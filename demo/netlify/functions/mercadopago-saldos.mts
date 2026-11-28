// Mercado Pago por API, programado: lunes a viernes a las 8:40 (Buenos Aires) lee los informes de liberaciones que Mercado Pago
// ya generó y los carga en la cuenta de Mercado Pago de cada empresa (movimientos y saldo de cierre de cada día). SOLO LECTURA:
// no pide informes nuevos ni mueve plata. Reemplaza a leerMercadoPago_ del Apps Script (ConectorFlujoV2.js).
// Token por variable de entorno: MERCADOPAGO_TOKEN_<EMPRESA> (o MERCADOPAGO_TOKEN con una sola cuenta de Mercado Pago).
// Sin token no hace nada y lo avisa (en el log de la función y en procesos_log). Feriados: no corre (es_dia_habil).
// Una corrida por organización a la vez (tomar_bloqueo).

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { hoyBuenosAires } from './lib/control-diario'
import { leerMercadoPago } from './lib/mercadopago'
import { conBloqueo } from './lib/xubio-ida-vuelta'

export default async () => {
  const db = supabaseAdmin()
  const { data: habil, error } = await db.rpc('es_dia_habil', { p_fecha: hoyBuenosAires() })
  if (error) return console.error('Mercado Pago: no se pudo saber si hoy es hábil:', error.message)
  if (habil !== true) return
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Mercado Pago: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacionId of organizaciones) {
    try {
      const r = await conBloqueo(db, `mercadopago:${organizacionId}`, () => leerMercadoPago(db, { organizacionId }))
      if (!r) {
        console.log(`Mercado Pago (organización ${organizacionId}): hay otra corrida en curso`)
        continue
      }
      if (r.lineas.length) console.log(`Mercado Pago (organización ${organizacionId}):\n` + r.lineas.join('\n'))
    } catch (e) {
      console.error(`Mercado Pago (organización ${organizacionId}):`, e instanceof Error ? e.message : e)
    }
  }
}

// 11:40 UTC = 8:40 en Buenos Aires (UTC−3, sin horario de verano), después de la lectura de Xubio (8:20).
export const config: Config = { schedule: '40 11 * * 1-5' }
