// Pruebas de 0032 (T-209): débitos en lote (1 débito ↔ N pagos, N débitos ↔ 1 pago), ambigüedad que queda para
// revisar, desempate fijo y motivo de los pagos sin débito. Bancos, importes y proveedores ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_0032.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows

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
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (con 0032)', true)

// ---------------------------------------------------------------- Datos ficticios
const dax = (await val(`select id from unidades where empresa_id = 'beratung' and codigo = 'dax-salud'`)).id
const ber = (await val(`select id from unidades where empresa_id = 'beratung' and codigo = 'beratung'`)).id
const cuenta = async (nombre, banco, clase, unidad, extra = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, patrones, cuenta_madre_id) values ('beratung', $1, $2, $3, $4, $5, $6) returning id`,
  [nombre, banco, clase, unidad, extra.patrones ?? [], extra.madre ?? null])).id
const hipA = await cuenta('PRUEBA HIPOTECARIO CC 1111', 'HIPOTECARIO', 'CC', dax, { patrones: ['BANCO PRUEBA HIPOTECARIO CC 1111 BERATUNG'] })
const hipB = await cuenta('PRUEBA HIPOTECARIO CA 2222', 'HIPOTECARIO', 'CA', dax)
const icbc = await cuenta('PRUEBA ICBC CC 3333', 'ICBC', 'CC', ber)
const fci = await cuenta('PRUEBA FCI ICBC', 'ICBC', 'FCI', ber, { madre: icbc })
let n = 0
const mov = async (c, fecha, importe, extra = {}) => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, numero_cheque)
   values ('beratung', $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
  [c, fecha, extra.desc ?? 'MOVIMIENTO DE PRUEBA', importe, `PRUEBA-${n++}`, extra.categoria ?? 'SIN_CLASIFICAR', extra.estado ?? 'INFORMATIVO', extra.cheque ?? null])).id
const saldo = (c, fecha, s, origen = 'EXTRACTO') => db.query(
  `insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, 'beratung', $3, $4, 'prueba')
   on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, origen = excluded.origen`, [c, fecha, s, origen])
const pago = async (importe, fecha, extra = {}) => (await val(
  `insert into pagos (empresa_id, fecha, importe, medio, cargado_por, cuenta_origen, banco_origen, numero_cuenta, proveedor_destino, estado)
   values ('beratung', $1, $2, $3, 'prueba', $4, $5, $6, $7, 'CARGADO') returning id, cuenta_origen_id`,
  [fecha, importe, extra.medio ?? 'TRANSFERENCIA', extra.cuenta ?? null, extra.banco ?? null, extra.numero ?? null, extra.proveedor ?? 'Proveedor Prueba SRL']))
const linea = async (tipo, id) => val(`select l.fecha::text, l.importe::text, u.codigo as unidad, l.fila, l.afecta_bancos
  from flujo_lineas l join unidades u on u.id = l.unidad_id where l.origen_tipo = $1 and l.origen_id = $2 and l.naturaleza = 'REAL'`, [tipo, id])

// ---------------------------------------------------------------- Búsqueda de subconjunto
const sub = async (imps, obj) => (await val(`select subconjunto_unico($1::bigint[], $2::bigint) r`, [imps, obj])).r
check('subconjunto único: 100 + 250 = 350 entre [100, 250, 400]', JSON.stringify((await sub([100, 250, 400], 350)).indices) === '[1,2]')
check('dos combinaciones distintas (100+250 y 350 sola no cuenta; 100+250 y 150+200): AMBIGUO', (await sub([100, 250, 150, 200], 350)).estado === 'AMBIGUO')
check('importes iguales son intercambiables: [80, 80, 70] → 150 es UNO solo y toma el primer 80', JSON.stringify(await sub([80, 80, 70], 150)) === JSON.stringify({ estado: 'UNICO', indices: [1, 3], combinaciones: 1 }))
check('ninguna suma da: NINGUNO', (await sub([100, 200], 50)).estado === 'NINGUNO')
check('más de 14 candidatos: DEMASIADOS (no se busca)', (await sub(Array.from({ length: 15 }, (_, i) => i + 1), 3)).estado === 'DEMASIADOS')
check('un solo elemento no es lote (mínimo 2)', (await sub([350, 1], 350)).estado === 'NINGUNO')

await db.query(`update cuentas_origen set requiere_extracto = (id = $1) where unidad_id = $2`, [hipA, dax])
await saldo(hipA, '2026-11-03', 10000)

// ---------------------------------------------------------------- 1 débito ↔ N pagos
const pa = (await pago(1200, '2026-11-04', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Prestador Uno' })).id
const pb = (await pago(800, '2026-11-04', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Prestador Dos' })).id
const pc = (await pago(500, '2026-11-04', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Prestador Tres' })).id
const pOtro = (await pago(333, '2026-11-04', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Otro' })).id
const mLote = await mov(hipA, '2026-11-05', -2500, { desc: 'N/D - DB SUELDOS LOTE' })
const lote = await filas(`select pago_id from movimientos_pagos where movimiento_id = $1 order by pago_id`, [mLote])
check('un débito de 2.500 se vincula en lote a los 3 pagos que suman exacto (1.200 + 800 + 500)',
  lote.length === 3 && [pa, pb, pc].every((x) => lote.some((l) => l.pago_id === x)), JSON.stringify(lote))
check('el pago de 333 queda afuera', !lote.some((l) => l.pago_id === pOtro))
check('el débito en lote no entra al Flujo', !(await linea('MOVIMIENTO', mLote)))
const la = await linea('PAGO', pa)
check('cada pago del lote entra el día del débito y en la unidad de la cuenta', la?.fecha === '2026-11-05' && la?.unidad === 'dax-salud', JSON.stringify(la))
await saldo(hipA, '2026-11-05', 7500)
check('control del día: banco −2.500 = pagos del lote −2.500 → Ok', (await val(`select estado from flujo_control where unidad_id = $1 and fecha = '2026-11-05'`, [dax]))?.estado === 'OK')
check('los pagos del lote no están en pagos_sin_debito', (await val(`select count(*)::int n from pagos_sin_debito where id = any($1::uuid[])`, [[pa, pb, pc]])).n === 0)
await db.query(`update pagos set estado = 'ANULADO' where id = $1`, [pb])
check('anular un pago del lote suelta todo el lote (el débito vuelve a contar solo)',
  (await val(`select count(*)::int n from movimientos_pagos where movimiento_id = $1`, [mLote])).n === 0 && (await linea('MOVIMIENTO', mLote))?.importe === '-2500.00')

// ---------------------------------------------------------------- Ambigüedad → revisar
await pago(600, '2026-11-10', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'A' })
await pago(400, '2026-11-10', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'B' })
await pago(700, '2026-11-10', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'C' })
await pago(300, '2026-11-10', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'D' })
const mAmb = await mov(hipA, '2026-11-10', -1000, { desc: 'N/D - LOTE AMBIGUO' })
check('dos combinaciones (600+400 y 700+300): no vincula nada', (await val(`select count(*)::int n from movimientos_pagos where movimiento_id = $1`, [mAmb])).n === 0)
const rev = await val(`select tipo, motivo from conciliacion_revisar where movimiento_id = $1`, [mAmb])
check('… y queda en conciliacion_revisar (DEBITO_LOTE, VARIAS_COMBINACIONES)', rev?.tipo === 'DEBITO_LOTE' && rev?.motivo === 'VARIAS_COMBINACIONES', JSON.stringify(rev))

// ---------------------------------------------------------------- Un pago con débito propio no entra en un lote
const pMal = (await pago(900, '2026-11-17', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Mal Fechado' })).id
await pago(100, '2026-11-17', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'E' })
await mov(hipA, '2026-11-02', -900, { desc: 'TRANSF (el débito propio, 15 días antes)' })
const mCoin = await mov(hipA, '2026-11-17', -1000, { desc: 'N/D - SUELDOS' })
check('900 + 100 suma 1.000, pero el de 900 tiene su débito exacto (mal fechado): no se arma el lote',
  (await val(`select count(*)::int n from movimientos_pagos where movimiento_id = $1`, [mCoin])).n === 0)
await mov(hipA, '2026-11-25', -1, { desc: 'COMISION' })
check('ese pago figura en pagos_sin_debito como CUENTA_O_FECHA', (await val(`select motivo from pagos_sin_debito where id = $1`, [pMal]))?.motivo === 'CUENTA_O_FECHA')

// ---------------------------------------------------------------- N débitos ↔ 1 pago
const pGrande = (await pago(5000, '2026-11-12', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Pago Partido' })).id
const d1 = await mov(hipA, '2026-11-12', -3000, { desc: 'TRANSF PARTE 1' })
const d2 = await mov(hipA, '2026-11-12', -2000, { desc: 'TRANSF PARTE 2' })
check('un pago de 5.000 que el banco debitó en 3.000 + 2.000 el mismo día: los dos débitos apuntan al pago',
  (await val(`select count(*)::int n from movimientos_bancarios where id in ($1, $2) and pago_id = $3`, [d1, d2, pGrande])).n === 2)
check('… el pago cuenta una vez (−5.000) y los débitos no', (await linea('PAGO', pGrande))?.importe === '-5000.00' && !(await linea('MOVIMIENTO', d1)))

// ---------------------------------------------------------------- Desempate fijo (1 a 1)
const pg1 = (await pago(4321, '2026-11-18', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Igual' })).id
const pg2 = (await pago(4321, '2026-11-18', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Igual' })).id
const mIg = await mov(hipA, '2026-11-18', -4321, { desc: 'TRANSF IGUAL' })
const menor = [pg1, pg2].sort()[0]
check('dos pagos iguales el mismo día y un débito: gana el de id menor (reproducible)',
  (await val(`select pago_id from movimientos_bancarios where id = $1`, [mIg])).pago_id === menor)
check('el otro queda como POSIBLE_DUPLICADO en pagos_sin_debito',
  (await val(`select motivo from pagos_sin_debito where id = $1`, [[pg1, pg2].sort()[1]]))?.motivo === 'POSIBLE_DUPLICADO')

// ---------------------------------------------------------------- Sin explicación
const pNada = (await pago(77777, '2026-11-06', { banco: 'Banco Hipotecario', numero: '1111', proveedor: 'Nadie' })).id
check('un pago sin nada parecido en el banco: SIN_EXPLICACION', (await val(`select motivo from pagos_sin_debito where id = $1`, [pNada]))?.motivo === 'SIN_EXPLICACION')

// ---------------------------------------------------------------- Seguridad
await db.exec(`set role authenticated`)
let negado = false
try { await db.query(`select conciliar_lotes('beratung')`) } catch { negado = true }
check('conciliar_lotes no la puede llamar un usuario (solo el servidor)', negado)
await db.exec(`reset role`)

console.log(`\n${ok} OK · ${mal} MAL`)
if (mal) process.exit(1)
