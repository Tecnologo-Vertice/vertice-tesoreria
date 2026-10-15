// Entrada de facturas (Flujo 1): guardar el archivo, encolarlo y leerlo con la IA.
// Lo usan ingesta-adjunto (Apps Script como cartero), subir-factura (carga manual desde la app)
// y leer-documentos (lector programado).

import type { SupabaseClient } from '@supabase/supabase-js'
import { ErrorHttp } from './comun'
import { llamarGemini } from './gemini'
import { ESQUEMA_FACTURA, interpretarLectura, promptFactura, type EmpresaRef } from './factura'

export const MIME_PERMITIDOS = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
/** Netlify corta los pedidos de más de 6 MB; en base64 eso es un archivo de unos 4 MB. */
export const MAX_BASE64 = 5.5 * 1024 * 1024

export interface Documento {
  id: string
  origen: string
  nombre_archivo: string
  mime_type: string
  storage_path: string
  intentos: number
}

const hoyAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date())

export function validarArchivo(nombre: string | undefined, mimeType: string | undefined, data: string | undefined) {
  if (!data) throw new ErrorHttp(400, 'Falta el archivo')
  if (!MIME_PERMITIDOS.has(mimeType ?? '')) throw new ErrorHttp(415, `Solo PDF, JPG, PNG o WEBP (llegó ${mimeType || 'sin tipo'})`)
  if (data.length > MAX_BASE64) throw new ErrorHttp(413, 'Archivo demasiado grande (máximo 4 MB)')
  if (!nombre) throw new ErrorHttp(400, 'Falta el nombre del archivo')
}

/** Guarda el archivo en el bucket privado "facturas" y devuelve la ruta. */
export async function guardarArchivo(db: SupabaseClient, nombre: string, mimeType: string, base64: string): Promise<string> {
  const limpio = nombre.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80)
  const hoy = hoyAR()
  const path = `${hoy.slice(0, 4)}/${hoy.slice(5, 7)}/${crypto.randomUUID()}_${limpio}`
  const { error } = await db.storage.from('facturas').upload(path, Buffer.from(base64, 'base64'), { contentType: mimeType })
  if (error) throw new ErrorHttp(502, `No se pudo guardar el archivo: ${error.message}`)
  return path
}

export async function registrarDocumento(db: SupabaseClient, d: Record<string, unknown>): Promise<{ id: string; nuevo: boolean }> {
  const { data, error } = await db.rpc('registrar_documento', { p: d })
  if (error) throw new ErrorHttp(500, `No se pudo registrar el documento: ${error.message}`)
  const fila = (data as { id: string; nuevo: boolean }[])[0]
  return fila
}

async function empresas(db: SupabaseClient): Promise<EmpresaRef[]> {
  const { data, error } = await db.from('empresas').select('id, nombre, cuit').eq('activa', true)
  if (error) throw new ErrorHttp(500, error.message)
  return data as EmpresaRef[]
}

export type ResultadoDocumento = { id: string; estado: 'LEIDO' | 'DUPLICADO' | 'ERROR' | 'PENDIENTE'; facturaId?: string; detalle?: string }

/**
 * Lee un documento ya tomado (estado LEYENDO) y deja el resultado en la base. Nunca tira error:
 * cualquier falla queda registrada en el documento (con reintento si es transitoria).
 */
export async function procesarDocumento(db: SupabaseClient, doc: Documento): Promise<ResultadoDocumento> {
  try {
    const { data: archivo, error } = await db.storage.from('facturas').download(doc.storage_path)
    if (error || !archivo) throw new ErrorHttp(502, `No se pudo leer el archivo guardado: ${error?.message ?? 'vacío'}`)
    const base64 = Buffer.from(await archivo.arrayBuffer()).toString('base64')
    const grupo = await empresas(db)

    const raw = await llamarGemini({ prompt: `${promptFactura(grupo, hoyAR())}\nEl archivo se llama "${doc.nombre_archivo}".`, schema: ESQUEMA_FACTURA, mimeType: doc.mime_type, data: base64 })
    const r = interpretarLectura(raw, grupo, hoyAR())

    if (r.tipo === 'SIN_FACTURA') {
      await db.rpc('documento_sin_factura', { p_id: doc.id, p_motivo: r.motivo, p_lectura: raw })
      return { id: doc.id, estado: 'ERROR', detalle: r.motivo }
    }
    const { data: facturaId, error: e2 } = await db.rpc('guardar_factura_leida', { p_doc: doc.id, p: r.factura })
    if (e2) throw new ErrorHttp(500, e2.message)
    const { data: d } = await db.from('documentos').select('estado').eq('id', doc.id).single()
    return { id: doc.id, estado: (d?.estado as ResultadoDocumento['estado']) ?? 'LEIDO', facturaId: String(facturaId), detalle: r.factura.validacion_ok ? undefined : r.factura.motivo_validacion }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 422 = el archivo no se puede leer: reintentar no sirve. Cuota, red o IA caída: vuelve a la cola.
    const transitorio = !(e instanceof ErrorHttp && e.status === 422)
    await db.rpc('documento_fallo', { p_id: doc.id, p_error: msg, p_reintentar: transitorio })
    return { id: doc.id, estado: transitorio && doc.intentos < 3 ? 'PENDIENTE' : 'ERROR', detalle: msg }
  }
}

/** Lee documentos de la cola de a uno mientras quede tiempo. */
export async function leerCola(db: SupabaseClient, presupuestoMs: number): Promise<ResultadoDocumento[]> {
  const inicio = Date.now()
  const resultados: ResultadoDocumento[] = []
  while (Date.now() - inicio < presupuestoMs) {
    const { data, error } = await db.rpc('tomar_documentos', { p_max: 1 })
    if (error) throw new ErrorHttp(500, error.message)
    const doc = (data as Documento[])[0]
    if (!doc) break
    resultados.push(await procesarDocumento(db, doc))
  }
  return resultados
}
