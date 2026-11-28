-- 0040 · FCI y saldos (Tanda 9 de PARIDAD_COMPLETA.md, secciones 6 y 7, 27/11/2026).
--
-- Copia del Apps Script (ConciliacionBancaria.js y ConectorFlujoV2.js):
--   1. Aviso "fondo sin movimientos del banco" (cbxRendimientos_): vista avisos_fci.
--   2. Intereses de la remunerada de Brubank ("INTERESES PAGADOS"): regla del extracto (rendimiento, al asiento),
--      función para clasificar los que ya estaban sin clasificar y rendimientos_fci_dia() con el detalle del día.
--   3. Segundo asiento del día cuando el primero ya subió a Xubio (cbxContabilizarAsiento, "asiento aparte"):
--      tipo BANCARIO_COMPLEMENTO, generar_asiento_complemento() y generar_asiento_del_dia() (elige solo).
--   4. Arrastre de saldo hasta el día hábil anterior (arrastrarSaldosPanel_): saldos_arrastrados(), solo lectura.
--   5. Capital del FCI al Flujo (syncFciCapitalVBI_): sincronizar_capital_fci() le pone al movimiento de la cuenta madre
--      su fondo como contraparte (y la suelta si el fondo ya trae su pata); la conciliación del fondo y el Flujo (que no cambia) la leen.
--   6. Mercado Pago por API: no toca la base. La función de Netlify (mercadopago-saldos) importa por importar_extracto();
--      acá solo se agrega la regla de las reservas ("reserve_for_payment"), que se anulan entre sí.
--
-- Nada de esta migración cambia flujo_lineas_entre. Re-ejecutable.

-- ---------------------------------------------------------------- Reglas del extracto (una vez por organización)

-- Una regla puede valer solo para una clase de cuenta y/o un banco (null = cualquiera). Los intereses pagados son solo de la
-- remunerada de Brubank (el Apps Script lo hacía para "BRUBANK REMUNERADA"); en una caja de ahorro común no son rendimiento de un fondo.
alter table reglas_extracto add column if not exists solo_clase text;
alter table reglas_extracto add column if not exists solo_banco text;

-- Igual que 0024, con las dos condiciones nuevas.
create or replace function regla_para_movimiento(p_cuenta uuid, p_descripcion text, p_importe numeric)
returns reglas_extracto language sql stable security definer set search_path = public as $$
  select r.* from reglas_extracto r
  join cuentas_origen c on c.id = p_cuenta
  join empresas e on e.id = c.empresa_id
  where r.activa and r.organizacion_id = e.organizacion_id
    and (r.empresa_id is null or r.empresa_id = c.empresa_id)
    and (r.cuenta_origen_id is null or r.cuenta_origen_id = c.id)
    and (r.solo_clase is null or r.solo_clase = c.clase)
    and (r.solo_banco is null or upper(r.solo_banco) = upper(coalesce(c.banco, '')))
    and (r.sentido = 'AMBOS' or (r.sentido = 'DEBITO' and p_importe < 0) or (r.sentido = 'CREDITO' and p_importe > 0))
    and exists (select 1 from unnest(r.patrones) x where position(texto_banco(x) in texto_banco(p_descripcion)) > 0)
  order by r.orden, (r.cuenta_origen_id is null), (r.empresa_id is null)
  limit 1
$$;

--   55  INTERESES PAGADOS (crédito, solo remunerada de Brubank) -> rendimiento, al asiento del día (Debe banco / Haber Rendimientos FCI)
--   85  MP RESERVA PARA PAGO -> informativo (queda por si una reserva entra a mano; la función de Mercado Pago ya no las carga)
insert into reglas_extracto (organizacion_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota, solo_clase, solo_banco)
select o.id, r.orden, r.patrones, r.sentido, r.categoria, r.cuenta, r.destino, null, r.nota, r.clase, r.banco
from organizaciones o cross join (values
  (55, array['INTERESES PAGADOS'], 'CREDITO', 'FCI_RENDIMIENTO', 'Rendimientos FCI', 'ASIENTO',
       'Intereses de la cuenta remunerada de Brubank (Apps Script: INTERES_REMUNERADA)', 'REMUNERADA', 'BRUBANK'),
  (85, array['MP RESERVA PARA PAGO'], 'AMBOS', 'INFORMATIVO', null, 'NINGUNO',
       'Mercado Pago: reserva para un pago; se anula con su liberación', null, null)
) as r(orden, patrones, sentido, categoria, cuenta, destino, nota, clase, banco)
where o.es_proveedor
  and not exists (select 1 from reglas_extracto x where x.organizacion_id = o.id and x.orden = r.orden and x.patrones = r.patrones);
-- Si la regla 55 ya estaba (migración anterior de esta misma tanda), se acota.
update reglas_extracto set solo_clase = 'REMUNERADA', solo_banco = 'BRUBANK'
where orden = 55 and patrones = array['INTERESES PAGADOS'] and (solo_clase is distinct from 'REMUNERADA' or solo_banco is distinct from 'BRUBANK');

-- ---------------------------------------------------------------- 3. Asientos: el complemento del día

alter table asientos drop constraint if exists asientos_tipo_check;
alter table asientos add constraint asientos_tipo_check
  check (tipo in ('BANCARIO_DIARIO', 'TRANSFERENCIA_PROPIA', 'AJUSTE', 'BANCARIO_COMPLEMENTO'));

-- Nunca dos complementos pendientes del mismo banco y día (el que no subió se rehace, no se suma otro).
create unique index if not exists asientos_un_complemento_pendiente on asientos (cuenta_origen_id, fecha)
  where tipo = 'BANCARIO_COMPLEMENTO' and anulado_en is null and estado_xubio <> 'SUBIDA';

-- El asiento del día (0034) con un cambio: solo arma con movimientos que no están ya en otro asiento vigente (un complemento).
-- Antes, rehacer el del día (por ejemplo después de anularlo) volvía a incluir lo que el complemento ya subió: doble asiento en Xubio.
-- Y un candado por banco y día, el mismo del complemento, para que dos llamadas a la vez no armen dos asientos.
create or replace function generar_asiento_bancario(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen; a asientos; v_id uuid; v_cuenta_banco text; v_usuario text; v_nuevos boolean;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if es_servidor() then v_usuario := 'servidor'; else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN')).email; end if;
  perform pg_advisory_xact_lock(hashtext('asiento:' || p_cuenta::text || ':' || p_fecha::text));
  -- (0034) comisiones del día sin IVA ni percepciones: van al asiento; si algo cambió, el comprobante se rehace.
  if ajustar_comisiones_sin_iva(p_cuenta, p_fecha) then perform generar_comprobante_gastos(p_cuenta, p_fecha); end if;
  select nombre into v_cuenta_banco from cuentas_contables where id = c.cuenta_contable_id;
  if v_cuenta_banco is null then raise exception 'La cuenta % no tiene su cuenta contable de Xubio', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
             and destino_xubio = 'ASIENTO' and cuenta_contable is null and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos del asiento sin cuenta contable: clasificalos primero';
  end if;
  select * into a from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
    and anulado_en is null for update;
  select exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO') into v_nuevos;
  -- Sin asiento vigente y sin movimientos para asentar: no hay nada que hacer.
  if a.id is null and not v_nuevos then return null; end if;
  if a.id is not null then
    -- Uno que se está enviando (o quedó "sin confirmar") no se toca: en Xubio puede estar creado.
    if a.envio_xubio_en is not null then
      raise exception 'El asiento de ese día se está enviando a Xubio: esperá el resultado';
    end if;
    if a.estado_xubio = 'SUBIDA' then
      if not v_nuevos then return null; end if;
      raise exception 'El asiento de ese día ya está en Xubio: anulalo para rehacerlo';
    end if;
    -- Vigente y sin subir (pendiente o con error): se rehace entero. Primero se sueltan sus movimientos.
    update movimientos_bancarios set asiento_id = null where asiento_id = a.id;
    delete from asientos where id = a.id;
  end if;
  if not exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO') then
    return null;   -- se reclasificó todo: el asiento viejo se fue y no hay uno nuevo
  end if;
  insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por)
  values (c.empresa_id, p_cuenta, p_fecha, 'BANCARIO_DIARIO', 'Movimientos del extracto ' || c.nombre || ' ' || to_char(p_fecha, 'DD/MM/YYYY'), v_usuario)
  returning id into v_id;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, m.cuenta_contable, greatest(-sum(m.importe), 0), greatest(sum(m.importe), 0), string_agg(distinct m.categoria, ', ')
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.asiento_id is null and m.estado <> 'IGNORADO'
  group by m.cuenta_contable having sum(m.importe) <> 0;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, v_cuenta_banco, greatest(sum(m.importe), 0), greatest(-sum(m.importe), 0), 'Banco'
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.asiento_id is null and m.estado <> 'IGNORADO'
  having sum(m.importe) <> 0;
  update movimientos_bancarios set asiento_id = v_id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO';
  return v_id;
end $$;

-- Lo que quedó sin asentar del día cuando el asiento del día ya está en Xubio (impuestos que llegaron tarde,
-- capital de un FCI). Mismo armado que el asiento del día: cada cuenta, neta, contra el banco. Va por el mismo camino
-- que los demás asientos (asientos + asiento_lineas, estado_xubio PENDIENTE): lo sube el envío bancario, en seco o real.
-- Candado por banco y día (advisory + el asiento del día "for update") y el índice único de arriba: dos llamadas a la vez no duplican.
create or replace function generar_asiento_complemento(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen; ya asientos; pend asientos; v_id uuid; v_cuenta_banco text; v_usuario text;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if es_servidor() then v_usuario := 'servidor'; else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN')).email; end if;
  perform pg_advisory_xact_lock(hashtext('asiento:' || p_cuenta::text || ':' || p_fecha::text));
  select * into ya from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
    and anulado_en is null and estado_xubio = 'SUBIDA' for update;
  if ya.id is null then
    raise exception 'El asiento de ese día todavía no está en Xubio: usá el asiento del día (no hace falta uno complementario)';
  end if;
  select nombre into v_cuenta_banco from cuentas_contables where id = c.cuenta_contable_id;
  if v_cuenta_banco is null then raise exception 'La cuenta % no tiene su cuenta contable de Xubio', c.nombre; end if;
  -- Un complemento que todavía no subió se rehace entero con lo que haya; uno que se está enviando no se toca.
  select * into pend from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_COMPLEMENTO'
    and anulado_en is null and estado_xubio <> 'SUBIDA' for update;
  if pend.id is not null then
    if pend.envio_xubio_en is not null then
      raise exception 'El asiento complementario de ese día se está enviando a Xubio: esperá el resultado';
    end if;
    update movimientos_bancarios set asiento_id = null where asiento_id = pend.id;
    delete from asientos where id = pend.id;
  end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO'
             and asiento_id is null and cuenta_contable is null and estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO')) then
    raise exception 'Hay movimientos del asiento sin cuenta contable: clasificalos primero';
  end if;
  if not exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO'
                 and asiento_id is null and estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO')) then
    return null;
  end if;
  insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por)
  values (c.empresa_id, p_cuenta, p_fecha, 'BANCARIO_COMPLEMENTO',
          'Complemento del extracto ' || c.nombre || ' ' || to_char(p_fecha, 'DD/MM/YYYY') || ' · ' || to_char(now() at time zone 'America/Argentina/Buenos_Aires', 'HH24MI'),
          v_usuario)
  returning id into v_id;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, m.cuenta_contable, greatest(-sum(m.importe), 0), greatest(sum(m.importe), 0), string_agg(distinct m.categoria, ', ')
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.asiento_id is null
    and m.estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO')
  group by m.cuenta_contable having sum(m.importe) <> 0;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, v_cuenta_banco, greatest(sum(m.importe), 0), greatest(-sum(m.importe), 0), 'Banco'
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.asiento_id is null
    and m.estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO')
  having sum(m.importe) <> 0;
  update movimientos_bancarios set asiento_id = v_id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO' and asiento_id is null
    and estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO');
  return v_id;
end $$;

-- El botón "Asiento del día": si el del día ya está en Xubio y hay movimientos nuevos (o un complemento sin subir para rehacer),
-- hace el complemento; si no, el asiento del día de siempre.
create or replace function generar_asiento_del_dia(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if not es_servidor() then perform exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); end if;
  if exists (select 1 from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
             and anulado_en is null and estado_xubio = 'SUBIDA')
     and (exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO'
                  and asiento_id is null and estado not in ('IGNORADO', 'CONTABILIZADO', 'CARGADO_A_MANO'))
          or exists (select 1 from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_COMPLEMENTO'
                     and anulado_en is null and estado_xubio <> 'SUBIDA')) then
    return generar_asiento_complemento(p_cuenta, p_fecha);
  end if;
  return generar_asiento_bancario(p_cuenta, p_fecha);
end $$;

-- ---------------------------------------------------------------- 2. Intereses de la remunerada ya cargados

-- Los "INTERESES PAGADOS" que entraron antes de la regla quedaron "A revisar": los pasa a rendimiento (al asiento del día)
-- con la regla de la organización, igual que si hubieran entrado ahora. No toca lo ya contabilizado ni lo que está en un asiento.
-- Devuelve cuántos clasificó.
create or replace function clasificar_intereses_remunerada(p_empresa text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare u usuarios; m record; r reglas_extracto; n int := 0; v_quien text;
begin
  if es_servidor() then v_quien := 'servidor';
  else u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); v_quien := u.email; end if;
  if p_empresa is not null then perform exigir_empresa(p_empresa); end if;
  for m in
    select mv.id, mv.cuenta_origen_id, mv.descripcion, mv.importe
    from movimientos_bancarios mv join cuentas_origen c on c.id = mv.cuenta_origen_id
    where c.clase = 'REMUNERADA' and mv.importe > 0 and mv.estado = 'A_REVISAR' and mv.categoria = 'SIN_CLASIFICAR' and mv.asiento_id is null
      and texto_banco(mv.descripcion) like '%INTERESES PAGADOS%'
      and (p_empresa is null or mv.empresa_id = p_empresa)
      and (es_servidor() or mv.empresa_id in (select empresas_visibles()))
  loop
    r := regla_para_movimiento(m.cuenta_origen_id, m.descripcion, m.importe);
    if r.id is not null and r.categoria = 'FCI_RENDIMIENTO' then
      update movimientos_bancarios set categoria = r.categoria, cuenta_contable = r.cuenta_contable, regla_id = r.id,
        destino_xubio = r.destino_xubio, componente = r.componente, estado = 'PENDIENTE', revisado_por = v_quien, revisado_en = now()
      where id = m.id;
      n := n + 1;
    end if;
  end loop;
  if u.email is not null and n > 0 then
    perform registrar_auditoria(u, 'INTERESES_REMUNERADA', 'EMPRESA', coalesce(p_empresa, 'todas'), n || ' movimientos clasificados como rendimiento');
  end if;
  return n;
end $$;

-- ---------------------------------------------------------------- 1. Aviso: fondo sin movimientos del banco

-- Un FCI con tenencia un día hábil en que su cuenta madre no tiene movimientos ni extracto ni "sin movimientos":
-- si hubo un rescate o una suscripción, el rendimiento de ese día sale mal. Los últimos 30 días corridos (solo días hábiles).
-- Solo FCI, como el Apps Script (la remunerada de Brubank no avisa).
create or replace view avisos_fci with (security_invoker = true) as
select f.empresa_id, f.id as cuenta_origen_id, f.nombre as cuenta, m.id as madre_id, m.nombre as madre, s.fecha,
       'No hay movimientos de ' || m.nombre || ' el ' || to_char(s.fecha, 'DD/MM/YYYY')
         || ': si hubo rescate o suscripción, subí antes el extracto del banco' as detalle
from cuentas_origen f
join cuentas_origen m on m.id = f.cuenta_madre_id
join saldos_bancarios s on s.cuenta_origen_id = f.id and s.origen in ('TENENCIA', 'EXTRACTO')
where f.activa and f.clase = 'FCI'
  and s.fecha >= hoy_ar() - 30 and s.fecha <= hoy_ar() and es_dia_habil(s.fecha)
  and not exists (select 1 from movimientos_bancarios x where x.cuenta_origen_id = m.id and x.fecha = s.fecha and x.estado <> 'IGNORADO')
  and not exists (select 1 from saldos_bancarios y where y.cuenta_origen_id = m.id and y.fecha = s.fecha and y.origen in ('EXTRACTO', 'SIN_MOVIMIENTOS'));

-- El rendimiento de un día con su detalle (cbxRendimientos_). En un fondo: saldo - anterior + rescates - suscripciones (una
-- suscripción entra como crédito y un rescate como débito de la cuenta del fondo). En una remunerada con "intereses pagados"
-- informados por el banco, el importe son esos intereses (como el Apps Script). aviso = ver avisos_fci.
create or replace function rendimientos_fci_dia(p_fecha date, p_cuenta uuid default null)
returns table (empresa_id text, cuenta_origen_id uuid, cuenta text, clase text, fecha date, importe numeric, detalle text, aviso boolean)
language sql stable set search_path = public as $$
  select cb.empresa_id, cb.cuenta_origen_id, cb.cuenta, cb.clase, cb.fecha,
         case when cb.clase = 'REMUNERADA' and i.t is not null then i.t else coalesce(cb.rendimiento, 0) end,
         case
           when cb.clase = 'REMUNERADA' and i.t is not null then 'Intereses pagados informados por el banco ' || to_char(i.t, 'FM999999999990.00')
           when cb.saldo_extracto is null then 'Falta la tenencia del ' || to_char(cb.fecha, 'DD/MM/YYYY')
           when cb.saldo_anterior is null then 'Falta el saldo del día anterior'
           else 'Saldo ' || to_char(cb.saldo_extracto, 'FM999999999990.00') || ' - anterior ' || to_char(cb.saldo_anterior, 'FM999999999990.00')
                || ' + rescates ' || to_char(cb.debitos, 'FM999999999990.00') || ' - suscripciones ' || to_char(cb.creditos, 'FM999999999990.00')
         end,
         exists (select 1 from avisos_fci a where a.cuenta_origen_id = cb.cuenta_origen_id and a.fecha = cb.fecha)
  from conciliacion_calculo(true) cb
  left join lateral (
    select sum(mv.importe) as t from movimientos_bancarios mv
    where mv.cuenta_origen_id = cb.cuenta_origen_id and mv.fecha = cb.fecha and mv.estado <> 'IGNORADO'
      and mv.categoria = 'FCI_RENDIMIENTO' and mv.importe > 0
  ) i on true
  where cb.fecha = p_fecha and (p_cuenta is null or cb.cuenta_origen_id = p_cuenta)
$$;

-- ---------------------------------------------------------------- 5. Capital del FCI: contraparte en la cuenta madre

-- En la conciliación del fondo (y en el Flujo, por la otra pata del movimiento) la suscripción o el rescate se descuenta
-- del rendimiento solo si el movimiento de la cuenta madre dice cuál es su fondo. conciliar_movimientos (0030) lo hace cuando el
-- movimiento viene como FCI. Acá se completan:
--   · los de categoría FCI que quedaron sin fondo (como el Apps Script: CATEGORIA = FCI; nunca por el texto "SUSC" o "RESC" solo);
--   · la transferencia a la remunerada de Brubank (el texto dice REMUNERADA; el Apps Script no pedía categoría).
-- Solo con UN fondo en la cuenta madre y sin la pata propia ya cargada en el fondo. Con varios fondos elige Tesorería
-- (asignar_contraparte, 0031): se cuentan como "dudosos".
-- Y al revés: si después llegó la pata propia (el extracto del fondo o de la remunerada), la contraparte de la cuenta madre se suelta
-- (se empareja con la que existe en vez de sumar dos veces).
-- Mira los últimos 60 días (o desde p_desde). Devuelve {asignados, soltados, dudosos}.
create or replace function sincronizar_capital_fci(p_empresa text default null, p_desde date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; v_asignados int := 0; v_soltados int := 0; v_dudosos int := 0; v_desde date := coalesce(p_desde, hoy_ar() - 60);
begin
  if not es_servidor() then u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); end if;
  if p_empresa is not null then perform exigir_empresa(p_empresa); end if;
  -- Primero se sueltan las contrapartes que ya tienen su pata propia en el fondo.
  with s as (
    update movimientos_bancarios m set contraparte_cuenta_id = null
    where m.contraparte_cuenta_id is not null and m.estado <> 'IGNORADO' and m.fecha >= v_desde
      and (p_empresa is null or m.empresa_id = p_empresa)
      and (es_servidor() or m.empresa_id in (select empresas_visibles()))
      and exists (select 1 from cuentas_origen f where f.id = m.contraparte_cuenta_id and f.clase in ('FCI', 'REMUNERADA') and f.cuenta_madre_id = m.cuenta_origen_id)
      and exists (select 1 from movimientos_bancarios o where o.cuenta_origen_id = m.contraparte_cuenta_id and o.fecha = m.fecha
                  and o.importe = -m.importe and o.estado <> 'IGNORADO')
    returning m.id
  )
  select count(*) into v_soltados from s;
  with h as (
    select m.id as mov_id, f.id as fondo_id
    from movimientos_bancarios m
    join cuentas_origen f on f.cuenta_madre_id = m.cuenta_origen_id and f.activa and f.clase in ('FCI', 'REMUNERADA')
    where m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO' and m.importe <> 0 and m.fecha >= v_desde
      and (p_empresa is null or m.empresa_id = p_empresa)
      and (es_servidor() or m.empresa_id in (select empresas_visibles()))
      and (select count(*) from cuentas_origen f2 where f2.cuenta_madre_id = m.cuenta_origen_id and f2.activa and f2.clase in ('FCI', 'REMUNERADA')) = 1
      and (m.categoria = 'FCI'
           or (f.clase = 'REMUNERADA' and texto_banco(m.descripcion) like '%REMUNERADA%'))
      and not exists (select 1 from movimientos_bancarios o where o.cuenta_origen_id = f.id and o.fecha = m.fecha and o.importe = -m.importe
                      and o.estado <> 'IGNORADO')
  ), hecho as (
    update movimientos_bancarios m set contraparte_cuenta_id = h.fondo_id from h where m.id = h.mov_id returning m.id
  )
  select count(*) into v_asignados from hecho;
  select count(*) into v_dudosos
  from movimientos_bancarios m
  where m.categoria = 'FCI' and m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO' and m.fecha >= v_desde
    and (p_empresa is null or m.empresa_id = p_empresa)
    and (es_servidor() or m.empresa_id in (select empresas_visibles()))
    and (select count(*) from cuentas_origen f where f.cuenta_madre_id = m.cuenta_origen_id and f.activa and f.clase in ('FCI', 'REMUNERADA')) > 1;
  if u.email is not null and (v_asignados > 0 or v_soltados > 0) then
    perform registrar_auditoria(u, 'FCI_CAPITAL', 'EMPRESA', coalesce(p_empresa, 'todas'),
                                v_asignados || ' movimientos con su fondo como contraparte, ' || v_soltados || ' soltados (el fondo ya tiene su pata)');
  end if;
  return jsonb_build_object('asignados', v_asignados, 'soltados', v_soltados, 'dudosos', v_dudosos);
end $$;

-- ---------------------------------------------------------------- 4. Arrastre de saldo hasta el día hábil anterior

-- Por cuenta y día hábil: el saldo del día si lo hay; si no, el anterior repetido, solo en días SIN movimientos y
-- (a) entre dos saldos o (b) después del último saldo, hasta el día anterior a la fecha en que se subió el último extracto
-- (arrastrarSaldosPanel_: hasta min(hoy, fecha de subida)), y nunca más allá del día hábil anterior a hoy (hoy_ar()):
-- un día que no cerró no se arrastra. No escribe nada (no cambia el Flujo ni los controles): quien lo necesita lo lee.
-- Como mucho 400 días hacia atrás.
create or replace function saldos_arrastrados(p_desde date, p_hasta date default null, p_empresa text default null)
returns table (empresa_id text, cuenta_origen_id uuid, cuenta text, fecha date, saldo numeric, arrastrado boolean, saldo_de date, rinde_diario boolean)
language sql stable set search_path = public as $$
  with tope as (
    select least(coalesce(p_hasta, hoy_ar() - 1), hoy_ar() - 1) as h
  ), dias as (
    select d::date as fecha
    from tope, generate_series(greatest(p_desde, tope.h - 400), tope.h, interval '1 day') d
    where es_dia_habil(d::date)
  ), ctas as (
    select c.id, c.empresa_id, c.nombre, c.rinde_diario,
           -- hasta dónde llega lo subido: el día anterior a la subida del último extracto
           (select max((e.importado_en at time zone 'America/Argentina/Buenos_Aires')::date) - 1 from extractos e where e.cuenta_origen_id = c.id) as cubierto_hasta
    from cuentas_origen c
    where c.activa and (p_empresa is null or c.empresa_id = p_empresa)
  ), x as (
    select c.*, d.fecha, s.saldo as propio, p.saldo as prev_saldo, p.fecha as prev_fecha,
           exists (select 1 from movimientos_bancarios m
                   where (m.cuenta_origen_id = c.id or m.contraparte_cuenta_id = c.id) and m.fecha = d.fecha and m.estado <> 'IGNORADO') as con_mov,
           exists (select 1 from saldos_bancarios n where n.cuenta_origen_id = c.id and n.fecha > d.fecha) as hay_siguiente
    from ctas c
    cross join dias d
    left join saldos_bancarios s on s.cuenta_origen_id = c.id and s.fecha = d.fecha
    left join lateral (
      select a.saldo, a.fecha from saldos_bancarios a where a.cuenta_origen_id = c.id and a.fecha < d.fecha order by a.fecha desc limit 1
    ) p on true
  )
  select x.empresa_id, x.id, x.nombre, x.fecha, coalesce(x.propio, x.prev_saldo), x.propio is null,
         case when x.propio is null then x.prev_fecha end, x.rinde_diario
  from x
  where x.propio is not null
     or (x.prev_saldo is not null and not x.con_mov and (x.hay_siguiente or x.fecha <= x.cubierto_hasta))
  order by x.nombre, x.fecha
$$;

-- ---------------------------------------------------------------- Pata propia del fondo: se empareja, no se suma

-- Cuando entra un movimiento a un FCI o una remunerada (su extracto o informe) y la cuenta madre ya tenía el movimiento espejo con ese
-- fondo como contraparte, la contraparte se suelta: el fondo ya tiene su pata y contarla dos veces inflaría los créditos y el Flujo.
create or replace function soltar_contraparte_con_pata_propia()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'IGNORADO' or new.importe = 0 then return new; end if;
  update movimientos_bancarios m set contraparte_cuenta_id = null
  from cuentas_origen f
  where f.id = new.cuenta_origen_id and f.clase in ('FCI', 'REMUNERADA') and f.cuenta_madre_id is not null
    and m.cuenta_origen_id = f.cuenta_madre_id and m.contraparte_cuenta_id = f.id and m.fecha = new.fecha and m.importe = -new.importe
    and m.estado <> 'IGNORADO';
  return new;
end $$;
drop trigger if exists trg_soltar_contraparte_con_pata_propia on movimientos_bancarios;
create trigger trg_soltar_contraparte_con_pata_propia after insert on movimientos_bancarios
  for each row execute function soltar_contraparte_con_pata_propia();
revoke execute on function soltar_contraparte_con_pata_propia() from public, anon, authenticated;

-- ---------------------------------------------------------------- Reglas de la cuenta de Mercado Pago (banco MP)

-- El Apps Script separaba lo de Mercado Pago en PROPIA (ingreso: plata que entra a la billetera) y PAGO (lo que sale).
--   86  "MP INGRESO ..."  (crédito) -> entre cuentas propias
--   87  "MP ..." (débito)           -> pago
-- Solo en cuentas con banco MP (por eso "MP " no se confunde con "IMP LEY" de otros bancos). Comisión e impuestos van dentro del neto.
insert into reglas_extracto (organizacion_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota, solo_banco)
select o.id, r.orden, r.patrones, r.sentido, r.categoria, null, 'NINGUNO', null, r.nota, 'MP'
from organizaciones o cross join (values
  (86, array['MP INGRESO'], 'CREDITO', 'TRANSFERENCIA_PROPIA', 'Mercado Pago: ingreso a la billetera (PROPIA en el Apps Script)'),
  (87, array['MP '], 'DEBITO', 'PAGO', 'Mercado Pago: egreso (PAGO en el Apps Script)')
) as r(orden, patrones, sentido, categoria, nota)
where o.es_proveedor
  and not exists (select 1 from reglas_extracto x where x.organizacion_id = o.id and x.orden = r.orden and x.patrones = r.patrones);

-- ---------------------------------------------------------------- Seguridad

revoke all on avisos_fci from public, anon, authenticated;
grant select on avisos_fci to authenticated;
grant all on avisos_fci to service_role;

-- Los usan las personas desde la pantalla (con su rol) y el servidor.
revoke execute on function
  generar_asiento_bancario(uuid, date), generar_asiento_complemento(uuid, date), generar_asiento_del_dia(uuid, date),
  clasificar_intereses_remunerada(text), rendimientos_fci_dia(date, uuid),
  sincronizar_capital_fci(text, date), saldos_arrastrados(date, date, text)
from public, anon;
grant execute on function
  generar_asiento_bancario(uuid, date), generar_asiento_complemento(uuid, date), generar_asiento_del_dia(uuid, date),
  clasificar_intereses_remunerada(text), rendimientos_fci_dia(date, uuid),
  sincronizar_capital_fci(text, date), saldos_arrastrados(date, date, text)
to authenticated, service_role;
