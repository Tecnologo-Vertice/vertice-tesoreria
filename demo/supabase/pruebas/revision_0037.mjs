// Revisión independiente de 0037 (agente 06, 27/11/2026). "BUG" = comportamiento que falla o difiere del Apps Script; "OK" = control.
// Datos ficticios. No toca producción. Uso (desde demo/): node supabase/pruebas/revision_0037.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'BUG'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
const error = async (sql, p = []) => { try { await db.query(sql, p); return null } catch (e) { return e.message } }
const falla = async (nombre, sql, p, patron) => { const e = await error(sql, p); check(nombre, e !== null && patron.test(e), e ?? 'no falló') }
const n = (x) => (x == null ? null : Number(x))
let actual = null
const como = async (email) => {
  actual = email
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const servidor = async () => { actual = null; await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }

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
check('migraciones aplican (con 0037)', true)

await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMINISTRACION', true), ('ctrl@prueba.com', 'Ctrl', 'CONTROLLER', true);`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const prov = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre) values ($1, $2) returning id`, [cuit, nombre])).id
const pDelta = await prov('30710000012', 'Delta Servicios SRL')
const pOmega = await prov('30710000013', 'Omega Servicios SA')
const pago = async (e = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, estado, xubio_id, contabilizado_por, gestion, factura_asociada, proveedor_destino)
   values ($1, $2, $3, $4, 'TRANSFERENCIA', 'x', $5, $6, $7, $8, 'x', $9, $10, $11) returning id`,
  [e.empresa ?? 'india', e.proveedor ?? null, e.fecha ?? dia(-3), e.importe ?? 1000, e.tipoPago ?? 'SIN_FACTURA', e.forma ?? 'ORDEN_PAGO', e.estado ?? 'CONTABILIZADO',
   e.xubioId === undefined ? 'OP-7001' : e.xubioId, e.gestion ?? 'SISTEMA', e.facturaAsociada ?? null, e.destino ?? null])).id
const pagoDe = async (id) => val(`select * from pagos where id = $1`, [id])

// ---------------------------------------------------------------- 1. N° de OP sobre los pagos que ya existen (HOJA)
const pHoja = await pago({ gestion: 'HOJA', importe: 1234, xubioId: 'OP-8001', proveedor: pDelta })
const pSis = await pago({ gestion: 'SISTEMA', importe: 2345, xubioId: 'OP-8002', proveedor: pDelta })
const pend = (await val(`select numero_op_pendientes($1) r`, [org])).r
check('[1] numero_op_pendientes NO debe ofrecer pagos de la hoja (gestion = HOJA): la hoja manda sobre ellos y su NUMERO_OP_ASIENTO no se copia a la base',
  !pend.pendientes.some((x) => x.id === pHoja) && pend.pendientes.some((x) => x.id === pSis), 'con los ~930 pagos HOJA reales entran todos los de los últimos 90 días contabilizados como OP')
await db.query(`select aplicar_numero_op_xubio($1, 'X-0001-00000100')`, [pHoja])
check('[1] aplicar_numero_op_xubio no debería escribir sobre un pago de la hoja', (await pagoDe(pHoja)).numero_op === null, 'escribió numero_op y detalle_contabilizacion de un pago HOJA')
await db.query(`select aplicar_numero_op_xubio($1, 'X-0001-00000100')`, [pSis])
const pSis2 = await pago({ importe: 3456, xubioId: 'OP-8003', proveedor: pDelta })
await db.query(`select aplicar_numero_op_xubio($1, 'X-0001-00000100')`, [pSis2])
check('[1] el mismo N° de OP no debería quedar en dos pagos de la misma empresa (no hay chequeo ni clave única en la base)', (await val(`select count(*)::int n from pagos where numero_op = 'X-0001-00000100' and empresa_id = 'india'`)).n <= 1)
await como('admin@prueba.com')
check('[1] guardar_numero_op a mano rechaza un N° que ya está en otro pago de la empresa', /ya está en otro pago/.test((await error(`select guardar_numero_op($1, 'X-0001-00000100')`, [pSis2])) ?? ''))
await db.query(`select guardar_numero_op($1, 'X-0001-00000101')`, [pSis2])
check('[1] guardar_numero_op a mano no pisa un número ya cargado sin confirmación (con confirmación sí, y queda en la auditoría)', /confirmarlo/.test((await error(`select guardar_numero_op($1, 'X-0001-00000102')`, [pSis2])) ?? '') && (await pagoDe(pSis2)).numero_op === 'X-0001-00000101' && (await error(`select guardar_numero_op($1, 'X-0001-00000102', true)`, [pSis2])) === null)
await como('ctrl@prueba.com')
check('[1] CONTROLLER no puede cargar N° (coincide con permisos.ts PAGAR)', (await error(`select guardar_numero_op($1, '1')`, [pSis2])) !== null)
await servidor()
await db.query(`update pagos set estado = 'ANULADO', anulado_en = now(), anulado_por = 'x', motivo_anulacion = 'x' where id = $1`, [pSis2])
await como('admin@prueba.com')
const eAn = await error(`select guardar_numero_op($1, 'X-0001-00000555')`, [pSis2])
check('[1] guardar_numero_op sobre un pago ANULADO: el mensaje debería decir que está anulado', /anulad/i.test(eAn ?? ''), eAn ?? 'no falló')
await servidor()

// ---------------------------------------------------------------- 2. emparejar cuenta de Xubio con la cuenta bancaria
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const cuenta = async (nombre, e = {}) => (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, numero) values ('india', $1, $2, $3, $4, $5) returning id`,
  [nombre, e.banco ?? 'BANCO', e.clase ?? 'CC', uIndia, e.numero ?? null])).id
const cMp = await cuenta('MERCADO PAGO', { banco: 'MERCADOPAGO', clase: 'BILLETERA' })
const cMacro = await cuenta('MACRO CC 3120', { banco: 'MACRO', numero: '3120' })
const emp = async (x) => (await val(`select emparejar_cuenta_xubio('india', $1) id`, [x])).id
check('[2] "Mercado Pago" (nombre exacto) se empareja', (await emp('Mercado Pago')) === cMp)
check('[2] una cuenta de GASTO del plan ("Mercado Pago Comisiones") NO debería emparejarse con la billetera: guardaría el saldo del gasto como saldo de la cuenta',
  (await emp('Mercado Pago Comisiones')) === null, 'el nivel c (una palabra en común) la empareja con MERCADO PAGO; la API "cuenta" devuelve todo el plan de cuentas, no solo bancos')
check('[2] "Gastos Bancarios Banco Macro" no debería emparejarse con la cuenta Macro', (await emp('Gastos Bancarios Banco Macro')) === null)
check('[2] "Deudores por ventas 3120" (cuenta que no es de banco, con 4 dígitos iguales) no debería emparejarse por dígitos', (await emp('Deudores por ventas 3120')) === null)
await db.query(`select registrar_lecturas_xubio('india', $1, $2::jsonb, 'Saldo de Xubio', true)`, [dia(-1), JSON.stringify([{ cuenta: 'Mercado Pago', saldo: 1000 }, { cuenta: 'Mercado Pago Comisiones', saldo: 50 }])])
check('[2] dos cuentas de Xubio distintas no deberían terminar como lectura de la misma cuenta bancaria el mismo día (la conciliación toma "la última")',
  (await val(`select count(distinct cuenta_xubio)::int n from lecturas_xubio where cuenta_origen_id = $1 and fecha = $2`, [cMp, dia(-1)])).n === 1)

// ---------------------------------------------------------------- 3. cobranzas
const c1 = [{ fecha: dia(-1), recibo: 'R-1', transaccion_id: '900', instrumento_id: '', cliente: 'Cli', cuenta: 'x', importe: 100 }, { fecha: dia(-1), recibo: 'R-1', transaccion_id: '900', instrumento_id: '', cliente: 'Cli', cuenta: 'y', importe: 200 }]
const rc = (await val(`select importar_cobros_xubio('india', $1::jsonb, null) r`, [JSON.stringify(c1)])).r
check('[3] dos instrumentos de una cobranza sin id de instrumento no deben pisarse entre sí (la clave queda solo en la transacción)', rc.nuevas === 2, JSON.stringify(rc))
const rc2 = (await val(`select importar_cobros_xubio('india', $1::jsonb, null) r`, [JSON.stringify(c1)])).r
check('[3] repetir la importación es idempotente', rc2.nuevas === 0)

// ---------------------------------------------------------------- 4. sincronizar facturas pagadas
let nro = 800
const factura = async (e = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, gestion, cuenta_contable)
   values ('india', $1, 'Factura A', 'A', 1, $2, $3, $4, $5, $5, $6, $7, $8, 'PROVEEDORES LOCALES') returning id`,
  [e.proveedor, e.numero ?? nro++, dia(-20), dia(5), e.total ?? 1000, e.estado ?? 'PARA_PAGAR', e.pagado ?? 0, e.gestion ?? 'SISTEMA'])).id
const fac = async (id) => val(`select estado::text, pagado::float from facturas where id = $1`, [id])
const num = (x) => `00001-${String(x).padStart(8, '0')}`
const fDelta = await factura({ proveedor: pDelta, numero: 801, total: 1000 })
await pago({ proveedor: pOmega, destino: 'Omega Servicios SA', facturaAsociada: num(801), importe: 1000, tipoPago: 'FACTURA' })
await db.query(`select sincronizar_facturas_pagadas($1)`, [org])
check('[4] un pago a OMEGA SERVICIOS (proveedor_id distinto) no debe dejar PAGADA la factura 1-801 de DELTA SERVICIOS (mismo número; comparten la palabra "servicios")',
  (await fac(fDelta)).estado === 'PARA_PAGAR', JSON.stringify(await fac(fDelta)))
const fDob = await factura({ proveedor: pDelta, numero: 802, total: 1000 })
const pDob = await pago({ proveedor: pDelta, destino: 'Delta Servicios SRL', facturaAsociada: num(802), importe: 400, tipoPago: 'FACTURA', gestion: 'HOJA' })
await db.query(`select sincronizar_facturas_pagadas($1)`, [org])
const antes = await fac(fDob)
await db.query(`delete from pagos_facturas where pago_id = $1`, [pDob])
await db.query(`select sincronizar_facturas_pagadas($1)`, [org])
check('[4] si el vínculo del pago se pierde (espejar_pagos hace delete + insert de los vínculos cuando cambia la fila de la hoja), la factura no debe sumar dos veces el mismo pago',
  (await fac(fDob)).pagado === antes.pagado, `pagado antes ${antes.pagado}, después ${(await fac(fDob)).pagado}`)
const fCar = await factura({ proveedor: pDelta, numero: 803, total: 500 })
await pago({ proveedor: pDelta, destino: 'Delta Servicios SRL', facturaAsociada: num(803), importe: 500, tipoPago: 'FACTURA', estado: 'CARGADO', xubioId: null })
await db.query(`select sincronizar_facturas_pagadas($1)`, [org])
check('[4] (igual que el Apps Script: a confirmar) un pago CARGADO, sin contabilizar, ya marca la factura como PAGADA', (await fac(fCar)).estado === 'PAGADA')
const fHoja = await factura({ proveedor: pDelta, numero: 804, total: 300, gestion: 'HOJA' })
await pago({ proveedor: pDelta, destino: 'Delta Servicios SRL', facturaAsociada: num(804), importe: 300, tipoPago: 'FACTURA', gestion: 'HOJA' })
await db.query(`select sincronizar_facturas_pagadas($1)`, [org])
check('[4] una factura de la hoja (gestion = HOJA) no se toca', (await fac(fHoja)).estado === 'PARA_PAGAR')

// ---------------------------------------------------------------- 5. permisos
const fns = ['guardar_numero_op(uuid,text,boolean)', 'registrar_lectura_xubio(text,text,date,numeric,text)', 'registrar_lecturas_xubio(text,date,jsonb,text,boolean)']
const priv = async (rol, f) => (await val(`select has_function_privilege('${rol}', '${f}'::regprocedure, 'execute') p`)).p
for (const f of fns) check(`permisos: ${f} para authenticated sí y para anon no`, (await priv('authenticated', f)) === true && (await priv('anon', f)) === false)
const soloServ = ['numero_op_pendientes(uuid,integer)', 'aplicar_numero_op_xubio(uuid,text,text)', 'emparejar_cuenta_xubio(text,text)', 'guardar_lectura_xubio(text,text,date,numeric,text)',
  'importar_cobros_xubio(text,jsonb,text)', 'numeros_de_facturas(text)', 'mismo_proveedor_palabras(text,text)', 'sincronizar_facturas_pagadas(uuid,boolean)', 'resultado_anulacion_xubio(text,uuid,text,text)']
for (const f of soloServ) check(`permisos: ${f} solo para service_role`, (await priv('authenticated', f)) === false && (await priv('anon', f)) === false && (await priv('service_role', f)) === true)
check('seguridad: toda función security definer de 0037 tiene search_path fijado', (await val(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.prosecdef
  and p.proname in ('guardar_numero_op','numero_op_pendientes','aplicar_numero_op_xubio','emparejar_cuenta_xubio','guardar_lectura_xubio','registrar_lectura_xubio','registrar_lecturas_xubio','importar_cobros_xubio','sincronizar_facturas_pagadas','resultado_anulacion_xubio')
  and not coalesce(p.proconfig::text, '') like '%search_path%'`)).n === 0)
let seg = null
try { await db.exec(readFileSync(join(dir, '0037_xubio_ida_y_vuelta.sql'), 'utf8')) } catch (e) { seg = e.message }
check('0037 se puede volver a correr sobre una base con datos', seg === null, seg ?? '')
check('…y no pierde los números de OP ya cargados', (await val(`select count(*)::int n from pagos where numero_op is not null`)).n >= 2)

console.log(`\n${ok} OK · ${mal} BUG`)
await db.close()
process.exit(mal ? 1 : 0)
