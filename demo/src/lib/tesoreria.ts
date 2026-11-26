// Ayudas de Tesorería que usan las pantallas y la demo: días hábiles, rótulos y la grilla del Flujo.
// Las reglas de verdad están en la base (0023 a 0027); esto solo replica lo necesario para mostrar.

import type {
  CategoriaMovimiento,
  ClaseCuenta,
  ControlFlujo,
  CuentaBancaria,
  EstadoCheque,
  EstadoConciliacion,
  FilaFlujo,
  LineaFlujo,
  Proyeccion,
  SaldoBancario,
  SeccionFlujo,
} from '../types'
import { addDays, iso, parseIso } from './format'

// ---------------------------------------------------------------- Días hábiles (es_dia_habil, dia_habil_desde…)

export function esDiaHabil(d: string, feriados: Set<string>): boolean {
  const dow = parseIso(d).getDay()
  return dow !== 0 && dow !== 6 && !feriados.has(d)
}

/** El primer día hábil desde d inclusive. */
export function diaHabilDesde(d: string, feriados: Set<string>): string {
  let x = parseIso(d)
  while (!esDiaHabil(iso(x), feriados)) x = addDays(x, 1)
  return iso(x)
}

/** El día hábil anterior a d (exclusive). */
export function diaHabilAnterior(d: string, feriados: Set<string>): string {
  let x = addDays(parseIso(d), -1)
  while (!esDiaHabil(iso(x), feriados)) x = addDays(x, -1)
  return iso(x)
}

/** Suma n días hábiles (n puede ser negativo). Con n = 0 devuelve el día hábil desde d. */
export function sumarHabiles(d: string, n: number, feriados: Set<string>): string {
  let x = diaHabilDesde(d, feriados)
  for (let i = 0; i < Math.abs(n); i++) {
    x = n > 0 ? diaHabilDesde(iso(addDays(parseIso(x), 1)), feriados) : diaHabilAnterior(x, feriados)
  }
  return x
}

/** n días hábiles desde d (inclusive). */
export function diasHabiles(desde: string, n: number, feriados: Set<string>): string[] {
  const r: string[] = []
  let x = diaHabilDesde(desde, feriados)
  while (r.length < n) {
    r.push(x)
    x = diaHabilDesde(iso(addDays(parseIso(x), 1)), feriados)
  }
  return r
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
/** "jue 26/11" */
export function diaCorto(d: string): string {
  const x = parseIso(d)
  return `${DIAS[x.getDay()]} ${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}`
}

// ---------------------------------------------------------------- Proyecciones (proyeccion_ocurrencias)

/** Las fechas de una proyección entre dos días, como proyeccion_ocurrencias() en SQL. */
export function ocurrenciasProyeccion(p: Proyeccion, desde: string, hasta: string, feriados: Set<string>): { ocurrencia: string; fecha: string; importe: number }[] {
  const fin = p.hasta && p.hasta < hasta ? p.hasta : hasta
  const r: { ocurrencia: string; fecha: string; importe: number }[] = []
  if (p.recurrencia === 'UNICA') {
    if (p.fechaInicio >= desde && p.fechaInicio <= fin) r.push({ ocurrencia: p.fechaInicio, fecha: diaHabilDesde(p.fechaInicio, feriados), importe: p.importe })
    return r
  }
  const ini = parseIso(p.fechaInicio)
  let mes = new Date(ini.getFullYear(), ini.getMonth(), 1)
  let n = 0
  for (let guard = 0; guard < 400; guard++) {
    let d: Date
    if (p.recurrencia === 'MENSUAL') {
      const ultimo = new Date(mes.getFullYear(), mes.getMonth() + 1, 0).getDate()
      d = new Date(mes.getFullYear(), mes.getMonth(), Math.min(p.diaMes ?? 1, ultimo))
      mes = new Date(mes.getFullYear(), mes.getMonth() + 1, 1)
      if (iso(d) < p.fechaInicio) continue
    } else {
      d = addDays(ini, (p.recurrencia === 'SEMANAL' ? 7 : 14) * n)
    }
    const di = iso(d)
    if (di > fin || (p.cuotas !== undefined && n >= p.cuotas)) break
    if (di >= desde) {
      const meses = (d.getFullYear() - ini.getFullYear()) * 12 + d.getMonth() - ini.getMonth() - (d.getDate() < ini.getDate() ? 1 : 0)
      const importe = Math.round(p.importe * Math.pow(1 + p.ajustePctMensual / 100, Math.max(0, meses)) * 100) / 100
      r.push({ ocurrencia: di, fecha: diaHabilDesde(di, feriados), importe })
    }
    n++
  }
  return r
}

// ---------------------------------------------------------------- Rótulos

export const CATEGORIAS_MOV: Record<CategoriaMovimiento, string> = {
  SIN_CLASIFICAR: 'Sin clasificar',
  PAGO: 'Pago',
  COBRO: 'Cobro',
  IMPUESTO: 'Impuesto',
  GASTO_BANCARIO: 'Gasto bancario',
  FCI: 'FCI (suscripción / rescate)',
  FCI_RENDIMIENTO: 'Rendimiento FCI',
  TRANSFERENCIA_PROPIA: 'Entre cuentas propias',
  CHEQUE_PAGADO: 'Cheque debitado',
  INTERESES: 'Intereses',
  PRESTAMO: 'Préstamo',
  INFORMATIVO: 'Informativo',
}

export const CLASES: Record<ClaseCuenta, string> = {
  CC: 'Cuenta corriente',
  CA: 'Caja de ahorro',
  FCI: 'FCI',
  REMUNERADA: 'Remunerada',
  BILLETERA: 'Billetera',
  CAJA: 'Caja',
  ECHEQ: 'E-cheq',
  TARJETA: 'Tarjeta',
}

type Tono = 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja'

export const ESTADO_CONCILIACION: Record<EstadoConciliacion, { label: string; tone: Tono }> = {
  OK: { label: 'OK', tone: 'verde' },
  DIFERENCIA: { label: 'Diferencia', tone: 'rojo' },
  SIN_EXTRACTO: { label: 'Sin extracto', tone: 'naranja' },
  SIN_MOVIMIENTOS: { label: 'Sin movimientos', tone: 'azul' },
  PRIMER_SALDO: { label: 'Primer saldo', tone: 'neutro' },
}

export const ESTADO_CHEQUE: Record<EstadoCheque, { label: string; tone: Tono }> = {
  EMITIDO: { label: 'Emitido', tone: 'dorado' },
  ENTREGADO: { label: 'Entregado', tone: 'azul' },
  DEBITADO: { label: 'Debitado', tone: 'verde' },
  ANULADO: { label: 'Anulado', tone: 'neutro' },
  RECHAZADO: { label: 'Rechazado', tone: 'rojo' },
}

export const SECCIONES: SeccionFlujo[] = [
  'INGRESOS_OPERATIVOS',
  'COSTOS',
  'GASTOS_OPERATIVOS',
  'IMPUESTOS',
  'CAPEX',
  'INGRESOS_FINANCIEROS',
  'TOMA_DEUDA',
  'DEVOLUCION_DEUDA',
  'SOCIOS',
  'INTERCOMPANY',
]

// ---------------------------------------------------------------- Saldos

/** El saldo de una cuenta al cierre de d: el del día, o el último anterior. */
export function saldoAl(saldos: SaldoBancario[], cuentaId: string, d: string): SaldoBancario | undefined {
  let mejor: SaldoBancario | undefined
  for (const s of saldos) if (s.cuentaId === cuentaId && s.fecha <= d && (!mejor || s.fecha > mejor.fecha)) mejor = s
  return mejor
}

// ---------------------------------------------------------------- Grilla del Flujo

export interface FilaGrilla {
  fila: FilaFlujo
  /** Importe por día (columna). */
  valores: Record<string, number>
  /** Hay algo proyectado en la celda (se muestra distinto). */
  proyectado: Record<string, boolean>
  total: number
  vacia: boolean
}

export interface BloqueGrilla {
  seccion: FilaFlujo
  filas: FilaGrilla[]
  subtotal: Record<string, number>
  total: number
}

export interface Grilla {
  dias: string[]
  bloques: BloqueGrilla[]
  internas: FilaGrilla[]
  neto: Record<string, number>
  cajaInicial: Record<string, number>
  cajaFinal: Record<string, number>
  /** De dónde sale la caja inicial: saldo real de los bancos o la caja final proyectada del día anterior. */
  cajaInicialReal: Record<string, boolean>
  bancos: { cuenta: CuentaBancaria; saldos: Record<string, SaldoBancario | undefined> }[]
  totalBancos: Record<string, number | undefined>
  control: Record<string, ControlFlujo | undefined>
}

/**
 * Arma la grilla de una unidad: filas = flujo_filas por sección (1 a 10, más las internas), columnas = días
 * hábiles, celda = suma de flujo_lineas. Caja inicial = saldo de los bancos del día hábil anterior cuando
 * están todos; si no, la caja final del día anterior (lo proyectado se acumula).
 */
export function armarGrilla(args: {
  unidadId: string
  dias: string[]
  filas: FilaFlujo[]
  lineas: LineaFlujo[]
  cuentas: CuentaBancaria[]
  saldos: SaldoBancario[]
  control: ControlFlujo[]
  feriados: Set<string>
}): Grilla {
  const { unidadId, dias, feriados } = args
  const filas = args.filas.filter((f) => f.unidadId === unidadId).sort((a, b) => a.orden - b.orden)
  const enDias = new Set(dias)
  const lineas = args.lineas.filter((l) => l.unidadId === unidadId && enDias.has(l.fecha))
  const porFila = new Map<string, LineaFlujo[]>()
  for (const l of lineas) porFila.set(l.filaId, [...(porFila.get(l.filaId) ?? []), l])

  const filaGrilla = (f: FilaFlujo): FilaGrilla => {
    const valores: Record<string, number> = {}
    const proyectado: Record<string, boolean> = {}
    let total = 0
    for (const l of porFila.get(f.id) ?? []) {
      valores[l.fecha] = Math.round(((valores[l.fecha] ?? 0) + l.importe) * 100) / 100
      if (l.naturaleza === 'PROYECTADO') proyectado[l.fecha] = true
      total += l.importe
    }
    return { fila: f, valores, proyectado, total: Math.round(total * 100) / 100, vacia: !porFila.has(f.id) }
  }

  const bloques: BloqueGrilla[] = []
  for (const sec of filas.filter((f) => f.tipo === 'SECCION')) {
    const hijas = filas.filter((f) => f.seccion === sec.seccion && f.tipo !== 'SECCION' && f.tipo !== 'INTERNO').map(filaGrilla)
    const subtotal: Record<string, number> = {}
    for (const d of dias) subtotal[d] = Math.round(hijas.reduce((a, h) => a + (h.valores[d] ?? 0), 0) * 100) / 100
    bloques.push({ seccion: sec, filas: hijas, subtotal, total: Math.round(hijas.reduce((a, h) => a + h.total, 0) * 100) / 100 })
  }
  const internas = filas.filter((f) => f.tipo === 'INTERNO').map(filaGrilla)

  const neto: Record<string, number> = {}
  for (const d of dias) neto[d] = Math.round(lineas.filter((l) => l.fecha === d).reduce((a, l) => a + l.importe, 0) * 100) / 100

  const cuentas = args.cuentas.filter((c) => c.unidadId === unidadId && c.requiereExtracto).sort((a, b) => a.orden - b.orden)
  const bancos = cuentas.map((c) => ({
    cuenta: c,
    saldos: Object.fromEntries(dias.map((d) => [d, args.saldos.find((s) => s.cuentaId === c.id && s.fecha === d)])) as Record<string, SaldoBancario | undefined>,
  }))
  const totalBancos: Record<string, number | undefined> = {}
  for (const d of dias) {
    const todos = bancos.every((b) => b.saldos[d])
    totalBancos[d] = todos && bancos.length ? Math.round(bancos.reduce((a, b) => a + (b.saldos[d]?.saldo ?? 0), 0) * 100) / 100 : undefined
  }
  // Saldo completo de los bancos al cierre de un día (todas las cuentas con saldo ese día).
  const bancosCompletos = (d: string): number | undefined => {
    if (!cuentas.length) return undefined
    const ss = cuentas.map((c) => args.saldos.find((s) => s.cuentaId === c.id && s.fecha === d))
    return ss.every(Boolean) ? Math.round(ss.reduce((a, s) => a + (s?.saldo ?? 0), 0) * 100) / 100 : undefined
  }
  const cajaInicial: Record<string, number> = {}
  const cajaFinal: Record<string, number> = {}
  const cajaInicialReal: Record<string, boolean> = {}
  let previa: number | undefined
  for (const d of dias) {
    const real = bancosCompletos(diaHabilAnterior(d, feriados))
    if (real !== undefined) {
      cajaInicial[d] = real
      cajaInicialReal[d] = true
    } else {
      // Sin saldos del día anterior: la caja final de la columna anterior, o el último saldo de cada banco.
      cajaInicial[d] =
        previa ?? Math.round(cuentas.reduce((a, c) => a + (saldoAl(args.saldos, c.id, diaHabilAnterior(d, feriados))?.saldo ?? 0), 0) * 100) / 100
      cajaInicialReal[d] = false
    }
    cajaFinal[d] = Math.round((cajaInicial[d] + neto[d]) * 100) / 100
    previa = cajaFinal[d]
  }
  const control: Record<string, ControlFlujo | undefined> = {}
  for (const d of dias) control[d] = args.control.find((c) => c.unidadId === unidadId && c.fecha === d)

  return { dias, bloques, internas, neto, cajaInicial, cajaFinal, cajaInicialReal, bancos, totalBancos, control }
}

/** Normaliza como texto_banco() en SQL: mayúsculas, sin tildes, espacios simples. */
export function textoBanco(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- Importes

const numFmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 1.234,56 sin signo de moneda (para la grilla). */
export const num = (n: number) => numFmt.format(n)

/** Lee "1.234,56", "1234.56" o "1234,5". Null si no es un número. */
export function parseMonto(s: string): number | null {
  const t = s.trim().replace(/\s|\$/g, '')
  if (!t) return null
  const normal = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : /^\-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t
  const n = Number(normal)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
