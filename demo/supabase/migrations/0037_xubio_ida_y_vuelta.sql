-- Xubio de ida y vuelta, copiando lo que hace el Apps Script (27/11/2026).
--
--   1. N° de orden de pago (o de asiento) de cada pago contabilizado: lo trae el servidor desde Xubio (a las 9 y a las 14 h,
--      PagoFactura.js: completarNumerosOPDesdeXubio) y se puede cargar a mano (ParchePagos.js: guardarNumeroOpAsiento).
--   2. Saldo de Xubio en la conciliación (ConciliacionBancaria.js: obtenerConciliacionBancaria): la cuenta de Xubio se empareja con
--      la cuenta bancaria por los dígitos del nombre y se llena lecturas_xubio (0024). La diferencia ya la muestra la vista
--      conciliacion (0031) y la pantalla Bancos.
--   3. Cobranzas de Xubio (cbxTraerCobranzasXubio, todos los días 8:30): llenan la tabla cobros (0025).
--   4. Sincronizar facturas pagadas (Code.js: sincronizarFacturasPagadas_, cada hora): el Apps Script cruza las facturas
--      "para pagar" con los pagos cargados (proveedor + número de factura) y las marca pagadas. Acá se hace igual.
--   5. Anulación de la orden de pago en Xubio por API: la hace el servidor detrás de XUBIO_ANULAR_ENVIO_REAL (apagada por
--      defecto). Acá solo queda el registro del resultado con auditoría (resultado_anulacion_xubio).
--
-- Las funciones se redefinen desde la última versión que las define: registrar_lectura_xubio (0024).
-- Los procesos escriben en procesos_log con los valores que ya acepta (XUBIO_PAGOS, LECTURA_XUBIO, XUBIO_ANULACIONES).

-- ---------------------------------------------------------------- 1. N° de OP o de asiento

alter table pagos add column if not exists numero_op text;                    -- "X-0001-00002312" o el N° de asiento
alter table pagos add column if not exists numero_op_origen text check (numero_op_origen in ('XUBIO', 'MANUAL'));
alter table pagos add column if not exists numero_op_por text;
alter table pagos add column if not exists numero_op_en timestamptz;

-- A mano: Tesorería o Administración cargan el N° de OP o de asiento de un pago ya contabilizado.
-- Un N° no se repite entre los pagos de una empresa (índice de abajo). Si el pago ya tiene uno, no se lo pisa a menos que
-- se confirme (p_confirmar = true: la pantalla lo pregunta).
create unique index if not exists pagos_numero_op_unico on pagos (empresa_id, numero_op) where numero_op is not null;

create or replace function guardar_numero_op(p_pago uuid, p_numero text, p_confirmar boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; pg pagos; v_num text := trim(coalesce(p_numero, '')); v_otro pagos;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  if v_num = '' then raise exception 'Escribí el N° de OP o de asiento'; end if;
  if upper(v_num) = 'PENDIENTE' then raise exception 'Escribí el número que le dio Xubio'; end if;
  if length(v_num) > 40 then raise exception 'El N° es demasiado largo'; end if;
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(pg.empresa_id);
  if pg.estado::text = 'ANULADO' then raise exception 'Este pago está anulado: no se le carga N° de OP'; end if;
  if pg.estado::text not in ('CONTABILIZADO', 'CONCILIADO') then raise exception 'Este pago todavía no está contabilizado'; end if;
  if coalesce(pg.xubio_id, '') = 'RALPHARMA' then raise exception 'Este pago se cargó en Ralpharma: no tiene N° de Xubio'; end if;
  select * into v_otro from pagos where empresa_id = pg.empresa_id and numero_op = v_num and id <> pg.id limit 1;
  if v_otro.id is not null then
    raise exception 'El N° % ya está en otro pago de esta empresa (% · $ %)', v_num, to_char(v_otro.fecha, 'DD/MM/YYYY'), v_otro.importe;
  end if;
  if pg.numero_op is not null and pg.numero_op <> v_num and not coalesce(p_confirmar, false) then
    raise exception 'Este pago ya tiene el N° %. Para cambiarlo hay que confirmarlo', pg.numero_op;
  end if;
  update pagos set numero_op = v_num, numero_op_origen = 'MANUAL', numero_op_por = u.nombre, numero_op_en = now(),
    detalle_contabilizacion = coalesce(nullif(detalle_contabilizacion, '') || ' · ', '') || 'N° ' || v_num || ' (' || u.nombre || ')'
  where id = p_pago;
  perform registrar_auditoria(u, 'NUMERO_OP_MANUAL', 'PAGO', p_pago::text,
    'N° ' || v_num || case when pg.numero_op is not null then ' (antes ' || pg.numero_op || ')' else '' end);
end $$;

-- Solo el servidor: los pagos de órdenes de pago contabilizados en Xubio (de los últimos 90 días) que todavía no
-- tienen número (solo los gobernados por el sistema), más los números ya usados, por empresa (para no repetir uno en dos pagos).
-- No entran los que se cargaron dentro de una factura (FC-…), en Ralpharma o a mano: no tienen una OP para buscar.
create or replace function numero_op_pendientes(p_organizacion uuid, p_max integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_pend jsonb; v_usados jsonb;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'empresa_id', t.empresa_id, 'fecha', t.fecha, 'importe', t.importe,
           'proveedor', t.proveedor, 'xubio_id', t.xubio_id) order by t.fecha desc), '[]'::jsonb) into v_pend
  from (
    select p.id, p.empresa_id, p.fecha, p.importe, coalesce(pr.nombre, p.proveedor_destino, '') as proveedor, p.xubio_id
    from pagos p
    join empresas e on e.id = p.empresa_id
    left join proveedores pr on pr.id = p.proveedor_id
    where e.organizacion_id = p_organizacion and e.erp = 'XUBIO'
      and p.estado::text in ('CONTABILIZADO', 'CONCILIADO') and p.forma_carga_xubio = 'ORDEN_PAGO'
      and nullif(trim(coalesce(p.numero_op, '')), '') is null
      and p.importe > 0 and p.fecha >= hoy_ar() - 90
      -- Los pagos de la hoja los gobierna la hoja (su NUMERO_OP_ASIENTO no se copia acá): no se les escribe.
      and p.gestion = 'SISTEMA'
      and coalesce(p.xubio_id, '') !~ '^(FC-|RALPHARMA|CARGADO_A_MANO)'
    order by p.fecha desc limit greatest(1, least(coalesce(p_max, 200), 500))
  ) t;
  -- Cada empresa es una cuenta de Xubio con su propia numeración: los usados se cuentan por empresa.
  select coalesce(jsonb_agg(distinct jsonb_build_object('empresa_id', p.empresa_id, 'numero', p.numero_op)), '[]'::jsonb) into v_usados
  from pagos p join empresas e on e.id = p.empresa_id
  where e.organizacion_id = p_organizacion and nullif(trim(coalesce(p.numero_op, '')), '') is not null;
  return jsonb_build_object('pendientes', v_pend, 'usados', v_usados);
end $$;

-- Solo el servidor: guarda el número que encontró en Xubio. No pisa uno ya cargado (a mano o antes).
create or replace function aplicar_numero_op_xubio(p_pago uuid, p_numero text, p_usuario text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare pg pagos; v_num text := trim(coalesce(p_numero, '')); v_usuario text := coalesce(p_usuario, 'Número de OP desde Xubio');
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  if v_num = '' or length(v_num) > 40 then raise exception 'Número de OP inválido'; end if;
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null then raise exception 'Pago inexistente'; end if;
  if nullif(trim(coalesce(pg.numero_op, '')), '') is not null then return false; end if;
  if pg.estado::text not in ('CONTABILIZADO', 'CONCILIADO') or pg.gestion <> 'SISTEMA' then return false; end if;
  -- Si otro pago de la empresa ya tiene ese número, no se le asigna a este (el índice único también lo impediría).
  if exists (select 1 from pagos where empresa_id = pg.empresa_id and numero_op = v_num and id <> pg.id) then return false; end if;
  update pagos set numero_op = v_num, numero_op_origen = 'XUBIO', numero_op_por = v_usuario, numero_op_en = now(),
    detalle_contabilizacion = coalesce(nullif(detalle_contabilizacion, '') || ' · ', '') || 'N° ' || v_num || ' (automático desde Xubio)'
  where id = p_pago;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (v_usuario, 'ADMIN', 'NUMERO_OP_XUBIO', 'PAGO', p_pago::text, 'N° ' || v_num || ' traído desde Xubio');
  return true;
end $$;

-- ---------------------------------------------------------------- 2. Saldo de Xubio: emparejar por dígitos

-- Qué cuenta bancaria es una cuenta del plan de Xubio. Mismo criterio que el Apps Script (obtenerConciliacionBancaria › buscar),
-- pero la API "cuenta" devuelve TODO el plan (el Apps Script leía el reporte de Fondos, solo bancos), así que acá es más estricto:
--   a) mismo nombre (el de la cuenta, o el de su cuenta contable);
--   b) los dígitos: un número de 3 o más cifras del banco ("0319", "7861") que coincida con uno del nombre en Xubio
--      (igual, o que uno termine en el otro), y además el nombre de Xubio nombra al banco de esa cuenta. Si queda más de una
--      cuenta, no se adivina.
-- Una cuenta de gasto, de deudores o de impuestos ("Gastos Bancarios Banco Macro", "Deudores por ventas 3120") nunca se empareja.
-- No hay emparejamiento "por una palabra": con una sola palabra en común se confundían las cuentas de gasto con las del banco.
-- Los cheques, los e-cheqs y los fondos comunes no se emparejan (en Xubio van juntos en una sola cuenta).
create or replace function emparejar_cuenta_xubio(p_empresa text, p_cuenta_xubio text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_x text := texto_banco(p_cuenta_xubio); v_tokens text[]; v_id uuid; v_n integer;
begin
  if v_x = '' or trim(v_x) = '' then return null; end if;
  select c.id into v_id from cuentas_origen c left join cuentas_contables cc on cc.id = c.cuenta_contable_id
  where c.empresa_id = p_empresa and (texto_banco(cc.nombre) = v_x or texto_banco(c.nombre) = v_x)
  order by c.activa desc, c.orden, c.nombre limit 1;
  if v_id is not null then return v_id; end if;
  if v_x ~ 'CHEQ|E-CHE|FISICO|DIFERIDO|EMITIDO|FCI|FONDO COMUN|REMUNERADA' then return null; end if;
  if v_x ~ 'GASTO|DEUDOR|ACREEDOR|PROVEEDOR|IMPUESTO|COMISION|INTERES|SUELDO|RESULTADO|VENTAS|COMPRAS|DEUDA|PERCEPC|RETENC|\mIVA\M' then return null; end if;

  select coalesce(array_agg(t), '{}') into v_tokens from regexp_split_to_table(regexp_replace(v_x, '[^0-9]', ' ', 'g'), ' ') t where t <> '';
  if cardinality(v_tokens) = 0 then return null; end if;
  select count(*), min(x.id::text)::uuid into v_n, v_id from (
    select c.id from cuentas_origen c left join cuentas_contables cc on cc.id = c.cuenta_contable_id
    where c.empresa_id = p_empresa and c.activa and c.clase in ('CC', 'CA', 'BILLETERA')
      and (nullif(trim(coalesce(c.banco, '')), '') is null or replace(v_x, ' ', '') like '%' || replace(texto_banco(c.banco), ' ', '') || '%')
      and exists (
        select 1 from regexp_split_to_table(regexp_replace(texto_banco(coalesce(c.numero, '') || ' ' || c.nombre || ' ' || coalesce(cc.nombre, '')), '[^0-9]', ' ', 'g'), ' ') d,
                     unnest(v_tokens) t
        where length(d) >= 3 and (t = d or right(t, length(d)) = d or (length(t) >= 4 and right(d, length(t)) = t)))
  ) x;
  return case when v_n = 1 then v_id end;
end $$;

-- Guarda una lectura sin controlar quién la pide (la usan las dos funciones de abajo). Si la última lectura de esa cuenta de
-- Xubio para ese día tiene el mismo saldo, no agrega otra fila: la lectura programada repetida no llena la tabla.
create or replace function guardar_lectura_xubio(p_empresa text, p_cuenta_xubio text, p_fecha date, p_saldo numeric, p_usuario text,
                                                 out o_id uuid, out o_nueva boolean, out o_cuenta uuid)
language plpgsql security definer set search_path = public as $$
begin
  o_cuenta := emparejar_cuenta_xubio(p_empresa, p_cuenta_xubio);
  select l.id into o_id from lecturas_xubio l
  where l.empresa_id = p_empresa and l.cuenta_xubio = p_cuenta_xubio and l.fecha = p_fecha
  order by l.leido_en desc, l.id limit 1;
  if o_id is not null and (select saldo from lecturas_xubio where id = o_id) = round(p_saldo, 2) then
    o_nueva := false;
    return;
  end if;
  insert into lecturas_xubio (empresa_id, cuenta_origen_id, cuenta_xubio, fecha, saldo, leido_por)
  values (p_empresa, o_cuenta, p_cuenta_xubio, p_fecha, round(p_saldo, 2), p_usuario) returning id into o_id;
  o_nueva := true;
end $$;

-- Lectura de saldo de Xubio, una cuenta (servidor o a mano). Misma firma que la de 0024; ahora empareja por dígitos y deja auditoría.
create or replace function registrar_lectura_xubio(p_empresa text, p_cuenta_xubio text, p_fecha date, p_saldo numeric, p_usuario text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare u usuarios; v_usuario text; r record;
begin
  perform exigir_empresa(p_empresa);
  if es_servidor() then v_usuario := coalesce(p_usuario, 'servidor');
  else u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN'); v_usuario := u.email; end if;
  if coalesce(trim(p_cuenta_xubio), '') = '' then raise exception 'Falta el nombre de la cuenta de Xubio'; end if;
  if p_fecha is null or p_saldo is null then raise exception 'Faltan la fecha y el saldo'; end if;
  select * into r from guardar_lectura_xubio(p_empresa, p_cuenta_xubio, p_fecha, p_saldo, v_usuario);
  if r.o_nueva then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values (coalesce(u.nombre, v_usuario), coalesce(u.rol, 'ADMIN'), 'LECTURA_XUBIO', 'EMPRESA', p_empresa,
            p_cuenta_xubio || ' · ' || p_fecha || ' · $ ' || round(p_saldo, 2) || case when r.o_cuenta is null then ' · sin cuenta bancaria emparejada' else '' end);
  end if;
  return r.o_id;
end $$;

-- Varias cuentas de una empresa de una vez: p_lecturas = [{cuenta, saldo}]. Devuelve cuántas se guardaron, cuántas ya estaban y
-- las que no se pudieron emparejar con una cuenta bancaria (se guardan igual, sin cuenta, salvo con p_solo_emparejadas: ahí se descartan).
create or replace function registrar_lecturas_xubio(p_empresa text, p_fecha date, p_lecturas jsonb, p_usuario text default null, p_solo_emparejadas boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; v_usuario text; x jsonb; r record; v_nuevas integer := 0; v_repetidas integer := 0; v_sin text[] := '{}'; v_invalidas integer := 0;
  v_dup text[] := '{}'; v_nombres text[] := '{}'; v_saldos numeric[] := '{}'; v_cuentas uuid[] := '{}'; v_i integer; v_cta uuid;
begin
  perform exigir_empresa(p_empresa);
  if es_servidor() then v_usuario := coalesce(p_usuario, 'servidor');
  else u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN'); v_usuario := u.email; end if;
  if p_fecha is null then raise exception 'Falta la fecha de la lectura'; end if;
  if p_fecha > hoy_ar() then raise exception 'La fecha de la lectura no puede ser futura'; end if;
  if jsonb_typeof(p_lecturas) is distinct from 'array' then raise exception 'Faltan las lecturas'; end if;
  -- Primero se empareja todo: si dos cuentas de Xubio caen en la misma cuenta bancaria no se sabe cuál es el saldo del banco,
  -- así que se descartan las dos (y se avisa en "duplicadas").
  for x in select * from jsonb_array_elements(p_lecturas) loop
    if coalesce(trim(x ->> 'cuenta'), '') = '' or (x ->> 'saldo') is null or (x ->> 'saldo') !~ '^-?[0-9]+(\.[0-9]+)?$' then v_invalidas := v_invalidas + 1; continue; end if;
    v_nombres := v_nombres || trim(x ->> 'cuenta'); v_saldos := v_saldos || (x ->> 'saldo')::numeric;
    v_cuentas := v_cuentas || emparejar_cuenta_xubio(p_empresa, trim(x ->> 'cuenta'));
  end loop;
  for v_i in 1 .. coalesce(array_length(v_nombres, 1), 0) loop
    v_cta := v_cuentas[v_i];
    if v_cta is not null and (select count(*) from unnest(v_cuentas) c where c = v_cta) > 1 then v_dup := v_dup || v_nombres[v_i]; continue; end if;
    if v_cta is null and p_solo_emparejadas then v_sin := v_sin || v_nombres[v_i]; continue; end if;
    select * into r from guardar_lectura_xubio(p_empresa, v_nombres[v_i], p_fecha, v_saldos[v_i], v_usuario);
    if r.o_nueva then v_nuevas := v_nuevas + 1; else v_repetidas := v_repetidas + 1; end if;
    if r.o_cuenta is null then v_sin := v_sin || v_nombres[v_i]; end if;
  end loop;
  if v_nuevas > 0 or cardinality(v_dup) > 0 then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values (coalesce(u.nombre, v_usuario), coalesce(u.rol, 'ADMIN'), 'LECTURA_XUBIO', 'EMPRESA', p_empresa,
            v_nuevas || ' saldo(s) de Xubio al ' || p_fecha || case when cardinality(v_sin) > 0 then ' · sin cuenta bancaria emparejada: ' || array_to_string(v_sin, ', ') else '' end
            || case when cardinality(v_dup) > 0 then ' · DESCARTADAS (dos cuentas de Xubio para la misma cuenta bancaria): ' || array_to_string(v_dup, ', ') else '' end);
  end if;
  return jsonb_build_object('guardadas', v_nuevas, 'repetidas', v_repetidas, 'invalidas', v_invalidas, 'sin_cuenta', to_jsonb(v_sin), 'duplicadas', to_jsonb(v_dup));
end $$;

-- ---------------------------------------------------------------- 3. Cobranzas de Xubio

-- Solo el servidor. p_cobros = [{fecha, recibo, transaccion_id, instrumento_id, cliente, cuenta, importe, descripcion}], uno por
-- instrumento de cobro de cada cobranza (la clave es transacción + instrumento, como en la hoja Cobros_Xubio; sin id de instrumento,
-- su lugar dentro de la cobranza, así dos instrumentos no se pisan). Lo que ya estaba
-- no se vuelve a cargar; lo que no tiene importe positivo se descarta.
create or replace function importar_cobros_xubio(p_empresa text, p_cobros jsonb, p_usuario text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c jsonb; q record; v_importe numeric; v_fecha date; v_tx text; v_ic text; v_filas integer;
  v_nuevas integer := 0; v_ya integer := 0; v_omitidas integer := 0; v_usuario text := coalesce(p_usuario, 'Cobranzas de Xubio');
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  if not exists (select 1 from empresas where id = p_empresa) then raise exception 'Empresa inexistente'; end if;
  if jsonb_typeof(p_cobros) is distinct from 'array' then raise exception 'Faltan las cobranzas'; end if;
  -- q.k: el lugar del instrumento dentro de su cobranza (para la clave cuando Xubio no manda el id del instrumento).
  for q in select t.value as c, (row_number() over (partition by t.value ->> 'transaccion_id' order by t.ord))::integer as k
           from jsonb_array_elements(p_cobros) with ordinality as t(value, ord) order by t.ord loop
    c := q.c;
    begin
      v_importe := round((c ->> 'importe')::numeric, 2);
      v_fecha := nullif(left(coalesce(c ->> 'fecha', ''), 10), '')::date;
    exception when others then
      v_omitidas := v_omitidas + 1; continue;
    end;
    v_tx := nullif(trim(coalesce(c ->> 'transaccion_id', '')), '');
    v_ic := nullif(trim(coalesce(c ->> 'instrumento_id', '')), '');
    if v_importe is null or v_importe <= 0 or v_fecha is null or v_tx is null then v_omitidas := v_omitidas + 1; continue; end if;
    insert into cobros (empresa_id, cuenta_origen_id, fecha, cliente, recibo, importe, descripcion, xubio_transaccion_id, origen)
    values (p_empresa, emparejar_cuenta_xubio(p_empresa, c ->> 'cuenta'), v_fecha, coalesce(nullif(trim(c ->> 'cliente'), ''), 'Sin nombre'),
            nullif(trim(coalesce(c ->> 'recibo', '')), ''), v_importe, nullif(trim(coalesce(c ->> 'descripcion', '')), ''),
            v_tx || ':' || coalesce(v_ic, 'n' || q.k), 'XUBIO')
    on conflict (empresa_id, xubio_transaccion_id) do nothing;
    get diagnostics v_filas = row_count;
    if v_filas > 0 then v_nuevas := v_nuevas + 1; else v_ya := v_ya + 1; end if;
  end loop;
  if v_nuevas > 0 then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values (v_usuario, 'ADMIN', 'COBROS_XUBIO', 'EMPRESA', p_empresa, v_nuevas || ' cobranza(s) nueva(s) traída(s) de Xubio');
  end if;
  return jsonb_build_object('nuevas', v_nuevas, 'ya_estaban', v_ya, 'omitidas', v_omitidas);
end $$;

-- ---------------------------------------------------------------- 4. Sincronizar facturas pagadas

-- Los números de factura que dice un pago ("00001-00000123", "A-1-123, A-1-124"): cada uno como "punto-número" sin ceros.
create or replace function numeros_de_facturas(p text)
returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct (m)[1]::bigint::text || '-' || (m)[2]::bigint::text), '{}')
  from (select regexp_match(t, '(\d{1,5})\D+(\d{1,8})') as m from unnest(regexp_split_to_array(coalesce(p, ''), '[,;]')) t) x
  where m is not null
$$;

-- ¿Es el mismo proveedor? Comparten una palabra de 4 letras o más (sin SA, SRL, laboratorio…), como en el Apps Script.
create or replace function mismo_proveedor_palabras(a text, b text)
returns boolean language sql immutable as $$
  select exists (
    select 1
    from regexp_split_to_table(regexp_replace(upper(translate(coalesce(a, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^A-Z0-9]+', ' ', 'g'), ' ') x
    join regexp_split_to_table(regexp_replace(upper(translate(coalesce(b, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^A-Z0-9]+', ' ', 'g'), ' ') y on x = y
    where length(x) >= 4 and x !~ '^(SOCIEDAD|ANONIMA|LABORATORIO|LABORATORIOS)$'
  )
$$;

-- Qué pagos ya se aplicaron a qué facturas por esta sincronización. Es la clave estable que evita contar dos veces un pago aunque
-- su vínculo en pagos_facturas se pierda (espejar_pagos borra y rearma los vínculos de los pagos de la hoja). Solo el servidor.
create table if not exists pagos_sincronizados (
  pago_id     uuid not null references pagos on delete cascade,
  factura_id  uuid not null references facturas on delete cascade,
  importe     numeric(14,2) not null,
  creado_en   timestamptz not null default now(),
  primary key (pago_id, factura_id)
);
alter table pagos_sincronizados enable row level security;
revoke all on pagos_sincronizados from public, anon, authenticated;
grant all on pagos_sincronizados to service_role;

-- Solo el servidor. Mismas reglas que sincronizarFacturasPagadas_:
--   · facturas "para pagar" (o pagadas en parte) con pagos cargados que nombran esa factura (factura_asociada) y son del mismo proveedor
--     (el del pago, si lo tiene; si no, el nombre);
--   · un pago que nombra una sola factura cuenta por su importe; uno que nombra varias, solo si alcanza para todas (cuenta el total
--     de cada una); si no alcanza, la factura va a la lista "a mano" (ambigua);
--   · si lo pagado cubre el total (a $1) la factura queda PAGADA, con la fecha del último pago; si no, queda pagada en parte.
-- No toca lo que gobierna la hoja del Apps Script (gestion = HOJA: la hoja ya hace este mismo cruce), ni los pagos que ya están
-- vinculados a la factura (pagos_facturas: ya descontaron). Al aplicar, vincula cada pago a su factura, así no se cuenta dos veces.
-- p_aplicar = false: solo dice qué haría.
create or replace function sincronizar_facturas_pagadas(p_organizacion uuid, p_aplicar boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f record; r record; v_num text; v_lista text[]; v_pagado numeric; v_amb boolean; v_ult date; v_tot numeric; v_contrib numeric;
  v_ids uuid[]; v_imps numeric[]; v_i integer; v_corre numeric; v_cambios jsonb := '[]'::jsonb; v_manual jsonb := '[]'::jsonb;
  v_total_pagado numeric; v_aplica numeric; v_estado estado_factura;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  for f in
    select fa.id, fa.empresa_id, fa.proveedor_id, fa.total, fa.pagado, fa.punto_venta, fa.numero, fa.estado, pr.nombre as proveedor
    from facturas fa join empresas e on e.id = fa.empresa_id left join proveedores pr on pr.id = fa.proveedor_id
    where e.organizacion_id = p_organizacion and fa.gestion = 'SISTEMA' and fa.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL')
      and fa.total > 0 and fa.tipo not ilike 'nota de cr%'
    order by fa.empresa_id, fa.fecha, fa.id
  loop
    v_num := f.punto_venta::bigint::text || '-' || f.numero::bigint::text;
    v_pagado := 0; v_amb := false; v_ult := null; v_ids := '{}'; v_imps := '{}';
    for r in
      select p.id, p.importe, p.fecha, p.factura_asociada
      from pagos p left join proveedores pp on pp.id = p.proveedor_id
      where p.empresa_id = f.empresa_id and p.estado::text <> 'ANULADO' and p.importe > 0 and trim(coalesce(p.factura_asociada, '')) <> ''
        and not exists (select 1 from pagos_facturas x where x.pago_id = p.id and x.factura_id = f.id)
        and not exists (select 1 from pagos_sincronizados z where z.pago_id = p.id and z.factura_id = f.id)
        -- Si el pago tiene proveedor, tiene que ser el de la factura; solo los pagos sin proveedor se cruzan por el nombre.
        and case when p.proveedor_id is not null then p.proveedor_id = f.proveedor_id
                 else mismo_proveedor_palabras(f.proveedor, p.proveedor_destino) end
      order by p.fecha, p.id
    loop
      v_lista := numeros_de_facturas(r.factura_asociada);
      if not (v_num = any(v_lista)) then continue; end if;
      if cardinality(v_lista) = 1 then
        v_contrib := r.importe;
      else
        select coalesce(sum(fb.total), 0) into v_tot from facturas fb
        where fb.empresa_id = f.empresa_id and (fb.punto_venta::bigint::text || '-' || fb.numero::bigint::text) = any(v_lista);
        if v_tot > 0 and r.importe >= v_tot - 1 then v_contrib := f.total; else v_amb := true; continue; end if;
      end if;
      v_pagado := v_pagado + v_contrib;
      v_ids := v_ids || r.id; v_imps := v_imps || v_contrib;
      if v_ult is null or r.fecha > v_ult then v_ult := r.fecha; end if;
    end loop;
    if v_pagado = 0 and not v_amb then continue; end if;
    v_total_pagado := f.pagado + v_pagado;
    if v_pagado > 0 and v_total_pagado >= f.total - 1 then
      v_cambios := v_cambios || jsonb_build_object('factura', f.id, 'numero', v_num, 'proveedor', f.proveedor, 'total', f.total, 'pagado', v_total_pagado, 'tipo', 'PAGADA');
      v_estado := 'PAGADA';
    elsif v_amb then
      v_manual := v_manual || jsonb_build_object('factura', f.id, 'numero', v_num, 'proveedor', f.proveedor, 'total', f.total, 'pagado', f.pagado + v_pagado);
      continue;
    elsif v_pagado > 0 then
      v_cambios := v_cambios || jsonb_build_object('factura', f.id, 'numero', v_num, 'proveedor', f.proveedor, 'total', f.total, 'pagado', v_total_pagado,
                     'tipo', 'PARCIAL ' || least(100, round(v_total_pagado / f.total * 100)) || '%');
      v_estado := 'PAGADA_PARCIAL';
    else
      continue;
    end if;
    if not p_aplicar then continue; end if;
    -- Vincula cada pago a la factura (sin pasarse del total) y deja la factura como corresponde.
    v_corre := f.pagado;
    for v_i in 1 .. coalesce(array_length(v_ids, 1), 0) loop
      v_aplica := least(v_imps[v_i], f.total - v_corre);
      if v_aplica <= 0 then continue; end if;
      insert into pagos_facturas (pago_id, factura_id, importe) values (v_ids[v_i], f.id, v_aplica) on conflict do nothing;
      insert into pagos_sincronizados (pago_id, factura_id, importe) values (v_ids[v_i], f.id, v_aplica) on conflict do nothing;
      v_corre := v_corre + v_aplica;
    end loop;
    update facturas set pagado = v_corre, estado = case when v_estado = 'PAGADA' and v_corre >= total - 1 then 'PAGADA' else v_estado end::estado_factura,
      fecha_pago = case when v_estado = 'PAGADA' then coalesce(fecha_pago, v_ult) else fecha_pago end, actualizado_en = now()
    where id = f.id;
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Sincronizar facturas pagadas', 'ADMIN', 'FACTURA_PAGADA_SINCRONIZADA', 'FACTURA', f.id::text,
            'Factura ' || v_num || ' ' || f.proveedor || ': pagado $ ' || v_corre || ' de $ ' || f.total || ' según los pagos cargados');
  end loop;
  return jsonb_build_object('aplicado', p_aplicar, 'cambios', v_cambios, 'manual', v_manual);
end $$;

-- ---------------------------------------------------------------- 5. Resultado de la anulación en Xubio

-- Solo el servidor. Marca cómo terminó la anulación por API (HECHA o ERROR) y lo deja en la auditoría. Solo toca lo que está PENDIENTE.
create or replace function resultado_anulacion_xubio(p_tabla text, p_id uuid, p_estado text, p_detalle text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_filas integer; v_entidad text;
begin
  if not es_servidor() then raise exception 'Solo lo puede hacer el servidor'; end if;
  if p_estado not in ('HECHA', 'ERROR') then raise exception 'Estado inválido'; end if;
  if p_tabla = 'pagos' then
    update pagos set anulacion_xubio = p_estado where id = p_id and anulacion_xubio = 'PENDIENTE'; v_entidad := 'PAGO';
  elsif p_tabla = 'asientos' then
    update asientos set anulacion_xubio = p_estado where id = p_id and anulacion_xubio = 'PENDIENTE'; v_entidad := 'ASIENTO';
  elsif p_tabla = 'cheques' then
    update cheques set anulacion_xubio = p_estado where id = p_id and anulacion_xubio = 'PENDIENTE'; v_entidad := 'CHEQUE';
  else raise exception 'Tabla inválida'; end if;
  get diagnostics v_filas = row_count;
  if v_filas = 0 then return false; end if;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values ('Anulación en Xubio', 'ADMIN', case when p_estado = 'HECHA' then 'ANULADO_EN_XUBIO' else 'ANULACION_XUBIO_ERROR' end, v_entidad, p_id::text, left(coalesce(p_detalle, ''), 500));
  return true;
end $$;

-- ---------------------------------------------------------------- Permisos
-- En la base real las funciones nuevas no dan EXECUTE por defecto (0021, 0035): se lo damos a quien corresponde.

-- Las que llama la pantalla (la persona con su sesión) y también el servidor.
revoke execute on function
  guardar_numero_op(uuid, text, boolean),
  registrar_lectura_xubio(text, text, date, numeric, text),
  registrar_lecturas_xubio(text, date, jsonb, text, boolean)
from public, anon;
grant execute on function
  guardar_numero_op(uuid, text, boolean),
  registrar_lectura_xubio(text, text, date, numeric, text),
  registrar_lecturas_xubio(text, date, jsonb, text, boolean)
to authenticated, service_role;

-- Solo el servidor: las tareas programadas de Netlify y las funciones que llaman otras funciones.
revoke execute on function
  numero_op_pendientes(uuid, integer),
  aplicar_numero_op_xubio(uuid, text, text),
  emparejar_cuenta_xubio(text, text),
  guardar_lectura_xubio(text, text, date, numeric, text),
  importar_cobros_xubio(text, jsonb, text),
  numeros_de_facturas(text),
  mismo_proveedor_palabras(text, text),
  sincronizar_facturas_pagadas(uuid, boolean),
  resultado_anulacion_xubio(text, uuid, text, text)
from public, anon, authenticated;
grant execute on function
  numero_op_pendientes(uuid, integer),
  aplicar_numero_op_xubio(uuid, text, text),
  emparejar_cuenta_xubio(text, text),
  guardar_lectura_xubio(text, text, date, numeric, text),
  importar_cobros_xubio(text, jsonb, text),
  numeros_de_facturas(text),
  mismo_proveedor_palabras(text, text),
  sincronizar_facturas_pagadas(uuid, boolean),
  resultado_anulacion_xubio(text, uuid, text, text)
to service_role;
