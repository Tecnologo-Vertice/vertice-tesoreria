// Lector mínimo de XLSX (Excel 2007+), sin dependencias: un XLSX es un ZIP con XML adentro.
// Lee la primera hoja (o todas) como filas de celdas: texto, número, fecha (Date en UTC) o booleano.
// Alcanza para los extractos de los bancos (Brubank, Galicia); no lee fórmulas sin valor ni gráficos.

import { inflateRawSync } from 'node:zlib'
import { ErrorExtracto, type Celda, type FilaPlanilla } from './tipos'

// ---------------------------------------------------------------- ZIP

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

/** Archivos del ZIP por nombre (sin descomprimir hasta que se piden). Solo métodos 0 (guardado) y 8 (deflate). */
export function leerZip(b: Uint8Array): Map<string, () => Uint8Array> {
  // Fin del directorio central: firma 0x06054b50, a lo sumo 64 KB antes del final (comentario).
  let fin = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (u32(b, i) === 0x06054b50) {
      fin = i
      break
    }
  }
  if (fin < 0) throw new ErrorExtracto('El archivo no es un Excel (.xlsx) válido: no se encontró el índice del ZIP')
  const cantidad = u16(b, fin + 10)
  let p = u32(b, fin + 16)
  const archivos = new Map<string, () => Uint8Array>()
  const nombres = new TextDecoder('utf-8')
  for (let k = 0; k < cantidad; k++) {
    if (u32(b, p) !== 0x02014b50) throw new ErrorExtracto('El índice del ZIP está dañado')
    const metodo = u16(b, p + 10)
    const comprimido = u32(b, p + 20)
    const largoNombre = u16(b, p + 28)
    const largoExtra = u16(b, p + 30)
    const largoComentario = u16(b, p + 32)
    const local = u32(b, p + 42)
    const nombre = nombres.decode(b.subarray(p + 46, p + 46 + largoNombre))
    p += 46 + largoNombre + largoExtra + largoComentario
    archivos.set(nombre, () => {
      if (u32(b, local) !== 0x04034b50) throw new ErrorExtracto(`ZIP dañado en ${nombre}`)
      const inicio = local + 30 + u16(b, local + 26) + u16(b, local + 28)
      const datos = b.subarray(inicio, inicio + comprimido)
      if (metodo === 0) return datos
      if (metodo === 8) return new Uint8Array(inflateRawSync(datos))
      throw new ErrorExtracto(`El Excel usa una compresión que no se soporta (método ${metodo})`)
    })
  }
  return archivos
}

// ---------------------------------------------------------------- XML

function desescapar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_t, e: string) => {
    const x = e.toLowerCase()
    if (x === 'amp') return '&'
    if (x === 'lt') return '<'
    if (x === 'gt') return '>'
    if (x === 'quot') return '"'
    if (x === 'apos') return "'"
    return String.fromCodePoint(x.startsWith('#x') ? parseInt(x.slice(2), 16) : parseInt(x.slice(1), 10))
  })
}

const atributo = (etiqueta: string, nombre: string) => {
  const m = new RegExp(`\\s${nombre}="([^"]*)"`).exec(etiqueta)
  return m ? desescapar(m[1]) : null
}

/** Texto de todos los <t> de un fragmento (texto enriquecido = varias corridas <r><t>). */
const textoT = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1])).join('')

/** "AB12" → 27 (columna base 0). */
function columna(ref: string): number {
  let n = 0
  for (const c of ref.replace(/\d+$/, '')) n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

// ---------------------------------------------------------------- Formatos de fecha

const FORMATOS_FECHA_FIJOS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
/** ¿El formato de número es una fecha? (d, m, y fuera de comillas y corchetes, y no es un número con "0"). */
export function esFormatoFecha(codigo: string): boolean {
  const limpio = codigo.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[dmy]/i.test(limpio) && !/[0#]/.test(limpio.replace(/[dmyhs:/\-. ]/gi, ''))
}

function estilosFecha(xml: string | null): Set<number> {
  const fecha = new Set<number>()
  if (!xml) return fecha
  const propios = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = atributo(m[0], 'numFmtId')
    const codigo = atributo(m[0], 'formatCode')
    if (id != null && codigo != null) propios.set(Number(id), codigo)
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  let i = 0
  for (const m of xfs.matchAll(/<xf\s[^>]*?\/?>/g)) {
    const id = Number(atributo(m[0], 'numFmtId') ?? 0)
    if (FORMATOS_FECHA_FIJOS.has(id) || (propios.has(id) && esFormatoFecha(propios.get(id)!))) fecha.add(i)
    i++
  }
  return fecha
}

const serialAFecha = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86_400_000))

// ---------------------------------------------------------------- Hojas

export interface Hoja {
  nombre: string
  filas: FilaPlanilla[]
}

/** Lee las hojas del libro, en el orden del libro. */
export function leerXlsx(bytes: Uint8Array): Hoja[] {
  const zip = leerZip(bytes)
  const utf8 = new TextDecoder('utf-8')
  const leer = (nombre: string) => {
    const f = zip.get(nombre)
    return f ? utf8.decode(f()) : null
  }
  const libro = leer('xl/workbook.xml')
  if (!libro) throw new ErrorExtracto('El archivo no es un Excel (.xlsx): falta el libro')
  const rels = leer('xl/_rels/workbook.xml.rels') ?? ''
  const destino = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = atributo(m[0], 'Id')
    const t = atributo(m[0], 'Target')
    if (id && t) destino.set(id, t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, ''))
  }
  const compartidos = [...(leer('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoT(m[1]))
  const fechas = estilosFecha(leer('xl/styles.xml'))

  const hojas: Hoja[] = []
  let n = 0
  for (const m of libro.matchAll(/<sheet\s[^>]*>/g)) {
    n++
    const rid = atributo(m[0], 'r:id')
    const ruta = (rid && destino.get(rid)) || `xl/worksheets/sheet${n}.xml`
    const xml = leer(ruta)
    if (xml == null) continue
    hojas.push({ nombre: atributo(m[0], 'name') ?? `Hoja ${n}`, filas: leerHoja(xml, compartidos, fechas) })
  }
  if (!hojas.length) throw new ErrorExtracto('El Excel no tiene hojas')
  return hojas
}

function leerHoja(xml: string, compartidos: string[], fechas: Set<number>): FilaPlanilla[] {
  const filas: FilaPlanilla[] = []
  let siguienteFila = 0
  for (const mf of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = atributo(mf[0].slice(0, mf[0].indexOf('>') + 1), 'r')
    const nroFila = r ? Number(r) - 1 : siguienteFila
    siguienteFila = nroFila + 1
    const fila: Celda[] = []
    let siguienteCol = 0
    for (const mc of (mf[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const etiqueta = `<c${mc[1]}>`
      const ref = atributo(etiqueta, 'r')
      const col = ref ? columna(ref) : siguienteCol
      siguienteCol = col + 1
      const t = atributo(etiqueta, 't') ?? 'n'
      const s = Number(atributo(etiqueta, 's') ?? 0)
      const cuerpo = mc[2] ?? ''
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)
      const v = vMatch ? desescapar(vMatch[1]) : null
      let valor: Celda = null
      if (t === 's') valor = v == null ? null : (compartidos[Number(v)] ?? null)
      else if (t === 'inlineStr') valor = textoT(cuerpo)
      else if (t === 'str') valor = v ?? ''
      else if (t === 'b') valor = v === '1'
      else if (t === 'd') valor = v ? new Date(v.length === 10 ? v + 'T00:00:00Z' : v) : null
      else if (t === 'e') valor = null
      else if (v != null && v !== '') valor = fechas.has(s) ? serialAFecha(Number(v)) : Number(v)
      fila[col] = valor
    }
    for (let i = 0; i < fila.length; i++) if (fila[i] === undefined) fila[i] = null
    filas[nroFila] = fila
  }
  for (let i = 0; i < filas.length; i++) if (!filas[i]) filas[i] = []
  return filas
}
