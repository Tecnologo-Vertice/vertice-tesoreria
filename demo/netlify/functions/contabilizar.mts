// POST /api/contabilizar  { pagoId, cuentaContable, formaCargaXubio }
// Guido contabiliza un pago. Arma el comprobante para Xubio, lo registra en xubio_log y:
//   - XUBIO_ENVIO_REAL=false (default): prueba en seco. El pago queda REVISADO con la cuenta y la forma.
//   - XUBIO_ENVIO_REAL=true: lo envía, guarda el id de Xubio y el pago queda CONTABILIZADO.

import type { Config } from '@netlify/functions'
import { env, exigirRol, json, leerJson, manejar, supabaseAdmin, usuarioDesde, ErrorHttp } from './lib/comun'
import * as xubio from './lib/xubio'

interface Body {
  pagoId: string
  cuentaContable: string
  formaCargaXubio: 'ORDEN_PAGO' | 'SALIDA_FONDOS' | 'ASIENTO_MANUAL'
}

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'ADMINISTRACION', 'ADMIN')
  const b = await leerJson<Body>(req)
  if (!b.pagoId || !b.cuentaContable || !b.formaCargaXubio) throw new ErrorHttp(400, 'Faltan pagoId, cuentaContable o formaCargaXubio')

  const db = supabaseAdmin()
  const { data: pago, error } = await db.from('pagos').select('*, proveedores(nombre, cuit), empresas(id, nombre, erp)').eq('id', b.pagoId).single()
  if (error || !pago) throw new ErrorHttp(404, 'Pago inexistente')
  if (!['CARGADO', 'REVISADO'].includes(pago.estado)) throw new ErrorHttp(409, `El pago está en estado ${pago.estado}`)
  if (pago.empresas.erp !== 'XUBIO') throw new ErrorHttp(422, 'Esta empresa no usa Xubio: confirmá la carga en Ralpharma')

  const envioReal = env('XUBIO_ENVIO_REAL', false) === 'true'
  const creds = xubio.credencialesDe(pago.empresas.id)
  const notas: string[] = []

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
  const payload = b.formaCargaXubio === 'ORDEN_PAGO' ? xubio.ordenDePago(datos) : xubio.asientoManual(datos)
  const path = xubio.pathPara(b.formaCargaXubio)

  if (!envioReal || !t) {
    await db.from('xubio_log').insert({ empresa_id: pago.empresas.id, entidad: 'PAGO', entidad_id: pago.id, en_seco: true, request: { path, payload }, usuario: u.nombre })
    const detalle = `En seco: ${b.formaCargaXubio} por ${datos.importe} contra ${cuentaOrigen.nombre}${notas.length ? ' (' + notas.join('; ') + ')' : ''}`
    const { error: e2 } = await db.rpc('marcar_pago_revisado', { p_id: pago.id, p_cuenta: b.cuentaContable, p_forma: b.formaCargaXubio, p_detalle: detalle, p_usuario: u.nombre, p_rol: u.rol })
    if (e2) throw new ErrorHttp(500, e2.message)
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

  const r = await xubio.post(t, path, payload)
  await db.from('xubio_log').insert({ empresa_id: pago.empresas.id, entidad: 'PAGO', entidad_id: pago.id, en_seco: false, request: { path, payload }, response: r.body, http_status: r.status, usuario: u.nombre })
  if (r.status >= 400 && r.status < 500) {
    // Rechazo claro de Xubio: no se creó nada, se libera la reserva para corregir y reintentar.
    await db.from('pagos').update({ envio_xubio_en: null }).eq('id', pago.id)
    throw new ErrorHttp(502, `Xubio rechazó el comprobante (${r.status}): ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)}`)
  }
  // 5xx o 2xx sin id: no se sabe si Xubio lo creó. La reserva queda puesta para que nadie reintente a ciegas.
  if (r.status < 200 || r.status >= 300) throw new ErrorHttp(502, `Xubio respondió ${r.status}: no se sabe si creó el comprobante. Verificalo en Xubio antes de reintentar.`)
  const id = xubio.idDeRespuesta(r.body)
  if (!id) throw new ErrorHttp(502, 'Xubio aceptó el envío pero no devolvió un id. Buscalo en Xubio y cargalo a mano; no reintentes.')
  const { error: e3 } = await db.rpc('marcar_pago_contabilizado', { p_id: pago.id, p_cuenta: b.cuentaContable, p_forma: b.formaCargaXubio, p_xubio_id: id, p_usuario: u.nombre, p_rol: u.rol })
  if (e3) throw new ErrorHttp(500, `Xubio aceptó (${id}) pero no se pudo marcar el pago: ${e3.message}`)
  return json({ ok: true, id, enSeco: false })
})

export const config: Config = { path: '/api/contabilizar' }
