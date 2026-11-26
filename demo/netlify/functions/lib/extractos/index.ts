// Lectores de extractos bancarios: detectan el formato por el contenido del archivo y lo convierten a lo
// que espera importar_extracto (0024). Para sumar un banco: un módulo nuevo con su Lector, agregarlo a
// LECTORES y sacarlo de PENDIENTES, con su prueba en netlify/pruebas/extractos.prueba.mts.

import { abrirArchivo } from './abrir'
import { brubankXlsx } from './brubank-xlsx'
import { credicoopXls } from './credicoop-xls'
import { galiciaXlsx } from './galicia-xlsx'
import { hipotecarioCsv } from './hipotecario-csv'
import { hipotecarioFciPdf } from './hipotecario-fci-pdf'
import { macroFciXls } from './macro-fci-xls'
import { macroXls } from './macro-xls'
import { huellaArchivo } from './normalizar'
import { ErrorExtracto, type Banco, type Lector, type LecturaExtracto, type OpcionesLectura } from './tipos'

export { huellaArchivo, totales } from './normalizar'
export { ErrorExtracto } from './tipos'
export type { CuentaLeida, LecturaExtracto, MovimientoExtracto, ParteCuenta, SaldoExtracto } from './tipos'

/** Formatos probados con un ejemplo real del banco (estructura) y fixtures ficticios. */
export const LECTORES: Lector[] = [hipotecarioCsv, hipotecarioFciPdf, brubankXlsx, credicoopXls, galiciaXlsx, macroXls, macroFciXls]

/** Formatos del grupo que todavía no tienen lector porque no hay un archivo de ejemplo. No se inventan. */
export const PENDIENTES: { banco: Banco; formato: string; nota: string }[] = [
  { banco: 'ICBC', formato: 'CC (CSV "<fecha>_<cuenta>_movimientos.csv")', nota: '[FALTA ejemplo]' },
  { banco: 'ICBC', formato: 'Tenencia FCI Alpha (CSV)', nota: '[FALTA ejemplo]' },
  { banco: 'SANTANDER', formato: 'CC', nota: '[FALTA ejemplo]' },
  { banco: 'CHUBUT', formato: 'CC (CSV "BEE_Reporte_*.csv")', nota: '[FALTA ejemplo]' },
  { banco: 'MP', formato: 'Mercado Pago', nota: '[FALTA ejemplo] del grupo; el resumen PDF de MP viene cifrado: hace falta el Excel/CSV' },
  { banco: 'GALICIA', formato: 'Tenencia FCI', nota: '[FALTA ejemplo]' },
  { banco: 'BBVA', formato: 'Tenencia FCI', nota: '[FALTA ejemplo]' },
  { banco: 'HIPOTECARIO', formato: 'Informe FCI en CSV', nota: '[FALTA ejemplo] (el PDF sí se lee)' },
]

export interface Leido extends LecturaExtracto {
  hash: string
  tipoArchivo: string
}

/** Lee el archivo de un banco. Si no reconoce el formato, dice cuáles conoce y cuáles faltan. */
export function leerExtracto(nombre: string, bytes: Uint8Array, opciones: OpcionesLectura = {}): Leido {
  const a = abrirArchivo(nombre, bytes)
  const candidatos = LECTORES.filter((l) => l.tipos.includes(a.tipo)).filter((l) => {
    try {
      return l.reconoce(a)
    } catch (e) {
      if (e instanceof ErrorExtracto) throw e // el archivo está dañado: mejor decir por qué
      return false
    }
  })
  if (!candidatos.length) {
    const conocidos = LECTORES.map((l) => l.formato).join(', ')
    const faltan = PENDIENTES.map((p) => `${p.banco} ${p.formato}`).join('; ')
    throw new ErrorExtracto(`No se reconoce el formato del archivo (${a.tipo}). Se leen: ${conocidos}. Sin lector todavía: ${faltan}`)
  }
  if (candidatos.length > 1) throw new ErrorExtracto(`El archivo coincide con más de un formato (${candidatos.map((l) => l.formato).join(', ')})`)
  const l = candidatos[0]
  const { cuentas, avisos } = l.leer(a, opciones)
  return { formato: l.formato, banco: l.banco, tenencia: l.tenencia, cuentas, avisos, hash: huellaArchivo(bytes), tipoArchivo: a.tipo }
}
