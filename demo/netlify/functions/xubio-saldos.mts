// Lunes a viernes a las 8:20 (Buenos Aires) lee de Xubio el saldo de cada cuenta y lo guarda en lecturas_xubio con la fecha del
// día hábil anterior (Xubio llega hasta ese día), para que Bancos compare contra el extracto. Solo LEE de Xubio.
// Solo se guardan las cuentas que se emparejan con una cuenta bancaria por los dígitos del nombre.
// Los feriados no corren (es_dia_habil), igual que los envíos bancarios.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { hoyBuenosAires } from './lib/control-diario'
import { conBloqueo, leerSaldosXubio } from './lib/xubio-ida-vuelta'

export default async () => {
  const db = supabaseAdmin()
  const inicio = Date.now()
  const { data: habil, error } = await db.rpc('es_dia_habil', { p_fecha: hoyBuenosAires() })
  if (error) return console.error('Saldo de Xubio: no se pudo saber si hoy es hábil:', error.message)
  if (habil !== true) return
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Saldo de Xubio: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacionId of organizaciones) {
    const resta = 25_000 - (Date.now() - inicio)
    if (resta < 3_000) break
    try {
      const r = await conBloqueo(db, `xubio-saldos:${organizacionId}`, () => leerSaldosXubio(db, { organizacionId, presupuestoMs: resta - 2_000 }))
      if (!r) {
        console.log(`Saldo de Xubio (organización ${organizacionId}): hay otra corrida en curso`)
        continue
      }
      console.log(`Saldo de Xubio (organización ${organizacionId}, al ${r.fecha}):\n` + r.lineas.join('\n'))
    } catch (e) {
      console.error(`Saldo de Xubio (organización ${organizacionId}):`, e)
    }
  }
}

// 11:20 UTC = 8:20 en Buenos Aires (UTC−3, sin horario de verano).
export const config: Config = { schedule: '20 11 * * 1-5' }
