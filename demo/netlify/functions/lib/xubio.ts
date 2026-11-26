// Cliente de Xubio. Replica los payloads que ya se probaron "en seco" en la copia de desarrollo
// (XubioPagos.gs): orden de pago → POST pagoBean; asiento manual y salida de fondos → POST
// asientoContableManualBean (la API no tiene salida de fondos: se registra como asiento).
// Las órdenes de pago NO se pueden borrar por API; los asientos manuales sí.

import type { SupabaseClient } from '@supabase/supabase-js'
import { cifrar, descifrar, hayClave } from './cifrado'
import { env, ErrorHttp } from './comun'

const API = 'https://xubio.com/API/1.1/'
const MONEDA_ARS = { ID: -2, nombre: 'Pesos Argentinos', codigo: 'PESOS_ARGENTINOS', id: -2 }
const CIRCUITO = { ID: -2, nombre: 'default', codigo: 'DEFAULT', id: -2 }

export interface Credenciales {
  clientId: string
  secret: string
}

/** Variable de siempre: XUBIO_CREDS_JSON = {"beratung":{"clientId":"...","secret":"..."}, "india":{...}} */
function credencialesDeLaVariable(empresaId: string): Credenciales | null {
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

/** Dónde queda atado el dato cifrado: copiado a otra empresa no se descifra. */
const lugarXubio = (empresaId: string) => `conexiones_erp:${empresaId}:XUBIO`

/**
 * Credenciales de Xubio de una empresa: las guardadas (cifradas) en conexiones_erp si hay fila;
 * si no, las de la variable XUBIO_CREDS_JSON, como siempre. Si hay fila y no se puede descifrar, es un
 * error (no se cae en silencio a la variable: podría estar vieja). El mensaje nunca incluye la credencial.
 */
export async function credencialesDe(db: SupabaseClient, empresaId: string): Promise<Credenciales | null> {
  const { data, error } = await db.from('conexiones_erp').select('secreto_cifrado').eq('empresa_id', empresaId).eq('erp', 'XUBIO').maybeSingle()
  if (error) throw new ErrorHttp(500, `No se pudieron leer las credenciales de Xubio de ${empresaId} guardadas en la base`)
  if (!data?.secreto_cifrado) return credencialesDeLaVariable(empresaId)
  const nombre = `Credenciales de Xubio de ${empresaId}`
  const d = descifrar(String(data.secreto_cifrado), lugarXubio(empresaId), nombre)
  let c: Partial<Credenciales>
  try {
    c = JSON.parse(d.texto) as Partial<Credenciales>
  } catch {
    throw new ErrorHttp(500, `${nombre}: el dato guardado no tiene el formato esperado.`)
  }
  if (!c.clientId || !c.secret) throw new ErrorHttp(500, `${nombre}: el dato guardado está incompleto.`)
  // Cambio de clave: lo que todavía estaba con la anterior se vuelve a cifrar con la actual al usarlo.
  // Si solo está la anterior (la actual falta), se usa igual y queda como estaba.
  if (d.conClaveAnterior && hayClave())
    await db.from('conexiones_erp').update({ secreto_cifrado: cifrar(d.texto, lugarXubio(empresaId)) }).eq('empresa_id', empresaId).eq('erp', 'XUBIO')
  return { clientId: c.clientId, secret: c.secret }
}

/**
 * Alta (o reemplazo) de las credenciales de Xubio de una empresa en la base. Primero exige la clave de
 * cifrado, después prueba la credencial pidiendo un token a Xubio (solo lectura) y recién entonces la
 * cifra y la guarda. Si algo falla no se guarda nada. Devuelve solo la pista (últimos 4 del identificador).
 */
export async function guardarCredencialesXubio(db: SupabaseClient, d: { empresaId: string; clientId: string; secret: string; usuario: string }): Promise<{ pista: string; verificadoEn: string }> {
  const clientId = String(d.clientId ?? '').trim()
  const secret = String(d.secret ?? '').trim()
  if (!clientId || !secret) throw new ErrorHttp(400, 'Faltan el identificador o el secreto de Xubio')
  if (clientId.length > 500 || secret.length > 500) throw new ErrorHttp(400, 'El identificador o el secreto de Xubio son demasiado largos')
  // Sin clave no se sigue: ni siquiera se le pide el token a Xubio.
  const cifrado = cifrar(JSON.stringify({ clientId, secret }), lugarXubio(d.empresaId))
  const { data: e, error } = await db.from('empresas').select('id, nombre, erp').eq('id', d.empresaId).maybeSingle()
  if (error) throw new ErrorHttp(500, error.message)
  if (!e) throw new ErrorHttp(404, `La empresa ${d.empresaId} no existe`)
  if (e.erp !== 'XUBIO') throw new ErrorHttp(422, `${e.nombre} no usa Xubio`)
  try {
    await token({ clientId, secret })
  } catch (err) {
    // Texto fijo: el mensaje del error (por ejemplo, el de fetch) no se devuelve ni se registra.
    throw new ErrorHttp(422, `${motivoAlta(err)} (${e.nombre}). No se guardó nada.`)
  }
  const verificadoEn = new Date().toISOString()
  const pista = clientId.slice(-4)
  const { error: e2 } = await db.from('conexiones_erp').upsert({ empresa_id: d.empresaId, erp: 'XUBIO', secreto_cifrado: cifrado, pista, verificado_en: verificadoEn, cargado_por: d.usuario, cargado_en: verificadoEn })
  if (e2) throw new ErrorHttp(500, `No se pudieron guardar las credenciales de ${e.nombre}`)
  return { pista, verificadoEn }
}

/** Motivo del rechazo de un alta, sin repetir nunca el mensaje del error original. */
function motivoAlta(err: unknown): string {
  const status = err instanceof ErrorHttp ? err.status : 0
  const codigo = err instanceof ErrorHttp ? /^Xubio no entregó token \((\d{3})\)$/.exec(err.message)?.[1] : undefined
  if (codigo) return `Xubio no aceptó las credenciales (código ${codigo})`
  if (status === 504) return 'Xubio no respondió a tiempo'
  if (err instanceof ErrorHttp && err.message.startsWith('No se pudo conectar con Xubio')) return 'No se pudo conectar con Xubio para probar las credenciales'
  return 'Xubio no entregó un token válido con esas credenciales'
}

export interface Token {
  access_token: string
  token_type: string
}

/**
 * Tope de tiempo de cada llamada a Xubio. Sin tope, un Xubio que no contesta deja la función colgada
 * hasta que Netlify la corta, sin registrar nada. Se cambia con XUBIO_TIMEOUT_MS.
 */
export const topeXubioMs = () => Number(env('XUBIO_TIMEOUT_MS', false)) || 8_000
/** Lecturas largas (pagos de 180 días para los catálogos). */
export const TOPE_XUBIO_LARGO_MS = 20_000

/**
 * Hace el pedido y lee la respuesta completa dentro del tope. Si Xubio no contesta a tiempo o no se
 * puede conectar, tira ErrorHttp 504 o 502. OJO en un POST o PUT: ese error NO dice que Xubio no haya
 * creado el comprobante; quien llama tiene que tratarlo como "no se sabe".
 */
async function pedir(que: string, url: string, init: RequestInit, ms = topeXubioMs()): Promise<{ status: number; ok: boolean; texto: string }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
    return { status: r.status, ok: r.ok, texto: await r.text() }
  } catch (e) {
    const nombre = e instanceof Error ? e.name : ''
    if (nombre === 'TimeoutError' || nombre === 'AbortError') throw new ErrorHttp(504, `Xubio no respondió en ${Math.max(1, Math.round(ms / 1000))} s (${que})`)
    throw new ErrorHttp(502, `No se pudo conectar con Xubio (${que}): ${e instanceof Error ? e.message : e}`)
  }
}

function comoJson<T>(que: string, texto: string): T {
  try {
    return JSON.parse(texto) as T
  } catch {
    throw new ErrorHttp(502, `Xubio devolvió una respuesta que no se entiende (${que})`)
  }
}

export async function token(c: Credenciales): Promise<Token> {
  const r = await pedir('token', API + 'TokenEndpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.secret}`).toString('base64') },
    body: 'grant_type=client_credentials',
  })
  if (!r.ok) throw new ErrorHttp(502, `Xubio no entregó token (${r.status})`)
  const j = comoJson<Token>('token', r.texto)
  if (!j.access_token) throw new ErrorHttp(502, 'Xubio devolvió un token vacío')
  return j
}

export async function get<T>(t: Token, path: string, query = '', ms?: number): Promise<T> {
  const r = await pedir(`GET ${path}`, API + path + (query ? `?${query}` : ''), { headers: { Authorization: `${t.token_type} ${t.access_token}`, Accept: 'application/json' } }, ms)
  if (!r.ok) throw new ErrorHttp(502, `Xubio GET ${path} → ${r.status}`)
  return comoJson<T>(`GET ${path}`, r.texto)
}

const lista = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : [])
export const listarProveedores = async (t: Token) => lista(await get(t, 'ProveedorBean'))
export const listarProductosCompra = async (t: Token) => lista(await get(t, 'ProductoCompraBean'))
export const listarFacturasCompra = async (t: Token, desde: string, hasta: string) => lista(await get(t, 'comprobanteCompraBean', `fechaDesde=${desde}&fechaHasta=${hasta}`))
export const listarPagos = async (t: Token, desde: string, hasta: string) => lista(await get(t, 'pagoBean', `fechaDesde=${desde}&fechaHasta=${hasta}`))
export const facturaCompraPorId = async (t: Token, id: string) => (await get(t, `comprobanteCompraBean/${id}`)) as Record<string, unknown>

export async function put(t: Token, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return enviar('PUT', t, path, payload)
}

export async function post(t: Token, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return enviar('POST', t, path, payload)
}

/**
 * DELETE de un recurso de Xubio (hoy solo lo usa la anulación de asientos, lib/xubio-bancos.ts).
 * Si tira error (sin respuesta a tiempo o sin conexión), no se sabe si Xubio lo borró.
 */
export async function borrar(t: Token, path: string): Promise<{ status: number; body: unknown }> {
  const r = await pedir(`DELETE ${path}`, API + path, { method: 'DELETE', headers: { Authorization: `${t.token_type} ${t.access_token}`, Accept: 'application/json' } })
  let body: unknown = r.texto
  try {
    body = r.texto ? JSON.parse(r.texto) : null
  } catch {
    /* texto plano */
  }
  return { status: r.status, body }
}

/** Si tira error (sin respuesta a tiempo o sin conexión), no se sabe si Xubio creó el comprobante. */
async function enviar(metodo: 'POST' | 'PUT', t: Token, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const r = await pedir(`${metodo} ${path}`, API + path, {
    method: metodo,
    headers: { Authorization: `${t.token_type} ${t.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const texto = r.texto
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

/** Solo coincidencia exacta (sin mayúsculas, tildes ni signos), por nombre o por "CÓDIGO NOMBRE", que es como
 *  la guarda producción ("GASTOS_BANCARIOS GASTOS BANCARIOS"). Una coincidencia parcial podría imputar a
 *  "Banco Galicia USD" un pago de "Banco Galicia": en contabilidad no se adivina. */
export function buscarCuenta(lista: RefXubio[], texto: string): RefXubio | null {
  const n = norm(texto)
  if (!n) return null
  return lista.find((c) => norm(c.nombre) === n) ?? lista.find((c) => !!c.codigo && norm(`${c.codigo} ${c.nombre}`) === n) ?? null
}

/**
 * Proveedor de Xubio: por CUIT; si no, por nombre exacto. El CUIT solo se compara si tiene 11 dígitos:
 * con un CUIT vacío, la comparación coincidía con el primer proveedor de Xubio que no tuviera CUIT
 * (el error del Apps Script del 17/11). Lo mismo con un nombre vacío. Igual que elegirProveedor.
 */
export async function proveedorPorCuit(t: Token, cuit: string, nombre: string): Promise<RefXubio | null> {
  const lista = await get<{ ID?: number; id?: number; nombre?: string; codigo?: string; CUIT?: string; cuit?: string; identificacionTributaria?: { numero?: string } }[]>(t, 'ProveedorBean')
  const limpio = String(cuit ?? '').replace(/\D/g, '')
  const buscado = norm(String(nombre ?? ''))
  const porCuit = limpio.length === 11 ? (Array.isArray(lista) ? lista : []).find((p) => (p.CUIT ?? p.cuit ?? p.identificacionTributaria?.numero ?? '').replace(/\D/g, '') === limpio) : undefined
  const porNombre = porCuit ?? (buscado ? (Array.isArray(lista) ? lista : []).find((p) => norm(p.nombre ?? '') === buscado) : undefined)
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
