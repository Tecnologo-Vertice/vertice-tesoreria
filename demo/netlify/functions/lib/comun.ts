// Utilidades compartidas por las funciones: cliente de Supabase con rol de servicio,
// identificación del usuario que llama, y respuestas JSON.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type Rol = 'TESORERIA' | 'ADMINISTRACION' | 'APROBADOR' | 'DIRECCION' | 'CONTROLLER' | 'ADMIN'
export interface UsuarioFn {
  email: string
  nombre: string
  rol: Rol
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
  const { data: u } = await db.from('usuarios').select('email, nombre, rol, activo').eq('email', email).maybeSingle()
  if (!u || !u.activo) throw new ErrorHttp(403, `La cuenta ${email} no está habilitada`)
  return { email: u.email, nombre: u.nombre, rol: u.rol as Rol }
}

export function exigirRol(u: UsuarioFn, ...roles: Rol[]) {
  if (!roles.includes(u.rol)) throw new ErrorHttp(403, `Tu rol (${u.rol}) no puede hacer esta acción`)
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
