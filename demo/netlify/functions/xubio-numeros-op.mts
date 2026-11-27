// Todos los días a las 9 y a las 14 (Buenos Aires) busca en Xubio el N° de orden de pago de los pagos contabilizados que
// todavía no lo tienen, como completarNumerosOPDesdeXubio del Apps Script. Solo LEE de Xubio; guarda el número en la base.
// Recorre organización por organización (las activas). Si hay varias OP posibles para un pago, no elige: se carga a mano.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { completarNumerosOP, conBloqueo } from './lib/xubio-ida-vuelta'

export default async () => {
  const db = supabaseAdmin()
  const inicio = Date.now()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('N° de OP desde Xubio: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacionId of organizaciones) {
    const resta = 25_000 - (Date.now() - inicio)
    if (resta < 3_000) break
    try {
      const r = await conBloqueo(db, `xubio-numeros-op:${organizacionId}`, () => completarNumerosOP(db, { organizacionId, presupuestoMs: resta - 2_000 }))
      if (!r) {
        console.log(`N° de OP desde Xubio (organización ${organizacionId}): hay otra corrida en curso`)
        continue
      }
      console.log(`N° de OP desde Xubio (organización ${organizacionId}):\n` + r.lineas.join('\n'))
    } catch (e) {
      console.error(`N° de OP desde Xubio (organización ${organizacionId}):`, e)
    }
  }
}

// 12:00 y 17:00 UTC = 9:00 y 14:00 en Buenos Aires (UTC−3, sin horario de verano). Todos los días, como el Apps Script.
export const config: Config = { schedule: '0 12,17 * * *' }
