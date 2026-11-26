// Base contra planillas, por unidad y día (control del Flujo) y por cuenta y día (conciliación bancaria).
// Todo en centavos (BigInt). La base devuelve numeric como texto: se convierte sin pasar por float.
import { norm } from '../migrar-desde-planillas/leer.mjs'
import { PESTANAS } from '../migrar-desde-planillas/transformar.mjs'

/** '123.45' / '-1' / null → centavos. */
export function cent(t) {
  if (t === null || t === undefined) return null
  const s = String(t), neg = s.startsWith('-')
  const [e, d = ''] = s.replace('-', '').split('.')
  const v = BigInt(e || '0') * 100n + BigInt((d + '00').slice(0, 2))
  return neg ? -v : v
}
const abs = (x) => (x < 0n ? -x : x)
const TOL = 100n // $1, la misma tolerancia de la planilla y de flujo_control

/** flujo_control de la base, por unidad (código) y día. */
export async function controlBase(db, { desde, hasta }) {
  const rows = (await db.query(`
    select u.codigo as unidad, fc.fecha::text as fecha, fc.fecha_anterior::text as fecha_anterior, fc.estado,
           fc.saldo_anterior::text as saldo_anterior, fc.saldo_bancos::text as saldo_bancos,
           fc.real_del_periodo::text as real_del_periodo, fc.diferencia::text as diferencia
    from flujo_control fc join unidades u on u.id = fc.unidad_id
    where fc.fecha between $1 and $2`, [desde, hasta])).rows
  const m = new Map()
  for (const r of rows) m.set(`${r.unidad}|${r.fecha}`, { ...r, saldo_bancos: cent(r.saldo_bancos), saldo_anterior: cent(r.saldo_anterior),
    real_del_periodo: cent(r.real_del_periodo) ?? 0n, diferencia: cent(r.diferencia) })
  // Días sin control (falta el saldo de alguna cuenta): cuántas cuentas tienen saldo ese día.
  const parciales = (await db.query(`
    select u.codigo as unidad, s.fecha::text as fecha, count(*)::int as con_saldo,
           (select count(*)::int from cuentas_origen c2 where c2.unidad_id = u.id and c2.activa and c2.requiere_extracto) as cuentas,
           sum(s.saldo)::text as suma
    from saldos_bancarios s join cuentas_origen c on c.id = s.cuenta_origen_id join unidades u on u.id = c.unidad_id
    where c.activa and c.requiere_extracto and s.fecha between $1 and $2 group by u.id, u.codigo, s.fecha`, [desde, hasta])).rows
  const p = new Map(parciales.map((r) => [`${r.unidad}|${r.fecha}`, r]))
  return { control: m, parciales: p }
}

/** Una fila por unidad y día del Flujo original: planilla vs base. */
export function compararFlujo(planilla, base) {
  return planilla.map((pl) => {
    const k = `${pl.unidad}|${pl.fecha}`
    const b = base.control.get(k)
    const parcial = base.parciales.get(k)
    const estadoBase = b ? b.estado : 'SIN_EXTRACTO'
    const saldoBase = b ? b.saldo_bancos : null
    const difSaldo = pl.saldo_bancos !== null && pl.saldo_bancos !== undefined && saldoBase !== null ? saldoBase - pl.saldo_bancos : null
    const comparable = estadoBase !== 'PRIMER_SALDO'
    const mismoEstado = estadoBase === pl.estado
    const mismoSaldo = difSaldo === null || abs(difSaldo) <= TOL
    return {
      unidad: pl.unidad, pestana: pl.pestana, fecha: pl.fecha,
      estado_planilla: pl.estado, estado_base: estadoBase, comparable,
      coincide: comparable && mismoEstado && mismoSaldo,
      saldo_planilla: pl.saldo_bancos ?? null, saldo_base: saldoBase, dif_saldo: difSaldo,
      dif_planilla: pl.diferencia ?? null, dif_base: b?.diferencia ?? null,
      caja_periodo: pl.caja_periodo ?? null, real_base: b?.real_del_periodo ?? null,
      cuentas_con_saldo: parcial ? `${parcial.con_saldo}/${parcial.cuentas}` : '0',
    }
  })
}

/** conciliacion_bancaria de la base por empresa|cuenta|fecha. */
export async function conciliacionBase(db, { desde, hasta }) {
  const rows = (await db.query(`select empresa_id, cuenta, fecha::text as fecha, estado, diferencia::text as diferencia, origen
                                from conciliacion_bancaria where fecha between $1 and $2`, [desde, hasta])).rows
  return new Map(rows.map((r) => [`${r.empresa_id}|${r.cuenta}|${r.fecha}`, { ...r, diferencia: cent(r.diferencia) }]))
}

/**
 * VBI+ Conciliacion_Diaria contra la vista conciliacion_bancaria. La cuenta de cada fila de VBI+ es la que le asignó la
 * migración (plan.saldos_bancarios[].ref = "Conciliacion_Diaria fila N"). VBI+ marca DIFERENCIA el primer día de una
 * cuenta (sin saldo inicial); la base lo marca PRIMER_SALDO: se cuentan aparte, no como diferencia.
 */
export function compararConciliacion(vbi, planSaldos, base) {
  const porRef = new Map(planSaldos.filter((s) => s.ref).map((s) => [s.ref, s]))
  return vbi.map((v) => {
    const s = porRef.get(`Conciliacion_Diaria fila ${v.fila}`)
    const b = s ? base.get(`${s.empresa}|${s.cuenta}|${v.fecha}`) : null
    const primer = v.saldo_inicial === null
    const estadoBase = b?.estado ?? 'SIN_FILA'
    // VBI+ marca "EXTRACTO" la fila de una tenencia de FCI (no concilia); la base la da OK y su diferencia es el rendimiento.
    const tenencia = v.estado === 'EXTRACTO' && estadoBase === 'OK'
    const mismoEstado = estadoBase === v.estado || (estadoBase === 'PRIMER_SALDO' && primer) || tenencia
    const difB = b?.diferencia ?? null, difV = v.diferencia ?? null
    const mismaDif = estadoBase === 'PRIMER_SALDO' || tenencia || (difB === null && difV === null) || (difB !== null && difV !== null && abs(difB - difV) <= TOL)
    return {
      fila: v.fila, fecha: v.fecha, empresa: v.empresa, banco: v.banco, cuenta: s?.cuenta ?? null,
      estado_vbi: v.estado, estado_base: estadoBase, dif_vbi: difV, dif_base: difB, primer_dia: primer,
      coincide: !!b && mismoEstado && mismaDif,
    }
  })
}

export const unidades = Object.values(PESTANAS).map((p) => p.unidad)
export { norm }
