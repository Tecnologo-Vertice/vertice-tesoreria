// Tanda A1 · Las funciones del servidor que actúan en nombre de una persona respetan sus empresas.
// Corre las funciones enteras contra el simulador (sin Supabase, Xubio ni Gemini reales).
// Uso: npm run test:separacion
import { cerrar, check, json, lecturaGemini, pedido, simular, type Fila, type Mundo, type Pedido } from './simulador.mts'

process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: 'id-beratung', secret: 's' }, india: { clientId: 'id-india', secret: 's' } })

const subirFactura = (await import('../functions/subir-factura.mts')).default
const catalogos = (await import('../functions/xubio-catalogos.mts')).default
const leerAhora = (await import('../functions/leer-ahora.mts')).default
const leerComprobante = (await import('../functions/ia-leer-comprobante.mts')).default

// Quién ve qué. 'todas' ve las dos empresas; 'nadie' todavía no tiene ninguna asignada.
const VE: Record<string, string[]> = {
  'admin.india@prueba.com': ['india'],
  'aprob.india@prueba.com': ['india'],
  'todas@prueba.com': ['beratung', 'india'],
  'nadie@prueba.com': [],
}
function mundo(extra: Partial<Mundo> = {}): Mundo {
  return simular({
    sesiones: { india: 'admin.india@prueba.com', aprobIndia: 'aprob.india@prueba.com', todas: 'todas@prueba.com', nadie: 'nadie@prueba.com' },
    tablas: {
      usuarios: [
        { email: 'admin.india@prueba.com', nombre: 'Administración India', rol: 'ADMINISTRACION', activo: true, todas_empresas: false },
        { email: 'aprob.india@prueba.com', nombre: 'Aprobador India', rol: 'APROBADOR', activo: true, todas_empresas: false },
        { email: 'todas@prueba.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true },
        { email: 'nadie@prueba.com', nombre: 'Sin asignar', rol: 'ADMINISTRACION', activo: true, todas_empresas: false },
      ],
      empresas: [
        { id: 'beratung', nombre: 'Beratung S.A.', cuit: '30710000014', erp: 'XUBIO', activa: true },
        { id: 'india', nombre: 'INDIA ADV S.A.', cuit: '30710000022', erp: 'XUBIO', activa: true },
      ],
      documentos: [],
      facturas: [],
    },
    rpc: {
      empresas_visibles_de: (a) => VE[String(a.p_email)] ?? [],
      usuario_ve_empresa: (a) => (VE[String(a.p_email)] ?? []).includes(String(a.p_empresa)),
      registrar_documento: (a, m) => {
        const d = { id: `doc-${m.tablas.documentos.length + 1}`, estado: 'PENDIENTE', intentos: 0, ...(a.p as Fila) }
        m.tablas.documentos.push(d)
        return [{ id: d.id, nuevo: true }]
      },
      tomar_documento: (a, m) => {
        const d = m.tablas.documentos.find((x) => x.id === a.p_id)!
        Object.assign(d, { estado: 'LEYENDO', intentos: 1 })
        return [d]
      },
      documento_sin_factura: (a, m) => void Object.assign(m.tablas.documentos.find((x) => x.id === a.p_id)!, { estado: 'ERROR', error: a.p_motivo }),
      documento_fallo: (a, m) => void Object.assign(m.tablas.documentos.find((x) => x.id === a.p_id)!, { estado: 'ERROR', error: a.p_error }),
      guardar_factura_leida: (a, m) => {
        m.tablas.facturas.push({ id: 'fac-1', ...(a.p as Fila) })
        Object.assign(m.tablas.documentos.find((x) => x.id === a.p_doc)!, { estado: 'LEIDO', factura_id: 'fac-1' })
        return 'fac-1'
      },
      tomar_documentos: () => [],
      tomar_documentos_de_empresas: () => [],
      espejar_catalogos: () => ({}),
    },
    ...extra,
  })
}
const llamadas = (m: Mundo, parte: string) => m.pedidos.filter((p) => p.url.includes(parte))
const archivo = { nombre: 'factura.pdf', mimeType: 'application/pdf', data: 'JVBERg==' }
const lectura = (receptor: string, cuit: string) =>
  lecturaGemini({
    RECEPTOR: receptor, CUIT_RECEPTOR: cuit, PROVEEDOR: 'Laboratorio Ejemplo S.A.', CUIT_PROVEEDOR: '20-12345678-6', LETRA: 'A', TIPO: 'Factura A',
    NUMERO: '0001-00002604', CAE: '74123456789012', CAE_VENCIMIENTO: '2099-10-20', FECHA: '2026-10-10', VENCIMIENTODELPAGO: '2026-11-09', MONEDA: 'ARS',
    IMPORTE: 100000, IVA: 21000, NETO_NO_GRAVADO_EXENTO: 0, PERCEPCION_IVA: 0, PERCEPCIONES_IIBB: [], RETENCION: 0, TOTAL: 121000,
  })
const deBeratung = () => lectura('BERATUNG S.A.', '30-71000001-4')
const deIndia = () => lectura('INDIA ADV S.A.', '30-71000002-2')

// ---------------------------------------------------------------- Carga manual de facturas
let m = mundo()
let r = await subirFactura(pedido('india', { ...archivo, empresaId: 'beratung' }))
let cuerpo = await r.json()
check('India elige Beratung al subir una factura: rechazado', r.status === 403 && /acceso a la empresa beratung/.test(cuerpo.error), `${r.status} ${cuerpo.error}`)
check('…y no se guardó el archivo ni se encoló nada', llamadas(m, '/storage/').length === 0 && m.tablas.documentos.length === 0 && llamadas(m, 'googleapis').length === 0)

m = mundo({ gemini: deBeratung })
r = await subirFactura(pedido('india', archivo))
cuerpo = await r.json()
check('India sube (sin elegir) una factura que es de Beratung: no se carga', cuerpo.estado === 'ERROR' && /no tiene acceso a esa empresa/.test(cuerpo.detalle), JSON.stringify(cuerpo))
check('…la factura no se guardó en ninguna empresa', m.tablas.facturas.length === 0 && llamadas(m, 'guardar_factura_leida').length === 0)
check('…el documento quedó limitado a India, también para el lector programado', JSON.stringify(m.tablas.documentos[0]?.empresas_permitidas) === '["india"]')

m = mundo({ gemini: deIndia })
r = await subirFactura(pedido('india', archivo))
cuerpo = await r.json()
check('India sube una factura de India: se carga', cuerpo.estado === 'LEIDO' && m.tablas.facturas[0]?.empresa_id === 'india', JSON.stringify(cuerpo))

m = mundo({ gemini: deBeratung })
r = await subirFactura(pedido('todas', { ...archivo, empresaId: 'india' }))
cuerpo = await r.json()
check('quien ve todas elige India y la factura es de Beratung: no se carga', cuerpo.estado === 'ERROR' && m.tablas.facturas.length === 0, JSON.stringify(cuerpo))

m = mundo({ gemini: deBeratung })
r = await subirFactura(pedido('todas', archivo))
cuerpo = await r.json()
check('quien ve todas sube sin elegir: se carga en la empresa de la factura', cuerpo.estado === 'LEIDO' && m.tablas.facturas[0]?.empresa_id === 'beratung', JSON.stringify(cuerpo))
check('…y el documento lleva la lista de las empresas que ve', JSON.stringify(m.tablas.documentos[0]?.empresas_permitidas) === '["beratung","india"]')

m = mundo()
r = await subirFactura(pedido('nadie', archivo))
check('sin empresas asignadas no se puede subir nada', r.status === 403 && m.tablas.documentos.length === 0 && llamadas(m, '/storage/').length === 0)

// ---------------------------------------------------------------- Catálogos de Xubio a pedido
const deBasic = (auth: string) => Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':')[0]
const xubio = (p: Pedido) => {
  if (p.ruta.endsWith('/TokenEndpoint')) return json({ access_token: deBasic(p.auth), token_type: 'Bearer' })
  if (p.ruta.endsWith('/cuenta')) return json([{ ID: 1, codigo: 'CAJA', nombre: 'Caja' }])
  return json([])
}
// Con qué credencial se entró a Xubio (el simulador devuelve como token el identificador de la empresa).
const credenciales = (m: Mundo) => [...new Set(llamadas(m, 'xubio.com').map((p) => (p.ruta.endsWith('/TokenEndpoint') ? deBasic(p.auth) : p.auth.replace('Bearer ', ''))))].sort().join()
const guardado = (m: Mundo) => [...new Set(llamadas(m, 'espejar_catalogos').flatMap((p) => ((p.cuerpo as { p: { cuentas: Fila[] } }).p.cuentas ?? []).map((c) => c.empresa_id)))].sort().join()

m = mundo({ xubio })
r = await catalogos(pedido('india'))
check('Administración de India pide los catálogos: solo se entra al Xubio de India', r.status === 200 && credenciales(m) === 'id-india', credenciales(m))
check('…y solo se guardan cuentas de India', guardado(m) === 'india', guardado(m))
m = mundo({ xubio })
r = await catalogos(pedido('todas'))
check('quien ve todas trae los catálogos de las dos empresas', credenciales(m) === 'id-beratung,id-india' && guardado(m) === 'beratung,india', credenciales(m))
m = mundo({ xubio })
r = await catalogos(pedido('nadie'))
check('sin empresas asignadas no se entra a ningún Xubio', r.status === 403 && llamadas(m, 'xubio.com').length === 0)
m = mundo({ xubio })
r = await catalogos(pedido('aprobIndia'))
check('un aprobador no trae catálogos (rol)', r.status === 403 && llamadas(m, 'xubio.com').length === 0)

// ---------------------------------------------------------------- Leer la cola a pedido
const colaEntera = (m: Mundo) => m.pedidos.filter((p) => p.ruta.endsWith('/rpc/tomar_documentos')).length
m = mundo()
r = await leerAhora(pedido('india'))
const deEmpresas = llamadas(m, 'tomar_documentos_de_empresas')
check('India pide leer la cola: solo documentos subidos para India', r.status === 200 && deEmpresas.length === 1 && JSON.stringify((deEmpresas[0].cuerpo as Fila).p_empresas) === '["india"]')
check('…y no toma documentos del resto de la cola', colaEntera(m) === 0)
m = mundo()
r = await leerAhora(pedido('todas'))
check('quien ve todas lee toda la cola', r.status === 200 && colaEntera(m) === 1 && llamadas(m, 'tomar_documentos_de_empresas').length === 0)
m = mundo()
r = await leerAhora(pedido('nadie'))
check('sin empresas asignadas no lee nada', r.status === 403 && llamadas(m, 'tomar_documentos').length === 0)

// ---------------------------------------------------------------- Lectura de comprobantes de pago
m = mundo()
r = await leerComprobante(pedido('aprobIndia', archivo))
check('un rol que no carga pagos no gasta lecturas de IA', r.status === 403 && llamadas(m, 'googleapis').length === 0)
m = mundo({ gemini: () => lecturaGemini({ IMPORTE: 1500, FECHA: '2026-10-10', MEDIO: 'TRANSFERENCIA', CONFIANZA: 0.9, BANCO_ORIGEN: 'Galicia', BENEFICIARIO: 'Proveedor' }) })
r = await leerComprobante(pedido('india', archivo))
cuerpo = await r.json()
check('quien carga pagos sí lee el comprobante', r.status === 200 && cuerpo.importe === 1500, JSON.stringify(cuerpo))

r = await subirFactura(pedido('token-inventado', archivo))
check('sin sesión válida no se hace nada', r.status === 401)

cerrar()
