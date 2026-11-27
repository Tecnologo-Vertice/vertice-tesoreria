// Pruebas de 0038: Flujo, lo que usan en la grilla (Tanda 6 de PARIDAD_COMPLETA.md, 27/11/2026).
//   1. "Esta y las siguientes" al cambiar una proyección recurrente (fbProyCambiar).
//   3. Filas MANUAL que suman en los subtotales y en la caja; las proyecciones recurrentes no entran en esas filas.
//   4. Persona física pagada desde Dax: va a Consultorios (regla 3 del motor).
//   5. Planilla de gastos del mes: cruce con las facturas con ±1 %, pendientes de factura y "Gastos Mes Control".
//   6. Foto mensual de la proyección: tabla, acción, programación del servidor y permisos.
// (El punto 2, exportar la grilla, es de la pantalla: lo prueba `npm test` con la prueba de lib/tesoreria.)
// Datos ficticios. Las fechas salen siempre de hoy_ar(), nunca de current_date.
// Uso (desde demo/): node supabase/pruebas/probar_0038.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
const error = async (sql, p = []) => { try { await db.query(sql, p); return null } catch (e) { return e.message } }
const falla = async (nombre, sql, p, patron) => { const e = await error(sql, p); check(nombre, e !== null && patron.test(e), e ?? 'no falló') }
let actual = null
const como = async (email) => {
  actual = email
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const comoAnon = async () => { actual = null; await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role anon`) }
const servidor = async () => { actual = null; await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const alServidor = (fn) => async (...a) => { const antes = actual; await servidor(); try { return await fn(...a) } finally { if (antes) await como(antes) } }

await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant select, insert on storage.objects to authenticated;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated;
  alter default privileges in schema public grant all on tables to service_role;
  alter default privileges in schema public grant all on sequences to service_role;
  alter default privileges in schema public grant execute on functions to service_role;
`)
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (con 0038)', true)

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
const habil = async (d) => (await val(`select dia_habil_desde($1::date)::text d`, [d])).d
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('aprob@prueba.com', 'Aprob', 'APROBADOR', true),
    ('admin@prueba.com', 'Admin', 'ADMIN', true), ('dir@prueba.com', 'Dirección', 'DIRECCION', true),
    ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false), ('soloind@prueba.com', 'Solo India', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung'), ('soloind@prueba.com', 'india');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const uBer = (await val(`select id from unidades where empresa_id = 'beratung' and por_defecto`)).id
const uDax = (await val(`select id from unidades where empresa_id = 'beratung' and nombre = 'Dax Salud'`)).id
const fila = async (unidad, etiqueta, seccion, cuenta, orden = 500) => (await val(
  `insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable) values ($1, 'x', $2, 'CUENTA', $3, $4, $5) returning id`,
  [unidad, orden, seccion, etiqueta, cuenta])).id
const filaBase = async (unidad, seccion) => (await val(`select id from flujo_filas where unidad_id = $1 and seccion = $2 and tipo <> 'SECCION' order by orden limit 1`, [unidad, seccion])).id

// India: una fila común, una de gastos y una "manual" (sueldos).
const fAlq = await fila(uIndia, 'Alquiler', 'GASTOS_OPERATIVOS', 'ALQUILER DE OFICINA', 320)
const fSueldos = await fila(uIndia, 'Sueldos y jornales', 'GASTOS_OPERATIVOS', 'SUELDOS Y JORNALES', 310)
const fCobr = await fila(uIndia, 'Cobranzas', 'INGRESOS_OPERATIVOS', 'DEUDORES POR VENTAS', 110)
const fSoc = await fila(uIndia, 'Retiros de socios', 'SOCIOS', 'RETIROS DE SOCIOS', 910)
const fImp = await fila(uIndia, 'Impuesto al cheque', 'IMPUESTOS', 'IMPUESTO DEB/CRED BANCARIO', 410)
// Dax Salud: Consultorios, honorarios genéricos e insumos. Beratung S/Dax: honorarios.
const fCons = await fila(uDax, 'Prestaciones médicas · Consultorios', 'COSTOS', 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO TUCUMAN', 220)
const fHon = await fila(uDax, 'Honorarios profesionales', 'COSTOS', 'HONORARIOS PROFESIONALES', 230)
const fIns = await fila(uDax, 'Insumos', 'COSTOS', 'COSTO DE INSUMOS', 210)
const fPresta = await fila(uDax, 'Prestaciones médicas', 'COSTOS', 'PRESTACIONES VARIAS', 225)
const fDeud = await fila(uDax, 'DEUDORES POR VENTAS - Consultorios Tucumán', 'INGRESOS_OPERATIVOS', 'DEUDORES POR VENTAS', 110)
const fHonBer = await fila(uBer, 'Honorarios profesionales', 'COSTOS', 'HONORARIOS PROFESIONALES', 230)

const crear = async (extra) => (await val(`select crear_proyeccion($1) id`, [{
  empresa_id: 'india', unidad_id: uIndia, fila_id: fAlq, concepto: 'Alquiler', importe: -100, fecha_inicio: dia(7), recurrencia: 'UNICA', ...extra }])).id
const lineasDe = (id, desde = hoy, hasta = dia(120)) => filas(
  `select ocurrencia, fecha::text, importe::float as importe, ajustada from flujo_lineas_entre($1, $2, null, false) where origen_tipo = 'PROYECCION' and origen_id = $3 order by ocurrencia`, [desde, hasta, id])
const proy = async (id) => val(`select estado, hasta::text, cuotas, importe::float as importe, fecha_inicio::text, dia_mes, origen, nota from proyecciones where id = $1`, [id])

// ================================================================ 1. "Esta y las siguientes"
await como('teso@prueba.com')
const serie = await crear({ recurrencia: 'SEMANAL', cuotas: 5, importe: -100 })        // dia 7, 14, 21, 28 y 35
let ls = await lineasDe(serie)
check('[1] la serie semanal de 5 cuotas da 5 líneas de -100', ls.length === 5 && ls.every((l) => l.importe === -100), JSON.stringify(ls))
// Una excepción en la ocurrencia 28 que después tiene que acompañar a la serie nueva.
await db.query(`select ajustar_linea_flujo('PROYECCION', $1, $2, null, 999, false, 'prueba')`, [serie, dia(28)])
// Solo esta: la del día 14 pasa a 150.
let r = (await val(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 150, null, 'sube esta') id`, [serie, dia(14)])).id
ls = await lineasDe(serie)
check('[1] solo esta: cambia esa ocurrencia (-150) y las demás quedan como estaban', r === null && ls.find((l) => l.ocurrencia === dia(14))?.importe === -150
  && ls.filter((l) => l.importe === -100).length === 3 && ls.length === 5, JSON.stringify(ls))
check('[1] solo esta: sigue habiendo una sola proyección activa y la serie no se tocó', (await proy(serie)).estado === 'ACTIVA' && (await proy(serie)).hasta === null)
// Esta y las siguientes: desde el día 21, importe 200.
const nueva = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 200, null, 'nuevo precio') id`, [serie, dia(21)])).id
const vieja = await proy(serie), nv = await proy(nueva)
check('[1] desde esta: la serie vieja termina el día anterior y la nueva empieza en esta ocurrencia', vieja.estado === 'ACTIVA' && vieja.hasta === dia(20) && nv.fecha_inicio === dia(21) && nv.importe === -200 && nv.estado === 'ACTIVA', JSON.stringify({ vieja, nv }))
check('[1] la nueva sigue con las cuotas que quedaban (5 - 2 = 3), el mismo origen y "Sigue a …"', nv.cuotas === 3 && nv.origen === vieja.origen && /^Sigue a /.test(nv.nota), JSON.stringify(nv))
const lv = await lineasDe(serie), ln = await lineasDe(nueva)
check('[1] vieja: días 7 y 14 (con su excepción de -150); nueva: 21, 28 y 35 con -200',
  lv.map((l) => l.ocurrencia).join() === [dia(7), dia(14)].join() && lv[1].importe === -150 && ln.map((l) => l.ocurrencia).join() === [dia(21), dia(28), dia(35)].join(), JSON.stringify({ lv, ln }))
check('[1] la excepción de más adelante (el 28, -999) pasa a la serie nueva y la vieja no la conserva', ln.find((l) => l.ocurrencia === dia(28))?.importe === -999
  && (await val(`select count(*)::int n from flujo_ajustes where origen_id = $1 and reemplazado_en is null and ocurrencia = $2`, [serie, dia(28)])).n === 0, JSON.stringify(ln))
check('[1] la ocurrencia donde se corta toma el importe nuevo (-200), no el anterior', ln[0].importe === -200)
check('[1] el total proyectado de las dos series es la suma de las 5 ocurrencias', Math.round(lv.concat(ln).reduce((a, l) => a + l.importe, 0)) === -100 - 150 - 200 - 999 - 200)

// Con cambio de fecha: la excepción no se arrastra (las fechas cambian) y la serie arranca el día nuevo.
const s2 = await crear({ recurrencia: 'SEMANAL', cuotas: 3, importe: -50, fecha_inicio: dia(8) })
await db.query(`select ajustar_linea_flujo('PROYECCION', $1, $2, null, 77, false, 'prueba')`, [s2, dia(22)])
const n2 = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'corro la fecha') id`, [s2, dia(8), dia(10)])).id
const v2 = await proy(s2), p2 = await proy(n2)
check('[1] desde la primera ocurrencia: la serie vieja se cancela (no quedaría ninguna) y la nueva arranca en la fecha nueva', v2.estado === 'CANCELADA' && p2.fecha_inicio === dia(10) && p2.cuotas === 3 && p2.importe === -50, JSON.stringify({ v2, p2 }))
const l2 = await lineasDe(n2)
check('[1] con cambio de fecha las excepciones viejas se dan de baja y las líneas salen sin ajustar', l2.length === 3 && l2.every((l) => !l.ajustada && l.importe === -50) && (await lineasDe(s2)).length === 0, JSON.stringify(l2))

// Borrar desde esta: la serie termina el día anterior y no se crea otra.
const s3 = await crear({ recurrencia: 'SEMANAL', hasta: dia(40), importe: -30, fecha_inicio: dia(7) })
const b3 = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'BORRAR', null, null, 'se terminó') id`, [s3, dia(21)])).id
check('[1] borrar desde esta: corta la serie (queda hasta el día anterior), no crea otra y no hay líneas del 21 en adelante',
  b3 === null && (await proy(s3)).hasta === dia(20) && (await lineasDe(s3)).map((l) => l.ocurrencia).join() === [dia(7), dia(14)].join())
// Borrar solo esta (recurrente): queda una excepción de baja y la serie sigue.
const s4 = await crear({ recurrencia: 'SEMANAL', cuotas: 3, importe: -30, fecha_inicio: dia(7) })
await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'BORRAR', null, null, 'este mes no')`, [s4, dia(14)])
check('[1] borrar solo esta: esa ocurrencia desaparece y las otras siguen', (await lineasDe(s4)).map((l) => l.ocurrencia).join() === [dia(7), dia(21)].join())
// Puntual: borrar la da de baja (como el Apps Script: ESTADO = BAJA).
const s5 = await crear({ importe: -10, fecha_inicio: dia(9) })
await db.query(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'BORRAR', null, null, 'no va')`, [s5, dia(9)])
check('[1] una puntual con "borrar" se cancela entera (aunque se pida "desde esta")', (await proy(s5)).estado === 'CANCELADA' && (await lineasDe(s5)).length === 0)
// Mensual: el día del mes se conserva y las cuotas que quedan se descuentan.
const sm = await crear({ recurrencia: 'MENSUAL', dia_mes: 5, cuotas: 4, importe: -1000, ajuste_pct_mensual: 10, fecha_inicio: dia(1) })
const ocm = await filas(`select ocurrencia::text o, importe::float i from proyeccion_ocurrencias((select p from proyecciones p where id = $1), $2, $3)`, [sm, dia(1), dia(200)])
const tercera = ocm[2].o
const nm = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $2, 'sigue igual') id`, [sm, tercera])).id
const pm = await proy(nm)
check('[1] mensual: la serie nueva conserva el día del mes y las cuotas que quedan (4 - 2 = 2)', pm.dia_mes === 5 && pm.cuotas === 2 && pm.fecha_inicio === tercera, JSON.stringify({ pm, tercera }))
check('[1] sin importe nuevo, la nueva arranca con el importe que ya tenía esa ocurrencia (con su ajuste mensual)', Math.abs(pm.importe - ocm[2].i) < 0.01, JSON.stringify({ pm, ocm }))
check('[1] el total mensual de las dos series es el mismo que el de la serie original',
  Math.round((await lineasDe(sm)).concat(await lineasDe(nm)).reduce((a, l) => a + l.importe, 0)) === Math.round(ocm.reduce((a, o) => a + o.i, 0)), JSON.stringify(ocm))

// Errores y permisos.
await falla('[1] sin motivo no cambia nada', `select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 5, null, '  ')`, [s4, dia(21)], /motivo/)
await falla('[1] el alcance tiene que ser uno de los dos', `select cambiar_proyeccion($1, $2, 'TODAS', 'EDITAR', 5, null, 'x')`, [s4, dia(21)], /alcance/i)
await falla('[1] editar sin importe ni fecha no hace nada', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, null, 'x')`, [s4, dia(21)], /nada para cambiar/)
await falla('[1] no se cambia lo que ya pasó', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 5, null, 'x')`, [s4, dia(-1)], /ya pasó/)
await falla('[1] no se proyecta en el pasado', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'x')`, [s4, dia(21), dia(-2)], /pasado/)
await falla('[1] una fecha que no es una ocurrencia se rechaza', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 5, null, 'x')`, [s4, dia(22)], /no tiene una ocurrencia/)
await falla('[1] el importe va en positivo', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', -5, null, 'x')`, [s4, dia(21)], /positivo/)
await falla('[1] una proyección cancelada ya no se cambia', `select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 5, null, 'x')`, [s5, dia(9)], /ya no está activa/)
const s6 = await crear({ recurrencia: 'SEMANAL', cuotas: 5, importe: -60, fecha_inicio: dia(7) })
await falla('[1] la fecha nueva no puede quedar antes de la ocurrencia anterior (dejaría dos ocurrencias pegadas)', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'x')`, [s6, dia(21), dia(9)], /antes de la ocurrencia anterior/)
check('[1] y no cambió nada: la serie sigue entera', (await lineasDe(s6)).length === 5 && (await proy(s6)).hasta === null)
const s6n = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'la corro') id`, [s6, dia(21), dia(16)])).id
check('[1] una fecha posterior a la ocurrencia anterior sí se acepta', (await proy(s6n)).fecha_inicio === dia(16))
await falla('[1] la fecha nueva no puede pasarse del final de la serie', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'x')`, [s3, dia(14), dia(60)], /después del final/)
await como('aprob@prueba.com')
await falla('[1] un aprobador no puede', `select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 5, null, 'x')`, [s4, dia(21)], /rol/)
await como('solober@prueba.com')
await falla('[1] quien no ve la empresa de la proyección no la cambia', `select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 5, null, 'x')`, [s4, dia(21)], /acceso a la empresa/)
await comoAnon()
await falla('[1] anon no la ejecuta', `select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 5, null, 'x')`, [s4, dia(21)], /permission denied|permiso/i)
await servidor()
check('[1] la auditoría anota cada cambio (PROYECCION_CAMBIAR)', (await val(`select count(*)::int n from auditoria where accion = 'PROYECCION_CAMBIAR'`)).n >= 7)
check('[1] y el detalle dice el alcance y el motivo', (await val(`select count(*)::int n from auditoria where accion = 'PROYECCION_CAMBIAR' and detalle like 'Desde el %' and detalle like '%nuevo precio%'`)).n === 1)

// ================================================================ 3. Filas MANUAL
await como('teso@prueba.com')
await como('aprob@prueba.com')
await falla('[3] un aprobador no marca filas', `select marcar_fila_flujo($1, true, false)`, [fSueldos], /rol/)
await como('teso@prueba.com')
await db.query(`select marcar_fila_flujo($1, false, false)`, [fAlq])
check('[3] Tesorería sí puede marcar y desmarcar filas', true)
await como('admin@prueba.com')
await db.query(`select marcar_fila_flujo($1, true, false)`, [fSueldos])
await db.query(`select marcar_fila_flujo($1, true, false)`, [fCobr])
check('[3] marcar la fila de sueldos como manual', (await val(`select manual from flujo_filas where id = $1`, [fSueldos])).manual === true)
await falla('[3] solo se marcan filas de cuenta, no las secciones', `select marcar_fila_flujo($1, true, false)`, [(await val(`select id from flujo_filas where unidad_id = $1 and tipo = 'SECCION' limit 1`, [uIndia])).id], /filas de cuenta/)
await como('teso@prueba.com')
await falla('[3] en una fila manual no se carga una recurrencia', `select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fSueldos, concepto: 'Sueldos', importe: -5000, fecha_inicio: dia(3), recurrencia: 'MENSUAL', dia_mes: 5, cuotas: 3 }], /sin recurrencia/)
await falla('[3] ni se carga un importe con fecha pasada', `select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fSueldos, concepto: 'Sueldos', importe: -5000, fecha_inicio: dia(-1), recurrencia: 'UNICA' }], /de hoy en adelante/)
const mDia = dia(4)
const man1 = await crear({ fila_id: fSueldos, concepto: 'Sueldos de la semana', importe: -5000, fecha_inicio: mDia, origen: 'GASTO_FIJO' })
const man2 = await crear({ fila_id: fSueldos, concepto: 'Aguinaldo adelanto', importe: -2000, fecha_inicio: mDia })
const ing = await crear({ fila_id: fCobr, concepto: 'Cobro a mano', importe: 9000, fecha_inicio: mDia })
check('[3] la carga manual queda como una proyección puntual de origen MANUAL (aunque pidan otro origen)', (await proy(man1)).origen === 'MANUAL' && (await proy(man2)).origen === 'MANUAL')
const fM = await habil(mDia)
const celda = await filas(`select importe::float i, naturaleza, concepto from flujo_lineas_entre($1, $1, $2, false) where fila_id = $3 order by importe`, [fM, uIndia, fSueldos])
check('[3] las dos cargas manuales de la misma celda son dos líneas proyectadas que suman -7000 en la fila', celda.length === 2 && celda.every((c) => c.naturaleza === 'PROYECTADO') && celda.reduce((a, c) => a + c.i, 0) === -7000, JSON.stringify(celda))
const resum = async (unidad, d) => val(`select * from resumen_flujo_dias($1, $2, $2)`, [unidad, d])
let dd = await resum(uIndia, fM)
check('[3] el subtotal de GASTOS OPERATIVOS incluye las filas manuales (-7000)', Number(dd.gastos_operativos) === -7000, JSON.stringify(dd))
check('[3] el ingreso manual entra en INGRESOS OPERATIVOS (+9000), en el subtotal (+2000) y en la variación de caja (+2000)',
  Number(dd.ingresos_operativos) === 9000 && Number(dd.subtotal) === 2000 && Number(dd.variacion_caja) === 2000, JSON.stringify(dd))
// Editar y eliminar una carga manual: es lo que hace fbEditarManual (EDITAR / ELIMINAR) y se hace con el ajuste de siempre.
await db.query(`select ajustar_linea_flujo('PROYECCION', $1, $2, null, 3000, false, 'corrijo')`, [man2, mDia])
dd = await resum(uIndia, fM)
check('[3] editar el importe de la carga manual cambia el subtotal (-5000 - 3000)', Number(dd.gastos_operativos) === -8000, JSON.stringify(dd))
await db.query(`select ajustar_linea_flujo('PROYECCION', $1, $2, $3, null, false, 'la paso al otro día')`, [man1, mDia, dia(6)])
check('[3] mover una carga manual de día la saca de la celda de origen', Number((await resum(uIndia, fM)).gastos_operativos) === -3000)
await db.query(`select cancelar_proyeccion($1, 'no va')`, [man2])
check('[3] cancelar la carga manual la saca del subtotal', Number((await resum(uIndia, fM)).gastos_operativos) === 0)
// Fila manual: lo cargado a mano en la app reemplaza ese día a las demás proyecciones de la fila (sin doble suma); sin carga a mano, el plan de pagos / sueldos de la planilla suma como siempre.
await como('teso@prueba.com')
const fijo = await crear({ fila_id: fAlq, concepto: 'Alquiler fijo de la planilla', importe: -400, fecha_inicio: dia(5), origen: 'GASTO_FIJO' })
const cuenta5 = async (id) => (await lineasDe(id)).length
check('[3] antes de marcar la fila como manual la proyección suma', (await cuenta5(fijo)) === 1)
await como('admin@prueba.com')
await db.query(`select marcar_fila_flujo($1, true, false)`, [fAlq])
check('[3] fila manual con un plan (proyección de la planilla) y sin carga manual: suma el plan', (await cuenta5(fijo)) === 1 && Number((await val(`select coalesce(sum(importe), 0)::float s from flujo_lineas_entre($1, $1, $2, false) where fila_id = $3`, [await habil(dia(5)), uIndia, fAlq])).s) === -400)
await como('teso@prueba.com')
const manualEnAlq = await crear({ fila_id: fAlq, concepto: 'Carga a mano en la fila', importe: -123, fecha_inicio: dia(5) })
check('[3] con la fila manual, la proyección que no es MANUAL no suma y la carga a mano sí', (await cuenta5(fijo)) === 0 && (await cuenta5(manualEnAlq)) === 1, `${await cuenta5(fijo)} / ${await cuenta5(manualEnAlq)}`)
check('[3] la celda suma solo la carga manual (-123), no la proyección vieja (sin doble conteo)',
  Number((await val(`select coalesce(sum(importe), 0)::float s from flujo_lineas_entre($1, $1, $2, false) where fila_id = $3`, [await habil(dia(5)), uIndia, fAlq])).s) === -123)
await como('admin@prueba.com')
await db.query(`select marcar_fila_flujo($1, false, false)`, [fAlq])
check('[3] al desmarcar la fila la proyección vuelve a sumar junto a la otra', (await cuenta5(fijo)) === 1)
await como('teso@prueba.com')
const otroDia = await crear({ fila_id: fAlq, concepto: 'x', importe: -5, fecha_inicio: dia(6) })
await db.query(`select cancelar_proyeccion($1, 'prueba')`, [otroDia])
await como('teso@prueba.com')
await db.query(`select cancelar_proyeccion($1, 'prueba')`, [manualEnAlq])
const rec = await crear({ fila_id: fAlq, concepto: 'Alquiler mensual', importe: -800, fecha_inicio: dia(3), recurrencia: 'MENSUAL', dia_mes: 10, cuotas: 3 })
check('[3] una fila que no es manual sí admite recurrencia (como siempre)', !!rec)
await como('dir@prueba.com')
await falla('[3] Dirección no carga importes', `select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fSueldos, concepto: 'x', importe: -1, fecha_inicio: dia(3) }], /rol/)
await como('solober@prueba.com')
await falla('[3] ni quien no ve la empresa', `select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fSueldos, concepto: 'x', importe: -1, fecha_inicio: dia(3) }], /acceso a la empresa/)
await servidor()
check('[3] la auditoría de la carga manual lo dice', (await val(`select count(*)::int n from auditoria where accion = 'CREAR' and entidad = 'PROYECCION' and detalle like '%carga manual%'`)).n >= 3)

// ================================================================ 4. Persona física pagada desde Dax → Consultorios
const esPF = async (n) => (await val(`select es_persona_fisica($1) r`, [n])).r
check('[4] es_persona_fisica: nombres de personas sí; S.A., S.R.L., SAS, sociedad y cooperativa no',
  (await esPF('GOMEZ JUAN')) === true && (await esPF('Salvador Rossi')) === true && (await esPF('Clínica Prueba S.A.')) === false && (await esPF('Mesa SRL')) === false
  && (await esPF('Coop Norte')) === false && (await esPF('Cooperativa del Norte')) === true /* como el motor: COOP es la palabra suelta */ && (await esPF('Andes S. R. L.')) === false && (await esPF('Los Pinos SAS')) === false
  && (await esPF(null)) === false && (await esPF('  ')) === false && (await esPF('Sociedad Médica del Sur')) === false)
await como('admin@prueba.com')
await db.query(`select marcar_fila_flujo($1, false, true)`, [fCons])
await servidor()
const pf = async (u) => filas(`select id from flujo_filas where unidad_id = $1 and para_persona_fisica`, [u])
check('[4] la fila de Consultorios queda marcada como destino de las personas físicas', (await pf(uDax)).length === 1 && (await pf(uDax))[0].id === fCons)
await como('admin@prueba.com')
await db.query(`select marcar_fila_flujo($1, false, true)`, [fIns])
await db.query(`select marcar_fila_flujo($1, false, true)`, [fCons])
await servidor()
check('[4] solo una fila por unidad: marcar otra le saca la marca a la anterior', (await pf(uDax)).length === 1 && (await pf(uDax))[0].id === fCons)
check('[4] la tabla tampoco deja dos marcadas en la misma unidad', (await error(`update flujo_filas set para_persona_fisica = true where id = $1`, [fIns]))?.includes('flujo_filas_una_persona_fisica') === true)

const provP = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ($1, $2, $3) returning id`, [cuit, nombre, org])).id
const pPersona = await provP('20111111112', 'GOMEZ JUAN')
const pSociedad = await provP('30111111118', 'CLINICA PRUEBA SA')
const pOtra = await provP('20222222223', 'RAMIREZ OSCAR')
const cDax = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, requiere_extracto) values ('beratung', 'HIPOTECARIO DAX CC', 'HIPOTECARIO', 'CC', $1, true) returning id`, [uDax])).id
const cBer = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, requiere_extracto) values ('beratung', 'GALICIA BERATUNG CC', 'GALICIA', 'CC', $1, true) returning id`, [uBer])).id
const cSin = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, requiere_extracto) values ('beratung', 'CAJA CHICA DAX', 'CAJA', 'CC', $1, false) returning id`, [uDax])).id
let nh = 0
const mov = async (cuenta, fecha, importe, desc = 'TRANSF PRUEBA', categoria = 'SIN_CLASIFICAR') => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
   values ('beratung', $1, $2, $3, $4, $5, $6, 'PENDIENTE') returning id`, [cuenta, fecha, desc, importe, `H38-${nh++}`, categoria])).id
await mov(cDax, dia(-12), 1000000, 'DEPOSITO INICIAL', 'COBRO')   // cobertura del extracto
await mov(cBer, dia(-12), 1000000, 'DEPOSITO INICIAL', 'COBRO')
const pagoDe = async (proveedor, importe, cuentaContable, cuenta = cDax, extra = {}) => {
  const p = (await val(
    `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, cuenta_origen_id, estado_xubio_pago, estado, gestion, contabilizado_por, cuenta_contable)
     values ('beratung', $1, $2, $3, 'TRANSFERENCIA', 'prueba', $4, 'SUBIDO', 'CARGADO', 'SISTEMA', 'prueba', $5) returning id`,
    [proveedor, dia(-3), importe, cuenta, cuentaContable])).id
  const m = await mov(cuenta, dia(-3), -importe, 'DEBITO PAGO ' + importe)
  await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [p, m])
  return p
}
const dondeCae = async (pago) => val(`select l.fila, l.unidad_id, l.fila_id, l.fecha::text from flujo_lineas_entre(null, null, null, false) l where l.origen_tipo = 'PAGO' and l.origen_id = $1`, [pago])
const pg1 = await pagoDe(pPersona, 1111, 'HONORARIOS PROFESIONALES')
const pg2 = await pagoDe(pPersona, 1112, null)
const pg3 = await pagoDe(pSociedad, 1113, 'HONORARIOS PROFESIONALES')
const pg4 = await pagoDe(pPersona, 1114, 'COSTO DE INSUMOS')
const pg5 = await pagoDe(pPersona, 1115, 'HONORARIOS PROFESIONALES', cBer)
const pg6 = await pagoDe(pPersona, 1116, 'HONORARIOS PROFESIONALES', cSin)
const pg7 = await pagoDe(pOtra, 1117, 'GASTOS GENERALES')
const nom = async (p) => (await dondeCae(p))?.fila
check('[4] persona física con honorarios profesionales (genérica) pagada desde Dax: va a Consultorios', await nom(pg1) === 'Prestaciones médicas · Consultorios', await nom(pg1))
check('[4] persona física sin cuenta contable (Sin clasificar) pagada desde Dax: va a Consultorios', await nom(pg2) === 'Prestaciones médicas · Consultorios', await nom(pg2))
check('[4] una sociedad (S.A.) con la misma cuenta se queda en Honorarios profesionales', await nom(pg3) === 'Honorarios profesionales', await nom(pg3))
check('[4] persona física con una cuenta específica (insumos) se queda donde dice su cuenta', await nom(pg4) === 'Insumos', await nom(pg4))
check('[4] persona física pagada desde la cuenta de otra unidad (Beratung S/Dax) no va a Consultorios', await nom(pg5) === 'Honorarios profesionales' && (await dondeCae(pg5)).unidad_id === uBer, JSON.stringify(await dondeCae(pg5)))
check('[4] pagada desde una cuenta sin extracto no se mueve (el motor exige el movimiento del banco)', (await nom(pg6)) !== 'Prestaciones médicas · Consultorios', await nom(pg6))
check('[4] otra persona con "gastos generales" también va a Consultorios', await nom(pg7) === 'Prestaciones médicas · Consultorios', await nom(pg7))
// Una regla del Flujo manda sobre el criterio (en el motor: "sin Reglas Estudio").
await db.query(`insert into flujo_reglas (organizacion_id, empresa_id, si_proveedor_id, unidad_id, fila_id, nota) values ($1, 'beratung', $2, $3, $4, 'regla del estudio')`, [org, pOtra, uDax, fHon])
check('[4] si una regla del Flujo ya mandó el pago a una fila, la regla gana', await nom(pg7) === 'Honorarios profesionales', await nom(pg7))
await db.query(`delete from flujo_reglas where si_proveedor_id = $1`, [pOtra])
// Sin fila marcada, todo vuelve a como era.
await db.query(`update flujo_filas set para_persona_fisica = false where unidad_id = $1`, [uDax])
check('[4] sin una fila marcada en la unidad la regla no hace nada', await nom(pg1) === 'Honorarios profesionales' && (await nom(pg2)) === 'Sin clasificar', `${await nom(pg1)} / ${await nom(pg2)}`)
await db.query(`update flujo_filas set para_persona_fisica = true where id = $1`, [fCons])
const tot = async (u) => Number((await val(`select coalesce(sum(importe), 0)::float s from flujo_lineas_entre(null, null, $1, false) where naturaleza = 'REAL' and origen_tipo = 'PAGO'`, [u])).s)
const totConRegla = await tot(uDax)
await db.query(`update flujo_filas set para_persona_fisica = false where unidad_id = $1`, [uDax])
const totSinRegla = await tot(uDax)
await db.query(`update flujo_filas set para_persona_fisica = true where id = $1`, [fCons])
check('[4] la plata no cambia de lugar: el total real de pagos de la unidad es EXACTAMENTE el mismo con o sin la regla', totConRegla !== 0 && totConRegla === totSinRegla && totConRegla === (await tot(uDax)), `${totConRegla} / ${totSinRegla}`)
// Solo la regla del estudio frena el traslado; una regla del Mapa Flujo no (el Apps Script solo mira "Reglas Estudio").
await db.query(`insert into flujo_reglas (organizacion_id, empresa_id, si_proveedor_id, unidad_id, fila_id, nota) values ($1, 'beratung', $2, $3, $4, 'Mapa Flujo · PROVEEDOR RAMIREZ')`, [org, pOtra, uDax, fHon])
check('[4] una regla que viene del Mapa Flujo no frena a la persona física (solo la del estudio)', await nom(pg7) === 'Prestaciones médicas · Consultorios', await nom(pg7))
await db.query(`delete from flujo_reglas where si_proveedor_id = $1`, [pOtra])
// Solo filas de cuenta; si hay aperturas con la misma cuenta, el relleno de la migración elige la de cuenta (y la de menor orden).
const apertura = (await val(`insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable, apertura) values ($1, 'beratung', 215, 'APERTURA', 'COSTOS', 'Dr. Pérez', 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO TUCUMAN', 'PEREZ') returning id`, [uDax])).id
await como('admin@prueba.com')
await falla('[4] una apertura no puede ser la fila de las personas físicas', `select marcar_fila_flujo($1, false, true)`, [apertura], /fila de cuenta/)
await servidor()
await db.query(`update flujo_filas set para_persona_fisica = false where unidad_id = $1`, [uDax])
// [9] La migración se puede correr dos veces: vuelve a marcar (la fila de CUENTA, no la apertura) y no rompe nada.
const antesDeNuevo = (await val(`select count(*)::int n from flujo_lineas_entre(null, null, null, false)`)).n
let errRe = null
try { await db.exec(readFileSync(join(dir, '0038_flujo_grilla.sql'), 'utf8')) } catch (e) { errRe = e.message }
check('[9] la migración 0038 se puede ejecutar de nuevo sin errores', errRe === null, errRe ?? '')
check('[9] y el relleno de personas físicas elige la fila de cuenta (no la apertura), aunque la apertura tenga menor orden', (await pf(uDax)).length === 1 && (await pf(uDax))[0].id === fCons, JSON.stringify(await pf(uDax)))
check('[9] y no cambia nada de lo que ya estaba', (await val(`select count(*)::int n from flujo_lineas_entre(null, null, null, false)`)).n === antesDeNuevo)
// [2] El código de la hoja marca las filas manuales (lista FB_MANUAL_ del Apps Script); el nombre de la cuenta no cuenta.
const fCod = await fila(uIndia, 'Fila con código', 'GASTOS_OPERATIVOS', 'COMISIONES Y GASTOS', 600)
const fCod2 = await fila(uIndia, 'Fila con código 2', 'GASTOS_OPERATIVOS', 'SUELDOS Y JORNALES', 601)
check('[2] sin código de hoja no se marca nada, ni siquiera una cuenta que se llame SUELDOS (no se usa el nombre)', (await val(`select manual from flujo_filas where id = $1`, [fCod2])).manual === false)
await db.query(`update flujo_filas set codigo_hoja = 'COMISIONES' where id = $1`, [fCod])
await db.query(`update flujo_filas set codigo_hoja = 'SUELDOS_Y_JORNALES' where id = $1`, [fCod2])
check('[2] "COMISIONES" no es de la lista (solo COMISIONES__ID); "SUELDOS…" sí: el código marca la fila solo', (await val(`select manual from flujo_filas where id = $1`, [fCod])).manual === false && (await val(`select manual from flujo_filas where id = $1`, [fCod2])).manual === true)
await db.query(`update flujo_filas set codigo_hoja = 'COMISIONES__ID' where id = $1`, [fCod])
check('[2] "COMISIONES__ID" sí', (await val(`select manual from flujo_filas where id = $1`, [fCod])).manual === true)
const cods = await val(`select es_codigo_manual('ANTICIPOS_CLIENTES') a, es_codigo_manual('BELTRAMINO') b, es_codigo_manual('NICOLAS_SISELES') c, es_codigo_manual('ALEJO_SISELES') d,
  es_codigo_manual('RETENCION_DE_IVA_EFECTUADA') e, es_codigo_manual('MANAGEMENT_FEE') f, es_codigo_manual('GASTOS_VARIOS') g, es_codigo_manual('Sueldos') h, es_codigo_manual(null) i, es_codigo_manual('COMISIONES') j`)
check('[2] la lista tiene los códigos de FB_MANUAL_ (incluidos BELTRAMINO y los SISELES) y respeta las mayúsculas', cods.a && cods.b && cods.c && cods.d && cods.e && cods.f && !cods.g && !cods.h && !cods.i && !cods.j, JSON.stringify(cods))
await db.query(`update flujo_filas set manual = false where id = $1`, [fCod])
await db.query(`update flujo_filas set etiqueta = etiqueta where id = $1`, [fCod])
check('[2] desmarcar a mano vale hasta que el código cambie', (await val(`select manual from flujo_filas where id = $1`, [fCod])).manual === false)

// ================================================================ 5. Planilla de gastos del mes (±1 %)
check('[5] importes_cercanos: hasta el 1 % del importe de la factura', (await val(`select importes_cercanos(10100, 10000) a, importes_cercanos(10101, 10000) b, importes_cercanos(9900, 10000) c, importes_cercanos(9899, 10000) d`)).a === true
  && (await val(`select importes_cercanos(10101, 10000) b`)).b === false && (await val(`select importes_cercanos(9900, 10000) c`)).c === true && (await val(`select importes_cercanos(9899, 10000) d`)).d === false)
check('[5] importes_cercanos: en importes chicos alcanza con $1 de diferencia', (await val(`select importes_cercanos(100.9, 100) a`)).a === true && (await val(`select importes_cercanos(102, 100) b`)).b === false)
check('[5] mismo proveedor: comparten una palabra de más de 3 letras', (await val(`select mismo_proveedor_texto('GOMEZ JUAN CARLOS', 'Gómez, Juan') a, mismo_proveedor_texto('PEREZ MA', 'RUIZ LUIS') b, mismo_proveedor_texto('DE LA CRUZ', 'LA SOL') c`)).a === true
  && (await val(`select mismo_proveedor_texto('PEREZ MA', 'RUIZ LUIS') b`)).b === false && (await val(`select mismo_proveedor_texto('DE LA CRUZ', 'LA SOL') c`)).c === false)
check('[5] la clave de la factura sale del primer y el último grupo de dígitos', (await val(`select clave_factura_texto('00001-00000123') a, clave_factura_texto('FA 1-123') b, clave_factura_texto('sin numero') c, clave_factura_texto('A 0003-00000045-0') d`)).a === '1-123'
  && (await val(`select clave_factura_texto('FA 1-123') b, clave_factura_texto('sin numero') c`)).b === '1-123' && (await val(`select clave_factura_texto('sin numero') c`)).c === '' )

const hoyMes = (await val(`select extract(month from $1::date)::int m, extract(year from $1::date)::int a`, [hoy]))
let nroF = 100
const factura = async (proveedor, total, numero, venc) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable, unidad_id)
   values ('beratung', $1, 'Factura A', 'A', 1, $2, $3, $4, $5, $5, 'PARA_PAGAR', 0, 'HONORARIOS PROFESIONALES', $6) returning id`,
  [proveedor, numero ?? nroF++, dia(-5), venc, total, uDax])).id
const pGomez = pPersona
const pPerez = await provP('20333333334', 'PEREZ MARIA')
const pLopez = await provP('20444444445', 'LOPEZ ANA')
const pQqqq = await provP('20555555556', 'QQQQ HERMANOS')
const fGomez = await factura(pGomez, 10000, 123, dia(20))
const fPerez = await factura(pPerez, 20000, 456, dia(25))
const fLopez = await factura(pLopez, 30000, 457, dia(18))
const fQ1 = await factura(pQqqq, 7060, 789, dia(22))
const fQ2 = await factura(pQqqq, 9000, 790, dia(23))
const venc = async (id) => (await val(`select fecha::text f, ajustada from flujo_lineas_entre(null, null, $2, false) where origen_tipo = 'FACTURA' and origen_id = $1`, [id, uDax]))
check('[5] antes de cargar la planilla las facturas caen en su vencimiento', (await venc(fGomez)).f === await habil(dia(20)) && !(await venc(fGomez)).ajustada, JSON.stringify(await venc(fGomez)))
const lineasPlanilla = [
  { hoja: 'COLABORADORES', nombre: 'GOMEZ JUAN', cuit: '20111111112', factura: '00001-00000123', importe: 10050, fecha: dia(10), fila: 'Honorarios profesionales' },          // número + proveedor
  { hoja: 'COLABORADORES', nombre: 'PEREZ MARIA', factura: '', importe: 20150, fecha: dia(12), fila: 'Honorarios profesionales' },                                     // proveedor + 0,75 %
  { hoja: 'COLABORADORES', nombre: 'LOPEZ ANA', factura: '', importe: 30400, fecha: dia(15), fila: 'Insumos' },                                                      // 1,33 %: NO coincide
  { hoja: 'HONORARIOS', nombre: 'RUIZ CARLOS', factura: '', importe: 5000, fecha: dia(-3), fila: 'Insumos' },                                                           // vencido: se toma como pagado
  { hoja: 'HONORARIOS', nombre: 'ROSALES NOEMI', factura: '', importe: 8000, pami: true, fila: 'Prestaciones médicas · Consultorios' },                                // PAMI
  { hoja: 'HONORARIOS', nombre: 'SIN FECHA SRL', factura: '', importe: 100, fila: 'Insumos' },                                                                          // sin fecha
  { hoja: 'HONORARIOS', nombre: 'ZZZZ OTRO', factura: '00001-00000789', importe: 7000, fecha: dia(14), fila: 'Insumos' },                                                // número + 0,86 % (proveedor distinto)
  { hoja: 'HONORARIOS', nombre: 'WWWW OTRO', factura: '00001-00000790', importe: 5000, fecha: dia(16), fila: 'Insumos' },                                                // número, pero importe y proveedor lejos
  { hoja: 'HONORARIOS', nombre: 'SIN IMPORTE', factura: '', importe: 0, fecha: dia(16) },                                                                                 // se ignora
]
await como('teso@prueba.com')
const res = (await val(`select cargar_gastos_mes($1, $2, $3, 'GASTOS NOVIEMBRE.xlsx', $4) r`, [uDax, hoyMes.a, hoyMes.m, JSON.stringify(lineasPlanilla)])).r
check('[5] resumen de la carga: 8 renglones (el de importe 0 se ignora), 3 con factura, 4 pendientes... y los vencidos o sin fecha salteados',
  res.lineas === 8 && res.con_factura === 3 && res.pendientes === 3 && res.salteadas === 2, JSON.stringify(res))
const gm = async (nombre) => val(`select resultado, usada, factura_id, fecha_flujo::text f from gastos_mes where nombre = $1`, [nombre])
check('[5] número y proveedor: la factura de GOMEZ toma la fecha de la planilla (día hábil)', (await gm('GOMEZ JUAN')).resultado === 'CON_FACTURA' && (await venc(fGomez)).f === await habil(dia(10)) && (await venc(fGomez)).ajustada, JSON.stringify(await venc(fGomez)))
check('[5] proveedor + importe a menos del 1 % (0,75 %): coincide y toma la fecha de la planilla', (await gm('PEREZ MARIA')).resultado === 'CON_FACTURA' && (await venc(fPerez)).f === await habil(dia(12)))
check('[5] a más del 1 % (1,33 %) no coincide: la factura sigue en su vencimiento y el renglón queda pendiente de factura', (await gm('LOPEZ ANA')).resultado === 'PENDIENTE' && (await venc(fLopez)).f === await habil(dia(18)))
check('[5] mismo número de factura e importe cercano (0,86 %), aunque el proveedor sea otro', (await gm('ZZZZ OTRO')).resultado === 'CON_FACTURA' && (await venc(fQ1)).f === await habil(dia(14)))
check('[5] mismo número pero proveedor e importe lejos: no coincide', (await gm('WWWW OTRO')).resultado === 'PENDIENTE' && !(await venc(fQ2)).ajustada)
check('[5] un renglón vencido sin factura se toma como pagado (salteado) y no genera proyección', (await gm('RUIZ CARLOS')).resultado === 'SALTEADA' && (await val(`select count(*)::int n from proyecciones where concepto like 'RUIZ CARLOS%'`)).n === 0)
check('[5] un renglón sin fecha ni PAMI también se saltea', (await gm('SIN FECHA SRL')).resultado === 'SALTEADA')
const pend = await val(`select p.importe::float i, p.fecha_inicio::text f, p.origen, p.estado, ff.etiqueta fila, p.concepto from proyecciones p join flujo_filas ff on ff.id = p.fila_id where p.concepto like 'LOPEZ ANA%'`)
check('[5] lo pendiente de factura es una proyección de la planilla: egreso, en su fila y en la fecha de la planilla', pend.i === -30400 && pend.origen === 'PLANILLA_GASTOS' && pend.estado === 'ACTIVA' && pend.fila === 'Insumos' && pend.f === await habil(dia(15)), JSON.stringify(pend))
const pami = await gm('ROSALES NOEMI')
check('[5] PAMI sin cobro proyectado: último día hábil del mes (o mañana si ya pasó) y en la fila de la planilla',
  pami.resultado === 'PENDIENTE' && pami.f >= hoy && (await val(`select es_dia_habil($1::date) h`, [pami.f])).h === true, JSON.stringify(pami))
const lineaPami = await val(`select fila, fecha::text f, importe::float i from flujo_lineas_entre($1, $1, $2, false) where concepto like 'ROSALES%'`, [pami.f, uDax])
check('[5] la línea de PAMI aparece en el Flujo de Dax en esa fecha', lineaPami?.fila === 'Prestaciones médicas · Consultorios' && lineaPami.i === -8000, JSON.stringify(lineaPami))
const mesDeFecha0 = (await val(`select to_char($1::date, 'MM/YYYY') m`, [await habil(dia(10))])).m
const ctl = await filas(`select fila, mes from gastos_mes_control where unidad_id = $1 order by fila, mes`, [uDax])
const mesTxt = `${String(hoyMes.m).padStart(2, '0')}/${hoyMes.a}`
check('[5] Gastos Mes Control: las filas y meses que manda la planilla (la de las facturas y la de los renglones)',
  ctl.some((c) => c.fila === 'Honorarios profesionales' && c.mes === mesTxt) && ctl.some((c) => c.fila === 'Insumos' && c.mes === mesTxt)
  && ctl.some((c) => c.fila === 'Prestaciones médicas · Consultorios') && !ctl.some((c) => /SIN CUENTA/i.test(c.fila)), JSON.stringify(ctl))
check('[5] y se anota también el mes de la fecha nueva', ctl.some((c) => c.fila === 'Honorarios profesionales' && c.mes === mesDeFecha0), JSON.stringify(ctl))
// Volver a cargar la misma planilla no duplica nada: reemplaza.
const nProyAntes = (await val(`select count(*)::int n from proyecciones where origen = 'PLANILLA_GASTOS' and estado = 'ACTIVA'`)).n
const res2 = (await val(`select cargar_gastos_mes($1, $2, $3, 'GASTOS NOVIEMBRE.xlsx', $4) r`, [uDax, hoyMes.a, hoyMes.m, JSON.stringify(lineasPlanilla)])).r
check('[5] cargar otra vez la misma planilla da el mismo resultado y no duplica lo pendiente', JSON.stringify(res2) === JSON.stringify(res)
  && (await val(`select count(*)::int n from proyecciones where origen = 'PLANILLA_GASTOS' and estado = 'ACTIVA'`)).n === nProyAntes
  && (await val(`select count(*)::int n from gastos_mes where unidad_id = $1`, [uDax])).n === 8
  && (await val(`select count(*)::int n from flujo_ajustes where origen_tipo = 'FACTURA' and motivo like 'Planilla GASTOS%' and reemplazado_en is null`)).n === 3)
// Una carga nueva sin la factura de GOMEZ la devuelve a su vencimiento.
await db.query(`select cargar_gastos_mes($1, $2, $3, 'GASTOS NOVIEMBRE.xlsx', $4)`, [uDax, hoyMes.a, hoyMes.m, JSON.stringify(lineasPlanilla.filter((l) => l.nombre !== 'GOMEZ JUAN'))])
check('[5] si la planilla ya no trae el renglón, la factura vuelve a su fecha (la que puso la planilla se deshace)', (await venc(fGomez)).f === await habil(dia(20)) && !(await venc(fGomez)).ajustada, JSON.stringify(await venc(fGomez)))
await falla('[5] mes inválido', `select cargar_gastos_mes($1, 2026, 13, 'x', '[]'::jsonb)`, [uDax], /no es válido/)
await falla('[5] las líneas tienen que ser una lista', `select cargar_gastos_mes($1, 2026, 11, 'x', '{}'::jsonb)`, [uDax], /lista/)
await como('aprob@prueba.com')
await falla('[5] un aprobador no carga la planilla', `select cargar_gastos_mes($1, 2026, 11, 'x', '[]'::jsonb)`, [uDax], /rol/)
await como('soloind@prueba.com')
await falla('[5] quien no ve Beratung no la carga', `select cargar_gastos_mes($1, 2026, 11, 'x', '[]'::jsonb)`, [uDax], /acceso a la empresa/)
check('[5] ni la lee: gastos_mes y su control salen vacíos', (await val(`select count(*)::int n from gastos_mes`)).n === 0 && (await val(`select count(*)::int n from gastos_mes_control`)).n === 0)
await como('solober@prueba.com')
check('[5] quien ve Beratung sí la lee', (await val(`select count(*)::int n from gastos_mes`)).n === 7 && (await val(`select count(*)::int n from gastos_mes_control`)).n > 0)
await falla('[5] y no escribe en las tablas directo', `insert into gastos_mes_control (unidad_id, empresa_id, fila_norm, fila, mes) values ($1, 'beratung', 'X', 'X', '11/2026')`, [uDax], /permission denied|permiso/i)
await servidor()
check('[5] la auditoría anota cada carga de la planilla', (await val(`select count(*)::int n from auditoria where accion = 'GASTOS_MES'`)).n === 3)
// Si la factura llega después de la carga, el pendiente de la planilla deja de sumar (no se cuenta dos veces).
const pRosales = await provP('20666666667', 'ROSALES NOEMI')
const sumaRosales = async () => Number((await val(`select coalesce(sum(importe), 0)::float s from flujo_lineas_entre(null, null, $1, false) where contraparte like 'ROSALES%' or concepto like 'ROSALES%'`, [uDax])).s)
check('[5] antes de que llegue la factura, el pendiente de la planilla suma (-8000)', (await sumaRosales()) === -8000, String(await sumaRosales()))
await factura(pRosales, 8040, 901, dia(25))
check('[5] cuando llega la factura (a menos del 1 %), el pendiente deja de sumar y queda solo la factura (-8040): no se cuenta doble', (await sumaRosales()) === -8040, String(await sumaRosales()))
check('[5] el pendiente sigue guardado (si la factura se anula vuelve a sumar)', (await val(`select count(*)::int n from proyecciones where concepto like 'ROSALES%' and estado = 'ACTIVA'`)).n === 1)

// ================================================================ 6. Foto mensual de la proyección
const hoyMesTxt = (await val(`select to_char($1::date, 'MM/YYYY') t, to_char($1::date, 'YYYY-MM') m`, [hoy]))
const habilesMes = (await val(`select count(*)::int n from generate_series(date_trunc('month', $1::date)::date, (date_trunc('month', $1::date) + interval '1 month - 1 day')::date, interval '1 day') d where es_dia_habil(d::date)`, [hoy])).n
// Algo proyectado hoy en India: -1000 gastos, +5000 ingresos, -200 socios.
await como('teso@prueba.com')
await db.query(`select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fAlq, concepto: 'Gasto de la foto', importe: -1000, fecha_inicio: hoy }])
await db.query(`select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fCobr, concepto: 'Cobro de la foto', importe: 5000, fecha_inicio: hoy }])
await db.query(`select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fSoc, concepto: 'Retiro de la foto', importe: -200, fecha_inicio: hoy }])
const fHoy = await habil(hoy)
const msg = (await val(`select sacar_foto_flujo_unidad($1) m`, [uIndia])).m
const fotos = () => filas(`select dia::text d, ingresos_operativos::float ing, costos::float cos, gastos_operativos::float gas, impuestos::float imp, subtotal::float sub, socios::float soc, intercompany::float inter, variacion_caja::float var, tomada_por, parcial from flujo_fotos where unidad_id = $1 order by dia`, [uIndia])
let fs = await fotos()
check('[6] sacar la foto del mes devuelve el mismo mensaje del Apps Script y guarda un día por cada día hábil del mes (o con movimientos)', new RegExp(`^Foto de ${hoyMesTxt.t.replace('/', '\\/')}: \\d+ filas$`).test(msg) && fs.length >= habilesMes && fs.length === Number(msg.match(/(\d+) filas/)[1]), `${msg} · ${fs.length} · hábiles ${habilesMes}`)
const fd = fs.find((f) => f.d === fHoy)
check('[6] el día de hoy tiene lo proyectado: ingresos +5000, gastos -1000, socios -200', fd?.ing === 5000 && fd.gas === -1000 && fd.soc === -200, JSON.stringify(fd))
check('[6] el subtotal es ingresos + costos + gastos + impuestos (4000) y la variación de caja es todo lo que mueve la caja (3800)', fd?.sub === 4000 && fd.var === 3800, JSON.stringify(fd))
check('[6] queda quién la sacó, y no es parcial', fd?.tomada_por === 'teso@prueba.com' && fd.parcial === false)
check('[6] todos los días de la foto son del mes', fs.every((f) => f.d.startsWith(hoyMesTxt.m)))
check('[6] segunda vez: "Ya hay foto de MM/AAAA" y no cambia nada', (await val(`select sacar_foto_flujo_unidad($1) m`, [uIndia])).m === `Ya hay foto de ${hoyMesTxt.t}` && (await fotos()).length === fs.length)
// El Flujo cambia después: la foto no, la comparación sí.
await db.query(`select crear_proyeccion($1)`, [{ empresa_id: 'india', unidad_id: uIndia, fila_id: fAlq, concepto: 'Gasto nuevo', importe: -700, fecha_inicio: hoy }])
check('[6] después de cambiar el Flujo la foto sigue igual', (await fotos()).find((f) => f.d === fHoy).var === 3800)
const ahora = await val(`select variacion_caja::float v, gastos_operativos::float g from resumen_flujo_dias($1, $2, $2)`, [uIndia, fHoy])
check('[6] y la comparación (resumen del día) ve el cambio: -700 más de gastos', ahora.v === 3100 && ahora.g === -1700, JSON.stringify(ahora))
const msg2 = (await val(`select sacar_foto_flujo_unidad($1, true) m`, [uIndia])).m
check('[6] forzar reemplaza la foto del mes (y no deja días repetidos)', /^Foto de /.test(msg2) && (await fotos()).find((f) => f.d === fHoy).var === 3100 && (await fotos()).length === fs.length)
// Una foto parcial no cuenta como "ya hay foto".
await servidor()
await db.query(`update flujo_fotos set parcial = true where unidad_id = $1`, [uIndia])
await como('teso@prueba.com')
check('[6] una foto marcada parcial no frena la siguiente (como el Apps Script)', /^Foto de /.test((await val(`select sacar_foto_flujo_unidad($1) m`, [uIndia])).m) && (await fotos()).every((f) => f.parcial === false))
// Todas las unidades que ve la persona.
await como('solober@prueba.com')
const mine = (await val(`select sacar_fotos_flujo() r`)).r
check('[6] sacar_fotos_flujo de una persona recorre solo las unidades de las empresas que ve (Beratung)', mine.length === 2 && mine.every((m) => [uBer, uDax].includes(m.unidad_id)) && mine.every((m) => /^Foto de /.test(m.resultado)), JSON.stringify(mine))
check('[6] y esa persona lee solo las fotos de Beratung', (await val(`select count(*)::int n from flujo_fotos where empresa_id <> 'beratung'`)).n === 0 && (await val(`select count(*)::int n from flujo_fotos where empresa_id = 'beratung'`)).n > 0)
await falla('[6] quien no ve India no le saca la foto', `select sacar_foto_flujo_unidad($1)`, [uIndia], /acceso a la empresa/)
await falla('[6] ni escribe en la tabla de fotos directo', `insert into flujo_fotos (empresa_id, unidad_id, mes, dia, tomada_por) values ('beratung', $1, '2026-11', $2, 'x')`, [uBer, hoy], /permission denied|permiso/i)
await como('aprob@prueba.com')
await falla('[6] un aprobador no saca fotos', `select sacar_fotos_flujo()`, [], /rol/)
await como('dir@prueba.com')
await falla('[6] ni Dirección', `select sacar_foto_flujo_unidad($1)`, [uIndia], /rol/)
await comoAnon()
await falla('[6] anon no ejecuta nada de esto', `select sacar_fotos_flujo()`, [], /permission denied|permiso/i)
// El servidor (la tarea programada de las 10 de Argentina): por organización.
await servidor()
await falla('[6] el servidor tiene que decir la organización', `select sacar_fotos_flujo(null, false)`, [], /Falta la organización/)
const srv = (await val(`select sacar_fotos_flujo($1, false) r`, [org])).r
const nUnidades = (await val(`select count(*)::int n from unidades u join empresas e on e.id = u.empresa_id where e.organizacion_id = $1 and u.activa`, [org])).n
check('[6] el servidor recorre todas las unidades de la organización; las que ya tienen foto dicen "Ya hay foto"', srv.length === nUnidades
  && srv.find((x) => x.unidad_id === uBer).resultado === `Ya hay foto de ${hoyMesTxt.t}` && srv.find((x) => x.unidad_id === uIndia).resultado === `Ya hay foto de ${hoyMesTxt.t}`
  && srv.filter((x) => /^Foto de /.test(x.resultado)).length === nUnidades - 3, JSON.stringify(srv))
check('[6] la foto del servidor queda a nombre de la tarea programada y en la auditoría', (await val(`select count(*)::int n from flujo_fotos where tomada_por = 'Sistema (tarea programada)'`)).n > 0
  && (await val(`select count(*)::int n from auditoria where accion = 'FLUJO_FOTO' and usuario = 'Sistema (tarea programada)'`)).n > 0)
check('[6] cada foto de una persona queda en la auditoría con su nombre', (await val(`select count(*)::int n from auditoria where accion = 'FLUJO_FOTO' and usuario = 'Teso'`)).n >= 3)
const otra = await val(`select o.id from organizaciones o where o.id <> $1 limit 1`, [org])
check('[6] una organización sin unidades devuelve una lista vacía (no toca las de otra)', (await val(`select jsonb_array_length(sacar_fotos_flujo(gen_random_uuid(), false)) n`)).n === 0)

// ================================================================ Permisos: nada queda abierto
const fns = ['marcar_fila_flujo(uuid, boolean, boolean)', 'cambiar_proyeccion(uuid, date, text, text, numeric, date, text)', 'cargar_gastos_mes(uuid, integer, integer, text, jsonb)',
  'resumen_flujo_dias(uuid, date, date)', 'sacar_foto_flujo_unidad(uuid, boolean, boolean)', 'sacar_fotos_flujo(uuid, boolean)', 'es_persona_fisica(text)',
  'importes_cercanos(numeric, numeric)', 'mismo_proveedor_texto(text, text)', 'clave_factura_texto(text)', 'crear_proyeccion(jsonb)', 'flujo_lineas_entre(date, date, uuid, boolean)']
const priv = async (rol, f) => (await val(`select has_function_privilege($1, $2, 'execute') ok`, [rol, f])).ok
const anon = [], auth = [], serv = []
for (const f of fns) { if (await priv('anon', f)) anon.push(f); if (!(await priv('authenticated', f))) auth.push(f); if (!(await priv('service_role', f))) serv.push(f) }
check('[permisos] anon no ejecuta ninguna de las funciones nuevas', anon.length === 0, anon.join(', '))
check('[permisos] authenticated y service_role sí', auth.length === 0 && serv.length === 0, `${auth.join(', ')} / ${serv.join(', ')}`)
const tablas = await filas(`select relname from pg_class where relname in ('gastos_mes', 'gastos_mes_control', 'flujo_fotos') and relrowsecurity`)
check('[permisos] las tres tablas nuevas tienen RLS', tablas.length === 3)
check('[permisos] anon ni authenticated escriben en ellas', !(await val(`select has_table_privilege('authenticated', 'flujo_fotos', 'insert') a`)).a && !(await val(`select has_table_privilege('anon', 'flujo_fotos', 'select') a`)).a
  && !(await val(`select has_table_privilege('authenticated', 'gastos_mes', 'update') a`)).a)

console.log(`\n${ok} OK · ${mal} MAL`)
await db.close()
process.exit(mal ? 1 : 0)
