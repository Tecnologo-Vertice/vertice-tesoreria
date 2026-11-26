// POST /api/cheques/pendientes  { }                       → cheques que gas/ChequesCashFlow.gs tiene que pasar
// POST /api/cheques/resultado   { resultados: [{ pago_id, estado }] } → la marca de cada uno
// Header x-ingesta-token. El Apps Script escribe en CHEQUES EMITIDOS con la misma lógica de producción.
// CASHFLOW_CHEQUES_DESDE (aaaa-mm-dd): desde qué carga de pago se pasan; lo anterior ya está a mano.

import type { Config } from '@netlify/functions'
import { env, exigirTokenCartero, json, leerJson, manejar, organizacionDelPuente, supabaseAdmin, ErrorHttp } from './lib/comun'

export default manejar(async (req) => {
  exigirTokenCartero(req)
  // Las consultas de cheques devuelven los de toda la base: solo se atienden mientras haya una sola organización.
  await organizacionDelPuente()
  const db = supabaseAdmin()
  if (new URL(req.url).pathname.endsWith('/resultado')) {
    const b = await leerJson<{ resultados?: { pago_id: string; estado: string }[] }>(req)
    const { data, error } = await db.rpc('marcar_cheques_cashflow', { p: b.resultados ?? [] })
    if (error) throw new ErrorHttp(500, error.message)
    return json({ ok: true, marcados: data })
  }
  const desde = env('CASHFLOW_CHEQUES_DESDE', false)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new ErrorHttp(409, 'Falta CASHFLOW_CHEQUES_DESDE (aaaa-mm-dd) en Netlify: desde qué fecha se pasan los cheques')
  const { data, error } = await db.rpc('cheques_para_cashflow', { p_desde: `${desde}T00:00:00-03:00` })
  if (error) throw new ErrorHttp(500, error.message)
  return json({ ok: true, desde, cheques: data ?? [] })
})

export const config: Config = { path: ['/api/cheques/pendientes', '/api/cheques/resultado'] }
