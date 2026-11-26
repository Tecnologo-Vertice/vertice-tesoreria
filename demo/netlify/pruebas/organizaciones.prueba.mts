// Grupo B · Las funciones del servidor con más de una organización cliente.
// Corre las funciones enteras contra el simulador (sin Supabase, Xubio ni Gemini reales).
//   · Lo que se hace en nombre de una persona queda dentro de su organización.
//   · Los puentes del Apps Script con INGESTA_TOKEN trabajan para la organización que da el servicio o, si
//     ninguna figura así, para la única que haya; con dos o más y ninguna que dé el servicio se detienen sin
//     copiar ni entregar nada. Los secretos por organización (grupo C) se prueban en secretos.prueba.mts.
// Uso: npm run test:organizaciones
import { cerrar, check, lecturaGemini, pedido, simular, type Fila, type Mundo } from './simulador.mts'

process.env.INGESTA_TOKEN = 'secreto-del-puente'
process.env.CASHFLOW_CHEQUES_DESDE = '2026-01-01'

const subirFactura = (await import('../functions/subir-factura.mts')).default
const leerAhora = (await import('../functions/leer-ahora.mts')).default
const leerComprobante = (await import('../functions/ia-leer-comprobante.mts')).default
const lectorProgramado = (await import('../functions/leer-documentos.mts')).default
const espejo = (await import('../functions/espejo.mts')).default
const ingestaAdjunto = (await import('../functions/ingesta-adjunto.mts')).default
const ingestaFactura = (await import('../functions/ingesta-factura.mts')).default
const ingestaConocidos = (await import('../functions/ingesta-conocidos.mts')).default
const cheques = (await import('../functions/cheques-cashflow.mts')).default
const flujo = (await import('../functions/flujo-datos.mts')).default

const A = 'org-a'
const B = 'org-b'
const DOS = [{ id: A, slug: 'a', estado: 'ACTIVA' }, { id: B, slug: 'b', estado: 'ACTIVA' }]
const SOLO_A = [{ id: A, slug: 'a', estado: 'ACTIVA' }]
const VE: Record<string, string[]> = { 'todas@a.com': ['a-uno', 'a-dos'], 'todas@b.com': ['b-uno'], 'uno@a.com': ['a-uno'] }

function mundo(organizaciones: Fila[], extra: Partial<Mundo> = {}): Mundo {
  return simular({
    sesiones: { deA: 'todas@a.com', deB: 'todas@b.com', unoA: 'uno@a.com', perdido: 'perdido@c.com' },
    tablas: {
      organizaciones,
      usuarios: [
        { email: 'todas@a.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true, organizacion_id: A },
        { email: 'uno@a.com', nombre: 'Tesorería de A Uno', rol: 'TESORERIA', activo: true, todas_empresas: false, organizacion_id: A },
        { email: 'todas@b.com', nombre: 'Administración de B', rol: 'ADMINISTRACION', activo: true, todas_empresas: true, organizacion_id: B },
        { email: 'perdido@c.com', nombre: 'Sin organización', rol: 'ADMINISTRACION', activo: true, todas_empresas: true, organizacion_id: 'org-que-no-existe' },
      ],
      empresas: [
        { id: 'a-uno', nombre: 'A Uno S.A.', cuit: '30710000014', erp: 'XUBIO', activa: true, organizacion_id: A, alias: ['a uno'] },
        { id: 'a-dos', nombre: 'A Dos S.A.', cuit: '30710000030', erp: 'NINGUNO', activa: true, organizacion_id: A },
        { id: 'b-uno', nombre: 'B Uno S.A.', cuit: '30710000022', erp: 'XUBIO', activa: true, organizacion_id: B },
      ],
      documentos: [],
      facturas: [],
      espejo_estado: [],
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
      ingresar_factura: () => 'fac-ingresada',
      espejar_facturas: () => ({ nuevas: 0, actualizadas: 0, sin_cambios: 0, omitidas: [] }),
      espejar_pagos: () => ({ nuevas: 0, actualizadas: 0, sin_cambios: 0, omitidas: [] }),
      espejar_catalogos: () => ({ cuentas: 0 }),
      cheques_para_cashflow: () => [],
      marcar_cheques_cashflow: () => 0,
      flujo_datos: () => ({ pagos: [], facturas: [] }),
    },
    ...extra,
  })
}
const llamadas = (m: Mundo, parte: string) => m.pedidos.filter((p) => p.url.includes(parte))
/** Lo que se le pidió a la base, sin contar la pregunta "¿cuántas organizaciones hay?". */
const tocoLaBase = (m: Mundo) => m.pedidos.filter((p) => p.url.includes('/rest/v1/') && !p.ruta.endsWith('/organizaciones')).length + llamadas(m, '/storage/').length
const archivo = { nombre: 'factura.pdf', mimeType: 'application/pdf', data: 'JVBERg==' }
const lectura = (receptor: string, cuit: string) => () =>
  lecturaGemini({
    RECEPTOR: receptor, CUIT_RECEPTOR: cuit, PROVEEDOR: 'Laboratorio Ejemplo S.A.', CUIT_PROVEEDOR: '20-12345678-6', LETRA: 'A', TIPO: 'Factura A',
    NUMERO: '0001-00002604', CAE: '74123456789012', CAE_VENCIMIENTO: '2099-10-20', FECHA: '2026-10-10', VENCIMIENTODELPAGO: '2026-11-09', MONEDA: 'ARS',
    IMPORTE: 100000, IVA: 21000, NETO_NO_GRAVADO_EXENTO: 0, PERCEPCION_IVA: 0, PERCEPCIONES_IIBB: [], RETENCION: 0, TOTAL: 121000,
  })
/** Un pedido como el que manda el Apps Script: con el secreto del puente. */
const puente = (ruta: string, cuerpo: unknown = {}) =>
  new Request(`http://sitio.prueba${ruta}`, { method: 'POST', headers: { 'x-ingesta-token': 'secreto-del-puente', 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })

// ---------------------------------------------------------------- En nombre de una persona
let m = mundo(DOS)
let r = await leerAhora(pedido('deA'))
let tomas = m.pedidos.filter((p) => p.ruta.endsWith('/rpc/tomar_documentos'))
check('quien ve todas las empresas de A pide leer la cola: solo la cola de A', r.status === 200 && tomas.length === 1 && (tomas[0].cuerpo as Fila).p_organizacion === A, JSON.stringify(tomas.map((p) => p.cuerpo)))
m = mundo(DOS)
r = await leerAhora(pedido('deB'))
tomas = m.pedidos.filter((p) => p.ruta.endsWith('/rpc/tomar_documentos'))
check('…y quien ve todas las de B, solo la de B', tomas.length === 1 && (tomas[0].cuerpo as Fila).p_organizacion === B)
m = mundo(DOS)
r = await leerAhora(pedido('unoA'))
check('quien ve una sola empresa sigue leyendo solo lo subido para ella', llamadas(m, 'tomar_documentos_de_empresas').length === 1 && m.pedidos.filter((p) => p.ruta.endsWith('/rpc/tomar_documentos')).length === 0)

m = mundo(DOS, { gemini: lectura('B UNO S.A.', '30-71000002-2') })
r = await subirFactura(pedido('deB', archivo))
let cuerpo = await r.json()
check('una factura subida por alguien de B queda como documento de B', cuerpo.estado === 'LEIDO' && m.tablas.documentos[0]?.organizacion_id === B, JSON.stringify(m.tablas.documentos[0]))
check('…limitado a las empresas de B', JSON.stringify(m.tablas.documentos[0]?.empresas_permitidas) === '["b-uno"]')
// Archivos: <organización>/<empresa elegida o sin-empresa>/año/mes/archivo (la regla de lectura de la base mira la primera carpeta).
const guardados = (m: Mundo) => Object.keys(m.archivos).join()
check('…y el archivo se guarda en la carpeta de B', new RegExp(`^facturas/${B}/sin-empresa/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}_factura[.]pdf$`).test(guardados(m)) && m.tablas.documentos[0]?.storage_path === guardados(m).replace('facturas/', ''), guardados(m))
m = mundo(DOS, { gemini: lectura('A UNO S.A.', '30-71000001-4') })
r = await subirFactura(pedido('deA', { ...archivo, empresaId: 'a-uno' }))
check('eligiendo la empresa, el archivo va a la carpeta de esa empresa dentro de su organización', guardados(m).startsWith(`facturas/${A}/a-uno/`), guardados(m))
m = mundo(DOS)
r = await subirFactura(pedido('deA', { ...archivo, empresaId: 'b-uno' }))
check('eligiendo una empresa de otra organización: rechazado, sin guardar nada', r.status === 403 && guardados(m) === '' && m.tablas.documentos.length === 0)

m = mundo([{ id: A, slug: 'a', estado: 'ACTIVA' }, { id: B, slug: 'b', estado: 'SUSPENDIDA' }])
r = await leerComprobante(pedido('deB', archivo))
cuerpo = await r.json()
check('organización suspendida: su gente no usa las funciones del servidor', r.status === 403 && /organización.*no está activa/.test(cuerpo.error) && llamadas(m, 'googleapis').length === 0, `${r.status} ${cuerpo.error}`)
r = await subirFactura(pedido('deB', archivo))
check('…ni sube archivos', r.status === 403 && llamadas(m, '/storage/').length === 0 && m.tablas.documentos.length === 0)
m = mundo([{ id: A, slug: 'a', estado: 'ACTIVA' }, { id: B, slug: 'b', estado: 'SUSPENDIDA' }], { gemini: () => lecturaGemini({ IMPORTE: 1500, FECHA: '2026-10-10', MEDIO: 'TRANSFERENCIA', CONFIANZA: 0.9 }) })
r = await leerComprobante(pedido('deA', archivo))
check('…y la otra organización sigue trabajando', r.status === 200)
m = mundo(DOS)
r = await leerComprobante(pedido('perdido', archivo))
check('una cuenta cuya organización no existe no entra', r.status === 403 && llamadas(m, 'googleapis').length === 0)

// ---------------------------------------------------------------- La IA recibe solo las empresas de la organización del documento
const pedidosIa = (m: Mundo) => llamadas(m, 'googleapis').map((p) => JSON.stringify(p.cuerpo))
m = mundo(DOS, { gemini: lectura('B UNO S.A.', '30-71000002-2') })
await subirFactura(pedido('deB', archivo))
check('documento de B: en el pedido a la IA van las empresas de B', pedidosIa(m).length === 1 && pedidosIa(m)[0].includes('30710000022 (B Uno S.A.)'))
check('…y ningún dato de las empresas de A', !pedidosIa(m)[0].includes('30710000014') && !pedidosIa(m)[0].includes('A Uno') && !pedidosIa(m)[0].includes('30710000030'))
m = mundo(DOS, { gemini: lectura('A UNO S.A.', '30-71000001-4') })
r = await subirFactura(pedido('deB', archivo))
cuerpo = await r.json()
check('documento de B cuya factura trae el CUIT de una empresa de A: no se asigna a A ni a nadie', cuerpo.estado === 'ERROR' && /No se reconoce la empresa receptora/.test(cuerpo.detalle) && m.tablas.facturas.length === 0 && llamadas(m, 'guardar_factura_leida').length === 0, JSON.stringify(cuerpo))
m = mundo(DOS, { gemini: lectura('A UNO S.A.', '') })
r = await subirFactura(pedido('deB', archivo))
cuerpo = await r.json()
check('…ni por el nombre (alias) de una empresa de A', cuerpo.estado === 'ERROR' && m.tablas.facturas.length === 0, JSON.stringify(cuerpo))
m = mundo(DOS, { gemini: lectura('A UNO S.A.', '') })
r = await subirFactura(pedido('deA', archivo))
cuerpo = await r.json()
check('el mismo archivo subido por alguien de A sí se carga en A, por el alias guardado en la empresa', cuerpo.estado === 'LEIDO' && m.tablas.facturas[0]?.empresa_id === 'a-uno', JSON.stringify(cuerpo))
// El lector programado toma documentos de las dos organizaciones: cada uno se lee con las empresas de la suya.
const cola: Fila[] = [
  { id: 'doc-a', origen: 'GMAIL', nombre_archivo: 'a.pdf', mime_type: 'application/pdf', storage_path: 'cola/a.pdf', intentos: 1, organizacion_id: A },
  { id: 'doc-b', origen: 'GMAIL', nombre_archivo: 'b.pdf', mime_type: 'application/pdf', storage_path: 'cola/b.pdf', intentos: 1, organizacion_id: B },
]
m = mundo(DOS, { gemini: lectura('B UNO S.A.', '30-71000002-2'), archivos: { 'facturas/cola/a.pdf': new Uint8Array(0), 'facturas/cola/b.pdf': new Uint8Array(0) } })
m.tablas.documentos.push(...cola.map((d) => ({ ...d })))
let turno = 0
m.rpc.tomar_documentos = () => (turno < cola.length ? [cola[turno++]] : [])
await lectorProgramado()
const [iaA, iaB] = pedidosIa(m)
check('lector programado: el documento de A se lee solo con las empresas de A', !!iaA && iaA.includes('30710000014 (A Uno S.A.)') && !iaA.includes('30710000022'))
check('…y el de B solo con las de B', !!iaB && iaB.includes('30710000022 (B Uno S.A.)') && !iaB.includes('30710000014'))
check('…la factura de una empresa de B que llegó en el documento de A no se carga; la del documento de B sí', m.tablas.facturas.length === 1 && m.tablas.facturas[0].empresa_id === 'b-uno'
  && m.tablas.documentos.find((d) => d.id === 'doc-a')?.estado === 'ERROR' && m.tablas.documentos.find((d) => d.id === 'doc-b')?.estado === 'LEIDO', JSON.stringify(m.tablas.documentos.map((d) => [d.id, d.estado])))
m = mundo(DOS, { gemini: lectura('B UNO S.A.', '30-71000002-2'), archivos: { 'facturas/cola/x.pdf': new Uint8Array(0) } })
m.tablas.documentos.push({ id: 'doc-x', estado: 'LEYENDO' })
turno = 0
m.rpc.tomar_documentos = () => (turno++ === 0 ? [{ id: 'doc-x', origen: 'GMAIL', nombre_archivo: 'x.pdf', mime_type: 'application/pdf', storage_path: 'cola/x.pdf', intentos: 1, organizacion_id: null }] : [])
await lectorProgramado()
check('un documento sin organización no se manda a la IA ni se carga', pedidosIa(m).length === 0 && m.tablas.facturas.length === 0 && m.tablas.documentos[0].estado === 'ERROR')

// ---------------------------------------------------------------- Puentes del Apps Script con dos organizaciones
const PUENTES: [string, (req: Request) => Promise<Response>, string, unknown][] = [
  ['la copia de la hoja (facturas)', espejo, '/api/espejo', { tipo: 'facturas', hoja: 'Facturas', filas: [] }],
  ['la copia de la hoja (catálogos)', espejo, '/api/espejo', { tipo: 'catalogos', catalogos: {} }],
  ['el cartero de adjuntos', ingestaAdjunto, '/api/ingesta/adjunto', { gmailMessageId: 'msg-1', ...archivo }],
  ['la ingesta de facturas leídas', ingestaFactura, '/api/ingesta/factura', { empresa_id: 'a-uno', cuit_proveedor: '20123456786', total: 100 }],
  ['la consulta de archivos conocidos', ingestaConocidos, '/api/ingesta/conocidos', { ids: ['msg-1'] }],
  ['los cheques para el Cash Flow', cheques, '/api/cheques/pendientes', {}],
  ['el resultado de los cheques', cheques, '/api/cheques/resultado', { resultados: [{ pago_id: 'x', estado: 'AGREGADO' }] }],
  ['los datos del flujo de caja', flujo, '/api/flujo/datos', {}],
]
for (const [nombre, fn, ruta, body] of PUENTES) {
  m = mundo(DOS)
  r = await fn(puente(ruta, body))
  cuerpo = await r.json()
  check(`con dos organizaciones, ${nombre} se detiene sin tocar nada`, r.status === 409 && /más de una organización/.test(cuerpo.error) && tocoLaBase(m) === 0, `${r.status} ${cuerpo.error ?? ''} · ${tocoLaBase(m)} pedidos`)
}
m = mundo(DOS)
r = await espejo(new Request('http://sitio.prueba/api/espejo', { method: 'POST', headers: { 'x-ingesta-token': 'otro' }, body: '{}' }))
check('con el secreto equivocado, ni siquiera se pregunta por las organizaciones', r.status === 401 && m.pedidos.length === 0)

// ---------------------------------------------------------------- Puentes con una sola organización: todo sigue andando, a su nombre
for (const [nombre, fn, ruta, body] of PUENTES) {
  m = mundo(SOLO_A)
  r = await fn(puente(ruta, body))
  check(`con una sola organización, ${nombre} sigue andando`, r.status === 200, `${r.status} ${JSON.stringify(await r.json()).slice(0, 120)}`)
}
m = mundo(SOLO_A)
await ingestaAdjunto(puente('/api/ingesta/adjunto', { gmailMessageId: 'msg-1', ...archivo }))
check('el adjunto del cartero queda como documento de la única organización', m.tablas.documentos[0]?.organizacion_id === A && llamadas(m, '/storage/').length === 1)
check('…y su archivo, en la carpeta de esa organización', Object.keys(m.archivos).join().startsWith(`facturas/${A}/sin-empresa/`) && String(m.tablas.documentos[0]?.storage_path).startsWith(`${A}/sin-empresa/`), Object.keys(m.archivos).join())
m = mundo(SOLO_A)
await espejo(puente('/api/espejo', { tipo: 'facturas', hoja: 'Facturas', filas: [] }))
check('el estado de la copia de la hoja se anota a nombre de la organización', m.tablas.espejo_estado.length === 1 && m.tablas.espejo_estado[0].organizacion_id === A && m.tablas.espejo_estado[0].hoja === 'Facturas')
// La copia de la hoja reconoce el RECEPTOR con los alias de las empresas de la organización del puente.
const filaHoja = (receptor: string, fila: number) => ({ _fila: fila, RECEPTOR: receptor, PROVEEDOR: 'LIMPIEZA SUR SRL', CUIT_PROVEEDOR: '30-71555555-1', TIPO: 'Factura A', NUMERO: `00007-0000035${fila}`, FECHA: '2026-10-20', TOTAL: 121000 })
m = mundo(SOLO_A)
r = await espejo(puente('/api/espejo', { tipo: 'facturas', hoja: 'Facturas', filas: [filaHoja('A UNO SA', 2), filaHoja('B UNO SA', 3), filaHoja('BERATUNG SA', 4)] }))
cuerpo = await r.json()
const copiadas = ((llamadas(m, 'espejar_facturas')[0]?.cuerpo as { p_filas: Fila[] })?.p_filas ?? []).map((f) => f.empresa_id).join()
check('copia de la hoja: la fila de una empresa de la organización se traduce con el alias de la base', copiadas === 'a-uno', copiadas)
check('…y las filas que dicen una empresa de otra organización, o un nombre que no es de nadie, se omiten', cuerpo.omitidas?.length === 2 && cuerpo.omitidas.every((o: { motivo: string }) => /Receptor no reconocido/.test(o.motivo)), JSON.stringify(cuerpo.omitidas))
m = mundo(SOLO_A)
r = await ingestaFactura(puente('/api/ingesta/factura', { empresa_id: 'b-uno', cuit_proveedor: '20123456786', total: 100 }))
check('la ingesta no acepta una factura para una empresa que no es de la organización del puente', r.status === 403 && llamadas(m, 'ingresar_factura').length === 0, String(r.status))
m = mundo(SOLO_A)
m.tablas.documentos.push({ id: 'd1', gmail_message_id: 'msg-1', organizacion_id: A }, { id: 'd2', gmail_message_id: 'msg-2', organizacion_id: 'otra' })
r = await ingestaConocidos(puente('/api/ingesta/conocidos', { ids: ['msg-1', 'msg-2', 'msg-3'] }))
cuerpo = await r.json()
check('archivos conocidos: solo los de la organización del puente', JSON.stringify(cuerpo.conocidos) === '["msg-1"]', JSON.stringify(cuerpo))

cerrar()
