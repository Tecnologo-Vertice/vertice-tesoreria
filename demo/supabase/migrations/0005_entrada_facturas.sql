-- Flujo 1 · Entrada de facturas en el sistema nuevo.
-- Cada archivo que llega (adjunto de Gmail, carga manual, Drive) es un DOCUMENTO. Se guarda primero
-- y se lee con la IA después, en una cola: si la IA falla o se corta, el documento no se pierde y se
-- reintenta. De un documento leído sale una FACTURA (o se marca como duplicado o error).

create type estado_documento as enum ('PENDIENTE', 'LEYENDO', 'LEIDO', 'DUPLICADO', 'ERROR', 'DESCARTADO');

create table documentos (
  id                uuid primary key default gen_random_uuid(),
  origen            text not null check (origen in ('GMAIL', 'DRIVE', 'MANUAL')),
  gmail_message_id  text,
  nombre_archivo    text not null,
  mime_type         text not null,
  storage_path      text not null,                 -- bucket privado "facturas"
  tamano            integer,
  remitente         text,
  asunto            text,
  cargado_por       text,
  estado            estado_documento not null default 'PENDIENTE',
  intentos          integer not null default 0,
  tomado_en         timestamptz,                   -- cuándo lo agarró un lector (para liberar si se cortó)
  error             text,
  lectura           jsonb,                         -- lo que devolvió la IA, tal cual, para auditar
  factura_id        uuid references facturas,
  recibido_en       timestamptz not null default now(),
  leido_en          timestamptz,
  unique (gmail_message_id, nombre_archivo)        -- el mismo adjunto del mismo mail entra una sola vez
);
create index on documentos (estado, recibido_en);

alter table facturas add column documento_id uuid references documentos;
alter table facturas add column pdf_path text;              -- PDF en el bucket privado "facturas"
alter table facturas add column comprobante_vinculado text;  -- para notas de crédito y débito
alter table facturas add column categoria_ia text;           -- categoría genérica que sugiere la IA (no es la cuenta)
alter table facturas add column advertencia text;            -- avisos que no bloquean (redondeo, Factura M, CAE)

-- Memoria por proveedor y empresa: lo que se eligió al aprobar se usa en la próxima factura.
-- Reemplaza a la pestaña Catalogo_Proveedores_Por_Empresa del Apps Script.
create table proveedores_empresa (
  proveedor_id       uuid not null references proveedores,
  empresa_id         text not null references empresas,
  cuenta_contable    text,
  metodo_pago        metodo_pago,
  codigo_producto    text,
  categoria_vertice  text,
  veces              integer not null default 0,
  actualizado_por    text,
  actualizado_en     timestamptz not null default now(),
  primary key (proveedor_id, empresa_id)
);

alter table documentos enable row level security;
alter table proveedores_empresa enable row level security;
create policy leer_documentos on documentos for select to authenticated using ((usuario_actual()).email is not null);
create policy leer_memoria on proveedores_empresa for select to authenticated using ((usuario_actual()).email is not null);

-- PDFs de facturas: bucket privado. Solo se leen con link firmado; escribe solo el servidor.
insert into storage.buckets (id, name, public) values ('facturas', 'facturas', false)
on conflict (id) do nothing;
create policy facturas_leer on storage.objects for select to authenticated
  using (bucket_id = 'facturas' and (usuario_actual()).email is not null);

-- ---------------------------------------------------------------- Cola (solo el servidor)

-- Registra un documento. Idempotente para Gmail: si el mismo adjunto ya llegó, devuelve el existente.
create or replace function registrar_documento(p jsonb)
returns table (id uuid, nuevo boolean) language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into documentos (origen, gmail_message_id, nombre_archivo, mime_type, storage_path, tamano, remitente, asunto, cargado_por)
  values (p ->> 'origen', nullif(p ->> 'gmail_message_id', ''), p ->> 'nombre_archivo', p ->> 'mime_type', p ->> 'storage_path',
          (p ->> 'tamano')::int, p ->> 'remitente', p ->> 'asunto', p ->> 'cargado_por')
  on conflict (gmail_message_id, nombre_archivo) do nothing
  returning documentos.id into v_id;
  if v_id is not null then return query select v_id, true; return; end if;
  return query select d.id, false from documentos d
    where d.gmail_message_id = nullif(p ->> 'gmail_message_id', '') and d.nombre_archivo = p ->> 'nombre_archivo';
end $$;

-- Toma hasta p_max documentos para leer. skip locked: dos lectores en paralelo nunca agarran el mismo.
-- Un documento que quedó LEYENDO más de 5 minutos (el lector se cortó) vuelve a la cola.
create or replace function tomar_documentos(p_max integer)
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id in (
    select id from documentos
    where (estado = 'PENDIENTE' or (estado = 'LEYENDO' and tomado_en < now() - interval '5 minutes'))
      and intentos < 3
    order by recibido_en
    limit p_max
    for update skip locked
  )
  returning *
$$;

-- Toma un documento puntual (carga manual: se lee en el momento). Null si otro lector ya lo tiene.
create or replace function tomar_documento(p_id uuid)
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id = p_id and estado = 'PENDIENTE'
  returning *
$$;

-- Falla de lectura: vuelve a la cola si quedan intentos y el error es transitorio; si no, queda en ERROR.
create or replace function documento_fallo(p_id uuid, p_error text, p_reintentar boolean)
returns void language sql security definer set search_path = public as $$
  update documentos set
    estado = case when p_reintentar and intentos < 3 then 'PENDIENTE' else 'ERROR' end::estado_documento,
    error = p_error, tomado_en = null
  where id = p_id
$$;

-- Guarda lo leído. Crea el proveedor si no existe, aplica la memoria del proveedor en esa empresa,
-- y crea la factura. Si ya existía (misma clave natural), el documento queda como DUPLICADO.
create or replace function guardar_factura_leida(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d documentos; v_prov uuid; v_id uuid; v_existente uuid; m proveedores_empresa; v_cuit text; v_estado estado_factura;
begin
  select * into d from documentos where id = p_doc for update;
  if d.id is null then raise exception 'Documento inexistente'; end if;
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;

  insert into proveedores (cuit, nombre) values (v_cuit, coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'))
  on conflict (cuit) do update set nombre = proveedores.nombre    -- el nombre ya cargado manda
  returning id into v_prov;

  select * into m from proveedores_empresa where proveedor_id = v_prov and empresa_id = p ->> 'empresa_id';
  v_estado := case when coalesce((p ->> 'validacion_ok')::boolean, false) then 'PENDIENTE_APROBACION' else 'ERROR' end;

  insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, moneda, cotizacion,
                        neto, iva, exento, percepciones, percepciones_json, total, cae, cae_vencimiento, origen,
                        estado, estado_xubio, validacion_ok, motivo_validacion, advertencia, categoria_ia,
                        cuenta_contable, metodo_pago, codigo_producto, categoria_vertice, comprobante_vinculado,
                        documento_id, pdf_path)
  values (p ->> 'empresa_id', v_prov, p ->> 'tipo', nullif(p ->> 'letra', ''), (p ->> 'punto_venta')::int, (p ->> 'numero')::int,
          (p ->> 'fecha')::date, nullif(p ->> 'vencimiento', '')::date, coalesce(nullif(p ->> 'moneda', ''), 'ARS'),
          coalesce((p ->> 'cotizacion')::numeric, 1), (p ->> 'neto')::numeric, coalesce((p ->> 'iva')::numeric, 0),
          coalesce((p ->> 'exento')::numeric, 0), coalesce((p ->> 'percepciones')::numeric, 0),
          coalesce(p -> 'percepciones_json', '[]'::jsonb), (p ->> 'total')::numeric, nullif(p ->> 'cae', ''),
          nullif(p ->> 'cae_vencimiento', '')::date, d.origen,
          v_estado,
          (case when (select erp from empresas where id = p ->> 'empresa_id') = 'XUBIO' then 'PENDIENTE' else 'PENDIENTE_RALPHARMA' end)::estado_xubio,
          coalesce((p ->> 'validacion_ok')::boolean, false), nullif(p ->> 'motivo_validacion', ''), nullif(p ->> 'advertencia', ''),
          nullif(p ->> 'categoria_ia', ''),
          m.cuenta_contable, m.metodo_pago, m.codigo_producto, coalesce(m.categoria_vertice, p ->> 'categoria_vertice'),
          nullif(p ->> 'comprobante_vinculado', ''), d.id, d.storage_path)
  on conflict (empresa_id, proveedor_id, tipo, punto_venta, numero) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_existente from facturas
    where empresa_id = p ->> 'empresa_id' and proveedor_id = v_prov and tipo = p ->> 'tipo'
      and punto_venta = (p ->> 'punto_venta')::int and numero = (p ->> 'numero')::int;
    update documentos set estado = 'DUPLICADO', lectura = p, factura_id = v_existente, leido_en = now(), tomado_en = null,
                          error = 'Ya estaba cargada'
    where id = p_doc;
    return v_existente;
  end if;

  update documentos set estado = 'LEIDO', lectura = p, factura_id = v_id, leido_en = now(), tomado_en = null where id = p_doc;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values ('Lector IA', 'ADMIN', 'INGRESO', 'FACTURA', v_id::text,
          'Leída desde ' || d.origen || ' (' || d.nombre_archivo || '); validación ' ||
          case when v_estado = 'ERROR' then 'con error: ' || coalesce(p ->> 'motivo_validacion', '') else 'OK' end ||
          case when m.cuenta_contable is not null then '; cuenta recordada: ' || m.cuenta_contable else '' end);
  return v_id;
end $$;

-- La lectura terminó pero no salió una factura (no es un comprobante, empresa desconocida...).
create or replace function documento_sin_factura(p_id uuid, p_motivo text, p_lectura jsonb)
returns void language sql security definer set search_path = public as $$
  update documentos set estado = 'ERROR', error = p_motivo, lectura = p_lectura, leido_en = now(), tomado_en = null
  where id = p_id
$$;

revoke execute on function registrar_documento, tomar_documentos, tomar_documento, documento_fallo, guardar_factura_leida, documento_sin_factura
  from public, anon, authenticated;

-- ---------------------------------------------------------------- Acciones de las personas

create or replace function reintentar_documento(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMINISTRACION', 'ADMIN');
  update documentos set estado = 'PENDIENTE', intentos = 0, error = null, tomado_en = null
  where id = p_id and estado in ('ERROR', 'DUPLICADO');
  if not found then raise exception 'Solo se reintentan documentos con error o duplicados'; end if;
  perform registrar_auditoria(u, 'REINTENTO_LECTURA', 'SISTEMA', p_id::text, 'Vuelve a la cola de lectura');
end $$;

create or replace function descartar_documento(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('APROBADOR', 'ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  update documentos set estado = 'DESCARTADO', error = p_motivo, tomado_en = null
  where id = p_id and estado in ('PENDIENTE', 'ERROR', 'DUPLICADO');
  if not found then raise exception 'El documento no se puede descartar en su estado actual'; end if;
  perform registrar_auditoria(u, 'DESCARTE_DOCUMENTO', 'SISTEMA', p_id::text, p_motivo);
end $$;

-- Aprobar ahora también RECUERDA cuenta y método para ese proveedor en esa empresa.
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
  insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, metodo_pago, veces, actualizado_por)
  values (f.proveedor_id, f.empresa_id, p_cuenta, p_metodo, 1, u.nombre)
  on conflict (proveedor_id, empresa_id) do update set
    cuenta_contable = excluded.cuenta_contable, metodo_pago = excluded.metodo_pago,
    veces = proveedores_empresa.veces + 1, actualizado_por = excluded.actualizado_por, actualizado_en = now();
  perform registrar_auditoria(u, 'APROBACION', 'FACTURA', p_id::text, 'Cuenta ' || p_cuenta || ' · ' || p_metodo);
end $$;
