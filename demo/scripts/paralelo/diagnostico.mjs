// Para cada unidad y día que NO coincide, indicadores de la causa (salen de la base, no de una opinión):
//   · cuentas: las que tienen DIFERENCIA en conciliacion_bancaria en el período (sus movimientos no explican su
//     saldo), marcando si el saldo es MANUAL (copiado del Flujo viejo) y si el extracto cubre ese día.
//   · docs_sin_debito: pagos y cheques debitados que cuentan como reales sin débito vinculado.
//   · pagos_sin_debito: pagos de la hoja que el banco no muestra (vista de 0030; no cuentan en lo real).
// Solo para el escenario DESPUÉS (usa funciones de 0030). Centavos (BigInt).
import { cent } from './comparar.mjs'

export async function detalleDias(db, flujo) {
  const malos = flujo.filter((f) => !f.coincide && f.estado_base !== 'PRIMER_SALDO' && f.estado_base !== 'SIN_EXTRACTO')
  const out = []
  for (const f of malos) {
    const ant = (await db.query(`select max(fc.fecha)::text as a from flujo_control fc join unidades u on u.id = fc.unidad_id
                                 where u.codigo = $1 and fc.fecha < $2`, [f.unidad, f.fecha])).rows[0].a
    if (!ant) continue
    // Cuentas cuyo saldo no lo explican sus movimientos (conciliación de la base) en el período.
    const conc = (await db.query(`
      select cb.cuenta, cb.origen, extracto_cubre(cb.cuenta_origen_id, cb.fecha) as cubre, sum(cb.diferencia)::text as dif
      from conciliacion_bancaria cb join unidades u on u.id = cb.unidad_id
      where u.codigo = $1 and cb.fecha > $2 and cb.fecha <= $3 and cb.estado = 'DIFERENCIA'
      group by cb.cuenta, cb.origen, cb.cuenta_origen_id, cb.fecha`, [f.unidad, ant, f.fecha])).rows
    const porCuenta = new Map()
    for (const c of conc) {
      const x = porCuenta.get(c.cuenta) ?? { cuenta: c.cuenta, dif: 0n, manual: false, sin_extracto: false }
      x.dif += cent(c.dif); x.manual ||= c.origen === 'MANUAL'; x.sin_extracto ||= !c.cubre
      porCuenta.set(c.cuenta, x)
    }
    // Documentos que cuentan como reales sin débito vinculado (el extracto no cubre ese día o la cuenta no se sabe).
    const docs = (await db.query(`
      select 'PAGO' as tipo, count(*)::int as n, coalesce(sum(p.importe), 0)::text as suma
      from pagos p left join cuentas_origen co on co.id = p.cuenta_origen_id
      join unidades u on u.id = coalesce(co.unidad_id, unidad_por_defecto(p.empresa_id))
      where u.codigo = $1 and p.fecha > $2 and p.fecha <= $3 and p.estado <> 'ANULADO' and p.medio not in ('CHEQUE', 'ECHEQ', 'CAJA')
        and not exists (select 1 from movimientos_bancarios m where m.pago_id = p.id)
        and (co.id is null or not extracto_cubre(co.id, p.fecha))
      union all
      select 'CHEQUE', count(*)::int, coalesce(sum(ch.importe), 0)::text
      from cheques ch join cuentas_origen co on co.id = ch.cuenta_origen_id join unidades u on u.id = co.unidad_id
      where u.codigo = $1 and ch.estado = 'DEBITADO' and ch.debitado_en > $2 and ch.debitado_en <= $3 and ch.movimiento_id is null`, [f.unidad, ant, f.fecha])).rows
    const psd = (await db.query(`
      select count(*)::int as n, coalesce(sum(p.importe), 0)::text as suma, count(*) filter (where p.posible_duplicado)::int as dup
      from pagos_sin_debito p join cuentas_origen c on c.id = p.cuenta_origen_id join unidades u on u.id = c.unidad_id
      where u.codigo = $1 and p.fecha > $2 and p.fecha <= $3`, [f.unidad, ant, f.fecha])).rows[0]
    out.push({
      unidad: f.unidad, fecha: f.fecha, anterior: ant, diferencia: f.dif_base,
      cuentas: [...porCuenta.values()],
      docs_sin_debito: docs.filter((d) => d.n > 0).map((d) => ({ tipo: d.tipo, n: d.n, suma: cent(d.suma) })),
      pagos_sin_debito: { n: psd.n, suma: cent(psd.suma), duplicados: psd.dup },
    })
  }
  return out
}

/** Causa del día, por prioridad: qué explica que la base no cierre contra los bancos. */
export function causaDelDia(d, pesosAR) {
  if (!d) return 'sin diagnóstico'
  const c = []
  for (const x of d.cuentas) {
    const que = x.sin_extracto ? 'saldo MANUAL (copiado del Flujo viejo) sin extracto: no hay movimientos que lo expliquen'
      : x.manual ? 'saldo MANUAL (copiado del Flujo viejo) que no coincide con los movimientos del banco'
      : 'los movimientos del extracto no explican el saldo (faltan o sobran movimientos)'
    c.push(`${x.cuenta}: ${que} (${pesosAR(x.dif)})`)
  }
  for (const x of d.docs_sin_debito) c.push(`${x.n} ${x.tipo === 'PAGO' ? 'pago(s)' : 'cheque(s) debitado(s)'} que cuentan sin débito vinculado (${pesosAR(-x.suma)})`)
  return c.length ? c.join(' · ') : 'sin indicador automático: revisar a mano'
}
