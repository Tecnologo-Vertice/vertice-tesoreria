// /api/robot-echeqs   clave: ROBOT_ECHEQS_CLAVE (encabezado x-robot-token, Bearer o ?token=)
// Es la API que usa el robot de la PC (e-cheqs y débitos) y que hoy da el proyecto aparte "Robot e-cheqs API" del Apps Script.
// Mismas acciones y mismo formato de respuesta (ver lib/robot-echeqs.ts). No escribe en Xubio: el que lo hace es el robot.
// Con ROBOT_ECHEQS_ENVIO_REAL distinto de "true" las corridas se le entregan siempre como prueba.

import type { Config } from '@netlify/functions'
import { supabaseAdmin } from './lib/comun'
import { atenderRobot } from './lib/robot-echeqs'

export default async (req: Request) =>
  atenderRobot(req, supabaseAdmin, { clave: process.env.ROBOT_ECHEQS_CLAVE, envioReal: process.env.ROBOT_ECHEQS_ENVIO_REAL === 'true' })

export const config: Config = { path: '/api/robot-echeqs' }
