// Reporte del simulacro del período en paralelo. Todo número sale de la comparación (centavos, BigInt).
// Sin CBU ni números de cuenta completos: todo texto pasa por enmascarar() (deja los últimos 4 dígitos).
import { pesosAR } from '../migrar-desde-planillas/leer.mjs'
import { enmascarar } from '../migrar-desde-planillas/reporte.mjs'
import { causaDelDia } from './diagnostico.mjs'
import { cent } from './comparar.mjs'

const $ = (c) => (c === null || c === undefined ? '—' : pesosAR(c))
const pct = (a, b) => (b ? `${Math.round((a * 1000) / b) / 10} %` : '—')
const ESTADO = { OK: 'Ok', F: 'F', SIN_EXTRACTO: 'Sin extracto', PRIMER_SALDO: 'Primer saldo', DIFERENCIA: 'Diferencia', SIN_MOVIMIENTOS: 'Sin movimientos', SIN_FILA: 'sin fila' }
const e = (x) => ESTADO[x] ?? x ?? '—'
const NOMBRE = { beratung: 'Beratung S/Dax', 'dax-salud': 'Dax Salud', india: 'India', vertice: 'Vértice' }

/** Control de la migración: planilla = a cargar + cubiertas + no mapeadas, en filas y pesos, por tabla y empresa. */
export function controlMigracion(control) {
  const malas = []
  for (const [t, x] of Object.entries(control.tablas)) {
    const emps = new Set([...Object.keys(x.planilla), ...Object.keys(x.cargar), ...Object.keys(x.cubiertas), ...x.noMapeadas.map((n) => n.empresa)])
    for (const emp of emps) {
      const p = x.planilla[emp] ?? { filas: 0, suma: 0n }, c = x.cargar[emp] ?? { filas: 0, suma: 0n }, b = x.cubiertas[emp] ?? { filas: 0, suma: 0n }
      const nm = x.noMapeadas.filter((n) => n.empresa === emp)
      const filas = c.filas + b.filas + nm.length, suma = c.suma + b.suma + nm.reduce((a, n) => a + (n.importe ?? 0n), 0n)
      if (filas !== p.filas || suma !== p.suma) malas.push(`${t} · ${emp}: planilla ${p.filas} / ${pesosAR(p.suma)} vs ${filas} / ${pesosAR(suma)}`)
    }
  }
  return { cierra: malas.length === 0, malas }
}

export function armarReporte({ antes, despues, op, generado, conPagos }) {
  const L = []
  const p = (s = '') => L.push(s)
  const unidades = [...new Set(antes.flujo.map((f) => f.unidad))]
  const resumen = unidades.map((u) => {
    const a = antes.flujo.filter((f) => f.unidad === u), d = despues.flujo.filter((f) => f.unidad === u)
    return { unidad: u, dias: a.length, antes: a.filter((f) => f.coincide).length, despues: d.filter((f) => f.coincide).length,
      comparables: d.filter((f) => f.comparable).length }
  })
  const tot = resumen.reduce((a, r) => ({ dias: a.dias + r.dias, antes: a.antes + r.antes, despues: a.despues + r.despues, comparables: a.comparables + r.comparables }), { dias: 0, antes: 0, despues: 0, comparables: 0 })
  const cA = antes.conc.filter((x) => x.coincide).length, cD = despues.conc.filter((x) => x.coincide).length
  const migA = controlMigracion(antes.control), migD = controlMigracion(despues.control)

  p(`# Simulacro del período en paralelo · noviembre 2026 · ${op.desde} al ${op.hasta}`)
  p()
  p(`**T-206.** Generado ${generado.slice(0, 16).replace('T', ' ')} UTC con \`demo/scripts/paralelo/paralelo.mjs\`. Nada se escribió en planillas ni en bases reales: dos bases PGlite en memoria con los datos reales (instantáneas de las planillas, fuera del repo).`)
  p()
  p('- **ANTES**: migraciones 0001–0029 + script de migración como estaba + pagos de VBI+.')
  p('- **DESPUÉS**: migraciones 0001–0030 + script de migración con las correcciones de T-206 + los mismos pagos.')
  p(`- Comparación por unidad y día contra la fila "Conciliación Bancaria" del Flujo original (Ok / F / Sin extracto), la suma de sus filas de saldo por banco y la "Caja del Período"; y por cuenta y día contra VBI+ › Conciliacion_Diaria.`)
  p(`- "Coincide" = mismo estado y mismo saldo de bancos (tolerancia $1). "Primer saldo" = la base no tiene día anterior completo para controlar (no comparable).`)
  if (!conPagos) p('- **[FALTA] Sin pagos de VBI+**: el Flujo de la base no tiene pagos reales. Los resultados no sirven para decidir.')
  p()
  p('## Resultado')
  p()
  p(`- Días unidad × día comparados: **${tot.dias}** (${unidades.length} unidades). Coinciden **antes ${tot.antes} (${pct(tot.antes, tot.dias)})** · **después ${tot.despues} (${pct(tot.despues, tot.dias)})**. Sin contar los "Primer saldo": ${tot.despues} de ${tot.comparables} (${pct(tot.despues, tot.comparables)}).`)
  p(`- Conciliación por cuenta (filas de Conciliacion_Diaria en el período): ${antes.conc.length}. Coinciden antes ${cA} (${pct(cA, antes.conc.length)}) · después ${cD} (${pct(cD, despues.conc.length)}).`)
  p(`- Control de la migración (planilla = a cargar + cubiertas + no mapeadas, filas y pesos): antes **${migA.cierra ? 'cierra' : 'NO CIERRA'}** · después **${migD.cierra ? 'cierra' : 'NO CIERRA'}**.${[...migA.malas, ...migD.malas].map((m) => ` ${enmascarar(m)}.`).join('')}`)
  if (despues.pagos) {
    const g = despues.pagos, o = g.espejo.omitidas?.length ?? 0
    const cierraPagos = g.leidas === g.fuera_de_rango + g.traducidas + g.omitidas_traduccion.length && g.traducidas === g.espejo.nuevas + g.espejo.actualizadas + g.espejo.sin_cambios + o
    p(`- Pagos de VBI+ (copia por el mismo camino que producción: pagoDesdeFila + espejar_pagos): leídas ${g.leidas} = fuera del período ${g.fuera_de_rango} + traducidas ${g.traducidas} + no traducidas ${g.omitidas_traduccion.length} (anulados u otras); traducidas = nuevas ${g.espejo.nuevas} + omitidas por la base ${o} → **${cierraPagos ? 'cierra' : 'NO CIERRA'}**.`)
  }
  p(`- Vínculos movimiento ↔ documento en la base DESPUÉS: ${despues.vinculos.pagos} pagos, ${despues.vinculos.cheques} cheques, ${despues.vinculos.cobros} cobros, ${despues.vinculos.contraparte} con contraparte FCI/remunerada, sobre ${despues.vinculos.movimientos} movimientos (ANTES: ${antes.vinculos.pagos} · ${antes.vinculos.cheques} · ${antes.vinculos.cobros} · ${antes.vinculos.contraparte}).`)
  p()
  p('| Unidad | Días comparados | Coinciden antes | Coinciden después | % antes | % después |')
  p('|---|--:|--:|--:|--:|--:|')
  for (const r of resumen) p(`| ${NOMBRE[r.unidad] ?? r.unidad} | ${r.dias} | ${r.antes} | ${r.despues} | ${pct(r.antes, r.dias)} | ${pct(r.despues, r.dias)} |`)
  p(`| **Total** | **${tot.dias}** | **${tot.antes}** | **${tot.despues}** | **${pct(tot.antes, tot.dias)}** | **${pct(tot.despues, tot.dias)}** |`)
  p()

  p('## Causas encontradas (5 porqués) y qué se corrigió')
  p()
  p('| # | Síntoma en el simulacro | Causa raíz | Corrección | Dónde |')
  p('|---|---|---|---|---|')
  p('| 1 | F en casi todos los días con pagos (la base restaba pagos que el banco ya mostraba como débito) | El extracto trae el débito (VBI+ lo marca INFORMATIVO) y el sistema trae el pago: la base contaba los dos. Por qué: flujo_lineas excluía el débito por categoría (PAGO), no por vínculo, y nadie vinculaba el débito con el pago | El movimiento se vincula a su documento (pago, cheque debitado, cobro) por importe, empresa, cuenta y ventana de fecha; un movimiento vinculado no entra (entra el documento) y uno sin vincular sí, sea cual sea su categoría | 0030 · conciliar_movimientos + triggers |')
  p('| 2 | Pagos de una cuenta de Dax Salud caían en Beratung S/Dax | La copia de la hoja guarda la cuenta como texto y pagos.cuenta_origen_id quedaba vacío → unidad por defecto | La base deduce la cuenta del texto sin adivinar (patrón, banco único o últimos 4 dígitos) y el pago vinculado toma día y unidad del débito | 0030 · cuenta_de_pago, flujo_lineas |')
  p('| 3 | Débitos de cheques (proveedores y financieras) desaparecían del Flujo | Los cheques "Pagado" del Cash Flow no se migraban (solo Pendiente) y el débito con categoría CHEQUE_PAGADO se excluía | Cheques "Pagado" cobrados desde el inicio de la carga entran DEBITADO; el débito se vincula al cheque | script · transformar/cargar; 0030 |')
  p('| 4 | Cheques sin pago vinculado en "Sin clasificar" | El destino del cheque salía de la cuenta contable del pago, que no existe | Reglas por categoría del acreedor del Cash Flow y por unidad (flujo_reglas.si_unidad_id): P → la fila de cheques a proveedores de cada pestaña; F… → la fila "Cheques Financieras <X>" o "Pagaré <X>" cuyo nombre está en los acreedores de esa categoría (lista abajo) | script + 0030 |')
  p('| 5 | Transferencias propias registradas como pago daban F en las dos unidades | Una regla de la Llave las excluía o las mandaba a otra unidad, y con el débito vinculado la plata desaparecía del control | Lo REAL que pasó por una cuenta con extracto queda en la unidad de esa cuenta y no se excluye (va a "Entre cuentas propias") | 0030 · flujo_lineas |')
  p('| 6 | "Rendimiento" del FCI igual a toda la suscripción el día que se suscribe | La suscripción (DEB SUSCR FCI) no tenía contraparte: la conciliación del FCI la tomaba como rendimiento | Si la cuenta madre tiene un solo FCI/remunerada, el movimiento FCI lleva ese fondo como contraparte | 0030 |')
  p('| 7 | Pagos de la hoja que nunca salieron del banco (duplicados, otra cuenta) daban F | Contaban como reales aunque el extracto del día estaba y no había débito | Un pago de cuenta con extracto es real cuando el banco lo debita; mientras tanto queda en la vista pagos_sin_debito (con marca de posible duplicado) | 0030 |')
  p('| 8 | Un día de una cuenta con todos los movimientos dos veces | VBI+ importó el mismo día dos veces (CSV y PDF, descripciones en mayúsculas y minúsculas) | Archivo superpuesto: el archivo posterior solo agrega importes nuevos del mismo día y cuenta (la misma regla que importar_extracto) | script · transformar |')
  p('| 9 | Un saldo de Conciliacion_Diaria muy distinto al del Flujo | Conciliacion_Diaria tomó como saldo de cierre el de un movimiento intermedio (ella misma marca DIFERENCIA) | Si VBI+ marca DIFERENCIA y el saldo del Flujo es justo el calculado por los movimientos, vale el del Flujo | script · transformar |')
  p('| 10 | Días "Sin extracto" en la base que en el Flujo tienen saldo | Los saldos del Flujo que son fórmula no se migraban | Se toman con su valor (MANUAL) | script · transformar |')
  p('| 11 | Pagos en efectivo en el control contra bancos | Un pago "Caja" no pasa por ningún extracto | flujo_control suma solo lo que mueve un banco (flujo_lineas.afecta_bancos) | 0030 |')
  p()
  p('## Decisiones que necesita Santiago')
  p()
  p('1. **Mercado Pago (Dax Salud e India)**: el saldo del Flujo viejo es MANUAL y no se actualiza con los movimientos de MP (que sí están en Motor › Bancos Movimientos y en la base). ¿Se sube el extracto de MP todos los días (y la base pasa a controlar MP) o MP queda fuera del control (requiere_extracto = false)? Hoy es la causa de la mayoría de los días de Dax Salud e India que no coinciden.')
  p('2. **Vértice · Macro CC y FCI Macro**: VBI+ no tiene extracto de Macro antes del 24/11; los saldos son del Flujo viejo (MANUAL) y no hay movimientos que los expliquen. [FALTA] el extracto de Macro de Vértice del 02/11 al 23/11 para cerrar esos días.')
  p('3. **Pagos sin débito** (tabla abajo): ¿se anulan en la hoja los duplicados y se corrige la cuenta o la fecha de los demás? Mientras tanto, la base no los cuenta como reales. Ojo: buena parte son pagos a prestadores que el banco debita en lote (un débito por varios pagos); la base vincula 1 a 1 y no los reconoce. [FALTA] regla de lote (un débito = suma de pagos del mismo día y cuenta) — propuesta para la próxima tanda; el control igual cierra porque cuenta el débito.')
  p('3b. **Conciliación por cuenta**: la base puede coincidir en menos filas que antes contra VBI+ a propósito: donde VBI+ tomó mal el saldo de cierre o importó un archivo dos veces (causas 8 y 9), VBI+ marca DIFERENCIA y la base, corregida, Ok.')
  p('4. **Reglas nuevas de la base** (0030), para aprobar: (a) un movimiento sin documento cuenta como real aunque su categoría sea PAGO o CHEQUE_PAGADO; (b) un pago de cuenta con extracto es real recién cuando aparece el débito; (c) lo real de un banco queda en la unidad de esa cuenta aunque una regla de la Llave diga otra cosa; (d) ventana de vinculación: el banco puede debitar hasta 2 días antes y 5 después de la fecha cargada.')
  const reglasCheques = despues.plan.flujo_reglas.filter((x) => x.si_origen === 'CHEQUE')
  p(`5. **Destino de cheques por categoría** (${reglasCheques.length} reglas, salen de las planillas), a confirmar: ${reglasCheques.map((x) => `${NOMBRE[x.unidad] ?? x.unidad} · ${x.si_categoria} → ${x.fila}`).join('; ')}.`)
  p('6. **Período en paralelo real**: con 1 y 2 resueltos, correr este simulacro cada día hábil durante dos semanas antes de apagar las planillas.')
  p()
  p('## Unidad × día')
  p()
  p('Saldo bancos = suma de las cuentas de la unidad ese día. Δ base = saldo bancos − saldo anterior − lo real de la base (lo que flujo_control llama diferencia). Caja del Período = lo que movió el Flujo original ese día.')
  p()
  for (const u of unidades) {
    p(`### ${NOMBRE[u] ?? u}`)
    p()
    p('| Día | Planilla | Base antes | Base después | Saldo bancos planilla | Saldo bancos base | Caja del Período (planilla) | Real base después | Δ base después | Coincide antes / después |')
    p('|---|---|---|---|--:|--:|--:|--:|--:|---|')
    const a = antes.flujo.filter((f) => f.unidad === u), d = despues.flujo.filter((f) => f.unidad === u)
    for (const x of d) {
      const y = a.find((z) => z.fecha === x.fecha)
      p(`| ${x.fecha.slice(8)}/${x.fecha.slice(5, 7)} | ${e(x.estado_planilla)} | ${e(y?.estado_base)} | ${e(x.estado_base)} | ${$(x.saldo_planilla)} | ${$(x.saldo_base)} | ${$(x.caja_periodo)} | ${$(x.real_base)} | ${$(x.dif_base)} | ${y?.coincide ? 'sí' : 'no'} / ${x.coincide ? 'sí' : 'no'} |`)
    }
    p()
  }

  p('## Diferencias que quedan (DESPUÉS) y su causa')
  p()
  p('La causa sale de la base: cuentas con DIFERENCIA en conciliacion_bancaria ese período (sus movimientos no explican su saldo) y documentos que cuentan como reales sin débito vinculado.')
  p()
  const quedan = despues.flujo.filter((f) => !f.coincide)
  p('| Unidad | Día | Planilla | Base | Δ base | Causa |')
  p('|---|---|---|---|--:|---|')
  for (const f of quedan) {
    const d = despues.detalle.find((x) => x.unidad === f.unidad && x.fecha === f.fecha)
    const causa = f.estado_base === 'PRIMER_SALDO' ? 'no comparable: la base no tiene un día anterior con todas las cuentas (primer día cargado)'
      : f.estado_base === 'SIN_EXTRACTO' ? `falta el saldo de alguna cuenta ese día (${f.cuentas_con_saldo})`
      : f.dif_saldo !== null && f.dif_saldo !== 0n ? `el saldo de bancos difiere en ${$(f.dif_saldo)} · ${causaDelDia(d, pesosAR)}`
      : causaDelDia(d, pesosAR)
    p(`| ${NOMBRE[f.unidad] ?? f.unidad} | ${f.fecha.slice(8)}/${f.fecha.slice(5, 7)} | ${e(f.estado_planilla)} | ${e(f.estado_base)} | ${$(f.dif_base)} | ${enmascarar(causa)} |`)
  }
  p()
  const sumaQuedan = quedan.reduce((a, f) => a + (f.dif_base ?? 0n), 0n)
  p(`Control: ${quedan.length} días sin coincidir; suma de Δ base de esos días ${pesosAR(sumaQuedan)}. ${quedan.length + tot.despues === tot.dias ? 'Días que coinciden + que no = días comparados: cierra.' : '**No cierra el conteo de días.**'}`)
  p()

  p('## Pagos de la hoja que el banco no muestra (vista pagos_sin_debito)')
  p()
  p('No cuentan como reales en la base DESPUÉS (antes sí, y el control daba F). Hay que decidir si se anulan, se corrigen (cuenta o fecha) o se dejan.')
  p()
  if (!despues.sinDebito.length) p('Ninguno.')
  else {
    p('| Empresa | Fecha | Importe | Proveedor | Cuenta | Fila VBI+ Pagos | ¿Posible duplicado? |')
    p('|---|---|--:|---|---|--:|---|')
    let s = 0n
    for (const x of despues.sinDebito) {
      const imp = cent(x.importe)
      s += imp
      p(`| ${x.empresa} | ${x.fecha} | ${pesosAR(imp)} | ${enmascarar(x.proveedor ?? '')} | ${enmascarar(x.cuenta)} | ${x.fila ?? '—'} | ${x.posible_duplicado ? 'sí' : 'no'} |`)
    }
    p(`| **Total** | | **${pesosAR(s)}** | | | | ${despues.sinDebito.filter((x) => x.posible_duplicado).length} posibles duplicados |`)
  }
  p()

  p('## Conciliación por cuenta: VBI+ › Conciliacion_Diaria contra la base (DESPUÉS)')
  p()
  const cm = despues.conc.filter((x) => !x.coincide)
  p(`${despues.conc.length} filas; coinciden ${cD}. VBI+ marca DIFERENCIA el primer día de una cuenta (no tiene saldo inicial) y la base PRIMER_SALDO; y marca "EXTRACTO" la tenencia de un FCI, que la base da Ok con el rendimiento como diferencia: las dos cuentan como coincidencia. Las que no coinciden:`)
  p()
  p('| Fecha | Empresa | Banco (VBI+) | Cuenta base | VBI+ | Base | Dif. VBI+ | Dif. base |')
  p('|---|---|---|---|---|---|--:|--:|')
  for (const x of cm) p(`| ${x.fecha} | ${x.empresa} | ${enmascarar(x.banco)} | ${enmascarar(x.cuenta ?? '—')} | ${e(x.estado_vbi)} | ${e(x.estado_base)} | ${$(x.dif_vbi)} | ${$(x.dif_base)} |`)
  p()
  return { texto: L.join('\n'), resumen, tot }
}
