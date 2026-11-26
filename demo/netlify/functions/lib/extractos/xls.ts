// Lector mínimo de XLS (Excel 97-2003, BIFF8), sin dependencias. Varios bancos (Credicoop, Macro) bajan
// los movimientos en este formato viejo: un "archivo compuesto" (CFB) con un flujo "Workbook" adentro.
// Lee las celdas de texto, número, RK, fórmulas con resultado y fechas (por el formato de la celda).

import { esFormatoFecha } from './xlsx'
import { ErrorExtracto, type Celda, type FilaPlanilla } from './tipos'

const FIRMA_CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
export const esCfb = (b: Uint8Array) => FIRMA_CFB.every((x, i) => b[i] === x)

// ---------------------------------------------------------------- Archivo compuesto (CFB)

const FIN_CADENA = 0xfffffffe
const LIBRE = 0xffffffff

/** Devuelve el contenido de un flujo del archivo compuesto por nombre (sin distinguir mayúsculas). */
export function flujoCfb(b: Uint8Array, nombres: string[]): Uint8Array | null {
  if (!esCfb(b)) throw new ErrorExtracto('El archivo no es un Excel 97-2003 (.xls) válido')
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const tamSector = 1 << dv.getUint16(30, true)
  const tamMini = 1 << dv.getUint16(32, true)
  const sectoresFat = dv.getUint32(44, true)
  const primerDir = dv.getUint32(48, true)
  const corte = dv.getUint32(56, true)
  const primerMiniFat = dv.getUint32(60, true)
  let sigDifat = dv.getUint32(68, true)
  const sector = (n: number) => {
    const o = (n + 1) * tamSector
    if (o >= b.length) throw new ErrorExtracto('El .xls está cortado')
    return b.subarray(o, Math.min(o + tamSector, b.length))
  }

  // Sectores de la FAT: los primeros 109 están en el encabezado; el resto, en la cadena DIFAT.
  const listaFat: number[] = []
  for (let i = 0; i < 109 && listaFat.length < sectoresFat; i++) listaFat.push(dv.getUint32(76 + i * 4, true))
  let vueltas = 0
  while (listaFat.length < sectoresFat && sigDifat !== FIN_CADENA && sigDifat !== LIBRE) {
    if (++vueltas > 10_000) throw new ErrorExtracto('El .xls está dañado (DIFAT)')
    const s = sector(sigDifat)
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength)
    const porSector = tamSector / 4 - 1
    for (let i = 0; i < porSector && listaFat.length < sectoresFat; i++) listaFat.push(sv.getUint32(i * 4, true))
    sigDifat = sv.getUint32(porSector * 4, true)
  }
  const fat: number[] = []
  for (const n of listaFat) {
    const s = sector(n)
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength)
    for (let i = 0; i + 4 <= s.length; i += 4) fat.push(sv.getUint32(i, true))
  }
  const cadena = (inicio: number, tabla: number[]) => {
    const lista: number[] = []
    for (let n = inicio; n !== FIN_CADENA && n !== LIBRE; n = tabla[n]) {
      if (n >= tabla.length || lista.length > tabla.length) throw new ErrorExtracto('El .xls está dañado (cadena de sectores)')
      lista.push(n)
    }
    return lista
  }
  const leerCadena = (inicio: number) => {
    const partes = cadena(inicio, fat).map(sector)
    const salida = new Uint8Array(partes.reduce((a, p) => a + p.length, 0))
    let o = 0
    for (const p of partes) {
      salida.set(p, o)
      o += p.length
    }
    return salida
  }

  // Directorio: entradas de 128 bytes. La primera es la raíz, dueña del "mini flujo".
  const dir = leerCadena(primerDir)
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  const entradas: { nombre: string; tipo: number; inicio: number; tam: number }[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const largo = ddv.getUint16(o + 64, true)
    let nombre = ''
    for (let i = 0; i + 2 < largo; i += 2) nombre += String.fromCharCode(ddv.getUint16(o + i, true))
    entradas.push({ nombre, tipo: dir[o + 66], inicio: ddv.getUint32(o + 116, true), tam: ddv.getUint32(o + 120, true) })
  }
  const raiz = entradas.find((e) => e.tipo === 5)
  const buscado = entradas.find((e) => e.tipo === 2 && nombres.some((n) => n.toLowerCase() === e.nombre.toLowerCase()))
  if (!buscado) return null
  if (buscado.tam >= corte) return leerCadena(buscado.inicio).subarray(0, buscado.tam)

  // Flujo chico: vive en el mini flujo (sectores de 64 bytes dentro del flujo de la raíz).
  if (!raiz) throw new ErrorExtracto('El .xls está dañado (sin raíz)')
  const mini = leerCadena(raiz.inicio)
  const miniFatBytes = primerMiniFat === FIN_CADENA ? new Uint8Array(0) : leerCadena(primerMiniFat)
  const mdv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength)
  const miniFat: number[] = []
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mdv.getUint32(i, true))
  const salida = new Uint8Array(buscado.tam)
  let o = 0
  for (const n of cadena(buscado.inicio, miniFat)) {
    const trozo = mini.subarray(n * tamMini, n * tamMini + tamMini)
    salida.set(trozo.subarray(0, Math.min(trozo.length, buscado.tam - o)), o)
    o += trozo.length
    if (o >= buscado.tam) break
  }
  return salida
}

// ---------------------------------------------------------------- BIFF8

interface Registro {
  tipo: number
  datos: Uint8Array
  pos: number
}

function registros(w: Uint8Array, desde: number): Registro[] {
  const lista: Registro[] = []
  let p = desde
  while (p + 4 <= w.length) {
    const tipo = w[p] | (w[p + 1] << 8)
    const largo = w[p + 2] | (w[p + 3] << 8)
    lista.push({ tipo, datos: w.subarray(p + 4, p + 4 + largo), pos: p })
    p += 4 + largo
    if (tipo === 0x000a) break // EOF de esta sección
  }
  return lista
}

/** Lee cadenas Unicode de BIFF8 que pueden seguir en registros CONTINUE (la tabla SST). */
class LectorPartido {
  private i = 0
  private o = 0
  private partes: Uint8Array[]
  constructor(partes: Uint8Array[]) {
    this.partes = partes
  }
  private actual() {
    while (this.i < this.partes.length && this.o >= this.partes[this.i].length) {
      this.i++
      this.o = 0
    }
    if (this.i >= this.partes.length) throw new ErrorExtracto('El .xls está dañado (tabla de textos)')
    return this.partes[this.i]
  }
  byte() {
    const p = this.actual()
    return p[this.o++]
  }
  u16() {
    return this.byte() | (this.byte() << 8)
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  saltar(n: number) {
    for (let k = 0; k < n; k++) this.byte()
  }
  cadena(): string {
    const largo = this.u16()
    let opciones = this.byte()
    const rico = opciones & 0x08 ? this.u16() : 0
    const extendido = opciones & 0x04 ? this.u32() : 0
    let s = ''
    for (let k = 0; k < largo; k++) {
      // Si los caracteres siguen en un CONTINUE, ese registro empieza con un byte de opciones nuevo.
      if (this.i < this.partes.length && this.o >= this.partes[this.i].length) {
        this.i++
        this.o = 0
        opciones = this.byte()
      }
      s += String.fromCharCode(opciones & 0x01 ? this.u16() : this.byte())
    }
    this.saltar(rico * 4 + extendido)
    return s
  }
}

/** Cadena Unicode de un registro (LABEL, BOUNDSHEET, FORMAT, STRING). largo16: el largo ocupa 2 bytes. */
function cadenaSimple(d: Uint8Array, o: number, largo16: boolean): string {
  const largo = largo16 ? d[o] | (d[o + 1] << 8) : d[o]
  o += largo16 ? 2 : 1
  const opciones = d[o++]
  if (opciones & 0x08) o += 2
  if (opciones & 0x04) o += 4
  let s = ''
  for (let k = 0; k < largo; k++) {
    if (opciones & 0x01) {
      s += String.fromCharCode(d[o] | (d[o + 1] << 8))
      o += 2
    } else s += String.fromCharCode(d[o++])
  }
  return s
}

function rk(v: number): number {
  const centesimos = v & 0x01
  let n: number
  if (v & 0x02) n = v >> 2
  else {
    const buf = new DataView(new ArrayBuffer(8))
    buf.setUint32(4, (v & 0xfffffffc) >>> 0, true)
    buf.setUint32(0, 0, true)
    n = buf.getFloat64(0, true)
  }
  return centesimos ? n / 100 : n
}

const FORMATOS_FECHA_FIJOS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const serialAFecha = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86_400_000))

export interface Hoja {
  nombre: string
  filas: FilaPlanilla[]
}

/** Lee las hojas de un .xls (BIFF8). Las versiones anteriores a Excel 97 no se soportan. */
export function leerXls(bytes: Uint8Array): Hoja[] {
  const w = flujoCfb(bytes, ['Workbook', 'Book'])
  if (!w) throw new ErrorExtracto('El .xls no tiene libro (Workbook)')
  const globales = registros(w, 0)
  const bof = globales[0]
  if (!bof || bof.tipo !== 0x0809 || (bof.datos[0] | (bof.datos[1] << 8)) !== 0x0600) {
    throw new ErrorExtracto('El .xls es de una versión de Excel anterior a 97: guardalo de nuevo como .xlsx')
  }
  const hojasDef: { nombre: string; pos: number }[] = []
  const formatos = new Map<number, string>()
  const xfFormato: number[] = []
  let sst: string[] = []
  for (let k = 0; k < globales.length; k++) {
    const r = globales[k]
    const d = r.datos
    if (r.tipo === 0x0085) {
      const pos = (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0
      if (d[5] === 0) hojasDef.push({ pos, nombre: cadenaSimple(d, 6, false) }) // solo hojas de cálculo
    } else if (r.tipo === 0x041e) {
      formatos.set(d[0] | (d[1] << 8), cadenaSimple(d, 2, true))
    } else if (r.tipo === 0x00e0) {
      xfFormato.push(d[2] | (d[3] << 8))
    } else if (r.tipo === 0x00fc) {
      const partes = [d]
      while (globales[k + 1]?.tipo === 0x003c) partes.push(globales[++k].datos)
      const lector = new LectorPartido(partes)
      lector.u32() // total
      const unicos = lector.u32()
      sst = []
      for (let i = 0; i < unicos; i++) sst.push(lector.cadena())
    }
  }
  const esFecha = (xf: number) => {
    const f = xfFormato[xf]
    return f != null && (FORMATOS_FECHA_FIJOS.has(f) || (formatos.has(f) && esFormatoFecha(formatos.get(f)!)))
  }

  return hojasDef.map((h) => {
    const filas: FilaPlanilla[] = []
    const poner = (fila: number, col: number, v: Celda) => {
      const f = (filas[fila] ??= [])
      f[col] = v
    }
    const numeroCon = (xf: number, n: number): Celda => (esFecha(xf) ? serialAFecha(n) : n)
    const regs = registros(w, h.pos)
    for (let k = 0; k < regs.length; k++) {
      const { tipo, datos: d } = regs[k]
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
      const fila = d.length >= 4 ? dv.getUint16(0, true) : 0
      const col = d.length >= 4 ? dv.getUint16(2, true) : 0
      if (tipo === 0x00fd) poner(fila, col, sst[dv.getUint32(6, true)] ?? null) // LABELSST
      else if (tipo === 0x0203) poner(fila, col, numeroCon(dv.getUint16(4, true), dv.getFloat64(6, true))) // NUMBER
      else if (tipo === 0x027e) poner(fila, col, numeroCon(dv.getUint16(4, true), rk(dv.getInt32(6, true)))) // RK
      else if (tipo === 0x0204) poner(fila, col, cadenaSimple(d, 6, true)) // LABEL
      else if (tipo === 0x00bd) {
        // MULRK: varias columnas seguidas con valores RK
        const ultima = dv.getUint16(d.length - 2, true)
        for (let c = col, o = 4; c <= ultima; c++, o += 6) poner(fila, c, numeroCon(dv.getUint16(o, true), rk(dv.getInt32(o + 2, true))))
      } else if (tipo === 0x0006) {
        // FORMULA: el resultado guardado; si es texto, viene en el registro STRING que sigue.
        const xf = dv.getUint16(4, true)
        if (dv.getUint16(12, true) === 0xffff) {
          if (d[6] === 0 && regs[k + 1]?.tipo === 0x0207) poner(fila, col, cadenaSimple(regs[++k].datos, 0, true))
          else if (d[6] === 1) poner(fila, col, d[8] === 1)
        } else poner(fila, col, numeroCon(xf, dv.getFloat64(6, true)))
      } else if (tipo === 0x0205 && d[7] === 0) poner(fila, col, d[6] === 1) // BOOLERR (booleano)
    }
    for (let i = 0; i < filas.length; i++) {
      const f = (filas[i] ??= [])
      for (let j = 0; j < f.length; j++) if (f[j] === undefined) f[j] = null
    }
    return { nombre: h.nombre, filas }
  })
}
