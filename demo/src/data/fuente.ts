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
  planCuentas: string[]
}

export interface Datos {
  facturas: Factura[]
  pagos: Pago[]
  auditoria: Auditoria[]
  /** Archivos que entraron y todavía no son factura (en lectura, con error, duplicados). */
  documentos: Documento[]
  catalogos: Catalogos
}

/** Resultado de subir una factura a mano: leída, duplicada, con error, o en cola si la IA tardó. */
export type ResultadoSubida = { estado: 'LEIDO' | 'DUPLICADO' | 'ERROR' | 'PENDIENTE'; detalle?: string }
export type Bucket = 'comprobantes' | 'facturas'
export type ResultadoXubioFactura = { estado: 'SUBIDA' | 'EN_SECO' | 'ERROR' | 'NO_APLICA'; xubioId?: string; detalle: string }

export type DatosAprobacion = { cuentaContable: string; metodoPago: MetodoPago; diasCheque?: number }
export type DatosContabilizacion = { cuentaContable: string; formaCargaXubio: Pago['formaCargaXubio'] }
export type NuevoPago = Omit<Pago, 'id' | 'estado' | 'cargadoPor' | 'cargadoEn'>
export type ResultadoXubio = { ok: true; id: string; enSeco: boolean; detalle?: string } | { ok: false; error: string }

export interface Fuente {
  modo: 'demo' | 'conectado'
  cargar(): Promise<Datos>
  aprobarFactura(id: string, datos: DatosAprobacion, u: Usuario): Promise<void>
  rechazarFactura(id: string, motivo: string, u: Usuario): Promise<void>
  corregirFactura(id: string, u: Usuario): Promise<void>
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
