// Lo que dicen HOY las planillas, para comparar contra la base (solo lectura, desde las instantáneas):
//   · Flujo original, por pestaña y día: la fila "Conciliación Bancaria" (Ok / F / Sin extracto), la suma de las filas
//     de saldo por banco, la "Caja Acumulada" contra la que se compara y la "Caja del Período" (lo que movió el Flujo).
//     Las filas salen de la fórmula de la propia celda: =IF(COUNTBLANK(O109:O113)>0;"Sin extracto";…SUM(O109:O113)-O108…).
//   · VBI+ › Conciliacion_Diaria, por empresa, banco y día: ESTADO y DIFERENCIA.
// Importes en centavos (BigInt). Nunca float.
import { hojas, texto, celda, centavos, fecha, norm } from '../migrar-desde-planillas/leer.mjs'
import { PESTANAS, empresaDe } from '../migrar-desde-planillas/transformar.mjs'

/** Letras de columna → índice 0 (A = 0, AA = 26). */
export function indiceColumna(letras) {
  let n = 0
  for (const ch of letras.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** De la fórmula de la conciliación: filas de bancos (desde, hasta) y fila de la caja (1-based). */
export function filasDeFormula(formula) {
  const m = /COUNTBLANK\(([A-Z]+)(\d+):[A-Z]+(\d+)\)/i.exec(formula ?? '')
  const c = /SUM\([A-Z]+\d+:[A-Z]+\d+\)-([A-Z]+)(\d+)/i.exec(formula ?? '')
  if (!m || !c) return null
  return { desde: +m[2], hasta: +m[3], caja: +c[2] }
}

/** Fórmulas crudas de una pestaña (la lectura normal de hojas() solo marca si es fórmula). */
function formulas(respuesta, titulo) {
  const s = (respuesta?.sheets ?? []).find((x) => x.properties.title === titulo)
  const filas = (s?.data ?? []).flatMap((b) => b.rowData ?? [])
  return (i, j) => filas[i]?.values?.[j]?.userEnteredValue?.formulaValue ?? null
}

const ESTADO_FLUJO = { OK: 'OK', F: 'F', 'SIN EXTRACTO': 'SIN_EXTRACTO' }

/**
 * Flujo original → [{ pestana, empresa, unidad, fecha, estado, saldo_bancos, caja_acumulada, diferencia, caja_periodo, bancos: [{fila, etiqueta, saldo}] }]
 * Solo días entre desde y hasta (inclusive) que tienen columna propia (no los totales del mes).
 */
export function leerFlujoOriginal(original, { desde, hasta }) {
  const O = hojas(original)
  const out = []
  for (const [pest, { empresa, unidad }] of Object.entries(PESTANAS)) {
    const h = O.get(pest)
    if (!h) throw new Error(`Falta la pestaña "${pest}" en el Flujo original`)
    const f = formulas(original, pest)
    const filaConc = h.findIndex((r) => /^CONCILIACION BANCARIA/.test(norm(texto(r, 2) || texto(r, 1))))
    const filaPeriodo = h.findIndex((r) => /^CAJA DEL PERIODO$/.test(norm(texto(r, 2) || texto(r, 1))))
    if (filaConc < 0) throw new Error(`${pest}: no está la fila "Conciliación Bancaria"`)
    const cab = h[1] ?? []
    cab.forEach((c, j) => {
      if (j < 3) return
      const d = fecha(c)
      if (!d || d < desde || d > hasta) return
      const formula = f(filaConc, j)
      const rango = filasDeFormula(formula)
      const estadoTxt = norm(texto(h[filaConc], j))
      if (!rango) { out.push({ pestana: pest, empresa, unidad, fecha: d, estado: ESTADO_FLUJO[estadoTxt] ?? estadoTxt ?? null, sinFormula: true, bancos: [] }); return }
      const bancos = []
      let suma = 0n, vacias = 0
      for (let i = rango.desde - 1; i <= rango.hasta - 1; i++) {
        const v = centavos(celda(h[i], j))
        if (v === null) { vacias++; continue }
        suma += v
        bancos.push({ fila: i + 1, etiqueta: [texto(h[i], 1), texto(h[i], 2)].filter(Boolean).join(' '), saldo: v })
      }
      const caja = centavos(celda(h[rango.caja - 1], j)) ?? 0n
      out.push({
        pestana: pest, empresa, unidad, fecha: d, estado: ESTADO_FLUJO[estadoTxt] ?? (estadoTxt || null),
        saldo_bancos: vacias ? null : suma, caja_acumulada: caja, diferencia: vacias ? null : suma - caja,
        caja_periodo: filaPeriodo >= 0 ? centavos(celda(h[filaPeriodo], j)) : null, filas_vacias: vacias, bancos, rango,
      })
    })
  }
  return out
}

const ESTADO_VBI = { OK: 'OK', DIFERENCIA: 'DIFERENCIA', 'SIN MOVIMIENTOS': 'SIN_MOVIMIENTOS', 'SIN EXTRACTO': 'SIN_EXTRACTO' }

/** VBI+ › Conciliacion_Diaria → [{ fecha, empresa, banco, estado, diferencia, saldo_extracto, saldo_inicial }] (fecha en m/d como la escribe el script). */
export function leerConciliacionVbi(vbi, { desde, hasta }) {
  const h = hojas(vbi).get('Conciliacion_Diaria')
  if (!h) throw new Error('Falta la pestaña Conciliacion_Diaria en VBI+')
  const out = []
  h.slice(1).forEach((r, i) => {
    const d = fecha(celda(r, 0), { mdy: true })
    if (!d || d < desde || d > hasta) return
    const est = norm(texto(r, 14))
    out.push({
      fila: i + 2, fecha: d, empresa: empresaDe(texto(r, 1)), etiqueta: texto(r, 1), banco: texto(r, 2),
      estado: ESTADO_VBI[est] ?? est, diferencia: centavos(celda(r, 8)), saldo_extracto: centavos(celda(r, 7)),
      saldo_inicial: centavos(celda(r, 3)),
    })
  })
  return out
}
