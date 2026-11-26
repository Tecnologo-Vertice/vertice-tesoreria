// Pruebas de 0029 (T-205): saldos de tenencia con origen TENENCIA, anulación hecha a mano en Xubio, vista
// de lo bancario pendiente en Xubio y control diario con anulaciones de pagos y cheques.
// Importes, CUIT y nombres ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_0029.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
async function falla(nombre, sql, p, patron) {
  try { await db.query(sql, p); check(nombre, false, 'no falló') }
  catch (e) { check(nombre, patron.test(e.message), e.message.slice(0, 140)) }
}
const como = async (email) => {
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const servidor = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const n = (x) => Number(x)

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
const migraciones = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
for (const f of migraciones) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (hasta 0029)', migraciones.includes('0029_cabos_tesoreria.sql'))

// ---------------------------------------------------------------- Datos de prueba (ficticios)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('adm@prueba.com', 'Administración', 'ADMINISTRACION', true),
    ('admin@prueba.com', 'Admin', 'ADMIN', true), ('ctrl@prueba.com', 'Controller', 'CONTROLLER', true),
    ('admber@prueba.com', 'Adm. Beratung', 'ADMINISTRACION', false);
  insert into usuarios_empresas (email, empresa_id) values ('admber@prueba.com', 'beratung');
  insert into cuentas_contables (empresa_id, nombre) values (null, 'Banco Prueba CA');
`)
const ccBanco = (await val(`select id from cuentas_contables where nombre = 'Banco Prueba CA'`)).id
const ca = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, cuenta_contable_id)
  values ('india', 'BANCO PRUEBA CA', 'HIPOTECARIO', 'CA', '30999999991', $1) returning id`, [ccBanco])).id
const fci = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuenta_madre_id)
  values ('india', 'BANCO PRUEBA FCI', 'HIPOTECARIO', 'FCI', $1) returning id`, [ca])).id
const caBer = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco)
  values ('beratung', 'BERATUNG CA', 'GALICIA', 'CA', '30999999992') returning id`)).id
const prov = (await val(`insert into proveedores (cuit, nombre) values ('30700000009', 'Proveedor Ficticio SA') returning id`)).id

const imp = async (p) => (await val(`select importar_extracto($1) r`, [p])).r
const ext = (cuenta, hash, extra = {}) => ({ cuenta_origen_id: cuenta, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash, formato: 'PRUEBA' }, movimientos: [], ...extra })

// ================================================================ 1. importar_extracto: a_revisar y origen de los saldos
await servidor()
let r = await imp(ext(ca, 'csv-1', { movimientos: [
  { fecha: '2026-11-23', descripcion: 'TRANSFERENCIA RECIBIDA', importe: 1000, saldo: 1000 },
  { fecha: '2026-11-24', descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 994 },
  { fecha: '2026-11-24', descripcion: 'MOVIMIENTO SIN REGLA', importe: -4, saldo: 990 },
] }))
check('llamada de siempre (sin origen_saldos): igual que antes, 3 nuevos', r.nuevos === 3 && r.movimientos === 3 && r.repetido === false, JSON.stringify(r))
check('…devuelve a_revisar: los nuevos que ninguna regla reconoció (2: transferencia y el raro)', r.a_revisar === 2, JSON.stringify(r))
check('…y los saldos quedan con origen EXTRACTO', (await filas(`select distinct origen from saldos_bancarios where cuenta_origen_id = $1`, [ca])).map((x) => x.origen).join() === 'EXTRACTO')
check('…con origen_saldos EXTRACTO en la respuesta y 2 saldos de cierre', r.origen_saldos === 'EXTRACTO' && r.saldos === 2, JSON.stringify(r))
r = await imp(ext(ca, 'csv-1', { movimientos: [{ fecha: '2026-11-23', descripcion: 'X', importe: 1, saldo: 1 }] }))
check('repetido: no importa nada y responde con la misma forma (nuevos 0, a_revisar 0)', r.repetido === true && r.nuevos === 0 && r.a_revisar === 0)

// Tenencia del FCI: saldos sin movimientos, origen TENENCIA
r = await imp(ext(fci, 'pdf-1', { origen_saldos: 'TENENCIA', saldos: [{ fecha: '2026-11-24', saldo: 7902.63 }, { fecha: '2026-11-25', saldo: 7907.01 }] }))
check('tenencia: 2 saldos con origen TENENCIA', r.saldos === 2 && r.origen_saldos === 'TENENCIA' && r.nuevos === 0, JSON.stringify(r))
check('…en saldos_bancarios figuran como TENENCIA (no EXTRACTO)',
  (await filas(`select origen from saldos_bancarios where cuenta_origen_id = $1 order by fecha`, [fci])).every((x) => x.origen === 'TENENCIA'))
const e1 = await val(`select desde, hasta from extractos where cuenta_origen_id = $1 and archivo_hash = 'pdf-1'`, [fci])
check('…el extracto toma el período de los saldos (24 al 25/11)', e1.desde.toISOString().startsWith('2026-11-24') && e1.hasta.toISOString().startsWith('2026-11-25'))
const c25 = await val(`select rendimiento, estado, origen from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = '2026-11-25'`, [fci])
check('…la conciliación saca el rendimiento 4,38 de la tenencia (origen TENENCIA, OK)', n(c25.rendimiento) === 4.38 && c25.estado === 'OK' && c25.origen === 'TENENCIA', JSON.stringify(c25))
check('…la auditoría dice IMPORTAR_TENENCIA', (await val(`select count(*)::int n from auditoria where accion = 'IMPORTAR_TENENCIA' and detalle like '%2 saldo(s) de tenencia%'`)).n === 1)

// Un saldo MANUAL no se pisa; uno de EXTRACTO sí pasa a TENENCIA
await como('teso@prueba.com')
await db.query(`select registrar_saldo($1, '2026-11-26', 8000, 'MANUAL')`, [fci])
await servidor()
await db.query(`insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, '2026-11-27', 'india', 1, 'EXTRACTO', 'x')`, [fci])
r = await imp(ext(fci, 'pdf-2', { origen_saldos: 'TENENCIA', saldos: [{ fecha: '2026-11-26', saldo: 9999 }, { fecha: '2026-11-27', saldo: 8010.5 }] }))
const s26 = await val(`select saldo, origen from saldos_bancarios where cuenta_origen_id = $1 and fecha = '2026-11-26'`, [fci])
const s27 = await val(`select saldo, origen from saldos_bancarios where cuenta_origen_id = $1 and fecha = '2026-11-27'`, [fci])
check('tenencia sobre un saldo cargado a mano: no lo pisa', n(s26.saldo) === 8000 && s26.origen === 'MANUAL' && r.saldos === 1, JSON.stringify({ s26, r }))
check('tenencia sobre un saldo de EXTRACTO: lo reemplaza y queda TENENCIA', n(s27.saldo) === 8010.5 && s27.origen === 'TENENCIA')

await falla('tenencia a una caja de ahorro: rechazada', `select importar_extracto($1)`, [ext(ca, 'pdf-3', { origen_saldos: 'TENENCIA', saldos: [{ fecha: '2026-11-25', saldo: 1 }] })], /cuenta FCI o remunerada/)
await falla('tenencia con movimientos: rechazada (entran por la cuenta madre)', `select importar_extracto($1)`,
  [ext(fci, 'pdf-4', { origen_saldos: 'TENENCIA', movimientos: [{ fecha: '2026-11-25', descripcion: 'SUSCRIPCION', importe: 10, saldo: 10 }] })], /solo saldos/)
await falla('origen_saldos inválido: rechazado', `select importar_extracto($1)`, [ext(ca, 'csv-9', { origen_saldos: 'MANUAL' })], /Origen de saldos inválido/)
check('las fallas no dejaron extractos a medias', (await val(`select count(*)::int n from extractos where archivo_hash in ('pdf-3', 'pdf-4', 'csv-9')`)).n === 0)
await como('teso@prueba.com')
await falla('una persona no llama a importar_extracto directo (solo el servidor)', `select importar_extracto($1)`, [ext(ca, 'csv-10')], /permission denied|permiso/i)

// ================================================================ 2. Anulación hecha a mano en Xubio
await servidor()
const pago = async (empresa, extra) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, forma_carga_xubio, xubio_id, estado, anulado_por, anulado_en, motivo_anulacion, anulacion_xubio, cuenta_origen_id)
   values ($1, $2, '2026-11-20', $3, 'TRANSFERENCIA', 'teso@prueba.com', $4, $5, 'ANULADO', 'adm@prueba.com', now(), 'Pago duplicado', $6, $7) returning id`,
  [empresa, prov, extra.importe ?? 1500, extra.forma ?? 'ORDEN_PAGO', extra.xubio ?? 'OP-7001', extra.anulacion ?? 'ERROR', extra.cuenta ?? null])).id
const pagoOP = await pago('india', { anulacion: 'ERROR', cuenta: ca })
const pagoSF = await pago('india', { forma: 'SALIDA_FONDOS', xubio: '7002', anulacion: 'PENDIENTE', importe: 250 })
const pagoVivo = (await val(`insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, estado) values ('india', $1, '2026-11-20', 10, 'TRANSFERENCIA', 'x', 'CARGADO') returning id`, [prov])).id
const pagoBer = await pago('beratung', { anulacion: 'ERROR' })
const cheque = (await val(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, beneficiario, importe, fecha_emision, fecha_pago, estado, xubio_emision_id, anulado_por, anulado_en, motivo_anulacion, anulacion_xubio, creado_por)
  values ('india', $1, 'ECHEQ', '00012345', 'Proveedor Ficticio SA', 3000, '2026-11-20', '2026-12-05', 'ANULADO', 'OP-8001', 'adm@prueba.com', now(), 'Se pagó por transferencia', 'PENDIENTE', 'teso@prueba.com') returning id`, [ca])).id
// Asiento subido y anulado, con id de Xubio que no es número: el robot lo deja en ERROR.
await db.exec(`begin`)
const asiento = (await val(`insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, estado_xubio, xubio_id, anulado_por, anulado_en, motivo_anulacion, anulacion_xubio, creado_por)
  values ('india', $1, '2026-11-24', 'BANCARIO_DIARIO', 'Asiento banco prueba 24/11', 'SUBIDA', 'AS-1', 'admin@prueba.com', now(), 'Mal clasificado', 'ERROR', 'servidor') returning id`, [ca])).id
await db.query(`insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber) values ($1, 'IMPUESTO DEB/CRED BANCARIO', 6, 0), ($1, 'Banco Prueba CA', 0, 6)`, [asiento])
await db.exec(`commit`)

const marcar = `select marcar_anulacion_xubio_manual($1, $2, $3)`
await como('teso@prueba.com')
await falla('Tesorería no marca anulaciones de Xubio (rol)', marcar, ['PAGO', pagoOP, 'Anulada OP 0001-00000123'], /no puede hacer esta acción/)
await como('ctrl@prueba.com')
await falla('Controller tampoco', marcar, ['PAGO', pagoOP, 'x'], /no puede hacer esta acción/)
await como('adm@prueba.com')
await falla('sin nota no se marca', marcar, ['PAGO', pagoOP, '  '], /Falta la nota/)
await falla('tipo inválido', marcar, ['FACTURA', pagoOP, 'x'], /Tipo inválido/)
await falla('id inexistente', marcar, ['PAGO', '00000000-0000-0000-0000-000000000000', 'x'], /No existe/)
await falla('un pago que no está anulado en el sistema no se marca', marcar, ['PAGO', pagoVivo, 'x'], /No está anulado/)
await como('admber@prueba.com')
await falla('Administración de otra empresa no marca un pago de India', marcar, ['PAGO', pagoOP, 'x'], /No tenés acceso/)

await como('adm@prueba.com')
await db.query(marcar, ['PAGO', pagoOP, 'Anulada en Xubio: OP 0001-00000123 el 26/11'])
let p = await val(`select anulacion_xubio, anulacion_manual_por, anulacion_manual_nota, anulacion_manual_en is not null as con_fecha from pagos where id = $1`, [pagoOP])
check('pago (orden de pago en ERROR) → HECHA, con quién, cuándo y la nota', p.anulacion_xubio === 'HECHA' && p.anulacion_manual_por === 'adm@prueba.com' && p.con_fecha && p.anulacion_manual_nota.includes('0001-00000123'), JSON.stringify(p))
await servidor()
check('…queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'ANULACION_XUBIO_MANUAL' and entidad = 'PAGO' and entidad_id = $1 and detalle like '%antes ERROR%'`, [pagoOP])).n === 1)
check('…y en procesos_log (XUBIO_ANULACIONES, OK, REAL)', (await val(`select count(*)::int n from procesos_log where proceso = 'XUBIO_ANULACIONES' and entidad = 'ANULAR_PAGO' and entidad_id = $1 and estado = 'OK' and modo = 'REAL'`, [pagoOP])).n === 1)
await como('adm@prueba.com')
await falla('marcarla otra vez: ya figura hecha', marcar, ['PAGO', pagoOP, 'otra'], /ya figura hecha/)

await como('admin@prueba.com')
await db.query(marcar, ['CHEQUE', cheque, 'Anulada la OP de emisión 0001-00000456'])
check('cheque PENDIENTE (Admin) → HECHA', (await val(`select anulacion_xubio from cheques where id = $1`, [cheque])).anulacion_xubio === 'HECHA')
await db.query(marcar, ['ASIENTO', asiento, 'Borrado a mano en Xubio'])
check('asiento en ERROR → HECHA', (await val(`select anulacion_xubio, anulacion_manual_por from asientos where id = $1`, [asiento])).anulacion_manual_por === 'admin@prueba.com')
check('el cheque sigue ANULADO en el sistema (solo cambia lo de Xubio)', (await val(`select estado from cheques where id = $1`, [cheque])).estado === 'ANULADO')

// ================================================================ 3. Vista xubio_bancos_pendientes
await servidor()
// Comprobante sin aprobar, comprobante con error y asiento pendiente
const comp = async (numero, estado, estadoXubio, error = null) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, punto_venta, numero, fecha, vencimiento, neto, total, origen, estado, estado_xubio, xubio_error, cuenta_contable, cuenta_origen_extracto_id)
   values ('india', $1, 'Extracto Bancario', 9990, $2, '2026-11-24', '2026-11-24', 100, 100, 'EXTRACTO', $3, $4, $5, 'GASTOS BANCARIOS', $6) returning id`,
  [prov, numero, estado, estadoXubio, error, ca])).id
const cSinAprobar = await comp(20261124, 'PENDIENTE_APROBACION', 'PENDIENTE')
const cError = await comp(20261125, 'PAGADA', 'ERROR', 'Xubio respondió 400')
const cSubido = await comp(20261126, 'PAGADA', 'SUBIDA')
await db.exec(`begin`)
const aPend = (await val(`insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por) values ('india', $1, '2026-11-25', 'BANCARIO_DIARIO', 'Asiento banco prueba 25/11', 'servidor') returning id`, [ca])).id
await db.query(`insert into asiento_lineas (asiento_id, cuenta_contable, debe, haber) values ($1, 'IMPUESTO DEB/CRED BANCARIO', 12, 0), ($1, 'Banco Prueba CA', 0, 12)`, [aPend])
await db.exec(`commit`)
await db.query(`insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle)
  select organizacion_id, 'india', 'XUBIO_ASIENTOS', 'PRUEBA', 'ASIENTO', $1, 'PRUEBA_OK', 'En seco: asiento de 2 líneas por 12' from empresas where id = 'india'`, [aPend])

await como('adm@prueba.com')
const pend = await filas(`select tipo, id, estado, a_mano, importe::float as importe, error, ultimo_intento_estado, ultimo_intento_modo, ultimo_intento_detalle from xubio_bancos_pendientes order by tipo, fecha`)
const de = (id) => pend.find((x) => x.id === id)
check('comprobante sin aprobar: FALTA_APROBAR', de(cSinAprobar)?.estado === 'FALTA_APROBAR' && de(cSinAprobar)?.tipo === 'COMPROBANTE')
check('comprobante con error: ERROR con el motivo', de(cError)?.estado === 'ERROR' && de(cError)?.error === 'Xubio respondió 400')
check('comprobante ya subido: no aparece', !de(cSubido))
check('asiento pendiente: PENDIENTE, importe 12 y el último intento (en seco)', de(aPend)?.estado === 'PENDIENTE' && de(aPend)?.importe === 12 && de(aPend)?.ultimo_intento_modo === 'PRUEBA' && /En seco/.test(de(aPend)?.ultimo_intento_detalle ?? ''), JSON.stringify(de(aPend)))
check('pago anulado como salida de fondos con id numérico: lo hace el robot (a_mano = false)', de(pagoSF)?.tipo === 'ANULAR_PAGO' && de(pagoSF)?.a_mano === false)
check('pago de Beratung (orden de pago): a mano', de(pagoBer)?.a_mano === true && de(pagoBer)?.estado === 'ERROR')
check('lo marcado a mano ya no aparece (pago, cheque, asiento)', !de(pagoOP) && !de(cheque) && !de(asiento))
await como('admber@prueba.com')
const soloBer = await filas(`select empresa_id from xubio_bancos_pendientes`)
check('quien ve solo Beratung ve solo lo de Beratung', soloBer.length === 1 && soloBer[0].empresa_id === 'beratung', JSON.stringify(soloBer))
await como('teso@prueba.com')
const teso = await filas(`select id, ultimo_intento_detalle from xubio_bancos_pendientes`)
check('Tesorería ve la lista, sin el detalle de procesos_log (no lo puede leer)', teso.some((x) => x.id === aPend) && teso.find((x) => x.id === aPend).ultimo_intento_detalle === null)
await servidor()
check('anon no lee xubio_bancos_pendientes', !(await val(`select has_table_privilege('anon', 'xubio_bancos_pendientes', 'select') p`)).p)
check('anon no ejecuta marcar_anulacion_xubio_manual', !(await val(`select has_function_privilege('anon', 'marcar_anulacion_xubio_manual(text, uuid, text)', 'execute') p`)).p)
check('authenticated no ejecuta importar_extracto', !(await val(`select has_function_privilege('authenticated', 'importar_extracto(jsonb)', 'execute') p`)).p)

// ================================================================ 4. Control diario
await como('adm@prueba.com')
const ctrl = await filas(`select control, sujeto, detalle from control_bancos where control = 'ANULAR_EN_XUBIO'`)
check('control diario: avisa el pago de la salida de fondos pendiente de anular', ctrl.some((x) => /Pago 7002/.test(x.detalle)), JSON.stringify(ctrl))
check('…y el de Beratung en ERROR, con "anularlo a mano"', ctrl.some((x) => /anularlo a mano/.test(x.detalle) && /Pago OP-7001/.test(x.detalle)))
check('…lo ya marcado a mano no se avisa (cheque y asiento)', !ctrl.some((x) => /00012345/.test(x.detalle)) && !ctrl.some((x) => x.sujeto === 'Asiento banco prueba 24/11'))
check('el resto del control sigue (falta extracto, comprobantes)', (await val(`select count(*)::int n from control_bancos where control in ('FALTA_EXTRACTO', 'COMPROBANTE_ERROR', 'COMPROBANTE_PENDIENTE')`)).n >= 3)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
