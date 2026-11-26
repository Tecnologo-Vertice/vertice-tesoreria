// Subida de facturas aprobadas a Xubio (lo que hoy hace subirUnaFilaAXubio_ en el Apps Script).
// XUBIO_FACTURAS_ENVIO_REAL=false (default): prueba en seco, verifica proveedor y producto en Xubio y
// guarda en xubio_log lo que se enviaría. true: la crea en Xubio y guarda su id (para imputar pagos).

import type { SupabaseClient } from '@supabase/supabase-js'
import { env, ErrorHttp } from './comun'
import * as xubio from './xubio'
import { elegirProducto, elegirProveedor, esExtractoBancario, facturaCompra, facturaYaExiste, idCreado, numeroDocumento, type Ref } from './xubio-armado'

export type ResultadoXubioFactura = { estado: 'SUBIDA' | 'EN_SECO' | 'ERROR' | 'NO_APLICA'; xubioId?: string; detalle: string }

const masDias = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Producto de compra del comprobante "Extracto Bancario" cuando la factura no trae código (el neto va a gastos bancarios). */
export const PRODUCTO_GASTOS_BANCARIOS = 'GASTOS_BANCARIOS'

/** opciones.real: lo decide quien llama (los envíos bancarios usan XUBIO_BANCOS_ENVIO_REAL). Si no, XUBIO_FACTURAS_ENVIO_REAL. */
export async function subirFacturaAXubio(db: SupabaseClient, facturaId: string, usuario: string, opciones: { real?: boolean } = {}): Promise<ResultadoXubioFactura> {
  const { data: f, error } = await db.from('facturas').select('*, proveedores(nombre, cuit), empresas(id, nombre, erp)').eq('id', facturaId).single()
  if (error || !f) throw new ErrorHttp(404, 'Factura inexistente')
  if (f.empresas.erp !== 'XUBIO') return { estado: 'NO_APLICA', detalle: `${f.empresas.nombre} no usa Xubio: va al sector Ralpharma` }
  if (f.estado_xubio === 'SUBIDA') return { estado: 'SUBIDA', xubioId: f.xubio_id, detalle: 'Ya estaba en Xubio' }
  if (!['PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA'].includes(f.estado)) throw new ErrorHttp(409, 'Solo se suben a Xubio facturas aprobadas')

  const real = opciones.real ?? env('XUBIO_FACTURAS_ENVIO_REAL', false) === 'true'
  const fallo = async (motivo: string, liberar = true): Promise<ResultadoXubioFactura> => {
    await db.rpc('resultado_factura_xubio', { p_id: f.id, p_estado: 'ERROR', p_xubio_id: null, p_error: motivo, p_usuario: usuario, p_liberar: liberar })
    return { estado: 'ERROR', detalle: motivo }
  }

  const creds = await xubio.credencialesDe(db, f.empresas.id)
  if (!creds) {
    if (real) return fallo(`Faltan las credenciales de Xubio de ${f.empresas.nombre} (ni en la base ni en XUBIO_CREDS_JSON)`)
    return { estado: 'EN_SECO', detalle: `Sin credenciales de Xubio para ${f.empresas.nombre}: no se pudo verificar proveedor ni producto` }
  }

  let t: xubio.Token
  let proveedores: Record<string, unknown>[]
  let productos: Record<string, unknown>[]
  try {
    t = await xubio.token(creds)
    ;[proveedores, productos] = await Promise.all([xubio.listarProveedores(t), xubio.listarProductosCompra(t)])
  } catch (e) {
    return fallo(`No se pudo consultar Xubio: ${e instanceof Error ? e.message : e}`)
  }

  const proveedor: Ref | null = elegirProveedor(proveedores, f.proveedores.cuit, f.proveedores.nombre)
  if (!proveedor) return fallo(`El proveedor ${f.proveedores.nombre} (CUIT ${f.proveedores.cuit}) no está dado de alta en el Xubio de ${f.empresas.nombre}`)
  const codigoProducto: string | null = f.codigo_producto ?? (f.cuenta_origen_extracto_id ? PRODUCTO_GASTOS_BANCARIOS : null)
  const producto = elegirProducto(productos, codigoProducto, f.cuenta_contable)
  if (!producto)
    return fallo(`No hay producto de compra en Xubio para la cuenta "${f.cuenta_contable ?? ''}"${codigoProducto ? ` ni con el código ${codigoProducto}` : ''}. Crear el producto en Xubio o cargar el código en la memoria del proveedor.`)

  // Extracto Bancario: Xubio pide la cuenta bancaria (la contable de la cuenta del banco, buscada en el plan de
  // cuentas como los asientos). Si no está, error claro: no se manda vacía.
  let cuentaBancaria: Ref | null = null
  if (f.cuenta_origen_extracto_id && esExtractoBancario(f.tipo)) {
    const { data: co } = await db.from('cuentas_origen').select('id, nombre, cuenta_contable_id').eq('id', f.cuenta_origen_extracto_id).maybeSingle()
    if (!co) return fallo('El comprobante del extracto apunta a una cuenta bancaria que no existe')
    if (!co.cuenta_contable_id) return fallo(`La cuenta ${co.nombre} no tiene su cuenta contable de Xubio: cargarla en Cuentas antes de subir el comprobante`)
    const { data: cc } = await db.from('cuentas_contables').select('nombre').eq('id', co.cuenta_contable_id).maybeSingle()
    if (!cc?.nombre) return fallo(`La cuenta contable de ${co.nombre} no existe`)
    let plan: xubio.RefXubio[]
    try {
      plan = await xubio.cuentas(t)
    } catch (e) {
      return fallo(`No se pudo leer el plan de cuentas de Xubio: ${e instanceof Error ? e.message : e}`)
    }
    cuentaBancaria = xubio.buscarCuenta(plan, String(cc.nombre))
    if (!cuentaBancaria || !(cuentaBancaria.ID > 0)) return fallo(`No encuentro en el plan de cuentas de Xubio la cuenta bancaria "${cc.nombre}" (${co.nombre}): el comprobante necesita la cuenta del banco`)
  }

  const payload = facturaCompra(f, proveedor, producto, cuentaBancaria)
  const nroDoc = numeroDocumento(f.letra, f.punto_venta, f.numero)

  // Duplicado: si ya está en Xubio (subida por el Apps Script o a mano), se toma su id y no se vuelve a crear.
  try {
    const existentes = await xubio.listarFacturasCompra(t, masDias(f.fecha, -60), masDias(f.fecha, 60))
    const yaEsta = facturaYaExiste(existentes, nroDoc, proveedor.ID)
    if (yaEsta) {
      if (yaEsta === 'EXISTENTE') return fallo(`La factura ${nroDoc} ya está en Xubio pero no se pudo leer su id: cargarlo a mano`)
      await db.rpc('resultado_factura_xubio', { p_id: f.id, p_estado: 'SUBIDA', p_xubio_id: yaEsta, p_error: null, p_usuario: usuario, p_liberar: true })
      return { estado: 'SUBIDA', xubioId: yaEsta, detalle: `Ya estaba en Xubio (id ${yaEsta}); se vinculó sin volver a subirla` }
    }
  } catch (e) {
    return fallo(`No se pudo verificar duplicados en Xubio: ${e instanceof Error ? e.message : e}`)
  }

  if (!real) {
    await db.from('xubio_log').insert({ empresa_id: f.empresas.id, entidad: 'FACTURA', entidad_id: f.id, en_seco: true, request: { path: 'comprobanteCompraBean', payload }, usuario })
    return { estado: 'EN_SECO', detalle: `Xubio la aceptaría: proveedor ${proveedor.nombre}, producto ${producto.nombre}, ${nroDoc}` }
  }

  const { data: reservada } = await db.rpc('reservar_factura_xubio', { p_id: f.id })
  if (!reservada) throw new ErrorHttp(409, 'La factura ya se está subiendo a Xubio o quedó un envío sin confirmar')
  let r: { status: number; body: unknown }
  try {
    r = await xubio.post(t, 'comprobanteCompraBean', payload)
  } catch (e) {
    // Sin respuesta: no se sabe si Xubio la creó. Queda reservada (no se reintenta sola) y se libera a mano.
    const motivo = e instanceof Error ? e.message : String(e)
    await db.from('xubio_log').insert({ empresa_id: f.empresas.id, entidad: 'FACTURA', entidad_id: f.id, en_seco: false, request: { path: 'comprobanteCompraBean', payload }, response: { error: motivo }, usuario })
    return fallo(`${motivo}: verificar en Xubio si la creó antes de reintentar`, false)
  }
  await db.from('xubio_log').insert({ empresa_id: f.empresas.id, entidad: 'FACTURA', entidad_id: f.id, en_seco: false, request: { path: 'comprobanteCompraBean', payload }, response: r.body, http_status: r.status, usuario })
  const cuerpo = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
  if (r.status >= 400 && r.status < 500) return fallo(`Xubio rechazó la factura (${r.status}): ${cuerpo.slice(0, 250)}`)
  if (r.status < 200 || r.status >= 300) return fallo(`Xubio respondió ${r.status}: verificar en Xubio si la creó antes de reintentar`, false)
  const id = idCreado(r.body)
  if (!id) return fallo('Xubio aceptó pero no devolvió el id: buscarla en Xubio y vincularla a mano', false)
  await db.rpc('resultado_factura_xubio', { p_id: f.id, p_estado: 'SUBIDA', p_xubio_id: id, p_error: null, p_usuario: usuario, p_liberar: true })
  return { estado: 'SUBIDA', xubioId: id, detalle: `Subida a Xubio con id ${id}` }
}
