// Mail del control diario de bancos: lunes a viernes a las 8:00 de Buenos Aires (11:00 UTC). Feriados no
// (es_dia_habil). Una vez por organización y día (control_envios). En seco por defecto
// (CONTROL_DIARIO_ENVIO_REAL=true para mandar) y sin proveedor de mail no manda nada: PENDIENTE DE FIRMA.

import type { Config } from '@netlify/functions'
import { organizacionesActivas, supabaseAdmin } from './lib/comun'
import { enviadorConfigurado, enviarControlDiario, envioRealControl } from './lib/control-diario'

export default async () => {
  const db = supabaseAdmin()
  let organizaciones: string[]
  try {
    organizaciones = await organizacionesActivas(db)
  } catch (e) {
    return console.error('Control diario: no se pudieron leer las organizaciones:', e)
  }
  const real = envioRealControl()
  const enviador = enviadorConfigurado()
  for (const organizacionId of organizaciones) {
    try {
      const r = await enviarControlDiario(db, { organizacionId, real, enviador })
      console.log('Control diario:', organizacionId, r.estado, r.detalle)
    } catch (e) {
      console.error('Control diario:', organizacionId, e)
    }
  }
}

export const config: Config = { schedule: '0 11 * * 1-5' }
