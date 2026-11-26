-- Tanda C2 · Secretos por organización para los puentes del Apps Script y las tareas programadas.
--
-- Hasta acá los puentes (copia de la hoja, cartero, ingesta, cheques, flujo) entraban con un solo secreto
-- (INGESTA_TOKEN) que no dice de qué organización es. Con dos organizaciones se detenían (409). Desde acá:
--
--   · Cada organización puede tener secretos propios, uno por tipo de tarea, en tokens_integracion. La base
--     guarda solo el resumen (SHA-256) del secreto, nunca el secreto. Se crean con crear_token_integracion
--     (devuelve el secreto una sola vez) y se revocan con activo = false, sin redesplegar.
--   · INGESTA_TOKEN no se retira: mientras exista la variable, vale para la organización que da el servicio
--     (Vértice, es_proveedor) en todas las tareas. El Apps Script de Vértice no cambia.
--   · El servidor sabe para qué organización trabaja y se lo dice a la base: las funciones de la copia de la
--     hoja, cheques, flujo y subida a Xubio tienen una versión con la organización. Lo que no trae empresa
--     (mails de proveedores, productos, pagos de la hoja sin empresa) queda a nombre de esa organización, y
--     una fila que dice una empresa de otra organización se omite o se rechaza.
--   · Las versiones sin organización siguen existiendo (el código publicado antes de esta tanda las usa) y
--     se comportan como antes mientras haya una sola organización. Con dos, se detienen: no adivinan.

-- ---------------------------------------------------------------- Secretos por organización y tarea

create table tokens_integracion (
  id               uuid primary key default gen_random_uuid(),
  organizacion_id  uuid not null references organizaciones,
  -- Qué puede hacer: INGESTA (cartero de Gmail y Drive, facturas leídas por el Apps Script), COPIA_HOJA
  -- (/api/espejo), CHEQUES (/api/cheques/*), FLUJO (/api/flujo/datos).
  tarea            text not null check (tarea in ('INGESTA', 'COPIA_HOJA', 'CHEQUES', 'FLUJO')),
  nombre           text not null,
  -- SHA-256 del secreto, en hexadecimal. El secreto no se guarda.
  huella           text not null unique check (huella ~ '^[0-9a-f]{64}$'),
  activo           boolean not null default true,
  ultimo_uso       timestamptz,
  creado_por       text not null,
  creado_en        timestamptz not null default now()
);
create index on tokens_integracion (organizacion_id, tarea);
alter table tokens_integracion enable row level security;   -- sin reglas: ninguna sesión de persona lee una fila
revoke all on tokens_integracion from public, anon, authenticated;
grant select, insert, update, delete on tokens_integracion to service_role;

-- Crea un secreto para una organización y una tarea. Devuelve el secreto UNA sola vez: en la base queda
-- solo su resumen. Formato: vti_ + 64 caracteres hexadecimales: el SHA-256 de tres UUID al azar (366 bits
-- al azar de entrada, 256 de salida). Solo para una organización activa.
-- Solo el servidor o el editor SQL de Supabase. Ejemplo:
--   select crear_token_integracion((select id from organizaciones where slug = 'otra'), 'COPIA_HOJA', 'Apps Script de Otra');
create or replace function crear_token_integracion(p_organizacion uuid, p_tarea text, p_nombre text, p_creado_por text default 'SQL')
returns text language plpgsql security definer set search_path = public as $$
declare v_secreto text;
begin
  if not exists (select 1 from organizaciones where id = p_organizacion) then
    raise exception 'La organización % no existe', p_organizacion;
  end if;
  if not exists (select 1 from organizaciones where id = p_organizacion and estado = 'ACTIVA') then
    raise exception 'La organización % no está activa: no se le crean tokens', p_organizacion;
  end if;
  v_secreto := 'vti_' || encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  insert into tokens_integracion (organizacion_id, tarea, nombre, huella, creado_por)
  values (p_organizacion, p_tarea, coalesce(nullif(trim(p_nombre), ''), p_tarea), encode(sha256(convert_to(v_secreto, 'UTF8')), 'hex'), coalesce(p_creado_por, 'SQL'));
  return v_secreto;
end $$;

-- Crear, revocar, reactivar o borrar un token deja un renglón en la auditoría de su organización: quién,
-- cuándo, la tarea y el nombre. Nunca el secreto ni su resumen. Anotar el último uso no se registra.
create or replace function auditar_token_integracion()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fila tokens_integracion; v_accion text; v_usuario text;
begin
  if tg_op = 'DELETE' then v_fila := old; else v_fila := new; end if;
  if tg_op = 'UPDATE' and new.activo is not distinct from old.activo then return new; end if;
  v_accion := case
    when tg_op = 'INSERT' then 'TOKEN_INTEGRACION_CREADO'
    when tg_op = 'DELETE' then 'TOKEN_INTEGRACION_BORRADO'
    when new.activo then 'TOKEN_INTEGRACION_REACTIVADO'
    else 'TOKEN_INTEGRACION_REVOCADO' end;
  v_usuario := case when tg_op = 'INSERT' then v_fila.creado_por else coalesce(nullif(auth.jwt() ->> 'email', ''), session_user::text) end;
  insert into auditoria (organizacion_id, usuario, accion, entidad, entidad_id, detalle)
  values (v_fila.organizacion_id, v_usuario, v_accion, 'TOKEN_INTEGRACION', v_fila.id::text,
          'Token ' || v_fila.tarea || ' "' || v_fila.nombre || '"');
  return null;
end $$;
create trigger trg_auditar_token_integracion after insert or update or delete on tokens_integracion for each row execute function auditar_token_integracion();

-- ---------------------------------------------------------------- Para qué organización trabaja el servidor

-- La organización que el servidor dijo para este pedido (fijar_organizacion_del_proceso), o null.
-- Vale solo dentro de la transacción del pedido: cada llamada a la API es una transacción aparte.
create or replace function organizacion_del_proceso()
returns uuid language sql stable security definer set search_path = public as $$
  select nullif(current_setting('vertice.organizacion', true), '')::uuid
$$;

-- El servidor dice para qué organización trabaja. Tiene que existir y estar activa.
create or replace function fijar_organizacion_del_proceso(p_organizacion uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_organizacion is null then raise exception 'Falta la organización'; end if;
  if not exists (select 1 from organizaciones where id = p_organizacion and estado = 'ACTIVA') then
    raise exception 'La organización % no existe o no está activa', p_organizacion;
  end if;
  perform set_config('vertice.organizacion', p_organizacion::text, true);
end $$;

-- (0017) Ahora primero mira la organización que dijo el servidor; si no dijo ninguna, la única que haya.
create or replace function organizacion_del_servidor()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  v := coalesce(organizacion_del_proceso(), organizacion_unica());
  if v is null then
    raise exception 'Hay más de una organización y este proceso todavía no sabe para cuál trabaja (falta el secreto por organización)';
  end if;
  return v;
end $$;

-- poner_organizacion (0017): el último recurso pasa a ser la organización que dijo el servidor y, si no
-- dijo ninguna, la única. Es la misma función con ese único cambio. Con sesión de persona sigue mandando
-- la organización de la persona (va antes).
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
  if new.organizacion_id is null then new.organizacion_id := coalesce(organizacion_del_proceso(), organizacion_unica()); end if;
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

-- ---------------------------------------------------------------- Copia de la hoja, por organización

-- Las filas que dicen una empresa de otra organización se omiten con el motivo; el resto va a la función
-- de siempre, que deja a nombre de la organización lo que no trae empresa.
create or replace function filas_de_otra_organizacion(p_filas jsonb, p_organizacion uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('fila', x -> 'sheets_fila_origen', 'motivo',
           'La empresa ' || (x ->> 'empresa_id') || ' no existe o es de otra organización')), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) x
  where nullif(x ->> 'empresa_id', '') is not null
    and organizacion_de_empresa(x ->> 'empresa_id') is distinct from p_organizacion
$$;

create or replace function filas_de_la_organizacion(p_filas jsonb, p_organizacion uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_filas, '[]'::jsonb)) x
  where nullif(x ->> 'empresa_id', '') is null
     or organizacion_de_empresa(x ->> 'empresa_id') = p_organizacion
$$;

create or replace function espejar_facturas(p_filas jsonb, p_organizacion uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform fijar_organizacion_del_proceso(p_organizacion);
  r := espejar_facturas(filas_de_la_organizacion(p_filas, p_organizacion));
  return jsonb_set(r, '{omitidas}', filas_de_otra_organizacion(p_filas, p_organizacion) || (r -> 'omitidas'));
end $$;

create or replace function espejar_pagos(p_filas jsonb, p_organizacion uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  perform fijar_organizacion_del_proceso(p_organizacion);
  r := espejar_pagos(filas_de_la_organizacion(p_filas, p_organizacion));
  return jsonb_set(r, '{omitidas}', filas_de_otra_organizacion(p_filas, p_organizacion) || (r -> 'omitidas'));
end $$;

-- Los catálogos van en un solo bloque: si alguna parte dice una empresa de otra organización, no se copia nada.
create or replace function espejar_catalogos(p jsonb, p_organizacion uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ajena text;
begin
  perform fijar_organizacion_del_proceso(p_organizacion);
  select x ->> 'empresa_id' into v_ajena
  from jsonb_array_elements(coalesce(p -> 'cuentas', '[]'::jsonb) || coalesce(p -> 'origen', '[]'::jsonb) || coalesce(p -> 'porEmpresa', '[]'::jsonb)) x
  where nullif(x ->> 'empresa_id', '') is not null and organizacion_de_empresa(x ->> 'empresa_id') is distinct from p_organizacion
  limit 1;
  if v_ajena is not null then
    raise exception 'Los catálogos traen la empresa %, que no existe o es de otra organización: no se copió nada', v_ajena;
  end if;
  return espejar_catalogos(p);
end $$;

-- ---------------------------------------------------------------- Cheques, flujo y subida a Xubio, por organización

-- cheques_para_cashflow (0012), solo los pagos de las empresas de la organización.
create or replace function cheques_para_cashflow(p_desde timestamptz, p_organizacion uuid)
returns table (pago_id uuid, empresa_id text, numero text, banco text, tipo_cheque text, medio text, proveedor text,
               importe numeric, emision timestamptz, deposito date, texto text)
language sql stable security definer set search_path = public as $$
  select p.id, p.empresa_id, trim(p.numero_cheque), coalesce(nullif(p.banco_origen, ''), p.cuenta_origen, ''),
         coalesce(p.tipo_cheque, ''), p.medio::text, coalesce(pr.nombre, p.proveedor_destino, ''),
         p.importe, p.cargado_en, coalesce(p.fecha_acreditacion, p.fecha),
         coalesce(p.descripcion, '') || ' ' || coalesce(p.observaciones, '')
  from pagos p join empresas e on e.id = p.empresa_id left join proveedores pr on pr.id = p.proveedor_id
  where e.organizacion_id = p_organizacion
    and coalesce(trim(p.numero_cheque), '') <> '' and p.importe > 0 and p.cheque_cashflow is null
    and p.estado::text <> 'ANULADO' and p.gestion = 'SISTEMA'
    and (p.estado = 'CONTABILIZADO' or p.fecha_acreditacion is not null)
    and p.cargado_en >= p_desde
  order by p.cargado_en, p.id
$$;

-- marcar_cheques_cashflow (0012): solo marca pagos de las empresas de la organización.
create or replace function marcar_cheques_cashflow(p jsonb, p_organizacion uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0;
begin
  for r in select value from jsonb_array_elements(coalesce(p, '[]'::jsonb)) loop
    if coalesce(r ->> 'estado', '') = '' then continue; end if;
    update pagos set cheque_cashflow = left(r ->> 'estado', 300)
    where id = (r ->> 'pago_id')::uuid and cheque_cashflow is null
      and empresa_id in (select e.id from empresas e where e.organizacion_id = p_organizacion);
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- flujo_datos (0012), solo pagos y facturas de las empresas de la organización.
create or replace function flujo_datos(p_organizacion uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pagos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ID_PAGO', coalesce(p.hoja_id, p.id::text),
        'FECHA_PAGO', p.fecha,
        'IMPORTE', p.importe,
        'EMPRESA', e.nombre,
        'REALIZADO_POR', coalesce(p.realizado_por, p.cargado_por, ''),
        'BANCO_ORIGEN', coalesce(nullif(p.banco_origen, ''), p.cuenta_origen, ''),
        'CUENTA_ORIGEN', coalesce(p.cuenta_origen, ''),
        'BANCO_DESTINO', coalesce(p.banco_destino, ''),
        'PROVEEDOR_DESTINO', coalesce(pr.nombre, p.proveedor_destino, ''),
        'CUIT_DESTINO', coalesce(pr.cuit, ''),
        'CUENTA_CONTABLE', coalesce(p.cuenta_contable, ''),
        'DESCRIPCION_PAGO', coalesce(p.descripcion, ''),
        'OBSERVACIONES_TESORERIA', coalesce(p.observaciones, ''),
        'NUMERO_CHEQUE', coalesce(p.numero_cheque, ''),
        'TIPO_CHEQUE', coalesce(p.tipo_cheque, case p.medio when 'ECHEQ' then 'ECHEQ' when 'CHEQUE' then 'FISICO' else '' end),
        'FECHA_VTO_CHEQUE', p.fecha_acreditacion,
        'FACTURA_ASOCIADA', coalesce(p.factura_asociada, (
          select string_agg(f.numero::text, ', ') from pagos_facturas pf join facturas f on f.id = pf.factura_id where pf.pago_id = p.id), ''),
        -- ESPERA_FC = pago a un proveedor sin factura todavía (anticipo): descuenta de su proyección.
        'ESTADO_CONTABLE', case
          when p.estado::text = 'ANULADO' then 'ANULADO'
          when p.estado::text in ('CONTABILIZADO', 'CONCILIADO') then 'CONTABILIZADA'
          when p.proveedor_id is not null and p.forma_carga_xubio = 'ORDEN_PAGO'
               and not exists (select 1 from pagos_facturas pf where pf.pago_id = p.id)
               and coalesce(p.factura_asociada, '') = '' then 'ESPERA_FC'
          else 'PENDIENTE' end
      ) order by p.fecha, p.id)
      from pagos p join empresas e on e.id = p.empresa_id left join proveedores pr on pr.id = p.proveedor_id
      where e.organizacion_id = p_organizacion
    ), '[]'::jsonb),
    'facturas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'NUMERO', f.numero,
        'TIPO', f.tipo,
        'RECEPTOR', e.nombre,
        'PROVEEDOR', pr.nombre,
        'CUIT_PROVEEDOR', pr.cuit,
        'FECHA', f.fecha,
        'VENCIMIENTODELPAGO', f.vencimiento,
        'TOTAL', f.total,
        'PORCENTAJE_PAGADO', f.pagado_pct,
        'ESTADO_APROBACION', case when f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA') then 'APROBADA' else f.estado::text end,
        'ESTADO_PAGO', case when f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') then 'PARA_PAGAR' else f.estado::text end,
        'YA_PAGADA_SEGUN_ADMIN', coalesce(f.ya_pagada_segun_admin, ''),
        'METODO_PAGO', case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null
                            then 'CHEQUE ' || f.dias_cheque || ' DIAS' else coalesce(f.metodo_pago::text, '') end,
        'CATEGORIA_CONTABLE', coalesce(f.cuenta_contable, f.categoria_ia, ''),
        'OBSERVACIONES', coalesce(f.advertencia, ''),
        'PRODUCTOSERVICIOPERCEPCION', coalesce(f.codigo_producto, '')
      ) order by f.vencimiento nulls last, f.id)
      from facturas f join empresas e on e.id = f.empresa_id join proveedores pr on pr.id = f.proveedor_id
      where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and e.organizacion_id = p_organizacion
    ), '[]'::jsonb)
  )
$$;

-- facturas_para_xubio (0006), solo las de las empresas de la organización (el subidor recorre organización por organización).
create or replace function facturas_para_xubio(p_max integer, p_organizacion uuid)
returns setof facturas language sql security definer set search_path = public as $$
  select f.* from facturas f join empresas e on e.id = f.empresa_id
  where e.organizacion_id = p_organizacion and e.erp = 'XUBIO' and f.estado_xubio = 'PENDIENTE' and f.xubio_envio_en is null
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA')
  order by f.aprobado_en nulls last
  limit p_max
$$;

-- Las versiones de antes (las usa el código publicado hasta esta tanda): con una sola organización dan lo
-- mismo que siempre; con dos o más se detienen (organizacion_del_servidor), en vez de devolver todo.
create or replace function cheques_para_cashflow(p_desde timestamptz)
returns table (pago_id uuid, empresa_id text, numero text, banco text, tipo_cheque text, medio text, proveedor text,
               importe numeric, emision timestamptz, deposito date, texto text)
language sql stable security definer set search_path = public as $$
  select * from cheques_para_cashflow(p_desde, organizacion_del_servidor())
$$;

create or replace function marcar_cheques_cashflow(p jsonb)
returns integer language sql security definer set search_path = public as $$
  select marcar_cheques_cashflow(p, organizacion_del_servidor())
$$;

create or replace function flujo_datos()
returns jsonb language sql stable security definer set search_path = public as $$
  select flujo_datos(organizacion_del_servidor())
$$;

create or replace function facturas_para_xubio(p_max integer)
returns setof facturas language sql security definer set search_path = public as $$
  select * from facturas_para_xubio(p_max, organizacion_del_servidor())
$$;

-- ---------------------------------------------------------------- Permisos: todo esto es solo del servidor

revoke execute on function auditar_token_integracion() from public, anon, authenticated;
revoke execute on function crear_token_integracion(uuid, text, text, text), organizacion_del_proceso(), fijar_organizacion_del_proceso(uuid),
  filas_de_otra_organizacion(jsonb, uuid), filas_de_la_organizacion(jsonb, uuid),
  espejar_facturas(jsonb, uuid), espejar_pagos(jsonb, uuid), espejar_catalogos(jsonb, uuid),
  cheques_para_cashflow(timestamptz, uuid), marcar_cheques_cashflow(jsonb, uuid), flujo_datos(uuid), facturas_para_xubio(integer, uuid)
  from public, anon, authenticated;
grant execute on function crear_token_integracion(uuid, text, text, text), organizacion_del_proceso(), fijar_organizacion_del_proceso(uuid),
  filas_de_otra_organizacion(jsonb, uuid), filas_de_la_organizacion(jsonb, uuid),
  espejar_facturas(jsonb, uuid), espejar_pagos(jsonb, uuid), espejar_catalogos(jsonb, uuid),
  cheques_para_cashflow(timestamptz, uuid), marcar_cheques_cashflow(jsonb, uuid), flujo_datos(uuid), facturas_para_xubio(integer, uuid)
  to service_role;
