// POST /api/documentos/leer
// Lee lo que haya en la cola sin esperar al lector programado (y en local, donde no corre).
// Presupuesto corto: Netlify corta a los 10 s; lo que no llegue, lo termina el lector.

import type { Config } from '@netlify/functions'
import { json, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { leerCola } from './lib/entrada'

export default manejar(async (req) => {
  await usuarioDesde(req)
  const resultados = await leerCola(supabaseAdmin(), 3_000)
  return json({ ok: true, resultados })
})

export const config: Config = { path: '/api/documentos/leer' }
