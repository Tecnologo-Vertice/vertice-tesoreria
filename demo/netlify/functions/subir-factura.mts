// POST /api/facturas/subir  { nombre, mimeType, data (base64), empresaId? }
// Carga manual de una factura desde la app: se guarda, se encola y se intenta leer en el momento.
// Si la IA tarda más de lo que permite Netlify, el documento queda en la cola y lo termina el lector.
// La factura solo se guarda si es de la empresa elegida (empresaId) o, si no se eligió, de una de las
// empresas que ve quien la sube: el documento lleva esa lista y la base la controla al guardar.

import type { Config } from '@netlify/functions'
import { empresasVisibles, exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { empresasParaCargar, guardarArchivo, procesarDocumento, registrarDocumento, validarArchivo, type Documento } from './lib/entrada'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'APROBADOR', 'ADMINISTRACION', 'TESORERIA', 'ADMIN')
  const b = await leerJson<{ nombre?: string; mimeType?: string; data?: string; empresaId?: string }>(req)
  validarArchivo(b.nombre, b.mimeType, b.data)
  // Antes de guardar nada: si eligió una empresa que no ve, se corta acá.
  const permitidas = empresasParaCargar(await empresasVisibles(u), b.empresaId)
  const db = supabaseAdmin()

  const path = await guardarArchivo(db, b.nombre!, b.mimeType!, b.data!)
  const { id } = await registrarDocumento(db, {
    origen: 'MANUAL',
    organizacion_id: u.organizacionId,
    nombre_archivo: b.nombre,
    mime_type: b.mimeType,
    storage_path: path,
    tamano: Math.round((b.data!.length * 3) / 4),
    cargado_por: u.nombre,
    empresas_permitidas: permitidas,
  })

  const { data } = await db.rpc('tomar_documento', { p_id: id })
  const doc = (data as Documento[] | null)?.[0]
  if (!doc) return json({ ok: true, id, estado: 'PENDIENTE' })
  return json({ ok: true, ...(await procesarDocumento(db, doc)) })
})

export const config: Config = { path: '/api/facturas/subir' }
