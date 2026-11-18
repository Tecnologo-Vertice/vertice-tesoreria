// Pruebas de los puentes del Apps Script (gas/ChequesCashFlow.gs y gas/FlujoCaja.gs) corridos en Node
// con un Google Sheets y un sistema simulados. Uso: npm run test:gas
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let ok = 0
let mal = 0
function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}

// ---------------------------------------------------------------- Google simulado
type Celda = string | number | Date
class Hoja {
  filas: Celda[][]
  formulas: string[][]
  nombre: string
  constructor(nombre: string, filas: Celda[][], formulas?: string[][]) {
    this.nombre = nombre
    this.filas = filas.map((f) => [...f])
    this.formulas = formulas ?? filas.map((f) => f.map(() => ''))
  }
  getName() { return this.nombre }
  getLastRow() { let u = 0; this.filas.forEach((f, i) => { if (f.some((x) => x !== '' && x !== null && x !== undefined)) u = i + 1 }); return u }
  getMaxRows() { return this.filas.length + 50 }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.filas.length), Math.max(...this.filas.map((f) => f.length), 1)) }
  insertRowBefore(n: number) { this.filas.splice(n - 1, 0, new Array(19).fill('')); this.formulas.splice(n - 1, 0, new Array(19).fill('')) }
  insertRowAfter(n: number) { this.insertRowBefore(n + 1) }
  getRange(fila: number | string, col = 1, nf = 1, nc = 1) {
    if (typeof fila === 'string') return { getValues: () => this.filas.slice(2).map((f) => [f[2] ?? '']) }
    const asegurar = () => { while (this.filas.length < fila + nf - 1) { this.filas.push(new Array(19).fill('')); this.formulas.push(new Array(19).fill('')) } }
    return {
      getValues: () => { asegurar(); return this.filas.slice(fila - 1, fila - 1 + nf).map((f) => Array.from({ length: nc }, (_, k) => f[col - 1 + k] ?? '')) },
      setValues: (v: Celda[][]) => { asegurar(); v.forEach((f, i) => f.forEach((x, k) => { this.filas[fila - 1 + i][col - 1 + k] = x })) },
      getFormulasR1C1: () => { asegurar(); return [Array.from({ length: nc }, (_, k) => this.formulas[fila - 1][col - 1 + k] ?? '')] },
      setFormulaR1C1: (fx: string) => { asegurar(); this.formulas[fila - 1][col - 1] = fx; this.filas[fila - 1][col - 1] = '=' + fx },
      setNumberFormat: () => {},
    }
  }
  clearContents() { this.filas = [] }
  setFrozenRows() {}
}
class Libro {
  hojas: Record<string, Hoja> = {}
  nombre: string
  constructor(nombre: string) { this.nombre = nombre }
  getName() { return this.nombre }
  getSheetByName(n: string) { return this.hojas[n] ?? null }
  insertSheet(n: string) { this.hojas[n] = new Hoja(n, []); return this.hojas[n] }
}

function cargar(archivo: string, libro: Libro, props: Record<string, string>, sistema: (ruta: string, cuerpo: unknown) => unknown) {
  const llamadas: { ruta: string; cuerpo: unknown }[] = []
  const ctx: Record<string, unknown> = {
    console, Date, JSON, Math, Object, String, Number, Array, isNaN, parseInt, parseFloat,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    SpreadsheetApp: { openById: () => libro, flush: () => {} },
    Session: { getScriptTimeZone: () => 'America/Argentina/Buenos_Aires' },
    Utilities: { formatDate: (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') },
    UrlFetchApp: {
      fetch: (url: string, o: { payload: string }) => {
        const ruta = url.replace(/^https?:\/\/[^/]+/, '')
        const cuerpo = JSON.parse(o.payload || '{}')
        llamadas.push({ ruta, cuerpo })
        const r = sistema(ruta, cuerpo)
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(r) }
      },
    },
    ScriptApp: { getProjectTriggers: () => [] },
  }
  vm.createContext(ctx)
  vm.runInContext(readFileSync(new URL(`../../gas/${archivo}`, import.meta.url), 'utf8'), ctx)
  return { ctx, llamadas }
}

const PROPS = { SISTEMA_URL: 'https://sistema.test', INGESTA_TOKEN: 't', CASHFLOW_CHEQUES_SHEET_ID: 'copia1', FLUJO_SHEET_ID: 'copia2' }
const ENC = ['EMISIÓN', 'DEPÓSITO', 'EMPRESA', 'BANCO', 'NÚMERO', 'TIPO', 'ACREEDORES', 'IMPORTE', 'ESTADO', 'OBSERVACIONES', 'COBRO', 'Categoría', 'SEMANA', 'ID CHEQUES', 'C1', 'C2', 'C3', 'C4', 'C5']
const fila = (dep: string, emp: string, banco: string, nro: number, acr: string, imp: number): Celda[] =>
  [new Date('2026-11-01T12:00:00'), new Date(dep + 'T12:00:00'), emp, banco, nro, 'ECHEQ', acr, imp, 'Pendiente', 'a mano', '', '', '', '', '', '', '', '', '']

// ================================================================ Cheques → CHEQUES EMITIDOS
{
  const libro = new Libro('Copy of CASH FLOW GRUPO INDIA')
  const filas = [ENC as Celda[], fila('2026-11-20', 'BERATUNG', 'GALICIA', 100, 'LAB SUR', 1000), fila('2026-12-20', 'INDIA ADV', 'ICBC', 200, 'OTRO', 2000)]
  const formulas = filas.map((f, i) => f.map((_, k) => (i > 0 && k === 10 ? 'R[0]C[-9]+30' : '')))
  libro.hojas['CHEQUES EMITIDOS'] = new Hoja('CHEQUES EMITIDOS', filas, formulas)
  libro.hojas['Categoría'] = new Hoja('Categoría', [['', '', ''], ['', '', 'ACREEDORES'], ['', '', 'Laboratorios JAYOR S.R.L.']])
  let marcas: { pago_id: string; estado: string }[] = []
  const pendientes = [
    { pago_id: 'p1', empresa_id: 'india', numero: '0012345', banco: 'Banco Galicia CC $', tipo_cheque: '', medio: 'ECHEQ', proveedor: 'JAYOR SRL', importe: 5000, emision: '2026-11-18T10:00:00Z', deposito: '2026-12-15', texto: '' },
    { pago_id: 'p2', empresa_id: 'india', numero: '12345', banco: 'GALICIA', tipo_cheque: '', medio: 'ECHEQ', proveedor: 'JAYOR SRL', importe: 1500, emision: '2026-11-18T10:20:00Z', deposito: '2026-12-15', texto: '' },
    { pago_id: 'p3', empresa_id: 'beratung', numero: '100', banco: 'Galicia', tipo_cheque: '', medio: 'CHEQUE', proveedor: 'LAB SUR', importe: 1000, emision: '2026-11-18T10:00:00Z', deposito: '2026-11-20', texto: '' },
    { pago_id: 'p4', empresa_id: 'ysd', numero: '777', banco: 'Macro', tipo_cheque: 'FISICO', medio: 'CHEQUE', proveedor: 'Proveedor Nuevo SA', importe: 300, emision: '2026-11-18T10:00:00Z', deposito: '2026-11-25', texto: '' },
  ]
  const { ctx } = cargar('ChequesCashFlow.gs', libro, PROPS, (ruta, cuerpo) => {
    if (ruta === '/api/cheques/pendientes') return { ok: true, desde: '2026-11-18', cheques: pendientes }
    marcas = (cuerpo as { resultados: typeof marcas }).resultados
    return { ok: true }
  })
  const msg = (ctx.pasarChequesAlCashFlow as () => string)()
  const h = libro.hojas['CHEQUES EMITIDOS']
  const datos = h.filas.slice(1).filter((f) => f[2])
  check('resumen: 2 agregados y 1 ya estaba', /2 cheque\(s\) agregado\(s\), 1 ya estaban/.test(msg), msg)
  const india = datos.find((f) => f[2] === 'INDIA ADV' && f[4] === 12345)
  check('mismo cheque en 2 pagos del mismo lote: una fila con el total', !!india && india[7] === 6500 && /un cheque para 2 pagos/.test(String(india[9])), JSON.stringify(india))
  check('banco y empresa como los escribe Tesorería', india?.[3] === 'GALICIA' && india?.[5] === 'ECHEQ')
  check('acreedor tomado de la pestaña Categoría ("de fondo")', india?.[6] === 'Laboratorios JAYOR S.R.L.' && !/revisar ACREEDORES/.test(String(india?.[9])))
  const idxIndia = h.filas.findIndex((f) => f === india)
  check('insertado en orden de fecha de depósito (antes del 20/12)', idxIndia > 0 && (h.filas[idxIndia + 1]?.[1] as Date)?.getTime() > (india![1] as Date).getTime())
  check('copió la fórmula de la fila vecina', h.formulas[idxIndia][10] === 'R[0]C[-9]+30')
  const ysd = datos.find((f) => f[2] === 'YSD PHARMA')
  check('cheque físico → CH/FISICO y acreedor desconocido avisado', ysd?.[5] === 'CH/FISICO' && /revisar ACREEDORES/.test(String(ysd?.[9])) && ysd?.[6] === 'PROVEEDOR NUEVO SA')
  check('no duplicó el que ya estaba a mano', datos.filter((f) => f[2] === 'BERATUNG' && f[4] === 100).length === 1)
  check('devuelve una marca por pago', marcas.length === 4 && marcas.find((m) => m.pago_id === 'p3')?.estado === 'YA ESTABA EN EL CASH FLOW' && marcas.filter((m) => /^AGREGADO/.test(m.estado)).length === 3)
}
{
  const libro = new Libro('CASH FLOW GRUPO INDIA')
  libro.hojas['CHEQUES EMITIDOS'] = new Hoja('CHEQUES EMITIDOS', [ENC as Celda[]])
  const { ctx } = cargar('ChequesCashFlow.gs', libro, { ...PROPS, CASHFLOW_CHEQUES_SHEET_ID: 'otra' }, () => ({ ok: true, cheques: [] }))
  let error = ''
  try { (ctx.pasarChequesAlCashFlow as () => string)() } catch (e) { error = String(e) }
  check('sin permiso no escribe en una planilla que no es copia', /solo se escribe en una copia/.test(error), error)
}

// ================================================================ Flujo de caja
{
  const libro = new Libro('Copy of Flujo de Caja Por empresa')
  const hoy = new Date()
  const d = (n: number) => { const x = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
  const datos = {
    pagos: [
      { ID_PAGO: 'a1', FECHA_PAGO: d(-3), IMPORTE: 1000, EMPRESA: 'Beratung S.A.', BANCO_ORIGEN: 'Banco ICBC', PROVEEDOR_DESTINO: 'EDENOR SA', CUENTA_CONTABLE: '', ESTADO_CONTABLE: 'CONTABILIZADA', NUMERO_CHEQUE: '', TIPO_CHEQUE: '', FECHA_VTO_CHEQUE: null },
      { ID_PAGO: 'a2', FECHA_PAGO: d(-2), IMPORTE: 500, EMPRESA: 'Beratung S.A.', BANCO_ORIGEN: 'Galicia', PROVEEDOR_DESTINO: 'Lab X', ESTADO_CONTABLE: 'PENDIENTE', NUMERO_CHEQUE: '999', TIPO_CHEQUE: 'ECHEQ', FECHA_VTO_CHEQUE: d(20) },
      { ID_PAGO: 'a3', FECHA_PAGO: d(-2), IMPORTE: 700, EMPRESA: 'Beratung S.A.', BANCO_ORIGEN: 'Hipotecario', PROVEEDOR_DESTINO: 'Beratung', DESCRIPCION_PAGO: 'Transferencia a cuentas propias', BANCO_DESTINO: 'ICBC', ESTADO_CONTABLE: 'CONTABILIZADA', NUMERO_CHEQUE: '', TIPO_CHEQUE: '' },
      { ID_PAGO: 'a4', FECHA_PAGO: d(-1), IMPORTE: 200, EMPRESA: 'Beratung S.A.', BANCO_ORIGEN: 'Galicia', PROVEEDOR_DESTINO: 'PIUR SRL', CUIT_DESTINO: '30711111119', ESTADO_CONTABLE: 'ESPERA_FC', NUMERO_CHEQUE: '', TIPO_CHEQUE: '', FACTURA_ASOCIADA: '' },
      { ID_PAGO: 'a5', FECHA_PAGO: d(-1), IMPORTE: 50, EMPRESA: 'Beratung S.A.', ESTADO_CONTABLE: 'ANULADO', NUMERO_CHEQUE: '', TIPO_CHEQUE: '' },
      { ID_PAGO: 'a6', FECHA_PAGO: d(-1), IMPORTE: 80, EMPRESA: 'INDIA ADV S.A.', ESTADO_CONTABLE: 'CONTABILIZADA', NUMERO_CHEQUE: '', TIPO_CHEQUE: '' },
    ],
    facturas: [
      { NUMERO: 11, TIPO: 'Factura A', RECEPTOR: 'Beratung S.A.', PROVEEDOR: 'PIUR SRL', CUIT_PROVEEDOR: '30711111119', FECHA: d(-10), VENCIMIENTODELPAGO: d(10), TOTAL: 1000, PORCENTAJE_PAGADO: 0, ESTADO_APROBACION: 'APROBADA', ESTADO_PAGO: 'PARA_PAGAR', YA_PAGADA_SEGUN_ADMIN: '', METODO_PAGO: 'TRANSFERENCIA', CATEGORIA_CONTABLE: '' },
      { NUMERO: 12, TIPO: 'Factura A', RECEPTOR: 'Beratung S.A.', PROVEEDOR: 'Otro', CUIT_PROVEEDOR: '', FECHA: d(-5), VENCIMIENTODELPAGO: d(40), TOTAL: 2000, PORCENTAJE_PAGADO: 50, ESTADO_APROBACION: 'APROBADA', ESTADO_PAGO: 'PARA_PAGAR', YA_PAGADA_SEGUN_ADMIN: '', METODO_PAGO: 'CHEQUE 30 DIAS', CATEGORIA_CONTABLE: '' },
      { NUMERO: 13, TIPO: 'Nota de Crédito A', RECEPTOR: 'Beratung S.A.', PROVEEDOR: 'Otro', TOTAL: 100, PORCENTAJE_PAGADO: 0, ESTADO_APROBACION: 'APROBADA', ESTADO_PAGO: 'PARA_PAGAR', VENCIMIENTODELPAGO: d(5) },
      { NUMERO: 14, TIPO: 'Factura B', RECEPTOR: 'Beratung S.A.', PROVEEDOR: 'Vencido SA', TOTAL: 300, PORCENTAJE_PAGADO: 0, ESTADO_APROBACION: 'APROBADA', ESTADO_PAGO: 'PARA_PAGAR', VENCIMIENTODELPAGO: d(-15), METODO_PAGO: 'TRANSFERENCIA' },
    ],
  }
  const { ctx } = cargar('FlujoCaja.gs', libro, PROPS, () => ({ ok: true, ...datos }))
  const msg = (ctx.fxActualizarFlujo as () => string)()
  const tabla = (n: string) => { const h = libro.hojas[n].filas; return h.slice(1).map((f) => Object.fromEntries((h[0] as string[]).map((k, i) => [k, f[i]]))) }
  const pagos = tabla('Aux Pagos')
  const proy = tabla('Aux Proyeccion')
  check('crea el Mapa Flujo con la precarga', (libro.hojas['Mapa Flujo']?.filas.length ?? 0) > 50)
  check('pago a EDENOR va a su fila por proveedor', pagos.some((p) => p.ID_PAGO === 'a1' && p.FILA === '53001009 ENERGIA - Edenor' && p.PESTANA === 'Dax Salud'))
  check('pagado desde ICBC (Beratung S/Dax) un gasto de Dax Salud: arma el préstamo entre unidades', pagos.filter((p) => p.ID_PAGO === 'a1' && p.MOVIMIENTO === 'PRESTAMO_ENTRE_UNIDADES').length === 2)
  check('cheques no entran (van por CHEQUES EMITIDOS)', !pagos.some((p) => p.ID_PAGO === 'a2'))
  check('transferencia a cuentas propias: realizada en una pestaña y recibida en la otra', pagos.filter((p) => p.ID_PAGO === 'a3').map((p) => `${p.PESTANA}|${p.FILA}`).sort().join() === 'Beratung S/Dax|Transferencias recibidas,Dax Salud|Transferencias Realizadas')
  check('anulados y otras empresas no entran', !pagos.some((p) => p.ID_PAGO === 'a5' || p.ID_PAGO === 'a6'))
  const f11 = proy.find((p) => p.FACTURA === '11')
  check('pago sin factura (anticipo) se descuenta de la factura del mismo CUIT', f11?.IMPORTE === 800 && /menos pago sin factura \$200\.00/.test(String(f11?.REGLA)), JSON.stringify(f11))
  const f12 = proy.find((p) => p.FACTURA === '12')
  check('cheque a 30 días desde la fecha de la factura, por el saldo (50 %)', f12?.IMPORTE === 1000 && f12?.ORIGEN_FECHA === 'Cheque a 30 días')
  check('notas de crédito no se proyectan', !proy.some((p) => p.FACTURA === '13'))
  check('vencida va al próximo día hábil, marcada', /\(vencida\)/.test(String(proy.find((p) => p.FACTURA === '14')?.ORIGEN_FECHA)))
  check('resumen del proceso', /Aux Pagos: \d+ renglones · Aux Proyeccion: 3/.test(msg), msg)
}

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
