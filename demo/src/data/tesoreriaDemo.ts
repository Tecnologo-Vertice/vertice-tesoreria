// Tesorería en modo demo: bancos, cheques, proyecciones y el Flujo con datos ficticios, relativos a hoy.
// Replica lo que hacen las vistas de la base (conciliacion_bancaria, flujo_lineas, flujo_control) y las
// funciones (0024 a 0026) con las mismas validaciones, para que la demo se comporte como el modo conectado.
//
// Diseño de los datos (todo ficticio):
//   · Beratung tiene dos pestañas: "Beratung S/Dax" (Galicia, Santander y un FCI) y "Dax Salud" (Hipotecario
//     y Mercado Pago). India tiene una (Galicia y Mercado Pago).
//   · Ocho días hábiles de extractos. Lo real del Flujo sale de esos movimientos, así que la caja cierra contra
//     los bancos: el control da OK, salvo un día de Santander en que el banco informa $125.000 menos (F).
//   · Mercado Pago de Dax Salud no tiene el extracto de ayer: hay que subirlo o confirmar "Sin movimientos".

import type {
  CategoriaMovimiento,
  Cheque,
  Conciliacion,
  ControlFlujo,
  CuentaBancaria,
  DocumentoBancario,
  Extracto,
  Factura,
  FilaFlujo,
  FotoFlujo,
  LineaFlujo,
  MovimientoBancario,
  Proyeccion,
  SaldoBancario,
  SeccionFlujo,
  Unidad,
} from '../types'
import type { DatosTesoreria, PendienteXubio } from './fuente'
import { PLAN_CUENTAS, PROVEEDORES } from './demo'
import { addDays, iso, parseIso } from '../lib/format'
import { diaHabilAnterior, diaHabilDesde, ocurrenciasProyeccion, sumarHabiles, textoBanco } from '../lib/tesoreria'

export interface AjusteDemo {
  id: string
  empresaId: string
  origenTipo: 'FACTURA' | 'CHEQUE' | 'PROYECCION'
  origenId: string
  ocurrencia: string
  fechaNueva?: string
  importeNuevo?: number
  eliminada: boolean
  motivo: string
  creadoPor: string
  creadoEn: string
  reemplazadoEn?: string
}

export interface ReglaDemo {
  patrones: string[]
  sentido: 'DEBITO' | 'CREDITO' | 'AMBOS'
  categoria: CategoriaMovimiento
  cuenta?: string
  destino: MovimientoBancario['destinoXubio']
  componente?: MovimientoBancario['componente']
  orden: number
}

export interface EstadoTesoreria {
  unidades: Unidad[]
  cuentas: CuentaBancaria[]
  feriados: string[]
  movimientos: MovimientoBancario[]
  saldos: SaldoBancario[]
  lecturasXubio: { cuentaId: string; fecha: string; saldo: number }[]
  documentos: DocumentoBancario[]
  extractos: (Extracto & { huella: string })[]
  cheques: Cheque[]
  filas: FilaFlujo[]
  proyecciones: Proyeccion[]
  ajustes: AjusteDemo[]
  /** Fotos mensuales de la proyección (0038). */
  fotos?: FotoFlujo[]
  reglas: ReglaDemo[]
  /** Pagos anulados en el sistema que siguen en Xubio (en la demo los pagos viven aparte: se simulan acá). */
  anulacionesPago?: AnulacionPagoDemo[]
}

export interface AnulacionPagoDemo {
  id: string
  empresaId: string
  fecha: string
  descripcion: string
  importe: number
  xubioId: string
  estado: 'PENDIENTE' | 'HECHA' | 'ERROR'
  manualPor?: string
  manualNota?: string
}

// Feriados nacionales de fin de 2026 y 2027 (alcanza para la ventana del Flujo).
const FERIADOS = ['2026-12-07', '2026-12-08', '2026-12-25', '2027-01-01', '2027-02-15', '2027-02-16', '2027-03-24', '2027-04-02']

// Reglas de Extractos_Reglas (resumidas de 0024).
const REGLAS: ReglaDemo[] = [
  { orden: 10, patrones: ['LEY 25413', 'IMP. DEB', 'IMP. CRED', 'IMP DEB', 'IMP CRED'], sentido: 'AMBOS', categoria: 'IMPUESTO', cuenta: 'IMPUESTO DEB/CRED BANCARIO', destino: 'ASIENTO' },
  { orden: 20, patrones: ['SIRCREB', 'IIBB', 'RET. IB'], sentido: 'AMBOS', categoria: 'IMPUESTO', cuenta: 'RETENCIÓN BANCARIA IIBB (SIRCREB)', destino: 'COMPROBANTE', componente: 'PERCEPCION_IIBB' },
  { orden: 40, patrones: ['IVA'], sentido: 'DEBITO', categoria: 'IMPUESTO', cuenta: 'IVA COMPRAS', destino: 'COMPROBANTE', componente: 'IVA' },
  { orden: 50, patrones: ['COMISION', 'MANTENIMIENTO', 'MANT.', 'CHEQUERA'], sentido: 'DEBITO', categoria: 'GASTO_BANCARIO', cuenta: 'GASTOS BANCARIOS', destino: 'COMPROBANTE', componente: 'NETO' },
  { orden: 60, patrones: ['RENDIMIENTO'], sentido: 'AMBOS', categoria: 'FCI_RENDIMIENTO', cuenta: 'Rendimientos FCI', destino: 'ASIENTO' },
  { orden: 70, patrones: ['FCI', 'SUSCRIPCION', 'RESCATE'], sentido: 'AMBOS', categoria: 'FCI', cuenta: 'Fondos Comun de Inversion Bancos', destino: 'ASIENTO' },
  { orden: 80, patrones: ['ECHEQ', 'CH CAMARA', 'CHEQUE'], sentido: 'DEBITO', categoria: 'CHEQUE_PAGADO', destino: 'NINGUNO' },
]

export function reglaPara(reglas: ReglaDemo[], descripcion: string, importe: number): ReglaDemo | undefined {
  const t = textoBanco(descripcion)
  return [...reglas]
    .sort((a, b) => a.orden - b.orden)
    .find(
      (r) =>
        (r.sentido === 'AMBOS' || (r.sentido === 'DEBITO' && importe < 0) || (r.sentido === 'CREDITO' && importe > 0)) &&
        r.patrones.some((p) => t.includes(textoBanco(p))),
    )
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r2 = (n: number) => Math.round(n * 100) / 100

// ---------------------------------------------------------------- Estructura del Flujo

const FILAS_BASE: [number, FilaFlujo['tipo'], SeccionFlujo, string, string | undefined, boolean][] = [
  [100, 'SECCION', 'INGRESOS_OPERATIVOS', '1. INGRESOS OPERATIVOS', undefined, true],
  [110, 'CUENTA', 'INGRESOS_OPERATIVOS', 'Cobranzas', 'DEUDORES POR VENTAS', true],
  [200, 'SECCION', 'COSTOS', '2. COSTOS', undefined, true],
  [210, 'CUENTA', 'COSTOS', 'Insumos', 'COSTO DE INSUMOS', true],
  [220, 'CUENTA', 'COSTOS', 'Prestaciones médicas', 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO', true],
  [230, 'CUENTA', 'COSTOS', 'Honorarios profesionales', 'HONORARIOS PROFESIONALES', true],
  [300, 'SECCION', 'GASTOS_OPERATIVOS', '3. GASTOS OPERATIVOS', undefined, true],
  [310, 'CUENTA', 'GASTOS_OPERATIVOS', 'Sueldos y jornales', 'SUELDOS Y JORNALES', true],
  [320, 'CUENTA', 'GASTOS_OPERATIVOS', 'Alquileres', 'ALQUILER DE OFICINA', true],
  [330, 'CUENTA', 'GASTOS_OPERATIVOS', 'Honorarios externos', 'HONORARIOS EXTERNOS CONTABLES', true],
  [340, 'CUENTA', 'GASTOS_OPERATIVOS', 'Servicios y oficina', 'GASTOS VARIOS OFICINA', true],
  [345, 'CUENTA', 'GASTOS_OPERATIVOS', 'Gastos generales', 'GASTOS GENERALES', true],
  [350, 'CUENTA', 'GASTOS_OPERATIVOS', 'Software', 'SOFTWARE DE GESTION', true],
  [355, 'CUENTA', 'GASTOS_OPERATIVOS', 'Seguros', 'SEGUROS', true],
  [360, 'CUENTA', 'GASTOS_OPERATIVOS', 'Fletes', 'GASTOS DE FLETES', true],
  [365, 'CUENTA', 'GASTOS_OPERATIVOS', 'Seguridad', 'SERVICIOS DE SEGURIDAD', true],
  [370, 'CUENTA', 'GASTOS_OPERATIVOS', 'Gastos bancarios', 'GASTOS BANCARIOS', true],
  [400, 'SECCION', 'IMPUESTOS', '4. IMPUESTOS OPERATIVOS', undefined, true],
  [410, 'CUENTA', 'IMPUESTOS', 'Impuesto al cheque (Ley 25.413)', 'IMPUESTO DEB/CRED BANCARIO', true],
  [420, 'CUENTA', 'IMPUESTOS', 'IIBB (SIRCREB)', 'RETENCIÓN BANCARIA IIBB (SIRCREB)', true],
  [425, 'CUENTA', 'IMPUESTOS', 'IVA bancario', 'IVA COMPRAS', true],
  [430, 'CUENTA', 'IMPUESTOS', 'Plan de pagos AFIP', 'PLAN DE PAGOS AFIP', true],
  [500, 'SECCION', 'CAPEX', '5. CAPEX / IMPUESTO A LAS GANANCIAS', undefined, true],
  [510, 'CUENTA', 'CAPEX', 'Equipamiento informático', 'INSUMOS INFORMÁTICOS', true],
  [600, 'SECCION', 'INGRESOS_FINANCIEROS', '6. INGRESOS FINANCIEROS', undefined, true],
  [610, 'CUENTA', 'INGRESOS_FINANCIEROS', 'Rendimientos FCI', 'Rendimientos FCI', true],
  [700, 'SECCION', 'TOMA_DEUDA', '7. TOMA DE DEUDA', undefined, true],
  [710, 'CUENTA', 'TOMA_DEUDA', 'Préstamos recibidos', 'PRESTAMOS RECIBIDOS', true],
  [800, 'SECCION', 'DEVOLUCION_DEUDA', '8. DEVOLUCIÓN DE DEUDA', undefined, true],
  [810, 'CUENTA', 'DEVOLUCION_DEUDA', 'Cuotas de préstamos', 'PRESTAMOS BANCARIOS', true],
  [820, 'CUENTA', 'DEVOLUCION_DEUDA', 'Intereses pagados', 'INTERESES PAGADOS', true],
  [900, 'SECCION', 'SOCIOS', '9. SOCIOS (retiros y aportes)', undefined, true],
  [910, 'CUENTA', 'SOCIOS', 'Retiros de socios', 'RETIROS DE SOCIOS', true],
  [1000, 'SECCION', 'INTERCOMPANY', '10. INTERCOMPANY Y OTROS MOVIMIENTOS', undefined, true],
  [1010, 'CUENTA', 'INTERCOMPANY', 'Intercompany', 'INTERCOMPANY', true],
  [1100, 'INTERNO', 'ENTRE_CUENTAS', 'Entre cuentas propias', undefined, false],
  [9999, 'INTERNO', 'SIN_CLASIFICAR', 'Sin clasificar', undefined, true],
]

function filasDe(u: Unidad): FilaFlujo[] {
  return FILAS_BASE.map(([orden, tipo, seccion, etiqueta, cuenta, mueve]) => ({
    id: `${u.id}-${orden}`,
    unidadId: u.id,
    orden,
    tipo,
    seccion,
    etiqueta,
    cuentaContable: cuenta,
    mueveCaja: mueve,
    // Como la carga inicial de 0038: sueldos, préstamos, intereses, retiros e intercompany se cargan a mano.
    manual: !!cuenta && /^(SUELDOS|PRESTAMOS|INTERESES|RETIROS|INTERCOMPANY|Rendimientos)/i.test(cuenta),
    // En Dax Salud, las personas físicas pagadas desde la unidad van a Consultorios.
    personaFisica: u.id === 'u-dax' && orden === 220,
  }))
}

// ---------------------------------------------------------------- Datos iniciales

export function tesoreriaInicial(hoyIso: string): EstadoTesoreria {
  const fer = new Set(FERIADOS)
  const rnd = mulberry32(20261126)
  const entre = (a: number, b: number) => Math.round((a + rnd() * (b - a)) / 100) * 100
  const unidades: Unidad[] = [
    { id: 'u-ber', empresaId: 'beratung', nombre: 'Beratung S/Dax', porDefecto: true, orden: 10 },
    { id: 'u-dax', empresaId: 'beratung', nombre: 'Dax Salud', porDefecto: false, orden: 20 },
    { id: 'u-ind', empresaId: 'india', nombre: 'India', porDefecto: true, orden: 10 },
  ]
  const cuentas: CuentaBancaria[] = [
    { id: 'co1', empresaId: 'beratung', unidadId: 'u-ber', nombre: 'Galicia CC $', banco: 'GALICIA', clase: 'CC', rindeDiario: false, requiereExtracto: true, orden: 10 },
    { id: 'co2', empresaId: 'beratung', unidadId: 'u-ber', nombre: 'Santander CC $', banco: 'SANTANDER', clase: 'CC', rindeDiario: false, requiereExtracto: true, orden: 20 },
    { id: 'cb-fci', empresaId: 'beratung', unidadId: 'u-ber', nombre: 'FCI Galicia Ahorro', banco: 'GALICIA', clase: 'FCI', rindeDiario: true, requiereExtracto: true, cuentaMadreId: 'co1', orden: 30 },
    { id: 'cb-dax', empresaId: 'beratung', unidadId: 'u-dax', nombre: 'Hipotecario CC Dax $', banco: 'HIPOTECARIO', clase: 'CC', rindeDiario: false, requiereExtracto: true, orden: 10 },
    { id: 'cb-mpdax', empresaId: 'beratung', unidadId: 'u-dax', nombre: 'Mercado Pago Dax', banco: 'MP', clase: 'BILLETERA', rindeDiario: true, requiereExtracto: true, orden: 20 },
    { id: 'co4', empresaId: 'india', unidadId: 'u-ind', nombre: 'Galicia CC $', banco: 'GALICIA', clase: 'CC', rindeDiario: false, requiereExtracto: true, orden: 10 },
    { id: 'co5', empresaId: 'india', unidadId: 'u-ind', nombre: 'Mercado Pago', banco: 'MP', clase: 'BILLETERA', rindeDiario: true, requiereExtracto: true, orden: 20 },
  ]
  const inicial: Record<string, number> = { co1: 18_450_000, co2: 6_200_000, 'cb-fci': 12_000_000, 'cb-dax': 4_100_000, 'cb-mpdax': 850_000, co4: 9_800_000, co5: 1_150_000 }

  // d[0] = primer saldo (sin movimientos), d[1..8] = días con extracto; ayer = d[8].
  const ayer = diaHabilAnterior(hoyIso, fer)
  const d = Array.from({ length: 9 }, (_, i) => sumarHabiles(ayer, i - 8, fer))
  const movimientos: MovimientoBancario[] = []
  const saldos: SaldoBancario[] = []
  const lecturasXubio: EstadoTesoreria['lecturasXubio'] = []
  let nMov = 0
  const mov = (cuentaId: string, fecha: string, descripcion: string, importe: number, extra: Partial<MovimientoBancario> = {}) => {
    const c = cuentas.find((x) => x.id === cuentaId)!
    const r = extra.categoria ? undefined : reglaPara(REGLAS, descripcion, importe)
    movimientos.push({
      id: `mv${++nMov}`,
      empresaId: c.empresaId,
      cuentaId,
      fecha,
      descripcion,
      importe: r2(importe),
      categoria: r?.categoria ?? 'SIN_CLASIFICAR',
      cuentaContable: r?.cuenta,
      destinoXubio: r?.destino ?? 'NINGUNO',
      componente: r?.componente,
      estado: r ? 'PENDIENTE' : 'A_REVISAR',
      ...extra,
    })
  }
  const clientes = ['OSDE Ficticia', 'Swiss Demo Salud', 'Galeno Ejemplo', 'Particulares (cobros)', 'Medifé Modelo']
  const provPagos = PROVEEDORES.filter((p) => ['p01', 'p02', 'p05', 'p06', 'p08', 'p10', 'p12', 'p13'].includes(p.id))
  const pagoA = (cuentaId: string, fecha: string, i: number) => {
    const p = provPagos[(i + nMov) % provPagos.length]
    const imp = entre(120_000, 1_400_000)
    mov(cuentaId, fecha, `TRANSF. A ${textoBanco(p.nombre).slice(0, 26)}`, -imp, {
      categoria: 'PAGO',
      cuentaContable: p.cuentaHabitual,
      destinoXubio: 'NINGUNO',
      estado: 'CONTABILIZADO',
      contraparte: p.nombre,
      pagoId: `pg-${nMov + 1}`,
    })
    return imp
  }
  const cobroDe = (cuentaId: string, fecha: string, i: number, min = 400_000, max = 2_600_000) => {
    const cli = clientes[(i + nMov) % clientes.length]
    const imp = entre(min, max)
    mov(cuentaId, fecha, `TRANSF. RECIBIDA ${textoBanco(cli)}`, imp, {
      categoria: 'COBRO',
      cuentaContable: 'DEUDORES POR VENTAS',
      destinoXubio: 'NINGUNO',
      estado: 'CONTABILIZADO',
      contraparte: cli,
      cobroId: `cb-${nMov + 1}`,
    })
    return imp
  }

  for (const c of cuentas) saldos.push({ cuentaId: c.id, fecha: d[0], saldo: inicial[c.id], origen: c.clase === 'FCI' ? 'TENENCIA' : 'EXTRACTO' })

  for (let i = 1; i <= 8; i++) {
    const f = d[i]
    // Cuentas corrientes: cobros, pagos, impuesto al cheque y, algunos días, comisiones con IVA y SIRCREB.
    for (const cid of ['co1', 'co2', 'cb-dax', 'co4']) {
      let deb = 0
      let cred = 0
      if ((i + cid.length) % 2 === 0) cred += cobroDe(cid, f, i)
      deb += pagoA(cid, f, i)
      if (i % 3 === 0) deb += pagoA(cid, f, i + 3)
      if (i % 4 === (cid.length % 4)) {
        const com = entre(3_000, 9_500)
        mov(cid, f, 'COMISION MANTENIMIENTO CUENTA', -com)
        mov(cid, f, 'IVA 21% S/COMISION', -r2(com * 0.21))
      }
      if (cred > 0 && i % 2 === 0) mov(cid, f, 'RET. IIBB SIRCREB', -r2(cred * 0.012))
      if (cred > 0) mov(cid, f, 'IMP. LEY 25413 CRED 0,6%', -r2(cred * 0.006))
      mov(cid, f, 'IMP. LEY 25413 DEB 0,6%', -r2(deb * 0.006))
    }
    // Mercado Pago: cobros y el rendimiento del día (Dax Salud no tiene el extracto de ayer).
    for (const cid of ['co5', 'cb-mpdax']) {
      if (cid === 'cb-mpdax' && i === 8) continue
      if (i % 2 === 1) cobroDe(cid, f, i, 60_000, 380_000)
      const base = inicial[cid] * 0.00095
      mov(cid, f, 'RENDIMIENTO ACREDITADO', r2(base + i * 7.3))
    }
  }
  // Movimientos que la regla no reconoce: quedan "A revisar".
  mov('co1', d[7], 'DEB. AUTOMATICO SEGUROS LA PROTECCION 4471', -84_300)
  mov('co4', d[8], 'TRANSF. 30-71000099 VARIOS', -250_000)
  mov('cb-dax', d[8], 'DEBITO DIRECTO ENERGIA DEMO 22981', -61_870)
  // Suscripción al FCI desde Galicia (entre cuentas propias: suma cero en la caja).
  mov('co1', d[4], 'SUSCRIPCION FCI GALICIA AHORRO', -3_000_000, {
    categoria: 'FCI',
    cuentaContable: 'Fondos Comun de Inversion Bancos',
    destinoXubio: 'ASIENTO',
    estado: 'PENDIENTE',
    contraparteCuentaId: 'cb-fci',
  })
  // Cheque propio debitado en Santander (el Flujo lo toma del cheque, no del movimiento).
  mov('co2', d[5], 'CH CAMARA 00012345', -1_250_000, { categoria: 'CHEQUE_PAGADO', destinoXubio: 'NINGUNO', estado: 'PENDIENTE', chequeId: 'ch1', numeroCheque: '00012345' })

  // Saldos de cierre: anterior + movimientos. El FCI informa tenencia (con rendimiento). Santander, el día d[6],
  // informa $125.000 menos: falta un movimiento en el archivo (diferencia en la conciliación y F en el Flujo).
  for (const c of cuentas) {
    let saldo = inicial[c.id]
    for (let i = 1; i <= 8; i++) {
      const f = d[i]
      const delta = movimientos
        .filter((m) => m.cuentaId === c.id && m.fecha === f)
        .reduce((a, m) => a + m.importe, 0) + movimientos.filter((m) => m.contraparteCuentaId === c.id && m.fecha === f).reduce((a, m) => a - m.importe, 0)
      if (c.id === 'cb-mpdax' && i === 8) continue
      saldo = r2(saldo + delta)
      if (c.clase === 'FCI') saldo = r2(saldo * 1.00112)
      if (c.id === 'co2' && i === 6) saldo = r2(saldo - 125_000)
      saldos.push({ cuentaId: c.id, fecha: f, saldo, origen: c.clase === 'FCI' ? 'TENENCIA' : 'EXTRACTO' })
      if (c.clase === 'CC') lecturasXubio.push({ cuentaId: c.id, fecha: f, saldo: c.id === 'co4' && i === 7 ? r2(saldo + 48_200) : saldo })
    }
  }

  const extractos: EstadoTesoreria['extractos'] = cuentas
    .filter((c) => c.clase !== 'FCI')
    .map((c, i) => ({
      id: `ex${i + 1}`,
      cuentaId: c.id,
      archivo: `${c.banco?.toLowerCase()}_${c.id}_${d[1].replace(/-/g, '')}_${(c.id === 'cb-mpdax' ? d[7] : d[8]).replace(/-/g, '')}.csv`,
      desde: d[1],
      hasta: c.id === 'cb-mpdax' ? d[7] : d[8],
      movimientos: movimientos.filter((m) => m.cuentaId === c.id).length,
      nuevos: movimientos.filter((m) => m.cuentaId === c.id).length,
      importadoPor: 'Vivi',
      importadoEn: `${hoyIso}T08:4${i}:00`,
      huella: `demo-${c.id}`,
    }))

  // Comprobante de gastos del primer día ya generado y subido (para mostrar que no se regenera).
  const documentos: DocumentoBancario[] = []
  const gastosCo1 = movimientos.filter((m) => m.cuentaId === 'co1' && m.destinoXubio === 'COMPROBANTE')
  const diaCo1 = gastosCo1[0]?.fecha
  if (diaCo1) {
    const tot = -gastosCo1.filter((m) => m.fecha === diaCo1).reduce((a, m) => a + m.importe, 0)
    documentos.push({ id: 'doc1', tipo: 'COMPROBANTE', cuentaId: 'co1', fecha: diaCo1, numero: `09990-${diaCo1.replace(/-/g, '')}`, total: r2(tot), estado: 'PAGADA', estadoXubio: 'SUBIDA' })
    for (const m of movimientos) if (m.cuentaId === 'co1' && m.fecha === diaCo1 && m.destinoXubio === 'COMPROBANTE') m.facturaId = 'doc1'
  }

  // ---------------------------------------------------------------- Cheques
  const h = (n: number) => sumarHabiles(hoyIso, n, fer)
  const ch = (c: Partial<Cheque> & Pick<Cheque, 'id' | 'empresaId' | 'cuentaId' | 'tipo' | 'numero' | 'beneficiario' | 'importe' | 'fechaPago'>): Cheque => ({
    fechaEmision: iso(addDays(parseIso(c.fechaPago), -30)),
    estado: 'EMITIDO',
    origen: 'PAGO',
    pagos: [],
    ...c,
  })
  const cheques: Cheque[] = [
    ch({ id: 'ch1', empresaId: 'beratung', cuentaId: 'co2', tipo: 'FISICO', numero: '00012345', beneficiario: 'Laboratorio Modelo S.A.', proveedorId: 'p02', importe: 1_250_000, fechaPago: d[5], estado: 'DEBITADO', debitadoEn: d[5], marcadoPor: 'Vivi' }),
    ch({ id: 'ch2', empresaId: 'beratung', cuentaId: 'co1', tipo: 'ECHEQ', numero: '70000418', beneficiario: 'Insumos Médicos del Sur S.R.L.', proveedorId: 'p01', importe: 1_840_000, fechaPago: h(3) }),
    ch({ id: 'ch3', empresaId: 'beratung', cuentaId: 'co1', tipo: 'ECHEQ', numero: '70000402', beneficiario: 'Seguros Prueba S.A.', proveedorId: 'p07', importe: 480_000, fechaPago: d[8], observaciones: 'Venció ayer: ¿se debitó?' }),
    ch({ id: 'ch4', empresaId: 'beratung', cuentaId: 'cb-dax', tipo: 'FISICO', numero: '00004471', beneficiario: 'Dr. Prestador Demo Dos', proveedorId: 'p04', importe: 620_000, fechaPago: h(8) }),
    ch({ id: 'ch5', empresaId: 'india', cuentaId: 'co4', tipo: 'ECHEQ', numero: '81000077', beneficiario: 'Seguridad Integral Modelo', proveedorId: 'p13', importe: 943_800, fechaPago: h(5), estado: 'ENTREGADO' }),
    ch({ id: 'ch6', empresaId: 'india', cuentaId: 'co4', tipo: 'ECHEQ', numero: '81000081', beneficiario: 'Financiera Demo S.A.', importe: 1_500_000, fechaPago: h(12), origen: 'FINANCIERA', observaciones: 'Descuento de cheques' }),
    ch({ id: 'ch7', empresaId: 'beratung', cuentaId: 'co1', tipo: 'FISICO', numero: '00012350', beneficiario: 'Librería Modelo', proveedorId: 'p08', importe: 96_500, fechaPago: h(2), estado: 'ANULADO', anuladoPor: 'Vivi', motivoAnulacion: 'Se pagó por transferencia', anulacionXubio: 'ERROR' }),
  ]

  // ---------------------------------------------------------------- Proyecciones
  const filas = unidades.flatMap(filasDe)
  const fila = (u: string, orden: number) => `${u}-${orden}`
  const mes0 = iso(new Date(parseIso(hoyIso).getFullYear(), parseIso(hoyIso).getMonth(), 1))
  const enMeses = (n: number) => iso(new Date(parseIso(hoyIso).getFullYear(), parseIso(hoyIso).getMonth() + n, 1))
  const viernes = (() => {
    let x = parseIso(hoyIso)
    while (x.getDay() !== 5) x = addDays(x, 1)
    return iso(x)
  })()
  const miercoles = (() => {
    let x = addDays(parseIso(hoyIso), 1)
    while (x.getDay() !== 3) x = addDays(x, 1)
    return iso(x)
  })()
  const p = (x: Omit<Proyeccion, 'estado' | 'creadoPor' | 'ajustePctMensual'> & { ajustePctMensual?: number }): Proyeccion => ({ estado: 'ACTIVA', creadoPor: 'Vivi', ajustePctMensual: 0, ...x })
  const proyecciones: Proyeccion[] = [
    p({ id: 'pr1', empresaId: 'beratung', unidadId: 'u-ber', filaId: fila('u-ber', 310), concepto: 'Sueldos Beratung', importe: -8_400_000, fechaInicio: mes0, recurrencia: 'MENSUAL', diaMes: 1, hasta: enMeses(12), origen: 'SUELDOS' }),
    p({ id: 'pr2', empresaId: 'beratung', unidadId: 'u-ber', filaId: fila('u-ber', 430), concepto: 'Plan de pagos AFIP (12 cuotas)', importe: -312_500, fechaInicio: mes0, recurrencia: 'MENSUAL', diaMes: 16, cuotas: 12, origen: 'PLAN_PAGO' }),
    p({ id: 'pr3', empresaId: 'beratung', unidadId: 'u-ber', filaId: fila('u-ber', 110), concepto: 'Cobranza obras sociales', importe: 3_200_000, fechaInicio: viernes, recurrencia: 'SEMANAL', hasta: enMeses(3), origen: 'COBRANZA' }),
    p({ id: 'pr4', empresaId: 'beratung', unidadId: 'u-ber', filaId: fila('u-ber', 810), concepto: 'Cuota préstamo Galicia', importe: -780_000, fechaInicio: mes0, recurrencia: 'MENSUAL', diaMes: 10, cuotas: 18, ajustePctMensual: 2.5, origen: 'PRESTAMO' }),
    p({ id: 'pr5', empresaId: 'beratung', unidadId: 'u-ber', filaId: fila('u-ber', 910), concepto: 'Retiro de socios', importe: -1_500_000, fechaInicio: h(6), recurrencia: 'UNICA', origen: 'MANUAL' }),
    p({ id: 'pr6', empresaId: 'beratung', unidadId: 'u-ber', filaId: fila('u-ber', 340), concepto: 'Expensas y servicios', importe: -265_000, fechaInicio: mes0, recurrencia: 'MENSUAL', diaMes: 7, hasta: enMeses(12), origen: 'GASTO_FIJO' }),
    p({ id: 'pr7', empresaId: 'beratung', unidadId: 'u-dax', filaId: fila('u-dax', 110), concepto: 'Cobranza Dax Salud', importe: 900_000, fechaInicio: miercoles, recurrencia: 'SEMANAL', hasta: enMeses(3), origen: 'COBRANZA' }),
    p({ id: 'pr8', empresaId: 'beratung', unidadId: 'u-dax', filaId: fila('u-dax', 310), concepto: 'Sueldos Dax Salud', importe: -2_100_000, fechaInicio: mes0, recurrencia: 'MENSUAL', diaMes: 1, hasta: enMeses(12), origen: 'SUELDOS' }),
    p({ id: 'pr9', empresaId: 'india', unidadId: 'u-ind', filaId: fila('u-ind', 310), concepto: 'Sueldos India', importe: -3_600_000, fechaInicio: mes0, recurrencia: 'MENSUAL', diaMes: 1, hasta: enMeses(12), origen: 'SUELDOS' }),
    p({ id: 'pr10', empresaId: 'india', unidadId: 'u-ind', filaId: fila('u-ind', 110), concepto: 'Cobranza India', importe: 2_500_000, fechaInicio: viernes, recurrencia: 'QUINCENAL', hasta: enMeses(3), origen: 'COBRANZA' }),
  ]
  // Un ajuste ya hecho, para que se vea cómo queda marcado: la cobranza de India se corrió dos días.
  const oc = ocurrenciasProyeccion(proyecciones[9], hoyIso, iso(addDays(parseIso(hoyIso), 60)), fer)[0]
  const ajustes: AjusteDemo[] = oc
    ? [{ id: 'aj1', empresaId: 'india', origenTipo: 'PROYECCION', origenId: 'pr10', ocurrencia: oc.ocurrencia, fechaNueva: sumarHabiles(oc.fecha, 2, fer), eliminada: false, motivo: 'El cliente avisó que paga el martes', creadoPor: 'Vivi', creadoEn: `${hoyIso}T09:10:00` }]
    : []

  // Una orden de pago anulada en el sistema que Xubio no deja borrar por API (queda ERROR hasta que se marque a mano).
  const anulacionesPago: AnulacionPagoDemo[] = [
    { id: 'pa-op1', empresaId: 'india', fecha: d[3], descripcion: 'Seguridad Integral Modelo · ORDEN_PAGO · Pago duplicado', importe: 120_000, xubioId: 'OP-0001-00000871', estado: 'ERROR' },
  ]
  return { unidades, cuentas, feriados: FERIADOS, movimientos, saldos, lecturasXubio, documentos, extractos, cheques, filas, proyecciones, ajustes, reglas: [...REGLAS], anulacionesPago }
}

// ---------------------------------------------------------------- Vistas (como en la base)

/** conciliacion_bancaria */
export function conciliacion(e: EstadoTesoreria): Conciliacion[] {
  const r: Conciliacion[] = []
  for (const c of e.cuentas) {
    const movs = [
      ...e.movimientos.filter((m) => m.cuentaId === c.id && m.estado !== 'IGNORADO').map((m) => ({ fecha: m.fecha, importe: m.importe })),
      ...e.movimientos.filter((m) => m.contraparteCuentaId === c.id && m.estado !== 'IGNORADO').map((m) => ({ fecha: m.fecha, importe: -m.importe })),
    ]
    const saldos = e.saldos.filter((s) => s.cuentaId === c.id).sort((a, b) => a.fecha.localeCompare(b.fecha))
    const dias = [...new Set([...saldos.map((s) => s.fecha), ...movs.map((m) => m.fecha)])].sort()
    for (const d of dias) {
      const s = saldos.find((x) => x.fecha === d)
      const ant = [...saldos].reverse().find((x) => x.fecha < d)
      const del = movs.filter((m) => m.fecha <= d && (!ant || m.fecha > ant.fecha))
      const creditos = r2(del.filter((m) => m.importe > 0).reduce((a, m) => a + m.importe, 0))
      const debitos = r2(-del.filter((m) => m.importe < 0).reduce((a, m) => a + m.importe, 0))
      const calc = ant ? r2(ant.saldo + creditos - debitos) : undefined
      const dif = s && calc !== undefined ? r2(s.saldo - calc) : undefined
      const x = e.lecturasXubio.find((l) => l.cuentaId === c.id && l.fecha === d)
      const estado: Conciliacion['estado'] = !s
        ? 'SIN_EXTRACTO'
        : s.origen === 'SIN_MOVIMIENTOS'
          ? 'SIN_MOVIMIENTOS'
          : !ant
            ? 'PRIMER_SALDO'
            : c.clase === 'FCI' || c.clase === 'REMUNERADA'
              ? 'OK'
              : Math.abs(dif ?? 0) <= 1
                ? 'OK'
                : 'DIFERENCIA'
      r.push({
        empresaId: c.empresaId,
        unidadId: c.unidadId,
        cuentaId: c.id,
        cuenta: c.nombre,
        clase: c.clase,
        fecha: d,
        fechaAnterior: ant?.fecha,
        saldoAnterior: ant?.saldo,
        creditos,
        debitos,
        movimientos: del.length,
        saldoCalculado: calc,
        saldoExtracto: s?.saldo,
        origen: s?.origen,
        diferencia: dif,
        rendimiento: (c.clase === 'FCI' || c.clase === 'REMUNERADA') && ant && s ? dif : undefined,
        saldoXubio: x?.saldo,
        diferenciaXubio: x && s ? r2(s.saldo - x.saldo) : undefined,
        estado,
      })
    }
  }
  return r
}

/** Destino de una línea: la fila de su cuenta contable en la unidad; FCI y entre cuentas, a "Entre cuentas propias". */
function filaDestino(e: EstadoTesoreria, unidadId: string, cuenta: string | undefined, categoria?: CategoriaMovimiento): string {
  const filas = e.filas.filter((f) => f.unidadId === unidadId)
  if (categoria === 'FCI' || categoria === 'TRANSFERENCIA_PROPIA') return filas.find((f) => f.seccion === 'ENTRE_CUENTAS')!.id
  const f = cuenta ? filas.find((x) => (x.tipo === 'CUENTA' || x.tipo === 'APERTURA') && textoBanco(x.cuentaContable) === textoBanco(cuenta)) : undefined
  return (f ?? filas.find((x) => x.seccion === 'SIN_CLASIFICAR'))!.id
}

/** flujo_lineas */
export function lineasFlujo(e: EstadoTesoreria, facturas: Factura[], hoyIso: string, conc: Conciliacion[]): LineaFlujo[] {
  const fer = new Set(e.feriados)
  const cuenta = (id: string) => e.cuentas.find((c) => c.id === id)!
  const unidadDe = (empresaId: string, unidadId?: string) => unidadId ?? e.unidades.find((u) => u.empresaId === empresaId && u.porDefecto)?.id
  type Base = Omit<LineaFlujo, 'fechaCalculada' | 'vencido' | 'ajustada' | 'editable'>
  const base: Base[] = []

  // REAL · movimientos del banco (en la demo, los pagos y cobros salen de su movimiento).
  for (const m of e.movimientos) {
    if (m.estado === 'IGNORADO' || m.chequeId) continue
    const c = cuenta(m.cuentaId)
    const u = c.unidadId!
    const tipo = m.categoria === 'PAGO' ? 'PAGO' : m.categoria === 'COBRO' ? 'COBRO' : 'MOVIMIENTO'
    base.push({
      empresaId: m.empresaId,
      unidadId: u,
      filaId: filaDestino(e, u, m.cuentaContable, m.categoria),
      origenTipo: tipo,
      origenId: m.id,
      ocurrencia: tipo,
      naturaleza: 'REAL',
      fecha: m.fecha,
      importe: m.importe,
      contraparte: m.contraparte ?? c.nombre,
      concepto: m.descripcion,
    })
    if (m.contraparteCuentaId) {
      const cc = cuenta(m.contraparteCuentaId)
      base.push({
        empresaId: m.empresaId,
        unidadId: cc.unidadId!,
        filaId: filaDestino(e, cc.unidadId!, m.cuentaContable, m.categoria),
        origenTipo: 'MOVIMIENTO',
        origenId: m.id,
        ocurrencia: 'CONTRAPARTE',
        naturaleza: 'REAL',
        fecha: m.fecha,
        importe: -m.importe,
        contraparte: cc.nombre,
        concepto: m.descripcion,
      })
    }
  }
  // REAL · rendimiento de FCI (sale de la conciliación).
  for (const k of conc) {
    if (!k.rendimiento) continue
    base.push({
      empresaId: k.empresaId,
      unidadId: k.unidadId!,
      filaId: filaDestino(e, k.unidadId!, 'Rendimientos FCI'),
      origenTipo: 'RENDIMIENTO',
      origenId: k.cuentaId,
      ocurrencia: k.fecha,
      naturaleza: 'REAL',
      fecha: k.fecha,
      importe: k.rendimiento,
      contraparte: k.cuenta,
      concepto: `Rendimiento ${k.cuenta}`,
    })
  }
  // REAL · cheques debitados / PROYECTADO · cheques emitidos sin debitar.
  for (const ch of e.cheques) {
    if (ch.estado !== 'DEBITADO' && ch.estado !== 'EMITIDO' && ch.estado !== 'ENTREGADO') continue
    const c = cuenta(ch.cuentaId)
    const cc = PROVEEDORES.find((p) => p.id === ch.proveedorId)?.cuentaHabitual
    base.push({
      empresaId: ch.empresaId,
      unidadId: c.unidadId!,
      filaId: filaDestino(e, c.unidadId!, cc),
      origenTipo: 'CHEQUE',
      origenId: ch.id,
      ocurrencia: 'CHEQUE',
      naturaleza: ch.estado === 'DEBITADO' ? 'REAL' : 'PROYECTADO',
      fecha: ch.estado === 'DEBITADO' ? ch.debitadoEn! : ch.fechaPago,
      importe: -ch.importe,
      contraparte: ch.beneficiario,
      concepto: `Cheque ${ch.numero}`,
    })
  }
  const manana = iso(addDays(parseIso(hoyIso), 1))
  // PROYECTADO · facturas por pagar, en tramos (anticipo pendiente el próximo día hábil, resto a su fecha).
  for (const f of facturas) {
    if (f.estado !== 'PARA_PAGAR' && f.estado !== 'PAGADA_PARCIAL') continue
    if (/cr[eé]dito/i.test(f.tipo)) continue
    const u = unidadDe(f.empresaId, f.unidadId)
    if (!u) continue
    const anticipoTotal = r2((f.total * (f.tipoPago === 'ANTICIPO_PARCIAL' ? (f.anticipoPct ?? 0) : 0)) / 100)
    const anticipoPend = Math.max(r2(anticipoTotal - f.pagado), 0)
    const prov = PROVEEDORES.find((p) => p.id === f.proveedorId)
    const fechaSaldo =
      f.fechaPago ?? ((f.metodoPago === 'CHEQUE' || f.metodoPago === 'ECHEQ') && f.diasCheque ? iso(addDays(parseIso(f.fecha), f.diasCheque)) : f.vencimiento)
    const tramos: [string, string, number][] = [
      ['ANTICIPO', diaHabilDesde(f.fecha > manana ? f.fecha : manana, fer), anticipoPend],
      ['SALDO', fechaSaldo, r2(f.total - f.pagado - anticipoPend)],
    ]
    for (const [oc, fecha, imp] of tramos) {
      if (imp <= 0) continue
      base.push({
        empresaId: f.empresaId,
        unidadId: u,
        filaId: filaDestino(e, u, f.cuentaContable),
        origenTipo: 'FACTURA',
        origenId: f.id,
        ocurrencia: oc,
        naturaleza: 'PROYECTADO',
        fecha,
        importe: -imp,
        contraparte: prov?.nombre ?? f.proveedorId,
        concepto: `${f.tipo} ${String(f.puntoVenta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}${oc === 'ANTICIPO' ? ` · anticipo ${f.anticipoPct} %` : ''}`,
      })
    }
  }
  // PROYECTADO · proyecciones de hoy a 180 días.
  const hasta = iso(addDays(parseIso(hoyIso), 180))
  // Fila manual (0038): lo cargado a mano (origen MANUAL) reemplaza ese día a las demás proyecciones de la fila; si no hay carga, suman.
  const cargasManuales = new Set<string>()
  for (const p of e.proyecciones) {
    if (p.estado === 'ACTIVA' && p.origen === 'MANUAL' && e.filas.find((f) => f.id === p.filaId)?.manual)
      for (const o of ocurrenciasProyeccion(p, hoyIso, hasta, fer)) cargasManuales.add(`${p.filaId}|${o.fecha}`)
  }
  for (const p of e.proyecciones) {
    if (p.estado !== 'ACTIVA') continue
    for (const o of ocurrenciasProyeccion(p, hoyIso, hasta, fer)) {
      if (p.origen !== 'MANUAL' && cargasManuales.has(`${p.filaId}|${o.fecha}`)) continue
      base.push({
        empresaId: p.empresaId,
        unidadId: p.unidadId,
        filaId: p.filaId,
        origenTipo: 'PROYECCION',
        origenId: p.id,
        ocurrencia: o.ocurrencia,
        naturaleza: 'PROYECTADO',
        fecha: o.fecha,
        importe: o.importe,
        contraparte: p.concepto,
        concepto: p.concepto,
      })
    }
  }

  const hoyHabil = diaHabilDesde(hoyIso, fer)
  const r: LineaFlujo[] = []
  for (const b of base) {
    const a =
      b.naturaleza === 'PROYECTADO'
        ? e.ajustes.find((x) => !x.reemplazadoEn && x.origenTipo === b.origenTipo && x.origenId === b.origenId && x.ocurrencia === b.ocurrencia)
        : undefined
    if (a?.eliminada) continue
    const fechaAj = a?.fechaNueva ?? b.fecha
    const vencido = b.naturaleza === 'PROYECTADO' && fechaAj < hoyIso
    r.push({
      ...b,
      fecha: vencido ? hoyHabil : fechaAj,
      fechaCalculada: b.fecha,
      importe: a?.importeNuevo !== undefined ? Math.sign(b.importe) * a.importeNuevo : b.importe,
      vencido,
      ajustada: !!a,
      editable: b.naturaleza === 'PROYECTADO',
    })
  }
  return r
}

/** flujo_control */
export function controlFlujo(e: EstadoTesoreria, lineas: LineaFlujo[]): ControlFlujo[] {
  const r: ControlFlujo[] = []
  for (const u of e.unidades) {
    const cuentas = e.cuentas.filter((c) => c.unidadId === u.id && c.requiereExtracto)
    if (!cuentas.length) continue
    const fechas = [...new Set(e.saldos.filter((s) => cuentas.some((c) => c.id === s.cuentaId)).map((s) => s.fecha))].sort()
    let ant: { fecha: string; saldo: number } | undefined
    for (const f of fechas) {
      const ss = cuentas.map((c) => e.saldos.find((s) => s.cuentaId === c.id && s.fecha === f))
      if (!ss.every(Boolean)) continue
      const saldo = r2(ss.reduce((a, s) => a + (s?.saldo ?? 0), 0))
      const movido = ant
        ? r2(lineas.filter((l) => l.unidadId === u.id && l.naturaleza === 'REAL' && l.fecha > ant!.fecha && l.fecha <= f).reduce((a, l) => a + l.importe, 0))
        : 0
      const dif = ant ? r2(saldo - ant.saldo - movido) : 0
      r.push({
        unidadId: u.id,
        fecha: f,
        fechaAnterior: ant?.fecha,
        saldoAnterior: ant?.saldo,
        saldoBancos: saldo,
        realDelPeriodo: movido,
        diferencia: dif,
        estado: !ant ? 'PRIMER_SALDO' : Math.abs(dif) <= 1 ? 'OK' : 'F',
      })
      ant = { fecha: f, saldo }
    }
  }
  return r
}

/** Lo mismo que la vista xubio_bancos_pendientes (0029), con lo que modela la demo. */
export function pendientesXubioDemo(e: EstadoTesoreria): PendienteXubio[] {
  const empresaDe = (cuentaId: string) => e.cuentas.find((c) => c.id === cuentaId)?.empresaId ?? ''
  const nombre = (cuentaId: string) => e.cuentas.find((c) => c.id === cuentaId)?.nombre ?? cuentaId
  const docs: PendienteXubio[] = e.documentos
    .filter((d) => d.estado !== 'ANULADO' && (d.estadoXubio === 'PENDIENTE' || d.estadoXubio === 'ERROR'))
    .map((d) => ({
      empresaId: empresaDe(d.cuentaId),
      tipo: d.tipo,
      id: d.id,
      fecha: d.fecha,
      descripcion: d.tipo === 'COMPROBANTE' ? `${d.numero} · ${nombre(d.cuentaId)}` : `Asiento del banco ${nombre(d.cuentaId)}`,
      importe: d.total,
      estado: d.tipo === 'COMPROBANTE' && d.estado === 'PENDIENTE_APROBACION' ? 'FALTA_APROBAR' : d.estadoXubio === 'ERROR' ? 'ERROR' : 'PENDIENTE',
      aMano: false,
      cuentaId: d.cuentaId,
    }))
  const cheques: PendienteXubio[] = e.cheques
    .filter((c) => c.anulacionXubio === 'PENDIENTE' || c.anulacionXubio === 'ERROR')
    .map((c) => ({
      empresaId: c.empresaId,
      tipo: 'ANULAR_CHEQUE',
      id: c.id,
      fecha: c.fechaPago,
      descripcion: `Cheque ${c.numero} · ${c.beneficiario} · ${c.motivoAnulacion ?? ''}`,
      importe: c.importe,
      estado: c.anulacionXubio as 'PENDIENTE' | 'ERROR',
      aMano: true,
      cuentaId: c.cuentaId,
      ultimoIntentoDetalle: c.anulacionXubio === 'ERROR' ? `Cheque ${c.numero}: la emisión es una orden de pago y Xubio no la borra por API. Anularla a mano en Xubio.` : undefined,
    }))
  const pagos: PendienteXubio[] = (e.anulacionesPago ?? [])
    .filter((p) => p.estado !== 'HECHA')
    .map((p) => ({
      empresaId: p.empresaId,
      tipo: 'ANULAR_PAGO',
      id: p.id,
      fecha: p.fecha,
      descripcion: p.descripcion,
      importe: p.importe,
      estado: p.estado as 'PENDIENTE' | 'ERROR',
      xubioId: p.xubioId,
      aMano: true,
      ultimoIntentoDetalle: p.estado === 'ERROR' ? `ORDEN_PAGO ${p.xubioId}: Xubio no permite borrarlo por API. Anularlo a mano en Xubio.` : undefined,
    }))
  return [...docs, ...cheques, ...pagos].sort((a, b) => a.fecha.localeCompare(b.fecha))
}

export function vistaTesoreria(e: EstadoTesoreria, facturas: Factura[], hoyIso: string): DatosTesoreria {
  const conc = conciliacion(e)
  const lineas = lineasFlujo(e, facturas, hoyIso, conc)
  const usadas = e.filas.map((f) => f.cuentaContable).filter((x): x is string => !!x)
  return {
    disponible: true,
    hoy: hoyIso,
    unidades: e.unidades,
    cuentas: e.cuentas,
    feriados: e.feriados,
    movimientos: e.movimientos,
    saldos: e.saldos,
    conciliacion: conc,
    documentos: e.documentos,
    extractos: e.extractos,
    cheques: e.cheques,
    pendientesXubio: pendientesXubioDemo(e),
    chequesSugeridos: [],
    avisosFci: [],
    saldosArrastrados: [],
    filas: e.filas,
    lineas,
    control: controlFlujo(e, lineas),
    proyecciones: e.proyecciones,
    fotos: e.fotos ?? [],
    cuentasContables: [...new Set([...PLAN_CUENTAS, ...usadas, 'IVA COMPRAS', 'Fondos Comun de Inversion Bancos'])].sort((a, b) => a.localeCompare(b)),
  }
}
