// POST /api/xubio/credenciales  { empresaId, clientId, secret }
// Alta o reemplazo de las credenciales de Xubio de una empresa en la base (tabla conexiones_erp, 0021).
// Solo ADMIN y solo para una empresa que ve. Prueba la credencial pidiendo un token a Xubio (no escribe
// nada en Xubio), la cifra con CREDENCIALES_CLAVE y la guarda. Sin esa variable se rechaza y todo sigue
// con XUBIO_CREDS_JSON. La credencial no vuelve en la respuesta ni se escribe en ningún registro.
// Todavía no hay pantalla (grupo K): cómo llamarla está en agentes/05-construccion/entregables/TANDA_C.md.

import type { Config } from '@netlify/functions'
import { exigirEmpresa, exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde, ErrorHttp } from './lib/comun'
import { guardarCredencialesXubio } from './lib/xubio'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'ADMIN')
  const b = await leerJson<{ empresaId?: string; clientId?: string; secret?: string }>(req)
  if (!b.empresaId) throw new ErrorHttp(400, 'Falta empresaId')
  await exigirEmpresa(u, b.empresaId)
  const r = await guardarCredencialesXubio(supabaseAdmin(), { empresaId: b.empresaId, clientId: b.clientId ?? '', secret: b.secret ?? '', usuario: u.email })
  return json({ ok: true, empresa: b.empresaId, pista: r.pista, verificadoEn: r.verificadoEn })
})

export const config: Config = { path: '/api/xubio/credenciales' }
