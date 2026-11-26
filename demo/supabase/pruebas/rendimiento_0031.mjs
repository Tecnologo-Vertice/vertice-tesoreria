// Prueba de rendimiento de Tesorería (T-208, hallazgo 3 de la revisión). NO corre en npm test: tarda.
//
// Arma el "año sintético" del revisor en PGlite: 10 cuentas × 250 días × 30 movimientos = 75.000 movimientos
// y 2.500 saldos (datos ficticios), terminando hoy, y mide las consultas que hacen la pantalla (Bancos y Flujo)
// y el mail del control diario. Meta: cada consulta de pantalla en menos de 2 s.
//
// Uso (desde demo/):
//   node supabase/pruebas/rendimiento_0031.mjs supabase/migrations            mide y exige la meta (sale con 1 si no)
//   node supabase/pruebas/rendimiento_0031.mjs <carpeta de migraciones> --antes   mide una base anterior a 0031
//                                                                              (consultas recortadas: tardan minutos)
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const ANTES = process.argv.includes('--antes')
const META_MS = 2000
const N_CTAS = 10, DIAS = 250, MOVS = 30

const db = new PGlite()
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const servidor = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const como = async (email) => {
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  await db.exec(`set role authenticated`)
}

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
`)
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''))
}

// ---------------------------------------------------------------- El año sintético (ficticio)
await db.exec(`
insert into usuarios (email, nombre, rol, todas_empresas) values ('teso@prueba.com', 'Teso', 'TESORERIA', true);
update cuentas_origen set requiere_extracto = false;
insert into cuentas_origen (empresa_id, nombre, banco, clase) select 'india', 'CTA '||g, 'BANCO PRUEBA', 'CC' from generate_series(1,${N_CTAS}) g;
alter table movimientos_bancarios disable trigger user;
insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, cuenta_contable)
select 'india', c.id, current_date - ${DIAS - 1} + d, 'MOV '||m, ((m % 7) - 3) * 100.0, md5(c.id::text||d||'-'||m),
  (array['IMPUESTO','GASTO_BANCARIO','SIN_CLASIFICAR','FCI'])[1 + m % 4], 'PENDIENTE', 'X'
from cuentas_origen c, generate_series(0, ${DIAS}-1) d, generate_series(1, ${MOVS}) m where c.nombre like 'CTA %';
alter table movimientos_bancarios enable trigger user;
alter table saldos_bancarios disable trigger user;
insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
select c.id, current_date - ${DIAS - 1} + d, 'india', 1000, 'EXTRACTO', 's' from cuentas_origen c, generate_series(0, ${DIAS}-1) d where c.nombre like 'CTA %';
alter table saldos_bancarios enable trigger user;
-- Algunas reglas del Flujo y filas de cuenta, para que el destino de cada línea trabaje como en la base real.
insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable)
select u.id, 'india', 300 + g, 'CUENTA', 'GASTOS_OPERATIVOS', 'Cuenta de prueba ' || g, case when g = 1 then 'X' else 'CUENTA ' || g end
from unidades u, generate_series(1, 40) g where u.empresa_id = 'india' and u.por_defecto;
insert into flujo_reglas (empresa_id, prioridad, si_origen, si_texto, fila_id, nota)
select 'india', 100 + g, 'MOVIMIENTO', 'TEXTO QUE NO APARECE ' || g, f.id, 'regla de prueba'
from generate_series(1, 60) g, flujo_filas f join unidades u on u.id = f.unidad_id
where u.empresa_id = 'india' and f.etiqueta = 'Cuenta de prueba 2';
analyze;
`)
const { n: nMov } = await val(`select count(*)::int n from movimientos_bancarios`)
console.log(`Año sintético: ${nMov} movimientos, ${(await val(`select count(*)::int n from saldos_bancarios`)).n} saldos, 60 reglas del Flujo${ANTES ? ' · base anterior a 0031 (consultas recortadas)' : ''}`)

const resultados = []
const medir = async (nombre, sql, { pantalla = false, nota = '' } = {}) => {
  const t0 = performance.now()
  const r = await val(sql)
  const ms = Math.round(performance.now() - t0)
  resultados.push({ nombre, ms, pantalla, nota })
  console.log(`${String(ms).padStart(7)} ms  ${pantalla ? '[pantalla] ' : ''}${nombre}${nota ? ' · ' + nota : ''} → ${JSON.stringify(r)}`)
  return ms
}
const D = `current_date - 45`, H = `current_date + 200`

// La pantalla lee como una persona (con las reglas de lectura por empresa).
await como('teso@prueba.com')
await medir('Bancos: conciliación de los últimos 45 días', `select count(*)::int filas, sum(saldo_calculado) s from conciliacion_bancaria where fecha >= ${D}`, { pantalla: true })
await medir('Bancos: movimientos, primera página de 1000', `select count(*)::int filas from (select * from movimientos_bancarios where fecha >= ${D} order by fecha desc, id limit 1000) x`, { pantalla: true })
if (ANTES) {
  const ms = await medir('Flujo: UNA página de 1000 líneas de flujo_lineas (−45 a +200 días)',
    `select count(*)::int filas from (select * from flujo_lineas where fecha >= ${D} and fecha <= ${H} order by fecha, origen_tipo, origen_id, ocurrencia limit 1000) x`, { pantalla: true })
  const pag = Math.ceil((N_CTAS * MOVS * 46) / 1000)
  console.log(`          la pantalla pedía ${pag} páginas y cada una recalculaba la vista: ~${Math.round((ms * pag) / 1000)} s en total`)
  const m1 = await medir('Flujo: control contra bancos, UN día', `select count(*)::int filas, min(estado) e from flujo_control where fecha = current_date`, { pantalla: true })
  console.log(`          la pantalla pedía 46 días (~${Math.round((m1 * 46) / 60000)} min) y el mail del control, 8 (~${Math.round((m1 * 8) / 1000)} s)`)
} else {
  await medir('Flujo: flujo_rango(todas las unidades, −45 a +200 días), una sola llamada',
    `select jsonb_array_length(flujo_rango(null, ${D}, ${H})) lineas`, { pantalla: true })
  await medir('Flujo: flujo_rango de una unidad', `select jsonb_array_length(flujo_rango(unidad_por_defecto('india'), ${D}, ${H})) lineas`, { pantalla: true })
  await medir('Flujo: flujo_control_rango (control contra bancos de los últimos 45 días), una sola llamada', `select jsonb_array_length(flujo_control_rango(${D})) dias`, { pantalla: true })
  await servidor()
  await medir('Mail del control diario: control_bancos completo', `select count(*)::int hallazgos from control_bancos`, { pantalla: true })
  await medir('Conciliación de todo el año', `select count(*)::int filas, sum(saldo_calculado) s from conciliacion_bancaria`)
  await medir('Control del Flujo de todo el año', `select count(*)::int filas from flujo_control`)
  await medir('flujo_lineas de todo el año (vista entera; la pantalla no la pide así)', `select count(*)::int filas from flujo_lineas`)
}

const pantalla = resultados.filter((r) => r.pantalla)
const peor = Math.max(...pantalla.map((r) => r.ms))
console.log(`\nPeor consulta de pantalla: ${peor} ms (meta: < ${META_MS} ms)`)
if (!ANTES && peor >= META_MS) { console.log('MAL: no se cumple la meta de rendimiento'); process.exit(1) }
if (!ANTES) console.log('OK: todas las consultas de pantalla por debajo de la meta')
