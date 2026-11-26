// Utilidades compartidas por las funciones: cliente de Supabase con rol de servicio,
// identificación del usuario que llama, y respuestas JSON.

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

/**
 * Para qué organización trabajan los puentes del Apps Script (cartero, copia de la hoja, cheques, flujo).
 * Hoy tienen un solo secreto (INGESTA_TOKEN) que no dice de quién es. Mientras haya una sola organización,
 * es esa. Con dos o más se rechaza el pedido: es preferible que el puente se detenga a que cargue o entregue
 * datos de un cliente a otro. Cuando cada organización tenga su secreto, la organización sale de ahí.
 */
export async function organizacionDelPuente(): Promise<string> {
  const { data, error } = await supabaseAdmin().from('organizaciones').select('id').limit(2)
  if (error) throw new ErrorHttp(500, error.message)
  if (!data || data.length !== 1)
    throw new ErrorHttp(409, 'Hay más de una organización y este puente todavía no sabe para cuál trabaja (falta el secreto por organización). No se copió ni se entregó nada.')
  return String(data[0].id)
}

/** Los puentes del Apps Script (cartero, cheques, flujo) se identifican con INGESTA_TOKEN en x-ingesta-token. */
export function exigirTokenCartero(req: Request) {
  const esperado = env('INGESTA_TOKEN')
  if ((req.headers.get('x-ingesta-token') ?? '') !== esperado) throw new ErrorHttp(401, 'Token del Apps Script inválido')
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
