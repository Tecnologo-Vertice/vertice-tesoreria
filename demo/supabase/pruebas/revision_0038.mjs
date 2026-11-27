// Revisión independiente de 0038 (agente 06, 27/11/2026). Los "BUG" son comportamientos que el Apps Script no tiene o
// que rompen algo; los "OK" son controles; los "INFO" solo muestran un dato. Datos ficticios. No toca producción.
// Uso (desde demo/): node --import ./netlify/pruebas/resolver.mjs supabase/pruebas/revision_0038.mjs supabase/migrations
//   (el resolver solo hace falta para la parte del CSV, que importa src/lib/tesoreria.ts; sin él esa parte se saltea)
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, bug = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else bug++; console.log(`${cond ? 'OK ' : 'BUG'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const info = (nombre, dato) => console.log(`INFO ${nombre} · ${typeof dato === 'string' ? dato : JSON.stringify(dato)}`)
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
const error = async (sql, p = []) => { try { await db.query(sql, p); return null } catch (e) { return e.message } }
const como = async (email) => {
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const servidor = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }

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
// Base armada hasta 0037 (sin 0038): así se ve qué hace 0038 sobre datos que ya existían.
const todas = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
const aplicar = async (f) => db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''))
for (const f of todas.filter((x) => !x.startsWith('0038'))) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  await aplicar(f)
}
const f0038 = todas.find((x) => x.startsWith('0038'))
const funcionesAntes = new Set((await filas(`select p.oid::regprocedure::text n from pg_proc p where p.pronamespace = 'public'::regnamespace`)).map((x) => x.n))

// ---------------------------------------------------------------- Datos "reales" que ya existían antes de 0038
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
const habil = async (d) => (await val(`select dia_habil_desde($1::date)::text d`, [d])).d
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMIN', true),
    ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const uBer = (await val(`select id from unidades where empresa_id = 'beratung' and por_defecto`)).id
const uDax = (await val(`select id from unidades where empresa_id = 'beratung' and nombre = 'Dax Salud'`)).id
const filaPre = async (unidad, tipo, seccion, etiqueta, cuenta, apertura = null, orden = 500) => (await val(
  `insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable, apertura) values ($1, 'beratung', $2, $3, $4, $5, $6, $7) returning id`,
  [unidad, orden, tipo, seccion, etiqueta, cuenta, apertura])).id
// Nombres de cuenta como los que pueden venir de la planilla del Flujo original (columna "Cuenta"; el código de la columna B no se guarda).
const rows = {
  sueldos: await filaPre(uBer, 'CUENTA', 'GASTOS_OPERATIVOS', 'Sueldos y jornales', 'SUELDOS Y JORNALES', null, 311),
  comisiones: await filaPre(uBer, 'CUENTA', 'GASTOS_OPERATIVOS', 'Comisiones y gastos bancarios', 'COMISIONES Y GASTOS BANCARIOS', null, 312),
  comisionesId: await filaPre(uBer, 'CUENTA', 'GASTOS_OPERATIVOS', 'Comisiones ID', 'COMISIONES ID', null, 313),
  anticipoProv: await filaPre(uBer, 'CUENTA', 'GASTOS_OPERATIVOS', 'Anticipo a proveedores', 'ANTICIPO A PROVEEDORES', null, 314),
  anticipoCli: await filaPre(uBer, 'CUENTA', 'INGRESOS_OPERATIVOS', 'Anticipos de clientes', 'ANTICIPOS DE CLIENTES', null, 315),
  honorarios: await filaPre(uBer, 'CUENTA', 'COSTOS', 'Honorarios profesionales', 'HONORARIOS PROFESIONALES', null, 230),
  sueldosApe: await filaPre(uBer, 'APERTURA', 'GASTOS_OPERATIVOS', 'Sueldos y jornales - Gomez', 'SUELDOS Y JORNALES', 'GOMEZ', 316),
}
// Dax: Consultorios con una fila de cuenta y una apertura por prestador (como las abre el Flujo original).
const consCta = await filaPre(uDax, 'CUENTA', 'COSTOS', 'Costo de prestaciones médicas - Consultorio Tucumán', 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO TUCUMAN', null, 221)
const consApe1 = await filaPre(uDax, 'APERTURA', 'COSTOS', 'Costo de prestaciones médicas - Consultorio Tucumán - GOMEZ', 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO TUCUMAN', 'GOMEZ', 222)
await filaPre(uDax, 'APERTURA', 'COSTOS', 'Costo de prestaciones médicas - Consultorio Tucumán - PEREZ', 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO TUCUMAN', 'PEREZ', 223)
// Proyecciones que ya existían (como las 86 cargadas desde la planilla): una mensual en "Sueldos" y una con origen SUELDOS.
const proy0 = async (fila, concepto, importe, origen, rec = 'MENSUAL', dm = 5, cuotas = 6) => (await val(
  `insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, importe, fecha_inicio, recurrencia, dia_mes, cuotas, origen, creado_por)
   values ('beratung', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'planilla') returning id`,
  [uBer, fila, concepto, importe, dia(1), rec, rec === 'MENSUAL' ? dm : null, cuotas, origen])).id
const pSueldosMensual = await proy0(rows.sueldos, 'Sueldos mensuales (de la planilla)', -1000000, 'SUELDOS')

await aplicar(f0038)
check('0038 aplica sobre una base con filas y proyecciones existentes', true)
const man = async (id) => (await val(`select manual, para_persona_fisica pf from flujo_filas where id = $1`, [id]))
const nombresMan = Object.entries(rows).filter(async ([, id]) => (await man(id)).manual)
// 0038 marca por el código de la hoja (como la lista FB_MANUAL_ del Apps Script): lo carga el migrador; acá se simula
await db.query(`update flujo_filas set codigo_hoja = 'SUELDOS' where id = any($1::uuid[])`, [[rows.sueldos, rows.sueldosApe]])
await db.query(`update flujo_filas set codigo_hoja = 'COMISIONES' where id = $1`, [rows.comisiones])
const flags = {}
for (const [k, id] of Object.entries(rows)) flags[k] = (await man(id)).manual
info('backfill manual por fila', flags)
check('[backfill] "Comisiones y gastos bancarios" (gasto del extracto) NO debería quedar como fila manual: el Apps Script marca solo COMISIONES__ID',
  flags.comisiones === false, 'la regex ^COMISIONES la marca; ahí no se puede cargar una recurrencia')
check('[backfill] "Anticipo a proveedores" / "Anticipos de clientes" (ANTICIPOS) no deberían quedar manuales por coincidir de prefijo', flags.anticipoCli === false, 'ANTICIPOS DE CLIENTES queda manual')
check('[backfill] la fila "Sueldos" y su apertura sí quedan manuales (lista FB_MANUAL_)', flags.sueldos === true && flags.sueldosApe === true)
const pfCons = await filas(`select id from flujo_filas where unidad_id = $1 and para_persona_fisica`, [uDax])
check('[backfill] si Consultorios tiene una fila de cuenta y una apertura por prestador, igual queda UNA marcada como "personas físicas"',
  pfCons.length === 1, `quedaron ${pfCons.length} marcadas: count(*) = 1 las descarta a todas y la regla no funciona hasta marcarla a mano (no hay pantalla para eso)`)

// ---------------------------------------------------------------- Funciones nuevas: permisos y search_path
const nuevas = (await filas(`select p.oid::regprocedure::text n, p.prosecdef sd, coalesce(p.proconfig::text, '') cfg,
    has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') srv
  from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).filter((x) => !funcionesAntes.has(x.n))
info('funciones nuevas de 0038', nuevas.map((x) => x.n.split('(')[0]))
check('[permisos] ninguna función nueva la ejecuta anon', nuevas.every((x) => !x.anon), nuevas.filter((x) => x.anon).map((x) => x.n).join(', '))
check('[permisos] toda función nueva security definer fija search_path', nuevas.filter((x) => x.sd).every((x) => /search_path=public/.test(x.cfg)), nuevas.filter((x) => x.sd && !/search_path/.test(x.cfg)).map((x) => x.n).join(', '))
// fila_manual_por_codigo es una función de trigger: solo la corre la base, nadie la llama (revocada a propósito)
check('[permisos] authenticated y service_role ejecutan todas (menos las de trigger)', nuevas.filter((x) => !/^fila_manual_por_codigo/.test(x.n)).every((x) => x.auth && x.srv))
const rls = await filas(`select relname, relrowsecurity r, relforcerowsecurity f from pg_class where relname in ('gastos_mes', 'gastos_mes_control', 'flujo_fotos')`)
check('[permisos] RLS activo en las 3 tablas', rls.length === 3 && rls.every((x) => x.r))
const usosControl = (await val(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and prosrc ilike '%gastos_mes_control%' and proname <> 'cargar_gastos_mes'`)).n
const usosVista = (await val(`select count(*)::int n from pg_views where schemaname = 'public' and definition ilike '%gastos_mes_control%'`)).n
check('[planilla] gastos_mes_control se lee en alguna función o vista (en el Apps Script decide qué filas y meses manda la planilla)', usosControl + usosVista > 0,
  'solo se escribe: nadie la consulta, así que no hace nada por sí sola')

// ---------------------------------------------------------------- Equivalencia con 0034 cuando no hay fila "personas físicas"
// Se crea una copia de la función de 0034 y se comparan los resultados sobre un mismo juego de datos.
const sql34 = readFileSync(join(dir, todas.find((x) => x.startsWith('0034'))), 'utf8')
const ini = sql34.indexOf('create or replace function flujo_lineas_entre(')
const fin = sql34.indexOf('revoke execute on function flujo_lineas_entre', ini)
await db.exec(sql34.slice(ini, fin).replace('function flujo_lineas_entre(', 'function flujo_lineas_entre_34('))
await db.exec(`grant execute on function flujo_lineas_entre_34(date, date, uuid, boolean) to authenticated`)

await db.exec(`update flujo_filas set para_persona_fisica = false`)   // sin la regla nueva
const provP = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ($1, $2, $3) returning id`, [cuit, nombre, org])).id
const pGomez = await provP('20111111112', 'GOMEZ JUAN')
const pSa = await provP('30111111118', 'CLINICA PRUEBA SA')
const cDax = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, requiere_extracto) values ('beratung', 'HIPOTECARIO DAX CC', 'HIPOTECARIO', 'CC', $1, true) returning id`, [uDax])).id
const cBer = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, requiere_extracto) values ('beratung', 'GALICIA BERATUNG CC', 'GALICIA', 'CC', $1, true) returning id`, [uBer])).id
let nh = 0
const mov = async (cuenta, fecha, importe, desc = 'TRANSF PRUEBA', categoria = 'SIN_CLASIFICAR') => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
   values ('beratung', $1, $2, $3, $4, $5, $6, 'PENDIENTE') returning id`, [cuenta, fecha, desc, importe, `R38-${nh++}`, categoria])).id
await mov(cDax, dia(-12), 1000000, 'DEPOSITO INICIAL', 'COBRO')
await mov(cBer, dia(-12), 1000000, 'DEPOSITO INICIAL', 'COBRO')
const pagoDe = async (proveedor, importe, cuentaContable, cuenta, estadoX, medio = 'TRANSFERENCIA', fecha = dia(-3), conMov = true) => {
  const p = (await val(
    `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, cuenta_origen_id, estado_xubio_pago, estado, gestion, contabilizado_por, cuenta_contable)
     values ('beratung', $1, $2, $3, $4, 'prueba', $5, $6, 'CARGADO', 'SISTEMA', 'prueba', $7) returning id`,
    [proveedor, fecha, importe, medio, cuenta, estadoX, cuentaContable])).id
  if (conMov) { const m = await mov(cuenta, fecha, -importe, 'DEBITO PAGO ' + importe); await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [p, m]) }
  return p
}
await pagoDe(pGomez, 1111, 'HONORARIOS PROFESIONALES', cDax, 'SUBIDO')          // entra como pago
await pagoDe(pSa, 1112, 'HONORARIOS PROFESIONALES', cDax, 'SUBIDO')
await pagoDe(pGomez, 1113, 'HONORARIOS PROFESIONALES', cBer, null)              // no está en Xubio: entra por el movimiento
await pagoDe(pGomez, 1114, null, cDax, 'SUBIDO', 'CAJA', dia(-2), false)         // caja: fuera
await mov(cDax, dia(-2), -333, 'IMPUESTO DEB/CRED')                             // movimiento suelto
await mov(cBer, dia(-1), -444, 'COMISION BANCARIA')
await db.query(`insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable, unidad_id)
  values ('beratung', $1, 'Factura A', 'A', 1, 501, $2, $3, 777, 777, 'PARA_PAGAR', 0, 'HONORARIOS PROFESIONALES', $4)`, [pGomez, dia(-5), dia(9), uDax])
await mov(cDax, dia(-4), -777, 'TRANSF A PROVEEDOR')                             // débito libre que duplica la factura proyectada (doble conteo)
await db.query(`insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, importe, fecha_inicio, recurrencia, creado_por)
  values ('beratung', $1, $2, 'Alquiler', -900, $3, 'UNICA', 'prueba')`, [uBer, rows.honorarios, dia(6)])
const mapa = (xs) => xs.map((x) => `${x.origen_tipo}|${x.origen_id}|${x.ocurrencia}|${x.fila_id}|${x.unidad_id}|${x.fecha}|${x.importe}|${x.naturaleza}|${x.afecta_bancos}|${x.vencido}`).sort().join('\n')
const l38 = await filas(`select * from flujo_lineas_entre(null, null, null, false)`)
// Sin carga a mano, 0038 suma lo mismo que 0034 también en las filas manuales
const l34 = await filas(`select * from flujo_lineas_entre_34(null, null, null, false)`)
check('[regresión 0034] con 0038 y sin fila de personas físicas el Flujo da EXACTAMENTE las mismas líneas que 0034 (pagos solo en Xubio, caja fuera, doble conteo, movimientos)', l34.length > 5 && mapa(l38) === mapa(l34), `${l38.length} vs ${l34.length}`)
const sinCaja = l38.filter((x) => x.origen_tipo === 'PAGO').length
check('[regresión 0034] el pago de caja y el no-Xubio siguen fuera como pago (solo 2 pagos)', sinCaja === 2, `pagos: ${sinCaja}`)
check('[regresión 0034] el débito que duplica la factura proyectada sigue contando una sola vez', l38.filter((x) => Math.abs(Number(x.importe)) === 777).length === 1, `${l38.filter((x) => Math.abs(Number(x.importe)) === 777).length}`)
const sol = (await val(`select count(*)::int n from pg_proc where proname = 'flujo_lineas_entre' and prosrc like '%dup_par%' and prosrc like '%pfuera%' and prosrc like '%lote_fuera%' and prosrc like '%deb_libres%'`)).n
check('[regresión 0034] la función de 0038 conserva los cuatro bloques de 0034 (pfuera, lote_fuera, deb_libres, dup_par)', sol === 1)
const subs = (s) => (s.match(/\(\s*select/gi) ?? []).length
const src = async (n) => (await val(`select prosrc s from pg_proc where proname = $1`, [n])).s
info('subconsultas "(select" en el cuerpo', { '0034': subs(await src('flujo_lineas_entre_34')), '0038': subs(await src('flujo_lineas_entre')) })

// ---------------------------------------------------------------- Rendimiento: 0034 contra 0038 con volumen
await db.exec(`
  insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, cuenta_origen_id, estado_xubio_pago, estado, gestion, contabilizado_por, cuenta_contable)
  select 'beratung', case when g % 3 = 0 then null else '${pGomez}'::uuid end, ($1::date - (g % 40) - 1), 100 + g, 'TRANSFERENCIA', 'carga', '${cDax}'::uuid, 'SUBIDO', 'CARGADO', 'SISTEMA', 'carga',
         case when g % 2 = 0 then 'HONORARIOS PROFESIONALES' else null end
  from generate_series(1, 3000) g`.replace('$1', `'${hoy}'`))
await db.exec(`
  insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, pago_id)
  select 'beratung', p.cuenta_origen_id, p.fecha, 'DEBITO ' || p.importe, -p.importe, 'VOL-' || p.id, 'PAGO', 'PENDIENTE', p.id from pagos p where p.cargado_por = 'carga'`)
const tiempo = async (fn) => { const t = Date.now(); await db.query(`select count(*) from ${fn}(null, null, null, false)`); return Date.now() - t }
await tiempo('flujo_lineas_entre'); await tiempo('flujo_lineas_entre_34')
const t38 = [], t34 = []
for (let i = 0; i < 3; i++) { t34.push(await tiempo('flujo_lineas_entre_34')); t38.push(await tiempo('flujo_lineas_entre')) }
const med = (a) => [...a].sort((x, y) => x - y)[1]
info('flujo_lineas_entre con ~6.000 filas (ms, mediana de 3, sin fila PF)', { '0034': med(t34), '0038': med(t38) })
check('[rendimiento] 0038 no es más de 1,3 veces más lenta que 0034 con la regla apagada', med(t38) <= med(t34) * 1.3 + 50, `${med(t38)} vs ${med(t34)} ms`)
await db.exec(`update flujo_filas set para_persona_fisica = true where id = '${consCta}'`)
const t38pf = []
for (let i = 0; i < 3; i++) t38pf.push(await tiempo('flujo_lineas_entre'))
info('con la fila PF marcada (ms)', med(t38pf))
check('[rendimiento] con la fila PF marcada tampoco se dispara', med(t38pf) <= med(t34) * 1.5 + 50, `${med(t38pf)} vs ${med(t34)} ms`)
await db.exec(`update flujo_filas set para_persona_fisica = false`)
await db.exec(`update movimientos_bancarios set pago_id = null where huella like 'VOL-%'`)
await db.exec(`delete from movimientos_bancarios where huella like 'VOL-%'`)
await db.exec(`delete from pagos where cargado_por = 'carga'`)

// ---------------------------------------------------------------- Persona física: falsos positivos del criterio (el Apps Script usa la misma lista)
const esPF = async (n) => (await val(`select es_persona_fisica($1) r`, [n])).r
const entidades = ['ARCA', 'AFIP', 'Telecom Argentina', 'Swiss Medical', 'Fundación Favaloro', 'Laboratorios Roemmers SAICF', 'Norte S.A.U.', 'Farmacia Central S.C.A.', 'Hermanos Gómez y Cía', 'Droguería del Sud LTDA']
const comoPF = []
for (const e of entidades) if (await esPF(e)) comoPF.push(e)
info('entidades que es_persona_fisica toma como persona (igual que el motor)', comoPF)
check('[persona física] solo S.A., S.R.L., SAS, sociedad y cooperativa excluyen: una empresa sin esas palabras se toma como persona (SAU, SAICF, LTDA, fundaciones, organismos)', comoPF.length === 0,
  `${comoPF.length} de ${entidades.length}; es la misma lista del Apps Script, así que es paridad, pero movería pagos a Consultorios`)

// ---------------------------------------------------------------- Persona física: no mueve pagos de otras unidades ni cambia el total
await db.exec(`update flujo_filas set para_persona_fisica = true where id = '${consCta}'`)
const hon = (await val(`select id from flujo_filas where unidad_id = $1 and tipo = 'CUENTA' and cuenta_norm = 'HONORARIOS PROFESIONALES'`, [uDax]))
const honDax = hon?.id ?? (await val(`insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable) values ($1, 'beratung', 230, 'CUENTA', 'COSTOS', 'Honorarios profesionales', 'HONORARIOS PROFESIONALES') returning id`, [uDax])).id
const antes = await filas(`select unidad_id, round(sum(importe), 2)::float s from flujo_lineas_entre_34(null, null, null, false) group by 1 order by 1`)
const despues = await filas(`select unidad_id, round(sum(importe), 2)::float s from flujo_lineas_entre(null, null, null, false) group by 1 order by 1`)
check('[persona física] mover un pago a Consultorios no cambia el total de ninguna unidad (solo la fila)', JSON.stringify(antes) === JSON.stringify(despues), JSON.stringify({ antes, despues }))
const movidos = await filas(`select a.origen_id, a.fila_id desde, b.fila_id hasta from flujo_lineas_entre_34(null, null, null, false) a join flujo_lineas_entre(null, null, null, false) b
  on b.origen_tipo = a.origen_tipo and b.origen_id = a.origen_id and b.ocurrencia = a.ocurrencia where a.fila_id <> b.fila_id`)
check('[persona física] solo se mueve el pago de GOMEZ (persona) desde la cuenta de Dax: uno', movidos.length === 1, JSON.stringify(movidos))
await db.exec(`update flujo_filas set para_persona_fisica = false`)

// ---------------------------------------------------------------- "Esta y las siguientes": desfase con la ocurrencia anterior
await como('teso@prueba.com')
const crear = async (extra) => (await val(`select crear_proyeccion($1) id`, [{ empresa_id: 'beratung', unidad_id: uBer, fila_id: rows.honorarios, concepto: 'Servicio', importe: -100, fecha_inicio: dia(7), recurrencia: 'UNICA', ...extra }])).id
const lin = (id) => filas(`select ocurrencia, importe::float i from flujo_lineas_entre($1, $2, null, false) where origen_tipo = 'PROYECCION' and origen_id = $3 order by ocurrencia`, [hoy, dia(200), id])
// Semanal sin tope de cuotas, con final: se corre "esta y las siguientes" a una fecha ANTERIOR a la ocurrencia previa.
const ss = await crear({ recurrencia: 'SEMANAL', hasta: dia(60), importe: -100, fecha_inicio: dia(7) })       // 7, 14, 21, 28...
const eAdelanto = await error(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'adelanto') id`, [ss, dia(21), dia(9)])
const ocs = (await lin(ss)).map((l) => l.ocurrencia).sort()   // ahora se rechaza: la serie queda entera
const dup = ocs.filter((d, i) => i > 0 && (Date.parse(d) - Date.parse(ocs[i - 1])) / 86400000 < 7)
check('[esta y siguientes] mover la serie a una fecha anterior a la ocurrencia previa se rechaza y no deja dos cobros pegados', dup.length === 0 && /antes de la ocurrencia anterior/.test(eAdelanto ?? ''), `quedan ${ocs.join(', ')}: dos ocurrencias a menos de 7 días`)
// Una excepción de BAJA de la ocurrencia siguiente se pierde cuando cambia la fecha (se da de baja sin avisar).
const sb = await crear({ recurrencia: 'SEMANAL', hasta: dia(40), importe: -100, fecha_inicio: dia(7) })
await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'BORRAR', null, null, 'este no va')`, [sb, dia(28)])
const nb = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 150, null, 'sube') id`, [sb, dia(21)])).id
const lb = await lin(nb)
check('[esta y siguientes] la baja que ya tenía una ocurrencia posterior (el 28) pasa a la serie nueva', !lb.some((l) => l.ocurrencia === dia(28)), JSON.stringify(lb.map((l) => l.ocurrencia)))
// Cuotas restantes con una excepción de baja en una cuota anterior (sigue contando como usada).
const sc = await crear({ recurrencia: 'SEMANAL', cuotas: 4, importe: -100, fecha_inicio: dia(7) })      // 7, 14, 21, 28
await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'BORRAR', null, null, 'saltea')`, [sc, dia(14)])
const nc = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 120, null, 'sube') id`, [sc, dia(21)])).id
check('[esta y siguientes] cuotas restantes: 4 - 2 anteriores = 2 aunque una de las anteriores se haya salteado', (await val(`select cuotas from proyecciones where id = $1`, [nc])).cuotas === 2)
const total = (await lin(sc)).concat(await lin(nc)).length
check('[esta y siguientes] sin huecos ni duplicados: 3 ocurrencias visibles (7, 21, 28; el 14 fue baja)', total === 3, `${total}`)
// Doble clic: la segunda vez ya no encuentra la ocurrencia (no duplica).
check('[esta y siguientes] repetir el mismo cambio (doble clic) falla y no crea otra serie', (await error(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 120, null, 'otra vez')`, [sc, dia(21)])) !== null
  && (await val(`select count(*)::int n from proyecciones where nota like 'Sigue a ' || left($1::text, 8) || '%'`, [sc])).n === 1)

// ---------------------------------------------------------------- Filas MANUAL: lo que ya existía sigue sumando junto a la carga a mano
await como('admin@prueba.com')
await servidor()
const ocSueldos = (await filas(`select ocurrencia, fecha::text f, importe::float i from flujo_lineas_entre($1, $2, $3, false) where origen_id = $4`, [hoy, dia(40), uBer, pSueldosMensual]))
check('[manual] una proyección mensual que ya existía en una fila manual y no tiene carga a mano ese día sigue sumando (es el valor manual de la planilla migrada)', ocSueldos.length > 0,
  `suma ${ocSueldos.length} ocurrencias de -1.000.000`)
await como('teso@prueba.com')
const fHab = await habil(ocSueldos[0]?.f ?? dia(5))
const manualId = (await val(`select crear_proyeccion($1) id`, [{ empresa_id: 'beratung', unidad_id: uBer, fila_id: rows.sueldos, concepto: 'Sueldos quincena a mano', importe: -1000000, fecha_inicio: ocSueldos[0]?.ocurrencia ?? dia(5), recurrencia: 'UNICA' }])).id
await servidor()
const celdaSueldos = await val(`select coalesce(sum(importe), 0)::float s, count(*)::int n from flujo_lineas_entre($1, $1, $2, false) where fila_id = $3`, [fHab, uBer, rows.sueldos])
check('[manual] la carga a mano del mismo día reemplaza a la proyección que ya estaba: no se suma además de la proyección que ya estaba (se espera -1.000.000, no -2.000.000)', celdaSueldos.s === -1000000, JSON.stringify(celdaSueldos))
// Una fila que el motor clasifica (movimiento real del banco) dentro de una fila manual también suma.
await servidor()
const movSueldo = await mov(cBer, dia(-1), -500000, 'PAGO SUELDOS')
await db.query(`update movimientos_bancarios set cuenta_contable = 'SUELDOS Y JORNALES' where id = $1`, [movSueldo])
const enManual = await val(`select count(*)::int n from flujo_lineas_entre($1, $2, $3, false) where fila_id = $4 and naturaleza = 'REAL'`, [dia(-1), dia(-1), uBer, rows.sueldos])
info('un débito real "SUELDOS" cae en la fila manual (ahí SÍ debe sumar: es plata que ya salió)', enManual)

// ---------------------------------------------------------------- Planilla de gastos: pendiente de factura + factura que llega después
const pQ = await provP('20999999991', 'QUIROGA ANA')
await como('teso@prueba.com')
const mesN = (await val(`select extract(month from $1::date)::int m, extract(year from $1::date)::int a`, [hoy]))
const r1 = (await val(`select cargar_gastos_mes($1, $2, $3, 'GASTOS.xlsx', $4) r`, [uDax, mesN.a, mesN.m, JSON.stringify([{ hoja: 'COLAB', nombre: 'QUIROGA ANA', factura: '', importe: 5000, fecha: dia(10), fila: 'Honorarios profesionales' }])])).r
check('[planilla] el renglón sin factura queda como pendiente', r1.pendientes === 1, JSON.stringify(r1))
await servidor()
await db.query(`insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable, unidad_id)
  values ('beratung', $1, 'Factura A', 'A', 1, 777, $2, $3, 5000, 5000, 'PARA_PAGAR', 0, 'HONORARIOS PROFESIONALES', $4)`, [pQ, dia(-1), dia(10), uDax])
const dosVeces = await filas(`select origen_tipo, importe::float i from flujo_lineas_entre($1, $2, $3, false) where contraparte like 'QUIROGA%' and naturaleza = 'PROYECTADO'`, [hoy, dia(30), uDax])
check('[planilla] cuando la factura llega después de cargar la planilla, el Flujo cuenta una sola vez lo mismo (pendiente + factura)', dosVeces.length === 1, JSON.stringify(dosVeces) + ' · se corrige recién al volver a cargar la planilla (no hay re-cruce automático)')

// ---------------------------------------------------------------- Foto mensual: concurrencia y mensajes
await como('teso@prueba.com')
const fotoA = (await val(`select sacar_foto_flujo_unidad($1) m`, [uBer])).m
const fotoB = (await val(`select sacar_foto_flujo_unidad($1) m`, [uBer])).m
check('[foto] dos corridas el mismo día: la segunda no hace nada', /^Foto de/.test(fotoA) && /^Ya hay foto de/.test(fotoB), `${fotoA} / ${fotoB}`)
const lockUsado = /pg_advisory|for update/i.test(await src('sacar_foto_flujo_unidad'))
check('[foto] la tarea y una persona que corren a la vez no se pisan (bloqueo por unidad y mes)', lockUsado, 'sin bloqueo: la segunda transacción termina con "duplicate key" en flujo_fotos (unique unidad_id, dia); no corrompe pero devuelve un error crudo')
await como('solober@prueba.com')
const mio = (await val(`select sacar_fotos_flujo(null, true) r`)).r
check('[foto] "Reemplazar la foto" de una persona reemplaza las de TODAS las unidades que ve, también las del cron del servidor', mio.every((x) => /^Foto de/.test(x.resultado)), JSON.stringify(mio))
await servidor()

// ---------------------------------------------------------------- CSV de la grilla (src/lib/tesoreria.ts)
let lib = null
try { lib = await import('../../src/lib/tesoreria.ts') } catch (e) { info('CSV: no se pudo importar tesoreria.ts (corré con --import ./netlify/pruebas/resolver.mjs)', e.message.slice(0, 80)) }
if (lib) {
  const U = 'u1'
  const dias = ['2026-11-26', '2026-11-27']
  const fila = (id, orden, tipo, seccion, etiqueta, extra = {}) => ({ id, unidadId: U, orden, tipo, seccion, etiqueta, mueveCaja: true, ...extra })
  const filasG = [
    fila('s1', 100, 'SECCION', 'INGRESOS_OPERATIVOS', '1. INGRESOS OPERATIVOS'), fila('c1', 110, 'CUENTA', 'INGRESOS_OPERATIVOS', 'Cobranzas'),
    fila('s3', 300, 'SECCION', 'GASTOS_OPERATIVOS', '3. GASTOS OPERATIVOS'), fila('g1', 320, 'CUENTA', 'GASTOS_OPERATIVOS', '=Alquiler'),
    fila('fci', 1100, 'INTERNO', 'ENTRE_CUENTAS', 'FCI suscripciones', { mueveCaja: false }),
  ]
  const ln = (filaId, fecha, importe) => ({ empresaId: 'e', unidadId: U, filaId, origenTipo: 'MOVIMIENTO', origenId: filaId + fecha, ocurrencia: 'MOVIMIENTO', naturaleza: 'REAL', fecha, fechaCalculada: fecha,
    importe, concepto: 'x', vencido: false, ajustada: false, editable: false })
  const lineasG = [ln('c1', '2026-11-26', 1000), ln('g1', '2026-11-26', -300), ln('fci', '2026-11-27', -500)]   // suscripción a un FCI de otra unidad: una sola pata acá
  const g = lib.armarGrilla({ unidadId: U, dias, filas: filasG, lineas: lineasG, cuentas: [], saldos: [], control: [], feriados: new Set() })
  const csv = lib.grillaACsv(g).replace(/^﻿/, '').trimEnd().split('\r\n').map((l) => l.split(';'))
  const f = (t) => csv.find((c) => c[1] === t)
  const ing = f('Ingresos del día').slice(2, 4).map((x) => Number(x.replace(',', '.')))
  const egr = f('Egresos del día').slice(2, 4).map((x) => Number(x.replace(',', '.')))
  const net = f('Flujo neto del día').slice(2, 4).map((x) => Number(x.replace(',', '.')))
  check('[CSV] por día: ingresos - egresos = flujo neto (como se ve en pantalla)', dias.every((_, i) => Math.round((ing[i] - egr[i]) * 100) === Math.round(net[i] * 100)),
    `ingresos ${ing} · egresos ${egr} · neto ${net}: la fila que no mueve caja entra al neto y la caja pero no a ingresos/egresos`)
  check('[CSV] una cuenta que empieza con "=" no se interpreta como fórmula al abrirla en la planilla', !csv.some((c) => c[1]?.startsWith('=')), csv.map((c) => c[1]).join(' | '))
  check('[CSV] las columnas de cada línea coinciden con el encabezado', csv.every((c) => c.length === csv[0].length || c[0] === '' ), '')
}

console.log(`\n${ok} OK · ${bug} BUG`)
await db.close()
process.exit(0)
