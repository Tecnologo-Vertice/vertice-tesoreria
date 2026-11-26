-- Tanda B1 · Organizaciones: el nivel por encima de las empresas (tablas y claves).
--
-- Hasta acá la base era de un solo grupo: 8 empresas, y "ver todas las empresas" quería decir todas las
-- de la base. Para poder dar el sistema a otras empresas hace falta saber de qué cliente es cada cosa.
-- Esta migración agrega la organización (el cliente) y le pone dueño a todo. Vértice es la primera y,
-- por ahora, la única: todo lo que ya existe queda a su nombre y nada cambia para el equipo.
--
--   · La organización se guarda en la empresa. Facturas, pagos, cuentas de origen, movimientos y la
--     memoria de proveedores ya tienen empresa obligatoria y la heredan de ahí: no llevan columna propia.
--   · Llevan columna propia las tablas que no tienen empresa (o la tienen opcional): usuarios,
--     proveedores, documentos, auditoría, cuentas y reglas contables, productos de Xubio y estado de la copia.
--   · Las claves únicas pasan a ser por organización (el mismo CUIT puede ser proveedor de dos clientes).
--
-- Quién ve qué no cambia en esta migración: las reglas de acceso se reescriben en la 0018.
--
-- Con una sola organización, nada de lo que escribe hoy (pantalla, funciones de Netlify, copia de la hoja,
-- puentes del Apps Script) necesita saber que existe: lo que no trae organización se asigna solo
-- (ver poner_organizacion). Con dos o más, lo que no se pueda deducir se rechaza con un mensaje claro
-- en vez de adivinar: eso se termina de resolver con los secretos por organización (grupo C).

-- ---------------------------------------------------------------- La tabla

create table organizaciones (
  id            uuid primary key default gen_random_uuid(),
  -- Nombre corto y estable, para verlo en consultas y reportes. Empieza con letra.
  slug          text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,39}$'),
  nombre        text not null,
  estado        text not null default 'ACTIVA' check (estado in ('ACTIVA', 'SUSPENDIDA', 'BAJA')),
  -- Verdadero solo para Vértice: la organización que da el servicio a las demás.
  es_proveedor  boolean not null default false,
  creado_en     timestamptz not null default now()
);
create unique index organizaciones_un_solo_proveedor on organizaciones (es_proveedor) where es_proveedor;
alter table organizaciones enable row level security;   -- sin regla de lectura hasta la 0018: nadie la lee
grant all on organizaciones to service_role;

insert into organizaciones (slug, nombre, es_proveedor) values ('vertice', 'Vértice', true);

-- ---------------------------------------------------------------- Funciones de apoyo

-- La única organización, si hay exactamente una. Con dos o más (o ninguna) devuelve null.
create or replace function organizacion_unica()
returns uuid language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then (array_agg(id))[1] end from organizaciones
$$;

-- Para lo que hace el servidor sin saber de quién es el dato (un mail de proveedor de la hoja, un pago
-- de la hoja sin empresa, un adjunto de Gmail). Mientras haya una sola organización, es esa. Con más de
-- una falla: es preferible que la copia se detenga a que cargue datos de un cliente en otro.
create or replace function organizacion_del_servidor()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  v := organizacion_unica();
  if v is null then
    raise exception 'Hay más de una organización y este proceso todavía no sabe para cuál trabaja (falta el secreto por organización)';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------- Columnas, con todo lo existente a nombre de Vértice

alter table empresas add column organizacion_id uuid references organizaciones;
update empresas set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table empresas alter column organizacion_id set not null;
create index on empresas (organizacion_id);

alter table usuarios add column organizacion_id uuid references organizaciones;   -- una persona, una organización
update usuarios set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table usuarios alter column organizacion_id set not null;
create index on usuarios (organizacion_id);

alter table proveedores add column organizacion_id uuid references organizaciones;
update proveedores set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table proveedores alter column organizacion_id set not null;
alter table proveedores drop constraint proveedores_cuit_key;
alter table proveedores add constraint proveedores_organizacion_cuit_key unique (organizacion_id, cuit);

alter table documentos add column organizacion_id uuid references organizaciones;
update documentos set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table documentos alter column organizacion_id set not null;
alter table documentos drop constraint documentos_gmail_message_id_nombre_archivo_key;
alter table documentos add constraint documentos_organizacion_mensaje_archivo_key unique (organizacion_id, gmail_message_id, nombre_archivo);
create index on documentos (organizacion_id, estado, recibido_en);

-- Auditoría: organización y, cuando el renglón habla de una factura o un pago, su empresa. La auditoría
-- no se modifica (0002): el trigger se apaga solo para completar las dos columnas nuevas.
alter table auditoria add column organizacion_id uuid references organizaciones;
alter table auditoria add column empresa_id text references empresas;
alter table auditoria disable trigger trg_auditoria_inmutable;
-- En una sola pasada, cruzando con facturas y pagos (una búsqueda por renglón tarda como facturas × auditoría).
update auditoria a set
  organizacion_id = (select id from organizaciones where slug = 'vertice'),
  empresa_id = x.empresa_id
from (
  select a2.id, coalesce(f.empresa_id, p.empresa_id) as empresa_id
  from auditoria a2
  left join facturas f on a2.entidad = 'FACTURA' and f.id::text = a2.entidad_id
  left join pagos p on a2.entidad = 'PAGO' and p.id::text = a2.entidad_id
) x
where x.id = a.id;
alter table auditoria enable trigger trg_auditoria_inmutable;
alter table auditoria alter column organizacion_id set not null;
create index on auditoria (organizacion_id, empresa_id);

-- Cuentas y reglas contables: las "comunes" (sin empresa) pasan a ser comunes de la organización.
alter table cuentas_contables add column organizacion_id uuid references organizaciones;
update cuentas_contables set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table cuentas_contables alter column organizacion_id set not null;
alter table cuentas_contables drop constraint cuentas_contables_empresa_id_nombre_key;
alter table cuentas_contables add constraint cuentas_contables_organizacion_empresa_nombre_key unique nulls not distinct (organizacion_id, empresa_id, nombre);

alter table reglas_cuenta add column organizacion_id uuid references organizaciones;
update reglas_cuenta set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table reglas_cuenta alter column organizacion_id set not null;

-- Productos de Xubio y estado de la copia de la hoja: uno por organización.
alter table productos_xubio add column organizacion_id uuid references organizaciones;
update productos_xubio set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table productos_xubio alter column organizacion_id set not null;
alter table productos_xubio drop constraint productos_xubio_pkey;
alter table productos_xubio add primary key (organizacion_id, nombre);

alter table espejo_estado add column organizacion_id uuid references organizaciones;
update espejo_estado set organizacion_id = (select id from organizaciones where slug = 'vertice');
alter table espejo_estado alter column organizacion_id set not null;
alter table espejo_estado drop constraint espejo_estado_pkey;
alter table espejo_estado add primary key (organizacion_id, hoja);

-- Va después de las columnas: una función en SQL se valida al crearla.
create or replace function organizacion_de_empresa(p_empresa text)
returns uuid language sql stable security definer set search_path = public as $$
  select organizacion_id from empresas where id = p_empresa
$$;

-- ---------------------------------------------------------------- De quién es cada registro nuevo

-- Completa organizacion_id en un registro nuevo que no la trae, en este orden:
--   1. la de su empresa, si la tabla tiene empresa y vino cargada (en la auditoría, la empresa de la
--      factura o el pago del renglón; en un documento, la de las empresas para las que se subió);
--   2. la de la persona que está haciendo la acción, si hay una sesión;
--   3. la única organización que existe.
-- Si no se puede deducir (hay más de una y no vino indicada), rechaza el registro: nunca adivina.
-- Si vino cargada y no coincide con la de la empresa, también lo rechaza. Y no deja cambiarla después.
create or replace function poner_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_empresa text; v_org uuid; v_lista text[];
begin
  if tg_op = 'UPDATE' then
    if new.organizacion_id is distinct from old.organizacion_id then
      raise exception 'La organización de un registro no se cambia (tabla %)', tg_table_name;
    end if;
    return new;
  end if;

  -- (Los campos propios de una tabla se miran en un "if" aparte: la función sirve para varias tablas.)
  if tg_table_name = 'auditoria' then
    if new.empresa_id is null and coalesce(new.entidad_id, '') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      if new.entidad = 'FACTURA' then select f.empresa_id into new.empresa_id from facturas f where f.id = new.entidad_id::uuid;
      elsif new.entidad = 'PAGO' then select p.empresa_id into new.empresa_id from pagos p where p.id = new.entidad_id::uuid;
      end if;
    end if;
  end if;

  v_empresa := to_jsonb(new) ->> 'empresa_id';
  if v_empresa is not null then
    select organizacion_id into v_org from empresas where id = v_empresa;
    if v_org is not null then
      if new.organizacion_id is null then new.organizacion_id := v_org;
      elsif new.organizacion_id <> v_org then
        raise exception 'La empresa % es de otra organización (tabla %)', v_empresa, tg_table_name;
      end if;
    end if;
  end if;

  if tg_table_name = 'documentos' then
    v_lista := new.empresas_permitidas;
    if new.organizacion_id is null and coalesce(array_length(v_lista, 1), 0) > 0 then
      select organizacion_id into new.organizacion_id from empresas where id = v_lista[1];
    end if;
  end if;

  if new.organizacion_id is null then new.organizacion_id := (usuario_actual()).organizacion_id; end if;
  if new.organizacion_id is null then new.organizacion_id := organizacion_unica(); end if;
  if new.organizacion_id is null then
    raise exception 'No se sabe de qué organización es el registro nuevo (tabla %): hay más de una organización y no vino indicada', tg_table_name;
  end if;

  if tg_table_name = 'documentos' and exists (
       select 1 from unnest(coalesce(v_lista, '{}')) x left join empresas e on e.id = x
       where e.id is null or e.organizacion_id <> new.organizacion_id) then
    raise exception 'El documento es para una empresa que no existe o que es de otra organización';
  end if;
  return new;
end $$;

create trigger trg_organizacion_empresas before insert or update on empresas for each row execute function poner_organizacion();
create trigger trg_organizacion_usuarios before insert or update on usuarios for each row execute function poner_organizacion();
create trigger trg_organizacion_proveedores before insert or update on proveedores for each row execute function poner_organizacion();
create trigger trg_organizacion_documentos before insert or update on documentos for each row execute function poner_organizacion();
create trigger trg_organizacion_cuentas_contables before insert or update on cuentas_contables for each row execute function poner_organizacion();
create trigger trg_organizacion_reglas_cuenta before insert or update on reglas_cuenta for each row execute function poner_organizacion();
create trigger trg_organizacion_productos_xubio before insert or update on productos_xubio for each row execute function poner_organizacion();
create trigger trg_organizacion_espejo_estado before insert or update on espejo_estado for each row execute function poner_organizacion();
-- La auditoría no se modifica: solo al insertar.
create trigger trg_organizacion_auditoria before insert on auditoria for each row execute function poner_organizacion();

-- ---------------------------------------------------------------- Nada cruza de una organización a otra

-- Una persona solo puede tener asignadas empresas de su organización.
create or replace function usuario_empresa_misma_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select organizacion_id from usuarios where email = new.email)
     is distinct from (select organizacion_id from empresas where id = new.empresa_id) then
    raise exception 'La empresa % es de otra organización que el usuario %', new.empresa_id, new.email;
  end if;
  return new;
end $$;
create trigger trg_usuarios_empresas_organizacion before insert or update on usuarios_empresas
  for each row execute function usuario_empresa_misma_organizacion();

-- El proveedor de una factura, de un pago, de la memoria o de una regla es de la misma organización
-- que la empresa. Las funciones ya lo buscan por organización; esto cubre cualquier otro camino
-- (por ejemplo, un pago cargado con el identificador de un proveedor ajeno).
create or replace function proveedor_misma_organizacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fila jsonb; v_org uuid; v_org_prov uuid;
begin
  if new.proveedor_id is null then return new; end if;
  v_fila := to_jsonb(new);
  v_org := coalesce((select organizacion_id from empresas where id = v_fila ->> 'empresa_id'), (v_fila ->> 'organizacion_id')::uuid);
  select organizacion_id into v_org_prov from proveedores where id = new.proveedor_id;
  if v_org_prov is not null and v_org is not null and v_org_prov <> v_org then
    raise exception 'El proveedor es de otra organización';
  end if;
  return new;
end $$;
create trigger trg_proveedor_organizacion_facturas before insert or update of proveedor_id, empresa_id on facturas
  for each row execute function proveedor_misma_organizacion();
create trigger trg_proveedor_organizacion_pagos before insert or update of proveedor_id, empresa_id on pagos
  for each row execute function proveedor_misma_organizacion();
create trigger trg_proveedor_organizacion_memoria before insert or update of proveedor_id, empresa_id on proveedores_empresa
  for each row execute function proveedor_misma_organizacion();
-- En reglas_cuenta corre después de trg_organizacion_reglas_cuenta (orden alfabético), que ya completó la organización.
create trigger trg_proveedor_organizacion_reglas before insert or update of proveedor_id, empresa_id on reglas_cuenta
  for each row execute function proveedor_misma_organizacion();

-- ---------------------------------------------------------------- Funciones que dan de alta proveedores, cuentas o documentos
--
-- Son las mismas de 0003, 0005, 0008, 0009 y 0013, con un solo cambio: el proveedor, la cuenta, el
-- producto y el documento se buscan y se crean dentro de la organización de la empresa (antes, en toda
-- la base). En la copia de pagos, además, la factura vinculada y el proveedor por nombre se buscan solo
-- en esa organización.

-- registrar_documento (0013). La organización: la que venga en p (la de quien lo sube), si no la de las
-- empresas para las que se subió, si no la del servidor.
create or replace function registrar_documento(p jsonb)
returns table (id uuid, nuevo boolean) language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_org uuid; v_lista text[];
begin
  v_lista := case when jsonb_typeof(p -> 'empresas_permitidas') = 'array'
                  then array(select jsonb_array_elements_text(p -> 'empresas_permitidas')) end;
  v_org := nullif(p ->> 'organizacion_id', '')::uuid;
  if v_org is null and coalesce(array_length(v_lista, 1), 0) > 0 then
    select e.organizacion_id into v_org from empresas e where e.id = v_lista[1];
  end if;
  if v_org is null then v_org := organizacion_del_servidor(); end if;

  insert into documentos (organizacion_id, origen, gmail_message_id, nombre_archivo, mime_type, storage_path, tamano, remitente, asunto, cargado_por,
                          empresas_permitidas)
  values (v_org, p ->> 'origen', nullif(p ->> 'gmail_message_id', ''), p ->> 'nombre_archivo', p ->> 'mime_type', p ->> 'storage_path',
          (p ->> 'tamano')::int, p ->> 'remitente', p ->> 'asunto', p ->> 'cargado_por', v_lista)
  on conflict (organizacion_id, gmail_message_id, nombre_archivo) do nothing
  returning documentos.id into v_id;
  if v_id is not null then return query select v_id, true; return; end if;
  return query select d.id, false from documentos d
    where d.organizacion_id = v_org and d.gmail_message_id = nullif(p ->> 'gmail_message_id', '') and d.nombre_archivo = p ->> 'nombre_archivo';
end $$;

-- ingresar_factura (0003)
create or replace function ingresar_factura(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_prov uuid; v_id uuid; v_cuit text; v_org uuid;
begin
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;
  select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
  if v_org is null then raise exception 'Empresa inexistente: %', coalesce(p ->> 'empresa_id', '(vacía)'); end if;
  insert into proveedores (organizacion_id, cuit, nombre, email, categoria_vertice)
  values (v_org, v_cuit, coalesce(p ->> 'proveedor', 'Sin nombre'), nullif(p ->> 'email_proveedor', ''), p ->> 'categoria_vertice')
  on conflict (organizacion_id, cuit) do update set nombre = excluded.nombre, categoria_vertice = coalesce(excluded.categoria_vertice, proveedores.categoria_vertice)
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

-- guardar_factura_leida (0005)
create or replace function guardar_factura_leida(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d documentos; v_prov uuid; v_id uuid; v_existente uuid; m proveedores_empresa; v_cuit text; v_estado estado_factura; v_org uuid;
begin
  select * into d from documentos where id = p_doc for update;
  if d.id is null then raise exception 'Documento inexistente'; end if;
  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'CUIT de proveedor inválido: %', p ->> 'cuit_proveedor'; end if;

  select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
  if v_org is null then raise exception 'Empresa inexistente: %', coalesce(p ->> 'empresa_id', '(vacía)'); end if;
  insert into proveedores (organizacion_id, cuit, nombre) values (v_org, v_cuit, coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'))
  on conflict (organizacion_id, cuit) do update set nombre = proveedores.nombre    -- el nombre ya cargado manda
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

-- espejar_facturas (0008)
create or replace function espejar_facturas(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; v_prov uuid; v_id uuid; v_gestion text; v_hash text; v_org uuid;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
      if v_org is null then raise exception 'Empresa inexistente: %', coalesce(p ->> 'empresa_id', '(vacía)'); end if;
      insert into proveedores (organizacion_id, cuit, nombre, categoria_vertice)
      values (v_org, p ->> 'cuit_proveedor', coalesce(nullif(p ->> 'proveedor', ''), 'Sin nombre'), nullif(p ->> 'categoria_vertice', ''))
      on conflict (organizacion_id, cuit) do update set categoria_vertice = coalesce(proveedores.categoria_vertice, excluded.categoria_vertice)
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

-- espejar_pagos (0008)
create or replace function espejar_pagos(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p jsonb; ref jsonb; v_id uuid; v_gestion text; v_hash text; v_emp text; v_prov uuid; v_org uuid; v_emp_previa text;
  v_fids uuid[]; v_totales numeric[]; v_fid uuid; v_femp text; v_fprov uuid; v_ftotal numeric; v_suma numeric; v_imp numeric; i int;
  n_nuevas int := 0; n_act int := 0; n_igual int := 0; omitidas jsonb := '[]';
begin
  perform set_config('vertice.espejo', 'si', true);
  for p in select value from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) loop
    begin
      v_emp := nullif(p ->> 'empresa_id', '');
      -- De qué organización es la fila: la de su empresa; si la fila no trae empresa, la del servidor
      -- (mientras haya una sola organización es esa; con más de una, hay que saber de quién es la hoja).
      if v_emp is not null then
        select organizacion_id into v_org from empresas where id = v_emp;
        if v_org is null then raise exception 'Empresa inexistente: %', v_emp; end if;
      else
        v_org := organizacion_del_servidor();
      end if;
      v_prov := null; v_fids := '{}'; v_totales := '{}';
      for ref in select value from jsonb_array_elements(coalesce(p -> 'facturas', '[]'::jsonb)) loop
        v_fid := null;
        select f.id, f.empresa_id, f.proveedor_id, f.total into v_fid, v_femp, v_fprov, v_ftotal
        from facturas f join proveedores pr on pr.id = f.proveedor_id join empresas em on em.id = f.empresa_id
        where f.punto_venta = (ref ->> 'punto_venta')::int and f.numero = (ref ->> 'numero')::int
          and (v_emp is null or f.empresa_id = v_emp) and em.organizacion_id = v_org
        order by (texto_comparable(pr.nombre) = texto_comparable(p ->> 'proveedor_destino')) desc, f.fecha desc
        limit 1;
        if v_fid is not null and not (v_fid = any(v_fids)) then
          v_fids := v_fids || v_fid; v_totales := v_totales || v_ftotal;
          v_emp := coalesce(v_emp, v_femp); v_prov := coalesce(v_prov, v_fprov);
        end if;
      end loop;
      if v_emp is null then raise exception 'No se sabe de qué empresa es el pago (EMPRESA y REALIZADO_POR vacíos, sin factura vinculada)'; end if;
      if v_prov is null and coalesce(p ->> 'proveedor_destino', '') <> '' then
        select id into v_prov from proveedores where organizacion_id = v_org and texto_comparable(nombre) = texto_comparable(p ->> 'proveedor_destino') limit 1;
      end if;
      p := p || jsonb_build_object('empresa_id', v_emp, 'proveedor_id', v_prov,
                                   'cargado_en', coalesce(p ->> 'cargado_en', now()::text), 'cargado_por', coalesce(p ->> 'cargado_por', 'Apps Script'));

      select id, gestion, hoja_hash, empresa_id into v_id, v_gestion, v_hash, v_emp_previa from pagos where hoja_id = p ->> 'hoja_id';
      -- El ID_PAGO de la hoja es único en toda la base: si ya lo usa un pago de otra organización, no se toca.
      if v_id is not null and organizacion_de_empresa(v_emp_previa) is distinct from v_org then
        raise exception 'El pago % ya existe en otra organización', p ->> 'hoja_id';
      end if;

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

-- espejar_catalogos (0008)
create or replace function espejar_catalogos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_prov uuid; v_org uuid; n jsonb := '{}';
begin
  perform set_config('vertice.espejo', 'si', true);

  -- Cada cuenta es de la organización de su empresa. Sin empresa (común), de la del servidor.
  insert into cuentas_contables (organizacion_id, empresa_id, nombre, codigo, xubio_id, activa)
  select coalesce(e.organizacion_id, organizacion_del_servidor()), x ->> 'empresa_id', x ->> 'nombre', x ->> 'codigo', x ->> 'xubio_id', true
  from jsonb_array_elements(coalesce(p -> 'cuentas', '[]'::jsonb)) x left join empresas e on e.id = x ->> 'empresa_id'
  on conflict (organizacion_id, empresa_id, nombre) do update set codigo = excluded.codigo, xubio_id = excluded.xubio_id, activa = true;
  n := n || jsonb_build_object('cuentas', jsonb_array_length(coalesce(p -> 'cuentas', '[]'::jsonb)));

  insert into cuentas_origen (empresa_id, nombre, xubio_id, tipo_cuenta, codigo, usos, ultimo_uso)
  select x ->> 'empresa_id', x ->> 'nombre', x ->> 'xubio_id', (x ->> 'tipo_cuenta')::int, x ->> 'codigo',
         coalesce((x ->> 'usos')::int, 0), (x ->> 'ultimo_uso')::date
  from jsonb_array_elements(coalesce(p -> 'origen', '[]'::jsonb)) x
  on conflict (empresa_id, nombre) do update set xubio_id = excluded.xubio_id, tipo_cuenta = excluded.tipo_cuenta,
    codigo = excluded.codigo, usos = excluded.usos, ultimo_uso = excluded.ultimo_uso;
  n := n || jsonb_build_object('origen', jsonb_array_length(coalesce(p -> 'origen', '[]'::jsonb)));

  for r in select value from jsonb_array_elements(coalesce(p -> 'porEmpresa', '[]'::jsonb)) loop
    select organizacion_id into v_org from empresas where id = r ->> 'empresa_id';
    if v_org is null then raise exception 'Empresa inexistente: %', coalesce(r ->> 'empresa_id', '(vacía)'); end if;
    insert into proveedores (organizacion_id, cuit, nombre) values (v_org, r ->> 'cuit', coalesce(nullif(r ->> 'nombre_xubio', ''), 'Sin nombre'))
    on conflict (organizacion_id, cuit) do update set nombre = proveedores.nombre
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
    -- Los mails no traen empresa: son de la organización del servidor (ver organizacion_del_servidor).
    insert into proveedores (organizacion_id, cuit, nombre, email) values (organizacion_del_servidor(), r ->> 'cuit', r ->> 'proveedor', r ->> 'email')
    on conflict (organizacion_id, cuit) do update set email = excluded.email;
  end loop;
  n := n || jsonb_build_object('emails', jsonb_array_length(coalesce(p -> 'emails', '[]'::jsonb)));

  insert into productos_xubio (organizacion_id, nombre, codigo)
  select organizacion_del_servidor(), x ->> 'nombre', x ->> 'codigo' from jsonb_array_elements(coalesce(p -> 'productos', '[]'::jsonb)) x
  on conflict (organizacion_id, nombre) do update set codigo = excluded.codigo;
  n := n || jsonb_build_object('productos', jsonb_array_length(coalesce(p -> 'productos', '[]'::jsonb)));

  return n;
end $$;

-- editar_factura (0009)
create or replace function editar_factura(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; f facturas; n facturas; v_cuit text; v_prov uuid; v_tipo text; v_cae text;
  v_neto numeric; v_iva numeric; v_exento numeric; v_perc numeric; v_total numeric; v_dif numeric;
  v_motivo text; v_estado estado_factura; v_cambios text; v_org uuid;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado not in ('PENDIENTE_APROBACION', 'ERROR', 'PARA_PAGAR') or f.pagado > 0 then
    raise exception 'Solo se editan facturas sin pagos (pendientes, en excepciones o para pagar)';
  end if;
  if f.estado_xubio = 'SUBIDA' then
    raise exception 'La factura ya está en Xubio: corregila en Xubio y volvé a traerla';
  end if;

  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'El CUIT del proveedor tiene que tener 11 dígitos'; end if;
  select organizacion_id into v_org from empresas where id = p ->> 'empresa_id';
  if v_org is null then raise exception 'Elegí la empresa que recibe la factura'; end if;
  if coalesce((p ->> 'numero')::int, 0) <= 0 then raise exception 'Falta el número del comprobante'; end if;
  if (p ->> 'fecha') is null then raise exception 'Falta la fecha de emisión'; end if;

  insert into proveedores (organizacion_id, cuit, nombre) values (v_org, v_cuit, coalesce(nullif(trim(p ->> 'proveedor'), ''), 'Sin nombre'))
  on conflict (organizacion_id, cuit) do update set nombre = coalesce(nullif(trim(excluded.nombre), ''), proveedores.nombre)
  returning id into v_prov;

  -- Validación de producción (validarFactura_): tipo, CAE de 14 dígitos y que cierre el total (±1 peso).
  v_tipo := nullif(trim(p ->> 'tipo'), '');
  v_cae := regexp_replace(coalesce(p ->> 'cae', ''), '\D', '', 'g');
  v_neto := coalesce((p ->> 'neto')::numeric, 0);
  v_iva := coalesce((p ->> 'iva')::numeric, 0);
  v_exento := coalesce((p ->> 'exento')::numeric, 0);
  select coalesce(sum((x ->> 'importe')::numeric), 0) into v_perc from jsonb_array_elements(coalesce(p -> 'percepciones_json', '[]'::jsonb)) x;
  v_total := coalesce((p ->> 'total')::numeric, 0);
  v_dif := round(v_total - (v_neto + v_iva + v_exento + v_perc), 2);
  v_motivo := case
    when v_tipo is null or v_tipo = 'Sin tipo' then 'Comprobante sin tipo válido'
    when v_total <= 0 then 'El total tiene que ser mayor a cero'
    when length(v_cae) <> 14 then 'El CAE tiene que tener 14 dígitos (tiene ' || length(v_cae) || ')'
    when abs(v_dif) >= 1 then 'Descuadre de $' || abs(v_dif) || ' entre el total y neto + IVA + exento + percepciones'
  end;
  v_estado := case
    when f.estado = 'PARA_PAGAR' then 'PARA_PAGAR'
    when v_motivo is null then 'PENDIENTE_APROBACION'
    else 'ERROR'
  end;

  begin
    update facturas set
      empresa_id = p ->> 'empresa_id', proveedor_id = v_prov, tipo = coalesce(v_tipo, 'Sin tipo'),
      letra = nullif(upper(left(trim(coalesce(p ->> 'letra', '')), 1)), ''),
      punto_venta = coalesce((p ->> 'punto_venta')::int, 0), numero = (p ->> 'numero')::int,
      fecha = (p ->> 'fecha')::date, vencimiento = coalesce(nullif(p ->> 'vencimiento', '')::date, (p ->> 'fecha')::date),
      moneda = coalesce(nullif(p ->> 'moneda', ''), 'ARS'), cotizacion = coalesce(nullif(p ->> 'cotizacion', '')::numeric, 1),
      neto = v_neto, iva = v_iva, exento = v_exento, percepciones = v_perc,
      percepciones_json = coalesce(p -> 'percepciones_json', '[]'::jsonb), total = v_total,
      cae = nullif(v_cae, ''), cae_vencimiento = nullif(p ->> 'cae_vencimiento', '')::date,
      categoria_vertice = coalesce(nullif(p ->> 'categoria_vertice', ''), categoria_vertice),
      cuenta_contable = coalesce(nullif(p ->> 'cuenta_contable', ''), cuenta_contable),
      codigo_producto = coalesce(nullif(p ->> 'codigo_producto', ''), codigo_producto),
      validacion_ok = v_motivo is null, motivo_validacion = v_motivo, estado = v_estado,
      gestion = 'SISTEMA', actualizado_en = now()
    where id = p_id
    returning * into n;
  exception when unique_violation then
    raise exception 'Ya hay otra factura de ese proveedor con el mismo tipo y número en esa empresa';
  end;

  -- Qué cambió, para la auditoría.
  select string_agg(o.key, ', ' order by o.key) into v_cambios
  from jsonb_each(to_jsonb(f)) o join jsonb_each(to_jsonb(n)) x using (key)
  where o.value is distinct from x.value and o.key not in ('actualizado_en', 'gestion', 'validacion_ok', 'motivo_validacion', 'estado', 'percepciones');
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle, antes, despues)
  values (u.nombre, u.rol, 'EDICION', 'FACTURA', p_id::text,
          'Datos corregidos a mano: ' || coalesce(v_cambios, 'sin cambios') || case when v_motivo is null then '' else ' · queda en excepciones: ' || v_motivo end,
          to_jsonb(f), to_jsonb(n));
  return jsonb_build_object('estado', v_estado, 'motivo', v_motivo, 'cambios', v_cambios);
end $$;

-- ---------------------------------------------------------------- Permisos

-- Las funciones de arriba conservan los permisos que ya tenían (se reemplazaron, no se crearon).
revoke execute on function organizacion_unica(), organizacion_de_empresa(text), organizacion_del_servidor(),
  poner_organizacion(), usuario_empresa_misma_organizacion(), proveedor_misma_organizacion()
  from public, anon, authenticated;
grant execute on function organizacion_unica(), organizacion_de_empresa(text), organizacion_del_servidor() to service_role;
