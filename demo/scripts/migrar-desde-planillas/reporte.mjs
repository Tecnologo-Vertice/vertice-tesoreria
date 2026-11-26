// Reporte en Markdown: por tabla destino, planilla vs lo que se cargaría (y lo que quedó en la base de prueba),
// por empresa, con la lista de lo que no se pudo mapear y por qué. Sin CBU ni números de cuenta completos.
import { pesosAR } from './leer.mjs'

/** Cualquier tira de 6 dígitos o más (cuenta, CBU, CUIT) queda con los últimos 4. */
export const enmascarar = (s) => String(s ?? '').replace(/\d{6,}/g, (d) => `…${d.slice(-4)}`)

const ORDEN = ['cuentas_origen', 'reglas_extracto', 'feriados', 'flujo_filas', 'flujo_reglas', 'proyecciones', 'flujo_ajustes', 'acreedores',
  'cheques', 'saldos_bancarios', 'movimientos_bancarios', 'cobros', 'lecturas_xubio', 'percepciones_iibb', 'procesos_log']
const CON_SUMA = new Set(['proyecciones', 'cheques', 'saldos_bancarios', 'movimientos_bancarios', 'cobros', 'lecturas_xubio', 'procesos_log'])
const QUE_SUMA = {
  proyecciones: 'importe con signo (egreso negativo): Gastos Fijos = una cuota mensual; Flujo original = la celda',
  cheques: 'importe', saldos_bancarios: 'saldo de cierre', movimientos_bancarios: 'créditos − débitos', cobros: 'importe',
  lecturas_xubio: 'saldo leído', procesos_log: 'importe del cheque',
}

const tot = (b) => Object.values(b ?? {}).reduce((a, x) => ({ filas: a.filas + x.filas, suma: a.suma + x.suma }), { filas: 0, suma: 0n })
const totLista = (l) => l.reduce((a, x) => ({ filas: a.filas + 1, suma: a.suma + (x.importe ?? 0n) }), { filas: 0, suma: 0n })
const s = (t, v) => (CON_SUMA.has(t) ? pesosAR(v) : '—')

export function armarReporte({ control, carga1, carga2, verificado, chequeos, op, origen, generado }) {
  const L = []
  const p = (x = '') => L.push(x)
  const tablas = ORDEN.filter((t) => control.tablas[t])
  const resumen = tablas.map((t) => {
    const c = control.tablas[t]
    const pl = tot(c.planilla), ca = tot(c.cargar), cu = tot(c.cubiertas), nm = totLista(c.noMapeadas)
    const ve = tot(verificado?.[t])
    return { t, c, pl, ca, cu, nm, ve, difF: pl.filas - ca.filas - cu.filas - nm.filas, difS: pl.suma - ca.suma - cu.suma - nm.suma }
  })
  const cierra = resumen.every((x) => x.difF === 0 && x.difS === 0n)
  const verifOk = resumen.every((x) => !verificado || x.t === 'flujo_reglas' || (x.ve.filas === x.ca.filas && (!CON_SUMA.has(x.t) || x.ve.suma === x.ca.suma)))
  const idem = carga2 ? Object.values(carga2).every((x) => x.altas === 0 && x.cambios === 0) : null

  p(`# Migración de planillas a la base · corrida en seco`)
  p()
  p(`Generado: ${generado} · hoy = ${op.hoy} · movimientos y saldos desde ${op.desde} · horizonte de gastos fijos sin fin: ${op.horizonte}`)
  p(`Fuente: ${origen}. **No se escribió en ninguna planilla ni en ninguna base real**: la carga se hizo en una base PGlite en memoria con las migraciones 0001 a 0028.`)
  p()
  p(`## Resultado`)
  p()
  p(`- Control planilla = a cargar + cubiertas + no mapeadas: **${cierra ? 'cierra en todas las tablas (filas y sumas)' : 'NO CIERRA (ver tabla)'}**`)
  if (verificado) p(`- Lo que quedó en la base de prueba = lo que se planeó cargar: **${verifOk ? 'sí, en todas las tablas' : 'NO (ver columna "en la base")'}**`)
  if (idem !== null) p(`- Segunda corrida (idempotencia): **${idem ? '0 altas y 0 cambios: no duplica' : 'HUBO ALTAS O CAMBIOS (ver abajo)'}**`)
  p()
  p(`## Tabla por tabla`)
  p()
  p(`"Cubiertas" = filas de planilla que no hace falta cargar porque la base ya las resuelve o vienen de otra fuente (motivo abajo). "No mapeadas" = filas que no se pudieron cargar (lista con motivo abajo).`)
  p()
  p(`| Tabla destino | Filas planilla | A cargar | Cubiertas | No mapeadas | Dif. | Suma planilla | Suma a cargar | Suma cubiertas | Suma no mapeadas | Dif. | En la base (filas · suma) | 2.ª corrida |`)
  p(`|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|`)
  for (const x of resumen) {
    const k2 = carga2?.[x.t]
    p(`| ${x.t} | ${x.pl.filas} | ${x.ca.filas} | ${x.cu.filas} | ${x.nm.filas} | ${x.difF} | ${s(x.t, x.pl.suma)} | ${s(x.t, x.ca.suma)} | ${s(x.t, x.cu.suma)} | ${s(x.t, x.nm.suma)} | ${CON_SUMA.has(x.t) ? pesosAR(x.difS) : '—'} | ${verificado ? `${x.ve.filas}${CON_SUMA.has(x.t) ? ' · ' + pesosAR(x.ve.suma) : ''}` : '—'} | ${k2 ? `${k2.altas} altas · ${k2.cambios} cambios` : '—'} |`)
  }
  p()
  p(`Notas: en flujo_reglas las filas son filas de planilla (Mapa Flujo + Llave Flujo v2); varias filas de la Llave dan una sola regla, así que "en la base" cuenta reglas. En cuentas_origen "en la base" incluye las chequeras creadas para cheques.`)
  p()
  p(`### Qué se suma en cada tabla y de dónde sale`)
  p()
  for (const x of resumen) p(`- **${x.t}**: ${[...x.c.fuentes].join(' · ')}${QUE_SUMA[x.t] ? ` · suma = ${QUE_SUMA[x.t]}` : ''}`)
  p()
  p(`## Por empresa`)
  p()
  for (const x of resumen.filter((y) => CON_SUMA.has(y.t) || ['cuentas_origen', 'flujo_filas', 'flujo_reglas', 'flujo_ajustes'].includes(y.t))) {
    p(`### ${x.t}`)
    p()
    p(`| Empresa | Filas planilla | Suma planilla | A cargar | Suma a cargar | Cubiertas | No mapeadas | Suma no mapeadas | En la base |`)
    p(`|---|--:|--:|--:|--:|--:|--:|--:|--:|`)
    const emps = new Set([...Object.keys(x.c.planilla), ...Object.keys(x.c.cargar)])
    for (const e of [...emps].sort()) {
      const pl = x.c.planilla[e] ?? { filas: 0, suma: 0n }, ca = x.c.cargar[e] ?? { filas: 0, suma: 0n }, cu = x.c.cubiertas[e] ?? { filas: 0, suma: 0n }
      const nm = totLista(x.c.noMapeadas.filter((n) => n.empresa === e)), ve = verificado?.[x.t]?.[e] ?? { filas: 0, suma: 0n }
      p(`| ${e} | ${pl.filas} | ${s(x.t, pl.suma)} | ${ca.filas} | ${s(x.t, ca.suma)} | ${cu.filas} | ${nm.filas} | ${s(x.t, nm.suma)} | ${verificado ? `${ve.filas}${CON_SUMA.has(x.t) ? ' · ' + pesosAR(ve.suma) : ''}` : '—'} |`)
    }
    p()
  }
  p(`## Filas que no se pudieron mapear`)
  p()
  for (const x of resumen) {
    if (!x.c.noMapeadas.length) continue
    p(`### ${x.t} (${x.c.noMapeadas.length})`)
    p()
    const porMotivo = new Map()
    for (const n of x.c.noMapeadas) { if (!porMotivo.has(n.motivo)) porMotivo.set(n.motivo, []); porMotivo.get(n.motivo).push(n) }
    for (const [motivo, lista] of porMotivo) {
      const suma = lista.reduce((a, n) => a + (n.importe ?? 0n), 0n)
      p(`- **${enmascarar(motivo)}** · ${lista.length} fila(s)${CON_SUMA.has(x.t) ? ` · ${pesosAR(suma)}` : ''}`)
      for (const n of lista.slice(0, 25)) p(`  - ${enmascarar(n.ref)}${CON_SUMA.has(x.t) && n.importe ? ` · ${pesosAR(n.importe)}` : ''}`)
      if (lista.length > 25) p(`  - … y ${lista.length - 25} más`)
    }
    p()
  }
  p(`## Cubiertas (no se cargan porque ya lo resuelve la base u otra fuente)`)
  p()
  for (const x of resumen) for (const [m, n] of Object.entries(x.c.motivosCubiertas)) p(`- ${x.t}: ${enmascarar(m)} · ${n}`)
  p()
  p(`## Fuera de alcance (no se cuentan como planilla)`)
  p()
  for (const x of resumen) for (const [m, n] of Object.entries(x.c.fuera)) p(`- ${x.t}: ${enmascarar(m)} · ${n}`)
  p()
  p(`## Avisos`)
  p()
  for (const x of resumen) {
    if (!x.c.avisos.length) continue
    p(`### ${x.t}`)
    p()
    for (const a of x.c.avisos.slice(0, 40)) p(`- ${enmascarar(a)}`)
    if (x.c.avisos.length > 40) p(`- … y ${x.c.avisos.length - 40} más`)
    p()
  }
  for (const [n, c] of [['Primera corrida', carga1], ['Segunda corrida', carga2]]) {
    if (!c) continue
    p(`## Carga en la base de prueba · ${n}`)
    p()
    p(`| Tabla | Altas | Cambios | Iguales | Omitidas / avisos |`)
    p(`|---|--:|--:|--:|--:|`)
    for (const t of ORDEN) if (c[t]) p(`| ${t} | ${c[t].altas} | ${c[t].cambios} | ${c[t].iguales} | ${c[t].omitidas.length} |`)
    p()
    const om = ORDEN.flatMap((t) => (c[t]?.omitidas ?? []).map((o) => `${t}: ${o.ref} · ${o.motivo}`))
    for (const o of om.slice(0, 30)) p(`- ${enmascarar(o)}`)
    if (om.length > 30) p(`- … y ${om.length - 30} más`)
    p()
  }
  if (chequeos) {
    p(`## Cómo queda la base de prueba después de cargar`)
    p()
    for (const [titulo, filas] of Object.entries(chequeos)) {
      p(`**${titulo}**`)
      p()
      if (!filas.length) { p('(sin filas)'); p(); continue }
      const cols = Object.keys(filas[0])
      p(`| ${cols.join(' | ')} |`)
      p(`|${cols.map(() => '---').join('|')}|`)
      for (const f of filas) p(`| ${cols.map((c) => enmascarar(f[c])).join(' | ')} |`)
      p()
    }
  }
  return { texto: L.join('\n'), cierra, verifOk, idem }
}
