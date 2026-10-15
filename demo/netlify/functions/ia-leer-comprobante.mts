// POST /api/ia/leer-comprobante  { nombre, mimeType, data (base64) }
// Devuelve LecturaComprobante. Cualquier usuario habilitado puede usarla.

import type { Config } from '@netlify/functions'
import { json, leerJson, manejar, usuarioDesde, ErrorHttp } from './lib/comun'
import { leerComprobanteConGemini } from './lib/gemini'

const MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

export default manejar(async (req) => {
  await usuarioDesde(req)
  const b = await leerJson<{ nombre?: string; mimeType?: string; data?: string }>(req)
  if (!b.data) throw new ErrorHttp(400, 'Falta el archivo')
  if (!MIME.has(b.mimeType ?? '')) throw new ErrorHttp(415, 'Solo PDF, JPG, PNG o WEBP')
  // Netlify corta los pedidos de más de 6 MB; en base64 eso es un archivo de unos 4 MB.
  if (b.data.length > 5.5 * 1024 * 1024) throw new ErrorHttp(413, 'Archivo demasiado grande (máximo 4 MB)')
  const lectura = await leerComprobanteConGemini({ nombre: b.nombre ?? 'comprobante', mimeType: b.mimeType!, data: b.data })
  return json(lectura)
})

export const config: Config = { path: '/api/ia/leer-comprobante' }
