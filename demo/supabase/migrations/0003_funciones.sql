-- Acciones de negocio. Cada una valida el rol, hace todo en una transacción y deja auditoría.
-- Es la misma lógica que src/data/fuenteDemo.ts, en SQL.

create or replace function registrar_auditoria(p_usuario usuarios, p_accion text, p_entidad text, p_id text, p_detalle text)
returns void language sql security definer set search_path = public as $$
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario.nombre, p_usuario.rol, p_accion, p_entidad, p_id, p_detalle)
$$;
-- Solo la llaman las otras funciones. Sin este revoke cualquiera podría escribir auditoría falsa por RPC.
revoke execute on function registrar_auditoria from public, anon, authenticated;

-- ---------------------------------------------------------------- Facturas

create or replace function aprobar_factura(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');   -- Dirección ve todo pero no modifica
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado <> 'PENDIENTE_APROBACION' then raise exception 'La factura no está pendiente de aprobación'; end if;
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  select * into e from empresas where id = f.empresa_id;
  update facturas set
    estado = 'PARA_PAGAR', cuenta_contable = p_cuenta, metodo_pago = p_metodo, dias_cheque = p_dias,
    aprobado_por = u.nombre, aprobado_en = now(), actualizado_en = now(),
    estado_xubio = case when e.erp = 'XUBIO' then (case when estado_xubio = 'SUBIDA' then 'SUBIDA' else 'PENDIENTE' end)::estado_xubio else 'PENDIENTE_RALPHARMA' end
  where id = p_id;
  perform registrar_auditoria(u, 'APROBACION', 'FACTURA', p_id::text, 'Cuenta ' || p_cuenta || ' · ' || p_metodo);
end $$;

create or replace function rechazar_factura(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo del rechazo'; end if;
  update facturas set estado = 'RECHAZADA', motivo_validacion = p_motivo, actualizado_en = now()
  where id = p_id and estado in ('PENDIENTE_APROBACION', 'ERROR');
  if not found then raise exception 'La factura no se puede rechazar en su estado actual'; end if;
  perform registrar_auditoria(u, 'RECHAZO', 'FACTURA', p_id::text, p_motivo);
end $$;

create or replace function corregir_factura(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  update facturas set estado = 'PENDIENTE_APROBACION', validacion_ok = true, motivo_validacion = null, actualizado_en = now()
  where id = p_id and estado = 'ERROR';
  if not found then raise exception 'La factura no está en excepciones'; end if;
  perform registrar_auditoria(u, 'CORRECCION', 'FACTURA', p_id::text, 'Datos corregidos a mano; vuelve a pendientes');
end $$;

-- ---------------------------------------------------------------- Pagos

create or replace function registrar_pago(p_datos jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  u usuarios; e empresas; v_id uuid; v_importe numeric; v_restante numeric; v_fid uuid;
  f facturas; v_pendiente numeric; v_aplica numeric; v_completas integer := 0;
  v_prov uuid; v_medio metodo_pago; v_n_facturas integer;
begin
  u := exigir_rol('TESORERIA', 'ADMIN', 'ADMINISTRACION');
  select * into e from empresas where id = p_datos ->> 'empresa_id';
  if e.id is null then raise exception 'Empresa inexistente'; end if;
  v_importe := round((p_datos ->> 'importe')::numeric, 2);
  if v_importe is null or v_importe <= 0 then raise exception 'El importe debe ser mayor a cero'; end if;
  v_prov := nullif(p_datos ->> 'proveedor_id', '')::uuid;
  v_medio := (p_datos ->> 'medio')::metodo_pago;
  if v_medio in ('CHEQUE', 'ECHEQ') and (coalesce(p_datos ->> 'numero_cheque', '') = '' or coalesce(p_datos ->> 'fecha_acreditacion', '') = '') then
    raise exception 'Un pago con cheque necesita número y fecha de vencimiento del cheque';
  end if;
  v_n_facturas := jsonb_array_length(coalesce(p_datos -> 'factura_ids', '[]'::jsonb));

  -- Validar todas las facturas antes de escribir nada.
  v_pendiente := 0;
  for f in select * from facturas where id in (select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p_datos -> 'factura_ids', '[]'::jsonb))) loop
    if f.empresa_id <> e.id then raise exception 'La factura % es de otra empresa', f.numero; end if;
    if f.estado not in ('PARA_PAGAR', 'PAGADA_PARCIAL') then raise exception 'La factura % no está para pagar (estado %)', f.numero, f.estado; end if;
    if v_prov is not null and f.proveedor_id <> v_prov then raise exception 'La factura % es de otro proveedor', f.numero; end if;
    v_pendiente := v_pendiente + (f.total - f.pagado);
  end loop;
  if v_n_facturas > 0 and v_importe > v_pendiente + 1 then
    raise exception 'El pago (%) supera lo pendiente de las facturas vinculadas (%). Cargá el excedente como un pago aparte.', v_importe, v_pendiente;
  end if;

  insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque,
                     fecha_acreditacion, descripcion, observaciones, cuenta_contable, sugerencia_origen, sugerencia_confianza,
                     forma_carga_xubio, estado, comprobante_path, cargado_por)
  values (e.id, v_prov, (p_datos ->> 'fecha')::date, v_importe,
          v_medio, p_datos ->> 'cuenta_origen', p_datos ->> 'banco_destino', p_datos ->> 'numero_cheque',
          (p_datos ->> 'fecha_acreditacion')::date, p_datos ->> 'descripcion', p_datos ->> 'observaciones', p_datos ->> 'cuenta_contable',
          p_datos ->> 'sugerencia_origen', (p_datos ->> 'sugerencia_confianza')::numeric,
          coalesce((p_datos ->> 'forma_carga_xubio')::forma_carga_xubio, 'SALIDA_FONDOS'),
          (case when e.erp = 'RALPHARMA' then 'PENDIENTE_RALPHARMA' else 'CARGADO' end)::estado_pago,
          p_datos ->> 'comprobante_path', u.nombre)
  returning id into v_id;

  -- Aplicar el pago a las facturas vinculadas, en el orden recibido, hasta agotar el importe.
  v_restante := v_importe;
  for v_fid in select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p_datos -> 'factura_ids', '[]'::jsonb)) loop
    select * into f from facturas where id = v_fid for update;
    if f.id is null then raise exception 'Factura % inexistente', v_fid; end if;
    v_pendiente := f.total - f.pagado;
    v_aplica := least(v_pendiente, v_restante);
    if v_aplica <= 0 then continue; end if;
    v_restante := v_restante - v_aplica;
    insert into pagos_facturas (pago_id, factura_id, importe) values (v_id, v_fid, v_aplica);
    update facturas set pagado = pagado + v_aplica,
                        estado = case when pagado + v_aplica >= total then 'PAGADA' else 'PAGADA_PARCIAL' end::estado_factura,
                        actualizado_en = now()
    where id = v_fid;
    if f.pagado + v_aplica >= f.total then v_completas := v_completas + 1; end if;
  end loop;

  perform registrar_auditoria(u, 'PAGO_CARGADO', 'PAGO', v_id::text,
    v_medio || ' · ' || coalesce(p_datos ->> 'cuenta_origen', '') || ' · ' || v_n_facturas || ' factura(s)');
  if v_completas > 0 then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Sistema', 'ADMIN', 'MAIL_PENDIENTE', 'PAGO', v_id::text, 'Mail al proveedor pendiente de envío: ' || v_completas || ' factura(s) canceladas');
  end if;
  return v_id;
end $$;

-- La llama la función de Netlify `contabilizar` (rol de servicio) después de hablar con Xubio.
create or replace function marcar_pago_contabilizado(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_xubio_id text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  if coalesce(p_xubio_id, '') = '' then raise exception 'Falta el id de Xubio'; end if;
  update pagos set estado = 'CONTABILIZADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma, xubio_id = p_xubio_id,
                   contabilizado_por = p_usuario, contabilizado_en = now()
  where id = p_id and estado in ('CARGADO', 'REVISADO');
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'CONTABILIZADO', 'PAGO', p_id::text, 'Xubio ' || p_xubio_id || ' · ' || p_forma || ' · ' || p_cuenta);
end $$;
revoke execute on function marcar_pago_contabilizado from public, anon, authenticated;

create or replace function marcar_pago_revisado(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_detalle text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
begin
  update pagos set estado = 'REVISADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma
  where id = p_id and estado in ('CARGADO', 'REVISADO');
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'REVISADO_EN_SECO', 'PAGO', p_id::text, p_detalle);
end $$;
revoke execute on function marcar_pago_revisado from public, anon, authenticated;

create or replace function marcar_ralpharma(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  update pagos set estado = 'CONTABILIZADO', xubio_id = 'RALPHARMA', contabilizado_por = u.nombre, contabilizado_en = now()
  where id = p_id and estado = 'PENDIENTE_RALPHARMA';
  if not found then raise exception 'El pago no está pendiente de Ralpharma'; end if;
  perform registrar_auditoria(u, 'CARGADO_RALPHARMA', 'PAGO', p_id::text, 'Carga manual confirmada en Ralpharma');
end $$;

-- ---------------------------------------------------------------- Ingesta desde el Apps Script

-- Recibe una factura ya leída por la IA del Apps Script. Crea o actualiza el proveedor por CUIT y
-- la factura por su clave natural. La llama la función de Netlify `ingesta-factura` (rol de servicio).
create or replace function ingresar_factura(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_prov uuid; v_id uuid; v_cuit text;
begin
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;
  insert into proveedores (cuit, nombre, email, categoria_vertice)
  values (v_cuit, coalesce(p ->> 'proveedor', 'Sin nombre'), nullif(p ->> 'email_proveedor', ''), p ->> 'categoria_vertice')
  on conflict (cuit) do update set nombre = excluded.nombre, categoria_vertice = coalesce(excluded.categoria_vertice, proveedores.categoria_vertice)
  returning id into v_prov;

  insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
                        neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen, drive_url,
                        estado, estado_xubio, xubio_id, validacion_ok, motivo_validacion, categoria_vertice, cuenta_contable,
                        codigo_producto, metodo_pago, pagado, sheets_fila_origen)
  values (p ->> 'empresa_id', v_prov, p ->> 'tipo', nullif(p ->> 'letra', ''), (p ->> 'punto_venta')::int, (p ->> 'numero')::int,
          (p ->> 'fecha')::date, nullif(p ->> 'vencimiento', '')::date, coalesce(p ->> 'moneda', 'ARS'), coalesce((p ->> 'cotizacion')::numeric, 1),
          (p ->> 'neto')::numeric, coalesce((p ->> 'iva')::numeric, 0), coalesce((p ->> 'exento')::numeric, 0), coalesce((p ->> 'percepciones')::numeric, 0),
          coalesce(p -> 'percepciones_json', '[]'::jsonb), (p ->> 'total')::numeric, nullif(p ->> 'cae', ''), nullif(p ->> 'cae_vencimiento', '')::date,
          coalesce(p ->> 'origen', 'GMAIL'), p ->> 'drive_url',
          coalesce((p ->> 'estado')::estado_factura, 'PENDIENTE_APROBACION'), coalesce((p ->> 'estado_xubio')::estado_xubio, 'PENDIENTE'), p ->> 'xubio_id',
          coalesce((p ->> 'validacion_ok')::boolean, false), p ->> 'motivo_validacion', p ->> 'categoria_vertice', p ->> 'cuenta_contable',
          p ->> 'codigo_producto', nullif(p ->> 'metodo_pago', '')::metodo_pago,
          -- Solo al migrar el histórico: lo ya pagado según la hoja, en pesos.
          least(coalesce((p ->> 'pagado')::numeric, 0), (p ->> 'total')::numeric),
          (p ->> 'sheets_fila_origen')::int)
  -- Reingesta: la hoja manda solo mientras el sistema nuevo no decidió nada (pendiente o error).
  -- Desde que la factura se aprueba, rechaza o paga acá, la hoja no la vuelve atrás. Lo pagado
  -- nunca se toma de la hoja en una reingesta: lo registran los pagos del sistema nuevo.
  on conflict (empresa_id, proveedor_id, tipo, punto_venta, numero) do update set
    estado = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.estado else facturas.estado end,
    validacion_ok = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.validacion_ok else facturas.validacion_ok end,
    motivo_validacion = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.motivo_validacion else facturas.motivo_validacion end,
    cuenta_contable = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then coalesce(excluded.cuenta_contable, facturas.cuenta_contable) else facturas.cuenta_contable end,
    metodo_pago = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then coalesce(excluded.metodo_pago, facturas.metodo_pago) else facturas.metodo_pago end,
    pagado = case when facturas.estado in ('PENDIENTE_APROBACION', 'ERROR') then excluded.pagado else facturas.pagado end,
    estado_xubio = excluded.estado_xubio, xubio_id = coalesce(excluded.xubio_id, facturas.xubio_id),
    drive_url = coalesce(excluded.drive_url, facturas.drive_url), sheets_fila_origen = excluded.sheets_fila_origen, actualizado_en = now()
  returning id into v_id;

  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values ('Apps Script', 'ADMIN', 'INGRESO', 'FACTURA', v_id::text, 'Recibida desde ' || coalesce(p ->> 'origen', 'GMAIL') || '; validación ' || case when coalesce((p ->> 'validacion_ok')::boolean, false) then 'OK' else 'con error' end);
  return v_id;
end $$;
revoke execute on function ingresar_factura from public, anon, authenticated;
