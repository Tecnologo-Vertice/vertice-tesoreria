-- 0041 · Pagos contra proyecciones del Flujo, fecha de pago al aprobar, cuentas propias y extracto repetido (27/11/2026)
--
-- Sale de los cambios del Apps Script "VBI+" del 27/11 (versiones v148 a v154) y de la revisión de la 0041. Re-ejecutable.
--
--   1. Un pago manual o sin factura se puede asociar a una proyección del Flujo (fbProyeccionesParaPago,
--      fbBajaProyeccionPorPago_, PROYECCION_ASOCIADA). Solo egresos, de hoy a hoy + 30 días (fecha efectiva), de la misma empresa.
--        · Si el pago cubre una parte, se descuenta del importe de la proyección y queda el saldo; si cubre todo (o más), se da de
--          baja. Motivo: "Pago <id>: baja de la proyección". Lo descontado nunca supera lo que queda.
--        · El descuento pesa en el Flujo recién cuando el pago cuenta como REAL (regla 0034: en Xubio, o el banco lo debitó). Hasta
--          entonces el Flujo sigue mostrando la proyección completa y el pago queda "esperando" (proyeccion_aplicada = false); lo hace
--          un disparador cuando el pago pasa a contar. Cheque y caja descuentan en el momento (ver pago_cuenta_en_flujo).
--        · Si el pago se anula, vuelve exactamente lo que había descontado, sobre el importe de ese momento, y la proyección
--          (o la ocurrencia) se reabre si queda algo, sin importar quién la cerró. Un aumento a mano posterior no se pierde.
--        · Una proyección que se repite se ajusta solo en la ocurrencia elegida (flujo_ajustes). "Esta y las siguientes"
--          (cambiar_proyeccion) arrastra los descuentos a la serie nueva y reapunta los pagos.
--        · Los pagos de la hoja del Apps Script (gestion HOJA) no se asocian acá.
--   2. Fecha de pago al aprobar desde "Pendiente de aprobación" (fijarFechaPagoAutorizada_): salvo cheque, ECHEQ, tarjeta (nace
--      pagada) y notas de crédito, es obligatoria, no puede ser anterior a hoy_ar() ni a más de un año. El vencimiento original va
--      a facturas.vencimiento_factura una sola vez; la fecha nueva queda como fecha de pago y como vencimiento. Las firmas de
--      4 argumentos de aprobar_factura y aprobar_factura_y_vincular quedan solo para el servidor.
--   3. CUIT propios (valen para toda la organización): una transferencia sin clasificar y sin documento, después de conciliar,
--      que nombra un CUIT propio pasa a entre cuentas propias. No VEP, AFIP ni impuestos. No se le asigna el fondo de la cuenta
--      madre solo. La remunerada de Brubank como fondo ya la resuelve la 0040.
--   4. El mismo extracto (por archivo o por contenido) no entra en la cuenta de otra empresa de la organización, salvo
--      confirmación. borrar_extracto deshace uno importado en la cuenta equivocada.
--   (5, el control de caja contra el Flujo, ya está en control_bancos desde la 0031: FLUJO_F.)

-- ---------------------------------------------------------------- 1. Columnas

alter table pagos add column if not exists proyeccion_id uuid references proyecciones on delete set null;
alter table pagos add column if not exists proyeccion_ocurrencia text;
alter table pagos add column if not exists proyeccion_importe numeric(16,2);
alter table pagos add column if not exists proyeccion_baja boolean not null default false;
-- false = el pago eligió la proyección pero todavía no cuenta en el Flujo: el descuento espera (ver pago_cuenta_en_flujo).
alter table pagos add column if not exists proyeccion_aplicada boolean not null default false;
create index if not exists pagos_proyeccion on pagos (proyeccion_id) where proyeccion_id is not null;

alter table facturas add column if not exists vencimiento_factura date;

-- Movimiento marcado como transferencia entre cuentas propias por el CUIT de la descripción (no por una regla del banco).
alter table movimientos_bancarios add column if not exists propia_por_cuit boolean not null default false;

-- ---------------------------------------------------------------- 1. Cómo está una ocurrencia de una proyección

-- Importe y fecha vigentes (con el ajuste del Flujo), y si está cerrada (proyección cancelada o ocurrencia eliminada).
create or replace function proyeccion_estado_ocurrencia(p proyecciones, p_ocurrencia date)
returns table (existe boolean, base numeric, vigente numeric, fecha date, con_fecha boolean, cerrada boolean)
language plpgsql stable security definer set search_path = public as $$
declare o record; a flujo_ajustes;
begin
  select x.* into o from proyeccion_ocurrencias(p, p_ocurrencia, p_ocurrencia) x where x.ocurrencia = p_ocurrencia;
  if o.ocurrencia is null then
    return query select false, 0::numeric, 0::numeric, null::date, false, true;
    return;
  end if;
  select * into a from flujo_ajustes
  where origen_tipo = 'PROYECCION' and origen_id = p.id and ocurrencia = p_ocurrencia::text and reemplazado_en is null;
  return query select true, abs(o.importe),
    case when p.estado <> 'ACTIVA' or coalesce(a.eliminada, false) then 0::numeric else coalesce(a.importe_nuevo, abs(o.importe)) end,
    coalesce(a.fecha_nueva, o.fecha), a.fecha_nueva is not null,
    p.estado <> 'ACTIVA' or coalesce(a.eliminada, false);
end $$;

-- Deja el ajuste vigente de una ocurrencia: importe nuevo (o ninguno), eliminada o no. Si queda igual que el original y
-- sin fecha movida, el ajuste se quita. Un importe mayor que el original (aumento a mano) sí queda como ajuste.
create or replace function proyeccion_poner_ajuste(p proyecciones, p_ocurrencia date, p_importe numeric, p_eliminada boolean, p_motivo text, p_usuario usuarios)
returns void language plpgsql security definer set search_path = public as $$
declare v_prev flujo_ajustes; v_base numeric; v_fecha date;
begin
  select * into v_prev from flujo_ajustes
  where origen_tipo = 'PROYECCION' and origen_id = p.id and ocurrencia = p_ocurrencia::text and reemplazado_en is null for update;
  if v_prev.id is not null then update flujo_ajustes set reemplazado_en = now() where id = v_prev.id; end if;
  v_fecha := case when not p_eliminada then v_prev.fecha_nueva end;
  select abs(x.importe) into v_base from proyeccion_ocurrencias(p, p_ocurrencia, p_ocurrencia) x where x.ocurrencia = p_ocurrencia;
  if not p_eliminada and v_fecha is null and abs(p_importe - coalesce(v_base, 0)) < 0.005 then return; end if;   -- vuelve a ser la original
  insert into flujo_ajustes (empresa_id, origen_tipo, origen_id, ocurrencia, fecha_nueva, importe_nuevo, eliminada, motivo, creado_por)
  values (p.empresa_id, 'PROYECCION', p.id, p_ocurrencia::text, v_fecha, case when p_eliminada then null else p_importe end,
          p_eliminada, p_motivo, p_usuario.email);
end $$;

-- ---------------------------------------------------------------- 1. Lista de proyecciones para elegir al cargar un pago

-- Solo egresos activos de la empresa cuya fecha EFECTIVA (con el ajuste del Flujo) cae entre hoy y hoy + 30. Se buscan las
-- ocurrencias en una ventana más ancha para no perder una que el Flujo adelantó o atrasó.
create or replace function proyecciones_para_pago(p_empresa text)
returns table (proyeccion_id uuid, ocurrencia date, fecha date, importe numeric, concepto text, proveedor text, fila text, recurrencia text)
language plpgsql stable security definer set search_path = public as $$
declare u usuarios; v_hoy date := hoy_ar();
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  perform exigir_empresa(p_empresa);
  return query
  select p.id, o.ocurrencia, coalesce(a.fecha_nueva, o.fecha),
         case when a.importe_nuevo is not null then a.importe_nuevo else abs(o.importe) end,
         p.concepto, pr.nombre, ff.etiqueta, p.recurrencia
  from proyecciones p
  join flujo_filas ff on ff.id = p.fila_id
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, v_hoy - 60, v_hoy + 120) o
  left join flujo_ajustes a on a.origen_tipo = 'PROYECCION' and a.origen_id = p.id and a.ocurrencia = o.ocurrencia::text and a.reemplazado_en is null
  where p.empresa_id = p_empresa and p.estado = 'ACTIVA' and p.importe < 0
    and not coalesce(a.eliminada, false)
    and coalesce(a.fecha_nueva, o.fecha) between v_hoy and v_hoy + 30
  order by coalesce(a.fecha_nueva, o.fecha), p.concepto, p.id;
end $$;

-- ---------------------------------------------------------------- 2. ¿El pago ya pesa en el Flujo?

-- Es la regla de flujo_lineas_entre (0034, rama pfuera): un pago de este sistema cuenta como REAL recién cuando está en Xubio.
-- Cuentan desde el momento: los pagos con cheque (el cheque emitido ya está proyectado) y los de caja (el Flujo nunca los
-- cuenta y el banco no los va a pagar: si el descuento esperara, la proyección quedaría de más para siempre).
-- También cuenta un pago cuyo débito del banco ya está vinculado (esa plata entra por el movimiento).
create or replace function pago_cuenta_en_flujo(pg pagos)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when pg.medio::text in ('CHEQUE', 'ECHEQ') or exists (select 1 from cheques_pagos cp where cp.pago_id = pg.id) then true
    when pg.medio::text = 'CAJA' then true
    when pg.fecha <= date '2026-11-17' then true
    when upper(btrim(coalesce(pg.estado_xubio_pago, ''))) in ('SUBIDO', 'YA_EN_XUBIO', 'CARGADO_A_MANO') then true
    when pg.estado_xubio_pago is null and pg.gestion = 'SISTEMA' and pg.estado::text in ('CONTABILIZADO', 'CONCILIADO') and pg.xubio_id is not null then true
    else exists (select 1 from movimientos_bancarios m where m.pago_id = pg.id and m.estado <> 'IGNORADO')
         or exists (select 1 from movimientos_pagos x where x.pago_id = pg.id)
  end
$$;

-- ---------------------------------------------------------------- 2. Descontar de la proyección (interna)

-- Hace el descuento: el pago ya cuenta en el Flujo. Descuenta lo que queda como máximo; si cubre todo, da de baja.
create or replace function efectuar_descuento_proyeccion(p_pago uuid, p_usuario usuarios)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pg pagos; p proyecciones; st record; v_oc date; v_aplica numeric; v_resto numeric; v_baja boolean; v_motivo text;
begin
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null or pg.proyeccion_id is null or pg.proyeccion_aplicada or pg.estado::text = 'ANULADO' then return null; end if;
  select * into p from proyecciones where id = pg.proyeccion_id for update;
  v_oc := pg.proyeccion_ocurrencia::date;
  if p.id is not null then select * into st from proyeccion_estado_ocurrencia(p, v_oc); end if;
  if p.id is null or not st.existe or st.cerrada or st.vigente < 0.01 then
    update pagos set proyeccion_aplicada = true, proyeccion_importe = 0, proyeccion_baja = false where id = pg.id;
    perform registrar_auditoria(p_usuario, 'PROYECCION_SIN_SALDO', 'PAGO', pg.id::text, 'La proyección ya estaba cubierta o dada de baja: el pago no descontó nada');
    return jsonb_build_object('descontado', 0, 'saldo', 0, 'baja', false, 'pendiente', false);
  end if;
  v_aplica := least(round(pg.importe, 2), st.vigente);   -- nunca se descuenta más de lo que queda
  v_resto := round(st.vigente - v_aplica, 2);
  v_baja := v_resto < 0.01;
  v_motivo := 'Pago ' || pg.id || case when v_baja then ': baja de la proyección' else ': descuento de $ ' || v_aplica || ' de la proyección (queda $ ' || v_resto || ')' end;
  if v_baja then
    if p.recurrencia = 'UNICA' then
      update proyecciones set estado = 'CANCELADA', cancelado_por = p_usuario.email, cancelado_en = now(), nota = concat_ws(' · ', nota, v_motivo)
      where id = p.id;
    else
      perform proyeccion_poner_ajuste(p, v_oc, null, true, v_motivo, p_usuario);
    end if;
  else
    perform proyeccion_poner_ajuste(p, v_oc, v_resto, false, v_motivo, p_usuario);
  end if;
  update pagos set proyeccion_importe = v_aplica, proyeccion_baja = v_baja, proyeccion_aplicada = true where id = pg.id;
  perform registrar_auditoria(p_usuario, 'PAGO_PROYECCION', 'PAGO', pg.id::text, p.concepto || ' · ' || v_oc || ' · $ ' || v_aplica || case when v_baja then ' · baja' else ' · queda $ ' || v_resto end);
  perform registrar_auditoria(p_usuario, case when v_baja then 'PROYECCION_BAJA_POR_PAGO' else 'PROYECCION_DESCUENTO_POR_PAGO' end, 'PROYECCION', p.id::text, v_motivo);
  return jsonb_build_object('proyeccion', p.id, 'descontado', v_aplica, 'saldo', greatest(v_resto, 0), 'baja', v_baja, 'pendiente', false);
end $$;

-- Asociar un pago a una proyección (interna). Valida todo; si el pago ya pesa en el Flujo descuenta ahora, y si no, el descuento
-- queda esperando (lo hace el disparador cuando el pago pasa a contar). Lo ya reservado por otros pagos que esperan no se vuelve a ofrecer.
create or replace function aplicar_pago_a_proyeccion(p_pago uuid, p_proyeccion uuid, p_ocurrencia date, p_usuario usuarios)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pg pagos; p proyecciones; st record; v_hoy date := hoy_ar(); v_reservado numeric;
begin
  if p_ocurrencia is null then raise exception 'Falta la fecha de la ocurrencia de la proyección'; end if;
  select * into pg from pagos where id = p_pago for update;
  if pg.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(pg.empresa_id);
  if pg.estado::text = 'ANULADO' then raise exception 'El pago está anulado'; end if;
  if pg.proyeccion_id is not null then raise exception 'El pago ya está asociado a una proyección'; end if;
  if exists (select 1 from pagos_facturas where pago_id = pg.id) or coalesce(trim(pg.factura_asociada), '') <> '' then
    raise exception 'Un pago con factura no se asocia a una proyección del Flujo';
  end if;
  if not (pg.importe > 0) then raise exception 'El pago no tiene monto'; end if;
  select * into p from proyecciones where id = p_proyeccion for update;
  if p.id is null then raise exception 'No encontré la proyección'; end if;
  if p.empresa_id <> pg.empresa_id then raise exception 'La proyección es de otra empresa'; end if;
  if p.estado <> 'ACTIVA' then raise exception 'La proyección ya no está activa (se dio de baja o se canceló)'; end if;
  if not (p.importe < 0) then raise exception 'Solo se asocian proyecciones de egreso'; end if;
  select * into st from proyeccion_estado_ocurrencia(p, p_ocurrencia);
  if not st.existe then raise exception 'La proyección no tiene una ocurrencia el %', p_ocurrencia; end if;
  select coalesce(sum(x.importe), 0) into v_reservado from pagos x
  where x.proyeccion_id = p.id and x.proyeccion_ocurrencia = p_ocurrencia::text and not x.proyeccion_aplicada and x.estado::text <> 'ANULADO' and x.id <> pg.id;
  if st.cerrada or st.vigente - v_reservado < 0.01 then raise exception 'Esa proyección ya está cubierta o dada de baja'; end if;
  if st.fecha < v_hoy or st.fecha > v_hoy + 30 then raise exception 'Solo se asocian proyecciones de hoy a 30 días (esta es del %)', st.fecha; end if;

  update pagos set proyeccion_id = p.id, proyeccion_ocurrencia = p_ocurrencia::text, proyeccion_importe = null, proyeccion_baja = false, proyeccion_aplicada = false
  where id = pg.id;
  select * into pg from pagos where id = p_pago;
  -- Si el pago ya cuenta, el disparador de arriba (trg_pago_proyeccion_pendiente) acaba de hacer el descuento.
  if pg.proyeccion_aplicada then
    return jsonb_build_object('proyeccion', p.id, 'descontado', pg.proyeccion_importe, 'saldo', greatest(st.vigente - coalesce(pg.proyeccion_importe, 0), 0),
                              'baja', pg.proyeccion_baja, 'pendiente', false);
  end if;
  if pago_cuenta_en_flujo(pg) then
    return efectuar_descuento_proyeccion(p_pago, p_usuario);
  end if;
  perform registrar_auditoria(p_usuario, 'PAGO_PROYECCION_PENDIENTE', 'PAGO', pg.id::text,
    p.concepto || ' · ' || p_ocurrencia || ': el descuento se aplica cuando el pago esté en Xubio (recién ahí cuenta en el Flujo)');
  return jsonb_build_object('proyeccion', p.id, 'descontado', 0, 'saldo', st.vigente, 'baja', false, 'pendiente', true);
end $$;

-- Cuando el pago pasa a contar en el Flujo (se contabiliza en Xubio, o el banco lo debita), se hace el descuento que esperaba.
create or replace function pago_aplica_proyeccion_pendiente()
returns trigger language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  if not pago_cuenta_en_flujo(new) then return null; end if;
  u.email := 'sistema'; u.nombre := 'Sistema'; u.rol := 'ADMIN';
  begin
    perform efectuar_descuento_proyeccion(new.id, u);
  exception when others then
    insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
    values ('Sistema', 'ADMIN', 'PROYECCION_SIN_DESCUENTO', 'PAGO', new.id::text, 'No se pudo descontar de la proyección: ' || sqlerrm);
  end;
  return null;
end $$;
drop trigger if exists trg_pago_proyeccion_pendiente on pagos;
create trigger trg_pago_proyeccion_pendiente after update on pagos for each row
  when (new.proyeccion_id is not null and not new.proyeccion_aplicada and new.estado::text <> 'ANULADO')
  execute function pago_aplica_proyeccion_pendiente();

-- Si el pago se anula, vuelve a la proyección EXACTAMENTE lo que ese pago descontó, sobre el importe de ahora (así un aumento a
-- mano posterior no se pierde). Si con eso queda algo, la proyección o la ocurrencia se reabre, sin importar quién la cerró.
create or replace function devolver_pago_a_proyeccion(p_pago uuid, p_usuario usuarios)
returns void language plpgsql security definer set search_path = public as $$
declare pg pagos; p proyecciones; st record; v_oc date; v_nuevo numeric; v_motivo text;
begin
  select * into pg from pagos where id = p_pago;
  if pg.id is null or pg.proyeccion_id is null then return; end if;
  if not pg.proyeccion_aplicada then
    perform registrar_auditoria(p_usuario, 'PROYECCION_SIN_DEVOLUCION', 'PAGO', pg.id::text, 'Pago anulado antes de contar en el Flujo: no había descontado nada de la proyección');
    return;
  end if;
  if coalesce(pg.proyeccion_importe, 0) <= 0 then return; end if;
  select * into p from proyecciones where id = pg.proyeccion_id for update;
  if p.id is null then return; end if;
  v_oc := pg.proyeccion_ocurrencia::date;
  v_motivo := 'Pago ' || pg.id || ' anulado: vuelve a la proyección';
  select * into st from proyeccion_estado_ocurrencia(p, v_oc);
  if not st.existe then
    perform registrar_auditoria(p_usuario, 'PROYECCION_SIN_DEVOLUCION', 'PROYECCION', p.id::text, 'Pago ' || pg.id || ' anulado: la ocurrencia del ' || v_oc || ' ya no existe, no hay nada para devolver');
    return;
  end if;
  v_nuevo := round(st.vigente + pg.proyeccion_importe, 2);   -- vigente es 0 si está cerrada
  if p.estado <> 'ACTIVA' then
    update proyecciones set estado = 'ACTIVA', cancelado_por = null, cancelado_en = null, nota = concat_ws(' · ', nota, v_motivo) where id = p.id;
    p.estado := 'ACTIVA';
  end if;
  perform proyeccion_poner_ajuste(p, v_oc, v_nuevo, false, v_motivo, p_usuario);
  perform registrar_auditoria(p_usuario, 'PROYECCION_DEVOLUCION', 'PROYECCION', p.id::text, v_motivo || ' · queda $ ' || v_nuevo);
end $$;

-- Asociar un pago ya cargado (sin factura, de este sistema) a una proyección.
create or replace function asociar_pago_proyeccion(p_pago uuid, p_proyeccion uuid, p_ocurrencia date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; pg pagos;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  select * into pg from pagos where id = p_pago;
  if pg.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(pg.empresa_id);
  if pg.gestion = 'HOJA' then raise exception 'Este pago viene de la hoja del Apps Script: se asocia ahí'; end if;
  return aplicar_pago_a_proyeccion(p_pago, p_proyeccion, p_ocurrencia, u);
end $$;

-- ---------------------------------------------------------------- 4. cambiar_proyeccion (0038): "esta y las siguientes" arrastra los pagos

-- Igual que 0038 con un agregado: lo que los pagos ya descontaron de esta ocurrencia pasa a la serie nueva (queda su importe menos
-- lo descontado) y esos pagos se reapuntan a la ocurrencia nueva, así no se cuenta doble. Con pagos en ocurrencias posteriores,
-- cambiar la fecha no se permite (las ocurrencias se recalculan y no hay cómo seguirlas): usar "solo esta" o anular esos pagos.
create or replace function cambiar_proyeccion(p_id uuid, p_ocurrencia date, p_alcance text, p_accion text,
                                              p_importe numeric default null, p_fecha date default null, p_motivo text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  u usuarios; p proyecciones; o record; v_hoy date := hoy_ar(); v_antes integer; v_ult_antes date; v_nueva uuid; v_imp numeric; v_inicio date; v_borrar boolean;
  v_desc numeric := 0; pn proyecciones; r record; st record;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN');
  if p_alcance not in ('SOLO_ESTA', 'DESDE_ESTA') then raise exception 'El alcance es SOLO_ESTA o DESDE_ESTA'; end if;
  if p_accion not in ('EDITAR', 'BORRAR') then raise exception 'La acción es EDITAR o BORRAR'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo'; end if;
  v_borrar := p_accion = 'BORRAR';
  if not v_borrar and p_importe is null and p_fecha is null then raise exception 'No hay nada para cambiar: falta el importe o la fecha'; end if;
  if p_importe is not null and p_importe <= 0 then raise exception 'El importe va en positivo: el signo lo pone la proyección'; end if;
  select * into p from proyecciones where id = p_id for update;
  if p.id is null then raise exception 'No encontré la proyección'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.estado <> 'ACTIVA' then raise exception 'La proyección ya no está activa'; end if;
  if p_ocurrencia < v_hoy then raise exception 'No se cambia lo que ya pasó'; end if;
  if p_fecha is not null and p_fecha < v_hoy then raise exception 'No se proyecta en el pasado'; end if;
  select x.* into o from proyeccion_ocurrencias(p, p_ocurrencia, p_ocurrencia) x where x.ocurrencia = p_ocurrencia;
  if o.ocurrencia is null then raise exception 'La proyección no tiene una ocurrencia el %', p_ocurrencia; end if;

  -- Una sola vez (o solo esta): como el Apps Script, una puntual se trata siempre como "solo esta".
  if p_alcance = 'SOLO_ESTA' or p.recurrencia = 'UNICA' then
    if p.recurrencia = 'UNICA' and v_borrar then
      update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(), nota = concat_ws(' · ', nota, p_motivo)
      where id = p_id;
    else
      perform ajustar_linea_flujo('PROYECCION', p_id, p_ocurrencia::text, p_fecha, p_importe, v_borrar, p_motivo);
    end if;
    perform registrar_auditoria(u, 'PROYECCION_CAMBIAR', 'PROYECCION', p_id::text,
      'Solo la del ' || p_ocurrencia || ' · ' || p_accion || coalesce(' · importe ' || p_importe, '') || coalesce(' · al ' || p_fecha, '') || ' · ' || p_motivo);
    return null;
  end if;

  -- Esta y las siguientes.
  select count(*), max(x.ocurrencia) into v_antes, v_ult_antes from proyeccion_ocurrencias(p, p.fecha_inicio, p_ocurrencia - 1) x;
  v_inicio := coalesce(p_fecha, p_ocurrencia);
  if not v_borrar and v_ult_antes is not null and v_inicio <= v_ult_antes then
    raise exception 'La fecha nueva queda antes de la ocurrencia anterior (%): elegí una posterior', v_ult_antes;
  end if;
  if not v_borrar and p.hasta is not null and v_inicio > p.hasta then raise exception 'La fecha nueva queda después del final de la serie'; end if;
  -- (0041) Lo que los pagos ya descontaron de esta ocurrencia.
  select coalesce(sum(x.proyeccion_importe), 0) into v_desc from pagos x
  where x.proyeccion_id = p_id and x.proyeccion_ocurrencia = p_ocurrencia::text and x.proyeccion_aplicada and x.estado::text <> 'ANULADO';
  if not v_borrar and p_fecha is not null and exists (
       select 1 from pagos x where x.proyeccion_id = p_id and x.proyeccion_ocurrencia > p_ocurrencia::text and x.estado::text <> 'ANULADO') then
    raise exception 'Hay pagos asociados a ocurrencias posteriores: no se puede cambiar la fecha de "esta y las siguientes". Cambiá solo esta, o anulá esos pagos';
  end if;
  -- Las excepciones de esta ocurrencia ya no valen (cambia la serie); las de después pasan a la nueva si la fecha no cambió.
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = 'PROYECCION' and origen_id = p_id and reemplazado_en is null and ocurrencia = p_ocurrencia::text;
  if v_antes = 0 then
    update proyecciones set estado = 'CANCELADA', cancelado_por = u.email, cancelado_en = now(), nota = concat_ws(' · ', nota, p_motivo)
    where id = p_id;
  else
    update proyecciones set hasta = p_ocurrencia - 1 where id = p_id;
  end if;
  if not v_borrar then
    v_imp := coalesce(p_importe, abs(o.importe)) * case when p.importe < 0 then -1 else 1 end;
    insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, proveedor_id, importe, fecha_inicio, recurrencia, dia_mes,
                              hasta, cuotas, ajuste_pct_mensual, origen, nota, creado_por)
    values (p.empresa_id, p.unidad_id, p.fila_id, p.concepto, p.proveedor_id, v_imp, v_inicio, p.recurrencia,
            case when p.recurrencia = 'MENSUAL' then case when p_fecha is null then p.dia_mes else extract(day from p_fecha)::integer end end,
            p.hasta, case when p.cuotas is not null then p.cuotas - v_antes end, p.ajuste_pct_mensual, p.origen,
            concat_ws(' · ', 'Sigue a ' || left(p_id::text, 8), p_motivo), u.email)
    returning id into v_nueva;
    if p_fecha is null then
      update flujo_ajustes set origen_id = v_nueva
      where origen_tipo = 'PROYECCION' and origen_id = p_id and reemplazado_en is null
        and ocurrencia ~ '^\d{4}-\d{2}-\d{2}$' and ocurrencia::date > p_ocurrencia;
      -- (0041) Los pagos de las ocurrencias de después siguen a su ocurrencia en la serie nueva (la fecha no cambió).
      update pagos set proyeccion_id = v_nueva
      where proyeccion_id = p_id and proyeccion_ocurrencia > p_ocurrencia::text and estado::text <> 'ANULADO';
      -- Cada una de esas ocurrencias queda con su importe (el de la serie nueva) menos lo que los pagos ya descontaron.
      select * into pn from proyecciones where id = v_nueva;
      for r in select x.proyeccion_ocurrencia as oc, sum(x.proyeccion_importe) as d from pagos x
               where x.proyeccion_id = v_nueva and x.proyeccion_ocurrencia > p_ocurrencia::text and x.proyeccion_aplicada and x.estado::text <> 'ANULADO'
               group by x.proyeccion_ocurrencia loop
        select * into st from proyeccion_estado_ocurrencia(pn, r.oc::date);
        if st.existe then
          if st.base - r.d < 0.01 then perform proyeccion_poner_ajuste(pn, r.oc::date, null, true, 'Pagos ya aplicados cubren esta ocurrencia', u);
          else perform proyeccion_poner_ajuste(pn, r.oc::date, st.base - r.d, false, 'Descuento de pagos ya aplicados', u); end if;
        end if;
      end loop;
    end if;
    -- (0041) Los pagos de esta ocurrencia pasan a la primera de la serie nueva, con su descuento.
    if exists (select 1 from pagos x where x.proyeccion_id = p_id and x.proyeccion_ocurrencia = p_ocurrencia::text and x.estado::text <> 'ANULADO') then
      update pagos set proyeccion_id = v_nueva, proyeccion_ocurrencia = v_inicio::text
      where proyeccion_id = p_id and proyeccion_ocurrencia = p_ocurrencia::text and estado::text <> 'ANULADO';
      select * into pn from proyecciones where id = v_nueva;
      if v_desc > 0 then
        if abs(v_imp) - v_desc < 0.01 then
          perform proyeccion_poner_ajuste(pn, v_inicio, null, true, 'Pagos ya aplicados cubren esta ocurrencia', u);
        else
          perform proyeccion_poner_ajuste(pn, v_inicio, abs(v_imp) - v_desc, false, 'Descuento de pagos ya aplicados', u);
        end if;
      end if;
    end if;
  end if;
  -- Lo que quedó sin dueño (se borró, o la fecha cambió): se da de baja para que no se vea como una excepción vigente.
  update flujo_ajustes set reemplazado_en = now()
  where origen_tipo = 'PROYECCION' and origen_id = p_id and reemplazado_en is null
    and ocurrencia ~ '^\d{4}-\d{2}-\d{2}$' and ocurrencia::date > p_ocurrencia;
  perform registrar_auditoria(u, 'PROYECCION_CAMBIAR', 'PROYECCION', p_id::text,
    'Desde el ' || p_ocurrencia || ' · ' || p_accion || coalesce(' · importe ' || p_importe, '') || coalesce(' · al ' || p_fecha, '') ||
    coalesce(' · serie nueva ' || v_nueva, '') || ' · ' || p_motivo);
  return v_nueva;
end $$;

-- ---------------------------------------------------------------- 1. registrar_pago (0036) con la proyección

create or replace function registrar_pago(p_datos jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  u usuarios; e empresas; v_id uuid; v_importe numeric; v_restante numeric; v_fid uuid;
  f facturas; v_pendiente numeric; v_aplica numeric; v_completas integer := 0;
  v_prov uuid; v_medio metodo_pago; v_n_facturas integer; v_proy uuid;
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
  v_proy := nullif(p_datos ->> 'proyeccion_id', '')::uuid;
  if v_proy is not null and v_n_facturas > 0 then
    raise exception 'Un pago con facturas vinculadas no se asocia a una proyección del Flujo';
  end if;
  if v_proy is not null and coalesce(p_datos ->> 'proyeccion_ocurrencia', '') = '' then
    raise exception 'Falta la fecha de la ocurrencia de la proyección';
  end if;

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
                     forma_carga_xubio, estado, comprobante_path, cargado_por, tipo_cheque, tipo_pago)
  values (e.id, v_prov, (p_datos ->> 'fecha')::date, v_importe,
          v_medio, p_datos ->> 'cuenta_origen', p_datos ->> 'banco_destino', p_datos ->> 'numero_cheque',
          (p_datos ->> 'fecha_acreditacion')::date, p_datos ->> 'descripcion', p_datos ->> 'observaciones', p_datos ->> 'cuenta_contable',
          p_datos ->> 'sugerencia_origen', (p_datos ->> 'sugerencia_confianza')::numeric,
          coalesce((p_datos ->> 'forma_carga_xubio')::forma_carga_xubio, 'SALIDA_FONDOS'),
          (case when e.erp = 'RALPHARMA' then 'PENDIENTE_RALPHARMA' else 'CARGADO' end)::estado_pago,
          p_datos ->> 'comprobante_path', u.nombre, nullif(upper(p_datos ->> 'tipo_cheque'), ''),
          -- Un pago a un proveedor sin facturas vinculadas espera su factura (ESPERA_FC del Apps Script): queda marcado así.
          -- Los pagos sin proveedor (banco, impuestos) no esperan nada.
          case when v_n_facturas = 0 and v_prov is not null then 'SIN_FACTURA' end)
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

  -- 1. (0041) La proyección del Flujo que cubre este pago.
  if v_proy is not null then
    perform aplicar_pago_a_proyeccion(v_id, v_proy, (p_datos ->> 'proyeccion_ocurrencia')::date, u);
  end if;

  -- 6. Aviso de posible duplicado (no bloquea) y 7. la fila del cheque.
  update pagos set posible_duplicado = posible_duplicado_pago(v_id), aviso_cheque = crear_cheque_de_pago(v_id, u) where id = v_id;
  if (select posible_duplicado from pagos where id = v_id) is not null then
    perform registrar_auditoria(u, 'POSIBLE_DUPLICADO', 'PAGO', v_id::text, (select posible_duplicado from pagos where id = v_id));
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- 1. anular_pago (0011) devuelve el importe a la proyección

create or replace function anular_pago(p_id uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; p pagos; r record;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Falta el motivo de la anulación'; end if;
  select * into p from pagos where id = p_id for update;
  if p.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.gestion = 'HOJA' then raise exception 'Este pago viene de la hoja del Apps Script: se anula ahí'; end if;
  if p.estado::text not in ('CARGADO', 'REVISADO', 'PENDIENTE_RALPHARMA') then
    raise exception 'Un pago % no se anula acá: si ya está en Xubio, anulalo primero en Xubio', p.estado;
  end if;
  if p.envio_xubio_en is not null then raise exception 'El pago se está enviando a Xubio: esperá el resultado'; end if;

  for r in select factura_id, importe from pagos_facturas where pago_id = p_id loop
    update facturas set pagado = greatest(0, pagado - r.importe),
      estado = case when pagado - r.importe <= 0 then 'PARA_PAGAR' else 'PAGADA_PARCIAL' end::estado_factura,
      actualizado_en = now()
    where id = r.factura_id;
  end loop;
  delete from pagos_facturas where pago_id = p_id;
  update pagos set estado = 'ANULADO', anulado_por = u.nombre, anulado_en = now(), motivo_anulacion = trim(p_motivo)
  where id = p_id;
  -- (0041) Lo que este pago había descontado de una proyección vuelve a ella.
  perform devolver_pago_a_proyeccion(p_id, u);
  perform registrar_auditoria(u, 'PAGO_ANULADO', 'PAGO', p_id::text, trim(p_motivo));
end $$;

-- ---------------------------------------------------------------- 2. Aprobar con fecha de pago

-- La aprobación de 0036 con la fecha de pago. p_exigir_fecha = false la deja como antes (aprobación de una factura que
-- ya está pagada). Con la fecha: se guarda el vencimiento original una sola vez, y la fecha nueva
-- queda como fecha de pago y como vencimiento.
create or replace function aprobar_factura_interna(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer, p_tarjeta_directa boolean,
                                                   p_fecha_pago date, p_exigir_fecha boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; f facturas; e empresas; v_saltar boolean; v_tarjeta boolean; v_fecha date;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');   -- Dirección ve todo pero no modifica
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado <> 'PENDIENTE_APROBACION' then raise exception 'La factura no está pendiente de aprobación'; end if;
  if coalesce(p_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
  -- Salvo cheque (su fecha sale de los días del cheque), tarjeta (nace pagada) y notas de crédito (no se pagan), la fecha de pago es obligatoria.
  if p_exigir_fecha and p_metodo not in ('CHEQUE', 'ECHEQ', 'TARJETA') and f.tipo not ilike 'nota de cr%' then
    if p_fecha_pago is null then raise exception 'Falta la fecha de pago: es obligatoria salvo que se pague con cheque'; end if;
    if p_fecha_pago < hoy_ar() then
      raise exception 'La fecha de pago no puede ser anterior a hoy (%)', to_char(hoy_ar(), 'DD/MM/YYYY');
    end if;
    if p_fecha_pago > hoy_ar() + 365 then raise exception 'La fecha de pago no puede ser a más de un año (%)', to_char(p_fecha_pago, 'DD/MM/YYYY'); end if;
    v_fecha := p_fecha_pago;
  end if;
  select * into e from empresas where id = f.empresa_id;
  select coalesce(bool_or(pe.saltar_xubio), false) into v_saltar from proveedores_empresa pe
  where pe.proveedor_id = f.proveedor_id and pe.empresa_id = f.empresa_id;
  -- Tarjeta de crédito: se paga con el resumen de la tarjeta, así que nace pagada (una nota de crédito no).
  v_tarjeta := p_tarjeta_directa and p_metodo = 'TARJETA' and f.tipo not ilike 'nota de cr%';
  update facturas set
    estado = (case when v_tarjeta then 'PAGADA' else 'PARA_PAGAR' end)::estado_factura,
    pagado = case when v_tarjeta then total else pagado end,
    fecha_pago = case when v_tarjeta then hoy_ar() when v_fecha is not null then v_fecha else fecha_pago end,
    vencimiento_factura = case when v_fecha is not null then coalesce(vencimiento_factura, vencimiento, fecha) else vencimiento_factura end,
    vencimiento = case when v_fecha is not null then v_fecha else vencimiento end,
    cuenta_contable = p_cuenta, metodo_pago = p_metodo, dias_cheque = p_dias,
    aprobado_por = u.nombre, aprobado_en = now(), actualizado_en = now(),
    estado_xubio = (case when e.erp = 'XUBIO'
                         then (case when estado_xubio = 'SUBIDA' then 'SUBIDA' when v_saltar then 'SIN_ERP' else 'PENDIENTE' end)
                         else 'PENDIENTE_RALPHARMA' end)::estado_xubio
  where id = p_id;
  insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, metodo_pago, veces, actualizado_por)
  values (f.proveedor_id, f.empresa_id, p_cuenta, p_metodo, 1, u.nombre)
  on conflict (proveedor_id, empresa_id) do update set
    cuenta_contable = excluded.cuenta_contable, metodo_pago = excluded.metodo_pago,
    veces = proveedores_empresa.veces + 1, actualizado_por = excluded.actualizado_por, actualizado_en = now();
  perform registrar_auditoria(u, 'APROBACION', 'FACTURA', p_id::text,
    'Cuenta ' || p_cuenta || ' · ' || p_metodo
    || case when v_fecha is not null then ' · fecha de pago ' || to_char(v_fecha, 'DD/MM/YYYY') else '' end
    || case when v_tarjeta then ' · tarjeta de crédito: queda pagada' else '' end
    || case when v_saltar and e.erp = 'XUBIO' then ' · el proveedor no va a Xubio' else '' end);
  return jsonb_build_object(
    'estado', (select estado from facturas where id = p_id),
    'estado_xubio', (select estado_xubio from facturas where id = p_id),
    'tarjeta', v_tarjeta,
    'fecha_pago', v_fecha);
end $$;

-- La de 5 argumentos de 0036 queda igual para quien no tiene fecha (aprobar ya pagada, servidor, pruebas anteriores).
create or replace function aprobar_factura_interna(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer, p_tarjeta_directa boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return aprobar_factura_interna(p_id, p_cuenta, p_metodo, p_dias, p_tarjeta_directa, null, false);
end $$;

-- Las que llama la pantalla: sin valor por defecto en la fecha (así no se confunden con las de 4 argumentos, que quedan solo para el servidor).
create or replace function aprobar_factura(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer, p_fecha_pago date)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform aprobar_factura_interna(p_id, p_cuenta, p_metodo, p_dias, true, p_fecha_pago, true);
end $$;

create or replace function aprobar_factura_y_vincular(p_id uuid, p_cuenta text, p_metodo metodo_pago, p_dias integer, p_fecha_pago date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; r jsonb; f facturas; v_ids uuid[]; v_n integer; v jsonb; v_msg text;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  r := aprobar_factura_interna(p_id, p_cuenta, p_metodo, p_dias, true, p_fecha_pago, true);
  select * into f from facturas where id = p_id;
  if f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.tipo not ilike 'nota de cr%' then
    select array_agg(s.pago_id order by s.fecha, s.pago_id) into v_ids from pagos_sin_factura s
    where s.empresa_id = f.empresa_id and s.proveedor_id = f.proveedor_id;
    v_n := coalesce(array_length(v_ids, 1), 0);
    if v_n > 1 then
      v_msg := 'Hay ' || v_n || ' pagos sin factura de este proveedor: vinculá el que corresponda desde la factura en Para pagar.';
    elsif v_n = 1 then
      begin
        v := vincular_pago_interno(v_ids[1], p_id, u);
        v_msg := 'Se vinculó sola con el pago sin factura de este proveedor.'
                 || case when (v ->> 'sobra')::numeric >= 1 then ' Ojo: el pago es $ ' || (v ->> 'sobra') || ' mayor que el saldo de la factura.' else '' end;
        r := r || jsonb_build_object('vinculado', true, 'pago', v_ids[1]);
      exception when others then
        v_msg := 'Hay un pago sin factura de este proveedor pero no se pudo vincular solo (' || sqlerrm || '): vinculalo desde Para pagar.';
      end;
    end if;
  end if;
  return r || jsonb_build_object('mensaje', v_msg);
end $$;

-- ---------------------------------------------------------------- 3. CUIT propios (valen para toda la organización)

create table if not exists cuits_propios (
  empresa_id  text not null references empresas,
  cuit        text not null check (cuit ~ '^[0-9]{11}$'),
  nombre      text,
  activo      boolean not null default true,
  creado_por  text not null default 'migración 0041',
  creado_en   timestamptz not null default now(),
  primary key (empresa_id, cuit)
);
alter table cuits_propios enable row level security;
drop policy if exists leer_cuits_propios on cuits_propios;
create policy leer_cuits_propios on cuits_propios for select to authenticated using (empresa_id in (select empresas_visibles()));
revoke all on cuits_propios from public, anon, authenticated;
grant select on cuits_propios to authenticated;
grant all on cuits_propios to service_role;

-- Los de la lista de la empresa: Beratung y Vértice como los dio Tesorería; India es el de su alta en configurar_equipo.sql
-- (se corrige con definir_cuit_propio si no es). Solo si la empresa existe, y sin pisar lo que ya haya.
insert into cuits_propios (empresa_id, cuit, nombre)
select e.id, v.cuit, v.nombre from (values
  ('beratung', '33716515929', 'Beratung S.A.'),
  ('vertice',  '30719561507', 'Vértice BI S.A.'),
  ('india',    '30718077180', 'INDIA ADV S.A.')
) as v(id, cuit, nombre)
join empresas e on e.id = v.id
on conflict (empresa_id, cuit) do nothing;

-- Solo ADMIN: cambia qué movimientos se dan por entre cuentas propias.
create or replace function definir_cuit_propio(p_empresa text, p_cuit text, p_nombre text default null, p_activo boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v_cuit text := regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g');
begin
  u := exigir_rol('ADMIN');
  perform exigir_empresa(p_empresa);
  if length(v_cuit) <> 11 then raise exception 'El CUIT tiene que tener 11 dígitos'; end if;
  insert into cuits_propios (empresa_id, cuit, nombre, activo, creado_por) values (p_empresa, v_cuit, nullif(trim(p_nombre), ''), coalesce(p_activo, true), u.email)
  on conflict (empresa_id, cuit) do update set nombre = coalesce(nullif(trim(p_nombre), ''), cuits_propios.nombre), activo = coalesce(p_activo, true);
  perform registrar_auditoria(u, 'CUIT_PROPIO', 'EMPRESA', p_empresa, v_cuit || case when coalesce(p_activo, true) then '' else ' · desactivado' end);
end $$;

-- Marca como transferencia entre cuentas propias los movimientos que siguen sin clasificar y sin documento después de conciliar,
-- cuya descripción es una transferencia (no VEP, AFIP, impuestos ni retenciones, donde el CUIT es el del contribuyente) y nombra
-- un CUIT propio. Los CUIT propios valen para toda la organización: el de Beratung es propio también visto desde India.
-- Con p_extracto solo mira los de ese archivo; con p_desde, los de esa fecha en adelante.
create or replace function reconocer_cuentas_propias_interna(p_empresa text, p_extracto uuid, p_desde date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with propios as (
    select e2.cuit::text as cuit from empresas e1 join empresas e2 on e2.organizacion_id = e1.organizacion_id
    where e1.id = p_empresa and e2.cuit::text ~ '^[0-9]{11}$' and e2.cuit::text !~ '^0+[0-9]$'
    union
    select c.cuit from cuits_propios c join empresas e2 on e2.id = c.empresa_id join empresas e1 on e1.organizacion_id = e2.organizacion_id
    where e1.id = p_empresa and c.activo
  ), cand as (
    select m.id from movimientos_bancarios m
    where m.empresa_id = p_empresa and m.categoria = 'SIN_CLASIFICAR' and m.estado = 'A_REVISAR'
      and m.pago_id is null and m.cobro_id is null and m.cheque_id is null and m.factura_id is null and m.asiento_id is null
      and m.contraparte_cuenta_id is null and not movimiento_vinculado(m.id)
      and (p_extracto is null or m.extracto_id = p_extracto) and (p_desde is null or m.fecha >= p_desde)
      and texto_banco(m.descripcion) ~ '(TRANSF|CBU)'
      and texto_banco(m.descripcion) !~ '((^| )(VEP|AFIP|ARCA|DGR|ARBA|AGIP|DGI)( |$))|IMPUEST|RETENC|RENTAS|SIRCREB'
      and exists (select 1 from propios x
                  where regexp_replace(coalesce(m.descripcion, ''), '([0-9]{2})-([0-9]{8})-([0-9])', '\1\2\3', 'g') ~ ('(^|[^0-9])' || x.cuit || '([^0-9]|$)'))
  )
  update movimientos_bancarios m set categoria = 'TRANSFERENCIA_PROPIA', estado = 'PENDIENTE', destino_xubio = 'NINGUNO', propia_por_cuit = true
  from cand where m.id = cand.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Pasa por la conciliación antes (para no tocar lo que se vincula con un pago, cheque o cobro).
create or replace function reconocer_cuentas_propias(p_empresa text, p_desde date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare u usuarios; n integer;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  perform exigir_empresa(p_empresa);
  perform conciliar_movimientos(p_empresa);
  n := reconocer_cuentas_propias_interna(p_empresa, null, p_desde);
  perform registrar_auditoria(u, 'CUENTAS_PROPIAS', 'EMPRESA', p_empresa, n || ' movimiento(s) reconocidos como transferencia entre cuentas propias');
  return n;
end $$;

-- La conciliación (0032) le pone a una TRANSFERENCIA_PROPIA "el único fondo" de la cuenta madre como contraparte. Una transferencia
-- reconocida por CUIT casi siempre va a una cuenta de otro banco, no al fondo: ese automático no se aplica. Si Tesorería la
-- asigna a mano (asignar_contraparte deja revisado_en) sí vale.
create or replace function movimiento_propia_sin_fondo_automatico()
returns trigger language plpgsql as $$
begin
  if new.propia_por_cuit and new.contraparte_cuenta_id is not null and new.revisado_en is not distinct from old.revisado_en
     and exists (select 1 from cuentas_origen f where f.id = new.contraparte_cuenta_id and f.clase in ('FCI', 'REMUNERADA') and f.cuenta_madre_id = new.cuenta_origen_id) then
    new.contraparte_cuenta_id := old.contraparte_cuenta_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_propia_sin_fondo on movimientos_bancarios;
create trigger trg_propia_sin_fondo before update of contraparte_cuenta_id on movimientos_bancarios
  for each row execute function movimiento_propia_sin_fondo_automatico();

-- ---------------------------------------------------------------- 4. El mismo extracto en la cuenta de otra empresa

-- ¿Ya está este extracto en una cuenta de OTRA empresa de la organización? Por la huella del archivo, o por el contenido (el mismo
-- extracto bajado de nuevo cambia de bytes): más de la mitad de sus movimientos (fecha, importe y descripción) ya están en una
-- cuenta de otra empresa. Un archivo de pocos movimientos puede coincidir de casualidad: por eso el aviso se puede confirmar. p: { cuenta_origen_id, hash, movimientos: [{ fecha, importe, descripcion }] }.
-- Devuelve null o { motivo: ARCHIVO | MOVIMIENTOS, cuenta, empresa, coinciden, total }.
create or replace function extracto_duplicado_en_otra_empresa(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c cuentas_origen; r record; v_total integer;
begin
  select * into c from cuentas_origen where id = (p->>'cuenta_origen_id')::uuid;
  if c.id is null then return null; end if;
  if coalesce(p->>'hash', '') <> '' then
    select co.nombre as cuenta, ex.nombre_corto as empresa into r
    from extractos x join empresas ex on ex.id = x.empresa_id
    join empresas ec on ec.id = c.empresa_id and ec.organizacion_id = ex.organizacion_id
    join cuentas_origen co on co.id = x.cuenta_origen_id
    where x.archivo_hash = p->>'hash' and x.empresa_id <> c.empresa_id
    order by x.importado_en limit 1;
    if r.cuenta is not null then return jsonb_build_object('motivo', 'ARCHIVO', 'cuenta', r.cuenta, 'empresa', r.empresa); end if;
  end if;
  with k as (
    select distinct (t.x->>'fecha')::date as f, round((t.x->>'importe')::numeric, 2) as i, texto_banco(t.x->>'descripcion') as d
    from jsonb_array_elements(coalesce(p->'movimientos', '[]'::jsonb)) as t(x)
  )
  select count(*) into v_total from k;
  if v_total < 1 then return null; end if;
  with k as (
    select distinct (t.x->>'fecha')::date as f, round((t.x->>'importe')::numeric, 2) as i, texto_banco(t.x->>'descripcion') as d
    from jsonb_array_elements(coalesce(p->'movimientos', '[]'::jsonb)) as t(x)
  )
  select co.nombre as cuenta, ex.nombre_corto as empresa, count(distinct (k.f, k.i, k.d)) as n into r
  from k
  join movimientos_bancarios m on m.fecha = k.f and m.importe = k.i and texto_banco(m.descripcion) = k.d and m.estado <> 'IGNORADO' and m.empresa_id <> c.empresa_id
  join empresas ex on ex.id = m.empresa_id
  join empresas ec on ec.id = c.empresa_id and ec.organizacion_id = ex.organizacion_id
  join cuentas_origen co on co.id = m.cuenta_origen_id
  group by co.nombre, ex.nombre_corto
  order by n desc limit 1;
  if r.cuenta is not null and r.n * 2 > v_total then
    return jsonb_build_object('motivo', 'MOVIMIENTOS', 'cuenta', r.cuenta, 'empresa', r.empresa, 'coinciden', r.n, 'total', v_total);
  end if;
  return null;
end $$;

-- Igual que 0031 con tres agregados:
--   · el mismo extracto (por archivo o por contenido) no entra en la cuenta de otra empresa de la organización
--     (p->>'confirmar_otra_empresa' = 'true' lo deja pasar; el mensaje empieza con [OTRA_EMPRESA]);
--   · al final, y después de conciliar, lo que sigue sin clasificar y nombra un CUIT propio pasa a transferencia entre cuentas propias.
create or replace function importar_extracto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c cuentas_origen; v_ext uuid; v_nuevos int := 0; v_total int := 0; v_revisar int := 0; v_migrados int := 0; m record; r reglas_extracto;
  v_huella text; v_id uuid; v_usuario text := coalesce(p->>'usuario', 'servidor');
  v_desde date; v_hasta date; v_origen text := coalesce(nullif(p->>'origen_saldos', ''), 'EXTRACTO'); v_saldos int;
  v_dup jsonb; v_propias int := 0;
begin
  select * into c from cuentas_origen where id = (p->>'cuenta_origen_id')::uuid;
  if c.id is null then raise exception 'Cuenta bancaria inexistente'; end if;
  perform exigir_empresa(c.empresa_id);
  if coalesce(p->'archivo'->>'hash', '') = '' then raise exception 'Falta la huella del archivo'; end if;
  if v_origen not in ('EXTRACTO', 'TENENCIA') then raise exception 'Origen de saldos inválido: %', v_origen; end if;
  if v_origen = 'TENENCIA' and c.clase not in ('FCI', 'REMUNERADA') then
    raise exception 'Una tenencia va a una cuenta FCI o remunerada, no a % (%)', c.nombre, c.clase;
  end if;
  if v_origen = 'TENENCIA' and jsonb_array_length(coalesce(p->'movimientos', '[]')) > 0 then
    raise exception 'Una tenencia trae solo saldos: los movimientos del fondo entran por la cuenta madre';
  end if;

  select id into v_ext from extractos where cuenta_origen_id = c.id and archivo_hash = p->'archivo'->>'hash';
  if v_ext is not null then
    return jsonb_build_object('extracto_id', v_ext, 'repetido', true, 'movimientos', 0, 'nuevos', 0, 'a_revisar', 0,
                              'saldos', 0, 'origen_saldos', v_origen, 'ya_migrados', 0, 'cuentas_propias', 0);
  end if;
  -- (0041) El mismo extracto ya cargado en una cuenta de OTRA empresa de la organización: casi seguro es la cuenta equivocada.
  if coalesce(p->>'confirmar_otra_empresa', '') <> 'true' then
    v_dup := extracto_duplicado_en_otra_empresa(jsonb_build_object('cuenta_origen_id', c.id, 'hash', p->'archivo'->>'hash', 'movimientos', coalesce(p->'movimientos', '[]'::jsonb)));
    if v_dup is not null then
      raise exception '[OTRA_EMPRESA] Este extracto % en la cuenta % de %: no se importa en % (¿cuenta equivocada?)',
        case when v_dup->>'motivo' = 'ARCHIVO' then 'ya está cargado'
             else 'parece ya cargado (' || (v_dup->>'coinciden') || ' de ' || (v_dup->>'total') || ' movimientos iguales)' end,
        v_dup->>'cuenta', v_dup->>'empresa', c.nombre;
    end if;
  end if;
  select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(coalesce(p->'movimientos', '[]')) x;
  if v_desde is null then
    select min((x->>'fecha')::date), max((x->>'fecha')::date) into v_desde, v_hasta from jsonb_array_elements(coalesce(p->'saldos', '[]')) x;
  end if;
  insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_path, archivo_hash, formato, desde, hasta, importado_por)
  values (c.empresa_id, c.id, p->'archivo'->>'nombre', p->'archivo'->>'path', p->'archivo'->>'hash', p->'archivo'->>'formato',
          v_desde, v_hasta, v_usuario)
  returning id into v_ext;

  -- La huella: fecha|importe|descripción|referencia|n.º de orden entre los iguales. El orden sale de la misma
  -- clave (y, entre iguales, de la posición en el archivo).
  perform set_config('tesoreria.conciliar_al_final', '1', true);
  for m in
    select z.x, z.clave, z.fecha, z.importe, z.texto,
           (row_number() over (partition by z.clave order by z.n) - 1)::int as orden,
           (row_number() over (partition by z.fecha, z.importe, z.texto order by z.clave, z.n) - 1)::int as orden_sin_ref
    from (
      select t.x, t.n, (t.x->>'fecha')::date as fecha, round((t.x->>'importe')::numeric, 2) as importe, texto_banco(t.x->>'descripcion') as texto,
             concat_ws('|', t.x->>'fecha', round((t.x->>'importe')::numeric, 2), texto_banco(t.x->>'descripcion'), coalesce(t.x->>'referencia', '')) as clave
      from jsonb_array_elements(coalesce(p->'movimientos', '[]')) with ordinality as t(x, n)
    ) z
    order by z.clave, z.n
  loop
    v_total := v_total + 1;
    -- ¿Ya entró por la migración desde planillas? (uno del archivo por cada migrado igual)
    if m.orden_sin_ref < (select count(*) from movimientos_bancarios l
                          where l.cuenta_origen_id = c.id and l.fecha = m.fecha and l.importe = m.importe
                            and texto_banco(l.descripcion) = m.texto
                            and (l.huella like 'VBI:%' or l.huella like 'MOTOR:%' or l.huella like 'LEGADO-%')) then
      v_migrados := v_migrados + 1;
      continue;
    end if;
    v_huella := md5(m.clave || '|' || m.orden);
    r := regla_para_movimiento(c.id, m.x->>'descripcion', (m.x->>'importe')::numeric);
    insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, saldo, referencia, numero_cheque,
                                       huella, extracto_id, orden, categoria, cuenta_contable, regla_id, destino_xubio, componente, estado)
    values (c.empresa_id, c.id, m.fecha, m.x->>'descripcion', m.importe,
            (m.x->>'saldo')::numeric, m.x->>'referencia', nullif(m.x->>'numero_cheque', ''), v_huella, v_ext, m.orden,
            coalesce(r.categoria, 'SIN_CLASIFICAR'), r.cuenta_contable, r.id, coalesce(r.destino_xubio, 'NINGUNO'), r.componente,
            case when r.id is null then 'A_REVISAR' when r.categoria = 'INFORMATIVO' then 'INFORMATIVO' else 'PENDIENTE' end)
    on conflict (cuenta_origen_id, huella) do nothing
    returning id into v_id;
    if v_id is not null then
      v_nuevos := v_nuevos + 1;
      if r.id is null then v_revisar := v_revisar + 1; end if;
      v_id := null;
    end if;
  end loop;
  -- Vincular cada movimiento con su pago, cheque o cobro: una vez, con todo el archivo adentro.
  perform set_config('tesoreria.conciliar_al_final', '', true);
  if v_nuevos > 0 then perform conciliar_movimientos(c.empresa_id); end if;
  -- (0041) Transferencias entre cuentas propias reconocidas por el CUIT, sobre lo que quedó sin documento.
  if v_revisar > 0 then
    v_propias := reconocer_cuentas_propias_interna(c.empresa_id, v_ext, null);
  end if;
  v_revisar := (select count(*) from movimientos_bancarios where extracto_id = v_ext and estado = 'A_REVISAR');

  -- Saldos de cierre: los que informa el archivo; si no, el saldo del último movimiento de cada día.
  -- Un saldo cargado a mano (MANUAL) no se pisa.
  insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, extracto_id, cargado_por)
  select c.id, d.fecha, c.empresa_id, d.saldo, v_origen, v_ext, v_usuario
  from (
    select (x->>'fecha')::date as fecha, (x->>'saldo')::numeric as saldo from jsonb_array_elements(coalesce(p->'saldos', '[]')) x
    union all
    (select distinct on ((t.x->>'fecha')::date) (t.x->>'fecha')::date, (t.x->>'saldo')::numeric
     from jsonb_array_elements(coalesce(p->'movimientos', '[]')) with ordinality as t(x, n)
     where t.x->>'saldo' is not null and jsonb_array_length(coalesce(p->'saldos', '[]')) = 0
     order by (t.x->>'fecha')::date, t.n desc)
  ) d
  on conflict (cuenta_origen_id, fecha) do update
    set saldo = excluded.saldo, origen = excluded.origen, extracto_id = excluded.extracto_id,
        cargado_por = excluded.cargado_por, cargado_en = now()
    where saldos_bancarios.origen <> 'MANUAL';
  get diagnostics v_saldos = row_count;

  update extractos set movimientos = v_total, nuevos = v_nuevos where id = v_ext;
  insert into auditoria (usuario, accion, entidad, entidad_id, detalle, empresa_id)
  values (v_usuario, case when v_origen = 'TENENCIA' then 'IMPORTAR_TENENCIA' else 'IMPORTAR_EXTRACTO' end, 'EXTRACTO', v_ext::text,
          c.nombre || ': ' || case when v_origen = 'TENENCIA' then v_saldos || ' saldo(s) de tenencia'
                                   else v_nuevos || ' nuevos de ' || v_total end
            || case when v_migrados > 0 then ' (' || v_migrados || ' ya migrados de la planilla)' else '' end
            || case when v_propias > 0 then ' · ' || v_propias || ' entre cuentas propias (CUIT propio)' else '' end
            || case when coalesce(p->>'confirmar_otra_empresa', '') = 'true' then ' · confirmado a pesar de estar en otra empresa' else '' end, c.empresa_id);
  return jsonb_build_object('extracto_id', v_ext, 'repetido', false, 'movimientos', v_total, 'nuevos', v_nuevos,
                            'a_revisar', v_revisar, 'saldos', v_saldos, 'origen_saldos', v_origen, 'ya_migrados', v_migrados,
                            'cuentas_propias', v_propias);
end $$;

-- Deshacer un extracto importado en la cuenta equivocada: borra el archivo importado, sus movimientos y sus saldos.
-- Solo si ninguno de sus movimientos está conciliado (pago, cobro, cheque, lote, comprobante) ni en un asiento ni contabilizado.
create or replace function borrar_extracto(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u usuarios; e extractos; v_bloq integer; v_movs integer; v_saldos integer;
begin
  u := exigir_rol('ADMIN', 'TESORERIA');
  select * into e from extractos where id = p_id for update;
  if e.id is null then raise exception 'Ese extracto ya no existe'; end if;
  perform exigir_empresa(e.empresa_id);
  select count(*) into v_bloq from movimientos_bancarios m
  where m.extracto_id = p_id
    and (m.pago_id is not null or m.cobro_id is not null or m.cheque_id is not null or m.factura_id is not null or m.asiento_id is not null
         or m.estado in ('CONTABILIZADO', 'CARGADO_A_MANO') or movimiento_vinculado(m.id)
         or exists (select 1 from transferencias_propias t where t.mov_salida_id = m.id or t.mov_entrada_id = m.id));
  if v_bloq > 0 then
    raise exception 'No se puede deshacer: % movimiento(s) de este extracto ya están conciliados, en un asiento o contabilizados', v_bloq;
  end if;
  begin
    delete from saldos_bancarios where extracto_id = p_id and origen <> 'MANUAL';
    get diagnostics v_saldos = row_count;
    update saldos_bancarios set extracto_id = null where extracto_id = p_id;
    delete from movimientos_bancarios where extracto_id = p_id;
    get diagnostics v_movs = row_count;
    delete from extractos where id = p_id;
  exception when foreign_key_violation then
    raise exception 'No se puede deshacer: algo del sistema usa este extracto (%)', sqlerrm;
  end;
  perform registrar_auditoria(u, 'EXTRACTO_DESHECHO', 'EXTRACTO', p_id::text, e.archivo_nombre || ' · ' || v_movs || ' movimiento(s) y ' || v_saldos || ' saldo(s) borrados');
  return jsonb_build_object('movimientos', v_movs, 'saldos', v_saldos, 'archivo_path', e.archivo_path);
end $$;

-- ---------------------------------------------------------------- Permisos
-- Las funciones nuevas no dan EXECUTE por defecto (0021, 0035).

revoke execute on function
  proyeccion_estado_ocurrencia(proyecciones, date),
  proyeccion_poner_ajuste(proyecciones, date, numeric, boolean, text, usuarios),
  pago_cuenta_en_flujo(pagos),
  efectuar_descuento_proyeccion(uuid, usuarios),
  aplicar_pago_a_proyeccion(uuid, uuid, date, usuarios),
  devolver_pago_a_proyeccion(uuid, usuarios),
  pago_aplica_proyeccion_pendiente(),
  movimiento_propia_sin_fondo_automatico(),
  aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean),
  aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean, date, boolean),
  reconocer_cuentas_propias_interna(text, uuid, date),
  extracto_duplicado_en_otra_empresa(jsonb)
from public, anon, authenticated;
grant execute on function
  proyeccion_estado_ocurrencia(proyecciones, date),
  proyeccion_poner_ajuste(proyecciones, date, numeric, boolean, text, usuarios),
  pago_cuenta_en_flujo(pagos),
  efectuar_descuento_proyeccion(uuid, usuarios),
  aplicar_pago_a_proyeccion(uuid, uuid, date, usuarios),
  devolver_pago_a_proyeccion(uuid, usuarios),
  pago_aplica_proyeccion_pendiente(),
  aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean),
  aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean, date, boolean),
  reconocer_cuentas_propias_interna(text, uuid, date),
  extracto_duplicado_en_otra_empresa(jsonb)
to service_role;

-- Las firmas de 4 argumentos de la aprobación (sin fecha de pago) ya no las usa la pantalla: solo el servidor.
revoke execute on function
  aprobar_factura(uuid, text, metodo_pago, integer),
  aprobar_factura_y_vincular(uuid, text, metodo_pago, integer)
from public, anon, authenticated;
grant execute on function
  aprobar_factura(uuid, text, metodo_pago, integer),
  aprobar_factura_y_vincular(uuid, text, metodo_pago, integer)
to service_role;

-- registrar_pago y anular_pago se redefinieron arriba: se les quita el EXECUTE que traían de PUBLIC (y con él, anon).
revoke execute on function registrar_pago(jsonb), anular_pago(uuid, text) from public, anon;
grant execute on function registrar_pago(jsonb), anular_pago(uuid, text) to authenticated, service_role;

revoke execute on function
  proyecciones_para_pago(text),
  asociar_pago_proyeccion(uuid, uuid, date),
  aprobar_factura(uuid, text, metodo_pago, integer, date),
  aprobar_factura_y_vincular(uuid, text, metodo_pago, integer, date),
  definir_cuit_propio(text, text, text, boolean),
  reconocer_cuentas_propias(text, date),
  cambiar_proyeccion(uuid, date, text, text, numeric, date, text),
  borrar_extracto(uuid)
from public, anon;
grant execute on function
  proyecciones_para_pago(text),
  asociar_pago_proyeccion(uuid, uuid, date),
  aprobar_factura(uuid, text, metodo_pago, integer, date),
  aprobar_factura_y_vincular(uuid, text, metodo_pago, integer, date),
  definir_cuit_propio(text, text, text, boolean),
  reconocer_cuentas_propias(text, date),
  cambiar_proyeccion(uuid, date, text, text, numeric, date, text),
  borrar_extracto(uuid)
to authenticated, service_role;

revoke execute on function importar_extracto(jsonb) from public, anon, authenticated;
grant execute on function importar_extracto(jsonb) to service_role;
