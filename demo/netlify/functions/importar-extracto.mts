// POST /api/bancos/extracto
// Tesorería sube el archivo tal como lo baja del banco y el sistema lo lee, lo guarda y lo importa.
//   · multipart/form-data: campos cuentaOrigenId, archivo (el archivo), y opcionales cuentaRemuneradaId, fechaTenencia
//   · JSON: { cuentaOrigenId, nombre, data (base64), mimeType?, cuentaRemuneradaId?, fechaTenencia? }
//     (es lo que manda la pantalla Bancos; mimeType es informativo: el formato se detecta por el contenido)
// Respuesta (contrato con src/data/resultadoExtracto.ts):
//   { ok, repetido, movimientos, nuevos, a_revisar, formato, banco, tenencia, detalle, avisos, archivo,
//     cuentas: [{ cuenta_origen_id, cuenta, parte, repetido, movimientos, nuevos, a_revisar, origen_saldos,
//                 filas, debitos, creditos, desde, hasta, saldo_final, saldos, resultado }] }
//   repetido = el archivo ya estaba importado en TODAS sus cuentas; los totales suman las cuentas.
// Pasos: lee el archivo (detecta banco y formato por el contenido) → controla que sea de la cuenta elegida
// (mismo banco y, si el archivo trae el número de cuenta o el CBU, que no sea el de otra cuenta de ese banco;
// tenencia de FCI solo a una cuenta FCI/remunerada) → si ya se importó, no hace nada → guarda
// el archivo en <organización>/<empresa>/extractos/… → llama a importar_extracto (una vez por cuenta).
// Brubank trae la CC y la remunerada en el mismo Excel: cada parte va a su cuenta (la remunerada es la que
// tiene como cuenta madre a la CC, o la que se indique en cuentaRemuneradaId).
// Una tenencia de FCI (informe del fondo) guarda sus saldos con origen TENENCIA (0029); lo demás, EXTRACTO.

import type { Config } from '@netlify/functions'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ErrorHttp, exigirEmpresa, exigirRol, json, manejar, supabaseAdmin, usuarioDesde, type UsuarioFn } from './lib/comun'
import { ErrorExtracto, leerExtracto, totales, type CuentaLeida, type Leido } from './lib/extractos/index'
import { verificarCuentaDelArchivo } from './lib/extractos/cuenta-del-archivo'

/** Netlify corta los pedidos de más de 6 MB; en base64 eso es un archivo de unos 4 MB. */
const MAX_BYTES = 4 * 1024 * 1024
/**
 * Bucket privado donde quedan los extractos. Se usa "comprobantes" porque su regla de lectura ya es por
 * carpeta <organización>/<empresa>/ (0019): lo ve quien ve esa empresa. Pendiente: un bucket propio.
 */
const BUCKET = 'comprobantes'

interface Cuenta {
  id: string
  empresa_id: string
  nombre: string
  banco: string | null
  clase: string
  cuenta_madre_id: string | null
  activa: boolean
  numero?: string | null
  cbu?: string | null
}
const COLUMNAS_CUENTA = 'id, empresa_id, nombre, banco, clase, cuenta_madre_id, activa, numero, cbu'
const CLASES_TENENCIA = ['FCI', 'REMUNERADA']

interface Pedido {
  cuentaOrigenId: string
  nombre: string
  bytes: Uint8Array
  cuentaRemuneradaId?: string
  fechaTenencia?: string
  /** "Subir igual": el extracto parece ya cargado en otra empresa y Tesorería confirma que es esta cuenta. */
  confirmarOtraEmpresa?: boolean
}

async function leerPedido(req: Request): Promise<Pedido> {
  const tipo = req.headers.get('content-type') ?? ''
  let p: Partial<Pedido> = {}
  if (tipo.includes('multipart/form-data')) {
    let f: FormData
    try {
      f = await req.formData()
    } catch {
      throw new ErrorHttp(400, 'Formulario inválido')
    }
    const archivo = f.get('archivo')
    if (!archivo || typeof archivo === 'string') throw new ErrorHttp(400, 'Falta el archivo (campo "archivo")')
    if (archivo.size > MAX_BYTES) throw new ErrorHttp(413, 'Archivo demasiado grande (máximo 4 MB)')
    const campo = (n: string) => {
      const v = f.get(n)
      return typeof v === 'string' && v.trim() ? v.trim() : undefined
    }
    p = { cuentaOrigenId: campo('cuentaOrigenId'), nombre: archivo.name, bytes: new Uint8Array(await archivo.arrayBuffer()), cuentaRemuneradaId: campo('cuentaRemuneradaId'), fechaTenencia: campo('fechaTenencia'), confirmarOtraEmpresa: campo('confirmarOtraEmpresa') === 'true' }
  } else {
    let b: { cuentaOrigenId?: string; nombre?: string; data?: string; cuentaRemuneradaId?: string; fechaTenencia?: string; confirmarOtraEmpresa?: boolean }
    try {
      b = await req.json()
    } catch {
      throw new ErrorHttp(400, 'Cuerpo JSON inválido')
    }
    if (!b.data) throw new ErrorHttp(400, 'Falta el archivo (data en base64)')
    if (b.data.length > (MAX_BYTES * 4) / 3 + 4) throw new ErrorHttp(413, 'Archivo demasiado grande (máximo 4 MB)')
    p = { cuentaOrigenId: b.cuentaOrigenId, nombre: b.nombre, bytes: new Uint8Array(Buffer.from(b.data, 'base64')), cuentaRemuneradaId: b.cuentaRemuneradaId, fechaTenencia: b.fechaTenencia, confirmarOtraEmpresa: b.confirmarOtraEmpresa === true }
  }
  if (!p.cuentaOrigenId) throw new ErrorHttp(400, 'Falta cuentaOrigenId (la cuenta del extracto)')
  if (!p.nombre) throw new ErrorHttp(400, 'Falta el nombre del archivo')
  if (!p.bytes?.length) throw new ErrorHttp(400, 'El archivo está vacío')
  if (p.fechaTenencia && !/^\d{4}-\d{2}-\d{2}$/.test(p.fechaTenencia)) throw new ErrorHttp(400, 'fechaTenencia tiene que ser aaaa-mm-dd')
  return p as Pedido
}

async function cuenta(db: SupabaseClient, id: string): Promise<Cuenta> {
  const { data, error } = await db.from('cuentas_origen').select(COLUMNAS_CUENTA).eq('id', id).maybeSingle()
  if (error) throw new ErrorHttp(500, error.message)
  if (!data) throw new ErrorHttp(404, 'Cuenta bancaria inexistente')
  return data as Cuenta
}

const mismoBanco = (a: string | null, b: string) => !!a && a.toUpperCase().replace(/[^A-Z]/g, '') === b.replace(/[^A-Z]/g, '')

/**
 * El banco coincide, pero ¿es ESA cuenta? Con dos cuentas del mismo banco en la empresa (CA y CC, o las de dos
 * unidades) el archivo entraba en la que se eligiera. Se busca el número de cuenta o el CBU en el nombre del
 * archivo y, si es CSV, en su encabezado: si es el de otra cuenta, no se importa; si no se puede saber, se avisa.
 */
async function controlarCuenta(db: SupabaseClient, principal: Cuenta, l: Leido, nombre: string, bytes: Uint8Array): Promise<string | null> {
  const { data, error } = await db.from('cuentas_origen').select(COLUMNAS_CUENTA).eq('empresa_id', principal.empresa_id)
  if (error) throw new ErrorHttp(500, error.message)
  const tenencia = CLASES_TENENCIA.includes(principal.clase)
  const hermanas = ((data ?? []) as Cuenta[]).filter(
    (c) => c.id !== principal.id && c.activa !== false && mismoBanco(c.banco, l.banco) && CLASES_TENENCIA.includes(c.clase) === tenencia,
  )
  const encabezado = l.tipoArchivo === 'CSV' ? Buffer.from(bytes.subarray(0, 3000)).toString('latin1') : ''
  const v = verificarCuentaDelArchivo(nombre, encabezado, principal, hermanas)
  if (v.estado === 'OTRA') {
    throw new ErrorHttp(422, `El archivo parece de ${v.cuenta.nombre} (su número está en el archivo) y elegiste ${principal.nombre}. No se importó nada.`)
  }
  return v.estado === 'SIN_DATOS' ? v.aviso : null
}

/** A qué cuenta va cada parte del archivo. */
async function destinos(db: SupabaseClient, u: UsuarioFn, elegida: Cuenta, l: Leido, remuneradaId?: string): Promise<{ cuenta: Cuenta; parte: CuentaLeida }[]> {
  const partes = new Map(l.cuentas.map((c) => [c.parte, c]))
  if (partes.has('UNICA')) {
    if (l.tenencia && !CLASES_TENENCIA.includes(elegida.clase)) {
      throw new ErrorHttp(422, `El archivo es una tenencia de FCI (${l.formato}): elegí la cuenta FCI, no ${elegida.nombre} (${elegida.clase})`)
    }
    if (!l.tenencia && elegida.clase === 'FCI') throw new ErrorHttp(422, `El archivo tiene movimientos de una cuenta (${l.formato}): ${elegida.nombre} es un FCI`)
    return [{ cuenta: elegida, parte: partes.get('UNICA')! }]
  }

  // Brubank: CC y remunerada en el mismo archivo.
  let cc: Cuenta
  let rem: Cuenta | null = null
  if (elegida.clase === 'REMUNERADA' || elegida.id === remuneradaId) {
    rem = elegida
    if (!elegida.cuenta_madre_id) throw new ErrorHttp(422, `${elegida.nombre} no tiene cuenta madre: subí el archivo desde la cuenta corriente`)
    cc = await cuenta(db, elegida.cuenta_madre_id)
  } else {
    cc = elegida
    if (remuneradaId) rem = await cuenta(db, remuneradaId)
    else if (partes.has('REMUNERADA')) {
      const { data, error } = await db.from('cuentas_origen').select(COLUMNAS_CUENTA).eq('cuenta_madre_id', cc.id).in('clase', CLASES_TENENCIA)
      if (error) throw new ErrorHttp(500, error.message)
      const hijas = ((data ?? []) as Cuenta[]).filter((c) => c.activa !== false && (!c.banco || mismoBanco(c.banco, l.banco)))
      if (hijas.length > 1) throw new ErrorHttp(409, `${cc.nombre} tiene ${hijas.length} cuentas remuneradas: indicá cuál en cuentaRemuneradaId`)
      rem = hijas[0] ?? null
    }
  }
  if (rem && (rem.empresa_id !== cc.empresa_id || rem.cuenta_madre_id !== cc.id)) {
    throw new ErrorHttp(422, `${rem.nombre} no es la remunerada de ${cc.nombre} (su cuenta madre es otra)`)
  }
  if (partes.has('REMUNERADA') && !rem) {
    throw new ErrorHttp(422, `El archivo trae movimientos de la cuenta remunerada y ${cc.nombre} no tiene una cuenta remunerada cargada (clase REMUNERADA con cuenta madre ${cc.nombre}). No se importó nada.`)
  }
  const lista: { cuenta: Cuenta; parte: CuentaLeida }[] = []
  if (partes.has('CC')) lista.push({ cuenta: cc, parte: partes.get('CC')! })
  if (partes.has('REMUNERADA')) lista.push({ cuenta: rem!, parte: partes.get('REMUNERADA')! })
  for (const d of lista) {
    if (d.cuenta.id !== elegida.id) await exigirEmpresa(u, d.cuenta.empresa_id)
  }
  return lista
}

const hoyAR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date())
const MIME: Record<string, string> = {
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  XLS: 'application/vnd.ms-excel',
  PDF: 'application/pdf',
}

/** <organización>/<empresa>/extractos/aaaa/mm/<uuid>_<nombre>: la regla de lectura de 0019 mira las dos primeras carpetas. */
async function guardarArchivo(db: SupabaseClient, organizacion: string, empresa: string, nombre: string, bytes: Uint8Array, tipo: string): Promise<string> {
  const limpio = nombre.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80)
  const hoy = hoyAR()
  const path = `${organizacion}/${empresa.replace(/[^a-zA-Z0-9_-]+/g, '')}/extractos/${hoy.slice(0, 4)}/${hoy.slice(5, 7)}/${crypto.randomUUID()}_${limpio}`
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: MIME[tipo] ?? 'application/octet-stream' })
  if (error) throw new ErrorHttp(502, `No se pudo guardar el archivo: ${error.message}`)
  return path
}

/** Lo que entró en cada cuenta del archivo (contrato con la pantalla: src/data/resultadoExtracto.ts). */
interface CuentaImportada {
  cuenta_origen_id: string
  cuenta: string
  parte: string
  repetido: boolean
  movimientos: number
  nuevos: number
  a_revisar: number
  origen_saldos: string
  filas: number
  debitos: number
  creditos: number
  desde: string | null
  hasta: string | null
  saldo_final: number | null
  saldos: { fecha: string; saldo: number }[]
  resultado: unknown
}

const pesos = (n: number) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
const ddmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

/** Una línea para la pantalla: qué entró en cada cuenta (Brubank son dos) o el saldo de la tenencia. */
function detalleImportacion(
  tenencia: boolean,
  cuentas: CuentaImportada[],
  avisos: string[],
): string {
  const partes = cuentas.map((c) => {
    if (c.repetido) return `${c.cuenta}: ya estaba importado`
    if (tenencia) return `${c.cuenta}: tenencia al ${ddmm(c.hasta)}${c.saldo_final != null ? ` $ ${pesos(c.saldo_final)}` : ''} (el rendimiento sale de la conciliación)`
    return `${c.cuenta}: ${c.nuevos} nuevo(s) de ${c.movimientos}`
  })
  return [...partes, ...avisos].join(' · ')
}

export default manejar(async (req) => {
  const u = await usuarioDesde(req)
  exigirRol(u, 'TESORERIA', 'ADMINISTRACION', 'ADMIN')
  const p = await leerPedido(req)
  const db = supabaseAdmin()
  const elegida = await cuenta(db, p.cuentaOrigenId)
  await exigirEmpresa(u, elegida.empresa_id)
  if (elegida.activa === false) throw new ErrorHttp(422, `${elegida.nombre} está dada de baja`)

  let l: Leido
  try {
    l = leerExtracto(p.nombre, p.bytes, { fechaTenencia: p.fechaTenencia })
  } catch (e) {
    if (e instanceof ErrorExtracto) throw new ErrorHttp(422, e.message)
    throw e
  }
  if (!elegida.banco) throw new ErrorHttp(422, `${elegida.nombre} no tiene el banco cargado: completalo en la cuenta antes de importar un extracto`)
  if (!mismoBanco(elegida.banco, l.banco)) throw new ErrorHttp(422, `El archivo es de ${l.banco} (${l.formato}) y la cuenta ${elegida.nombre} es de ${elegida.banco}`)
  const lista = await destinos(db, u, elegida, l, p.cuentaRemuneradaId)
  // El control de cuenta va sobre la cuenta donde entra la parte principal del archivo (en Brubank, la CC).
  const avisoCuenta = await controlarCuenta(db, lista[0].cuenta, l, p.nombre, p.bytes)
  const avisos = avisoCuenta ? [...l.avisos, avisoCuenta] : l.avisos

  // ¿Ya se importó este mismo archivo en todas sus cuentas? Entonces no se guarda de nuevo.
  const { data: ya, error: eYa } = await db.from('extractos').select('id, cuenta_origen_id').eq('archivo_hash', l.hash).in('cuenta_origen_id', lista.map((d) => d.cuenta.id))
  if (eYa) throw new ErrorHttp(500, eYa.message)
  const importadas = new Set(((ya ?? []) as { cuenta_origen_id: string }[]).map((x) => x.cuenta_origen_id))
  // ¿Ya está en una cuenta de OTRA empresa de la organización (mismo archivo o mismos movimientos)? Se controla ANTES de guardar el
  // archivo: un extracto rechazado no deja nada en el storage. El aviso empieza con [OTRA_EMPRESA]: la pantalla ofrece "Subir igual".
  if (!p.confirmarOtraEmpresa) {
    for (const d of lista) {
      if (importadas.has(d.cuenta.id)) continue
      const { data, error } = await db.rpc('extracto_duplicado_en_otra_empresa', {
        p: { cuenta_origen_id: d.cuenta.id, hash: l.hash, movimientos: d.parte.movimientos },
      })
      // Base sin la migración 0041: no hay control.
      if (error) {
        if (/could not find|does not exist/i.test(error.message)) break
        throw new ErrorHttp(500, error.message)
      }
      const dup = data as { motivo?: string; cuenta?: string; empresa?: string; coinciden?: number; total?: number } | null
      if (dup?.motivo) {
        throw new ErrorHttp(
          409,
          `[OTRA_EMPRESA] Este extracto ${dup.motivo === 'ARCHIVO' ? 'ya está cargado' : `parece ya cargado (${dup.coinciden} de ${dup.total} movimientos iguales)`} en la cuenta ${dup.cuenta} de ${dup.empresa}: no se importa en ${d.cuenta.nombre} (¿cuenta equivocada?)`,
        )
      }
    }
  }
  const path = lista.every((d) => importadas.has(d.cuenta.id)) ? null : await guardarArchivo(db, u.organizacionId, elegida.empresa_id, p.nombre, p.bytes, l.tipoArchivo)

  const origenSaldos = l.tenencia ? 'TENENCIA' : 'EXTRACTO'
  const cuentas: CuentaImportada[] = []
  for (const d of lista) {
    const movs = d.parte.movimientos
    const { data, error } = await db.rpc('importar_extracto', {
      p: {
        cuenta_origen_id: d.cuenta.id,
        usuario: u.email,
        archivo: { nombre: p.nombre, path, hash: l.hash, formato: l.formato },
        movimientos: movs,
        saldos: d.parte.saldos,
        origen_saldos: origenSaldos,
        ...(p.confirmarOtraEmpresa ? { confirmar_otra_empresa: 'true' } : {}),
      },
    })
    if (error) {
      // Lo que ya se importó en otra cuenta del mismo archivo queda (cada importación es completa en sí).
      throw new ErrorHttp(422, `No se pudo importar en ${d.cuenta.nombre}: ${error.message}${cuentas.length ? ` (ya quedó importado en ${cuentas.map((c) => c.cuenta).join(', ')})` : ''}`)
    }
    const t = totales(movs)
    const saldoFinal = d.parte.saldos.length ? d.parte.saldos[d.parte.saldos.length - 1].saldo : (movs[movs.length - 1]?.saldo ?? null)
    const res = (data ?? {}) as { repetido?: boolean; movimientos?: number; nuevos?: number; a_revisar?: number; origen_saldos?: string }
    cuentas.push({
      cuenta_origen_id: d.cuenta.id,
      cuenta: d.cuenta.nombre,
      parte: d.parte.parte,
      repetido: res.repetido === true,
      movimientos: res.repetido ? 0 : Number(res.movimientos ?? movs.length),
      nuevos: Number(res.nuevos ?? 0),
      // Sin 0029 la base no informa a_revisar: 0 (la pantalla igual muestra la pestaña "A revisar").
      a_revisar: Number(res.a_revisar ?? 0),
      origen_saldos: res.origen_saldos ?? origenSaldos,
      filas: t.filas,
      debitos: t.debitos,
      creditos: t.creditos,
      desde: movs[0]?.fecha ?? d.parte.saldos[0]?.fecha ?? null,
      hasta: movs[movs.length - 1]?.fecha ?? d.parte.saldos[d.parte.saldos.length - 1]?.fecha ?? null,
      saldo_final: saldoFinal,
      saldos: d.parte.saldos,
      resultado: data,
    })
  }
  const suma = (k: 'movimientos' | 'nuevos' | 'a_revisar') => cuentas.reduce((a, c) => a + c[k], 0)
  const repetido = cuentas.every((c) => c.repetido)
  return json({
    ok: true,
    repetido,
    movimientos: suma('movimientos'),
    nuevos: suma('nuevos'),
    a_revisar: suma('a_revisar'),
    formato: l.formato,
    banco: l.banco,
    tenencia: l.tenencia,
    detalle: detalleImportacion(l.tenencia, cuentas, avisos),
    archivo: { nombre: p.nombre, hash: l.hash, path },
    cuentas,
    avisos,
  })
})

export const config: Config = { path: '/api/bancos/extracto' }
