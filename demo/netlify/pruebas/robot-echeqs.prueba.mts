// API del robot de e-cheqs (lib/robot-echeqs.ts) contra el simulador, sin Supabase ni PC reales: clave compartida (503 sin clave,
// 401 con clave mala, tiempo constante), acciones y forma de las respuestas, modo prueba forzado sin ROBOT_ECHEQS_ENVIO_REAL y
// corridas automáticas de las 13 y 17 h. La lógica de la base (pendientes, resultados, estados) la prueba probar_0039.mjs.
// Uso: node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/robot-echeqs.prueba.mts
import { check, cerrar, simular, ORG_PRUEBA, type Mundo } from './simulador.mts'

const lib = await import('../functions/lib/robot-echeqs.ts')
const { supabaseAdmin } = await import('../functions/lib/comun.ts')

const CLAVE = 'clave-larga-de-prueba-0123456789'
type Llamadas = Record<string, Record<string, unknown>[]>

function mundo(rpc: Mundo['rpc'] = {}): Mundo & { llamadas: Llamadas } {
  const llamadas: Llamadas = {}
  const anotar = (nombre: string, f: (a: Record<string, unknown>) => unknown): Mundo['rpc'][string] => (a) => {
    ;(llamadas[nombre] ??= []).push(a)
    return f(a)
  }
  const base: Mundo['rpc'] = {
    robot_organizacion: anotar('robot_organizacion', () => ORG_PRUEBA),
    robot_estado: anotar('robot_estado', () => ({ solicitada: true, fecha: '2026-11-27 13:00', por: 'teso@prueba.com', modo: 'real', tipo: 'ambos' })),
    robot_tomar_corrida: anotar('robot_tomar_corrida', () => ({ tomada: true, modo: 'prueba', tipo: 'ambos' })),
    robot_grupos_op: anotar('robot_grupos_op', () => ({ grupos: [{ empresa: 'INDIA ADV S.A.', cheque: '5001' }], bloqueados: [] })),
    robot_candidatos_debito: anotar('robot_candidatos_debito', () => ({ candidatos: [], bloqueados: [], ralpharmaOmitidos: 0, desde: '2026-10-13' })),
    robot_registrar_resultados: anotar('robot_registrar_resultados', () => ({ registrados: 1, repetidos: 0, sin_cheque: 0, recibidos: 1 })),
    robot_registrar_debitos: anotar('robot_registrar_debitos', () => ({ registrados: 1, repetidos: 0, sin_cheque: 0, recibidos: 1 })),
    robot_pedir_automatica: anotar('robot_pedir_automatica', () => ({ pedida: true, corrida_id: 'c1' })),
    tomar_bloqueo: () => true,
    soltar_bloqueo: () => null,
    ...rpc,
  }
  const m = simular({ rpc: base })
  return Object.assign(m, { llamadas })
}

const db = () => supabaseAdmin()
const opciones = { clave: CLAVE, envioReal: false }
const pedido = (accion: string, o: { metodo?: string; cuerpo?: unknown; token?: string | null; encabezado?: string; extra?: string } = {}) => {
  const url = `http://sitio.prueba/api/robot-echeqs?accion=${accion}${o.token === null || o.encabezado ? '' : `&token=${encodeURIComponent(o.token ?? CLAVE)}`}${o.extra ?? ''}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (o.encabezado) headers['x-robot-token'] = o.encabezado
  return new Request(url, { method: o.metodo ?? 'GET', headers, body: o.cuerpo === undefined ? undefined : typeof o.cuerpo === 'string' ? o.cuerpo : JSON.stringify(o.cuerpo) })
}
const llamar = async (req: Request, op = opciones) => {
  const r = await lib.atenderRobot(req, db, op)
  return { status: r.status, cuerpo: (await r.json()) as Record<string, unknown> }
}

// ================================================================ Clave
check('la comparación de la clave es exacta', lib.claveIgual(CLAVE, CLAVE) && !lib.claveIgual(CLAVE + 'x', CLAVE) && !lib.claveIgual('', CLAVE) && !lib.claveIgual(CLAVE, '') && !lib.claveIgual('corta', CLAVE))
check('claves de distinto largo no tiran error (se compara el resumen, en tiempo constante)', lib.claveIgual('a'.repeat(1000), CLAVE) === false)
let m = mundo()
let r = await llamar(pedido('estado'), { clave: undefined, envioReal: false })
check('sin ROBOT_ECHEQS_CLAVE configurada responde 503 y no toca la base', r.status === 503 && r.cuerpo.ok === false && /ROBOT_ECHEQS_CLAVE/.test(String(r.cuerpo.error)) && m.pedidos.length === 0)
r = await llamar(pedido('estado'), { clave: '', envioReal: false })
check('una clave configurada vacía también es 503 (nunca se acepta una clave vacía)', r.status === 503)
r = await llamar(pedido('estado', { token: 'otra-clave' }))
check('clave equivocada: 401, sin entregar nada y sin tocar la base', r.status === 401 && r.cuerpo.ok === false && m.pedidos.length === 0)
r = await llamar(pedido('estado', { token: null }))
check('sin clave: 401', r.status === 401 && m.pedidos.length === 0)
check('la respuesta de error no repite la clave recibida ni la esperada', !JSON.stringify(r.cuerpo).includes(CLAVE))
r = await llamar(pedido('estado', { token: 'otra-clave' }))
check('ni siquiera con clave mala se repite lo recibido', !JSON.stringify(r.cuerpo).includes('otra-clave'))
m = mundo()
r = await llamar(pedido('estado', { token: null, encabezado: CLAVE }))
check('la clave también se acepta en el encabezado x-robot-token', r.status === 200 && r.cuerpo.ok === true)
r = await llamar(new Request('http://sitio.prueba/api/robot-echeqs?accion=estado', { headers: { Authorization: `Bearer ${CLAVE}` } }))
check('... y como Bearer', r.status === 200)
r = await llamar(pedido('estado'))
check('... y como "token" en la dirección (como el robot de hoy)', r.status === 200)

// ================================================================ Acciones
m = mundo()
r = await llamar(pedido('estado'))
check('estado (sin el envío real en el servidor): un pedido en real se le entrega al robot como PRUEBA', r.cuerpo.ok === true && r.cuerpo.solicitada === true && r.cuerpo.modo === 'prueba' && r.cuerpo.tipo === 'ambos' && r.cuerpo.por === 'teso@prueba.com' && typeof r.cuerpo.fecha === 'string')
r = await llamar(pedido('estado'), { clave: CLAVE, envioReal: true })
check('estado (con ROBOT_ECHEQS_ENVIO_REAL encendida): se le entrega en real', r.cuerpo.modo === 'real')
check('modoEntregado: solo real con el envío autorizado', lib.modoEntregado('real', true) === 'real' && lib.modoEntregado('real', false) === 'prueba' && lib.modoEntregado('prueba', true) === 'prueba' && lib.modoEntregado('cualquiera', true) === 'prueba')
m = mundo()
r = await llamar(pedido('tomarCorrida'))
check('tomarCorrida: avisa a la base que se entregó como prueba si no hay envío real', r.cuerpo.ok === true && r.cuerpo.tomada === true && m.llamadas.robot_tomar_corrida[0].p_forzar_prueba === true && m.llamadas.robot_tomar_corrida[0].p_org === ORG_PRUEBA)
r = await llamar(pedido('tomarCorrida'), { clave: CLAVE, envioReal: true })
check('tomarCorrida con el envío real encendido no fuerza prueba', m.llamadas.robot_tomar_corrida[1].p_forzar_prueba === false)
r = await llamar(pedido('pendientes'))
check('pendientes: devuelve grupos y bloqueados, con ok', r.cuerpo.ok === true && Array.isArray(r.cuerpo.grupos) && Array.isArray(r.cuerpo.bloqueados) && m.llamadas.robot_grupos_op[0].p_empresas === null)
r = await llamar(pedido('debitos'))
check('debitos: por defecto 45 días; devuelve candidatos, bloqueados, ralpharmaOmitidos y desde', r.cuerpo.ok === true && Array.isArray(r.cuerpo.candidatos) && 'ralpharmaOmitidos' in r.cuerpo && 'desde' in r.cuerpo && m.llamadas.robot_candidatos_debito[0].p_dias === 45)
await llamar(pedido('debitos', { extra: '&dias=10' }))
await llamar(pedido('debitos', { extra: '&dias=100000' }))
await llamar(pedido('debitos', { extra: '&dias=abc' }))
check('debitos: los días se leen y se acotan (nunca más de un año)', m.llamadas.robot_candidatos_debito[1].p_dias === 10 && m.llamadas.robot_candidatos_debito[2].p_dias === 365 && m.llamadas.robot_candidatos_debito[3].p_dias === 45)
const cuerpoRes = { resultados: [{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5001', estado: 'SUBIDO', numeroOP: 'X-0001-00002478', filas: ['a'], ids: ['a'] }] }
r = await llamar(pedido('resultado', { metodo: 'POST', cuerpo: cuerpoRes }))
check('resultado: pasa el cuerpo tal cual a la base y devuelve los conteos', r.cuerpo.ok === true && r.cuerpo.registrados === 1 && JSON.stringify(m.llamadas.robot_registrar_resultados[0].p_cuerpo) === JSON.stringify(cuerpoRes))
check('resultado: con el envío real apagado le dice a la base que no permita "real" (la base lo registra como prueba)', m.llamadas.robot_registrar_resultados[0].p_permitir_real === false)
await llamar(pedido('resultado', { metodo: 'POST', cuerpo: cuerpoRes }), { clave: CLAVE, envioReal: true })
check('resultado: con el envío real encendido lo permite', m.llamadas.robot_registrar_resultados[1].p_permitir_real === true)
r = await llamar(pedido('resultado', { metodo: 'POST', cuerpo: { aviso: 'SESION_VENCIDA', detalle: 'x' } }))
check('resultado con aviso ({aviso, detalle}) también pasa a la base', r.cuerpo.ok === true && (m.llamadas.robot_registrar_resultados[2].p_cuerpo as { aviso: string }).aviso === 'SESION_VENCIDA')
r = await llamar(pedido('resultadoDebito', { metodo: 'POST', cuerpo: { resultados: [{ modo: 'real', estado: 'DEBITADO', cheque: '6001' }] } }))
check('resultadoDebito: va a la función de los débitos', r.cuerpo.ok === true && m.llamadas.robot_registrar_debitos.length === 1 && m.llamadas.robot_registrar_debitos[0].p_permitir_real === false && m.llamadas.robot_registrar_resultados.length === 3)

// ================================================================ Errores
r = await llamar(pedido('inventada'))
check('acción desconocida: 400 con ok false (como el Apps Script)', r.status === 400 && r.cuerpo.ok === false && /acción desconocida: inventada/.test(String(r.cuerpo.error)))
r = await llamar(pedido('resultado', { metodo: 'GET' }))
check('resultado por GET: 405', r.status === 405 && r.cuerpo.ok === false)
r = await llamar(pedido('estado', { metodo: 'DELETE' }))
check('un método raro: 405', r.status === 405)
r = await llamar(pedido('resultado', { metodo: 'POST', cuerpo: 'esto no es json' }))
check('cuerpo que no es JSON: 400', r.status === 400 && /JSON/.test(String(r.cuerpo.error)))
r = await llamar(pedido('resultado', { metodo: 'POST', cuerpo: [1, 2] }))
check('cuerpo que no es un objeto: 400', r.status === 400)
r = await llamar(pedido('resultado', { metodo: 'POST', cuerpo: { resultados: 'x' } }))
check('resultados que no es una lista: 400', r.status === 400)
r = await llamar(pedido('resultado', { metodo: 'POST', cuerpo: { resultados: Array.from({ length: 501 }, () => ({})) } }))
check('demasiados resultados juntos: 400 y no llega a la base', r.status === 400 && m.llamadas.robot_registrar_resultados.length === 3)
m = mundo({ robot_estado: () => { throw new Error('la base se cayó') } })
r = await llamar(pedido('estado'))
check('un error de la base: 500 con ok false, sin devolver el texto interno de la base', r.status === 500 && r.cuerpo.ok === false && !/la base se cayó/.test(JSON.stringify(r.cuerpo)))
m = mundo({ robot_organizacion: () => { throw new Error('Ninguna organización activa figura como la que da el servicio') } })
r = await llamar(pedido('pendientes'))
check('si no se sabe para qué organización trabaja el robot, no se entrega nada', r.status === 500 && r.cuerpo.ok === false && !('grupos' in r.cuerpo))

// ================================================================ Corridas automáticas
const utc = (h: number) => new Date(Date.UTC(2026, 10, 27, h, 0, 0))
check('las 16 UTC son las 13 h; las 20 UTC, las 17 h con reverificación', JSON.stringify(lib.corridaAutomatica(utc(16))) === JSON.stringify({ hora: '13:00', reverificar: false }) && JSON.stringify(lib.corridaAutomatica(utc(20))) === JSON.stringify({ hora: '17:00', reverificar: true }))
check('si Netlify se atrasa unos minutos sigue siendo la misma corrida', lib.corridaAutomatica(new Date(Date.UTC(2026, 10, 27, 16, 7))).hora === '13:00' && lib.corridaAutomatica(new Date(Date.UTC(2026, 10, 27, 20, 7))).hora === '17:00')
m = mundo()
let a = await lib.pedirCorridasAutomaticas(db(), ['org-a', 'org-b'], utc(16), false)
check('automática: una llamada por organización, en prueba si no hay envío real', a.length === 2 && a.every((x) => x.pedida) && m.llamadas.robot_pedir_automatica.length === 2 && m.llamadas.robot_pedir_automatica.every((c) => c.p_real === false && c.p_hora === '13:00' && c.p_reverificar === false))
m = mundo()
a = await lib.pedirCorridasAutomaticas(db(), ['org-a'], utc(20), true)
check('automática de las 17 con el envío real autorizado: real y con reverificación', m.llamadas.robot_pedir_automatica[0].p_real === true && m.llamadas.robot_pedir_automatica[0].p_hora === '17:00' && m.llamadas.robot_pedir_automatica[0].p_reverificar === true)
m = mundo({ robot_pedir_automatica: () => ({ pedida: false, motivo: 'hoy no es día hábil' }) })
a = await lib.pedirCorridasAutomaticas(db(), ['org-a'], utc(16), false)
check('un día no hábil o con pedido esperando: no pide y dice por qué', a[0].pedida === false && /día hábil/.test(String(a[0].motivo)))
m = mundo({ tomar_bloqueo: () => false })
a = await lib.pedirCorridasAutomaticas(db(), ['org-a'], utc(16), false)
check('con otro proceso en curso (bloqueo tomado) no pide nada', a[0].pedida === false && !m.llamadas.robot_pedir_automatica)

m = mundo({ robot_pedir_automatica: (a) => { if (a.p_org === 'org-a') throw new Error('falla de A'); return { pedida: true } } })
a = await lib.pedirCorridasAutomaticas(db(), ['org-a', 'org-b'], utc(16), false)
check('automática: si falla una organización, las demás igual se piden (errores aislados)', a.length === 2 && a[0].pedida === false && /error/.test(String(a[0].motivo)) && a[1].pedida === true)

check('ningún pedido salió del simulador (nada llegó a Xubio, bancos ni mails)', m.pedidos.every((p) => p.url.startsWith('http://supabase.prueba')))
cerrar()
