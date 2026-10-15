// POST /api/facturas/subir  { nombre, mimeType, data (base64) }
// Carga manual de una factura desde la app: se guarda, se encola y se intenta leer en el momento.
// Si la IA tarda más de lo que permite Netlify, el documento queda en la cola y lo termina el lector.

import type { Config } from '@netlify/functions'
import { exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { guardarArchivo, procesarDocumento, registrarDocumento, validarArchivo, type Documento } from './lib/entrada'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'APROBADOR', 'ADMINISTRACION', 'TESORERIA', 'ADMIN')
  const b = await leerJson<{ nombre?: string; mimeType?: string; data?: string }>(req)
  validarArchivo(b.nombre, b.mimeType, b.data)
  const db = supabaseAdmin()

  const path = await guardarArchivo(db, b.nombre!, b.mimeType!, b.data!)
  const { id } = await registrarDocumento(db, {
    origen: 'MANUAL',
    nombre_archivo: b.nombre,
    mime_type: b.mimeType,
    storage_path: path,
    tamano: Math.round((b.data!.length * 3) / 4),
    cargado_por: u.nombre,
  })

  const { data } = await db.rpc('tomar_documento', { p_id: id })
  const doc = (data as Documento[] | null)?.[0]
  if (!doc) return json({ ok: true, id, estado: 'PENDIENTE' })
  return json({ ok: true, ...(await procesarDocumento(db, doc)) })
})

export const config: Config = { path: '/api/facturas/subir' }
