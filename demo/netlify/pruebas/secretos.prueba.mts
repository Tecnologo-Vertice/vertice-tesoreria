// Tanda C2 · Secretos por organización en los puentes del Apps Script y tareas programadas por organización.
// Corre las funciones enteras contra el simulador (sin Supabase, Xubio ni Gemini reales). Dos organizaciones:
// A da el servicio (como Vértice) y B es un cliente.
//   · INGESTA_TOKEN, el de siempre, sigue entrando y trabaja para A en las seis rutas, aunque haya dos.
//   · Cada secreto de B (tokens_integracion) entra solo para su tarea y solo carga y lee lo de B.
//   · Las tareas programadas recorren organización por organización.
//   · Ningún secreto aparece en el registro ni en las respuestas.
// Que una sesión de persona no lea los secretos se prueba sobre la base en memoria (test:sql).
// Uso: npm run test:secretos
import { createHash, randomBytes } from 'node:crypto'
import { cerrar, check, json, lecturaGemini, simular, type Fila, type Mundo, type Pedido } from './simulador.mts'

const registro: string[] = []
for (const nivel of ['log', 'error', 'warn', 'info'] as const) {
  const original = console[nivel].bind(console)
  console[nivel] = (...args: unknown[]) => {
    registro.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    original(...args)
  }
}

const INGESTA_TOKEN = 'ingesta-token-de-vertice-' + randomBytes(8).toString('hex')
process.env.INGESTA_TOKEN = INGESTA_TOKEN
process.env.CASHFLOW_CHEQUES_DESDE = '2026-01-01'
process.env.XUBIO_FACTURAS_ENVIO_REAL = 'true'
process.env.XUBIO_CREDS_JSON = JSON.stringify({ 'a-uno': { clientId: 'id-a', secret: 's-a' }, 'b-uno': { clientId: 'id-b', secret: 's-b' } })

const espejo = (await import('../functions/espejo.mts')).default
const ingestaAdjunto = (await import('../functions/ingesta-adjunto.mts')).default
const ingestaFactura = (await import('../functions/ingesta-factura.mts')).default
const ingestaConocidos = (await import('../functions/ingesta-conocidos.mts')).default
const cheques = (await import('../functions/cheques-cashflow.mts')).default
const flujo = (await import('../functions/flujo-datos.mts')).default
const subidor = (await import('../functions/xubio-subir-pendientes.mts')).default
const catalogosSemanal = (await import('../functions/xubio-catalogos-semanal.mts')).default
const lector = (await import('../functions/leer-documentos.mts')).default

const A = 'org-a'
const B = 'org-b'
const nuevoSecreto = () => 'vti_' + randomBytes(32).toString('hex')
const huella = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const DE_B = { INGESTA: nuevoSecreto(), COPIA_HOJA: nuevoSecreto(), CHEQUES: nuevoSecreto(), FLUJO: nuevoSecreto() }
const REVOCADO = nuevoSecreto()
const SIN_CARGAR = nuevoSecreto()

function mundo(extra: Partial<Mundo> = {}, estadoB = 'ACTIVA'): Mundo {
  return simular({
    tablas: {
      organizaciones: [{ id: A, slug: 'a', estado: 'ACTIVA', es_proveedor: true }, { id: B, slug: 'b', estado: estadoB, es_proveedor: false }],
      tokens_integracion: [
        ...Object.entries(DE_B).map(([tarea, s], i) => ({ id: `tok-${i}`, organizacion_id: B, tarea, nombre: tarea, huella: huella(s), activo: true })),
        { id: 'tok-revocado', organizacion_id: B, tarea: 'COPIA_HOJA', nombre: 'viejo', huella: huella(REVOCADO), activo: false },
      ],
      empresas: [
        { id: 'a-uno', nombre: 'A Uno S.A.', cuit: '30710000014', erp: 'XUBIO', activa: true, organizacion_id: A, alias: ['a uno'] },
        { id: 'b-uno', nombre: 'B Uno S.A.', cuit: '30710000022', erp: 'XUBIO', activa: true, organizacion_id: B, alias: ['b uno'] },
      ],
      documentos: [
        { id: 'd-a', gmail_message_id: 'msg-a', organizacion_id: A },
        { id: 'd-b', gmail_message_id: 'msg-b', organizacion_id: B },
      ],
      espejo_estado: [],
      conexiones_erp: [],
    },
    rpc: {
      registrar_documento: (a, m) => {
        const d = { id: `doc-${m.tablas.documentos.length + 1}`, estado: 'PENDIENTE', intentos: 0, ...(a.p as Fila) }
        m.tablas.documentos.push(d)
        return [{ id: d.id, nuevo: true }]
      },
      ingresar_factura: () => 'fac-ingresada',
      espejar_facturas: () => ({ nuevas: 0, actualizadas: 0, sin_cambios: 0, omitidas: [] }),
      espejar_pagos: () => ({ nuevas: 0, actualizadas: 0, sin_cambios: 0, omitidas: [] }),
      espejar_catalogos: () => ({ cuentas: 0 }),
      cheques_para_cashflow: (a) => [{ pago_id: `cheque-de-${a.p_organizacion}` }],
      marcar_cheques_cashflow: () => 1,
      flujo_datos: (a) => ({ pagos: [{ EMPRESA: `pago-de-${a.p_organizacion}` }], facturas: [] }),
      facturas_para_xubio: () => [],
      tomar_documentos: () => [],
    },
    ...extra,
  })
}
const puente = (ruta: string, secreto: string, cuerpo: unknown = {}) =>
  new Request(`http://sitio.prueba${ruta}`, { method: 'POST', headers: { 'x-ingesta-token': secreto, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })
const rpcs = (m: Mundo, fn: string) => m.pedidos.filter((p) => p.ruta.endsWith(`/rpc/${fn}`)).map((p) => p.cuerpo as Fila)
const respuestas: string[] = []
async function llamar(fn: (r: Request) => Promise<Response>, req: Request): Promise<{ status: number; cuerpo: Fila }> {
  const r = await fn(req)
  const texto = await r.text()
  respuestas.push(texto)
  return { status: r.status, cuerpo: JSON.parse(texto) as Fila }
}
const archivo = { nombre: 'factura.pdf', mimeType: 'application/pdf', data: 'JVBERg==' }
const filaHoja = (receptor: string, fila: number) => ({ _fila: fila, RECEPTOR: receptor, PROVEEDOR: 'LIMPIEZA SUR SRL', CUIT_PROVEEDOR: '30-71555555-1', TIPO: 'Factura A', NUMERO: `00007-0000035${fila}`, FECHA: '2026-10-20', TOTAL: 121000 })

type Caso = [string, (r: Request) => Promise<Response>, string, keyof typeof DE_B, unknown]
const SEIS: Caso[] = [
  ['la copia de la hoja', espejo, '/api/espejo', 'COPIA_HOJA', { tipo: 'facturas', hoja: 'Facturas', filas: [] }],
  ['el cartero de adjuntos', ingestaAdjunto, '/api/ingesta/adjunto', 'INGESTA', { gmailMessageId: 'msg-nuevo', ...archivo }],
  ['la ingesta de facturas leídas', ingestaFactura, '/api/ingesta/factura', 'INGESTA', { empresa_id: 'b-uno', cuit_proveedor: '20123456786', total: 100 }],
  ['la consulta de archivos conocidos', ingestaConocidos, '/api/ingesta/conocidos', 'INGESTA', { ids: ['msg-a', 'msg-b'] }],
  ['los cheques para el Cash Flow', cheques, '/api/cheques/pendientes', 'CHEQUES', {}],
  ['los datos del flujo de caja', flujo, '/api/flujo/datos', 'FLUJO', {}],
]
let m: Mundo
let r: { status: number; cuerpo: Fila }

// ---------------------------------------------------------------- INGESTA_TOKEN sigue sirviendo a la organización que da el servicio
for (const [nombre, fn, ruta, , body] of SEIS) {
  m = mundo()
  const cuerpo = ruta === '/api/ingesta/factura' ? { ...(body as Fila), empresa_id: 'a-uno' } : body
  r = await llamar(fn, puente(ruta, INGESTA_TOKEN, cuerpo))
  check(`con dos organizaciones, INGESTA_TOKEN sigue entrando a ${nombre} (para la que da el servicio)`, r.status === 200, `${r.status} ${String(r.cuerpo.error ?? '')}`)
}
m = mundo()
await llamar(espejo, puente('/api/espejo', INGESTA_TOKEN, { tipo: 'facturas', hoja: 'Facturas', filas: [filaHoja('A UNO SA', 2), filaHoja('B UNO SA', 3)] }))
check('la copia con INGESTA_TOKEN trabaja para A: traduce solo las filas de A y se lo dice a la base', rpcs(m, 'espejar_facturas')[0]?.p_organizacion === A
  && ((rpcs(m, 'espejar_facturas')[0]?.p_filas as Fila[]) ?? []).map((f) => f.empresa_id).join() === 'a-uno' && m.tablas.espejo_estado[0]?.organizacion_id === A)
m = mundo()
r = await llamar(flujo, puente('/api/flujo/datos', INGESTA_TOKEN))
check('el flujo con INGESTA_TOKEN entrega lo de A', rpcs(m, 'flujo_datos')[0]?.p_organizacion === A && JSON.stringify(r.cuerpo.pagos) === JSON.stringify([{ EMPRESA: `pago-de-${A}` }]))
m = mundo()
r = await llamar(ingestaConocidos, puente('/api/ingesta/conocidos', INGESTA_TOKEN, { ids: ['msg-a', 'msg-b'] }))
check('los archivos conocidos con INGESTA_TOKEN son solo los de A', JSON.stringify(r.cuerpo.conocidos) === '["msg-a"]', JSON.stringify(r.cuerpo))
m = mundo()
r = await llamar(ingestaFactura, puente('/api/ingesta/factura', INGESTA_TOKEN, { empresa_id: 'b-uno', cuit_proveedor: '20123456786', total: 100 }))
check('INGESTA_TOKEN no carga una factura en una empresa de B', r.status === 403 && rpcs(m, 'ingresar_factura').length === 0)
m = mundo()
m.tablas.organizaciones = [{ id: A, slug: 'a', estado: 'ACTIVA', es_proveedor: false }, { id: B, slug: 'b', estado: 'ACTIVA', es_proveedor: false }]
r = await llamar(flujo, puente('/api/flujo/datos', INGESTA_TOKEN))
check('si ninguna figura como la que da el servicio y hay dos, INGESTA_TOKEN se detiene como antes (409)', r.status === 409 && rpcs(m, 'flujo_datos').length === 0)
m = mundo()
m.tablas.organizaciones[0].estado = 'SUSPENDIDA'
r = await llamar(flujo, puente('/api/flujo/datos', INGESTA_TOKEN))
check('con la organización que da el servicio suspendida, INGESTA_TOKEN no entrega nada', r.status === 403 && rpcs(m, 'flujo_datos').length === 0)

// ---------------------------------------------------------------- El secreto de B: su organización y su tarea
for (const [nombre, fn, ruta, tarea, body] of SEIS) {
  m = mundo()
  r = await llamar(fn, puente(ruta, DE_B[tarea], body))
  check(`el secreto ${tarea} de B entra a ${nombre}`, r.status === 200, `${r.status} ${String(r.cuerpo.error ?? '')}`)
  check('…y anota cuándo se usó', !!m.tablas.tokens_integracion.find((t) => t.tarea === tarea && t.organizacion_id === B && t.activo)?.ultimo_uso)
}
m = mundo()
await llamar(espejo, puente('/api/espejo', DE_B.COPIA_HOJA, { tipo: 'facturas', hoja: 'Facturas', filas: [filaHoja('A UNO SA', 2), filaHoja('B UNO SA', 3)] }))
check('la copia con el secreto de B: solo las filas de B, y la base recibe la organización B', rpcs(m, 'espejar_facturas')[0]?.p_organizacion === B
  && ((rpcs(m, 'espejar_facturas')[0]?.p_filas as Fila[]) ?? []).map((f) => f.empresa_id).join() === 'b-uno' && m.tablas.espejo_estado[0]?.organizacion_id === B)
m = mundo()
await llamar(espejo, puente('/api/espejo', DE_B.COPIA_HOJA, { tipo: 'catalogos', catalogos: { emails: [{ CUIT_PROVEEDOR: '30715555551', PROVEEDOR: 'X', EMAIL: 'x@x.com' }] } }))
check('los catálogos con el secreto de B van a nombre de B', rpcs(m, 'espejar_catalogos')[0]?.p_organizacion === B)
m = mundo()
r = await llamar(ingestaAdjunto, puente('/api/ingesta/adjunto', DE_B.INGESTA, { gmailMessageId: 'msg-nuevo', ...archivo }))
check('el cartero de B deja el adjunto como documento de B, en la carpeta de B', m.tablas.documentos.at(-1)?.organizacion_id === B && Object.keys(m.archivos).join().startsWith(`facturas/${B}/`))
m = mundo()
r = await llamar(ingestaAdjunto, puente('/api/ingesta/adjunto', DE_B.INGESTA, { gmailMessageId: 'msg-a', nombre: 'factura.pdf', mimeType: 'application/pdf', data: 'JVBERg==' }))
check('…un adjunto que A ya tiene no cuenta como "ya llegó" para B', r.cuerpo.nuevo === true && m.tablas.documentos.at(-1)?.organizacion_id === B)
m = mundo()
r = await llamar(ingestaConocidos, puente('/api/ingesta/conocidos', DE_B.INGESTA, { ids: ['msg-a', 'msg-b'] }))
check('archivos conocidos con el secreto de B: solo los de B', JSON.stringify(r.cuerpo.conocidos) === '["msg-b"]', JSON.stringify(r.cuerpo))
m = mundo()
r = await llamar(ingestaFactura, puente('/api/ingesta/factura', DE_B.INGESTA, { empresa_id: 'a-uno', cuit_proveedor: '20123456786', total: 100 }))
check('el secreto de B no carga una factura en una empresa de A', r.status === 403 && rpcs(m, 'ingresar_factura').length === 0)
m = mundo()
r = await llamar(cheques, puente('/api/cheques/pendientes', DE_B.CHEQUES))
check('cheques con el secreto de B: la base recibe B y se entregan los de B', rpcs(m, 'cheques_para_cashflow')[0]?.p_organizacion === B && JSON.stringify(r.cuerpo.cheques) === JSON.stringify([{ pago_id: `cheque-de-${B}` }]))
m = mundo()
await llamar(cheques, puente('/api/cheques/resultado', DE_B.CHEQUES, { resultados: [{ pago_id: 'x', estado: 'AGREGADO' }] }))
check('…y al marcar, también B', rpcs(m, 'marcar_cheques_cashflow')[0]?.p_organizacion === B)
m = mundo()
r = await llamar(flujo, puente('/api/flujo/datos', DE_B.FLUJO))
check('el flujo con el secreto de B entrega lo de B', rpcs(m, 'flujo_datos')[0]?.p_organizacion === B && JSON.stringify(r.cuerpo.pagos) === JSON.stringify([{ EMPRESA: `pago-de-${B}` }]))

// Cada secreto sirve para una sola tarea.
m = mundo()
r = await llamar(flujo, puente('/api/flujo/datos', DE_B.COPIA_HOJA))
check('el secreto de la copia de la hoja de B no sirve para el flujo', r.status === 403 && rpcs(m, 'flujo_datos').length === 0)
m = mundo()
r = await llamar(espejo, puente('/api/espejo', DE_B.INGESTA, { tipo: 'facturas', hoja: 'Facturas', filas: [] }))
check('…ni el del cartero para la copia de la hoja', r.status === 403 && rpcs(m, 'espejar_facturas').length === 0)
// Revocado, inventado, o de una organización suspendida.
m = mundo()
r = await llamar(espejo, puente('/api/espejo', REVOCADO, { tipo: 'facturas', hoja: 'Facturas', filas: [] }))
check('un secreto revocado (activo = false) no entra', r.status === 401 && rpcs(m, 'espejar_facturas').length === 0)
m = mundo()
r = await llamar(espejo, puente('/api/espejo', SIN_CARGAR, { tipo: 'facturas', hoja: 'Facturas', filas: [] }))
check('un secreto con el formato correcto pero que no existe no entra', r.status === 401 && rpcs(m, 'espejar_facturas').length === 0)
m = mundo()
r = await llamar(espejo, puente('/api/espejo', 'cualquier-cosa', { tipo: 'facturas', hoja: 'Facturas', filas: [] }))
check('algo que no tiene la forma de un secreto ni siquiera se busca en la base', r.status === 401 && m.pedidos.length === 0)
m = mundo({}, 'SUSPENDIDA')
r = await llamar(flujo, puente('/api/flujo/datos', DE_B.FLUJO))
check('con B suspendida, su secreto no entrega nada', r.status === 403 && rpcs(m, 'flujo_datos').length === 0)
m = mundo({}, 'SUSPENDIDA')
r = await llamar(flujo, puente('/api/flujo/datos', INGESTA_TOKEN))
check('…y A sigue trabajando con INGESTA_TOKEN', r.status === 200)

// ---------------------------------------------------------------- Tareas programadas: organización por organización
m = mundo()
await subidor()
let llamadas = rpcs(m, 'facturas_para_xubio')
check('el subidor a Xubio pide las facturas de cada organización por separado', llamadas.length === 2 && llamadas.map((x) => x.p_organizacion).sort().join() === `${A},${B}` && llamadas.every((x) => x.p_max === 5), JSON.stringify(llamadas))
m = mundo({}, 'SUSPENDIDA')
await subidor()
check('…y no sube las de una organización suspendida', rpcs(m, 'facturas_para_xubio').map((x) => x.p_organizacion).join() === A)
m = mundo()
let falloLaDeA = false
m.rpc.facturas_para_xubio = (a) => {
  if (a.p_organizacion === A) { falloLaDeA = true; throw new Error('falla de A') }
  return []
}
await subidor()
check('…si la consulta de una falla, sigue con la otra', falloLaDeA && rpcs(m, 'facturas_para_xubio').length === 2)

const xubio = (p: Pedido) => {
  if (p.ruta.endsWith('/TokenEndpoint')) return json({ access_token: Buffer.from(p.auth.replace('Basic ', ''), 'base64').toString().split(':')[0], token_type: 'Bearer' })
  if (p.ruta.endsWith('/cuenta')) return json([{ ID: 1, codigo: 'CAJA', nombre: 'Caja' }])
  return json([])
}
m = mundo({ xubio })
await catalogosSemanal()
const porOrg = rpcs(m, 'espejar_catalogos').map((x) => `${x.p_organizacion}:${((x.p as { cuentas: Fila[] }).cuentas ?? []).map((c) => c.empresa_id).join()}`)
check('los catálogos semanales: una copia por organización, cada una solo con sus empresas', porOrg.sort().join() === `${A}:a-uno,${B}:b-uno`, porOrg.join())
m = mundo({ xubio })
m.rpc.espejar_catalogos = (a) => {
  if (a.p_organizacion === A) throw new Error('falla de A')
  return { cuentas: 1 }
}
await catalogosSemanal()
check('…si la de una falla, la otra se copia igual', rpcs(m, 'espejar_catalogos').length === 2)

const cola: Record<string, Fila[]> = {
  [A]: [1, 2, 3].map((n) => ({ id: `a${n}`, origen: 'GMAIL', nombre_archivo: `a${n}.pdf`, mime_type: 'application/pdf', storage_path: `cola/a${n}.pdf`, intentos: 1, organizacion_id: A })),
  [B]: [{ id: 'b1', origen: 'GMAIL', nombre_archivo: 'b1.pdf', mime_type: 'application/pdf', storage_path: 'cola/b1.pdf', intentos: 1, organizacion_id: B }],
}
m = mundo({
  gemini: () => lecturaGemini({ RECEPTOR: 'Nadie', CUIT_RECEPTOR: '', TOTAL: 1 }),
  archivos: Object.fromEntries(['a1', 'a2', 'a3', 'b1'].map((x) => [`facturas/cola/${x}.pdf`, new Uint8Array(0)])),
})
m.tablas.documentos = Object.values(cola).flat().map((d) => ({ ...d }))
m.rpc.tomar_documentos = (a) => (cola[String(a.p_organizacion)] ?? []).splice(0, Number(a.p_max) || 1)
m.rpc.documento_sin_factura = () => null
m.rpc.documento_fallo = () => null
await lector()
const orden = rpcs(m, 'tomar_documentos').map((x) => (x.p_organizacion === A ? 'A' : x.p_organizacion === B ? 'B' : '?'))
check('el lector programado toma por turnos de cada organización (B no espera a que A vacíe su cola)', orden.slice(0, 2).sort().join() === 'A,B' && orden.filter((x) => x === 'B').length >= 1 && !orden.includes('?'), orden.join())
check('…y lee todo lo que había', m.pedidos.filter((p) => p.url.includes('googleapis')).length === 4)

// ---------------------------------------------------------------- Ningún secreto en el registro ni en las respuestas
const todo = [...registro, ...respuestas].join('\n')
const fugas = [INGESTA_TOKEN, ...Object.values(DE_B), REVOCADO, SIN_CARGAR].filter((s) => todo.includes(s) || todo.includes(s.slice(4)))
check('en lo que se escribió en el registro y en las respuestas no aparece ningún secreto', fugas.length === 0, `${fugas.length} encontrados`)
check('…tampoco en lo que se guardó en la base de prueba (solo el resumen)', ![INGESTA_TOKEN, ...Object.values(DE_B)].some((s) => JSON.stringify(m.tablas).includes(s)))

cerrar()
