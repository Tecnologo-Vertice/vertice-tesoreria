-- Tanda D5 · Pagos sin factura (ESPERA_FC) en el Flujo.
--
-- Lo que hacía gas/FlujoCaja.gs (fxAnticiposSinFactura_ + fxDescontarAnticipos_) pasa a la base:
--
--   · Un pago a un proveedor que todavía no tiene factura (anticipo) ya salió del banco: está en el Flujo
--     como REAL. Si además se proyectara entera la factura que llega después, el Flujo contaría dos veces
--     la misma plata.
--   · Por eso, lo pagado sin factura se descuenta de lo proyectado del MISMO proveedor y la MISMA empresa,
--     empezando por la factura más vieja (la que se paga primero) y siguiendo con la más nueva. Si el
--     anticipo cubre una factura entera, esa línea desaparece; lo que sobra pasa a la siguiente.
--   · Cuando la factura llega y el pago se vincula (pagos_facturas o factura_asociada), el pago deja de
--     ser anticipo y la factura baja sola por lo pagado: no hay doble descuento.
--
-- Pago sin factura (ESPERA_FC) =
--   no anulado · importe > 0 · con proveedor · sin factura vinculada (ni en pagos_facturas ni en el texto
--   factura_asociada) · y tipo_pago 'SIN_FACTURA' o cargado como orden de pago (la misma condición que usa el
--   ESTADO_CONTABLE = 'ESPERA_FC' de 0012/0022). Cuenta aunque ya esté contabilizado en Xubio: la plata ya
--   se fue y la factura todavía no está.

-- ---------------------------------------------------------------- Arreglo de 0024: la clave vieja de movimientos

-- 0024 quiso borrar la clave (cuenta, fecha, importe, referencia) con su nombre largo, pero Postgres la había
-- creado con el nombre truncado a 63 caracteres (…_refere_key): el "drop … if exists" no la encontró y siguió
-- viva. Con referencia vacía no se notaba (null ≠ null); con los extractos reales del Hipotecario, dos
-- movimientos iguales del mismo día con la misma referencia ("1666 Chq: 0") chocaban. La huella ya cubre eso.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'movimientos_bancarios'::regclass and contype = 'u'
             and conname like 'movimientos_bancarios_cuenta_origen_id_fecha_importe_ref%' loop
    execute format('alter table movimientos_bancarios drop constraint %I', c);
  end loop;
end $$;

-- ---------------------------------------------------------------- Pagos sin factura por proveedor

create or replace view anticipos_sin_factura with (security_invoker = true) as
select p.empresa_id, p.proveedor_id, count(*)::integer as pagos, sum(p.importe) as importe,
       min(p.fecha) as desde, max(p.fecha) as hasta
from pagos p
where p.estado <> 'ANULADO' and p.importe > 0 and p.proveedor_id is not null
  and coalesce(trim(p.factura_asociada), '') = ''
  and not exists (select 1 from pagos_facturas pf where pf.pago_id = p.id)
  and (upper(coalesce(p.tipo_pago, '')) = 'SIN_FACTURA' or p.forma_carga_xubio = 'ORDEN_PAGO')
group by p.empresa_id, p.proveedor_id;

-- ---------------------------------------------------------------- Las líneas del Flujo (misma vista, mismo orden de columnas)

create or replace view flujo_lineas with (security_invoker = true) as
with fac as (
  -- PROYECTADO · facturas por pagar, en tramos (anticipo pendiente mañana, resto al vencimiento)
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
  -- ESPERA_FC · lo pagado sin factura se descuenta de la más vieja a la más nueva (por fecha de pago
  -- proyectada, después por fecha de la factura), mismo proveedor y misma empresa.
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
  -- REAL · pagos (los pagados con cheque cuentan cuando se debita el cheque)
  select p.empresa_id, coalesce(co.unidad_id, unidad_por_defecto(p.empresa_id)) as unidad_hint, 'PAGO'::text as origen_tipo,
         p.id as origen_id, 'PAGO'::text as ocurrencia, p.fecha, -p.importe as importe, 'REAL'::text as naturaleza,
         coalesce(pr.nombre, p.proveedor_destino, p.descripcion) as contraparte, coalesce(p.descripcion, pr.nombre) as concepto,
         p.proveedor_id, p.cuenta_contable, p.cuenta_origen_id, null::text as categoria, false as vencido
  from pagos p
  left join cuentas_origen co on co.id = p.cuenta_origen_id
  left join proveedores pr on pr.id = p.proveedor_id
  where p.estado <> 'ANULADO' and p.importe > 0 and p.medio not in ('CHEQUE', 'ECHEQ')
    and not exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)
  union all
  -- REAL · cheques debitados
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.debitado_en, -ch.importe, 'REAL',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado = 'DEBITADO'
  union all
  -- REAL · cobros
  select cb.empresa_id, co.unidad_id, 'COBRO', cb.id, 'COBRO', cb.fecha, cb.importe, 'REAL', cb.cliente,
         coalesce(cb.descripcion, 'Cobro ' || coalesce(cb.recibo, '')), null, 'DEUDORES POR VENTAS', cb.cuenta_origen_id, null, false
  from cobros cb left join cuentas_origen co on co.id = cb.cuenta_origen_id
  union all
  -- REAL · movimientos del banco que no son pago, cobro ni cheque (impuestos, gastos, FCI, intereses…)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'MOVIMIENTO', m.fecha, m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.cuenta_origen_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.cuenta_origen_id
  where m.estado <> 'IGNORADO' and m.pago_id is null and m.cobro_id is null and m.cheque_id is null
    and m.categoria not in ('PAGO', 'COBRO', 'CHEQUE_PAGADO')
  union all
  -- REAL · la otra pata de un movimiento entre cuentas propias o de un FCI (suma cero en la caja total)
  select m.empresa_id, co.unidad_id, 'MOVIMIENTO', m.id, 'CONTRAPARTE', m.fecha, -m.importe, 'REAL', co.nombre, m.descripcion,
         null, m.cuenta_contable, m.contraparte_cuenta_id, m.categoria, false
  from movimientos_bancarios m join cuentas_origen co on co.id = m.contraparte_cuenta_id
  where m.estado <> 'IGNORADO' and m.contraparte_cuenta_id is not null
  union all
  -- REAL · rendimiento de FCI y remuneradas que no vino como movimiento (sale de la conciliación)
  select cb.empresa_id, cb.unidad_id, 'RENDIMIENTO', cb.cuenta_origen_id, cb.fecha::text, cb.fecha, cb.rendimiento, 'REAL',
         cb.cuenta, 'Rendimiento ' || cb.cuenta, null, 'Rendimientos FCI', cb.cuenta_origen_id, 'FCI_RENDIMIENTO', false
  from conciliacion_bancaria cb where cb.rendimiento is not null and cb.rendimiento <> 0
  union all
  -- PROYECTADO · facturas por pagar, menos lo pagado sin factura al mismo proveedor (ESPERA_FC)
  select d.empresa_id, d.unidad_id, 'FACTURA', d.factura_id, d.ocurrencia, d.fecha, -(d.importe - d.descuento), 'PROYECTADO',
         d.proveedor,
         d.comprobante || case when d.descuento > 0
                               then ' · menos pago sin factura $' || to_char(d.descuento, 'FM999999999990.00') else '' end,
         d.proveedor_id, d.cuenta_contable, null, null, false
  from fac_desc d
  where d.importe - d.descuento > 0
  union all
  -- PROYECTADO · cheques emitidos sin debitar
  select ch.empresa_id, co.unidad_id, 'CHEQUE', ch.id, 'CHEQUE', ch.fecha_pago, -ch.importe, 'PROYECTADO',
         coalesce(a.nombre, ch.beneficiario), 'Cheque ' || ch.numero, ch.proveedor_id,
         (select pg.cuenta_contable from cheques_pagos cp join pagos pg on pg.id = cp.pago_id where cp.cheque_id = ch.id limit 1),
         ch.cuenta_origen_id, null, false
  from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id left join acreedores a on a.id = ch.acreedor_id
  where ch.estado in ('EMITIDO', 'ENTREGADO')
), proy as (
  -- PROYECTADO · proyecciones, de hoy a 180 días
  select p.empresa_id, p.unidad_id, p.fila_id, 'PROYECCION'::text as origen_tipo, p.id as origen_id, o.ocurrencia::text as ocurrencia,
         o.fecha, o.importe, coalesce(pr.nombre, p.concepto) as contraparte, p.concepto, p.proveedor_id
  from proyecciones p
  left join proveedores pr on pr.id = p.proveedor_id
  cross join lateral proyeccion_ocurrencias(p, current_date, current_date + 180) o
  where p.estado = 'ACTIVA'
), todas as (
  select b.empresa_id, d.unidad_id, d.fila_id, d.excluir, b.origen_tipo, b.origen_id, b.ocurrencia, b.fecha, b.importe,
         b.naturaleza, b.contraparte, b.concepto
  from base b
  cross join lateral flujo_destino(b.empresa_id, b.unidad_hint, b.origen_tipo, b.proveedor_id, b.cuenta_contable,
                                   b.cuenta_origen_id, b.categoria, coalesce(b.contraparte, '') || ' ' || coalesce(b.concepto, '')) d
  union all
  select empresa_id, unidad_id, fila_id, false, origen_tipo, origen_id, ocurrencia, fecha, importe, 'PROYECTADO', contraparte, concepto
  from proy
)
select t.empresa_id, t.unidad_id, t.fila_id, ff.etiqueta as fila, ff.seccion, ff.mueve_caja,
       t.origen_tipo, t.origen_id, t.ocurrencia, t.naturaleza,
       -- Lo proyectado que quedó atrás pasa al día hábil de hoy.
       case when t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date
            then dia_habil_desde(current_date) else coalesce(a.fecha_nueva, t.fecha) end as fecha,
       t.fecha as fecha_calculada,
       case when a.importe_nuevo is not null then sign(t.importe) * a.importe_nuevo else t.importe end as importe,
       t.contraparte, t.concepto,
       t.naturaleza = 'PROYECTADO' and coalesce(a.fecha_nueva, t.fecha) < current_date as vencido,
       a.id is not null as ajustada,
       t.naturaleza = 'PROYECTADO' as editable
from todas t
join flujo_filas ff on ff.id = t.fila_id
left join flujo_ajustes a on a.origen_tipo = t.origen_tipo and a.origen_id = t.origen_id and a.ocurrencia = t.ocurrencia
                         and a.reemplazado_en is null and t.naturaleza = 'PROYECTADO'
where not t.excluir and not coalesce(a.eliminada, false);

-- ---------------------------------------------------------------- Seguridad

revoke all on anticipos_sin_factura, flujo_lineas from public, anon, authenticated;
grant select on anticipos_sin_factura, flujo_lineas to authenticated;
grant all on anticipos_sin_factura, flujo_lineas to service_role;
