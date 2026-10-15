// Cliente de Xubio. Replica los payloads que ya se probaron "en seco" en la copia de desarrollo
// (XubioPagos.gs): orden de pago → POST pagoBean; asiento manual y salida de fondos → POST
// asientoContableManualBean (la API no tiene salida de fondos: se registra como asiento).
// Las órdenes de pago NO se pueden borrar por API; los asientos manuales sí.

import { env, ErrorHttp } from './comun'

const API = 'https://xubio.com/API/1.1/'
const MONEDA_ARS = { ID: -2, nombre: 'Pesos Argentinos', codigo: 'PESOS_ARGENTINOS', id: -2 }
const CIRCUITO = { ID: -2, nombre: 'default', codigo: 'DEFAULT', id: -2 }

export interface Credenciales {
  clientId: string
  secret: string
}

/** XUBIO_CREDS_JSON = {"beratung":{"clientId":"...","secret":"..."}, "india":{...}} */
export function credencialesDe(empresaId: string): Credenciales | null {
  const raw = env('XUBIO_CREDS_JSON', false)
  if (!raw) return null
  try {
    const all = JSON.parse(raw) as Record<string, Credenciales>
    const c = all[empresaId]
    return c?.clientId && c?.secret ? c : null
  } catch {
    throw new ErrorHttp(500, 'XUBIO_CREDS_JSON no es un JSON válido')
  }
}

export interface Token {
  access_token: string
  token_type: string
}

export async function token(c: Credenciales): Promise<Token> {
  const r = await fetch(API + 'TokenEndpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.secret}`).toString('base64') },
    body: 'grant_type=client_credentials',
  })
  if (!r.ok) throw new ErrorHttp(502, `Xubio no entregó token (${r.status})`)
  const j = (await r.json()) as Token
  if (!j.access_token) throw new ErrorHttp(502, 'Xubio devolvió un token vacío')
  return j
}

export async function get<T>(t: Token, path: string, query = ''): Promise<T> {
  const r = await fetch(API + path + (query ? `?${query}` : ''), { headers: { Authorization: `${t.token_type} ${t.access_token}`, Accept: 'application/json' } })
  if (!r.ok) throw new ErrorHttp(502, `Xubio GET ${path} → ${r.status}`)
  return (await r.json()) as T
}

const lista = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : [])
export const listarProveedores = async (t: Token) => lista(await get(t, 'ProveedorBean'))
export const listarProductosCompra = async (t: Token) => lista(await get(t, 'ProductoCompraBean'))
export const listarFacturasCompra = async (t: Token, desde: string, hasta: string) => lista(await get(t, 'comprobanteCompraBean', `fechaDesde=${desde}&fechaHasta=${hasta}`))
export const facturaCompraPorId = async (t: Token, id: string) => (await get(t, `comprobanteCompraBean/${id}`)) as Record<string, unknown>

export async function put(t: Token, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return enviar('PUT', t, path, payload)
}

export async function post(t: Token, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return enviar('POST', t, path, payload)
}

async function enviar(metodo: 'POST' | 'PUT', t: Token, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(API + path, {
    method: metodo,
    headers: { Authorization: `${t.token_type} ${t.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const texto = await r.text()
  let body: unknown = texto
  try {
    body = JSON.parse(texto)
  } catch {
    /* texto plano */
  }
  return { status: r.status, body }
}

export interface RefXubio {
  ID: number
  id: number
  nombre: string
  codigo: string
}
interface CuentaXubio {
  ID?: number
  id?: number
  nombre?: string
  codigo?: string
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export async function cuentas(t: Token): Promise<RefXubio[]> {
  const lista = await get<CuentaXubio[]>(t, 'cuenta', 'activo=1')
  return (Array.isArray(lista) ? lista : []).map((c) => ({ ID: Number(c.ID ?? c.id), id: Number(c.ID ?? c.id), nombre: String(c.nombre ?? ''), codigo: String(c.codigo ?? '') }))
}

/** Solo coincidencia exacta (sin mayúsculas, tildes ni signos). Una coincidencia parcial podría
 *  imputar a "Banco Galicia USD" un pago de "Banco Galicia": en contabilidad no se adivina. */
export function buscarCuenta(lista: RefXubio[], texto: string): RefXubio | null {
  const n = norm(texto)
  if (!n) return null
  return lista.find((c) => norm(c.nombre) === n) ?? null
}

export async function proveedorPorCuit(t: Token, cuit: string, nombre: string): Promise<RefXubio | null> {
  const lista = await get<{ ID?: number; id?: number; nombre?: string; codigo?: string; CUIT?: string; cuit?: string; identificacionTributaria?: { numero?: string } }[]>(t, 'ProveedorBean')
  const limpio = cuit.replace(/\D/g, '')
  const porCuit = (Array.isArray(lista) ? lista : []).find((p) => (p.CUIT ?? p.cuit ?? p.identificacionTributaria?.numero ?? '').replace(/\D/g, '') === limpio)
  const porNombre = porCuit ?? (Array.isArray(lista) ? lista : []).find((p) => norm(p.nombre ?? '') === norm(nombre))
  if (!porNombre) return null
  return { ID: Number(porNombre.ID ?? porNombre.id), id: Number(porNombre.ID ?? porNombre.id), nombre: String(porNombre.nombre ?? nombre), codigo: String(porNombre.codigo ?? '') }
}

/** tipoCuenta de Xubio por el nombre de la cuenta de origen: 1 caja · 4 cheque diferido / e-cheq · 2 banco.
 *  Verificado: la cuenta "Cheque Diferido BRUBANK" usa tipoCuenta 4. */
export function tipoCuentaPara(nombreCuenta: string): number {
  const n = norm(nombreCuenta)
  if (n.includes('caja')) return 1
  if (n.includes('cheq')) return 4
  return 2
}

export interface DatosPago {
  idPago: string
  importe: number
  fecha: string
  observacion: string
  cuentaOrigen: RefXubio
  cuentaGasto?: RefXubio
  proveedor?: RefXubio
  /** Cheque propio o e-cheq. Campos verificados en la OP X-0001-00000483 de INDIA ADV. */
  cheque?: { numero: string; vencimiento: string; banco?: RefXubio }
}

export function ordenDePago(d: DatosPago) {
  if (!d.proveedor) throw new ErrorHttp(422, 'Una orden de pago necesita proveedor en Xubio')
  return {
    circuitoContable: CIRCUITO,
    proveedor: d.proveedor,
    fecha: d.fecha,
    numeroRecibo: '',
    cotizacion: 1,
    utilizaMonedaExtranjera: 0,
    observacion: d.observacion,
    moneda: MONEDA_ARS,
    transaccionInstrumentoDePago: [
      {
        cuenta: d.cuentaOrigen,
        moneda: MONEDA_ARS,
        cotizacion: 1,
        importe: d.importe,
        descripcion: '',
        tipoCuenta: d.cheque ? 4 : tipoCuentaPara(d.cuentaOrigen.nombre),
        ...(d.cheque ? { chequePropio: d.cheque.numero, vencimientoCheque: d.cheque.vencimiento, ...(d.cheque.banco ? { banco: d.cheque.banco } : {}) } : {}),
      },
    ],
    // OJO: PagoBean no tiene campo para imputar facturas (verificado en la especificación de la API, 13/10/2026).
    // La OP creada por API queda a cuenta del proveedor; la imputación a facturas se hace en Xubio.
    transaccionRetencionItems: [],
  }
}

export function asientoManual(d: DatosPago) {
  if (!d.cuentaGasto) throw new ErrorHttp(422, 'Un asiento necesita la cuenta de gasto')
  const linea = (cuenta: RefXubio, debeHaber: 1 | -1) => ({ cuenta, debeHaber, importe: d.importe, descripcion: d.observacion, moneda: MONEDA_ARS, cotizacion: 1 })
  return {
    circuitoContable: CIRCUITO,
    fecha: d.fecha,
    descripcion: d.observacion,
    numeroDocumento: '',
    nombre: `Pago ${d.idPago}`,
    externalId: d.idPago,
    importetotal: d.importe,
    importeImpuestos: 0,
    importeGravado: 0,
    asientoContableManualItem: [linea(d.cuentaGasto, 1), linea(d.cuentaOrigen, -1)],
  }
}

export function pathPara(forma: 'ORDEN_PAGO' | 'SALIDA_FONDOS' | 'ASIENTO_MANUAL'): string {
  return forma === 'ORDEN_PAGO' ? 'pagoBean' : 'asientoContableManualBean'
}

export function idDeRespuesta(body: unknown): string {
  const b = body as { ID?: number; id?: number; transaccionid?: number; transaccionId?: number; numero?: string } | null
  const n = b?.ID ?? b?.id ?? b?.transaccionid ?? b?.transaccionId
  return n != null ? `OP-${n}` : b?.numero ? String(b.numero) : ''
}
