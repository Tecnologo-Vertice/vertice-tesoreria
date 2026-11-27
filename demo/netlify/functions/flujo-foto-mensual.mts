// Foto mensual de la proyección del Flujo (sacarFotoProyeccionMes del Apps Script, activador diario a las 10:00).
// Todos los días a las 10:00 de Buenos Aires (13:00 UTC, Argentina no cambia de hora): por cada organización activa y
// cada unidad, saca la foto del mes si todavía no hay una (la base decide con hoy_ar(): si ya hay foto del mes contesta
// "Ya hay foto de MM/AAAA" y no toca nada). En la práctica actúa el primer día del mes; si ese día falló, el siguiente.
// Organización por organización: si una falla, las demás siguen.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'

export default async () => {
  const db = supabaseAdmin()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Foto del Flujo: no se pudieron leer las organizaciones:', e)
  }
  for (const organizacion of organizaciones) {
    try {
      const { data, error } = await db.rpc('sacar_fotos_flujo', { p_organizacion: organizacion, p_forzar: false })
      if (error) throw new Error(error.message)
      const r = (data ?? []) as { unidad: string; resultado: string }[]
      console.log(`Foto del Flujo (organización ${organizacion}): ` + (r.map((x) => `${x.unidad}: ${x.resultado}`).join(' · ') || 'sin unidades'))
    } catch (e) {
      console.error(`Foto del Flujo (organización ${organizacion}):`, e)
    }
  }
}

// 10:00 de Argentina = 13:00 UTC.
export const config: Config = { schedule: '0 13 * * *' }
