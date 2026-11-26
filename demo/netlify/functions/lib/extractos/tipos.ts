// Tipos comunes de los lectores de extractos bancarios.
// Cada lector recibe el archivo tal como lo baja Tesorería del banco y devuelve lo que espera la función
// importar_extracto(p jsonb) de la base (0024): movimientos con importe con signo y saldos de cierre.

/** Una celda de planilla ya leída (CSV, XLSX o XLS). Las fechas de Excel llegan como Date. */
export type Celda = string | number | Date | boolean | null
export type FilaPlanilla = Celda[]

/** Un movimiento como lo espera importar_extracto. Importe negativo = débito. */
export interface MovimientoExtracto {
  fecha: string // aaaa-mm-dd
  descripcion: string
  referencia: string | null
  importe: number
  saldo: number | null
  numero_cheque: string | null
}

/** Saldo de cierre de un día (lo informa el archivo: tenencias de FCI, informes con saldo final). */
export interface SaldoExtracto {
  fecha: string // aaaa-mm-dd
  saldo: number
}

/**
 * Qué parte del archivo es. Casi todos los bancos traen una sola cuenta por archivo (UNICA).
 * Brubank trae la cuenta corriente y la remunerada en el MISMO Excel: se separan en CC y REMUNERADA.
 */
export type ParteCuenta = 'UNICA' | 'CC' | 'REMUNERADA'

export interface CuentaLeida {
  parte: ParteCuenta
  movimientos: MovimientoExtracto[]
  saldos: SaldoExtracto[]
}

/** Como figura el banco en cuentas_origen.banco (0023). */
export type Banco = 'HIPOTECARIO' | 'BRUBANK' | 'MP' | 'ICBC' | 'SANTANDER' | 'CREDICOOP' | 'CHUBUT' | 'MACRO' | 'GALICIA' | 'BBVA'

export interface LecturaExtracto {
  /** Nombre del formato, se guarda en extractos.formato (HIPOTECARIO_CSV, BRUBANK_XLSX…). */
  formato: string
  banco: Banco
  /** Informe de tenencia de un FCI: trae saldos y ningún movimiento. */
  tenencia: boolean
  cuentas: CuentaLeida[]
  /** Cosas que Tesorería tiene que saber (no frenan la importación). */
  avisos: string[]
}

export type TipoArchivo = 'CSV' | 'XLSX' | 'XLS' | 'PDF'

/** El archivo ya abierto: cada vista se calcula una sola vez y solo si un lector la pide. */
export interface ArchivoAbierto {
  nombre: string
  bytes: Uint8Array
  tipo: TipoArchivo
  /** Primera hoja (XLSX/XLS) o filas del CSV. */
  filas(): FilaPlanilla[]
  /** Texto del archivo (CSV) o líneas del PDF unidas con saltos de línea. */
  texto(): string
}

export interface OpcionesLectura {
  /** Fecha del saldo de una tenencia cuando el archivo no la dice con certeza (aaaa-mm-dd). */
  fechaTenencia?: string
}

/** Un formato de un banco: lo reconoce por el contenido (encabezados) y lo lee. */
export interface Lector {
  formato: string
  banco: Banco
  tenencia: boolean
  tipos: TipoArchivo[]
  reconoce(a: ArchivoAbierto): boolean
  leer(a: ArchivoAbierto, o: OpcionesLectura): { cuentas: CuentaLeida[]; avisos: string[] }
}

/** Error de lectura: el archivo no es lo que se esperaba. La función lo devuelve como 422. */
export class ErrorExtracto extends Error {}
