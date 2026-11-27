// Cada hora marca como pagadas las facturas "para pagar" que ya tienen su pago cargado, como sincronizarFacturasPagadasAplicar
// del Apps Script: cruza por proveedor y número de factura (no consulta a Xubio). Corre en la base (sincronizar_facturas_pagadas).
// Recorre organización por organización. No toca lo que gobierna la hoja ni los pagos ya vinculados.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { conBloqueo, sincronizarFacturasPagadas } from './lib/xubio-ida-vuelta'

export default async () => {
  const db = supabaseAdmin()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Facturas pagadas: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacionId of organizaciones) {
    try {
      const r = await conBloqueo(db, `sincronizar-facturas-pagadas:${organizacionId}`, () => sincronizarFacturasPagadas(db, { organizacionId }))
      if (!r) {
        console.log(`Facturas pagadas (organización ${organizacionId}): hay otra corrida en curso`)
        continue
      }
      if (r.cambios.length || r.manual.length) console.log(`Facturas pagadas (organización ${organizacionId}): ${r.cambios.length} marcadas, ${r.manual.length} para revisar a mano`)
    } catch (e) {
      console.error(`Facturas pagadas (organización ${organizacionId}):`, e)
    }
  }
}

// En punto de cada hora (UTC y Buenos Aires coinciden en los minutos).
export const config: Config = { schedule: '0 * * * *' }
