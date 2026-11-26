// Pruebas de 0033: lo que escribe el servidor (copia de la hoja) no concilia fila por fila; se concilia una vez al
// final. Lo que hace una persona sigue conciliando al momento. Datos ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_0033.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]

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
check('migraciones aplican (con 0033)', true)

const c = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase) values ('india', 'PRUEBA CC 9999', 'PRUEBA', 'CC') returning id`)).id
await db.query(`insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
  values ('india', $1, '2026-11-05', 'TRANSF', -1234, 'P-1', 'SIN_CLASIFICAR', 'INFORMATIVO'), ('india', $1, '2026-11-06', 'TRANSF', -555, 'P-2', 'SIN_CLASIFICAR', 'INFORMATIVO')`, [c])
const vinculado = async (h) => (await val(`select pago_id from movimientos_bancarios where huella = $1`, [h])).pago_id

// Como la copia de la hoja: rol service_role.
await db.exec(`set role service_role`)
const p1 = (await val(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, cuenta_origen_id) values ('india', '2026-11-05', 1234, 'TRANSFERENCIA', 'hoja', $1) returning id`, [c])).id
check('pago escrito por el servidor: no concilia en el momento', (await vinculado('P-1')) === null)
await db.query(`select conciliar_movimientos('india')`)
check('… y se vincula cuando el servidor concilia al final del lote', (await vinculado('P-1')) === p1)
await db.exec(`reset role`)

// Como una persona o una migración (sin service_role): concilia en el momento, como antes.
const p2 = (await val(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, cuenta_origen_id) values ('india', '2026-11-06', 555, 'TRANSFERENCIA', 'persona', $1) returning id`, [c])).id
check('pago cargado fuera del servidor: concilia en el momento', (await vinculado('P-2')) === p2)

// Si la conciliación falla, el pago se guarda igual.
await db.exec(`alter function conciliar_movimientos(text) rename to conciliar_movimientos_ok;
  create function conciliar_movimientos(text) returns jsonb language plpgsql as $$ begin raise exception 'falla de prueba'; end $$;`)
let guardado = true
try { await db.query(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por) values ('india', '2026-11-07', 10, 'TRANSFERENCIA', 'persona')`) } catch { guardado = false }
check('si la conciliación falla, el pago se guarda igual', guardado && (await val(`select count(*)::int n from pagos where importe = 10`)).n === 1)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
