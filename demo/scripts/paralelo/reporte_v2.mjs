// Reporte del paralelo, segunda vuelta (T-209): lotes, pagos sin débito por clase, Mercado Pago día por día y
// rescates de FCI. Todo número sale de las dos bases (centavos, BigInt). Sin CBU ni números de cuenta completos.
import { pesosAR } from '../migrar-desde-planillas/leer.mjs'
import { enmascarar } from '../migrar-desde-planillas/reporte.mjs'
import { controlMigracion } from './reporte.mjs'
import { causaDelDia } from './diagnostico.mjs'
import { cent } from './comparar.mjs'

const $ = (c) => (c === null || c === undefined ? '—' : pesosAR(c))
const pct = (a, b) => (b ? `${Math.round((a * 1000) / b) / 10} %` : '—')
const abs = (x) => (x < 0n ? -x : x)
const ESTADO = { OK: 'Ok', F: 'F', SIN_EXTRACTO: 'Sin extracto', PRIMER_SALDO: 'Primer saldo', REVISAR: 'Revisar' }
const e = (x) => ESTADO[x] ?? x ?? '—'
const NOMBRE = { beratung: 'Beratung S/Dax', 'dax-salud': 'Dax Salud', india: 'India', vertice: 'Vértice' }
const dia = (f) => `${f.slice(8, 10)}/${f.slice(5, 7)}`

export const CLASES = {
  LOTE: 'Resuelto por lote (1 débito ↔ varios pagos)',
  VARIOS_DEBITOS: 'Resuelto: un pago en varios débitos',
  UNO_A_UNO: 'Resuelto 1 a 1 (desempate fijo)',
  POSIBLE_DUPLICADO: 'Posible duplicado (mismo proveedor, importe y fecha cercana)',
  CUENTA_O_FECHA: 'Cuenta o fecha mal cargada (hay un débito igual en otra cuenta o fuera de la ventana)',
  SIN_EXPLICACION: 'Sin explicación',
  FUERA_DE_VISTA: 'Sigue sin débito pero ya no entra en la vista (el extracto no cubre 5 días después)',
}

/** Pagos sin débito de ANTES clasificados según cómo quedaron DESPUÉS. Control: la suma de las clases = total de antes. */
export function clasificarSinDebito(antes, despues) {
  const motivoDespues = new Map(despues.sinDebito.map((x) => [x.hoja_id, x]))
  const clases = new Map(Object.keys(CLASES).map((k) => [k, { n: 0, suma: 0n, filas: [] }]))
  let total = 0n
  for (const p of antes.sinDebito) {
    const imp = cent(p.importe); total += imp
    const est = despues.estadoPagos.get(p.hoja_id) ?? 'SIN'
    const d = motivoDespues.get(p.hoja_id)
    const k = est !== 'SIN' ? est : d?.motivo ?? 'FUERA_DE_VISTA'
    const c = clases.get(k); c.n++; c.suma += imp; c.filas.push({ ...p, ...(d ?? {}), importe_c: imp })
  }
  const nuevos = despues.sinDebito.filter((x) => !antes.sinDebito.some((a) => a.hoja_id === x.hoja_id))
  const suma = [...clases.values()].reduce((a, c) => a + c.suma, 0n)
  return { clases, total, suma, cierra: suma === total, nuevos }
}

/** Mercado Pago: saldo calculado = saldo inicial + movimientos hasta el día; diferencia = cargado − calculado. */
export function mercadoPago(filas) {
  return filas.map((r) => {
    const calc = cent(r.saldo_inicial) + cent(r.movido), cargado = cent(r.saldo_cargado)
    return { unidad: r.unidad, fecha: r.fecha, origen: r.origen, cargado, calculado: calc, diferencia: cargado - calc,
      movido_dia: cent(r.movido_dia), movimientos_dia: r.movimientos_dia }
  })
}

export function armarReporteV2({ antes, despues, op, generado, conPagos }) {
  const L = [], p = (s = '') => L.push(s)
  const unidades = [...new Set(despues.flujo.map((f) => f.unidad))]
  const resumen = unidades.map((u) => {
    const a = antes.flujo.filter((f) => f.unidad === u), d = despues.flujo.filter((f) => f.unidad === u)
    return { unidad: u, dias: d.length, antes: a.filter((f) => f.coincide).length, despues: d.filter((f) => f.coincide).length }
  })
  const tot = resumen.reduce((a, r) => ({ dias: a.dias + r.dias, antes: a.antes + r.antes, despues: a.despues + r.despues }), { dias: 0, antes: 0, despues: 0 })
  const sd = clasificarSinDebito(antes, despues)
  const mp = mercadoPago(despues.mp)
  const mpConDif = mp.filter((x) => abs(x.diferencia) > 100n)
  const migA = controlMigracion(antes.control), migD = controlMigracion(despues.control)
  const quedan = despues.flujo.filter((f) => !f.coincide)
  const motivoDia = (f) => {
    const d = despues.detalle.find((x) => x.unidad === f.unidad && x.fecha === f.fecha)
    return f.estado_base === 'PRIMER_SALDO' ? 'no comparable: primer día cargado (sin día anterior completo)'
      : f.estado_base === 'SIN_EXTRACTO' ? `falta el saldo de alguna cuenta (${f.cuentas_con_saldo})` : causaDelDia(d, pesosAR)
  }
  const porCausa = { mp: 0, macro: 0, primer: 0, otros: 0 }
  for (const f of quedan) {
    const m = motivoDia(f)
    if (f.estado_base === 'PRIMER_SALDO') porCausa.primer++
    else if (/MERCADO PAGO/i.test(m)) porCausa.mp++
    else if (/MACRO/i.test(m) && f.unidad === 'vertice') porCausa.macro++
    else porCausa.otros++
  }

  p(`# Simulacro del período en paralelo, segunda vuelta (T-209) · ${op.desde} al ${op.hasta}`)
  p()
  p(`Generado ${generado.slice(0, 16).replace('T', ' ')} UTC con \`demo/scripts/paralelo/paralelo.mjs\`. Nada se escribió en planillas ni en bases reales: dos bases PGlite en memoria con los datos reales (instantáneas fuera del repo).`)
  p()
  p('- **ANTES** = lo entregado en T-206/T-208: migraciones hasta 0031 + script de migración con las correcciones de T-206 + pagos de VBI+.')
  p('- **DESPUÉS** = + 0032 (lotes, desempate fijo, motivo de los pagos sin débito) + rescates y suscripciones de FCI clasificados en la carga.')
  if (!conPagos) p('- **[FALTA] Sin pagos de VBI+**: los resultados no sirven para decidir.')
  p()
  p('## Conclusión')
  p()
  p(`1. Coinciden ${tot.antes} de ${tot.dias} días unidad × día antes y **${tot.despues} de ${tot.dias}** después (${pct(tot.despues, tot.dias)}). El trabajo de datos sin firmas ya no mueve el control: de los ${quedan.length} días que no coinciden, ${porCausa.mp} son de Mercado Pago, ${porCausa.macro} de Macro de Vértice sin extracto, ${porCausa.primer} son el primer día (no comparable) y ${porCausa.otros} otros.`)
  p(`2. Pagos sin débito: ${antes.sinDebito.length} por ${pesosAR(sd.total)} antes; después ${sd.clases.get('LOTE').n + sd.clases.get('VARIOS_DEBITOS').n + sd.clases.get('UNO_A_UNO').n} quedan vinculados, ${sd.clases.get('CUENTA_O_FECHA').n} tienen un débito igual en otra cuenta o fuera de la ventana (${pesosAR(sd.clases.get('CUENTA_O_FECHA').suma)}), ${sd.clases.get('POSIBLE_DUPLICADO').n} son posibles duplicados y ${sd.clases.get('SIN_EXPLICACION').n} no tienen explicación (control de totales: ${sd.cierra ? 'cierra' : 'NO CIERRA'}).`)
  p(`3. Mercado Pago: en ${mpConDif.length} de ${mp.length} días el saldo cargado a mano no es el que dan sus movimientos; es la firma que más días destraba (ver tabla).`)
  p()
  p('## Por unidad')
  p()
  p('| Unidad | Días | Coinciden antes | Coinciden después | % después |')
  p('|---|--:|--:|--:|--:|')
  for (const r of resumen) p(`| ${NOMBRE[r.unidad] ?? r.unidad} | ${r.dias} | ${r.antes} | ${r.despues} | ${pct(r.despues, r.dias)} |`)
  p(`| **Total** | **${tot.dias}** | **${tot.antes}** | **${tot.despues}** | **${pct(tot.despues, tot.dias)}** |`)
  p()
  const g = despues.pagos, o = g?.espejo?.omitidas?.length ?? 0
  p('Controles:')
  p(`- Migración (planilla = a cargar + cubiertas + no mapeadas, filas y pesos): antes ${migA.cierra ? 'cierra' : 'NO CIERRA'} · después ${migD.cierra ? 'cierra' : 'NO CIERRA'}.`)
  if (g) p(`- Pagos de VBI+: leídas ${g.leidas} = fuera del período ${g.fuera_de_rango} + traducidas ${g.traducidas} + no traducidas ${g.omitidas_traduccion.length}; traducidas = nuevas ${g.espejo.nuevas} + omitidas ${o}.`)
  p(`- Vínculos después: ${despues.vinculos.pagos} débitos con pago (1 a 1 o varios débitos por pago), ${despues.vinculos.lotes ?? 0} débitos en lote que pagan ${despues.vinculos.pagos_en_lotes ?? 0} pagos, ${despues.vinculos.cheques} cheques, ${despues.vinculos.cobros} cobros, ${despues.vinculos.contraparte} con contraparte FCI (antes: ${antes.vinculos.pagos} · ${antes.vinculos.lotes ?? 0} lotes · ${antes.vinculos.cheques} · ${antes.vinculos.cobros} · ${antes.vinculos.contraparte}).`)
  p(`- Días que coinciden + que no = ${tot.despues} + ${quedan.length} = ${tot.despues + quedan.length} (${tot.despues + quedan.length === tot.dias ? 'cierra' : 'NO CIERRA'}).`)
  p()

  p('## Pagos sin débito por clase')
  p()
  p(`Los ${antes.sinDebito.length} pagos que ANTES estaban en pagos_sin_debito (fecha del pago en el período), según cómo quedaron DESPUÉS.`)
  p()
  p('| Clase | Cantidad | Importe |')
  p('|---|--:|--:|')
  for (const [k, c] of sd.clases) if (c.n) p(`| ${CLASES[k]} | ${c.n} | ${pesosAR(c.suma)} |`)
  p(`| **Total** | **${antes.sinDebito.length}** | **${pesosAR(sd.suma)}** |`)
  p()
  p(`Control: suma de las clases ${pesosAR(sd.suma)} = total de antes ${pesosAR(sd.total)} → **${sd.cierra ? 'cierra' : 'NO CIERRA'}**.${sd.nuevos.length ? ` Además aparecen ${sd.nuevos.length} pagos sin débito que antes no estaban (${pesosAR(sd.nuevos.reduce((a, x) => a + cent(x.importe), 0n))}).` : ' No aparecen pagos sin débito nuevos.'}`)
  p()

  p('## Mercado Pago día por día (para la firma 1)')
  p()
  p('Saldo según movimientos = primer saldo cargado de la cuenta + todos los movimientos de MP desde ese día hasta el de la fila (los de Motor › Bancos Movimientos y VBI+). Diferencia = saldo cargado − saldo según movimientos.')
  p()
  for (const u of [...new Set(mp.map((x) => x.unidad))]) {
    const l = mp.filter((x) => x.unidad === u)
    const conDif = l.filter((x) => abs(x.diferencia) > 100n)
    p(`### ${NOMBRE[u] ?? u}: ${conDif.length} de ${l.length} días con diferencia; la mayor, ${pesosAR(l.reduce((a, x) => (abs(x.diferencia) > abs(a) ? x.diferencia : a), 0n))}; al ${dia(l[l.length - 1]?.fecha ?? op.hasta)}, ${pesosAR(l[l.length - 1]?.diferencia ?? 0n)}`)
    p()
    p('| Día | Saldo cargado | Origen | Movimientos del día | Movido el día | Saldo según movimientos | Diferencia |')
    p('|---|--:|---|--:|--:|--:|--:|')
    for (const x of l) p(`| ${dia(x.fecha)} | ${$(x.cargado)} | ${x.origen} | ${x.movimientos_dia} | ${$(x.movido_dia)} | ${$(x.calculado)} | ${$(x.diferencia)} |`)
    p()
  }

  p('## Rescates de FCI que se veían como rendimiento')
  p()
  const rf = despues.reclasificadosFci
  const lineasSaldo = despues.control.tablas.movimientos_bancarios.motivosCubiertas['línea de saldo del informe (saldo anterior/inicial/final): no es un movimiento'] ?? 0
  p(`Detección en la carga (script de migración): para cada FCI o remunerada, lo que cambió su saldo y no explican sus propios movimientos ni los FCI de su cuenta madre; si un único movimiento SIN_CLASIFICAR del mismo banco lo explica (al revés, con tolerancia del rendimiento del día), entra como FCI con el fondo de contraparte. Resultado: **${rf.length} movimientos reclasificados** (VBI+ ya había clasificado como FCI los rescates y suscripciones reales de noviembre). Además, **${lineasSaldo} línea(s) "Saldo anterior"** de un informe de tenencia se cargaban como movimiento y aparecían como "rendimiento" negativo del fondo: ya no se cargan.`)
  p()
  const fmtR = (l) => l.map((x) => `${enmascarar(x.cuenta)} ${dia(x.fecha)} ${pesosAR(cent(x.rendimiento))}`).join(' · ') || 'ninguno'
  p(`"Rendimientos" de más del 1 % del saldo en un día (no son rendimiento: falta la pata de un rescate o una suscripción): antes ${antes.rendRaros.length} (${fmtR(antes.rendRaros)}); después ${despues.rendRaros.length} (${fmtR(despues.rendRaros)}).`)
  p()
  if (rf.length) {
    p('| Empresa | Cuenta | Día | Tipo | Importe |')
    p('|---|---|---|---|--:|')
    for (const x of rf) p(`| ${x.empresa} | ${enmascarar(x.cuenta)} | ${dia(x.fecha)} | ${x.tipo === 'RESCATE_FCI' ? 'rescate' : 'suscripción'} | ${pesosAR(x.importe)} |`)
    p()
  }

  p('## Casos para revisar a mano (por importe, máx. 30)')
  p()
  const casos = []
  for (const r of despues.revisar) casos.push({ imp: cent(r.importe), fecha: r.fecha, empresa: r.empresa, cuenta: r.cuenta, que: r.detalle,
    motivo: r.tipo === 'DEBITO_LOTE' ? `débito que podría ser un lote: ${r.motivo === 'VARIAS_COMBINACIONES' ? 'más de una combinación de pagos suma exacto' : `${r.candidatos} pagos posibles (más de 14)`}` : 'pago que podría haber salido en varios débitos: más de una combinación' })
  for (const k of ['CUENTA_O_FECHA', 'POSIBLE_DUPLICADO', 'SIN_EXPLICACION']) for (const x of sd.clases.get(k).filas) casos.push({ imp: x.importe_c, fecha: x.fecha, empresa: x.empresa, cuenta: x.cuenta, que: `pago a ${x.proveedor ?? '—'} (fila ${x.fila ?? '—'} de Pagos)`,
    motivo: k === 'CUENTA_O_FECHA' ? `hay un débito igual sin vincular ${x.otra_cuenta ? 'en otra cuenta' : 'fuera de la ventana'}${x.fecha_debito ? ` (el ${dia(x.fecha_debito)})` : ''}: corregir cuenta o fecha` : k === 'POSIBLE_DUPLICADO' ? 'otro pago igual al mismo proveedor ±5 días: ¿anular uno?' : 'el banco no muestra nada parecido' })
  casos.sort((a, b) => (b.imp > a.imp ? 1 : b.imp < a.imp ? -1 : a.fecha < b.fecha ? -1 : 1))
  p('| # | Importe | Día | Empresa | Cuenta | Qué | Motivo |')
  p('|--:|--:|---|---|---|---|---|')
  casos.slice(0, 30).forEach((c, i) => p(`| ${i + 1} | ${pesosAR(c.imp)} | ${dia(c.fecha)} | ${c.empresa} | ${enmascarar(c.cuenta ?? '—')} | ${enmascarar(c.que ?? '')} | ${c.motivo} |`))
  p()
  p(`${casos.length} casos en total${casos.length > 30 ? ` (se muestran los 30 de mayor importe)` : ''}.`)
  p()

  p('## Lo que solo Santiago puede resolver (en orden de impacto)')
  p()
  const mpDias = new Set(quedan.filter((f) => /MERCADO PAGO/i.test(motivoDia(f))).map((f) => `${f.unidad}|${f.fecha}`)).size
  p(`1. **Mercado Pago (firma 1)**: ¿se sube el extracto de MP todos los días (la base pasa a controlarlo con su saldo real) o MP queda fuera del control (requiere_extracto = false)? Destraba hasta ${mpDias} días. Diferencia acumulada al ${dia(op.hasta)}: ${[...new Set(mp.map((x) => x.unidad))].map((u) => { const l = mp.filter((x) => x.unidad === u); return `${NOMBRE[u]} ${pesosAR(l[l.length - 1]?.diferencia ?? 0n)}` }).join(' · ')}.`)
  p(`2. **Extracto de Macro de Vértice del período** ([FALTA], no es una firma: hay que bajarlo del banco). Destraba hasta ${porCausa.macro} días.`)
  p(`3. **Pagos mal cargados** (${sd.clases.get('CUENTA_O_FECHA').n + sd.clases.get('POSIBLE_DUPLICADO').n} casos, ${pesosAR(sd.clases.get('CUENTA_O_FECHA').suma + sd.clases.get('POSIBLE_DUPLICADO').suma)}): corregir cuenta o fecha en la hoja o anular el duplicado. No cambian el control (la base ya no los cuenta) pero sí la clasificación del Flujo.`)
  p('4. **Reglas de 0030 y 0032 para aprobar**: ventana de vinculación (2 días antes, 5 después), un débito sin documento cuenta como real, un pago de cuenta con extracto es real recién con su débito, lotes de hasta 12 pagos con suma exacta y sin ambigüedad.')
  p('5. **Destino de cheques por categoría** (12 reglas que salen de las planillas, listadas en el reporte de T-206).')
  p()

  p('## Unidad × día (DESPUÉS) y causa de lo que no coincide')
  p()
  p('| Unidad | Día | Planilla | Base antes | Base después | Δ base después | Coincide antes / después | Causa |')
  p('|---|---|---|---|---|--:|---|---|')
  for (const f of despues.flujo) {
    const a = antes.flujo.find((x) => x.unidad === f.unidad && x.fecha === f.fecha)
    p(`| ${NOMBRE[f.unidad] ?? f.unidad} | ${dia(f.fecha)} | ${e(f.estado_planilla)} | ${e(a?.estado_base)} | ${e(f.estado_base)} | ${$(f.dif_base)} | ${a?.coincide ? 'sí' : 'no'} / ${f.coincide ? 'sí' : 'no'} | ${f.coincide ? '' : enmascarar(motivoDia(f))} |`)
  }
  p()
  return { texto: L.join('\n'), resumen, tot, sd }
}
