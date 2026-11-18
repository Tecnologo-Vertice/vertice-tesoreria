// Todos los lunes a las 6:17 (UTC) vuelve a leer de Xubio el plan de cuentas y las cuentas de origen.

import type { Config } from '@netlify/functions'
import { supabaseAdmin } from './lib/comun'
import { cargarCatalogosXubio } from './lib/xubio-catalogos'

export default async () => {
  try {
    console.log('Catálogos de Xubio:\n' + (await cargarCatalogosXubio(supabaseAdmin())).join('\n'))
  } catch (e) {
    console.error('Catálogos de Xubio:', e)
  }
}

export const config: Config = { schedule: '17 6 * * 1' }
