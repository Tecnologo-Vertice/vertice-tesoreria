// POST /api/xubio/catalogos — Administración trae el plan de cuentas y las cuentas de origen de Xubio.
// (cargarPlanCuentasDesdeXubio + descubrirCuentasOrigenXubio del Apps Script). Solo lee Xubio, y solo
// el de las empresas que ve quien lo pide. La lectura de todas la hace la versión programada.

import type { Config } from '@netlify/functions'
import { empresasVisibles, exigirRol, json, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { cargarCatalogosXubio } from './lib/xubio-catalogos'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'ADMINISTRACION', 'ADMIN')
  return json({ ok: true, log: await cargarCatalogosXubio(supabaseAdmin(), u.organizacionId, await empresasVisibles(u)) })
})

export const config: Config = { path: '/api/xubio/catalogos' }
