// Pruebas de 0028: pagos sin factura (ESPERA_FC) que se descuentan de lo proyectado del mismo proveedor y la
// misma empresa, de la factura más vieja a la más nueva (como gas/FlujoCaja.gs fxDescontarAnticipos_).
// Importes y proveedores ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_espera_fc.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
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
`)
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (con 0028)', true)

// ---------------------------------------------------------------- Datos de prueba (ficticios)
await servidor()
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
`)
const prov = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre) values ($1, $2) returning id`, [cuit, nombre])).id
const pA = await prov('30700000001', 'Proveedor Anticipo SA')
const pB = await prov('30700000002', 'Otro Proveedor SRL')
const hoy = (await val(`select current_date d`)).d
const dia = (n) => new Date(hoy.getTime() + n * 86400000).toISOString().slice(0, 10)
let nro = 100
const factura = async (empresa, proveedor, total, vence, extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, anticipo_pct, cuenta_contable)
   values ($1, $2, 'Factura A', 'A', 1, $3, $4, $5, $6, $6, 'PARA_PAGAR', $7, $8, 'PROVEEDORES LOCALES') returning id`,
  [empresa, proveedor, nro++, extra.fecha ?? dia(-10), vence, total, extra.pagado ?? 0, extra.anticipo_pct ?? null])).id
const pago = async (empresa, proveedor, importe, extra = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, factura_asociada, estado, estado_xubio_pago)
   values ($1, $2, $3, $4, 'TRANSFERENCIA', 'teso@prueba.com', $5, $6, $7, $8, 'SUBIDO') returning id`,
  [empresa, proveedor, extra.fecha ?? dia(-3), importe, extra.tipo_pago ?? 'SIN_FACTURA', extra.forma ?? 'SALIDA_FONDOS',
   extra.factura_asociada ?? null, extra.estado ?? 'CARGADO'])).id
const proyectado = async (facturaId) => filas(
  `select ocurrencia, importe::numeric::text as importe, concepto from flujo_lineas where origen_tipo = 'FACTURA' and origen_id = $1 order by ocurrencia`, [facturaId])
const total = async (facturaId) => (await val(`select coalesce(sum(importe), 0)::numeric::text t from flujo_lineas where origen_tipo = 'FACTURA' and origen_id = $1`, [facturaId])).t

// ---------------------------------------------------------------- Caso base: de la más vieja a la más nueva
// India · Proveedor A: facturas de 100 (vence en 5 días) y 500 (vence en 20). Anticipo sin factura de 300.
const fVieja = await factura('india', pA, 100, dia(5))
const fNueva = await factura('india', pA, 500, dia(20))
check('sin anticipos: se proyectan enteras (−100 y −500)', (await total(fVieja)) === '-100.00' && (await total(fNueva)) === '-500.00')
const ant = await pago('india', pA, 300)
check('anticipo de 300: la factura vieja (100) desaparece del Flujo', (await proyectado(fVieja)).length === 0)
check('… y de la nueva quedan −300 (500 − 200 que sobraron)', (await total(fNueva)) === '-300.00', await total(fNueva))
check('… con la nota "menos pago sin factura $200.00"', (await proyectado(fNueva))[0].concepto.includes('menos pago sin factura $200.00'))
check('el pago sin factura sigue en el Flujo como REAL (−300)',
  (await val(`select importe::numeric::text i from flujo_lineas where origen_tipo = 'PAGO' and origen_id = $1`, [ant])).i === '-300.00')
check('vista anticipos_sin_factura: 1 pago por 300', JSON.stringify(await val(`select pagos, importe::text from anticipos_sin_factura where empresa_id = 'india' and proveedor_id = $1`, [pA])) === JSON.stringify({ pagos: 1, importe: '300.00' }))

// El orden es por fecha de pago proyectada, no por orden de carga: una factura cargada después que vence antes va primero.
const fAntes = await factura('india', pA, 50, dia(2))
check('una factura que vence antes (50) se descuenta primero', (await proyectado(fAntes)).length === 0)
check('… 300 − 50 = 250: cubre la de 100 y sobran 150 para la de 500 → −350',
  (await proyectado(fVieja)).length === 0 && (await total(fNueva)) === '-350.00', await total(fNueva))

// ---------------------------------------------------------------- Lo que NO es anticipo
check('otro proveedor: su factura no se toca', await (async () => { const f = await factura('india', pB, 200, dia(5)); return (await total(f)) === '-200.00' })())
const fBer = await factura('beratung', pA, 200, dia(5))
check('otra empresa (mismo proveedor): no se descuenta el anticipo de India', (await total(fBer)) === '-200.00')
await pago('india', pA, 1000, { estado: 'ANULADO' })
check('un pago anulado no descuenta', (await total(fNueva)) === '-350.00')
await pago('india', pA, 1000, { factura_asociada: '0001-00000999' })
check('un pago con factura asociada (texto) no es anticipo', (await total(fNueva)) === '-350.00')
const pVinc = await pago('india', pA, 1000, { tipo_pago: 'FACTURA' })
const fVinc = await factura('india', pB, 1000, dia(40))
await db.query(`insert into pagos_facturas (pago_id, factura_id, importe) values ($1, $2, 1000)`, [pVinc, fVinc])
check('un pago vinculado a una factura (pagos_facturas) no es anticipo', (await total(fNueva)) === '-350.00')
await pago('india', pA, 1000, { tipo_pago: 'FACTURA', forma: 'SALIDA_FONDOS' })
check('un pago tipo FACTURA cargado como salida de fondos no es anticipo', (await total(fNueva)) === '-350.00')

// Orden de pago sin factura (ESPERA_FC de 0022) aunque no diga SIN_FACTURA: sí es anticipo.
const op = await pago('india', pA, 40, { tipo_pago: null, forma: 'ORDEN_PAGO' })
check('orden de pago a proveedor sin factura (ESPERA_FC) también descuenta: −350 + 40 = −310', (await total(fNueva)) === '-310.00', await total(fNueva))

// ---------------------------------------------------------------- Llega la factura: el anticipo se vincula y deja de descontar
await db.query(`update pagos set factura_asociada = '0001-00000101' where id = $1`, [op])
await db.query(`update facturas set pagado = 40, estado = 'PAGADA_PARCIAL' where id = $1`, [fNueva])
check('vinculado el pago de 40 a la factura: la factura baja por lo pagado y no hay doble descuento (−500 + 40 + 150 = −310)',
  (await total(fNueva)) === '-310.00', await total(fNueva))

// ---------------------------------------------------------------- Anticipo mayor que todo lo proyectado
const pC = await prov('30700000003', 'Proveedor Grande SA')
const fc1 = await factura('vertice', pC, 100, dia(3))
const fc2 = await factura('vertice', pC, 200, dia(8))
await pago('vertice', pC, 1000)
check('anticipo de 1000 contra 300 proyectados: no queda ninguna línea, ni positiva ni negativa',
  (await proyectado(fc1)).length === 0 && (await proyectado(fc2)).length === 0)
check('no aparecen líneas FACTURA con importe ≥ 0', (await val(`select count(*)::int n from flujo_lineas where origen_tipo = 'FACTURA' and importe >= 0`)).n === 0)

// ---------------------------------------------------------------- Anticipo % + cuenta corriente: el tramo de mañana va primero
const pD = await prov('30700000004', 'Proveedor Tramos SA')
const fT = await factura('india', pD, 1000, dia(30), { anticipo_pct: 30 })
await pago('india', pD, 100)
const tr = await proyectado(fT)
check('tramos: ANTICIPO 300 − 100 = −200 (mañana) y SALDO −700 intacto',
  tr.length === 2 && tr[0].ocurrencia === 'ANTICIPO' && tr[0].importe === '-200.00' && tr[1].importe === '-700.00', JSON.stringify(tr.map((t) => t.importe)))
await pago('india', pD, 500)
const tr2 = await proyectado(fT)
check('con 600 sin factura: ANTICIPO desaparece y del SALDO quedan −400',
  tr2.length === 1 && tr2[0].ocurrencia === 'SALDO' && tr2[0].importe === '-400.00', JSON.stringify(tr2.map((t) => [t.ocurrencia, t.importe])))

// ---------------------------------------------------------------- Ajustes y control siguen andando
await como('teso@prueba.com')
await db.query(`select ajustar_linea_flujo('FACTURA', $1, 'SALDO', null, 50, false, 'Acordamos 50')`, [fT])
check('un ajuste manual de importe sigue mandando sobre la línea descontada', (await total(fT)) === '-50.00')
await db.query(`select restaurar_linea_flujo('FACTURA', $1, 'SALDO')`, [fT])
check('restaurar vuelve a la línea descontada (−400)', (await total(fT)) === '-400.00')
check('flujo_control sigue respondiendo', Array.isArray(await filas(`select * from flujo_control`)))

// ---------------------------------------------------------------- Arreglo de 0024: dos movimientos iguales con la misma referencia
await servidor()
const ca = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase) values ('india', 'CUENTA PRUEBA', 'HIPOTECARIO', 'CA') returning id`)).id
const mov = { fecha: '2026-11-02', descripcion: 'N/D - DB TRF CTA PROP', referencia: '1666 Chq: 0', importe: -10000 }
const imp = (await val(`select importar_extracto($1) r`, [{ cuenta_origen_id: ca, usuario: 'servidor', archivo: { nombre: 'x.csv', hash: 'h1' }, movimientos: [mov, { ...mov }] }])).r
check('dos movimientos iguales del mismo día con la misma referencia entran los dos', imp.nuevos === 2, JSON.stringify(imp))
check('ya no existe la clave vieja (cuenta, fecha, importe, referencia)',
  (await val(`select count(*)::int n from pg_constraint where conrelid = 'movimientos_bancarios'::regclass and conname like '%fecha_importe_ref%'`)).n === 0)

// ---------------------------------------------------------------- Seguridad
await como('solober@prueba.com')
check('quien ve solo Beratung no ve anticipos de India', (await val(`select count(*)::int n from anticipos_sin_factura where empresa_id = 'india'`)).n === 0)
check('… y en su Flujo la factura de Beratung sigue entera (−200)', (await total(fBer)) === '-200.00')
await servidor()
check('anon no lee anticipos_sin_factura', !(await val(`select has_table_privilege('anon', 'anticipos_sin_factura', 'select') p`)).p)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
