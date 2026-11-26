#!/usr/bin/env node
// Carga en la base nueva lo que hoy vive en planillas (Tesorería sin planillas, migraciones 0023 a 0028).
//
// Por defecto corre EN SECO: lee las planillas (solo lectura), arma el plan, lo carga en una base PGlite en
// memoria con las migraciones del repo, lo vuelve a cargar para probar que no duplica, y escribe el reporte.
// No toca ninguna base real.
//
// Uso (desde demo/):
//   node scripts/migrar-desde-planillas/migrar.mjs                       en seco, leyendo de Google
//   node scripts/migrar-desde-planillas/migrar.mjs --instantaneas DIR    en seco, leyendo instantáneas guardadas
//   node scripts/migrar-desde-planillas/migrar.mjs --escribir --confirmo escribe en la base (SUPABASE_DB_URL)
// Opciones: --reporte ARCHIVO.md (fuera del repo; por defecto en la carpeta temporal) · --desde AAAA-MM-DD (movimientos y saldos; 2026-11-02) · --hoy AAAA-MM-DD
//           --guardar-instantaneas DIR (fuera del repo: tienen datos reales) · --migraciones DIR
//
// Variables de entorno (las pone Santiago; nada de esto va al repo):
//   PLANILLA_VBI, PLANILLA_MOTOR, PLANILLA_FLUJO_ORIGINAL, PLANILLA_CASHFLOW   IDs de las planillas
//   GOOGLE_ACCESS_TOKEN o GOOGLE_APPLICATION_CREDENTIALS                      lectura de Sheets (solo lectura)
//   SUPABASE_DB_URL                                                           solo con --escribir (conexión Postgres;
//                                                                             el script toma el rol service_role)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { idsDePlanillas, leerPlanillas } from './fuente.mjs'
import { transformar } from './transformar.mjs'
import { cargar, verificar } from './cargar.mjs'
import { armarReporte } from './reporte.mjs'
import { finDeMes, sumarMeses } from './leer.mjs'

const aqui = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(aqui, '../../..')

export function opciones(argv = process.argv.slice(2)) {
  const o = { escribir: false, confirmo: false, desde: '2026-11-02' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], sig = () => argv[++i]
    if (a === '--en-seco') o.escribir = false
    else if (a === '--escribir') o.escribir = true
    else if (a === '--confirmo') o.confirmo = true
    else if (a === '--instantaneas') o.instantaneas = sig()
    else if (a === '--guardar-instantaneas') o.guardar = sig()
    else if (a === '--reporte') o.reporte = sig()
    else if (a === '--desde') o.desde = sig()
    else if (a === '--hoy') o.hoy = sig()
    else if (a === '--migraciones') o.migraciones = sig()
    else throw new Error(`Opción desconocida: ${a}`)
  }
  o.hoy ??= new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date())
  const [a, m] = o.hoy.split('-').map(Number)
  const [ha, hm] = sumarMeses(a, m, 6)
  o.horizonte = finDeMes(ha, hm)
  o.migraciones ??= join(aqui, '../../supabase/migrations')
  o.reporte ??= join(tmpdir(), 'reporte-migracion-en-seco.md')
  return o
}

/** Base PGlite en memoria con las migraciones del repo (el mismo arnés que supabase/pruebas). */
export async function basePrueba(dir) {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
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
    -- Como en Supabase: service_role tiene permisos propios (no por "public") sobre todo lo que se crea en public.
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant all on sequences to service_role;
    alter default privileges in schema public grant execute on functions to service_role;
  `)
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (f.startsWith('0021')) await db.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant all on sequences to anon, authenticated;
      alter default privileges in schema public grant execute on functions to anon, authenticated;`)
    await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''))
  }
  // Igual que el servidor en producción: rol service_role (pasa por los triggers de aislamiento como servidor).
  await db.exec(`set role service_role`)
  return db
}

/** Cómo queda la base después de cargar: conciliación, control del Flujo y líneas del Flujo por empresa. */
export async function chequeosBase(db) {
  const q = async (sql) => (await db.query(sql)).rows
  return {
    'Conciliación bancaria por estado (vista conciliacion_bancaria)': await q(`select estado, count(*)::int as dias_cuenta from conciliacion_bancaria group by 1 order by 1`),
    'Control del Flujo contra bancos por unidad (vista flujo_control)': await q(`select unidad, estado, count(*)::int as dias from flujo_control group by 1, 2 order by 1, 2`),
    'Líneas del Flujo por empresa (vista flujo_lineas)': await q(`select empresa_id as empresa, naturaleza, origen_tipo, count(*)::int as lineas,
      to_char(sum(importe), 'FM999G999G999G990D00') as suma from flujo_lineas group by 1, 2, 3 order by 1, 2, 3`),
    'Proyectado que cae en "Sin clasificar"': await q(`select empresa_id as empresa, count(*)::int as lineas, to_char(sum(importe), 'FM999G999G999G990D00') as suma
      from flujo_lineas where naturaleza = 'PROYECTADO' and seccion = 'SIN_CLASIFICAR' group by 1 order by 1`),
  }
}

async function main() {
  const op = opciones()
  if (resolve(op.reporte).startsWith(REPO + '/')) throw new Error('El reporte tiene datos reales (montos y nombres): no se guarda dentro del repo')
  const { ids, faltan } = idsDePlanillas()
  if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`)
  const origen = op.instantaneas ? `instantáneas leídas de las planillas (${Object.keys(ids).length} planillas)` : 'API de Google Sheets (solo lectura)'
  console.log(`Leyendo planillas (${op.instantaneas ? 'instantáneas' : 'Google'})…`)
  const planillas = await leerPlanillas(ids, op.instantaneas ? { instantaneas: op.instantaneas } : { google: true }, { guardarEn: op.guardar, repo: REPO })
  const { plan, control } = transformar(planillas, op)
  console.log('Plan armado:', Object.entries(plan).map(([k, v]) => `${k} ${v.length}`).join(' · '))

  let db, carga1, carga2, verificado, chequeos
  if (!op.escribir) {
    db = await basePrueba(op.migraciones)
    carga1 = await cargar(db, plan)
    carga2 = await cargar(db, plan)
    verificado = await verificar(db, plan)
    chequeos = await chequeosBase(db)
  } else {
    if (!op.confirmo) throw new Error('Para escribir en la base hace falta --confirmo (y haber revisado el reporte en seco)')
    if (!process.env.SUPABASE_DB_URL) throw new Error('Falta SUPABASE_DB_URL')
    const pg = await import('pg').catch(() => { throw new Error('Para escribir hace falta el paquete "pg" (npm i -D pg)') })
    const cliente = new (pg.default ?? pg).Client({ connectionString: process.env.SUPABASE_DB_URL })
    await cliente.connect()
    try {
      await cliente.query('set role service_role')
      db = cliente
      carga1 = await cargar(db, plan)
      verificado = await verificar(db, plan)
    } finally { await cliente.end() }
  }
  const { texto, cierra, verifOk, idem } = armarReporte({ control, carga1, carga2, verificado, chequeos, op, origen, generado: new Date().toISOString() })
  writeFileSync(op.reporte, op.escribir ? texto.replace('· corrida en seco', '· CARGA REAL') : texto)
  console.log(`Reporte: ${op.reporte} · control ${cierra ? 'cierra' : 'NO CIERRA'} · base ${verifOk ? 'OK' : 'DISTINTA'}${idem === null ? '' : ` · idempotente ${idem ? 'sí' : 'NO'}`}`)
  if (!cierra || !verifOk || idem === false) process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
