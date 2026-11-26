// Lectura de celdas de Google Sheets (respuesta de spreadsheets.get con grid data).
// Los importes se manejan en CENTAVOS (BigInt): nunca float para sumar plata.
import { createHash } from 'node:crypto'

const VACIA = Object.freeze({ t: '', n: null, f: false })

/** Respuesta de spreadsheets.get → Map(título → filas de celdas {t: texto, n: número, f: es fórmula}). */
export function hojas(respuesta) {
  const out = new Map()
  for (const s of respuesta?.sheets ?? []) {
    const filas = []
    for (const bloque of s.data ?? []) {
      for (const fila of bloque.rowData ?? []) {
        filas.push((fila.values ?? []).map((c) => ({
          t: String(c.formattedValue ?? '').trim(),
          n: typeof c.effectiveValue?.numberValue === 'number' ? c.effectiveValue.numberValue : null,
          f: Boolean(c.userEnteredValue?.formulaValue),
        })))
      }
    }
    out.set(s.properties.title, filas)
  }
  return out
}

export const celda = (fila, j) => (fila && fila[j]) || VACIA
export const texto = (fila, j) => celda(fila, j).t
export const vacia = (fila) => !fila || fila.every((c) => !c.t)

/** Mayúsculas, sin tildes, espacios simples (igual que texto_banco() de la base). */
export function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
}

/** Importe de una celda en centavos. Usa el valor numérico real (no el formato, que redondea). null si no hay número. */
export function centavos(c) {
  if (!c) return null
  if (typeof c.n === 'number' && Number.isFinite(c.n) && !esFechaTexto(c.t)) return BigInt(Math.round(c.n * 100))
  return centavosDeTexto(c.t)
}

const esFechaTexto = (t) => /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(t)

/** "1.234.567,89" · "-164321,19" · "24301.31" · "$ 10.980.750" · "(1.000)". */
export function centavosDeTexto(t) {
  let s = String(t ?? '').replace(/[$\s]/g, '')
  if (!s || s === '-') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) }
  if (!/^[\d.,]+$/.test(s)) return null
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.')
  let entero, dec = ''
  if (coma >= 0 && punto >= 0) {
    const sep = Math.max(coma, punto)
    entero = s.slice(0, sep).replace(/[.,]/g, ''); dec = s.slice(sep + 1)
  } else if (coma >= 0) {
    const partes = s.split(',')
    if (partes.length === 2 && partes[1].length !== 3) { entero = partes[0]; dec = partes[1] } else entero = partes.join('')
  } else if (punto >= 0) {
    const partes = s.split('.')
    if (partes.length === 2 && partes[1].length !== 3) { entero = partes[0]; dec = partes[1] } else entero = partes.join('')
  } else entero = s
  dec = (dec + '00').slice(0, 2)
  const v = BigInt(entero || '0') * 100n + BigInt(dec)
  return neg ? -v : v
}

/** Centavos → "1234.56" (para numeric de Postgres). */
export function pesos(c) {
  const neg = c < 0n, a = neg ? -c : c
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`
}

/** Centavos → "1.234,56" (para el reporte). */
export function pesosAR(c) {
  const neg = c < 0n, a = neg ? -c : c
  const ent = String(a / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${neg ? '−' : ''}${ent},${String(a % 100n).padStart(2, '0')}`
}

/** Fecha de una celda → 'AAAA-MM-DD'. Si la celda es fecha real usa el número de serie (sin ambigüedad).
 *  En texto: AAAA-MM-DD, DD/MM/AAAA o DD/MM/AA; con mdy=true, MM/DD/AAAA (lo que escribe un script en
 *  configuración de EE. UU.). Devuelve null si no se entiende. */
export function fecha(c, { mdy = false } = {}) {
  if (!c) return null
  const t = c.t
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  if (typeof c.n === 'number' && c.n > 20000 && c.n < 80000) return deSerie(c.n)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t)
  if (!m) return null
  const a = +m[1], b = +m[2]
  const anio = m[3].length === 2 ? 2000 + +m[3] : +m[3]
  let d = mdy ? b : a, mes = mdy ? a : b
  if (mes > 12 && d <= 12) [d, mes] = [mes, d]   // el orden real se ve cuando un número pasa de 12
  if (mes < 1 || mes > 12 || d < 1 || d > 31) return null
  return `${anio}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Número de serie de Sheets (días desde 30/12/1899) → 'AAAA-MM-DD'. */
export function deSerie(n) {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

/** Hora de una celda (fracción de día o 'HH:MM') → 'HH:MM'. */
export function hora(c) {
  if (!c) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(c.t)
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`
  if (typeof c.n === 'number' && c.n >= 0 && c.n < 1) {
    const min = Math.round(c.n * 1440)
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  }
  return null
}

export const clave = (...partes) => createHash('md5').update(partes.map((p) => norm(p)).join('|')).digest('hex').slice(0, 16)

/** Último día del mes de 'AAAA-MM'. */
export function finDeMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10)
}

export const sumarMeses = (anio, mes, n) => {
  const t = (anio * 12 + (mes - 1)) + n
  return [Math.floor(t / 12), (t % 12) + 1]
}
