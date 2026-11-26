// Plan de cuentas y cuentas de origen leídos directo de Xubio, como cargarPlanCuentasDesdeXubio y
// descubrirCuentasOrigenXubio del Apps Script (XubioPagos.gs). Solo lectura en Xubio; en la base se
// guardan con espejar_catalogos (actualiza o agrega, nunca borra: si una empresa falla, queda lo que había).

import type { SupabaseClient } from '@supabase/supabase-js'
import { credencialesDe, get, token, TOPE_XUBIO_LARGO_MS, type Token } from './xubio'
import { cuentasDesdeXubio, origenDesdePagos, type CuentaXubio, type PagoXubio } from './xubio-catalogos-armado'

const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Lee Xubio de cada empresa con credenciales y guarda. Devuelve una línea por empresa (como el log del Apps Script).
 * `soloEmpresas`: cuando lo pide una persona, las empresas que ve. Sin lista (tarea programada), todas.
 */
export async function cargarCatalogosXubio(db: SupabaseClient, soloEmpresas?: string[]): Promise<string[]> {
  const consulta = db.from('empresas').select('id, nombre, erp').eq('erp', 'XUBIO').eq('activa', true)
  const { data: empresas, error } = await (soloEmpresas ? consulta.in('id', soloEmpresas) : consulta)
  if (error) throw new Error(error.message)
  const log: string[] = []
  const cuentas: ReturnType<typeof cuentasDesdeXubio> = []
  const origen: ReturnType<typeof origenDesdePagos> = []
  const hasta = new Date()
  const desde = new Date(hasta.getTime() - 180 * 86_400_000)
  for (const e of empresas ?? []) {
    const cred = credencialesDe(e.id)
    if (!cred) { log.push(`${e.nombre}: sin credenciales de Xubio, se conserva lo que había`); continue }
    let t: Token
    try { t = await token(cred) } catch (err) { log.push(`${e.nombre}: sin conexión (${String(err instanceof Error ? err.message : err).slice(0, 120)})`); continue }
    try {
      const c = cuentasDesdeXubio(await get<CuentaXubio[]>(t, 'cuenta', 'activo=1'), e.id)
      if (!c.length) throw new Error('Xubio no devolvió cuentas')
      cuentas.push(...c)
      log.push(`${e.nombre}: ${c.length} cuentas`)
    } catch (err) { log.push(`${e.nombre}: no se pudo leer el plan (${String(err instanceof Error ? err.message : err).slice(0, 120)}), se conserva el que había`) }
    try {
      const o = origenDesdePagos(await get<PagoXubio[]>(t, 'pagoBean', `fechaDesde=${iso(desde)}&fechaHasta=${iso(hasta)}`, TOPE_XUBIO_LARGO_MS), e.id)
      origen.push(...o)
      log.push(`${e.nombre}: ${o.length} cuentas de origen usadas en 180 días`)
    } catch (err) { log.push(`${e.nombre}: no se pudieron leer los pagos (${String(err instanceof Error ? err.message : err).slice(0, 120)})`) }
  }
  if (cuentas.length || origen.length) {
    const { error: e2 } = await db.rpc('espejar_catalogos', { p: { cuentas, origen } })
    if (e2) throw new Error(e2.message)
  }
  return log
}
