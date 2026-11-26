// POST /api/flujo/datos  header x-ingesta-token
// Pagos y facturas para pagar con los encabezados de la hoja, para gas/FlujoCaja.gs (Aux Pagos y Aux Proyeccion).

import type { Config } from '@netlify/functions'
import { exigirTokenIntegracion, json, manejar, supabaseAdmin, ErrorHttp } from './lib/comun'

export default manejar(async (req) => {
  // La organización sale del token: solo pagos y facturas de sus empresas.
  const { organizacion } = await exigirTokenIntegracion(req, 'FLUJO')
  const { data, error } = await supabaseAdmin().rpc('flujo_datos', { p_organizacion: organizacion })
  if (error) throw new ErrorHttp(500, error.message)
  return json({ ok: true, ...(data as object) })
})

export const config: Config = { path: '/api/flujo/datos' }
