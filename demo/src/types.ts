// Modelo de dominio de la demo. Es el borrador del esquema de la base nueva:
// cada tipo acá se corresponde con una tabla en docs/02-modelo-datos.md.

export type Erp = 'XUBIO' | 'RALPHARMA' | 'NINGUNO'

export interface Empresa {
  id: string
  nombre: string
  corto: string
  cuit: string
  erp: Erp
}

export interface Proveedor {
  id: string
  nombre: string
  cuit: string
  email: string
  categoriaVertice: CategoriaVertice
  cuentaHabitual?: string
}

export type CategoriaVertice =
  | 'PROVEEDOR'
  | 'PRESTADOR_MEDICO'
  | 'FINANCIERA'
  | 'IMPUESTOS_SERVICIOS'
  | 'INSUMOS_MEDICOS'

export type TipoComprobante = 'Factura A' | 'Factura B' | 'Factura C' | 'Factura M' | 'Nota de Crédito'

export type EstadoFactura =
  | 'PENDIENTE_APROBACION'
  | 'PARA_PAGAR'
  | 'PAGADA_PARCIAL'
  | 'PAGADA'
  | 'RECHAZADA'
  | 'ERROR'

export type EstadoXubio = 'PENDIENTE' | 'SUBIDA' | 'ERROR' | 'SIN_ERP' | 'PENDIENTE_RALPHARMA' | 'CARGADA_RALPHARMA'

export type MetodoPago = 'TRANSFERENCIA' | 'CHEQUE' | 'ECHEQ' | 'DEBITO' | 'TARJETA' | 'CAJA'

export type Origen = 'GMAIL' | 'DRIVE' | 'MANUAL'

export interface Factura {
  id: string
  empresaId: string
  proveedorId: string
  tipo: TipoComprobante
  puntoVenta: number
  numero: number
  fecha: string // ISO
  vencimiento: string // ISO
  neto: number
  iva: number
  percepciones: number
  total: number
  cae: string
  caeVencimiento: string
  origen: Origen
  estado: EstadoFactura
  estadoXubio: EstadoXubio
  validacionOk: boolean
  motivoValidacion?: string
  categoriaVertice: CategoriaVertice
  cuentaContable?: string
  metodoPago?: MetodoPago
  diasCheque?: number
  /** Pagado en pesos: es el dato de verdad. pagadoPct es solo para mostrar. */
  pagado: number
  pagadoPct: number
  driveUrl?: string
  /** PDF en el bucket privado "facturas" (facturas que entraron por el sistema nuevo). */
  pdfPath?: string
  /** Avisos que no bloquean: redondeo, Factura M, CAE vencido después de emitir. */
  advertencia?: string
  /** Categoría genérica que sugirió la IA. No es la cuenta contable. */
  categoriaIa?: string
  /** Id en Xubio (para imputar pagos) y por qué falló la última subida. */
  xubioId?: string
  xubioError?: string
  /** Quién confirmó la carga en Ralpharma (empresas sin Xubio). */
  ralpharmaPor?: string
  ralpharmaEn?: string
  aprobadoPor?: string
  aprobadoEn?: string
}

export type EstadoDocumento = 'PENDIENTE' | 'LEYENDO' | 'LEIDO' | 'DUPLICADO' | 'ERROR' | 'DESCARTADO'

/** Un archivo que entró al sistema (adjunto de mail, carga manual, Drive) y espera o ya tuvo su lectura. */
export interface Documento {
  id: string
  origen: Origen
  nombre: string
  estado: EstadoDocumento
  error?: string
  remitente?: string
  asunto?: string
  cargadoPor?: string
  recibidoEn: string
  intentos: number
  storagePath: string
  facturaId?: string
}

export type FormaCargaXubio = 'ORDEN_PAGO' | 'SALIDA_FONDOS' | 'ASIENTO_MANUAL'

export type EstadoPago = 'CARGADO' | 'REVISADO' | 'CONTABILIZADO' | 'CONCILIADO' | 'PENDIENTE_RALPHARMA'

export type OrigenSugerencia = 'REGLA' | 'IA' | 'MANUAL'

export interface Pago {
  id: string
  empresaId: string
  proveedorId?: string
  fecha: string
  importe: number
  medio: MetodoPago
  cuentaOrigen: string
  bancoDestino?: string
  numeroCheque?: string
  fechaAcreditacion?: string
  facturaIds: string[]
  descripcion: string
  observaciones?: string
  cuentaContable?: string
  sugerenciaOrigen?: OrigenSugerencia
  sugerenciaConfianza?: number
  formaCargaXubio: FormaCargaXubio
  estado: EstadoPago
  comprobante: string
  cargadoPor: string
  cargadoEn: string
  contabilizadoPor?: string
  contabilizadoEn?: string
  xubioId?: string
  mailProveedorEnviado?: boolean
}

export interface CuentaOrigen {
  id: string
  empresaId: string
  nombre: string
  saldo: number
}

export interface Auditoria {
  id: string
  fecha: string
  usuario: string
  rol: Rol
  accion: string
  entidad: 'FACTURA' | 'PAGO' | 'SISTEMA'
  entidadId: string
  detalle: string
}

export type Rol = 'TESORERIA' | 'ADMINISTRACION' | 'APROBADOR' | 'DIRECCION' | 'CONTROLLER' | 'ADMIN'

export interface Usuario {
  nombre: string
  rol: Rol
  email: string
}

export interface LecturaComprobante {
  banco: string
  importe: number
  fecha: string
  medio: MetodoPago
  numeroCheque?: string
  bancoDestino?: string
  beneficiario?: string
  referencia?: string
  confianza: number
}

export interface ComprobanteEjemplo {
  id: string
  nombre: string
  descripcion: string
  lectura: LecturaComprobante
}
