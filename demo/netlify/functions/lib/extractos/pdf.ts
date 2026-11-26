// Extractor mínimo de texto de PDF, sin dependencias. Alcanza para informes generados por sistemas
// (JasperReports, iText): objetos sueltos, contenido comprimido con Flate y fuentes con tabla ToUnicode.
// Devuelve el texto por renglón, de arriba hacia abajo. No soporta PDF cifrados ni flujos de objetos:
// en ese caso avisa para que Tesorería baje el informe en otro formato.

import { inflateRawSync, inflateSync } from 'node:zlib'
import { ErrorExtracto } from './tipos'

const latin1 = new TextDecoder('latin1')

interface Objeto {
  dic: string
  flujo: Uint8Array | null
}

/** Descomprime Flate. Algunos generadores dejan mal el control final (adler32): se lee igual sin él. */
function inflar(d: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(inflateSync(d))
  } catch {
    try {
      return new Uint8Array(inflateRawSync(d.subarray(2)))
    } catch {
      throw new ErrorExtracto('No se pudo descomprimir el contenido del PDF')
    }
  }
}

function objetos(b: Uint8Array): Map<number, Objeto> {
  const t = latin1.decode(b)
  if (/\/Encrypt\b/.test(t)) throw new ErrorExtracto('El PDF está protegido (cifrado): bajá el informe en Excel o CSV, o guardalo sin protección')
  const mapa = new Map<number, Objeto>()
  const inicios = new Map<number, number>() // dónde empieza el flujo de cada objeto que tiene uno
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const desde = m.index + m[0].length
    const fin = t.indexOf('endobj', desde)
    if (fin < 0) break
    const cuerpo = t.slice(desde, fin)
    const s = /\bstream\r?\n/.exec(cuerpo)
    const n = Number(m[1])
    mapa.set(n, { dic: s ? cuerpo.slice(0, s.index) : cuerpo, flujo: null })
    if (s) inicios.set(n, desde + s.index + s[0].length)
    re.lastIndex = fin
  }
  for (const [n, inicio] of inicios) {
    const o = mapa.get(n)!
    // El largo puede ser un número o una referencia a otro objeto.
    const l = /\/Length\s+(\d+)(?:\s+\d+\s+R)?/.exec(o.dic)
    let largo = l ? Number(l[1]) : -1
    if (l && /\sR$/.test(l[0])) largo = Number(mapa.get(Number(l[1]))?.dic.trim() ?? -1)
    if (!(largo >= 0) || inicio + largo > b.length) largo = t.indexOf('endstream', inicio) - inicio
    let datos = b.subarray(inicio, inicio + largo)
    if (/\/Filter\s*(\[\s*)?\/FlateDecode\s*\]?/.test(o.dic)) datos = inflar(datos)
    else if (/\/Filter/.test(o.dic)) datos = new Uint8Array(0) // imágenes u otros filtros: no es texto
    o.flujo = datos
  }
  const hayPaginas = [...mapa.values()].some((o) => /\/Type\s*\/Page\b/.test(o.dic))
  if (!hayPaginas && [...mapa.values()].some((o) => /\/Type\s*\/ObjStm/.test(o.dic))) {
    throw new ErrorExtracto('El PDF usa un formato comprimido que no se puede leer: bajá el informe en Excel o CSV')
  }
  return mapa
}

const ref = (s: string) => {
  const m = /^\s*(\d+)\s+\d+\s+R/.exec(s)
  return m ? Number(m[1]) : null
}

/** Contenido de un diccionario que puede estar en línea (<< ... >>) o en otro objeto. */
function subDic(mapa: Map<number, Objeto>, dic: string, clave: string): string {
  const i = dic.search(new RegExp(`/${clave}\\b`))
  if (i < 0) return ''
  const resto = dic.slice(i + clave.length + 1).trimStart()
  const r = ref(resto)
  if (r != null) return mapa.get(r)?.dic ?? ''
  if (!resto.startsWith('<<')) return ''
  let nivel = 0
  for (let k = 0; k < resto.length - 1; k++) {
    if (resto[k] === '<' && resto[k + 1] === '<') {
      nivel++
      k++
    } else if (resto[k] === '>' && resto[k + 1] === '>') {
      nivel--
      k++
      if (nivel === 0) return resto.slice(2, k - 1)
    }
  }
  return ''
}

// ---------------------------------------------------------------- Fuentes (ToUnicode)

interface Fuente {
  bytesPorCodigo: number
  mapa: Map<number, string>
}

function hexATexto(h: string): string {
  let s = ''
  for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
  return s
}

function leerCmap(t: string): Fuente {
  const mapa = new Map<number, string>()
  const espacio = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(t)
  const bytesPorCodigo = espacio ? espacio[1].length / 2 : 1
  for (const bloque of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of bloque[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) mapa.set(parseInt(m[1], 16), hexATexto(m[2]))
  }
  for (const bloque of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of bloque[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]+)>|\[([^\]]*)\])/gi)) {
      const desde = parseInt(m[1], 16)
      const hasta = parseInt(m[2], 16)
      if (m[4] != null) {
        const base = parseInt(m[4], 16)
        for (let c = desde; c <= hasta && c - desde < 65_536; c++) mapa.set(c, String.fromCharCode(base + c - desde))
      } else {
        const lista = [...(m[5] ?? '').matchAll(/<([0-9a-f]*)>/gi)].map((x) => hexATexto(x[1]))
        lista.forEach((s, k) => mapa.set(desde + k, s))
      }
    }
  }
  return { bytesPorCodigo, mapa }
}

function fuentesDePagina(mapa: Map<number, Objeto>, pagina: string): Map<string, Fuente> {
  const recursos = subDic(mapa, pagina, 'Resources')
  const dicFuentes = subDic(mapa, recursos, 'Font')
  const fuentes = new Map<string, Fuente>()
  for (const m of dicFuentes.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const f = mapa.get(Number(m[2]))
    if (!f) continue
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(f.dic)
    const flujo = tu ? mapa.get(Number(tu[1]))?.flujo : null
    if (flujo) fuentes.set(m[1], leerCmap(latin1.decode(flujo)))
    else fuentes.set(m[1], { bytesPorCodigo: /\/Type0/.test(f.dic) ? 2 : 1, mapa: new Map() })
  }
  return fuentes
}

// ---------------------------------------------------------------- Contenido de la página

type Token = { t: 'num'; v: number } | { t: 'cad'; v: Uint8Array } | { t: 'nom'; v: string } | { t: 'op'; v: string } | { t: 'arr'; v: Token[] }

function tokens(c: Uint8Array): Token[] {
  const pila: Token[][] = [[]]
  const salida = () => pila[pila.length - 1]
  let i = 0
  const blanco = (x: number) => x === 0x20 || x === 0x0a || x === 0x0d || x === 0x09 || x === 0x0c || x === 0x00
  const delim = (x: number) => blanco(x) || '()<>[]{}/%'.includes(String.fromCharCode(x))
  while (i < c.length) {
    const x = c[i]
    if (blanco(x)) i++
    else if (x === 0x25) while (i < c.length && c[i] !== 0x0a && c[i] !== 0x0d) i++ // comentario
    else if (x === 0x28) {
      // (cadena literal) con escapes y paréntesis anidados
      const bytes: number[] = []
      let nivel = 1
      i++
      while (i < c.length && nivel > 0) {
        const y = c[i++]
        if (y === 0x5c) {
          const z = c[i++]
          const esc: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }
          if (z in esc) bytes.push(esc[z])
          else if (z >= 0x30 && z <= 0x37) {
            let oct = z - 0x30
            for (let k = 0; k < 2 && c[i] >= 0x30 && c[i] <= 0x37; k++) oct = oct * 8 + (c[i++] - 0x30)
            bytes.push(oct & 0xff)
          } else if (z === 0x0d || z === 0x0a) {
            if (z === 0x0d && c[i] === 0x0a) i++
          } else bytes.push(z)
        } else {
          if (y === 0x28) nivel++
          if (y === 0x29) nivel--
          if (nivel > 0) bytes.push(y)
        }
      }
      salida().push({ t: 'cad', v: Uint8Array.from(bytes) })
    } else if (x === 0x3c && c[i + 1] === 0x3c) {
      // diccionario en línea (BDC, etc.): se saltea entero
      let nivel = 0
      while (i < c.length) {
        if (c[i] === 0x3c && c[i + 1] === 0x3c) {
          nivel++
          i += 2
        } else if (c[i] === 0x3e && c[i + 1] === 0x3e) {
          nivel--
          i += 2
          if (nivel === 0) break
        } else i++
      }
    } else if (x === 0x3c) {
      let h = ''
      i++
      while (i < c.length && c[i] !== 0x3e) h += String.fromCharCode(c[i++])
      i++
      h = h.replace(/\s+/g, '')
      if (h.length % 2) h += '0'
      const bytes = new Uint8Array(h.length / 2)
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16)
      salida().push({ t: 'cad', v: bytes })
    } else if (x === 0x5b) {
      pila.push([])
      i++
    } else if (x === 0x5d) {
      const arr = pila.length > 1 ? pila.pop()! : []
      salida().push({ t: 'arr', v: arr })
      i++
    } else if (x === 0x2f) {
      let n = ''
      i++
      while (i < c.length && !delim(c[i])) n += String.fromCharCode(c[i++])
      salida().push({ t: 'nom', v: n })
    } else {
      let p = ''
      while (i < c.length && !delim(c[i])) p += String.fromCharCode(c[i++])
      if (p === '') {
        i++
        continue
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(p)) salida().push({ t: 'num', v: Number(p) })
      else if (p === 'BI') {
        // imagen en línea: hasta EI
        while (i < c.length && !(c[i] === 0x45 && c[i + 1] === 0x49 && blanco(c[i + 2] ?? 0x20) && blanco(c[i - 1]))) i++
        i += 2
      } else salida().push({ t: 'op', v: p })
    }
  }
  return pila[0]
}

type Matriz = [number, number, number, number, number, number]
const por = (m: Matriz, n: Matriz): Matriz => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]

interface Trozo {
  x: number
  y: number
  texto: string
}

function decodificar(cad: Uint8Array, f: Fuente | undefined): string {
  const n = f?.bytesPorCodigo ?? 1
  let s = ''
  for (let i = 0; i + n <= cad.length; i += n) {
    const codigo = n === 2 ? (cad[i] << 8) | cad[i + 1] : cad[i]
    s += f?.mapa.get(codigo) ?? (n === 1 ? String.fromCharCode(codigo) : '')
  }
  return s
}

function trozosDePagina(contenido: Uint8Array, fuentes: Map<string, Fuente>): Trozo[] {
  const trozos: Trozo[] = []
  let ctm: Matriz = [1, 0, 0, 1, 0, 0]
  const pilaCtm: Matriz[] = []
  let tm: Matriz = [1, 0, 0, 1, 0, 0]
  let tlm: Matriz = [1, 0, 0, 1, 0, 0]
  let interlineado = 0
  let fuente: Fuente | undefined
  let operandos: Token[] = []
  const nums = () => operandos.filter((o): o is { t: 'num'; v: number } => o.t === 'num').map((o) => o.v)
  // Sin anchos de letra no se sabe cuánto avanza el texto: lo que se muestra sin moverse antes (por
  // ejemplo, una letra con tilde en otra fuente en medio de una palabra) sigue pegado al trozo anterior.
  let movido = true
  const mover = (tx: number, ty: number) => {
    tlm = por([1, 0, 0, 1, tx, ty], tlm)
    tm = tlm
    movido = true
  }
  const mostrar = (s: string) => {
    if (!s) return
    const ultimo = trozos[trozos.length - 1]
    if (!movido && ultimo) ultimo.texto += s
    else {
      const p = por(tm, ctm)
      trozos.push({ x: p[4], y: p[5], texto: s })
    }
    movido = false
  }
  for (const tok of tokens(contenido)) {
    if (tok.t !== 'op') {
      operandos.push(tok)
      continue
    }
    const n = nums()
    switch (tok.v) {
      case 'q':
        pilaCtm.push(ctm)
        break
      case 'Q':
        ctm = pilaCtm.pop() ?? [1, 0, 0, 1, 0, 0]
        break
      case 'cm':
        if (n.length === 6) ctm = por(n as Matriz, ctm)
        break
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0]
        tlm = tm
        movido = true
        break
      case 'Tf': {
        const nombre = operandos.find((o) => o.t === 'nom')
        fuente = nombre && nombre.t === 'nom' ? fuentes.get(nombre.v) : undefined
        break
      }
      case 'TL':
        interlineado = n[0] ?? 0
        break
      case 'Td':
        mover(n[0] ?? 0, n[1] ?? 0)
        break
      case 'TD':
        interlineado = -(n[1] ?? 0)
        mover(n[0] ?? 0, n[1] ?? 0)
        break
      case 'Tm':
        if (n.length === 6) {
          tlm = n as Matriz
          tm = tlm
          movido = true
        }
        break
      case 'T*':
        mover(0, -interlineado)
        break
      case "'":
      case '"': {
        mover(0, -interlineado)
        const cad = operandos.find((o) => o.t === 'cad')
        if (cad && cad.t === 'cad') mostrar(decodificar(cad.v, fuente))
        break
      }
      case 'Tj': {
        const cad = operandos.find((o) => o.t === 'cad')
        if (cad && cad.t === 'cad') mostrar(decodificar(cad.v, fuente))
        break
      }
      case 'TJ': {
        const arr = operandos.find((o) => o.t === 'arr')
        if (arr && arr.t === 'arr') {
          let s = ''
          for (const e of arr.v) {
            if (e.t === 'cad') s += decodificar(e.v, fuente)
            else if (e.t === 'num' && e.v < -200) s += ' ' // un hueco grande entre letras es un espacio
          }
          mostrar(s)
        }
        break
      }
    }
    operandos = []
  }
  return trozos
}

/** Renglones de texto de todas las páginas, de arriba hacia abajo y de izquierda a derecha. */
export function textoPdf(b: Uint8Array): string[] {
  if (latin1.decode(b.subarray(0, 5)) !== '%PDF-') throw new ErrorExtracto('El archivo no es un PDF')
  const mapa = objetos(b)
  const paginas = [...mapa.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dic)).sort((a, z) => a[0] - z[0])
  if (!paginas.length) throw new ErrorExtracto('El PDF no tiene páginas legibles')
  const renglones: string[] = []
  for (const [, p] of paginas) {
    const fuentes = fuentesDePagina(mapa, p.dic)
    const cont = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(p.dic)
    if (!cont) continue
    const partes = [...cont[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => mapa.get(Number(m[1]))?.flujo ?? new Uint8Array(0))
    const todo = new Uint8Array(partes.reduce((a, x) => a + x.length + 1, 0))
    let o = 0
    for (const x of partes) {
      todo.set(x, o)
      o += x.length
      todo[o++] = 0x0a
    }
    // Agrupar por altura (tolerancia de 2 puntos) y ordenar de arriba hacia abajo.
    const lineas: { y: number; trozos: Trozo[] }[] = []
    for (const t of trozosDePagina(todo, fuentes)) {
      const l = lineas.find((x) => Math.abs(x.y - t.y) < 2)
      if (l) l.trozos.push(t)
      else lineas.push({ y: t.y, trozos: [t] })
    }
    lineas.sort((a, z) => z.y - a.y)
    for (const l of lineas) {
      renglones.push(
        l.trozos
          .sort((a, z) => a.x - z.x)
          .map((t) => t.texto)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
  }
  return renglones.filter((r) => r !== '')
}
