#!/usr/bin/env node
// T-206 · Simulacro del período en paralelo (en local, nada real se toca).
//
// Arma DOS bases PGlite en memoria con los datos reales de las planillas (desde instantáneas, fuera del repo):
//   · ANTES:   migraciones hasta 0029 + script de migración sin las correcciones de T-206 + pagos de VBI+
//   · DESPUÉS: todas las migraciones (incluida 0030) + script de migración con las correcciones + pagos de VBI+
// y compara cada una, por unidad y día, contra el Flujo original (fila "Conciliación Bancaria", saldos por banco y Caja
// del Período) y, por cuenta y día, contra VBI+ › Conciliacion_Diaria. Escribe el reporte (fuera del repo).
//
// Uso (desde demo/):
//   node scripts/paralelo/paralelo.mjs --instantaneas DIR [--pagos DIR] [--reporte ARCHIVO.md] [--desde 2026-11-02] [--hasta 2026-11-25] [--hoy 2026-11-26]
// Variables de entorno: PLANILLA_VBI, PLANILLA_MOTOR, PLANILLA_FLUJO_ORIGINAL, PLANILLA_CASHFLOW (IDs: nombre de cada instantánea).
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { idsDePlanillas, leerPlanillas } from '../migrar-desde-planillas/fuente.mjs'
import { transformar } from '../migrar-desde-planillas/transformar.mjs'
import { cargar } from '../migrar-desde-planillas/cargar.mjs'
import { basePrueba, opciones as opcionesMigracion } from '../migrar-desde-planillas/migrar.mjs'
import { leerFlujoOriginal, leerConciliacionVbi } from './planillas.mjs'
import { filasPagos, espejarPagos } from './pagos.mjs'
import { controlBase, compararFlujo, conciliacionBase, compararConciliacion } from './comparar.mjs'
import { armarReporte } from './reporte.mjs'
import { detalleDias } from './diagnostico.mjs'

const aqui = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(aqui, '../../..')
const MIGRACIONES = join(aqui, '../../supabase/migrations')

export function opciones(argv = process.argv.slice(2)) {
  const o = { desde: '2026-11-02', hasta: '2026-11-25', hoy: '2026-11-26' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], sig = () => argv[++i]
    if (a === '--instantaneas') o.instantaneas = sig()
    else if (a === '--pagos') o.pagos = sig()
    else if (a === '--reporte') o.reporte = sig()
    else if (a === '--desde') o.desde = sig()
    else if (a === '--hasta') o.hasta = sig()
    else if (a === '--hoy') o.hoy = sig()
    else throw new Error(`Opción desconocida: ${a}`)
  }
  o.reporte ??= join(tmpdir(), 'paralelo-noviembre.md')
  return o
}

/** Día anterior (para cargar saldos y movimientos desde el último día hábil de octubre: el primer día comparado tiene contra qué). */
const menosDias = (d, n) => new Date(Date.parse(d) - n * 86400000).toISOString().slice(0, 10)

/** Una base con los datos reales y su comparación contra las planillas. */
export async function escenario(planillas, filas, op, { hastaMigracion, correcciones }) {
  const desdeCarga = menosDias(op.desde, 3) // 30/10 (viernes) para que el 02/11 tenga saldo anterior
  const opm = { ...opcionesMigracion(['--hoy', op.hoy, '--desde', desdeCarga]), correcciones }
  const { plan, control } = transformar(planillas, opm)
  const db = await basePrueba(MIGRACIONES, { hasta: hastaMigracion })
  const carga = await cargar(db, plan, { correcciones })
  const pagos = filas ? await espejarPagos(db, filas, { desde: desdeCarga, hasta: op.hasta }) : null
  if (correcciones) await db.query(`select vincular_pagos_a_cuentas()`) // 0030: pagos ya espejados toman su cuenta
  const flujoPl = leerFlujoOriginal(planillas.original, op)
  const flujo = compararFlujo(flujoPl, await controlBase(db, op))
  const conc = compararConciliacion(leerConciliacionVbi(planillas.vbi, op), plan.saldos_bancarios, await conciliacionBase(db, op))
  const vinculos = (await db.query(`select count(*) filter (where pago_id is not null)::int as pagos, count(*) filter (where cheque_id is not null)::int as cheques,
      count(*) filter (where cobro_id is not null)::int as cobros, count(*) filter (where contraparte_cuenta_id is not null)::int as contraparte,
      count(*)::int as movimientos from movimientos_bancarios`)).rows[0]
  const sinDebito = correcciones ? (await db.query(`select p.empresa_id as empresa, p.fecha::text as fecha, p.importe::text as importe, p.proveedor_destino as proveedor,
      p.cuenta, p.sheets_fila_origen as fila, p.posible_duplicado from pagos_sin_debito p where p.fecha between $1 and $2 order by p.empresa_id, p.fecha, p.importe desc`,
      [op.desde, op.hasta])).rows : []
  const detalle = correcciones ? await detalleDias(db, flujo) : []
  await db.close()
  return { flujo, conc, detalle, carga, pagos, control, plan, vinculos, sinDebito }
}

async function main() {
  const op = opciones()
  if (resolve(op.reporte).startsWith(REPO + '/')) throw new Error('El reporte tiene datos reales: no se guarda dentro del repo')
  if (!op.instantaneas) throw new Error('Falta --instantaneas DIR (este simulacro no lee de Google)')
  const { ids, faltan } = idsDePlanillas()
  if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`)
  const planillas = await leerPlanillas(ids, { instantaneas: op.instantaneas })
  const filas = await filasPagos({ vbi: planillas.vbi, carpeta: op.pagos })
  if (!filas) console.warn('[FALTA] Sin pagos de VBI+ (ni pestaña Pagos en la instantánea ni --pagos): el Flujo de la base no tiene pagos reales')
  console.log('Escenario ANTES (hasta 0029, sin correcciones)…')
  const antes = await escenario(planillas, filas, op, { hastaMigracion: '0029', correcciones: false })
  console.log('Escenario DESPUÉS (con 0030 y correcciones)…')
  const despues = await escenario(planillas, filas, op, { hastaMigracion: null, correcciones: true })
  const { texto, resumen } = armarReporte({ antes, despues, op, generado: new Date().toISOString(), conPagos: !!filas })
  writeFileSync(op.reporte, texto)
  console.log(`Reporte: ${op.reporte}`)
  for (const r of resumen) console.log(`${r.unidad.padEnd(10)} días ${r.dias} · coinciden antes ${r.antes} · después ${r.despues}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1) })
}
