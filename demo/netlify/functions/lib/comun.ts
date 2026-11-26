// Utilidades compartidas por las funciones: cliente de Supabase con rol de servicio,
// identificación del usuario que llama, y respuestas JSON.

import { createHash, timingSafeEqual } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type Rol = 'TESORERIA' | 'ADMINISTRACION' | 'APROBADOR' | 'DIRECCION' | 'CONTROLLER' | 'ADMIN'
export interface UsuarioFn {
  email: string
  nombre: string
  rol: Rol
  /** Ve todas las empresas DE SU ORGANIZACIÓN (usuarios.todas_empresas). Si es false, solo las de usuarios_empresas. */
  todasEmpresas: boolean
  /** La organización (el cliente) a la que pertenece la persona. Todo lo que hace queda dentro de ella. */
  organizacionId: string
}

export class ErrorHttp extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

export function env(nombre: string, obligatoria = true): string {
  const v = process.env[nombre]
  if (!v && obligatoria) throw new ErrorHttp(500, `Falta configurar ${nombre} en las variables de entorno`)
  return v ?? ''
}

let admin: SupabaseClient | null = null
/** Cliente con la clave de servicio: salta RLS. Solo se usa en el servidor, nunca en el navegador. */
export function supabaseAdmin(): SupabaseClient {
  if (!admin) admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
  return admin
}

/** Valida el token de sesión que manda la app y devuelve el usuario con su rol. */
export async function usuarioDesde(req: Request): Promise<UsuarioFn> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) throw new ErrorHttp(401, 'Sin sesión')
  const db = supabaseAdmin()
  const { data, error } = await db.auth.getUser(token)
  const email = data.user?.email?.toLowerCase()
  if (error || !email) throw new ErrorHttp(401, 'Sesión inválida')
  const { data: u } = await db.from('usuarios').select('email, nombre, rol, activo, todas_empresas, organizacion_id, organizaciones(estado)').eq('email', email).maybeSingle()
  if (!u || !u.activo) throw new ErrorHttp(403, `La cuenta ${email} no está habilitada`)
  // La organización de la persona tiene que existir y estar activa (igual que usuario_actual() en la base).
  const org = (Array.isArray(u.organizaciones) ? u.organizaciones[0] : u.organizaciones) as { estado?: string } | null | undefined
  if (!u.organizacion_id || org?.estado !== 'ACTIVA') throw new ErrorHttp(403, `La organización de la cuenta ${email} no está activa`)
  return { email: u.email, nombre: u.nombre, rol: u.rol as Rol, todasEmpresas: u.todas_empresas === true, organizacionId: String(u.organizacion_id) }
}

export function exigirRol(u: UsuarioFn, ...roles: Rol[]) {
  if (!roles.includes(u.rol)) throw new ErrorHttp(403, `Tu rol (${u.rol}) no puede hacer esta acción`)
}

/** La función corre con la clave de servicio (salta RLS): controla a mano que la persona vea esa empresa. */
export async function exigirEmpresa(u: UsuarioFn, empresaId: string | null | undefined) {
  if (!empresaId) throw new ErrorHttp(422, 'El registro no tiene empresa')
  const { data, error } = await supabaseAdmin().rpc('usuario_ve_empresa', { p_email: u.email, p_empresa: empresaId })
  if (error) throw new ErrorHttp(500, error.message)
  if (data !== true) throw new ErrorHttp(403, `No tenés acceso a la empresa ${empresaId}`)
}

/** Empresas activas que ve la persona. Para limitar a ellas lo que la función hace en su nombre. */
export async function empresasVisibles(u: UsuarioFn): Promise<string[]> {
  const { data, error } = await supabaseAdmin().rpc('empresas_visibles_de', { p_email: u.email })
  if (error) throw new ErrorHttp(500, error.message)
  const ids = Array.isArray(data) ? (data as string[]) : []
  if (!ids.length) throw new ErrorHttp(403, 'No tenés ninguna empresa asignada')
  return ids
}

/** Organizaciones activas, para las tareas programadas que recorren organización por organización. */
export async function organizacionesActivas(db: SupabaseClient = supabaseAdmin()): Promise<string[]> {
  const { data, error } = await db.from('organizaciones').select('id').eq('estado', 'ACTIVA').order('id')
  if (error) throw new ErrorHttp(500, error.message)
  return (data ?? []).map((o) => String(o.id))
}

/**
 * Tipo de tarea de un puente del Apps Script. Cada secreto de tokens_integracion sirve para una sola.
 *   INGESTA: cartero de Gmail y Drive (/api/ingesta/adjunto y /conocidos) y facturas leídas (/api/ingesta/factura).
 *   COPIA_HOJA: /api/espejo. CHEQUES: /api/cheques/*. FLUJO: /api/flujo/datos.
 */
export type Tarea = 'INGESTA' | 'COPIA_HOJA' | 'CHEQUES' | 'FLUJO'

/** Los secretos que crea crear_token_integracion (migración 0022). */
const FORMATO_SECRETO = /^vti_[0-9a-f]{64}$/
const resumen = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/**
 * Para qué organización trabaja un puente del Apps Script, según el secreto que manda en x-ingesta-token:
 *   · INGESTA_TOKEN (la variable de siempre): la organización que da el servicio (Vértice), para todas las
 *     tareas. Así el Apps Script de Vértice sigue entrando sin cambiar nada. Si ninguna organización figura
 *     como la que da el servicio y hay una sola, esa (como antes); con más de una, se detiene (409).
 *   · Un secreto de tokens_integracion: su organización, solo para su tarea, si está activo y la
 *     organización también. La base guarda solo el resumen del secreto.
 * Ningún mensaje repite el secreto recibido.
 */
export async function exigirTokenIntegracion(req: Request, tarea: Tarea): Promise<{ organizacion: string }> {
  const recibido = req.headers.get('x-ingesta-token') ?? ''
  if (!recibido) throw new ErrorHttp(401, 'Token de ingesta inválido')
  const general = process.env.INGESTA_TOKEN ?? ''
  if (general && timingSafeEqual(resumen(recibido), resumen(general))) return { organizacion: await organizacionProveedora() }
  // Lo que no tiene la forma de un secreto nuestro ni siquiera se busca en la base.
  if (!FORMATO_SECRETO.test(recibido)) throw new ErrorHttp(401, 'Token de ingesta inválido')
  const db = supabaseAdmin()
  const { data: t, error } = await db.from('tokens_integracion').select('id, organizacion_id, tarea, activo').eq('huella', resumen(recibido).toString('hex')).maybeSingle()
  if (error) throw new ErrorHttp(500, 'No se pudo verificar el token de ingesta')
  if (!t || t.activo !== true) throw new ErrorHttp(401, 'Token de ingesta inválido')
  if (t.tarea !== tarea) throw new ErrorHttp(403, `Este token es para la tarea ${t.tarea}, no para ${tarea}`)
  const { data: o, error: e2 } = await db.from('organizaciones').select('id, estado').eq('id', String(t.organizacion_id)).maybeSingle()
  if (e2) throw new ErrorHttp(500, e2.message)
  if (!o || o.estado !== 'ACTIVA') throw new ErrorHttp(403, 'La organización de este token no está activa')
  await db.from('tokens_integracion').update({ ultimo_uso: new Date().toISOString() }).eq('id', String(t.id))
  return { organizacion: String(t.organizacion_id) }
}

/** La organización que da el servicio (es_proveedor). Es la de INGESTA_TOKEN. */
async function organizacionProveedora(): Promise<string> {
  const { data, error } = await supabaseAdmin().from('organizaciones').select('id, estado, es_proveedor')
  if (error) throw new ErrorHttp(500, error.message)
  const lista = data ?? []
  if (!lista.length) throw new ErrorHttp(409, 'No hay ninguna organización cargada: INGESTA_TOKEN no tiene para quién trabajar. No se copió ni se entregó nada.')
  const o = lista.find((x) => x.es_proveedor === true) ?? (lista.length === 1 ? lista[0] : undefined)
  if (!o)
    throw new ErrorHttp(409, 'Ninguna organización figura como la que da el servicio (es_proveedor) y hay más de una organización: INGESTA_TOKEN no sabe para cuál trabaja (usar el token de la organización). No se copió ni se entregó nada.')
  if (o.estado !== 'ACTIVA') throw new ErrorHttp(403, 'La organización de este token no está activa')
  return String(o.id)
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

/** Envuelve una función: parsea errores conocidos a respuestas JSON con su código. */
export function manejar(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
    try {
      return await fn(req)
    } catch (e) {
      if (e instanceof ErrorHttp) return json({ error: e.message }, e.status)
      console.error(e)
      return json({ error: e instanceof Error ? e.message : 'Error interno' }, 500)
    }
  }
}

export async function leerJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new ErrorHttp(400, 'Cuerpo JSON inválido')
  }
}
