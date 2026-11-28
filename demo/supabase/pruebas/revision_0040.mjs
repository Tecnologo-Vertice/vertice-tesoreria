// Revisión independiente de 0040 (agente 06, 27/11/2026): FCI y saldos + Mercado Pago por API.
// Los "BUG" son comportamientos que rompen algo o que no coinciden con el Apps Script; los "OK" son controles (lo que sí anda);
// los "INFO" solo muestran un dato. Datos ficticios. No toca producción.
// Uso (desde demo/): node --import ./netlify/pruebas/resolver.mjs supabase/pruebas/revision_0040.mjs supabase/migrations
//   (el resolver solo hace falta para la parte de Mercado Pago, que importa el .ts; sin él esa parte se saltea)
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
const comoAnon = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role anon`) }
const servidor = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const sqlDe = (f) => readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')

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
// La base "real" ya tiene 0001-0039 (con datos); 0040 se aplica después, sobre datos existentes.
const todas = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
for (const f of todas.filter((x) => !x.startsWith('0040'))) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(sqlDe(f)) } catch (e) { console.log(`BUG migración ${f} no aplica: ${e.message}`); process.exit(1) }
}

// ---------------------------------------------------------------- Datos "reales" que ya existían antes de 0040
await servidor()
const hab = (await filas(`select d::date::text f from generate_series(hoy_ar() - 40, hoy_ar() - 1, interval '1 day') d where es_dia_habil(d::date) order by d`)).map((x) => x.f).slice(-14)
const hoy = (await val(`select hoy_ar()::text d`)).d
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMIN', true),
    ('aprob@prueba.com', 'Aprob', 'APROBADOR', true), ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
  insert into cuentas_contables (empresa_id, nombre) values (null, 'Banco Prueba CC'), (null, 'Banco Prueba CA'), (null, 'Banco Prueba REM');
`)
const cc = async (n) => (await val(`select id from cuentas_contables where nombre = $1`, [n])).id
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const uBer = (await val(`select id from unidades where empresa_id = 'beratung' and por_defecto`)).id
const cuenta = async (nombre, clase, x = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, cuenta_contable_id, unidad_id, requiere_extracto, cuenta_madre_id, rinde_diario)
   values ($1, $2, $3, $4, '30999999991', $5, $6, $7, $8, $9) returning id`,
  [x.empresa ?? 'india', nombre, x.banco ?? 'BANCOPRUEBA', clase, x.contable ?? null, x.unidad ?? uIndia, x.requiere ?? false, x.madre ?? null, x.rinde ?? false])).id
let nh = 0
const mov = async (c, fecha, importe, desc, o = {}) => (await servidor(), await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, destino_xubio, cuenta_contable)
   values ((select empresa_id from cuentas_origen where id = $1), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
  [c, fecha, desc, importe, `R40-${nh++}`, o.categoria ?? 'SIN_CLASIFICAR', o.estado ?? 'PENDIENTE', o.destino ?? 'NINGUNO', o.cuentaContable ?? null])).id
const saldo = (c, fecha, s, origen = 'EXTRACTO') => db.query(
  `insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
   values ($1, $2, (select empresa_id from cuentas_origen where id = $1), $3, $4, 'prueba')
   on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, origen = excluded.origen`, [c, fecha, s, origen])
const importar = async (c, hash, movs, extra = {}) => (await val(`select importar_extracto($1) r`, [{ cuenta_origen_id: c, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash }, movimientos: movs, ...extra }])).r

const hipo = await cuenta('HIPOTECARIO CC', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true })
const fciTor = await cuenta('FCI TORONTO', 'FCI', { madre: hipo })
const bru = await cuenta('BRUBANK CC', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'BRUBANK' })
const bruRem = await cuenta('BRUBANK REMUNERADA', 'REMUNERADA', { madre: bru, banco: 'BRUBANK', rinde: true, contable: await cc('Banco Prueba REM') })
const icbc = await cuenta('ICBC CC', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'ICBC' })
const fciA = await cuenta('FCI ALPHA', 'FCI', { madre: icbc })
const ca = await cuenta('GALICIA CA', 'CA', { contable: await cc('Banco Prueba CA'), requiere: true, banco: 'GALICIA' })
const cx = await cuenta('GALICIA CC X', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'GALICIA' })
const cy = await cuenta('GALICIA CC Y', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'GALICIA' })
const cz = await cuenta('GALICIA CC Z', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'GALICIA' })
const berMadre = await cuenta('BER MADRE', 'CC', { empresa: 'beratung', unidad: uBer, contable: await cc('Banco Prueba CC'), requiere: true, banco: 'ICBC' })
const berFondo = await cuenta('BER FONDO', 'FCI', { empresa: 'beratung', unidad: uBer, madre: berMadre })

// Intereses "INTERESES PAGADOS" que ya estaban cargados sin clasificar (la base real los tiene así).
await mov(bruRem, hab[2], 7.5, 'INTERESES PAGADOS', { estado: 'A_REVISAR' })
const f40 = todas.find((x) => x.startsWith('0040'))
try { await db.exec(sqlDe(f40)); check('0040 aplica sobre una base con 0001-0039 y datos', true) } catch (e) { console.log('BUG 0040 no aplica: ' + e.message); process.exit(1) }
try { await db.exec(sqlDe(f40)); check('0040 se puede ejecutar dos veces', true) } catch (e) { check('0040 se puede ejecutar dos veces', false, e.message) }

// ---- Lo que queda sin tocar después de aplicar 0040
{
  const viejo = await val(`select categoria, estado from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2 and descripcion = 'INTERESES PAGADOS'`, [bruRem, hab[2]])
  const usos = ['src', 'netlify/functions'].flatMap((d) => { const r = []; const rec = (p) => { for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) rec(q); else if (/[.](ts|tsx|mts)$/.test(e.name)) r.push(q) } }; rec(d); return r })
    .filter((q) => /clasificar_intereses_remunerada|saldos_arrastrados|rendimientos_fci_dia|avisos_fci/.test(readFileSync(q, 'utf8')))
  check('los "INTERESES PAGADOS" ya cargados quedan clasificados al aplicar 0040, o los clasifica el cron/la pantalla', viejo.categoria === 'FCI_RENDIMIENTO' || usos.length > 0,
    `siguen "${viejo.categoria}/${viejo.estado}" y ningún código (pantalla ni funciones de Netlify) llama a clasificar_intereses_remunerada, saldos_arrastrados, rendimientos_fci_dia ni avisos_fci: hay que correrlas a mano desde el editor SQL`)
  const sql0040 = readFileSync(join(dir, f40), 'utf8').split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('--')).join(' ')
  check('0040 no usa current_date (todo con hoy_ar())', !/current_date/i.test(sql0040))
}

// ================================================================ 1. Permisos
const FUNCS = ['generar_asiento_complemento(uuid,date)', 'generar_asiento_del_dia(uuid,date)', 'clasificar_intereses_remunerada(text)',
  'rendimientos_fci_dia(date,uuid)', 'sincronizar_capital_fci(text,date)', 'saldos_arrastrados(date,date,text)']
for (const f of FUNCS) {
  const r = await val(`select has_function_privilege('anon', $1::regprocedure, 'execute') a, has_function_privilege('authenticated', $1::regprocedure, 'execute') u,
                              has_function_privilege('service_role', $1::regprocedure, 'execute') s, p.prosecdef d, p.proconfig c
                       from pg_proc p where p.oid = $1::regprocedure`, [f])
  check(`permisos de ${f}: anon no, authenticated y servidor sí`, !r.a && r.u && r.s, JSON.stringify(r))
  if (r.d) check(`${f} es SECURITY DEFINER con search_path fijo`, (r.c ?? []).some((x) => /search_path=/.test(x)), JSON.stringify(r.c))
}
const vista = await val(`select has_table_privilege('anon', 'avisos_fci', 'select') a, has_table_privilege('authenticated', 'avisos_fci', 'select') u,
  (select reloptions from pg_class where relname = 'avisos_fci') o`)
check('avisos_fci: anon no, authenticated sí, con security_invoker', !vista.a && vista.u && (vista.o ?? []).includes('security_invoker=true'), JSON.stringify(vista))
{
  await comoAnon()
  check('anon no puede llamar generar_asiento_del_dia', (await error(`select generar_asiento_del_dia($1, $2)`, [cx, hab[0]])) !== null)
  await como('aprob@prueba.com')
  check('un APROBADOR no genera asientos del día', /rol|permiso|autoriz/i.test((await error(`select generar_asiento_del_dia($1, $2)`, [cx, hab[0]])) ?? ''))
  check('un APROBADOR no sincroniza capital FCI', (await error(`select sincronizar_capital_fci('india')`)) !== null)
  check('un APROBADOR no clasifica intereses', (await error(`select clasificar_intereses_remunerada('india')`)) !== null)
  await como('solober@prueba.com')
  check('otra empresa: no genera complemento de una cuenta ajena', /acceso/i.test((await error(`select generar_asiento_complemento($1, $2)`, [cx, hab[0]])) ?? ''))
  check('otra empresa: no genera el asiento del día de una cuenta ajena', /acceso/i.test((await error(`select generar_asiento_del_dia($1, $2)`, [cx, hab[0]])) ?? ''))
  check('otra empresa: no sincroniza capital de india', /acceso/i.test((await error(`select sincronizar_capital_fci('india')`)) ?? ''))
  check('otra empresa: no clasifica intereses de india', /acceso/i.test((await error(`select clasificar_intereses_remunerada('india')`)) ?? ''))
  await servidor()
}

// ================================================================ 2. Complemento del día
const habilitarImpuesto = (c, fecha, imp, d = 'IMP LEY 25413 DB') => mov(c, fecha, imp, d, { categoria: 'IMPUESTO', destino: 'ASIENTO', cuentaContable: 'IMPUESTO DEB/CRED BANCARIO' })
const subir = async (id) => { await servidor(); await db.query(`select resultado_asiento_xubio($1, true, '9001', null)`, [id]) }
const lineasDe = async (id) => filas(`select cuenta_contable, debe::float d, haber::float h from asiento_lineas where asiento_id = $1 order by id`, [id])
{
  await como('teso@prueba.com')
  const m1 = await habilitarImpuesto(cx, hab[10], -3000)
  await como('teso@prueba.com')
  const dia1 = await val(`select generar_asiento_bancario($1, $2) id`, [cx, hab[10]])
  check('el asiento del día se genera', !!dia1.id)
  await subir(dia1.id)
  await como('teso@prueba.com')
  const sinNuevos = await val(`select generar_asiento_del_dia($1, $2) id`, [cx, hab[10]])
  check('sin movimientos nuevos, "asiento del día" no crea nada (no duplica)', sinNuevos.id === null && (await val(`select count(*)::int n from asientos where cuenta_origen_id = $1 and fecha = $2`, [cx, hab[10]])).n === 1)
  await servidor()
  const m2 = await habilitarImpuesto(cx, hab[10], -500, 'IMP LEY 25413 DB TARDE')
  await como('teso@prueba.com')
  const c1 = (await val(`select generar_asiento_del_dia($1, $2) id`, [cx, hab[10]])).id
  const a1 = await val(`select tipo, estado_xubio::text e from asientos where id = $1`, [c1])
  const l1 = await lineasDe(c1)
  check('tarde llega un impuesto: se crea el complemento (BANCARIO_COMPLEMENTO, pendiente) balanceado', a1.tipo === 'BANCARIO_COMPLEMENTO' && a1.e === 'PENDIENTE' && l1.reduce((s, x) => s + x.d - x.h, 0) === 0 && l1.length === 2, JSON.stringify(l1))
  check('el complemento no toca los movimientos del asiento ya subido', (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [dia1.id])).n === 1)
  const pend = await val(`select count(*)::int n from xubio_bancos_pendientes where id = $1 and tipo = 'ASIENTO' and estado = 'PENDIENTE'`, [c1])
  check('el complemento entra a xubio_bancos_pendientes (se envía como cualquier asiento)', pend.n === 1)
  await servidor()
  await habilitarImpuesto(cx, hab[10], -200, 'IMP LEY 25413 DB TARDE 2')
  await como('teso@prueba.com')
  const c1b = (await val(`select generar_asiento_del_dia($1, $2) id`, [cx, hab[10]])).id
  check('complemento pendiente: se rehace con todo lo nuevo, sin duplicar', (await val(`select count(*)::int n from asientos where cuenta_origen_id = $1 and fecha = $2 and tipo = 'BANCARIO_COMPLEMENTO'`, [cx, hab[10]])).n === 1
    && (await lineasDe(c1b)).reduce((s, x) => s + x.d, 0) === 700)
  // en envío: no se pisa
  await servidor()
  await db.query(`update asientos set envio_xubio_en = now() where id = $1`, [c1b])
  const m4 = await habilitarImpuesto(cx, hab[10], -100, 'IMP LEY 25413 DB TARDE 3')
  await como('teso@prueba.com')
  const eEnvio = await error(`select generar_asiento_del_dia($1, $2)`, [cx, hab[10]])
  check('un complemento que se está enviando no se pisa', /se está enviando/.test(eEnvio ?? ''), eEnvio ?? 'no falló')
  check('...y el movimiento nuevo queda libre', (await val(`select asiento_id from movimientos_bancarios where id = $1`, [m4])).asiento_id === null)
  // complemento subido -> el próximo es otro complemento
  await servidor()
  await db.query(`update asientos set envio_xubio_en = null where id = $1`, [c1b])
  await subir(c1b)
  await como('teso@prueba.com')
  const c2 = (await val(`select generar_asiento_del_dia($1, $2) id`, [cx, hab[10]])).id
  check('con el complemento ya subido, lo nuevo va en otro complemento (el subido no se toca)', c2 && c2 !== c1b
    && (await val(`select estado_xubio::text e from asientos where id = $1`, [c1b])).e === 'SUBIDA'
    && (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [c1b])).n === 2)

  // ---- carrera entre dos llamadas: no hay candado ni índice único para el complemento
  const idx = await filas(`select indexdef from pg_indexes where tablename = 'asientos' and indexdef ilike '%unique%'`)
  info('índices únicos de asientos', idx.map((x) => x.indexdef))
  await servidor()
  const dup = await error(`insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por)
    select empresa_id, cuenta_origen_id, fecha, 'BANCARIO_COMPLEMENTO', 'dup', 'x' from asientos where id = $1`, [c2])
  check('la base impide dos complementos pendientes del mismo banco y día (carrera de dos llamadas: la 2ª ve lo mismo sin confirmar y crea otro asiento con las mismas líneas)',
    dup !== null, 'se pudo insertar un segundo complemento pendiente; solo el código lo evita, y entre dos transacciones simultáneas no alcanza (falta índice único parcial o bloqueo del asiento del día)')
  const def = (await val(`select pg_get_functiondef('generar_asiento_complemento(uuid,date)'::regprocedure) d`)).d
  check('generar_asiento_complemento bloquea (for update) el asiento del día antes de armar', /BANCARIO_DIARIO[^;]*for update/s.test(def), 'solo bloquea el complemento pendiente (si existe); sin uno pendiente, dos llamadas simultáneas pasan las dos')
}

// ---- Anular el asiento del día con un complemento ya hecho: rehacer duplica
{
  await servidor()
  await habilitarImpuesto(cy, hab[9], -3000)
  await habilitarImpuesto(cy, hab[9], -1000, 'IMP LEY 25413 DB 2')
  const d = (await val(`select generar_asiento_bancario($1, $2) id`, [cy, hab[9]])).id
  await subir(d)
  await habilitarImpuesto(cy, hab[9], -700, 'IMP LEY 25413 DB TARDE')
  const c = (await val(`select generar_asiento_del_dia($1, $2) id`, [cy, hab[9]])).id
  await subir(c)
  await como('admin@prueba.com')
  await db.query(`select anular_asiento($1, 'se subió con un error')`, [d])
  const nuevo = (await val(`select generar_asiento_del_dia($1, $2) id`, [cy, hab[9]])).id
  await servidor()
  const vigentes = await filas(`select id, tipo, estado_xubio::text e, (select coalesce(sum(debe),0)::float from asiento_lineas l where l.asiento_id = a.id) debe
                                from asientos a where cuenta_origen_id = $1 and fecha = $2 and anulado_en is null`, [cy, hab[9]])
  const totalMovs = (await val(`select coalesce(sum(-importe),0)::float t from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2 and destino_xubio = 'ASIENTO'`, [cy, hab[9]])).t
  const totalAsientos = vigentes.reduce((s, x) => s + x.debe, 0)
  info('anular el del día y rehacer: asientos vigentes', vigentes)
  check('anular el asiento del día (con un complemento subido) y rehacerlo no repite en Xubio lo que ya subió el complemento',
    totalAsientos === totalMovs, `los movimientos suman ${totalMovs} y los asientos vigentes ${totalAsientos}: el nuevo asiento del día vuelve a incluir los movimientos del complemento (generar_asiento_bancario no filtra asiento_id is null) y se los quita`)
  check('...y los movimientos del complemento siguen en su asiento', (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [c])).n === 1)
}

// ================================================================ 3. Regla 55 (intereses) y regla 85 (reservas MP)
{
  await servidor()
  const r = await filas(`select orden, patrones, sentido, categoria, destino_xubio from reglas_extracto where orden in (55, 85)`)
  info('reglas 55 y 85', r)
  const org = (await val(`select count(*)::int n from organizaciones where es_proveedor`)).n
  check('una regla 55 y una 85 por organización proveedora', r.length === 2 * org)
  // la regla 55 se aplica a cualquier cuenta de la organización, no solo a la remunerada de Brubank
  const x = await importar(ca, 'ca-int-1', [{ fecha: hab[11], descripcion: 'INTERESES PAGADOS', importe: 50, saldo: 1050 }], { saldos: [{ fecha: hab[11], saldo: 1050 }] })
  const m = await val(`select categoria, destino_xubio, cuenta_contable, estado from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [ca, hab[11]])
  info('INTERESES PAGADOS en una caja de ahorro común (CA)', m)
  check('"INTERESES PAGADOS" de una caja de ahorro común no se vuelve "Rendimientos FCI" (el Apps Script solo lo hacía con Brubank remunerada)',
    m.categoria !== 'FCI_RENDIMIENTO', `queda ${m.categoria} → asiento Haber "${m.cuenta_contable}": la regla 55 no distingue cuenta (reglas_extracto.cuenta_origen_id queda null) y regla_para_movimiento no mira la clase`)
  // clasificar_intereses_remunerada sí mira la clase
  await como('teso@prueba.com')
  const n = (await val(`select clasificar_intereses_remunerada('india') n`)).n
  await servidor()
  check('clasificar_intereses_remunerada pasa a rendimiento los intereses viejos de la remunerada (uno)', n === 1 && (await val(`select categoria from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [bruRem, hab[2]])).categoria === 'FCI_RENDIMIENTO')
  await como('teso@prueba.com')
  check('...y no clasifica de nuevo (idempotente)', (await val(`select clasificar_intereses_remunerada('india') n`)).n === 0)
  await servidor()
}
{
  // El detalle del día de la remunerada: el Apps Script devuelve como importe los intereses informados por Brubank.
  await servidor()
  await saldo(bruRem, hab[3], 5000); await saldo(bruRem, hab[4], 5010)
  await importar(bruRem, 'rem-int-1', [{ fecha: hab[4], descripcion: 'INTERESES PAGADOS', importe: 10, saldo: 5010 }], { saldos: [{ fecha: hab[4], saldo: 5010 }] })
  await como('teso@prueba.com')
  const r = await val(`select importe::float i, detalle from rendimientos_fci_dia($1, $2)`, [hab[4], bruRem])
  info('rendimientos_fci_dia de la remunerada con intereses pagados', r)
  check('rendimientos_fci_dia devuelve como importe los intereses pagados que informa Brubank (cbxRendimientos_: intRem)', r.i === 10, `importe ${r.i} pero el detalle dice "${r.detalle}": el importe sale de conciliacion_calculo.rendimiento (saldo - anterior - créditos), y el interés ya cuenta como crédito`)
  await servidor()
  // el Flujo no pierde la plata: entra por el movimiento
  const fl = await val(`select coalesce(sum(importe),0)::float t from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 1, null, true) where cuenta_origen_id = $1 and fecha = $2`, [bruRem, hab[4]])
  check('el interés entra al Flujo una sola vez (por el movimiento; el rendimiento calculado da 0)', fl.t === 10, JSON.stringify(fl))
}

// ================================================================ 4. Capital del FCI (sincronizar_capital_fci)
{
  await servidor()
  // a) lo que sí tiene que hacer: suscripción clasificada como FCI
  const sus = await mov(icbc, hab[6], -80000, 'SUSCRIPCION FCI ALPHA', { categoria: 'FCI', destino: 'ASIENTO', cuentaContable: 'Fondos Comun de Inversion Bancos' })
  const r1 = (await val(`select sincronizar_capital_fci('india') r`)).r
  check('suscripción FCI: queda con su fondo (lo hace el disparador de 0030 al importar; la función no la repite) y de nuevo no cambia nada', (await val(`select contraparte_cuenta_id c from movimientos_bancarios where id = $1`, [sus])).c === fciA && (await val(`select sincronizar_capital_fci('india') r`)).r.asignados === 0, JSON.stringify(r1))
  // b) falso positivo: cualquier movimiento de la madre con SUSC/RESC en el texto, aunque no sea del fondo
  await saldo(fciA, hab[7], 1000000, 'TENENCIA'); await saldo(fciA, hab[8], 1000100, 'TENENCIA')
  const antes = await val(`select rendimiento::float r from conciliacion_calculo(true) where cuenta_origen_id = $1 and fecha = $2`, [fciA, hab[8]])
  const revista = await mov(icbc, hab[8], -5000, 'DEBITO SUSCRIPCION REVISTA EL ECONOMISTA', { categoria: 'PAGO' })
  const resc = await mov(icbc, hab[8], -9000, 'PAGO RESCISION CONTRATO LOCACION', { categoria: 'PAGO' })
  await db.query(`select sincronizar_capital_fci('india')`)
  const cpt = await filas(`select id, contraparte_cuenta_id c from movimientos_bancarios where id in ($1, $2)`, [revista, resc])
  const desp = await val(`select rendimiento::float r from conciliacion_calculo(true) where cuenta_origen_id = $1 and fecha = $2`, [fciA, hab[8]])
  info('rendimiento del fondo antes/después', { antes: antes?.r, despues: desp?.r })
  check('un pago de "SUSCRIPCION REVISTA" (categoría PAGO) no queda como capital del fondo', cpt.find((x) => x.id === revista).c === null,
    'se le puso el FCI como contraparte (la condición f.clase = FCI y texto ~ SUSC|RESC no pide categoría FCI ni mira el signo; el Apps Script exigía CATEGORIA = FCI)')
  check('un "RESCISION" tampoco (RESC dentro de otra palabra)', cpt.find((x) => x.id === resc).c === null, 'RESC matchea "RESCISION"')
  check('el rendimiento del fondo no cambia por esos pagos', antes?.r === desp?.r, JSON.stringify({ antes: antes?.r, despues: desp?.r }))
  const flujo = await val(`select count(*)::int n from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 1, null, true) where origen_id = $1 and ocurrencia = 'CONTRAPARTE'`, [revista])
  check('...ni aparece una pata "contraparte" en el Flujo para ese pago', flujo.n === 0, 'aparece')
}
{
  // c) la pata propia llega después: doble conteo (la remunerada de Brubank sí trae movimientos en su extracto)
  await servidor()
  const tr = await mov(bru, hab[12], -2000, 'Transferencia a cuenta remunerada')
  await saldo(bruRem, hab[11], 5010); await saldo(bruRem, hab[12], 7013)
  await db.query(`select sincronizar_capital_fci('india')`)
  check('la transferencia a la remunerada recibe su fondo como contraparte', (await val(`select contraparte_cuenta_id c from movimientos_bancarios where id = $1`, [tr])).c === bruRem)
  const antes = await val(`select creditos::float c, rendimiento::float r from conciliacion_calculo(true) where cuenta_origen_id = $1 and fecha = $2`, [bruRem, hab[12]])
  // al otro día Tesorería sube el extracto de la remunerada, que trae el ingreso de esos 2000 (la pata propia)
  await importar(bruRem, 'rem-pata-propia', [{ fecha: hab[12], descripcion: 'Transferencia recibida de cuenta Brubank', importe: 2000, saldo: 7013 }], { saldos: [{ fecha: hab[12], saldo: 7013 }] })
  const desp = await val(`select creditos::float c, rendimiento::float r from conciliacion_calculo(true) where cuenta_origen_id = $1 and fecha = $2`, [bruRem, hab[12]])
  info('remunerada: créditos antes/después de subir su propio extracto', { antes, despues: desp })
  check('si la pata propia llega después de la sincronización, el ingreso no se cuenta dos veces en la remunerada', desp.c === antes.c, `créditos ${antes.c} → ${desp.c}: contraparte + movimiento propio (rendimiento ${antes.r} → ${desp.r}); nada limpia la contraparte cuando entra la pata propia (igual que conciliar_movimientos de 0032, pero ahora lo dispara un cron diario)`)
  const fl = await val(`select count(*)::int n from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 1, null, true) where cuenta_origen_id = $1 and fecha = $2 and importe = 2000`, [bruRem, hab[12]])
  check('...ni en el Flujo (un solo +2000 en la remunerada)', fl.n === 1, `${fl.n} líneas de +2000`)
}
{
  // d) varios fondos: solo se cuentan como dudosos (y se vuelven a contar todos los días)
  await servidor()
  const fciB = await cuenta('FCI ALPHA B', 'FCI', { madre: icbc })
  const dud = await mov(icbc, hab[9], -1234, 'SUSCRIPCION FCI', { categoria: 'FCI' })
  const r = (await val(`select sincronizar_capital_fci('india') r`)).r
  check('con dos fondos en la madre no asigna (los elige Tesorería) y lo cuenta como dudoso', r.asignados === 0 && r.dudosos >= 1 && (await val(`select contraparte_cuenta_id c from movimientos_bancarios where id = $1`, [dud])).c === null, JSON.stringify(r))
  info('dudosos de la 2ª corrida (se vuelven a avisar cada día mientras nadie elija)', (await val(`select sincronizar_capital_fci('india') r`)).r)
  await db.query(`update cuentas_origen set activa = false where id = $1`, [fciB])
}
{
  // e) aislamiento por empresa de la sincronización
  await servidor()
  // Decisión 27/11: el capital se reconoce por categoría FCI (como el Apps Script), no por el texto. Se simulan dos movimientos de categoría FCI
  // que quedaron sin fondo (por ejemplo, antes de crear el fondo).
  const mb = await mov(berMadre, hab[8], -777, 'SUSCRIPCION FONDO', { categoria: 'FCI' })
  const mi = await mov(icbc, hab[7], -888, 'SUSCRIPCION FONDO ALPHA 2', { categoria: 'FCI' })
  await db.query(`update movimientos_bancarios set contraparte_cuenta_id = null where id in ($1, $2)`, [mb, mi])
  await como('solober@prueba.com')
  const r = (await val(`select sincronizar_capital_fci(null) r`)).r
  await servidor()
  check('sincronizar_capital_fci(null) como persona de una sola empresa toca solo su empresa', (await val(`select contraparte_cuenta_id c from movimientos_bancarios where id = $1`, [mb])).c === berFondo && (await val(`select contraparte_cuenta_id c from movimientos_bancarios where id = $1`, [mi])).c === null, JSON.stringify(r))
}

// ================================================================ 5. Aviso fondo sin movimientos
{
  await servidor()
  await saldo(fciTor, hab[11], 1000000, 'TENENCIA'); await saldo(fciTor, hab[12], 1000300, 'TENENCIA'); await saldo(fciTor, hab[13], 1000600, 'TENENCIA')
  await mov(hipo, hab[12], -10, 'COMISION')
  await saldo(hipo, hab[13], 100, 'SIN_MOVIMIENTOS')
  await como('teso@prueba.com')
  const av = (await filas(`select fecha::text f from avisos_fci where cuenta_origen_id = $1 order by fecha`, [fciTor])).map((x) => x.f)
  check('aviso: sí el día sin nada de la madre; no con movimiento; no con "sin movimientos"', av.includes(hab[11]) && !av.includes(hab[12]) && !av.includes(hab[13]), JSON.stringify(av))
  await como('solober@prueba.com')
  check('avisos_fci no muestra otra empresa', (await val(`select count(*)::int n from avisos_fci where empresa_id = 'india'`)).n === 0)
  check('rendimientos_fci_dia y saldos_arrastrados no muestran otra empresa', (await val(`select count(*)::int n from rendimientos_fci_dia($1)`, [hab[12]])).n === 0 && (await val(`select count(*)::int n from saldos_arrastrados($1)`, [hab[0]])).n === 0)
  await servidor()
}

// ================================================================ 6. Arrastre de saldo
{
  await servidor()
  const ar = await cuenta('ARRASTRE A', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true })
  await importar(ar, 'ar-a', [], { saldos: [{ fecha: hab[0], saldo: 1000 }, { fecha: hab[4], saldo: 1100 }] })
  await mov(ar, hab[2], 5, 'MOV', { estado: 'PENDIENTE' })
  await como('teso@prueba.com')
  const a = await filas(`select fecha::text f, saldo::float s, arrastrado a from saldos_arrastrados($1, null, 'india') where cuenta_origen_id = $2 order by fecha`, [hab[0], ar])
  check('(a) entre dos saldos repite el anterior en los días sin movimientos y no en el que tiene movimientos', a.find((x) => x.f === hab[1])?.a === true && a.find((x) => x.f === hab[1])?.s === 1000 && !a.some((x) => x.f === hab[2]) && a.find((x) => x.f === hab[3])?.a === true, JSON.stringify(a))
  // (b) después del último saldo, hasta el día hábil anterior a hoy cuando el extracto se subió hoy
  await servidor()
  const ar2 = await cuenta('ARRASTRE B', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true })
  await importar(ar2, 'ar-b', [], { saldos: [{ fecha: hab[6], saldo: 2000 }] })
  const ext = await val(`select hasta::text h, (importado_en at time zone 'America/Argentina/Buenos_Aires')::date::text i from extractos where cuenta_origen_id = $1`, [ar2])
  await como('teso@prueba.com')
  const b = await filas(`select fecha::text f, arrastrado a from saldos_arrastrados($1, null, 'india') where cuenta_origen_id = $2 order by fecha`, [hab[0], ar2])
  info('(b) extracto de ARRASTRE B', { extracto: ext, filas: b.map((x) => x.f) })
  check('(b) después del último saldo repite hasta el día hábil anterior a hoy cuando el extracto se subió hoy (arrastrarSaldosPanel_: hasta min(hoy, fecha de subida))',
    b.some((x) => x.a && x.f > hab[6]), `devuelve ${b.length} fila(s), ninguna después del último saldo (${hab[6]}): cubierto_hasta usa extractos.hasta (último día con datos) y no la fecha en que se subió el extracto, así que la rama (b) casi nunca se activa`)
  check('nunca arrastra hoy ni días futuros', !b.some((x) => x.f >= hoy))
  await servidor()
  // un feriado no se arrastra
  await db.query(`insert into feriados (fecha, nombre) values ($1, 'Prueba') on conflict do nothing`, [hab[1]])
  await como('teso@prueba.com')
  check('un feriado no se arrastra', !(await filas(`select 1 from saldos_arrastrados($1, null, 'india') where cuenta_origen_id = $2 and fecha = $3`, [hab[0], ar, hab[1]])).length)
  await servidor()
  await db.query(`delete from feriados where fecha = $1`, [hab[1]])
}

// ================================================================ 7. Mercado Pago (TS)
let mp = null
try { mp = await import('../../netlify/functions/lib/mercadopago.ts') } catch (e) { console.log('INFO Mercado Pago: se saltea (correr con --import ./netlify/pruebas/resolver.mjs): ' + String(e.message).slice(0, 80)) }
if (mp) {
  await servidor()
  const CSV = (extra = []) => [
    'DATE,SOURCE_ID,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT,GROSS_AMOUNT,MP_FEE_AMOUNT,TAXES_AMOUNT,PAYMENT_METHOD',
    `${hab[5]}T00:00:00.000-03:00,,initial_available_balance,,1000.00,0.00,,,,`,
    `${hab[5]}T09:10:00.000-03:00,111,release,payment,500.00,0.00,520.00,15.00,5.00,master`,
    `${hab[5]}T10:00:00.000-03:00,222,release,reserve_for_payment,0.00,100.00,,,,`,
    `${hab[6]}T08:00:00.000-03:00,333,release,payout,0.00,1200.50,,,,`,
    `${hab[6]}T09:00:00.000-03:00,444,release,reserve_for_payment,100.00,0.00,,,,`,
    ...extra, ',,total,,0,0,,,,'].join('\n')
  const e = mp.armarExtractoMP(mp.leerInformeLiberaciones(CSV()))
  const mpCta = await cuenta('MERCADO PAGO', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'MP', rinde: true })
  const r1 = await importar(mpCta, 'mp-1', e.movimientos, { saldos: e.saldos, origen_saldos: 'EXTRACTO', archivo: { nombre: 'mp', hash: 'mp-1', formato: 'MERCADOPAGO_API' } })
  const est = await filas(`select estado, categoria, count(*)::int n from movimientos_bancarios where cuenta_origen_id = $1 group by 1, 2 order by 1`, [mpCta])
  info('estados de los movimientos de Mercado Pago importados', est)
  // Decisión 27/11: las reservas no entran al extracto (como el Apps Script: "se anulan entre sí"); la regla 85 queda solo por si entran a mano.
  check('las reservas no se cargan como movimientos (decisión 27/11, antes quedaban informativas)', !est.some((x) => x.estado === 'INFORMATIVO'))
  const resto = est.filter((x) => x.estado !== 'INFORMATIVO').reduce((s, x) => s + x.n, 0)
  check('los demás movimientos de Mercado Pago (ingresos, pagos, comisiones) quedan clasificados (el Apps Script los separaba en PROPIA / PAGO / GASTO)', est.filter((x) => x.estado === 'A_REVISAR').length === 0, `${resto} movimientos quedan A_REVISAR: no hay reglas para "MP ingreso …" ni "MP payout …"; cada día de Mercado Pago pide revisión manual`)
  const conc = await filas(`select fecha::text f, estado, diferencia::float d from conciliacion_calculo() where cuenta_origen_id = $1 order by fecha`, [mpCta])
  check('la conciliación de Mercado Pago cierra (las reservas están en los movimientos y en el saldo)', conc.every((x) => x.estado === 'OK' || x.estado === 'PRIMER_SALDO'), JSON.stringify(conc))
  // el Flujo y las reservas
  const fr = await filas(`select concepto, importe::float i from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 1, null, true) where cuenta_origen_id = $1 and concepto ilike 'MP reserva%'`, [mpCta])
  check('las reservas de Mercado Pago no mueven el Flujo (el Apps Script las salteaba: "se anulan entre sí")', fr.length === 0, `${fr.length} líneas REAL de reserva en el Flujo (${fr.map((x) => x.i).join(', ')}): un día sale plata y otro vuelve; INFORMATIVO no se excluye en flujo_lineas_entre`)
  // reimportar con el informe crecido: idempotencia
  const e2 = mp.armarExtractoMP(mp.leerInformeLiberaciones(CSV([`${hab[6]}T11:00:00.000-03:00,555,release,payment,50.00,0.00,52.00,1.5,0.5,visa`])))
  const r2 = await importar(mpCta, 'mp-2', e2.movimientos, { saldos: e2.saldos, origen_saldos: 'EXTRACTO', archivo: { nombre: 'mp', hash: 'mp-2', formato: 'MERCADOPAGO_API' } })
  check('el mismo informe con una fila más: solo entra la nueva (sin duplicar)', r2.nuevos === 1 && (await val(`select count(*)::int n from movimientos_bancarios where cuenta_origen_id = $1`, [mpCta])).n === r1.nuevos + 1, JSON.stringify(r2))
  const r3 = await importar(mpCta, 'mp-2', e2.movimientos, { saldos: e2.saldos, origen_saldos: 'EXTRACTO', archivo: { nombre: 'mp', hash: 'mp-2' } })
  check('el mismo archivo otra vez: repetido', r3.repetido === true)

  // ---- orquestación con un fetch y una base de mentira (la base es PGlite)
  const TOKEN = 'APP_USR-1234567890-SECRETO'
  const construir = () => {
    const consultas = []
    return {
      from(t) {
        const f = { t, cols: '*', filtros: [], ins: null }
        const b = {
          select(c) { f.cols = c; return b }, eq(c, v) { f.filtros.push([c, '=', v]); return b }, in(c, v) { f.filtros.push([c, 'in', v]); return b },
          insert(row) { f.ins = row; return b },
          then(res, rej) { return ejecutar(f).then(res, rej) },
        }
        return b
      },
      async rpc(fn, args) {
        try { await servidor(); const r = await val(`select ${fn}($1) r`, [args.p]); return { data: r.r, error: null } } catch (err) { return { data: null, error: { message: err.message } } }
      },
      consultas,
    }
  }
  const ejecutar = async (f) => {
    try {
      await servidor()
      if (f.ins) {
        const k = Object.keys(f.ins)
        await db.query(`insert into ${f.t} (${k.join(',')}) values (${k.map((_, i) => '$' + (i + 1)).join(',')})`, k.map((c) => (f.ins[c] !== null && typeof f.ins[c] === 'object' ? JSON.stringify(f.ins[c]) : f.ins[c])))
        return { data: null, error: null }
      }
      const w = f.filtros.map(([c, op], i) => (op === 'in' ? `${c} = any($${i + 1})` : `${c} = $${i + 1}`)).join(' and ')
      return { data: await filas(`select ${f.cols} from ${f.t} ${w ? 'where ' + w : ''}`, f.filtros.map((x) => x[2])), error: null }
    } catch (err) { return { data: null, error: { message: err.message } } }
  }
  const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
  const respuesta = (cuerpo, status = 200) => ({ ok: status < 400, status, json: async () => cuerpo, text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) })
  const csvDe = (dia, id, importe = 10) => ['DATE,SOURCE_ID,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT,PAYMENT_METHOD',
    `${dia}T00:00:00.000-03:00,,initial_available_balance,,1000.00,0.00,`, `${dia}T09:00:00.000-03:00,${id},release,payment,${importe}.00,0.00,visa`].join('\n')
  const consola = []
  const logOrig = console.log, errOrig = console.error
  const correr = async (fetchFalso, entorno = { MERCADOPAGO_TOKEN_INDIA: TOKEN }, max) => {
    const d = construir()
    console.log = (...a) => consola.push(a.join(' ')); console.error = (...a) => consola.push(a.join(' '))
    try { return await mp.leerMercadoPago(d, { organizacionId: org, entorno, fetch: fetchFalso, maximoInformes: max }) } finally { console.log = logOrig; console.error = errOrig }
  }
  const pedidos = []
  const apiFalsa = (informes, textos, fallaLista = false) => async (url, init) => {
    pedidos.push({ url, metodo: init?.method, auth: init?.headers?.Authorization })
    if (url.endsWith('/release_report/list')) return fallaLista ? respuesta('{"message":"boom"}', 500) : respuesta(informes)
    const f = url.split('/release_report/')[1]
    if (f && textos[f] !== undefined) return respuesta(textos[f])
    if (url.endsWith('/users/me')) return respuesta({ id: 1 })
    if (url.includes('/balance')) return respuesta({ available_balance: 123.45 })
    return respuesta('no', 404)
  }
  // token en los logs
  pedidos.length = 0
  const rErr = await correr(apiFalsa([], {}, true))
  const logs = (await filas(`select detalle from procesos_log`)).map((x) => x.detalle).join('\n') + '\n' + consola.join('\n') + '\n' + rErr.lineas.join('\n')
  check('el token nunca aparece en las líneas, el log ni procesos_log (cuando falla la API)', !logs.includes(TOKEN) && !logs.includes('Bearer'), logs.slice(0, 200))
  check('solo hace GET', pedidos.every((p) => p.metodo === 'GET'))
  // ventana de 5 informes
  const lista = Array.from({ length: 8 }, (_, i) => ({ file_name: `rep-${i + 1}.csv`, begin_date: hab[i], end_date: hab[i], status: 'processed' }))
  const textos = Object.fromEntries(lista.map((x, i) => [x.file_name, csvDe(hab[i], 9000 + i)]))
  pedidos.length = 0
  const r8 = await correr(apiFalsa(lista, textos))
  const bajados = pedidos.filter((p) => p.url.includes('/release_report/rep-')).map((p) => p.url.split('/').pop())
  info('con 8 informes sin importar, baja', bajados)
  check('si hay más de 5 informes sin importar (función caída una semana, primera corrida) se importan todos', bajados.length === 8 && r8.importados === 8, `baja ${bajados.length}: los más viejos nunca se importan (slice(-5)) y quedan huecos de saldo y movimientos`)
  // un informe roto en la ventana frena a los demás
  const lista2 = [{ file_name: 'roto.csv', end_date: hab[10], status: 'processed' }, { file_name: 'bueno.csv', end_date: hab[11], status: 'processed' }]
  const r2m = await correr(apiFalsa(lista2, { 'roto.csv': 'DATE,RECORD_TYPE,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT\nayer,release,1,0', 'bueno.csv': csvDe(hab[11], 777) }))
  info('informe roto + informe bueno', r2m)
  check('un informe que no se puede leer no impide importar los siguientes', r2m.importados === 1, `importados ${r2m.importados}: el catch está fuera del for, el roto (el más viejo) aborta toda la empresa; los nuevos esperan hasta que el roto salga de la ventana de 5`)
  // paginación de la lista
  const pagina = (await filas(`select 1`)) && pedidos.some((p) => /offset|limit|page/.test(p.url))
  info('la lista de informes se pide con paginación/offset', pagina)
  check('el token general solo se usa con una cuenta de Mercado Pago (control)', mp.tokenDeMercadoPago('india', 2, { MERCADOPAGO_TOKEN: 'x' }) === null)
  check('importes con coma de miles sin decimales ("1,234") se leen como 1234', mp.numeroMP('1,234') === 1234, `da ${mp.numeroMP('1,234')}`)
}

console.log(`\nResumen: ${ok} OK · ${bug} BUG`)
await db.close()
