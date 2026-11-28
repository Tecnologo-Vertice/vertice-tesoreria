// Mercado Pago por API (reemplaza a leerMercadoPago_ de ConectorFlujoV2.js, que leía una planilla con los informes).
// SOLO LECTURA: lee los informes de liberaciones ("release report") que Mercado Pago ya generó y el saldo disponible.
// No pide informes nuevos, no mueve plata ni escribe nada en Mercado Pago.
//
// Qué hace por cada informe nuevo:
//   1. Lo baja (CSV con RECORD_TYPE, DATE, DESCRIPTION, NET_CREDIT_AMOUNT, NET_DEBIT_AMOUNT, SOURCE_ID, PAYMENT_METHOD…).
//   2. Arma los movimientos de la cuenta (un movimiento por fila, con el importe neto con signo) y el saldo de cierre de cada
//      día (el saldo corre desde "initial_available_balance", como en el Apps Script).
//   3. Los carga con importar_extracto(): no duplica (huella del informe y de cada movimiento) y queda en Bancos como un extracto
//      más (formato MERCADOPAGO_API), con el saldo en la conciliación.
// Las reservas ("reserve_for_payment") se saltean (se anulan con su liberación): no entran al extracto, al Flujo ni al saldo.
// Recorre TODOS los informes que todavía no se importaron (de a páginas); uno que no se puede leer se registra y se sigue con los demás.
//
// Token: variable de entorno MERCADOPAGO_TOKEN_<EMPRESA> (id de la empresa en mayúsculas, solo letras y números, el resto "_":
// MERCADOPAGO_TOKEN_BERATUNG). MERCADOPAGO_TOKEN a secas solo se usa si hay UNA sola cuenta de Mercado Pago en toda la
// organización (con varias, un token único mezclaría empresas). Sin token no hace nada y lo avisa. El token nunca se imprime.
//
// A CONFIRMAR con Mercado Pago / Santi (no se pudo probar contra la cuenta real): los nombres de los campos de la lista de
// informes (file_name, begin_date, end_date, status) y que los informes se generen solos todos los días (configuración de
// Mercado Pago). Si la forma de la respuesta no es la esperada, avisa y no carga nada.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { registrarProceso } from './xubio-bancos'

export const URL_MERCADOPAGO = 'https://api.mercadopago.com'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------- Token

/** MERCADOPAGO_TOKEN_<EMPRESA>: el id de la empresa en mayúsculas, lo que no es letra o número pasa a "_". */
export function nombreVariableToken(empresaId: string): string {
  return 'MERCADOPAGO_TOKEN_' + empresaId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** El token de la empresa, o null si no hay. El genérico solo vale con una única cuenta de Mercado Pago en la organización. */
export function tokenDeMercadoPago(empresaId: string, cuentasMercadoPago: number, entorno: Record<string, string | undefined> = process.env): string | null {
  const propio = entorno[nombreVariableToken(empresaId)]?.trim()
  if (propio) return propio
  const general = entorno.MERCADOPAGO_TOKEN?.trim()
  return general && cuentasMercadoPago === 1 ? general : null
}

// ---------------------------------------------------------------- CSV del informe de liberaciones

/** Parte una línea de CSV respetando las comillas. */
function partirLinea(linea: string, sep: string): string[] {
  const out: string[] = []
  let actual = ''
  let comillas = false
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]
    if (comillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"'
        i++
      } else if (c === '"') comillas = false
      else actual += c
    } else if (c === '"') comillas = true
    else if (c === sep) {
      out.push(actual)
      actual = ''
    } else actual += c
  }
  out.push(actual)
  return out
}

/** Importe del informe: "1234.56" o "1.234,56"; vacío = 0. NaN si no es un número. */
export function numeroMP(v: string | undefined): number {
  const t = String(v ?? '').trim().replace(/\s|\$/g, '')
  if (t === '' || t === '-') return 0
  const coma = t.lastIndexOf(','), punto = t.lastIndexOf('.')
  // "1,234" (solo comas, grupos de tres) es mil doscientos treinta y cuatro; "1,5" o "1.234,56" llevan coma decimal.
  const milesConComa = /^-?\d{1,3}(,\d{3})+$/.test(t)
  const limpio = milesConComa ? t.replace(/,/g, '') : coma > punto ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  const n = Number(limpio)
  return Number.isFinite(n) ? n : NaN
}

export interface FilaLiberacion {
  fecha: string // aaaa-mm-dd
  tipo: string // RECORD_TYPE
  descripcion: string
  credito: number
  debito: number
  bruto: number
  comision: number
  impuestos: number
  id: string // SOURCE_ID
  medio: string // PAYMENT_METHOD
}

/** Lee el CSV del informe. Separador "," o ";" según el encabezado. Lanza si faltan columnas esenciales o una fila no se entiende. */
export function leerInformeLiberaciones(texto: string): FilaLiberacion[] {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lineas.length < 2) return []
  const sep = (lineas[0].match(/;/g) ?? []).length > (lineas[0].match(/,/g) ?? []).length ? ';' : ','
  const enc = partirLinea(lineas[0], sep).map((x) => x.trim().toUpperCase())
  const col = (n: string) => enc.indexOf(n)
  for (const n of ['DATE', 'RECORD_TYPE', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT']) {
    if (col(n) < 0) throw new Error(`El informe de Mercado Pago no trae la columna ${n}`)
  }
  const out: FilaLiberacion[] = []
  for (let i = 1; i < lineas.length; i++) {
    const c = partirLinea(lineas[i], sep)
    const g = (n: string) => (col(n) >= 0 ? (c[col(n)] ?? '').trim() : '')
    const tipo = g('RECORD_TYPE')
    if (!tipo || tipo.toLowerCase() === 'total') continue
    const f = /^(\d{4}-\d{2}-\d{2})/.exec(g('DATE'))
    if (!f) throw new Error(`Informe de Mercado Pago, fila ${i + 1}: fecha "${g('DATE')}" que no se entiende`)
    const fila: FilaLiberacion = {
      fecha: f[1],
      tipo,
      descripcion: g('DESCRIPTION'),
      credito: numeroMP(g('NET_CREDIT_AMOUNT')),
      debito: numeroMP(g('NET_DEBIT_AMOUNT')),
      bruto: numeroMP(g('GROSS_AMOUNT')),
      comision: numeroMP(g('MP_FEE_AMOUNT')),
      impuestos: numeroMP(g('TAXES_AMOUNT')),
      id: g('SOURCE_ID'),
      medio: g('PAYMENT_METHOD'),
    }
    if (Number.isNaN(fila.credito) || Number.isNaN(fila.debito)) throw new Error(`Informe de Mercado Pago, fila ${i + 1}: importe que no se entiende`)
    out.push(fila)
  }
  return out
}

// ---------------------------------------------------------------- Del informe al extracto

export interface MovimientoMP {
  fecha: string
  descripcion: string
  referencia: string | null
  importe: number
  saldo: number
  numero_cheque: null
}

const centavos = (n: number) => Math.round(n * 100) / 100

/**
 * Movimientos y saldos de cierre. El saldo corre desde "initial_available_balance" y suma crédito - débito de cada fila
 * (sin las reservas). Un movimiento por fila con el neto con signo; los de neto cero no son movimiento.
 * La descripción lleva "MP ingreso <medio de pago>" en los créditos y "MP <tipo>" en los débitos, con el id de la operación
 * (las reglas de 0040 para la cuenta de Mercado Pago los clasifican: ingreso = entre cuentas propias, egreso = pago). Comisión e impuestos van dentro del neto (a confirmar con Santi si se separan).
 */
export function armarExtractoMP(filas: FilaLiberacion[]): { movimientos: MovimientoMP[]; saldos: { fecha: string; saldo: number }[]; desde: string | null; hasta: string | null } {
  const ordenadas = filas.map((f, i) => ({ f, i })).sort((a, b) => (a.f.fecha < b.f.fecha ? -1 : a.f.fecha > b.f.fecha ? 1 : a.i - b.i)).map((x) => x.f)
  let saldo = 0
  const porDia = new Map<string, number>()
  const movimientos: MovimientoMP[] = []
  for (const x of ordenadas) {
    const neto = centavos(x.credito - x.debito)
    if (x.tipo === 'initial_available_balance') {
      saldo = neto
      porDia.set(x.fecha, saldo)
      continue
    }
    // Las reservas se anulan con su liberación: no son movimiento (el Apps Script las salteaba) y tampoco corren en el saldo,
    // así el saldo del día cierra con los movimientos cargados y el Flujo no muestra plata que sale un día y vuelve otro.
    if (x.descripcion === 'reserve_for_payment') {
      porDia.set(x.fecha, saldo)
      continue
    }
    saldo = centavos(saldo + neto)
    porDia.set(x.fecha, saldo)
    if (neto === 0) continue
    const descripcion =
      neto > 0 ? `MP ingreso ${x.medio || x.descripcion} ${x.id}`.replace(/\s+/g, ' ').trim() : `MP ${x.descripcion || x.tipo} ${x.id}`.replace(/\s+/g, ' ').trim()
    movimientos.push({ fecha: x.fecha, descripcion, referencia: x.id || null, importe: neto, saldo, numero_cheque: null })
  }
  const saldos = [...porDia.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([fecha, s]) => ({ fecha, saldo: s }))
  return { movimientos, saldos, desde: saldos[0]?.fecha ?? null, hasta: saldos[saldos.length - 1]?.fecha ?? null }
}

// ---------------------------------------------------------------- Lectura de la API (solo GET)

export interface InformeLista {
  file_name: string
  begin_date?: string
  end_date?: string
}

async function pedir(f: Fetch, token: string, ruta: string): Promise<Response> {
  const r = await f(URL_MERCADOPAGO + ruta, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/csv' } })
  if (!r.ok) throw new Error(`Mercado Pago respondió ${r.status} en ${ruta.split('?')[0].replace(/\/[^/]*\.csv$/i, '/…')}`)
  return r
}

const TAMANO_PAGINA = 100
const MAXIMO_PAGINAS = 10

function filtrarInformes(x: unknown): InformeLista[] {
  if (!Array.isArray(x)) throw new Error('Mercado Pago devolvió la lista de informes con una forma que no se esperaba')
  return (x as Record<string, unknown>[])
    .filter((i) => typeof i.file_name === 'string' && i.file_name !== '' && i.is_test !== true && (i.status === undefined || /^(processed|ready|available|done)$/i.test(String(i.status))))
    .map((i) => ({ file_name: String(i.file_name), begin_date: typeof i.begin_date === 'string' ? i.begin_date : undefined, end_date: typeof i.end_date === 'string' ? i.end_date : undefined }))
}

/**
 * Los informes de liberaciones ya generados, del más viejo al más nuevo. Pide la primera página sin parámetros; si vino llena,
 * sigue con offset/limit hasta que una página no traiga nada nuevo (si la API ignorara la paginación, la repetición corta el bucle).
 */
export async function listarInformes(f: Fetch, token: string): Promise<InformeLista[]> {
  const todos = new Map<string, InformeLista>()
  let ultimo = await (await pedir(f, token, '/v1/account/release_report/list')).json()
  for (let pagina = 0; pagina < MAXIMO_PAGINAS; pagina++) {
    const nuevos = filtrarInformes(ultimo)
    const antes = todos.size
    for (const i of nuevos) todos.set(i.file_name, i)
    const crudos = (ultimo as unknown[]).length
    if (crudos < TAMANO_PAGINA || todos.size === antes) break
    ultimo = await (await pedir(f, token, `/v1/account/release_report/list?limit=${TAMANO_PAGINA}&offset=${(pagina + 1) * TAMANO_PAGINA}`)).json()
  }
  return [...todos.values()].sort((a, b) => String(a.end_date ?? a.file_name).localeCompare(String(b.end_date ?? b.file_name)))
}

export async function bajarInforme(f: Fetch, token: string, archivo: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(archivo)) throw new Error('Nombre de informe raro: no se baja')
  return await (await pedir(f, token, `/v1/account/release_report/${archivo}`)).text()
}

/** Saldo disponible hoy en Mercado Pago (solo para informar). null si la API no lo da. */
export async function saldoDisponible(f: Fetch, token: string): Promise<number | null> {
  try {
    const me = (await (await pedir(f, token, '/users/me')).json()) as { id?: number | string }
    if (me?.id === undefined) return null
    const b = (await (await pedir(f, token, `/users/${me.id}/mercadopago_account/balance`)).json()) as { available_balance?: number }
    return typeof b.available_balance === 'number' ? b.available_balance : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- Orquestación

export interface OpcionesMP {
  organizacionId: string
  entorno?: Record<string, string | undefined>
  fetch?: Fetch
  /** Tope de informes por corrida y empresa (por defecto, todos los que falten, hasta agotar el tiempo). */
  maximoInformes?: number
  /** Tiempo disponible en la corrida (las funciones programadas de Netlify cortan pronto). Por defecto 20 s. */
  presupuestoMs?: number
}
export interface ResultadoMP {
  lineas: string[]
  importados: number
}

/** Como queda guardado el informe en extractos.archivo_nombre (para no bajar dos veces el mismo). */
const nombreArchivo = (fileName: string) => `Mercado Pago API · ${fileName}`

interface CuentaMP {
  id: string
  empresa_id: string
  nombre: string
}

/**
 * Recorre las cuentas de Mercado Pago (banco "MP", clase BILLETERA o cuenta corriente) de la organización. Sin token: no hace nada y lo
 * avisa (en la respuesta y en procesos_log). Una cuenta por empresa: con dos cuentas de MP en la misma empresa avisa y no carga.
 */
export async function leerMercadoPago(db: SupabaseClient, o: OpcionesMP): Promise<ResultadoMP> {
  const inicio = Date.now()
  const entorno = o.entorno ?? process.env
  const f: Fetch = o.fetch ?? ((url, init) => fetch(url, init))
  const r: ResultadoMP = { lineas: [], importados: 0 }
  const registrar = (empresaId: string | null, estado: 'OK' | 'ERROR' | 'OMITIDO', detalle: string, datos?: unknown) =>
    registrarProceso(db, { organizacionId: o.organizacionId, empresaId, proceso: 'IMPORTAR_EXTRACTO', real: true, entidad: 'MERCADOPAGO', estado, detalle, datos })

  const { data: emp, error: eEmp } = await db.from('empresas').select('id, nombre').eq('organizacion_id', o.organizacionId)
  if (eEmp) throw new Error(`No se pudieron leer las empresas: ${eEmp.message}`)
  const nombreDe = new Map((emp ?? []).map((e) => [String(e.id), String(e.nombre)]))
  if (!nombreDe.size) return r
  const { data, error } = await db.from('cuentas_origen').select('id, empresa_id, nombre').eq('banco', 'MP').eq('activa', true).in('empresa_id', [...nombreDe.keys()])
  if (error) throw new Error(`No se pudieron leer las cuentas de Mercado Pago: ${error.message}`)
  const cuentas = (data ?? []) as CuentaMP[]
  if (!cuentas.length) return r

  for (const empresaId of [...new Set(cuentas.map((c) => c.empresa_id))]) {
    const nombre = nombreDe.get(empresaId) ?? empresaId
    const propias = cuentas.filter((c) => c.empresa_id === empresaId)
    const token = tokenDeMercadoPago(empresaId, cuentas.length, entorno)
    if (!token) {
      const d = `falta ${nombreVariableToken(empresaId)} (o MERCADOPAGO_TOKEN si es la única cuenta de Mercado Pago): no se leyó nada`
      r.lineas.push(`${nombre}: ${d}`)
      await registrar(empresaId, 'OMITIDO', `Mercado Pago: ${d}`)
      continue
    }
    if (propias.length > 1) {
      const d = `tiene ${propias.length} cuentas de Mercado Pago: no se sabe a cuál va el informe, no se cargó nada`
      r.lineas.push(`${nombre}: ${d}`)
      await registrar(empresaId, 'ERROR', `Mercado Pago: ${d}`)
      continue
    }
    const cuenta = propias[0]
    try {
      const todos = await listarInformes(f, token)
      if (!todos.length) {
        const d = 'Mercado Pago no tiene informes de liberaciones generados (hay que configurarlos para que se generen solos todos los días)'
        r.lineas.push(`${nombre}: ${d}`)
        await registrar(empresaId, 'OMITIDO', d)
      }
      // Los que ya se importaron (por nombre) no se bajan de nuevo.
      const nombres = todos.map((i) => nombreArchivo(i.file_name))
      const ya = new Set<string>()
      if (nombres.length) {
        const { data: ex, error: eEx } = await db.from('extractos').select('archivo_nombre').eq('cuenta_origen_id', cuenta.id).in('archivo_nombre', nombres)
        if (eEx) throw new Error(`no se pudieron leer los extractos ya importados: ${eEx.message}`)
        for (const x of ex ?? []) ya.add(String((x as { archivo_nombre: string }).archivo_nombre))
      }
      let faltan = todos.filter((i) => !ya.has(nombreArchivo(i.file_name)))
      if (o.maximoInformes) faltan = faltan.slice(0, o.maximoInformes)
      for (const [k, inf] of faltan.entries()) {
        if (Date.now() - inicio > (o.presupuestoMs ?? 20_000)) {
          const d = `se quedó sin tiempo: faltan ${faltan.length - k} informes, siguen en la próxima corrida`
          r.lineas.push(`${nombre}: ${d}`)
          break
        }
        try {
          const texto = await bajarInforme(f, token, inf.file_name)
          const e = armarExtractoMP(leerInformeLiberaciones(texto))
          if (!e.movimientos.length && !e.saldos.length) {
            r.lineas.push(`${nombre}: el informe ${inf.file_name} no trae movimientos`)
            continue
          }
          const hash = createHash('sha256').update(`${cuenta.id}
${inf.file_name}
${texto}`).digest('hex')
          const { data: res, error: eImp } = await db.rpc('importar_extracto', {
            p: {
              cuenta_origen_id: cuenta.id,
              usuario: 'mercadopago-api',
              archivo: { nombre: nombreArchivo(inf.file_name), path: null, hash, formato: 'MERCADOPAGO_API' },
              movimientos: e.movimientos,
              saldos: e.saldos,
              origen_saldos: 'EXTRACTO',
            },
          })
          if (eImp) throw new Error(`no se pudo importar: ${eImp.message}`)
          const x = (res ?? {}) as { repetido?: boolean; nuevos?: number }
          if (x.repetido) continue
          r.importados++
          const d = `${inf.file_name}: ${x.nuevos ?? 0} movimientos nuevos de ${e.movimientos.length} (del ${e.desde} al ${e.hasta})`
          r.lineas.push(`${nombre}: ${d}`)
          await registrar(empresaId, 'OK', `Mercado Pago ${d}`)
        } catch (err) {
          // Un informe roto se registra y se sigue con los demás.
          const d = `el informe ${inf.file_name} no se pudo cargar (${err instanceof Error ? err.message : String(err)})`
          r.lineas.push(`${nombre}: ${d}`)
          await registrar(empresaId, 'ERROR', `Mercado Pago: ${d}`)
        }
      }
      const disp = await saldoDisponible(f, token)
      if (disp !== null) r.lineas.push(`${nombre}: saldo disponible hoy en Mercado Pago $ ${disp.toFixed(2)} (informativo)`)
    } catch (err) {
      const d = err instanceof Error ? err.message : String(err)
      r.lineas.push(`${nombre}: ${d}`)
      await registrar(empresaId, 'ERROR', `Mercado Pago: ${d}`)
    }
  }
  return r
}
