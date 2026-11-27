// Ayudas de Tesorería que usan las pantallas y la demo: días hábiles, rótulos y la grilla del Flujo.
// Las reglas de verdad están en la base (0023 a 0027); esto solo replica lo necesario para mostrar.

import type {
  Cheque,
  CategoriaMovimiento,
  ClaseCuenta,
  ControlFlujo,
  CuentaBancaria,
  EstadoCheque,
  EstadoConciliacion,
  Factura,
  FilaFlujo,
  FotoFlujo,
  LineaFlujo,
  Pago,
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
  REVISAR: { label: 'Revisar rendimiento', tone: 'naranja' },
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

// ---------------------------------------------------------------- Exportar la grilla (fbExportar)

const fechaLarga = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
/** Un campo del CSV: entre comillas si trae separador, comillas o salto de línea. */
const campoCsv = (x: string | number | undefined): string => {
  if (x === undefined || x === '') return ''
  if (typeof x === 'number') return String(Math.round(x * 100) / 100).replace('.', ',')
  // Un texto que empieza con = + - @ (o tab / retorno) se leería como fórmula al abrirlo en la planilla: se neutraliza con una comilla.
  const t = /^[=+\-@\t\r]/.test(x) ? `'${x}` : x
  return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/**
 * La grilla visible como CSV para abrir en una planilla (el Apps Script la volcaba a una planilla nueva: fbExportar).
 * Misma estructura: Sección, Cuenta y una columna por día; después ingresos y egresos del día y la caja. Separador ";",
 * decimales con coma y BOM, así Excel y Google Sheets en español lo leen sin vueltas. Las filas sin importes no van.
 */
export function grillaACsv(g: Grilla): string {
  const dias = g.dias
  const filas: (string | number | undefined)[][] = [['Sección', 'Cuenta', ...dias.map(fechaLarga), 'Total']]
  const ing = dias.map(() => 0)
  const egr = dias.map(() => 0)
  const suma = (f: FilaGrilla) => {
    dias.forEach((d, i) => {
      const v = f.valores[d]
      if (v === undefined) return
      if (v > 0) ing[i] += v
      else egr[i] += -v
    })
  }
  const linea = (seccion: string, f: FilaGrilla) => {
    if (dias.every((d) => f.valores[d] === undefined)) return
    filas.push([seccion, f.fila.etiqueta, ...dias.map((d) => f.valores[d]), f.total])
    suma(f)
  }
  for (const b of g.bloques) for (const f of b.filas) linea(b.seccion.etiqueta, f)
  for (const f of g.internas) linea('', f)
  const r2 = (n: number) => Math.round(n * 100) / 100
  filas.push(
    ['', 'Ingresos del día', ...ing.map(r2), r2(ing.reduce((a, x) => a + x, 0))],
    ['', 'Egresos del día', ...egr.map(r2), r2(egr.reduce((a, x) => a + x, 0))],
    ['', 'Flujo neto del día', ...dias.map((d) => g.neto[d]), r2(dias.reduce((a, d) => a + g.neto[d], 0))],
    ['', 'Caja inicial', ...dias.map((d) => g.cajaInicial[d])],
    ['', 'Caja acumulada', ...dias.map((d) => g.cajaFinal[d])],
  )
  return '﻿' + filas.map((f) => f.map(campoCsv).join(';')).join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------- Bloques con detalle (flujoBloquesDatos / fbItem_)

export type EstadoItemBloque = 'PAGADO' | 'BANCO' | 'DEBITADO' | 'A DEBITAR' | 'PROGRAMADO' | 'PARCIAL' | 'PROYECTADO' | 'MANUAL' | 'PLANILLA'
export interface ItemBloque {
  linea: LineaFlujo
  tipo: 'PAGO' | 'CHEQUE' | 'COBRO' | 'BANCO' | 'FACTURA' | 'PROYECCION' | 'MANUAL' | 'PLANILLA'
  estado: EstadoItemBloque
  /** Lo que se sabe de ese renglón: número, vencimiento, cheque, comprobante. */
  detalle: string[]
  /** Se puede mover, editar o eliminar (lo proyectado). */
  editable: boolean
}
export interface BloqueDetalle {
  /** Valor absoluto de la celda. */
  total: number
  pagado: number
  estado: 'PAGADO' | 'PARCIAL' | 'PROYECTADO' | 'PROGRAMADO'
  ingreso: boolean
  items: ItemBloque[]
  /** Lo que hay cargado a mano en la celda (filas MANUAL): entra en el total como cualquier otra línea. */
  manual: number
}

const numeroFactura = (f: Factura) => `${String(f.puntoVenta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}`

/**
 * El detalle de un bloque (fila × día): cada línea con su estado y sus datos, y el estado del bloque como el
 * Apps Script: PAGADO si lo pagado llega al total, PARCIAL si hay algo pagado, PROYECTADO si todo es proyectado,
 * si no PROGRAMADO. Un día pasado cuenta entero como pagado. Las cargas manuales suman como cualquier línea.
 */
export function bloqueDetalle(
  lineas: LineaFlujo[],
  ctx: { hoy: string; facturas: Factura[]; pagos: Pago[]; cheques: Cheque[]; cuentas: CuentaBancaria[]; proyecciones: Proyeccion[]; fila?: FilaFlujo },
): BloqueDetalle {
  const items: ItemBloque[] = lineas.map((l) => {
    const real = l.naturaleza === 'REAL'
    const detalle: string[] = []
    const proy = l.origenTipo === 'PROYECCION' ? ctx.proyecciones.find((x) => x.id === l.origenId) : undefined
    if (l.origenTipo === 'FACTURA') {
      const f = ctx.facturas.find((x) => x.id === l.origenId)
      if (f) {
        detalle.push(`${f.tipo} ${numeroFactura(f)}`)
        detalle.push(`Vence ${fechaLarga(f.vencimiento)}${f.fechaPago ? ` · programada ${fechaLarga(f.fechaPago)}` : ''}`)
        detalle.push(`Total ${num(f.total)}${f.pagadoPct > 0 ? ` · pagada ${Math.round(f.pagadoPct)} %` : ''}`)
        if (f.tipoPago === 'ANTICIPO_PARCIAL' && f.anticipoPct) detalle.push(`Anticipo ${f.anticipoPct} % + cuenta corriente (${l.ocurrencia === 'ANTICIPO' ? 'tramo del anticipo' : 'saldo'})`)
        if (f.ncAplicadas?.length) detalle.push(`${f.ncAplicadas.length} nota(s) de crédito aplicada(s)`)
      }
    } else if (l.origenTipo === 'PAGO') {
      const p = ctx.pagos.find((x) => x.id === l.origenId)
      if (p) {
        const fs = p.facturaIds.map((id) => ctx.facturas.find((f) => f.id === id)).filter((f): f is Factura => !!f)
        detalle.push(fs.length ? `Factura asociada: ${fs.map(numeroFactura).join(', ')}` : 'Sin factura asociada')
        if (p.cuentaOrigen) detalle.push(`Desde ${p.cuentaOrigen}`)
        if (p.comprobante || p.comprobanteUrl) detalle.push('Con comprobante')
      }
    } else if (l.origenTipo === 'CHEQUE') {
      const c = ctx.cheques.find((x) => x.id === l.origenId)
      if (c) {
        const banco = ctx.cuentas.find((x) => x.id === c.cuentaId)?.nombre
        detalle.push(`Cheque ${c.numero} (${c.tipo})${banco ? ` · ${banco}` : ''}`)
        detalle.push(c.estado === 'DEBITADO' ? `Debitado el ${c.debitadoEn ? fechaLarga(c.debitadoEn) : fechaLarga(l.fecha)}` : `Fecha de pago ${fechaLarga(c.fechaPago)}`)
      }
    } else if (proy) {
      detalle.push(proy.recurrencia === 'UNICA' ? 'Proyección puntual' : `Proyección ${proy.recurrencia.toLowerCase()}${proy.ajustePctMensual ? ` con ajuste de ${String(proy.ajustePctMensual).replace('.', ',')} % por mes` : ''}`)
      if (proy.nota) detalle.push(proy.nota)
    }
    let tipo: ItemBloque['tipo'] = l.origenTipo === 'MOVIMIENTO' || l.origenTipo === 'RENDIMIENTO' ? 'BANCO' : (l.origenTipo as ItemBloque['tipo'])
    let estado: EstadoItemBloque
    if (l.origenTipo === 'PROYECCION') {
      tipo = proy?.origen === 'MANUAL' ? 'MANUAL' : proy?.origen === 'PLANILLA_GASTOS' ? 'PLANILLA' : 'PROYECCION'
      estado = tipo === 'MANUAL' ? 'MANUAL' : tipo === 'PLANILLA' ? 'PLANILLA' : 'PROYECTADO'
    } else if (l.origenTipo === 'FACTURA') {
      const f = ctx.facturas.find((x) => x.id === l.origenId)
      estado = f && f.pagadoPct > 0 && f.pagadoPct < 100 ? 'PARCIAL' : 'PROGRAMADO'
    } else if (l.origenTipo === 'CHEQUE') estado = real ? 'DEBITADO' : 'A DEBITAR'
    else if (l.origenTipo === 'MOVIMIENTO' || l.origenTipo === 'RENDIMIENTO') estado = 'BANCO'
    else estado = 'PAGADO'
    if (l.ajustada) detalle.push(`Ajustada a mano (la calculada era el ${fechaLarga(l.fechaCalculada)})`)
    return { linea: l, tipo, estado, detalle, editable: l.editable }
  })
  const neto = Math.round(lineas.reduce((a, l) => a + l.importe, 0) * 100) / 100
  const total = Math.abs(neto)
  const pagado = Math.round(lineas.filter((l) => l.naturaleza === 'REAL').reduce((a, l) => a + Math.abs(l.importe), 0) * 100) / 100
  const pasado = lineas.length > 0 && lineas.every((l) => l.fecha < ctx.hoy)
  const estado: BloqueDetalle['estado'] =
    pasado || (total > 0 && pagado >= total - 1)
      ? 'PAGADO'
      : pagado > 0
        ? 'PARCIAL'
        : items.length > 0 && items.every((i) => i.estado === 'PROYECTADO' || i.estado === 'MANUAL' || i.estado === 'PLANILLA')
          ? 'PROYECTADO'
          : 'PROGRAMADO'
  const manual = Math.round(items.filter((i) => i.tipo === 'MANUAL').reduce((a, i) => a + i.linea.importe, 0) * 100) / 100
  const ingreso = ctx.fila ? ctx.fila.seccion === 'INGRESOS_OPERATIVOS' || ctx.fila.seccion === 'INGRESOS_FINANCIEROS' || ctx.fila.seccion === 'TOMA_DEUDA' : neto > 0
  return { total, pagado, estado, ingreso, items, manual }
}

// ---------------------------------------------------------------- Foto mensual (resumen_flujo_dias)

export interface ResumenDia {
  dia: string
  ingresosOperativos: number
  costos: number
  gastosOperativos: number
  impuestos: number
  subtotal: number
  socios: number
  intercompany: number
  variacionCaja: number
}

const redondear = (n: number) => Math.round(n * 100) / 100

/**
 * El Flujo de una unidad resumido por día y sección, como resumen_flujo_dias() en SQL: ingresos operativos, costos,
 * gastos, impuestos, su subtotal, socios, intercompany y la variación de caja. Es lo que guarda la foto y lo que se
 * compara con ella.
 */
export function resumenDias(lineas: LineaFlujo[], filas: FilaFlujo[], unidadId: string, dias: string[]): ResumenDia[] {
  const fila = new Map(filas.map((f) => [f.id, f] as const))
  const por = new Map<string, LineaFlujo[]>()
  for (const l of lineas) if (l.unidadId === unidadId) por.set(l.fecha, [...(por.get(l.fecha) ?? []), l])
  return dias.map((dia) => {
    const ls = por.get(dia) ?? []
    const de = (...s: SeccionFlujo[]) => redondear(ls.filter((l) => s.includes(fila.get(l.filaId)?.seccion as SeccionFlujo)).reduce((a, l) => a + l.importe, 0))
    return {
      dia,
      ingresosOperativos: de('INGRESOS_OPERATIVOS'),
      costos: de('COSTOS'),
      gastosOperativos: de('GASTOS_OPERATIVOS'),
      impuestos: de('IMPUESTOS'),
      subtotal: de('INGRESOS_OPERATIVOS', 'COSTOS', 'GASTOS_OPERATIVOS', 'IMPUESTOS'),
      socios: de('SOCIOS'),
      intercompany: de('INTERCOMPANY'),
      variacionCaja: redondear(ls.filter((l) => fila.get(l.filaId)?.mueveCaja !== false).reduce((a, l) => a + l.importe, 0)),
    }
  })
}

/** Los días de un mes (aaaa-mm): los hábiles y los que tienen líneas. */
export function diasDelMes(mes: string, lineas: LineaFlujo[], unidadId: string, feriados: Set<string>): string[] {
  const [a, m] = mes.split('-').map(Number)
  const ultimo = new Date(a, m, 0).getDate()
  const set = new Set<string>()
  for (let d = 1; d <= ultimo; d++) {
    const x = `${mes}-${String(d).padStart(2, '0')}`
    if (esDiaHabil(x, feriados)) set.add(x)
  }
  for (const l of lineas) if (l.unidadId === unidadId && l.fecha.startsWith(mes)) set.add(l.fecha)
  return [...set].sort()
}

export interface FilaComparacion {
  dia: string
  foto?: FotoFlujo
  ahora: ResumenDia
  /** Lo de hoy menos lo de la foto, en la variación de caja. */
  diferencia: number
}

/** La foto de un mes contra cómo está el mes hoy (el "Real vs Proyectado" de la planilla del motor). */
export function compararFoto(fotos: FotoFlujo[], ahora: ResumenDia[]): FilaComparacion[] {
  return ahora.map((a) => {
    const foto = fotos.find((f) => f.dia === a.dia)
    return { dia: a.dia, foto, ahora: a, diferencia: redondear(a.variacionCaja - (foto?.variacionCaja ?? 0)) }
  })
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
