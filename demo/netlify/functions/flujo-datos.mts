// POST /api/flujo/datos  header x-ingesta-token
// Pagos y facturas para pagar con los encabezados de la hoja, para gas/FlujoCaja.gs (Aux Pagos y Aux Proyeccion).

import type { Config } from '@netlify/functions'
import { exigirTokenCartero, json, manejar, organizacionDelPuente, supabaseAdmin, ErrorHttp } from './lib/comun'

export default manejar(async (req) => {
  exigirTokenCartero(req)
  // flujo_datos devuelve pagos y facturas de toda la base: solo se atiende mientras haya una sola organización.
  await organizacionDelPuente()
  const { data, error } = await supabaseAdmin().rpc('flujo_datos')
  if (error) throw new ErrorHttp(500, error.message)
  return json({ ok: true, ...(data as object) })
})

export const config: Config = { path: '/api/flujo/datos' }
