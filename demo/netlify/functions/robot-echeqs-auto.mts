// Corridas automáticas del robot de e-cheqs: 13 y 17 h de Buenos Aires, días hábiles (robotAutomatico13 y robotAutomatico17 del Apps Script).
// Solo deja el pedido en la base; el robot de la PC lo toma. No escribe afuera. Pide en REAL solo con ROBOT_ECHEQS_ENVIO_REAL="true";
// si no, pide en prueba. Los feriados los resuelve la base (robot_pedir_automatica usa es_dia_habil con hoy_ar()).

import type { Config } from '@netlify/functions'
import { supabaseAdmin } from './lib/comun'
import { pedirCorridasAutomaticas } from './lib/robot-echeqs'

export default async () => {
  const db = supabaseAdmin()
  try {
    // Solo la organización a la que el robot le da servicio (la proveedora): las demás no tienen una PC con el robot.
    const { data: org, error } = await db.rpc('robot_organizacion')
    if (error) throw new Error(error.message)
    const organizaciones = [String(org)]
    const r = await pedirCorridasAutomaticas(db, organizaciones, new Date(), process.env.ROBOT_ECHEQS_ENVIO_REAL === 'true')
    for (const x of r) console.log(`Robot e-cheqs automático (organización ${x.organizacion}): ${x.pedida ? 'corrida pedida' : 'no se pidió: ' + (x.motivo ?? '')}`)
  } catch (e) {
    console.error('Robot e-cheqs automático:', e)
  }
}

// 16:00 y 20:00 UTC = 13:00 y 17:00 en Buenos Aires (UTC−3, sin horario de verano). Lunes a viernes; los feriados los descarta la base.
export const config: Config = { schedule: '0 16,20 * * 1-5' }
