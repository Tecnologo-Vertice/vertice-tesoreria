// Pruebas de lib/factura.ts (lectura y validación de facturas del Flujo 1) con respuestas de IA de ejemplo.
// Uso: npm run test:ia   (Node 24 corre TypeScript sin compilar). CUIT y montos ficticios.
import { cuitValido, interpretarLectura, parsearNumero, promptFactura, type EmpresaRef } from '../functions/lib/factura.ts'

let ok = 0
let mal = 0
function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}

const EMPRESAS: EmpresaRef[] = [
  { id: 'beratung', nombre: 'Beratung S.A.', cuit: '30710000014' },
  { id: 'india', nombre: 'INDIA ADV S.A.', cuit: '00000000001' }, // CUIT marcador de la semilla
  { id: 'robles', nombre: 'Droguería Robles S.A.', cuit: '00000000005' },
  { id: 'hrobles', nombre: 'Héctor Daniel Robles', cuit: '00000000006' },
]
const HOY = '2026-10-14'
const PROV = '20123456786' // CUIT válido (dígito verificador correcto)

// Factura A típica, que cierra exacto.
const base = (extra: Record<string, unknown> = {}) => ({
  RECEPTOR: 'BERATUNG S.A.', CUIT_RECEPTOR: '30-71000001-4', PROVEEDOR: 'Laboratorio Ejemplo S.A.', CUIT_PROVEEDOR: '20-12345678-6',
  LETRA: 'A', TIPO: 'Factura A', NUMERO: '0001-00002604', CAE: '74123456789012', CAE_VENCIMIENTO: '2026-10-20', COMPROBANTE_VINCULADO: '',
  FECHA: '2026-10-10', VENCIMIENTODELPAGO: '2026-11-09', MONEDA: 'ARS', COTIZACION: 1, PRODUCTOSERVICIOPERCEPCION: 'Insumos',
  IMPORTE: 100000, IVA: 21000, NETO_NO_GRAVADO_EXENTO: 0, PERCEPCION_IVA: 3000,
  PERCEPCIONES_IIBB: [{ PROVINCIA: 'Buenos Aires', MONTO: 1500 }, { PROVINCIA: 'CABA', MONTO: 1000 }],
  RETENCION: 0, TOTAL: 126500, CATEGORIA_CONTABLE: 'Gastos Generales', ...extra,
})
const leer = (extra: Record<string, unknown> = {}) => interpretarLectura(base(extra), EMPRESAS, HOY)
const factura = (extra: Record<string, unknown> = {}) => {
  const r = leer(extra)
  if (r.tipo !== 'FACTURA') throw new Error('se esperaba FACTURA y vino: ' + r.motivo)
  return r.factura
}

// --- Utilidades
check('CUIT válido por dígito verificador', cuitValido(PROV) && cuitValido('30-71000001-4'))
check('CUIT con dígito mal', !cuitValido('20123456785'))
check('número 0001-00002604', JSON.stringify(parsearNumero('0001-00002604')) === '{"puntoVenta":1,"numero":2604}')
check('número de Xubio A-00105-02121138', JSON.stringify(parsearNumero('A-00105-02121138')) === '{"puntoVenta":105,"numero":2121138}')
check('número sin formato no inventa 00001', parsearNumero('12345') === null)

// --- Caso feliz
let f = factura()
check('factura A que cierra: válida', f.validacion_ok && !f.motivo_validacion, f.motivo_validacion)
check('empresa por CUIT del receptor', f.empresa_id === 'beratung')
check('percepciones IIBB de dos provincias, separadas y sumadas', f.percepciones === 5500 && f.percepciones_json.length === 3)
check('categoría de la IA queda como sugerencia, no como cuenta', f.categoria_ia === 'Gastos Generales')
check('punto de venta y número', f.punto_venta === 1 && f.numero === 2604)

// --- Reglas del manual de carga (Code.gs)
f = factura({ LETRA: 'C', TIPO: 'Factura C', IMPORTE: 0, IVA: 0, NETO_NO_GRAVADO_EXENTO: 50000, PERCEPCION_IVA: 0, PERCEPCIONES_IIBB: [], TOTAL: 50000 })
check('B/C con el total en exento: pasa al neto', f.neto === 50000 && f.exento === 0 && f.validacion_ok)
f = factura({ TIPO: 'Nota de Crédito A', IMPORTE: -100000, IVA: -21000 })
check('nota de crédito: importes en positivo', f.neto === 100000 && f.iva === 21000 && f.validacion_ok, f.motivo_validacion)
f = factura({ TOTAL: 126500.4 })
check('diferencia menor a $1: válida con aviso de redondeo', f.validacion_ok && f.advertencia.includes('redondeo'))
f = factura({ TOTAL: 130000 })
check('descuadre de más de $1: error', !f.validacion_ok && f.motivo_validacion.includes('Descuadre'))
f = factura({ CAE: '' })
check('sin CAE: error', !f.validacion_ok && f.motivo_validacion.includes('CAE'))
f = factura({ CAE: '7412345678' })
check('CAE de 10 dígitos: error', !f.validacion_ok && f.motivo_validacion.includes('longitud'))
f = factura({ LETRA: 'M', TIPO: 'Factura M' })
check('Factura M: aviso de retenciones', f.validacion_ok && f.advertencia.includes('Factura M'))

// --- MEJORAS frente a Code.gs
f = factura({ CAE_VENCIMIENTO: '2026-10-12' })
check('CAE vencido DESPUÉS de emitir: válida con aviso (Code.gs la marcaba error)', f.validacion_ok && f.advertencia.includes('CAE vencido'))
f = factura({ CAE_VENCIMIENTO: '2026-10-01' })
check('CAE vencido ANTES de emitir: error', !f.validacion_ok && f.motivo_validacion.includes('antes de la fecha de emisión'))
f = factura({ CUIT_PROVEEDOR: '20123456785' })
check('CUIT del proveedor con dígito mal: error', !f.validacion_ok && f.motivo_validacion.includes('dígito verificador'))
f = factura({ CUIT_PROVEEDOR: '30710000014' })
check('CUIT del proveedor = empresa del grupo (IA confundió emisor/receptor): error', !f.validacion_ok && f.motivo_validacion.includes('grupo'))

// --- Empresa receptora
f = factura({ CUIT_RECEPTOR: '', RECEPTOR: 'India ADV SA' })
check('empresa por nombre si no hay CUIT', f.empresa_id === 'india')
f = factura({ PROVEEDOR: 'DROGUERIA ROBLES S.A.', RECEPTOR: 'Beratung' })
check('emitida por Droguería Robles → empresa robles (regla de Code.gs)', f.empresa_id === 'robles')

// --- No se puede guardar como factura
let r = leer({ TIPO: '' })
check('sin tipo (recibo X, presupuesto): no crea factura', r.tipo === 'SIN_FACTURA')
r = leer({ RECEPTOR: 'Empresa Desconocida SRL', CUIT_RECEPTOR: '' })
check('empresa receptora desconocida: no crea factura', r.tipo === 'SIN_FACTURA' && r.motivo.includes('receptora'))
r = leer({ NUMERO: 'S/N' })
check('número ilegible: no crea factura', r.tipo === 'SIN_FACTURA')

// --- Prompt
const p = promptFactura(EMPRESAS, HOY)
check('el prompt lleva los CUIT reales del grupo', p.includes('30710000014 (Beratung S.A.)'))
check('el prompt no lleva CUIT marcadores ni "[CUIT India]"', !p.includes('00000000001') && !p.includes('[CUIT'))

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
