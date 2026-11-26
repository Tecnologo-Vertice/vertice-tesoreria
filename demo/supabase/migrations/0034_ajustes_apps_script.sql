-- Ajustes de las decisiones tomadas sobre lo que hace el Apps Script del 26/11/2026 (T-210).
--
-- No cambia migraciones anteriores: redefine lo que hace falta.
--
--   1. SIRCREB / IIBB bancario va al ASIENTO del día, no al comprobante "Extracto Bancario" (cbxEsAsiento_ de
--      ConciliacionBancaria.js). También al asiento: SELLOS y "COBRO COM VALORES" (comisión sin IVA, Brubank) por reglas
--      nuevas, y las comisiones de un día en que el banco no cobró IVA ni percepciones (cbxSinIva_), que se deciden
--      al generar el comprobante / el asiento (ajustar_comisiones_sin_iva). Una percepción de IIBB (dice PERCEP) sigue
--      en el comprobante. Las filas que ya estaban cargadas y no se enviaron a Xubio se pasan al asiento.
--   2. Flujo (flujo_lineas_entre): los pagos REALES entran solo si están en Xubio y no son de caja (filtro del motor,
--      ConectorFlujoV2.js). Si el pago no entra pero su débito está vinculado, el débito cuenta como movimiento: la plata
--      que salió del banco no desaparece y el control contra bancos cierra.
--   3. marcar_sin_movimientos: solo días ya cerrados (anteriores a hoy_ar()).
--   4. Doble conteo: una factura proyectada que el extracto ya muestra pagada (un débito sin documento, mismo importe,
--      de 30 días antes a 3 después de su fecha) deja de proyectarse si la pareja es única (paso "REAL (extracto)" del motor).
--   5. Feriados: los de la lista del Apps Script (FlujoCaja.js).
--   (La cuenta bancaria del comprobante "Extracto Bancario" para Xubio es de las funciones de Netlify, no de la base.)

-- ---------------------------------------------------------------- 1. Reglas del extracto

-- IIBB Tucumán y SIRCREB/IIBB: al asiento (la cuenta contable no cambia).
update reglas_extracto
set destino_xubio = 'ASIENTO', componente = null, nota = nota || ' · al asiento del día (26/11/2026)'
where orden in (15, 20) and empresa_id is null and cuenta_origen_id is null
  and destino_xubio = 'COMPROBANTE' and componente = 'PERCEPCION_IIBB' and cuenta_contable = 'RETENCIÓN BANCARIA IIBB (SIRCREB)';

-- Reglas nuevas (una vez por organización):
--   8  SELLOS            -> asiento, gastos bancarios
--   9  COBRO COM VALORES -> asiento, gastos bancarios (comisión sin IVA)
--   12 Percepción de IIBB (el banco la informa como PERCEPCION) -> sigue en el comprobante
insert into reglas_extracto (organizacion_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota)
select o.id, r.orden, r.patrones, 'AMBOS', r.categoria, r.cuenta, r.destino, r.componente, r.nota
from organizaciones o cross join (values
  (8,  array['SELLO'], 'GASTO_BANCARIO', 'GASTOS BANCARIOS', 'ASIENTO', null, 'Sellos: al asiento (Apps Script 26/11/2026)'),
  (9,  array['COBRO COM VALORES'], 'GASTO_BANCARIO', 'GASTOS BANCARIOS', 'ASIENTO', null, 'Comisión sin IVA: al asiento (Apps Script 26/11/2026)'),
  (12, array['PERCEPCION IIBB','PERC. IIBB','PERC IIBB','PERCEP. IIBB','PERCEPCION ING','PERC. ING','PERCEPCION INGRESOS BRUTOS','PERCEPCION BRUTOS'],
       'IMPUESTO', 'RETENCIÓN BANCARIA IIBB (SIRCREB)', 'COMPROBANTE', 'PERCEPCION_IIBB', 'Percepción IIBB informada por el banco: va en el comprobante')
) as r(orden, patrones, categoria, cuenta, destino, componente, nota)
where o.es_proveedor
  and not exists (select 1 from reglas_extracto x where x.organizacion_id = o.id and x.orden = r.orden and x.patrones = r.patrones);

-- Lo ya cargado que sigue sin enviar: SIRCREB/IIBB al asiento. Si estaba en un comprobante que todavía no subió,
-- sale de él y el comprobante se rehace (más abajo).
do $$
declare x record;
begin
  for x in
    select m.cuenta_origen_id as cuenta, m.fecha, bool_or(m.factura_id is not null) as con_comprobante, array_agg(m.id) as ids
    from movimientos_bancarios m
    join reglas_extracto r on r.id = m.regla_id and r.orden in (15, 20) and r.destino_xubio = 'ASIENTO'
    where m.destino_xubio = 'COMPROBANTE' and m.componente = 'PERCEPCION_IIBB' and m.estado in ('PENDIENTE', 'A_REVISAR')
      and (m.factura_id is null
           or exists (select 1 from facturas f where f.id = m.factura_id and f.estado_xubio <> 'SUBIDA' and f.xubio_envio_en is null))
    group by m.cuenta_origen_id, m.fecha
  loop
    update movimientos_bancarios set destino_xubio = 'ASIENTO', componente = null, factura_id = null where id = any(x.ids);
    if x.con_comprobante then
      begin
        perform generar_comprobante_gastos(x.cuenta, x.fecha);
      exception when others then
        raise notice 'No se pudo rehacer el comprobante de % %: %', x.cuenta, x.fecha, sqlerrm;
      end;
    end if;
  end loop;
end $$;

-- Comisiones de un día sin IVA ni percepciones (cbxSinIva_): van al asiento. La marca sin_iva_auto permite
-- devolverlas al comprobante si después llega el IVA de ese día.
alter table movimientos_bancarios add column sin_iva_auto boolean not null default false;

create or replace function ajustar_comisiones_sin_iva(p_cuenta uuid, p_fecha date)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_con_iva boolean; v_cambio boolean := false; r record;
begin
  -- ¿Ese día el banco cobró IVA o percepciones (dentro del comprobante)?
  select exists (select 1 from movimientos_bancarios
                 where cuenta_origen_id = p_cuenta and fecha = p_fecha and estado <> 'IGNORADO' and destino_xubio = 'COMPROBANTE'
                   and componente in ('IVA', 'PERCEPCION_IVA', 'PERCEPCION_IIBB')) into v_con_iva;
  if not v_con_iva then
    -- Comisiones por regla (no las reclasificadas a mano) que todavía no están en un documento enviado.
    for r in
      select m.id, m.factura_id from movimientos_bancarios m
      where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.estado in ('PENDIENTE', 'A_REVISAR')
        and m.destino_xubio = 'COMPROBANTE' and m.componente = 'NETO' and m.categoria = 'GASTO_BANCARIO'
        and exists (select 1 from reglas_extracto g where g.id = m.regla_id and g.destino_xubio = 'COMPROBANTE' and g.componente = 'NETO')
        and (m.factura_id is null or exists (select 1 from facturas f where f.id = m.factura_id and f.estado_xubio <> 'SUBIDA' and f.xubio_envio_en is null))
    loop
      update movimientos_bancarios set destino_xubio = 'ASIENTO', sin_iva_auto = true, factura_id = null,
        cuenta_contable = coalesce(cuenta_contable, 'GASTOS BANCARIOS')
      where id = r.id;
      v_cambio := true;
    end loop;
  else
    -- Llegó el IVA o una percepción: las comisiones que se habían pasado al asiento vuelven al comprobante.
    for r in
      select m.id, m.asiento_id from movimientos_bancarios m
      where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.sin_iva_auto and m.estado in ('PENDIENTE', 'A_REVISAR')
        and (m.asiento_id is null or exists (select 1 from asientos a where a.id = m.asiento_id and a.estado_xubio <> 'SUBIDA' and a.envio_xubio_en is null))
    loop
      if r.asiento_id is not null then
        update movimientos_bancarios set asiento_id = null where asiento_id = r.asiento_id;
        delete from asientos where id = r.asiento_id;
      end if;
      update movimientos_bancarios set destino_xubio = 'COMPROBANTE', sin_iva_auto = false, asiento_id = null where id = r.id;
      v_cambio := true;
    end loop;
  end if;
  return v_cambio;
end $$;
revoke execute on function ajustar_comisiones_sin_iva(uuid, date) from public, anon, authenticated;
grant execute on function ajustar_comisiones_sin_iva(uuid, date) to service_role;

-- Junta en un comprobante "Extracto Bancario" lo facturable del banco en la cuenta y el día (0031 + comisiones sin IVA).
create or replace function generar_comprobante_gastos(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; u usuarios; v_prov uuid; f facturas; otra facturas; v_neto numeric; v_iva numeric; v_perc numeric; v_perc_json jsonb;
  v_numero integer := to_char(p_fecha, 'YYYYMMDD')::integer; v_org uuid; v_pv integer; v_nro text;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if not es_servidor() then u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN'); end if;
  if c.cuit_banco is null then raise exception 'Falta el CUIT del banco en la cuenta %', c.nombre; end if;
  if c.digito_comprobante is null then
    raise exception 'La cuenta % no tiene dígito de comprobante: hay más de 10 cuentas de ese banco en la empresa', c.nombre;
  end if;
  v_pv := 9990 + c.digito_comprobante;
  -- (0034) comisiones del día sin IVA ni percepciones: van al asiento, no al comprobante.
  perform ajustar_comisiones_sin_iva(p_cuenta, p_fecha);

  select coalesce(sum(-importe) filter (where componente = 'NETO'), 0),
         coalesce(sum(-importe) filter (where componente = 'IVA'), 0),
         coalesce(sum(-importe) filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), 0),
         coalesce(jsonb_agg(jsonb_build_object('tipo', componente, 'cuenta', cuenta_contable, 'importe', -importe, 'movimiento', id))
                  filter (where componente in ('PERCEPCION_IVA', 'PERCEPCION_IIBB')), '[]')
  into v_neto, v_iva, v_perc, v_perc_json
  from movimientos_bancarios
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';

  -- El comprobante de ESTA cuenta para ese día (los de antes de 0031 son todos 09990, sea cual sea el dígito).
  select * into f from facturas
  where empresa_id = c.empresa_id and tipo = 'Extracto Bancario' and cuenta_origen_extracto_id = c.id and numero = v_numero
    and punto_venta between 9990 and 9999
  order by (punto_venta = v_pv) desc limit 1 for update;
  v_nro := lpad(coalesce(f.punto_venta, v_pv)::text, 5, '0') || '-' || v_numero;

  if v_neto + v_iva + v_perc = 0 then
    -- Ya no queda nada facturable ese día (se reclasificó): un comprobante sin aprobar ni enviar queda rechazado.
    if f.id is not null and f.estado = 'PENDIENTE_APROBACION' and f.estado_xubio <> 'SUBIDA' and f.xubio_envio_en is null then
      update facturas set estado = 'RECHAZADA', motivo_validacion = 'Sin movimientos facturables: se reclasificaron', actualizado_en = now()
      where id = f.id;
    end if;
    return null;
  end if;
  if f.id is not null and f.estado_xubio = 'SUBIDA' then
    raise exception 'El comprobante % ya está en Xubio: no se regenera', v_nro;
  end if;
  if f.id is not null and f.xubio_envio_en is not null then
    raise exception 'El comprobante % se está enviando a Xubio: esperá el resultado', v_nro;
  end if;

  select organizacion_id into v_org from empresas where id = c.empresa_id;
  insert into proveedores (cuit, nombre, organizacion_id) values (c.cuit_banco, coalesce(c.banco, c.nombre), v_org)
  on conflict (organizacion_id, cuit) do nothing;
  select id into v_prov from proveedores where cuit = c.cuit_banco and organizacion_id = v_org;

  if f.id is null then
    select * into otra from facturas where empresa_id = c.empresa_id and proveedor_id = v_prov and tipo = 'Extracto Bancario'
      and punto_venta = v_pv and numero = v_numero;
    if otra.id is not null then
      raise exception 'El número % ya lo usa un comprobante de otra cuenta (de antes de separar por cuenta): rechazalo o anulalo y volvé a generar', v_nro;
    end if;
    insert into facturas (empresa_id, proveedor_id, tipo, punto_venta, numero, fecha, vencimiento, neto, iva, percepciones,
                          percepciones_json, total, origen, estado, validacion_ok, cuenta_contable, metodo_pago, cuenta_origen_extracto_id)
    values (c.empresa_id, v_prov, 'Extracto Bancario', v_pv, v_numero, p_fecha, p_fecha, v_neto, v_iva, v_perc, v_perc_json,
            v_neto + v_iva + v_perc, 'EXTRACTO', 'PENDIENTE_APROBACION', true, 'GASTOS BANCARIOS', 'DEBITO', c.id)
    returning * into f;
  else
    update facturas set neto = v_neto, iva = v_iva, percepciones = v_perc, percepciones_json = v_perc_json,
      total = v_neto + v_iva + v_perc, estado_xubio = 'PENDIENTE', xubio_error = null, actualizado_en = now()
    where id = f.id returning * into f;
  end if;
  update movimientos_bancarios set factura_id = f.id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'COMPROBANTE' and estado <> 'IGNORADO';
  return f.id;
end $$;

-- Asiento del día (0031 + comisiones sin IVA).
create or replace function generar_asiento_bancario(p_cuenta uuid, p_fecha date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c cuentas_origen; a asientos; v_id uuid; v_cuenta_banco text; v_usuario text; v_nuevos boolean;
begin
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if es_servidor() then v_usuario := 'servidor'; else v_usuario := (exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN')).email; end if;
  -- (0034) comisiones del día sin IVA ni percepciones: van al asiento; si algo cambió, el comprobante se rehace.
  if ajustar_comisiones_sin_iva(p_cuenta, p_fecha) then perform generar_comprobante_gastos(p_cuenta, p_fecha); end if;
  select nombre into v_cuenta_banco from cuentas_contables where id = c.cuenta_contable_id;
  if v_cuenta_banco is null then raise exception 'La cuenta % no tiene su cuenta contable de Xubio', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
             and destino_xubio = 'ASIENTO' and cuenta_contable is null and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos del asiento sin cuenta contable: clasificalos primero';
  end if;
  select exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha
                 and destino_xubio = 'ASIENTO' and asiento_id is null and estado <> 'IGNORADO') into v_nuevos;
  select * into a from asientos where cuenta_origen_id = p_cuenta and fecha = p_fecha and tipo = 'BANCARIO_DIARIO'
    and anulado_en is null for update;
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
                 and destino_xubio = 'ASIENTO' and estado <> 'IGNORADO') then
    return null;   -- se reclasificó todo: el asiento viejo se fue y no hay uno nuevo
  end if;
  insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por)
  values (c.empresa_id, p_cuenta, p_fecha, 'BANCARIO_DIARIO', 'Movimientos del extracto ' || c.nombre || ' ' || to_char(p_fecha, 'DD/MM/YYYY'), v_usuario)
  returning id into v_id;
  -- Cada cuenta, neta: un débito del banco va al debe de la cuenta y al haber del banco.
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, m.cuenta_contable, greatest(-sum(m.importe), 0), greatest(sum(m.importe), 0), string_agg(distinct m.categoria, ', ')
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.estado <> 'IGNORADO'
  group by m.cuenta_contable having sum(m.importe) <> 0;
  insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber, detalle)
  select v_id, v_cuenta_banco, greatest(sum(m.importe), 0), greatest(-sum(m.importe), 0), 'Banco'
  from movimientos_bancarios m
  where m.cuenta_origen_id = p_cuenta and m.fecha = p_fecha and m.destino_xubio = 'ASIENTO' and m.estado <> 'IGNORADO'
  having sum(m.importe) <> 0;
  update movimientos_bancarios set asiento_id = v_id
  where cuenta_origen_id = p_cuenta and fecha = p_fecha and destino_xubio = 'ASIENTO' and estado <> 'IGNORADO';
  return v_id;
end $$;

-- ---------------------------------------------------------------- 3. Sin movimientos: solo días cerrados

create or replace function marcar_sin_movimientos(p_cuenta uuid, p_fecha date, p_confirmo_sin_rendimiento boolean default false)
returns numeric language plpgsql security definer set search_path = public as $$
declare u usuarios; c cuentas_origen; v_saldo numeric; v_desde date;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into c from cuentas_origen where id = p_cuenta;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  -- (0034) Solo un día ya cerrado: el de hoy todavía puede traer movimientos (cbxSinMovimientos del Apps Script).
  if p_fecha >= hoy_ar() then raise exception 'Solo se marca "sin movimientos" un día ya cerrado (anterior a hoy)'; end if;
  if c.rinde_diario and not p_confirmo_sin_rendimiento then
    raise exception '% rinde todos los días: subí el extracto o confirmá que no hubo rendimiento', c.nombre;
  end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and estado <> 'IGNORADO') then
    raise exception 'Ese día tiene movimientos: no se puede marcar sin movimientos';
  end if;
  if exists (select 1 from saldos_bancarios where cuenta_origen_id = p_cuenta and fecha = p_fecha and origen <> 'SIN_MOVIMIENTOS') then
    raise exception 'Ese día ya tiene saldo del banco';
  end if;
  select saldo, fecha into v_saldo, v_desde from saldos_bancarios where cuenta_origen_id = p_cuenta and fecha < p_fecha
  order by fecha desc limit 1;
  if v_saldo is null then raise exception 'No hay un saldo anterior: cargá el saldo de % a mano', c.nombre; end if;
  if exists (select 1 from movimientos_bancarios where cuenta_origen_id = p_cuenta and fecha > v_desde and fecha < p_fecha and estado <> 'IGNORADO') then
    raise exception 'Hay movimientos entre % y % sin saldo de cierre: subí ese extracto primero', v_desde, p_fecha;
  end if;
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
  values (p_cuenta, p_fecha, c.empresa_id, v_saldo, 'SIN_MOVIMIENTOS', u.email)
  on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, cargado_por = excluded.cargado_por, cargado_en = now();
  perform registrar_auditoria(u, 'SIN_MOVIMIENTOS', 'CUENTA', p_cuenta::text, c.nombre || ' ' || p_fecha || ' · saldo ' || v_saldo || ' (de ' || v_desde || ')');
  return v_saldo;
end $$;

-- ---------------------------------------------------------------- 2 y 4. El Flujo: pagos en Xubio y sin doble conteo

create or replace function flujo_lineas_entre(p_desde date default null, p_hasta date default null, p_unidad uuid default null,
                                              p_solo_real boolean default false)
returns table (empresa_id text, unidad_id uuid, fila_id uuid, fila text, seccion text, mueve_caja boolean,
               origen_tipo text, origen_id uuid, ocurrencia text, naturaleza text, fecha date, fecha_calculada date,
               importe numeric, contraparte text, concepto text, vencido boolean, ajustada boolean, editable boolean,
               cuenta_origen_id uuid, afecta_bancos boolean)
language sql stable as $$
with hoy as materialized (
  select hoy_ar() as h, dia_habil_desde(hoy_ar()) as habil
), reglas as materialized (
  select x.id, x.organizacion_id, x.empresa_id, x.prioridad, x.si_origen, x.si_proveedor_id, x.si_cuenta_norm, x.si_cuenta_origen_id,
         x.si_categoria, x.si_texto_norm, x.si_unidad_id, x.unidad_id, x.fila_id, x.excluir, x.creada_en
  from flujo_reglas x
), pfuera as materialized (
  -- (0034) Pagos que NO entran al Flujo como pago: los de caja (efectivo; impactan por la reposición del fondo) y,
  -- desde el corte del 17/11/2026, los que no están en Xubio (estado SUBIDO, YA_EN_XUBIO o CARGADO_A_MANO; los
  -- cargados en el sistema nuevo cuentan cuando están contabilizados con su id de Xubio). Es el filtro del motor
  -- (ConectorFlujoV2.js). Su débito, si el banco ya lo tiene, sigue entrando por la rama de movimientos.
  select p.id as pago_id
  from pagos p
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio::text not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    and (p.medio::text = 'CAJA'
         or (p.fecha > date '2026-11-17'
             and upper(btrim(coalesce(p.estado_xubio_pago, ''))) not in ('SUBIDO', 'YA_EN_XUBIO', 'CARGADO_A_MANO')
             and not (p.estado_xubio_pago is null and p.gestion = 'SISTEMA'
                      and p.estado in ('CONTABILIZADO', 'CONCILIADO') and p.xubio_id is not null)))
), lote_fuera as materialized (
  -- De un débito en lote: cuántos de sus pagos quedan fuera y por cuánto.
  select x.movimiento_id, count(*) as n, count(pf.pago_id) as fuera_n, coalesce(sum(x.importe) filter (where pf.pago_id is not null), 0) as fuera_imp
  from movimientos_pagos x left join pfuera pf on pf.pago_id = x.pago_id
  group by x.movimiento_id
), esp as materialized (
  -- Filas internas de cada unidad ("Sin clasificar", "Entre cuentas propias"): lo que devolvía fila_especial.
  select distinct on (f.unidad_id, f.seccion) f.unidad_id, f.seccion, f.id
  from flujo_filas f where f.tipo = 'INTERNO' and f.seccion in ('SIN_CLASIFICAR', 'ENTRE_CUENTAS')
  order by f.unidad_id, f.seccion, f.orden, f.id
), fcta as materialized (
  select distinct on (f.unidad_id, f.cuenta_norm) f.unidad_id, f.cuenta_norm, f.id
  from flujo_filas f where f.activa and f.tipo = 'CUENTA'
  order by f.unidad_id, f.cuenta_norm, f.orden, f.id
), fape as materialized (
  select f.unidad_id, f.cuenta_norm, f.apertura_norm, f.id, f.orden from flujo_filas f where f.activa and f.tipo = 'APERTURA'
), cob as materialized (
  -- Hasta dónde llegó el extracto de cada cuenta (extracto_cubre de 0030, por conjuntos): hay evidencia del
  -- banco (un movimiento o un saldo que no se cargó a mano) ese día o antes Y ese día o después.
  select c.id as cuenta_id,
         least((select min(m.fecha) from movimientos_bancarios m where m.cuenta_origen_id = c.id),
               (select min(s.fecha) from saldos_bancarios s where s.cuenta_origen_id = c.id and s.origen <> 'MANUAL')) as desde,
         greatest((select max(m.fecha) from movimientos_bancarios m where m.cuenta_origen_id = c.id),
                  (select max(s.fecha) from saldos_bancarios s where s.cuenta_origen_id = c.id and s.origen <> 'MANUAL')) as hasta
  from cuentas_origen c where c.requiere_extracto
), mvp as (
  -- El débito del banco vinculado a cada pago (el primero).
  -- (0032) también los pagos de un débito en lote.
  select distinct on (v.pago_id) v.pago_id, v.fecha, v.cuenta_origen_id
  from (select m.pago_id, m.fecha, m.cuenta_origen_id, m.id from movimientos_bancarios m where m.pago_id is not null
        union all
        select x.pago_id, m.fecha, m.cuenta_origen_id, m.id from movimientos_pagos x join movimientos_bancarios m on m.id = x.movimiento_id) v
  order by v.pago_id, v.fecha, v.id
), fac0 as (
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
  select f.empresa_id, f.unidad_id, f.id as factura_id, f.fecha as fecha_factura, t.ocurrencia, t.fecha, t.importe,
         pr.nombre as proveedor, f.proveedor_id, f.cuenta_contable,
         f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0') as comprobante
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join hoy
  cross join lateral (
    select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend
  ) q
  cross join lateral (values
    ('ANTICIPO', case when q.anticipo_pend > 0 then dia_habil_desde(greatest(f.fecha, hoy.h + 1)) end, q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where not coalesce(p_solo_real, false)
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
), deb_libres as materialized (
  -- (0034) Débitos del banco sin documento: la plata ya salió y cuentan como reales.
  select m.id, m.empresa_id, m.fecha, -m.importe as imp
  from movimientos_bancarios m
  where m.estado <> 'IGNORADO' and m.importe < 0 and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and m.contraparte_cuenta_id is null and m.categoria in ('PAGO', 'SIN_CLASIFICAR') and m.destino_xubio = 'NINGUNO'
    and not exists (select 1 from movimientos_pagos x where x.movimiento_id = m.id)
    and exists (select 1 from fac0)
), dup_par as (
  -- (0034) Doble conteo: una factura proyectada que el extracto ya muestra pagada (paso "REAL (extracto)" del motor):
  -- débito sin documento, misma empresa, mismo importe al centavo, de 30 días antes a 3 después de la fecha de la
  -- factura. Solo cuenta si la pareja es ÚNICA de los dos lados.
  select f.factura_id, f.ocurrencia, d.id as mov_id,
         count(*) over (partition by f.factura_id, f.ocurrencia) as n_mov,
         count(*) over (partition by d.id) as n_fac
  from fac0 f join deb_libres d on d.empresa_id = f.empresa_id and d.imp = f.importe and d.fecha between f.fecha - 30 and f.fecha + 3
), fac as (
  -- Se excluye la proyección (el débito ya cuenta como real, en su fecha y su cuenta).
  select f.* from fac0 f
  where not exists (select 1 from dup_par x where x.n_mov = 1 and x.n_fac = 1 and x.factura_id = f.factura_id and x.ocurrencia = f.ocurrencia)
), fac_desc as (
  -- ESPERA_FC (0028): lo pagado sin factura se descuenta de la más vieja a la más nueva.
  select x.*,
         least(x.importe, greatest(coalesce(a.importe, 0) - coalesce(x.acumulado_antes, 0), 0)) as descuento
  from (
    select fac.*,
           sum(fac.importe) over (partition by fac.empresa_id, fac.proveedor_id
                                  order by fac.fecha, fac.fecha_factura, fac.factura_id, fac.ocurrencia
                                  rows between unbounded preceding and 1 preceding) as acumulado_antes
    from fac
  ) x
  left join anticipos_sin_factura a on a.empresa_id = x.empresa_id and a.proveedor_id = x.proveedor_id
), base as (
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque). Si el banco ya lo debitó (movimiento
  -- vinculado), cuenta ese día y en la unidad de esa cuenta.
  select p.empresa_id, coalesce(co.unidad_id, cm.unidad_id) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, coalesce(mv.fecha, p.fecha) as fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, coalesce(p.cuenta_origen_id, mv.cuenta_origen_id) as cuenta_origen_id, null::text as categoria,
         (mv.fecha is not null or p.medio::text <> 'CAJA') as afecta_bancos, 0::numeric as descuento
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join mvp mv on mv.pago_id = p.id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  left join cob on cob.cuenta_id = co.id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    and not exists (select 1 from pfuera pf where pf.pago_id = p.id)
    -- Un pago de una cuenta con extracto es real cuando el banco lo debita. Si el extracto de esa cuenta para ese
    -- día está y el débito no aparece, el pago no salió: no entra y queda en pagos_sin_debito.
    and (mv.fecha is not null or co.id is null or not co.requiere_extracto or p.medio = 'CAJA'
         or not coalesce(cob.desde <= p.fecha and cob.hasta >= p.fecha, false))
    and (p_desde is null or coalesce(mv.fecha, p.fecha) >= p_desde) and (p_hasta is null or coalesce(mv.fecha, p.fecha) <= p_hasta)
  union all
  -- REAL · cheques debitados (la categoría del acreedor elige la fila de cheques)
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id order by pg.id limit 1),
         ch.cuenta_origen_id, a.categoria, true, 0
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
    and (p_desde is null or ch.debitado_en >= p_desde) and (p_hasta is null or ch.debitado_en <= p_hasta)
  union all
  -- REAL · cobros (el día y la cuenta del banco, si ya está vinculado)
  select cb.empresa_id, coalesce(cm.unidad_id, co.unidad_id), 'COBRO', cb.id, 'COBRO', coalesce(mv.fecha, cb.fecha), cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', coalesce(mv.cuenta_origen_id, cb.cuenta_origen_id),
         null, true, 0
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  left join movimientos_bancarios mv on mv.id = cb.movimiento_id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  where (p_desde is null or coalesce(mv.fecha, cb.fecha) >= p_desde) and (p_hasta is null or coalesce(mv.fecha, cb.fecha) <= p_hasta)
  union all
  -- REAL · movimientos del banco sin documento vinculado (impuestos, gastos, FCI, transferencias… y débitos que
  -- todavía no tienen su pago, cheque o cobro: la plata ya se movió).
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha,
         -- (0034) de un lote con pagos fuera del Flujo cuenta solo la parte de esos pagos
         case when lf.movimiento_id is null or lf.fuera_n = lf.n then m.importe else -lf.fuera_imp end,
         'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  left join lote_fuera lf on lf.movimiento_id = m.id
  where m.estado <> 'IGNORADO'
    -- (0034) un débito vinculado a un pago que no entra al Flujo (no está en Xubio, o es de caja) sigue contando
    and (m.pago_id is null or exists (select 1 from pfuera pf where pf.pago_id = m.pago_id))
    and m.cobro_id is null and m.cheque_id is null
    and (lf.movimiento_id is null or lf.fuera_n > 0)
    and (p_desde is null or m.fecha >= p_desde) and (p_hasta is null or m.fecha <= p_hasta)
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, true, 0
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
    and (p_desde is null or m.fecha >= p_desde) and (p_hasta is null or m.fecha <= p_hasta)
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación de esas cuentas)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', true, 0
  from conciliacion_calculo(true) cb
  where cb.rendimiento is not null and cb.rendimiento <> 0
    and (p_desde is null or cb.fecha >= p_desde) and (p_hasta is null or cb.fecha <= p_hasta)
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, true, d.descuento
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id order by pg.id limit 1),
         ch.cuenta_origen_id, a.categoria, true, 0
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where not coalesce(p_solo_real, false) and ch.estado in ('EMITIDO', 'ENTREGADO')
), b2 as materialized (
  -- Cada línea con lo que hace falta para buscar su destino, calculado una sola vez.
  select b.*, e.organizacion_id, coalesce(b.unidad_hint, ud.id) as hint,
         texto_banco(b.cuenta_contable) as cuenta_norm,
         case when (select bool_or(x.si_texto_norm is not null) from reglas x)
              then texto_banco(coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) else '' end as texto_norm,
         coalesce(b.proveedor_id, '00000000-0000-0000-0000-000000000000'::uuid) as k_prov,
         coalesce(b.cuenta_origen_id, '00000000-0000-0000-0000-000000000000'::uuid) as k_cta,
         coalesce(b.categoria, '') as k_cat,
         -- Lo REAL que pasó por una cuenta con extracto queda en la unidad de esa cuenta (0030, punto 8).
         cu.unidad_id as unidad_cuenta
  from base b
  join empresas e on e.id = b.empresa_id
  left join unidades ud on ud.empresa_id = b.empresa_id and ud.por_defecto
  left join cuentas_origen cu on cu.id = b.cuenta_origen_id and b.afecta_bancos and cu.requiere_extracto and b.naturaleza = 'REAL'
  where p_unidad is null or cu.unidad_id is null or cu.unidad_id = p_unidad
), claves as (
  select distinct b.organizacion_id, b.empresa_id, b.hint, b.origen_tipo, b.k_prov, b.cuenta_norm, b.k_cta, b.k_cat, b.texto_norm
  from b2 b
), dest as materialized (
  -- La regla que aplica a cada combinación: la primera por prioridad; lo más específico gana.
  select c.*, r.regla_id, r.r_unidad, r.r_fila, coalesce(r.r_excluir, false) as r_excluir
  from claves c
  left join lateral (
    select x.id as regla_id, x.unidad_id as r_unidad, x.fila_id as r_fila, x.excluir as r_excluir
    from reglas x
    where x.organizacion_id = c.organizacion_id and (x.empresa_id is null or x.empresa_id = c.empresa_id)
      and (x.si_origen is null or x.si_origen = c.origen_tipo)
      and (x.si_proveedor_id is null or x.si_proveedor_id = c.k_prov)
      and (x.si_cuenta_norm is null or x.si_cuenta_norm = c.cuenta_norm)
      and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = c.k_cta)
      and (x.si_categoria is null or x.si_categoria = nullif(c.k_cat, ''))
      and (x.si_texto_norm is null or position(x.si_texto_norm in c.texto_norm) > 0)
      and (x.si_unidad_id is null or x.si_unidad_id = c.hint)
    order by x.prioridad, (x.empresa_id is null), (x.si_unidad_id is null), x.creada_en, x.id
    limit 1
  ) r on true
), res as (
  -- Unidad y fila de cada línea: la de la regla; si no, la apertura del proveedor o la fila de su cuenta
  -- contable en su unidad; si no, "Sin clasificar".
  select b.empresa_id, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe, b.naturaleza, b.contraparte, b.concepto,
         b.cuenta_origen_id, b.afecta_bancos, b.descuento, b.unidad_cuenta, d.r_excluir,
         coalesce(d.r_unidad, b.hint) as v_unidad,
         coalesce(d.r_fila, ap.id, fc.id, sc.id) as v_fila
  from b2 b
  join dest d on d.organizacion_id = b.organizacion_id and d.empresa_id = b.empresa_id and d.hint is not distinct from b.hint
             and d.origen_tipo = b.origen_tipo and d.k_prov = b.k_prov and d.cuenta_norm = b.cuenta_norm and d.k_cta = b.k_cta
             and d.k_cat = b.k_cat and d.texto_norm = b.texto_norm
  left join proveedores pv on pv.id = b.proveedor_id
  left join fcta fc on fc.unidad_id = coalesce(d.r_unidad, b.hint) and fc.cuenta_norm = b.cuenta_norm
                   and b.cuenta_contable is not null and d.r_fila is null
  left join lateral (
    select f.id from fape f
    where b.proveedor_id is not null and b.cuenta_contable is not null and d.r_fila is null and pv.nombre is not null
      and f.unidad_id = coalesce(d.r_unidad, b.hint) and f.cuenta_norm = b.cuenta_norm
      and position(f.apertura_norm in texto_banco(pv.nombre)) > 0
    order by f.orden, f.id limit 1
  ) ap on true
  left join esp sc on sc.unidad_id = coalesce(d.r_unidad, b.hint) and sc.seccion = 'SIN_CLASIFICAR'
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto
  from proyecciones p
  cross join hoy
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, hoy.h, hoy.h + 180) o
  where not coalesce(p_solo_real, false) and p.estado = 'ACTIVA'
), todas as (
  -- Lo REAL que pasó por una cuenta bancaria queda en la unidad de esa cuenta y no se excluye. Si una regla lo
  -- mandaba a otra unidad o lo excluía (transferencia propia), va a "Entre cuentas propias" (excluida) o a
  -- "Sin clasificar" (otra unidad) de su unidad.
  select r.empresa_id,
         coalesce(r.unidad_cuenta, r.v_unidad) as unidad_id,
         case when r.unidad_cuenta is not null and r.r_excluir then ec.id
              when r.unidad_cuenta is not null and r.v_unidad is distinct from r.unidad_cuenta then su.id
              else r.v_fila end as fila_id,
         r.origen_tipo, r.origen_id, r.ocurrencia, r.fecha, r.importe, r.naturaleza, r.contraparte, r.concepto,
         r.cuenta_origen_id, r.afecta_bancos, r.descuento
  from res r
  left join esp ec on ec.unidad_id = r.unidad_cuenta and ec.seccion = 'ENTRE_CUENTAS'
  left join esp su on su.unidad_id = r.unidad_cuenta and su.seccion = 'SIN_CLASIFICAR'
  where r.unidad_cuenta is not null or not r.r_excluir
  union all
  select empresa_id, unidad_id, fila_id, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto,
         null::uuid, true, 0
  from proy
), fin as (
  select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
         t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
         -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
         case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < hoy.h
              then hoy.habil else coalesce(a.fecha_nueva, t.fecha) end as fecha,
         t.fecha as fecha_calculada,
         case when a.importe_nuevo is null then t.importe
              -- 20. Con un pago sin factura descontado, el ajuste no puede volver a sumarlo: tope = lo que queda.
              when t.origen_tipo = 'FACTURA' and t.descuento > 0 then -least(a.importe_nuevo, -t.importe)
              else sign(t.importe) * a.importe_nuevo end as importe,
         t.contraparte, t.concepto,
         t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < hoy.h as vencido,
         a.id is not null as ajustada,
         t.naturaleza = 'PROYECTADO' as editable,
         t.cuenta_origen_id,
         t.afecta_bancos
  from todas t
  cross join hoy
  join flujo_filas ff on ff.id = t.fila_id
  left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                           and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
  where not coalesce(a.eliminada, false)
)
select f.* from fin f
where (p_unidad is null or f.unidad_id = p_unidad)
  and (p_desde is null or f.fecha >= p_desde) and (p_hasta is null or f.fecha <= p_hasta)
$$;
revoke execute on function flujo_lineas_entre(date, date, uuid, boolean) from public, anon;
grant execute on function flujo_lineas_entre(date, date, uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------- 5. Feriados

-- La lista que usa el Apps Script (FlujoCaja.js, filas FERIADO del Mapa Flujo; "los mismos de CHEQUES EMITIDOS").
-- Tecnología puede agregar o corregir desde la tabla; on conflict no pisa lo que ya esté cargado.
insert into feriados (fecha, nombre) values
  ('2026-11-23', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2026-12-07', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2026-12-08', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2026-12-25', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-01-01', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-02-08', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-02-09', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-03-24', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-03-26', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-04-02', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-05-01', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-05-25', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-06-15', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)'),
  ('2027-06-20', 'Feriado o puente (lista del Apps Script, FlujoCaja.js)')
on conflict (fecha) do nothing;
