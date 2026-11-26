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
  /** Empresas para las que se puede cargar (lo subió una persona). null = lo trajo el servidor: cualquiera. */
  empresas_permitidas?: string[] | null
  /** Organización dueña del documento: se lee contra las empresas de esa organización y ninguna más. */
  organizacion_id?: string | null
}

const hoyAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date())

export function validarArchivo(nombre: string | undefined, mimeType: string | undefined, data: string | undefined) {
  if (!data) throw new ErrorHttp(400, 'Falta el archivo')
  if (!MIME_PERMITIDOS.has(mimeType ?? '')) throw new ErrorHttp(415, `Solo PDF, JPG, PNG o WEBP (llegó ${mimeType || 'sin tipo'})`)
  if (data.length > MAX_BASE64) throw new ErrorHttp(413, 'Archivo demasiado grande (máximo 4 MB)')
  if (!nombre) throw new ErrorHttp(400, 'Falta el nombre del archivo')
}

/** Carpeta de las facturas que se suben sin saber todavía de qué empresa son (la empresa la dice la IA al leerlas). */
export const CARPETA_SIN_EMPRESA = 'sin-empresa'

/**
 * Guarda el archivo en el bucket privado "facturas" y devuelve la ruta: <organización>/<empresa>/año/mes/archivo.
 * La primera carpeta es la organización dueña del archivo: la regla de lectura de la base (0019) la mira.
 * La segunda es la empresa que eligió quien lo subió, o "sin-empresa".
 */
export async function guardarArchivo(db: SupabaseClient, nombre: string, mimeType: string, base64: string, destino: { organizacion: string; empresa?: string | null }): Promise<string> {
  if (!destino.organizacion) throw new ErrorHttp(500, 'No se sabe de qué organización es el archivo: no se guarda')
  const limpio = nombre.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80)
  const hoy = hoyAR()
  const carpetaEmpresa = (destino.empresa ?? '').replace(/[^a-zA-Z0-9_-]+/g, '') || CARPETA_SIN_EMPRESA
  const path = `${destino.organizacion}/${carpetaEmpresa}/${hoy.slice(0, 4)}/${hoy.slice(5, 7)}/${crypto.randomUUID()}_${limpio}`
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

/**
 * Empresas activas de una organización, con sus alias. Es lo único que recibe la IA (en el pedido van sus
 * nombres y CUIT) y lo único contra lo que se busca la empresa receptora: un documento de una organización
 * nunca manda datos de otra ni puede quedar asignado a una empresa de otra.
 */
async function empresas(db: SupabaseClient, organizacionId: string): Promise<EmpresaRef[]> {
  const { data, error } = await db.from('empresas').select('id, nombre, cuit, erp, alias, alias_emisor, alias_orden').eq('activa', true).eq('organizacion_id', organizacionId)
  if (error) throw new ErrorHttp(500, error.message)
  return data as EmpresaRef[]
}

/**
 * Empresas para las que una persona puede cargar un archivo: la que eligió, si la ve; si no eligió,
 * todas las que ve. Nunca devuelve una empresa que la persona no ve.
 */
export function empresasParaCargar(visibles: string[], elegida?: string | null): string[] {
  const e = (elegida ?? '').trim()
  if (!e) return visibles
  if (!visibles.includes(e)) throw new ErrorHttp(403, `No tenés acceso a la empresa ${e}`)
  return [e]
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
    if (!doc.organizacion_id) throw new ErrorHttp(422, 'El documento no dice de qué organización es: no se lee')
    const grupo = await empresas(db, doc.organizacion_id)

    const raw = await llamarGemini({ prompt: `${promptFactura(grupo, hoyAR())}\nEl archivo se llama "${doc.nombre_archivo}".`, schema: ESQUEMA_FACTURA, mimeType: doc.mime_type, data: base64 })
    const r = interpretarLectura(raw, grupo, hoyAR())

    if (r.tipo === 'SIN_FACTURA') {
      await db.rpc('documento_sin_factura', { p_id: doc.id, p_motivo: r.motivo, p_lectura: raw })
      return { id: doc.id, estado: 'ERROR', detalle: r.motivo }
    }
    // Subido por una persona: la factura tiene que ser de una empresa que esa persona puede cargar.
    // (La base lo vuelve a controlar al guardar: trigger factura_respeta_documento.)
    if (doc.empresas_permitidas && !doc.empresas_permitidas.includes(r.factura.empresa_id)) {
      const nombre = grupo.find((e) => e.id === r.factura.empresa_id)?.nombre ?? r.factura.empresa_id
      const motivo = `La factura es de ${nombre} y quien la subió no tiene acceso a esa empresa. La tiene que cargar alguien que la vea.`
      await db.rpc('documento_sin_factura', { p_id: doc.id, p_motivo: motivo, p_lectura: raw })
      return { id: doc.id, estado: 'ERROR', detalle: motivo }
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

/**
 * Lee documentos de la cola de a uno mientras quede tiempo. `filtro` limita qué se toma:
 *  - una lista de empresas: únicamente lo que una persona subió para esas empresas (nunca lo de Gmail
 *    o Drive, que puede ser de cualquiera);
 *  - una organización: únicamente los documentos de esa organización;
 *  - nada: toda la cola (el lector programado).
 */
export async function leerCola(db: SupabaseClient, presupuestoMs: number, filtro?: string[] | { organizacion: string }): Promise<ResultadoDocumento[]> {
  const inicio = Date.now()
  const resultados: ResultadoDocumento[] = []
  while (Date.now() - inicio < presupuestoMs) {
    const { data, error } = Array.isArray(filtro)
      ? await db.rpc('tomar_documentos_de_empresas', { p_max: 1, p_empresas: filtro })
      : filtro
        ? await db.rpc('tomar_documentos', { p_max: 1, p_organizacion: filtro.organizacion })
        : await db.rpc('tomar_documentos', { p_max: 1 })
    if (error) throw new ErrorHttp(500, error.message)
    const doc = (data as Documento[])[0]
    if (!doc) break
    resultados.push(await procesarDocumento(db, doc))
  }
  return resultados
}
