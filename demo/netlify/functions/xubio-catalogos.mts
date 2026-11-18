// POST /api/xubio/catalogos — Administración trae el plan de cuentas y las cuentas de origen de Xubio.
// (cargarPlanCuentasDesdeXubio + descubrirCuentasOrigenXubio del Apps Script). Solo lee Xubio.

import type { Config } from '@netlify/functions'
import { exigirRol, json, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { cargarCatalogosXubio } from './lib/xubio-catalogos'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'ADMINISTRACION', 'ADMIN')
  return json({ ok: true, log: await cargarCatalogosXubio(supabaseAdmin()) })
})

export const config: Config = { path: '/api/xubio/catalogos' }
