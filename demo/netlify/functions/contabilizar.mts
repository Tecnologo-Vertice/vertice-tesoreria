// POST /api/contabilizar  { pagoId, cuentaContable, formaCargaXubio, cuentaOrigen? }
// Guido contabiliza un pago. Arma el comprobante para Xubio, lo registra en xubio_log y:
//   - XUBIO_ENVIO_REAL=false (default): prueba en seco. El pago queda REVISADO con la cuenta y la forma.
//   - XUBIO_ENVIO_REAL=true: lo envía, guarda el id de Xubio y el pago queda CONTABILIZADO.

import type { Config } from '@netlify/functions'
import { env, exigirEmpresa, exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde, ErrorHttp } from './lib/comun'
import * as xubio from './lib/xubio'
import { itemPagoEnFactura, pagoYaExiste } from './lib/xubio-armado'

interface Body {
  pagoId: string
  cuentaContable: string
  formaCargaXubio: 'ORDEN_PAGO' | 'SALIDA_FONDOS' | 'ASIENTO_MANUAL'
  /** La que elige Guido en la tarjeta (los pagos copiados de la hoja suelen traer solo el banco). */
  cuentaOrigen?: string
}

const masDias = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'ADMINISTRACION', 'ADMIN')
  const b = await leerJson<Body>(req)
  if (!b.pagoId || !b.cuentaContable || !b.formaCargaXubio) throw new ErrorHttp(400, 'Faltan pagoId, cuentaContable o formaCargaXubio')

  const db = supabaseAdmin()
  const { data: pago, error } = await db.from('pagos').select('*, proveedores(nombre, cuit), empresas(id, nombre, erp)').eq('id', b.pagoId).single()
  if (error || !pago) throw new ErrorHttp(404, 'Pago inexistente')
  await exigirEmpresa(u, pago.empresas?.id)
  if (!['CARGADO', 'REVISADO'].includes(pago.estado)) throw new ErrorHttp(409, `El pago está en estado ${pago.estado}`)
  if (pago.empresas.erp !== 'XUBIO') throw new ErrorHttp(422, 'Esta empresa no usa Xubio: confirmá la carga en Ralpharma')
  if (!(Number(pago.importe) > 0)) throw new ErrorHttp(422, 'Falta el importe del pago: la IA no lo leyó del comprobante')

  // Cuenta de origen: la elegida en la tarjeta manda; queda guardada en el pago.
  const origenTexto = (b.cuentaOrigen ?? '').trim() || pago.cuenta_origen || ''
  if (!origenTexto) throw new ErrorHttp(422, 'Falta la cuenta de origen (de qué banco o caja salió el pago)')
  if (origenTexto !== pago.cuenta_origen) {
    const { error: eo } = await db.from('pagos').update({ cuenta_origen: origenTexto }).eq('id', pago.id)
    if (eo) throw new ErrorHttp(500, eo.message)
    pago.cuenta_origen = origenTexto
  }
  // E-cheq contra la cuenta de e-cheqs emitidos (tipo 4): Xubio no acepta crear esa OP por API (producción: CARGAR_A_MANO).
  const { data: co4 } = await db.from('cuentas_origen').select('tipo_cuenta').eq('empresa_id', pago.empresas.id).eq('nombre', origenTexto).maybeSingle()
  const echeqAMano = !!pago.numero_cheque && b.formaCargaXubio === 'ORDEN_PAGO' && (co4?.tipo_cuenta === 4 || xubio.tipoCuentaPara(origenTexto) === 4)

  const envioReal = env('XUBIO_ENVIO_REAL', false) === 'true'
  if (echeqAMano && envioReal)
    throw new ErrorHttp(422, `Pago con e-cheq ${pago.numero_cheque}: Xubio no permite crear esta orden de pago por API. Cargala a mano en Xubio (${pago.empresas.nombre}).`)
  const creds = xubio.credencialesDe(pago.empresas.id)
  const notas: string[] = []
  if (echeqAMano) notas.push('e-cheq: en real hay que cargar la OP a mano en Xubio')

  // Con credenciales: verifica cuentas y proveedor contra Xubio real (solo lectura).
  let t: xubio.Token | null = null
  let cuentaOrigen: xubio.RefXubio = { ID: 0, id: 0, nombre: pago.cuenta_origen ?? '', codigo: '' }
  let cuentaGasto: xubio.RefXubio = { ID: 0, id: 0, nombre: b.cuentaContable, codigo: '' }
  let proveedor: xubio.RefXubio | undefined
  if (creds) {
    t = await xubio.token(creds)
    const lista = await xubio.cuentas(t)
    const co = xubio.buscarCuenta(lista, pago.cuenta_origen ?? '')
    const cg = xubio.buscarCuenta(lista, b.cuentaContable)
    if (!co) throw new ErrorHttp(422, `La cuenta de origen "${pago.cuenta_origen}" no existe en Xubio de ${pago.empresas.nombre}`)
    if (!cg) throw new ErrorHttp(422, `La cuenta "${b.cuentaContable}" no existe en el plan de Xubio de ${pago.empresas.nombre}`)
    cuentaOrigen = co
    cuentaGasto = cg
    if (b.formaCargaXubio === 'ORDEN_PAGO') {
      if (!pago.proveedores) throw new ErrorHttp(422, 'Una orden de pago necesita proveedor')
      const p = await xubio.proveedorPorCuit(t, pago.proveedores.cuit, pago.proveedores.nombre)
      if (!p) throw new ErrorHttp(422, `El proveedor ${pago.proveedores.nombre} no existe en Xubio: darlo de alta primero`)
      proveedor = p
    }
  } else {
    notas.push('sin credenciales de Xubio para esta empresa: cuentas y proveedor sin verificar')
    if (pago.proveedores) proveedor = { ID: 0, id: 0, nombre: pago.proveedores.nombre, codigo: '' }
  }

  const datos: xubio.DatosPago = {
    idPago: pago.id,
    importe: Number(pago.importe),
    fecha: pago.fecha,
    observacion: [pago.descripcion, pago.observaciones, `Vértice ${pago.id.slice(0, 8)}`].filter(Boolean).join(' · '),
    cuentaOrigen,
    cuentaGasto,
    proveedor,
    cheque: pago.numero_cheque ? { numero: String(pago.numero_cheque), vencimiento: pago.fecha_acreditacion ?? pago.fecha } : undefined,
  }
  // Facturas que cancela este pago, con su id en Xubio.
  const { data: vinculos } = await db.from('pagos_facturas').select('importe, facturas(id, xubio_id, letra, punto_venta, numero)').eq('pago_id', pago.id)
  const facturas = ((vinculos ?? []) as unknown as { importe: number; facturas: { xubio_id: string | null; letra: string | null; punto_venta: number; numero: number } }[]).map((v) => ({
    importe: Number(v.importe),
    xubioId: v.facturas?.xubio_id && /^\d+$/.test(v.facturas.xubio_id) ? v.facturas.xubio_id : null,
    nro: `${v.facturas?.letra ? v.facturas.letra + '-' : ''}${String(v.facturas?.punto_venta ?? '').padStart(5, '0')}-${String(v.facturas?.numero ?? '').padStart(8, '0')}`,
  }))

  // ¿Ya está en Xubio? Producción lo revisa antes de crear la OP: los pagos copiados de la hoja suelen estar
  // contabilizados allá. Mismo proveedor, mismo importe, ±5 días (buscarPagoXubioExistente_).
  if (t && b.formaCargaXubio === 'ORDEN_PAGO' && proveedor?.ID) {
    let existente: string | null = null
    try {
      existente = pagoYaExiste(await xubio.listarPagos(t, masDias(pago.fecha, -5), masDias(pago.fecha, 5)), proveedor.ID, datos.importe)
    } catch (e) {
      if (envioReal) throw new ErrorHttp(502, `No se pudo verificar en Xubio si el pago ya está cargado (${e instanceof Error ? e.message : e}). No se envía para no duplicar.`)
      notas.push('no se pudo verificar si ya estaba en Xubio')
    }
    if (existente) {
      const detalle = `Ya está en Xubio (OP ${existente}, mismo proveedor e importe): no se vuelve a cargar`
      if (envioReal) {
        const { error: e4 } = await db.rpc('marcar_pago_contabilizado', { p_id: pago.id, p_cuenta: b.cuentaContable, p_forma: b.formaCargaXubio, p_xubio_id: `OP-${existente}`, p_usuario: u.nombre, p_rol: u.rol })
        if (e4) throw new ErrorHttp(500, e4.message)
        await db.from('pagos').update({ detalle_contabilizacion: detalle }).eq('id', pago.id)
        return json({ ok: true, id: `OP-${existente}`, enSeco: false, detalle })
      }
      const { error: e5 } = await db.rpc('marcar_pago_revisado', { p_id: pago.id, p_cuenta: b.cuentaContable, p_forma: b.formaCargaXubio, p_detalle: 'En seco: ' + detalle, p_usuario: u.nombre, p_rol: u.rol })
      if (e5) throw new ErrorHttp(500, e5.message)
      await db.from('pagos').update({ detalle_contabilizacion: 'En seco: ' + detalle }).eq('id', pago.id)
      return json({ ok: true, id: 'EN-SECO', enSeco: true, detalle })
    }
  }

  // Camino B (docs/08): con XUBIO_PAGO_EN_FACTURA=true y una sola factura ya subida, el pago se registra
  // DENTRO de la factura y queda imputado. La API de Xubio no permite tildar facturas en una orden de pago.
  const enFactura = b.formaCargaXubio === 'ORDEN_PAGO' && env('XUBIO_PAGO_EN_FACTURA', false) === 'true' && facturas.length === 1 && !!facturas[0].xubioId
  let payload: unknown
  let path: string
  let metodo: 'POST' | 'PUT' = 'POST'
  if (enFactura) {
    const item = itemPagoEnFactura({ cuentaOrigen, importe: datos.importe, descripcion: datos.observacion, cheque: datos.cheque })
    const actual = t ? await xubio.facturaCompraPorId(t, facturas[0].xubioId!) : {}
    const items = Array.isArray(actual.transaccionOrdenPagoItems) ? actual.transaccionOrdenPagoItems : []
    payload = { ...actual, condicionDePago: 2, transaccionOrdenPagoItems: [...items, item] }
    path = `comprobanteCompraBean/${facturas[0].xubioId}`
    metodo = 'PUT'
    notas.push(`pago registrado dentro de la factura ${facturas[0].nro}: queda imputado`)
  } else {
    payload = b.formaCargaXubio === 'ORDEN_PAGO' ? xubio.ordenDePago(datos) : xubio.asientoManual(datos)
    path = xubio.pathPara(b.formaCargaXubio)
    if (b.formaCargaXubio === 'ORDEN_PAGO' && facturas.length)
      notas.push(`la OP queda a cuenta del proveedor: en Xubio hay que tildar ${facturas.map((x) => `${x.nro} por ${x.importe}`).join(', ')}`)
  }

  if (!envioReal || !t) {
    await db.from('xubio_log').insert({ empresa_id: pago.empresas.id, entidad: 'PAGO', entidad_id: pago.id, en_seco: true, request: { path, payload }, usuario: u.nombre })
    const detalle = `En seco: ${enFactura ? 'PAGO EN FACTURA' : b.formaCargaXubio} por ${datos.importe} contra ${cuentaOrigen.nombre}${notas.length ? ' (' + notas.join('; ') + ')' : ''}`
    const { error: e2 } = await db.rpc('marcar_pago_revisado', { p_id: pago.id, p_cuenta: b.cuentaContable, p_forma: b.formaCargaXubio, p_detalle: detalle, p_usuario: u.nombre, p_rol: u.rol })
    if (e2) throw new ErrorHttp(500, e2.message)
    await db.from('pagos').update({ detalle_contabilizacion: detalle }).eq('id', pago.id)
    return json({ ok: true, id: 'EN-SECO', enSeco: true, detalle })
  }

  // Reserva atómica: solo un envío real por pago. Si dos clics o un reintento llegan juntos, el
  // segundo no encuentra la fila libre y se corta acá, antes de crear una segunda OP en Xubio.
  const { data: reservado } = await db
    .from('pagos')
    .update({ envio_xubio_en: new Date().toISOString() })
    .eq('id', pago.id)
    .in('estado', ['CARGADO', 'REVISADO'])
    .is('envio_xubio_en', null)
    .select('id')
  if (!reservado?.length)
    throw new ErrorHttp(409, 'Este pago ya se está enviando a Xubio o quedó un envío sin confirmar. Revisá en Xubio y en xubio_log antes de reintentar.')

  const r = metodo === 'PUT' ? await xubio.put(t, path, payload) : await xubio.post(t, path, payload)
  await db.from('xubio_log').insert({ empresa_id: pago.empresas.id, entidad: 'PAGO', entidad_id: pago.id, en_seco: false, request: { path, payload }, response: r.body, http_status: r.status, usuario: u.nombre })
  if (r.status >= 400 && r.status < 500) {
    // Rechazo claro de Xubio: no se creó nada, se libera la reserva para corregir y reintentar.
    await db.from('pagos').update({ envio_xubio_en: null }).eq('id', pago.id)
    throw new ErrorHttp(502, `Xubio rechazó el comprobante (${r.status}): ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)}`)
  }
  // 5xx o 2xx sin id: no se sabe si Xubio lo creó. La reserva queda puesta para que nadie reintente a ciegas.
  if (r.status < 200 || r.status >= 300) throw new ErrorHttp(502, `Xubio respondió ${r.status}: no se sabe si creó el comprobante. Verificalo en Xubio antes de reintentar.`)
  const id = enFactura ? `FC-${facturas[0].xubioId}` : xubio.idDeRespuesta(r.body)
  if (!id) throw new ErrorHttp(502, 'Xubio aceptó el envío pero no devolvió un id. Buscalo en Xubio y cargalo a mano; no reintentes.')
  const { error: e3 } = await db.rpc('marcar_pago_contabilizado', { p_id: pago.id, p_cuenta: b.cuentaContable, p_forma: b.formaCargaXubio, p_xubio_id: id, p_usuario: u.nombre, p_rol: u.rol })
  if (e3) throw new ErrorHttp(500, `Xubio aceptó (${id}) pero no se pudo marcar el pago: ${e3.message}`)
  return json({ ok: true, id, enSeco: false, detalle: notas.join('; ') || undefined })
})

export const config: Config = { path: '/api/contabilizar' }
