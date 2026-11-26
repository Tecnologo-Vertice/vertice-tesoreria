// T-201 · Lectores de extractos bancarios y POST /api/bancos/extracto.
// Los archivos de prueba se arman acá mismo con la MISMA estructura de columnas que los que bajan los
// bancos (vistos en los ejemplos reales del 25/11/2026), pero con importes, nombres y números inventados:
// ningún CUIT, CBU ni número de cuenta real. Cada banco se controla por suma de débitos, de créditos,
// saldo final y cantidad de filas.
// Uso: node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/extractos.prueba.mts
import { deflateRawSync, deflateSync } from 'node:zlib'
import { cerrar, check, simular, type Fila, type Mundo } from './simulador.mts'

const { leerExtracto, PENDIENTES, totales } = await import('../functions/lib/extractos/index.ts')
const { numero, fechaISO, importeDesde, ordenCronologico, numeroCheque, diaHabilAnterior, huellaArchivo } = await import('../functions/lib/extractos/normalizar.ts')
const importar = (await import('../functions/importar-extracto.mts')).default

type Celda = string | number | Date | null
const enc = new TextEncoder()
const falla = (f: () => unknown): string => {
  try {
    f()
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
/** Controla una cuenta leída: filas, débitos, créditos y saldo final. */
function controlar(nombre: string, c: { movimientos: { importe: number; saldo: number | null }[] } | undefined, filas: number, debitos: number, creditos: number, saldoFinal: number) {
  const t = totales((c?.movimientos ?? []) as never)
  const fin = c?.movimientos.at(-1)?.saldo
  check(`${nombre}: ${filas} filas`, t.filas === filas, String(t.filas))
  check(`${nombre}: débitos ${debitos}`, t.debitos === debitos, String(t.debitos))
  check(`${nombre}: créditos ${creditos}`, t.creditos === creditos, String(t.creditos))
  check(`${nombre}: saldo final ${saldoFinal}`, fin === saldoFinal, String(fin))
}

// ================================================================ Armado de archivos de prueba

// ---------------------------------------------------------------- ZIP / XLSX
const tablaCrc = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff
  for (const x of b) c = tablaCrc[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function zip(archivos: Record<string, string>, comprimir: boolean): Uint8Array {
  const locales: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [nombre, contenido] of Object.entries(archivos)) {
    const datos = Buffer.from(contenido, 'utf8')
    const guardado = comprimir ? deflateRawSync(datos) : datos
    const n = Buffer.from(nombre, 'utf8')
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0)
    l.writeUInt16LE(20, 4)
    l.writeUInt16LE(comprimir ? 8 : 0, 8)
    l.writeUInt32LE(crc32(datos), 14)
    l.writeUInt32LE(guardado.length, 18)
    l.writeUInt32LE(datos.length, 22)
    l.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(comprimir ? 8 : 0, 10)
    c.writeUInt32LE(crc32(datos), 16)
    c.writeUInt32LE(guardado.length, 20)
    c.writeUInt32LE(datos.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    locales.push(l, n, guardado)
    central.push(c, n)
    offset += 30 + n.length + guardado.length
  }
  const dir = Buffer.concat(central)
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0)
  fin.writeUInt16LE(Object.keys(archivos).length, 8)
  fin.writeUInt16LE(Object.keys(archivos).length, 10)
  fin.writeUInt32LE(dir.length, 12)
  fin.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locales, dir, fin]))
}
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const letra = (i: number) => String.fromCharCode(65 + i)
/**
 * Un .xlsx de una hoja. Texto en la tabla compartida (como Brubank) o en línea "str" (como Galicia).
 * Fechas: t="d" (Galicia) o número de serie con estilo de fecha.
 */
function xlsx(filas: Celda[][], o: { textoEnLinea?: boolean; fechas?: 'd' | 'serie'; comprimir?: boolean; hoja?: string } = {}): Uint8Array {
  const compartidos: string[] = []
  const filasXml = filas
    .map((f, i) => {
      const celdas = f
        .map((v, j) => {
          const r = `${letra(j)}${i + 1}`
          if (v == null) return ''
          if (v instanceof Date) {
            if (o.fechas === 'd') return `<c r="${r}" s="1" t="d"><v>${v.toISOString()}</v></c>`
            return `<c r="${r}" s="1"><v>${(v.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000}</v></c>`
          }
          if (typeof v === 'number') return `<c r="${r}"><v>${v}</v></c>`
          if (o.textoEnLinea) return `<c r="${r}" t="str"><v>${esc(v)}</v></c>`
          compartidos.push(v)
          return `<c r="${r}" t="s"><v>${compartidos.length - 1}</v></c>`
        })
        .join('')
      return `<row r="${i + 1}">${celdas}</row>`
    })
    .join('')
  return zip(
    {
      '[Content_Types].xml':
        `<?xml version="1.0"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${OR}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SS}" xmlns:r="${OR}"><sheets><sheet name="${o.hoja ?? 'Sheet1'}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':
        `<?xml version="1.0"?><Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${OR}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${OR}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${OR}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
      'xl/styles.xml': `<?xml version="1.0"?><styleSheet xmlns="${SS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
      'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${SS}">${compartidos.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${SS}"><sheetData>${filasXml}</sheetData></worksheet>`,
    },
    o.comprimir ?? true,
  )
}

// ---------------------------------------------------------------- XLS (BIFF8 dentro de un archivo compuesto)
const registro = (tipo: number, datos: Buffer) => {
  const h = Buffer.alloc(4)
  h.writeUInt16LE(tipo, 0)
  h.writeUInt16LE(datos.length, 2)
  return Buffer.concat([h, datos])
}
const u16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
const f64 = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(n)
  return b
}
/** Cadena BIFF8: compacta (latin-1) si se puede; si no, UTF-16. */
const cadenaBiff = (s: string, largo16: boolean) => {
  const ancho = [...s].some((c) => c.charCodeAt(0) > 255)
  return Buffer.concat([largo16 ? u16(s.length) : Buffer.from([s.length]), Buffer.from([ancho ? 1 : 0]), Buffer.from(s, ancho ? 'utf16le' : 'latin1')])
}
const serie = (d: Date) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000
/** RK entero (×100 si tiene centavos). */
const rkDe = (n: number) => (Number.isInteger(n) ? (n << 2) | 2 : (Math.round(n * 100) << 2) | 3)

/**
 * Un .xls de una hoja. Texto en SST (partida en un CONTINUE si es larga, como lo hace Excel), números con
 * NUMBER o RK, una fila con MULRK y fechas como número con formato de fecha (XF 1 → formato 14).
 */
function xls(filas: Celda[][], o: { usarRk?: boolean; relleno?: number } = {}): Uint8Array {
  const sst: string[] = []
  const indice = (s: string) => {
    const i = sst.indexOf(s)
    if (i >= 0) return i
    sst.push(s)
    return sst.length - 1
  }
  const celdas: Buffer[] = []
  filas.forEach((f, r) => {
    // Una fila de solo números con RK sale como MULRK (varias columnas en un registro).
    if (o.usarRk && f.length > 1 && f.every((v) => typeof v === 'number' && Math.abs(v) < 1e6)) {
      const partes = (f as number[]).map((v) => Buffer.concat([u16(0), u32(rkDe(v))]))
      celdas.push(registro(0x00bd, Buffer.concat([u16(r), u16(0), ...partes, u16(f.length - 1)])))
      return
    }
    f.forEach((v, c) => {
      const pos = Buffer.concat([u16(r), u16(c)])
      if (v == null) return
      if (v instanceof Date) celdas.push(registro(0x0203, Buffer.concat([pos, u16(1), f64(serie(v))])))
      else if (typeof v === 'number') {
        if (o.usarRk && Math.abs(v) < 1e6 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9) celdas.push(registro(0x027e, Buffer.concat([pos, u16(0), u32(rkDe(v))])))
        else celdas.push(registro(0x0203, Buffer.concat([pos, u16(0), f64(v)])))
      } else if (v.startsWith('LABEL:')) celdas.push(registro(0x0204, Buffer.concat([pos, u16(0), cadenaBiff(v.slice(6), true)])))
      else celdas.push(registro(0x00fd, Buffer.concat([pos, u16(0), u32(indice(v))])))
    })
  })
  // SST: si pasa de 200 bytes, el resto sigue en un CONTINUE (cortando entre cadenas).
  const cadenas = sst.map((s) => cadenaBiff(s, true))
  const sstRegs: Buffer[] = []
  let actual = Buffer.concat([u32(sst.length), u32(sst.length)])
  let primero = true
  for (const c of cadenas) {
    if (actual.length + c.length > 200 && actual.length > 8) {
      sstRegs.push(registro(primero ? 0x00fc : 0x003c, actual))
      primero = false
      actual = Buffer.alloc(0)
    }
    actual = Buffer.concat([actual, c])
  }
  sstRegs.push(registro(primero ? 0x00fc : 0x003c, actual))
  const bof = (tipo: number) => registro(0x0809, Buffer.concat([u16(0x0600), u16(tipo), Buffer.alloc(12)]))
  const xf = (formato: number) => registro(0x00e0, Buffer.concat([u16(0), u16(formato), Buffer.alloc(16)]))
  const hoja = Buffer.concat([bof(0x10), ...celdas, registro(0x000a, Buffer.alloc(0))])
  const armarGlobales = (pos: number) =>
    Buffer.concat([bof(0x05), xf(0), xf(14), registro(0x0085, Buffer.concat([u32(pos), Buffer.from([0, 0]), cadenaBiff('Hoja 1', false)])), ...sstRegs, registro(0x000a, Buffer.alloc(0))])
  const largoGlobales = armarGlobales(0).length
  const libro = Buffer.concat([armarGlobales(largoGlobales), hoja, Buffer.alloc(o.relleno ?? 0)])
  return cfb(libro)
}

/** Archivo compuesto (CFB) con un solo flujo "Workbook". Si es chico (< 4096), va al mini flujo, como Credicoop. */
function cfb(libro: Buffer): Uint8Array {
  const S = 512
  const FIN = 0xfffffffe
  const NADA = 0xffffffff
  const sectores = (n: number) => Math.ceil(n / S)
  const mini = libro.length < 4096
  // Sector 0: FAT · 1: directorio · 2: mini FAT (si hace falta) · después, los datos.
  const fat: number[] = [0xfffffffd, FIN]
  let primerMiniFat = FIN
  let datos: Buffer
  let inicioDatos: number
  const miniFat: number[] = []
  if (mini) {
    primerMiniFat = 2
    fat.push(FIN)
    const n = Math.ceil(libro.length / 64)
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? FIN : i + 1)
    datos = Buffer.concat([libro, Buffer.alloc(n * 64 - libro.length)])
    inicioDatos = 3
  } else {
    datos = libro
    inicioDatos = 2
  }
  const nDatos = sectores(datos.length)
  for (let i = 0; i < nDatos; i++) fat.push(i === nDatos - 1 ? FIN : inicioDatos + i + 1)
  const encabezado = Buffer.alloc(S, 0)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(encabezado, 0)
  encabezado.writeUInt16LE(0x3e, 24)
  encabezado.writeUInt16LE(3, 26)
  encabezado.writeUInt16LE(0xfffe, 28)
  encabezado.writeUInt16LE(9, 30)
  encabezado.writeUInt16LE(6, 32)
  encabezado.writeUInt32LE(1, 44)
  encabezado.writeUInt32LE(1, 48)
  encabezado.writeUInt32LE(4096, 56)
  encabezado.writeUInt32LE(primerMiniFat, 60)
  encabezado.writeUInt32LE(mini ? 1 : 0, 64)
  encabezado.writeUInt32LE(FIN, 68)
  for (let i = 0; i < 109; i++) encabezado.writeUInt32LE(i === 0 ? 0 : NADA, 76 + i * 4)
  const sectorFat = Buffer.alloc(S, 0xff)
  fat.forEach((v, i) => sectorFat.writeUInt32LE(v >>> 0, i * 4))
  const entrada = (nombre: string, tipo: number, inicio: number, tam: number, hijo: number) => {
    const e = Buffer.alloc(128, 0)
    Buffer.from(nombre + '\0', 'utf16le').copy(e, 0)
    e.writeUInt16LE((nombre.length + 1) * 2, 64)
    e[66] = tipo
    e.writeUInt32LE(NADA, 68)
    e.writeUInt32LE(NADA, 72)
    e.writeUInt32LE(hijo >>> 0, 76)
    e.writeUInt32LE(inicio >>> 0, 116)
    e.writeUInt32LE(tam, 120)
    return e
  }
  const dir = Buffer.concat([
    entrada('Root Entry', 5, mini ? inicioDatos : FIN, mini ? datos.length : 0, 1),
    entrada('Workbook', 2, mini ? 0 : inicioDatos, libro.length, NADA),
    Buffer.alloc(256, 0),
  ])
  const sectorMiniFat = Buffer.alloc(S, 0xff)
  miniFat.forEach((v, i) => sectorMiniFat.writeUInt32LE(v >>> 0, i * 4))
  const relleno = Buffer.alloc(nDatos * S - datos.length, 0)
  return new Uint8Array(Buffer.concat([encabezado, sectorFat, dir, ...(mini ? [sectorMiniFat] : []), datos, relleno]))
}

// ---------------------------------------------------------------- PDF
/**
 * Un PDF de una página como el informe del FCI: fuente con tabla ToUnicode que cambia los códigos (como
 * lo hacen JasperReports/iText), letras con tilde en otra fuente en medio de la palabra, contenido
 * comprimido y, si se pide, el control adler32 roto (pasa en los informes reales).
 */
function pdf(lineas: string[], o: { adlerRoto?: boolean; cifrado?: boolean } = {}): Uint8Array {
  // F1: cada letra se escribe con el código (letra + 1) y la tabla ToUnicode la devuelve a su lugar.
  // Las letras con tilde van en F2 (otra fuente, códigos propios).
  const tildes = ['ó', 'é', 'á', 'í', 'ú', 'Ó']
  const codigoF1 = (c: string) => String.fromCharCode(c.charCodeAt(0) + 1)
  const escPdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  let contenido = '1 0 0 -1 0 792 cm\n'
  lineas.forEach((l, i) => {
    contenido += `BT 1 0 0 -1 40 ${100 + i * 12} Tm `
    // Columnas separadas por "|": cada una con su posición.
    l.split('|').forEach((col, k) => {
      if (k) contenido += `${k === 1 ? 200 : 120} 0 Td `
      let tramo = ''
      const cerrar = () => {
        if (tramo) contenido += `/F1 8 Tf (${escPdf(tramo)}) Tj `
        tramo = ''
      }
      for (const c of col) {
        if (tildes.includes(c)) {
          cerrar()
          contenido += `/F2 8 Tf <${(0x41 + tildes.indexOf(c)).toString(16)}> Tj `
        } else tramo += codigoF1(c)
      }
      cerrar()
    })
    contenido += 'ET\n'
  })
  let comprimido = deflateSync(Buffer.from(contenido, 'latin1'))
  if (o.adlerRoto) {
    comprimido = Buffer.from(comprimido)
    comprimido[comprimido.length - 1] ^= 0xff
  }
  const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase()
  const cmapF1 = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfrange\n<21> <FF> <${hex4(0x20)}>\nendbfrange\nendcmap end end`
  const cmapF2 = `begincmap\n1 begincodespacerange <00> <FF> endcodespacerange\n${tildes.length} beginbfchar\n${tildes.map((t, i) => `<${(0x41 + i).toString(16)}> <${hex4(t.charCodeAt(0))}>`).join('\n')}\nendbfchar\nendcmap`
  const objs: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    Buffer.concat([Buffer.from(`<< /Length ${comprimido.length} /Filter /FlateDecode >>\nstream\r\n`), comprimido, Buffer.from('\r\nendstream')]),
    '<< /Type /Font /Subtype /TrueType /BaseFont /Ficticia /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /TrueType /BaseFont /FicticiaTildes /ToUnicode 8 0 R >>',
    `<< /Length ${cmapF1.length} >>\nstream\n${cmapF1}\nendstream`,
    `<< /Length ${cmapF2.length} >>\nstream\n${cmapF2}\nendstream`,
  ]
  const partes: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let largo = partes[0].length
  objs.forEach((ob, i) => {
    offsets.push(largo)
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(ob) ? ob : Buffer.from(ob, 'latin1'), Buffer.from('\nendobj\n')])
    partes.push(b)
    largo += b.length
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}`
  partes.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${o.cifrado ? ' /Encrypt 9 0 R' : ''} >>\nstartxref\n${largo}\n%%EOF`))
  return new Uint8Array(Buffer.concat(partes))
}

const d = (iso: string) => new Date(iso + 'T00:00:00Z')

// ================================================================ Normalización
check('número AR: "12.500,00" → 12500', numero('12.500,00') === 12500)
check('número AR: "$ 5,25" → 5.25', numero('$ 5,25') === 5.25)
check('número AR: "- $ 123.456,78" → -123456.78', numero('- $ 123.456,78') === -123456.78)
check('número AR: "-12345.6" (punto decimal) → -12345.6', numero('-12345.6') === -12345.6)
check('número AR: "1.234.567" (solo miles) → 1234567', numero('1.234.567') === 1234567)
check('número AR: "(1.234,50)" → -1234.5', numero('(1.234,50)') === -1234.5)
check('número AR: "-" (Brubank sin importe) → vacío', numero('-') === null && numero('') === null)
check('número AR: basura → error', /no se entiende/i.test(falla(() => numero('12a,5'))))
check('fecha dd/mm/aaaa → ISO', fechaISO('02/11/2026') === '2026-11-02')
check('fecha dd-mm-aa (Brubank) → ISO', fechaISO('30-10-26') === '2026-10-30')
check('fecha de Excel (serie 46350) → 2026-11-24', fechaISO(46350) === '2026-11-24')
check('fecha inexistente (31/02) → vacía', fechaISO('31/02/2026') === null)
check('débito y crédito a la vez → error', /débito y crédito/.test(falla(() => importeDesde('10,00', '5,00', 3))))
check('débito → importe negativo; crédito → positivo', importeDesde('1.000,50', '', 1) === -1000.5 && importeDesde('', '200', 1) === 200)
check('n.º de cheque: "665 Chq: 0" no es cheque; "Chq: 00012345" → 12345', numeroCheque('665 Chq: 0') === null && numeroCheque('1 Chq: 00012345') === '12345')
check('día hábil anterior al lunes 30/11/2026 → viernes 27/11', diaHabilAnterior('2026-11-30') === '2026-11-27')
const desc = [
  { fecha: '2026-11-12', descripcion: 'b', referencia: null, importe: -10, saldo: 90, numero_cheque: null },
  { fecha: '2026-11-12', descripcion: 'a', referencia: null, importe: -20, saldo: 100, numero_cheque: null },
  { fecha: '2026-11-11', descripcion: 'x', referencia: null, importe: 120, saldo: 120, numero_cheque: null },
]
check('orden: del más nuevo al más viejo se da vuelta (por la cadena de saldos)', ordenCronologico(desc).map((m) => m.descripcion).join('') === 'xab')
check('huella sha256: igual para el mismo archivo, distinta si cambia un byte', huellaArchivo(enc.encode('abc')) === huellaArchivo(enc.encode('abc')) && huellaArchivo(enc.encode('abc')) !== huellaArchivo(enc.encode('abd')) && huellaArchivo(enc.encode('abc')).length === 64)

// ================================================================ Hipotecario · CSV
const csvHipotecario = (total = '1.401.000,40;2.000.000,00') =>
  [
    'FECHA;DESCRIPCION;SUCURSAL;REFERENCIA;DEBITO EN $;CREDITO EN $;SALDO EN $  ',
    '03/11/2026;N/D - COMISION MANTENIMIENTO DE CUENTA;0;33 Chq: 0;1.000,00;;9.000,00  ',
    '03/11/2026;DEBITO FISCAL IVA BASICO;0;33 Chq: 0;210,00;;8.790,00  ',
    '04/11/2026;N/C - TEF DATANET PROVEEDORES | 20000000001 COMPAÑIA FICTICIA SA;0;2041 Chq: 0;;2.000.000,00;2.008.790,00  ',
    '04/11/2026;N/D - IMPUESTO IMP DEB TASA GRAL;0;1684 Chq: 0;95,20;;2.008.694,80  ',
    '04/11/2026;N/D - IMPUESTO IMP DEB TASA GRAL;0;1684 Chq: 0;95,20;;2.008.599,60  ',
    '05/11/2026;N/D - CHEQUE PAGADO POR CAMARA;0;1500 Chq: 00012345;400.000,00;;1.608.599,60  ',
    '05/11/2026;N/D - TRANSF ENV INMEDIATA COELSA | 20000000002 PROVEEDOR INVENTADO;0;261 Chq: 0;999.600,00;;608.999,60  ',
    `;;;Total:;${total};  `,
    '  ',
    'El presente documento no constituye el resumen original de su Caja de Ahorro o Cuenta Corriente.',
  ].join('\n')
// Como lo baja el banco: en Windows-1252 (la Ñ en un byte).
const latin = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
let l = leerExtracto('Descarga_Movimientos (1).csv', latin(csvHipotecario()))
check('Hipotecario CSV: formato y banco', l.formato === 'HIPOTECARIO_CSV' && l.banco === 'HIPOTECARIO' && !l.tenencia)
controlar('Hipotecario CSV', l.cuentas[0], 7, 1401000.4, 2000000, 608999.6)
check('Hipotecario CSV: la Ñ se lee bien (Windows-1252)', l.cuentas[0].movimientos[2].descripcion.includes('COMPAÑIA'))
check('Hipotecario CSV: referencia y n.º de cheque', l.cuentas[0].movimientos[5].referencia === '1500 Chq: 00012345' && l.cuentas[0].movimientos[5].numero_cheque === '12345' && l.cuentas[0].movimientos[0].numero_cheque === null)
check('Hipotecario CSV: los dos impuestos iguales del mismo día quedan los dos', l.cuentas[0].movimientos.filter((m) => m.importe === -95.2).length === 2)
check('Hipotecario CSV: fechas ISO y orden cronológico', l.cuentas[0].movimientos[0].fecha === '2026-11-03' && l.cuentas[0].movimientos.at(-1)!.fecha === '2026-11-05')
check('Hipotecario CSV: los totales del banco no cierran → no se importa', /totales del archivo no cierran/.test(falla(() => leerExtracto('x.csv', latin(csvHipotecario('1.401.000,41;2.000.000,00'))))))
l = leerExtracto('x.csv', enc.encode(csvHipotecario().split('\n').filter((x) => !x.includes('Total:')).join('\r\n')))
check('Hipotecario CSV (UTF-8, CRLF, sin fila de totales): se lee y avisa', l.cuentas[0].movimientos.length === 7 && l.avisos.some((a) => /fila de totales/.test(a)))

// ================================================================ Hipotecario · Informe FCI (PDF)
const informe = (o: { adlerRoto?: boolean; cifrado?: boolean } = {}) =>
  pdf(
    [
      'RESUMEN DE CUENTA',
      'FONDO COMÚN DE INVERSIÓN',
      'CUOTAPARTISTA Nº: 000000',
      'EMPRESA FICTICIA SA',
      'FONDO: 1 - TORONTO TRUST AHORRO - Clase B - PESOS',
      'Fecha|Concepto|Valor de Cuota|Cantidad de Cuotas|Monto',
      '24/11/2026|Saldo Anterior|50,000000|200,000000|10.000,00',
      'Total de su Inversión al 25/11/2026|$ 50,027500|200,00000000|$ 10.005,50',
      'Las inversiones en cuotapartes no constituyen depósitos en BACS (texto legal inventado).',
    ],
    o,
  )
l = leerExtracto('Informe_FCI_1.pdf', informe({ adlerRoto: true }))
check('Hipotecario FCI PDF: formato tenencia', l.formato === 'HIPOTECARIO_FCI_PDF' && l.tenencia)
check('Hipotecario FCI PDF: sin movimientos', l.cuentas[0].movimientos.length === 0)
check('Hipotecario FCI PDF: saldo anterior 24/11 = 10000 y total 25/11 = 10005.50', JSON.stringify(l.cuentas[0].saldos) === JSON.stringify([{ fecha: '2026-11-24', saldo: 10000 }, { fecha: '2026-11-25', saldo: 10005.5 }]), JSON.stringify(l.cuentas[0].saldos))
check('Hipotecario FCI PDF: dice qué fondo es (tildes en otra fuente bien pegadas)', l.avisos.some((a) => a === 'FONDO: 1 - TORONTO TRUST AHORRO - Clase B - PESOS'))
check('PDF cifrado (como el resumen de Mercado Pago): pide otro formato', /cifrado/.test(falla(() => leerExtracto('account_statement.pdf', informe({ cifrado: true })))))

// ================================================================ Brubank · XLSX (CC + remunerada en el mismo archivo)
const brubank = (moneda = 'ARS') =>
  xlsx([
    ['Fecha', 'Referencia', 'Descripcion', 'Moneda', 'Creditos', 'Debitos', 'Saldo', 'Cuenta'],
    ['30-10-26', '1000000001', 'Cobro Interese por Sobregiro', 'ARS', '-', '$ 5,00', '- $ 5,00', 'Cuenta corriente'],
    ['02-11-26', '1000000002', 'Retiro de tu cuenta remunerada', 'ARS', '$ 5,00', '-', '$ 0,00', 'Cuenta corriente'],
    ['05-11-26', '1000000003', 'EMPRESA FICTICIA SA', moneda, '$ 1.000.000,00', '-', '$ 1.000.000,00', 'Cuenta corriente'],
    ['05-11-26', '1000000004', 'Proveedor Inventado', 'ARS', '-', '$ 400.000,00', '$ 600.000,00', 'Cuenta corriente'],
    ['05-11-26', '1000000004', 'Impuesto Ley 25413 s/de', 'ARS', '-', '$ 2.400,00', '$ 597.600,00', 'Cuenta corriente'],
    ['05-11-26', '1000000005', 'Fondeo de tu cuenta remunerada', 'ARS', '-', '$ 597.600,00', '$ 0,00', 'Cuenta corriente'],
    ['26-10-26', '1000000010', 'Intereses pagados', 'ARS', '$ 100,00', '-', '$ 50.100,00', 'Cuenta remunerada'],
    ['02-11-26', '1000000002', 'Retiro de cuenta remunerada', 'ARS', '-', '$ 5,00', '$ 50.095,00', 'Cuenta remunerada'],
    ['05-11-26', '1000000005', 'Depósito en cuenta remunerada', 'ARS', '$ 597.600,00', '-', '$ 647.695,00', 'Cuenta remunerada'],
    ['06-11-26', '1000000011', 'Intereses pagados', 'ARS', '$ 300,25', '-', '$ 647.995,25', 'Cuenta remunerada'],
  ])
l = leerExtracto('Estado de cuenta Brubank EMPRESA 2026-10-26 al 2026-11-25.xlsx', brubank())
check('Brubank XLSX: formato', l.formato === 'BRUBANK_XLSX' && l.banco === 'BRUBANK')
check('Brubank XLSX: se separa en CC y REMUNERADA', l.cuentas.map((c) => c.parte).join() === 'CC,REMUNERADA')
controlar('Brubank CC', l.cuentas[0], 6, 1000005, 1000005, 0)
controlar('Brubank Remunerada', l.cuentas[1], 4, 5, 598000.25, 647995.25)
check('Brubank: saldo negativo "- $ 5,00" → -5', l.cuentas[0].movimientos[0].saldo === -5)
check('Brubank: la referencia queda como texto', l.cuentas[0].movimientos[0].referencia === '1000000001')
check('Brubank: un movimiento en dólares no se importa', /USD/.test(falla(() => leerExtracto('b.xlsx', brubank('USD')))))
l = leerExtracto('b.xlsx', xlsx([['Fecha', 'Referencia', 'Descripcion', 'Moneda', 'Creditos', 'Debitos', 'Saldo', 'Cuenta'], ['01-11-26', '1', 'x', 'ARS', '$ 1,00', '-', '$ 1,00', 'Cuenta remunerada']], { comprimir: false }))
check('Brubank (ZIP sin comprimir, solo remunerada): una sola parte', l.cuentas.length === 1 && l.cuentas[0].parte === 'REMUNERADA')

// ================================================================ Galicia · XLSX
const galiciaFilas: Celda[][] = [
  ['Fecha', 'Descripción', 'Origen', 'Débitos', 'Créditos', 'Grupo de Conceptos', 'Concepto', 'Número de Terminal', 'Observaciones Cliente', 'Número de Comprobante', 'Leyendas Adicionales 1', 'Leyendas Adicionales 2', 'Leyendas Adicionales 3', 'Leyendas Adicionales 4', 'Tipo de Movimiento', 'Saldo'],
  [d('2026-11-02'), 'Comision Servicio De Cuenta', '', 10000, 0, '000808 - Comisiones', '907394 - COMISION SERVICIO DE CUENTA', '', '', '', 'Octubre 2026', '', '', '', 'Imputado', -10000],
  [d('2026-11-02'), 'Iva', '', 2100, 0, '000901 - Impuestos', '907171 - IVA', '', '', '', 'Octubre 2026', '', '', '', 'Imputado', -12100],
  [d('2026-11-02'), 'Imp. Deb. Ley 25413 Gral.', '', 72.6, 0, '000901 - Impuestos', '907176 - IMP. DEB. LEY 25413', '', '', '', '', '', '', '', 'Imputado', -12172.6],
  [d('2026-11-03'), 'Transferencia De Cuenta Propia', '', 0, 50000, '000907 - Transferencias', '917152 - TRANSFERENCIA DE CUENTA PROPIA', 'TERM0000', '', '777', 'EMPRESA FICTICIA SA', '', '', '', 'Imputado', 37827.4],
]
for (const fechas of ['d', 'serie'] as const) {
  l = leerExtracto('Extracto_CC000000000.xlsx', xlsx(galiciaFilas, { textoEnLinea: true, fechas, hoja: 'Movimientos' }))
  check(`Galicia XLSX (fechas ${fechas === 'd' ? 'tipo fecha' : 'número con formato de fecha'}): formato`, l.formato === 'GALICIA_XLSX')
  controlar(`Galicia (${fechas})`, l.cuentas[0], 4, 12172.6, 50000, 37827.4)
  check(`Galicia (${fechas}): fechas`, l.cuentas[0].movimientos.map((m) => m.fecha).join() === '2026-11-02,2026-11-02,2026-11-02,2026-11-03')
}
check('Galicia: la descripción suma concepto y leyendas (para las reglas)', l.cuentas[0].movimientos[2].descripcion === 'Imp. Deb. Ley 25413 Gral. · 000901 - Impuestos · 907176 - IMP. DEB. LEY 25413 · Imputado', l.cuentas[0].movimientos[2].descripcion)
check('Galicia: referencia = n.º de comprobante', l.cuentas[0].movimientos[3].referencia === '777' && l.cuentas[0].movimientos[0].referencia === null)

// ================================================================ Credicoop · XLS (chico: va en el mini flujo)
const credicoop = xls([
  ['Fecha', 'Concepto', 'Nro.Cpbte.', 'Débito', 'Crédito', 'Saldo', 'Cód.'],
  ['12/11/2026', 'Impuesto Ley 25.413 Ali Gral s/Debitos', 0, 300, 0, 49700, 'IDCC3'],
  ['12/11/2026', 'Debito Automatico Directo PROVEEDOR FICTICIO-0000000000000000000001', 111, 20000, 0, 50000, 2499],
  [],
  ['12/11/2026', 'Debito Automatico Directo PROVEEDOR FICTICIO-0000000000000000000001', 111, 30000, 0, 70000, 2499],
  [],
  ['04/11/2026', 'Transferencia Inmediata e/Ctas. Propias 30000000000-VAR-EMPRESA FICTICIA SA', 222, 0, 100000, 100000, 1871],
])
l = leerExtracto('SaldMovs_CC-000-000000-0_25-11-2026.xls', credicoop)
check('Credicoop XLS: formato', l.formato === 'CREDICOOP_XLS' && l.banco === 'CREDICOOP')
controlar('Credicoop', l.cuentas[0], 4, 50300, 100000, 49700)
check('Credicoop: viene del más nuevo al más viejo → queda en orden', l.cuentas[0].movimientos.map((m) => m.saldo).join() === '100000,70000,50000,49700')
check('Credicoop: referencia numérica como texto; 0 = sin referencia', l.cuentas[0].movimientos[0].referencia === '222' && l.cuentas[0].movimientos[3].referencia === null)
check('Credicoop: la cadena de saldos cierra (sin avisos)', l.avisos.length === 0, l.avisos.join())

// ================================================================ Macro · XLS (grande: va en sectores comunes, SST partida)
const macro = (moneda = 'PESOS') =>
  xls(
    [
      ['Últimos Movimientos'],
      [],
      ['CUENTA CORRIENTE BANCARIA'],
      [],
      ['Tipo', null, 'Cuenta Corriente'],
      ['Número', null, '000000000000001'],
      ['Moneda', null, moneda],
      ['Fecha', 'Nro. de Referencia', 'Causal', 'Concepto', 'Importe', 'Saldo'],
      [d('2026-11-24'), '1000000001', '1684', 'DBCR 25413 S/DB TASA GRAL', -150, 24850.55],
      [d('2026-11-24'), '900001', '4213', 'LABEL:TRANSF 20000000001 FAC 00000001', -25000, 25000.55],
      [d('2026-11-23'), '900000', '4213', 'TRANSF RECIBIDA EMPRESA FICTICIA', 50000.55, 50000.55],
      ['Fecha de descarga: 25/11/2026 09:56:08'],
      ['Empresa: 30000000000 - EMPRESA FICTICIA SA'],
      ['Operador: persona inventada'],
    ],
    { relleno: 5000 },
  )
l = leerExtracto('Ultimos_Movimientos (2).xls', macro())
check('Macro XLS: formato', l.formato === 'MACRO_XLS' && l.banco === 'MACRO')
controlar('Macro', l.cuentas[0], 3, 25150, 50000.55, 24850.55)
check('Macro: fecha de Excel → ISO y orden cronológico', l.cuentas[0].movimientos.map((m) => m.fecha).join() === '2026-11-23,2026-11-24,2026-11-24')
check('Macro: dentro del día, primero la transferencia y después el impuesto (cadena de saldos)', l.cuentas[0].movimientos[1].descripcion.startsWith('TRANSF 2') && l.cuentas[0].movimientos[2].descripcion.startsWith('DBCR'))
check('Macro: el pie del informe no son movimientos', !l.cuentas[0].movimientos.some((m) => /descarga|Operador/i.test(m.descripcion)))
check('Macro: una cuenta en dólares no se importa', /DOLARES/.test(falla(() => leerExtracto('u.xls', macro('DOLARES')))))

// ================================================================ Macro · Tenencia FCI (XLS)
const tenencia = (descarga: string) =>
  xls(
    [
      ['Tenencias en FCI'],
      [],
      ['Nombre', 'Tenencias a la fecha', 'Cuotapartes', 'Ultimo valor de cuota disponible'],
      ['FONDO FICTICIO PESOS (Money Market) - Clase B', 1000000.5, 15000.1234, 66.665],
      ['OTRO FONDO INVENTADO - Clase A', 250000.25, 1000, 250.00025],
      [`Fecha de descarga: ${descarga} 09:58:08`],
      ['Empresa: 30000000000 - EMPRESA FICTICIA SA'],
      ['Operador: persona inventada'],
    ],
    { usarRk: true },
  )
l = leerExtracto('consulta_tenencias_FCI.xls', tenencia('25/11/2026'))
check('Macro FCI: formato tenencia, sin movimientos', l.formato === 'MACRO_FCI_TENENCIA_XLS' && l.tenencia && l.cuentas[0].movimientos.length === 0)
check('Macro FCI: saldo = suma de los fondos, al día hábil anterior a la descarga (24/11)', JSON.stringify(l.cuentas[0].saldos) === JSON.stringify([{ fecha: '2026-11-24', saldo: 1250000.75 }]), JSON.stringify(l.cuentas[0].saldos))
l = leerExtracto('consulta_tenencias_FCI.xls', tenencia('30/11/2026'))
check('Macro FCI: descarga del lunes 30/11 → saldo del viernes 27/11', l.cuentas[0].saldos[0].fecha === '2026-11-27')
l = leerExtracto('consulta_tenencias_FCI.xls', tenencia('30/11/2026'), { fechaTenencia: '2026-11-30' })
check('Macro FCI: la fecha se puede indicar a mano', l.cuentas[0].saldos[0].fecha === '2026-11-30' && l.avisos[0].includes('a mano'))

// ================================================================ Formatos que no se reconocen
check('CSV desconocido: dice qué bancos faltan', /ICBC.*\[?FALTA|Sin lector todavía: ICBC/.test(falla(() => leerExtracto('x.csv', enc.encode('a;b;c\n1;2;3')))))
check('HTML guardado como .xls: pide guardarlo como .xlsx', /página web/.test(falla(() => leerExtracto('x.xls', enc.encode('<html><table><tr><td>1</td></tr></table></html>')))))
check('archivo binario cualquiera: no se reconoce', /No se reconoce/.test(falla(() => leerExtracto('x.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0])))))
check('los bancos sin ejemplo quedan listados como [FALTA ejemplo]', ['ICBC', 'SANTANDER', 'CHUBUT', 'MP', 'BBVA'].every((b) => PENDIENTES.some((p) => p.banco === b && p.nota.includes('[FALTA ejemplo]'))))

// ================================================================ POST /api/bancos/extracto
const ORG = 'org-prueba'
function mundo(extra: { extractos?: Fila[]; cuentas?: Fila[] } = {}): Mundo {
  return simular({
    sesiones: { teso: 'teso@prueba.com', aprob: 'aprob@prueba.com', otra: 'otra@prueba.com' },
    tablas: {
      usuarios: [
        { email: 'teso@prueba.com', nombre: 'Tesorería', rol: 'TESORERIA', activo: true, todas_empresas: false },
        { email: 'aprob@prueba.com', nombre: 'Aprobador', rol: 'APROBADOR', activo: true, todas_empresas: false },
        { email: 'otra@prueba.com', nombre: 'Tesorería de otra empresa', rol: 'TESORERIA', activo: true, todas_empresas: false },
      ],
      empresas: [{ id: 'india', nombre: 'Empresa de prueba', activa: true }],
      cuentas_origen: extra.cuentas ?? [
        { id: 'c-bru', empresa_id: 'india', nombre: 'BRUBANK CC', banco: 'BRUBANK', clase: 'CC', cuenta_madre_id: null, activa: true },
        { id: 'c-rem', empresa_id: 'india', nombre: 'BRUBANK REMUNERADA', banco: 'BRUBANK', clase: 'REMUNERADA', cuenta_madre_id: 'c-bru', activa: true },
        { id: 'c-hip', empresa_id: 'india', nombre: 'HIPOTECARIO CA', banco: 'HIPOTECARIO', clase: 'CA', cuenta_madre_id: null, activa: true },
        { id: 'c-fci', empresa_id: 'india', nombre: 'HIPOTECARIO FCI', banco: 'HIPOTECARIO', clase: 'FCI', cuenta_madre_id: 'c-hip', activa: true },
      ],
      extractos: extra.extractos ?? [],
    },
    rpc: {
      usuario_ve_empresa: (a) => a.p_email !== 'otra@prueba.com' && a.p_empresa === 'india',
      importar_extracto: (a) => {
        const p = a.p as { movimientos: unknown[] }
        return { extracto_id: 'ext-' + Math.random(), repetido: false, movimientos: p.movimientos.length, nuevos: p.movimientos.length }
      },
    },
  })
}
const pedirJson = (token: string, cuerpo: unknown) =>
  new Request('http://sitio.prueba/api/bancos/extracto', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const importaciones = (m: Mundo) => m.pedidos.filter((p) => p.ruta.endsWith('/rpc/importar_extracto')).map((p) => (p.cuerpo as { p: Record<string, unknown> }).p)
const largo = (x: unknown) => (Array.isArray(x) ? x.length : -1)
const subidas = (m: Mundo) => m.pedidos.filter((p) => p.ruta.startsWith('/storage/'))

let m = mundo()
let r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-bru', nombre: 'Brubank.xlsx', data: b64(brubank()) }))
let cuerpo = await r.json()
let imp = importaciones(m)
check('Brubank desde la CC: una importación por cuenta (CC y remunerada)', r.status === 200 && imp.map((p) => p.cuenta_origen_id).join() === 'c-bru,c-rem', `${r.status} ${JSON.stringify(cuerpo)}`)
check('…cada una con sus movimientos (6 y 4) y la misma huella del archivo', largo(imp[0]?.movimientos) === 6 && largo(imp[1]?.movimientos) === 4 && (imp[0]?.archivo as Fila)?.hash === huellaArchivo(brubank()))
check('…con el formato y quien importó', (imp[0]?.archivo as Fila)?.formato === 'BRUBANK_XLSX' && imp[0]?.usuario === 'teso@prueba.com')
const path = String((imp[0]?.archivo as Fila)?.path ?? '')
check('…el archivo se guardó una vez, en <organización>/<empresa>/extractos/', subidas(m).length === 1 && path.startsWith(`${ORG}/india/extractos/`) && subidas(m)[0].ruta.includes(path), path)
check('…el resumen trae débitos, créditos y saldo final por cuenta', cuerpo.cuentas?.[1]?.saldo_final === 647995.25 && cuerpo.cuentas?.[0]?.debitos === 1000005 && cuerpo.cuentas?.[1]?.filas === 4, JSON.stringify(cuerpo.cuentas?.[1]))

m = mundo()
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-rem', nombre: 'Brubank.xlsx', data: b64(brubank()) }))
imp = importaciones(m)
check('Brubank subido desde la remunerada: también reparte en las dos', r.status === 200 && imp.map((p) => p.cuenta_origen_id).join() === 'c-bru,c-rem')

m = mundo({ cuentas: [{ id: 'c-bru', empresa_id: 'india', nombre: 'BRUBANK CC', banco: 'BRUBANK', clase: 'CC', cuenta_madre_id: null, activa: true }] })
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-bru', nombre: 'Brubank.xlsx', data: b64(brubank()) }))
cuerpo = await r.json()
check('Brubank sin la remunerada cargada: no importa nada (ni la CC) y lo dice', r.status === 422 && /remunerada/.test(cuerpo.error) && importaciones(m).length === 0 && subidas(m).length === 0, cuerpo.error)

const hash = huellaArchivo(brubank())
m = mundo({ extractos: [{ id: 'e1', cuenta_origen_id: 'c-bru', archivo_hash: hash }, { id: 'e2', cuenta_origen_id: 'c-rem', archivo_hash: hash }] })
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-bru', nombre: 'Brubank.xlsx', data: b64(brubank()) }))
check('el mismo archivo otra vez: no se vuelve a guardar en Storage', r.status === 200 && subidas(m).length === 0)

m = mundo()
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-fci', nombre: 'Informe_FCI.pdf', data: b64(informe()) }))
imp = importaciones(m)
check('tenencia del FCI a la cuenta FCI: saldos sin movimientos', r.status === 200 && largo(imp[0]?.movimientos) === 0 && largo(imp[0]?.saldos) === 2)

m = mundo()
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-hip', nombre: 'Informe_FCI.pdf', data: b64(informe()) }))
cuerpo = await r.json()
check('tenencia del FCI a la CA: rechazada (elegí la cuenta FCI)', r.status === 422 && /cuenta FCI/.test(cuerpo.error) && importaciones(m).length === 0, cuerpo.error)

m = mundo()
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-hip', nombre: 'Brubank.xlsx', data: b64(brubank()) }))
cuerpo = await r.json()
check('archivo de Brubank en la cuenta del Hipotecario: rechazado', r.status === 422 && /BRUBANK/.test(cuerpo.error) && subidas(m).length === 0, cuerpo.error)

m = mundo()
r = await importar(pedirJson('teso', { cuentaOrigenId: 'c-hip', nombre: 'x.csv', data: b64(enc.encode('a;b\n1;2')) }))
cuerpo = await r.json()
check('formato desconocido: 422 con la lista de lo que falta', r.status === 422 && /No se reconoce el formato/.test(cuerpo.error))

m = mundo()
r = await importar(pedirJson('aprob', { cuentaOrigenId: 'c-hip', nombre: 'x.csv', data: b64(latin(csvHipotecario())) }))
check('un aprobador no importa extractos (rol)', r.status === 403 && importaciones(m).length === 0)

m = mundo()
r = await importar(pedirJson('otra', { cuentaOrigenId: 'c-hip', nombre: 'x.csv', data: b64(latin(csvHipotecario())) }))
check('Tesorería de otra empresa no importa en esta (exigirEmpresa)', r.status === 403 && importaciones(m).length === 0 && subidas(m).length === 0)

m = mundo()
const form = new FormData()
form.set('cuentaOrigenId', 'c-hip')
form.set('archivo', new Blob([Buffer.from(latin(csvHipotecario()))], { type: 'text/csv' }), 'Descarga_Movimientos (1).csv')
r = await importar(new Request('http://sitio.prueba/api/bancos/extracto', { method: 'POST', headers: { Authorization: 'Bearer teso' }, body: form }))
cuerpo = await r.json()
imp = importaciones(m)
check('multipart: el CSV del Hipotecario se importa en la CA', r.status === 200 && imp[0]?.cuenta_origen_id === 'c-hip' && largo(imp[0]?.movimientos) === 7, JSON.stringify(cuerpo))
check('…con el nombre original del archivo', (imp[0]?.archivo as Fila)?.nombre === 'Descarga_Movimientos (1).csv')


// ================================================================ T-205 · Contrato pantalla ↔ endpoint
// La pantalla Bancos manda { cuentaOrigenId, nombre, mimeType, data } y lee la respuesta con
// leerResultadoExtracto (src/data/resultadoExtracto.ts). Se prueba con la respuesta REAL de la función.
const { leerResultadoExtracto } = await import('../../src/data/resultadoExtracto.ts')
/** Como la base con 0029: devuelve a_revisar (1 por cuenta) y el origen de los saldos que recibió. */
function con0029(m: Mundo, repetido = false) {
  m.rpc.importar_extracto = (a) => {
    const p = a.p as { movimientos: unknown[]; origen_saldos?: string }
    return repetido
      ? { extracto_id: 'e-viejo', repetido: true, movimientos: 0, nuevos: 0, a_revisar: 0, origen_saldos: p.origen_saldos ?? 'EXTRACTO' }
      : { extracto_id: 'ext-' + Math.random(), repetido: false, movimientos: p.movimientos.length, nuevos: p.movimientos.length, a_revisar: p.movimientos.length ? 1 : 0, saldos: 1, origen_saldos: p.origen_saldos ?? 'EXTRACTO' }
  }
  return m
}
const comoPantalla = (cuenta: string, nombre: string, bytes: Uint8Array, extra: Record<string, string> = {}) =>
  pedirJson('teso', { cuentaOrigenId: cuenta, nombre, mimeType: 'application/octet-stream', data: b64(bytes), ...extra })

// Brubank (dos cuentas)
m = con0029(mundo())
r = await importar(comoPantalla('c-bru', 'Brubank.xlsx', brubank()))
cuerpo = await r.json()
let res = leerResultadoExtracto(cuerpo)
check('contrato: el pedido de la pantalla (con mimeType) se acepta', r.status === 200, JSON.stringify(cuerpo).slice(0, 200))
check('contrato: la respuesta trae repetido, movimientos, nuevos y a_revisar arriba (suma de las cuentas)',
  cuerpo.repetido === false && cuerpo.movimientos === 10 && cuerpo.nuevos === 10 && cuerpo.a_revisar === 2 && cuerpo.formato === 'BRUBANK_XLSX', JSON.stringify({ r: cuerpo.repetido, m: cuerpo.movimientos, n: cuerpo.nuevos, a: cuerpo.a_revisar }))
check('contrato: la pantalla lee 10 nuevos de 10, 2 a revisar, formato BRUBANK_XLSX',
  res.repetido === false && res.nuevos === 10 && res.movimientos === 10 && res.aRevisar === 2 && res.formato === 'BRUBANK_XLSX' && res.tenencia === false)
check('contrato Brubank: una línea por cuenta (CC 6 y remunerada 4), con su saldo final',
  res.cuentas?.length === 2 && res.cuentas[0].parte === 'CC' && res.cuentas[0].nuevos === 6 && res.cuentas[1].parte === 'REMUNERADA' && res.cuentas[1].cuentaId === 'c-rem' && res.cuentas[1].saldoFinal === 647995.25, JSON.stringify(res.cuentas))
check('contrato Brubank: el detalle nombra las dos cuentas', /BRUBANK CC: 6 nuevo\(s\) de 6/.test(res.detalle ?? '') && /BRUBANK REMUNERADA: 4 nuevo\(s\) de 4/.test(res.detalle ?? ''), res.detalle)
check('Brubank: los saldos van con origen EXTRACTO (no es tenencia)', importaciones(m).every((p) => p.origen_saldos === 'EXTRACTO'))

// Brubank con dos remuneradas: la pantalla tiene que decir cuál
const dosRem = [
  { id: 'c-bru', empresa_id: 'india', nombre: 'BRUBANK CC', banco: 'BRUBANK', clase: 'CC', cuenta_madre_id: null, activa: true },
  { id: 'c-rem', empresa_id: 'india', nombre: 'BRUBANK REMUNERADA', banco: 'BRUBANK', clase: 'REMUNERADA', cuenta_madre_id: 'c-bru', activa: true },
  { id: 'c-rem2', empresa_id: 'india', nombre: 'BRUBANK REMUNERADA 2', banco: 'BRUBANK', clase: 'REMUNERADA', cuenta_madre_id: 'c-bru', activa: true },
]
m = con0029(mundo({ cuentas: dosRem }))
r = await importar(comoPantalla('c-bru', 'Brubank.xlsx', brubank()))
cuerpo = await r.json()
check('Brubank con dos remuneradas y sin elegir: 409 y no importa nada', r.status === 409 && /cuentaRemuneradaId/.test(cuerpo.error) && importaciones(m).length === 0, cuerpo.error)
m = con0029(mundo({ cuentas: dosRem }))
r = await importar(comoPantalla('c-bru', 'Brubank.xlsx', brubank(), { cuentaRemuneradaId: 'c-rem2' }))
res = leerResultadoExtracto(await r.json())
check('…eligiendo la remunerada en la pantalla (cuentaRemuneradaId): va a esa', r.status === 200 && importaciones(m).map((p) => p.cuenta_origen_id).join() === 'c-bru,c-rem2' && res.cuentas?.[1]?.cuentaId === 'c-rem2')

// Tenencia FCI (PDF del Hipotecario): origen TENENCIA
m = con0029(mundo())
r = await importar(comoPantalla('c-fci', 'Informe_FCI.pdf', informe()))
cuerpo = await r.json()
res = leerResultadoExtracto(cuerpo)
imp = importaciones(m)
check('tenencia: el endpoint pide origen_saldos TENENCIA a importar_extracto (0029)', imp.length === 1 && imp[0].origen_saldos === 'TENENCIA' && largo(imp[0].movimientos) === 0, JSON.stringify(imp[0]?.origen_saldos))
check('tenencia: la pantalla ve tenencia, 0 movimientos, saldo final 10.005,50 y origen TENENCIA',
  res.tenencia === true && res.nuevos === 0 && res.cuentas?.[0]?.origenSaldos === 'TENENCIA' && res.cuentas?.[0]?.saldoFinal === 10005.5 && res.cuentas?.[0]?.hasta === '2026-11-25', JSON.stringify(res.cuentas))
check('tenencia: el detalle dice la fecha y el saldo', /tenencia al 25\/11\/2026 \$ 10\.005,50/.test(res.detalle ?? ''), res.detalle)

// Tenencia de Macro con la fecha indicada en la pantalla
const conMacro = [
  { id: 'c-mac', empresa_id: 'india', nombre: 'MACRO CC', banco: 'MACRO', clase: 'CC', cuenta_madre_id: null, activa: true },
  { id: 'c-mfci', empresa_id: 'india', nombre: 'MACRO FCI', banco: 'MACRO', clase: 'FCI', cuenta_madre_id: 'c-mac', activa: true },
]
m = con0029(mundo({ cuentas: conMacro }))
r = await importar(comoPantalla('c-mfci', 'consulta_tenencias_FCI.xls', tenencia('30/11/2026'), { fechaTenencia: '2026-11-30' }))
imp = importaciones(m)
check('tenencia Macro con fechaTenencia desde la pantalla: saldo al 30/11 y origen TENENCIA',
  r.status === 200 && (imp[0]?.saldos as Fila[])?.[0]?.fecha === '2026-11-30' && imp[0]?.origen_saldos === 'TENENCIA', JSON.stringify(imp[0]?.saldos))

// Repetido en las dos cuentas
m = con0029(mundo({ extractos: [{ id: 'e1', cuenta_origen_id: 'c-bru', archivo_hash: hash }, { id: 'e2', cuenta_origen_id: 'c-rem', archivo_hash: hash }] }), true)
r = await importar(comoPantalla('c-bru', 'Brubank.xlsx', brubank()))
res = leerResultadoExtracto(await r.json())
check('repetido: la pantalla ve "ya estaba importado" (repetido, 0 nuevos, 0 movimientos)', res.repetido === true && res.nuevos === 0 && res.movimientos === 0 && /ya estaba importado/.test(res.detalle ?? ''), JSON.stringify(res))

// Base sin 0029 (respuesta vieja de importar_extracto, sin a_revisar): sigue andando
m = mundo()
r = await importar(comoPantalla('c-hip', 'x.csv', latin(csvHipotecario())))
res = leerResultadoExtracto(await r.json())
check('base sin 0029: a_revisar 0 y el resto igual', r.status === 200 && res.aRevisar === 0 && res.nuevos === 7 && res.movimientos === 7)
check('respuesta vieja de la función (solo "cuentas"): la pantalla igual suma',
  (() => { const v = leerResultadoExtracto({ cuentas: [{ cuenta_origen_id: 'a', cuenta: 'A', parte: 'CC', nuevos: 2, movimientos: 3 }, { cuenta_origen_id: 'b', cuenta: 'B', parte: 'REMUNERADA', nuevos: 1, movimientos: 1, repetido: true }] }); return v.nuevos === 3 && v.movimientos === 4 && v.repetido === false })())

// ================================================================ ¿El archivo es de la cuenta elegida? (T-208, revisión T-207 hallazgo 9)
const { verificarCuentaDelArchivo } = await import('../functions/lib/extractos/cuenta-del-archivo.ts')
const caH = { id: 'h-ca', nombre: 'HIPOTECARIO CA', numero: '4-001-0000111222-3', cbu: null }
const ccH = { id: 'h-cc', nombre: 'HIPOTECARIO CC', numero: '3-001-0000999888-7', cbu: '0440001130000099988870' }
check('cuenta del archivo: el número de la elegida está en el nombre → coincide', verificarCuentaDelArchivo('Extracto_CA40010000111222 3.csv', '', caH, [ccH]).estado === 'COINCIDE')
check('…los últimos dígitos en el nombre alcanzan', verificarCuentaDelArchivo('SaldMovs_CA-1112223.csv', '', caH, [ccH]).estado === 'COINCIDE')
const otra = verificarCuentaDelArchivo('SaldMovs_CC-0009998887.csv', '', caH, [ccH])
check('…el número de OTRA cuenta del banco → no es de la elegida', otra.estado === 'OTRA' && otra.cuenta.id === 'h-cc')
check('…el CBU en el encabezado del CSV también cuenta', verificarCuentaDelArchivo('movimientos.csv', 'Cuenta;CBU 0440001130000099988870\nFecha;Importe', caH, [ccH]).estado === 'OTRA')
check('…una fecha en el nombre no se confunde con un número de cuenta', verificarCuentaDelArchivo('extracto_20261124.csv', '', { ...caH, numero: '5520261124' }, [ccH]).estado === 'SIN_DATOS')
const sinDatos = verificarCuentaDelArchivo('extracto.csv', '', caH, [ccH])
check('…sin número en el archivo y con otra cuenta posible: avisa', sinDatos.estado === 'SIN_DATOS' && /revisá que sea de HIPOTECARIO CA/.test(sinDatos.aviso ?? ''))
const unica = verificarCuentaDelArchivo('extracto.csv', '', caH, [])
check('…sin otra cuenta del banco: no hay nada que avisar', unica.estado === 'SIN_DATOS' && unica.aviso === null)

const dosDelBanco = [
  { id: 'c-hip', empresa_id: 'india', nombre: 'HIPOTECARIO CA', banco: 'HIPOTECARIO', clase: 'CA', cuenta_madre_id: null, activa: true, numero: '4-001-0000111222-3' },
  { id: 'c-hcc', empresa_id: 'india', nombre: 'HIPOTECARIO CC', banco: 'HIPOTECARIO', clase: 'CC', cuenta_madre_id: null, activa: true, numero: '3-001-0000999888-7' },
  { id: 'c-sinb', empresa_id: 'india', nombre: 'CUENTA SIN BANCO', banco: null, clase: 'CC', cuenta_madre_id: null, activa: true },
]
m = mundo({ cuentas: dosDelBanco })
r = await importar(comoPantalla('c-hip', 'SaldMovs_CC-0009998887.csv', latin(csvHipotecario())))
cuerpo = await r.json()
check('extracto de la CC subido en la CA del mismo banco: no importa nada y dice de cuál es', r.status === 422 && /parece de HIPOTECARIO CC/.test(cuerpo.error) && importaciones(m).length === 0 && subidas(m).length === 0, cuerpo.error)
m = mundo({ cuentas: dosDelBanco })
r = await importar(comoPantalla('c-hcc', 'SaldMovs_CC-0009998887.csv', latin(csvHipotecario())))
check('…subido en su cuenta: entra', r.status === 200 && importaciones(m).length === 1 && importaciones(m)[0].cuenta_origen_id === 'c-hcc')
m = mundo({ cuentas: dosDelBanco })
r = await importar(comoPantalla('c-hip', 'x.csv', latin(csvHipotecario())))
cuerpo = await r.json()
check('…archivo sin número con dos cuentas del banco: entra con un aviso para revisar', r.status === 200 && (cuerpo.avisos as string[]).some((a) => /revisá que sea de HIPOTECARIO CA/.test(a)), JSON.stringify(cuerpo.avisos))
m = mundo({ cuentas: dosDelBanco })
r = await importar(comoPantalla('c-sinb', 'x.csv', latin(csvHipotecario())))
cuerpo = await r.json()
check('cuenta sin banco cargado: ya no acepta cualquier archivo', r.status === 422 && /no tiene el banco cargado/.test(cuerpo.error) && importaciones(m).length === 0, cuerpo.error)

cerrar()
