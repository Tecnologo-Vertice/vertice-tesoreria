-- Tanda B3 · Archivos por organización y por empresa.
--
-- Hasta acá los archivos se guardaban como "año/mes/nombre" (facturas) y "año/nombre" (comprobantes de
-- pago), sin nada en la ruta que dijera de quién eran. La regla de lectura miraba si alguna factura o
-- algún pago visible apuntaba al archivo, y registrar_pago guardaba la ruta que le llegara: cargando un
-- pago propio con la ruta del comprobante de otra empresa, se podía leer ese comprobante.
--
-- Desde acá:
--   · Los archivos nuevos se guardan en <organización>/<empresa>/… (la organización es su identificador).
--     En las facturas, que se suben antes de saber de qué empresa son, la segunda carpeta es la empresa
--     que eligió quien la subió o "sin-empresa".
--   · Comprobantes de pago nuevos: se leen y se suben por carpeta. Hay que ser de esa organización y ver
--     esa empresa.
--   · Facturas nuevas: hay que ser de la organización de la carpeta y, además, ver el documento o la
--     factura que apunta al archivo (la empresa recién se sabe cuando la IA lo lee).
--   · registrar_pago rechaza una ruta que no sea de la carpeta de la empresa del pago.
--   · Los archivos que ya estaban (rutas sin carpeta de organización) se siguen leyendo como antes: si se
--     ve el pago, la factura o el documento que apunta a ellos. Un comprobante viejo que ya está en un
--     pago de otra empresa no se puede volver a usar.
--   · Las rutas viejas tienen dueño: son de la organización que ya existía cuando no había carpetas (la
--     que da el servicio, es_proveedor). Nadie de otra organización las lee, las sube ni las usa en un
--     pago, aunque conozca la ruta exacta. Y hay un interruptor (acepta_rutas_viejas) para dejar de
--     aceptarlas en pagos y subidas nuevas cuando ya no queden pantallas abiertas con el código anterior.
-- Un cambio para quien ve todas las empresas: antes leía cualquier archivo del depósito, aunque nada
-- apuntara a él. Ahora lee todos los de los pagos, facturas y documentos de su organización (que son
-- todos los que muestra la pantalla); un archivo suelto, sin registro, solo lo ve el servidor.

-- ---------------------------------------------------------------- De quién es una ruta

-- La organización de una ruta nueva (su primera carpeta). Null si es una ruta de antes de las organizaciones.
create or replace function organizacion_de_ruta(p_ruta text)
returns uuid language sql immutable as $$
  select case when split_part(coalesce(p_ruta, ''), '/', 1) ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
              then split_part(p_ruta, '/', 1)::uuid end
$$;

-- ¿Se siguen aceptando rutas viejas (sin carpeta de organización) en pagos y subidas NUEVOS? Hace falta
-- mientras haya pantallas abiertas con el código anterior, que suben el comprobante como "año/archivo":
-- entre aplicar esta migración y publicar el código nuevo, y un tiempo después. Para cerrarlo, cuando el
-- código nuevo esté publicado y el equipo haya recargado la pantalla, alcanza con correr:
--   create or replace function acepta_rutas_viejas() returns boolean language sql stable as $f$ select false $f$;
-- Los archivos viejos que ya están en un pago se siguen leyendo igual: esto solo corta los usos nuevos.
create or replace function acepta_rutas_viejas()
returns boolean language sql stable as $$ select true $$;

-- ¿La persona de la sesión es de la organización dueña de los archivos viejos? Todo lo que se guardó sin
-- carpeta de organización es de la organización que ya existía entonces: la que da el servicio.
create or replace function rutas_viejas_son_mias()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select o.es_proveedor from organizaciones o where o.id = organizacion_actual()), false)
$$;

-- Controla la ruta del comprobante de un pago de la empresa p_empresa. Devuelve la ruta limpia (o null).
--   · ruta nueva: tiene que empezar con <organización de la empresa>/<empresa>/;
--   · ruta vieja (la manda una pantalla que quedó abierta desde antes de esta migración): se acepta solo
--     si acepta_rutas_viejas() sigue en verdadero, la empresa es de la organización dueña de los archivos
--     viejos y la ruta no está ya en un pago de otra empresa.
-- Una carpeta ".." o "." no se acepta. Dos puntos seguidos dentro del nombre del archivo sí
-- ("Transferencia 12.11..pdf" es un nombre válido y la pantalla lo deja así).
create or replace function exigir_ruta_de_empresa(p_ruta text, p_empresa text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text := nullif(trim(coalesce(p_ruta, '')), ''); v_carpeta text;
begin
  if v is null then return null; end if;
  if left(v, 1) = '/' or v like '%//%' or string_to_array(v, '/') && array['..', '.'] then
    raise exception 'La ruta del comprobante no es válida';
  end if;
  if organizacion_de_ruta(v) is not null then
    select organizacion_id::text || '/' || id || '/' into v_carpeta from empresas where id = p_empresa;
    if v_carpeta is null or left(v, length(v_carpeta)) <> v_carpeta then
      raise exception 'El comprobante está guardado en la carpeta de otra empresa: no se puede usar en un pago de %. Volvé a subirlo.', p_empresa;
    end if;
    return v;
  end if;
  -- Ruta vieja.
  if not acepta_rutas_viejas() then
    raise exception 'El comprobante se subió con una versión anterior de la pantalla. Recargá la página y volvé a subirlo.';
  end if;
  -- El mismo mensaje para los dos rechazos: no dice si la ruta existe ni de quién es.
  if not coalesce((select o.es_proveedor from empresas e join organizaciones o on o.id = e.organizacion_id where e.id = p_empresa), false) then
    raise exception 'El comprobante no es de esta empresa: no se puede usar en un pago de %. Volvé a subirlo.', p_empresa;
  end if;
  if exists (select 1 from pagos where comprobante_path = v and empresa_id <> p_empresa) then
    raise exception 'El comprobante no es de esta empresa: no se puede usar en un pago de %. Volvé a subirlo.', p_empresa;
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------- Lectura y subida de archivos

drop policy comprobantes_leer on storage.objects;
create policy comprobantes_leer on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and (usuario_actual()).email is not null
         and case when organizacion_de_ruta(name) is not null
                  then organizacion_de_ruta(name) = organizacion_actual() and puede_ver_empresa(split_part(name, '/', 2))
                  else rutas_viejas_son_mias() and exists (select 1 from pagos p where p.comprobante_path = name) end);

-- Subir: a la carpeta de una empresa que veo. Las rutas viejas se aceptan solo de la organización dueña
-- de los archivos viejos y mientras acepta_rutas_viejas() esté en verdadero (por las pantallas que
-- quedaron abiertas). No dan acceso a nada: se leen solo a través de un pago visible.
drop policy comprobantes_subir on storage.objects;
create policy comprobantes_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and (usuario_actual()).email is not null
              and case when organizacion_de_ruta(name) is not null
                       then organizacion_de_ruta(name) = organizacion_actual() and puede_ver_empresa(split_part(name, '/', 2))
                       else acepta_rutas_viejas() and rutas_viejas_son_mias() end);

-- Facturas (las sube solo el servidor): de mi organización si la ruta lo dice, y siempre a través de una
-- factura o un documento que veo. Los subselects pasan por las reglas de facturas y documentos (0018).
drop policy facturas_leer on storage.objects;
create policy facturas_leer on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (usuario_actual()).email is not null
         and case when organizacion_de_ruta(name) is not null then organizacion_de_ruta(name) = organizacion_actual()
                  else rutas_viejas_son_mias() end
         and (exists (select 1 from facturas f where f.pdf_path = name)
              or exists (select 1 from documentos d where d.storage_path = name)));

-- ---------------------------------------------------------------- registrar_pago rechaza rutas ajenas
-- Es la función de 0003 con un solo agregado: el control de la ruta del comprobante.

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

  -- El comprobante tiene que estar en la carpeta de esta empresa (0019). Va después de crear el pago para
  -- que quien no ve la empresa reciba el rechazo de siempre y no se entere de nada de la ruta.
  perform exigir_ruta_de_empresa(p_datos ->> 'comprobante_path', e.id);

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

-- ---------------------------------------------------------------- Permisos

revoke execute on function exigir_ruta_de_empresa(text, text) from public, anon, authenticated;
grant execute on function exigir_ruta_de_empresa(text, text) to service_role;
-- organizacion_de_ruta la usan las reglas de los archivos con la sesión de la persona: solo mira el texto de la ruta.
-- Las otras dos también las usan las reglas: una dice verdadero o falso para todos, la otra solo habla de la propia organización.
revoke execute on function organizacion_de_ruta(text), acepta_rutas_viejas(), rutas_viejas_son_mias() from public, anon;
grant execute on function organizacion_de_ruta(text), acepta_rutas_viejas(), rutas_viejas_son_mias() to authenticated, service_role;
