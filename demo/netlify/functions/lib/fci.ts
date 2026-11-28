// FCI diario: completa el fondo (contraparte) de las suscripciones y rescates de la cuenta madre y clasifica los intereses de la
// remunerada que quedaron "A revisar". La lógica está en la base (sincronizar_capital_fci y clasificar_intereses_remunerada, 0040);
// acá solo se recorren las empresas de la organización y se deja el resultado en procesos_log.
// Lo que sigue igual de un día para otro (suscripciones con más de un fondo, que elige Tesorería) se muestra pero no se vuelve a registrar.

import type { SupabaseClient } from '@supabase/supabase-js'
import { registrarProceso } from './xubio-bancos'

export interface ResultadoFci {
  lineas: string[]
  asignados: number
  soltados: number
  dudosos: number
  intereses: number
}

export async function sincronizarCapitalFci(db: SupabaseClient, organizacionId: string): Promise<ResultadoFci> {
  const r: ResultadoFci = { lineas: [], asignados: 0, soltados: 0, dudosos: 0, intereses: 0 }
  const { data, error } = await db.from('empresas').select('id, nombre').eq('organizacion_id', organizacionId)
  if (error) throw new Error(`No se pudieron leer las empresas: ${error.message}`)
  for (const e of data ?? []) {
    const empresaId = String(e.id)
    const fallo = async (d: string) => {
      r.lineas.push(`${e.nombre}: ${d}`)
      await registrarProceso(db, { organizacionId, empresaId, proceso: 'CONTROL_DIARIO', real: true, entidad: 'FCI_CAPITAL', estado: 'ERROR', detalle: d })
    }
    const { data: res, error: eRpc } = await db.rpc('sincronizar_capital_fci', { p_empresa: empresaId })
    if (eRpc) {
      await fallo(`no se pudo sincronizar el capital del FCI (${eRpc.message})`)
      continue
    }
    const x = (res ?? {}) as { asignados?: number; soltados?: number; dudosos?: number }
    const asignados = Number(x.asignados ?? 0)
    const soltados = Number(x.soltados ?? 0)
    const dudosos = Number(x.dudosos ?? 0)
    const { data: ni, error: eInt } = await db.rpc('clasificar_intereses_remunerada', { p_empresa: empresaId })
    if (eInt) await fallo(`no se pudieron clasificar los intereses de la remunerada (${eInt.message})`)
    const intereses = eInt ? 0 : Number(ni ?? 0)
    r.asignados += asignados
    r.soltados += soltados
    r.dudosos += dudosos
    r.intereses += intereses
    const partes = [
      asignados ? `${asignados} suscripciones o rescates con su fondo` : '',
      soltados ? `${soltados} sueltos porque el fondo ya trae su movimiento` : '',
      intereses ? `${intereses} intereses de la remunerada clasificados` : '',
    ].filter(Boolean)
    const aviso = dudosos ? `${dudosos} con más de un fondo posible (los elige Tesorería)` : ''
    if (partes.length || aviso) r.lineas.push(`${e.nombre}: ${[...partes, aviso].filter(Boolean).join('; ')}`)
    // Solo se registra lo que hizo algo: los dudosos de ayer no se anotan de nuevo cada día.
    if (partes.length) await registrarProceso(db, { organizacionId, empresaId, proceso: 'CONTROL_DIARIO', real: true, entidad: 'FCI_CAPITAL', estado: 'OK', detalle: partes.join('; ') })
  }
  if (!r.lineas.length) r.lineas.push('sin novedades')
  return r
}
