// POST /api/documentos/leer
// Lee lo que haya en la cola sin esperar al lector programado (y en local, donde no corre).
// Presupuesto corto: Netlify corta a los 10 s; lo que no llegue, lo termina el lector.

import type { Config } from '@netlify/functions'
import { json, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { leerCola } from './lib/entrada'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  const db = supabaseAdmin()
  const resultados = await leerCola(db, 3_000)
  // La cola mezcla empresas: el detalle solo para quien ve todas; al resto, cuántos se leyeron.
  const { data: todas } = await db.from('usuarios').select('todas_empresas').eq('email', u.email).maybeSingle()
  return json({ ok: true, resultados: todas?.todas_empresas ? resultados : resultados.map(() => ({})) })
})

export const config: Config = { path: '/api/documentos/leer' }
