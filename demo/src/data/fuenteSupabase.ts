// Modo conectado: lee de Supabase con la sesión del usuario (RLS) y escribe a través
// de funciones SQL (RPC) que validan el rol y dejan auditoría. La IA y Xubio pasan por
// funciones de Netlify porque necesitan claves que nunca van al navegador.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Auditoria, ComprobanteEjemplo, CuentaOrigen, Documento, Empresa, EstadoEspejo, Factura, LecturaComprobante, Pago, Proveedor, Usuario } from '../types'
import type { AlcanceProyeccion, CambioLinea, DatosTesoreria, NuevaProyeccion, NuevoCheque, OpcionesExtracto, PendienteXubio, ResultadoCorridaBancos, ResultadoExtracto } from './fuente'
import { leerResultadoExtracto } from './resultadoExtracto'
import type {
  AvisoFci,
  CategoriaMovimiento,
  Cheque,
  Conciliacion,
  ControlFlujo,
  CuentaBancaria,
  DocumentoBancario,
  Extracto,
  FilaFlujo,
  FotoFlujo,
  LineaFlujo,
  MovimientoBancario,
  OrigenSaldo,
  Proyeccion,
  RefLinea,
  SaldoArrastrado,
  SaldoBancario,
  TipoPagoFactura,
  Unidad,
} from '../types'
import { addDays, iso } from '../lib/format'
import type { Bucket, Datos, DatosAprobacion, ResultadoAprobacion, ResultadoVinculo, DatosContabilizacion, DatosEdicion, DatosLiberacion, DatosYaPagada, Fuente, ResultadoLiberacion, ResultadoYaPagada, ResultadoEdicion, NuevoPago, ProyeccionParaPago, ResultadoSubida, ResultadoXubio, ResultadoXubioFactura } from './fuente'
import { archivoABase64, llamarFuncion } from '../lib/supabase'
import { rutaComprobante } from '../lib/rutas'

type Row = Record<string, unknown>
const s = (v: unknown) => (v == null ? undefined : String(v))
const n = (v: unknown) => (v == null ? 0 : Number(v))
const nu = (v: unknown) => (v == null ? undefined : Number(v))
const d10 = (v: unknown) => (v == null ? undefined : String(v).slice(0, 10))
type Consulta = ReturnType<ReturnType<SupabaseClient['from']>['select']>

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
    vencimientoFactura: s(r.vencimiento_factura),
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
    tipoPago: s(r.tipo_pago) as Factura['tipoPago'],
    anticipoPct: nu(r.anticipo_pct),
    fechaPago: d10(r.fecha_pago),
    unidadId: s(r.unidad_id),
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
    proyeccionId: s(r.proyeccion_id),
    proyeccionOcurrencia: s(r.proyeccion_ocurrencia),
    proyeccionImporte: r.proyeccion_importe == null ? undefined : n(r.proyeccion_importe),
    proyeccionBaja: r.proyeccion_baja === true,
    estadoExtraccion: s(r.estado_extraccion),
    avisoImporte: s(r.aviso_importe),
    detalleXubio: s(r.xubio_detalle) ?? s(r.detalle_contabilizacion),
    envioXubioEn: s(r.envio_xubio_en),
    anuladoPor: s(r.anulado_por),
    anuladoEn: s(r.anulado_en),
    motivoAnulacion: s(r.motivo_anulacion),
    tipoPago: s(r.tipo_pago),
    facturaAsociada: s(r.factura_asociada),
    posibleDuplicado: s(r.posible_duplicado),
    avisoCheque: s(r.aviso_cheque),
    faltaComprobante: r.falta_comprobante === true,
    numeroOp: s(r.numero_op),
    numeroOpOrigen: s(r.numero_op_origen) as Pago['numeroOpOrigen'],
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
    const [empresas, proveedores, cuentasOrigen, plan, facturas, pagosRaw, vinculos, auditoria, documentos, espejo, productos, ncs, plazoEnvioXubioSeg] = await Promise.all([
      this.lista<Empresa>('empresas', (r) => ({ id: String(r.id), nombre: String(r.nombre), corto: String(r.nombre_corto), cuit: String(r.cuit), erp: String(r.erp) as Empresa['erp'], organizacionId: s(r.organizacion_id) })),
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
      // Plazo para dar por cortado un envío a Xubio (0016). Sin la migración, sin dato: la pantalla no ofrece liberar.
      this.rpc<number>('plazo_envio_xubio_segundos', {}).then((v) => (typeof v === 'number' && v > 0 ? v : undefined)).catch(() => undefined),
    ])
    this.organizacionDe = new Map(empresas.flatMap((e) => (e.organizacionId ? [[e.id, e.organizacionId] as [string, string]] : [])))
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
    return { facturas, pagos, documentos, auditoria: auditoria.sort((a, b) => a.fecha.localeCompare(b.fecha)), catalogos: { empresas, proveedores, cuentasOrigen, planCuentas: [...new Set(comunes)].sort(), planPorEmpresa, productos: productos.map((p) => p.nombre), codigosProducto: Object.fromEntries(productos.map((p) => [p.nombre, p.codigo])), plazoEnvioXubioSeg }, espejo }
  }

  private async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args)
    if (error) throw new Error(error.message)
    return data as T
  }

  async aprobarFactura(id: string, d: DatosAprobacion): Promise<ResultadoAprobacion> {
    // La fecha de pago es obligatoria salvo cheque, tarjeta y notas de crédito (la base lo controla, 0041). Las firmas viejas de
    // 4 argumentos ya no las puede llamar una persona.
    const r = await this.rpc<Row>('aprobar_factura_y_vincular', { p_id: id, p_cuenta: d.cuentaContable, p_metodo: d.metodoPago, p_dias: d.diasCheque ?? null, p_fecha_pago: d.fechaPago ?? null })
    return { estado: s(r.estado), estadoXubio: s(r.estado_xubio), tarjeta: r.tarjeta === true, vinculado: r.vinculado === true, mensaje: s(r.mensaje) }
  }

  async vincularPagoSinFactura(pagoId: string, facturaId: string): Promise<ResultadoVinculo> {
    const r = await this.rpc<Row>('vincular_pago_sin_factura', { p_pago: pagoId, p_factura: facturaId })
    return { numero: String(r.numero), monto: n(r.monto), sobra: n(r.sobra), completa: r.completa === true, yaEnXubio: r.ya_en_xubio === true }
  }

  async corregirProveedorPago(pagoId: string, proveedorId: string) {
    await this.rpc('corregir_proveedor_pago', { p_pago: pagoId, p_proveedor: proveedorId })
  }

  async adjuntarComprobantePago(pagoId: string, ruta: string, cuentaOrigen: string | undefined) {
    await this.rpc('adjuntar_comprobante_pago', { p_pago: pagoId, p_ruta: ruta, p_cuenta_origen: cuentaOrigen ?? null })
  }

  async quitarComprobantePago(pagoId: string) {
    await this.rpc('quitar_comprobante_pago', { p_pago: pagoId })
  }

  async guardarNumeroOp(pagoId: string, numero: string, _u?: unknown, confirmar = false) {
    await this.rpc('guardar_numero_op', { p_pago: pagoId, p_numero: numero, p_confirmar: confirmar })
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

  async liberarPagoXubio(id: string, xubioId: string, d: DatosLiberacion): Promise<ResultadoLiberacion> {
    return this.rpc<ResultadoLiberacion>('liberar_pago_xubio', { p_id: id, p_xubio_id: xubioId.trim(), p_cuenta: d.cuentaContable || null, p_forma: d.formaCargaXubio ?? null })
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
        proyeccion_id: d.proyeccionId ?? null,
        proyeccion_ocurrencia: d.proyeccionOcurrencia ?? null,
      },
    })
    const { data } = await this.db.from('pagos').select('*').eq('id', id).single()
    return mapPago(data as Row, d.facturaIds)
  }

  async proyeccionesParaPago(empresaId: string): Promise<ProyeccionParaPago[]> {
    try {
      const filas = await this.rpc<Row[]>('proyecciones_para_pago', { p_empresa: empresaId })
      return (filas ?? []).map((r) => ({
        proyeccionId: String(r.proyeccion_id), ocurrencia: String(r.ocurrencia), fecha: String(r.fecha), importe: n(r.importe),
        concepto: s(r.concepto) ?? '', proveedor: s(r.proveedor), fila: s(r.fila) ?? '', recurrencia: s(r.recurrencia) ?? 'UNICA',
      }))
    } catch (e) {
      // Base sin la migración 0041: no hay proyecciones para elegir.
      if (/could not find the function/i.test(e instanceof Error ? e.message : String(e))) return []
      throw e
    }
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

  /** Organización de cada empresa visible, para armar la carpeta de los comprobantes. Se llena al cargar. */
  private organizacionDe = new Map<string, string>()

  async subirComprobante(archivo: File, empresaId: string): Promise<string> {
    const path = rutaComprobante(this.organizacionDe.get(empresaId), empresaId, archivo.name)
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
  // ---------------------------------------------------------------- Tesorería (0023 a 0027)

  /** Como lista(), con filtros. */
  private async consulta<T>(tabla: string, map: (r: Row) => T, filtrar: (q: Consulta) => Consulta, orden: [string, 'asc' | 'desc'][], tope = 20000): Promise<T[]> {
    const PAGINA = 1000
    const filas: Row[] = []
    for (let desde = 0; desde < tope; desde += PAGINA) {
      const hasta = Math.min(desde + PAGINA, tope) - 1
      let q = filtrar(this.db.from(tabla).select('*'))
      for (const [col, dir] of orden) q = q.order(col, { ascending: dir === 'asc' })
      const { data, error } = await q.range(desde, hasta)
      if (error) throw new Error(`${tabla}: ${error.message}`)
      filas.push(...(data as Row[]))
      if ((data as Row[]).length < hasta - desde + 1) break
    }
    return filas.map(map)
  }

  /**
   * El Flujo y su control en UNA llamada (flujo_rango y flujo_control_rango, 0031): la base aplica el rango de
   * fechas antes de calcular y devuelve todo junto. Antes se pedía la vista de a 1000 filas y cada página la
   * recalculaba entera. Si la base todavía no tiene 0031, lee la vista como antes.
   */
  private async porRango<T>(fn: string, args: Record<string, unknown>, vista: string, map: (r: Row) => T, filtrar: (q: Consulta) => Consulta, orden: [string, 'asc' | 'desc'][]): Promise<T[]> {
    const { data, error } = await this.db.rpc(fn, args)
    if (!error) return ((data ?? []) as Row[]).map(map)
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message)) return this.consulta<T>(vista, map, filtrar, orden)
    throw new Error(`${fn}: ${error.message}`)
  }

  async cargarTesoreria(): Promise<DatosTesoreria> {
    const hoy = iso(new Date())
    const desde = iso(addDays(new Date(), -45))
    const hasta = iso(addDays(new Date(), 200))
    const todo = (q: Consulta) => q
    try {
      const [unidades, cuentas, feriados, movimientos, saldos, conciliacion, asientos, comprobantes, extractos, chequesRaw, chequesPagos, acreedores, filas, lineas, control, proyecciones] = await Promise.all([
        this.consulta<Unidad>('unidades', (r) => ({ id: String(r.id), empresaId: String(r.empresa_id), nombre: String(r.nombre), porDefecto: Boolean(r.por_defecto), orden: n(r.orden) }), (q) => q.eq('activa', true), [['orden', 'asc'], ['id', 'asc']]),
        this.consulta<CuentaBancaria>(
          'cuentas_origen',
          (r) => ({
            id: String(r.id),
            empresaId: String(r.empresa_id),
            unidadId: s(r.unidad_id),
            nombre: String(r.nombre),
            banco: s(r.banco),
            clase: (s(r.clase) ?? 'CC') as CuentaBancaria['clase'],
            rindeDiario: Boolean(r.rinde_diario),
            requiereExtracto: r.requiere_extracto !== false,
            cuentaMadreId: s(r.cuenta_madre_id),
            orden: n(r.orden),
          }),
          (q) => q.eq('activa', true),
          [['orden', 'asc'], ['id', 'asc']],
        ),
        this.consulta<string>('feriados', (r) => String(r.fecha), (q) => q.gte('fecha', desde), [['fecha', 'asc']]),
        this.consulta<MovimientoBancario>(
          'movimientos_bancarios',
          (r) => ({
            id: String(r.id),
            empresaId: String(r.empresa_id),
            cuentaId: String(r.cuenta_origen_id),
            fecha: String(r.fecha),
            descripcion: s(r.descripcion) ?? '',
            importe: n(r.importe),
            referencia: s(r.referencia),
            numeroCheque: s(r.numero_cheque),
            categoria: (s(r.categoria) ?? 'SIN_CLASIFICAR') as CategoriaMovimiento,
            cuentaContable: s(r.cuenta_contable),
            destinoXubio: (s(r.destino_xubio) ?? 'NINGUNO') as MovimientoBancario['destinoXubio'],
            componente: s(r.componente) as MovimientoBancario['componente'],
            estado: (s(r.estado) ?? 'A_REVISAR') as MovimientoBancario['estado'],
            contraparteCuentaId: s(r.contraparte_cuenta_id),
            pagoId: s(r.pago_id),
            cobroId: s(r.cobro_id),
            chequeId: s(r.cheque_id),
            facturaId: s(r.factura_id),
            asientoId: s(r.asiento_id),
            revisadoPor: s(r.revisado_por),
          }),
          (q) => q.gte('fecha', desde),
          [['fecha', 'desc'], ['id', 'asc']],
        ),
        this.consulta<SaldoBancario>('saldos_bancarios', (r) => ({ cuentaId: String(r.cuenta_origen_id), fecha: String(r.fecha), saldo: n(r.saldo), origen: String(r.origen) as OrigenSaldo }), (q) => q.gte('fecha', desde), [['fecha', 'asc'], ['cuenta_origen_id', 'asc']]),
        this.consulta<Conciliacion>(
          'conciliacion_bancaria',
          (r) => ({
            empresaId: String(r.empresa_id),
            unidadId: s(r.unidad_id),
            cuentaId: String(r.cuenta_origen_id),
            cuenta: String(r.cuenta),
            clase: (s(r.clase) ?? 'CC') as Conciliacion['clase'],
            fecha: String(r.fecha),
            fechaAnterior: s(r.fecha_anterior),
            saldoAnterior: nu(r.saldo_anterior),
            creditos: n(r.creditos),
            debitos: n(r.debitos),
            movimientos: n(r.movimientos),
            saldoCalculado: nu(r.saldo_calculado),
            saldoExtracto: nu(r.saldo_extracto),
            origen: s(r.origen) as OrigenSaldo | undefined,
            diferencia: nu(r.diferencia),
            rendimiento: nu(r.rendimiento),
            saldoXubio: nu(r.saldo_xubio),
            diferenciaXubio: nu(r.diferencia_xubio),
            estado: String(r.estado) as Conciliacion['estado'],
          }),
          (q) => q.gte('fecha', desde),
          [['fecha', 'asc'], ['cuenta_origen_id', 'asc']],
        ),
        this.consulta<DocumentoBancario>(
          'asientos',
          (r) => ({ id: String(r.id), tipo: 'ASIENTO', cuentaId: String(r.cuenta_origen_id), fecha: String(r.fecha), estado: r.anulado_en ? 'ANULADO' : 'GENERADO', estadoXubio: s(r.estado_xubio), complemento: r.tipo === 'BANCARIO_COMPLEMENTO' }),
          (q) => q.gte('fecha', desde).in('tipo', ['BANCARIO_DIARIO', 'BANCARIO_COMPLEMENTO']).is('anulado_en', null),
          [['fecha', 'asc'], ['id', 'asc']],
        ),
        this.consulta<DocumentoBancario>(
          'facturas',
          (r) => ({ id: String(r.id), tipo: 'COMPROBANTE', cuentaId: String(r.cuenta_origen_extracto_id), fecha: String(r.fecha), numero: `${String(nu(r.punto_venta) ?? 9990).padStart(5, '0')}-${s(r.numero) ?? ''}`, total: n(r.total), estado: String(r.estado), estadoXubio: s(r.estado_xubio) }),
          (q) => q.gte('fecha', desde).not('cuenta_origen_extracto_id', 'is', null),
          [['fecha', 'asc'], ['id', 'asc']],
        ),
        this.consulta<Extracto>(
          'extractos',
          (r) => ({ id: String(r.id), cuentaId: String(r.cuenta_origen_id), archivo: String(r.archivo_nombre), desde: s(r.desde), hasta: s(r.hasta), movimientos: n(r.movimientos), nuevos: n(r.nuevos), importadoPor: String(r.importado_por), importadoEn: String(r.importado_en) }),
          todo,
          [['importado_en', 'desc'], ['id', 'asc']],
          200,
        ),
        this.consulta<Row>('cheques', (r) => r, todo, [['fecha_pago', 'desc'], ['id', 'asc']], 3000),
        this.consulta<{ cheque: string; pago: string; importe: number }>('cheques_pagos', (r) => ({ cheque: String(r.cheque_id), pago: String(r.pago_id), importe: n(r.importe) }), todo, [['cheque_id', 'asc'], ['pago_id', 'asc']]),
        this.consulta<{ id: string; nombre: string }>('acreedores', (r) => ({ id: String(r.id), nombre: String(r.nombre) }), todo, [['id', 'asc']]),
        this.consulta<FilaFlujo>(
          'flujo_filas',
          (r) => ({
            id: String(r.id),
            unidadId: String(r.unidad_id),
            orden: n(r.orden),
            tipo: String(r.tipo) as FilaFlujo['tipo'],
            seccion: String(r.seccion) as FilaFlujo['seccion'],
            etiqueta: String(r.etiqueta),
            cuentaContable: s(r.cuenta_contable),
            padreId: s(r.padre_id),
            mueveCaja: r.mueve_caja !== false,
            manual: r.manual === true,
            personaFisica: r.para_persona_fisica === true,
          }),
          (q) => q.eq('activa', true),
          [['unidad_id', 'asc'], ['orden', 'asc'], ['id', 'asc']],
        ),
        this.porRango<LineaFlujo>(
          'flujo_rango',
          { p_unidad: null, p_desde: desde, p_hasta: hasta },
          'flujo_lineas',
          (r) => ({
            empresaId: String(r.empresa_id),
            unidadId: String(r.unidad_id),
            filaId: String(r.fila_id),
            origenTipo: String(r.origen_tipo) as LineaFlujo['origenTipo'],
            origenId: String(r.origen_id),
            ocurrencia: String(r.ocurrencia),
            naturaleza: String(r.naturaleza) as LineaFlujo['naturaleza'],
            fecha: String(r.fecha),
            fechaCalculada: String(r.fecha_calculada ?? r.fecha),
            importe: n(r.importe),
            contraparte: s(r.contraparte),
            concepto: s(r.concepto),
            vencido: Boolean(r.vencido),
            ajustada: Boolean(r.ajustada),
            editable: Boolean(r.editable),
          }),
          (q) => q.gte('fecha', desde).lte('fecha', hasta),
          [['fecha', 'asc'], ['origen_tipo', 'asc'], ['origen_id', 'asc'], ['ocurrencia', 'asc']],
        ),
        this.porRango<ControlFlujo>(
          'flujo_control_rango',
          { p_desde: desde, p_hasta: null },
          'flujo_control',
          (r) => ({
            unidadId: String(r.unidad_id),
            fecha: String(r.fecha),
            fechaAnterior: s(r.fecha_anterior),
            saldoAnterior: nu(r.saldo_anterior),
            saldoBancos: n(r.saldo_bancos),
            realDelPeriodo: n(r.real_del_periodo),
            diferencia: n(r.diferencia),
            estado: String(r.estado) as ControlFlujo['estado'],
          }),
          (q) => q.gte('fecha', desde),
          [['unidad_id', 'asc'], ['fecha', 'asc']],
        ),
        this.consulta<Proyeccion>(
          'proyecciones',
          (r) => ({
            id: String(r.id),
            empresaId: String(r.empresa_id),
            unidadId: String(r.unidad_id),
            filaId: String(r.fila_id),
            concepto: String(r.concepto),
            importe: n(r.importe),
            fechaInicio: String(r.fecha_inicio),
            recurrencia: String(r.recurrencia) as Proyeccion['recurrencia'],
            diaMes: nu(r.dia_mes),
            hasta: s(r.hasta),
            cuotas: nu(r.cuotas),
            ajustePctMensual: n(r.ajuste_pct_mensual),
            estado: String(r.estado) as Proyeccion['estado'],
            origen: String(r.origen) as Proyeccion['origen'],
            nota: s(r.nota),
            creadoPor: String(r.creado_por),
          }),
          (q) => q.neq('estado', 'CANCELADA'),
          [['fecha_inicio', 'asc'], ['id', 'asc']],
        ),
      ])
      const nombreAcreedor = new Map(acreedores.map((a) => [a.id, a.nombre]))
      const cheques: Cheque[] = chequesRaw.map((r) => ({
        id: String(r.id),
        empresaId: String(r.empresa_id),
        cuentaId: String(r.cuenta_origen_id),
        tipo: String(r.tipo) as Cheque['tipo'],
        numero: String(r.numero),
        acreedor: r.acreedor_id ? nombreAcreedor.get(String(r.acreedor_id)) : undefined,
        proveedorId: s(r.proveedor_id),
        beneficiario: String(r.beneficiario),
        importe: n(r.importe),
        fechaEmision: String(r.fecha_emision),
        fechaPago: String(r.fecha_pago),
        estado: String(r.estado) as Cheque['estado'],
        origen: String(r.origen) as Cheque['origen'],
        debitadoEn: s(r.debitado_en),
        marcadoPor: s(r.marcado_por),
        anuladoPor: s(r.anulado_por),
        motivoAnulacion: s(r.motivo_anulacion),
        anulacionXubio: s(r.anulacion_xubio) as Cheque['anulacionXubio'],
        anulacionManualPor: s(r.anulacion_manual_por),
        anulacionManualNota: s(r.anulacion_manual_nota),
        observaciones: s(r.observaciones),
        pagos: chequesPagos.filter((x) => x.cheque === String(r.id)).map((x) => ({ pagoId: x.pago, importe: x.importe })),
      }))
      return {
        disponible: true,
        hoy,
        unidades,
        cuentas,
        feriados,
        movimientos,
        saldos,
        conciliacion,
        documentos: [...asientos, ...comprobantes],
        extractos,
        cheques,
        pendientesXubio: await this.pendientesXubio(),
        chequesSugeridos: await this.chequesSugeridos(),
        avisosFci: await this.avisosFci(),
        saldosArrastrados: await this.saldosArrastrados(),
        filas,
        lineas,
        control,
        proyecciones,
        fotos: await this.fotosFlujo(),
        cuentasContables: [...new Set(filas.map((f) => f.cuentaContable).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b)),
      }
    } catch (e) {
      return {
        disponible: false,
        error: e instanceof Error ? e.message : String(e),
        hoy,
        unidades: [],
        cuentas: [],
        feriados: [],
        movimientos: [],
        saldos: [],
        conciliacion: [],
        documentos: [],
        extractos: [],
        cheques: [],
        pendientesXubio: [],
        chequesSugeridos: [],
        avisosFci: [],
        saldosArrastrados: [],
        filas: [],
        lineas: [],
        control: [],
        proyecciones: [],
        fotos: [],
        cuentasContables: [],
      }
    }
  }

  /** Fotos mensuales de la proyección (0038): los últimos tres meses. Sin la migración, lista vacía. */
  private async fotosFlujo(): Promise<FotoFlujo[]> {
    const desde = iso(addDays(new Date(), -100))
    const { data, error } = await this.db.from('flujo_fotos').select('*').gte('dia', desde).order('dia', { ascending: true }).limit(5000)
    if (error) return []
    return (data as Row[]).map((r) => ({
      unidadId: String(r.unidad_id),
      mes: String(r.mes),
      dia: String(r.dia),
      ingresosOperativos: n(r.ingresos_operativos),
      costos: n(r.costos),
      gastosOperativos: n(r.gastos_operativos),
      impuestos: n(r.impuestos),
      subtotal: n(r.subtotal),
      socios: n(r.socios),
      intercompany: n(r.intercompany),
      variacionCaja: n(r.variacion_caja),
      parcial: r.parcial === true,
      tomadaEn: String(r.tomada_en),
      tomadaPor: String(r.tomada_por),
    }))
  }

  /** Vista avisos_fci (0040). Sin la migración, lista vacía. */
  private async avisosFci(): Promise<AvisoFci[]> {
    const { data, error } = await this.db.from('avisos_fci').select('cuenta_origen_id, cuenta, madre, fecha, detalle').order('fecha', { ascending: false }).limit(200)
    if (error) return []
    return (data as Row[]).map((r) => ({ cuentaId: String(r.cuenta_origen_id), cuenta: String(r.cuenta), madre: String(r.madre), fecha: String(r.fecha), detalle: String(r.detalle) }))
  }

  /** saldos_arrastrados (0040) de los últimos 20 días. Sin la migración, lista vacía. */
  private async saldosArrastrados(): Promise<SaldoArrastrado[]> {
    const { data, error } = await this.db.rpc('saldos_arrastrados', { p_desde: iso(addDays(new Date(), -20)), p_hasta: null, p_empresa: null })
    if (error) return []
    return ((data ?? []) as Row[]).map((r) => ({ cuentaId: String(r.cuenta_origen_id), fecha: String(r.fecha), saldo: n(r.saldo), arrastrado: r.arrastrado === true, saldoDe: s(r.saldo_de) }))
  }

  /** Vista movimientos_cheque_sugerido (0036). Sin la migración, lista vacía. */
  private async chequesSugeridos(): Promise<DatosTesoreria['chequesSugeridos']> {
    const { data, error } = await this.db.from('movimientos_cheque_sugerido').select('movimiento_id, cheque_id, numero, importe')
    if (error) return []
    return (data as Row[]).map((r) => ({ movimientoId: String(r.movimiento_id), chequeId: String(r.cheque_id), numero: String(r.numero), importe: n(r.importe) }))
  }

  /** Vista xubio_bancos_pendientes (0029). Sin la migración, lista vacía: el resto de Tesorería sigue andando. */
  private async pendientesXubio(): Promise<PendienteXubio[]> {
    try {
      return await this.consulta<PendienteXubio>(
        'xubio_bancos_pendientes',
        (r) => ({
          empresaId: String(r.empresa_id),
          tipo: String(r.tipo) as PendienteXubio['tipo'],
          id: String(r.id),
          fecha: String(r.fecha),
          descripcion: String(r.descripcion ?? ''),
          importe: nu(r.importe),
          estado: String(r.estado) as PendienteXubio['estado'],
          error: s(r.error),
          xubioId: s(r.xubio_id),
          aMano: Boolean(r.a_mano),
          cuentaId: s(r.cuenta_origen_id),
          ultimoIntentoEn: s(r.ultimo_intento_en),
          ultimoIntentoEstado: s(r.ultimo_intento_estado),
          ultimoIntentoModo: s(r.ultimo_intento_modo) as PendienteXubio['ultimoIntentoModo'],
          ultimoIntentoDetalle: s(r.ultimo_intento_detalle),
        }),
        (q) => q,
        [['fecha', 'asc'], ['id', 'asc']],
        2000,
      )
    } catch {
      return []
    }
  }

  async subirExtracto(archivo: File, cuentaId: string, _u?: Usuario, o: OpcionesExtracto = {}): Promise<ResultadoExtracto> {
    const data = await archivoABase64(archivo)
    const r = await llamarFuncion<Record<string, unknown>>('bancos/extracto', {
      cuentaOrigenId: cuentaId,
      nombre: archivo.name,
      mimeType: archivo.type || 'application/octet-stream',
      data,
      ...(o.fechaTenencia ? { fechaTenencia: o.fechaTenencia } : {}),
      ...(o.cuentaRemuneradaId ? { cuentaRemuneradaId: o.cuentaRemuneradaId } : {}),
      ...(o.confirmarOtraEmpresa ? { confirmarOtraEmpresa: true } : {}),
    }).catch((e) => {
      // [OTRA_EMPRESA]: no es un error, es un aviso que se puede confirmar desde la pantalla ("Subir igual").
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('[OTRA_EMPRESA]')) return { otraEmpresa: msg.replace('[OTRA_EMPRESA]', '').trim() } as Record<string, unknown>
      throw e
    })
    if (typeof r.otraEmpresa === 'string') return { repetido: false, nuevos: 0, otraEmpresa: r.otraEmpresa }
    return leerResultadoExtracto(r)
  }

  async borrarExtracto(id: string) {
    await this.rpc('borrar_extracto', { p_id: id })
  }

  async marcarAnulacionXubioManual(tipo: 'PAGO' | 'CHEQUE' | 'ASIENTO', id: string, nota: string) {
    await this.rpc('marcar_anulacion_xubio_manual', { p_tipo: tipo, p_id: id, p_nota: nota })
  }

  async correrEnviosBancos(enSeco: boolean): Promise<ResultadoCorridaBancos> {
    const r = await llamarFuncion<Record<string, unknown>>('xubio/bancos', { enSeco })
    return {
      real: r.real === true,
      envioRealHabilitado: r.envioRealHabilitado === true,
      omitido: s(r.omitido),
      items: Array.isArray(r.items) ? (r.items as ResultadoCorridaBancos['items']) : [],
    }
  }

  async reclasificarMovimiento(id: string, categoria: CategoriaMovimiento, cuenta: string | null, aprender: string | null) {
    await this.rpc('reclasificar_movimiento', { p_id: id, p_categoria: categoria, p_cuenta: cuenta, p_aprender_patron: aprender })
  }

  async asignarContraparte(movimientoId: string, cuentaId: string | null) {
    await this.rpc('asignar_contraparte', { p_mov: movimientoId, p_cuenta: cuentaId })
  }

  async marcarSinMovimientos(cuentaId: string, fecha: string, confirmo: boolean): Promise<number> {
    return Number(await this.rpc('marcar_sin_movimientos', { p_cuenta: cuentaId, p_fecha: fecha, p_confirmo_sin_rendimiento: confirmo }))
  }

  async registrarSaldo(cuentaId: string, fecha: string, saldo: number, origen: Extract<OrigenSaldo, 'TENENCIA' | 'MANUAL'>) {
    await this.rpc('registrar_saldo', { p_cuenta: cuentaId, p_fecha: fecha, p_saldo: saldo, p_origen: origen })
  }

  async generarComprobanteGastos(cuentaId: string, fecha: string): Promise<string | null> {
    return (await this.rpc<string | null>('generar_comprobante_gastos', { p_cuenta: cuentaId, p_fecha: fecha })) ?? null
  }

  async generarAsientoBancario(cuentaId: string, fecha: string): Promise<string | null> {
    return (await this.rpc<string | null>('generar_asiento_del_dia', { p_cuenta: cuentaId, p_fecha: fecha })) ?? null
  }

  async emitirCheque(c: NuevoCheque): Promise<string> {
    return this.rpc<string>('emitir_cheque', {
      p: {
        empresa_id: c.empresaId,
        cuenta_origen_id: c.cuentaId,
        tipo: c.tipo,
        numero: c.numero,
        beneficiario: c.beneficiario,
        proveedor_id: c.proveedorId ?? null,
        importe: c.importe,
        fecha_emision: c.fechaEmision,
        fecha_pago: c.fechaPago,
        origen: c.origen,
        observaciones: c.observaciones ?? null,
        pagos: c.pagos.map((p) => ({ pago_id: p.pagoId, importe: p.importe })),
      },
    })
  }

  async marcarChequeDebitado(id: string, numero: string, fecha: string) {
    await this.rpc('marcar_cheque_debitado', { p_id: id, p_numero: numero, p_fecha: fecha, p_movimiento: null })
  }

  async anularCheque(id: string, motivo: string) {
    await this.rpc('anular_cheque', { p_id: id, p_motivo: motivo })
  }

  async ajustarLineaFlujo(ref: RefLinea, cambio: CambioLinea, motivo: string) {
    await this.rpc('ajustar_linea_flujo', {
      p_tipo: ref.origenTipo,
      p_id: ref.origenId,
      p_ocurrencia: ref.ocurrencia,
      p_fecha: cambio.fecha ?? null,
      p_importe: cambio.importe ?? null,
      p_eliminar: cambio.eliminar ?? false,
      p_motivo: motivo,
    })
  }

  async restaurarLineaFlujo(ref: RefLinea) {
    await this.rpc('restaurar_linea_flujo', { p_tipo: ref.origenTipo, p_id: ref.origenId, p_ocurrencia: ref.ocurrencia })
  }

  async crearProyeccion(p: NuevaProyeccion): Promise<string> {
    return this.rpc<string>('crear_proyeccion', {
      p: {
        empresa_id: p.empresaId,
        unidad_id: p.unidadId,
        fila_id: p.filaId,
        concepto: p.concepto,
        importe: p.importe,
        fecha_inicio: p.fechaInicio,
        recurrencia: p.recurrencia,
        dia_mes: p.diaMes ?? null,
        hasta: p.hasta ?? null,
        cuotas: p.cuotas ?? null,
        ajuste_pct_mensual: p.ajustePctMensual,
        origen: p.origen,
        nota: p.nota ?? null,
      },
    })
  }

  async cambiarProyeccion(id: string, ocurrencia: string, alcance: AlcanceProyeccion, accion: 'EDITAR' | 'BORRAR', cambio: { importe?: number; fecha?: string }, motivo: string): Promise<string | null> {
    return this.rpc<string | null>('cambiar_proyeccion', {
      p_id: id,
      p_ocurrencia: ocurrencia,
      p_alcance: alcance,
      p_accion: accion,
      p_importe: cambio.importe ?? null,
      p_fecha: cambio.fecha ?? null,
      p_motivo: motivo,
    })
  }

  async marcarFilaFlujo(filaId: string, manual: boolean, personaFisica: boolean) {
    await this.rpc('marcar_fila_flujo', { p_fila: filaId, p_manual: manual, p_persona_fisica: personaFisica })
  }

  async sacarFotoFlujo(forzar: boolean): Promise<{ unidad: string; resultado: string }[]> {
    const r = await this.rpc<{ unidad: string; resultado: string }[]>('sacar_fotos_flujo', { p_organizacion: null, p_forzar: forzar })
    return r ?? []
  }

  async cancelarProyeccion(id: string, motivo: string) {
    await this.rpc('cancelar_proyeccion', { p_id: id, p_motivo: motivo })
  }

  async definirPagoFactura(id: string, tipoPago: TipoPagoFactura, anticipoPct: number | null, unidadId: string | null) {
    await this.rpc('definir_pago_factura', { p_id: id, p_tipo_pago: tipoPago, p_anticipo_pct: anticipoPct, p_unidad: unidadId })
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
