// Envíos a Xubio de lo bancario (T-202): lo que la base deja "pendiente" sube solo.
//   a) Comprobante "Extracto Bancario" (facturas con cuenta_origen_extracto_id, 0999X-AAAAMMDD con X = dígito de la cuenta, tipo 8):
//      reusa subirFacturaAXubio (reserva para no duplicar, búsqueda por número + CUIT del banco, xubio_log).
//   b) Asientos del banco (asientos + asiento_lineas, estado_xubio PENDIENTE) → POST asientoContableManualBean
//      (el mismo endpoint que usa producción para SALIDA_FONDOS y ASIENTO_MANUAL, docs/12 §6) y
//      resultado_asiento_xubio(), que deja sus movimientos CONTABILIZADOS.
//   c) Anulaciones (anulacion_xubio = 'PENDIENTE' en asientos, pagos y cheques) → HECHA o ERROR.
//      Borrar un asiento manual: DELETE asientoContableManualBean/{id}. [FALTA confirmar endpoint]: no se
//      pudo leer la documentación pública de Xubio; queda detrás de AnuladorXubio y apagado hasta que
//      XUBIO_BORRAR_ASIENTO_CONFIRMADO=true. Las órdenes de pago no se borran por API (xubio.ts): ERROR con
//      el aviso de anularla a mano.
//
// Modo en seco por defecto: XUBIO_BANCOS_ENVIO_REAL=true para enviar de verdad. En seco no cambia ningún
// estado: deja en xubio_log lo que se enviaría y en procesos_log el resultado (modo PRUEBA).

import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from './comun'
import * as xubio from './xubio'
import { CIRCUITO, idCreado, MONEDA_ARS } from './xubio-armado'
import { anularDesde, anularEnXubioAuto, anularOpReal } from './xubio-anular'
import { subirFacturaAXubio } from './xubio-facturas'

export const envioRealBancos = () => env('XUBIO_BANCOS_ENVIO_REAL', false) === 'true'
/** Recién con el endpoint de borrado confirmado contra Xubio real (prueba con un asiento de $1). */
export const borradoAsientoConfirmado = () => env('XUBIO_BORRAR_ASIENTO_CONFIRMADO', false) === 'true'

export const PATH_ASIENTO = 'asientoContableManualBean'
const USUARIO = 'Envíos bancarios'

export type Proceso = 'XUBIO_ASIENTOS' | 'XUBIO_ANULACIONES' | 'CONTROL_DIARIO' | 'XUBIO_PAGOS' | 'LECTURA_XUBIO'
export type EstadoLog = 'OK' | 'PRUEBA_OK' | 'ERROR' | 'OMITIDO'

export interface Item {
  entidad: 'COMPROBANTE' | 'ASIENTO' | 'ANULAR_ASIENTO' | 'ANULAR_PAGO' | 'ANULAR_CHEQUE'
  id: string
  estado: EstadoLog
  detalle: string
}

/** procesos_log: si no se puede escribir, se avisa en la consola y se sigue (el estado ya quedó en la tabla). */
export async function registrarProceso(
  db: SupabaseClient,
  d: { organizacionId: string; empresaId?: string | null; proceso: Proceso; real: boolean; entidad?: string; entidadId?: string; estado: EstadoLog; detalle: string; datos?: unknown },
) {
  const { error } = await db.from('procesos_log').insert({
    organizacion_id: d.organizacionId,
    empresa_id: d.empresaId ?? null,
    proceso: d.proceso,
    modo: d.real ? 'REAL' : 'PRUEBA',
    entidad: d.entidad ?? null,
    entidad_id: d.entidadId ?? null,
    estado: d.estado,
    detalle: d.detalle.slice(0, 1000),
    datos: d.datos ?? null,
  })
  if (error) console.error('procesos_log:', error.message)
}

// ---------------------------------------------------------------- Armado (sin red)

export interface LineaAsiento {
  cuenta_contable: string
  debe: number
  haber: number
  detalle?: string | null
}

const centavos = (n: number) => Math.round(Number(n) * 100)

/** Debe = haber, al menos dos líneas, cada línea de un solo lado. Devuelve el motivo si no se puede subir. */
export function problemaDeAsiento(lineas: LineaAsiento[]): string | null {
  if (lineas.length < 2) return 'El asiento no tiene líneas suficientes'
  if (lineas.some((l) => (centavos(l.debe) > 0) === (centavos(l.haber) > 0))) return 'Hay una línea con debe y haber a la vez (o en cero)'
  const dif = lineas.reduce((a, l) => a + centavos(l.debe) - centavos(l.haber), 0)
  if (dif !== 0) return `El asiento no balancea (debe − haber = ${dif / 100})`
  return null
}

/** Asiento manual de Xubio con varias líneas. Misma forma que asientoManual de xubio.ts (debeHaber 1 debe, -1 haber). */
export function asientoBancario(a: { id: string; fecha: string; descripcion: string }, lineas: (LineaAsiento & { cuenta: xubio.RefXubio })[]) {
  const total = lineas.reduce((x, l) => x + centavos(l.debe), 0) / 100
  return {
    circuitoContable: CIRCUITO,
    fecha: a.fecha,
    descripcion: a.descripcion,
    numeroDocumento: '',
    nombre: a.descripcion.slice(0, 100),
    externalId: a.id,
    importetotal: total,
    importeImpuestos: 0,
    importeGravado: 0,
    asientoContableManualItem: lineas.map((l) => ({
      cuenta: l.cuenta,
      debeHaber: centavos(l.debe) > 0 ? 1 : -1,
      importe: (centavos(l.debe) > 0 ? centavos(l.debe) : centavos(l.haber)) / 100,
      descripcion: l.detalle || a.descripcion,
      moneda: MONEDA_ARS,
      cotizacion: 1,
    })),
  }
}

/** Id numérico de Xubio a partir de lo guardado ("7001", "OP-7001"). null si es otra cosa (p. ej. "FC-…": pago dentro de una factura). */
export function idNumerico(guardado: string | null | undefined): string | null {
  const m = /^(?:OP-)?(\d+)$/.exec(String(guardado ?? '').trim())
  return m ? m[1] : null
}

// ---------------------------------------------------------------- Anulador (interfaz)

/** Cómo se borra en Xubio. Separado para poder cambiar el endpoint cuando se confirme sin tocar el resto. */
export interface AnuladorXubio {
  /** false = el endpoint no está confirmado: no se llama a Xubio y la anulación queda PENDIENTE. */
  confirmado: boolean
  descripcion: string
  borrarAsiento(t: xubio.Token, xubioId: string): Promise<{ status: number; body: unknown }>
}

/** [FALTA confirmar endpoint] DELETE asientoContableManualBean/{id}: el comentario de xubio.ts dice que los
 *  asientos manuales se pueden borrar por API, pero no se verificó contra la documentación ni contra Xubio real. */
export const anuladorPorDefecto = (): AnuladorXubio => ({
  confirmado: borradoAsientoConfirmado(),
  descripcion: `DELETE ${PATH_ASIENTO}/{id}`,
  borrarAsiento: (t, id) => xubio.borrar(t, `${PATH_ASIENTO}/${id}`),
})

// ---------------------------------------------------------------- Conexión por empresa

interface Conexion {
  t: xubio.Token
  cuentas: xubio.RefXubio[]
}

/** Token y plan de cuentas de cada empresa, una sola vez por corrida. null = sin credenciales. */
function conexiones(db: SupabaseClient) {
  const cache = new Map<string, Promise<Conexion | null>>()
  return (empresaId: string, conCuentas: boolean) => {
    const clave = `${empresaId}:${conCuentas}`
    if (!cache.has(clave))
      cache.set(
        clave,
        (async () => {
          const creds = await xubio.credencialesDe(db, empresaId)
          if (!creds) return null
          const t = await xubio.token(creds)
          return { t, cuentas: conCuentas ? await xubio.cuentas(t) : [] }
        })(),
      )
    return cache.get(clave)!
  }
}

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e))
const textoRespuesta = (b: unknown) => (typeof b === 'string' ? b : JSON.stringify(b ?? '')).slice(0, 250)

// ---------------------------------------------------------------- Corrida

export interface OpcionesBancos {
  organizacionId: string
  /** Para la corrida manual: solo las empresas que ve quien la pide. */
  empresas?: string[]
  real: boolean
  usuario?: string
  /** Máximo por tipo y por corrida. */
  max?: number
  /** Tiempo de la corrida (Netlify corta). */
  presupuestoMs?: number
  anulador?: AnuladorXubio
}

export interface ResumenBancos {
  organizacionId: string
  real: boolean
  omitido?: string
  items: Item[]
}

export async function procesarPendientesBancos(db: SupabaseClient, o: OpcionesBancos): Promise<ResumenBancos> {
  const inicio = Date.now()
  const queda = () => Date.now() - inicio < (o.presupuestoMs ?? 18_000)
  const max = o.max ?? 10
  const usuario = o.usuario ?? USUARIO
  const anulador = o.anulador ?? anuladorPorDefecto()
  const resumen: ResumenBancos = { organizacionId: o.organizacionId, real: o.real, items: [] }

  const { data: emps, error: eEmp } = await db.from('empresas').select('id, nombre, erp').eq('organizacion_id', o.organizacionId).eq('erp', 'XUBIO')
  if (eEmp) throw new Error(`No se pudieron leer las empresas: ${eEmp.message}`)
  const empresas = (emps ?? []).map((e) => String(e.id)).filter((id) => !o.empresas || o.empresas.includes(id))
  if (!empresas.length) return { ...resumen, omitido: 'Ninguna empresa con Xubio' }

  // Una sola corrida por organización a la vez (la programada y la manual no se pisan).
  const recurso = `xubio-bancos:${o.organizacionId}`
  const dueno = `${usuario}:${inicio}:${Math.random().toString(36).slice(2, 8)}`
  const { data: tomado, error: eBloq } = await db.rpc('tomar_bloqueo', { p_recurso: recurso, p_dueno: dueno, p_segundos: 300 })
  if (eBloq) throw new Error(`No se pudo tomar el bloqueo: ${eBloq.message}`)
  if (tomado !== true) return { ...resumen, omitido: 'Hay otra corrida de envíos bancarios en curso' }

  const con = conexiones(db)
  const log = async (it: Item & { empresaId: string; proceso: Proceso; datos?: unknown }) => {
    resumen.items.push({ entidad: it.entidad, id: it.id, estado: it.estado, detalle: it.detalle })
    await registrarProceso(db, { organizacionId: o.organizacionId, empresaId: it.empresaId, proceso: it.proceso, real: o.real, entidad: it.entidad, entidadId: it.id, estado: it.estado, detalle: it.detalle, datos: it.datos })
  }

  try {
    // ------------------------------------------------ a) Comprobantes "Extracto Bancario"
    {
      const { data, error } = await db
        .from('facturas')
        .select('id, empresa_id, cuenta_origen_extracto_id, punto_venta, numero')
        .in('empresa_id', empresas)
        .eq('tipo', 'Extracto Bancario')
        .eq('estado_xubio', 'PENDIENTE')
        .in('estado', ['PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA'])
        .is('xubio_envio_en', null)
        .order('fecha')
        .limit(max)
      if (error) throw new Error(`No se pudieron leer los comprobantes: ${error.message}`)
      for (const f of (data ?? []).filter((x) => x.cuenta_origen_extracto_id)) {
        if (!queda()) break
        const nro = `${String(f.punto_venta ?? 9990).padStart(5, '0')}-${f.numero}`
        try {
          const r = await subirFacturaAXubio(db, String(f.id), usuario, { real: o.real })
          const estado: EstadoLog = r.estado === 'SUBIDA' ? 'OK' : r.estado === 'EN_SECO' ? 'PRUEBA_OK' : r.estado === 'ERROR' ? 'ERROR' : 'OMITIDO'
          await log({ entidad: 'COMPROBANTE', id: String(f.id), empresaId: String(f.empresa_id), proceso: 'XUBIO_ASIENTOS', estado, detalle: `${nro}: ${r.detalle}`, datos: { xubio_id: r.xubioId ?? null } })
        } catch (e) {
          await log({ entidad: 'COMPROBANTE', id: String(f.id), empresaId: String(f.empresa_id), proceso: 'XUBIO_ASIENTOS', estado: 'ERROR', detalle: `${nro}: ${mensaje(e)}` })
        }
      }
    }

    // ------------------------------------------------ b) Asientos
    {
      const { data, error } = await db
        .from('asientos')
        .select('id, empresa_id, fecha, descripcion, tipo, xubio_id')
        .in('empresa_id', empresas)
        .eq('estado_xubio', 'PENDIENTE')
        .is('anulado_en', null)
        .is('envio_xubio_en', null)
        .order('fecha')
        .limit(max)
      if (error) throw new Error(`No se pudieron leer los asientos: ${error.message}`)
      for (const a of data ?? []) {
        if (!queda()) break
        await subirAsiento(db, a as AsientoFila, o.real, usuario, con, log)
      }
    }

    // ------------------------------------------------ c) Anulaciones
    const pendientes = async (tabla: 'asientos' | 'pagos' | 'cheques', columnas: string) => {
      const { data, error } = await db.from(tabla).select(columnas).in('empresa_id', empresas).eq('anulacion_xubio', 'PENDIENTE').limit(max)
      if (error) throw new Error(`No se pudieron leer las anulaciones de ${tabla}: ${error.message}`)
      return (data ?? []) as unknown as Record<string, unknown>[]
    }
    const marcar = async (tabla: 'asientos' | 'pagos' | 'cheques', id: string, estado: 'HECHA' | 'ERROR') => {
      const { error } = await db.from(tabla).update({ anulacion_xubio: estado }).eq('id', id).eq('anulacion_xubio', 'PENDIENTE')
      if (error) throw new Error(`No se pudo marcar la anulación (${tabla} ${id}): ${error.message}`)
    }

    const anularAsientoEnXubio = async (tabla: 'asientos' | 'pagos', entidad: Item['entidad'], id: string, empresaId: string, xubioId: string) => {
      const base = { entidad, id, empresaId, proceso: 'XUBIO_ANULACIONES' as const }
      if (!anulador.confirmado) {
        await log({ ...base, estado: 'OMITIDO', detalle: `[FALTA confirmar endpoint] ${anulador.descripcion}: queda PENDIENTE de anular en Xubio (id ${xubioId})` })
        return
      }
      if (!o.real) {
        await db.from('xubio_log').insert({ empresa_id: empresaId, entidad: tabla === 'asientos' ? 'ASIENTO' : 'PAGO', entidad_id: id, en_seco: true, request: { metodo: 'DELETE', path: `${PATH_ASIENTO}/${xubioId}` }, usuario })
        await log({ ...base, estado: 'PRUEBA_OK', detalle: `En seco: se borraría el asiento ${xubioId} de Xubio` })
        return
      }
      let c: Conexion | null
      try {
        c = await con(empresaId, false)
      } catch (e) {
        await marcar(tabla, id, 'ERROR')
        await log({ ...base, estado: 'ERROR', detalle: `No se pudo conectar con Xubio: ${mensaje(e)}` })
        return
      }
      if (!c) {
        await marcar(tabla, id, 'ERROR')
        await log({ ...base, estado: 'ERROR', detalle: `Faltan las credenciales de Xubio de ${empresaId}` })
        return
      }
      let r: { status: number; body: unknown }
      try {
        r = await anulador.borrarAsiento(c.t, xubioId)
      } catch (e) {
        await marcar(tabla, id, 'ERROR')
        await log({ ...base, estado: 'ERROR', detalle: `${mensaje(e)}: no se sabe si Xubio borró el asiento ${xubioId}. Verificar en Xubio.` })
        return
      }
      await db.from('xubio_log').insert({ empresa_id: empresaId, entidad: tabla === 'asientos' ? 'ASIENTO' : 'PAGO', entidad_id: id, en_seco: false, request: { metodo: 'DELETE', path: `${PATH_ASIENTO}/${xubioId}` }, response: r.body, http_status: r.status, usuario })
      if (r.status >= 200 && r.status < 300) {
        await marcar(tabla, id, 'HECHA')
        await log({ ...base, estado: 'OK', detalle: `Asiento ${xubioId} borrado de Xubio` })
      } else {
        await marcar(tabla, id, 'ERROR')
        await log({ ...base, estado: 'ERROR', detalle: `Xubio respondió ${r.status} al borrar el asiento ${xubioId}: ${textoRespuesta(r.body)}` })
      }
    }

    for (const a of await pendientes('asientos', 'id, empresa_id, xubio_id')) {
      if (!queda()) break
      const id = idNumerico(a.xubio_id as string)
      if (!id) {
        await marcar('asientos', String(a.id), 'ERROR')
        await log({ entidad: 'ANULAR_ASIENTO', id: String(a.id), empresaId: String(a.empresa_id), proceso: 'XUBIO_ANULACIONES', estado: 'ERROR', detalle: `El id de Xubio guardado ("${a.xubio_id ?? ''}") no es un número: anular a mano` })
        continue
      }
      await anularAsientoEnXubio('asientos', 'ANULAR_ASIENTO', String(a.id), String(a.empresa_id), id)
    }

    const anularPagoPorApi = async (p: Record<string, unknown>, id: string) => {
      const base = { entidad: 'ANULAR_PAGO' as const, id: String(p.id), empresaId: String(p.empresa_id), proceso: 'XUBIO_ANULACIONES' as const }
      const importe = Number(p.importe) || 0
      const prov = p.proveedores as { nombre?: string } | { nombre?: string }[] | null | undefined
      const proveedor = String((Array.isArray(prov) ? prov[0]?.nombre : prov?.nombre) || p.proveedor_destino || '')
      const fecha = p.fecha ? String(p.fecha).slice(0, 10) : undefined
      if (!o.real) {
        await db.from('xubio_log').insert({ empresa_id: base.empresaId, entidad: 'PAGO', entidad_id: base.id, en_seco: true, request: { metodo: 'DELETE', path: `pagoBean o asientoContableManualBean /${id}`, importe, verifica: 'importe (suma de los instrumentos), proveedor y fecha antes de borrar' }, usuario })
        await log({ ...base, estado: 'PRUEBA_OK', detalle: `En seco: se anularía en Xubio la orden de pago (o el asiento) ${id}, verificando antes importe ${importe}, proveedor y fecha` })
        return
      }
      // Si no se puede marcar el resultado se registra y la corrida sigue con el resto (la próxima vuelta lo vuelve a ver).
      const resultado = async (estado: 'HECHA' | 'ERROR', detalle: string) => {
        const { error } = await db.rpc('resultado_anulacion_xubio', { p_tabla: 'pagos', p_id: base.id, p_estado: estado, p_detalle: detalle })
        if (error) await log({ ...base, estado: 'ERROR', detalle: `No se pudo marcar la anulación (${estado}) del pago ${base.id}: ${error.message}. Detalle: ${detalle}` })
      }
      let c: Conexion | null
      try {
        c = await con(base.empresaId, false)
      } catch (e) {
        await log({ ...base, estado: 'OMITIDO', detalle: `No se pudo conectar con Xubio (${mensaje(e)}): se reintenta en la próxima corrida` })
        return
      }
      if (!c) {
        await resultado('ERROR', `Faltan las credenciales de Xubio de ${base.empresaId}`)
        await log({ ...base, estado: 'ERROR', detalle: `Faltan las credenciales de Xubio de ${base.empresaId}` })
        return
      }
      const r = await anularEnXubioAuto(c.t, { id, importe, proveedor, fecha })
      // Solo queda como DELETE lo que de verdad se mandó; si se frenó antes, el registro dice que fue una lectura.
      await db.from('xubio_log').insert({ empresa_id: base.empresaId, entidad: 'PAGO', entidad_id: base.id, en_seco: false, request: { metodo: r.path ? 'DELETE' : 'GET', path: `${r.path ?? 'pagoBean o asientoContableManualBean'}/${id}`, importe }, response: r.ok ? r.body : { error: r.error }, http_status: r.status ?? null, usuario })
      if (r.ok) {
        await resultado('HECHA', `Anulado en Xubio: ${r.que} ${id}`)
        await log({ ...base, estado: 'OK', detalle: `Anulado también en Xubio: ${r.que} ${id}` })
      } else if (r.reintentar) {
        // Pasajero (límite de pedidos, sesión, sin conexión): no se marca nada, queda PENDIENTE.
        await log({ ...base, estado: 'OMITIDO', detalle: r.error ?? 'Xubio no pudo responder ahora: se reintenta' })
      } else {
        await resultado('ERROR', r.error ?? 'No se pudo anular en Xubio')
        await log({ ...base, estado: 'ERROR', detalle: `${r.error ?? 'No se pudo anular en Xubio'}. Anular a mano en Xubio.` })
      }
    }

    // Anulación por API: solo con la variable prendida, solo pagos del sistema anulados desde XUBIO_ANULAR_DESDE (sin esa fecha
    // no procesa nada: el atraso de la 0024 y lo que el Apps Script ya anuló no se toca).
    const desde = anularOpReal() ? anularDesde() : null
    for (const p of await pendientes('pagos', 'id, empresa_id, xubio_id, forma_carga_xubio, importe, fecha, gestion, anulado_en, proveedor_destino, proveedores(nombre)')) {
      if (!queda()) break
      const base = { entidad: 'ANULAR_PAGO' as const, id: String(p.id), empresaId: String(p.empresa_id), proceso: 'XUBIO_ANULACIONES' as const }
      const forma = String(p.forma_carga_xubio ?? '')
      const id = idNumerico(p.xubio_id as string)
      if (desde && id && p.gestion === 'SISTEMA' && p.anulado_en && new Date(String(p.anulado_en)) >= desde) {
        try {
          await anularPagoPorApi(p, id)
        } catch (e) {
          await log({ ...base, estado: 'ERROR', detalle: `Falló la anulación por API: ${mensaje(e)}` })
        }
        continue
      }
      if ((forma === 'SALIDA_FONDOS' || forma === 'ASIENTO_MANUAL') && id) {
        await anularAsientoEnXubio('pagos', 'ANULAR_PAGO', String(p.id), String(p.empresa_id), id)
        continue
      }
      // Orden de pago o pago dentro de la factura: Xubio no lo borra por API. Queda ERROR para que se haga a mano.
      const detalle = `${forma || 'Comprobante'} ${p.xubio_id ?? ''}: Xubio no permite borrarlo por API. Anularlo a mano en Xubio.`
      if (o.real) await marcar('pagos', String(p.id), 'ERROR')
      await log({ ...base, estado: o.real ? 'ERROR' : 'PRUEBA_OK', detalle: o.real ? detalle : `En seco: ${detalle}` })
    }

    for (const ch of await pendientes('cheques', 'id, empresa_id, numero, xubio_emision_id')) {
      if (!queda()) break
      const detalle = `Cheque ${ch.numero} (Xubio ${ch.xubio_emision_id ?? 's/id'}): la emisión es una orden de pago y Xubio no la borra por API. Anularla a mano en Xubio.`
      if (o.real) await marcar('cheques', String(ch.id), 'ERROR')
      await log({ entidad: 'ANULAR_CHEQUE', id: String(ch.id), empresaId: String(ch.empresa_id), proceso: 'XUBIO_ANULACIONES', estado: o.real ? 'ERROR' : 'PRUEBA_OK', detalle: o.real ? detalle : `En seco: ${detalle}` })
    }
  } finally {
    await db.rpc('soltar_bloqueo', { p_recurso: recurso, p_dueno: dueno })
  }
  return resumen
}

interface AsientoFila {
  id: string
  empresa_id: string
  fecha: string
  descripcion: string
  tipo: string
}

async function subirAsiento(
  db: SupabaseClient,
  a: AsientoFila,
  real: boolean,
  usuario: string,
  con: ReturnType<typeof conexiones>,
  log: (it: Item & { empresaId: string; proceso: Proceso; datos?: unknown }) => Promise<void>,
) {
  const base = { entidad: 'ASIENTO' as const, id: a.id, empresaId: a.empresa_id, proceso: 'XUBIO_ASIENTOS' as const }
  // Error claro (no se creó nada en Xubio): ERROR con el motivo. Para reintentar, Tesorería regenera el asiento.
  const fallo = async (motivo: string) => {
    if (real) {
      const { error } = await db.rpc('resultado_asiento_xubio', { p_id: a.id, p_ok: false, p_xubio_id: null, p_error: motivo })
      if (error) motivo += ` (no se pudo marcar el error: ${error.message})`
    }
    await log({ ...base, estado: real ? 'ERROR' : 'PRUEBA_OK', detalle: real ? motivo : `En seco, Xubio lo rechazaría: ${motivo}` })
  }

  const { data: lineasDb, error } = await db.from('asiento_lineas').select('cuenta_contable, debe, haber, detalle').eq('asiento_id', a.id).order('id')
  if (error) return log({ ...base, estado: 'ERROR', detalle: `No se pudieron leer las líneas: ${error.message}` })
  const lineas = (lineasDb ?? []).map((l) => ({ cuenta_contable: String(l.cuenta_contable), debe: Number(l.debe) || 0, haber: Number(l.haber) || 0, detalle: (l.detalle as string | null) ?? null }))
  const problema = problemaDeAsiento(lineas)
  if (problema) return fallo(problema)

  let c: Conexion | null
  try {
    c = await con(a.empresa_id, true)
  } catch (e) {
    return fallo(`No se pudo consultar Xubio: ${mensaje(e)}`)
  }
  if (!c && real) return fallo(`Faltan las credenciales de Xubio de ${a.empresa_id} (ni en la base ni en XUBIO_CREDS_JSON)`)

  const notas: string[] = []
  const conCuenta = lineas.map((l) => ({ ...l, cuenta: c ? xubio.buscarCuenta(c.cuentas, l.cuenta_contable) : ({ ID: 0, id: 0, nombre: l.cuenta_contable, codigo: '' } as xubio.RefXubio) }))
  if (!c) notas.push('sin credenciales: cuentas sin verificar')
  const faltan = conCuenta.filter((l) => !l.cuenta).map((l) => l.cuenta_contable)
  if (faltan.length) return fallo(`Cuentas que no existen en el plan de Xubio: ${[...new Set(faltan)].join(', ')}`)
  const payload = asientoBancario(a, conCuenta as (LineaAsiento & { cuenta: xubio.RefXubio })[])

  if (!real || !c) {
    await db.from('xubio_log').insert({ empresa_id: a.empresa_id, entidad: 'ASIENTO', entidad_id: a.id, en_seco: true, request: { path: PATH_ASIENTO, payload }, usuario })
    return log({ ...base, estado: 'PRUEBA_OK', detalle: `En seco: asiento de ${payload.asientoContableManualItem.length} líneas por ${payload.importetotal}${notas.length ? ` (${notas.join('; ')})` : ''}` })
  }

  // Reserva: un solo envío por asiento. Si otra corrida lo tomó, se sigue con el próximo.
  const { data: reservado } = await db.from('asientos').update({ envio_xubio_en: new Date().toISOString() }).eq('id', a.id).eq('estado_xubio', 'PENDIENTE').is('envio_xubio_en', null).select('id')
  if (!reservado?.length) return log({ ...base, estado: 'OMITIDO', detalle: 'Ya se está enviando (otra corrida lo reservó)' })

  // No se sabe si Xubio lo creó: ERROR con la reserva puesta, para que nadie lo reintente a ciegas.
  const sinConfirmar = async (motivo: string) => {
    await db.from('asientos').update({ estado_xubio: 'ERROR', xubio_error: `Envío sin confirmar: ${motivo}. Buscar en Xubio el asiento "${a.descripcion}" antes de regenerarlo.` }).eq('id', a.id)
    await log({ ...base, estado: 'ERROR', detalle: `Envío sin confirmar: ${motivo}` })
  }

  let r: { status: number; body: unknown }
  try {
    r = await xubio.post(c.t, PATH_ASIENTO, payload)
  } catch (e) {
    await db.from('xubio_log').insert({ empresa_id: a.empresa_id, entidad: 'ASIENTO', entidad_id: a.id, en_seco: false, request: { path: PATH_ASIENTO, payload }, response: { error: mensaje(e) }, usuario })
    return sinConfirmar(mensaje(e))
  }
  await db.from('xubio_log').insert({ empresa_id: a.empresa_id, entidad: 'ASIENTO', entidad_id: a.id, en_seco: false, request: { path: PATH_ASIENTO, payload }, response: r.body, http_status: r.status, usuario })
  if (r.status >= 400 && r.status < 500) return fallo(`Xubio rechazó el asiento (${r.status}): ${textoRespuesta(r.body)}`)
  if (r.status < 200 || r.status >= 300) return sinConfirmar(`Xubio respondió ${r.status}`)
  const id = idCreado(r.body)
  if (!id) return sinConfirmar('Xubio aceptó pero no devolvió el id')
  const { error: e2 } = await db.rpc('resultado_asiento_xubio', { p_id: a.id, p_ok: true, p_xubio_id: id, p_error: null })
  if (e2) return log({ ...base, estado: 'ERROR', detalle: `Xubio creó el asiento ${id} pero no se pudo marcar: ${e2.message}` })
  return log({ ...base, estado: 'OK', detalle: `Subido a Xubio con id ${id}`, datos: { xubio_id: id } })
}
