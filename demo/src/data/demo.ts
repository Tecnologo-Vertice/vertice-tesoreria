// Datos FICTICIOS para la demo. Las empresas son las del grupo; proveedores, CUIT,
// importes, CAE y comprobantes son inventados. Las fechas se generan relativas a hoy
// para que el tablero de vencimientos siempre luzca.

import type {
  Auditoria,
  CategoriaVertice,
  ComprobanteEjemplo,
  CuentaOrigen,
  Documento,
  Empresa,
  Factura,
  Pago,
  Proveedor,
  Usuario,
} from '../types'
import { addDays, cuitConVerificador, hoy, iso } from '../lib/format'

export const USUARIOS: Usuario[] = [
  { nombre: 'Vivi', rol: 'TESORERIA', email: 'tesoreria@verticebi.com' },
  { nombre: 'Guido', rol: 'ADMINISTRACION', email: 'administracion@verticebi.com' },
  { nombre: 'Aprobador', rol: 'APROBADOR', email: 'aprobaciones@verticebi.com' },
  { nombre: 'Dirección', rol: 'DIRECCION', email: 'direccion@verticebi.com' },
  { nombre: 'Santi', rol: 'ADMIN', email: 'sistemas@verticebi.com' },
]

export const EMPRESAS: Empresa[] = [
  { id: 'beratung', nombre: 'Beratung S.A.', corto: 'Beratung', cuit: cuitConVerificador('30', '71000001'), erp: 'XUBIO' },
  { id: 'india', nombre: 'INDIA ADV S.A.', corto: 'India', cuit: cuitConVerificador('30', '71000002'), erp: 'XUBIO' },
  { id: 'controlb', nombre: 'Control B', corto: 'Control B', cuit: cuitConVerificador('30', '71000003'), erp: 'XUBIO' },
  { id: 'ysd', nombre: 'YSD Pharma S.A.', corto: 'YSD', cuit: cuitConVerificador('30', '71000004'), erp: 'XUBIO' },
  { id: 'vertice', nombre: 'Vértice BI S.A.', corto: 'Vértice', cuit: cuitConVerificador('30', '71000005'), erp: 'XUBIO' },
  { id: 'robles', nombre: 'Droguería Robles S.A.', corto: 'Drog. Robles', cuit: cuitConVerificador('30', '71000006'), erp: 'RALPHARMA' },
  { id: 'hrobles', nombre: 'Héctor Daniel Robles', corto: 'H. Robles', cuit: cuitConVerificador('20', '20000007'), erp: 'RALPHARMA' },
  { id: 'farmacontrol', nombre: 'Farma Control S.A.', corto: 'Farma Control', cuit: cuitConVerificador('30', '71000008'), erp: 'RALPHARMA' },
]

export const CATEGORIAS: Record<CategoriaVertice, string> = {
  PROVEEDOR: 'Proveedor',
  PRESTADOR_MEDICO: 'Prestador médico',
  FINANCIERA: 'Financiera',
  IMPUESTOS_SERVICIOS: 'Impuestos / servicios',
  INSUMOS_MEDICOS: 'Insumos médicos',
}

// Nombres tomados del plan de cuentas real exportado de Xubio (cuentas de resultado).
export const PLAN_CUENTAS: string[] = [
  'COSTO DE INSUMOS',
  'COSTO DE PRESTACIONES MEDICAS CONSULTORIO',
  'HONORARIOS PROFESIONALES',
  'HONORARIOS EXTERNOS CONTABLES',
  'HONORARIOS EXTERNOS LEGALES',
  'HONORARIOS EXTERNOS TECNICOS',
  'ALQUILER DE OFICINA',
  'GASTOS VARIOS OFICINA',
  'GASTOS GENERALES',
  'GASTOS BANCARIOS',
  'IMPUESTO DEB/CRED BANCARIO',
  'IMPUESTOS Y TASAS',
  'INSUMOS INFORMÁTICOS',
  'SOFTWARE DE GESTION',
  'SEGUROS',
  'MOVILIDAD Y VIATICOS',
  'PROMOCIÓN Y PUBLICIDAD',
  'SERVICIO DE TERCEROS',
  'GASTOS DE FLETES',
  'SERVICIOS DE SEGURIDAD',
  'INTERESES PAGADOS',
  'SUELDOS Y JORNALES',
]

export const PROVEEDORES: Proveedor[] = [
  { id: 'p01', nombre: 'Insumos Médicos del Sur S.R.L.', cuit: cuitConVerificador('30', '61000101'), email: 'pagos@insumosdelsur.demo', categoriaVertice: 'INSUMOS_MEDICOS', cuentaHabitual: 'COSTO DE INSUMOS' },
  { id: 'p02', nombre: 'Laboratorio Modelo S.A.', cuit: cuitConVerificador('30', '61000102'), email: 'cobranzas@labmodelo.demo', categoriaVertice: 'INSUMOS_MEDICOS', cuentaHabitual: 'COSTO DE INSUMOS' },
  { id: 'p03', nombre: 'Dra. Prestadora Demo Uno', cuit: cuitConVerificador('27', '20000103'), email: 'dra.uno@prestador.demo', categoriaVertice: 'PRESTADOR_MEDICO', cuentaHabitual: 'HONORARIOS PROFESIONALES' },
  { id: 'p04', nombre: 'Dr. Prestador Demo Dos', cuit: cuitConVerificador('20', '20000104'), email: 'dr.dos@prestador.demo', categoriaVertice: 'PRESTADOR_MEDICO', cuentaHabitual: 'HONORARIOS PROFESIONALES' },
  { id: 'p05', nombre: 'Estudio Contable Ejemplo', cuit: cuitConVerificador('30', '61000105'), email: 'admin@estudioejemplo.demo', categoriaVertice: 'PROVEEDOR', cuentaHabitual: 'HONORARIOS EXTERNOS CONTABLES' },
  { id: 'p06', nombre: 'Telefonía Demo S.A.', cuit: cuitConVerificador('30', '61000106'), email: 'facturacion@telefoniademo.demo', categoriaVertice: 'IMPUESTOS_SERVICIOS', cuentaHabitual: 'GASTOS VARIOS OFICINA' },
  { id: 'p07', nombre: 'Seguros Prueba S.A.', cuit: cuitConVerificador('30', '61000107'), email: 'polizas@segurosprueba.demo', categoriaVertice: 'FINANCIERA', cuentaHabitual: 'SEGUROS' },
  { id: 'p08', nombre: 'Librería Modelo', cuit: cuitConVerificador('27', '20000108'), email: 'ventas@libreriamodelo.demo', categoriaVertice: 'PROVEEDOR', cuentaHabitual: 'GASTOS VARIOS OFICINA' },
  { id: 'p09', nombre: 'Transporte Ficticio S.R.L.', cuit: cuitConVerificador('30', '61000109'), email: 'admin@transporteficticio.demo', categoriaVertice: 'PROVEEDOR', cuentaHabitual: 'GASTOS DE FLETES' },
  { id: 'p10', nombre: 'Software Gestión Demo', cuit: cuitConVerificador('30', '61000110'), email: 'billing@softgestion.demo', categoriaVertice: 'PROVEEDOR', cuentaHabitual: 'SOFTWARE DE GESTION' },
  { id: 'p11', nombre: 'Inmobiliaria Ejemplo S.A.', cuit: cuitConVerificador('30', '61000111'), email: 'alquileres@inmoejemplo.demo', categoriaVertice: 'PROVEEDOR', cuentaHabitual: 'ALQUILER DE OFICINA' },
  { id: 'p12', nombre: 'Energía Demo S.A.', cuit: cuitConVerificador('30', '61000112'), email: 'clientes@energiademo.demo', categoriaVertice: 'IMPUESTOS_SERVICIOS', cuentaHabitual: 'GASTOS GENERALES' },
  { id: 'p13', nombre: 'Seguridad Integral Modelo', cuit: cuitConVerificador('30', '61000113'), email: 'admin@segmodelo.demo', categoriaVertice: 'PROVEEDOR', cuentaHabitual: 'SERVICIOS DE SEGURIDAD' },
  { id: 'p14', nombre: 'Farmacéutica Ficticia S.A.', cuit: cuitConVerificador('30', '61000114'), email: 'cobros@farmaficticia.demo', categoriaVertice: 'INSUMOS_MEDICOS', cuentaHabitual: 'COSTO DE INSUMOS' },
]

export const CUENTAS_ORIGEN: CuentaOrigen[] = [
  { id: 'co1', empresaId: 'beratung', nombre: 'Banco Galicia CC $', saldo: 18_450_000 },
  { id: 'co2', empresaId: 'beratung', nombre: 'Banco Santander CC $', saldo: 6_200_000 },
  { id: 'co3', empresaId: 'beratung', nombre: 'Caja Beratung', saldo: 350_000 },
  { id: 'co4', empresaId: 'india', nombre: 'Banco Galicia CC $', saldo: 9_800_000 },
  { id: 'co5', empresaId: 'india', nombre: 'Mercado Pago', saldo: 1_150_000 },
  { id: 'co6', empresaId: 'controlb', nombre: 'Banco Macro CC $', saldo: 4_300_000 },
  { id: 'co7', empresaId: 'ysd', nombre: 'Banco BBVA CC $', saldo: 7_650_000 },
  { id: 'co8', empresaId: 'vertice', nombre: 'Banco Galicia CC $', saldo: 2_900_000 },
  { id: 'co9', empresaId: 'robles', nombre: 'Banco Credicoop CC $', saldo: 5_400_000 },
  { id: 'co10', empresaId: 'hrobles', nombre: 'Banco Nación CC $', saldo: 1_200_000 },
  { id: 'co11', empresaId: 'farmacontrol', nombre: 'Banco Galicia CC $', saldo: 3_100_000 },
]

// Generador determinista para que la demo sea igual en cada carga.
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(20261013)
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
const entre = (a: number, b: number) => Math.round((a + rnd() * (b - a)) / 100) * 100
const r2 = (n: number) => Math.round(n * 100) / 100

function cae(): string {
  let s = '7'
  for (let i = 0; i < 13; i++) s += Math.floor(rnd() * 10)
  return s
}

interface Spec {
  empresa: string
  prov: string
  diasVto: number
  estado: Factura['estado']
  neto?: number
  tipo?: Factura['tipo']
  origen?: Factura['origen']
  pct?: number
  xubio?: Factura['estadoXubio']
  valid?: string
  cuenta?: string
}

const SPECS: Spec[] = [
  // Pendientes de aprobación (Flujo 1 → Aprobador)
  { empresa: 'beratung', prov: 'p01', diasVto: 12, estado: 'PENDIENTE_APROBACION', origen: 'GMAIL' },
  { empresa: 'beratung', prov: 'p03', diasVto: 20, estado: 'PENDIENTE_APROBACION', origen: 'DRIVE', tipo: 'Factura C' },
  { empresa: 'india', prov: 'p10', diasVto: 9, estado: 'PENDIENTE_APROBACION', origen: 'GMAIL' },
  { empresa: 'controlb', prov: 'p06', diasVto: 5, estado: 'PENDIENTE_APROBACION', origen: 'GMAIL' },
  { empresa: 'ysd', prov: 'p14', diasVto: 30, estado: 'PENDIENTE_APROBACION', origen: 'GMAIL' },
  { empresa: 'robles', prov: 'p02', diasVto: 15, estado: 'PENDIENTE_APROBACION', origen: 'MANUAL' },
  { empresa: 'beratung', prov: 'p08', diasVto: 7, estado: 'ERROR', origen: 'GMAIL', valid: 'Total no cierra: neto + IVA difiere en $1.210,00' },
  { empresa: 'india', prov: 'p09', diasVto: 3, estado: 'ERROR', origen: 'GMAIL', valid: 'CAE vencido el mes pasado' },
  { empresa: 'vertice', prov: 'p05', diasVto: 10, estado: 'PENDIENTE_APROBACION', origen: 'GMAIL', tipo: 'Factura M' },

  // Para pagar (aprobadas, Flujo 2 → Vivi)
  { empresa: 'beratung', prov: 'p02', diasVto: -9, estado: 'PARA_PAGAR', neto: 1_480_000, xubio: 'SUBIDA' },
  { empresa: 'beratung', prov: 'p04', diasVto: -3, estado: 'PARA_PAGAR', neto: 620_000, tipo: 'Factura C', xubio: 'SUBIDA' },
  { empresa: 'beratung', prov: 'p11', diasVto: 0, estado: 'PARA_PAGAR', neto: 950_000, xubio: 'SUBIDA' },
  { empresa: 'beratung', prov: 'p01', diasVto: 2, estado: 'PARA_PAGAR', neto: 2_310_000, xubio: 'SUBIDA' },
  { empresa: 'india', prov: 'p12', diasVto: 0, estado: 'PARA_PAGAR', neto: 410_000, xubio: 'SUBIDA' },
  { empresa: 'india', prov: 'p13', diasVto: 6, estado: 'PARA_PAGAR', neto: 780_000, xubio: 'SUBIDA' },
  { empresa: 'india', prov: 'p07', diasVto: 14, estado: 'PARA_PAGAR', neto: 1_120_000, xubio: 'SUBIDA' },
  { empresa: 'controlb', prov: 'p05', diasVto: -1, estado: 'PARA_PAGAR', neto: 540_000, xubio: 'ERROR' },
  { empresa: 'controlb', prov: 'p10', diasVto: 11, estado: 'PARA_PAGAR', neto: 260_000, xubio: 'SUBIDA' },
  { empresa: 'ysd', prov: 'p14', diasVto: 4, estado: 'PARA_PAGAR', neto: 3_050_000, xubio: 'SUBIDA' },
  { empresa: 'ysd', prov: 'p09', diasVto: 21, estado: 'PARA_PAGAR', neto: 330_000, xubio: 'SUBIDA' },
  { empresa: 'vertice', prov: 'p10', diasVto: 8, estado: 'PARA_PAGAR', neto: 180_000, xubio: 'SUBIDA' },
  { empresa: 'robles', prov: 'p01', diasVto: -5, estado: 'PARA_PAGAR', neto: 1_890_000, xubio: 'PENDIENTE_RALPHARMA' },
  { empresa: 'farmacontrol', prov: 'p14', diasVto: 18, estado: 'PARA_PAGAR', neto: 2_400_000, xubio: 'PENDIENTE_RALPHARMA' },
  { empresa: 'hrobles', prov: 'p06', diasVto: 25, estado: 'PARA_PAGAR', neto: 95_000, xubio: 'PENDIENTE_RALPHARMA' },
  { empresa: 'beratung', prov: 'p03', diasVto: 27, estado: 'PARA_PAGAR', neto: 450_000, tipo: 'Factura C', xubio: 'SUBIDA' },
  { empresa: 'india', prov: 'p02', diasVto: 1, estado: 'PAGADA_PARCIAL', neto: 2_000_000, pct: 50, xubio: 'SUBIDA' },

  // Pagadas (histórico)
  { empresa: 'beratung', prov: 'p06', diasVto: -20, estado: 'PAGADA', neto: 385_000, pct: 100, xubio: 'SUBIDA' },
  { empresa: 'beratung', prov: 'p12', diasVto: -16, estado: 'PAGADA', neto: 512_000, pct: 100, xubio: 'SUBIDA' },
  { empresa: 'india', prov: 'p11', diasVto: -12, estado: 'PAGADA', neto: 880_000, pct: 100, xubio: 'SUBIDA' },
  { empresa: 'ysd', prov: 'p01', diasVto: -8, estado: 'PAGADA', neto: 1_720_000, pct: 100, xubio: 'SUBIDA' },
  { empresa: 'controlb', prov: 'p13', diasVto: -6, estado: 'PAGADA', neto: 640_000, pct: 100, xubio: 'SUBIDA' },
  { empresa: 'robles', prov: 'p02', diasVto: -4, estado: 'PAGADA', neto: 990_000, pct: 100, xubio: 'PENDIENTE_RALPHARMA' },
]

function buildFacturas(): Factura[] {
  const t = hoy()
  return SPECS.map((s, i) => {
    const prov = PROVEEDORES.find((p) => p.id === s.prov)!
    const tipo = s.tipo ?? (prov.categoriaVertice === 'PRESTADOR_MEDICO' ? 'Factura C' : 'Factura A')
    const neto = s.neto ?? entre(90_000, 2_600_000)
    const alicuota = tipo === 'Factura C' ? 0 : 0.21
    const iva = r2(neto * alicuota)
    const percepciones = tipo === 'Factura A' && rnd() > 0.6 ? r2(neto * 0.03) : 0
    const total = r2(neto + iva + percepciones)
    const vto = addDays(t, s.diasVto)
    const fechaEmision = addDays(vto, -30)
    const aprobada = s.estado !== 'PENDIENTE_APROBACION' && s.estado !== 'ERROR'
    return {
      id: `f${String(i + 1).padStart(3, '0')}`,
      empresaId: s.empresa,
      proveedorId: s.prov,
      tipo,
      puntoVenta: 1 + Math.floor(rnd() * 12),
      numero: 1000 + Math.floor(rnd() * 90000),
      fecha: iso(fechaEmision),
      vencimiento: iso(vto),
      neto,
      iva,
      percepciones,
      total,
      cae: cae(),
      caeVencimiento: iso(addDays(fechaEmision, s.valid?.includes('CAE') ? -40 : 10)),
      origen: s.origen ?? pick<Factura['origen']>(['GMAIL', 'GMAIL', 'DRIVE', 'MANUAL']),
      estado: s.estado,
      estadoXubio: s.xubio ?? 'PENDIENTE',
      validacionOk: !s.valid,
      motivoValidacion: s.valid,
      categoriaVertice: prov.categoriaVertice,
      cuentaContable: aprobada ? (s.cuenta ?? prov.cuentaHabitual) : undefined,
      metodoPago: aprobada ? pick<Factura['metodoPago']>(['TRANSFERENCIA', 'TRANSFERENCIA', 'CHEQUE', 'ECHEQ', 'DEBITO']) : undefined,
      diasCheque: 30,
      pagado: r2(total * ((s.pct ?? 0) / 100)),
      pagadoPct: s.pct ?? 0,
      aprobadoPor: aprobada ? 'Aprobador' : undefined,
      aprobadoEn: aprobada ? new Date(addDays(fechaEmision, 3).getTime() + (9 + (i % 7)) * 3600 * 1000 + (i * 7 % 60) * 60000).toISOString() : undefined,
    }
  })
}

export const FACTURAS_INICIALES: Factura[] = buildFacturas()

function buildPagos(facturas: Factura[]): Pago[] {
  const t = hoy()
  const pagadas = facturas.filter((f) => f.estado === 'PAGADA' || f.estado === 'PAGADA_PARCIAL')
  const pagos: Pago[] = pagadas.map((f, i) => {
    const emp = EMPRESAS.find((e) => e.id === f.empresaId)!
    const cuentas = CUENTAS_ORIGEN.filter((c) => c.empresaId === f.empresaId)
    const medio = f.metodoPago ?? 'TRANSFERENCIA'
    const esCheque = medio === 'CHEQUE' || medio === 'ECHEQ'
    const fechaPago = addDays(t, -Math.abs(Math.round(f.vencimiento < iso(t) ? -1 : 0)) - (i % 5) - 1)
    const importe = f.pagado
    const contabilizado = i % 3 !== 1
    return {
      id: `pg${String(i + 1).padStart(3, '0')}`,
      empresaId: f.empresaId,
      proveedorId: f.proveedorId,
      fecha: iso(fechaPago),
      importe,
      medio,
      cuentaOrigen: cuentas[0]?.nombre ?? 'Caja',
      bancoDestino: pick(['Banco Galicia', 'Banco Santander', 'Banco Macro', 'Banco Nación']),
      numeroCheque: esCheque ? String(44000000 + Math.floor(rnd() * 999999)) : undefined,
      fechaAcreditacion: esCheque ? iso(addDays(fechaPago, 30)) : undefined,
      facturaIds: [f.id],
      descripcion: `Pago ${f.tipo} ${PROVEEDORES.find((p) => p.id === f.proveedorId)!.nombre}`,
      observaciones: f.pagadoPct < 100 ? 'Pago del 50 %, el resto la semana que viene' : undefined,
      cuentaContable: f.cuentaContable,
      sugerenciaOrigen: 'REGLA',
      sugerenciaConfianza: 0.97,
      formaCargaXubio: 'ORDEN_PAGO',
      estado: emp.erp === 'RALPHARMA' ? 'PENDIENTE_RALPHARMA' : contabilizado ? 'CONTABILIZADO' : 'CARGADO',
      comprobante: `comprobante_${f.id}.pdf`,
      cargadoPor: 'Vivi',
      cargadoEn: new Date(fechaPago.getTime() + 10 * 3600 * 1000).toISOString(),
      contabilizadoPor: contabilizado && emp.erp === 'XUBIO' ? 'Guido' : undefined,
      contabilizadoEn: contabilizado && emp.erp === 'XUBIO' ? new Date(fechaPago.getTime() + 15 * 3600 * 1000).toISOString() : undefined,
      xubioId: contabilizado && emp.erp === 'XUBIO' ? `OP-${7100 + i}` : undefined,
      mailProveedorEnviado: f.pagadoPct === 100,
    }
  })

  // Pagos sin factura (gastos bancarios, impuestos), el caso que más dudas genera.
  pagos.push(
    {
      id: 'pg901',
      empresaId: 'beratung',
      fecha: iso(addDays(t, -2)),
      importe: 48_350,
      medio: 'DEBITO',
      cuentaOrigen: 'Banco Galicia CC $',
      facturaIds: [],
      descripcion: 'Débito automático: comisión mantenimiento de cuenta',
      observaciones: 'Lo debitó el banco, no hay factura. ¿Va a gastos bancarios?',
      cuentaContable: 'GASTOS BANCARIOS',
      sugerenciaOrigen: 'IA',
      sugerenciaConfianza: 0.88,
      formaCargaXubio: 'SALIDA_FONDOS',
      estado: 'CARGADO',
      comprobante: 'extracto_galicia_comision.png',
      cargadoPor: 'Vivi',
      cargadoEn: new Date(addDays(t, -2).getTime() + 11.25 * 3600 * 1000).toISOString(),
    },
    {
      id: 'pg902',
      empresaId: 'india',
      fecha: iso(addDays(t, -1)),
      importe: 312_900,
      medio: 'TRANSFERENCIA',
      cuentaOrigen: 'Banco Galicia CC $',
      bancoDestino: 'ARCA',
      facturaIds: [],
      descripcion: 'Pago IIBB CABA período anterior',
      observaciones: 'VEP de ingresos brutos',
      cuentaContable: 'IMPUESTOS Y TASAS',
      sugerenciaOrigen: 'REGLA',
      sugerenciaConfianza: 0.99,
      formaCargaXubio: 'ASIENTO_MANUAL',
      estado: 'CARGADO',
      comprobante: 'vep_iibb_india.pdf',
      cargadoPor: 'Vivi',
      cargadoEn: new Date(addDays(t, -1).getTime() + 16.6 * 3600 * 1000).toISOString(),
    },
    {
      id: 'pg903',
      empresaId: 'ysd',
      fecha: iso(addDays(t, -1)),
      importe: 150_000,
      medio: 'TRANSFERENCIA',
      cuentaOrigen: 'Banco BBVA CC $',
      bancoDestino: 'Banco Santander',
      facturaIds: [],
      descripcion: 'Transferencia a proveedor, sin factura todavía',
      observaciones: 'Anticipo a Laboratorio Modelo, la factura llega la semana próxima',
      cuentaContable: undefined,
      sugerenciaOrigen: undefined,
      formaCargaXubio: 'SALIDA_FONDOS',
      estado: 'CARGADO',
      comprobante: 'transf_bbva_anticipo.jpg',
      cargadoPor: 'Vivi',
      cargadoEn: new Date(addDays(t, -1).getTime() + 16.6 * 3600 * 1000).toISOString(),
    },
  )
  return pagos
}

export const PAGOS_INICIALES: Pago[] = buildPagos(FACTURAS_INICIALES)

export function auditoriaInicial(facturas: Factura[], pagos: Pago[]): Auditoria[] {
  const out: Auditoria[] = []
  let n = 1
  for (const f of facturas) {
    out.push({
      id: `a${n++}`,
      fecha: new Date(addDays(new Date(f.fecha), 1).getTime() + 8.5 * 3600 * 1000).toISOString(),
      usuario: 'Sistema',
      rol: 'ADMIN',
      accion: 'INGRESO',
      entidad: 'FACTURA',
      entidadId: f.id,
      detalle: `Leída por IA desde ${f.origen}; validación ${f.validacionOk ? 'OK' : 'con error'}`,
    })
    if (f.aprobadoEn)
      out.push({
        id: `a${n++}`,
        fecha: f.aprobadoEn,
        usuario: f.aprobadoPor ?? 'Aprobador',
        rol: 'APROBADOR',
        accion: 'APROBACION',
        entidad: 'FACTURA',
        entidadId: f.id,
        detalle: `Cuenta ${f.cuentaContable ?? '—'} · ${f.metodoPago ?? '—'}`,
      })
  }
  for (const p of pagos) {
    out.push({
      id: `a${n++}`,
      fecha: p.cargadoEn,
      usuario: p.cargadoPor,
      rol: 'TESORERIA',
      accion: 'PAGO_CARGADO',
      entidad: 'PAGO',
      entidadId: p.id,
      detalle: `${p.medio} · ${p.cuentaOrigen}`,
    })
    if (p.contabilizadoEn)
      out.push({
        id: `a${n++}`,
        fecha: p.contabilizadoEn,
        usuario: p.contabilizadoPor ?? 'Guido',
        rol: 'ADMINISTRACION',
        accion: 'CONTABILIZADO',
        entidad: 'PAGO',
        entidadId: p.id,
        detalle: `Xubio ${p.xubioId} · ${p.formaCargaXubio} · ${p.cuentaContable}`,
      })
  }
  return out.sort((a, b) => a.fecha.localeCompare(b.fecha))
}

// Documentos de entrada (Flujo 1) que no terminaron en factura: lo que la bandeja "Entrada" muestra.
export const DOCUMENTOS_INICIALES: Documento[] = [
  {
    id: 'd901',
    origen: 'GMAIL',
    nombre: 'presupuesto_mantenimiento_aire.pdf',
    estado: 'ERROR',
    error: 'No es un comprobante de compra válido (sin tipo: recibo X, presupuesto, otro documento).',
    remitente: 'Climatización Ejemplo <ventas@climaejemplo.demo>',
    asunto: 'Presupuesto mantenimiento',
    recibidoEn: new Date(addDays(hoy(), -1).getTime() + 10.5 * 3600 * 1000).toISOString(),
    intentos: 1,
    storagePath: 'presupuesto_mantenimiento_aire.pdf',
  },
  {
    id: 'd902',
    origen: 'GMAIL',
    nombre: 'FC_A_0003_00045120.pdf',
    estado: 'DUPLICADO',
    error: 'Ya estaba cargada',
    remitente: 'Insumos Médicos del Sur <facturacion@insumosdelsur.demo>',
    asunto: 'RV: Factura pendiente',
    recibidoEn: new Date(addDays(hoy(), 0).getTime() + 9 * 3600 * 1000).toISOString(),
    intentos: 1,
    storagePath: 'FC_A_0003_00045120.pdf',
    facturaId: 'f001',
  },
]

// Comprobantes "subidos" en la demo: la IA devuelve esto en vez de llamar a un modelo.
export function comprobantesEjemplo(facturas: Factura[]): ComprobanteEjemplo[] {
  const t = hoy()
  const fLab = facturas.find((f) => f.id === 'f010')
  const fAlq = facturas.find((f) => f.id === 'f012')
  return [
    {
      id: 'c1',
      nombre: 'transferencia_galicia_8841.pdf',
      descripcion: 'Transferencia desde Galicia a Laboratorio Modelo (coincide con una factura vencida)',
      lectura: {
        banco: 'Banco Galicia CC $',
        importe: fLab?.total ?? 1_790_800,
        fecha: iso(t),
        medio: 'TRANSFERENCIA',
        bancoDestino: 'Banco Santander',
        beneficiario: 'Laboratorio Modelo S.A.',
        referencia: 'TRF 0008841',
        confianza: 0.96,
      },
    },
    {
      id: 'c2',
      nombre: 'echeq_44120077.png',
      descripcion: 'Foto de un e-cheq a 30 días para Inmobiliaria Ejemplo (alquiler)',
      lectura: {
        banco: 'Banco Santander CC $',
        importe: fAlq?.total ?? 1_149_500,
        fecha: iso(t),
        medio: 'ECHEQ',
        numeroCheque: '44120077',
        beneficiario: 'Inmobiliaria Ejemplo S.A.',
        referencia: 'ECHEQ 30 días',
        confianza: 0.91,
      },
    },
    {
      id: 'c3',
      nombre: 'captura_app_banco_borrosa.jpg',
      descripcion: 'Captura borrosa del homebanking, sin factura asociada',
      lectura: {
        banco: 'Banco Galicia CC $',
        importe: 27_500,
        fecha: iso(addDays(t, -1)),
        medio: 'DEBITO',
        referencia: 'Impuesto Ley 25413',
        confianza: 0.62,
      },
    },
  ]
}
