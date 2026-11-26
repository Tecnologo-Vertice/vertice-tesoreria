// Mail del control diario de bancos (reemplaza Control_Diario_Bancos). Lee la vista control_bancos de cada
// organización, arma un HTML simple (una tabla por empresa, ordenada por gravedad), lo registra en
// control_envios (uno por organización y día: la base lo exige con su clave única) y lo manda.
//
// Proveedor de mail: el repo no tiene ninguno (docs/07 lo deja abierto entre Gmail API y Resend).
// PENDIENTE DE FIRMA: el envío queda detrás de EnviadorMail y, sin proveedor, no se manda nada.
// Modo en seco por defecto: CONTROL_DIARIO_ENVIO_REAL=true para mandar (y además hace falta un proveedor).

import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from './comun'
import { registrarProceso } from './xubio-bancos'

export interface Mail {
  para: string[]
  asunto: string
  html: string
}
export interface EnviadorMail {
  nombre: string
  enviar(m: Mail): Promise<{ id?: string }>
}

/** PENDIENTE DE FIRMA: elegir proveedor (Gmail API con la cuenta de Tesorería o Resend). Hasta entonces, ninguno. */
export function enviadorConfigurado(): EnviadorMail | null {
  return null
}

export const envioRealControl = () => env('CONTROL_DIARIO_ENVIO_REAL', false) === 'true'

/** Roles que reciben el control. Supuesto: Controller, Tesorería y Admin de la organización. */
export const ROLES_DESTINATARIOS = ['CONTROLLER', 'TESORERIA', 'ADMIN']

export interface Hallazgo {
  empresa_id: string
  control: string
  sujeto: string | null
  fecha: string | null
  detalle: string | null
  importe: number | null
  gravedad: number
}

/** Fecha de hoy en Buenos Aires (AAAA-MM-DD). */
export function hoyBuenosAires(ahora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora)
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
const pesos = (n: number | null) => (n == null ? '' : new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(n)))
const ddmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

const NOMBRE_CONTROL: Record<string, string> = {
  FALTA_EXTRACTO: 'Falta el extracto',
  DIFERENCIA: 'Diferencia de conciliación',
  A_REVISAR: 'Movimiento sin clasificar',
  COMPROBANTE_ERROR: 'Comprobante con error en Xubio',
  COMPROBANTE_PENDIENTE: 'Comprobante pendiente',
  ANULAR_EN_XUBIO: 'Anulación pendiente en Xubio',
  ASIENTO_ERROR: 'Asiento con error en Xubio',
  FLUJO_F: 'Control del Flujo en F',
  CHEQUE_SIN_MARCAR: 'Cheque sin marcar',
}

export function armarMailControl(fecha: string, empresas: Record<string, string>, hallazgos: Hallazgo[]): { asunto: string; html: string } {
  const urgentes = hallazgos.filter((h) => Number(h.gravedad) === 1).length
  const asunto = hallazgos.length
    ? `Control diario de bancos ${ddmm(fecha)} · ${hallazgos.length} pendiente${hallazgos.length === 1 ? '' : 's'}${urgentes ? ` (${urgentes} urgente${urgentes === 1 ? '' : 's'})` : ''}`
    : `Control diario de bancos ${ddmm(fecha)} · sin pendientes`
  const td = 'style="border:1px solid #ccc;padding:4px 8px;font-size:13px"'
  const partes = [`<div style="font-family:Arial,sans-serif"><h2 style="font-size:16px">Control diario de bancos · ${esc(ddmm(fecha))}</h2>`]
  if (!hallazgos.length) partes.push('<p>Todo en orden: no hay extractos faltantes, diferencias ni pendientes con Xubio.</p>')
  const porEmpresa = new Map<string, Hallazgo[]>()
  for (const h of hallazgos) porEmpresa.set(h.empresa_id, [...(porEmpresa.get(h.empresa_id) ?? []), h])
  for (const [empresaId, lista] of [...porEmpresa].sort((a, b) => (empresas[a[0]] ?? a[0]).localeCompare(empresas[b[0]] ?? b[0]))) {
    lista.sort((a, b) => Number(a.gravedad) - Number(b.gravedad) || String(a.fecha ?? '').localeCompare(String(b.fecha ?? '')))
    partes.push(`<h3 style="font-size:14px;margin-top:18px">${esc(empresas[empresaId] ?? empresaId)}</h3>`)
    partes.push(`<table style="border-collapse:collapse"><tr><th ${td}>Gravedad</th><th ${td}>Control</th><th ${td}>Cuenta / sujeto</th><th ${td}>Fecha</th><th ${td}>Detalle</th><th ${td}>Importe</th></tr>`)
    for (const h of lista)
      partes.push(
        `<tr><td ${td}>${Number(h.gravedad) === 1 ? '<b style="color:#b00020">Urgente</b>' : 'Revisar'}</td><td ${td}>${esc(NOMBRE_CONTROL[h.control] ?? h.control)}</td>` +
          `<td ${td}>${esc(h.sujeto)}</td><td ${td}>${esc(ddmm(h.fecha))}</td><td ${td}>${esc(h.detalle)}</td><td ${td} align="right">${esc(pesos(h.importe))}</td></tr>`,
      )
    partes.push('</table>')
  }
  partes.push('<p style="color:#666;font-size:12px">Generado por el sistema de Tesorería a partir de la vista control_bancos.</p></div>')
  return { asunto, html: partes.join('\n') }
}

export interface OpcionesControl {
  organizacionId: string
  real: boolean
  enviador: EnviadorMail | null
  ahora?: Date
}

export interface ResultadoControl {
  estado: 'OK' | 'PRUEBA_OK' | 'OMITIDO' | 'ERROR'
  detalle: string
  hallazgos?: number
  asunto?: string
}

export async function enviarControlDiario(db: SupabaseClient, o: OpcionesControl): Promise<ResultadoControl> {
  const fecha = hoyBuenosAires(o.ahora)
  const fin = async (r: ResultadoControl, datos?: unknown): Promise<ResultadoControl> => {
    await registrarProceso(db, { organizacionId: o.organizacionId, proceso: 'CONTROL_DIARIO', real: o.real, entidad: 'CONTROL_ENVIO', entidadId: fecha, estado: r.estado, detalle: r.detalle, datos })
    return r
  }

  const { data: habil, error: eHab } = await db.rpc('es_dia_habil', { p_fecha: fecha })
  if (eHab) return fin({ estado: 'ERROR', detalle: `No se pudo saber si ${fecha} es hábil: ${eHab.message}` })
  if (habil !== true) return fin({ estado: 'OMITIDO', detalle: `${fecha} no es día hábil` })

  const { data: ya, error: eYa } = await db.from('control_envios').select('id').eq('organizacion_id', o.organizacionId).eq('fecha', fecha)
  if (eYa) return fin({ estado: 'ERROR', detalle: `No se pudo leer control_envios: ${eYa.message}` })
  if (ya?.length) return fin({ estado: 'OMITIDO', detalle: `El control del ${fecha} ya se envió` })

  const { data: emps, error: eEmp } = await db.from('empresas').select('id, nombre').eq('organizacion_id', o.organizacionId)
  if (eEmp) return fin({ estado: 'ERROR', detalle: `No se pudieron leer las empresas: ${eEmp.message}` })
  const nombres = Object.fromEntries((emps ?? []).map((e) => [String(e.id), String(e.nombre)]))
  const ids = Object.keys(nombres)
  if (!ids.length) return fin({ estado: 'OMITIDO', detalle: 'La organización no tiene empresas' })

  const { data: filas, error: eCtl } = await db.from('control_bancos').select('empresa_id, control, sujeto, fecha, detalle, importe, gravedad').in('empresa_id', ids)
  if (eCtl) return fin({ estado: 'ERROR', detalle: `No se pudo leer control_bancos: ${eCtl.message}` })
  const hallazgos = (filas ?? []) as Hallazgo[]

  const { data: us, error: eUs } = await db.from('usuarios').select('email, rol').eq('organizacion_id', o.organizacionId).eq('activo', true).in('rol', ROLES_DESTINATARIOS)
  if (eUs) return fin({ estado: 'ERROR', detalle: `No se pudieron leer los destinatarios: ${eUs.message}` })
  const para = [...new Set((us ?? []).map((u) => String(u.email).toLowerCase()).filter(Boolean))].sort()

  const { asunto, html } = armarMailControl(fecha, nombres, hallazgos)
  const resumen = { hallazgos: hallazgos.length, asunto }
  if (!para.length) return fin({ estado: 'OMITIDO', detalle: 'No hay destinatarios activos (Controller, Tesorería o Admin)', ...resumen })

  if (!o.real) return fin({ estado: 'PRUEBA_OK', detalle: `En seco: se mandaría "${asunto}" a ${para.length} destinatario(s)`, ...resumen }, { para, html })
  if (!o.enviador) return fin({ estado: 'OMITIDO', detalle: 'Sin proveedor de mail (decisión PENDIENTE DE FIRMA): no se envió', ...resumen }, { para })

  // Reserva del día: la clave única (organización, fecha) impide un segundo envío aunque corran dos a la vez.
  const { error: eIns } = await db.from('control_envios').insert({ organizacion_id: o.organizacionId, fecha, destinatarios: para, hallazgos })
  if (eIns) {
    if (eIns.code === '23505') return fin({ estado: 'OMITIDO', detalle: `El control del ${fecha} ya se envió (otra corrida)`, ...resumen })
    return fin({ estado: 'ERROR', detalle: `No se pudo registrar el envío: ${eIns.message}`, ...resumen })
  }
  try {
    const r = await o.enviador.enviar({ para, asunto, html })
    return fin({ estado: 'OK', detalle: `Enviado por ${o.enviador.nombre} a ${para.length} destinatario(s)`, ...resumen }, { para, mensaje_id: r.id ?? null })
  } catch (e) {
    // No salió: se libera la reserva para poder reintentar el mismo día.
    await db.from('control_envios').delete().eq('organizacion_id', o.organizacionId).eq('fecha', fecha)
    return fin({ estado: 'ERROR', detalle: `${o.enviador.nombre} no lo envió: ${e instanceof Error ? e.message : String(e)}`, ...resumen })
  }
}
