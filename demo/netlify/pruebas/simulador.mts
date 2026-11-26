// Simulador para probar las funciones de Netlify enteras, sin Supabase, Xubio ni Gemini reales.
// Reemplaza fetch: lo que va a la URL de Supabase lo atiende una base mínima en memoria (tablas como
// listas de filas y funciones de base como funciones de JavaScript); lo que va a Xubio o a Gemini lo
// atiende lo que diga cada prueba. Guarda todos los pedidos para poder comprobar qué se llamó y qué no.

export const SUPABASE = 'http://supabase.prueba'
process.env.SUPABASE_URL = SUPABASE
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-prueba'
process.env.GEMINI_API_KEY = 'clave-de-prueba'

export type Fila = Record<string, unknown>
export interface Pedido {
  metodo: string
  url: string
  ruta: string
  cuerpo: unknown
  /** Cabecera Authorization tal como llegó (para saber con qué credencial se llamó). */
  auth: string
}
export type Externo = (p: Pedido, corte: AbortSignal | undefined) => Promise<Response> | Response

export interface Mundo {
  /** token de sesión → mail de la persona */
  sesiones: Record<string, string>
  tablas: Record<string, Fila[]>
  rpc: Record<string, (args: Record<string, unknown>, m: Mundo) => unknown>
  archivos: Record<string, Uint8Array>
  xubio: Externo
  gemini: Externo
  pedidos: Pedido[]
}

const responder = (cuerpo: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Un servicio que no contesta nunca: la promesa solo termina cuando quien llamó corta el pedido.
 * Si quien llamó no puso tope, la prueba se corta a los 5 s con un error (antes de A3 quedaba colgada).
 */
export const noResponde: Externo = (_p, corte) =>
  new Promise<Response>((_ok, mal) => {
    // Como una conexión abierta de verdad, mantiene vivo el proceso mientras espera.
    const espera = setTimeout(() => mal(new Error('La prueba esperó 5 s: la llamada no tiene tope de tiempo')), 5_000)
    corte?.addEventListener('abort', () => {
      clearTimeout(espera)
      mal(corte.reason ?? new DOMException('Cortado', 'AbortError'))
    })
  })

function cumple(fila: Fila, filtros: [string, string][]): boolean {
  return filtros.every(([col, cond]) => {
    const v = fila[col]
    if (cond.startsWith('eq.')) return String(v) === cond.slice(3)
    if (cond.startsWith('in.(')) return cond.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')).includes(String(v))
    if (cond === 'is.null') return v == null
    throw new Error(`El simulador no entiende el filtro ${col}=${cond}`)
  })
}

async function supabase(m: Mundo, p: Pedido, req: { headers: Headers }): Promise<Response> {
  const u = new URL(p.url)
  if (u.pathname === '/auth/v1/user') {
    const email = m.sesiones[(req.headers.get('authorization') ?? '').replace('Bearer ', '')]
    return email ? responder({ id: 'id-' + email, aud: 'authenticated', email }) : responder({ message: 'invalid JWT' }, 401)
  }
  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = u.pathname.slice('/rest/v1/rpc/'.length)
    if (!m.rpc[fn]) return responder({ message: `La prueba no definió la función ${fn}` }, 404)
    try {
      return responder((await m.rpc[fn]((p.cuerpo ?? {}) as Record<string, unknown>, m)) ?? null)
    } catch (e) {
      return responder({ message: e instanceof Error ? e.message : String(e) }, 400)
    }
  }
  if (u.pathname.startsWith('/rest/v1/')) {
    const tabla = u.pathname.slice('/rest/v1/'.length)
    const filas = (m.tablas[tabla] ??= [])
    const filtros = [...u.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit', 'columns'].includes(k))
    if (p.metodo === 'POST') {
      for (const f of Array.isArray(p.cuerpo) ? (p.cuerpo as Fila[]) : [p.cuerpo as Fila]) filas.push({ ...f })
      return responder(null, 201)
    }
    const elegidas = filas.filter((f) => cumple(f, filtros))
    if (p.metodo === 'PATCH') for (const f of elegidas) Object.assign(f, p.cuerpo as Fila)
    if (p.metodo !== 'GET' && p.metodo !== 'PATCH') return responder({ message: `El simulador no atiende ${p.metodo}` }, 405)
    if ((req.headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
      return elegidas.length === 1 ? responder(elegidas[0]) : responder({ code: 'PGRST116', message: 'No hay una única fila' }, 406)
    }
    return responder(elegidas)
  }
  if (u.pathname.startsWith('/storage/v1/object/')) {
    const clave = decodeURIComponent(u.pathname.slice('/storage/v1/object/'.length))
    if (p.metodo === 'POST') {
      m.archivos[clave] = new Uint8Array(0)
      return responder({ Key: clave, Id: 'archivo' })
    }
    return clave in m.archivos ? new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }) : responder({ message: 'no existe' }, 404)
  }
  return responder({ message: `El simulador no atiende ${u.pathname}` }, 404)
}

/** Arma un mundo de prueba y reemplaza fetch. Cada prueba arma el suyo. */
export function simular(parcial: Partial<Mundo> = {}): Mundo {
  const m: Mundo = {
    sesiones: {},
    tablas: {},
    rpc: {},
    archivos: {},
    xubio: () => responder({ error: 'La prueba no esperaba una llamada a Xubio' }, 500),
    gemini: () => responder({ error: 'La prueba no esperaba una llamada a la IA' }, 500),
    pedidos: [],
    ...parcial,
  }
  globalThis.fetch = (async (entrada: string | URL | Request, opciones?: RequestInit) => {
    const req = new Request(entrada, opciones)
    const texto = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text()
    let cuerpo: unknown = texto
    try {
      cuerpo = texto ? JSON.parse(texto) : undefined
    } catch {
      /* binario o formulario: queda como texto */
    }
    const p: Pedido = { metodo: req.method, url: req.url, ruta: new URL(req.url).pathname, cuerpo, auth: req.headers.get('authorization') ?? '' }
    m.pedidos.push(p)
    const corte = opciones?.signal ?? undefined
    if (req.url.startsWith(SUPABASE)) return supabase(m, p, req)
    if (req.url.startsWith('https://xubio.com/')) return m.xubio(p, corte)
    if (req.url.startsWith('https://generativelanguage.googleapis.com/')) return m.gemini(p, corte)
    return responder({ error: `Pedido a un lugar que la prueba no esperaba: ${req.url}` }, 500)
  }) as typeof fetch
  return m
}

/** Un pedido como el que manda la pantalla, con la sesión de una persona. */
export const pedido = (token: string, cuerpo: unknown = {}) =>
  new Request('http://sitio.prueba/api', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })

/** Respuesta de Gemini con el JSON de una lectura. */
export const lecturaGemini = (lectura: unknown) => responder({ candidates: [{ content: { parts: [{ text: JSON.stringify(lectura) }] } }] })

export const json = responder

let ok = 0
let mal = 0
export function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}
export function cerrar(): never {
  console.log(`\n${ok} OK · ${mal} MAL`)
  process.exit(mal ? 1 : 0)
}
