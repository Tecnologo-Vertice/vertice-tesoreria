// POST /api/ingesta/adjunto   header: x-ingesta-token
// La llama el Apps Script como cartero (gas/CarteroGmail.gs) con cada adjunto de un mail etiquetado.
// Solo guarda el archivo y lo encola: la lectura con IA la hace leer-documentos, así esta función
// responde rápido y un corte de la IA no hace perder el mail. Idempotente por mail + nombre de adjunto.
// Body: { origen?: 'GMAIL' | 'DRIVE', gmailMessageId, nombre, mimeType, data (base64), remitente?, asunto? }

import type { Config } from '@netlify/functions'
import { env, json, leerJson, manejar, organizacionDelPuente, supabaseAdmin, ErrorHttp } from './lib/comun'
import { guardarArchivo, registrarDocumento, validarArchivo } from './lib/entrada'

interface Body {
  origen?: 'GMAIL' | 'DRIVE'
  gmailMessageId?: string
  nombre?: string
  mimeType?: string
  data?: string
  remitente?: string
  asunto?: string
}

export default manejar(async (req) => {
  const esperado = env('INGESTA_TOKEN')
  if ((req.headers.get('x-ingesta-token') ?? '') !== esperado) throw new ErrorHttp(401, 'Token de ingesta inválido')
  const b = await leerJson<Body>(req)
  validarArchivo(b.nombre, b.mimeType, b.data)
  const origen = b.origen === 'DRIVE' ? 'DRIVE' : 'GMAIL'
  if (origen === 'GMAIL' && !b.gmailMessageId) throw new ErrorHttp(400, 'Falta gmailMessageId')
  const db = supabaseAdmin()
  // De qué organización es el buzón: mientras haya una sola, esa (ver organizacionDelPuente).
  const organizacion = await organizacionDelPuente()

  // Si este adjunto ya llegó, no se vuelve a guardar el archivo.
  if (b.gmailMessageId) {
    const { data: previo } = await db.from('documentos').select('id, estado').eq('organizacion_id', organizacion).eq('gmail_message_id', b.gmailMessageId).eq('nombre_archivo', b.nombre!).maybeSingle()
    if (previo) return json({ ok: true, id: previo.id, nuevo: false, estado: previo.estado })
  }

  const path = await guardarArchivo(db, b.nombre!, b.mimeType!, b.data!)
  const r = await registrarDocumento(db, {
    origen,
    organizacion_id: organizacion,
    gmail_message_id: b.gmailMessageId ?? '',
    nombre_archivo: b.nombre,
    mime_type: b.mimeType,
    storage_path: path,
    tamano: Math.round((b.data!.length * 3) / 4),
    remitente: b.remitente ?? '',
    asunto: b.asunto ?? '',
    cargado_por: 'Apps Script',
  })
  return json({ ok: true, id: r.id, nuevo: r.nuevo, estado: 'PENDIENTE' })
})

export const config: Config = { path: '/api/ingesta/adjunto' }
