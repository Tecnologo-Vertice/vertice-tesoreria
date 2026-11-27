// Anular por API la orden de pago (o el asiento) que subió el sistema, como xubioAnularAuto_ del Apps Script
// (FlujoCaja.js, 25/11/2026), pero más estricto: allá lo dispara una persona mirando un pago; acá corre solo cada 15 minutos.
//   · solo lo que subió el sistema (el pago tiene que traer su id de Xubio, numérico);
//   · se busca primero como orden de pago y, si no está, como asiento manual (transferencias entre cuentas propias);
//   · antes de borrar se verifica contra el comprobante de Xubio: el importe tiene que ser la SUMA de los instrumentos de la OP
//     (o el debe del asiento), no cualquier número del comprobante; en una OP, el mismo proveedor; y la fecha a ±10 días.
//     Si algo no coincide no se borra: el motivo queda para anularlo a mano.
// Va detrás de XUBIO_ANULAR_ENVIO_REAL (apagada por defecto) y solo toma pagos anulados desde XUBIO_ANULAR_DESDE (ver
// anularDesde): con la variable apagada el servidor sigue como hasta ahora (las órdenes de pago quedan para anular a mano).
// [FALTA confirmar]: que Xubio acepte el DELETE de pagoBean contra Xubio real; el Apps Script lo probó el 25/11/2026
// (probarDeleteXubio) y desde ahí lo usa.
//
// OJO con SALIDA_FONDOS y ASIENTO_MANUAL: con esta variable prendida esos pagos ya no pasan por XUBIO_BORRAR_ASIENTO_CONFIRMADO
// (el freno de xubio-bancos para borrar asientos): se anulan acá, con las verificaciones de arriba. Con la variable apagada
// siguen como antes.

import { env, ErrorHttp } from './comun'
import * as xubio from './xubio'
import { mismoProveedor } from './xubio-nombres'

export const anularOpReal = () => env('XUBIO_ANULAR_ENVIO_REAL', false) === 'true'

/**
 * Desde cuándo se toman las anulaciones (XUBIO_ANULAR_DESDE: fecha "2026-12-01" o con hora). Los pagos anulados antes (el atraso
 * que dejó el backfill de la 0024 y lo que el Apps Script ya anuló) no se tocan. Sin esa variable, la anulación por API no
 * procesa nada. Una fecha sola vale desde las 0:00 de Argentina.
 */
export function anularDesde(): Date | null {
  const v = env('XUBIO_ANULAR_DESDE', false).trim()
  if (!v) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00-03:00` : v)
  return Number.isNaN(d.getTime()) ? null : d
}

export const CAMINOS_ANULAR = [
  { path: 'pagoBean', que: 'orden de pago' },
  { path: 'asientoContableManualBean', que: 'asiento manual' },
] as const

type Fila = Record<string, unknown>
const centavos = (n: number) => Math.round(Number(n) * 100)

/** Lo que la OP de Xubio pagó en total: la suma de sus instrumentos de pago. */
export function importeDeOP(o: unknown): number {
  const items = Array.isArray((o as Fila | null)?.transaccionInstrumentoDePago) ? ((o as Fila).transaccionInstrumentoDePago as Fila[]) : []
  return items.reduce((a, i) => a + (Number(i.importe) || 0), 0)
}

/** El debe del asiento manual (debeHaber = 1). */
export function importeDeAsiento(o: unknown): number {
  const items = Array.isArray((o as Fila | null)?.asientoContableManualItem) ? ((o as Fila).asientoContableManualItem as Fila[]) : []
  return items.filter((i) => Number(i.debeHaber) === 1).reduce((a, i) => a + (Number(i.importe) || 0), 0)
}

export interface DatosAnulacion {
  id: string
  importe: number
  /** Nombre del proveedor del pago: se compara con el de la OP. */
  proveedor?: string
  /** Fecha del pago (AAAA-MM-DD). */
  fecha?: string
}

export interface ResultadoAnulacion {
  ok: boolean
  /** No se pudo ni leer ni borrar por algo pasajero (límite de pedidos, sesión, sin conexión): queda PENDIENTE para la próxima. */
  reintentar?: boolean
  /** Falló al borrar y no se sabe si Xubio lo borró (sin respuesta). */
  sinSaber?: boolean
  que?: string
  /** Solo si se llegó a mandar el DELETE. */
  path?: string
  status?: number
  body?: unknown
  error?: string
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** 401 (sesión), 408 (tiempo) y 429 (límite de pedidos) no dicen nada del comprobante: se reintenta. */
const PASAJEROS = new Set([401, 408, 429])

/** Qué dice la verificación de un comprobante de Xubio frente al pago. null = coincide. */
export function motivoDeNoCoincidir(c: (typeof CAMINOS_ANULAR)[number], comprobante: unknown, d: DatosAnulacion): string | null {
  const importe = Math.abs(Number(d.importe))
  const enXubio = c.path === 'pagoBean' ? importeDeOP(comprobante) : importeDeAsiento(comprobante)
  if (Math.abs(centavos(Math.abs(enXubio)) - centavos(importe)) > 2)
    return `en Xubio el ${c.que} ${d.id} suma ${enXubio} y el pago es de ${importe}: no se borra por seguridad`
  const o = (comprobante ?? {}) as Fila
  if (c.path === 'pagoBean') {
    const pr = o.proveedor as { nombre?: string; razonSocial?: string } | undefined
    const nombreXubio = pr?.nombre || pr?.razonSocial || ''
    if (!d.proveedor) return `el pago no tiene proveedor para comparar con la ${c.que} ${d.id}: no se borra por seguridad`
    if (!mismoProveedor(nombreXubio, d.proveedor)) return `la ${c.que} ${d.id} de Xubio es de "${nombreXubio}" y el pago es de "${d.proveedor}": no se borra por seguridad`
  }
  if (d.fecha) {
    const tPago = new Date(d.fecha.slice(0, 10) + 'T12:00:00Z').getTime()
    const tXubio = new Date(String(o.fecha ?? '').slice(0, 10) + 'T12:00:00Z').getTime()
    if (Number.isNaN(tXubio) || Math.abs(tXubio - tPago) > 10 * 86_400_000)
      return `la fecha del ${c.que} ${d.id} en Xubio (${String(o.fecha ?? 'sin fecha').slice(0, 10)}) no coincide con la del pago (${d.fecha.slice(0, 10)}): no se borra por seguridad`
  }
  return null
}

/**
 * Busca el comprobante, lo verifica contra el pago y lo borra. No tira errores: devuelve el motivo.
 * Un 404 al leer es "no existe" (se prueba el otro camino); un 401, 408, 429 o un fallo de conexión es pasajero (reintentar);
 * cualquier otro error corta sin borrar nada.
 */
export async function anularEnXubioAuto(t: xubio.Token, d: DatosAnulacion): Promise<ResultadoAnulacion> {
  if (!/^\d+$/.test(d.id)) return { ok: false, error: 'el pago no tiene ID de Xubio' }
  if (!(Math.abs(Number(d.importe)) > 0)) return { ok: false, error: 'el pago no tiene importe: no se borra por seguridad' }
  let ultimo = ''
  for (const c of CAMINOS_ANULAR) {
    let comprobante: unknown
    try {
      comprobante = await xubio.get<unknown>(t, `${c.path}/${d.id}`)
    } catch (e) {
      const m = mensaje(e)
      const codigo = e instanceof ErrorHttp ? Number(/→ (\d{3})$/.exec(m)?.[1] ?? 0) : 0
      if (codigo === 404) {
        ultimo = `${c.que}: no encontrado`
        continue
      }
      if (!codigo || PASAJEROS.has(codigo) || codigo >= 500) return { ok: false, reintentar: true, error: `${c.que}: Xubio no pudo responder ahora (${m}). Se reintenta en la próxima corrida` }
      return { ok: false, error: `${c.que}: no se pudo leer en Xubio (${m})` }
    }
    const motivo = motivoDeNoCoincidir(c, comprobante, d)
    if (motivo) return { ok: false, que: c.que, error: motivo }
    let r: { status: number; body: unknown }
    try {
      r = await xubio.borrar(t, `${c.path}/${d.id}`)
    } catch (e) {
      return { ok: false, sinSaber: true, que: c.que, path: c.path, error: `${mensaje(e)}: no se sabe si Xubio borró el ${c.que} ${d.id}. Verificar en Xubio.` }
    }
    if (r.status >= 200 && r.status < 300) return { ok: true, que: c.que, path: c.path, status: r.status, body: r.body }
    if (PASAJEROS.has(r.status)) return { ok: false, reintentar: true, que: c.que, path: c.path, status: r.status, body: r.body, error: `Xubio no pudo atender el borrado del ${c.que} ${d.id} ahora (${r.status}). Se reintenta en la próxima corrida` }
    return { ok: false, que: c.que, path: c.path, status: r.status, body: r.body, error: `Xubio no dejó borrar el ${c.que} ${d.id} (${r.status})` }
  }
  return { ok: false, error: ultimo || 'no encontrado en Xubio' }
}
