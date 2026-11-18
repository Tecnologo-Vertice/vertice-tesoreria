// Contrato entre las pantallas y los datos. Hay dos implementaciones:
//  - fuenteDemo: todo en memoria y localStorage, con datos ficticios (modo "demo").
//  - fuenteSupabase: base PostgreSQL en Supabase + funciones en Netlify (modo "conectado").
// Las pantallas no saben cuál está activa.

import type {
  Auditoria,
  ComprobanteEjemplo,
  CuentaOrigen,
  Documento,
  Empresa,
  EstadoEspejo,
  Factura,
  LecturaComprobante,
  MetodoPago,
  Pago,
  Proveedor,
  Usuario,
} from '../types'

export interface Catalogos {
  empresas: Empresa[]
  proveedores: Proveedor[]
  cuentasOrigen: CuentaOrigen[]
  /** Plan de cuentas común (o el único, en demo). */
  planCuentas: string[]
  /** Plan real de cada empresa (Catalogo_Cuentas_Contables). Vacío en demo. */
  planPorEmpresa: Record<string, string[]>
  /** Productos de compra de Xubio: la "cuenta" de una factura en producción. Vacío en demo. */
  productos: string[]
  /** Nombre del producto → código en Xubio (Catalogo_Productos). */
  codigosProducto: Record<string, string>
}

export interface Datos {
  facturas: Factura[]
  pagos: Pago[]
  auditoria: Auditoria[]
  /** Archivos que entraron y todavía no son factura (en lectura, con error, duplicados). */
  documentos: Documento[]
  catalogos: Catalogos
  /** Copia de la hoja real: cuándo corrió por última vez cada pestaña. Vacío en demo. */
  espejo: EstadoEspejo[]
}

/** Resultado de subir una factura a mano: leída, duplicada, con error, o en cola si la IA tardó. */
export type ResultadoSubida = { estado: 'LEIDO' | 'DUPLICADO' | 'ERROR' | 'PENDIENTE'; detalle?: string }
export type Bucket = 'comprobantes' | 'facturas'
export type ResultadoXubioFactura = { estado: 'SUBIDA' | 'EN_SECO' | 'ERROR' | 'NO_APLICA'; xubioId?: string; detalle: string }

/** Lo que se puede corregir a mano de una factura (editar_factura en SQL). */
export interface DatosEdicion {
  empresaId: string
  proveedor: string
  cuit: string
  tipo: string
  letra: string
  puntoVenta: number
  numero: number
  fecha: string
  vencimiento: string
  moneda: string
  cotizacion: number
  neto: number
  iva: number
  exento: number
  percepciones: { nombre: string; importe: number }[]
  total: number
  cae: string
  caeVencimiento: string
  categoriaVertice: string
  cuentaContable: string
  codigoProducto: string
}
/** Cómo quedó después de guardar: si la validación falla, en Excepciones con el motivo. */
export type ResultadoEdicion = { estado: string; motivo?: string | null }

export type DatosAprobacion = { cuentaContable: string; metodoPago: MetodoPago; diasCheque?: number }
/** Cómo se pagó una factura que Administración aprueba ya pagada (PagoAlAprobar.gs). */
export interface DatosYaPagada {
  /** El pago ya está cargado a mano en Xubio: queda contabilizado y no se envía nada. */
  yaEnXubio: boolean
  /** Banco o caja de donde salió. Vacío = no se sabe: Tesorería adjunta el comprobante después. */
  cuentaOrigen?: string
  fecha?: string
  numeroCheque?: string
  fechaAcreditacion?: string
  observaciones?: string
}
/** Cómo quedó: el pago ya contabilizado, el pago en Contabilización, o la factura en Para pagar. */
export type ResultadoYaPagada = 'CONTABILIZADO' | 'PARA_CONTABILIZAR' | 'PARA_PAGAR'

export type DatosContabilizacion = { cuentaContable: string; formaCargaXubio: Pago['formaCargaXubio']; cuentaOrigen?: string }
export type NuevoPago = Omit<Pago, 'id' | 'estado' | 'cargadoPor' | 'cargadoEn'>
export type ResultadoXubio = { ok: true; id: string; enSeco: boolean; detalle?: string } | { ok: false; error: string }

export interface Fuente {
  modo: 'demo' | 'conectado'
  cargar(): Promise<Datos>
  aprobarFactura(id: string, datos: DatosAprobacion, u: Usuario): Promise<void>
  rechazarFactura(id: string, motivo: string, u: Usuario): Promise<void>
  aprobarYaPagada(id: string, datos: DatosAprobacion, pago: DatosYaPagada, u: Usuario): Promise<ResultadoYaPagada>
  /** Aplica una nota de crédito aprobada a una factura del mismo proveedor y empresa. */
  aplicarNotaCredito(ncId: string, facturaId: string, importe: number, u: Usuario): Promise<void>
  /** Anula un pago que todavía no está en Xubio ni en Ralpharma y devuelve lo aplicado a sus facturas. */
  anularPago(id: string, motivo: string, u: Usuario): Promise<void>
  corregirFactura(id: string, u: Usuario): Promise<void>
  editarFactura(id: string, datos: DatosEdicion, u: Usuario): Promise<ResultadoEdicion>
  registrarPago(datos: NuevoPago, u: Usuario): Promise<Pago>
  contabilizarPago(id: string, datos: DatosContabilizacion, u: Usuario): Promise<ResultadoXubio>
  marcarRalpharma(id: string, u: Usuario): Promise<void>
  /** En demo recibe un comprobante de ejemplo; conectado, un File real que va a la IA. */
  leerComprobante(archivo: File | ComprobanteEjemplo): Promise<LecturaComprobante>
  comprobantesEjemplo(facturas: Factura[]): ComprobanteEjemplo[]
  /** Guarda el archivo y devuelve la ruta con la que se registra el pago. */
  subirComprobante(archivo: File): Promise<string>
  /** Link temporal para abrir un archivo guardado. Null en demo (no hay archivos reales). */
  urlArchivo(bucket: Bucket, path: string): Promise<string | null>
  /** Flujo 1: carga manual de una factura (PDF o foto). La IA la lee y queda en Aprobación. */
  subirFactura(archivo: File, u: Usuario): Promise<ResultadoSubida>
  /** Lee lo que esté esperando en la cola sin esperar al lector programado. Devuelve cuántos leyó. */
  leerAhora(): Promise<number>
  reintentarDocumento(id: string, u: Usuario): Promise<void>
  /** Sube a Xubio una factura aprobada (en seco o real según la configuración del servidor). */
  subirFacturaXubio(id: string, u: Usuario): Promise<ResultadoXubioFactura>
  /** Guido confirma que cargó en Ralpharma una factura de una empresa sin Xubio. */
  marcarFacturaRalpharma(id: string, u: Usuario): Promise<void>
  descartarDocumento(id: string, motivo: string, u: Usuario): Promise<void>
  reiniciar(): Promise<void>
}
