// POST /api/xubio/bancos  { enSeco?: boolean }
// Corrida manual de los envíos bancarios a Xubio (la misma que la programada xubio-bancos-pendientes),
// solo sobre las empresas que ve quien la pide. Envía de verdad solo si XUBIO_BANCOS_ENVIO_REAL=true y
// no se pidió enSeco; si no, es una prueba en seco: no cambia ningún estado y deja todo en los registros.

import type { Config } from '@netlify/functions'
import { empresasVisibles, exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { envioRealBancos, procesarPendientesBancos } from './lib/xubio-bancos'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'ADMINISTRACION', 'ADMIN')
  const b = await leerJson<{ enSeco?: boolean }>(req).catch(() => ({}) as { enSeco?: boolean })
  const r = await procesarPendientesBancos(supabaseAdmin(), {
    organizacionId: u.organizacionId,
    empresas: await empresasVisibles(u),
    real: envioRealBancos() && b.enSeco !== true,
    usuario: u.nombre,
    presupuestoMs: 8_000,
  })
  return json({ ok: true, ...r })
})

export const config: Config = { path: '/api/xubio/bancos' }
