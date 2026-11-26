// Todos los lunes a las 6:17 (UTC) vuelve a leer de Xubio el plan de cuentas y las cuentas de origen.
// Recorre organización por organización (las activas): si una falla, las demás siguen.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { cargarCatalogosXubio } from './lib/xubio-catalogos'

export default async () => {
  const db = supabaseAdmin()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Catálogos de Xubio: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacion of organizaciones) {
    try {
      console.log(`Catálogos de Xubio (organización ${organizacion}):\n` + (await cargarCatalogosXubio(db, organizacion)).join('\n'))
    } catch (e) {
      console.error(`Catálogos de Xubio (organización ${organizacion}):`, e)
    }
  }
}

export const config: Config = { schedule: '17 6 * * 1' }
