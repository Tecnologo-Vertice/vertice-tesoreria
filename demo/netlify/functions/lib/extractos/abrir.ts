// Abre el archivo según su contenido (no según la extensión: hay bancos que bajan un .xls que en
// realidad es otra cosa) y ofrece sus vistas (filas de la primera hoja, texto) a los lectores.

import { decodificar, leerCsv } from './csv'
import { textoPdf } from './pdf'
import { ErrorExtracto, type ArchivoAbierto, type FilaPlanilla, type TipoArchivo } from './tipos'
import { esCfb, leerXls } from './xls'
import { leerXlsx } from './xlsx'

export function tipoDeArchivo(b: Uint8Array): TipoArchivo {
  if (b.length < 4) throw new ErrorExtracto('El archivo está vacío')
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'XLSX'
  if (esCfb(b)) return 'XLS'
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'PDF'
  // Texto: no debería tener bytes de control raros (salvo tabulador y saltos de línea).
  const muestra = b.subarray(0, 4096)
  const raros = muestra.filter((x) => x < 0x09 || (x > 0x0d && x < 0x20)).length
  if (raros > muestra.length * 0.01) throw new ErrorExtracto('No se reconoce el tipo de archivo (no es CSV, Excel ni PDF)')
  const inicio = new TextDecoder('latin1').decode(b.subarray(0, 512)).trimStart().toLowerCase()
  if (inicio.startsWith('<html') || inicio.startsWith('<!doctype html') || inicio.startsWith('<table')) {
    throw new ErrorExtracto('El archivo es una página web guardada como Excel: abrilo y guardalo como .xlsx, o bajá el CSV')
  }
  return 'CSV'
}

export function abrirArchivo(nombre: string, bytes: Uint8Array): ArchivoAbierto {
  const tipo = tipoDeArchivo(bytes)
  let filas: FilaPlanilla[] | null = null
  let texto: string | null = null
  return {
    nombre,
    bytes,
    tipo,
    filas() {
      if (filas) return filas
      if (tipo === 'XLSX') filas = leerXlsx(bytes)[0].filas
      else if (tipo === 'XLS') filas = leerXls(bytes)[0]?.filas ?? []
      else if (tipo === 'CSV') filas = leerCsv(this.texto())
      else filas = []
      return filas
    },
    texto() {
      if (texto != null) return texto
      if (tipo === 'CSV') texto = decodificar(bytes)
      else if (tipo === 'PDF') texto = textoPdf(bytes).join('\n')
      else texto = this.filas().map((f) => f.map((c) => (c == null ? '' : String(c))).join('\t')).join('\n')
      return texto
    },
  }
}
