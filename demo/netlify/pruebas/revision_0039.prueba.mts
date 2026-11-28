// Revisión independiente de la API del robot de e-cheqs (agente 06, 27/11/2026): lib/robot-echeqs.ts y la función programada.
// "BUG" = comportamiento que no cumple lo pedido o rompe algo; "OK" = control; "INFO" = dato. Datos ficticios, todo con el simulador.
// Uso (desde demo/): node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/revision_0039.prueba.mts
import { simular, ORG_PRUEBA, type Mundo } from './simulador.mts'

const lib = await import('../functions/lib/robot-echeqs.ts')
const { supabaseAdmin } = await import('../functions/lib/comun.ts')

let ok = 0, bug = 0
const check = (nombre: string, cond: boolean, extra = '') => { if (cond) ok++; else bug++; console.log(`${cond ? 'OK ' : 'BUG'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const info = (nombre: string, dato: unknown) => console.log(`INFO ${nombre} · ${typeof dato === 'string' ? dato : JSON.stringify(dato)}`)

const CLAVE = 'clave-larga-de-prueba-0123456789'
type Llamadas = Record<string, Record<string, unknown>[]>
function mundo(rpc: Mundo['rpc'] = {}): Mundo & { llamadas: Llamadas } {
  const llamadas: Llamadas = {}
  const anotar = (nombre: string, f: (a: Record<string, unknown>) => unknown): Mundo['rpc'][string] => (a) => { ;(llamadas[nombre] ??= []).push(a); return f(a) }
  const base: Mundo['rpc'] = {
    robot_organizacion: anotar('robot_organizacion', () => ORG_PRUEBA),
    robot_estado: anotar('robot_estado', () => ({ solicitada: false, fecha: '', por: '', modo: 'prueba', tipo: 'op' })),
    robot_tomar_corrida: anotar('robot_tomar_corrida', () => ({ tomada: false })),
    robot_grupos_op: anotar('robot_grupos_op', () => ({ grupos: [{ empresa: 'INDIA ADV S.A.', cheque: '5001' }], bloqueados: [] })),
    robot_candidatos_debito: anotar('robot_candidatos_debito', () => ({ candidatos: [{ cheque: '7001' }], bloqueados: [], ralpharmaOmitidos: 0, desde: '2026-10-13' })),
    robot_registrar_resultados: anotar('robot_registrar_resultados', () => ({ registrados: 1 })),
    robot_registrar_debitos: anotar('robot_registrar_debitos', () => ({ registrados: 1 })),
    robot_pedir_automatica: anotar('robot_pedir_automatica', () => ({ pedida: true })),
    tomar_bloqueo: () => true,
    soltar_bloqueo: () => null,
    ...rpc,
  }
  return Object.assign(simular({ rpc: base }), { llamadas })
}
const db = () => supabaseAdmin()
const llamar = async (req: Request, envioReal = false) => {
  const r = await lib.atenderRobot(req, db, { clave: CLAVE, envioReal })
  return { status: r.status, cuerpo: (await r.json()) as Record<string, unknown> }
}
const url = (accion: string, extra = '') => `http://sitio.prueba/api/robot-echeqs?accion=${accion}&token=${CLAVE}${extra}`

// ---------------------------------------------------------------- 1. ENVIO_REAL apagado y resultados "real"
let m = mundo()
// El robot de hoy (robot.js:203) con --modo real, o corriendo con --forzar y config.json en real, manda modo "real" aunque el servidor haya entregado prueba.
const cuerpo = { resultados: [{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5001', estado: 'SUBIDO', numeroOP: 'X-0001-00001234', filas: ['a'] }] }
await llamar(new Request(url('resultado'), { method: 'POST', body: JSON.stringify(cuerpo) }), false)
// Decisión del coordinador: el interruptor frena en la base. La función no toca el modo que declara el robot; le dice a la base si el servidor permite
// "real" (p_permitir_real) y la base registra como prueba todo lo "real" que no esté permitido (probado en revision_0039.mjs [F] y probar_0039.mjs [8a]).
const permitio = m.llamadas.robot_registrar_resultados?.[0]?.p_permitir_real
check('[F] con ROBOT_ECHEQS_ENVIO_REAL apagado, la base recibe p_permitir_real=false y registra como prueba lo que el robot declara "real"', permitio === false, `p_permitir_real=${permitio}`)
m = mundo()
await llamar(new Request(url('resultadoDebito'), { method: 'POST', body: JSON.stringify({ resultados: [{ modo: 'real', estado: 'DEBITADO' }] }) }), false)
check('[F] ... y en los débitos', m.llamadas.robot_registrar_debitos?.[0]?.p_permitir_real === false)
// pendientes sin ninguna corrida pedida y con el envío apagado: se entregan igual (el menú del robot y --forzar los necesitan para probar); lo que el robot haga en real se registra como prueba.
m = mundo()
const pend = await llamar(new Request(url('pendientes')), false)
check('[F] con el envío apagado, pendientes se entrega igual (solo lectura); lo que el robot declare real se registra como prueba', Array.isArray(pend.cuerpo.grupos))

// ---------------------------------------------------------------- 2. Seguridad de la clave
m = mundo()
for (const accion of ['estado', 'tomarCorrida', 'pendientes', 'debitos', 'resultado', 'resultadoDebito']) {
  const r = await lib.atenderRobot(new Request(`http://sitio.prueba/api/robot-echeqs?accion=${accion}&token=mala`, { method: ['resultado', 'resultadoDebito'].includes(accion) ? 'POST' : 'GET', body: ['resultado', 'resultadoDebito'].includes(accion) ? '{}' : undefined }), db, { clave: CLAVE, envioReal: true })
  check(`[S] ${accion} con clave mala: 401 y la base no se toca`, r.status === 401 && m.pedidos.length === 0)
}
const rEnc = await lib.atenderRobot(new Request(`http://sitio.prueba/api/robot-echeqs?accion=estado&token=${CLAVE}`, { headers: { 'x-robot-token': 'mala' } }), db, { clave: CLAVE, envioReal: false })
check('[S] si llega un encabezado malo y una clave buena en la dirección, manda el encabezado (401)', rEnc.status === 401)
const sinClave = await lib.atenderRobot(new Request(url('estado')), db, { clave: undefined, envioReal: true })
check('[S] sin clave configurada: 503, aunque el token de la dirección sea cualquiera', sinClave.status === 503)
check('[S] claveIgual: largo distinto y Unicode no tiran error', lib.claveIgual('á'.repeat(5000), CLAVE) === false && lib.claveIgual('ñ', 'ñ') === true)

// ---------------------------------------------------------------- 3. Forma de lo que lee el robot
m = mundo({ robot_estado: () => ({ solicitada: true, fecha: '2026-11-27 13:00', por: 'x', modo: 'real', tipo: 'debito' }) })
const est = await llamar(new Request(url('estado')), false)
check('[A] estado: solicitada, fecha, por, modo y tipo con ok:true (lo que lee robot.js)', est.cuerpo.ok === true && est.cuerpo.solicitada === true && est.cuerpo.tipo === 'debito' && est.cuerpo.modo === 'prueba' && est.cuerpo.por === 'x')
m = mundo()
const dias = await llamar(new Request(url('debitos', '&dias=0')))
check('[A] debitos&dias=0 cae en 45 como el Apps Script (Number(p.dias) || 45)', m.llamadas.robot_candidatos_debito[0].p_dias === 45 && dias.cuerpo.ok === true)
await llamar(new Request(url('debitos', '&dias=-7')))
info('debitos&dias=-7 → p_dias', m.llamadas.robot_candidatos_debito[1].p_dias)
// robot.js manda el resultado con Content-Type text/plain
m = mundo()
const tp = await llamar(new Request(url('resultado'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ aviso: 'SESION_VENCIDA', detalle: 'x' }) }))
check('[A] POST con Content-Type text/plain (como lo manda robot.js) se lee como JSON', tp.status === 200 && tp.cuerpo.ok === true)

// ---------------------------------------------------------------- 4. Errores de la base hacia el robot
m = mundo({ robot_registrar_resultados: () => { throw new Error('duplicate key value violates unique constraint "pagos_numero_op_unico"') } })
const er = await llamar(new Request(url('resultado'), { method: 'POST', body: JSON.stringify({ resultados: [] }) }))
info('un error de la base llega al robot con el texto interno', er.cuerpo.error as string)
check('[S] el error interno de la base (nombres de índices y tablas) no se le muestra al robot: alcanza con "Error interno" y el detalle queda en el log del servidor', !/pagos_numero_op_unico|constraint/.test(String(er.cuerpo.error)), String(er.cuerpo.error))

// ---------------------------------------------------------------- 5. Corridas automáticas con varias organizaciones
m = mundo({ robot_pedir_automatica: (a) => { if (a.p_org === 'org-a') throw new Error('falló la organización A'); return { pedida: true } } })
let lanzo: unknown = null
let res: { organizacion: string; pedida: boolean }[] = []
try { res = await lib.pedirCorridasAutomaticas(db(), ['org-a', 'org-b'], new Date(Date.UTC(2026, 10, 27, 16, 0)), false) } catch (e) { lanzo = e }
check('[C] si la base falla para una organización, las demás igual reciben su corrida automática', lanzo === null && res.some((x) => x.organizacion === 'org-b' && x.pedida), `la excepción de org-a corta el recorrido: ${(lanzo as Error | null)?.message}; la B nunca se pide (llamadas: ${m.llamadas.robot_pedir_automatica?.length})`)
// Los disparos de Netlify llegan en UTC: el 16 y el 20 caen en el mismo día de Buenos Aires
check('[T] 16 y 20 UTC son el mismo día calendario en Buenos Aires (UTC-3): la fecha hábil se mira en la base con hoy_ar()', new Date(Date.UTC(2026, 10, 27, 16)).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }) === new Date(Date.UTC(2026, 10, 27, 20)).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }))

console.log(`\n${ok} OK · ${bug} BUG`)
process.exit(0)
