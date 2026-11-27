// Lunes a viernes a las 8:30 (Buenos Aires) trae de Xubio las cobranzas de los últimos 5 días (hasta ayer) y las guarda en la
// tabla de cobros, como cbxCobranzasDiaria del Apps Script. Solo LEE de Xubio. Recorre organización por organización.
// Lo que ya estaba no se repite (clave: empresa + transacción + instrumento de cobro).

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { conBloqueo, traerCobranzasXubio } from './lib/xubio-ida-vuelta'

export default async () => {
  const db = supabaseAdmin()
  const inicio = Date.now()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Cobranzas de Xubio: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacionId of organizaciones) {
    const resta = 25_000 - (Date.now() - inicio)
    if (resta < 3_000) break
    try {
      const r = await conBloqueo(db, `xubio-cobranzas:${organizacionId}`, () => traerCobranzasXubio(db, { organizacionId, presupuestoMs: resta - 2_000 }))
      if (!r) {
        console.log(`Cobranzas de Xubio (organización ${organizacionId}): hay otra corrida en curso`)
        continue
      }
      console.log(`Cobranzas de Xubio (organización ${organizacionId}):\n` + r.lineas.join('\n'))
    } catch (e) {
      console.error(`Cobranzas de Xubio (organización ${organizacionId}):`, e)
    }
  }
}

// 11:30 UTC = 8:30 en Buenos Aires (UTC−3, sin horario de verano). Sábado y domingo no hace nada, como el Apps Script.
export const config: Config = { schedule: '30 11 * * 1-5' }
