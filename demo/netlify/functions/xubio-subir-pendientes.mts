// Subidor programado: cada 10 minutos sube a Xubio las facturas aprobadas que quedaron pendientes
// (por ejemplo, si al aprobar Xubio no respondía). Solo corre con XUBIO_FACTURAS_ENVIO_REAL=true.
// Recorre organización por organización (las activas), hasta 5 facturas de cada una por corrida. Cada
// corrida empieza por una organización distinta, para que ninguna se quede siempre sin tiempo.

import type { Config } from '@netlify/functions'
import { env, organizacionesActivas, supabaseAdmin } from './lib/comun'
import { subirFacturaAXubio } from './lib/xubio-facturas'

export default async () => {
  if (env('XUBIO_FACTURAS_ENVIO_REAL', false) !== 'true') return
  const db = supabaseAdmin()
  const inicio = Date.now()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Subidor Xubio: no se pudieron leer las organizaciones:', e)
  }
  const corrida = Math.floor(inicio / 600_000)
  const orden = organizaciones.map((_, i) => organizaciones[(i + corrida) % organizaciones.length])
  for (const organizacion of orden) {
    if (Date.now() - inicio > 18_000) break
    const { data, error } = await db.rpc('facturas_para_xubio', { p_max: 5, p_organizacion: organizacion })
    if (error) {
      console.error('Subidor Xubio:', organizacion, error.message)
      continue
    }
    for (const f of (data as { id: string; cuenta_origen_extracto_id?: string | null }[]) ?? []) {
      if (Date.now() - inicio > 18_000) break
      // El comprobante "Extracto Bancario" lo sube xubio-bancos-pendientes, con su propio interruptor.
      if (f.cuenta_origen_extracto_id) continue
      try {
        const r = await subirFacturaAXubio(db, f.id, 'Subidor automático')
        console.log('Subidor Xubio:', f.id, r.estado, r.detalle)
      } catch (e) {
        console.error('Subidor Xubio:', f.id, e)
      }
    }
  }
}

export const config: Config = { schedule: '*/10 * * * *' }
