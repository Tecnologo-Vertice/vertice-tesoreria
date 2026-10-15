const ars = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const arsCorto = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
})

export const money = (n: number) => ars.format(n)
export const moneyShort = (n: number) => arsCorto.format(n)

export const DAY = 24 * 60 * 60 * 1000

export function hoy(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** Fecha local en AAAA-MM-DD. No usar toISOString: pasa a UTC y después de las 21 h da mañana. */
export function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Lo que falta pagar de una factura, en pesos. */
export function pendiente(f: { total: number; pagado: number }): number {
  return Math.round((f.total - f.pagado) * 100) / 100
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fecha(s: string | undefined): string {
  if (!s) return '—'
  const d = parseIso(s.slice(0, 10))
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function fechaHora(s: string | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  return d.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function diasHasta(s: string): number {
  return Math.round((parseIso(s).getTime() - hoy().getTime()) / DAY)
}

export function fmtCuit(c: string): string {
  const d = c.replace(/\D/g, '')
  if (d.length !== 11) return c
  return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`
}

/** Dígito verificador de CUIT, para que los CUIT ficticios pasen validación. */
export function cuitConVerificador(prefijo: string, cuerpo: string): string {
  const base = (prefijo + cuerpo).padEnd(10, '0').slice(0, 10)
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = base.split('').reduce((acc, ch, i) => acc + Number(ch) * pesos[i], 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return base + String(dv)
}

export function nroComprobante(pv: number, n: number): string {
  return `${String(pv).padStart(5, '0')}-${String(n).padStart(8, '0')}`
}

export function inicioSemana(d: Date): Date {
  const r = new Date(d)
  const day = r.getDay() === 0 ? 7 : r.getDay()
  r.setDate(r.getDate() - (day - 1))
  r.setHours(0, 0, 0, 0)
  return r
}
