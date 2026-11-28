// Contrato entre las pantallas y los datos. Hay dos implementaciones:
//  - fuenteDemo: todo en memoria y localStorage, con datos ficticios (modo "demo").
//  - fuenteSupabase: base PostgreSQL en Supabase + funciones en Netlify (modo "conectado").
// Las pantallas no saben cuál está activa.

import type {
  Auditoria,
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
  TipoCheque,
  TipoPagoFactura,
  Unidad,
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
  /**
   * Segundos que tienen que pasar desde que un pago se reservó para enviar a Xubio hasta que se puede dar el
   * envío por cortado y resolverlo a mano. Lo define la base (plazo_envio_xubio, migración 0016). Sin dato, la
   * pantalla no ofrece resolverlo.
   */
  plazoEnvioXubioSeg?: number
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

/** fechaPago: obligatoria al aprobar desde Pendiente de aprobación, salvo cheque y notas de crédito (0041). No puede ser anterior a hoy. */
export type DatosAprobacion = { cuentaContable: string; metodoPago: MetodoPago; diasCheque?: number; fechaPago?: string }
/** Una ocurrencia de proyección de egreso que un pago puede cubrir (proyecciones_para_pago, 0041): de hoy a 30 días. */
export interface ProyeccionParaPago { proyeccionId: string; ocurrencia: string; fecha: string; importe: number; concepto: string; proveedor?: string; fila: string; recurrencia: string }
/** Cómo quedó una factura al aprobarla: pagada sola (tarjeta), sin subir a Xubio, o vinculada a un pago sin factura. */
export interface ResultadoAprobacion {
  estado?: string
  estadoXubio?: string
  tarjeta?: boolean
  vinculado?: boolean
  mensaje?: string
}
/** Resultado de vincular un pago sin factura a una factura. */
export interface ResultadoVinculo {
  numero: string
  monto: number
  /** Lo que el pago supera el saldo de la factura (0 si no sobra). */
  sobra: number
  completa: boolean
  yaEnXubio: boolean
}
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
/** Con qué cuenta y forma queda un pago trabado cuando se confirma que ya estaba en Xubio. */
export type DatosLiberacion = { cuentaContable?: string; formaCargaXubio?: Pago['formaCargaXubio'] }
export type ResultadoLiberacion = 'CONTABILIZADO' | 'LIBERADO'
export type NuevoPago = Omit<Pago, 'id' | 'estado' | 'cargadoPor' | 'cargadoEn'>
export type ResultadoXubio = { ok: true; id: string; enSeco: boolean; detalle?: string } | { ok: false; error: string }

// ---------------------------------------------------------------- Tesorería sin planillas

/** Bancos, cheques y Flujo. Conectado sale de las tablas y vistas de las migraciones 0023 a 0027. */
export interface DatosTesoreria {
  /** False si la base todavía no tiene las migraciones 0023 a 0027 (las pantallas lo avisan). */
  disponible: boolean
  error?: string
  /** Hoy según la base (hoy_ar). En demo, hoy del navegador. */
  hoy: string
  unidades: Unidad[]
  cuentas: CuentaBancaria[]
  feriados: string[]
  movimientos: MovimientoBancario[]
  saldos: SaldoBancario[]
  conciliacion: Conciliacion[]
  documentos: DocumentoBancario[]
  extractos: Extracto[]
  cheques: Cheque[]
  /** Débitos de cheque sin número con un único cheque emitido por el mismo importe (±$1): "puede ser el cheque X". Vacío si la base no tiene 0036. */
  chequesSugeridos: { movimientoId: string; chequeId: string; numero: string; importe: number }[]
  /** Fondos con tenencia y sin movimientos de su banco ese día (0040). Vacío si la base no tiene 0040. */
  avisosFci: AvisoFci[]
  /** Saldos de los últimos días hábiles con el arrastre de los días sin movimientos (0040). Vacío si la base no tiene 0040. */
  saldosArrastrados: SaldoArrastrado[]
  /** Lo bancario que falta en Xubio (comprobantes, asientos, anulaciones). Vacío si la base no tiene 0029. */
  pendientesXubio: PendienteXubio[]
  filas: FilaFlujo[]
  lineas: LineaFlujo[]
  control: ControlFlujo[]
  proyecciones: Proyeccion[]
  /** Fotos mensuales de la proyección (0038). Vacío si la base no tiene 0038. */
  fotos: FotoFlujo[]
  /** Cuentas contables para reclasificar (plan común + las usadas en el Flujo). */
  cuentasContables: string[]
}

/** Lo que entró en cada cuenta del archivo (Brubank reparte en la CC y la remunerada). */
export interface CuentaImportada {
  cuentaId: string
  cuenta: string
  /** UNICA, o CC / REMUNERADA en Brubank. */
  parte: string
  repetido: boolean
  movimientos: number
  nuevos: number
  aRevisar: number
  /** EXTRACTO, o TENENCIA en el informe de un FCI (0029). */
  origenSaldos: 'EXTRACTO' | 'TENENCIA'
  hasta?: string
  saldoFinal?: number
}

/** Respuesta de POST /api/bancos/extracto (importar_extracto). La lee resultadoExtracto.ts. */
export interface ResultadoExtracto {
  /** El archivo ya estaba importado en todas sus cuentas. */
  repetido: boolean
  movimientos?: number
  nuevos: number
  /** Formato que reconoció el lector (HIPOTECARIO_CSV, BRUBANK_XLSX…), si lo informa. */
  formato?: string
  banco?: string
  /** Informe de tenencia de un FCI: trae saldos, no movimientos. */
  tenencia?: boolean
  /** Movimientos que entraron sin regla: quedan en "A revisar". */
  aRevisar?: number
  detalle?: string
  avisos?: string[]
  cuentas?: CuentaImportada[]
  /** El extracto parece ya cargado en otra empresa (aviso del servidor): no se importó nada; la pantalla ofrece "Subir igual". */
  otraEmpresa?: string
}

/** Lo que la pantalla puede indicar al subir un extracto (el servidor lo necesita a veces). */
export interface OpcionesExtracto {
  /** Fecha del saldo de una tenencia cuando el informe no la dice (aaaa-mm-dd). */
  fechaTenencia?: string
  /** Brubank: cuál es la remunerada, si la CC tiene más de una. */
  cuentaRemuneradaId?: string
  /** "Subir igual": confirma que es esta cuenta aunque el extracto parezca ya cargado en otra empresa. */
  confirmarOtraEmpresa?: boolean
}

/** Un pendiente bancario con Xubio (vista xubio_bancos_pendientes, 0029). */
export interface PendienteXubio {
  empresaId: string
  tipo: 'COMPROBANTE' | 'ASIENTO' | 'ANULAR_ASIENTO' | 'ANULAR_PAGO' | 'ANULAR_CHEQUE'
  id: string
  fecha: string
  descripcion: string
  importe?: number
  estado: 'FALTA_APROBAR' | 'PENDIENTE' | 'EN_CURSO' | 'ERROR'
  error?: string
  xubioId?: string
  /** El robot no lo puede hacer: anularlo en Xubio y marcarlo acá. */
  aMano: boolean
  cuentaId?: string
  ultimoIntentoEn?: string
  ultimoIntentoEstado?: string
  ultimoIntentoModo?: 'PRUEBA' | 'REAL'
  ultimoIntentoDetalle?: string
}

/** Respuesta de POST /api/xubio/bancos (corrida manual de los envíos bancarios). */
export interface ResultadoCorridaBancos {
  real: boolean
  /** El servidor tiene XUBIO_BANCOS_ENVIO_REAL=true (si no, toda corrida es en seco). */
  envioRealHabilitado: boolean
  omitido?: string
  items: { entidad: string; id: string; estado: 'OK' | 'PRUEBA_OK' | 'ERROR' | 'OMITIDO'; detalle: string }[]
}

export interface NuevoCheque {
  empresaId: string
  cuentaId: string
  tipo: TipoCheque
  numero: string
  beneficiario: string
  proveedorId?: string
  importe: number
  fechaEmision: string
  fechaPago: string
  origen: 'PAGO' | 'FINANCIERA' | 'MANUAL'
  observaciones?: string
  pagos: { pagoId: string; importe: number }[]
}

export interface CambioLinea {
  fecha?: string
  /** En positivo: el signo lo pone la línea. */
  importe?: number
  eliminar?: boolean
}

export type NuevaProyeccion = Omit<Proyeccion, 'id' | 'estado' | 'creadoPor'>

export type AlcanceProyeccion = 'SOLO_ESTA' | 'DESDE_ESTA'

export interface Fuente {
  modo: 'demo' | 'conectado'
  cargar(): Promise<Datos>
  /** Aprueba y, si hay un único pago sin factura de ese proveedor, lo vincula. Dice cómo quedó. */
  aprobarFactura(id: string, datos: DatosAprobacion, u: Usuario): Promise<ResultadoAprobacion>
  /** Vincula un pago sin factura a una factura aprobada del mismo proveedor: la factura baja por lo pagado. */
  vincularPagoSinFactura(pagoId: string, facturaId: string, u: Usuario): Promise<ResultadoVinculo>
  /** Corrige el proveedor de un pago sin factura que todavía no está en Xubio. */
  corregirProveedorPago(pagoId: string, proveedorId: string, u: Usuario): Promise<void>
  /** Adjunta (o reemplaza) el comprobante ya subido de un pago. La cuenta de origen completa a un pago ya pagado que no tenía banco. */
  adjuntarComprobantePago(pagoId: string, ruta: string, cuentaOrigen: string | undefined, u: Usuario): Promise<void>
  quitarComprobantePago(pagoId: string, u: Usuario): Promise<void>
  /** Carga a mano el N° de OP o de asiento de un pago ya contabilizado en Xubio (0037). Cambiar uno que ya está pide confirmar. */
  guardarNumeroOp(pagoId: string, numero: string, u: Usuario, confirmar?: boolean): Promise<void>
  rechazarFactura(id: string, motivo: string, u: Usuario): Promise<void>
  aprobarYaPagada(id: string, datos: DatosAprobacion, pago: DatosYaPagada, u: Usuario): Promise<ResultadoYaPagada>
  /** Aplica una nota de crédito aprobada a una factura del mismo proveedor y empresa. */
  aplicarNotaCredito(ncId: string, facturaId: string, importe: number, u: Usuario): Promise<void>
  /** Anula un pago que todavía no está en Xubio ni en Ralpharma y devuelve lo aplicado a sus facturas. */
  anularPago(id: string, motivo: string, u: Usuario): Promise<void>
  /**
   * Resuelve un pago cuyo envío a Xubio quedó sin confirmar. Con el número de Xubio: ya estaba cargado y
   * queda contabilizado sin enviar nada. Sin número: no estaba, se libera para volver a enviar o anular.
   */
  liberarPagoXubio(id: string, xubioId: string, datos: DatosLiberacion, u: Usuario): Promise<ResultadoLiberacion>
  /** Mails a proveedores: guarda el mail escrito a mano y deja registrado que se preparó en Gmail. */
  guardarEmailProveedor(proveedorId: string, email: string, u: Usuario): Promise<void>
  marcarMailPreparado(facturaIds: string[], u: Usuario): Promise<void>
  /** Link de cada comprobante para el texto del mail (Drive, o enlace firmado por 30 días). Vacío en demo. */
  linksComprobantes(pagos: Pago[]): Promise<Record<string, string | null>>
  /** Trae de Xubio el plan de cuentas y las cuentas de origen. Devuelve una línea por empresa. */
  catalogosXubio(): Promise<string[]>
  corregirFactura(id: string, u: Usuario): Promise<void>
  editarFactura(id: string, datos: DatosEdicion, u: Usuario): Promise<ResultadoEdicion>
  registrarPago(datos: NuevoPago, u: Usuario): Promise<Pago>
  /** Proyecciones de egreso de la empresa (hoy a 30 días) para asociarles un pago manual o sin factura. */
  proyeccionesParaPago(empresaId: string): Promise<ProyeccionParaPago[]>
  contabilizarPago(id: string, datos: DatosContabilizacion, u: Usuario): Promise<ResultadoXubio>
  marcarRalpharma(id: string, u: Usuario): Promise<void>
  /** En demo recibe un comprobante de ejemplo; conectado, un File real que va a la IA. */
  leerComprobante(archivo: File | ComprobanteEjemplo): Promise<LecturaComprobante>
  comprobantesEjemplo(facturas: Factura[]): ComprobanteEjemplo[]
  /** Guarda el archivo en la carpeta de la empresa del pago y devuelve la ruta con la que se registra. */
  subirComprobante(archivo: File, empresaId: string): Promise<string>
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

  // Tesorería (0023 a 0027). Toda escritura pasa por las funciones de la base.
  cargarTesoreria(facturas: Factura[]): Promise<DatosTesoreria>
  /** Sube el archivo del banco a POST /api/bancos/extracto (el lector por banco lo arma el servidor). */
  subirExtracto(archivo: File, cuentaId: string, u: Usuario, opciones?: OpcionesExtracto): Promise<ResultadoExtracto>
  /** Deshace un extracto importado en la cuenta equivocada (solo si nada de lo que trajo está conciliado ni en un asiento). */
  borrarExtracto(id: string, u: Usuario): Promise<void>
  reclasificarMovimiento(id: string, categoria: CategoriaMovimiento, cuenta: string | null, aprenderPatron: string | null, u: Usuario): Promise<void>
  /** La otra cuenta propia de una suscripción, un rescate o una transferencia entre cuentas (null la quita). */
  asignarContraparte(movimientoId: string, cuentaId: string | null, u: Usuario): Promise<void>
  /** Repite el saldo anterior. Devuelve el saldo que quedó. */
  marcarSinMovimientos(cuentaId: string, fecha: string, confirmoSinRendimiento: boolean, u: Usuario): Promise<number>
  registrarSaldo(cuentaId: string, fecha: string, saldo: number, origen: Extract<OrigenSaldo, 'TENENCIA' | 'MANUAL'>, u: Usuario): Promise<void>
  /** Devuelve el id del comprobante, o null si ese día no hubo nada facturable. */
  generarComprobanteGastos(cuentaId: string, fecha: string, u: Usuario): Promise<string | null>
  /** Devuelve el id del asiento, o null si ese día no hubo nada para el asiento. */
  generarAsientoBancario(cuentaId: string, fecha: string, u: Usuario): Promise<string | null>
  emitirCheque(c: NuevoCheque, u: Usuario): Promise<string>
  marcarChequeDebitado(id: string, numero: string, fecha: string, u: Usuario): Promise<void>
  anularCheque(id: string, motivo: string, u: Usuario): Promise<void>
  /** Xubio no deja anular por API (órdenes de pago, cheques): Administración lo anuló a mano y lo marca (0029). */
  marcarAnulacionXubioManual(tipo: 'PAGO' | 'CHEQUE' | 'ASIENTO', id: string, nota: string, u: Usuario): Promise<void>
  /** Corrida manual de los envíos bancarios a Xubio (POST /api/xubio/bancos). En demo, simulada. */
  correrEnviosBancos(enSeco: boolean, u: Usuario): Promise<ResultadoCorridaBancos>
  ajustarLineaFlujo(ref: RefLinea, cambio: CambioLinea, motivo: string, u: Usuario): Promise<void>
  restaurarLineaFlujo(ref: RefLinea, u: Usuario): Promise<void>
  crearProyeccion(p: NuevaProyeccion, u: Usuario): Promise<string>
  /** Cambia o borra una ocurrencia: solo esa o esa y las siguientes (0038). Con "esta y las siguientes" devuelve la serie nueva. */
  cambiarProyeccion(id: string, ocurrencia: string, alcance: AlcanceProyeccion, accion: 'EDITAR' | 'BORRAR', cambio: { importe?: number; fecha?: string }, motivo: string, u: Usuario): Promise<string | null>
  /** Marca una fila del Flujo como MANUAL (se carga a mano, sin recurrencia) o como la de las personas físicas de su unidad (0038). */
  marcarFilaFlujo(filaId: string, manual: boolean, personaFisica: boolean, u: Usuario): Promise<void>
  /** Saca la foto del mes de las unidades que ve la persona. Dice qué pasó en cada una. */
  sacarFotoFlujo(forzar: boolean, u: Usuario): Promise<{ unidad: string; resultado: string }[]>
  cancelarProyeccion(id: string, motivo: string, u: Usuario): Promise<void>
  definirPagoFactura(id: string, tipoPago: TipoPagoFactura, anticipoPct: number | null, unidadId: string | null, u: Usuario): Promise<void>
}
