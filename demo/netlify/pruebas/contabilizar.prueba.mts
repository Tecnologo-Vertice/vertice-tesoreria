// Envíos a Xubio y lecturas de IA corridos enteros contra el simulador.
// Tanda A2: una prueba en seco no cambia la cuenta de origen de un pago que gestiona la hoja.
// Tanda A3: con un Xubio o una IA que no responden, la función corta sola y el pago queda en un estado
//           del que se sale desde la pantalla; el proveedor se busca en Xubio solo con CUIT completo.
// Uso: npm run test:contabilizar
import { cerrar, check, json, lecturaGemini, noResponde, pedido, simular, type Externo, type Fila, type Mundo, type Pedido } from './simulador.mts'

delete process.env.XUBIO_ENVIO_REAL
delete process.env.XUBIO_CREDS_JSON

const contabilizar = (await import('../functions/contabilizar.mts')).default
const subirFacturaXubio = (await import('../functions/xubio-factura.mts')).default
const leerComprobante = (await import('../functions/ia-leer-comprobante.mts')).default
const subirFactura = (await import('../functions/subir-factura.mts')).default
const xubioLib = await import('../functions/lib/xubio.ts')

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

// ================================================================ Envío real y topes de tiempo (A3)
process.env.XUBIO_ENVIO_REAL = 'true'
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: 'id', secret: 's' } })
process.env.XUBIO_TIMEOUT_MS = '200'
process.env.GEMINI_TIMEOUT_MS = '200'

const PROVEEDORES_XUBIO = [{ ID: 1, nombre: 'Consumidor final' }, { ID: 501, nombre: 'LIMPIEZA SUR SRL', CUIT: '30-71555555-1' }]
/** Xubio contesta bien todas las lecturas; el envío (POST o PUT) lo decide cada prueba. */
const xubioCon = (envio: Externo): Externo => (p, corte) => {
  if (p.ruta.endsWith('/TokenEndpoint')) return json({ access_token: 't', token_type: 'Bearer' })
  if (p.metodo !== 'GET') return envio(p, corte)
  if (p.ruta.endsWith('/cuenta')) return json([{ ID: 10, codigo: '', nombre: CUENTA_ELEGIDA }, { ID: 11, codigo: '', nombre: 'Gastos Generales' }])
  if (p.ruta.endsWith('/ProveedorBean')) return json(PROVEEDORES_XUBIO)
  if (p.ruta.endsWith('/ProductoCompraBean')) return json([{ productoid: 77, nombre: 'Gastos Generales', codigo: 'GG' }])
  return json([])
}
const envios = (m: Mundo) => m.pedidos.filter((p) => p.url.includes('xubio.com') && p.metodo !== 'GET' && !p.ruta.endsWith('/TokenEndpoint'))
const cronometrar = async (fn: () => Promise<Response>) => {
  const inicio = Date.now()
  const resp = await fn()
  return { resp, ms: Date.now() - inicio, cuerpo: await resp.json() }
}

// Xubio no contesta nada: se corta antes de reservar el pago.
m = mundo({}, { xubio: noResponde })
let t = await cronometrar(() => pedir())
check('Xubio no responde: la función corta sola, en el tope', t.resp.status === 504 && /no respondió/.test(t.cuerpo.error) && t.ms < 2_000, `${t.resp.status} en ${t.ms} ms · ${t.cuerpo.error}`)
check('…y el pago queda como estaba, sin reserva', cambios(m).length === 0 && pago(m).estado === 'CARGADO' && pago(m).envio_xubio_en === null)

// Xubio contesta las lecturas y se cuelga en el envío: no se sabe si creó la orden de pago.
m = mundo({}, { xubio: xubioCon(noResponde) })
t = await cronometrar(() => pedir())
check('Xubio se cuelga en el envío: la función corta sola y avisa que no se sabe si se creó', t.resp.status === 502 && /no se sabe si Xubio creó/.test(t.cuerpo.error) && t.ms < 3_000, `${t.resp.status} en ${t.ms} ms · ${t.cuerpo.error}`)
check('…el pago queda reservado (trabado), sin contabilizar', pago(m).estado === 'CARGADO' && pago(m).envio_xubio_en != null && !pago(m).xubio_id)
check('…con la cuenta, la forma y el origen del envío, para resolverlo desde la tarjeta', pago(m).cuenta_contable === 'Gastos Generales' && pago(m).forma_carga_xubio === 'ORDEN_PAGO'
  && pago(m).cuenta_origen === CUENTA_ELEGIDA && /sin confirmar/.test(String(pago(m).detalle_contabilizacion)))
check('…y el intento queda en el registro de Xubio', m.tablas.xubio_log.length === 1 && /no respondió/.test(JSON.stringify(m.tablas.xubio_log[0].response)))
check('…y, aunque venía de la hoja, pasa a gestión del sistema: la copia de la hoja no le borra el aviso', pago(m).gestion === 'SISTEMA')
r = await pedir()
cuerpo = await r.json()
check('un pago trabado no se vuelve a enviar (no se crea una segunda orden de pago)', r.status === 409 && /tarjeta del pago/.test(cuerpo.error) && envios(m).length === 1, `${r.status} · ${envios(m).length} envío(s)`)

// Xubio responde con error del servidor: tampoco se sabe.
m = mundo({}, { xubio: xubioCon(() => json({ error: 'caído' }, 500)) })
r = await pedir()
check('Xubio responde 500 al envío: queda trabado y en gestión del sistema', r.status === 502 && pago(m).envio_xubio_en != null && pago(m).estado === 'CARGADO' && pago(m).cuenta_contable === 'Gastos Generales' && pago(m).gestion === 'SISTEMA')

// Xubio rechaza con claridad: no se creó nada, se libera sola.
m = mundo({}, { xubio: xubioCon(() => json({ error: 'cuenta inválida' }, 400)) })
r = await pedir()
cuerpo = await r.json()
check('Xubio rechaza el comprobante (400): la reserva se libera y el pago no cambia de dueño', r.status === 502 && /rechazó/.test(cuerpo.error) && pago(m).envio_xubio_en === null
  && pago(m).estado === 'CARGADO' && pago(m).cuenta_contable === null && pago(m).cuenta_origen === 'Banco Hipotecario' && pago(m).gestion === 'HOJA', JSON.stringify(cambios(m)))

// Xubio acepta.
m = mundo({}, { xubio: xubioCon(() => json({ ID: 9001 })) })
r = await pedir()
cuerpo = await r.json()
check('Xubio acepta: el pago queda contabilizado con su número y la cuenta de origen elegida', r.status === 200 && cuerpo.id === 'OP-9001' && pago(m).estado === 'CONTABILIZADO'
  && pago(m).xubio_id === 'OP-9001' && pago(m).cuenta_origen === CUENTA_ELEGIDA, JSON.stringify(cuerpo))
const ordenEnviada = envios(m)[0]?.cuerpo as { proveedor?: { ID?: number } }
check('…y la orden de pago fue al proveedor que coincide por CUIT', ordenEnviada?.proveedor?.ID === 501)

// Proveedor sin CUIT en el pago: no se elige el primero de Xubio que tampoco tenga CUIT.
m = mundo({ proveedores: { nombre: 'Proveedor Nuevo SA', cuit: '' } }, { xubio: xubioCon(() => json({ ID: 9002 })) })
r = await pedir()
cuerpo = await r.json()
check('proveedor sin CUIT: no se envía nada a un proveedor equivocado', r.status === 422 && /no existe en Xubio/.test(cuerpo.error) && envios(m).length === 0 && pago(m).estado === 'CARGADO', `${r.status} ${cuerpo.error}`)
simular({ xubio: xubioCon(() => json({})) })
const tok = { access_token: 't', token_type: 'Bearer' }
check('búsqueda de proveedor: CUIT vacío o incompleto no coincide con nadie', (await xubioLib.proveedorPorCuit(tok, '', 'Proveedor Nuevo SA')) === null && (await xubioLib.proveedorPorCuit(tok, '30-7155', 'Otro')) === null)
check('búsqueda de proveedor: nombre vacío tampoco', (await xubioLib.proveedorPorCuit(tok, '', '')) === null)
check('búsqueda de proveedor: con los 11 dígitos, por CUIT aunque el nombre difiera', (await xubioLib.proveedorPorCuit(tok, '30-71555555-1', 'Limpieza del Sur'))?.ID === 501)
check('búsqueda de proveedor: sin CUIT, por nombre exacto', (await xubioLib.proveedorPorCuit(tok, '', 'limpieza sur srl'))?.ID === 501)

// ---------------------------------------------------------------- Subida de una factura que se cuelga
process.env.XUBIO_FACTURAS_ENVIO_REAL = 'true'
const resultados: Fila[] = []
m = simular({
  sesiones: { guido: 'administracion@prueba.com' },
  tablas: {
    usuarios: [{ email: 'administracion@prueba.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true }],
    facturas: [{
      id: ID, empresa_id: 'beratung', estado: 'PARA_PAGAR', estado_xubio: 'PENDIENTE', tipo: 'Factura A', letra: 'A', punto_venta: 1, numero: 2604, fecha: '2026-10-10',
      vencimiento: '2026-11-09', cotizacion: 1, neto: 100000, iva: 21000, exento: 0, total: 121000, percepciones_json: [], codigo_producto: null, cuenta_contable: 'Gastos Generales',
      proveedores: { nombre: 'LIMPIEZA SUR SRL', cuit: '30715555551' }, empresas: { id: 'beratung', nombre: 'Beratung S.A.', erp: 'XUBIO' },
    }],
    xubio_log: [],
  },
  rpc: { usuario_ve_empresa: () => true, reservar_factura_xubio: () => true, resultado_factura_xubio: (a) => void resultados.push(a) },
  xubio: xubioCon(noResponde),
})
t = await cronometrar(() => subirFacturaXubio(pedido('guido', { facturaId: ID })))
check('factura: Xubio se cuelga en el envío y la función corta sola', t.resp.status === 200 && t.cuerpo.estado === 'ERROR' && /no respondió/.test(t.cuerpo.detalle) && t.ms < 3_000, `${t.ms} ms · ${JSON.stringify(t.cuerpo)}`)
check('…la factura queda reservada (no se sube dos veces) hasta que alguien la libere', resultados.length === 1 && resultados[0].p_estado === 'ERROR' && resultados[0].p_liberar === false)
check('…y el intento queda en el registro de Xubio', m.tablas.xubio_log.length === 1)
delete process.env.XUBIO_FACTURAS_ENVIO_REAL

// ---------------------------------------------------------------- La IA no responde
const fallos: Fila[] = []
const mundoIa = () =>
  simular({
    sesiones: { guido: 'administracion@prueba.com' },
    tablas: {
      usuarios: [{ email: 'administracion@prueba.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true }],
      empresas: [{ id: 'beratung', nombre: 'Beratung S.A.', cuit: '30710000014', erp: 'XUBIO', activa: true }],
    },
    rpc: {
      empresas_visibles_de: () => ['beratung'],
      registrar_documento: () => [{ id: 'doc-1', nuevo: true }],
      tomar_documento: () => [{ id: 'doc-1', origen: 'MANUAL', nombre_archivo: 'f.pdf', mime_type: 'application/pdf', storage_path: 'x/f.pdf', intentos: 1, empresas_permitidas: ['beratung'] }],
      documento_fallo: (a) => void fallos.push(a),
    },
    archivos: { 'facturas/x/f.pdf': new Uint8Array(0) },
    gemini: noResponde,
  })
const archivo = { nombre: 'f.pdf', mimeType: 'application/pdf', data: 'JVBERg==' }
mundoIa()
t = await cronometrar(() => leerComprobante(pedido('guido', archivo)))
check('la IA no responde al leer un comprobante: corta sola con un mensaje claro', t.resp.status === 504 && /La IA no respondió/.test(t.cuerpo.error) && t.ms < 2_000, `${t.resp.status} en ${t.ms} ms`)
m = mundoIa()
t = await cronometrar(() => subirFactura(pedido('guido', archivo)))
check('la IA no responde al subir una factura: el documento vuelve a la cola para reintentar', t.resp.status === 200 && t.cuerpo.estado === 'PENDIENTE' && fallos.length === 1
  && fallos[0].p_reintentar === true && /La IA no respondió/.test(String(fallos[0].p_error)) && t.ms < 2_000, `${t.ms} ms · ${JSON.stringify(t.cuerpo)}`)
m = mundoIa()
m.gemini = () => lecturaGemini({ IMPORTE: 10, FECHA: '2026-10-10', MEDIO: 'TRANSFERENCIA', CONFIANZA: 1 })
r = await leerComprobante(pedido('guido', archivo))
check('con la IA respondiendo a tiempo, la lectura sale igual que antes', r.status === 200 && (await r.json()).importe === 10)

cerrar()
