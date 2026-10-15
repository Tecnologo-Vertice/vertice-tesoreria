// Pruebas de lib/xubio-armado.ts: factura de compra, pago dentro de la factura y búsquedas en listados de Xubio.
// Uso: npm run test:xubio. Datos ficticios con la forma real de la API.
import { elegirProducto, elegirProveedor, facturaCompra, facturaYaExiste, idCreado, itemPagoEnFactura, numeroDocumento, tipoComprobante } from '../functions/lib/xubio-armado.ts'

let ok = 0
let mal = 0
function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}

check('número con el formato de Xubio (A-00105-02121138)', numeroDocumento('A', 105, 2121138) === 'A-00105-02121138')
check('tipos: factura 1, NC 3, ND 2', tipoComprobante('Factura A') === 1 && tipoComprobante('Nota de Crédito B') === 3 && tipoComprobante('Nota de Débito A') === 2)
check('tipo desconocido es 0 (no se sube)', tipoComprobante('Presupuesto') === 0)

const prov = { ID: 501, id: 501, nombre: 'Laboratorio Ejemplo S.A.', codigo: 'LABEJ' }
const prod = { ID: 77, id: 77, nombre: 'COSTO DE INSUMOS', codigo: 'INSUMOS' }
const fc = facturaCompra(
  {
    id: 'uuid-1', tipo: 'Factura A', letra: 'A', punto_venta: 1, numero: 2604, fecha: '2026-10-10', vencimiento: '2026-11-09', cotizacion: 1,
    neto: 100000, iva: 21000, exento: 0, total: 126500,
    percepciones_json: [{ nombre: 'Percepción IVA', importe: 3000 }, { nombre: 'Percepción IIBB Buenos Aires', importe: 1500 }, { nombre: 'Percepción IIBB CABA', importe: 1000 }],
  },
  prov,
  prod,
)
check('factura: total, gravado e impuestos (IVA + percepciones)', fc.importetotal === 126500 && fc.importeGravado === 100000 && fc.importeImpuestos === 26500)
check('factura: 3 percepciones separadas', fc.transaccionPercepcionItems.length === 3)
check('factura: cuenta corriente (se paga después)', fc.condicionDePago === 1)
check('factura: externalId = id propio (para encontrarla sin adivinar)', fc.externalId === 'uuid-1')
check('factura: ítem con el producto de la cuenta', fc.transaccionProductoItems[0].producto.codigo === 'INSUMOS' && fc.transaccionProductoItems[0].total === 121000)

// Listados como los devuelve Xubio
const proveedores = [
  { proveedorid: 10, nombre: 'Laboratorio Ejemplo SA', CUIT: '20-12345678-6' },
  { proveedorid: 11, nombre: 'Laboratorio Ejemplo S.A. Sucursal', CUIT: '30-99999999-1' },
]
check('proveedor por CUIT aunque el nombre difiera', elegirProveedor(proveedores, '20123456786', 'Otro nombre')?.ID === 10)
check('proveedor por nombre exacto si no hay CUIT', elegirProveedor([{ ID: 12, nombre: 'Estudio Ejemplo' }], '', 'ESTUDIO EJEMPLO')?.ID === 12)
check('proveedor parecido NO se toma (Code.gs lo tomaba)', elegirProveedor([{ ID: 13, nombre: 'Estudio Ejemplo y Asociados' }], '', 'Estudio Ejemplo') === null)

const productos = [{ productoid: 77, nombre: 'Costo de insumos', codigo: 'INSUMOS' }, { productoid: 78, nombre: 'Honorarios', codigo: 'HON' }]
check('producto por código recordado', elegirProducto(productos, 'HON', 'COSTO DE INSUMOS')?.ID === 78)
check('producto por nombre de la cuenta contable', elegirProducto(productos, null, 'COSTO DE INSUMOS')?.ID === 77)
check('sin producto: null (la factura queda con error claro)', elegirProducto(productos, null, 'SEGUROS') === null)

const existentes = [{ transaccionid: 95139854, numeroDocumento: 'A-00001-00002604', proveedor: { ID: 501 } }]
check('duplicado en Xubio: devuelve su id', facturaYaExiste(existentes, 'A-00001-00002604', 501) === '95139854')
check('mismo número de otro proveedor no es duplicado', facturaYaExiste(existentes, 'A-00001-00002604', 999) === null)

check('id creado: transaccionid', idCreado({ transaccionid: 123 }) === '123')
check('id creado: 0 o vacío no cuenta como id', idCreado({ transaccionid: 0 }) === '' && idCreado(null) === '')

const item = itemPagoEnFactura({ cuentaOrigen: { ID: 9, id: 9, nombre: 'Cheque Diferido BRUBANK', codigo: '' }, importe: 298931.21, descripcion: 'OP', cheque: { numero: '29598', vencimiento: '2026-09-18' } })
check('pago en factura con cheque: tipo de cuenta 4, número y vencimiento (OP 483)', item.cuentaTipo === '4' && item.chequePropios === '29598' && item.fechaVto === '2026-09-18')
const transf = itemPagoEnFactura({ cuentaOrigen: { ID: 3, id: 3, nombre: 'Banco Galicia CC $', codigo: '' }, importe: 1000, descripcion: 'x' })
check('pago en factura por transferencia: tipo de cuenta 2, sin cheque', transf.cuentaTipo === '2' && !('chequePropios' in transf))

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
