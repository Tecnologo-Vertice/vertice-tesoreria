// POST /api/ingesta/factura   header: x-ingesta-token
// La llama el Apps Script (gas/EnviarAlSistema.gs) cada vez que lee una factura.
// El cuerpo es la fila de la hoja Facturas en formato JSON (ver ingresar_factura en SQL).

import type { Config } from '@netlify/functions'
import { exigirTokenIntegracion, json, leerJson, manejar, supabaseAdmin, ErrorHttp } from './lib/comun'

export default manejar(async (req) => {
  const { organizacion } = await exigirTokenIntegracion(req, 'INGESTA')
  const factura = await leerJson<Record<string, unknown>>(req)
  if (!factura.empresa_id || !factura.cuit_proveedor || !factura.total) throw new ErrorHttp(400, 'Faltan empresa_id, cuit_proveedor o total')
  // La factura tiene que ser de una empresa de la organización del token (ingresar_factura acepta cualquiera).
  const db = supabaseAdmin()
  const { data: empresa } = await db.from('empresas').select('id').eq('id', String(factura.empresa_id)).eq('organizacion_id', organizacion).maybeSingle()
  if (!empresa) throw new ErrorHttp(403, `La empresa ${String(factura.empresa_id)} no existe o es de otra organización`)
  const { data, error } = await db.rpc('ingresar_factura', { p: factura })
  if (error) throw new ErrorHttp(422, error.message)
  return json({ ok: true, id: data })
})

export const config: Config = { path: '/api/ingesta/factura' }
