// Normalización común a todos los bancos: fechas, números con coma decimal, débito/crédito → importe con
// signo, n.º de cheque, orden cronológico y huella del archivo.

import { createHash } from 'node:crypto'
import { ErrorExtracto, type Celda, type FilaPlanilla, type MovimientoExtracto } from './tipos'

/** sha256 del archivo tal cual llegó: el mismo archivo no entra dos veces en la misma cuenta. */
export function huellaArchivo(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export const redondear2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Mayúsculas, sin tildes, sin signos: para comparar encabezados. */
export function clave(v: Celda): string {
  return texto(v)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9$]+/g, ' ')
    .trim()
}

/** Texto limpio de una celda: espacios simples, sin espacios en las puntas. */
export function texto(v: Celda): string {
  if (v == null) return ''
  if (v instanceof Date) return fechaISO(v) ?? ''
  return String(v).replace(/\s+/g, ' ').trim()
}

/**
 * Número de un extracto argentino: "12.500,00", "$ 5,00", "- $ 123.456,78", "-12345.6", "(1.234,50)".
 * Devuelve null si la celda está vacía o es un guion ("-" = sin importe en Brubank).
 * Con punto y coma, el último separador es el decimal. Solo coma: coma decimal. Solo puntos: si son
 * grupos de a tres ("15.600") son miles; si no, es punto decimal (Excel en inglés: "29112.90").
 */
export function numero(v: Celda): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v instanceof Date) return null
  let s = v.replace(/\s+/g, '').replace(/\$/g, '').replace(/ARS/gi, '')
  if (s === '' || s === '-' || s === '--') return null
  let negativo = false
  if (/^\(.*\)$/.test(s)) {
    negativo = true
    s = s.slice(1, -1)
  }
  if (s.startsWith('-')) {
    negativo = !negativo
    s = s.slice(1)
  } else if (s.endsWith('-')) {
    negativo = !negativo
    s = s.slice(0, -1)
  }
  if (s.startsWith('+')) s = s.slice(1)
  const coma = s.lastIndexOf(',')
  const punto = s.lastIndexOf('.')
  if (coma >= 0 && punto >= 0) {
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (coma >= 0) {
    if ((s.match(/,/g) ?? []).length > 1) throw new ErrorExtracto(`Número con varias comas: "${v}"`)
    s = s.replace(',', '.')
  } else if (punto >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ErrorExtracto(`No se entiende el número "${v}"`)
  const n = Number(s)
  return negativo ? -n : n
}

const dos = (n: number) => String(n).padStart(2, '0')
function armarFecha(a: number, m: number, d: number): string | null {
  const f = new Date(Date.UTC(a, m - 1, d))
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null
  return `${a}-${dos(m)}-${dos(d)}`
}

/**
 * Fecha a aaaa-mm-dd. Acepta dd/mm/aaaa, dd-mm-aa, aaaa-mm-dd, fecha de Excel (Date) y número de serie
 * de Excel (días desde 30/12/1899). Las fechas de los bancos argentinos son siempre día/mes.
 */
export function fechaISO(v: Celda): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : armarFecha(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null // fuera de 1954–2119: no es una fecha
    const f = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000)
    return armarFecha(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate())
  }
  const s = String(v).trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s)
  if (m) return armarFecha(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s.*)?$/.exec(s)
  if (m) return armarFecha(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])
  return null
}

/** La fecha obligatoria de un movimiento: si no se entiende, el archivo no se importa. */
export function fechaObligatoria(v: Celda, fila: number): string {
  const f = fechaISO(v)
  if (!f) throw new ErrorExtracto(`Fila ${fila}: no se entiende la fecha "${texto(v)}"`)
  return f
}

/** Débito y crédito (los dos en positivo, como los muestran los bancos) → importe con signo. */
export function importeDesde(debito: Celda, credito: Celda, fila: number): number {
  const d = Math.abs(numero(debito) ?? 0)
  const c = Math.abs(numero(credito) ?? 0)
  if (d && c) throw new ErrorExtracto(`Fila ${fila}: tiene débito y crédito a la vez`)
  return redondear2(c - d)
}

/** N.º de cheque cuando el banco lo informa ("Chq: 12345"); "Chq: 0" es que no hay cheque. */
export function numeroCheque(...textos: string[]): string | null {
  for (const t of textos) {
    const m = /CHQ\s*:?\s*(\d+)/i.exec(t)
    if (m && Number(m[1]) !== 0) return m[1].replace(/^0+/, '')
  }
  return null
}

/** Referencia como texto: los números de Excel vienen como 395023 (sin ".0"); 0 o vacío = sin referencia. */
export function referencia(v: Celda): string | null {
  if (v == null) return null
  if (typeof v === 'number') return v === 0 ? null : String(v)
  const s = texto(v)
  return s === '' || s === '0' ? null : s
}

/**
 * Busca la fila de encabezados: la primera (de las primeras 30) que tiene todas las columnas pedidas.
 * Devuelve la fila y la posición de cada columna (por nombre normalizado con clave()).
 */
export function buscarEncabezado(filas: FilaPlanilla[], columnas: string[]): { fila: number; col: Record<string, number> } | null {
  for (let i = 0; i < Math.min(filas.length, 30); i++) {
    const nombres = filas[i].map(clave)
    const col: Record<string, number> = {}
    let todas = true
    for (const c of columnas) {
      const j = nombres.indexOf(clave(c))
      if (j < 0) {
        todas = false
        break
      }
      col[c] = j
    }
    if (todas) return { fila: i, col }
  }
  return null
}

/**
 * Deja los movimientos en orden cronológico, que es lo que espera importar_extracto (el saldo de cierre
 * del día es el del último movimiento de ese día). Algunos bancos los dan del más nuevo al más viejo:
 * se mira la cadena de saldos (saldo = anterior + importe) para saber en qué sentido vienen dentro del día.
 */
export function ordenCronologico(movs: MovimientoExtracto[]): MovimientoExtracto[] {
  let asc = 0
  let desc = 0
  for (let i = 1; i < movs.length; i++) {
    const a = movs[i - 1]
    const b = movs[i]
    if (a.saldo == null || b.saldo == null) continue
    if (Math.abs(a.saldo + b.importe - b.saldo) < 0.005) asc++
    if (Math.abs(b.saldo + a.importe - a.saldo) < 0.005) desc++
  }
  const base = desc > asc ? [...movs].reverse() : [...movs]
  // Orden estable por fecha (sort de JS es estable): respeta el orden del banco dentro del día.
  return base.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0))
}

/** Cuántas veces se corta la cadena de saldos (saldo ≠ anterior + importe). 0 = el archivo cierra. */
export function cortesDeSaldo(movs: MovimientoExtracto[]): number {
  let cortes = 0
  for (let i = 1; i < movs.length; i++) {
    const a = movs[i - 1].saldo
    const b = movs[i].saldo
    if (a == null || b == null) continue
    if (Math.abs(a + movs[i].importe - b) >= 0.005) cortes++
  }
  return cortes
}

/** Aviso estándar si la cadena de saldos no cierra (no frena: lo marca la conciliación). */
export function avisoSaldos(movs: MovimientoExtracto[]): string[] {
  const c = cortesDeSaldo(movs)
  return c ? [`La cadena de saldos se corta ${c} ${c === 1 ? 'vez' : 'veces'}: revisá que el archivo esté completo`] : []
}

/** Día hábil anterior (salta sábados y domingos; los feriados no los conoce). */
export function diaHabilAnterior(iso: string): string {
  const f = new Date(iso + 'T00:00:00Z')
  do f.setUTCDate(f.getUTCDate() - 1)
  while (f.getUTCDay() === 0 || f.getUTCDay() === 6)
  return f.toISOString().slice(0, 10)
}

/** Totales de control de una lista de movimientos. */
export function totales(movs: MovimientoExtracto[]) {
  let debitos = 0
  let creditos = 0
  for (const m of movs) {
    if (m.importe < 0) debitos -= m.importe
    else creditos += m.importe
  }
  return { debitos: redondear2(debitos), creditos: redondear2(creditos), filas: movs.length }
}
