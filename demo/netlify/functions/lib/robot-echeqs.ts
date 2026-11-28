// API del robot de e-cheqs: lo que hoy hace el proyecto aparte "Robot e-cheqs API" del Apps Script (Code.js), con las mismas
// acciones y el mismo formato de respuesta, para que el día del cambio en la PC solo haya que cambiar la URL y la clave.
//
//   GET  ?accion=estado           → { ok, solicitada, fecha, por, modo, tipo }
//   GET  ?accion=tomarCorrida     → { ok, tomada, ... }       marca el pedido como tomado
//   GET  ?accion=pendientes       → { ok, grupos, bloqueados }
//   GET  ?accion=debitos&dias=45  → { ok, candidatos, bloqueados, ralpharmaOmitidos, desde }
//   POST ?accion=resultado        body { resultados: [...] } | { aviso, detalle }  → { ok, registrados, ... }
//   POST ?accion=resultadoDebito  body { resultados: [...] }                       → { ok, registrados, ... }
//
// La clave compartida va en ROBOT_ECHEQS_CLAVE. El robot la manda como "token" en la dirección (como hoy) o, mejor, en el
// encabezado x-robot-token (o Authorization: Bearer). Sin clave configurada responde 503; con clave equivocada, 401.
// Esta función no escribe nada afuera: Xubio lo toca el robot de la PC. Si el servidor no tiene ROBOT_ECHEQS_ENVIO_REAL="true",
// las corridas pedidas en real se le entregan al robot como PRUEBA y, si igual declara "real" en sus resultados, la base los registra
// como prueba (no cambian pagos ni cheques): el robot no puede promover una corrida a real.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { json } from './comun'
import { conBloqueo } from './xubio-ida-vuelta'

const ACCIONES_GET = ['estado', 'tomarCorrida', 'pendientes', 'debitos']
const ACCIONES_POST = ['resultado', 'resultadoDebito']
/** Un robot manda unas decenas de resultados por vez: más que esto es un error o un abuso. */
const MAX_RESULTADOS = 500

const resumen = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/** Compara en tiempo constante (sin que el largo ni el contenido de la clave se puedan adivinar por el tiempo). */
export function claveIgual(recibida: string, esperada: string): boolean {
  if (!recibida || !esperada) return false
  return timingSafeEqual(resumen(recibida), resumen(esperada))
}

/** La clave que mandó el robot: x-robot-token, Authorization: Bearer o el "token" de la dirección (como el Apps Script). */
export function claveDe(req: Request): string {
  const h = req.headers.get('x-robot-token')
  if (h) return h
  const auth = req.headers.get('authorization') ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  return new URL(req.url).searchParams.get('token') ?? ''
}

/** null si la clave es válida; si no, la respuesta que corresponde (503 sin clave configurada, 401 con clave mala). */
export function verificarClave(req: Request, esperada: string | undefined): Response | null {
  if (!esperada) return json({ ok: false, error: 'El robot de e-cheqs no está configurado en el servidor (falta ROBOT_ECHEQS_CLAVE)' }, 503)
  if (!claveIgual(claveDe(req), esperada)) return json({ ok: false, error: 'token inválido' }, 401)
  return null
}

/** El modo que se le dice al robot: sin el envío real encendido en el servidor, todo se entrega como prueba. */
export function modoEntregado(modo: string, envioReal: boolean): 'prueba' | 'real' {
  return modo === 'real' && envioReal ? 'real' : 'prueba'
}

export interface OpcionesRobot {
  /** ROBOT_ECHEQS_CLAVE */
  clave: string | undefined
  /** ROBOT_ECHEQS_ENVIO_REAL === 'true' */
  envioReal: boolean
}

class ErrorRobot extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

async function cuerpoDe(req: Request): Promise<Record<string, unknown>> {
  let cuerpo: unknown
  try {
    cuerpo = await req.json()
  } catch {
    throw new ErrorRobot(400, 'Cuerpo JSON inválido')
  }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) throw new ErrorRobot(400, 'El cuerpo tiene que ser un objeto JSON')
  const r = (cuerpo as Record<string, unknown>).resultados
  if (r !== undefined && !Array.isArray(r)) throw new ErrorRobot(400, 'resultados tiene que ser una lista')
  if (Array.isArray(r) && r.length > MAX_RESULTADOS) throw new ErrorRobot(400, `Demasiados resultados juntos (más de ${MAX_RESULTADOS})`)
  return cuerpo as Record<string, unknown>
}

/** Atiende un pedido del robot. `db` se pide recién cuando la clave ya está verificada. */
export async function atenderRobot(req: Request, db: () => SupabaseClient, op: OpcionesRobot): Promise<Response> {
  const rechazo = verificarClave(req, op.clave)
  if (rechazo) return rechazo
  try {
    const url = new URL(req.url)
    const accion = url.searchParams.get('accion') ?? ''
    const esPost = ACCIONES_POST.includes(accion)
    if (!esPost && !ACCIONES_GET.includes(accion)) throw new ErrorRobot(400, 'acción desconocida: ' + accion)
    if (esPost && req.method !== 'POST') throw new ErrorRobot(405, `La acción ${accion} se manda con POST`)
    if (!esPost && req.method !== 'GET' && req.method !== 'POST') throw new ErrorRobot(405, 'Método no permitido')
    const cliente = db()
    const org = await rpc<string>(cliente, 'robot_organizacion', {})
    let salida: Record<string, unknown>
    switch (accion) {
      case 'estado': {
        const e = await rpc<{ modo?: string } & Record<string, unknown>>(cliente, 'robot_estado', { p_org: org })
        salida = { ...e, modo: modoEntregado(String(e.modo ?? 'prueba'), op.envioReal) }
        break
      }
      case 'tomarCorrida':
        salida = await rpc<Record<string, unknown>>(cliente, 'robot_tomar_corrida', { p_org: org, p_forzar_prueba: !op.envioReal })
        break
      case 'pendientes':
        salida = await rpc<Record<string, unknown>>(cliente, 'robot_grupos_op', { p_org: org, p_empresas: null })
        break
      case 'debitos': {
        const dias = Number(url.searchParams.get('dias')) || 45
        salida = await rpc<Record<string, unknown>>(cliente, 'robot_candidatos_debito', { p_org: org, p_dias: Math.max(1, Math.min(Math.trunc(dias), 365)), p_empresas: null })
        break
      }
      case 'resultado':
        salida = await rpc<Record<string, unknown>>(cliente, 'robot_registrar_resultados', { p_org: org, p_cuerpo: await cuerpoDe(req), p_permitir_real: op.envioReal })
        break
      default:
        salida = await rpc<Record<string, unknown>>(cliente, 'robot_registrar_debitos', { p_org: org, p_cuerpo: await cuerpoDe(req), p_permitir_real: op.envioReal })
    }
    return json({ ...salida, ok: true })
  } catch (e) {
    if (e instanceof ErrorRobot) return json({ ok: false, error: e.message }, e.status)
    // El detalle (nombres de tablas, restricciones) queda en el registro del servidor; al robot no se le devuelve.
    console.error('Robot de e-cheqs:', e)
    return json({ ok: false, error: 'Error interno del servidor: probá de nuevo en unos minutos' }, 500)
  }
}

// ---------------------------------------------------------------- Corridas automáticas (13 y 17 h, días hábiles)

/**
 * Cuál de las dos corridas es, según la hora UTC en que arrancó la tarea (16 UTC = 13 h en Buenos Aires, 20 UTC = 17 h).
 * La de las 17 lleva además la reverificación de las órdenes de pago ya subidas (se anota en el pedido, como el Apps Script).
 */
export function corridaAutomatica(ahora: Date): { hora: '13:00' | '17:00'; reverificar: boolean } {
  return ahora.getUTCHours() < 18 ? { hora: '13:00', reverificar: false } : { hora: '17:00', reverificar: true }
}

export interface ResultadoAutomatica {
  organizacion: string
  pedida: boolean
  motivo?: string
}

/**
 * Deja el pedido de corrida de las 13 o las 17 h en cada organización activa. Es el mismo camino que el botón del panel: el robot
 * de la PC lo toma. Solo pide en REAL si el servidor lo autoriza (ROBOT_ECHEQS_ENVIO_REAL); si no, pide en prueba.
 * Una organización a la vez y con bloqueo: dos disparos juntos no pisan nada.
 */
export async function pedirCorridasAutomaticas(db: SupabaseClient, organizaciones: string[], ahora: Date, envioReal: boolean): Promise<ResultadoAutomatica[]> {
  const { hora, reverificar } = corridaAutomatica(ahora)
  const salida: ResultadoAutomatica[] = []
  for (const org of organizaciones) {
    try {
      const r = await conBloqueo(db, `robot-echeqs-auto:${org}`, () =>
        rpc<{ pedida?: boolean; motivo?: string }>(db, 'robot_pedir_automatica', { p_org: org, p_hora: hora, p_reverificar: reverificar, p_real: envioReal }),
      )
      if (!r) salida.push({ organizacion: org, pedida: false, motivo: 'hay otro proceso en curso' })
      else salida.push({ organizacion: org, pedida: r.pedida === true, motivo: r.motivo })
    } catch (e) {
      // Una organización que falla no corta a las demás.
      console.error(`Robot e-cheqs automático (organización ${org}):`, e)
      salida.push({ organizacion: org, pedida: false, motivo: 'error: ' + (e instanceof Error ? e.message : String(e)).slice(0, 120) })
    }
  }
  return salida
}
