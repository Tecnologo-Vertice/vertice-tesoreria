// POST /api/documentos/leer
// Lee lo que haya en la cola sin esperar al lector programado (y en local, donde no corre).
// Presupuesto corto: Netlify corta a los 10 s; lo que no llegue, lo termina el lector.
// Quien ve todas las empresas lee toda la cola. El resto, solo lo que se subió para sus empresas:
// lo que llega por Gmail o Drive puede ser de cualquiera y lo lee el lector programado.

import type { Config } from '@netlify/functions'
import { empresasVisibles, json, manejar, supabaseAdmin, usuarioDesde } from './lib/comun'
import { leerCola } from './lib/entrada'

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  const db = supabaseAdmin()
  if (u.todasEmpresas) return json({ ok: true, resultados: await leerCola(db, 3_000) })
  const resultados = await leerCola(db, 3_000, await empresasVisibles(u))
  // A quien no ve todas se le devuelve cuántos se leyeron, sin el detalle (como hasta ahora).
  return json({ ok: true, resultados: resultados.map(() => ({})) })
})

export const config: Config = { path: '/api/documentos/leer' }
