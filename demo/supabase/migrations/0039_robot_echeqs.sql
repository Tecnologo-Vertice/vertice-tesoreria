-- 0039 · Robot de e-cheqs (Tanda 5 de PARIDAD_COMPLETA.md, 27/11/2026).
--
-- Copia lo que hacen T/RobotEcheqs.js (el panel y las corridas de las 13 y las 17 h) y la API del robot
-- (vertice_desarrollo_robot_echeqs_2026-11-26/Code.js) pero dentro de la base, sin planillas:
--   1. Panel: pedir una corrida, cancelarla y ver el estado (solicitarCorridaRobotEcheqs, cancelarCorridaRobotEcheqs, estadoRobotEcheqs).
--   2. Tabla de control: robot_corridas (cada pedido y cómo terminó) y robot_control (último aviso y señal de vida del robot).
--   3. Lo que le entrega la API al robot de la PC: e-cheqs para subir (robotPendientes_) y cheques cobrados para debitar (robotDebitos_).
--   4. Lo que el robot devuelve: queda en el cheque (columnas robot_*), en los pagos (como la hoja Pagos) y en procesos_log
--      (Robot_Echeqs_Log y Robot_Debitos_Log). Es idempotente: si el robot reenvía lo mismo, no se duplica nada.
--   5. Corridas automáticas de las 13 y las 17 h en días hábiles: las pide una función programada de Netlify (robot_pedir_automatica).
--
-- Cómo se reemplazan las planillas:
--   CARGAR_A_MANO de la hoja Pagos  →  pagos sin contabilizar (o CARGAR_A_MANO si vienen de la hoja) cuyo cheque cae en una cuenta de e-cheqs.
--   CHEQUES EMITIDOS "Pagado"+COBRO →  cheques en estado DEBITADO con su fecha de débito (debitado_en).
--   Robot_Echeqs_Control            →  robot_corridas + robot_control.
-- Nada de esto escribe afuera: el robot de la PC es quien toca Xubio. Si el servidor no tiene ROBOT_ECHEQS_ENVIO_REAL="true",
-- las corridas se le entregan siempre como PRUEBA (ver la función de Netlify robot-echeqs).

-- ---------------------------------------------------------------- Qué empresas usa el robot

-- Mismos nombres que el robot tiene en su config.json (robotEmpresa_ del Apps Script).
create or replace function robot_nombre_empresa(p_nombre text)
returns text language sql immutable as $$
  select case when n like '%BERATUNG%' then 'Beratung S.A.'
              when n like '%INDIA%' then 'INDIA ADV S.A.'
              when n like '%CONTROLB%' then 'Control B'
              when n like '%YSD%' then 'YSD'
              else '' end
  from (select regexp_replace(texto_banco(p_nombre), '[^A-Z0-9]', '', 'g') as n) x
$$;

-- Empresas con el robot habilitado. Se completa una sola vez (las cuatro de Xubio que tiene el robot);
-- después se cambia a mano. Vértice BI no tiene tenant en el robot, igual que hoy.
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'empresas' and column_name = 'robot_echeqs') then
    alter table empresas add column robot_echeqs boolean not null default false;
    -- Solo las de la organización a la que el robot da servicio (la proveedora): las de otras organizaciones no se habilitan solas.
    update empresas set robot_echeqs = true
    where erp = 'XUBIO' and robot_nombre_empresa(nombre) <> '' and organizacion_id in (select id from organizaciones where es_proveedor);
  end if;
end $$;

-- ---------------------------------------------------------------- Tablas de control

-- Una fila por pedido de corrida. Estados: PEDIDA (esperando al robot) → CORRIENDO (la tomó) → TERMINADA | ERROR;
-- o CANCELADA. Hay a lo sumo una PEDIDA por organización: así dos personas no se pisan.
create table if not exists robot_corridas (
  id               uuid primary key default gen_random_uuid(),
  organizacion_id  uuid not null references organizaciones,
  modo             text not null default 'prueba' check (modo in ('prueba', 'real')),
  modo_entregado   text check (modo_entregado in ('prueba', 'real')),    -- el que se le dijo al robot al tomarla
  tipo             text not null default 'op' check (tipo in ('op', 'debito', 'ambos')),
  origen           text not null default 'PANEL' check (origen in ('PANEL', 'AUTOMATICA')),
  pedido_por       text,
  pedida_en        timestamptz not null default now(),
  tomada_en        timestamptz,
  fin_en           timestamptz,
  estado           text not null default 'PEDIDA',
  ultima_actividad timestamptz,                                          -- última vez que el robot la tocó (tomarla o informar algo)
  aviso            text,
  detalle          text
);
alter table robot_corridas drop constraint if exists robot_corridas_estado_check;
alter table robot_corridas add constraint robot_corridas_estado_check check (estado in ('PEDIDA', 'CORRIENDO', 'TERMINADA', 'ERROR', 'CANCELADA', 'SIN_FIN'));
create unique index if not exists robot_corridas_una_pedida on robot_corridas (organizacion_id) where estado = 'PEDIDA';
create index if not exists robot_corridas_reciente on robot_corridas (organizacion_id, pedida_en desc);
drop trigger if exists trg_organizacion_robot_corridas on robot_corridas;
create trigger trg_organizacion_robot_corridas before insert or update on robot_corridas for each row execute function poner_organizacion();

-- Una fila por organización: último aviso del robot (SESION_VENCIDA, FIN_CORRIDA...) y última señal de vida.
create table if not exists robot_control (
  organizacion_id       uuid primary key references organizaciones,
  ultimo_latido         timestamptz,
  ultimo_aviso          text,
  ultimo_aviso_detalle  text,
  ultimo_aviso_en       timestamptz
);
drop trigger if exists trg_organizacion_robot_control on robot_control;
create trigger trg_organizacion_robot_control before insert or update on robot_control for each row execute function poner_organizacion();

alter table robot_corridas enable row level security;
alter table robot_control enable row level security;
drop policy if exists leer_robot_corridas on robot_corridas;
create policy leer_robot_corridas on robot_corridas for select to authenticated
  using (organizacion_id = organizacion_actual() and (usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION', 'TESORERIA', 'CONTROLLER', 'DIRECCION')
         and exists (select 1 from empresas e where e.organizacion_id = robot_corridas.organizacion_id and e.id in (select empresas_visibles())));
drop policy if exists leer_robot_control on robot_control;
create policy leer_robot_control on robot_control for select to authenticated
  using (organizacion_id = organizacion_actual() and (usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION', 'TESORERIA', 'CONTROLLER', 'DIRECCION')
         and exists (select 1 from empresas e where e.organizacion_id = robot_control.organizacion_id and e.id in (select empresas_visibles())));
-- Las personas solo leen: escribe el servidor y las funciones de abajo.
revoke all on robot_corridas, robot_control from anon;
revoke insert, update, delete, truncate on robot_corridas, robot_control from authenticated;
grant all on robot_corridas, robot_control to service_role;

-- ---------------------------------------------------------------- Lo que el robot dejó en cada cheque

-- Estado de la carga de la orden de pago (e-cheq): lo que hoy va a ESTADO_XUBIO_PAGO / XUBIO_DETALLE / NUMERO_OP_ASIENTO de Pagos.
-- "Subido, falta aplicar" es un estado propio (en la hoja se perdía dentro de SUBIDO).
alter table cheques add column if not exists robot_op_estado text check (robot_op_estado in ('PRUEBA_OK', 'SUBIDO', 'SUBIDO_SIN_APLICAR', 'YA_EN_XUBIO', 'ERROR_ROBOT'));
alter table cheques add column if not exists robot_op_modo text check (robot_op_modo in ('prueba', 'real'));
alter table cheques add column if not exists robot_op_detalle text;
alter table cheques add column if not exists robot_op_en timestamptz;
alter table cheques add column if not exists robot_numero_op text;
-- Intentos con error de la carga real: el robot reintenta solo hasta 3 veces (como el Apps Script, que dejaba CARGAR_A_MANO); después queda para "Reintentar".
alter table cheques add column if not exists robot_op_intentos integer not null default 0;
-- Estado del débito del cheque cobrado: lo que hoy queda solo en Robot_Debitos_Log.
alter table cheques add column if not exists robot_debito_estado text check (robot_debito_estado in ('PRUEBA_OK', 'DEBITADO', 'YA_DEBITADO', 'SIN_OP', 'REVISAR', 'ERROR_DEBITO'));
alter table cheques add column if not exists robot_debito_modo text check (robot_debito_modo in ('prueba', 'real'));
alter table cheques add column if not exists robot_debito_detalle text;
alter table cheques add column if not exists robot_debito_en timestamptz;
alter table cheques add column if not exists robot_movimiento text;

-- Lo que el robot dejó en un pago (para que la copia de la hoja no lo pise: ver más abajo).
alter table pagos add column if not exists robot_echeq_en timestamptz;

-- ---------------------------------------------------------------- Auxiliares

-- Un pago espera al robot solo si pasó por Contabilización y quedó marcado "para cargar a mano" (CARGAR_A_MANO): los de la hoja
-- vienen así de la copia; los del sistema los marca marcar_echeq_a_mano cuando Administración contabiliza un e-cheq contra una
-- cuenta de e-cheqs (el caso echeqAMano de la función contabilizar). Nunca un pago sin contabilizar.
create or replace function robot_pago_pendiente(pg pagos)
returns boolean language sql stable set search_path = public as $$
  select pg.estado::text <> 'ANULADO' and upper(coalesce(pg.estado_xubio_pago, '')) = 'CARGAR_A_MANO'
$$;

-- Qué estado manda sobre cuál cuando el robot reenvía o se contradice (solo corridas reales).
create or replace function robot_rango_op(p text)
returns integer language sql immutable as $$
  select case p when 'ERROR_ROBOT' then 1 when 'SUBIDO_SIN_APLICAR' then 2 when 'YA_EN_XUBIO' then 3 when 'SUBIDO' then 4 else 0 end
$$;

-- Hora de Buenos Aires en texto, como la escribía el Apps Script (yyyy-MM-dd HH:mm).
create or replace function robot_hora_ar(p timestamptz)
returns text language sql immutable as $$
  select case when p is null then '' else to_char(p at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI') end
$$;

-- Minutos sin señal del robot después de los cuales una corrida en curso se da por cerrada. La base y la pantalla usan este mismo plazo.
create or replace function robot_minutos_sin_senal()
returns integer language sql immutable as $$ select 20 $$;

-- El robot de hoy no avisa cuando termina (no manda FIN_CORRIDA): la base cierra sola las corridas sin señal. Queda TERMINADA si el
-- robot informó algo mientras corría y SIN_FIN si no dijo nada. p_todas: al tomar una corrida nueva, las anteriores se cierran ya.
create or replace function robot_cerrar_vencidas(p_org uuid, p_todas boolean default false)
returns void language sql security definer set search_path = public as $$
  update robot_corridas c
     set estado = case when exists (select 1 from procesos_log l where l.organizacion_id = c.organizacion_id and l.proceso in ('ROBOT_ECHEQS', 'ROBOT_DEBITOS')
                                    and l.creado_en >= c.tomada_en) then 'TERMINADA' else 'SIN_FIN' end,
         fin_en = coalesce(c.ultima_actividad, c.tomada_en, now())
   where c.organizacion_id = p_org and c.estado = 'CORRIENDO'
     and (coalesce(p_todas, false) or coalesce(c.ultima_actividad, c.tomada_en) < now() - make_interval(mins => robot_minutos_sin_senal()))
$$;

-- El robot informó algo: la corrida en curso sigue viva.
create or replace function robot_tocar(p_org uuid)
returns void language sql security definer set search_path = public as $$
  update robot_corridas set ultima_actividad = now() where organizacion_id = p_org and estado = 'CORRIENDO'
$$;

-- Hay una corrida en curso (con señal en los últimos minutos): mientras tanto no se pide otra.
create or replace function robot_corriendo(p_org uuid)
returns robot_corridas language plpgsql security definer set search_path = public as $$
declare c robot_corridas;
begin
  perform robot_cerrar_vencidas(p_org);
  select * into c from robot_corridas where organizacion_id = p_org and estado = 'CORRIENDO' order by tomada_en desc limit 1;
  return c;
end $$;

-- La organización a la que el robot le da servicio: la proveedora o, si hay una sola, esa. Null si no se sabe.
create or replace function robot_org_servida()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from organizaciones where estado = 'ACTIVA' and es_proveedor limit 1;
  if v_id is null and (select count(*) from organizaciones where estado = 'ACTIVA') = 1 then select id into v_id from organizaciones where estado = 'ACTIVA'; end if;
  return v_id;
end $$;

-- Busca el cheque de un resultado del robot. Primero por los datos del sistema que el robot devuelve tal cual
-- (chequeId, fila, id, o los ids de los pagos); si no, por empresa y número, y solo si hay uno solo.
create or replace function robot_buscar_cheque(p_org uuid, p_r jsonb, p_debito boolean)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_uuid constant text := '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$';
  x text; v_id uuid; v_pagos uuid[]; v_n integer; v_num text; v_emp text;
begin
  foreach x in array array[p_r ->> 'chequeId', p_r ->> 'fila', p_r ->> 'id'] loop
    if x is not null and x ~ v_uuid then
      select ch.id into v_id from cheques ch join empresas e on e.id = ch.empresa_id where ch.id = x::uuid and e.organizacion_id = p_org;
      if v_id is not null then return v_id; end if;
    end if;
  end loop;
  if not p_debito then
    select coalesce(array_agg(distinct y::uuid), '{}') into v_pagos
    from jsonb_array_elements_text(case when jsonb_typeof(p_r -> 'ids') = 'array' then p_r -> 'ids'
                                        when jsonb_typeof(p_r -> 'filas') = 'array' then p_r -> 'filas' else '[]'::jsonb end) y
    where y ~ v_uuid;
    if cardinality(v_pagos) > 0 then
      select count(distinct cp.cheque_id), min(cp.cheque_id::text)::uuid into v_n, v_id
      from cheques_pagos cp join cheques ch on ch.id = cp.cheque_id join empresas e on e.id = ch.empresa_id
      where cp.pago_id = any(v_pagos) and e.organizacion_id = p_org;
      if v_n = 1 then return v_id; end if;
    end if;
  end if;
  v_num := ltrim(trim(coalesce(p_r ->> 'cheque', '')), '0');
  v_emp := trim(coalesce(p_r ->> 'empresa', ''));
  if v_num = '' or v_emp = '' then return null; end if;
  select count(*), min(ch.id::text)::uuid into v_n, v_id
  from cheques ch join empresas e on e.id = ch.empresa_id
  where e.organizacion_id = p_org and ltrim(ch.numero, '0') = v_num and ch.tipo <> 'PAGARE' and ch.estado not in ('ANULADO', 'RECHAZADO')
    and (e.nombre = v_emp or coalesce(nullif(robot_nombre_empresa(e.nombre), ''), e.nombre) = v_emp or e.id = v_emp);
  if v_n = 1 then return v_id; end if;
  return null;
end $$;

-- ---------------------------------------------------------------- Lo que se le entrega al robot

-- e-cheqs para subir a Xubio: un grupo por cheque, con la misma forma que robotPendientes_ (empresa, cheque, proveedor, cuit,
-- cuentaXubio, bancos, fechaPago, vencimiento, importe, facturas, importesFactura, filas, ids, descripcion) y los bloqueados con su motivo.
-- "filas" e "ids" son los ids de los pagos del sistema (no hay números de fila): el robot los devuelve y así se ubica el cheque.
-- p_empresas: solo esas empresas (para el panel de una persona). Null: todas las de la organización.
create or replace function robot_grupos_op(p_org uuid, p_empresas text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; f record; v_listos jsonb := '[]'; v_bloq jsonb := '[]'; v_pagos uuid[]; v_fecha date; v_prov text;
  v_facturas jsonb; v_importes jsonb; v_nros text[]; v_motivos text[]; v_bancos jsonb; v_desc text; v_ids jsonb;
begin
  for r in
    select ch.id, ch.numero, ch.importe, ch.fecha_pago, ch.beneficiario, ch.empresa_id,
           coalesce(nullif(robot_nombre_empresa(e.nombre), ''), e.nombre) as empresa,
           co.nombre as cuenta, co.banco as banco_cuenta, pr.nombre as proveedor, pr.cuit::text as cuit
    from cheques ch
    join empresas e on e.id = ch.empresa_id
    join cuentas_origen co on co.id = ch.cuenta_origen_id
    left join proveedores pr on pr.id = ch.proveedor_id
    where e.organizacion_id = p_org and e.erp = 'XUBIO' and e.robot_echeqs
      and ch.tipo <> 'PAGARE' and ch.estado in ('EMITIDO', 'ENTREGADO', 'DEBITADO') and ch.xubio_emision_id is null
      and (co.tipo_cuenta = 4 or co.clase = 'ECHEQ')
      -- Lo que el robot ya resolvió en una corrida REAL no vuelve a entrar. Un ERROR_ROBOT se reintenta solo hasta 3 veces; después
      -- queda para "Reintentar" a mano (como en el Apps Script el robot lo volvía a intentar en la corrida siguiente).
      and not (coalesce(ch.robot_op_modo, '') = 'real' and (coalesce(ch.robot_op_estado, '') in ('SUBIDO', 'SUBIDO_SIN_APLICAR', 'YA_EN_XUBIO')
                                                           or (ch.robot_op_estado = 'ERROR_ROBOT' and ch.robot_op_intentos >= 3)))
      and (p_empresas is null or ch.empresa_id = any(p_empresas))
      and exists (select 1 from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id and robot_pago_pendiente(pg))
    order by ch.fecha_pago, ch.numero, ch.id
  loop
    select coalesce(array_agg(pg.id order by pg.fecha, pg.id), '{}'), min(pg.fecha) into v_pagos, v_fecha
    from cheques_pagos cp join pagos pg on pg.id = cp.pago_id
    where cp.cheque_id = r.id and robot_pago_pendiente(pg);
    v_prov := coalesce(nullif(trim(r.proveedor), ''), r.beneficiario);
    v_nros := '{}'; v_motivos := '{}'; v_importes := '{}'::jsonb;
    for f in
      select coalesce(fa.letra::text || '-', '') || lpad(fa.punto_venta::text, 5, '0') || '-' || lpad(fa.numero::text, 8, '0') as nro,
             sum(pf.importe) as importe,
             bool_or(fa.estado_xubio::text = 'SUBIDA' or fa.xubio_id is not null) as en_xubio,
             min(fa.estado_xubio::text) as est
      from pagos_facturas pf join facturas fa on fa.id = pf.factura_id
      where pf.pago_id = any(v_pagos) group by 1 order by 1
    loop
      v_nros := v_nros || f.nro;
      v_importes := v_importes || jsonb_build_object(f.nro, round(f.importe, 2));
      -- La factura tiene que estar en Xubio; si no, la orden de pago quedaría sin poder aplicarse.
      if not f.en_xubio then v_motivos := v_motivos || ('la factura ' || f.nro || ' no está en Xubio (' || f.est || ')'); end if;
    end loop;
    if not (r.importe > 0) then v_motivos := v_motivos || 'falta el importe'::text; end if;
    if v_fecha is null then v_motivos := v_motivos || 'falta la fecha del pago'::text; end if;
    v_ids := (select coalesce(jsonb_agg(x::text), '[]'::jsonb) from unnest(v_pagos) x);
    if cardinality(v_motivos) > 0 then
      v_bloq := v_bloq || jsonb_build_array(jsonb_build_object('empresa', r.empresa, 'cheque', r.numero, 'proveedor', v_prov, 'filas', v_ids, 'motivo', array_to_string(v_motivos, '; ')));
      continue;
    end if;
    -- Variantes del nombre del banco para que el robot pruebe: el banco de la cuenta, "BANCO xxx" y "E-CHEQ xxx" del nombre.
    select coalesce(jsonb_agg(q.x order by q.o), '[]'::jsonb) into v_bancos
    from (select t.x, min(t.o) as o
          from unnest(array[regexp_replace(coalesce(r.banco_cuenta, ''), '^banco\s+', '', 'i'),
                            substring(r.cuenta from '(?i)BANCO[[:space:]]+([[:alpha:]]+)'),
                            substring(r.cuenta from '(?i)E-?CHE[[:alnum:]]*[[:space:]]+([[:alnum:]_]+)'),
                            r.banco_cuenta]) with ordinality as t(x, o)
          where coalesce(t.x, '') <> '' group by t.x) q;
    v_desc := (case when cardinality(v_nros) > 0 then 'Aplicar a FC ' || array_to_string(v_nros, ', ') || ' · ' else '' end)
              || v_prov || ' | ID ' || (select string_agg(left(x::text, 8), ', ') from unnest(v_pagos) x);
    v_listos := v_listos || jsonb_build_array(jsonb_build_object(
      'empresa', r.empresa, 'cheque', r.numero, 'chequeId', r.id, 'proveedor', v_prov, 'cuit', coalesce(r.cuit, ''),
      'cuentaXubio', r.cuenta, 'bancos', v_bancos, 'fechaPago', v_fecha::text, 'vencimiento', r.fecha_pago::text,
      'importe', r.importe, 'facturas', to_jsonb(v_nros), 'importesFactura', v_importes,
      'filas', v_ids, 'ids', v_ids, 'descripcion', v_desc));
  end loop;
  -- Pagos con e-cheq que el robot no puede tomar porque no tienen su cheque cargado (falta la cuenta de origen o la fecha de cobro).
  for r in
    select pg.id, pg.numero_cheque, coalesce(nullif(trim(pr.nombre), ''), pg.proveedor_destino, '') as prov,
           coalesce(nullif(robot_nombre_empresa(e.nombre), ''), e.nombre) as empresa
    from pagos pg join empresas e on e.id = pg.empresa_id left join proveedores pr on pr.id = pg.proveedor_id
    where e.organizacion_id = p_org and e.erp = 'XUBIO' and e.robot_echeqs
      and (pg.medio::text = 'ECHEQ' or upper(coalesce(pg.tipo_cheque, '')) = 'ECHEQ')
      and nullif(trim(coalesce(pg.numero_cheque, '')), '') is not null
      and pg.fecha >= hoy_ar() - 180 and robot_pago_pendiente(pg)
      and (p_empresas is null or pg.empresa_id = any(p_empresas))
      and not exists (select 1 from cheques_pagos cp where cp.pago_id = pg.id)
    order by pg.fecha, pg.id
  loop
    v_bloq := v_bloq || jsonb_build_array(jsonb_build_object('empresa', r.empresa, 'cheque', trim(r.numero_cheque), 'proveedor', r.prov,
      'filas', jsonb_build_array(r.id::text), 'motivo', 'el pago no tiene su cheque en Cheques (falta la cuenta de origen o la fecha de cobro)'));
  end loop;
  return jsonb_build_object('grupos', v_listos, 'bloqueados', v_bloq);
end $$;

-- Cheques cobrados para debitar en Xubio, como robotDebitos_: los que Tesorería marcó DEBITADO con su fecha real de débito,
-- de los últimos p_dias días, que no son de Ralpharma ni pagarés. Devuelve candidatos, bloqueados, ralpharmaOmitidos y desde.
create or replace function robot_candidatos_debito(p_org uuid, p_dias integer default 45, p_empresas text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; v_dias integer := greatest(1, least(coalesce(p_dias, 45), 365)); v_desde date; v_hoy date := hoy_ar();
  v_cand jsonb := '[]'; v_bloq jsonb := '[]'; v_ral integer := 0; v_motivos text[]; v_item jsonb;
begin
  v_desde := v_hoy - v_dias;
  for r in
    select ch.id, ch.numero, ch.importe, ch.debitado_en, ch.beneficiario, ch.empresa_id, e.erp::text as erp, e.nombre as empresa_nombre,
           e.robot_echeqs as robot, coalesce(nullif(robot_nombre_empresa(e.nombre), ''), e.nombre) as empresa,
           co.banco, coalesce(nullif(trim(a.nombre), ''), ch.beneficiario) as acreedor
    from cheques ch
    join empresas e on e.id = ch.empresa_id
    left join cuentas_origen co on co.id = ch.cuenta_origen_id
    left join acreedores a on a.id = ch.acreedor_id
    where e.organizacion_id = p_org and ch.estado = 'DEBITADO' and ch.tipo <> 'PAGARE'
      and ch.debitado_en between v_desde and v_hoy
      and not (coalesce(ch.robot_debito_modo, '') = 'real' and coalesce(ch.robot_debito_estado, '') in ('DEBITADO', 'YA_DEBITADO'))
      and (p_empresas is null or ch.empresa_id = any(p_empresas))
    order by ch.debitado_en, ch.numero, ch.id
  loop
    if r.erp <> 'XUBIO' then v_ral := v_ral + 1; continue; end if;      -- Ralpharma: nunca
    v_motivos := '{}';
    if not r.robot then v_motivos := v_motivos || ('empresa ''' || r.empresa_nombre || ''' sin Xubio configurado'); end if;
    if r.numero ~ '[A-Za-z]' then v_motivos := v_motivos || ('número con letras (' || r.numero || '): debitar a mano');
    elsif r.numero !~ '[0-9]{2,}' then v_motivos := v_motivos || 'número de cheque no reconocible'; end if;
    if not (r.importe > 0) then v_motivos := v_motivos || 'importe no reconocible'; end if;
    if cardinality(v_motivos) > 0 then
      v_bloq := v_bloq || jsonb_build_array(jsonb_build_object('empresa', r.empresa_nombre, 'cheque', r.numero, 'motivo', array_to_string(v_motivos, '; ')));
    else
      v_item := jsonb_build_object('fila', r.id::text, 'chequeId', r.id, 'empresaCashflow', upper(r.empresa_nombre), 'empresa', r.empresa, 'cheque', r.numero,
        'banco', coalesce(r.banco, ''), 'acreedor', coalesce(r.acreedor, ''), 'importe', r.importe, 'fechaCobro', r.debitado_en::text);
      v_cand := v_cand || jsonb_build_array(v_item);
    end if;
  end loop;
  return jsonb_build_object('candidatos', v_cand, 'bloqueados', v_bloq, 'ralpharmaOmitidos', v_ral, 'desde', v_desde::text);
end $$;

-- ---------------------------------------------------------------- Pedidos de corrida (panel y automáticas)

-- Botones del panel. p_modo: 'prueba' (no guarda) o 'real'. p_tipo: 'op' (subir e-cheqs), 'debito' o 'ambos'.
create or replace function robot_pedir_corrida(p_modo text, p_tipo text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; v_modo text; v_tipo text; c robot_corridas; v_id uuid; v_que text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  v_modo := case when p_modo = 'real' then 'real' else 'prueba' end;
  v_tipo := case when p_tipo in ('op', 'debito', 'ambos') then p_tipo else 'op' end;
  if robot_org_servida() is distinct from u.organizacion_id then
    return jsonb_build_object('ok', false, 'mensaje', 'El robot de e-cheqs todavía no atiende a tu organización: no hay una PC con el robot para ella.');
  end if;
  if not exists (select 1 from empresas e where e.organizacion_id = u.organizacion_id and e.robot_echeqs) then
    return jsonb_build_object('ok', false, 'mensaje', 'Ninguna empresa tiene el robot de e-cheqs habilitado.');
  end if;
  select * into c from robot_corridas where organizacion_id = u.organizacion_id and estado = 'PEDIDA';
  if found then
    return jsonb_build_object('ok', false, 'mensaje', 'Ya hay una corrida pedida (' || c.tipo || ' · ' || c.modo || ') por ' || coalesce(c.pedido_por, '?') ||
      ' a las ' || robot_hora_ar(c.pedida_en) || '. Esperá a que el robot la tome, o cancelala.');
  end if;
  c := robot_corriendo(u.organizacion_id);
  if c.id is not null then
    return jsonb_build_object('ok', false, 'mensaje', 'El robot está corriendo desde las ' || robot_hora_ar(c.tomada_en) || '. Esperá a que termine para pedir otra.');
  end if;
  begin
    insert into robot_corridas (organizacion_id, modo, tipo, origen, pedido_por)
    values (u.organizacion_id, v_modo, v_tipo, 'PANEL', u.email) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'mensaje', 'Justo se pidió otra corrida. Esperá a que el robot la tome, o cancelala.');
  end;
  perform registrar_auditoria(u, 'ROBOT_PEDIR_CORRIDA', 'ROBOT', v_id::text, v_tipo || ' · ' || v_modo);
  v_que := case v_tipo when 'debito' then 'débito de cheques cobrados' when 'ambos' then 'e-cheqs y débitos' else 'subida de e-cheqs' end;
  return jsonb_build_object('ok', true, 'corrida_id', v_id,
    'mensaje', 'Corrida pedida: ' || v_que || ' en modo ' || v_modo || '. El robot la toma en menos de 5 minutos si la PC está prendida.');
end $$;

-- Saca el pedido si el robot todavía no lo tomó (PC apagada, cambio de idea).
create or replace function robot_cancelar_corrida()
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; c robot_corridas;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  update robot_corridas set estado = 'CANCELADA', fin_en = now()
  where organizacion_id = u.organizacion_id and estado = 'PEDIDA' returning * into c;
  if not found then return jsonb_build_object('ok', true, 'mensaje', 'No había ninguna corrida pedida.'); end if;
  perform registrar_auditoria(u, 'ROBOT_CANCELAR_CORRIDA', 'ROBOT', c.id::text, c.tipo || ' · ' || c.modo);
  return jsonb_build_object('ok', true, 'mensaje', 'Pedido cancelado.');
end $$;

-- Corridas de las 13 y las 17 h: la llama la función programada de Netlify (robot-echeqs-auto). Solo días hábiles (con feriados).
-- Mismo camino que los botones: deja el pedido y el robot lo toma. Si ya hay uno esperando o el robot está corriendo, no pisa nada.
create or replace function robot_pedir_automatica(p_org uuid, p_hora text, p_reverificar boolean, p_real boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c robot_corridas; v_id uuid;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  perform fijar_organizacion_del_proceso(p_org);
  if not es_dia_habil(hoy_ar()) then return jsonb_build_object('pedida', false, 'motivo', 'hoy no es día hábil'); end if;
  if robot_org_servida() is distinct from p_org then return jsonb_build_object('pedida', false, 'motivo', 'el robot no atiende a esta organización'); end if;
  if not exists (select 1 from empresas e where e.organizacion_id = p_org and e.robot_echeqs) then
    return jsonb_build_object('pedida', false, 'motivo', 'ninguna empresa tiene el robot habilitado');
  end if;
  if exists (select 1 from robot_corridas where organizacion_id = p_org and estado = 'PEDIDA') then
    return jsonb_build_object('pedida', false, 'motivo', 'ya hay una corrida pedida: la automática de las ' || p_hora || ' no se pide');
  end if;
  c := robot_corriendo(p_org);
  if c.id is not null then return jsonb_build_object('pedida', false, 'motivo', 'el robot está corriendo: la automática de las ' || p_hora || ' no se pide'); end if;
  begin
    insert into robot_corridas (organizacion_id, modo, tipo, origen, pedido_por)
    values (p_org, case when coalesce(p_real, false) then 'real' else 'prueba' end, 'ambos', 'AUTOMATICA',
            'automático ' || p_hora || case when coalesce(p_reverificar, false) then ' · con reverificación' else '' end)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('pedida', false, 'motivo', 'ya hay una corrida pedida');
  end;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values ('Robot e-cheqs automático', 'ADMIN', 'ROBOT_PEDIR_CORRIDA', 'ROBOT', v_id::text, 'ambos · ' || case when coalesce(p_real, false) then 'real' else 'prueba' end || ' · ' || p_hora);
  return jsonb_build_object('pedida', true, 'corrida_id', v_id);
end $$;

-- ---------------------------------------------------------------- Lo que usa el robot (API)

-- Una sola organización le da el servicio al robot: la proveedora o, si hay una sola, esa. (Con una clave compartida no hay
-- otra forma de saber para quién trabaja; con varias organizaciones el robot tendría un token por cliente.)
create or replace function robot_organizacion()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_id uuid;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  v_id := robot_org_servida();
  if v_id is null then raise exception 'Ninguna organización activa figura como la que da el servicio (es_proveedor) y hay más de una (o ninguna)'; end if;
  return v_id;
end $$;

-- estado: lo que el robot pregunta cada 5 minutos. Anota la señal de vida.
create or replace function robot_estado(p_org uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c robot_corridas;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  perform fijar_organizacion_del_proceso(p_org);
  perform robot_cerrar_vencidas(p_org);
  insert into robot_control (organizacion_id, ultimo_latido) values (p_org, now())
  on conflict (organizacion_id) do update set ultimo_latido = now();
  select * into c from robot_corridas where organizacion_id = p_org and estado = 'PEDIDA';
  return jsonb_build_object('solicitada', found, 'fecha', robot_hora_ar(c.pedida_en), 'por', coalesce(c.pedido_por, ''),
    'modo', coalesce(c.modo, 'prueba'), 'tipo', coalesce(c.tipo, 'op'));
end $$;

-- tomarCorrida: marca el pedido como tomado (pasa a CORRIENDO). Es atómico: si dos robots la piden a la vez, solo uno la toma.
-- p_forzar_prueba: el servidor no tiene el envío real encendido, se le entregó como prueba.
create or replace function robot_tomar_corrida(p_org uuid, p_forzar_prueba boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c robot_corridas;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  perform fijar_organizacion_del_proceso(p_org);
  if not exists (select 1 from robot_corridas where organizacion_id = p_org and estado = 'PEDIDA') then return jsonb_build_object('tomada', false); end if;
  perform robot_cerrar_vencidas(p_org, true);      -- si había una anterior sin aviso de fin, se cierra ahora
  update robot_corridas
     set estado = 'CORRIENDO', tomada_en = now(), ultima_actividad = now(),
         modo_entregado = case when coalesce(p_forzar_prueba, false) then 'prueba' else modo end,
         detalle = case when coalesce(p_forzar_prueba, false) and modo = 'real'
                        then 'Pedida en real y entregada como prueba: el servidor no tiene ROBOT_ECHEQS_ENVIO_REAL encendida' end
   where organizacion_id = p_org and estado = 'PEDIDA' returning * into c;
  if not found then return jsonb_build_object('tomada', false); end if;
  insert into robot_control (organizacion_id, ultimo_latido) values (p_org, now())
  on conflict (organizacion_id) do update set ultimo_latido = now();
  return jsonb_build_object('tomada', true, 'modo', c.modo_entregado, 'tipo', c.tipo);
end $$;

-- Aviso del robot ({aviso, detalle}): SESION_VENCIDA, FIN_CORRIDA, FIN_CON_ERROR... Cierra la corrida que estaba en curso.
create or replace function robot_registrar_aviso(p_org uuid, p_aviso text, p_detalle text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_aviso text := left(trim(coalesce(p_aviso, '')), 60); v_det text := left(coalesce(p_detalle, ''), 400); v_fin boolean; v_id uuid;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  perform fijar_organizacion_del_proceso(p_org);
  if v_aviso = '' then raise exception 'Falta el aviso'; end if;
  v_fin := v_aviso like 'FIN_CORRIDA%';
  insert into robot_control (organizacion_id, ultimo_latido, ultimo_aviso, ultimo_aviso_detalle, ultimo_aviso_en)
  values (p_org, now(), v_aviso, v_det, now())
  on conflict (organizacion_id) do update set ultimo_latido = now(), ultimo_aviso = v_aviso, ultimo_aviso_detalle = v_det, ultimo_aviso_en = now();
  select id into v_id from robot_corridas where organizacion_id = p_org and estado = 'CORRIENDO' order by tomada_en desc limit 1;
  if v_id is not null then
    update robot_corridas set estado = case when v_fin then 'TERMINADA' else 'ERROR' end, fin_en = now(), aviso = v_aviso, detalle = coalesce(nullif(v_det, ''), detalle)
    where id = v_id;
  end if;
  insert into procesos_log (organizacion_id, proceso, modo, entidad, estado, detalle, datos)
  values (p_org, 'ROBOT_ECHEQS', 'REAL', 'AVISO', case when v_fin then 'OK' else 'ERROR' end, left(v_aviso || coalesce(' · ' || nullif(v_det, ''), ''), 1000),
          jsonb_build_object('aviso', v_aviso, 'detalle', v_det));
  return jsonb_build_object('registrados', 0, 'aviso', v_aviso);
end $$;

-- El robot no puede "promover" una corrida a real: si la última corrida tomada (de las últimas 3 horas) se le entregó como prueba, lo que
-- diga el robot de su propio modo no vale.
create or replace function robot_entregada_como_prueba(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select c.modo_entregado = 'prueba' from robot_corridas c
                   where c.organizacion_id = p_org and c.tomada_en is not null and c.tomada_en > now() - interval '3 hours'
                   order by c.tomada_en desc limit 1), false)
$$;

-- Un N° de orden de pago de Xubio tiene esta forma (X-0001-00002478). Otro texto no se guarda como N°: va solo al detalle.
create or replace function robot_es_numero_op(p text)
returns boolean language sql immutable as $$ select coalesce(p, '') ~ '^[A-Z]-[0-9]{4}-[0-9]{8}$' $$;

-- Saca el aviso "FALTA APLICAR" del detalle de los pagos de un cheque. Con p_detalle, lo reemplaza por ese texto (el robot completó la
-- aplicación); sin p_detalle, quita la frase y anota que se cerró a mano.
create or replace function robot_limpiar_falta_aplicar(p_cheque uuid, p_detalle text default null)
returns void language sql security definer set search_path = public as $$
  update pagos p
     set xubio_detalle = case when nullif(trim(coalesce(p_detalle, '')), '') is not null then left(p_detalle, 400)
                              else left(coalesce(nullif(trim(regexp_replace(p.xubio_detalle, '[⚠[:space:]]*FALTA APLICAR[^.;|]*[.;|]?', '', 'gi')), '') || ' · ', '') || 'aplicación cerrada a mano', 400) end
   where p.id in (select cp.pago_id from cheques_pagos cp where cp.cheque_id = p_cheque) and upper(coalesce(p.xubio_detalle, '')) like '%FALTA APLICAR%'
$$;

-- resultado: lo que el robot devuelve de los e-cheqs. { resultados: [{modo, empresa, cheque, proveedor, importe, filas, ids, estado, numeroOP, detalle}] }
-- o { aviso, detalle }. Idempotente: el mismo resultado real dos veces no cambia nada ni se anota dos veces.
--   · p_permitir_real: la función de Netlify dice si el servidor tiene ROBOT_ECHEQS_ENVIO_REAL encendida. Sin eso, o si la corrida se
--     entregó como prueba, todo lo que el robot declare "real" se registra como PRUEBA (queda anotado) y no cambia pagos ni cheques.
--   · En PRUEBA solo se anota (en el log y en el cheque como última pasada). No se toca el estado de nada. "real" + PRUEBA_OK = prueba.
--   · En REAL, el cheque queda con su estado (SUBIDO, SUBIDO_SIN_APLICAR, YA_EN_XUBIO o ERROR_ROBOT) y el N° de orden de pago;
--     los pagos marcados CARGAR_A_MANO quedan como hoy en la hoja Pagos: SUBIDO (SUBIDO_SIN_APLICAR cuenta como SUBIDO: la orden ya
--     está en Xubio), con el detalle y el N° de OP. Un pago del sistema contabilizado en el panel (REVISADO, con su cuenta contable)
--     pasa a CONTABILIZADO; nunca queda uno CONTABILIZADO sin cuenta contable.
--   · Un estado de menor jerarquía no pisa a uno mayor (un ERROR_ROBOT tardío no desarma un SUBIDO).
--   · Un ERROR_ROBOT real suma un intento; con 3 el cheque deja de ofrecerse y queda para "Reintentar" a mano.
create or replace function robot_registrar_resultados(p_org uuid, p_cuerpo jsonb, p_permitir_real boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; ch cheques; pg record; v_ch uuid; v_decl text; v_modo text; v_estado text; v_detalle text; v_num text; v_prev text;
  v_recibidos integer := 0; v_reg integer := 0; v_rep integer := 0; v_sin integer := 0; v_real_ok boolean;
  v_estado_log text; v_pago_estado text; v_unico boolean;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  perform fijar_organizacion_del_proceso(p_org);
  if nullif(trim(coalesce(p_cuerpo ->> 'aviso', '')), '') is not null then
    return robot_registrar_aviso(p_org, p_cuerpo ->> 'aviso', p_cuerpo ->> 'detalle');
  end if;
  v_real_ok := coalesce(p_permitir_real, false) and not robot_entregada_como_prueba(p_org);
  for r in select x from jsonb_array_elements(case when jsonb_typeof(p_cuerpo -> 'resultados') = 'array' then p_cuerpo -> 'resultados' else '[]'::jsonb end) x loop
    v_recibidos := v_recibidos + 1;
    v_decl := case when lower(coalesce(r ->> 'modo', '')) = 'real' then 'real' else 'prueba' end;
    v_estado := upper(trim(coalesce(r ->> 'estado', '')));
    v_detalle := left(coalesce(r ->> 'detalle', ''), 1000);
    v_modo := case when v_decl = 'real' and v_real_ok and v_estado <> 'PRUEBA_OK' then 'real' else 'prueba' end;
    if v_decl = 'real' and v_modo = 'prueba' and v_estado <> 'PRUEBA_OK' then
      v_detalle := left('[Declarado real, registrado como prueba: el servidor no tiene el envío real encendido o la corrida se entregó como prueba] ' || v_detalle, 1000);
    end if;
    v_num := left(nullif(trim(coalesce(r ->> 'numeroOP', '')), ''), 80);
    if v_num is not null and not robot_es_numero_op(v_num) then
      v_detalle := left(v_detalle || ' (el robot informó "' || left(v_num, 80) || '", que no tiene forma de N° de orden de pago)', 1000);
      v_num := null;
    end if;
    if v_estado not in ('PRUEBA_OK', 'SUBIDO', 'SUBIDO_SIN_APLICAR', 'YA_EN_XUBIO', 'ERROR_ROBOT') then
      insert into procesos_log (organizacion_id, proceso, modo, entidad, estado, detalle, datos)
      values (p_org, 'ROBOT_ECHEQS', upper(v_modo), 'CHEQUE', 'OMITIDO', left('Estado desconocido (' || v_estado || '): no se registró. ' || v_detalle, 1000), r);
      v_sin := v_sin + 1; continue;
    end if;
    v_ch := robot_buscar_cheque(p_org, r, false);
    if v_ch is null then
      insert into procesos_log (organizacion_id, proceso, modo, entidad, estado, detalle, datos)
      values (p_org, 'ROBOT_ECHEQS', upper(v_modo), 'CHEQUE', 'OMITIDO',
              left('No se encontró el cheque ' || coalesce(r ->> 'cheque', '?') || ' de ' || coalesce(r ->> 'empresa', '?') || ' (o hay más de uno). Resultado del robot: ' || v_estado || ' · ' || v_detalle, 1000), r);
      v_sin := v_sin + 1; continue;
    end if;
    select * into ch from cheques where id = v_ch for update;
    v_prev := case when ch.robot_op_modo = 'real' then ch.robot_op_estado end;
    if v_modo = 'real' and v_prev is not null then
      if v_prev = v_estado then
        -- El mismo resultado otra vez es un reenvío; un error repetido mucho después es un intento nuevo.
        if not (v_estado = 'ERROR_ROBOT' and ch.robot_op_en < now() - interval '2 minutes') then v_rep := v_rep + 1; continue; end if;
      elsif robot_rango_op(v_estado) <= robot_rango_op(v_prev) then                       -- no desarma lo ya resuelto
        insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle, datos)
        values (p_org, ch.empresa_id, 'ROBOT_ECHEQS', 'REAL', 'CHEQUE', v_ch::text, 'OMITIDO',
                left('El cheque ya figuraba ' || v_prev || ': no se pisa con ' || v_estado || '. ' || v_detalle, 1000), r || jsonb_build_object('chequeId', v_ch));
        v_rep := v_rep + 1; continue;
      end if;
    end if;
    v_estado_log := case v_estado when 'PRUEBA_OK' then 'PRUEBA_OK' when 'ERROR_ROBOT' then 'ERROR' else 'OK' end;
    insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle, datos)
    values (p_org, ch.empresa_id, 'ROBOT_ECHEQS', upper(v_modo), 'CHEQUE', v_ch::text, v_estado_log,
            left(v_estado || coalesce(' · OP ' || v_num, '') || ' · ' || v_detalle, 1000), r || jsonb_build_object('estado', v_estado, 'chequeId', v_ch));
    if v_modo = 'prueba' then
      -- Solo la última pasada: lo ya resuelto en real no se toca.
      if v_prev is null then
        update cheques set robot_op_estado = v_estado, robot_op_modo = 'prueba', robot_op_detalle = left(v_detalle, 400), robot_op_en = now() where id = v_ch;
      end if;
      v_reg := v_reg + 1; continue;
    end if;
    update cheques set robot_op_estado = v_estado, robot_op_modo = 'real', robot_op_detalle = left(v_detalle, 400), robot_op_en = now(),
      robot_op_intentos = case when v_estado = 'ERROR_ROBOT' then robot_op_intentos + 1 else 0 end,
      robot_numero_op = coalesce(v_num, robot_numero_op),
      xubio_emision_id = case when v_estado in ('SUBIDO', 'SUBIDO_SIN_APLICAR', 'YA_EN_XUBIO') then coalesce(xubio_emision_id, v_num) else xubio_emision_id end,
      estado_xubio = case when v_estado in ('SUBIDO', 'SUBIDO_SIN_APLICAR', 'YA_EN_XUBIO') then 'SUBIDA'::estado_xubio else estado_xubio end
    where id = v_ch;
    if v_estado in ('SUBIDO', 'SUBIDO_SIN_APLICAR', 'YA_EN_XUBIO') then
      v_pago_estado := case when v_estado = 'YA_EN_XUBIO' then 'YA_EN_XUBIO' else 'SUBIDO' end;
      for pg in
        select p.* from cheques_pagos cp join pagos p on p.id = cp.pago_id where cp.cheque_id = v_ch and robot_pago_pendiente(p) order by p.fecha, p.id
      loop
        -- Un cheque que paga varias facturas son varios pagos con la misma OP: el N° es único por empresa, queda en el primero.
        v_unico := v_num is not null and not exists (select 1 from pagos o where o.empresa_id = pg.empresa_id and o.numero_op = v_num and o.id <> pg.id);
        update pagos set
          estado_xubio_pago = v_pago_estado,
          xubio_detalle = left(v_detalle, 400),
          robot_echeq_en = now(),
          xubio_id = case when estado::text = 'REVISADO' and nullif(trim(coalesce(cuenta_contable, '')), '') is not null then 'CARGADO_A_MANO' else xubio_id end,
          forma_carga_xubio = case when estado::text = 'REVISADO' and nullif(trim(coalesce(cuenta_contable, '')), '') is not null then 'ORDEN_PAGO'::forma_carga_xubio else forma_carga_xubio end,
          contabilizado_por = case when estado::text = 'REVISADO' and nullif(trim(coalesce(cuenta_contable, '')), '') is not null then 'Robot e-cheqs' else contabilizado_por end,
          contabilizado_en = case when estado::text = 'REVISADO' and nullif(trim(coalesce(cuenta_contable, '')), '') is not null then now() else contabilizado_en end,
          estado = case when estado::text = 'REVISADO' and nullif(trim(coalesce(cuenta_contable, '')), '') is not null then 'CONTABILIZADO'::estado_pago else estado end,
          numero_op = case when v_unico and nullif(trim(coalesce(numero_op, '')), '') is null then v_num else numero_op end,
          numero_op_origen = case when v_unico and nullif(trim(coalesce(numero_op, '')), '') is null then 'XUBIO' else numero_op_origen end,
          numero_op_por = case when v_unico and nullif(trim(coalesce(numero_op, '')), '') is null then 'Robot e-cheqs' else numero_op_por end,
          numero_op_en = case when v_unico and nullif(trim(coalesce(numero_op, '')), '') is null then now() else numero_op_en end,
          detalle_contabilizacion = case when v_num is not null and coalesce(detalle_contabilizacion, '') not like '%' || v_num || '%'
                                         then coalesce(nullif(detalle_contabilizacion, '') || ' · ', '') || 'N° ' || v_num || ' (robot e-cheqs)' else detalle_contabilizacion end
        where id = pg.id;
      end loop;
      -- Completó una aplicación que había quedado pendiente: el pago ya no dice "FALTA APLICAR".
      if v_prev = 'SUBIDO_SIN_APLICAR' and v_estado = 'SUBIDO' then perform robot_limpiar_falta_aplicar(v_ch, v_detalle); end if;
    end if;
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Robot e-cheqs', 'ADMIN', 'ROBOT_ECHEQ_' || v_estado, 'CHEQUE', v_ch::text, left(ch.numero || coalesce(' · OP ' || v_num, '') || ' · ' || v_detalle, 500));
    v_reg := v_reg + 1;
  end loop;
  insert into robot_control (organizacion_id, ultimo_latido) values (p_org, now())
  on conflict (organizacion_id) do update set ultimo_latido = now();
  if v_recibidos > 0 then perform robot_tocar(p_org); end if;
  return jsonb_build_object('registrados', v_reg, 'repetidos', v_rep, 'sin_cheque', v_sin, 'recibidos', v_recibidos);
end $$;

-- resultadoDebito: lo que el robot devuelve de los débitos. { resultados: [{modo, empresa, cheque, banco, acreedor, importe, fechaCobro, fila, estado, movimiento, detalle}] }
-- Antes solo quedaba en un log; ahora queda en el cheque (robot_debito_*, xubio_debito_id) y en procesos_log. Mismas reglas que arriba.
create or replace function robot_registrar_debitos(p_org uuid, p_cuerpo jsonb, p_permitir_real boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; ch cheques; v_ch uuid; v_decl text; v_modo text; v_estado text; v_detalle text; v_mov text; v_prev text;
  v_recibidos integer := 0; v_reg integer := 0; v_rep integer := 0; v_sin integer := 0; v_estado_log text; v_real_ok boolean;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  perform fijar_organizacion_del_proceso(p_org);
  v_real_ok := coalesce(p_permitir_real, false) and not robot_entregada_como_prueba(p_org);
  for r in select x from jsonb_array_elements(case when jsonb_typeof(p_cuerpo -> 'resultados') = 'array' then p_cuerpo -> 'resultados' else '[]'::jsonb end) x loop
    v_recibidos := v_recibidos + 1;
    v_decl := case when lower(coalesce(r ->> 'modo', '')) = 'real' then 'real' else 'prueba' end;
    v_estado := upper(trim(coalesce(r ->> 'estado', '')));
    v_detalle := left(coalesce(r ->> 'detalle', ''), 1000);
    v_modo := case when v_decl = 'real' and v_real_ok and v_estado <> 'PRUEBA_OK' then 'real' else 'prueba' end;
    if v_decl = 'real' and v_modo = 'prueba' and v_estado <> 'PRUEBA_OK' then
      v_detalle := left('[Declarado real, registrado como prueba: el servidor no tiene el envío real encendido o la corrida se entregó como prueba] ' || v_detalle, 1000);
    end if;
    v_mov := left(nullif(trim(coalesce(r ->> 'movimiento', '')), ''), 80);
    if v_estado not in ('PRUEBA_OK', 'DEBITADO', 'YA_DEBITADO', 'SIN_OP', 'REVISAR', 'ERROR_DEBITO') then
      insert into procesos_log (organizacion_id, proceso, modo, entidad, estado, detalle, datos)
      values (p_org, 'ROBOT_DEBITOS', upper(v_modo), 'CHEQUE', 'OMITIDO', left('Estado desconocido (' || v_estado || '): no se registró. ' || v_detalle, 1000), r);
      v_sin := v_sin + 1; continue;
    end if;
    v_ch := robot_buscar_cheque(p_org, r, true);
    if v_ch is null then
      insert into procesos_log (organizacion_id, proceso, modo, entidad, estado, detalle, datos)
      values (p_org, 'ROBOT_DEBITOS', upper(v_modo), 'CHEQUE', 'OMITIDO',
              left('No se encontró el cheque ' || coalesce(r ->> 'cheque', '?') || ' de ' || coalesce(r ->> 'empresa', '?') || ' (o hay más de uno). Resultado del robot: ' || v_estado || ' · ' || v_detalle, 1000), r);
      v_sin := v_sin + 1; continue;
    end if;
    select * into ch from cheques where id = v_ch for update;
    v_prev := case when ch.robot_debito_modo = 'real' and ch.robot_debito_estado in ('DEBITADO', 'YA_DEBITADO') then ch.robot_debito_estado end;
    if v_modo = 'real' and v_prev is not null then
      if v_prev = v_estado then v_rep := v_rep + 1; continue; end if;
      insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle, datos)
      values (p_org, ch.empresa_id, 'ROBOT_DEBITOS', 'REAL', 'CHEQUE', v_ch::text, 'OMITIDO',
              left('El cheque ya figuraba ' || v_prev || ': no se pisa con ' || v_estado || '. ' || v_detalle, 1000), r || jsonb_build_object('chequeId', v_ch));
      v_rep := v_rep + 1; continue;
    end if;
    v_estado_log := case v_estado when 'PRUEBA_OK' then 'PRUEBA_OK' when 'ERROR_DEBITO' then 'ERROR' else 'OK' end;
    insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle, datos)
    values (p_org, ch.empresa_id, 'ROBOT_DEBITOS', upper(v_modo), 'CHEQUE', v_ch::text, v_estado_log,
            left(v_estado || coalesce(' · ' || v_mov, '') || ' · ' || v_detalle, 1000), r || jsonb_build_object('estado', v_estado, 'chequeId', v_ch));
    if v_modo = 'prueba' and ch.robot_debito_modo = 'real' and ch.robot_debito_estado is not null then
      v_reg := v_reg + 1; continue;                                                          -- una prueba no pisa una corrida real
    end if;
    update cheques set robot_debito_estado = v_estado, robot_debito_modo = v_modo, robot_debito_detalle = left(v_detalle, 400), robot_debito_en = now(),
      robot_movimiento = coalesce(v_mov, robot_movimiento),
      xubio_debito_id = case when v_modo = 'real' and v_estado in ('DEBITADO', 'YA_DEBITADO') then coalesce(xubio_debito_id, v_mov) else xubio_debito_id end
    where id = v_ch;
    if v_modo = 'real' then
      insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
      values ('Robot e-cheqs', 'ADMIN', 'ROBOT_DEBITO_' || v_estado, 'CHEQUE', v_ch::text, left(ch.numero || coalesce(' · ' || v_mov, '') || ' · ' || v_detalle, 500));
    end if;
    v_reg := v_reg + 1;
  end loop;
  insert into robot_control (organizacion_id, ultimo_latido) values (p_org, now())
  on conflict (organizacion_id) do update set ultimo_latido = now();
  if v_recibidos > 0 then perform robot_tocar(p_org); end if;
  return jsonb_build_object('registrados', v_reg, 'repetidos', v_rep, 'sin_cheque', v_sin, 'recibidos', v_recibidos);
end $$;

-- ---------------------------------------------------------------- Panel (lo que ve la persona)

-- estadoRobotEcheqs: pendientes de cada cosa, si hay corrida pedida o en curso y lo último que hizo el robot. Solo de las empresas que la persona ve.
create or replace function robot_estado_panel()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; v_org uuid; v_emp text[]; c robot_corridas; ctl robot_control; v_est text; v_op jsonb; v_deb jsonb;
  v_grupos jsonb; v_cand jsonb; v_corrida jsonb; v_ult_op jsonb; v_ult_deb jsonb; v_atencion jsonb; v_avisos jsonb := '[]'; v_habilitado boolean;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'DIRECCION', 'CONTROLLER', 'ADMIN');
  v_org := u.organizacion_id;
  v_emp := array(select empresas_visibles());
  perform robot_cerrar_vencidas(v_org);
  -- Habilitado: el robot atiende a esta organización y alguna empresa suya lo tiene encendido.
  select robot_org_servida() = v_org and exists (select 1 from empresas e where e.organizacion_id = v_org and e.robot_echeqs) into v_habilitado;
  v_grupos := robot_grupos_op(v_org, v_emp);
  v_cand := robot_candidatos_debito(v_org, 45, v_emp);
  select * into ctl from robot_control where organizacion_id = v_org;
  select * into c from robot_corridas where organizacion_id = v_org order by pedida_en desc, id limit 1;
  if c.id is not null then
    v_est := case c.estado when 'PEDIDA' then 'pedida' when 'CORRIENDO' then 'corriendo' when 'SIN_FIN' then 'sin_fin'
                           when 'TERMINADA' then 'terminada' when 'ERROR' then 'error' else 'cancelada' end;
    if c.tomada_en is not null then
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_op from (
        select datos ->> 'estado' as k, count(*) as n from procesos_log
        where organizacion_id = v_org and proceso = 'ROBOT_ECHEQS' and entidad = 'CHEQUE' and creado_en >= c.tomada_en
          and (empresa_id = any(v_emp) or (empresa_id is null and ve_todas_las_empresas())) and datos ->> 'estado' is not null group by 1) q;
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_deb from (
        select datos ->> 'estado' as k, count(*) as n from procesos_log
        where organizacion_id = v_org and proceso = 'ROBOT_DEBITOS' and entidad = 'CHEQUE' and creado_en >= c.tomada_en
          and (empresa_id = any(v_emp) or (empresa_id is null and ve_todas_las_empresas())) and datos ->> 'estado' is not null group by 1) q;
      select coalesce(jsonb_agg(jsonb_build_array(robot_hora_ar(creado_en), datos ->> 'aviso', left(coalesce(datos ->> 'detalle', ''), 300)) order by creado_en), '[]'::jsonb) into v_avisos
      from procesos_log where organizacion_id = v_org and proceso = 'ROBOT_ECHEQS' and entidad = 'AVISO' and creado_en >= c.tomada_en and datos ->> 'aviso' not like 'FIN\_%';
    end if;
    v_corrida := jsonb_build_object('estado', v_est, 'tipo', c.tipo, 'modo', c.modo, 'modoEntregado', coalesce(c.modo_entregado, ''), 'origen', c.origen, 'pedidoPor', coalesce(c.pedido_por, ''),
      'pedida', robot_hora_ar(c.pedida_en), 'desde', robot_hora_ar(c.tomada_en), 'hasta', robot_hora_ar(c.fin_en), 'aviso', coalesce(c.aviso, ''), 'detalle', coalesce(c.detalle, ''),
      'op', coalesce(v_op, '{}'::jsonb), 'debito', coalesce(v_deb, '{}'::jsonb), 'avisos', v_avisos);
  end if;
  select coalesce(jsonb_agg(x order by x ->> 'en' desc), '[]'::jsonb) into v_ult_op from (
    select jsonb_build_object('fecha', robot_hora_ar(l.creado_en), 'en', l.creado_en, 'modo', lower(l.modo), 'empresa', coalesce(e.nombre_corto, ''), 'cheque', l.datos ->> 'cheque',
           'proveedor', coalesce(l.datos ->> 'proveedor', ''), 'importe', l.datos -> 'importe', 'estado', coalesce(l.datos ->> 'estado', l.estado), 'numeroOP', coalesce(l.datos ->> 'numeroOP', ''), 'detalle', left(coalesce(l.detalle, ''), 300)) as x
    from procesos_log l left join empresas e on e.id = l.empresa_id
    where l.organizacion_id = v_org and l.proceso = 'ROBOT_ECHEQS' and l.entidad = 'CHEQUE' and (l.empresa_id = any(v_emp) or (l.empresa_id is null and ve_todas_las_empresas()))
    order by l.creado_en desc, l.id desc limit 10) q;
  select coalesce(jsonb_agg(x order by x ->> 'en' desc), '[]'::jsonb) into v_ult_deb from (
    select jsonb_build_object('fecha', robot_hora_ar(l.creado_en), 'en', l.creado_en, 'modo', lower(l.modo), 'empresa', coalesce(e.nombre_corto, ''), 'cheque', l.datos ->> 'cheque',
           'banco', coalesce(l.datos ->> 'banco', ''), 'acreedor', coalesce(l.datos ->> 'acreedor', ''), 'importe', l.datos -> 'importe', 'fechaCobro', coalesce(l.datos ->> 'fechaCobro', ''),
           'estado', coalesce(l.datos ->> 'estado', l.estado), 'movimiento', coalesce(l.datos ->> 'movimiento', ''), 'detalle', left(coalesce(l.detalle, ''), 300)) as x
    from procesos_log l left join empresas e on e.id = l.empresa_id
    where l.organizacion_id = v_org and l.proceso = 'ROBOT_DEBITOS' and l.entidad = 'CHEQUE' and (l.empresa_id = any(v_emp) or (l.empresa_id is null and ve_todas_las_empresas()))
    order by l.creado_en desc, l.id desc limit 12) q;
  -- Lo que necesita a una persona: e-cheqs con error o con la orden subida pero sin aplicar, y débitos sin orden de pago, para revisar o con error.
  select coalesce(jsonb_agg(x order by x ->> 'en' desc), '[]'::jsonb) into v_atencion from (
    select jsonb_build_object('id', ch.id, 'tipo', 'op', 'empresa', e.nombre_corto, 'cheque', ch.numero, 'importe', ch.importe, 'estado', ch.robot_op_estado,
           'detalle', coalesce(ch.robot_op_detalle, ''), 'en', ch.robot_op_en, 'puedeReintentar', ch.robot_op_estado = 'ERROR_ROBOT',
           'puedeCerrar', ch.robot_op_estado = 'SUBIDO_SIN_APLICAR', 'intentos', ch.robot_op_intentos) as x
    from cheques ch join empresas e on e.id = ch.empresa_id
    where e.organizacion_id = v_org and ch.empresa_id = any(v_emp) and ch.robot_op_modo = 'real'
      and (ch.robot_op_estado = 'SUBIDO_SIN_APLICAR' or (ch.robot_op_estado = 'ERROR_ROBOT' and ch.robot_op_intentos >= 3))
    union all
    select jsonb_build_object('id', ch.id, 'tipo', 'debito', 'empresa', e.nombre_corto, 'cheque', ch.numero, 'importe', ch.importe, 'estado', ch.robot_debito_estado,
           'detalle', coalesce(ch.robot_debito_detalle, ''), 'en', ch.robot_debito_en, 'puedeReintentar', true, 'puedeCerrar', false, 'intentos', 0)
    from cheques ch join empresas e on e.id = ch.empresa_id
    where e.organizacion_id = v_org and ch.empresa_id = any(v_emp) and ch.robot_debito_modo = 'real' and ch.robot_debito_estado in ('SIN_OP', 'REVISAR', 'ERROR_DEBITO')
      and ch.estado = 'DEBITADO') q;
  return jsonb_build_object(
    'habilitado', v_habilitado,
    'pendientes', jsonb_array_length(v_grupos -> 'grupos'), 'bloqueados', v_grupos -> 'bloqueados', 'grupos', v_grupos -> 'grupos',
    'pendientesDebitos', jsonb_array_length(v_cand -> 'candidatos'), 'bloqueadosDebitos', v_cand -> 'bloqueados',
    'solicitada', coalesce(c.estado = 'PEDIDA', false),
    'corrida', v_corrida,
    'ultimoLatido', robot_hora_ar(ctl.ultimo_latido), 'ultimoAviso', coalesce(ctl.ultimo_aviso, ''), 'ultimoAvisoDetalle', coalesce(ctl.ultimo_aviso_detalle, ''),
    'ultimoAvisoEn', robot_hora_ar(ctl.ultimo_aviso_en),
    'ultimosOP', v_ult_op, 'ultimosDebitos', v_ult_deb, 'atencion', v_atencion);
end $$;

-- Vuelve a poner un cheque en la cola del robot: un e-cheq con ERROR_ROBOT (después de revisarlo en Xubio) o un débito que quedó
-- sin orden de pago, para revisar o con error. El robot comprueba en Xubio antes de cargar o debitar, así que reintentar es seguro.
create or replace function robot_reintentar_cheque(p_cheque uuid, p_que text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; ch cheques;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into ch from cheques where id = p_cheque for update;
  if ch.id is null then raise exception 'Cheque inexistente'; end if;
  perform exigir_empresa(ch.empresa_id);
  if p_que = 'op' then
    if ch.robot_op_estado is distinct from 'ERROR_ROBOT' then raise exception 'Solo se reintenta un e-cheq que quedó con error'; end if;
    update cheques set robot_op_estado = null, robot_op_modo = null, robot_op_detalle = null, robot_op_en = null, robot_op_intentos = 0 where id = p_cheque;
  elsif p_que = 'debito' then
    if ch.robot_debito_estado is null or ch.robot_debito_estado in ('DEBITADO', 'YA_DEBITADO', 'PRUEBA_OK') then raise exception 'Este débito no está para reintentar'; end if;
    update cheques set robot_debito_estado = null, robot_debito_modo = null, robot_debito_detalle = null, robot_debito_en = null where id = p_cheque;
  else
    raise exception 'Indicá si es de e-cheq (op) o de débito';
  end if;
  perform registrar_auditoria(u, 'ROBOT_REINTENTAR', 'CHEQUE', p_cheque::text, p_que || ' · ' || ch.numero);
end $$;

-- Después de aplicar a mano en Xubio la orden que el robot dejó sin aplicar: el cheque pasa a SUBIDO y los pagos dejan de decir "FALTA APLICAR".
create or replace function robot_cerrar_sin_aplicar(p_cheque uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; ch cheques;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into ch from cheques where id = p_cheque for update;
  if ch.id is null then raise exception 'Cheque inexistente'; end if;
  perform exigir_empresa(ch.empresa_id);
  if ch.robot_op_estado is distinct from 'SUBIDO_SIN_APLICAR' then raise exception 'Este cheque no quedó con la aplicación pendiente'; end if;
  update cheques set robot_op_estado = 'SUBIDO', robot_op_en = now(),
    robot_op_detalle = left(coalesce(nullif(trim(regexp_replace(robot_op_detalle, '[⚠[:space:]]*FALTA APLICAR[^.;|]*[.;|]?', '', 'gi')), '') || ' · ', '') || 'aplicación cerrada a mano por ' || u.nombre, 400)
  where id = p_cheque;
  perform robot_limpiar_falta_aplicar(p_cheque, null);
  perform registrar_auditoria(u, 'ROBOT_CERRAR_SIN_APLICAR', 'CHEQUE', p_cheque::text, ch.numero);
end $$;

-- Administración contabiliza un e-cheq contra una cuenta de e-cheqs: Xubio no deja crear esa orden de pago por API, así que el pago queda
-- REVISADO (con su cuenta contable y su forma) y marcado CARGAR_A_MANO para que lo cargue el robot. La llama la función `contabilizar`
-- (el caso echeqAMano) en lugar de cortar. Pasa a gestión del sistema: la copia de la hoja no lo deshace.
create or replace function marcar_echeq_a_mano(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_detalle text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  if coalesce(trim(p_cuenta), '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  update pagos set estado = 'REVISADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma, estado_xubio_pago = 'CARGAR_A_MANO',
                   detalle_contabilizacion = left(p_detalle, 500), gestion = 'SISTEMA'
  where id = p_id and estado in ('CARGADO', 'REVISADO');
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'ECHEQ_PARA_ROBOT', 'PAGO', p_id::text, left(p_detalle, 500));
end $$;

-- La copia de la hoja (espejar_pagos) vuelve a escribir los pagos de la hoja cuando la fila cambia: no puede deshacer lo que dejó el robot
-- (estado, detalle y N° de OP del pago). Si la hoja sigue diciendo CARGAR_A_MANO o vacío, se conserva lo del robot; si dice otra cosa, manda la hoja.
create or replace function pago_conserva_robot()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.robot_echeq_en is not null and new.robot_echeq_en is not distinct from old.robot_echeq_en
     and upper(coalesce(old.estado_xubio_pago, '')) in ('SUBIDO', 'YA_EN_XUBIO')
     and upper(coalesce(new.estado_xubio_pago, '')) in ('', 'CARGAR_A_MANO') then
    new.estado_xubio_pago := old.estado_xubio_pago;
    new.xubio_detalle := old.xubio_detalle;
    if new.numero_op is null then new.numero_op := old.numero_op; end if;
    if coalesce(old.detalle_contabilizacion, '') like '%(robot e-cheqs)%' and coalesce(new.detalle_contabilizacion, '') not like '%(robot e-cheqs)%' then
      new.detalle_contabilizacion := coalesce(nullif(new.detalle_contabilizacion, '') || ' · ', '') || coalesce(substring(old.detalle_contabilizacion from 'N° [^ ]+ \(robot e-cheqs\)'), 'robot e-cheqs');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_pago_conserva_robot on pagos;
create trigger trg_pago_conserva_robot before update on pagos for each row execute function pago_conserva_robot();

-- ---------------------------------------------------------------- Permisos
-- Las funciones nuevas no dan EXECUTE por defecto (0021, 0035): se lo damos a quien corresponde.

-- Las que llama la pantalla con la sesión de la persona (y también el servidor).
revoke execute on function
  robot_pedir_corrida(text, text),
  robot_cancelar_corrida(),
  robot_estado_panel(),
  robot_reintentar_cheque(uuid, text),
  robot_cerrar_sin_aplicar(uuid)
from public, anon;
grant execute on function
  robot_pedir_corrida(text, text),
  robot_cancelar_corrida(),
  robot_estado_panel(),
  robot_reintentar_cheque(uuid, text),
  robot_cerrar_sin_aplicar(uuid)
to authenticated, service_role;

-- Solo el servidor: la API del robot, la corrida automática y las piezas que usan las otras funciones.
revoke execute on function
  robot_nombre_empresa(text),
  robot_pago_pendiente(pagos),
  robot_rango_op(text),
  robot_hora_ar(timestamptz),
  robot_corriendo(uuid),
  robot_minutos_sin_senal(),
  robot_cerrar_vencidas(uuid, boolean),
  robot_tocar(uuid),
  robot_org_servida(),
  robot_entregada_como_prueba(uuid),
  robot_es_numero_op(text),
  robot_limpiar_falta_aplicar(uuid, text),
  marcar_echeq_a_mano(uuid, text, forma_carga_xubio, text, text, rol),
  pago_conserva_robot(),
  robot_buscar_cheque(uuid, jsonb, boolean),
  robot_grupos_op(uuid, text[]),
  robot_candidatos_debito(uuid, integer, text[]),
  robot_pedir_automatica(uuid, text, boolean, boolean),
  robot_organizacion(),
  robot_estado(uuid),
  robot_tomar_corrida(uuid, boolean),
  robot_registrar_aviso(uuid, text, text),
  robot_registrar_resultados(uuid, jsonb, boolean),
  robot_registrar_debitos(uuid, jsonb, boolean)
from public, anon, authenticated;
grant execute on function
  robot_nombre_empresa(text),
  robot_pago_pendiente(pagos),
  robot_rango_op(text),
  robot_hora_ar(timestamptz),
  robot_corriendo(uuid),
  robot_minutos_sin_senal(),
  robot_cerrar_vencidas(uuid, boolean),
  robot_tocar(uuid),
  robot_org_servida(),
  robot_entregada_como_prueba(uuid),
  robot_es_numero_op(text),
  robot_limpiar_falta_aplicar(uuid, text),
  marcar_echeq_a_mano(uuid, text, forma_carga_xubio, text, text, rol),
  pago_conserva_robot(),
  robot_buscar_cheque(uuid, jsonb, boolean),
  robot_grupos_op(uuid, text[]),
  robot_candidatos_debito(uuid, integer, text[]),
  robot_pedir_automatica(uuid, text, boolean, boolean),
  robot_organizacion(),
  robot_estado(uuid),
  robot_tomar_corrida(uuid, boolean),
  robot_registrar_aviso(uuid, text, text),
  robot_registrar_resultados(uuid, jsonb, boolean),
  robot_registrar_debitos(uuid, jsonb, boolean)
to service_role;
