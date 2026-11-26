// POST /api/bancos/extracto
// Tesorería sube el archivo tal como lo baja del banco y el sistema lo lee, lo guarda y lo importa.
//   · multipart/form-data: campos cuentaOrigenId, archivo (el archivo), y opcionales cuentaRemuneradaId, fechaTenencia
//   · JSON: { cuentaOrigenId, nombre, data (base64), cuentaRemuneradaId?, fechaTenencia? }
// Pasos: lee el archivo (detecta banco y formato por el contenido) → controla que sea de la cuenta elegida
// (mismo banco; tenencia de FCI solo a una cuenta FCI/remunerada) → si ya se importó, no hace nada → guarda
// el archivo en <organización>/<empresa>/extractos/… → llama a importar_extracto (una vez por cuenta).
// Brubank trae la CC y la remunerada en el mismo Excel: cada parte va a su cuenta (la remunerada es la que
// tiene como cuenta madre a la CC, o la que se indique en cuentaRemuneradaId).

import type { Config } from '@netlify/functions'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ErrorHttp, exigirEmpresa, exigirRol, json, manejar, supabaseAdmin, usuarioDesde, type UsuarioFn } from './lib/comun'
import { ErrorExtracto, leerExtracto, totales, type CuentaLeida, type Leido } from './lib/extractos/index'

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
}
const COLUMNAS_CUENTA = 'id, empresa_id, nombre, banco, clase, cuenta_madre_id, activa'
const CLASES_TENENCIA = ['FCI', 'REMUNERADA']

interface Pedido {
  cuentaOrigenId: string
  nombre: string
  bytes: Uint8Array
  cuentaRemuneradaId?: string
  fechaTenencia?: string
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
    p = { cuentaOrigenId: campo('cuentaOrigenId'), nombre: archivo.name, bytes: new Uint8Array(await archivo.arrayBuffer()), cuentaRemuneradaId: campo('cuentaRemuneradaId'), fechaTenencia: campo('fechaTenencia') }
  } else {
    let b: { cuentaOrigenId?: string; nombre?: string; data?: string; cuentaRemuneradaId?: string; fechaTenencia?: string }
    try {
      b = await req.json()
    } catch {
      throw new ErrorHttp(400, 'Cuerpo JSON inválido')
    }
    if (!b.data) throw new ErrorHttp(400, 'Falta el archivo (data en base64)')
    if (b.data.length > (MAX_BYTES * 4) / 3 + 4) throw new ErrorHttp(413, 'Archivo demasiado grande (máximo 4 MB)')
    p = { cuentaOrigenId: b.cuentaOrigenId, nombre: b.nombre, bytes: new Uint8Array(Buffer.from(b.data, 'base64')), cuentaRemuneradaId: b.cuentaRemuneradaId, fechaTenencia: b.fechaTenencia }
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

const mismoBanco = (a: string | null, b: string) => !a || a.toUpperCase().replace(/[^A-Z]/g, '') === b.replace(/[^A-Z]/g, '')

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
      const hijas = ((data ?? []) as Cuenta[]).filter((c) => c.activa !== false && mismoBanco(c.banco, l.banco))
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
  if (!mismoBanco(elegida.banco, l.banco)) throw new ErrorHttp(422, `El archivo es de ${l.banco} (${l.formato}) y la cuenta ${elegida.nombre} es de ${elegida.banco}`)
  const lista = await destinos(db, u, elegida, l, p.cuentaRemuneradaId)

  // ¿Ya se importó este mismo archivo en todas sus cuentas? Entonces no se guarda de nuevo.
  const { data: ya, error: eYa } = await db.from('extractos').select('id, cuenta_origen_id').eq('archivo_hash', l.hash).in('cuenta_origen_id', lista.map((d) => d.cuenta.id))
  if (eYa) throw new ErrorHttp(500, eYa.message)
  const importadas = new Set(((ya ?? []) as { cuenta_origen_id: string }[]).map((x) => x.cuenta_origen_id))
  const path = lista.every((d) => importadas.has(d.cuenta.id)) ? null : await guardarArchivo(db, u.organizacionId, elegida.empresa_id, p.nombre, p.bytes, l.tipoArchivo)

  const cuentas = []
  for (const d of lista) {
    const movs = d.parte.movimientos
    const { data, error } = await db.rpc('importar_extracto', {
      p: {
        cuenta_origen_id: d.cuenta.id,
        usuario: u.email,
        archivo: { nombre: p.nombre, path, hash: l.hash, formato: l.formato },
        movimientos: movs,
        saldos: d.parte.saldos,
      },
    })
    if (error) {
      // Lo que ya se importó en otra cuenta del mismo archivo queda (cada importación es completa en sí).
      throw new ErrorHttp(422, `No se pudo importar en ${d.cuenta.nombre}: ${error.message}${cuentas.length ? ` (ya quedó importado en ${cuentas.map((c) => c.cuenta).join(', ')})` : ''}`)
    }
    const t = totales(movs)
    const saldoFinal = d.parte.saldos.length ? d.parte.saldos[d.parte.saldos.length - 1].saldo : (movs[movs.length - 1]?.saldo ?? null)
    cuentas.push({
      cuenta_origen_id: d.cuenta.id,
      cuenta: d.cuenta.nombre,
      parte: d.parte.parte,
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
  return json({ ok: true, formato: l.formato, banco: l.banco, tenencia: l.tenencia, archivo: { nombre: p.nombre, hash: l.hash, path }, cuentas, avisos: l.avisos })
})

export const config: Config = { path: '/api/bancos/extracto' }
