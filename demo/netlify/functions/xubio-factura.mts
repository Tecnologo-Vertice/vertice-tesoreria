// POST /api/xubio/factura  { facturaId }
// Sube a Xubio una factura aprobada. La app la llama sola al aprobar; también sirve para reintentar.

import type { Config } from '@netlify/functions'
import { exigirEmpresa, exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde, ErrorHttp } from './lib/comun'
import { subirFacturaAXubio } from './lib/xubio-facturas'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'APROBADOR', 'ADMINISTRACION', 'ADMIN')
  const { facturaId } = await leerJson<{ facturaId?: string }>(req)
  if (!facturaId) throw new ErrorHttp(400, 'Falta facturaId')
  const { data: f } = await supabaseAdmin().from('facturas').select('empresa_id').eq('id', facturaId).maybeSingle()
  if (!f) throw new ErrorHttp(404, 'Factura inexistente')
  await exigirEmpresa(u, f.empresa_id)
  return json(await subirFacturaAXubio(supabaseAdmin(), facturaId, u.nombre))
})

export const config: Config = { path: '/api/xubio/factura' }
