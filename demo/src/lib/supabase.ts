import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Null cuando faltan las variables: la app corre en modo demo. */
export const supabase: SupabaseClient | null = url && anon ? createClient(url, anon) : null

export const MODO_CONECTADO = supabase !== null

/** Token de sesión para llamar a las funciones de Netlify. */
export async function tokenSesion(): Promise<string> {
  if (!supabase) throw new Error('Sin Supabase')
  const { data } = await supabase.auth.getSession()
  const t = data.session?.access_token
  if (!t) throw new Error('Sesión vencida: volvé a entrar')
  return t
}

export async function llamarFuncion<T>(ruta: string, body: unknown): Promise<T> {
  const token = await tokenSesion()
  const r = await fetch(`/api/${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const texto = await r.text()
  let json: unknown = null
  try {
    json = texto ? JSON.parse(texto) : null
  } catch {
    /* respuesta no JSON */
  }
  if (!r.ok) {
    const msg = (json as { error?: string } | null)?.error ?? texto ?? `HTTP ${r.status}`
    throw new Error(msg)
  }
  return json as T
}

export function archivoABase64(archivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '')
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(archivo)
  })
}
