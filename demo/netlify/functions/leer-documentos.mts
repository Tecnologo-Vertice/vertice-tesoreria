// Lector programado: cada 2 minutos lee con la IA los documentos que esperan en la cola.
// Netlify corta las funciones programadas a los 30 s; con 15 s de presupuesto, el documento que
// esté leyendo al cumplirse el plazo todavía tiene margen para terminar.
// Recorre las organizaciones activas por turnos (un documento de cada una por vez).
// Solo corre en el sitio publicado. En local: `netlify functions:invoke leer-documentos`.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { leerColaPorOrganizacion } from './lib/entrada'

export default async () => {
  try {
    const db = supabaseAdmin()
    const resultados = await leerColaPorOrganizacion(db, 15_000, await organizacionesActivas(db))
    if (resultados.length) console.log('Lector de facturas:', JSON.stringify(resultados))
  } catch (e) {
    console.error('Lector de facturas falló:', e)
  }
}

export const config: Config = { schedule: '*/2 * * * *' }
