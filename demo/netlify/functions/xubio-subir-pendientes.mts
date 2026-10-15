// Subidor programado: cada 10 minutos sube a Xubio las facturas aprobadas que quedaron pendientes
// (por ejemplo, si al aprobar Xubio no respondía). Solo corre con XUBIO_FACTURAS_ENVIO_REAL=true.

import type { Config } from '@netlify/functions'
import { env, supabaseAdmin } from './lib/comun'
import { subirFacturaAXubio } from './lib/xubio-facturas'

export default async () => {
  if (env('XUBIO_FACTURAS_ENVIO_REAL', false) !== 'true') return
  const db = supabaseAdmin()
  const inicio = Date.now()
  const { data, error } = await db.rpc('facturas_para_xubio', { p_max: 5 })
  if (error) return console.error('Subidor Xubio:', error.message)
  for (const f of (data as { id: string }[]) ?? []) {
    if (Date.now() - inicio > 18_000) break
    try {
      const r = await subirFacturaAXubio(db, f.id, 'Subidor automático')
      console.log('Subidor Xubio:', f.id, r.estado, r.detalle)
    } catch (e) {
      console.error('Subidor Xubio:', f.id, e)
    }
  }
}

export const config: Config = { schedule: '*/10 * * * *' }
