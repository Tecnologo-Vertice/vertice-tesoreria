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
  /** Facturas copiadas de la hoja real: HOJA mientras nadie la toque en el sistema nuevo. */
  gestion?: 'HOJA' | 'SISTEMA'
  /** Datos completos del comprobante, para editarlos a mano (como la tarjeta del dashboard de producción). */
  letra?: string
  exento?: number
  percepcionesJson?: Percepcion[]
  moneda?: string
  cotizacion?: number
  codigoProducto?: string
  /** Cuándo entró al sistema: marca de "Nueva" y orden "más nuevo primero". */
  creadoEn?: string
  /** Notas de crédito: lo que queda por aplicar a facturas del mismo proveedor y empresa. */
  saldoNc?: number
  /** Aprobada como ya pagada sin banco: Tesorería solo tiene que adjuntar el comprobante. */
  yaPagadaSegunAdmin?: string
  /** "Preparado en Gmail dd/mm/aaaa hh:mm" (mail al proveedor armado y abierto por Tesorería). */
  mailEnviado?: string
  /** Notas de crédito aplicadas a esta factura. */
  ncAplicadas?: { ncId: string; importe: number }[]
}

export interface Percepcion {
  nombre: string
  importe: number
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

export type EstadoPago = 'CARGADO' | 'REVISADO' | 'CONTABILIZADO' | 'CONCILIADO' | 'PENDIENTE_RALPHARMA' | 'ANULADO'

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
  /** Pagos copiados de la hoja real (producción). gestion SISTEMA = ya se tocó en el sistema nuevo. */
  hojaId?: string
  gestion?: 'HOJA' | 'SISTEMA'
  /** Link de Drive del comprobante (pagos de la hoja); los del sistema nuevo usan `comprobante` (Storage). */
  comprobanteUrl?: string
  bancoOrigen?: string
  numeroCuenta?: string
  proveedorDestino?: string
  tipoCheque?: string
  /** Lectura del comprobante por la IA: OK · MANUAL_OK · ERROR_n · REVISION_MANUAL. */
  estadoExtraccion?: string
  /** El comprobante dice un importe y Tesorería cargó otro. */
  avisoImporte?: string
  /** Qué pasó en Xubio (texto de producción o del envío en seco). */
  detalleXubio?: string
  /** Cuándo se reservó para enviarlo a Xubio. Con fecha y sin contabilizar = envío sin confirmar (trabado). */
  envioXubioEn?: string
  /** Anulado: quién, cuándo y por qué. */
  anuladoPor?: string
  anuladoEn?: string
  motivoAnulacion?: string
}

export interface CuentaOrigen {
  id: string
  empresaId: string
  nombre: string
  saldo: number
  /** Datos de Xubio (Xubio_Cuentas_Origen): 1 caja · 2 banco · 4 e-cheq emitidos. */
  xubioId?: string
  tipoCuenta?: number
  /** Cuántas veces se usó en los últimos 180 días: ordena la lista. */
  usos?: number
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

/** Última copia de una pestaña de la hoja real (espejo, solo en modo conectado). */
export interface EstadoEspejo {
  hoja: string
  ultimaEn: string
  filas: number
  nuevas: number
  actualizadas: number
  omitidas: number
  detalle: { fila?: number; id?: string; motivo: string }[]
}

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
