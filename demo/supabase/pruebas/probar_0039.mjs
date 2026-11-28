// Pruebas de 0039: robot de e-cheqs (Tanda 5 de PARIDAD_COMPLETA.md, 27/11/2026).
//   1. Panel: pedir, cancelar y ver el estado; permisos; que no se pisen las corridas.
//   2. Estados de la corrida: pedida → corriendo → terminada | error | sin fin; corrida automática de las 13 y las 17 h.
//   3. Lo que se le entrega al robot: e-cheqs para subir (con bloqueados) y cheques cobrados para debitar.
//   4. Lo que el robot devuelve de los e-cheqs: queda en el cheque, en los pagos y en procesos_log, y es idempotente.
//   5. Lo que el robot devuelve de los débitos. 6. Panel completo. 7. Seguridad.
// Datos ficticios. Las fechas salen siempre de hoy_ar(), nunca de current_date.
// Uso (desde demo/): node supabase/pruebas/probar_0039.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

process.on('uncaughtException', (e) => { console.log('ERROR', String(e.message).slice(0, 400)); process.exit(1) })
const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
const error = async (sql, p = []) => { try { await db.query(sql, p); return null } catch (e) { return e.message } }
const falla = async (nombre, sql, p, patron) => { const e = await error(sql, p); check(nombre, e !== null && patron.test(e), e ?? 'no falló') }
const como = async (email) => {
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const comoAnon = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role anon`) }
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
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (con 0039)', true)
// Re-ejecutable: aplicarla otra vez no rompe nada ni pisa lo que alguien cambió a mano.
{
  await db.exec(`update empresas set robot_echeqs = false where id = 'ysd'`)
  let e = null
  try { await db.exec(readFileSync(join(dir, '0039_robot_echeqs.sql'), 'utf8')) } catch (x) { e = x.message }
  check('0039 se puede volver a ejecutar', e === null, e ?? '')
  check('... y no vuelve a habilitar una empresa que alguien apagó', (await val(`select robot_echeqs r from empresas where id = 'ysd'`)).r === false)
  await db.exec(`update empresas set robot_echeqs = true where id = 'ysd'`)
}

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMINISTRACION', true),
    ('aprob@prueba.com', 'Aprob', 'APROBADOR', true), ('dire@prueba.com', 'Dire', 'DIRECCION', true),
    ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
check('el robot queda habilitado en las cuatro empresas de Xubio del Apps Script y no en Vértice BI ni en Ralpharma',
  (await filas(`select id from empresas where robot_echeqs order by id`)).map((x) => x.id).join() === 'beratung,controlb,india,ysd')
const nombres = (await val(`select robot_nombre_empresa('Beratung S.A.') a, robot_nombre_empresa('INDIA ADV S.A.') b, robot_nombre_empresa('Control B') c,
  robot_nombre_empresa('YSD Pharma S.A.') d, robot_nombre_empresa('Farma Control S.A.') e`))
check('los nombres de empresa son los del config.json del robot', nombres.a === 'Beratung S.A.' && nombres.b === 'INDIA ADV S.A.' && nombres.c === 'Control B' && nombres.d === 'YSD' && nombres.e === '', JSON.stringify(nombres))

const prov = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre) values ($1, $2) returning id`, [cuit, nombre])).id
const pGamma = await prov('30710000011', 'Laboratorios Gamma SA')
const pDelta = await prov('30710000012', 'Delta Servicios SRL')
const cuenta = async (empresa, nombre, banco, clase, tipo) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, tipo_cuenta) values ($1, $2, $3, $4, $5) returning id`, [empresa, nombre, banco, clase, tipo])).id
const cIndia = await cuenta('india', 'E-CHEQ ICBC 0001', 'ICBC', 'ECHEQ', 4)
const cBera = await cuenta('beratung', 'BANCO GALICIA E-CHEQ', 'GALICIA', 'ECHEQ', 4)
const cBancoIndia = await cuenta('india', 'BANCO ICBC CC 0002', 'ICBC', 'CC', 2)
const cRobles = await cuenta('robles', 'E-CHEQ ROBLES', 'ICBC', 'ECHEQ', 4)
const cVertice = await cuenta('vertice', 'E-CHEQ VERTICE', 'ICBC', 'ECHEQ', 4)

let nroF = 800
const factura = async (extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, gestion, cuenta_contable, estado_xubio, xubio_id)
   values ($1, $2, 'Factura A', 'A', 1, $3, $4, $5, $6, $6, 'PARA_PAGAR', 0, 'SISTEMA', 'PROVEEDORES LOCALES', $7::estado_xubio, $8) returning id`,
  [extra.empresa ?? 'india', extra.proveedor ?? pGamma, extra.numero ?? nroF++, dia(-20), dia(5), extra.total ?? 1000, extra.estadoXubio ?? 'SUBIDA', extra.xubioId === undefined ? '9001' : extra.xubioId])).id
// Un pago como el que le toca al robot: contabilizado en el panel (REVISADO, con su cuenta contable) y marcado CARGAR_A_MANO.
const pago = async (extra = {}) => {
  const id = await pagoNuevo(extra)
  const est = extra.estado ?? 'REVISADO'
  await db.query(`update pagos set estado = $2::estado_pago, cuenta_contable = $3, xubio_id = case when $2 = 'CONTABILIZADO' then 'OP-1' end, contabilizado_por = case when $2 = 'CONTABILIZADO' then 'u' end where id = $1`,
    [id, est, est === 'CARGADO' ? null : 'PROVEEDORES LOCALES'])
  return id
}
const pagoNuevo = async (extra = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, estado, gestion, numero_cheque, fecha_acreditacion, tipo_cheque, estado_xubio_pago, proveedor_destino)
   values ($1, $2, $3, $4, $5::metodo_pago, 'teso@prueba.com', 'SIN_FACTURA', 'ORDEN_PAGO', $6::estado_pago, $7, $8, $9, 'ECHEQ', $10, 'GAMMA S.A.') returning id`,
  [extra.empresa ?? 'india', extra.proveedor === undefined ? pGamma : extra.proveedor, extra.fecha ?? dia(-2), extra.importe ?? 1000, extra.medio ?? 'ECHEQ', 'CARGADO',
   extra.gestion ?? 'SISTEMA', extra.cheque ?? null, extra.vence ?? dia(20), extra.estadoXubioPago === undefined ? 'CARGAR_A_MANO' : extra.estadoXubioPago])).id
const vincular = async (pagoId, facturaId, importe) => db.query(`insert into pagos_facturas (pago_id, factura_id, importe) values ($1, $2, $3)`, [pagoId, facturaId, importe])
let nroC = 1000
const cheque = async (extra = {}) => {
  const numero = extra.numero ?? String(nroC++)
  const id = (await val(
    `insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, proveedor_id, beneficiario, importe, fecha_emision, fecha_pago, estado, debitado_en, creado_por)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'teso@prueba.com') returning id`,
    [extra.empresa ?? 'india', extra.cuenta ?? cIndia, extra.tipo ?? 'ECHEQ', numero, extra.proveedor === undefined ? pGamma : extra.proveedor, extra.beneficiario ?? 'Laboratorios Gamma SA',
     extra.importe ?? 1000, dia(-3), extra.fechaPago ?? dia(20), extra.estado ?? 'EMITIDO', extra.debitadoEn ?? null])).id
  for (const p of extra.pagos ?? []) await db.query(`insert into cheques_pagos (cheque_id, pago_id, importe) values ($1, $2, $3)`, [id, p.id, p.importe])
  return { id, numero }
}
const chq = async (id) => val(`select * from cheques where id = $1`, [id])
const pg = async (id) => val(`select * from pagos where id = $1`, [id])
const grupos = async (emp = null) => (await val(`select robot_grupos_op($1, $2) r`, [org, emp])).r
const candidatos = async (dias = 45, emp = null) => (await val(`select robot_candidatos_debito($1, $2, $3) r`, [org, dias, emp])).r
const resultado = async (r) => (await val(`select robot_registrar_resultados($1, $2::jsonb, true) r`, [org, JSON.stringify({ resultados: Array.isArray(r) ? r : [r] })])).r
const resultadoDeb = async (r) => (await val(`select robot_registrar_debitos($1, $2::jsonb, true) r`, [org, JSON.stringify({ resultados: Array.isArray(r) ? r : [r] })])).r
const logs = async (proceso, entidadId) => filas(`select * from procesos_log where proceso = $1 and entidad_id = $2 order by id`, [proceso, entidadId])
const panel = async (email) => { await como(email); const r = (await val(`select robot_estado_panel() r`)).r; await servidor(); return r }

// ================================================================ 1. Panel: pedir y cancelar
await como('teso@prueba.com')
let r = (await val(`select robot_pedir_corrida('real', 'op') r`)).r
check('[1] Tesorería pide una corrida', r.ok === true && /Corrida pedida: subida de e-cheqs en modo real/.test(r.mensaje), JSON.stringify(r))
await servidor()
const c1 = await val(`select * from robot_corridas where estado = 'PEDIDA'`)
check('[1] queda el pedido con quién, cuándo, modo y tipo', c1.pedido_por === 'teso@prueba.com' && c1.modo === 'real' && c1.tipo === 'op' && c1.origen === 'PANEL' && c1.organizacion_id === org)
check('[1] queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'ROBOT_PEDIR_CORRIDA' and entidad_id = $1`, [c1.id])).n === 1)
await como('teso@prueba.com')
r = (await val(`select robot_pedir_corrida('prueba', 'debito') r`)).r
check('[1] con una corrida pedida no se pisa: avisa quién la pidió', r.ok === false && /Ya hay una corrida pedida \(op · real\) por teso@prueba.com/.test(r.mensaje), JSON.stringify(r))
await servidor()
check('[1] sigue habiendo una sola pedida', (await val(`select count(*)::int n from robot_corridas where estado = 'PEDIDA'`)).n === 1)
await falla('[1] la base no deja dos pedidas de la misma organización', `insert into robot_corridas (organizacion_id, modo, tipo) values ($1, 'prueba', 'op')`, [org], /duplicate|unique/)
await como('teso@prueba.com')
r = (await val(`select robot_cancelar_corrida() r`)).r
await servidor()
check('[1] cancelar saca el pedido', r.ok === true && /Pedido cancelado/.test(r.mensaje) && (await val(`select count(*)::int n from robot_corridas where estado = 'PEDIDA'`)).n === 0)
check('[1] el pedido cancelado queda en el historial como CANCELADA', (await val(`select estado from robot_corridas where id = $1`, [c1.id])).estado === 'CANCELADA')
await como('teso@prueba.com')
r = (await val(`select robot_cancelar_corrida() r`)).r
check('[1] cancelar sin pedido avisa que no había', r.ok === true && /No había ninguna corrida pedida/.test(r.mensaje))
r = (await val(`select robot_pedir_corrida('cualquiera', 'raro') r`)).r
const rara = await val(`select modo, tipo from robot_corridas where estado = 'PEDIDA'`)
check('[1] un modo o tipo raro cae en prueba y op (nunca en real por error)', r.ok === true && rara.modo === 'prueba' && rara.tipo === 'op')
await db.query(`select robot_cancelar_corrida()`)
await como('aprob@prueba.com')
await falla('[1] un aprobador no pide corridas', `select robot_pedir_corrida('real', 'op')`, [], /rol/)
await falla('[1] un aprobador no cancela', `select robot_cancelar_corrida()`, [], /rol/)
await falla('[1] un aprobador no ve el panel', `select robot_estado_panel()`, [], /rol/)
await como('dire@prueba.com')
await falla('[1] Dirección ve pero no pide', `select robot_pedir_corrida('real', 'op')`, [], /rol/)
check('[1] Dirección ve el panel', (await val(`select robot_estado_panel() r`)).r.habilitado === true)
await como('admin@prueba.com')
check('[1] Administración también pide', (await val(`select robot_pedir_corrida('prueba', 'ambos') r`)).r.ok === true)
await db.query(`select robot_cancelar_corrida()`)
await comoAnon()
await falla('[1] anon no ejecuta el panel', `select robot_estado_panel()`, [], /permission denied/)
await falla('[1] anon no pide corridas', `select robot_pedir_corrida('real', 'op')`, [], /permission denied/)
await como('teso@prueba.com')
for (const [fn, args] of [['robot_estado', `'${org}'`], ['robot_tomar_corrida', `'${org}', false`], ['robot_grupos_op', `'${org}', null`], ['robot_candidatos_debito', `'${org}', 45, null`],
  ['robot_registrar_resultados', `'${org}', '{}'::jsonb`], ['robot_registrar_debitos', `'${org}', '{}'::jsonb`], ['robot_registrar_aviso', `'${org}', 'X', ''`],
  ['robot_pedir_automatica', `'${org}', '13:00', false, false`], ['robot_organizacion', ``]]) {
  const e = await error(`select ${fn}(${args})`)
  check(`[1] permisos: ${fn} solo para el servidor`, e !== null && /permission denied/.test(e), e ?? 'no falló')
}
check('[1] una persona no escribe las tablas de control directamente', /permission denied|row-level/.test(await error(`insert into robot_corridas (organizacion_id, modo, tipo) values ('${org}', 'real', 'op')`) ?? ''))
check('[1] ... y las lee si su rol puede', (await filas(`select * from robot_corridas`)).length >= 3)
await como('aprob@prueba.com')
check('[1] un aprobador no lee las tablas de control', (await filas(`select * from robot_corridas`)).length === 0)
await servidor()

// ================================================================ 2. Estados de la corrida
check('[2] el servidor sabe para qué organización trabaja el robot', (await val(`select robot_organizacion() o`)).o === org)
let est = (await val(`select robot_estado($1) r`, [org])).r
check('[2] sin pedido: solicitada false, como el Apps Script', est.solicitada === false && est.modo === 'prueba' && est.tipo === 'op')
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('real', 'ambos')`)
await servidor()
est = (await val(`select robot_estado($1) r`, [org])).r
check('[2] con pedido: solicitada, quién, modo, tipo y fecha con hora de Argentina', est.solicitada === true && est.por === 'teso@prueba.com' && est.modo === 'real' && est.tipo === 'ambos' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(est.fecha), JSON.stringify(est))
check('[2] el robot que pregunta deja su señal de vida', (await val(`select ultimo_latido from robot_control where organizacion_id = $1`, [org])).ultimo_latido !== null)
let pan = await panel('teso@prueba.com')
check('[2] el panel dice "pedida"', pan.corrida.estado === 'pedida' && pan.solicitada === true, JSON.stringify(pan.corrida))
let t = (await val(`select robot_tomar_corrida($1, false) r`, [org])).r
check('[2] el robot toma la corrida (queda CORRIENDO)', t.tomada === true && t.modo === 'real' && (await val(`select count(*)::int n from robot_corridas where estado = 'CORRIENDO'`)).n === 1)
t = (await val(`select robot_tomar_corrida($1, false) r`, [org])).r
check('[2] tomarla dos veces no hace nada la segunda (no se pierde ni se repite)', t.tomada === false)
est = (await val(`select robot_estado($1) r`, [org])).r
check('[2] ya no figura como solicitada', est.solicitada === false)
pan = await panel('teso@prueba.com')
check('[2] el panel dice "corriendo"', pan.corrida.estado === 'corriendo' && pan.corrida.desde !== '' && pan.corrida.hasta === '')
await como('teso@prueba.com')
r = (await val(`select robot_pedir_corrida('real', 'op') r`)).r
check('[2] mientras el robot corre no se pide otra', r.ok === false && /El robot está corriendo desde las/.test(r.mensaje), JSON.stringify(r))
await servidor()
await db.query(`select robot_registrar_aviso($1, 'FIN_CORRIDA', 'ok')`, [org])
pan = await panel('teso@prueba.com')
check('[2] FIN_CORRIDA: el panel dice "terminada" y muestra cuándo', pan.corrida.estado === 'terminada' && pan.corrida.hasta !== '', JSON.stringify(pan.corrida))
check('[2] FIN_CORRIDA no figura como aviso a leer', pan.corrida.avisos.length === 0 && pan.ultimoAviso === 'FIN_CORRIDA')
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('prueba', 'op')`)
await servidor()
await db.query(`select robot_tomar_corrida($1, false)`, [org])
await db.query(`select robot_registrar_resultados($1, '{"aviso":"SESION_VENCIDA","detalle":"entrá a Xubio de nuevo"}'::jsonb)`, [org])
pan = await panel('teso@prueba.com')
check('[2] SESION_VENCIDA: "error", con el aviso y el detalle', pan.corrida.estado === 'error' && pan.corrida.aviso === 'SESION_VENCIDA' && /de nuevo/.test(pan.corrida.detalle) && pan.corrida.avisos.length === 1 && pan.corrida.avisos[0][1] === 'SESION_VENCIDA', JSON.stringify(pan.corrida))
check('[2] el último aviso queda a la vista del panel', pan.ultimoAviso === 'SESION_VENCIDA' && /de nuevo/.test(pan.ultimoAvisoDetalle))
check('[2] el aviso queda en procesos_log', (await val(`select count(*)::int n from procesos_log where proceso = 'ROBOT_ECHEQS' and entidad = 'AVISO' and estado = 'ERROR'`)).n === 1)
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('prueba', 'op')`)
await servidor()
await db.query(`select robot_tomar_corrida($1, false)`, [org])
await db.exec(`update robot_corridas set ultima_actividad = now() - interval '2 hours' where estado = 'CORRIENDO'`)
pan = await panel('teso@prueba.com')
check('[2] una corrida tomada hace horas y sin aviso de fin figura como "sin_fin"', pan.corrida.estado === 'sin_fin')
await como('teso@prueba.com')
check('[2] y no bloquea un pedido nuevo', (await val(`select robot_pedir_corrida('prueba', 'op') r`)).r.ok === true)
await db.query(`select robot_cancelar_corrida()`)
await servidor()
await db.exec(`update robot_corridas set estado = 'ERROR' where estado = 'CORRIENDO'`)
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('real', 'op')`)
await servidor()
await db.query(`select robot_tomar_corrida($1, true)`, [org])
const forz = await val(`select modo, modo_entregado, detalle from robot_corridas where estado = 'CORRIENDO'`)
check('[2] si el servidor no tiene el envío real, queda anotado que se entregó como prueba', forz.modo === 'real' && forz.modo_entregado === 'prueba' && /ROBOT_ECHEQS_ENVIO_REAL/.test(forz.detalle))
await db.query(`select robot_registrar_aviso($1, 'FIN_CORRIDA', '')`, [org])
const habil = (await val(`select es_dia_habil(hoy_ar()) h`)).h
await db.query(`insert into feriados (fecha, nombre) values (hoy_ar(), 'Feriado de prueba') on conflict do nothing`)
let a = (await val(`select robot_pedir_automatica($1, '13:00', false, false) r`, [org])).r
check('[2] la automática no se pide un feriado', a.pedida === false && /día hábil/.test(a.motivo), JSON.stringify(a))
await db.query(`delete from feriados where nombre = 'Feriado de prueba'`)
if (habil) {
  a = (await val(`select robot_pedir_automatica($1, '17:00', true, false) r`, [org])).r
  const ca = await val(`select * from robot_corridas where id = $1`, [a.corrida_id])
  check('[2] la automática de las 17 pide "ambos" en prueba (real solo si el servidor lo autoriza), con la reverificación en el texto',
    a.pedida === true && ca.tipo === 'ambos' && ca.modo === 'prueba' && ca.origen === 'AUTOMATICA' && /automático 17:00 · con reverificación/.test(ca.pedido_por), JSON.stringify(ca))
  a = (await val(`select robot_pedir_automatica($1, '17:00', false, true) r`, [org])).r
  check('[2] si ya hay una pedida, la automática no pisa nada', a.pedida === false && /ya hay una corrida pedida/.test(a.motivo))
  await db.exec(`update robot_corridas set estado = 'CANCELADA' where estado = 'PEDIDA'`)
  a = (await val(`select robot_pedir_automatica($1, '13:00', false, true) r`, [org])).r
  check('[2] la automática puede pedir en real cuando el servidor lo autoriza', a.pedida === true && (await val(`select modo from robot_corridas where id = $1`, [a.corrida_id])).modo === 'real')
  await db.exec(`update robot_corridas set estado = 'CANCELADA' where estado = 'PEDIDA'`)
} else check('[2] (fin de semana: la automática de días hábiles se prueba solo en su rechazo)', true)
check('[2] la automática queda en la auditoría solo cuando pide', (await val(`select count(*)::int n from auditoria where usuario = 'Robot e-cheqs automático'`)).n === (habil ? 2 : 0))
await db.exec(`update robot_corridas set estado = 'ERROR' where estado = 'CORRIENDO'`)

await db.exec(`update robot_corridas set tomada_en = tomada_en - interval '5 hours', ultima_actividad = null where tomada_en is not null`)

// ================================================================ 3. Lo que se le entrega al robot
const fOk = await factura({ numero: 1234 })
const fOk2 = await factura({ numero: 1235 })
const pA = await pago({ cheque: '5001', importe: 600 })
const pB = await pago({ cheque: '5001', importe: 400, fecha: dia(-1) })
await vincular(pA, fOk, 600); await vincular(pB, fOk2, 400)
const cA = await cheque({ numero: '5001', importe: 1000, pagos: [{ id: pA, importe: 600 }, { id: pB, importe: 400 }] })
const g0 = await grupos()
const gA = g0.grupos.find((x) => x.cheque === '5001')
check('[3] un cheque con dos pagos es un solo grupo (como en el Apps Script)', g0.grupos.filter((x) => x.cheque === '5001').length === 1 && gA !== undefined)
check('[3] el grupo trae los mismos campos que el robot espera', gA && gA.empresa === 'INDIA ADV S.A.' && gA.proveedor === 'Laboratorios Gamma SA' && gA.cuit === '30710000011' && gA.cuentaXubio === 'E-CHEQ ICBC 0001'
  && gA.importe === 1000 && gA.vencimiento === dia(20) && gA.fechaPago === dia(-2) && typeof gA.descripcion === 'string' && Array.isArray(gA.bancos) && Array.isArray(gA.facturas) && typeof gA.importesFactura === 'object', JSON.stringify(gA))
check('[3] las facturas van con su número y el importe de cada una', gA.facturas.join() === 'A-00001-00001234,A-00001-00001235' && gA.importesFactura['A-00001-00001234'] === 600 && gA.importesFactura['A-00001-00001235'] === 400, JSON.stringify(gA.importesFactura))
check('[3] filas e ids son los pagos del sistema', gA.ids.length === 2 && gA.ids.includes(pA) && gA.ids.includes(pB) && gA.filas.join() === gA.ids.join() && gA.chequeId === cA.id)
check('[3] los bancos a probar incluyen el de la cuenta', gA.bancos.includes('ICBC'), JSON.stringify(gA.bancos))
check('[3] la descripción es la de siempre ("Aplicar a FC ... · proveedor | ID ...")', /^Aplicar a FC A-00001-00001234, A-00001-00001235 · Laboratorios Gamma SA \| ID /.test(gA.descripcion), gA.descripcion)
const fPend = await factura({ numero: 1300, estadoXubio: 'PENDIENTE', xubioId: null })
const pBloq = await pago({ cheque: '5002', importe: 300 }); await vincular(pBloq, fPend, 300)
await cheque({ numero: '5002', importe: 300, pagos: [{ id: pBloq, importe: 300 }] })
const pHoja = await pago({ cheque: '5003', importe: 200, gestion: 'HOJA', estado: 'CONTABILIZADO', estadoXubioPago: 'CARGAR_A_MANO' })
await cheque({ numero: '5003', importe: 200, pagos: [{ id: pHoja, importe: 200 }] })
const pYa = await pago({ cheque: '5004', importe: 100, estado: 'CONTABILIZADO', estadoXubioPago: null })
await cheque({ numero: '5004', importe: 100, pagos: [{ id: pYa, importe: 100 }] })
const pAnul = await pago({ cheque: '5005', importe: 100, estado: 'ANULADO' })
await cheque({ numero: '5005', importe: 100, pagos: [{ id: pAnul, importe: 100 }] })
const pPag = await pago({ cheque: '5006', importe: 100 }); await cheque({ numero: '5006', importe: 100, tipo: 'PAGARE', pagos: [{ id: pPag, importe: 100 }] })
const pBco = await pago({ cheque: '5007', importe: 100 }); await cheque({ numero: '5007', importe: 100, tipo: 'FISICO', cuenta: cBancoIndia, pagos: [{ id: pBco, importe: 100 }] })
const pRob = await pago({ empresa: 'robles', cheque: '5008', importe: 100 }); await cheque({ empresa: 'robles', cuenta: cRobles, numero: '5008', importe: 100, pagos: [{ id: pRob, importe: 100 }] })
const pVer = await pago({ empresa: 'vertice', cheque: '5009', importe: 100 }); await cheque({ empresa: 'vertice', cuenta: cVertice, numero: '5009', importe: 100, pagos: [{ id: pVer, importe: 100 }] })
const pSinCh = await pago({ cheque: '5010', importe: 90 })
const pBera = await pago({ empresa: 'beratung', cheque: '5011', importe: 800, proveedor: pDelta })
await cheque({ empresa: 'beratung', cuenta: cBera, numero: '5011', importe: 800, proveedor: pDelta, beneficiario: 'Delta', pagos: [{ id: pBera, importe: 800 }] })
const g1 = await grupos()
const nros = g1.grupos.map((x) => x.cheque).sort().join()
check('[3] entran: los e-cheqs contabilizados y marcados CARGAR_A_MANO (del sistema y de la hoja) (de las empresas con robot)', nros === '5001,5003,5011', nros)
check('[3] no entran: contabilizados, anulados, pagarés, cuentas que no son de e-cheq, Ralpharma ni Vértice BI', !['5004', '5005', '5006', '5007', '5008', '5009'].some((n) => nros.includes(n)))
const bl = g1.bloqueados
check('[3] bloqueado: la factura no está en Xubio, con el motivo', bl.some((x) => x.cheque === '5002' && /la factura A-00001-00001300 no está en Xubio \(PENDIENTE\)/.test(x.motivo)), JSON.stringify(bl))
check('[3] bloqueado: el pago con e-cheq que no tiene su cheque en Cheques', bl.some((x) => x.cheque === '5010' && /no tiene su cheque/.test(x.motivo) && x.filas.includes(pSinCh)), JSON.stringify(bl))
check('[3] los bloqueados llevan empresa, cheque, proveedor, filas y motivo', bl.every((x) => x.empresa && x.cheque && 'proveedor' in x && Array.isArray(x.filas) && x.motivo))
const soloBera = await grupos(['beratung'])
check('[3] las empresas que ve la persona limitan la lista (Beratung no ve India)', soloBera.grupos.map((x) => x.cheque).join() === '5011' && soloBera.bloqueados.length === 0)
pan = await panel('solober@prueba.com')
check('[3] el panel de esa persona cuenta solo lo suyo', pan.pendientes === 1 && pan.grupos[0].cheque === '5011')

const dA = await cheque({ numero: '6001', importe: 700, estado: 'DEBITADO', debitadoEn: dia(-3) })
await cheque({ numero: '6002', importe: 700, estado: 'DEBITADO', debitadoEn: dia(-60) })
await cheque({ numero: 'AB123', importe: 700, estado: 'DEBITADO', debitadoEn: dia(-1) })
await cheque({ numero: '6003', importe: 700 })
await cheque({ empresa: 'robles', cuenta: cRobles, numero: '6004', importe: 100, estado: 'DEBITADO', debitadoEn: dia(-1) })
await cheque({ empresa: 'vertice', cuenta: cVertice, numero: '6005', importe: 100, estado: 'DEBITADO', debitadoEn: dia(-1) })
await cheque({ numero: '6006', importe: 100, tipo: 'PAGARE', estado: 'DEBITADO', debitadoEn: dia(-1) })
const dFisico = await cheque({ numero: '6007', importe: 250, tipo: 'FISICO', cuenta: cBancoIndia, estado: 'DEBITADO', debitadoEn: dia(0) })
const cd = await candidatos()
const cn = cd.candidatos.map((x) => x.cheque).sort().join()
check('[3] candidatos a debitar: los DEBITADO de los últimos 45 días (e-cheq y cheque físico), no pagarés', cn === '6001,6007', cn)
const c1d = cd.candidatos.find((x) => x.cheque === '6001')
check('[3] el candidato trae los mismos campos que robotDebitos_', c1d.fila === dA.id && c1d.empresa === 'INDIA ADV S.A.' && c1d.banco === 'ICBC' && c1d.importe === 700 && c1d.fechaCobro === dia(-3) && c1d.acreedor === 'Laboratorios Gamma SA' && c1d.empresaCashflow === 'INDIA ADV S.A.', JSON.stringify(c1d))
check('[3] bloqueados del débito: número con letras y empresa sin Xubio configurado', cd.bloqueados.some((x) => x.cheque === 'AB123' && /número con letras/.test(x.motivo)) && cd.bloqueados.some((x) => x.cheque === '6005' && /sin Xubio configurado/.test(x.motivo)), JSON.stringify(cd.bloqueados))
check('[3] Ralpharma se cuenta aparte y nunca se devuelve', cd.ralpharmaOmitidos === 1 && !cn.includes('6004'))
check('[3] "desde" es la fecha de corte, con hoy_ar()', cd.desde === dia(-45))
check('[3] con más días entra el más viejo', (await candidatos(90)).candidatos.some((x) => x.cheque === '6002'))
check('[3] los días se acotan (nunca todo el historial)', (await candidatos(100000)).desde === dia(-365))

// ================================================================ 4. Lo que el robot devuelve: e-cheqs
const base = { empresa: 'INDIA ADV S.A.', cheque: '5001', proveedor: 'Laboratorios Gamma SA', importe: 1000, filas: gA.ids, ids: gA.ids }
let rr = await resultado({ ...base, modo: 'prueba', estado: 'PRUEBA_OK', detalle: 'formulario completo' })
let x = await chq(cA.id)
check('[4] en prueba solo se anota: el cheque queda con la última pasada y nada más', rr.registrados === 1 && x.robot_op_estado === 'PRUEBA_OK' && x.robot_op_modo === 'prueba' && x.xubio_emision_id === null && x.estado_xubio === 'PENDIENTE')
check('[4] en prueba los pagos no se tocan', (await pg(pA)).estado === 'REVISADO' && (await pg(pA)).estado_xubio_pago === 'CARGAR_A_MANO')
check('[4] queda en procesos_log (Robot_Echeqs_Log) como PRUEBA', (await logs('ROBOT_ECHEQS', cA.id)).some((l) => l.modo === 'PRUEBA' && l.estado === 'PRUEBA_OK' && l.datos.cheque === '5001'))
check('[4] después de una prueba el cheque sigue en la cola', (await grupos()).grupos.some((y) => y.cheque === '5001'))
rr = await resultado({ ...base, modo: 'real', estado: 'SUBIDO', numeroOP: 'X-0001-00002478', detalle: 'orden de pago guardada y aplicada' })
x = await chq(cA.id)
check('[4] SUBIDO real: el cheque queda subido, con el N° de OP y el id de Xubio', rr.registrados === 1 && x.robot_op_estado === 'SUBIDO' && x.robot_op_modo === 'real' && x.robot_numero_op === 'X-0001-00002478' && x.xubio_emision_id === 'X-0001-00002478' && x.estado_xubio === 'SUBIDA' && x.robot_op_en !== null, JSON.stringify(x))
const p1 = await pg(pA), p2 = await pg(pB)
check('[4] SUBIDO real: los pagos del sistema pasan a CONTABILIZADO, cargados a mano, con SUBIDO y el detalle', p1.estado === 'CONTABILIZADO' && p2.estado === 'CONTABILIZADO' && p1.estado_xubio_pago === 'SUBIDO' && p1.xubio_id === 'CARGADO_A_MANO' && p1.contabilizado_por === 'Robot e-cheqs' && /guardada y aplicada/.test(p1.xubio_detalle), JSON.stringify(p1))
check('[4] el N° de OP va al primer pago y los dos lo llevan en el detalle (es único por empresa)', p1.numero_op === 'X-0001-00002478' && p1.numero_op_origen === 'XUBIO' && p2.numero_op === null && /X-0001-00002478/.test(p1.detalle_contabilizacion) && /X-0001-00002478/.test(p2.detalle_contabilizacion))
check('[4] queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'ROBOT_ECHEQ_SUBIDO' and entidad_id = $1`, [cA.id])).n === 1)
check('[4] ya no se le entrega al robot', !(await grupos()).grupos.some((y) => y.cheque === '5001'))
const antes = (await val(`select count(*)::int n from procesos_log`)).n
rr = await resultado({ ...base, modo: 'real', estado: 'SUBIDO', numeroOP: 'X-0001-00002478', detalle: 'orden de pago guardada y aplicada' })
check('[4] idempotente: el robot reenvía lo mismo y no cambia ni se anota otra vez', rr.registrados === 0 && rr.repetidos === 1 && (await val(`select count(*)::int n from procesos_log`)).n === antes && (await val(`select count(*)::int n from auditoria where accion = 'ROBOT_ECHEQ_SUBIDO' and entidad_id = $1`, [cA.id])).n === 1)
rr = await resultado({ ...base, modo: 'real', estado: 'ERROR_ROBOT', detalle: 'se cayó' })
x = await chq(cA.id)
check('[4] un error tardío no desarma un SUBIDO (queda anotado que no se pisó)', x.robot_op_estado === 'SUBIDO' && rr.repetidos === 1 && (await logs('ROBOT_ECHEQS', cA.id)).some((l) => l.estado === 'OMITIDO' && /no se pisa/.test(l.detalle)))
rr = await resultado({ ...base, modo: 'prueba', estado: 'PRUEBA_OK', detalle: 'otra prueba' })
check('[4] una prueba posterior no pisa lo real', (await chq(cA.id)).robot_op_estado === 'SUBIDO' && (await chq(cA.id)).robot_op_modo === 'real')

const fS = await factura({ numero: 1400 }); const pS = await pago({ cheque: '5101', importe: 500 }); await vincular(pS, fS, 500)
const cS = await cheque({ numero: '5101', importe: 500, pagos: [{ id: pS, importe: 500 }] })
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5101', estado: 'SUBIDO_SIN_APLICAR', numeroOP: 'X-0001-00002500', detalle: 'falta aplicar a FC 1400' })
x = await chq(cS.id)
check('[4] sin ids, el cheque se ubica por empresa y número', rr.registrados === 1 && x.robot_op_estado === 'SUBIDO_SIN_APLICAR')
check('[4] SUBIDO_SIN_APLICAR es un estado propio en el cheque', x.robot_op_estado === 'SUBIDO_SIN_APLICAR' && x.estado_xubio === 'SUBIDA')
check('[4] ... y en el pago cuenta como SUBIDO (la orden ya está en Xubio, no se vuelve a cargar)', (await pg(pS)).estado_xubio_pago === 'SUBIDO' && (await pg(pS)).estado === 'CONTABILIZADO')
check('[4] ... y no vuelve a la cola', !(await grupos()).grupos.some((y) => y.cheque === '5101'))
pan = await panel('teso@prueba.com')
check('[4] el panel lo muestra como trabajo para una persona', pan.atencion.some((y) => y.cheque === '5101' && y.estado === 'SUBIDO_SIN_APLICAR' && y.tipo === 'op'), JSON.stringify(pan.atencion))
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5101', estado: 'SUBIDO', numeroOP: 'X-0001-00002500', detalle: 'ya se aplicó' })
check('[4] si después se completa, sube de jerarquía a SUBIDO', rr.registrados === 1 && (await chq(cS.id)).robot_op_estado === 'SUBIDO')
const pE = await pago({ cheque: '5102', importe: 150 }); const cE = await cheque({ numero: '5102', importe: 150, pagos: [{ id: pE, importe: 150 }] })
const err = (n) => resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5102', estado: 'ERROR_ROBOT', detalle: 'no encontré el proveedor ' + n })
const vieja = async () => db.query(`update cheques set robot_op_en = now() - interval '10 minutes' where id = $1`, [cE.id])
rr = await err(1)
check('[4] ERROR_ROBOT real: el cheque queda con error, el pago sigue REVISADO y CARGAR_A_MANO', (await chq(cE.id)).robot_op_estado === 'ERROR_ROBOT' && (await chq(cE.id)).robot_op_intentos === 1 && (await pg(pE)).estado === 'REVISADO' && (await chq(cE.id)).xubio_emision_id === null)
check('[4] ... y se reintenta solo en la corrida siguiente (como el Apps Script, que lo dejaba CARGAR_A_MANO)', (await grupos()).grupos.some((y) => y.cheque === '5102'))
rr = await err(1)
check('[4] el mismo error reenviado enseguida es un reenvío: no suma intento', rr.repetidos === 1 && (await chq(cE.id)).robot_op_intentos === 1)
await vieja(); await err(2); await vieja(); 
check('[4] con 2 intentos todavía se ofrece', (await chq(cE.id)).robot_op_intentos === 2 && (await grupos()).grupos.some((y) => y.cheque === '5102'))
await err(3)
check('[4] al tercer error deja de ofrecerse: queda para "Reintentar" a mano', (await chq(cE.id)).robot_op_intentos === 3 && !(await grupos()).grupos.some((y) => y.cheque === '5102'))
pan = await panel('teso@prueba.com')
check('[4] el panel lo muestra con el botón de reintentar (solo con 3 intentos)', pan.atencion.some((y) => y.cheque === '5102' && y.puedeReintentar === true && y.intentos === 3))
await como('teso@prueba.com')
await falla('[4] reintentar un cheque que no tiene error no se puede', `select robot_reintentar_cheque($1, 'op')`, [cA.id], /quedó con error/)
await db.query(`select robot_reintentar_cheque($1, 'op')`, [cE.id])
await servidor()
check('[4] reintentar lo vuelve a la cola con los intentos en cero', (await chq(cE.id)).robot_op_estado === null && (await chq(cE.id)).robot_op_intentos === 0 && (await grupos()).grupos.some((y) => y.cheque === '5102'))
check('[4] el reintento queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'ROBOT_REINTENTAR' and entidad_id = $1`, [cE.id])).n === 1)
await como('aprob@prueba.com')
await falla('[4] un aprobador no reintenta', `select robot_reintentar_cheque($1, 'op')`, [cE.id], /rol/)
await como('solober@prueba.com')
await falla('[4] quien no ve la empresa del cheque no lo reintenta', `select robot_reintentar_cheque($1, 'debito')`, [cE.id], /acceso|reintentar/)
await servidor()
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5102', estado: 'SUBIDO', numeroOP: 'X-0001-00002501', detalle: 'ok al reintentar' })
check('[4] reintentado y subido: pasa a SUBIDO', (await chq(cE.id)).robot_op_estado === 'SUBIDO' && (await pg(pE)).estado === 'CONTABILIZADO' && (await pg(pE)).cuenta_contable === 'PROVEEDORES LOCALES')
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5003', estado: 'SUBIDO', numeroOP: 'X-0001-00002502', detalle: 'listo' })
const cH = await val(`select id from cheques where numero = '5003'`)
check('[4] un pago de la hoja pasa de CARGAR_A_MANO a SUBIDO con su detalle y N° de OP (como la hoja Pagos)', (await pg(pHoja)).estado_xubio_pago === 'SUBIDO' && (await pg(pHoja)).numero_op === 'X-0001-00002502' && (await pg(pHoja)).xubio_detalle === 'listo' && (await chq(cH.id)).robot_op_estado === 'SUBIDO')
const pY = await pago({ cheque: '5103', importe: 90 }); const cY = await cheque({ numero: '5103', importe: 90, pagos: [{ id: pY, importe: 90 }] })
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5103', estado: 'YA_EN_XUBIO', detalle: 'ya estaba cargado' })
check('[4] YA_EN_XUBIO: no se duplica, el pago queda como YA_EN_XUBIO y sale de la cola', (await chq(cY.id)).robot_op_estado === 'YA_EN_XUBIO' && (await pg(pY)).estado_xubio_pago === 'YA_EN_XUBIO' && !(await grupos()).grupos.some((y) => y.cheque === '5103'))
rr = await resultado([{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '99999', estado: 'SUBIDO', detalle: 'x' }, { modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5011', estado: 'RARO', detalle: 'x' }])
check('[4] un cheque que no existe o un estado raro no rompen nada: quedan OMITIDO en el log', rr.sin_cheque === 2 && rr.registrados === 0 && (await val(`select count(*)::int n from procesos_log where proceso = 'ROBOT_ECHEQS' and estado = 'OMITIDO' and detalle like 'No se encontró el cheque 99999%'`)).n === 1)
const pL1 = await pago({ cheque: '5201', importe: 10 }), pL2 = await pago({ cheque: '5202', importe: 20 })
await cheque({ numero: '5201', importe: 10, pagos: [{ id: pL1, importe: 10 }] }); await cheque({ numero: '5202', importe: 20, pagos: [{ id: pL2, importe: 20 }] })
const lote = [{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5201', estado: 'SUBIDO', numeroOP: 'X-0001-00003001' }, { modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5202', estado: 'SUBIDO', numeroOP: 'X-0001-00003002' }]
rr = await resultado(lote); const rr2 = await resultado(lote)
check('[4] un lote entero reenviado: la primera vez registra 2, la segunda 0', rr.registrados === 2 && rr2.registrados === 0 && rr2.repetidos === 2)
check('[4] sin números de OP repetidos entre pagos de la empresa', (await val(`select count(*)::int n from (select numero_op from pagos where numero_op is not null group by empresa_id, numero_op having count(*) > 1) q`)).n === 0)

// ================================================================ 5. Lo que el robot devuelve: débitos
const bd = { empresa: 'INDIA ADV S.A.', cheque: '6001', banco: 'ICBC', acreedor: 'Laboratorios Gamma SA', importe: 700, fechaCobro: dia(-3), fila: dA.id }
let rd = await resultadoDeb({ ...bd, modo: 'prueba', estado: 'PRUEBA_OK', detalle: 'ventana verificada' })
x = await chq(dA.id)
check('[5] débito en prueba: queda la última pasada y el cheque sigue siendo candidato', rd.registrados === 1 && x.robot_debito_estado === 'PRUEBA_OK' && x.robot_debito_modo === 'prueba' && x.xubio_debito_id === null && (await candidatos()).candidatos.some((y) => y.cheque === '6001'))
rd = await resultadoDeb({ ...bd, modo: 'real', estado: 'DEBITADO', movimiento: 'Movimiento de Fondos N° 990', detalle: 'debitado y verificado' })
x = await chq(dA.id)
check('[5] DEBITADO real: queda en el cheque (antes solo en un log), con el movimiento', rd.registrados === 1 && x.robot_debito_estado === 'DEBITADO' && x.robot_debito_modo === 'real' && x.robot_movimiento === 'Movimiento de Fondos N° 990' && x.xubio_debito_id === 'Movimiento de Fondos N° 990' && x.estado === 'DEBITADO', JSON.stringify(x))
check('[5] queda en procesos_log (Robot_Debitos_Log) y en la auditoría', (await logs('ROBOT_DEBITOS', dA.id)).some((l) => l.modo === 'REAL' && l.estado === 'OK' && l.datos.movimiento === 'Movimiento de Fondos N° 990') && (await val(`select count(*)::int n from auditoria where accion = 'ROBOT_DEBITO_DEBITADO' and entidad_id = $1`, [dA.id])).n === 1)
check('[5] ya no es candidato', !(await candidatos()).candidatos.some((y) => y.cheque === '6001'))
const antesD = (await val(`select count(*)::int n from procesos_log`)).n
rd = await resultadoDeb({ ...bd, modo: 'real', estado: 'DEBITADO', movimiento: 'Movimiento de Fondos N° 990', detalle: 'debitado y verificado' })
check('[5] idempotente: reenviar el débito no cambia ni se anota otra vez', rd.registrados === 0 && rd.repetidos === 1 && (await val(`select count(*)::int n from procesos_log`)).n === antesD)
rd = await resultadoDeb({ ...bd, modo: 'real', estado: 'YA_DEBITADO', detalle: 'ya estaba' })
check('[5] un resultado distinto sobre un cheque ya debitado no lo pisa, queda anotado', (await chq(dA.id)).robot_debito_estado === 'DEBITADO' && rd.repetidos === 1 && (await logs('ROBOT_DEBITOS', dA.id)).some((l) => l.estado === 'OMITIDO'))
rd = await resultadoDeb([{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '6007', estado: 'SIN_OP', detalle: 'no está en Xubio' }])
x = await chq(dFisico.id)
check('[5] sin fila, el cheque se ubica por empresa y número; SIN_OP queda en el cheque', rd.registrados === 1 && x.robot_debito_estado === 'SIN_OP')
check('[5] SIN_OP sigue en la lista del robot (se vuelve a mirar)', (await candidatos()).candidatos.some((y) => y.cheque === '6007'))
pan = await panel('teso@prueba.com')
check('[5] y el panel lo muestra como pendiente de una persona (no se pierde en el log)', pan.atencion.some((y) => y.cheque === '6007' && y.tipo === 'debito' && y.estado === 'SIN_OP'), JSON.stringify(pan.atencion))
await como('teso@prueba.com')
await db.query(`select robot_reintentar_cheque($1, 'debito')`, [dFisico.id])
check('[5] reintentar un débito limpia su estado', (await chq(dFisico.id)).robot_debito_estado === null)
await falla('[5] un débito ya debitado no se reintenta', `select robot_reintentar_cheque($1, 'debito')`, [dA.id], /no está para reintentar/)
await servidor()
rd = await resultadoDeb([{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '6007', estado: 'YA_DEBITADO', detalle: 'tenía su movimiento' }, { modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '70000', estado: 'DEBITADO' }, { modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '6001', estado: 'NO_SE' }])
check('[5] YA_DEBITADO queda final; un cheque desconocido o un estado raro quedan OMITIDO', (await chq(dFisico.id)).robot_debito_estado === 'YA_DEBITADO' && rd.sin_cheque === 2 && rd.registrados === 1, JSON.stringify(rd))

// ================================================================ 6. Panel completo
pan = await panel('teso@prueba.com')
check('[6] el panel trae los pendientes de e-cheqs y de débitos', typeof pan.pendientes === 'number' && pan.pendientes === pan.grupos.length && pan.pendientesDebitos === 0 && Array.isArray(pan.bloqueados) && Array.isArray(pan.bloqueadosDebitos))
check('[6] trae lo último de cada registro con la forma de las planillas', pan.ultimosOP.length > 0 && pan.ultimosOP.length <= 10 && pan.ultimosOP[0].cheque && 'numeroOP' in pan.ultimosOP[0] && pan.ultimosDebitos.length > 0 && pan.ultimosDebitos.length <= 12 && 'movimiento' in pan.ultimosDebitos[0])
check('[6] lo último viene ordenado de lo más nuevo a lo más viejo', pan.ultimosOP.every((y, i, arr) => i === 0 || arr[i - 1].en >= y.en))
pan = await panel('solober@prueba.com')
check('[6] quien solo ve Beratung no ve en el panel nada de India', pan.ultimosOP.length === 0 && pan.ultimosDebitos.length === 0 && pan.atencion.length === 0 && pan.pendientes === 1)
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('real', 'ambos')`)
await servidor()
await db.query(`select robot_tomar_corrida($1, false)`, [org])
const pR = await pago({ cheque: '5301', importe: 33 }); await cheque({ numero: '5301', importe: 33, pagos: [{ id: pR, importe: 33 }] })
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5301', estado: 'SUBIDO', numeroOP: 'X-0001-00003100' })
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '5301', estado: 'SUBIDO', numeroOP: 'X-0001-00003100' })
await db.query(`select robot_registrar_aviso($1, 'FIN_CORRIDA', '')`, [org])
pan = await panel('teso@prueba.com')
check('[6] el resumen de la corrida cuenta lo que el robot hizo desde que la tomó (sin duplicar el reenvío)', pan.corrida.estado === 'terminada' && pan.corrida.op.SUBIDO === 1, JSON.stringify(pan.corrida))

// ================================================================ 8. Correcciones de la revisión (Agente 06)
// 8a. El envío real apagado frena de verdad: el robot no puede promover una corrida a real.
await servidor()
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('real', 'op')`)
await servidor()
await db.query(`select robot_tomar_corrida($1, true)`, [org])
const g8 = async (n, imp = 70) => { const id = await pago({ cheque: n, importe: imp }); const c = await cheque({ numero: n, importe: imp, pagos: [{ id, importe: imp }] }); return { pago: id, cheque: c.id } }
const x1 = await g8('8001')
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8001', estado: 'SUBIDO', numeroOP: 'X-0001-00008001', detalle: 'subido' })
let c8 = await chq(x1.cheque)
check('[8a] corrida entregada como prueba: un resultado "real" se registra como prueba y no cambia cheque ni pago', c8.robot_op_modo === 'prueba' && c8.xubio_emision_id === null && (await pg(x1.pago)).estado === 'REVISADO' && (await pg(x1.pago)).estado_xubio_pago === 'CARGAR_A_MANO', JSON.stringify(c8))
check('[8a] ... y queda anotado en el log que se declaró real', (await logs('ROBOT_ECHEQS', x1.cheque)).some((l) => l.modo === 'PRUEBA' && /Declarado real, registrado como prueba/.test(l.detalle)))
const dN = await cheque({ numero: '8101', importe: 80, estado: 'DEBITADO', debitadoEn: dia(-1) })
await resultadoDeb({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8101', fila: dN.id, estado: 'DEBITADO', movimiento: 'MF 2' })
c8 = await chq(dN.id)
check('[8a] débito declarado real con la corrida entregada como prueba: queda como prueba', c8.robot_debito_modo === 'prueba' && c8.xubio_debito_id === null)
rr = (await val(`select robot_registrar_resultados($1, $2::jsonb, false) r`, [org, JSON.stringify({ resultados: [{ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8001', estado: 'SUBIDO', numeroOP: 'X-0001-00008001' }] })])).r
check('[8a] sin permiso del servidor (envío real apagado) también se registra como prueba', (await chq(x1.cheque)).robot_op_modo === 'prueba')
await db.query(`select robot_registrar_aviso($1, 'FIN_CORRIDA', '')`, [org])
await db.exec(`update robot_corridas set tomada_en = tomada_en - interval '5 hours' where modo_entregado = 'prueba'`)
rr = await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8001', estado: 'SUBIDO', numeroOP: 'X-0001-00008001', detalle: 'subido' })
check('[8a] pasadas 3 horas desde esa corrida (o sin corrida) y con el envío real encendido, una corrida manual del menú vale como real', (await chq(x1.cheque)).robot_op_modo === 'real' && (await chq(x1.cheque)).robot_op_estado === 'SUBIDO')
// real + PRUEBA_OK
const x2 = await g8('8002')
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8002', estado: 'PRUEBA_OK', detalle: 'x' })
check('[8i] "real" + PRUEBA_OK se toma como prueba (Code.js:219)', (await chq(x2.cheque)).robot_op_modo === 'prueba' && (await chq(x2.cheque)).robot_op_estado === 'PRUEBA_OK' && (await pg(x2.pago)).estado === 'REVISADO')

// 8b. Qué se le ofrece al robot: solo lo que pasó por Contabilización y quedó marcado
const pSin = await pagoNuevo({ cheque: '8201', importe: 66, estadoXubioPago: null })
const cSin = await cheque({ numero: '8201', importe: 66, pagos: [{ id: pSin, importe: 66 }] })
check('[8b] un pago CARGADO sin contabilizar no se le ofrece al robot', !(await grupos()).grupos.some((y) => y.cheque === '8201') && !(await grupos()).bloqueados.some((y) => y.cheque === '8201'))
await como('teso@prueba.com')
await falla('[8b] una persona no marca pagos para el robot por la vía directa', `select marcar_echeq_a_mano($1, 'X', 'ORDEN_PAGO', 'x', 'u', 'ADMIN')`, [pSin], /permission denied/)
await servidor()
await falla('[8b] marcar un e-cheq exige la cuenta contable', `select marcar_echeq_a_mano($1, '  ', 'ORDEN_PAGO', 'x', 'Admin', 'ADMINISTRACION')`, [pSin], /cuenta contable/)
await db.query(`select marcar_echeq_a_mano($1, 'PROVEEDORES LOCALES', 'ORDEN_PAGO', 'E-cheq 8201 para el robot', 'Admin', 'ADMINISTRACION')`, [pSin])
let ps = await pg(pSin)
check('[8b] Contabilización marca el e-cheq: queda REVISADO, con su cuenta contable, CARGAR_A_MANO y a cargo del sistema', ps.estado === 'REVISADO' && ps.cuenta_contable === 'PROVEEDORES LOCALES' && ps.estado_xubio_pago === 'CARGAR_A_MANO' && ps.gestion === 'SISTEMA' && /para el robot/.test(ps.detalle_contabilizacion))
check('[8b] ahora sí se le ofrece', (await grupos()).grupos.some((y) => y.cheque === '8201'))
check('[8b] queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'ECHEQ_PARA_ROBOT' and entidad_id = $1`, [pSin])).n === 1)
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8201', estado: 'SUBIDO', numeroOP: 'X-0001-00008201', detalle: 'ok' })
ps = await pg(pSin)
check('[8b] al terminar queda CONTABILIZADO con su cuenta contable (nunca sin ella)', ps.estado === 'CONTABILIZADO' && ps.cuenta_contable === 'PROVEEDORES LOCALES' && ps.xubio_id === 'CARGADO_A_MANO')
const pRar = await pagoNuevo({ cheque: '8202', importe: 5, estadoXubioPago: 'CARGAR_A_MANO' }); await db.query(`update pagos set estado = 'REVISADO' where id = $1`, [pRar])
await cheque({ numero: '8202', importe: 5, pagos: [{ id: pRar, importe: 5 }] })
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8202', estado: 'SUBIDO', numeroOP: 'X-0001-00008202', detalle: 'ok' })
ps = await pg(pRar)
check('[8b] un pago sin cuenta contable no pasa a CONTABILIZADO aunque el robot suba el cheque', ps.estado === 'REVISADO' && ps.estado_xubio_pago === 'SUBIDO' && ps.cuenta_contable === null)
check('[8b] no queda ningún pago CONTABILIZADO sin cuenta entre los que tocó el robot', (await val(`select count(*)::int n from pagos where contabilizado_por = 'Robot e-cheqs' and cuenta_contable is null`)).n === 0)
// e-cheq con cheque ya debitado
const pDeb = await pago({ cheque: '8203', importe: 44 }); await cheque({ numero: '8203', importe: 44, estado: 'DEBITADO', debitadoEn: dia(-1), pagos: [{ id: pDeb, importe: 44 }] })
check('[8j] un e-cheq con orden de pago sin cargar cuyo cheque ya está DEBITADO no desaparece de la cola', (await grupos()).grupos.some((y) => y.cheque === '8203'))

// 8c. Las corridas se cierran solas
await servidor()
await db.exec(`update robot_corridas set estado = 'ERROR' where estado in ('CORRIENDO', 'PEDIDA')`)
await como('teso@prueba.com')
await db.query(`select robot_pedir_corrida('prueba', 'ambos')`)
await servidor()
await db.query(`select robot_tomar_corrida($1, false)`, [org])
await resultado({ modo: 'prueba', empresa: 'INDIA ADV S.A.', cheque: '8002', estado: 'PRUEBA_OK', detalle: 'otra prueba' })
const corrId = (await val(`select id from robot_corridas where estado = 'CORRIENDO'`)).id
check('[8c] con señal del robot sigue corriendo (informar algo la mantiene viva)', (await val(`select estado from robot_corridas where id = $1`, [corrId])).estado === 'CORRIENDO')
await db.exec(`update robot_corridas set ultima_actividad = now() - interval '25 minutes' where id = '${corrId}'`)
pan = await panel('teso@prueba.com')
check('[8c] pasados 20 minutos sin señal, la corrida que informó algo queda TERMINADA (el robot de hoy no manda FIN_CORRIDA)', pan.corrida.estado === 'terminada' && (await val(`select estado from robot_corridas where id = $1`, [corrId])).estado === 'TERMINADA' && pan.corrida.hasta !== '')
await como('teso@prueba.com')
check('[8c] y ya se puede pedir otra (la pantalla y la base usan el mismo plazo)', (await val(`select robot_pedir_corrida('prueba', 'op') r`)).r.ok === true)
await servidor()
await db.query(`select robot_tomar_corrida($1, false)`, [org])
await db.exec(`update robot_corridas set ultima_actividad = now() - interval '30 minutes' where estado = 'CORRIENDO'`)
pan = await panel('teso@prueba.com')
check('[8c] una corrida que no informó nada y pasó el plazo queda SIN_FIN', pan.corrida.estado === 'sin_fin')
// al tomar la siguiente se cierra la anterior que seguía corriendo
await db.exec(`update robot_corridas set estado = 'ERROR' where estado in ('CORRIENDO', 'PEDIDA')`)
await db.exec(`insert into robot_corridas (organizacion_id, modo, tipo, estado, tomada_en, ultima_actividad) values ('${org}', 'prueba', 'op', 'CORRIENDO', now() - interval '3 minutes', now() - interval '3 minutes')`)
const vieja8 = (await val(`select id from robot_corridas where estado = 'CORRIENDO'`)).id
await db.exec(`insert into robot_corridas (organizacion_id, modo, tipo, estado) values ('${org}', 'prueba', 'op', 'PEDIDA')`)
await db.query(`select robot_tomar_corrida($1, false)`, [org])
check('[8c] al tomar una corrida nueva la anterior sin aviso de fin se cierra y queda una sola CORRIENDO', (await val(`select count(*)::int n from robot_corridas where estado = 'CORRIENDO'`)).n === 1 && ['SIN_FIN', 'TERMINADA'].includes((await val(`select estado from robot_corridas where id = $1`, [vieja8])).estado))
await db.exec(`update robot_corridas set estado = 'ERROR' where estado = 'CORRIENDO'`)

// 8d. FALTA APLICAR (las corridas de prueba de arriba ya quedaron atrás)
await db.exec(`update robot_corridas set tomada_en = tomada_en - interval '5 hours' where tomada_en is not null`)
const x3 = await g8('8301', 90)
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8301', estado: 'SUBIDO_SIN_APLICAR', numeroOP: 'X-0001-00008301', detalle: 'OP guardada ⚠ FALTA APLICAR a FC A-00001-00000123' })
check('[8d] SUBIDO_SIN_APLICAR deja el aviso en el detalle del pago', /FALTA APLICAR/.test((await pg(x3.pago)).xubio_detalle))
await como('aprob@prueba.com')
await falla('[8d] un aprobador no cierra aplicaciones', `select robot_cerrar_sin_aplicar($1)`, [x3.cheque], /rol/)
await como('teso@prueba.com')
await falla('[8d] solo se cierra un cheque que quedó sin aplicar', `select robot_cerrar_sin_aplicar($1)`, [x1.cheque], /aplicación pendiente/)
pan = (await val(`select robot_estado_panel() r`)).r
check('[8d] el panel lo ofrece para cerrar a mano', pan.atencion.some((y) => y.cheque === '8301' && y.puedeCerrar === true))
await db.query(`select robot_cerrar_sin_aplicar($1)`, [x3.cheque])
await servidor()
check('[8d] cerrado a mano: el cheque queda SUBIDO y el pago ya no dice FALTA APLICAR', (await chq(x3.cheque)).robot_op_estado === 'SUBIDO' && !/FALTA APLICAR/i.test((await pg(x3.pago)).xubio_detalle) && !/FALTA APLICAR/i.test((await chq(x3.cheque)).robot_op_detalle) && /cerrada a mano/.test((await pg(x3.pago)).xubio_detalle), (await pg(x3.pago)).xubio_detalle)
check('[8d] y deja de figurar en "para revisar"', !(await panel('teso@prueba.com')).atencion.some((y) => y.cheque === '8301'))
const x4 = await g8('8302', 91)
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8302', estado: 'SUBIDO_SIN_APLICAR', numeroOP: 'X-0001-00008302', detalle: 'OP guardada ⚠ FALTA APLICAR' })
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8302', estado: 'SUBIDO', numeroOP: 'X-0001-00008302', detalle: 'aplicada' })
check('[8d] si el robot la completa después, el pago también pierde el FALTA APLICAR', (await pg(x4.pago)).xubio_detalle === 'aplicada')

// 8e. La copia de la hoja no pisa lo que dejó el robot
const pH = await pago({ cheque: '8401', importe: 33, gestion: 'HOJA', estado: 'CONTABILIZADO', estadoXubioPago: 'CARGAR_A_MANO' }); await cheque({ numero: '8401', importe: 33, pagos: [{ id: pH, importe: 33 }] })
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8401', estado: 'SUBIDO', numeroOP: 'X-0001-00008401', detalle: 'subido por el robot' })
await db.query(`update pagos set estado_xubio_pago = 'CARGAR_A_MANO', xubio_detalle = null, numero_op = null, detalle_contabilizacion = 'texto de la hoja', hoja_hash = 'otro' where id = $1`, [pH])
let ph = await pg(pH)
check('[8e] la copia de la hoja (CARGAR_A_MANO otra vez) no deshace el estado, el detalle ni el N° de OP del robot', ph.estado_xubio_pago === 'SUBIDO' && ph.xubio_detalle === 'subido por el robot' && ph.numero_op === 'X-0001-00008401', JSON.stringify([ph.estado_xubio_pago, ph.xubio_detalle, ph.numero_op]))
check('[8e] ... y el detalle de contabilización de la hoja conserva la marca del robot', /texto de la hoja/.test(ph.detalle_contabilizacion) && /X-0001-00008401 \(robot e-cheqs\)/.test(ph.detalle_contabilizacion), ph.detalle_contabilizacion)
await db.query(`update pagos set estado_xubio_pago = 'SUBIDO', hoja_hash = 'otro2' where id = $1`, [pH])
await db.query(`update pagos set estado_xubio_pago = 'ERROR_ROBOT', hoja_hash = 'otro3' where id = $1`, [pH])
check('[8e] si la hoja dice otra cosa (no CARGAR_A_MANO), manda la hoja', (await pg(pH)).estado_xubio_pago === 'ERROR_ROBOT')

// 8f. N° de OP con forma
const x5 = await g8('8501', 12)
await resultado({ modo: 'real', empresa: 'INDIA ADV S.A.', cheque: '8501', estado: 'YA_EN_XUBIO', numeroOP: 'Salida de Fondos 5006 ($ 1.000,00) Beratung', detalle: 'ya estaba' })
const p5 = await pg(x5.pago), c5 = await chq(x5.cheque)
check('[8f] un numeroOP de texto libre no se guarda como N° de OP: va solo al detalle', p5.numero_op === null && c5.robot_numero_op === null && c5.xubio_emision_id === null && /Salida de Fondos 5006/.test(c5.robot_op_detalle) && c5.robot_op_estado === 'YA_EN_XUBIO', JSON.stringify([p5.numero_op, c5.robot_op_detalle]))
check('[8f] robot_es_numero_op reconoce la forma', (await val(`select robot_es_numero_op('X-0001-00002478') a, robot_es_numero_op('x-1') b, robot_es_numero_op(null) c`)).a === true && (await val(`select robot_es_numero_op('x-1') b`)).b === false)

// 8g. Otra organización: el robot no la atiende
await db.exec(`insert into organizaciones (slug, nombre) values ('otra', 'Otra organización')`)
const orgB = (await val(`select id from organizaciones where slug = 'otra'`)).id
await db.exec(`insert into empresas (id, nombre, nombre_corto, cuit, erp, organizacion_id) values ('indiasur', 'INDIA SUR S.A.', 'India Sur', '20999999991', 'XUBIO', '${orgB}')`)
await db.exec(`insert into usuarios (email, nombre, rol, todas_empresas, organizacion_id) values ('b@prueba.com', 'Tesorera B', 'TESORERIA', true, '${orgB}')`)
check('[8g] una empresa nueva de otra organización no queda habilitada para el robot', (await val(`select robot_echeqs r from empresas where id = 'indiasur'`)).r === false)
await db.exec(`update empresas set robot_echeqs = true where id = 'indiasur'`)
await como('b@prueba.com')
r = (await val(`select robot_pedir_corrida('real', 'op') r`)).r
check('[8g] el pedido de una organización que el robot no atiende no promete que lo toma en 5 minutos', r.ok === false && /no atiende a tu organización/.test(r.mensaje) && !/5 minutos/.test(r.mensaje), JSON.stringify(r))
check('[8g] el panel de esa organización dice que no está habilitado', (await val(`select robot_estado_panel() r`)).r.habilitado === false)
await servidor()
check('[8g] no se crea ninguna corrida para ella', (await val(`select count(*)::int n from robot_corridas where organizacion_id = $1`, [orgB])).n === 0)
const aB = (await val(`select robot_pedir_automatica($1, '13:00', false, false) r`, [orgB])).r
check('[8g] la corrida automática tampoco la pide para esa organización', aB.pedida === false && /no atiende/.test(aB.motivo), JSON.stringify(aB))
check('[8g] el robot sigue trabajando para la proveedora', (await val(`select robot_organizacion() o`)).o === org)

// ================================================================ 7. Seguridad de las tablas y fechas
check('[7] las tablas nuevas tienen RLS', (await filas(`select relname from pg_class where relname in ('robot_corridas', 'robot_control') and relrowsecurity`)).length === 2)
check('[7] no queda ningún current_date en la migración (siempre hoy_ar())', !/current_date/i.test(readFileSync(join(dir, '0039_robot_echeqs.sql'), 'utf8').replace(/--.*$/gm, '')))
await comoAnon()
check('[7] anon no lee las tablas de control', /permission denied/.test(await error(`select * from robot_corridas`) ?? ''))
await servidor()

console.log(`\n${ok} OK · ${mal} MAL`)
await db.close()
process.exit(mal ? 1 : 0)
