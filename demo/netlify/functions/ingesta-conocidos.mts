// POST /api/ingesta/conocidos  { ids: string[] }  header x-ingesta-token
// Le dice al cartero de Drive qué archivos ya entraron (por id de archivo), para no volver a bajarlos y mandarlos.

import type { Config } from '@netlify/functions'
import { exigirTokenIntegracion, json, leerJson, manejar, supabaseAdmin, ErrorHttp } from './lib/comun'

export default manejar(async (req) => {
  const { organizacion } = await exigirTokenIntegracion(req, 'INGESTA')
  const { ids } = await leerJson<{ ids?: string[] }>(req)
  const lista = (ids ?? []).filter((x) => typeof x === 'string' && x).slice(0, 500)
  if (!lista.length) return json({ ok: true, conocidos: [] })
  const { data, error } = await supabaseAdmin().from('documentos').select('gmail_message_id').eq('organizacion_id', organizacion).in('gmail_message_id', lista)
  if (error) throw new ErrorHttp(500, error.message)
  return json({ ok: true, conocidos: [...new Set((data ?? []).map((d) => d.gmail_message_id as string))] })
})

export const config: Config = { path: '/api/ingesta/conocidos' }
