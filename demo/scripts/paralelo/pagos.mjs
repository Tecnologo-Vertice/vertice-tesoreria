// Pagos de VBI+ → base, por el MISMO camino que producción: la fila se traduce con pagoDesdeFila()
// (netlify/functions/lib/espejo.ts, sin tocarlo) y entra con espejar_pagos() de la base. En producción los pagos ya
// están en la base (espejo de la hoja); acá se simula ese espejo para que el Flujo de la base tenga lo real.
//
// Fuentes (fuera del repo: tienen datos reales):
//   · una pestaña "Pagos" en la instantánea de VBI+ (si se leyó con la API), o
//   · una carpeta con columnas sueltas leídas con las herramientas de Sheets (--pagos DIR): FK.mjs (F:K), D.json, M.json,
//     W.mjs y ZAA.mjs, desde la fila indicada en desde.json ({"fila": 570}). Sin ID_PAGO: la clave es la fila.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hojas } from '../migrar-desde-planillas/leer.mjs'
import { pagoDesdeFila } from '../../netlify/functions/lib/espejo.ts'

const COLS = ['ID_PAGO', 'TIPO_PAGO', 'FACTURA_ASOCIADA', 'PROVEEDOR_DESTINO', 'DESCRIPCION_PAGO', 'REALIZADO_POR', 'BANCO_ORIGEN',
  'NUMERO_CUENTA', 'NUMERO_CHEQUE', 'FECHA_PAGO', 'IMPORTE', 'URL_COMPROBANTE', 'ESTADO_CONTABLE', 'DRIVE_URL_ORIGEN', 'BANCO_DESTINO',
  'ESTADO_EXTRACCION_IA', 'OBSERVACIONES_TESORERIA', 'CARGADO_POR', 'DETALLE_CONTABILIZACION', 'CONTABILIZADO_POR', 'FECHA_CONTABILIZACION',
  'FORMA_CARGA', 'CUENTA_CONTABLE', 'SUGERENCIA_ORIGEN', 'SUGERENCIA_MOTIVO', 'EMPRESA', 'CUENTA_ORIGEN', 'ESTADO_XUBIO_PAGO', 'XUBIO_ID_PAGO',
  'XUBIO_DETALLE', 'AVISO_IMPORTE', 'FECHA_VTO_CHEQUE']

/** Filas de la pestaña Pagos como objetos {COLUMNA: texto}. */
export async function filasPagos({ vbi, carpeta }) {
  const h = vbi ? hojas(vbi).get('Pagos') : null
  if (h) {
    const cab = h[0].map((c) => c.t)
    return h.slice(1).map((r, i) => ({ fila: i + 2, f: Object.fromEntries(cab.map((k, j) => [k, r[j]?.t ?? ''])) }))
  }
  if (!carpeta || !existsSync(carpeta)) return null
  const json = (n) => JSON.parse(readFileSync(join(carpeta, n), 'utf8')).values
  const mod = async (n) => (await import(pathToFileURL(join(carpeta, n)).href)).default
  const desde = existsSync(join(carpeta, 'desde.json')) ? JSON.parse(readFileSync(join(carpeta, 'desde.json'), 'utf8')).fila : 570
  const fk = await mod('FK.mjs'), d = json('D.json'), m = json('M.json'), w = await mod('W.mjs'), z = await mod('ZAA.mjs')
  if (![d.length, m.length, z.length].every((n) => n === fk.length)) throw new Error(`Columnas de Pagos de distinto largo: F:K ${fk.length}, D ${d.length}, M ${m.length}, Z:AA ${z.length}`)
  if (w.length > fk.length) throw new Error('La columna W es más larga que F:K')
  // La API no devuelve las filas vacías del final: W puede ser más corta.
  return fk.map((r, i) => {
    const f = Object.fromEntries(COLS.map((k) => [k, '']))
    ;[f.REALIZADO_POR, f.BANCO_ORIGEN, f.NUMERO_CUENTA, f.NUMERO_CHEQUE, f.FECHA_PAGO, f.IMPORTE] = r
    f.PROVEEDOR_DESTINO = d[i]?.[0] ?? ''
    f.ESTADO_CONTABLE = m[i]?.[0] ?? ''
    f.CUENTA_CONTABLE = w[i]?.[0] ?? ''
    f.EMPRESA = z[i]?.[0] ?? ''
    f.CUENTA_ORIGEN = z[i]?.[1] ?? ''
    f.ID_PAGO = `VBI+Pagos-fila-${desde + i}`
    return { fila: desde + i, f }
  })
}

/**
 * Traduce y espeja los pagos de [desde, hasta] (fecha de pago). Devuelve el control:
 * { leidas, fuera_de_rango, traducidas, omitidas_traduccion: [{fila, motivo}], espejo: {nuevas, actualizadas, sin_cambios, omitidas} }
 */
export async function espejarPagos(db, filas, { desde, hasta }) {
  const empresas = (await db.query(`select id, nombre, coalesce(cuit, '') as cuit, erp::text as erp, alias, alias_orden from empresas`)).rows
  const ctl = { leidas: filas.length, fuera_de_rango: 0, traducidas: 0, omitidas_traduccion: [] }
  const datos = []
  for (const { fila, f } of filas) {
    const r = pagoDesdeFila(f, fila, empresas)
    if (!r.ok) { ctl.omitidas_traduccion.push({ fila, motivo: r.motivo }); continue }
    if (r.dato.fecha < desde || r.dato.fecha > hasta) { ctl.fuera_de_rango++; continue }
    datos.push(r.dato); ctl.traducidas++
  }
  const res = (await db.query(`select espejar_pagos($1::jsonb) as r`, [JSON.stringify(datos)])).rows[0].r
  ctl.espejo = res
  return ctl
}
