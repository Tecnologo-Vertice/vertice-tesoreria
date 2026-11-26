// Contabilización de pagos (contabilizar.mts) corrida entera contra el simulador.
// Tanda A2: una prueba en seco no cambia la cuenta de origen de un pago que gestiona la hoja.
// Uso: npm run test:contabilizar
import { cerrar, check, json, pedido, simular, type Fila, type Mundo, type Pedido } from './simulador.mts'

delete process.env.XUBIO_ENVIO_REAL
delete process.env.XUBIO_CREDS_JSON

const contabilizar = (await import('../functions/contabilizar.mts')).default

const ID = '11111111-2222-3333-4444-555555555555'
const CUENTA_ELEGIDA = 'Banco Hipotecario CC 0319 BERATUNG'
function mundo(pago: Fila = {}, extra: Partial<Mundo> = {}): Mundo {
  return simular({
    sesiones: { guido: 'administracion@prueba.com', vivi: 'tesoreria@prueba.com' },
    tablas: {
      usuarios: [
        { email: 'administracion@prueba.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true },
        { email: 'tesoreria@prueba.com', nombre: 'Vivi', rol: 'TESORERIA', activo: true, todas_empresas: true },
      ],
      pagos: [
        {
          id: ID, estado: 'CARGADO', gestion: 'HOJA', importe: 60500, fecha: '2026-10-22', medio: 'TRANSFERENCIA', cuenta_origen: 'Banco Hipotecario',
          numero_cheque: null, fecha_acreditacion: null, descripcion: 'Pago factura 350', observaciones: null, envio_xubio_en: null, cuenta_contable: null,
          proveedores: { nombre: 'LIMPIEZA SUR SRL', cuit: '30715555551' }, empresas: { id: 'beratung', nombre: 'Beratung S.A.', erp: 'XUBIO' }, ...pago,
        },
      ],
      cuentas_origen: [{ empresa_id: 'beratung', nombre: CUENTA_ELEGIDA, tipo_cuenta: 2 }],
      pagos_facturas: [],
      xubio_log: [],
    },
    rpc: {
      usuario_ve_empresa: () => true,
      marcar_pago_revisado: (a, m) => void Object.assign(m.tablas.pagos[0], { estado: 'REVISADO', cuenta_contable: a.p_cuenta, forma_carga_xubio: a.p_forma }),
      marcar_pago_contabilizado: (a, m) => void Object.assign(m.tablas.pagos[0], { estado: 'CONTABILIZADO', cuenta_contable: a.p_cuenta, forma_carga_xubio: a.p_forma, xubio_id: a.p_xubio_id }),
    },
    ...extra,
  })
}
const pedir = (extra: Fila = {}) => contabilizar(pedido('guido', { pagoId: ID, cuentaContable: 'Gastos Generales', formaCargaXubio: 'ORDEN_PAGO', cuentaOrigen: CUENTA_ELEGIDA, ...extra }))
/** Cambios que la función le hizo a la fila del pago, en orden. */
const cambios = (m: Mundo) => m.pedidos.filter((p) => p.metodo === 'PATCH' && p.ruta.endsWith('/pagos')).map((p) => p.cuerpo as Fila)
const pago = (m: Mundo) => m.tablas.pagos[0]

// ---------------------------------------------------------------- Prueba en seco (A2)
let m = mundo()
let r = await pedir()
let cuerpo = await r.json()
check('prueba en seco de un pago de la hoja: responde bien y queda revisado', r.status === 200 && cuerpo.enSeco === true && pago(m).estado === 'REVISADO', JSON.stringify(cuerpo))
check('…sin cambiarle la cuenta de origen (seguiría siendo de la hoja)', pago(m).cuenta_origen === 'Banco Hipotecario' && cambios(m).every((c) => !('cuenta_origen' in c)), JSON.stringify(cambios(m)))
check('…y el detalle dice contra qué cuenta se probó', String(pago(m).detalle_contabilizacion).includes(CUENTA_ELEGIDA) && String(cuerpo.detalle).includes(CUENTA_ELEGIDA))

m = mundo({ gestion: 'SISTEMA' })
r = await pedir()
check('prueba en seco de un pago del sistema: la cuenta de origen elegida queda guardada', r.status === 200 && pago(m).cuenta_origen === CUENTA_ELEGIDA)

// Con credenciales, Xubio dice que la cuenta elegida no existe: no se guarda nada (antes se guardaba antes de validar).
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: 'id', secret: 's' } })
const xubioSinLaCuenta = (p: Pedido) => (p.ruta.endsWith('/TokenEndpoint') ? json({ access_token: 't', token_type: 'Bearer' }) : json([{ ID: 1, codigo: 'X', nombre: 'Otra cuenta' }]))
for (const gestion of ['HOJA', 'SISTEMA']) {
  m = mundo({ gestion }, { xubio: xubioSinLaCuenta })
  r = await pedir()
  cuerpo = await r.json()
  check(`la validación falla (pago ${gestion === 'HOJA' ? 'de la hoja' : 'del sistema'}): el pago no cambia en nada`, r.status === 422 && /no existe en Xubio/.test(cuerpo.error) && cambios(m).length === 0
    && pago(m).estado === 'CARGADO' && pago(m).cuenta_origen === 'Banco Hipotecario', `${r.status} ${cuerpo.error}`)
}
delete process.env.XUBIO_CREDS_JSON

m = mundo()
r = await contabilizar(pedido('vivi', { pagoId: ID, cuentaContable: 'Gastos Generales', formaCargaXubio: 'ORDEN_PAGO' }))
check('Tesorería no contabiliza (rol)', r.status === 403 && cambios(m).length === 0)

cerrar()
