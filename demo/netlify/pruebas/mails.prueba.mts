// Pruebas de src/lib/mails.ts (mails a proveedores) y lib/xubio-catalogos.ts. Uso: npm run test:mails
import { armarMails, linkGmail, pesosMail, remitentePara } from '../../src/lib/mails.ts'
import { cuentasDesdeXubio, origenDesdePagos } from '../functions/lib/xubio-catalogos-armado.ts'
import type { Empresa, Factura, Pago, Proveedor } from '../../src/types.ts'

let ok = 0
let mal = 0
function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}

const empresas: Empresa[] = [
  { id: 'india', nombre: 'INDIA ADV S.A.', corto: 'India', cuit: '', erp: 'XUBIO' },
  { id: 'robles', nombre: 'Droguería Robles S.A.', corto: 'Robles', cuit: '', erp: 'RALPHARMA' },
]
const proveedores: Proveedor[] = [
  { id: 'pv1', nombre: 'Lab Sur S.A.', cuit: '30711111119', email: 'pagos@labsur.com', categoriaVertice: 'PROVEEDOR' },
  { id: 'pv2', nombre: 'Sin Mail SRL', cuit: '30722222229', email: '', categoriaVertice: 'PROVEEDOR' },
]
const fac = (id: string, numero: number, total: number, extra: Partial<Factura> = {}): Factura => ({
  id, empresaId: 'india', proveedorId: 'pv1', tipo: 'Factura A', puntoVenta: 5, numero, fecha: '2026-11-01', vencimiento: '2026-11-30', neto: total, iva: 0,
  percepciones: 0, total, cae: '', caeVencimiento: '', origen: 'MANUAL', estado: 'PAGADA', estadoXubio: 'SUBIDA', validacionOk: true, categoriaVertice: 'PROVEEDOR',
  pagado: total, pagadoPct: 100, ...extra,
})
const pago = (id: string, facturaIds: string[], importe: number, extra: Partial<Pago> = {}): Pago => ({
  id, empresaId: 'india', proveedorId: 'pv1', fecha: '2026-11-15', importe, medio: 'TRANSFERENCIA', cuentaOrigen: 'Banco Galicia CC $', facturaIds, descripcion: '',
  formaCargaXubio: 'ORDEN_PAGO', estado: 'CONTABILIZADO', comprobante: '', cargadoPor: 'Vivi', cargadoEn: '2026-11-15T10:00:00Z', ...extra,
})

const f1 = fac('f1', 1001, 1000), f2 = fac('f2', 1002, 2000), f3 = fac('f3', 1003, 500), nc = fac('nc', 9, 300, { tipo: 'Nota de Crédito', estado: 'PAGADA' })
const fRob = fac('fr', 77, 400, { empresaId: 'robles' })
const fSin = fac('fs', 55, 100, { proveedorId: 'pv2' })
const pagos = [
  pago('p1', ['f1'], 700),
  pago('p2', ['f2'], 1500, { medio: 'ECHEQ', numeroCheque: '123', fechaAcreditacion: '2026-12-15' }),
  pago('p3', ['f3'], 500, { medio: 'ECHEQ', numeroCheque: '123', fechaAcreditacion: '2026-12-15' }),
  pago('p4', ['f2'], 500, { estado: 'ANULADO' }),
  pago('p5', ['fr'], 400, { empresaId: 'robles' }),
]
const todas = [f1, f2, f3, nc, fRob, fSin]
const mails = armarMails({
  facturas: [f1, f2, fRob, fSin], todas, pagos, proveedores, empresas,
  ncAplicadas: { f1: [{ ncId: 'nc', importe: 300 }] }, links: { p1: 'https://link/p1', p2: 'https://link/p2', p3: 'https://link/p3' },
})
const m = mails.find((x) => x.to === 'pagos@labsur.com' && x.from === 'tesoreria@verticebi.com')!
check('un mail por proveedor, remitente y empresa', mails.length === 3, mails.map((x) => x.clave).join(' / '))
check('asunto con proveedor y cantidad de facturas', m.subject === 'Comprobantes de pago — Lab Sur S.A. — 2 facturas', m.subject)
check('cada factura con su monto y la NC aplicada debajo', m.body.includes('• Factura N° 00005-00001001 · $ 1.000,00\n  Nota de Crédito N° 00005-00000009 aplicada · -$ 300,00'))
check('transferencia con banco, fecha y monto', m.body.includes('• Transferencia · Banco Galicia CC $ · 15/11/2026 · $ 700,00'))
check('el e-cheq aparece una sola vez con su total y aclara la otra factura', m.body.includes('• E-cheq N° 123 · Banco Galicia CC $ · fecha de cobro 15/12/2026 · $ 2.000,00 (también cancela la Factura N° 00005-00001003)'), m.body)
check('pagos anulados no aparecen', !m.body.includes('$ 500,00 ·') && !m.body.includes('· $ 500,00\n'))
check('links de los comprobantes', m.body.includes('Comprobantes de pago:\nhttps://link/p1\nhttps://link/p2\nhttps://link/p3') && !m.sinComprobante)
check('firma con el nombre prolijo de la empresa', m.body.endsWith('Saludos cordiales,\nTesorería · India ADV S.A.'))
const rob = mails.find((x) => x.from !== 'tesoreria@verticebi.com')!
check('Robles sale desde la casilla de Tesorería de Robles', rob.from === remitentePara('robles') && rob.body.includes('por Droguería Robles S.A.'))
check('una sola factura: asunto en singular y aviso de que falta el comprobante', rob.subject === 'Comprobante de pago — Lab Sur S.A. — Factura N° 00005-00000077' && rob.sinComprobante)
check('proveedor sin mail: queda para completar', mails.some((x) => x.proveedor === 'Sin Mail SRL' && x.to === ''))
const url = new URL(linkGmail(m))
check('link de Gmail en la cuenta del remitente, con destinatario, asunto y texto', url.hostname === 'mail.google.com' && url.searchParams.get('authuser') === 'tesoreria@verticebi.com' && url.searchParams.get('to') === 'pagos@labsur.com' && url.searchParams.get('body') === m.body)
check('pesos con punto de miles y coma decimal', pesosMail(1234567.5) === '$ 1.234.567,50' && pesosMail(-3) === '-$ 3,00')
const soloNc = armarMails({ facturas: [nc], todas, pagos, proveedores, empresas, ncAplicadas: {}, links: {} })[0]
check('una NC sola (no aplicada en el mail) va como Nota de Crédito, no como Factura', soloNc.body.includes('• Nota de Crédito N° 00005-00000009 · -$ 300,00') && !soloNc.body.includes('• Factura'))

// ---------------------------------------------------------------- Catálogos de Xubio
const cuentas = cuentasDesdeXubio([{ ID: 2, codigo: '55001001', nombre: 'GASTOS BANCARIOS' }, { id: 1, codigo: '11001001', nombre: 'CAJA' }, { ID: 3, nombre: 'SIN CODIGO' }], 'india')
check('plan de cuentas: "CÓDIGO NOMBRE", ordenado por código', cuentas.map((c) => c.nombre).join(' | ') === 'SIN CODIGO | 11001001 CAJA | 55001001 GASTOS BANCARIOS' && cuentas[1].xubio_id === '1')
const origen = origenDesdePagos([
  { fecha: '2026-10-01', transaccionInstrumentoDePago: [{ tipoCuenta: 2, cuenta: { ID: 10, nombre: 'Banco Galicia CC $', codigo: 'GAL' } }] },
  { fecha: '2026-11-05', transaccionInstrumentoDePago: [{ tipoCuenta: 2, cuenta: { ID: 10, nombre: 'Banco Galicia CC $' } }, { tipoCuenta: 4, cuenta: { ID: 11, nombre: 'Cheque Diferido BRUBANK' } }] },
], 'india')
check('cuentas de origen: usos, tipo y último uso', origen[0].nombre === 'Banco Galicia CC $' && origen[0].usos === 2 && origen[0].ultimo_uso === '2026-11-05' && origen[1].tipo_cuenta === 4)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
