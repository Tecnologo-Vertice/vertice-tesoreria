// Tanda C1 · Credenciales de Xubio cifradas en la base (conexiones_erp), con la variable de siempre de respaldo.
// Corre las funciones enteras contra el simulador (sin Supabase ni Xubio reales).
//   · Con fila en la tabla se usa esa credencial; sin fila, la de XUBIO_CREDS_JSON.
//   · El alta exige la clave de cifrado, prueba la credencial contra Xubio y recién entonces guarda.
//   · Ni la credencial ni la clave aparecen en la base en claro, en las respuestas, en los mensajes de
//     error ni en lo que se escribe en el registro (console).
// Que una sesión de persona no pueda leer la tabla se prueba sobre la base real en memoria (test:sql).
// Uso: npm run test:credenciales
import { randomBytes } from 'node:crypto'
import { cerrar, check, json, pedido, simular, type Fila, type Mundo, type Pedido } from './simulador.mts'

// Todo lo que se escribe en el registro, para buscar secretos al final.
const registro: string[] = []
for (const nivel of ['log', 'error', 'warn', 'info'] as const) {
  const original = console[nivel].bind(console)
  console[nivel] = (...args: unknown[]) => {
    registro.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    original(...args)
  }
}

const CLAVE = randomBytes(32).toString('base64')
const CLAVE_NUEVA = randomBytes(32).toString('base64')
// Credenciales de mentira, con textos fáciles de buscar.
const ID_BASE = 'id-de-la-base-7Q3x'
const SECRETO_BASE = 'secreto-de-la-base-ZZ91'
const ID_VAR = 'id-de-la-variable'
const SECRETO_VAR = 'secreto-de-la-variable-KK22'
const SECRETO_MALO = 'secreto-que-xubio-rechaza-PP07'
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: ID_VAR, secret: SECRETO_VAR }, india: { clientId: 'id-india-var', secret: 'secreto-india-var' } })
delete process.env.CREDENCIALES_CLAVE
delete process.env.CREDENCIALES_CLAVE_ANTERIOR

const alta = (await import('../functions/xubio-credenciales.mts')).default
const catalogos = (await import('../functions/xubio-catalogos.mts')).default
const { credencialesDe } = await import('../functions/lib/xubio.ts')
const { cifrar, descifrar } = await import('../functions/lib/cifrado.ts')
const { supabaseAdmin } = await import('../functions/lib/comun.ts')

const VE: Record<string, string[]> = { 'admin@prueba.com': ['beratung', 'india', 'robles'], 'guido@prueba.com': ['beratung', 'india'], 'admin.india@prueba.com': ['india'] }
const deBasic = (auth: string) => Buffer.from(auth.replace('Basic ', ''), 'base64').toString()
/** Xubio de mentira: da token a cualquier credencial salvo SECRETO_MALO. El token es el identificador. */
const xubio = (p: Pedido) => {
  if (p.ruta.endsWith('/TokenEndpoint')) {
    const [id, secreto] = deBasic(p.auth).split(':')
    return secreto === SECRETO_MALO ? json({ error: 'invalid_client' }, 401) : json({ access_token: id, token_type: 'Bearer' })
  }
  if (p.ruta.endsWith('/cuenta')) return json([{ ID: 1, codigo: 'CAJA', nombre: 'Caja' }])
  return json([])
}
function mundo(extra: Partial<Mundo> = {}): Mundo {
  return simular({
    sesiones: { admin: 'admin@prueba.com', guido: 'guido@prueba.com', adminIndia: 'admin.india@prueba.com' },
    tablas: {
      usuarios: [
        { email: 'admin@prueba.com', nombre: 'Tecnología', rol: 'ADMIN', activo: true, todas_empresas: true },
        { email: 'guido@prueba.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true },
        { email: 'admin.india@prueba.com', nombre: 'Admin India', rol: 'ADMIN', activo: true, todas_empresas: false },
      ],
      empresas: [
        { id: 'beratung', nombre: 'Beratung S.A.', cuit: '30710000014', erp: 'XUBIO', activa: true },
        { id: 'india', nombre: 'INDIA ADV S.A.', cuit: '30710000022', erp: 'XUBIO', activa: true },
        { id: 'robles', nombre: 'Droguería Robles', cuit: '30710000030', erp: 'RALPHARMA', activa: true },
      ],
      conexiones_erp: [],
    },
    rpc: {
      empresas_visibles_de: (a) => VE[String(a.p_email)] ?? [],
      usuario_ve_empresa: (a) => (VE[String(a.p_email)] ?? ['beratung', 'india', 'robles']).includes(String(a.p_empresa)),
      espejar_catalogos: () => ({ cuentas: 1 }),
    },
    xubio,
    ...extra,
  })
}
const llamadas = (m: Mundo, parte: string) => m.pedidos.filter((p) => p.url.includes(parte))
const tokensPedidos = (m: Mundo) => llamadas(m, '/TokenEndpoint').map((p) => deBasic(p.auth))
const textoDe = (x: unknown) => JSON.stringify(x)
let m: Mundo
let r: Response
let cuerpo: { error?: string; pista?: string; ok?: boolean; log?: string[] }

// ---------------------------------------------------------------- Sin clave de cifrado: se rechaza el alta, el resto sigue igual
m = mundo()
r = await alta(pedido('admin', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_BASE }))
cuerpo = await r.json()
check('sin CREDENCIALES_CLAVE el alta se rechaza con un mensaje claro', r.status === 503 && /Falta configurar CREDENCIALES_CLAVE/.test(cuerpo.error ?? ''), `${r.status} ${cuerpo.error}`)
check('…sin llamar a Xubio ni guardar nada', llamadas(m, 'xubio.com').length === 0 && m.tablas.conexiones_erp.length === 0)
m = mundo()
r = await catalogos(pedido('guido'))
check('…y los catálogos siguen entrando con XUBIO_CREDS_JSON', r.status === 200 && tokensPedidos(m).sort().join() === `${ID_VAR}:${SECRETO_VAR},id-india-var:secreto-india-var`)

process.env.CREDENCIALES_CLAVE = CLAVE

// ---------------------------------------------------------------- Quién puede cargar
m = mundo()
r = await alta(pedido('guido', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_BASE }))
check('Administración (sin rol ADMIN) no carga credenciales', r.status === 403 && llamadas(m, 'xubio.com').length === 0 && m.tablas.conexiones_erp.length === 0)
m = mundo()
r = await alta(pedido('adminIndia', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_BASE }))
check('un ADMIN que no ve la empresa no le carga credenciales', r.status === 403 && llamadas(m, 'xubio.com').length === 0 && m.tablas.conexiones_erp.length === 0)
m = mundo()
r = await alta(pedido('admin', { empresaId: 'robles', clientId: ID_BASE, secret: SECRETO_BASE }))
check('una empresa que no usa Xubio no lleva credenciales de Xubio', r.status === 422 && llamadas(m, 'xubio.com').length === 0 && m.tablas.conexiones_erp.length === 0)
m = mundo()
r = await alta(pedido('admin', { empresaId: 'beratung', clientId: ID_BASE }))
check('sin secreto no se carga', r.status === 400 && m.tablas.conexiones_erp.length === 0)

// ---------------------------------------------------------------- Prueba la conexión antes de guardar
m = mundo()
r = await alta(pedido('admin', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_MALO }))
cuerpo = await r.json()
check('si Xubio rechaza la credencial, no se guarda nada', r.status === 422 && /Xubio no aceptó/.test(cuerpo.error ?? '') && m.tablas.conexiones_erp.length === 0, `${r.status} ${cuerpo.error}`)
check('…y el mensaje de error no incluye la credencial', !textoDe(cuerpo).includes(SECRETO_MALO) && !textoDe(cuerpo).includes(ID_BASE))

m = mundo()
r = await alta(pedido('admin', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_BASE }))
cuerpo = await r.json()
const fila = m.tablas.conexiones_erp[0] as Fila | undefined
check('con la credencial buena: se prueba contra Xubio y se guarda una fila', r.status === 200 && tokensPedidos(m).join() === `${ID_BASE}:${SECRETO_BASE}` && m.tablas.conexiones_erp.length === 1 && fila?.empresa_id === 'beratung' && fila?.erp === 'XUBIO', `${r.status} ${textoDe(cuerpo)}`)
check('…cifrada: en la fila no está ni el secreto ni el identificador', !!fila && !textoDe(fila).includes(SECRETO_BASE) && !textoDe(fila).includes(ID_BASE) && /^v1:[0-9a-f]{8}:/.test(String(fila.secreto_cifrado)), textoDe(fila))
check('…con la pista (últimos 4 del identificador) y quién la cargó', fila?.pista === '7Q3x' && fila?.cargado_por === 'admin@prueba.com' && !!fila?.verificado_en)
check('…y la respuesta devuelve solo la pista', cuerpo.pista === '7Q3x' && !textoDe(cuerpo).includes(SECRETO_BASE) && !textoDe(cuerpo).includes(String(fila?.secreto_cifrado)))
check('…la clave tampoco queda en la fila', !textoDe(fila).includes(CLAVE) && !textoDe(fila).includes(Buffer.from(CLAVE, 'base64').toString('hex')))

// ---------------------------------------------------------------- Con fila usa la de la base; sin fila, la variable
const filaGuardada = { ...fila! }
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada })
let c = await credencialesDe(supabaseAdmin(), 'beratung')
check('con fila en la tabla se usa esa credencial (no la de la variable)', c?.clientId === ID_BASE && c?.secret === SECRETO_BASE)
c = await credencialesDe(supabaseAdmin(), 'india')
check('sin fila se usa la de XUBIO_CREDS_JSON, como siempre', c?.clientId === 'id-india-var')
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada })
r = await catalogos(pedido('guido'))
check('de punta a punta (catálogos): Beratung entra con la de la base e India con la variable', r.status === 200 && tokensPedidos(m).sort().join() === `${ID_BASE}:${SECRETO_BASE},id-india-var:secreto-india-var`)
delete process.env.XUBIO_CREDS_JSON
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada })
check('sin la variable, la credencial de la base alcanza', (await credencialesDe(supabaseAdmin(), 'beratung'))?.secret === SECRETO_BASE && (await credencialesDe(supabaseAdmin(), 'india')) === null)
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: ID_VAR, secret: SECRETO_VAR }, india: { clientId: 'id-india-var', secret: 'secreto-india-var' } })

// ---------------------------------------------------------------- Lo que no se puede descifrar no se usa (ni cae a la variable)
const error = async (empresa: string) => {
  try {
    await credencialesDe(supabaseAdmin(), empresa)
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada, empresa_id: 'india' })
let msg = await error('india')
check('la fila de Beratung copiada a India no se descifra (queda atada a su empresa)', /no se pudieron descifrar/.test(msg), msg)
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada })
process.env.CREDENCIALES_CLAVE = CLAVE_NUEVA
msg = await error('beratung')
check('con otra clave configurada: error claro, sin usar la variable en silencio', /clave que no está configurada/.test(msg), msg)
r = await catalogos(pedido('guido'))
cuerpo = await r.json()
check('…y en los catálogos frena solo a esa empresa', r.status === 200 && (cuerpo.log ?? []).some((l) => /Beratung.*clave que no está configurada/.test(l)) && tokensPedidos(m).join() === 'id-india-var:secreto-india-var', String(r.status))
const alterada = String(filaGuardada.secreto_cifrado).replace(/:([A-Za-z0-9_-])([A-Za-z0-9_-]*)$/, (_x, a: string, b: string) => `:${a === 'A' ? 'B' : 'A'}${b}`)
process.env.CREDENCIALES_CLAVE = CLAVE
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada, secreto_cifrado: alterada })
msg = await error('beratung')
check('un dato alterado no se descifra', /no se pudieron descifrar/.test(msg), msg)
process.env.CREDENCIALES_CLAVE = 'corta'
msg = await error('beratung')
check('una clave mal escrita da un error claro, que no la repite', /tiene que ser una clave de 32 bytes/.test(msg) && !msg.includes('corta'), msg)

// ---------------------------------------------------------------- Cambio de clave
process.env.CREDENCIALES_CLAVE = CLAVE_NUEVA
process.env.CREDENCIALES_CLAVE_ANTERIOR = CLAVE
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada })
c = await credencialesDe(supabaseAdmin(), 'beratung')
const recifrada = String(m.tablas.conexiones_erp[0].secreto_cifrado)
check('cambio de clave: lo guardado con la anterior se sigue leyendo', c?.secret === SECRETO_BASE)
check('…y al usarlo se vuelve a cifrar con la nueva', recifrada !== filaGuardada.secreto_cifrado && recifrada.split(':')[1] !== String(filaGuardada.secreto_cifrado).split(':')[1])
delete process.env.CREDENCIALES_CLAVE_ANTERIOR
check('…así que después se puede sacar la anterior', (await credencialesDe(supabaseAdmin(), 'beratung'))?.secret === SECRETO_BASE)

// ---------------------------------------------------------------- Detalles del cifrado (revisión del agente 06)
process.env.CREDENCIALES_CLAVE = CLAVE
const una = cifrar('mismo texto', 'lugar')
const otra = cifrar('mismo texto', 'lugar')
check('cifrar dos veces lo mismo da datos distintos (iv al azar en cada uno)', una !== otra && una.split(':')[2] !== otra.split(':')[2]
  && descifrar(una, 'lugar', 'x').texto === 'mismo texto' && descifrar(otra, 'lugar', 'x').texto === 'mismo texto')
const [v, h, iv, etiqueta, datos] = una.split(':')
const recortada = [v, h, iv, Buffer.from(etiqueta, 'base64url').subarray(0, 4).toString('base64url'), datos].join(':')
msg = ''
try { descifrar(recortada, 'lugar', 'Dato de prueba') } catch (e) { msg = e instanceof Error ? e.message : String(e) }
check('una etiqueta recortada (4 bytes) no se acepta', /no se pudieron descifrar/.test(msg), msg)
// Solo la clave anterior configurada (la actual se borró por error): la credencial se usa igual y no se toca.
delete process.env.CREDENCIALES_CLAVE
process.env.CREDENCIALES_CLAVE_ANTERIOR = CLAVE
m = mundo()
m.tablas.conexiones_erp.push({ ...filaGuardada })
let soloAnterior: unknown = null
try { soloAnterior = await credencialesDe(supabaseAdmin(), 'beratung') } catch (e) { soloAnterior = e instanceof Error ? e.message : e }
check('con solo la clave anterior configurada, la credencial guardada se sigue usando', (soloAnterior as { secret?: string } | null)?.secret === SECRETO_BASE, typeof soloAnterior === 'string' ? soloAnterior : '')
check('…y queda como estaba (sin clave actual no se vuelve a cifrar)', m.tablas.conexiones_erp[0].secreto_cifrado === filaGuardada.secreto_cifrado)
delete process.env.CREDENCIALES_CLAVE_ANTERIOR
process.env.CREDENCIALES_CLAVE = CLAVE
// Si el error de conexión trajera la credencial en el texto, no llega a la respuesta ni al registro.
m = mundo({ xubio: () => { throw new Error(`conexión rechazada ${SECRETO_BASE} ${ID_BASE}`) } })
r = await alta(pedido('admin', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_BASE }))
cuerpo = await r.json()
check('alta sin conexión con Xubio: texto fijo, sin el mensaje del error', r.status === 422 && /No se pudo conectar con Xubio/.test(cuerpo.error ?? '') && !textoDe(cuerpo).includes(SECRETO_BASE) && !textoDe(cuerpo).includes(ID_BASE) && m.tablas.conexiones_erp.length === 0)
m = mundo()
r = await alta(pedido('admin', { empresaId: 'beratung', clientId: ID_BASE, secret: SECRETO_MALO }))
cuerpo = await r.json()
check('alta con la credencial rechazada: dice el código que dio Xubio', r.status === 422 && /código 401/.test(cuerpo.error ?? ''))

// ---------------------------------------------------------------- Ningún secreto en el registro
const todo = registro.join('\n')
const SECRETOS = [SECRETO_BASE, SECRETO_MALO, SECRETO_VAR, CLAVE, CLAVE_NUEVA, ID_BASE]
const fugas = SECRETOS.filter((s) => todo.includes(s))
check('en todo lo que se escribió en el registro no aparece ninguna credencial ni clave', fugas.length === 0, fugas.join())

cerrar()
