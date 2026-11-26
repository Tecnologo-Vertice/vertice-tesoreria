-- T-206 · Ajustes que salieron del simulacro del período en paralelo (noviembre 2026, datos reales en local).
--
-- Se corrió la base con los datos reales del 02/11 al 25/11 y se comparó, día por día, contra la fila
-- "Conciliación Bancaria" del Flujo original y contra Conciliacion_Diaria de VBI+. Las causas de los días que no
-- cerraban y que son reglas de la base se corrigen acá:
--
--   1. El pago y su débito en el banco se contaban dos veces. El extracto trae el débito (VBI+ lo marca INFORMATIVO
--      o SIN_CLASIFICAR) y el sistema trae el pago: los dos entraban al Flujo como REAL. Ahora el movimiento se
--      VINCULA a su documento (pago, cheque debitado o cobro): mismo importe, misma empresa, misma cuenta si el
--      documento la sabe, y fecha del banco dentro de una ventana corta. Un movimiento vinculado no entra al Flujo
--      (entra su documento); uno sin vincular SÍ entra, sea cual sea su categoría: la plata salió del banco.
--      Antes un débito con categoría PAGO, COBRO o CHEQUE_PAGADO sin documento desaparecía del Flujo.
--   2. El pago vinculado entra el día que lo debitó el banco y en la unidad de esa cuenta (no la fecha que se cargó
--      a mano ni la unidad por defecto de la empresa).
--   3. Los pagos no tenían cuenta bancaria (la copia de la hoja guarda el texto: nombre del banco, "XXXX - 1234",
--      "BANCO_X_CC_1234_EMPRESA …"). Sin cuenta, un pago desde una cuenta de Dax Salud caía en la unidad por defecto
--      de la empresa (Beratung S/Dax). Ahora la base la deduce del texto, sin adivinar: si hay más de una
--      posible, queda vacía (y la toma del movimiento cuando se vincula).
--   4. Suscripción o rescate de FCI desde la cuenta madre: si la cuenta tiene UN solo FCI o remunerada, el
--      movimiento lleva ese FCI como contraparte. Así la conciliación del FCI no confunde la suscripción con
--      rendimiento (antes: toda la suscripción aparecía como "rendimiento" del FCI y como egreso en la CC).
--   5. Destino de los cheques por categoría del acreedor (Cash Flow: P, FCON, FU…): flujo_reglas puede pedir una
--      unidad (si_unidad_id) y los cheques pasan la categoría del acreedor. Así "Cheques Financieras <financiera>" o
--      "Cheques Insumos hospitales" no caen en "Sin clasificar".
--   6. El control del Flujo contra bancos (flujo_control) suma solo lo que mueve un banco: un pago en efectivo
--      (medio CAJA) es real pero no está en ningún extracto.
--   8. Lo REAL que pasó por una cuenta con extracto queda en la unidad de esa cuenta y no se excluye: una regla del
--      Flujo puede elegir su fila, pero no sacarlo de la unidad ni del Flujo (antes una transferencia propia registrada
--      como pago se excluía y el débito vinculado también desaparecía → F).
--   7. Un pago de una cuenta con extracto es REAL cuando el banco lo debita. Si el extracto de esa cuenta ya llegó
--      de ese día (un movimiento o un saldo que no sea MANUAL) y no hay débito vinculado, no entra al Flujo y aparece en la vista pagos_sin_debito
--      (duplicados de la hoja, cuenta equivocada, pagos que no salieron). Antes contaba igual y el control daba F.
--
-- flujo_lineas mantiene sus columnas y agrega dos al final: cuenta_origen_id y afecta_bancos.

-- ---------------------------------------------------------------- 3. La cuenta de un pago, desde el texto de la hoja

-- Sin adivinar: 1) un patrón o el nombre de la cuenta está en el texto (gana el más largo, si es uno solo);
-- 2) el banco está en el texto y es la única cuenta de ese banco; 3) si hay varias del banco, los últimos 4 dígitos
-- del número de cuenta lo deciden; 4) "Caja" / "Efectivo" → la cuenta CAJA si hay una. Si no, null.
create or replace function cuenta_de_pago(p_empresa text, p_cuenta_origen text, p_banco text, p_numero text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  t text := ' ' || regexp_replace(texto_banco(concat_ws(' ', p_cuenta_origen, p_banco, p_numero)), '[^A-Z0-9]+', ' ', 'g') || ' ';
  dig text := right(regexp_replace(coalesce(nullif(p_numero, ''), p_cuenta_origen, ''), '[^0-9]', '', 'g'), 4);
  v uuid[]; n int;
begin
  if trim(t) = '' then return null; end if;
  -- 1. Patrón o nombre contenido en el texto (de 8 letras o más, para no confundir "BANCO" con una cuenta).
  select array_agg(id order by largo desc) into v from (
    select c.id, max(length(x)) as largo
    from cuentas_origen c cross join lateral unnest(c.patrones || texto_banco(c.nombre)) x
    where c.empresa_id = p_empresa and c.activa and c.clase in ('CC', 'CA', 'BILLETERA', 'CAJA')
      and length(x) >= 8 and position(' ' || regexp_replace(x, '[^A-Z0-9]+', ' ', 'g') || ' ' in t) > 0
    group by c.id) z;
  n := coalesce(array_length(v, 1), 0);
  if n = 1 then return v[1]; end if;
  -- 2 y 3. Por banco y, si hace falta, por los últimos dígitos.
  select array_agg(c.id) into v from cuentas_origen c
  where c.empresa_id = p_empresa and c.activa and c.clase in ('CC', 'CA', 'BILLETERA')
    and c.banco is not null
    and (position(' ' || c.banco || ' ' in t) > 0 or (c.banco = 'MP' and position(' MERCADO PAGO ' in t) > 0));
  n := coalesce(array_length(v, 1), 0);
  if n = 1 then return v[1]; end if;
  if n > 1 and length(dig) = 4 then
    select array_agg(c.id) into v from cuentas_origen c
    where c.id = any(v) and (position(dig in regexp_replace(c.nombre || ' ' || coalesce(c.numero, ''), '[^0-9]', '', 'g')) > 0);
    if coalesce(array_length(v, 1), 0) = 1 then return v[1]; end if;
  end if;
  -- 4. Efectivo.
  if n = 0 and (position(' CAJA ' in t) > 0 or position(' EFECTIVO ' in t) > 0) then
    select array_agg(c.id) into v from cuentas_origen c where c.empresa_id = p_empresa and c.activa and c.clase = 'CAJA';
    if coalesce(array_length(v, 1), 0) = 1 then return v[1]; end if;
  end if;
  return null;
end $$;

create or replace function pago_con_cuenta()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cuenta_origen_id is null then
    new.cuenta_origen_id := cuenta_de_pago(new.empresa_id, new.cuenta_origen, new.banco_origen, new.numero_cuenta);
  end if;
  return new;
end $$;
create trigger trg_pago_con_cuenta before insert or update of cuenta_origen, banco_origen, numero_cuenta, empresa_id on pagos
  for each row execute function pago_con_cuenta();

-- Los pagos que ya están en la base sin cuenta. Devuelve cuántos tomaron una.
create or replace function vincular_pagos_a_cuentas()
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update pagos p set cuenta_origen_id = x.c
  from (select id, cuenta_de_pago(empresa_id, cuenta_origen, banco_origen, numero_cuenta) as c from pagos where cuenta_origen_id is null) x
  where p.id = x.id and x.c is not null;
  get diagnostics n = row_count;
  return n;
end $$;
select vincular_pagos_a_cuentas();

-- ---------------------------------------------------------------- El extracto de una cuenta ya llegó hasta un día

-- El extracto de la cuenta cubre un día si hay evidencia del banco (un movimiento o un saldo que no se cargó a mano:
-- extracto, tenencia, "sin movimientos") ese día o antes Y ese día o después. Un saldo MANUAL (copiado del Flujo
-- viejo) no es evidencia: hasta que no llega el primer extracto de una cuenta, nada está cubierto.
create or replace function extracto_cubre(p_cuenta uuid, p_dia date)
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (select 1 from movimientos_bancarios m where m.cuenta_origen_id = p_cuenta and m.fecha <= p_dia)
          or exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = p_cuenta and s.fecha <= p_dia and s.origen <> 'MANUAL'))
     and (exists (select 1 from movimientos_bancarios m where m.cuenta_origen_id = p_cuenta and m.fecha >= p_dia)
          or exists (select 1 from saldos_bancarios s where s.cuenta_origen_id = p_cuenta and s.fecha >= p_dia and s.origen <> 'MANUAL'))
$$;

-- ---------------------------------------------------------------- 1, 4. Movimiento ↔ documento

-- Ventana: el banco puede debitar hasta 2 días antes de la fecha cargada (el pago se carga después) y hasta 5 días
-- después (transferencia diferida). Gana el más cercano; a igual distancia, el número de cheque y el orden.
create or replace function conciliar_movimientos(p_empresa text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; n_pag int := 0; n_che int := 0; n_cob int := 0; n_fci int := 0;
begin
  -- FCI / remunerada: la contraparte es el único fondo de la cuenta madre (si el fondo no trae ya su propia pata).
  update movimientos_bancarios m set contraparte_cuenta_id = h.id
  from cuentas_origen h
  where m.empresa_id = p_empresa and m.categoria in ('FCI', 'TRANSFERENCIA_PROPIA') and m.contraparte_cuenta_id is null and m.estado <> 'IGNORADO'
    and h.cuenta_madre_id = m.cuenta_origen_id and h.activa and h.clase in ('FCI', 'REMUNERADA')
    and (select count(*) from cuentas_origen h2 where h2.cuenta_madre_id = m.cuenta_origen_id and h2.activa and h2.clase in ('FCI', 'REMUNERADA')) = 1
    and not exists (select 1 from movimientos_bancarios o where o.cuenta_origen_id = h.id and o.fecha = m.fecha and o.importe = -m.importe);
  get diagnostics n_fci = row_count;

  -- Cheques debitados.
  for r in
    select m.id as mid, ch.id as cid
    from movimientos_bancarios m
    join cheques ch on ch.cuenta_origen_id = m.cuenta_origen_id and ch.importe = -m.importe and ch.estado = 'DEBITADO'
                   and ch.movimiento_id is null and m.fecha between ch.debitado_en - 3 and ch.debitado_en + 3
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
    order by (m.numero_cheque is not null and right(regexp_replace(m.numero_cheque, '\D', '', 'g'), 4) = right(regexp_replace(ch.numero, '\D', '', 'g'), 4)) desc,
             abs(m.fecha - ch.debitado_en), m.fecha, m.orden, ch.numero
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cheque_id is null)
       and exists (select 1 from cheques where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cheque_id = r.cid where id = r.mid;
      update cheques set movimiento_id = r.mid where id = r.cid;
      n_che := n_che + 1;
    end if;
  end loop;

  -- Pagos (no cheques ni efectivo: el cheque cuenta cuando se debita; el efectivo no pasa por el banco).
  for r in
    select m.id as mid, p.id as pid
    from movimientos_bancarios m
    join pagos p on p.empresa_id = m.empresa_id and p.importe = -m.importe and p.estado <> 'ANULADO'
                and p.medio not in ('CHEQUE', 'ECHEQ')
                and (p.medio <> 'CAJA' or p.cuenta_origen_id is not null)   -- "Caja" con cuenta de banco: salió por el banco
                and (p.cuenta_origen_id is null or p.cuenta_origen_id = m.cuenta_origen_id)
                and m.fecha between p.fecha - 2 and p.fecha + 5
    where m.empresa_id = p_empresa and m.importe < 0 and m.estado <> 'IGNORADO'
      and m.cheque_id is null and m.pago_id is null and m.cobro_id is null
      and not exists (select 1 from movimientos_bancarios x where x.pago_id = p.id)
    order by abs(m.fecha - p.fecha), (p.cuenta_origen_id is not null) desc, m.fecha, m.orden, p.fecha, p.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and pago_id is null and cheque_id is null)
       and not exists (select 1 from movimientos_bancarios where pago_id = r.pid) then
      update movimientos_bancarios set pago_id = r.pid where id = r.mid;
      n_pag := n_pag + 1;
    end if;
  end loop;

  -- Cobros.
  for r in
    select m.id as mid, c.id as cid
    from movimientos_bancarios m
    join cobros c on c.empresa_id = m.empresa_id and c.importe = m.importe and c.movimiento_id is null
                 and (c.cuenta_origen_id is null or c.cuenta_origen_id = m.cuenta_origen_id)
                 and m.fecha between c.fecha - 3 and c.fecha + 3
    where m.empresa_id = p_empresa and m.importe > 0 and m.estado <> 'IGNORADO'
      and m.cobro_id is null and m.pago_id is null and m.cheque_id is null
    order by abs(m.fecha - c.fecha), m.fecha, m.orden, c.fecha, c.id
  loop
    if exists (select 1 from movimientos_bancarios where id = r.mid and cobro_id is null)
       and exists (select 1 from cobros where id = r.cid and movimiento_id is null) then
      update movimientos_bancarios set cobro_id = r.cid where id = r.mid;
      update cobros set movimiento_id = r.mid where id = r.cid;
      n_cob := n_cob + 1;
    end if;
  end loop;
  return jsonb_build_object('pagos', n_pag, 'cheques', n_che, 'cobros', n_cob, 'fci', n_fci);
end $$;

-- Se concilia solo: al entrar movimientos (extracto), pagos (copia de la hoja o sistema), cobros, y al marcar un
-- cheque debitado. Por sentencia, una vez por empresa afectada.
create or replace function conciliar_tras_cambio()
returns trigger language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  for e in select distinct empresa_id from nuevos loop perform conciliar_movimientos(e); end loop;
  return null;
end $$;
create trigger trg_conciliar_movimientos after insert on movimientos_bancarios
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_pagos_alta after insert on pagos
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_pagos_cambio after update on pagos
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_cobros after insert on cobros
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_cheques after update on cheques
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();
create trigger trg_conciliar_cheques_alta after insert on cheques
  referencing new table as nuevos for each statement execute function conciliar_tras_cambio();

-- Un pago anulado suelta su movimiento (el débito vuelve a contar solo, hasta que se vincule otro documento).
create or replace function soltar_movimiento_de_anulado()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'ANULADO' and old.estado is distinct from 'ANULADO' then
    update movimientos_bancarios set pago_id = null where pago_id = new.id;
  end if;
  return null;
end $$;
create trigger trg_soltar_movimiento_de_anulado after update of estado on pagos
  for each row execute function soltar_movimiento_de_anulado();

-- ---------------------------------------------------------------- 5. Destino por unidad y categoría del acreedor

alter table flujo_reglas add column si_unidad_id uuid references unidades;
alter table acreedores add column categoria text;      -- la del Cash Flow: P (proveedor), F… (financieras)

create or replace function flujo_destino(p_empresa text, p_unidad uuid, p_origen text, p_proveedor uuid,
                                         p_cuenta_contable text, p_cuenta_origen uuid, p_categoria text, p_texto text)
returns table (unidad_id uuid, fila_id uuid, excluir boolean)
language plpgsql stable security definer set search_path = public as $$
declare r flujo_reglas; v_unidad uuid; v_fila uuid; v_prov text; v_hint uuid := coalesce(p_unidad, unidad_por_defecto(p_empresa));
begin
  select x.* into r from flujo_reglas x join empresas e on e.id = p_empresa
  where x.organizacion_id = e.organizacion_id and (x.empresa_id is null or x.empresa_id = p_empresa)
    and (x.si_origen is null or x.si_origen = p_origen)
    and (x.si_proveedor_id is null or x.si_proveedor_id = p_proveedor)
    and (x.si_cuenta_contable is null or texto_banco(x.si_cuenta_contable) = texto_banco(p_cuenta_contable))
    and (x.si_cuenta_origen_id is null or x.si_cuenta_origen_id = p_cuenta_origen)
    and (x.si_categoria is null or x.si_categoria = p_categoria)
    and (x.si_texto is null or position(texto_banco(x.si_texto) in texto_banco(p_texto)) > 0)
    and (x.si_unidad_id is null or x.si_unidad_id = v_hint)
  order by x.prioridad, (x.empresa_id is null), (x.si_unidad_id is null) limit 1;
  if r.id is not null and r.excluir then return query select null::uuid, null::uuid, true; return; end if;
  v_unidad := coalesce(r.unidad_id, v_hint);
  v_fila := r.fila_id;
  if v_fila is null and p_cuenta_contable is not null then
    select nombre into v_prov from proveedores where id = p_proveedor;
    select f.id into v_fila from flujo_filas f
    where f.unidad_id = v_unidad and f.activa and f.tipo in ('CUENTA', 'APERTURA')
      and texto_banco(f.cuenta_contable) = texto_banco(p_cuenta_contable)
      and (f.tipo = 'CUENTA' or (v_prov is not null and position(texto_banco(f.apertura) in texto_banco(v_prov)) > 0))
    order by (f.tipo = 'APERTURA') desc, f.orden limit 1;
  end if;
  if v_fila is null then v_fila := fila_especial(v_unidad, 'SIN_CLASIFICAR'); end if;
  return query select v_unidad, v_fila, false;
end $$;

-- ---------------------------------------------------------------- 1, 2, 5, 6. Las líneas del Flujo

create or replace view flujo_lineas with (security_invoker = true) as
with fac as (
  select f.empresa_id, f.unidad_id, f.id as factura_id, f.fecha as fecha_factura, t.ocurrencia, t.fecha, t.importe,
         pr.nombre as proveedor, f.proveedor_id, f.cuenta_contable,
         f.tipo || ' ' || lpad(f.punto_venta::text, 5, '0') || '-' || lpad(f.numero::text, 8, '0') as comprobante
  from facturas f
  join proveedores pr on pr.id = f.proveedor_id
  cross join lateral (
    select greatest(round(f.total * coalesce(f.anticipo_pct, 0) / 100, 2) - f.pagado, 0) as anticipo_pend
  ) q
  cross join lateral (values
    ('ANTICIPO', dia_habil_desde(greatest(f.fecha, current_date + 1)), q.anticipo_pend),
    ('SALDO', coalesce(f.fecha_pago,
                       case when f.metodo_pago in ('CHEQUE', 'ECHEQ') and f.dias_cheque is not null then f.fecha + f.dias_cheque end,
                       f.vencimiento, f.fecha),
              f.total - f.pagado - q.anticipo_pend)
  ) as t(ocurrencia, fecha, importe)
  where f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL') and f.cuenta_origen_extracto_id is null
    and f.tipo !~* 'cr[eé]dito' and t.importe > 0
), fac_desc as (
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
  select p.empresa_id, coalesce(co.unidad_id, cm.unidad_id, unidad_por_defecto(p.empresa_id)) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, coalesce(mv.fecha, p.fecha) as fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, coalesce(p.cuenta_origen_id, mv.cuenta_origen_id) as cuenta_origen_id, null::text as categoria,
         false as vencido, (mv.fecha is not null or p.medio::text <> 'CAJA') as afecta_bancos
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join lateral (select m.fecha, m.cuenta_origen_id from movimientos_bancarios m where m.pago_id = p.id order by m.fecha limit 1) mv on true
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
    -- Un pago de una cuenta con extracto es real cuando el banco lo debita. Si el extracto de esa cuenta para ese
    -- día está y el débito no aparece, el pago no salió (duplicado, otra cuenta, otra fecha): no entra y queda
    -- en pagos_sin_debito para revisar. Mientras el extracto no llegó, cuenta en su fecha.
    and (mv.fecha is not null or co.id is null or not co.requiere_extracto or p.medio = 'CAJA'
         or not extracto_cubre(co.id, p.fecha))
  union all
  -- REAL · cheques debitados (la categoría del acreedor elige la fila de cheques)
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, a.categoria, false, true
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
  union all
  -- REAL · cobros (el día y la cuenta del banco, si ya está vinculado)
  select cb.empresa_id, coalesce(cm.unidad_id, co.unidad_id), 'COBRO', cb.id, 'COBRO', coalesce(mv.fecha, cb.fecha), cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', coalesce(mv.cuenta_origen_id, cb.cuenta_origen_id),
         null, false, true
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  left join movimientos_bancarios mv on mv.id = cb.movimiento_id
  left join cuentas_origen cm on cm.id = mv.cuenta_origen_id
  union all
  -- REAL · movimientos del banco sin documento vinculado (impuestos, gastos, FCI, transferencias… y débitos que
  -- todavía no tienen su pago, cheque o cobro: la plata ya se movió).
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, false, true
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, false, true
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', false, true
  from conciliacion_bancaria cb where cb.rendimiento is not null and cb.rendimiento <> 0
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, false, true
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, a.categoria, false, true
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado in ('EMITIDO', 'ENTREGADO')
), proy as (
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.proveedor_id
  from proyecciones p
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, current_date, current_date + 180) o
  where p.estado = 'ACTIVA'
), todas as (
  -- Lo REAL que pasó por una cuenta bancaria queda en la unidad de esa cuenta y no se excluye: la plata se movió en
  -- ese banco y el control contra bancos tiene que verla. Si una regla lo mandaba a otra unidad o lo excluía
  -- (transferencia propia), va a "Entre cuentas propias" (excluida) o a "Sin clasificar" (otra unidad) de su unidad.
  select b.empresa_id,
         case when b.naturaleza = 'REAL' and cu.unidad_id is not null then cu.unidad_id else d.unidad_id end as unidad_id,
         case when b.naturaleza = 'REAL' and cu.unidad_id is not null and (d.excluir or d.unidad_id <> cu.unidad_id)
              then fila_especial(cu.unidad_id, case when d.excluir then 'ENTRE_CUENTAS' else 'SIN_CLASIFICAR' end)
              else d.fila_id end as fila_id,
         case when b.naturaleza = 'REAL' and cu.unidad_id is not null then false else d.excluir end as excluir,
         b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe,
         b.naturaleza, b.contraparte, b.concepto, b.cuenta_origen_id, b.afecta_bancos
  from base b
  left join cuentas_origen cu on cu.id = b.cuenta_origen_id and b.afecta_bancos and cu.requiere_extracto
  cross join lateral flujo_destino(b.empresa_id, b.unidad_hint, b.origen_tipo, b.proveedor_id, b.cuenta_contable,
                                   b.cuenta_origen_id, b.categoria, coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) d
  union all
  select empresa_id, unidad_id, fila_id, false, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto,
         null::uuid, true
  from proy
)
select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
       t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
       case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date
            then dia_habil_desde(current_date) else coalesce(a.fecha_nueva, t.fecha) end as fecha,
       t.fecha as fecha_calculada,
       case when a.importe_nuevo is not null then sign(t.importe) * a.importe_nuevo else t.importe end as importe,
       t.contraparte, t.concepto,
       t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date as vencido,
       a.id is not null as ajustada,
       t.naturaleza = 'PROYECTADO' as editable,
       t.cuenta_origen_id,
       t.afecta_bancos
from todas t
join flujo_filas ff on ff.id = t.fila_id
left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                         and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
where not t.excluir and not coalesce(a.eliminada, false);

-- ---------------------------------------------------------------- 6. Control: solo lo que mueve un banco

create or replace view flujo_control with (security_invoker = true) as
with cuentas as (
  select unidad_id, count(*) as n from cuentas_origen where activa and requiere_extracto group by unidad_id
), dias as (
  select co.unidad_id, s.fecha, sum(s.saldo) as saldo_bancos, count(*) as con_saldo
  from saldos_bancarios s join cuentas_origen co on co.id = s.cuenta_origen_id
  where co.activa and co.requiere_extracto
  group by co.unidad_id, s.fecha
), completos as (
  select d.*, c.n, d.con_saldo = c.n as completo,
         lag(d.fecha) over (partition by d.unidad_id order by d.fecha) as fecha_anterior,
         lag(d.saldo_bancos) over (partition by d.unidad_id order by d.fecha) as saldo_anterior
  from dias d join cuentas c on c.unidad_id = d.unidad_id
  where d.con_saldo = c.n
)
select u.empresa_id, k.unidad_id, u.nombre as unidad, k.fecha, k.fecha_anterior, k.saldo_anterior, k.saldo_bancos,
       r.movido as real_del_periodo,
       round(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0), 2) as diferencia,
       case when k.saldo_anterior is null then 'PRIMER_SALDO'
            when abs(k.saldo_bancos - k.saldo_anterior - coalesce(r.movido, 0)) <= 1 then 'OK'
            else 'F' end as estado
from completos k
join unidades u on u.id = k.unidad_id
left join lateral (
  select sum(l.importe) as movido from flujo_lineas l
  where l.unidad_id = k.unidad_id and l.naturaleza = 'REAL' and l.afecta_bancos
    and l.fecha > k.fecha_anterior and l.fecha <= k.fecha
) r on true;

-- ---------------------------------------------------------------- Pagos que el banco no muestra

-- Pagos de una cuenta con extracto sin débito vinculado: el extracto cubre hasta 5 días después de la fecha del
-- pago (la ventana de vinculación cerró). posible_duplicado: hay otro pago igual (empresa, importe, proveedor, ±5 días).
create or replace view pagos_sin_debito with (security_invoker = true) as
select p.id, p.empresa_id, p.fecha, p.importe, p.proveedor_destino, p.estado, p.cuenta_origen_id, co.nombre as cuenta,
       p.sheets_fila_origen, p.hoja_id,
       exists (select 1 from pagos d where d.id <> p.id and d.empresa_id = p.empresa_id and d.importe = p.importe
                 and d.estado <> 'ANULADO' and abs(d.fecha - p.fecha) <= 5
                 and texto_comparable(coalesce(d.proveedor_destino, '')) = texto_comparable(coalesce(p.proveedor_destino, ''))) as posible_duplicado
from pagos p join cuentas_origen co on co.id = p.cuenta_origen_id
where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ') and co.requiere_extracto
  and not exists (select 1 from movimientos_bancarios m where m.pago_id = p.id)
  and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
  and extracto_cubre(co.id, p.fecha + 5);

-- Lo que ya estaba cargado: conciliar una vez.
select conciliar_movimientos(id) from empresas;

-- ---------------------------------------------------------------- Seguridad

revoke all on flujo_lineas, flujo_control, pagos_sin_debito from public, anon, authenticated;
grant select on flujo_lineas, flujo_control, pagos_sin_debito to authenticated;
grant all on flujo_lineas, flujo_control, pagos_sin_debito to service_role;
revoke execute on function extracto_cubre(uuid, date), cuenta_de_pago(text, text, text, text), pago_con_cuenta(), vincular_pagos_a_cuentas(),
  conciliar_movimientos(text), conciliar_tras_cambio(), soltar_movimiento_de_anulado() from public, anon, authenticated;
grant execute on function vincular_pagos_a_cuentas(), conciliar_movimientos(text) to service_role;
grant execute on function extracto_cubre(uuid, date) to authenticated, service_role;
grant execute on function flujo_destino(text, uuid, text, uuid, text, uuid, text, text) to authenticated, service_role;
