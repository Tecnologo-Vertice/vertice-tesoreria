// POST /api/espejo   header: x-ingesta-token
// La llama gas/PuenteHojas.gs cada 10 minutos con las filas de la hoja real "Facturas automatizadas"
// (solo lectura). Traduce las filas (lib/espejo.ts) y las copia a la base (espejar_* en SQL).
//   { tipo: 'facturas', hoja: 'Facturas' | 'Facturas_Aprobadas', filas: [{ _fila, ...columnas }] }
//   { tipo: 'pagos', hoja: 'Pagos', filas: [...] }
//   { tipo: 'catalogos', catalogos: { cuentas, origen, porEmpresa, emails, productos } }
// Las pestañas grandes llegan en lotes; el primero de cada corrida trae el header x-espejo-lote: 1.

import type { Config } from '@netlify/functions'
import { env, json, leerJson, manejar, organizacionDelPuente, supabaseAdmin, ErrorHttp } from './lib/comun'
import { catalogosDesdeHoja, facturaDesdeFila, pagoDesdeFila, type CatalogosHoja, type FilaHoja, type HojaFacturas } from './lib/espejo'
import type { EmpresaRef } from './lib/factura'

interface Body {
  tipo: 'facturas' | 'pagos' | 'catalogos'
  hoja?: string
  filas?: FilaHoja[]
  catalogos?: CatalogosHoja
}

interface Conteo {
  nuevas: number
  actualizadas: number
  sin_cambios: number
  omitidas: { fila?: unknown; id?: unknown; motivo: string }[]
}

export default manejar(async (req) => {
  const esperado = env('INGESTA_TOKEN')
  if ((req.headers.get('x-ingesta-token') ?? '') !== esperado) throw new ErrorHttp(401, 'Token de ingesta inválido')
  // De qué organización es la hoja: mientras haya una sola, esa (ver organizacionDelPuente).
  const organizacion = await organizacionDelPuente()
  const b = await leerJson<Body>(req)
  const db = supabaseAdmin()
  // Las empresas de esa organización, con sus alias: contra ellas (y ninguna más) se reconoce el RECEPTOR de cada fila.
  const { data: lista, error: errorEmpresas } = await db.from('empresas').select('id, nombre, cuit, erp, alias, alias_emisor, alias_orden').eq('organizacion_id', organizacion)
  if (errorEmpresas) throw new ErrorHttp(500, errorEmpresas.message)
  const empresas = (lista ?? []) as EmpresaRef[]

  if (b.tipo === 'catalogos') {
    const c = catalogosDesdeHoja(b.catalogos ?? {}, empresas)
    const { data, error } = await db.rpc('espejar_catalogos', { p: c })
    if (error) throw new ErrorHttp(422, error.message)
    await anotar(db, organizacion, 'Catalogos', { filas: Object.values(data as Record<string, number>).reduce((a, n) => a + n, 0), nuevas: 0, actualizadas: 0, sin_cambios: 0, omitidas: c.omitidas.map((m) => ({ motivo: m })) })
    return json({ ok: true, ...(data as object), omitidas: c.omitidas })
  }

  const filas = b.filas ?? []
  if (filas.length > 500) throw new ErrorHttp(413, 'Mandar de a 500 filas como máximo')
  const omitidasLocal: Conteo['omitidas'] = []
  const traducidas: Record<string, unknown>[] = []

  if (b.tipo === 'facturas') {
    if (b.hoja !== 'Facturas' && b.hoja !== 'Facturas_Aprobadas') throw new ErrorHttp(400, 'hoja tiene que ser Facturas o Facturas_Aprobadas')
    for (const f of filas) {
      const r = facturaDesdeFila(f, b.hoja as HojaFacturas, Number(f._fila) || 0, empresas)
      if (r.ok) traducidas.push(r.dato)
      else omitidasLocal.push({ fila: f._fila, motivo: r.motivo })
    }
  } else if (b.tipo === 'pagos') {
    for (const f of filas) {
      const r = pagoDesdeFila(f, Number(f._fila) || 0, empresas)
      if (r.ok) traducidas.push(r.dato)
      else omitidasLocal.push({ fila: f._fila, motivo: r.motivo })
    }
  } else {
    throw new ErrorHttp(400, 'tipo tiene que ser facturas, pagos o catalogos')
  }

  const { data, error } = await db.rpc(b.tipo === 'facturas' ? 'espejar_facturas' : 'espejar_pagos', { p_filas: traducidas })
  if (error) throw new ErrorHttp(422, error.message)
  const r = data as Conteo
  const conteo: Conteo = { ...r, omitidas: [...omitidasLocal, ...r.omitidas] }
  await anotar(db, organizacion, b.hoja ?? b.tipo, { filas: filas.length, ...conteo }, req.headers.get('x-espejo-lote') === '1')
  return json({ ok: true, recibidas: filas.length, ...conteo })
})

/** Acumula el resultado del lote en espejo_estado. El primer lote de cada corrida (x-espejo-lote: 1) reinicia los contadores. */
async function anotar(db: ReturnType<typeof supabaseAdmin>, organizacion: string, hoja: string, c: Conteo & { filas: number }, primero = true) {
  const { data: previo } = primero ? { data: null } : await db.from('espejo_estado').select('*').eq('organizacion_id', organizacion).eq('hoja', hoja).maybeSingle()
  const suma = (k: 'filas' | 'nuevas' | 'actualizadas' | 'sin_cambios') => (previo ? Number(previo[k]) || 0 : 0) + c[k]
  const detalle = [...((previo?.detalle as unknown[]) ?? []), ...c.omitidas].slice(0, 200)
  await db.from('espejo_estado').upsert({
    organizacion_id: organizacion,
    hoja,
    ultima_en: new Date().toISOString(),
    filas: suma('filas'),
    nuevas: suma('nuevas'),
    actualizadas: suma('actualizadas'),
    sin_cambios: suma('sin_cambios'),
    omitidas: detalle.length,
    detalle,
  })
}

export const config: Config = { path: '/api/espejo' }
