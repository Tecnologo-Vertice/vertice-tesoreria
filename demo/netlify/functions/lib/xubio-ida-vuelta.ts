// Lo que se le LEE a Xubio para completar la base (Tanda "Xubio de ida y vuelta"). Todo es solo lectura en Xubio (GET):
// lo que se escribe es en la base, por funciones de SQL de la migración 0037. Sin credenciales de una empresa, esa empresa se
// salta con un aviso (en local y en las pruebas no hace falta Xubio real).
//   1. N° de orden de pago de los pagos contabilizados (PagoFactura.js: completarNumerosOPDesdeXubio, 9 y 14 h).
//   2. Saldo de cada cuenta de Xubio → lecturas_xubio (ConciliacionBancaria.js: obtenerConciliacionBancaria).
//   3. Cobranzas → cobros (ConciliacionBancaria.js: cbxTraerCobranzasXubio, 8:30).
//   4. Facturas pagadas (Code.js: sincronizarFacturasPagadas_, cada hora): no consulta Xubio, cruza con los pagos cargados.

import type { SupabaseClient } from '@supabase/supabase-js'
import { hoyBuenosAires } from './control-diario'
import * as xubio from './xubio'
import { TOPE_XUBIO_LARGO_MS } from './xubio'
import { idNumerico, registrarProceso, type EstadoLog, type Proceso } from './xubio-bancos'
import { mismoProveedor, nucleoAcreedor } from './xubio-nombres'

const mensaje = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 160)
type Fila = Record<string, unknown>

const sumarDias = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export interface OpcionesLectura {
  organizacionId: string
  /** Solo estas empresas (cuando lo pide una persona). Sin lista: todas las de la organización con Xubio. */
  empresas?: string[]
  /** Corte de tiempo de la corrida (Netlify corta las tareas programadas). */
  presupuestoMs?: number
  usuario?: string
}

export interface ResultadoLectura {
  lineas: string[]
  /** Cuántos registros quedaron guardados en la base. */
  guardados: number
}

/** Empresas con Xubio de la organización, cada una con su token (o el motivo por el que no se pudo). */
async function empresasConToken(db: SupabaseClient, o: OpcionesLectura) {
  const { data, error } = await db.from('empresas').select('id, nombre, erp').eq('organizacion_id', o.organizacionId).eq('erp', 'XUBIO')
  if (error) throw new Error(`No se pudieron leer las empresas: ${error.message}`)
  const lista = (data ?? []).filter((e) => !o.empresas || o.empresas.includes(String(e.id)))
  return lista.map((e) => {
    const id = String(e.id)
    const nombre = String(e.nombre)
    // El token se pide recién al usarlo, para no pedirlo de empresas que no tienen nada que leer.
    let t: Promise<xubio.Token | string> | null = null
    const token = () =>
      (t ??= (async () => {
        try {
          const cred = await xubio.credencialesDe(db, id)
          if (!cred) return 'sin credenciales de Xubio'
          return await xubio.token(cred)
        } catch (err) {
          return `sin conexión con Xubio (${mensaje(err)})`
        }
      })())
    return { id, nombre, token }
  })
}

const registrar = (db: SupabaseClient, o: OpcionesLectura, d: { empresaId?: string; proceso: Proceso; entidad: string; estado: EstadoLog; detalle: string; datos?: unknown }) =>
  registrarProceso(db, { organizacionId: o.organizacionId, empresaId: d.empresaId, proceso: d.proceso, real: true, entidad: d.entidad, estado: d.estado, detalle: d.detalle, datos: d.datos })

// ================================================================ 1. N° de orden de pago

/** El número visible de la OP ("X-0001-00002312"). Xubio no documenta el campo: se prueba por nombre y por forma. */
export function numeroOPDeObjetoXubio(o: unknown): string {
  if (!o || typeof o !== 'object') return ''
  const obj = o as Fila
  const forma = /^[A-Z]{1,2}-?\d{4}-\d{8}$/
  for (const k of ['numeroDocumento', 'numero', 'numeroComprobante', 'nombre', 'comprobante']) {
    const v = String(obj[k] ?? '').trim()
    if (forma.test(v)) return v
  }
  const hallado = Object.values(obj).find((v) => typeof v === 'string' && forma.test(v.trim()))
  return hallado ? String(hallado).trim() : ''
}

export { mismoProveedor, nucleoAcreedor }

export interface PagoSinNumero {
  id: string
  empresa_id: string
  fecha: string
  importe: number
  proveedor: string
  xubio_id: string | null
}

export type ResultadoEmparejar = { tipo: 'NUMERO'; numero: string } | { tipo: 'VARIAS'; cuantas: number } | { tipo: 'NINGUNA' }

/**
 * Qué OP de Xubio es de este pago. Si el pago trae su id de Xubio, la OP con ese id; si no, mismo proveedor, mismo importe
 * (menos de $1) y fecha a ±10 días. Solo cuenta si queda UN número reconocible que no esté usado por otro pago.
 */
export function emparejarNumeroOP(p: PagoSinNumero, opsXubio: Fila[], usados: Set<string>): ResultadoEmparejar {
  const idXubio = idNumerico(p.xubio_id)
  let candidatas: Fila[]
  if (idXubio) {
    candidatas = opsXubio.filter((x) => String(x.transaccionid ?? x.transaccionId ?? '') === idXubio)
  } else {
    const tPago = new Date(p.fecha + 'T12:00:00Z').getTime()
    candidatas = opsXubio.filter((x) => {
      const pr = x.proveedor as { nombre?: string; razonSocial?: string } | undefined
      if (!mismoProveedor(pr?.nombre || pr?.razonSocial || '', p.proveedor)) return false
      const instrumentos = Array.isArray(x.transaccionInstrumentoDePago) ? (x.transaccionInstrumentoDePago as { importe?: unknown }[]) : []
      const total = instrumentos.reduce((a, i) => a + (Number(i.importe) || 0), 0)
      if (Math.abs(total - Number(p.importe)) >= 1) return false
      const tOp = new Date(String(x.fecha ?? '').slice(0, 10) + 'T12:00:00Z').getTime()
      return Number.isNaN(tOp) || Math.abs(tOp - tPago) <= 10 * 86_400_000
    })
  }
  const numeros = candidatas.map((x) => numeroOPDeObjetoXubio(x)).filter((n) => n && !usados.has(n))
  if (numeros.length === 1) return { tipo: 'NUMERO', numero: numeros[0] }
  if (numeros.length > 1) return { tipo: 'VARIAS', cuantas: numeros.length }
  return { tipo: 'NINGUNA' }
}

/**
 * Busca en Xubio el N° de OP de los pagos contabilizados que todavía no lo tienen y lo guarda (aplicar_numero_op_xubio no pisa
 * uno ya cargado a mano). Si hay más de una OP posible, no elige: queda para cargar a mano desde Contabilización.
 */
export async function completarNumerosOP(db: SupabaseClient, o: OpcionesLectura): Promise<ResultadoLectura> {
  const inicio = Date.now()
  const queda = () => Date.now() - inicio < (o.presupuestoMs ?? 18_000)
  const r: ResultadoLectura = { lineas: [], guardados: 0 }
  const { data, error } = await db.rpc('numero_op_pendientes', { p_organizacion: o.organizacionId, p_max: 200 })
  if (error) throw new Error(`No se pudieron leer los pagos sin N° de OP: ${error.message}`)
  const d = (data ?? { pendientes: [], usados: [] }) as { pendientes: PagoSinNumero[]; usados: { empresa_id: string; numero: string }[] }
  // Cada empresa es una cuenta de Xubio con su propia numeración: un N° "usado" lo es solo dentro de su empresa.
  const usadosPorEmpresa = new Map<string, Set<string>>()
  for (const u of d.usados ?? []) usadosPorEmpresa.set(u.empresa_id, (usadosPorEmpresa.get(u.empresa_id) ?? usadosPorEmpresa.set(u.empresa_id, new Set()).get(u.empresa_id)!).add(String(u.numero)))
  const pendientes = (d.pendientes ?? []).map((p) => ({ ...p, importe: Number(p.importe) }))
  if (!pendientes.length) {
    r.lineas.push('N° de OP: no hay pagos esperando su número.')
    return r
  }
  for (const e of await empresasConToken(db, o)) {
    const lista = pendientes.filter((p) => p.empresa_id === e.id)
    if (!lista.length) continue
    if (!queda()) {
      r.lineas.push(`${e.nombre}: se quedó sin tiempo, sigue en la próxima corrida`)
      continue
    }
    const t = await e.token()
    if (typeof t === 'string') {
      r.lineas.push(`${e.nombre}: ${t}`)
      await registrar(db, o, { empresaId: e.id, proceso: 'XUBIO_PAGOS', entidad: 'NUMERO_OP', estado: 'ERROR', detalle: t })
      continue
    }
    const fechas = lista.map((p) => new Date(p.fecha + 'T12:00:00Z').getTime()).filter((x) => !Number.isNaN(x))
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const desde = iso(Math.min(...fechas) - 10 * 86_400_000)
    const hasta = iso(Math.max(...fechas) + 10 * 86_400_000)
    let ops: Fila[]
    try {
      const x = await xubio.get<unknown>(t, 'pagoBean', `fechaDesde=${desde}&fechaHasta=${hasta}`, TOPE_XUBIO_LARGO_MS)
      ops = Array.isArray(x) ? (x as Fila[]) : []
    } catch (err) {
      r.lineas.push(`${e.nombre}: no se pudo leer Xubio (${mensaje(err)})`)
      await registrar(db, o, { empresaId: e.id, proceso: 'XUBIO_PAGOS', entidad: 'NUMERO_OP', estado: 'ERROR', detalle: `No se pudo leer Xubio (${mensaje(err)})` })
      continue
    }
    if (ops.length && !numeroOPDeObjetoXubio(ops[0]))
      r.lineas.push(`${e.nombre}: las OP de Xubio no traen un número reconocible. Campos: ${Object.keys(ops[0]).slice(0, 25).join(', ')}`)
    const usados = usadosPorEmpresa.get(e.id) ?? usadosPorEmpresa.set(e.id, new Set()).get(e.id)!
    let puestos = 0
    let varias = 0
    for (const p of lista) {
      const m = emparejarNumeroOP(p, ops, usados)
      if (m.tipo === 'VARIAS') {
        varias++
        r.lineas.push(`${e.nombre} · ${p.proveedor}: hay ${m.cuantas} OP posibles, se deja para completar a mano`)
        continue
      }
      if (m.tipo !== 'NUMERO') continue
      const { data: puso, error: e2 } = await db.rpc('aplicar_numero_op_xubio', { p_pago: p.id, p_numero: m.numero, p_usuario: o.usuario ?? 'Número de OP desde Xubio' })
      if (e2) {
        r.lineas.push(`${e.nombre} · ${p.proveedor}: no se pudo guardar el N° ${m.numero} (${e2.message})`)
        continue
      }
      if (puso === true) {
        usados.add(m.numero)
        puestos++
        r.lineas.push(`${e.nombre} · ${p.proveedor}: N° ${m.numero}`)
      }
    }
    r.guardados += puestos
    await registrar(db, o, { empresaId: e.id, proceso: 'XUBIO_PAGOS', entidad: 'NUMERO_OP', estado: 'OK', detalle: `${lista.length} pago(s) sin N°, ${ops.length} OP leídas de Xubio, ${puestos} completados${varias ? `, ${varias} con varias OP posibles` : ''}`, datos: { puestos, varias } })
  }
  return r
}

// ================================================================ 2. Saldo de Xubio

const CAMPOS_SALDO = ['saldo', 'saldoActual', 'saldoContable', 'saldoCuenta', 'importeSaldo']

/** El saldo que trae una cuenta de Xubio, si trae alguno. [FALTA confirmar]: cuál de estos campos usa la API real. */
export function saldoDeCuentaXubio(c: Fila): number | null {
  for (const k of CAMPOS_SALDO) {
    const v = c[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  }
  return null
}

/**
 * Lee las cuentas de cada empresa de Xubio (plan de cuentas con saldo), arma [{cuenta, saldo}] y lo guarda en lecturas_xubio con
 * la fecha pedida (por defecto, el día hábil anterior: Xubio llega hasta ese día). Solo se guardan las que se emparejan con una
 * cuenta bancaria por los dígitos del nombre (emparejar_cuenta_xubio). Si Xubio no informa saldos en la API, avisa y no guarda nada.
 */
export async function leerSaldosXubio(db: SupabaseClient, o: OpcionesLectura & { fecha?: string }): Promise<ResultadoLectura & { fecha: string }> {
  const inicio = Date.now()
  const queda = () => Date.now() - inicio < (o.presupuestoMs ?? 18_000)
  let fecha = o.fecha
  if (!fecha) {
    const { data, error } = await db.rpc('dia_habil_anterior', { p_fecha: hoyBuenosAires() })
    if (error) throw new Error(`No se pudo calcular el día hábil anterior: ${error.message}`)
    fecha = String(data).slice(0, 10)
  }
  const r: ResultadoLectura & { fecha: string } = { lineas: [], guardados: 0, fecha }
  for (const e of await empresasConToken(db, o)) {
    if (!queda()) {
      r.lineas.push(`${e.nombre}: se quedó sin tiempo, sigue en la próxima corrida`)
      continue
    }
    const t = await e.token()
    if (typeof t === 'string') {
      r.lineas.push(`${e.nombre}: ${t}`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'SALDO', estado: 'ERROR', detalle: t })
      continue
    }
    let cuentas: Fila[]
    try {
      const x = await xubio.get<unknown>(t, 'cuenta', 'activo=1')
      cuentas = Array.isArray(x) ? (x as Fila[]) : []
    } catch (err) {
      r.lineas.push(`${e.nombre}: no se pudo leer Xubio (${mensaje(err)})`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'SALDO', estado: 'ERROR', detalle: `No se pudo leer Xubio (${mensaje(err)})` })
      continue
    }
    const lecturas = cuentas.flatMap((c) => {
      const saldo = saldoDeCuentaXubio(c)
      const cuenta = String(c.nombre ?? '').trim()
      return saldo == null || !cuenta ? [] : [{ cuenta, saldo }]
    })
    if (!lecturas.length) {
      const detalle = 'Xubio no informa el saldo de las cuentas por la API: no se guardó nada (a confirmar con Xubio; mientras tanto se carga a mano)'
      r.lineas.push(`${e.nombre}: ${detalle}`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'SALDO', estado: 'OMITIDO', detalle, datos: { campos: Object.keys(cuentas[0] ?? {}).slice(0, 25) } })
      continue
    }
    const { data, error } = await db.rpc('registrar_lecturas_xubio', { p_empresa: e.id, p_fecha: fecha, p_lecturas: lecturas, p_usuario: o.usuario ?? 'Saldo de Xubio', p_solo_emparejadas: true })
    if (error) {
      r.lineas.push(`${e.nombre}: no se pudieron guardar los saldos (${error.message})`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'SALDO', estado: 'ERROR', detalle: `No se pudieron guardar los saldos: ${error.message}` })
      continue
    }
    const g = data as { guardadas: number; repetidas: number; sin_cuenta: string[]; duplicadas?: string[] }
    r.guardados += g.guardadas
    r.lineas.push(`${e.nombre}: ${g.guardadas} saldo(s) al ${fecha}, ${g.repetidas} sin cambios, ${g.sin_cuenta.length} cuenta(s) de Xubio sin cuenta bancaria`)
    if (g.duplicadas?.length) {
      const aviso = `Dos cuentas de Xubio para la misma cuenta bancaria, se descartaron las dos: ${g.duplicadas.join(', ')}`
      r.lineas.push(`${e.nombre}: ${aviso}`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'SALDO', estado: 'ERROR', detalle: aviso })
    }
    await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'SALDO', estado: 'OK', detalle: `${g.guardadas} saldo(s) al ${fecha}, ${g.repetidas} sin cambios`, datos: g })
  }
  return r
}

// ================================================================ 3. Cobranzas

export interface CobroXubio {
  fecha: string
  recibo: string
  transaccion_id: string
  instrumento_id: string
  cliente: string
  cuenta: string
  importe: number
  descripcion: string
}

/** Una fila por instrumento de cobro de cada cobranza, como la hoja Cobros_Xubio. */
export function cobrosDeCobranzas(lista: Fila[], nombres: Record<string, string>): CobroXubio[] {
  const filas: CobroXubio[] = []
  for (const cb of lista) {
    const cliente = cb.cliente as { ID?: number; id?: number } | undefined
    const cid = String(cliente?.ID ?? cliente?.id ?? '')
    const instrumentos = Array.isArray(cb.transaccionInstrumentoDeCobro) ? (cb.transaccionInstrumentoDeCobro as Fila[]) : []
    for (const ins of instrumentos) {
      const cuenta = ins.cuenta as { nombre?: string } | undefined
      filas.push({
        fecha: String(cb.fecha ?? '').slice(0, 10),
        recibo: String(cb.numeroRecibo ?? ''),
        transaccion_id: String(cb.transaccionid ?? cb.transaccionId ?? ''),
        instrumento_id: String(ins.transaccionICId ?? ''),
        cliente: nombres[cid] || cid,
        cuenta: String(cuenta?.nombre ?? ''),
        importe: Number(ins.importe) || 0,
        descripcion: String(ins.descripcion || cb.observacion || ''),
      })
    }
  }
  return filas
}

/** Cobranzas de los últimos `diasAtras` días hasta ayer (cbxTraerCobranzasXubio: 5 días) → tabla cobros. */
/** Empresas de las que se traen cobranzas: las que usa el Apps Script (CBX_XUBIO_EMPRESAS: Beratung e India). Se cambia con XUBIO_COBRANZAS_EMPRESAS (ids separados por coma). */
export const empresasDeCobranzas = () => (process.env.XUBIO_COBRANZAS_EMPRESAS?.trim() || 'beratung,india').split(',').map((x) => x.trim()).filter(Boolean)

export async function traerCobranzasXubio(db: SupabaseClient, o: OpcionesLectura & { diasAtras?: number; ahora?: Date }): Promise<ResultadoLectura> {
  const inicio = Date.now()
  const queda = () => Date.now() - inicio < (o.presupuestoMs ?? 18_000)
  const hoy = hoyBuenosAires(o.ahora)
  const desde = sumarDias(hoy, -(o.diasAtras ?? 5))
  const hasta = sumarDias(hoy, -1)
  const r: ResultadoLectura = { lineas: [], guardados: 0 }
  const permitidas = empresasDeCobranzas()
  for (const e of (await empresasConToken(db, o)).filter((x) => permitidas.includes(x.id))) {
    if (!queda()) {
      r.lineas.push(`${e.nombre}: se quedó sin tiempo, sigue en la próxima corrida`)
      continue
    }
    const t = await e.token()
    if (typeof t === 'string') {
      r.lineas.push(`${e.nombre}: ${t}`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'COBRANZA', estado: 'ERROR', detalle: t })
      continue
    }
    let lista: Fila[]
    try {
      const x = await xubio.get<unknown>(t, 'cobranzaBean', `fechaDesde=${desde}&fechaHasta=${hasta}`, TOPE_XUBIO_LARGO_MS)
      lista = Array.isArray(x) ? (x as Fila[]) : []
    } catch (err) {
      r.lineas.push(`${e.nombre}: error ${mensaje(err)}`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'COBRANZA', estado: 'ERROR', detalle: `No se pudo leer las cobranzas (${mensaje(err)})` })
      continue
    }
    // Nombre de cada cliente, una vez cada uno. Si no se puede leer, queda el número (como en el Apps Script).
    const nombres: Record<string, string> = {}
    for (const cb of lista) {
      const c = cb.cliente as { ID?: number; id?: number } | undefined
      const cid = String(c?.ID ?? c?.id ?? '')
      if (!cid || cid in nombres) continue
      if (!queda()) {
        nombres[cid] = cid
        continue
      }
      try {
        const cl = await xubio.get<{ nombre?: string; razonSocial?: string }>(t, `clienteBean/${cid}`)
        nombres[cid] = cl.nombre || cl.razonSocial || cid
      } catch {
        nombres[cid] = cid
      }
    }
    const cobros = cobrosDeCobranzas(lista, nombres)
    if (!cobros.length) {
      r.lineas.push(`${e.nombre}: ${lista.length} cobranzas, 0 nuevas`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'COBRANZA', estado: 'OK', detalle: `${desde} a ${hasta}: ${lista.length} cobranzas, 0 nuevas` })
      continue
    }
    const { data, error } = await db.rpc('importar_cobros_xubio', { p_empresa: e.id, p_cobros: cobros, p_usuario: o.usuario ?? 'Cobranzas de Xubio' })
    if (error) {
      r.lineas.push(`${e.nombre}: no se pudieron guardar las cobranzas (${error.message})`)
      await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'COBRANZA', estado: 'ERROR', detalle: `No se pudieron guardar las cobranzas: ${error.message}` })
      continue
    }
    const g = data as { nuevas: number; ya_estaban: number; omitidas: number }
    r.guardados += g.nuevas
    r.lineas.push(`${e.nombre}: ${lista.length} cobranzas, ${g.nuevas} nuevas`)
    await registrar(db, o, { empresaId: e.id, proceso: 'LECTURA_XUBIO', entidad: 'COBRANZA', estado: 'OK', detalle: `${desde} a ${hasta}: ${lista.length} cobranzas, ${g.nuevas} nuevas, ${g.ya_estaban} ya estaban, ${g.omitidas} sin importe`, datos: g })
  }
  return r
}

// ================================================================ 4. Facturas pagadas

export interface CambioFactura {
  factura: string
  numero: string
  proveedor: string
  total: number
  pagado: number
  tipo: string
}

/** sincronizar_facturas_pagadas (0037) de una organización. Corre en la base, no consulta Xubio. */
export async function sincronizarFacturasPagadas(db: SupabaseClient, o: { organizacionId: string; aplicar?: boolean }) {
  const { data, error } = await db.rpc('sincronizar_facturas_pagadas', { p_organizacion: o.organizacionId, p_aplicar: o.aplicar !== false })
  if (error) throw new Error(`No se pudieron sincronizar las facturas pagadas: ${error.message}`)
  const d = data as { aplicado: boolean; cambios: CambioFactura[]; manual: CambioFactura[] }
  // Cada hora: si no hubo nada, no se llena el registro.
  if (d.cambios.length || d.manual.length)
  await registrarProceso(db, {
    organizacionId: o.organizacionId,
    proceso: 'XUBIO_PAGOS',
    real: d.aplicado,
    entidad: 'FACTURAS_PAGADAS',
    estado: d.aplicado ? 'OK' : 'PRUEBA_OK',
    detalle: `${d.cambios.length} factura(s) ${d.aplicado ? 'marcadas' : 'para marcar'} según los pagos cargados, ${d.manual.length} para revisar a mano`,
    datos: { cambios: d.cambios.length, manual: d.manual.length },
  })
  return d
}

// ================================================================ Una corrida a la vez

/**
 * Corre `fn` solo si nadie más tiene el bloqueo `recurso` (tomar_bloqueo / soltar_bloqueo, como los envíos bancarios): dos corridas
 * de la misma tarea no se pisan. Devuelve null si había otra en curso.
 */
export async function conBloqueo<T>(db: SupabaseClient, recurso: string, fn: () => Promise<T>): Promise<T | null> {
  const dueno = `${recurso}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await db.rpc('tomar_bloqueo', { p_recurso: recurso, p_dueno: dueno, p_segundos: 300 })
  if (error) throw new Error(`No se pudo tomar el bloqueo ${recurso}: ${error.message}`)
  if (data !== true) return null
  try {
    return await fn()
  } finally {
    await db.rpc('soltar_bloqueo', { p_recurso: recurso, p_dueno: dueno })
  }
}
