#!/usr/bin/env node
// T-206 · Simulacro del período en paralelo (en local, nada real se toca).
//
// Arma DOS bases PGlite en memoria con los datos reales de las planillas (desde instantáneas, fuera del repo):
//   · ANTES:   migraciones hasta 0031 + script de migración con las correcciones de T-206 + pagos de VBI+
//   · DESPUÉS: todas las migraciones (0032: lotes) + script con las correcciones de T-209 (rescates de FCI) + pagos
// (T-206 comparaba 0029 contra 0030; con escenario() se puede armar cualquier par.)
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
import { armarReporteV2 } from './reporte_v2.mjs'
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
  o.reporte ??= join(tmpdir(), 'paralelo-noviembre-v2.md')
  return o
}

/** Día anterior (para cargar saldos y movimientos desde el último día hábil de octubre: el primer día comparado tiene contra qué). */
const menosDias = (d, n) => new Date(Date.parse(d) - n * 86400000).toISOString().slice(0, 10)

/** Una base con los datos reales y su comparación contra las planillas. */
export async function escenario(planillas, filas, op, { hastaMigracion, correcciones, rescatesFci = true }) {
  const desdeCarga = menosDias(op.desde, 3) // 30/10 (viernes) para que el 02/11 tenga saldo anterior
  const opm = { ...opcionesMigracion(['--hoy', op.hoy, '--desde', desdeCarga]), correcciones, rescatesFci }
  const { plan, control } = transformar(planillas, opm)
  const db = await basePrueba(MIGRACIONES, { hasta: hastaMigracion })
  const carga = await cargar(db, plan, { correcciones })
  const hay = async (f) => (await db.query(`select to_regprocedure($1) is not null as h`, [f])).rows[0].h
  const hayTabla = async (t) => (await db.query(`select to_regclass($1) is not null as h`, [t])).rows[0].h
  // Los pagos entran todos y se concilia una vez al final (como importar_extracto de 0031), no por cada pago.
  await db.query(`select set_config('tesoreria.conciliar_al_final', '1', false)`)
  const pagos = filas ? await espejarPagos(db, filas, { desde: desdeCarga, hasta: op.hasta }) : null
  await db.query(`select set_config('tesoreria.conciliar_al_final', '', false)`)
  if (correcciones) await db.query(`select vincular_pagos_a_cuentas()`) // 0030: pagos ya espejados toman su cuenta
  if (await hay('conciliar_movimientos(text)')) await db.query(`select conciliar_movimientos(id) from empresas order by id`)
  const flujoPl = leerFlujoOriginal(planillas.original, op)
  const flujo = compararFlujo(flujoPl, await controlBase(db, op))
  const conc = compararConciliacion(leerConciliacionVbi(planillas.vbi, op), plan.saldos_bancarios, await conciliacionBase(db, op))
  const lotes = await hayTabla('movimientos_pagos')
  const vinculos = (await db.query(`select count(*) filter (where pago_id is not null)::int as pagos, count(*) filter (where cheque_id is not null)::int as cheques,
      count(*) filter (where cobro_id is not null)::int as cobros, count(*) filter (where contraparte_cuenta_id is not null)::int as contraparte,
      count(*)::int as movimientos${lotes ? ', (select count(distinct movimiento_id)::int from movimientos_pagos) as lotes, (select count(*)::int from movimientos_pagos) as pagos_en_lotes' : ''}
      from movimientos_bancarios`)).rows[0]
  const sinDebito = correcciones ? (await db.query(`select p.id, p.hoja_id, p.empresa_id as empresa, p.fecha::text as fecha, p.importe::text as importe, p.proveedor_destino as proveedor,
      p.cuenta, p.sheets_fila_origen as fila, p.posible_duplicado${lotes ? `, p.motivo, (select m.cuenta_origen_id <> p.cuenta_origen_id from movimientos_bancarios m where m.id = p.debito_parecido_id) as otra_cuenta,
      (select m.fecha::text from movimientos_bancarios m where m.id = p.debito_parecido_id) as fecha_debito` : ''}
      from pagos_sin_debito p where p.fecha between $1 and $2 order by p.empresa_id, p.fecha, p.importe desc`,
      [op.desde, op.hasta])).rows : []
  // Cómo quedó cada pago (por la clave de la hoja): vinculado 1 a 1, en lote o sin vincular.
  const estadoPagos = new Map((await db.query(`select p.hoja_id,
      case when ${lotes ? 'exists (select 1 from movimientos_pagos x where x.pago_id = p.id)' : 'false'} then 'LOTE'
           when exists (select 1 from movimientos_bancarios m where m.pago_id = p.id) then
             case when (select count(*) from movimientos_bancarios m where m.pago_id = p.id) > 1 then 'VARIOS_DEBITOS' else 'UNO_A_UNO' end
           else 'SIN' end as estado from pagos p where p.hoja_id is not null`)).rows.map((r) => [r.hoja_id, r.estado]))
  const revisar = lotes ? (await db.query(`select r.tipo, r.motivo, r.combinaciones, r.candidatos, r.importe::text as importe, r.empresa_id as empresa,
      coalesce(m.fecha, p.fecha)::text as fecha, coalesce(c.nombre, cp.nombre) as cuenta, coalesce(m.descripcion, p.proveedor_destino) as detalle
      from conciliacion_revisar r left join movimientos_bancarios m on m.id = r.movimiento_id left join cuentas_origen c on c.id = m.cuenta_origen_id
      left join pagos p on p.id = r.pago_id left join cuentas_origen cp on cp.id = p.cuenta_origen_id
      where coalesce(m.fecha, p.fecha) between $1 and $2 order by r.importe desc`, [op.desde, op.hasta])).rows : []
  // Mercado Pago: el saldo que dan sus movimientos día por día contra el saldo cargado (MANUAL del Flujo viejo).
  const mp = (await db.query(`
      with c as (select co.id, co.nombre, u.codigo as unidad from cuentas_origen co join unidades u on u.id = co.unidad_id
                 where co.clase = 'BILLETERA' and co.activa and u.codigo in ('dax-salud', 'india')),
      ini as (select distinct on (c.id) c.id, s.fecha, s.saldo from c join saldos_bancarios s on s.cuenta_origen_id = c.id
              order by c.id, s.fecha),
      dias as (select c.id, c.unidad, s.fecha, s.saldo, s.origen from c join saldos_bancarios s on s.cuenta_origen_id = c.id where s.fecha between $1 and $2)
      select d.unidad, d.fecha::text as fecha, d.origen, d.saldo::text as saldo_cargado, i.saldo::text as saldo_inicial, i.fecha::text as fecha_inicial,
             (select coalesce(sum(m.importe), 0) from movimientos_bancarios m where m.cuenta_origen_id = d.id and m.fecha > i.fecha and m.fecha <= d.fecha and m.estado <> 'IGNORADO')::text as movido,
             (select coalesce(sum(m.importe), 0) from movimientos_bancarios m where m.cuenta_origen_id = d.id and m.fecha = d.fecha and m.estado <> 'IGNORADO')::text as movido_dia,
             (select count(*)::int from movimientos_bancarios m where m.cuenta_origen_id = d.id and m.fecha = d.fecha and m.estado <> 'IGNORADO') as movimientos_dia
      from dias d join ini i on i.id = d.id order by d.unidad, d.fecha`, [op.desde, op.hasta])).rows
  const reclasificadosFci = plan.movimientos_bancarios.filter((m) => m.reclasificado)
    .map((m) => ({ empresa: m.empresa, cuenta: m.cuenta, fecha: m.fecha, importe: m.importe, tipo: m.reclasificado }))
  // "Rendimientos" de FCI que no son rendimiento: más del 1 % del saldo anterior en un día (0031 los marca REVISAR).
  const rendRaros = (await db.query(`select cb.cuenta, cb.fecha::text as fecha, cb.rendimiento::text as rendimiento, cb.saldo_anterior::text as anterior
      from conciliacion_bancaria cb where cb.fecha between $1 and $2 and cb.rendimiento is not null
        and abs(cb.rendimiento) > greatest(abs(coalesce(cb.saldo_anterior, 0)) * 0.01, 1000) order by abs(cb.rendimiento) desc`, [op.desde, op.hasta])).rows
  const detalle = correcciones ? await detalleDias(db, flujo) : []
  await db.close()
  return { flujo, conc, detalle, carga, pagos, control, plan, vinculos, sinDebito, estadoPagos, revisar, mp, reclasificadosFci, rendRaros }
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
  console.log('Escenario ANTES (hasta 0031, correcciones de T-206, sin las de T-209)…')
  const antes = await escenario(planillas, filas, op, { hastaMigracion: '0031', correcciones: true, rescatesFci: false })
  console.log('Escenario DESPUÉS (todas las migraciones, con 0032 y las correcciones de T-209)…')
  const despues = await escenario(planillas, filas, op, { hastaMigracion: null, correcciones: true, rescatesFci: true })
  const { texto, resumen } = armarReporteV2({ antes, despues, op, generado: new Date().toISOString(), conPagos: !!filas })
  writeFileSync(op.reporte, texto)
  console.log(`Reporte: ${op.reporte}`)
  for (const r of resumen) console.log(`${r.unidad.padEnd(10)} días ${r.dias} · coinciden antes ${r.antes} · después ${r.despues}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1) })
}
