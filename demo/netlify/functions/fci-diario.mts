// FCI, programado: lunes a viernes a las 9:30 (Buenos Aires), como el Flujo del Apps Script (syncFciCapitalVBI_).
// Completa en la base el fondo de cada suscripción o rescate de la cuenta madre (sincronizar_capital_fci), para que el
// rendimiento del día y el Flujo no cuenten el capital como rendimiento. No toca Xubio ni nada externo.
// Feriados: no corre (es_dia_habil). Una corrida por organización a la vez (tomar_bloqueo).

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { hoyBuenosAires } from './lib/control-diario'
import { sincronizarCapitalFci } from './lib/fci'
import { conBloqueo } from './lib/xubio-ida-vuelta'

export default async () => {
  const db = supabaseAdmin()
  const { data: habil, error } = await db.rpc('es_dia_habil', { p_fecha: hoyBuenosAires() })
  if (error) return console.error('FCI: no se pudo saber si hoy es hábil:', error.message)
  if (habil !== true) return
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('FCI: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacionId of organizaciones) {
    try {
      const r = await conBloqueo(db, `fci-diario:${organizacionId}`, () => sincronizarCapitalFci(db, organizacionId))
      if (!r) {
        console.log(`FCI (organización ${organizacionId}): hay otra corrida en curso`)
        continue
      }
      console.log(`FCI (organización ${organizacionId}):\n` + r.lineas.join('\n'))
    } catch (e) {
      console.error(`FCI (organización ${organizacionId}):`, e instanceof Error ? e.message : e)
    }
  }
}

// 12:30 UTC = 9:30 en Buenos Aires (UTC−3, sin horario de verano).
export const config: Config = { schedule: '30 12 * * 1-5' }
