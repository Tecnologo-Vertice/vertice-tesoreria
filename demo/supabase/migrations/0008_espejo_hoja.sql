-- Espejo de la hoja real "Facturas automatizadas" (solo lectura) → base.
-- Mientras el Apps Script de producción siga siendo el sistema del equipo, el sistema nuevo copia
-- facturas, pagos y catálogos de la hoja cada 10 minutos (gas/PuenteHojas.gs → /api/espejo).
-- Regla: la hoja manda sobre cada factura o pago (gestion = 'HOJA') hasta que alguien lo aprueba,
-- paga o contabiliza en el sistema nuevo (gestion = 'SISTEMA'); desde ahí la copia no lo pisa.

-- ---------------------------------------------------------------- Columnas nuevas

alter table facturas add column gestion text not null default 'SISTEMA' check (gestion in ('HOJA', 'SISTEMA'));
alter table facturas add column hoja text;                                  -- Facturas · Facturas_Aprobadas
alter table facturas add column hoja_hash text;                             -- huella de la fila: si no cambió, no se reescribe
alter table facturas add column espejado_en timestamptz;
alter table facturas add column tipo_pago text;                             -- CUENTA_CORRIENTE · ANTICIPADO
alter table facturas add column fecha_pago date;
alter table facturas add column mail_enviado text;
alter table facturas add column comprobantes_pago jsonb not null default '[]';
alter table facturas add column nc_aplicadas jsonb not null default '[]';

alter table pagos add column hoja_id text unique;                           -- ID_PAGO de la hoja
alter table pagos add column gestion text not null default 'SISTEMA' check (gestion in ('HOJA', 'SISTEMA'));
alter table pagos add column hoja_hash text;
alter table pagos add column espejado_en timestamptz;
alter table pagos add column tipo_pago text;                                -- FACTURA · SIN_FACTURA
alter table pagos add column factura_asociada text;                         -- como la escribió la hoja
alter table pagos add column proveedor_destino text;
alter table pagos add column realizado_por text;
alter table pagos add column banco_origen text;
alter table pagos add column numero_cuenta text;
alter table pagos add column tipo_cheque text;                              -- ECHEQ · FISICO
alter table pagos add column estado_extraccion text;                        -- lectura del comprobante por la IA
alter table pagos add column estado_xubio_pago text;
alter table pagos add column xubio_detalle text;
alter table pagos add column detalle_contabilizacion text;
alter table pagos add column sugerencia_motivo text;
alter table pagos add column aviso_importe text;
alter table pagos add column cheque_cashflow text;
alter table pagos add column ralpharma_cargado text;
alter table pagos add column comprobante_url text;                          -- link de Drive del comprobante
-- Un pago copiado de la hoja puede tener importe 0 mientras la IA no leyó el comprobante.
alter table pagos drop constraint pagos_importe_check;
alter table pagos add constraint pagos_importe_check check (importe > 0 or (hoja_id is not null and importe = 0));

alter table cuentas_origen add column codigo text;
alter table cuentas_origen add column usos integer not null default 0;
alter table cuentas_origen add column ultimo_uso date;

alter table proveedores_empresa add column nombre_xubio text;               -- nombre exacto en el Xubio de esa empresa
alter table proveedores_empresa add column saltar_xubio boolean not null default false;

-- Productos de compra de Xubio (Catalogo_Productos): categoría de la factura → código del producto.
create table productos_xubio (
  nombre  text primary key,
  codigo  text not null
);

-- Última copia de cada pestaña, para mostrar en la app "copiado hace 3 min".
create table espejo_estado (
  hoja          text primary key,
  ultima_en     timestamptz not null default now(),
  filas         integer not null default 0,
  nuevas        integer not null default 0,
  actualizadas  integer not null default 0,
  sin_cambios   integer not null default 0,
  omitidas      integer not null default 0,
  detalle       jsonb not null default '[]'
);

-- ---------------------------------------------------------------- Quién gestiona cada fila

-- Cualquier cambio de estado o de datos contables hecho en el sistema nuevo pasa la fila a 'SISTEMA'.
-- La copia de la hoja corre con vertice.espejo = 'si' y no la marca.
create or replace function facturas_gestion_sistema()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then return new; end if;
  if new.estado is distinct from old.estado or new.pagado is distinct from old.pagado
     or new.cuenta_contable is distinct from old.cuenta_contable or new.metodo_pago is distinct from old.metodo_pago then
    new.gestion := 'SISTEMA';
  end if;
  return new;
end $$;
create trigger trg_facturas_gestion before update on facturas for each row execute function facturas_gestion_sistema();

create or replace function pagos_gestion_sistema()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then return new; end if;
  if new.estado is distinct from old.estado or new.importe is distinct from old.importe
     or new.cuenta_contable is distinct from old.cuenta_contable or new.cuenta_origen is distinct from old.cuenta_origen
     or new.forma_carga_xubio is distinct from old.forma_carga_xubio then
    new.gestion := 'SISTEMA';
  end if;
  return new;
end $$;
create trigger trg_pagos_gestion before update on pagos for each row execute function pagos_gestion_sistema();

-- Texto comparable (sin tildes, minúsculas, sin símbolos), para cruzar nombres de proveedores.
create or replace function texto_comparable(t text)
returns text language sql immutable as $$
  select regexp_replace(lower(translate(coalesce(t, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]', '', 'g')
$$;

-- ---------------------------------------------------------------- Copia de facturas

-- p_filas: facturas ya traducidas por netlify/functions/lib/espejo.ts (claves = columnas de facturas,
-- más cuit_proveedor y proveedor). Devuelve los contadores y las filas omitidas con su motivo.
create or replace function espejar_facturas(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; v_prov uuid; v_id uuid; v_gestion text; v_hash text;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      insert into proveedores (cuit, nombre, categoria_vertice)
      values (p ->> 'cuit_proveedor', coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'), nullif(p ->> 'categoria_vertice', ''))
      on conflict (cuit) do update set categoria_vertice = coalesce(proveedores.categoria_vertice, excluded.categoria_vertice)
      returning id into v_prov;
      p := p || jsonb_build_object('proveedor_id', v_prov);

      select id, gestion, hoja_hash into v_id, v_gestion, v_hash from facturas
      where empresa_id = p ->> 'empresa_id' and proveedor_id = v_prov and tipo = p ->> 'tipo'
        and punto_venta = (p ->> 'punto_venta')::int and numero = (p ->> 'numero')::int;

      if v_id is null then
        insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
          neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen, drive_url, estado, estado_xubio,
          xubio_id, xubio_error, validacion_ok, motivo_validacion, categoria_vertice, cuenta_contable, codigo_producto, metodo_pago,
          pagado, saldo_nc, comprobante_vinculado, tipo_pago, fecha_pago, mail_enviado, comprobantes_pago, nc_aplicadas,
          hoja, sheets_fila_origen, hoja_hash, gestion, espejado_en)
        select r.empresa_id, r.proveedor_id, r.tipo, r.letra, r.punto_venta, r.numero, r.fecha, r.vencimiento, r.moneda, r.cotizacion,
          r.neto, r.iva, r.exento, r.percepciones, r.percepciones_json, r.total, r.cae, r.cae_vencimiento, r.origen, r.drive_url, r.estado, r.estado_xubio,
          r.xubio_id, r.xubio_error, r.validacion_ok, r.motivo_validacion, r.categoria_vertice, r.cuenta_contable, r.codigo_producto, r.metodo_pago,
          r.pagado, r.saldo_nc, r.comprobante_vinculado, r.tipo_pago, r.fecha_pago, r.mail_enviado, r.comprobantes_pago, r.nc_aplicadas,
          r.hoja, r.sheets_fila_origen, r.hoja_hash, 'HOJA', now()
        from jsonb_populate_record(null::facturas, p) r
        returning id into v_id;
        insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
        values ('Copia de la hoja', 'ADMIN', 'COPIA_HOJA', 'FACTURA', v_id::text, 'Factura copiada de la hoja real (' || (p ->> 'hoja') || ', fila ' || coalesce(p ->> 'sheets_fila_origen', '?') || ')');
        n_nuevas := n_nuevas + 1;
      elsif v_hash is not distinct from p ->> 'hoja_hash' then
        -- Sin cambios: solo se anota si la fila se movió (por ejemplo, pasó a Facturas_Aprobadas).
        update facturas set hoja = p ->> 'hoja', sheets_fila_origen = (p ->> 'sheets_fila_origen')::int
        where id = v_id and (hoja is distinct from p ->> 'hoja' or sheets_fila_origen is distinct from (p ->> 'sheets_fila_origen')::int);
        n_igual := n_igual + 1;
      elsif v_gestion = 'HOJA' then
        update facturas set (letra, fecha, vencimiento, moneda, cotizacion, neto, iva, exento, percepciones, percepciones_json, total,
          cae, cae_vencimiento, drive_url, estado, estado_xubio, xubio_id, xubio_error, validacion_ok, motivo_validacion, categoria_vertice,
          cuenta_contable, codigo_producto, metodo_pago, pagado, saldo_nc, comprobante_vinculado, tipo_pago, fecha_pago, mail_enviado,
          comprobantes_pago, nc_aplicadas, hoja, sheets_fila_origen, hoja_hash, espejado_en, actualizado_en) =
        (select r.letra, r.fecha, r.vencimiento, r.moneda, r.cotizacion, r.neto, r.iva, r.exento, r.percepciones, r.percepciones_json, r.total,
          r.cae, r.cae_vencimiento, r.drive_url, r.estado, r.estado_xubio, coalesce(r.xubio_id, facturas.xubio_id), r.xubio_error, r.validacion_ok,
          r.motivo_validacion, r.categoria_vertice, r.cuenta_contable, r.codigo_producto, r.metodo_pago, r.pagado, r.saldo_nc,
          r.comprobante_vinculado, r.tipo_pago, r.fecha_pago, r.mail_enviado, r.comprobantes_pago, r.nc_aplicadas, r.hoja,
          r.sheets_fila_origen, r.hoja_hash, now(), now()
         from jsonb_populate_record(null::facturas, p) r)
        where id = v_id;
        n_act := n_act + 1;
      else
        -- La gestiona el sistema nuevo: de la hoja solo se toma dónde está la fila y el PDF.
        update facturas set drive_url = coalesce(drive_url, p ->> 'drive_url'), hoja = p ->> 'hoja',
          sheets_fila_origen = (p ->> 'sheets_fila_origen')::int, hoja_hash = p ->> 'hoja_hash', espejado_en = now()
        where id = v_id;
        n_igual := n_igual + 1;
      end if;
    exception when others then
      omitidas := omitidas || jsonb_build_object('fila', p -> 'sheets_fila_origen', 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('nuevas', n_nuevas, 'actualizadas', n_act, 'sin_cambios', n_igual, 'omitidas', omitidas);
end $$;

-- ---------------------------------------------------------------- Copia de pagos

-- p_filas: pagos traducidos por lib/espejo.ts (claves = columnas de pagos, más facturas: [{punto_venta, numero}]).
-- La empresa que falta se toma de la primera factura vinculada; el proveedor, de la factura o por nombre.
create or replace function espejar_pagos(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; ref jsonb; v_id uuid; v_gestion text; v_hash text; v_emp text; v_prov uuid;
  v_fids uuid[]; v_totales numeric[]; v_fid uuid; v_femp text; v_fprov uuid; v_ftotal numeric; v_suma numeric; v_imp numeric; i int;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      v_emp := nullif(p ->> 'empresa_id', '');
      v_prov := null; v_fids := '{}'; v_totales := '{}';
      for ref in select value from jsonb_array_elements(coalesce(p -> 'facturas', '[]'::jsonb)) loop
        v_fid := null;
        select f.id, f.empresa_id, f.proveedor_id, f.total into v_fid, v_femp, v_fprov, v_ftotal
        from facturas f join proveedores pr on pr.id = f.proveedor_id
        where f.punto_venta = (ref ->> 'punto_venta')::int and f.numero = (ref ->> 'numero')::int
          and (v_emp is null or f.empresa_id = v_emp)
        order by (texto_comparable(pr.nombre) = texto_comparable(p ->> 'proveedor_destino')) desc, f.fecha desc
        limit 1;
        if v_fid is not null and not (v_fid = any(v_fids)) then
          v_fids := v_fids || v_fid; v_totales := v_totales || v_ftotal;
          v_emp := coalesce(v_emp, v_femp); v_prov := coalesce(v_prov, v_fprov);
        end if;
      end loop;
      if v_emp is null then raise exception 'No se sabe de qué empresa es el pago (EMPRESA y REALIZADO_POR vacíos, sin factura vinculada)'; end if;
      if v_prov is null and coalesce(p ->> 'proveedor_destino', '') <> '' then
        select id into v_prov from proveedores where texto_comparable(nombre) = texto_comparable(p ->> 'proveedor_destino') limit 1;
      end if;
      p := p || jsonb_build_object('empresa_id', v_emp, 'proveedor_id', v_prov,
                                   'cargado_en', coalesce(p ->> 'cargado_en', now()::text), 'cargado_por', coalesce(p ->> 'cargado_por', 'Apps Script'));

      select id, gestion, hoja_hash into v_id, v_gestion, v_hash from pagos where hoja_id = p ->> 'hoja_id';

      if v_id is null then
        insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque, fecha_acreditacion,
          descripcion, observaciones, cuenta_contable, sugerencia_origen, forma_carga_xubio, estado, xubio_id, cargado_por, cargado_en,
          contabilizado_por, contabilizado_en, hoja_id, tipo_pago, factura_asociada, proveedor_destino, realizado_por, banco_origen,
          numero_cuenta, tipo_cheque, estado_extraccion, estado_xubio_pago, xubio_detalle, detalle_contabilizacion, sugerencia_motivo,
          aviso_importe, cheque_cashflow, ralpharma_cargado, comprobante_url, sheets_fila_origen, hoja_hash, gestion, espejado_en)
        select r.empresa_id, r.proveedor_id, r.fecha, r.importe, r.medio, r.cuenta_origen, r.banco_destino, r.numero_cheque, r.fecha_acreditacion,
          r.descripcion, r.observaciones, r.cuenta_contable, r.sugerencia_origen, r.forma_carga_xubio, r.estado, r.xubio_id, r.cargado_por, r.cargado_en,
          r.contabilizado_por, r.contabilizado_en, r.hoja_id, r.tipo_pago, r.factura_asociada, r.proveedor_destino, r.realizado_por, r.banco_origen,
          r.numero_cuenta, r.tipo_cheque, r.estado_extraccion, r.estado_xubio_pago, r.xubio_detalle, r.detalle_contabilizacion, r.sugerencia_motivo,
          r.aviso_importe, r.cheque_cashflow, r.ralpharma_cargado, r.comprobante_url, (p ->> 'sheets_fila_origen')::int, r.hoja_hash, 'HOJA', now()
        from jsonb_populate_record(null::pagos, p) r
        returning id into v_id;
        insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
        values ('Copia de la hoja', 'ADMIN', 'COPIA_HOJA', 'PAGO', v_id::text, 'Pago ' || (p ->> 'hoja_id') || ' copiado de la hoja real');
        n_nuevas := n_nuevas + 1;
        v_gestion := 'HOJA'; v_hash := null;
      elsif v_hash is not distinct from p ->> 'hoja_hash' then
        update pagos set sheets_fila_origen = (p ->> 'sheets_fila_origen')::int
        where id = v_id and sheets_fila_origen is distinct from (p ->> 'sheets_fila_origen')::int;
        n_igual := n_igual + 1;
        continue;
      elsif v_gestion = 'HOJA' then
        update pagos set (empresa_id, proveedor_id, fecha, importe, medio, cuenta_origen, banco_destino, numero_cheque, fecha_acreditacion,
          descripcion, observaciones, cuenta_contable, sugerencia_origen, forma_carga_xubio, estado, xubio_id, cargado_por,
          contabilizado_por, contabilizado_en, tipo_pago, factura_asociada, proveedor_destino, realizado_por, banco_origen,
          numero_cuenta, tipo_cheque, estado_extraccion, estado_xubio_pago, xubio_detalle, detalle_contabilizacion, sugerencia_motivo,
          aviso_importe, cheque_cashflow, ralpharma_cargado, comprobante_url, sheets_fila_origen, hoja_hash, espejado_en) =
        (select r.empresa_id, r.proveedor_id, r.fecha, r.importe, r.medio, r.cuenta_origen, r.banco_destino, r.numero_cheque, r.fecha_acreditacion,
          r.descripcion, r.observaciones, r.cuenta_contable, r.sugerencia_origen, r.forma_carga_xubio, r.estado, r.xubio_id, r.cargado_por,
          r.contabilizado_por, r.contabilizado_en, r.tipo_pago, r.factura_asociada, r.proveedor_destino, r.realizado_por, r.banco_origen,
          r.numero_cuenta, r.tipo_cheque, r.estado_extraccion, r.estado_xubio_pago, r.xubio_detalle, r.detalle_contabilizacion, r.sugerencia_motivo,
          r.aviso_importe, r.cheque_cashflow, r.ralpharma_cargado, r.comprobante_url, (p ->> 'sheets_fila_origen')::int, r.hoja_hash, now()
         from jsonb_populate_record(null::pagos, p) r)
        where id = v_id;
        n_act := n_act + 1;
      else
        update pagos set sheets_fila_origen = (p ->> 'sheets_fila_origen')::int, hoja_hash = p ->> 'hoja_hash', espejado_en = now() where id = v_id;
        n_igual := n_igual + 1;
        continue;
      end if;

      -- Facturas que cancela, para mostrar el vínculo. Lo pagado de cada factura lo sigue diciendo la hoja
      -- (PORCENTAJE_PAGADO): estos importes no la modifican. Con varias facturas se reparte según el total.
      delete from pagos_facturas where pago_id = v_id;
      select coalesce(sum(t), 0) into v_suma from unnest(v_totales) t;
      for i in 1 .. coalesce(array_length(v_fids, 1), 0) loop
        v_imp := case when array_length(v_fids, 1) = 1 then least((p ->> 'importe')::numeric, v_totales[i])
                      when v_suma > 0 then round((p ->> 'importe')::numeric * v_totales[i] / v_suma, 2) else 0 end;
        insert into pagos_facturas (pago_id, factura_id, importe) values (v_id, v_fids[i], v_imp) on conflict do nothing;
      end loop;
    exception when others then
      omitidas := omitidas || jsonb_build_object('fila', p -> 'sheets_fila_origen', 'id', p -> 'hoja_id', 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('nuevas', n_nuevas, 'actualizadas', n_act, 'sin_cambios', n_igual, 'omitidas', omitidas);
end $$;

-- ---------------------------------------------------------------- Copia de catálogos

-- p: { cuentas, origen, porEmpresa, emails, productos } ya traducidos por lib/espejo.ts.
create or replace function espejar_catalogos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_prov uuid; n jsonb := '{}';
begin
  perform set_config('vertice.espejo', 'si', true);

  insert into cuentas_contables (empresa_id, nombre, codigo, xubio_id, activa)
  select x ->> 'empresa_id', x ->> 'nombre', x ->> 'codigo', x ->> 'xubio_id', true
  from jsonb_array_elements(coalesce(p -> 'cuentas', '[]'::jsonb)) x
  on conflict (empresa_id, nombre) do update set codigo = excluded.codigo, xubio_id = excluded.xubio_id, activa = true;
  n := n || jsonb_build_object('cuentas', jsonb_array_length(coalesce(p -> 'cuentas', '[]'::jsonb)));

  insert into cuentas_origen (empresa_id, nombre, xubio_id, tipo_cuenta, codigo, usos, ultimo_uso)
  select x ->> 'empresa_id', x ->> 'nombre', x ->> 'xubio_id', (x ->> 'tipo_cuenta')::int, x ->> 'codigo',
         coalesce((x ->> 'usos')::int, 0), (x ->> 'ultimo_uso')::date
  from jsonb_array_elements(coalesce(p -> 'origen', '[]'::jsonb)) x
  on conflict (empresa_id, nombre) do update set xubio_id = excluded.xubio_id, tipo_cuenta = excluded.tipo_cuenta,
    codigo = excluded.codigo, usos = excluded.usos, ultimo_uso = excluded.ultimo_uso;
  n := n || jsonb_build_object('origen', jsonb_array_length(coalesce(p -> 'origen', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'porEmpresa', '[]'::jsonb)) loop
    insert into proveedores (cuit, nombre) values (r ->> 'cuit', coalesce(nullif(r ->> 'nombre_xubio', ''), 'Sin nombre'))
    on conflict (cuit) do update set nombre = proveedores.nombre
    returning id into v_prov;
    insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, nombre_xubio, saltar_xubio, actualizado_por)
    values (v_prov, r ->> 'empresa_id', nullif(r ->> 'cuenta_contable', ''), nullif(r ->> 'nombre_xubio', ''),
            coalesce((r ->> 'saltar_xubio')::boolean, false), 'Copia de la hoja')
    on conflict (proveedor_id, empresa_id) do update set
      cuenta_contable = coalesce(excluded.cuenta_contable, proveedores_empresa.cuenta_contable),
      nombre_xubio = excluded.nombre_xubio, saltar_xubio = excluded.saltar_xubio;
  end loop;
  n := n || jsonb_build_object('porEmpresa', jsonb_array_length(coalesce(p -> 'porEmpresa', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'emails', '[]'::jsonb)) loop
    insert into proveedores (cuit, nombre, email) values (r ->> 'cuit', r ->> 'proveedor', r ->> 'email')
    on conflict (cuit) do update set email = excluded.email;
  end loop;
  n := n || jsonb_build_object('emails', jsonb_array_length(coalesce(p -> 'emails', '[]'::jsonb)));

  insert into productos_xubio (nombre, codigo)
  select x ->> 'nombre', x ->> 'codigo' from jsonb_array_elements(coalesce(p -> 'productos', '[]'::jsonb)) x
  on conflict (nombre) do update set codigo = excluded.codigo;
  n := n || jsonb_build_object('productos', jsonb_array_length(coalesce(p -> 'productos', '[]'::jsonb)));

  return n;
end $$;

-- ---------------------------------------------------------------- Permisos

alter table productos_xubio enable row level security;
alter table espejo_estado enable row level security;
create policy leer_productos_xubio on productos_xubio for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_espejo_estado on espejo_estado for select to authenticated using ((usuario_actual()).email is not null);
grant select on productos_xubio, espejo_estado to authenticated;
grant all on productos_xubio, espejo_estado to service_role;

-- La copia solo la hace el servidor (/api/espejo, con el token del puente).
revoke execute on function espejar_facturas(jsonb), espejar_pagos(jsonb), espejar_catalogos(jsonb) from public, anon, authenticated;
grant execute on function espejar_facturas(jsonb), espejar_pagos(jsonb), espejar_catalogos(jsonb) to service_role;
