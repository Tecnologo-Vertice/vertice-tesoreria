// Pruebas de 0036: pagos del día a día y cheques completos (Tandas 1 y 2 de PARIDAD_COMPLETA.md, 27/11/2026).
//   1. Vincular un pago sin factura a su factura (al aprobar y a mano) y corregir el proveedor del pago.
//   2. Adjuntar o quitar el comprobante de un pago ya cargado.   3. Tarjeta de crédito: directo a pagada.
//   4. Proveedor que no va a Xubio.   5. "Ya pagada, falta comprobante".   6. Posible duplicado al cargar el pago.
//   7. Un pago con cheque crea o vincula su fila en Cheques.   8. Acreedor por núcleo.   9. "Puede ser el cheque X".
// Datos ficticios. Uso (desde demo/): node supabase/pruebas/probar_0036.mjs supabase/migrations
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
check('migraciones aplican (con 0036)', true)

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('aprob@prueba.com', 'Aprob', 'APROBADOR', true),
    ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false), ('dir@prueba.com', 'Dirección', 'DIRECCION', true);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const alServidor = (fn) => async (...a) => { const antes = actual; await servidor(); try { return await fn(...a) } finally { if (antes) await como(antes) } }
const prov = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre) values ($1, $2) returning id`, [cuit, nombre])).id
const pA = await prov('30710000001', 'Proveedor Uno SA')
const pB = await prov('30710000002', 'Proveedor Dos SRL')
const pC = await prov('30710000003', 'Proveedor Tres SA')
const chequera = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id) values ('india', 'BANCO PRUEBA CC-0001', 'BANCOPRUEBA', 'CC', $1) returning id`, [uIndia])).id
let nro = 500
const factura = alServidor(async (empresa, proveedor, total, extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable)
   values ($1, $2, $3, 'A', 1, $4, $5, $6, $7, $7, $8, $9, 'PROVEEDORES LOCALES') returning id`,
  [empresa, proveedor, extra.tipo ?? 'Factura A', nro++, dia(-10), dia(10), total, extra.estado ?? 'PENDIENTE_APROBACION', extra.pagado ?? 0])).id)
const fac = async (id) => val(`select estado::text, estado_xubio::text, pagado::float, fecha_pago::text, ya_pagada_segun_admin from facturas where id = $1`, [id])
const pagoSF = alServidor(async (empresa, proveedor, importe, extra = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, estado, gestion)
   values ($1, $2, $3, $4, 'TRANSFERENCIA', 'teso@prueba.com', 'SIN_FACTURA', 'ORDEN_PAGO', $5, $6) returning id`,
  [empresa, proveedor, extra.fecha ?? dia(-2), importe, extra.estado ?? 'CARGADO', extra.gestion ?? 'SISTEMA'])).id)
const pagoDe = async (id) => val(`select * from pagos where id = $1`, [id])
const registrar = async (extra) => (await val(`select registrar_pago($1) id`, [{
  empresa_id: 'india', fecha: hoy, importe: 1000, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA CC-0001', forma_carga_xubio: 'SALIDA_FONDOS', ...extra }])).id

// ================================================================ 3. Tarjeta de crédito: directo a pagada
await como('aprob@prueba.com')
const fTar = await factura('india', pA, 1000)
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TARJETA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [fTar])
let f = await fac(fTar)
check('[3] aprobar con tarjeta: la factura nace PAGADA, pagado = total y con la fecha de hoy (Argentina)', f.estado === 'PAGADA' && f.pagado === 1000 && f.fecha_pago === hoy, JSON.stringify(f))
check('[3] la auditoría lo dice', (await val(`select count(*)::int n from auditoria where accion = 'APROBACION' and entidad_id = $1 and detalle like '%tarjeta de crédito%'`, [fTar])).n === 1)
const fNoTar = await factura('india', pA, 500)
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [fNoTar])
f = await fac(fNoTar)
// Desde 0041 aprobar con otro método fija la fecha de pago (acá, el vencimiento de la factura, que es la fecha que se pasa).
check('[3] con otro método sigue como siempre: PARA_PAGAR, sin pagar (y con la fecha de pago de 0041)', f.estado === 'PARA_PAGAR' && f.pagado === 0 && f.fecha_pago === dia(10))
const ncTar = await factura('india', pA, 300, { tipo: 'Nota de Crédito A' })
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TARJETA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [ncTar])
check('[3] una nota de crédito con tarjeta no se da por pagada', (await fac(ncTar)).estado === 'PARA_PAGAR')
// Aprobar ya pagada con tarjeta: el pago se crea aparte por el saldo entero (no importe 0).
const fTarYa = await factura('india', pA, 700)
const r = (await val(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'TARJETA', $2) r`, [fTarYa, { cuenta_origen: 'BANCO PRUEBA CC-0001', fecha: hoy }])).r
f = await fac(fTarYa)
check('[3] aprobar "ya pagada" con tarjeta: crea el pago por el total y la factura queda PAGADA', r === 'PARA_CONTABILIZAR' && f.estado === 'PAGADA' && f.pagado === 700, JSON.stringify({ r, f }))
await como('teso@prueba.com')
await falla('[3] Tesorería no aprueba facturas', `select aprobar_factura($1, 'X', 'TARJETA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [await (async () => { await servidor(); const id = await factura('india', pA, 10); await como('teso@prueba.com'); return id })()], /rol/)

// ================================================================ 4. Proveedor que no va a Xubio
await servidor()
await db.exec(`
  insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, metodo_pago, saltar_xubio) values ('${pB}', 'india', 'X', 'TRANSFERENCIA', true);
  insert into proveedores_empresa (proveedor_id, empresa_id, cuenta_contable, metodo_pago, saltar_xubio) values ('${pB}', 'robles', 'X', 'TRANSFERENCIA', true);`)
await como('aprob@prueba.com')
const fSalta = await factura('india', pB, 200)
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [fSalta])
f = await fac(fSalta)
check('[4] proveedor que no va a Xubio: la factura aprobada queda SIN_ERP y en Para pagar', f.estado_xubio === 'SIN_ERP' && f.estado === 'PARA_PAGAR', JSON.stringify(f))
check('[4] no aparece entre las facturas para subir a Xubio', (await val(`select count(*)::int n from facturas where id = $1 and estado_xubio = 'PENDIENTE'`, [fSalta])).n === 0)
const fNoSalta = await factura('india', pA, 200)
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [fNoSalta])
check('[4] un proveedor común sigue quedando PENDIENTE de Xubio', (await fac(fNoSalta)).estado_xubio === 'PENDIENTE')
const fRobles = await factura('robles', pB, 200)
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [fRobles])
check('[4] una empresa de Ralpharma sigue por su camino (pendiente de Ralpharma)', (await fac(fRobles)).estado_xubio === 'PENDIENTE_RALPHARMA')
const fSalta2 = await factura('india', pB, 200)
const rs = (await val(`select aprobar_factura_y_vincular($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1))) r`, [fSalta2])).r
check('[4] aprobar_factura_y_vincular también lo respeta y lo informa', rs.estado_xubio === 'SIN_ERP' && rs.estado === 'PARA_PAGAR', JSON.stringify(rs))

// ================================================================ 1. Vincular al aprobar la factura
await servidor()
const antUno = await pagoSF('india', pC, 300)          // un solo pago sin factura de Proveedor Tres
const fC = await factura('india', pC, 1000)
await como('aprob@prueba.com')
let ap = (await val(`select aprobar_factura_y_vincular($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1))) r`, [fC])).r
f = await fac(fC)
check('[1] al aprobar, el único pago sin factura del proveedor se vincula solo', ap.vinculado === true && ap.pago === antUno && /vinculó sola/.test(ap.mensaje), JSON.stringify(ap))
check('[1] la factura baja por lo pagado: PAGADA_PARCIAL con 300 pagados', f.estado === 'PAGADA_PARCIAL' && f.pagado === 300, JSON.stringify(f))
let p1 = await pagoDe(antUno)
check('[1] el pago pasa a ser el pago de esa factura (tipo FACTURA, factura asociada, descripción)',
  p1.tipo_pago === 'FACTURA' && /^\d{5}-\d{8}$/.test(p1.factura_asociada) && /vinculado/.test(p1.descripcion) && p1.proveedor_destino === 'Proveedor Tres SA', JSON.stringify(p1))
check('[1] y ya no es un pago sin factura (sale de la vista y de anticipos)',
  (await val(`select count(*)::int n from pagos_sin_factura where pago_id = $1`, [antUno])).n === 0 && (await val(`select count(*)::int n from anticipos_sin_factura where proveedor_id = $1`, [pC])).n === 0)
check('[1] queda la fila en pagos_facturas y la auditoría', (await val(`select importe::float i from pagos_facturas where pago_id = $1 and factura_id = $2`, [antUno, fC])).i === 300
  && (await val(`select count(*)::int n from auditoria where accion = 'PAGO_VINCULADO'`)).n >= 2)

// Dos pagos sin factura del mismo proveedor: no se decide solo, avisa.
await servidor()
const antDos = await pagoSF('india', pA, 100)
const antTres = await pagoSF('india', pA, 120)
const fA2 = await factura('india', pA, 900)
await como('aprob@prueba.com')
ap = (await val(`select aprobar_factura_y_vincular($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1))) r`, [fA2])).r
check('[1] con dos pagos sin factura del proveedor: no vincula y avisa cuántos hay', !ap.vinculado && /Hay 2 pagos sin factura/.test(ap.mensaje), JSON.stringify(ap))
check('[1] la factura queda aprobada y sin pagar', (await fac(fA2)).pagado === 0 && (await fac(fA2)).estado === 'PARA_PAGAR')

// Otra empresa o un pago de la hoja: no se vinculan solos.
await servidor()
await pagoSF('beratung', pB, 50)
const antHoja = await pagoSF('india', pB, 60, { gestion: 'HOJA' })
const fB = await factura('india', pB, 400)
await como('aprob@prueba.com')
ap = (await val(`select aprobar_factura_y_vincular($1, 'GASTOS VARIOS', 'TRANSFERENCIA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1))) r`, [fB])).r
check('[1] un pago de la hoja del Apps Script no se vincula solo (se avisa) y el de otra empresa no cuenta', !ap.vinculado && /no se pudo vincular solo/.test(ap.mensaje), JSON.stringify(ap))

// ================================================================ 1. Vincular a mano
await como('teso@prueba.com')
const vin = async (pago, factura) => (await val(`select vincular_pago_sin_factura($1, $2) r`, [pago, factura])).r
const rv = await vin(antDos, fA2)
check('[1] a mano: la factura baja por el pago (100 de 900)', rv.monto === 100 && rv.sobra === 0 && (await fac(fA2)).pagado === 100 && (await fac(fA2)).estado === 'PAGADA_PARCIAL', JSON.stringify(rv))
await falla('[1] a mano: el mismo pago no se vincula dos veces', `select vincular_pago_sin_factura($1, $2)`, [antDos, fA2], /ya no está esperando factura/)
// El pago supera el saldo: se aplica el saldo y se avisa lo que sobra.
await servidor()
const fChica = await factura('india', pA, 50, { estado: 'PARA_PAGAR' })
await como('teso@prueba.com')
const rs2 = await vin(antTres, fChica)
check('[1] a mano: si el pago supera el saldo, se aplica el saldo (50), la factura queda PAGADA y se avisa lo que sobra (70)', rs2.monto === 50 && rs2.sobra === 70 && rs2.completa === true && (await fac(fChica)).estado === 'PAGADA', JSON.stringify(rs2))
check('[1] … y queda anotado en las observaciones del pago', /supera el saldo de la factura en \$ 70/.test((await pagoDe(antTres)).observaciones))
// Rechazos.
await servidor()
const pRech = await pagoSF('india', pA, 10)
const fOtraEmp = await factura('beratung', pA, 10, { estado: 'PARA_PAGAR' })
const fOtroProv = await factura('india', pB, 10, { estado: 'PARA_PAGAR' })
const fNc = await factura('india', pA, 10, { estado: 'PARA_PAGAR', tipo: 'Nota de Crédito A' })
const fPend = await factura('india', pA, 10)
const fPaga = await factura('india', pA, 10, { estado: 'PAGADA', pagado: 10 })
await como('teso@prueba.com')
await falla('[1] factura de otra empresa: no', `select vincular_pago_sin_factura($1, $2)`, [pRech, fOtraEmp], /otra empresa/)
await falla('[1] factura de otro proveedor: no', `select vincular_pago_sin_factura($1, $2)`, [pRech, fOtroProv], /otro proveedor/)
await falla('[1] nota de crédito: no', `select vincular_pago_sin_factura($1, $2)`, [pRech, fNc], /nota de crédito/)
await falla('[1] factura sin aprobar: no', `select vincular_pago_sin_factura($1, $2)`, [pRech, fPend], /aprobada/)
await falla('[1] factura ya pagada: no', `select vincular_pago_sin_factura($1, $2)`, [pRech, fPaga], /aprobada|ya está pagada/)
await falla('[1] pago de la hoja del Apps Script: no (se vincula ahí)', `select vincular_pago_sin_factura($1, $2)`, [antHoja, fB], /hoja/)
await como('aprob@prueba.com')
await falla('[1] el aprobador no vincula a mano (es de Tesorería)', `select vincular_pago_sin_factura($1, $2)`, [pRech, fB], /rol/)
await como('dir@prueba.com')
await falla('[1] Dirección ve pero no modifica', `select vincular_pago_sin_factura($1, $2)`, [pRech, fB], /rol/)
await como('solober@prueba.com')
await falla('[1] quien no ve la empresa del pago no se entera de nada', `select vincular_pago_sin_factura($1, $2)`, [pRech, fB], /No tenés acceso a la empresa india/)

// ================================================================ 1. Corregir el proveedor del pago
await como('teso@prueba.com')
await db.query(`select corregir_proveedor_pago($1, $2)`, [pRech, pB])
const pc = await pagoDe(pRech)
check('[1] corregir proveedor: cambia el proveedor y el destino', pc.proveedor_id === pB && pc.proveedor_destino === 'Proveedor Dos SRL')
check('[1] … y queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'PAGO_PROVEEDOR_CORREGIDO' and entidad_id = $1`, [pRech])).n === 1)
await servidor()
const pXub = await pagoSF('india', pA, 20, { estado: 'REVISADO' })
await db.query(`update pagos set envio_xubio_en = now() where id = $1`, [pXub])
const pCont = await pagoSF('india', pA, 20)
await db.query(`update pagos set estado = 'CONTABILIZADO', xubio_id = 'OP-1', contabilizado_por = 'x' where id = $1`, [pCont])
await como('teso@prueba.com')
await falla('[1] corregir proveedor de un pago ya contabilizado en Xubio: no', `select corregir_proveedor_pago($1, $2)`, [pCont, pB], /ya está registrado en Xubio/)
await falla('[1] corregir proveedor con un envío a Xubio en curso: no', `select corregir_proveedor_pago($1, $2)`, [pXub, pB], /ya está registrado en Xubio/)
await falla('[1] corregir proveedor de un pago ya vinculado a una factura: no', `select corregir_proveedor_pago($1, $2)`, [antUno, pB], /vinculado a una factura/)
await falla('[1] corregir sin elegir proveedor: no', `select corregir_proveedor_pago($1, null)`, [pRech], /proveedor/)
await servidor()
const org2 = (await val(`insert into organizaciones (slug, nombre) values ('otra36', 'Otra 36 SA') returning id`)).id
const provAjeno = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30720000009', 'PROV DE OTRA ORG', $1) returning id`, [org2])).id
await como('teso@prueba.com')
await falla('[1] un proveedor de otra organización: no', `select corregir_proveedor_pago($1, $2)`, [pRech, provAjeno], /otra organización/)
await como('solober@prueba.com')
await falla('[1] corregir el proveedor de una empresa que no ve: no', `select corregir_proveedor_pago($1, $2)`, [pRech, pA], /No tenés acceso/)

// ================================================================ 2. Adjuntar y quitar el comprobante
await como('teso@prueba.com')
const pComp = await registrar({ importe: 77 })
check('[2] un pago cargado sin comprobante parte sin ruta', (await pagoDe(pComp)).comprobante_path === null)
await db.query(`select adjuntar_comprobante_pago($1, $2)`, [pComp, `${org}/india/2026/cargado.pdf`])
check('[2] adjuntar: queda la ruta en el pago', (await pagoDe(pComp)).comprobante_path === `${org}/india/2026/cargado.pdf`)
await db.query(`select adjuntar_comprobante_pago($1, $2)`, [pComp, `${org}/india/2026/nuevo.pdf`])
check('[2] adjuntar otra vez reemplaza el anterior y lo deja anotado', (await pagoDe(pComp)).comprobante_path === `${org}/india/2026/nuevo.pdf`
  && (await val(`select count(*)::int n from auditoria where accion = 'COMPROBANTE_ADJUNTADO' and entidad_id = $1 and detalle like 'Reemplaza a%'`, [pComp])).n === 1)
await falla('[2] un comprobante guardado en la carpeta de otra empresa: no', `select adjuntar_comprobante_pago($1, $2)`, [pComp, `${org}/beratung/2026/ajeno.pdf`], /carpeta de otra empresa/)
await falla('[2] adjuntar sin archivo: no', `select adjuntar_comprobante_pago($1, '')`, [pComp], /Adjuntá/)
await db.query(`select quitar_comprobante_pago($1)`, [pComp])
check('[2] quitar: el pago queda sin comprobante y se audita', (await pagoDe(pComp)).comprobante_path === null
  && (await val(`select count(*)::int n from auditoria where accion = 'COMPROBANTE_QUITADO' and entidad_id = $1`, [pComp])).n === 1)
await db.query(`select quitar_comprobante_pago($1)`, [pComp])
check('[7] quitar dos veces es idempotente: no falla y no deja otra auditoría', (await val(`select count(*)::int n from auditoria where accion = 'COMPROBANTE_QUITADO' and entidad_id = $1`, [pComp])).n === 1)
check('[7] al quitar el comprobante, el pago bancario vuelve a "falta comprobante"', (await pagoDe(pComp)).falta_comprobante === true)
await como('aprob@prueba.com')
await falla('[2] el aprobador no adjunta ni quita (es de Tesorería)', `select adjuntar_comprobante_pago($1, $2)`, [pComp, `${org}/india/x.pdf`], /rol/)
await como('solober@prueba.com')
await falla('[2] quien no ve la empresa del pago: no', `select quitar_comprobante_pago($1)`, [pComp], /No tenés acceso|rol/)
await como('teso@prueba.com')
await db.query(`select anular_pago($1, 'prueba')`, [pComp])
await falla('[2] un pago anulado no recibe comprobantes', `select adjuntar_comprobante_pago($1, $2)`, [pComp, `${org}/india/y.pdf`], /anulado/)

// ================================================================ 5. "Ya pagada, falta comprobante"
await servidor()
const fYa1 = await factura('india', pA, 400)
const fYa2 = await factura('india', pA, 450)
const fYa3 = await factura('india', pA, 460)
await como('aprob@prueba.com')
const ya1 = (await val(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'TRANSFERENCIA', $2) r`, [fYa1, { cuenta_origen: 'BANCO PRUEBA CC-0001', fecha: dia(-1) }])).r
const pYa1 = (await val(`select pago_id from pagos_facturas where factura_id = $1`, [fYa1])).pago_id
const ya2 = (await val(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'TRANSFERENCIA', $2) r`, [fYa2, { ya_en_xubio: true }])).r
const pYa2 = (await val(`select pago_id from pagos_facturas where factura_id = $1`, [fYa2])).pago_id
const ya3 = (await val(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'CAJA', $2) r`, [fYa3, {}])).r
const pYa3 = (await val(`select pago_id from pagos_facturas where factura_id = $1`, [fYa3])).pago_id
check('[5] aprobar ya pagada con banco: el pago nace marcado "falta comprobante"', ya1 === 'PARA_CONTABILIZAR' && (await pagoDe(pYa1)).falta_comprobante === true)
check('[5] … también si ya estaba cargado en Xubio (sin banco)', ya2 === 'CONTABILIZADO' && (await pagoDe(pYa2)).falta_comprobante === true && (await pagoDe(pYa2)).cuenta_origen === null)
check('[5] con Caja no hay comprobante bancario que esperar', ya3 === 'PARA_CONTABILIZAR' && (await pagoDe(pYa3)).falta_comprobante === false)
check('[5] la fecha del pago, sin banco, es la de hoy en Argentina', (await val(`select fecha::text f from pagos where id = $1`, [pYa2])).f === hoy)
await como('teso@prueba.com')
await falla('[5] completar el pago sin banco y sin elegir uno: pide el banco', `select adjuntar_comprobante_pago($1, $2)`, [pYa2, `${org}/india/ya2.pdf`], /banco/)
await db.query(`select adjuntar_comprobante_pago($1, $2, 'BANCO PRUEBA CC-0001')`, [pYa2, `${org}/india/ya2.pdf`])
check('[5] con comprobante y banco: sale de la lista y el pago toma el banco', (await pagoDe(pYa2)).falta_comprobante === false && (await pagoDe(pYa2)).cuenta_origen === 'BANCO PRUEBA CC-0001')
await db.query(`select adjuntar_comprobante_pago($1, $2)`, [pYa1, `${org}/india/ya1.pdf`])
check('[5] con el banco ya puesto alcanza con el comprobante', (await pagoDe(pYa1)).falta_comprobante === false)
// Facturas marcadas ya pagadas sin banco (sin pago todavía): al cargar el pago desde Pagos se limpia la marca (0011).
await servidor()
const fYa4 = await factura('india', pB, 300)
await como('aprob@prueba.com')
check('[5] sin banco: la factura queda en Para pagar marcada, sin pago', (await val(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'TRANSFERENCIA', '{}') r`, [fYa4])).r === 'PARA_PAGAR'
  && (await fac(fYa4)).ya_pagada_segun_admin !== null)
await como('teso@prueba.com')
await registrar({ importe: 300, proveedor_id: pB, factura_ids: [fYa4], forma_carga_xubio: 'ORDEN_PAGO', comprobante_path: `${org}/india/ya4.pdf` })
check('[5] al cargarle el pago con comprobante, la marca se limpia y la factura queda PAGADA', (await fac(fYa4)).ya_pagada_segun_admin === null && (await fac(fYa4)).estado === 'PAGADA')

// Un pago a un proveedor, sin facturas, espera su factura; sin proveedor (impuestos) o con facturas, no.
await como('teso@prueba.com')
const sf1 = await registrar({ importe: 33, proveedor_id: pB, fecha: dia(-20) })
const sf2 = await registrar({ importe: 34, fecha: dia(-20) })
check('[1] registrar_pago a un proveedor sin facturas lo marca SIN_FACTURA y entra en la lista de espera', (await pagoDe(sf1)).tipo_pago === 'SIN_FACTURA'
  && (await val(`select count(*)::int n from pagos_sin_factura where pago_id = $1`, [sf1])).n === 1)
check('[1] sin proveedor (banco, impuestos) no espera ninguna factura', (await pagoDe(sf2)).tipo_pago === null && (await val(`select count(*)::int n from pagos_sin_factura where pago_id = $1`, [sf2])).n === 0)
check('[1] con facturas vinculadas tampoco', (await val(`select count(*)::int n from pagos_sin_factura where pago_id = $1`, [pYa1])).n === 0)

// ================================================================ 6. Posible duplicado (aviso, no bloqueo)
await como('teso@prueba.com')
const d1 = await registrar({ importe: 5000.5, proveedor_id: pA, fecha: dia(-1), comprobante_path: `${org}/india/d1.pdf` })
check('[6] el primer pago no tiene aviso', (await pagoDe(d1)).posible_duplicado === null)
const d2 = await registrar({ importe: 5000, proveedor_id: pA, fecha: dia(0) })
check('[6] otro pago de la misma empresa, mismo proveedor, importe (menos de $1) y fecha a un día: se carga y queda el aviso',
  /5000\.50/.test((await pagoDe(d2)).posible_duplicado ?? '') && /Proveedor Uno SA/.test((await pagoDe(d2)).posible_duplicado), (await pagoDe(d2)).posible_duplicado)
check('[6] el aviso no bloquea: el pago existe y está CARGADO', (await pagoDe(d2)).estado === 'CARGADO')
check('[6] … y queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'POSIBLE_DUPLICADO' and entidad_id = $1`, [d2])).n === 1)
const d3 = await registrar({ importe: 5000.5, proveedor_id: pA, fecha: dia(-1), comprobante_path: `${org}/india/d1.pdf` })
check('[6] mismo comprobante que el otro: es del mismo lote, no se marca (solo el d2 se parece)', !/ 1 · /.test('') && ((await pagoDe(d3)).posible_duplicado ?? '').split(' | ').length === 1)
check('[6] fechas a más de 3 días: no se marca', (await pagoDe(await registrar({ importe: 5000.5, proveedor_id: pA, fecha: dia(-9) }))).posible_duplicado === null)
check('[6] otro proveedor: no se marca', (await pagoDe(await registrar({ importe: 5000.5, proveedor_id: pB, fecha: dia(-1) }))).posible_duplicado === null)
check('[6] otro importe: no se marca', (await pagoDe(await registrar({ importe: 5100, proveedor_id: pA, fecha: dia(-1) }))).posible_duplicado === null)
check('[6] un pago sin destino se compara con cualquiera', /Proveedor Uno SA/.test((await pagoDe(await registrar({ importe: 5000.5, fecha: dia(-1) }))).posible_duplicado ?? ''))
await db.query(`select anular_pago($1, 'duplicado')`, [d2])
check('[6] un pago anulado ya no cuenta como duplicado', !/5000\.00/.test((await pagoDe(await registrar({ importe: 5000, proveedor_id: pA, fecha: dia(0) }))).posible_duplicado ?? ''))
// Con cheque: mismo número e importe sí; mismo importe con número distinto no.
const c1 = await registrar({ importe: 2500, medio: 'CHEQUE', numero_cheque: '90001', fecha_acreditacion: dia(20), proveedor_id: pA })
const c2 = await registrar({ importe: 2500, medio: 'CHEQUE', numero_cheque: '90002', fecha_acreditacion: dia(20), proveedor_id: pA })
check('[6] dos cheques con distinto número y el mismo importe no son duplicado', (await pagoDe(c2)).posible_duplicado === null)
const c3 = await registrar({ importe: 2500, medio: 'CHEQUE', numero_cheque: '90001', fecha_acreditacion: dia(20), proveedor_id: pB, fecha: dia(-30) })
check('[6] el mismo número de cheque y el mismo importe sí, aunque la fecha y el proveedor difieran', /2500/.test((await pagoDe(c3)).posible_duplicado ?? ''), (await pagoDe(c3)).posible_duplicado)

// ================================================================ 7. Un pago con cheque crea o vincula su fila en Cheques
const chq = async (numero) => filas(`select * from cheques where numero = $1 and estado <> 'ANULADO'`, [numero])
const fila1 = (await chq('90001'))[0]
check('[7] un pago con cheque crea la fila en Cheques: EMITIDO, FISICO, por el importe y la fecha de cobro', !!fila1 && fila1.estado === 'EMITIDO' && fila1.tipo === 'FISICO' && Number(fila1.importe) === 2500
  && fila1.fecha_pago.toISOString().slice(0, 10) === dia(20) && fila1.cuenta_origen_id === chequera && fila1.proveedor_id === pA && fila1.origen === 'PAGO', JSON.stringify(fila1))
check('[7] … vinculada al pago por cheques_pagos', (await val(`select count(*)::int n from cheques_pagos where cheque_id = $1 and pago_id = $2`, [fila1.id, c1])).n === 1)
check('[7] … con el aviso para la pantalla y la auditoría', /se cargó en Cheques/.test((await pagoDe(c1)).aviso_cheque) && (await val(`select count(*)::int n from auditoria where accion = 'CHEQUE_DE_PAGO'`)).n >= 1)
check('[7] el pago c3 (mismo cheque 90001) no duplica la fila: avisa que ya estaba y que no alcanza', (await chq('90001')).length === 1 && /ya estaba en Cheques/.test((await pagoDe(c3)).aviso_cheque), (await pagoDe(c3)).aviso_cheque)
const pe = await registrar({ importe: 1800, medio: 'ECHEQ', numero_cheque: '70001', fecha_acreditacion: dia(15), proveedor_id: pB })
check('[7] un e-cheq crea la fila ECHEQ', (await chq('70001'))[0]?.tipo === 'ECHEQ')
// Un cheque que ya estaba cargado a mano (con ceros a la izquierda): se vincula, no se duplica.
await db.query(`select emitir_cheque($1)`, [{ empresa_id: 'india', cuenta_origen_id: chequera, tipo: 'ECHEQ', numero: '00080001', beneficiario: 'A MANO SA', importe: 900, fecha_emision: dia(-1), fecha_pago: dia(9) }])
const pm = await registrar({ importe: 900, medio: 'ECHEQ', numero_cheque: '80001', fecha_acreditacion: dia(9), proveedor_id: pC })
check('[7] el cheque ya cargado a mano (00080001) se vincula al pago (80001) sin duplicarlo', (await filas(`select id from cheques where ltrim(numero, '0') = '80001'`)).length === 1
  && (await val(`select count(*)::int n from cheques_pagos cp join cheques c on c.id = cp.cheque_id where cp.pago_id = $1 and ltrim(c.numero, '0') = '80001'`, [pm])).n === 1
  && /ya estaba en Cheques/.test((await pagoDe(pm)).aviso_cheque), (await pagoDe(pm)).aviso_cheque)
// Una cuenta que no se reconoce como chequera: el pago se carga igual y el aviso lo dice.
const pr = await registrar({ importe: 410, medio: 'CHEQUE', numero_cheque: '60001', fecha_acreditacion: dia(9), cuenta_origen: 'Cuenta inexistente' })
check('[7] cuenta de origen que no es una chequera: el pago se carga, no hay cheque y el aviso lo explica', (await chq('60001')).length === 0 && /no se reconoce la cuenta de origen/.test((await pagoDe(pr)).aviso_cheque), (await pagoDe(pr)).aviso_cheque)
// Un número que ya se usó en un cheque anulado de la misma chequera: no rompe el pago.
await servidor()
await db.query(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, beneficiario, importe, fecha_emision, fecha_pago, estado, anulado_por, anulado_en, motivo_anulacion, anulacion_xubio, creado_por)
  values ('india', $1, 'FISICO', '50001', 'X', 10, $2, $2, 'ANULADO', 'x', now(), 'prueba', 'HECHA', 'x')`, [chequera, dia(-5)])
await como('teso@prueba.com')
const pu = await registrar({ importe: 220, medio: 'CHEQUE', numero_cheque: '50001', fecha_acreditacion: dia(9) })
check('[7] si la fila del cheque no se puede crear (número de un cheque anulado), el pago igual queda cargado y el aviso lo dice',
  (await pagoDe(pu)).estado === 'CARGADO' && /figura anulado o rechazado/.test((await pagoDe(pu)).aviso_cheque) && !/duplicate key/.test((await pagoDe(pu)).aviso_cheque), (await pagoDe(pu)).aviso_cheque)
check('[7] el cheque creado entra a la emisión: el pago ya no se ofrece sin su cheque', (await val(`select count(*)::int n from pagos p where p.medio in ('CHEQUE', 'ECHEQ') and p.numero_cheque = '70001' and exists (select 1 from cheques_pagos cp where cp.pago_id = p.id)`)).n === 1)
// Ya pagada con cheque: también crea su fila.
await servidor()
const fYaCh = await factura('india', pA, 1300)
await como('aprob@prueba.com')
await db.query(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'ECHEQ', $2)`, [fYaCh, { cuenta_origen: 'BANCO PRUEBA CC-0001', numero_cheque: '30001', fecha_acreditacion: dia(12) }])
check('[7] aprobar ya pagada con e-cheq: también crea su fila en Cheques', (await chq('30001'))[0]?.tipo === 'ECHEQ' && Number((await chq('30001'))[0].importe) === 1300)
await como('teso@prueba.com')
await falla('[7] el pago con cheque sigue pidiendo número y fecha de cobro', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'CHEQUE', cuenta_origen: 'X' }], /necesita número y fecha/)

// ================================================================ 8. Acreedor por núcleo
await servidor()
const acr = async (nombre, alias = []) => (await val(`insert into acreedores (organizacion_id, nombre, alias) values ($1, $2, $3) returning id`, [org, nombre, alias])).id
const aJayor = await acr('Laboratorios JAYOR, S.R.L.')
const aNorte = await acr('DISTRIBUIDORA NORTE SA')
const aFarma = await acr('FARMACIAS CENTRAL')
const aLuna = await acr('LUNA ROSA')
const aEste = await acr('ESTE ROSA')
const aF1 = await acr('FARMA UNO SA')
const aF2 = await acr('FARMA UNO SRL')
const aAlias = await acr('TRANSPORTES DEL SUR', ['TDS LOGISTICA'])
const aMini = await acr('GIGANTE ARGENTINA SA')
const para = async (texto, prov = null) => (await val(`select acreedor_para($1, $2, $3) id`, [org, prov, texto])).id
check('[8] núcleo: "JAYOR" encuentra a "Laboratorios JAYOR, S.R.L." (sin Laboratorios ni S.R.L.)', (await para('JAYOR')) === aJayor)
check('[8] núcleo: "Jayor SRL" también', (await para('Jayor SRL')) === aJayor)
check('[8] nombre exacto', (await para('DISTRIBUIDORA NORTE SA')) === aNorte)
check('[8] núcleo: "Distribuidora Norte Argentina SRL" (sin SRL ni Argentina)', (await para('Distribuidora Norte Argentina SRL')) === aNorte)
check('[8] todas las palabras del más corto están en el otro: "Distribuidora Norte Pharma" → DISTRIBUIDORA NORTE', (await para('Distribuidora Norte Pharma')) === aNorte)
check('[8] error de tipeo en un nombre largo: "Farmacias Centrl" → FARMACIAS CENTRAL', (await para('Farmacias Centrl')) === aFarma)
check('[8] dos acreedores distintos empatan: no se adivina (null)', (await para('ROSA LUNA ESTE')) === null)
check('[8] uno contiene al otro: "TRANSPORTES DEL SUR BUENOS AIRES" → TRANSPORTES DEL SUR', (await para('TRANSPORTES DEL SUR BUENOS AIRES')) === aAlias)
check('[8] por alias', (await para('TDS Logistica')) === aAlias)
check('[8] sin nada parecido: null', (await para('Empresa Que No Existe SA')) === null)
check('[8] un nombre de puras palabras genéricas ("Argentina SA") no tiene núcleo: no se decide por fondo', JSON.stringify((await val(`select nucleo_acreedor('Argentina SA') n`)).n) === '[]')
check('[8] el empate entre dos alias del mismo nombre de fondo (FARMA UNO SA / SRL), sin uso: null', (await para('FARMA UNO')) === null)
// El alias más usado gana: FARMA UNO SRL con dos cheques.
for (const n of ['A1', 'A2']) await db.query(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, beneficiario, importe, fecha_emision, fecha_pago, creado_por)
  values ('india', $1, 'ECHEQ', $2, $3, 'FARMA UNO', 10, $4, $4, 'x')`, [chequera, n, aF2, dia(-2)])
check('[8] entre alias iguales gana el más usado (FARMA UNO SRL, con 2 cheques)', (await para('FARMA UNO')) === aF2)
check('[8] "Farma Uno S.A." exacto sigue yendo a su nombre', (await para('FARMA UNO SA')) === aF1)
check('[8] por proveedor: sigue andando', await (async () => { const a = (await val(`insert into acreedores (organizacion_id, nombre, proveedor_id) values ($1, 'NOMBRE INTERNO', $2) returning id`, [org, pC])).id; return (await para('lo que sea', pC)) === a })())
check('[8] no mira acreedores de otra organización', (await val(`select acreedor_para($1, null, 'JAYOR') id`, [org2])).id === null)
check('[8] nucleo_acreedor: sin tildes ni genéricas y juntando letras sueltas', JSON.stringify((await val(`select nucleo_acreedor('D&R Droguería Ñandú S.A.C.I.F.I.A.') n`)).n) === JSON.stringify(['dr', 'nandu']))
// El cheque que sale de un pago toma el acreedor por núcleo.
await como('teso@prueba.com')
await registrar({ importe: 640, medio: 'ECHEQ', numero_cheque: '40001', fecha_acreditacion: dia(10), descripcion: 'Pago a Jayor SRL' })
check('[8] el cheque creado desde un pago toma el acreedor por el beneficiario (descripción "Jayor SRL")', (await chq('40001'))[0]?.acreedor_id === aJayor, JSON.stringify((await chq('40001'))[0]))

// ================================================================ 9. "Puede ser el cheque X"
await servidor()
const chequeDe = alServidor(async (numero, importe, extra = {}) => (await val(
  `insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, beneficiario, importe, fecha_emision, fecha_pago, estado, debitado_en, creado_por)
   values ('india', $1, 'ECHEQ', $2, 'X', $3, $4, $4, $5, $6, 'x') returning id`,
  [extra.cuenta ?? chequera, numero, importe, dia(-3), extra.estado ?? 'EMITIDO', extra.estado === 'DEBITADO' ? dia(-1) : null])).id)
const movDe = alServidor(async (importe, extra = {}) => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, numero_cheque)
   values ('india', $1, $2, $3, $4, $5, $6, 'A_REVISAR', $7) returning id`,
  [chequera, dia(-1), extra.desc ?? 'DEBITO CHEQUE CAMARA', importe, `h-${nro++}`, extra.categoria ?? 'CHEQUE_PAGADO', extra.numero ?? null])).id)
const chS1 = await chequeDe('31001', 1000)
const mS1 = await movDe(-1000.5)
const sug = async (m) => filas(`select cheque_id, numero from movimientos_cheque_sugerido where movimiento_id = $1`, [m])
check('[9] movimiento de cheque sin número, un solo cheque por el mismo importe (tolerancia $1): se sugiere', (await sug(mS1))[0]?.cheque_id === chS1 && (await sug(mS1))[0]?.numero === '31001')
check('[9] solo sugiere: el cheque sigue EMITIDO y el movimiento sin vincular', (await val(`select estado from cheques where id = $1`, [chS1])).estado === 'EMITIDO' && (await val(`select cheque_id from movimientos_bancarios where id = $1`, [mS1])).cheque_id === null)
check('[9] pasada la tolerancia ($1,01 de diferencia): no se sugiere', (await sug(await movDe(-1001.01))).length === 0)
const chS2 = await chequeDe('31002', 2000)
await chequeDe('31003', 2000.8)
check('[9] si hay dos cheques posibles por ese importe, no se sugiere ninguno', (await sug(await movDe(-2000))).length === 0)
check('[9] si el movimiento trae número de cheque, no se sugiere (se busca por número)', (await sug(await movDe(-1000, { numero: '31001' }))).length === 0)
await chequeDe('31004', 3000, { estado: 'DEBITADO' })
await chequeDe('31005', 4000, { estado: 'ANULADO' })
check('[9] un cheque ya debitado o anulado no se sugiere', (await sug(await movDe(-3000))).length === 0 && (await sug(await movDe(-4000))).length === 0)
check('[9] un movimiento que no es de cheque (categoría) no recibe sugerencia', (await sug(await movDe(-1000, { categoria: 'PAGO' }))).length === 0)
check('[9] un ingreso no recibe sugerencia', (await sug(await movDe(1000))).length === 0)
await como('solober@prueba.com')
check('[9] quien no ve la empresa no ve las sugerencias', (await filas(`select * from movimientos_cheque_sugerido`)).length === 0)
await como('teso@prueba.com')
check('[9] Tesorería la ve', (await filas(`select * from movimientos_cheque_sugerido where movimiento_id = $1`, [mS1])).length === 1)
// Marcar debitado sigue a mano y con el movimiento elegido por la persona.
await db.query(`select marcar_cheque_debitado($1, '31001', $2, $3)`, [chS1, dia(-1), mS1])
check('[9] marcar debitado sigue siendo a mano: con el número confirmado y el movimiento, el cheque pasa a DEBITADO y sale de las sugerencias', (await val(`select estado from cheques where id = $1`, [chS1])).estado === 'DEBITADO' && (await sug(mS1)).length === 0)
void chS2

// ================================================================ Arreglos de la revisión (REVISION_TANDA_E)
// [1] tarjeta no espera comprobante bancario; [4] backfill solo de SISTEMA.
await servidor()
const fTj = await factura('india', pA, 810)
await como('aprob@prueba.com')
await db.query(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'TARJETA', $2)`, [fTj, { cuenta_origen: 'BANCO PRUEBA CC-0001' }])
const pTj = (await val(`select pago_id from pagos_facturas where factura_id = $1`, [fTj])).pago_id
check('[R1] aprobar ya pagada con tarjeta: el pago no queda esperando comprobante', (await pagoDe(pTj)).falta_comprobante === false)
const fTarj2 = await factura('india', pA, 120)
await db.query(`select aprobar_factura($1, 'GASTOS VARIOS', 'TARJETA', null::integer, greatest(hoy_ar(), (select vencimiento from facturas where id = $1)))`, [fTarj2])
check('[R2] factura de tarjeta pagada al aprobar: sin fila en pagos (la pantalla muestra "Tarjeta de crédito")', (await val(`select count(*)::int n from pagos_facturas where factura_id = $1`, [fTarj2])).n === 0 && (await fac(fTarj2)).estado === 'PAGADA')
// El backfill de la migración, corrido de nuevo sobre filas de cada tipo.
await servidor()
const bf = async (medio, gestion) => (await val(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, descripcion, gestion, estado) values ('india', $1, 10, $2, 'x', 'Factura 1-1 pagada antes de aprobar', $3, 'CARGADO') returning id`, [hoy, medio, gestion])).id
const bfTarjeta = await bf('TARJETA', 'SISTEMA'), bfHoja = await bf('TRANSFERENCIA', 'HOJA'), bfOk = await bf('TRANSFERENCIA', 'SISTEMA')
const backfill = readFileSync(join(dir, '0036_pagos_y_cheques.sql'), 'utf8').match(/update pagos set falta_comprobante = true[\s\S]*?;/)[0]
await db.exec(backfill)
check('[R4] el backfill marca el pago bancario del sistema, pero no el de tarjeta ni el de la hoja',
  (await pagoDe(bfOk)).falta_comprobante === true && (await pagoDe(bfTarjeta)).falta_comprobante === false && (await pagoDe(bfHoja)).falta_comprobante === false)

// [3] duplicado: destino en texto (pagos de la hoja) y S/D.
const hojaPago = async (destino, importe) => (await val(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, proveedor_destino, gestion, estado) values ('india', $1, $2, 'TRANSFERENCIA', 'x', $3, 'HOJA', 'CARGADO') returning id`, [dia(-1), importe, destino])).id
await hojaPago('Otro Distinto SA', 7777)
await hojaPago('S/D', 7778)
await hojaPago('PROVEEDOR UNO, S.A.', 7779)
await como('teso@prueba.com')
check('[R3] mismo importe y fecha pero destino en texto distinto: no es duplicado', (await pagoDe(await registrar({ importe: 7777, proveedor_id: pA, fecha: dia(-1) }))).posible_duplicado === null)
check('[R3] destino "S/D" de la hoja: se trata como sin destino y sí avisa', /7778/.test((await pagoDe(await registrar({ importe: 7778, proveedor_id: pA, fecha: dia(-1) }))).posible_duplicado ?? ''))
check('[R3] el mismo proveedor escrito en texto (mayúsculas y puntos) sí avisa', /7779/.test((await pagoDe(await registrar({ importe: 7779, proveedor_id: pA, fecha: dia(-1) }))).posible_duplicado ?? ''))

// [5] cheque con el número de uno rechazado: aviso claro, sin "duplicate key".
await servidor()
await db.query(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, beneficiario, importe, fecha_emision, fecha_pago, estado, creado_por)
  values ('india', $1, 'ECHEQ', '20001', 'X', 10, $2, $2, 'RECHAZADO', 'x')`, [chequera, dia(-5)])
await como('teso@prueba.com')
const pRj = await registrar({ importe: 330, medio: 'ECHEQ', numero_cheque: '20001', fecha_acreditacion: dia(9) })
check('[R5] cheque con el número de uno rechazado: el pago se carga y el aviso dice qué hacer, sin "duplicate key"',
  (await pagoDe(pRj)).estado === 'CARGADO' && /anulado o rechazado/.test((await pagoDe(pRj)).aviso_cheque) && /cargalo desde Cheques/.test((await pagoDe(pRj)).aviso_cheque) && !/duplicate/i.test((await pagoDe(pRj)).aviso_cheque))

// [7] quitar: pago anulado no; el pago de caja no vuelve a la lista.
await falla('[R7] quitar el comprobante de un pago anulado: no', `select quitar_comprobante_pago($1)`, [pComp], /anulado/)
const pCaja = await registrar({ importe: 15, medio: 'CAJA', cuenta_origen: 'Caja', comprobante_path: `${org}/india/caja.pdf` })
await db.query(`select quitar_comprobante_pago($1)`, [pCaja])
check('[R7] un pago de caja sin comprobante no pasa a "falta comprobante"', (await pagoDe(pCaja)).falta_comprobante === false)

// [8] un cheque con dos movimientos del mismo importe: no se sugiere a ninguno.
const chDos = await chequeDe('32001', 5555)
const mDos1 = await movDe(-5555)
const mDos2 = await movDe(-5555)
check('[R8] un cheque que coincide con dos movimientos: no se sugiere en ninguno', (await sug(mDos1)).length === 0 && (await sug(mDos2)).length === 0)
await servidor()
await db.query(`delete from movimientos_bancarios where id = $1`, [mDos2])
check('[R8] con un solo movimiento vuelve a sugerirse', (await sug(mDos1))[0]?.cheque_id === chDos)


// ================================================================ Las pruebas de las otras migraciones siguen siendo las de siempre
check('registrar_pago sin cheque ni duplicado sigue igual: devuelve el id y deja la auditoría PAGO_CARGADO', (await val(`select count(*)::int n from auditoria where accion = 'PAGO_CARGADO'`)).n > 10)

console.log(`\n${ok} OK · ${mal} MAL`)
await db.close()
process.exit(mal ? 1 : 0)
