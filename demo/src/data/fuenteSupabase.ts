// Modo conectado: lee de Supabase con la sesión del usuario (RLS) y escribe a través
// de funciones SQL (RPC) que validan el rol y dejan auditoría. La IA y Xubio pasan por
// funciones de Netlify porque necesitan claves que nunca van al navegador.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Auditoria, ComprobanteEjemplo, CuentaOrigen, Documento, Empresa, EstadoEspejo, Factura, LecturaComprobante, Pago, Proveedor, Usuario } from '../types'
import type { Bucket, Datos, DatosAprobacion, DatosContabilizacion, DatosEdicion, DatosYaPagada, Fuente, ResultadoYaPagada, ResultadoEdicion, NuevoPago, ResultadoSubida, ResultadoXubio, ResultadoXubioFactura } from './fuente'
import { archivoABase64, llamarFuncion } from '../lib/supabase'

type Row = Record<string, unknown>
const s = (v: unknown) => (v == null ? undefined : String(v))
const n = (v: unknown) => (v == null ? 0 : Number(v))

function mapFactura(r: Row): Factura {
  return {
    id: String(r.id),
    empresaId: String(r.empresa_id),
    proveedorId: String(r.proveedor_id),
    tipo: String(r.tipo) as Factura['tipo'],
    puntoVenta: n(r.punto_venta),
    numero: n(r.numero),
    fecha: String(r.fecha),
    vencimiento: String(r.vencimiento ?? r.fecha),
    neto: n(r.neto),
    iva: n(r.iva),
    percepciones: n(r.percepciones),
    total: n(r.total),
    cae: s(r.cae) ?? '',
    caeVencimiento: s(r.cae_vencimiento) ?? '',
    origen: String(r.origen) as Factura['origen'],
    estado: String(r.estado) as Factura['estado'],
    estadoXubio: String(r.estado_xubio) as Factura['estadoXubio'],
    validacionOk: Boolean(r.validacion_ok),
    motivoValidacion: s(r.motivo_validacion),
    categoriaVertice: (s(r.categoria_vertice) ?? 'PROVEEDOR') as Factura['categoriaVertice'],
    cuentaContable: s(r.cuenta_contable),
    metodoPago: s(r.metodo_pago) as Factura['metodoPago'],
    diasCheque: r.dias_cheque == null ? undefined : n(r.dias_cheque),
    pagado: n(r.pagado),
    pagadoPct: n(r.pagado_pct),
    driveUrl: s(r.drive_url),
    pdfPath: s(r.pdf_path),
    advertencia: s(r.advertencia),
    categoriaIa: s(r.categoria_ia),
    xubioId: s(r.xubio_id),
    xubioError: s(r.xubio_error),
    ralpharmaPor: s(r.ralpharma_por),
    ralpharmaEn: s(r.ralpharma_en),
    aprobadoPor: s(r.aprobado_por),
    aprobadoEn: s(r.aprobado_en),
    gestion: s(r.gestion) as Factura['gestion'],
    letra: s(r.letra),
    exento: n(r.exento),
    percepcionesJson: Array.isArray(r.percepciones_json)
      ? (r.percepciones_json as Record<string, unknown>[]).map((p) => ({ nombre: String(p.nombre ?? p.descripcion ?? 'Percepción'), importe: n(p.importe) }))
      : [],
    moneda: s(r.moneda),
    cotizacion: r.cotizacion == null ? undefined : n(r.cotizacion),
    codigoProducto: s(r.codigo_producto),
    creadoEn: s(r.creado_en),
    saldoNc: r.saldo_nc == null ? undefined : n(r.saldo_nc),
    yaPagadaSegunAdmin: s(r.ya_pagada_segun_admin),
    mailEnviado: s(r.mail_enviado),
  }
}

function mapPago(r: Row, facturaIds: string[]): Pago {
  return {
    id: String(r.id),
    empresaId: String(r.empresa_id),
    proveedorId: s(r.proveedor_id),
    fecha: String(r.fecha),
    importe: n(r.importe),
    medio: String(r.medio) as Pago['medio'],
    cuentaOrigen: s(r.cuenta_origen) ?? '',
    bancoDestino: s(r.banco_destino),
    numeroCheque: s(r.numero_cheque),
    fechaAcreditacion: s(r.fecha_acreditacion),
    facturaIds,
    descripcion: s(r.descripcion) ?? '',
    observaciones: s(r.observaciones),
    cuentaContable: s(r.cuenta_contable),
    sugerenciaOrigen: s(r.sugerencia_origen) as Pago['sugerenciaOrigen'],
    sugerenciaConfianza: r.sugerencia_confianza == null ? undefined : n(r.sugerencia_confianza),
    formaCargaXubio: (s(r.forma_carga_xubio) ?? 'SALIDA_FONDOS') as Pago['formaCargaXubio'],
    estado: String(r.estado) as Pago['estado'],
    comprobante: s(r.comprobante_path) ?? '',
    cargadoPor: s(r.cargado_por) ?? '',
    cargadoEn: String(r.cargado_en),
    contabilizadoPor: s(r.contabilizado_por),
    contabilizadoEn: s(r.contabilizado_en),
    xubioId: s(r.xubio_id),
    mailProveedorEnviado: r.mail_proveedor_en != null,
    hojaId: s(r.hoja_id),
    gestion: s(r.gestion) as Pago['gestion'],
    comprobanteUrl: s(r.comprobante_url),
    bancoOrigen: s(r.banco_origen),
    numeroCuenta: s(r.numero_cuenta),
    proveedorDestino: s(r.proveedor_destino),
    tipoCheque: s(r.tipo_cheque),
    estadoExtraccion: s(r.estado_extraccion),
    avisoImporte: s(r.aviso_importe),
    detalleXubio: s(r.xubio_detalle) ?? s(r.detalle_contabilizacion),
    anuladoPor: s(r.anulado_por),
    anuladoEn: s(r.anulado_en),
    motivoAnulacion: s(r.motivo_anulacion),
  }
}

export class FuenteSupabase implements Fuente {
  modo = 'conectado' as const
  private db: SupabaseClient
  constructor(db: SupabaseClient) {
    this.db = db
  }

  /** Trae la tabla en páginas: Supabase devuelve como máximo 1.000 filas por pedido y corta sin avisar.
   *  `orden` tiene que identificar cada fila (si no, las páginas repiten o saltean filas).
   *  `tope` limita el total: la auditoría crece sin fin y la pantalla muestra los últimos eventos. */
  private async lista<T>(tabla: string, map: (r: Row) => T, orden: [string, 'asc' | 'desc'][] = [['id', 'asc']], tope = Infinity): Promise<T[]> {
    const PAGINA = 1000
    const filas: Row[] = []
    for (let desde = 0; desde < tope; desde += PAGINA) {
      const hasta = Math.min(desde + PAGINA, tope) - 1
      let q = this.db.from(tabla).select('*')
      for (const [col, dir] of orden) q = q.order(col, { ascending: dir === 'asc' })
      const { data, error } = await q.range(desde, hasta)
      if (error) throw new Error(`${tabla}: ${error.message}`)
      filas.push(...(data as Row[]))
      if ((data as Row[]).length < hasta - desde + 1) break
    }
    return filas.map(map)
  }

  async cargar(): Promise<Datos> {
    const [empresas, proveedores, cuentasOrigen, plan, facturas, pagosRaw, vinculos, auditoria, documentos, espejo, productos, ncs] = await Promise.all([
      this.lista<Empresa>('empresas', (r) => ({ id: String(r.id), nombre: String(r.nombre), corto: String(r.nombre_corto), cuit: String(r.cuit), erp: String(r.erp) as Empresa['erp'] })),
      this.lista<Proveedor>('proveedores', (r) => ({
        id: String(r.id),
        nombre: String(r.nombre),
        cuit: String(r.cuit),
        email: s(r.email) ?? '',
        categoriaVertice: (s(r.categoria_vertice) ?? 'PROVEEDOR') as Proveedor['categoriaVertice'],
        cuentaHabitual: s(r.cuenta_habitual),
      })),
      this.lista<CuentaOrigen>('cuentas_origen', (r) => ({
        id: String(r.id),
        empresaId: String(r.empresa_id),
        nombre: String(r.nombre),
        saldo: n(r.saldo),
        xubioId: s(r.xubio_id),
        tipoCuenta: r.tipo_cuenta == null ? undefined : n(r.tipo_cuenta),
        usos: n(r.usos),
      })),
      this.lista<{ empresa: string | undefined; nombre: string; activa: boolean }>('cuentas_contables', (r) => ({ empresa: s(r.empresa_id), nombre: String(r.nombre), activa: r.activa !== false })),
      this.lista<Factura>('facturas', mapFactura),
      this.lista<Row>('pagos', (r) => r, [['cargado_en', 'desc'], ['id', 'asc']]),
      this.lista<{ pago: string; factura: string }>('pagos_facturas', (r) => ({ pago: String(r.pago_id), factura: String(r.factura_id) }), [['pago_id', 'asc'], ['factura_id', 'asc']]),
      // Los 2.000 eventos más recientes.
      this.lista<Auditoria>(
        'auditoria',
        (r) => ({
          id: String(r.id),
          fecha: String(r.fecha),
          usuario: String(r.usuario),
          rol: String(r.rol ?? 'ADMIN') as Auditoria['rol'],
          accion: String(r.accion),
          entidad: String(r.entidad) as Auditoria['entidad'],
          entidadId: String(r.entidad_id ?? ''),
          detalle: s(r.detalle) ?? '',
        }),
        [['id', 'desc']],
        2000,
      ),
      // Los 500 documentos más recientes: la bandeja de Entrada muestra los que no terminaron en factura.
      this.lista<Documento>(
        'documentos',
        (r) => ({
          id: String(r.id),
          origen: String(r.origen) as Documento['origen'],
          nombre: String(r.nombre_archivo),
          estado: String(r.estado) as Documento['estado'],
          error: s(r.error),
          remitente: s(r.remitente),
          asunto: s(r.asunto),
          cargadoPor: s(r.cargado_por),
          recibidoEn: String(r.recibido_en),
          intentos: n(r.intentos),
          storagePath: String(r.storage_path),
          facturaId: s(r.factura_id),
        }),
        [['recibido_en', 'desc'], ['id', 'asc']],
        500,
      ),
      // Estado de la copia de la hoja real. Si la base todavía no tiene la migración 0008, se muestra vacío.
      this.lista<EstadoEspejo>(
        'espejo_estado',
        (r) => ({
          hoja: String(r.hoja),
          ultimaEn: String(r.ultima_en),
          filas: n(r.filas),
          nuevas: n(r.nuevas),
          actualizadas: n(r.actualizadas),
          omitidas: n(r.omitidas),
          detalle: (r.detalle as EstadoEspejo['detalle']) ?? [],
        }),
        [['hoja', 'asc']],
      ).catch(() => [] as EstadoEspejo[]),
      this.lista<{ nombre: string; codigo: string }>('productos_xubio', (r) => ({ nombre: String(r.nombre), codigo: String(r.codigo) }), [['nombre', 'asc']]).catch(() => [] as { nombre: string; codigo: string }[]),
      // NC aplicadas a cada factura (0011). Sin la migración, vacío.
      this.lista<{ factura: string; nc: string; importe: number }>('notas_credito_aplicadas', (r) => ({ factura: String(r.factura_id), nc: String(r.nc_id), importe: n(r.importe) })).catch(() => [] as { factura: string; nc: string; importe: number }[]),
    ])
    for (const f of facturas) {
      const a = ncs.filter((x) => x.factura === f.id)
      if (a.length) f.ncAplicadas = a.map((x) => ({ ncId: x.nc, importe: x.importe }))
    }
    const comunes = plan.filter((c) => !c.empresa && c.activa).map((c) => c.nombre)
    const planPorEmpresa: Record<string, string[]> = {}
    for (const c of plan) if (c.empresa && c.activa) (planPorEmpresa[c.empresa] ??= []).push(c.nombre)
    for (const k of Object.keys(planPorEmpresa)) planPorEmpresa[k].sort((a, b) => a.localeCompare(b))
    const facturasDePago = new Map<string, string[]>()
    for (const v of vinculos) facturasDePago.set(v.pago, [...(facturasDePago.get(v.pago) ?? []), v.factura])
    const pagos = pagosRaw.map((r) => mapPago(r, facturasDePago.get(String(r.id)) ?? []))
    return { facturas, pagos, documentos, auditoria: auditoria.sort((a, b) => a.fecha.localeCompare(b.fecha)), catalogos: { empresas, proveedores, cuentasOrigen, planCuentas: [...new Set(comunes)].sort(), planPorEmpresa, productos: productos.map((p) => p.nombre), codigosProducto: Object.fromEntries(productos.map((p) => [p.nombre, p.codigo])) }, espejo }
  }

  private async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as T
  }

  async aprobarFactura(id: string, d: DatosAprobacion) {
    await this.rpc('aprobar_factura', { p_id: id, p_cuenta: d.cuentaContable, p_metodo: d.metodoPago, p_dias: d.diasCheque ?? null })
  }

  async rechazarFactura(id: string, motivo: string) {
    await this.rpc('rechazar_factura', { p_id: id, p_motivo: motivo })
  }

  async aprobarYaPagada(id: string, d: DatosAprobacion, p: DatosYaPagada): Promise<ResultadoYaPagada> {
    return this.rpc<ResultadoYaPagada>('aprobar_factura_ya_pagada', {
      p_id: id,
      p_cuenta: d.cuentaContable,
      p_metodo: d.metodoPago,
      p_pago: {
        ya_en_xubio: p.yaEnXubio,
        cuenta_origen: p.cuentaOrigen || null,
        fecha: p.fecha || null,
        numero_cheque: p.numeroCheque || null,
        fecha_acreditacion: p.fechaAcreditacion || null,
        observaciones: p.observaciones || null,
      },
    })
  }

  async aplicarNotaCredito(ncId: string, facturaId: string, importe: number) {
    await this.rpc('aplicar_nota_credito', { p_nc: ncId, p_factura: facturaId, p_importe: importe })
  }

  async anularPago(id: string, motivo: string) {
    await this.rpc('anular_pago', { p_id: id, p_motivo: motivo })
  }

  async guardarEmailProveedor(proveedorId: string, email: string) {
    await this.rpc('guardar_email_proveedor', { p_proveedor: proveedorId, p_email: email })
  }

  async marcarMailPreparado(facturaIds: string[]) {
    await this.rpc('marcar_mail_preparado', { p_facturas: facturaIds })
  }

  /** Como en producción, el comprobante va como link: el de Drive (pagos de la hoja) o un enlace firmado por 30 días. */
  async linksComprobantes(pagos: Pago[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {}
    await Promise.all(
      pagos.map(async (p) => {
        if (p.comprobanteUrl) out[p.id] = p.comprobanteUrl
        else if (p.comprobante) {
          const { data } = await this.db.storage.from('comprobantes').createSignedUrl(p.comprobante, 30 * 24 * 3600)
          out[p.id] = data?.signedUrl ?? null
        } else out[p.id] = null
      }),
    )
    return out
  }

  async catalogosXubio(): Promise<string[]> {
    return (await llamarFuncion<{ log: string[] }>('xubio/catalogos', {})).log
  }

  async editarFactura(id: string, d: DatosEdicion): Promise<ResultadoEdicion> {
    return this.rpc<ResultadoEdicion>('editar_factura', {
      p_id: id,
      p: {
        empresa_id: d.empresaId, proveedor: d.proveedor, cuit_proveedor: d.cuit, tipo: d.tipo, letra: d.letra, punto_venta: d.puntoVenta, numero: d.numero,
        fecha: d.fecha, vencimiento: d.vencimiento || null, moneda: d.moneda, cotizacion: d.cotizacion, neto: d.neto, iva: d.iva, exento: d.exento,
        percepciones_json: d.percepciones, total: d.total, cae: d.cae, cae_vencimiento: d.caeVencimiento || null,
        categoria_vertice: d.categoriaVertice, cuenta_contable: d.cuentaContable, codigo_producto: d.codigoProducto,
      },
    })
  }

  async corregirFactura(id: string) {
    await this.rpc('corregir_factura', { p_id: id })
  }

  async registrarPago(d: NuevoPago): Promise<Pago> {
    const id = await this.rpc<string>('registrar_pago', {
      p_datos: {
        empresa_id: d.empresaId,
        proveedor_id: d.proveedorId ?? null,
        fecha: d.fecha,
        importe: d.importe,
        medio: d.medio,
        cuenta_origen: d.cuentaOrigen,
        banco_destino: d.bancoDestino ?? null,
        numero_cheque: d.numeroCheque ?? null,
        fecha_acreditacion: d.fechaAcreditacion ?? null,
        factura_ids: d.facturaIds,
        descripcion: d.descripcion,
        observaciones: d.observaciones ?? null,
        cuenta_contable: d.cuentaContable ?? null,
        sugerencia_origen: d.sugerenciaOrigen ?? null,
        sugerencia_confianza: d.sugerenciaConfianza ?? null,
        forma_carga_xubio: d.formaCargaXubio,
        comprobante_path: d.comprobante,
      },
    })
    const { data } = await this.db.from('pagos').select('*').eq('id', id).single()
    return mapPago(data as Row, d.facturaIds)
  }

  async contabilizarPago(id: string, d: DatosContabilizacion): Promise<ResultadoXubio> {
    try {
      return await llamarFuncion<ResultadoXubio>('contabilizar', { pagoId: id, cuentaContable: d.cuentaContable, formaCargaXubio: d.formaCargaXubio, cuentaOrigen: d.cuentaOrigen })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async marcarRalpharma(id: string) {
    await this.rpc('marcar_ralpharma', { p_id: id })
  }

  async leerComprobante(archivo: File | ComprobanteEjemplo): Promise<LecturaComprobante> {
    if (!(archivo instanceof File)) return archivo.lectura
    const data = await archivoABase64(archivo)
    return llamarFuncion<LecturaComprobante>('ia/leer-comprobante', { nombre: archivo.name, mimeType: archivo.type || 'application/pdf', data })
  }

  async subirComprobante(archivo: File): Promise<string> {
    const limpio = archivo.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const path = `${new Date().getFullYear()}/${Date.now()}_${limpio}`
    const { error } = await this.db.storage.from('comprobantes').upload(path, archivo, { contentType: archivo.type || 'application/octet-stream' })
    if (error) throw new Error(`No se pudo guardar el comprobante: ${error.message}`)
    return path
  }

  async urlArchivo(bucket: Bucket, path: string): Promise<string | null> {
    // Los buckets son privados: link firmado que vence en 10 minutos.
    const { data, error } = await this.db.storage.from(bucket).createSignedUrl(path, 600)
    if (error) throw new Error(`No se pudo abrir el archivo: ${error.message}`)
    return data.signedUrl
  }

  async subirFactura(archivo: File): Promise<ResultadoSubida> {
    const data = await archivoABase64(archivo)
    return llamarFuncion<ResultadoSubida>('facturas/subir', { nombre: archivo.name, mimeType: archivo.type || 'application/pdf', data })
  }

  async leerAhora(): Promise<number> {
    const r = await llamarFuncion<{ resultados: unknown[] }>('documentos/leer', {})
    return r.resultados.length
  }

  async subirFacturaXubio(id: string): Promise<ResultadoXubioFactura> {
    return llamarFuncion<ResultadoXubioFactura>('xubio/factura', { facturaId: id })
  }

  async marcarFacturaRalpharma(id: string) {
    await this.rpc('marcar_factura_ralpharma', { p_id: id })
  }

  async reintentarDocumento(id: string) {
    await this.rpc('reintentar_documento', { p_id: id })
  }

  async descartarDocumento(id: string, motivo: string) {
    await this.rpc('descartar_documento', { p_id: id, p_motivo: motivo })
  }

  comprobantesEjemplo(): ComprobanteEjemplo[] {
    return []
  }

  async reiniciar() {
    /* no aplica con datos reales */
  }
}

/** Usuario actual a partir de la sesión de Supabase y la tabla usuarios. */
export async function usuarioActual(db: SupabaseClient): Promise<Usuario | null> {
  const { data: sesion } = await db.auth.getSession()
  const email = sesion.session?.user.email
  if (!email) return null
  const { data } = await db.from('usuarios').select('nombre, rol, email, activo').eq('email', email.toLowerCase()).maybeSingle()
  if (!data || !data.activo) return null
  return { nombre: String(data.nombre), rol: String(data.rol) as Usuario['rol'], email: String(data.email) }
}
