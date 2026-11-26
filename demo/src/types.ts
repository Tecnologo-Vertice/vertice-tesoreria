// Modelo de dominio de la demo. Es el borrador del esquema de la base nueva:
// cada tipo acá se corresponde con una tabla en docs/02-modelo-datos.md.

export type Erp = 'XUBIO' | 'RALPHARMA' | 'NINGUNO'

export interface Empresa {
  id: string
  nombre: string
  corto: string
  cuit: string
  erp: Erp
  /** La organización (el cliente) dueña de la empresa. Sin dato en modo demo. */
  organizacionId?: string
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
  /** Forma de pago (definir_pago_factura): cuenta corriente, anticipado o anticipo % + cuenta corriente. */
  tipoPago?: TipoPagoFactura
  /** Con ANTICIPO_PARCIAL: el porcentaje que se paga por adelantado (el resto, al vencimiento). */
  anticipoPct?: number
  /** Fecha de pago programada (la que mueve el Flujo). No es el vencimiento. */
  fechaPago?: string
  /** Pestaña del Flujo donde cae. Sin dato: la unidad por defecto de la empresa. */
  unidadId?: string
}

export type TipoPagoFactura = 'CUENTA_CORRIENTE' | 'ANTICIPADO' | 'ANTICIPO_PARCIAL'

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
  entidad: 'FACTURA' | 'PAGO' | 'SISTEMA' | 'CHEQUE' | 'MOVIMIENTO' | 'CUENTA' | 'PROYECCION' | 'FLUJO'
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

// ---------------------------------------------------------------- Tesorería sin planillas (migraciones 0023 a 0027)

/** Una pestaña del Flujo (Beratung S/Dax, Dax Salud, India…). */
export interface Unidad {
  id: string
  empresaId: string
  nombre: string
  porDefecto: boolean
  orden: number
}

export type ClaseCuenta = 'CC' | 'CA' | 'FCI' | 'REMUNERADA' | 'BILLETERA' | 'CAJA' | 'ECHEQ' | 'TARJETA'

/** cuentas_origen con los datos de banco (0023). */
export interface CuentaBancaria {
  id: string
  empresaId: string
  unidadId?: string
  nombre: string
  banco?: string
  clase: ClaseCuenta
  /** Rinde todos los días (Mercado Pago, remunerada): "Sin movimientos" pide confirmación. */
  rindeDiario: boolean
  requiereExtracto: boolean
  cuentaMadreId?: string
  orden: number
}

export type CategoriaMovimiento =
  | 'SIN_CLASIFICAR'
  | 'PAGO'
  | 'COBRO'
  | 'IMPUESTO'
  | 'GASTO_BANCARIO'
  | 'FCI'
  | 'FCI_RENDIMIENTO'
  | 'TRANSFERENCIA_PROPIA'
  | 'CHEQUE_PAGADO'
  | 'INTERESES'
  | 'PRESTAMO'
  | 'INFORMATIVO'

export type EstadoMovimiento = 'A_REVISAR' | 'PENDIENTE' | 'CONTABILIZADO' | 'CARGADO_A_MANO' | 'INFORMATIVO' | 'IGNORADO'
export type DestinoXubio = 'COMPROBANTE' | 'ASIENTO' | 'NINGUNO'

export interface MovimientoBancario {
  id: string
  empresaId: string
  cuentaId: string
  fecha: string
  descripcion: string
  importe: number
  referencia?: string
  numeroCheque?: string
  categoria: CategoriaMovimiento
  cuentaContable?: string
  destinoXubio: DestinoXubio
  componente?: 'NETO' | 'IVA' | 'PERCEPCION_IVA' | 'PERCEPCION_IIBB'
  estado: EstadoMovimiento
  /** Otra cuenta propia (FCI, remunerada, transferencia entre cuentas). */
  contraparteCuentaId?: string
  pagoId?: string
  cobroId?: string
  chequeId?: string
  /** Comprobante "Extracto Bancario" donde quedó. */
  facturaId?: string
  /** Solo demo: a quién se le pagó o quién cobró (en la base sale del pago o del cobro). */
  contraparte?: string
  revisadoPor?: string
}

export type OrigenSaldo = 'EXTRACTO' | 'TENENCIA' | 'SIN_MOVIMIENTOS' | 'MANUAL'

export interface SaldoBancario {
  cuentaId: string
  fecha: string
  saldo: number
  origen: OrigenSaldo
}

export type EstadoConciliacion = 'OK' | 'DIFERENCIA' | 'SIN_EXTRACTO' | 'SIN_MOVIMIENTOS' | 'PRIMER_SALDO'

/** Una fila de la vista conciliacion_bancaria: banco vs calculado vs Xubio, por cuenta y día. */
export interface Conciliacion {
  empresaId: string
  unidadId?: string
  cuentaId: string
  cuenta: string
  clase: ClaseCuenta
  fecha: string
  fechaAnterior?: string
  saldoAnterior?: number
  creditos: number
  debitos: number
  movimientos: number
  saldoCalculado?: number
  saldoExtracto?: number
  origen?: OrigenSaldo
  diferencia?: number
  rendimiento?: number
  saldoXubio?: number
  diferenciaXubio?: number
  estado: EstadoConciliacion
}

/** Comprobante "Extracto Bancario" (09990-AAAAMMDD) o asiento del día, por cuenta y fecha. */
export interface DocumentoBancario {
  id: string
  tipo: 'COMPROBANTE' | 'ASIENTO'
  cuentaId: string
  fecha: string
  numero?: string
  total?: number
  estado: string
  estadoXubio?: string
}

export interface Extracto {
  id: string
  cuentaId: string
  archivo: string
  desde?: string
  hasta?: string
  movimientos: number
  nuevos: number
  importadoPor: string
  importadoEn: string
}

export type TipoCheque = 'FISICO' | 'ECHEQ' | 'PAGARE'
export type EstadoCheque = 'EMITIDO' | 'ENTREGADO' | 'DEBITADO' | 'ANULADO' | 'RECHAZADO'

export interface Cheque {
  id: string
  empresaId: string
  cuentaId: string
  tipo: TipoCheque
  numero: string
  acreedor?: string
  proveedorId?: string
  beneficiario: string
  importe: number
  fechaEmision: string
  fechaPago: string
  estado: EstadoCheque
  origen: 'PAGO' | 'FINANCIERA' | 'MANUAL'
  debitadoEn?: string
  marcadoPor?: string
  anuladoPor?: string
  motivoAnulacion?: string
  observaciones?: string
  /** Pagos del lote que cubre (cheques_pagos). */
  pagos: { pagoId: string; importe: number }[]
}

export type SeccionFlujo =
  | 'INGRESOS_OPERATIVOS'
  | 'COSTOS'
  | 'GASTOS_OPERATIVOS'
  | 'IMPUESTOS'
  | 'CAPEX'
  | 'INGRESOS_FINANCIEROS'
  | 'TOMA_DEUDA'
  | 'DEVOLUCION_DEUDA'
  | 'SOCIOS'
  | 'INTERCOMPANY'
  | 'ENTRE_CUENTAS'
  | 'SIN_CLASIFICAR'

export interface FilaFlujo {
  id: string
  unidadId: string
  orden: number
  tipo: 'SECCION' | 'CUENTA' | 'APERTURA' | 'INTERNO'
  seccion: SeccionFlujo
  etiqueta: string
  cuentaContable?: string
  padreId?: string
  mueveCaja: boolean
}

export type OrigenLinea = 'PAGO' | 'CHEQUE' | 'COBRO' | 'MOVIMIENTO' | 'RENDIMIENTO' | 'FACTURA' | 'PROYECCION'

/** Una línea de la vista flujo_lineas. Cada celda de la grilla es la suma de sus líneas. */
export interface LineaFlujo {
  empresaId: string
  unidadId: string
  filaId: string
  origenTipo: OrigenLinea
  origenId: string
  /** ANTICIPO · SALDO (facturas) · CHEQUE · fecha (proyecciones) · PAGO, MOVIMIENTO, CONTRAPARTE… (real). */
  ocurrencia: string
  naturaleza: 'REAL' | 'PROYECTADO'
  fecha: string
  fechaCalculada: string
  importe: number
  contraparte?: string
  concepto?: string
  vencido: boolean
  ajustada: boolean
  editable: boolean
}

/** Identifica una línea proyectada para moverla, editarla, eliminarla o restaurarla. */
export interface RefLinea {
  origenTipo: 'FACTURA' | 'CHEQUE' | 'PROYECCION'
  origenId: string
  ocurrencia: string
}

export type EstadoControlFlujo = 'OK' | 'F' | 'PRIMER_SALDO'

/** Vista flujo_control: el cambio en los bancos contra lo real del período, por unidad y día. */
export interface ControlFlujo {
  unidadId: string
  fecha: string
  fechaAnterior?: string
  saldoAnterior?: number
  saldoBancos: number
  realDelPeriodo: number
  diferencia: number
  estado: EstadoControlFlujo
}

export type Recurrencia = 'UNICA' | 'SEMANAL' | 'QUINCENAL' | 'MENSUAL'

export interface Proyeccion {
  id: string
  empresaId: string
  unidadId: string
  filaId: string
  concepto: string
  /** Con signo: negativo = egreso. */
  importe: number
  fechaInicio: string
  recurrencia: Recurrencia
  diaMes?: number
  hasta?: string
  cuotas?: number
  ajustePctMensual: number
  estado: 'ACTIVA' | 'PAUSADA' | 'CANCELADA'
  origen: 'MANUAL' | 'GASTO_FIJO' | 'PLAN_PAGO' | 'PRESTAMO' | 'SUELDOS' | 'COBRANZA'
  nota?: string
  creadoPor: string
}
