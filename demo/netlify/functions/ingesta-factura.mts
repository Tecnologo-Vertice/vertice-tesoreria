// POST /api/ingesta/factura   header: x-ingesta-token
// La llama el Apps Script (gas/EnviarAlSistema.gs) cada vez que lee una factura.
// El cuerpo es la fila de la hoja Facturas en formato JSON (ver ingresar_factura en SQL).

import type { Config } from '@netlify/functions'
import { env, json, leerJson, manejar, supabaseAdmin, ErrorHttp } from './lib/comun'

export default manejar(async (req) => {
  const esperado = env('INGESTA_TOKEN')
  const recibido = req.headers.get('x-ingesta-token') ?? ''
  if (!recibido || recibido !== esperado) throw new ErrorHttp(401, 'Token de ingesta inválido')
  const factura = await leerJson<Record<string, unknown>>(req)
  if (!factura.empresa_id || !factura.cuit_proveedor || !factura.total) throw new ErrorHttp(400, 'Faltan empresa_id, cuit_proveedor o total')
  const { data, error } = await supabaseAdmin().rpc('ingresar_factura', { p: factura })
  if (error) throw new ErrorHttp(422, error.message)
  return json({ ok: true, id: data })
})

export const config: Config = { path: '/api/ingesta/factura' }
