// Pruebas de lo que la pantalla del Flujo hace sola (Tanda 6, 0038): exportar la grilla (CSV), el detalle de cada bloque con las
// filas MANUAL sumando, y la comparación de la foto mensual. Datos ficticios.
// Uso: npm run test:grilla   (node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/flujo-grilla.prueba.mts)
import { armarGrilla, bloqueDetalle, compararFoto, diasDelMes, grillaACsv, resumenDias } from '../../src/lib/tesoreria.ts'
import type { Cheque, CuentaBancaria, Factura, FilaFlujo, FotoFlujo, LineaFlujo, Pago, Proyeccion } from '../../src/types.ts'

let ok = 0
let mal = 0
function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}

const U = 'u1'
const hoy = '2026-11-27' // viernes
const dias = ['2026-11-26', '2026-11-27', '2026-11-30', '2026-12-01']
const fila = (id: string, orden: number, tipo: FilaFlujo['tipo'], seccion: FilaFlujo['seccion'], etiqueta: string, extra: Partial<FilaFlujo> = {}): FilaFlujo => ({
  id, unidadId: U, orden, tipo, seccion, etiqueta, mueveCaja: true, ...extra,
})
const filas: FilaFlujo[] = [
  fila('s1', 100, 'SECCION', 'INGRESOS_OPERATIVOS', '1. INGRESOS OPERATIVOS'),
  fila('f-cobr', 110, 'CUENTA', 'INGRESOS_OPERATIVOS', 'Cobranzas'),
  fila('s3', 300, 'SECCION', 'GASTOS_OPERATIVOS', '3. GASTOS OPERATIVOS'),
  fila('f-alq', 320, 'CUENTA', 'GASTOS_OPERATIVOS', 'Alquileres; "centro"'),
  fila('f-sue', 310, 'CUENTA', 'GASTOS_OPERATIVOS', 'Sueldos y jornales', { manual: true }),
  fila('s9', 900, 'SECCION', 'SOCIOS', '9. SOCIOS'),
  fila('f-soc', 910, 'CUENTA', 'SOCIOS', 'Retiros de socios'),
  fila('f-sc', 9999, 'INTERNO', 'SIN_CLASIFICAR', 'Sin clasificar'),
  fila('f-ec', 1100, 'INTERNO', 'ENTRE_CUENTAS', 'Entre cuentas propias', { mueveCaja: false }),
]
const linea = (filaId: string, fecha: string, importe: number, extra: Partial<LineaFlujo> = {}): LineaFlujo => ({
  empresaId: 'e1', unidadId: U, filaId, origenTipo: 'PROYECCION', origenId: 'p-' + filaId + fecha, ocurrencia: fecha, naturaleza: 'PROYECTADO',
  fecha, fechaCalculada: fecha, importe, concepto: 'x', vencido: false, ajustada: false, editable: true, ...extra,
})
const proyManual: Proyeccion = {
  id: 'pm', empresaId: 'e1', unidadId: U, filaId: 'f-sue', concepto: 'Sueldos de la quincena', importe: -5000, fechaInicio: '2026-11-30', recurrencia: 'UNICA',
  ajustePctMensual: 0, estado: 'ACTIVA', origen: 'MANUAL', creadoPor: 'Teso',
}
const proyPlanilla: Proyeccion = { ...proyManual, id: 'pp', filaId: 'f-alq', concepto: 'ROSALES · GASTOS', origen: 'PLANILLA_GASTOS', nota: 'Planilla GASTOS NOVIEMBRE (sin factura cargada)' }
const lineas: LineaFlujo[] = [
  linea('f-cobr', '2026-11-26', 100000, { origenTipo: 'COBRO', origenId: 'cb1', naturaleza: 'REAL', editable: false }),
  linea('f-alq', '2026-11-27', -2500, { origenTipo: 'MOVIMIENTO', origenId: 'm1', naturaleza: 'REAL', editable: false }),
  linea('f-alq', '2026-11-30', -3000, { origenId: 'pp' }),
  linea('f-sue', '2026-11-30', -5000, { origenId: 'pm' }),
  linea('f-sue', '2026-11-30', -2000, { origenId: 'pm2' }),
  linea('f-soc', '2026-12-01', -700, { origenId: 'ps' }),
  linea('f-sc', '2026-11-27', -50, { origenTipo: 'MOVIMIENTO', origenId: 'm2', naturaleza: 'REAL', editable: false }),
  linea('f-ec', '2026-11-27', -1000, { origenTipo: 'MOVIMIENTO', origenId: 'm3', naturaleza: 'REAL', editable: false }),
  linea('f-ec', '2026-11-27', 1000, { origenTipo: 'MOVIMIENTO', origenId: 'm3', ocurrencia: 'CONTRAPARTE', naturaleza: 'REAL', editable: false }),
]
const grilla = armarGrilla({ unidadId: U, dias, filas, lineas, cuentas: [], saldos: [], control: [], feriados: new Set(['2026-12-08']) })

// ---------------------------------------------------------------- 2. Exportar la grilla
const csv = grillaACsv(grilla)
const lineasCsv = csv.replace(/^﻿/, '').trimEnd().split('\r\n')
check('[exportar] el archivo empieza con BOM y termina con salto de línea (Excel lo abre bien)', csv.startsWith('﻿') && csv.endsWith('\r\n'))
check('[exportar] el encabezado es Sección, Cuenta, un día por columna (dd/mm/aaaa) y Total', lineasCsv[0] === 'Sección;Cuenta;26/11/2026;27/11/2026;30/11/2026;01/12/2026;Total', lineasCsv[0])
const filaCsv = (cuenta: string) => lineasCsv.map((l) => l.split(';')).find((c) => c[1] === cuenta || c[1] === `"${cuenta}"`)
check('[exportar] una fila con importes: su sección, su cuenta y un valor por día con coma decimal', filaCsv('Cobranzas')?.join('|') === '1. INGRESOS OPERATIVOS|Cobranzas|100000||||100000', filaCsv('Cobranzas')?.join('|'))
check('[exportar] las filas manuales con carga están y suman las dos cargas del día (-7000)', filaCsv('Sueldos y jornales')?.[4] === '-7000', filaCsv('Sueldos y jornales')?.join('|'))
check('[exportar] el texto con ; o comillas se cita como corresponde', lineasCsv.some((l) => l.includes('"Alquileres; ""centro"""')), lineasCsv.join(' / '))
check('[exportar] las filas sin ningún importe no van (Honorarios); las que suman cero pero tienen valores (Entre cuentas propias) sí', !lineasCsv.some((l) => l.includes(';Honorarios')) && lineasCsv.length === 1 + 6 + 5 && !!filaCsv('Retiros de socios'), String(lineasCsv.length))
const resumenCsv = (t: string) => lineasCsv.map((l) => l.split(';')).find((c) => c[1] === t)
check('[exportar] ingresos del día = lo positivo que mueve caja; egresos = lo negativo en positivo (las internas que no mueven caja no cuentan)',
  resumenCsv('Ingresos del día')?.slice(2).join('|') === '100000|0|0|0|100000' && resumenCsv('Egresos del día')?.slice(2).join('|') === '0|2550|10000|700|13250', `${resumenCsv('Ingresos del día')} / ${resumenCsv('Egresos del día')}`)
check('[exportar] flujo neto del día y caja acumulada llevan lo mismo que la grilla', resumenCsv('Flujo neto del día')?.[3] === String(grilla.neto['2026-11-27']).replace('.', ',') && resumenCsv('Caja acumulada')?.length === 6)

// Una pata suelta que no mueve caja (p. ej. un FCI de otra unidad): ingresos - egresos = neto, igual que en la pantalla.
const filasSuelta = [...filas, fila('f-fci', 1200, 'INTERNO', 'ENTRE_CUENTAS', 'FCI suelto', { mueveCaja: false })]
const grillaSuelta = armarGrilla({ unidadId: U, dias, filas: filasSuelta, lineas: [...lineas, linea('f-fci', '2026-11-30', -500, { origenTipo: 'MOVIMIENTO', origenId: 'm9', naturaleza: 'REAL', editable: false })], cuentas: [], saldos: [], control: [], feriados: new Set() })
const csvSuelta = grillaACsv(grillaSuelta).replace(/^\ufeff/, '').trimEnd().split('\r\n').map((l) => l.split(';'))
const pick = (t: string) => csvSuelta.find((c) => c[1] === t)!.slice(2, 6).map((x) => Number(x.replace(',', '.') || 0))
const ing2 = pick('Ingresos del día'), egr2 = pick('Egresos del día'), neto2 = pick('Flujo neto del día')
check('[exportar] ingresos - egresos = neto todos los días, aunque haya una pata que no mueve caja', ing2.every((v, i) => Math.round((v - egr2[i]) * 100) === Math.round(neto2[i] * 100)), JSON.stringify({ ing2, egr2, neto2 }))
const csvInyec = grillaACsv(armarGrilla({ unidadId: U, dias, filas: [fila('s1', 100, 'SECCION', 'INGRESOS_OPERATIVOS', '1. X'), fila('f1', 110, 'CUENTA', 'INGRESOS_OPERATIVOS', '=HYPERLINK(A1)'), fila('f2', 120, 'CUENTA', 'INGRESOS_OPERATIVOS', '-cmd'), fila('f3', 130, 'CUENTA', 'INGRESOS_OPERATIVOS', '@SUM(A1)'), fila('f4', 140, 'CUENTA', 'INGRESOS_OPERATIVOS', '+1')], lineas: ['f1', 'f2', 'f3', 'f4'].map((f) => linea(f, '2026-11-30', 10)), cuentas: [], saldos: [], control: [], feriados: new Set() }))
check('[exportar] un texto que empieza con = + - @ no llega como fórmula a la planilla (se le antepone una comilla simple)',
  ['=HYPERLINK', '-cmd', '@SUM', '+1'].every((t) => csvInyec.includes(";'" + t)) && !/;=HYPERLINK/.test(csvInyec) && !/;@SUM/.test(csvInyec), csvInyec)
check('[exportar] los importes negativos siguen siendo números (no se les antepone nada)', csvSuelta.some((c) => c.includes('-3000') || c.includes('-5500')))

// ---------------------------------------------------------------- 3. Bloques con detalle y filas MANUAL
const fac: Factura = {
  id: 'fa1', empresaId: 'e1', proveedorId: 'pv', tipo: 'Factura A', puntoVenta: 1, numero: 123, fecha: '2026-11-01', vencimiento: '2026-12-10', neto: 10000, iva: 0, percepciones: 0, total: 10000,
  cae: '', caeVencimiento: '', origen: 'MANUAL', estado: 'PAGADA_PARCIAL', estadoXubio: 'SUBIDA', validacionOk: true, categoriaVertice: 'PROVEEDOR', pagado: 3000, pagadoPct: 30,
  fechaPago: '2026-11-30',
} as Factura
const pago: Pago = {
  id: 'pg1', empresaId: 'e1', fecha: '2026-11-27', importe: 2500, medio: 'TRANSFERENCIA', cuentaOrigen: 'Galicia CC', facturaIds: ['fa1'], descripcion: '', formaCargaXubio: 'ORDEN_PAGO',
  estado: 'CONTABILIZADO', comprobante: 'x.pdf', cargadoPor: 'Vivi', cargadoEn: '2026-11-27T10:00:00Z',
} as Pago
const cuenta = { id: 'c1', nombre: 'Galicia CC' } as CuentaBancaria
const cheque: Cheque = { id: 'ch1', empresaId: 'e1', cuentaId: 'c1', tipo: 'ECHEQ', numero: '777', beneficiario: 'X', importe: 900, fechaEmision: '2026-11-20', fechaPago: '2026-11-30', estado: 'EMITIDO', origen: 'PAGO', pagos: [] } as Cheque
const ctx = { hoy, facturas: [fac], pagos: [pago], cheques: [cheque], cuentas: [cuenta], proyecciones: [proyManual, proyPlanilla] }
const celda = (f: string, d: string) => lineas.filter((l) => l.filaId === f && l.fecha === d)

const sueldos = bloqueDetalle(celda('f-sue', '2026-11-30'), { ...ctx, fila: filas.find((f) => f.id === 'f-sue') })
check('[bloque] las dos cargas manuales de la celda suman en el total del bloque (7000) y se anotan aparte', sueldos.total === 7000 && sueldos.manual === -5000 && sueldos.items.length === 2, JSON.stringify({ t: sueldos.total, m: sueldos.manual }))
check('[bloque] el que tiene una proyección de origen MANUAL se marca como carga manual; la otra (sin datos) queda como proyectada', sueldos.items[0].tipo === 'MANUAL' && sueldos.items[0].estado === 'MANUAL' && sueldos.items[1].estado === 'PROYECTADO')
check('[bloque] todo proyectado: el estado del bloque es PROYECTADO, es un egreso y no hay nada pagado', sueldos.estado === 'PROYECTADO' && !sueldos.ingreso && sueldos.pagado === 0)
const alq = bloqueDetalle(celda('f-alq', '2026-11-30'), { ...ctx, fila: filas.find((f) => f.id === 'f-alq') })
check('[bloque] una proyección de la planilla de gastos se rotula así y muestra su nota', alq.items[0].tipo === 'PLANILLA' && alq.items[0].estado === 'PLANILLA' && alq.items[0].detalle.some((d) => /Planilla GASTOS NOVIEMBRE/.test(d)))
const cobro = bloqueDetalle(celda('f-cobr', '2026-11-26'), { ...ctx, fila: filas.find((f) => f.id === 'f-cobr') })
check('[bloque] un día pasado con lo real: PAGADO, ingreso, y el pagado es el total', cobro.estado === 'PAGADO' && cobro.ingreso && cobro.total === 100000 && cobro.pagado === 100000)
// Mezcla: la factura proyectada y el pago real del mismo día y fila.
const mezcla = bloqueDetalle(
  [
    linea('f-alq', '2026-11-30', -7000, { origenTipo: 'FACTURA', origenId: 'fa1', ocurrencia: 'SALDO', naturaleza: 'PROYECTADO' }),
    linea('f-alq', '2026-11-30', -2500, { origenTipo: 'PAGO', origenId: 'pg1', ocurrencia: 'PAGO', naturaleza: 'REAL', editable: false }),
    linea('f-alq', '2026-11-30', -900, { origenTipo: 'CHEQUE', origenId: 'ch1', ocurrencia: 'CHEQUE', naturaleza: 'PROYECTADO' }),
  ],
  { ...ctx, fila: filas.find((f) => f.id === 'f-alq') },
)
check('[bloque] con algo pagado y algo por pagar el bloque es PARCIAL (total 10400, real 2500)', mezcla.estado === 'PARCIAL' && mezcla.total === 10400 && mezcla.pagado === 2500, JSON.stringify({ e: mezcla.estado, t: mezcla.total, p: mezcla.pagado }))
const itF = mezcla.items[0], itP = mezcla.items[1], itC = mezcla.items[2]
check('[bloque] la factura trae número, vencimiento, fecha programada y porcentaje pagado; con pagada parcial se rotula así', itF.estado === 'PARCIAL'
  && itF.detalle[0] === 'Factura A 00001-00000123' && /Vence 10\/12\/2026 · programada 30\/11\/2026/.test(itF.detalle[1]) && /pagada 30 %/.test(itF.detalle[2]), itF.detalle.join(' | '))
check('[bloque] el pago trae su factura asociada y el comprobante', itP.estado === 'PAGADO' && itP.detalle.some((d) => d === 'Factura asociada: 00001-00000123') && itP.detalle.includes('Con comprobante'), itP.detalle.join(' | '))
check('[bloque] el cheque sin debitar es A DEBITAR y trae número, clase y banco', itC.estado === 'A DEBITAR' && itC.detalle[0] === 'Cheque 777 (ECHEQ) · Galicia CC', itC.detalle.join(' | '))
check('[bloque] solo lo proyectado es editable', itF.editable && !itP.editable && itC.editable)
const todoPagado = bloqueDetalle([linea('f-alq', '2026-11-30', -2500, { origenTipo: 'PAGO', origenId: 'pg1', naturaleza: 'REAL', editable: false })], { ...ctx, fila: filas.find((f) => f.id === 'f-alq') })
check('[bloque] si lo real llega al total (tolerancia de $1) el bloque es PAGADO aunque el día sea futuro', todoPagado.estado === 'PAGADO')
check('[bloque] una celda de ingreso (sección de ingresos) se marca como ingreso', bloqueDetalle([linea('f-cobr', '2026-11-30', 500)], { ...ctx, fila: filas[1] }).ingreso)

// ---------------------------------------------------------------- 6. Foto mensual
const rs = resumenDias(lineas, filas, U, dias)
const r30 = rs.find((r) => r.dia === '2026-11-30')!
check('[foto] resumen por día: gastos operativos -10000 el 30/11 (alquileres -3000 y sueldos manuales -7000)', r30.gastosOperativos === -10000 && r30.subtotal === -10000 && r30.variacionCaja === -10000, JSON.stringify(r30))
const r27 = rs.find((r) => r.dia === '2026-11-27')!
check('[foto] la variación de caja no cuenta lo que no mueve caja (entre cuentas propias), pero sí "sin clasificar"', r27.variacionCaja === -2550 && r27.gastosOperativos === -2500, JSON.stringify(r27))
check('[foto] socios y subtotal quedan separados: el subtotal no incluye socios', rs.find((r) => r.dia === '2026-12-01')!.socios === -700 && rs.find((r) => r.dia === '2026-12-01')!.subtotal === 0)
check('[foto] el ingreso operativo del 26/11 (+100000) entra en el subtotal', rs[0].ingresosOperativos === 100000 && rs[0].subtotal === 100000)
const feri = new Set(['2026-11-23'])
const dm = diasDelMes('2026-11', lineas, U, feri)
check('[foto] los días del mes: los hábiles (sin feriados ni fines de semana) y los que tienen líneas', dm.length === 20 && dm.includes('2026-11-27') && !dm.includes('2026-11-28') && !dm.includes('2026-11-23'), String(dm.length))
const foto = (dia: string, variacionCaja: number): FotoFlujo => ({
  unidadId: U, mes: '2026-11', dia, ingresosOperativos: 0, costos: 0, gastosOperativos: 0, impuestos: 0, subtotal: 0, socios: 0, intercompany: 0, variacionCaja, parcial: false, tomadaEn: '2026-11-01T13:00:00Z', tomadaPor: 'Sistema',
})
const comp = compararFoto([foto('2026-11-27', -2000), foto('2026-11-30', -10000)], rs.filter((r) => r.dia.startsWith('2026-11')))
check('[foto] la comparación: lo de hoy menos lo de la foto (-2550 contra -2000 da -550; igual da cero; sin foto es todo lo de hoy)',
  comp.find((c) => c.dia === '2026-11-27')!.diferencia === -550 && comp.find((c) => c.dia === '2026-11-30')!.diferencia === 0 && comp.find((c) => c.dia === '2026-11-26')!.diferencia === 100000)
check('[foto] cada fila trae la foto si la hay', !!comp.find((c) => c.dia === '2026-11-27')!.foto && !comp.find((c) => c.dia === '2026-11-26')!.foto)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
