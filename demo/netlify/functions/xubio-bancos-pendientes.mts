// Envíos bancarios a Xubio, programado: cada 15 minutos de 8 a 19:45 (Buenos Aires) de lunes a viernes,
// sube lo que la base dejó pendiente (comprobantes "Extracto Bancario", asientos del banco) y procesa las
// anulaciones. Solo corre con XUBIO_BANCOS_ENVIO_REAL=true (en seco se usa la corrida manual, POST
// /api/xubio/bancos, para no llenar los registros cada 15 minutos). Feriados: no corre (es_dia_habil).
// Recorre organización por organización; cada corrida empieza por una distinta.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { hoyBuenosAires } from './lib/control-diario'
import { envioRealBancos, procesarPendientesBancos } from './lib/xubio-bancos'

export default async () => {
  if (!envioRealBancos()) return
  const db = supabaseAdmin()
  const inicio = Date.now()
  const { data: habil, error } = await db.rpc('es_dia_habil', { p_fecha: hoyBuenosAires() })
  if (error) return console.error('Envíos bancarios: no se pudo saber si hoy es hábil:', error.message)
  if (habil !== true) return
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Envíos bancarios: no se pudieron leer las organizaciones:', e)
  }
  const corrida = Math.floor(inicio / 900_000)
  const orden = organizaciones.map((_, i) => organizaciones[(i + corrida) % organizaciones.length])
  for (const organizacionId of orden) {
    const resta = 20_000 - (Date.now() - inicio)
    if (resta < 3_000) break
    try {
      const r = await procesarPendientesBancos(db, { organizacionId, real: true, presupuestoMs: resta - 2_000 })
      console.log('Envíos bancarios:', organizacionId, r.omitido ?? `${r.items.length} procesados`, r.items.map((i) => `${i.entidad} ${i.id} ${i.estado}`).join(' · '))
    } catch (e) {
      console.error('Envíos bancarios:', organizacionId, e)
    }
  }
}

// 11:00 a 22:45 UTC = 8:00 a 19:45 en Buenos Aires (UTC−3, sin horario de verano).
export const config: Config = { schedule: '*/15 11-22 * * 1-5' }
