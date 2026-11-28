// Revisión independiente de 0039, robot de e-cheqs (agente 06, 27/11/2026). Los "BUG" son comportamientos que el Apps Script no tiene
// o que rompen algo; los "OK" son controles de lo que sí anda; los "INFO" solo muestran un dato. Datos ficticios. No toca producción.
// Cada BUG lleva el escenario en el nombre. Las formas de entrada son las que manda el robot de hoy (integracion_dashboard_robot/v2/robot.js):
//   resultado e-cheq  = { filas, empresa, cheque, proveedor, importe, estado, numeroOP, detalle, captura, modo }   (resumen(g) + resultado; sin ids ni chequeId)
//   resultado débito  = { ...candidato (fila, chequeId, empresa, cheque...), estado, movimiento, detalle, modo }
// Uso (desde demo/): node supabase/pruebas/revision_0039.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

process.on('uncaughtException', (e) => { console.log('ERROR', String(e.message).slice(0, 400)); process.exit(1) })
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
const todas = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
const aplicar = async (f) => db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''))
// Base armada hasta 0038 (sin 0039 ni 0040): así 0039 se prueba sobre datos que ya existían.
for (const f of todas.filter((x) => !x.startsWith('0039') && !x.startsWith('0040'))) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  await aplicar(f)
}
const f0039 = todas.find((x) => x.startsWith('0039'))
const funcionesAntes = new Set((await filas(`select p.oid::regprocedure::text n from pg_proc p where p.pronamespace = 'public'::regnamespace`)).map((x) => x.n))

// ---------------------------------------------------------------- Datos "reales" que ya existían antes de 0039 (como los de la hoja)
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMINISTRACION', true),
    ('aprob@prueba.com', 'Aprob', 'APROBADOR', true), ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const prov = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre) values ($1, $2) returning id`, [cuit, nombre])).id
const pGamma = await prov('30710000011', 'Laboratorios Gamma SA')
const cuenta = async (empresa, nombre, banco, clase, tipo) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, tipo_cuenta) values ($1, $2, $3, $4, $5) returning id`, [empresa, nombre, banco, clase, tipo])).id
const cIndia = await cuenta('india', 'E-CHEQ ICBC 0001', 'ICBC', 'ECHEQ', 4)
const cIndia2 = await cuenta('india', 'E-CHEQ GALICIA 0002', 'GALICIA', 'ECHEQ', 4)
const cBera = await cuenta('beratung', 'BANCO GALICIA E-CHEQ', 'GALICIA', 'ECHEQ', 4)
let nroF = 800
const factura = async (extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, gestion, cuenta_contable, estado_xubio, xubio_id)
   values ($1, $2, 'Factura A', 'A', 1, $3, $4, $5, $6, $6, 'PARA_PAGAR', 0, 'SISTEMA', 'PROVEEDORES LOCALES', 'SUBIDA', '9001') returning id`,
  [extra.empresa ?? 'india', extra.proveedor ?? pGamma, nroF++, dia(-20), dia(5), extra.total ?? 1000])).id
// Un pago tal como lo deja la copia de la hoja (HOJA) o como lo carga el sistema (SISTEMA).
const pagoNuevo = async (extra = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, estado, gestion, numero_cheque, fecha_acreditacion, tipo_cheque, estado_xubio_pago, proveedor_destino, xubio_id, cuenta_contable, contabilizado_por)
   values ($1, $2, $3, $4, 'ECHEQ', 'teso@prueba.com', 'SIN_FACTURA', 'ORDEN_PAGO', $5::estado_pago, $6, $7, $8, 'ECHEQ', $9, 'GAMMA S.A.', $10, $11, case when $5 = 'CONTABILIZADO' then 'Apps Script' end) returning id`,
  [extra.empresa ?? 'india', extra.proveedor === undefined ? pGamma : extra.proveedor, extra.fecha ?? dia(-2), extra.importe ?? 1000, extra.estado ?? 'CARGADO', extra.gestion ?? 'SISTEMA',
   extra.cheque ?? null, dia(20), extra.estadoXubioPago ?? null, extra.xubioId ?? null, extra.cuentaContable ?? null])).id
let nroC = 1000
const cheque = async (extra = {}) => {
  const numero = extra.numero ?? String(nroC++)
  const id = (await val(
    `insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, proveedor_id, beneficiario, importe, fecha_emision, fecha_pago, estado, debitado_en, creado_por)
     values ($1, $2, 'ECHEQ', $3, $4, 'Laboratorios Gamma SA', $5, $6, $7, $8, $9, 'teso@prueba.com') returning id`,
    [extra.empresa ?? 'india', extra.cuenta ?? cIndia, numero, pGamma, extra.importe ?? 1000, dia(-3), extra.fechaPago ?? dia(20), extra.estado ?? 'EMITIDO', extra.debitadoEn ?? null])).id
  for (const p of extra.pagos ?? []) await db.query(`insert into cheques_pagos (cheque_id, pago_id, importe) values ($1, $2, $3)`, [id, p.id, p.importe])
  return { id, numero }
}
// Un e-cheq con su pago "de la hoja": CONTABILIZADO por el Apps Script, con ESTADO_XUBIO_PAGO = CARGAR_A_MANO (como lo copia espejo.ts).
const chequeHoja = async (extra = {}) => {
  const num = extra.numero ?? String(nroC++)
  const p = await pagoNuevo({ estado: 'CONTABILIZADO', gestion: 'HOJA', cheque: num, estadoXubioPago: 'CARGAR_A_MANO', xubioId: 'CARGAR_A_MANO', cuentaContable: 'PROVEEDORES LOCALES', empresa: extra.empresa })
  const c = await cheque({ numero: num, pagos: [{ id: p, importe: 1000 }], empresa: extra.empresa, cuenta: extra.cuenta })
  return { ...c, pago: p }
}
const chequeSistema = async (extra = {}) => {
  const num = extra.numero ?? String(nroC++)
  const p = await pagoNuevo({ estado: extra.estadoPago ?? 'CARGADO', cheque: num, empresa: extra.empresa })
  const c = await cheque({ numero: num, pagos: [{ id: p, importe: 1000 }], empresa: extra.empresa, cuenta: extra.cuenta })
  return { ...c, pago: p }
}

// ---------------------------------------------------------------- 0039 sobre la base con datos
const hojaPrevio = await chequeHoja()
const t0 = Date.now()
await aplicar(f0039)
check('0039 aplica sobre una base con cheques y pagos existentes', true)
info('tiempo de aplicar 0039 (PGlite)', `${Date.now() - t0} ms`)
{
  let e = null
  try { await aplicar(f0039) } catch (x) { e = x.message }
  check('0039 se puede ejecutar dos veces seguidas', e === null, e ?? '')
}
const chq = async (id) => val(`select * from cheques where id = $1`, [id])
const pg = async (id) => val(`select * from pagos where id = $1`, [id])
const grupos = async (emp = null) => (await val(`select robot_grupos_op($1, $2) r`, [org, emp])).r
const candidatos = async (dias = 45) => (await val(`select robot_candidatos_debito($1, $2, null) r`, [org, dias])).r
const resultado = async (r) => (await val(`select robot_registrar_resultados($1, $2::jsonb, true) r`, [org, JSON.stringify({ resultados: Array.isArray(r) ? r : [r] })])).r
const resultadoDeb = async (r) => (await val(`select robot_registrar_debitos($1, $2::jsonb, true) r`, [org, JSON.stringify({ resultados: Array.isArray(r) ? r : [r] })])).r
// Las corridas de prueba de arriba no cuentan para las pruebas que siguen (el robot que declara "real" después de una corrida entregada como prueba se prueba en F).
const olvidar = () => db.query(`update robot_corridas set tomada_en = tomada_en - interval '5 hours' where tomada_en is not null`)
const panel = async (email) => { await como(email); const r = (await val(`select robot_estado_panel() r`)).r; await servidor(); return r }
// Lo que el robot devuelve de un grupo: resumen(g) + resultado + modo (robot.js: resumen y correr). filas = los ids que le dio pendientes.
const deRobot = (g, estado, modo, extra = {}) => ({ filas: g.filas, empresa: g.empresa, cheque: g.cheque, proveedor: g.proveedor, importe: g.importe, estado, modo, ...extra })

// ================================================================ A. Compatibilidad con el robot de la PC
{
  const h = await chequeHoja({ numero: '5001' })
  const g = (await grupos()).grupos.find((x) => x.cheque === '5001')
  check('[A] pendientes trae el grupo con los campos del Apps Script (empresa, cheque, proveedor, cuit, cuentaXubio, bancos, fechaPago, vencimiento, importe, facturas, importesFactura, filas, ids, descripcion)',
    !!g && ['empresa', 'cheque', 'proveedor', 'cuit', 'cuentaXubio', 'bancos', 'fechaPago', 'vencimiento', 'importe', 'facturas', 'importesFactura', 'filas', 'ids', 'descripcion'].every((k) => k in g), JSON.stringify(g))
  check('[A] el importe llega como número (robot.js hace g.importe.toFixed(2))', typeof g.importe === 'number', typeof g.importe)
  check('[A] filas son uuid de pagos (no números de fila): el robot los devuelve tal cual', /^[0-9a-f-]{36}$/.test(g.filas[0]))
  const r = await resultado(deRobot(g, 'SUBIDO', 'real', { numeroOP: 'X-0001-00001234', detalle: 'Xubio: OP', captura: 'C:\\x.png' }))
  check('[A] el resultado con la forma exacta que manda robot.js se registra (filas → pagos → cheque)', r.registrados === 1 && (await chq(h.id)).robot_op_estado === 'SUBIDO', JSON.stringify(r))
  const p = await pg(h.pago)
  check('[A] el pago de la hoja pasa a SUBIDO con N° de OP y sin cambiar de estado ni de quien lo gestiona', p.estado_xubio_pago === 'SUBIDO' && p.numero_op === 'X-0001-00001234' && p.estado === 'CONTABILIZADO' && p.gestion === 'HOJA', JSON.stringify({ e: p.estado_xubio_pago, op: p.numero_op, g: p.gestion }))

  // Resultados viejos que el robot guardó en resultados_sin_enviar.json con números de fila de la hoja (filas: [41, 42]).
  const h2 = await chequeHoja({ numero: '5002' })
  const r2 = await resultado({ filas: [41, 42], empresa: 'INDIA ADV S.A.', cheque: '5002', proveedor: 'GAMMA', importe: 1000, estado: 'SUBIDO', numeroOP: 'X-0001-00001300', detalle: 'viejo', modo: 'real' })
  check('[A] resultado viejo con números de fila de la hoja: se ubica por empresa y número y no explota', r2.registrados === 1 && (await chq(h2.id)).robot_op_estado === 'SUBIDO', JSON.stringify(r2))
  const h3 = await chequeHoja({ numero: '0005003' })
  const r3 = await resultado({ filas: [43], empresa: 'INDIA ADV S.A.', cheque: '5003', estado: 'SUBIDO', numeroOP: 'X-0001-00001301', modo: 'real' })
  check('[A] el número se compara sin ceros a la izquierda', r3.registrados === 1 && (await chq(h3.id)).robot_op_estado === 'SUBIDO', JSON.stringify(r3))

  // Dos cheques con el mismo número en la misma empresa (cuentas distintas): no se adivina.
  const dupA = await chequeHoja({ numero: '5004' })
  const dupB = await chequeHoja({ numero: '5004', cuenta: cIndia2 })
  const r4 = await resultado({ filas: [44], empresa: 'INDIA ADV S.A.', cheque: '5004', estado: 'SUBIDO', numeroOP: 'X-0001-00001302', modo: 'real' })
  check('[A] mismo número en dos cuentas de la misma empresa y filas viejas: queda OMITIDO (no adivina)', r4.registrados === 0 && r4.sin_cheque === 1)
  // Con los ids de los pagos (lo que manda el robot de hoy) sí distingue.
  const r4b = await resultado({ filas: [dupB.pago], empresa: 'INDIA ADV S.A.', cheque: '5004', estado: 'SUBIDO', numeroOP: 'X-0001-00001303', modo: 'real' })
  check('[A] ... y con los ids de pago los distingue', r4b.registrados === 1 && (await chq(dupB.id)).robot_op_estado === 'SUBIDO' && (await chq(dupA.id)).robot_op_estado === null)

  // modo en mayúsculas, estado en minúsculas
  const h5 = await chequeHoja({ numero: '5005' })
  const g5 = (await grupos()).grupos.find((x) => x.cheque === '5005')
  await resultado(deRobot(g5, 'subido', 'REAL', { numeroOP: 'X-0001-00001304' }))
  check('[A] modo REAL y estado subido (mayúsculas/minúsculas) se entienden', (await chq(h5.id)).robot_op_estado === 'SUBIDO')

  // numeroOP del YA_EN_XUBIO: robot.js: numeroOP = (origen.match(/[A-Z]-\d{4}-\d{8}/) || [])[0] || origen  → si no hay número con formato, manda el texto entero.
  const h6 = await chequeHoja({ numero: '5006' })
  const g6 = (await grupos()).grupos.find((x) => x.cheque === '5006')
  await resultado(deRobot(g6, 'YA_EN_XUBIO', 'real', { numeroOP: 'Salida de Fondos 5006 ($ 1.000,00) Beratung', detalle: 'ya estaba' }))
  const p6 = await pg(h6.pago)
  check('[A] un numeroOP que no tiene forma de N° de OP (texto libre de Xubio) NO debería quedar como N° de OP del pago ni como id de emisión',
    !/Salida de Fondos/.test(p6.numero_op ?? '') && !/Salida de Fondos/.test((await chq(h6.id)).xubio_emision_id ?? ''), `numero_op="${p6.numero_op}" xubio_emision_id="${(await chq(h6.id)).xubio_emision_id}"`)

  // Débito: candidato → resultado con { ...c, ...r, modo }
  const d1 = await cheque({ numero: '7001', estado: 'DEBITADO', debitadoEn: dia(-1) })
  const c1 = (await candidatos()).candidatos.find((x) => x.cheque === '7001')
  check('[A] candidato de débito con los campos del Apps Script (fila, empresaCashflow, empresa, cheque, banco, acreedor, importe, fechaCobro)',
    !!c1 && ['fila', 'empresaCashflow', 'empresa', 'cheque', 'banco', 'acreedor', 'importe', 'fechaCobro'].every((k) => k in c1) && typeof c1.importe === 'number', JSON.stringify(c1))
  const rd = await resultadoDeb({ ...c1, estado: 'DEBITADO', movimiento: 'MF-0001', detalle: 'ok', modo: 'real' })
  check('[A] resultadoDebito con { ...candidato, estado, movimiento, detalle, modo } se registra', rd.registrados === 1 && (await chq(d1.id)).robot_debito_estado === 'DEBITADO', JSON.stringify(rd))
}

// ================================================================ B. Seguridad de la base
{
  const nuevas = (await filas(`select p.oid::regprocedure::text n, p.prosecdef sd, coalesce(p.proconfig::text, '') cfg,
      has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') srv,
      has_function_privilege('public', p.oid, 'execute') pub
    from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).filter((x) => !funcionesAntes.has(x.n))
  info('funciones nuevas de 0039', nuevas.map((x) => x.n.split('(')[0]).join(', '))
  check('[B] ninguna función nueva la ejecuta anon ni PUBLIC', nuevas.every((x) => !x.anon && !x.pub), nuevas.filter((x) => x.anon || x.pub).map((x) => x.n).join(', '))
  check('[B] toda función nueva security definer fija search_path', nuevas.filter((x) => x.sd).every((x) => /search_path=public/.test(x.cfg)), nuevas.filter((x) => x.sd && !/search_path/.test(x.cfg)).map((x) => x.n).join(', '))
  const soloServidor = nuevas.filter((x) => !['robot_pedir_corrida', 'robot_cancelar_corrida', 'robot_estado_panel', 'robot_reintentar_cheque', 'robot_cerrar_sin_aplicar'].includes(x.n.split('(')[0]))
  check('[B] las 24 de uso interno las ejecuta solo service_role (no authenticated)', soloServidor.length === 24 && soloServidor.every((x) => !x.auth && x.srv), soloServidor.filter((x) => x.auth).map((x) => x.n).join(', '))
  // Todas las que escriben o leen datos y las llama una persona hacen exigir_rol / exigir_empresa
  const src = (n) => val(`select prosrc s from pg_proc where proname = $1`, [n])
  for (const f of ['robot_pedir_corrida', 'robot_cancelar_corrida', 'robot_estado_panel', 'robot_reintentar_cheque', 'robot_cerrar_sin_aplicar'])
    check(`[B] ${f} exige rol`, /exigir_rol/.test((await src(f)).s))
  check('[B] robot_reintentar_cheque exige empresa', /exigir_empresa/.test((await src('robot_reintentar_cheque')).s))
  // Una persona no puede dejar estados del robot en el cheque por la vía directa.
  await como('teso@prueba.com')
  const e1 = await error(`update cheques set robot_op_estado = 'SUBIDO', robot_op_modo = 'real' where numero = '5001'`)
  check('[B] una persona no escribe robot_op_* en cheques', e1 !== null && /permission denied|row-level/.test(e1) || (await val(`select count(*)::int n from cheques where robot_op_estado = 'SUBIDO' and numero = '5001'`)).n === 1 && false, e1 ?? '')
  const e2 = await error(`update empresas set robot_echeqs = false where id = 'india'`)
  check('[B] una persona no apaga/enciende el robot de una empresa por la vía directa', e2 !== null, e2 ?? 'pudo')
  // Solo Beratung no reintenta un cheque de India
  await servidor()
  const hh = await chequeHoja({ numero: '5100' })
  await servidor()
  await resultado({ filas: [hh.pago], empresa: 'INDIA ADV S.A.', cheque: '5100', estado: 'ERROR_ROBOT', modo: 'real', detalle: 'x' })
  await como('solober@prueba.com')
  const e3 = await error(`select robot_reintentar_cheque($1, 'op')`, [hh.id])
  check('[B] quien solo ve Beratung no reintenta un cheque de India', e3 !== null && /empresa|acceso/i.test(e3), e3 ?? 'pudo')
  await como('aprob@prueba.com')
  const e4 = await error(`select robot_reintentar_cheque($1, 'op')`, [hh.id])
  check('[B] un aprobador no reintenta', e4 !== null && /rol/.test(e4), e4 ?? '')
  await servidor()
}

// ================================================================ C. Estados e idempotencia
{
  // C1: tomar → resultados → pedir otra
  await como('teso@prueba.com'); await db.query(`select robot_pedir_corrida('prueba', 'op')`); await servidor()
  const t = (await val(`select robot_tomar_corrida($1, false) r`, [org])).r
  const hC = await chequeHoja({ numero: '6001' })
  const gC = (await grupos()).grupos.find((x) => x.cheque === '6001')
  await resultado(deRobot(gC, 'PRUEBA_OK', 'prueba', { detalle: 'prueba' }))
  // El robot de hoy no manda FIN_CORRIDA (robot.js solo hace log("Fin: ...")): la corrida queda CORRIENDO.
  check('[C] la corrida tomada y terminada sin aviso de fin figura como corriendo (el robot v2 no manda FIN_CORRIDA)', (await val(`select estado from robot_corridas where id = (select id from robot_corridas order by pedida_en desc limit 1)`)).estado === 'CORRIENDO', JSON.stringify(t))
  await como('teso@prueba.com')
  const r1 = (await val(`select robot_pedir_corrida('real', 'debito') r`)).r
  await servidor()
  // Decisión del coordinador: el robot de hoy no manda FIN_CORRIDA, así que la base cierra sola la corrida a los 20 minutos sin señal; mientras tanto no se pide otra.
  check('[C] con el robot de hoy, 2 minutos después del último resultado todavía figura corriendo y no se pide otra (se cierra sola a los 20 minutos sin señal)', r1.ok === false && /corriendo/.test(r1.mensaje ?? ''), r1.mensaje)
  if (r1.ok) await db.query(`update robot_corridas set estado = 'CANCELADA' where estado = 'PEDIDA'`)
  // C1b: a los 30 minutos: la base deja pedir, pero el panel sigue diciendo "corriendo" (60 min) y la pantalla deshabilita los botones
  await db.query(`update robot_corridas set ultima_actividad = now() - interval '30 minutes' where estado = 'CORRIENDO'`)
  const pan30 = await panel('teso@prueba.com')
  await como('teso@prueba.com')
  const r2 = (await val(`select robot_pedir_corrida('prueba', 'op') r`)).r
  await servidor()
  info('a los 30 min de tomada, sin aviso de fin', { pedirAcepta: r2.ok, estadoQueMuestraElPanel: pan30.corrida?.estado })
  check('[C] a los 30 min la base deja pedir y el panel dice lo mismo (mismo plazo de 20 minutos)',
    r2.ok === true && pan30.corrida?.estado === 'terminada', JSON.stringify([r2.ok, pan30.corrida?.estado]))
  await olvidar()
  // C2: la pedida nueva se toma: ahora hay dos filas CORRIENDO, y un aviso cierra solo la última
  await db.query(`select robot_tomar_corrida($1, false)`, [org])
  await db.query(`select robot_registrar_aviso($1, 'FIN_CORRIDA', '')`, [org])
  const corriendo = (await val(`select count(*)::int n from robot_corridas where estado = 'CORRIENDO'`)).n
  check('[C] una corrida que nunca recibió aviso de fin no queda CORRIENDO para siempre', corriendo === 0, `quedaron ${corriendo} corridas CORRIENDO`)
  await db.query(`update robot_corridas set estado = 'ERROR' where estado = 'CORRIENDO'`)

  await olvidar()
  // C3: ERROR_ROBOT real: el cheque no vuelve a la cola (el Apps Script lo reintentaba solo en la corrida siguiente)
  const hE = await chequeHoja({ numero: '6002' })
  const gE = (await grupos()).grupos.find((x) => x.cheque === '6002')
  await resultado(deRobot(gE, 'ERROR_ROBOT', 'real', { detalle: 'Robot: no pudo entrar a INDIA ADV S.A. (timeout)' }))
  const sigue = (await grupos()).grupos.some((x) => x.cheque === '6002')
  check('[C] un ERROR_ROBOT transitorio (Xubio caído, timeout al cambiar de empresa) se reintenta solo en la próxima corrida, como en el Apps Script (la fila seguía CARGAR_A_MANO)', sigue,
    'el cheque sale de la cola hasta que una persona toque "Reintentar"; las corridas automáticas de las 13 y 17 no lo toman')
  const pagoE = await pg(hE.pago)
  check('[C] el pago de un ERROR_ROBOT queda CARGAR_A_MANO (no se toca), igual que la hoja', pagoE.estado_xubio_pago === 'CARGAR_A_MANO')

  // C4: SUBIDO_SIN_APLICAR: queda en "Para revisar" sin forma de resolverlo
  const hS = await chequeHoja({ numero: '6003' })
  const gS = (await grupos()).grupos.find((x) => x.cheque === '6003')
  await resultado(deRobot(gS, 'SUBIDO_SIN_APLICAR', 'real', { numeroOP: 'X-0001-00002000', detalle: '⚠ FALTA APLICAR a A-00001-00000800' }))
  const pn = await panel('teso@prueba.com')
  const a = pn.atencion.find((x) => x.cheque === '6003')
  check('[C] SUBIDO_SIN_APLICAR aparece en "Para revisar"', !!a)
  check('[C] ... y la persona tiene cómo marcarlo resuelto cuando aplica la factura a mano en Xubio (puedeCerrar y robot_cerrar_sin_aplicar)', a?.puedeCerrar === true || a?.puedeReintentar === true || (await (async () => { await como('teso@prueba.com'); const e = await error(`select robot_reintentar_cheque($1, 'op')`, [hS.id]); await servidor(); return e === null })()),
    'no hay acción para cerrarlo: el contador "Para revisar" queda en rojo para siempre')
  // pasa de SUBIDO_SIN_APLICAR a SUBIDO (por ejemplo, el robot reenvía desde la cola o alguien reenvía): el pago conserva el texto de "falta aplicar"
  await resultado(deRobot(gS, 'SUBIDO', 'real', { numeroOP: 'X-0001-00002000', detalle: 'Xubio: OP aplicada' }))
  const pS = await pg(hS.pago)
  check('[C] cuando SUBIDO_SIN_APLICAR pasa a SUBIDO, el XUBIO_DETALLE del pago se actualiza (no queda "FALTA APLICAR")', !/FALTA APLICAR/.test(pS.xubio_detalle ?? ''), pS.xubio_detalle)

  // C5: resultados repetidos y fuera de orden
  const hR = await chequeHoja({ numero: '6004' })
  const gR = (await grupos()).grupos.find((x) => x.cheque === '6004')
  const s1 = await resultado(deRobot(gR, 'SUBIDO', 'real', { numeroOP: 'X-0001-00003000' }))
  const s2 = await resultado(deRobot(gR, 'SUBIDO', 'real', { numeroOP: 'X-0001-00003000' }))
  check('[C] el mismo SUBIDO real dos veces no se registra dos veces', s1.registrados === 1 && s2.registrados === 0 && s2.repetidos === 1)
  await resultado(deRobot(gR, 'ERROR_ROBOT', 'real', { detalle: 'tarde' }))
  await resultado(deRobot(gR, 'PRUEBA_OK', 'prueba', {}))
  const cR = await chq(hR.id)
  check('[C] un ERROR o una prueba tardíos no desarman un SUBIDO real', cR.robot_op_estado === 'SUBIDO' && cR.robot_op_modo === 'real')
  check('[C] los 3 intentos dejan 2 renglones en el log para el SUBIDO real (uno OK y un OMITIDO por el ERROR) y uno por la prueba',
    (await val(`select count(*)::int n from procesos_log where entidad_id = $1 and proceso = 'ROBOT_ECHEQS'`, [hR.id])).n >= 2)

  // C6: un resultado 'real' con estado PRUEBA_OK no debería contar como real (Code.js: if (r.modo !== "real" || r.estado === "PRUEBA_OK") return)
  const hP = await chequeHoja({ numero: '6005' })
  const gP = (await grupos()).grupos.find((x) => x.cheque === '6005')
  await resultado(deRobot(gP, 'PRUEBA_OK', 'real', {}))
  const cP = await chq(hP.id)
  check('[C] real + PRUEBA_OK se ignora como el Apps Script (no marca el cheque como "real")', cP.robot_op_modo !== 'real', `robot_op_modo=${cP.robot_op_modo}`)

  // C7: cancelar y tomar
  await como('teso@prueba.com'); await db.query(`select robot_pedir_corrida('prueba', 'op')`); await db.query(`select robot_cancelar_corrida()`); await servidor()
  const tt = (await val(`select robot_tomar_corrida($1, false) r`, [org])).r
  check('[C] tomar una corrida cancelada devuelve tomada=false (robot.js lo ignora: api(cfg,"tomarCorrida") sin leer la respuesta; igual que el original)', tt.tomada === false)

  // C8: pedido viejo que nunca se tomó
  await como('teso@prueba.com'); await db.query(`select robot_pedir_corrida('real', 'op')`); await servidor()
  await db.query(`update robot_corridas set pedida_en = now() - interval '3 days' where estado = 'PEDIDA'`)
  const est = (await val(`select robot_estado($1) r`, [org])).r
  info('[C] (igual que el Apps Script) un pedido "real" de hace 3 días sigue solicitado: no vence', est)
  await db.query(`update robot_corridas set estado = 'CANCELADA' where estado = 'PEDIDA'`)
}

// ================================================================ D. Pagos, numero_op y contabilización
{
  await olvidar()
  // D1: pago del sistema (CARGADO) con e-cheq: lo toma el robot antes de que Administración lo contabilice
  const s = await chequeSistema({ numero: '8001' })
  const g = (await grupos()).grupos.find((x) => x.cheque === '8001')
  check('[D] un pago CARGADO (todavía sin contabilizar por Administración) NO debería ofrecerse al robot: en el Apps Script solo entra con CARGAR_A_MANO, que se pone al contabilizar', !g, 'el robot lo sube a Xubio en real antes de la contabilización')
  if (g) {
    await resultado(deRobot(g, 'SUBIDO', 'real', { numeroOP: 'X-0001-00004000' }))
    const p = await pg(s.pago)
    info('pago del sistema tras el robot', { estado: p.estado, xubio_id: p.xubio_id, cuenta_contable: p.cuenta_contable, contabilizado_por: p.contabilizado_por, gestion: p.gestion })
    check('[D] ... y queda CONTABILIZADO sin cuenta contable (Administración no la eligió): rompe la clasificación del Flujo y la revisión', p.cuenta_contable !== null, `estado=${p.estado} cuenta_contable=${p.cuenta_contable}`)
  }

  // D2: la unicidad de numero_op por empresa
  const a = await chequeHoja({ numero: '8002' })
  const b = await chequeHoja({ numero: '8003' })
  const ga = (await grupos()).grupos.find((x) => x.cheque === '8002'), gb = (await grupos()).grupos.find((x) => x.cheque === '8003')
  await resultado(deRobot(ga, 'SUBIDO', 'real', { numeroOP: 'X-0001-00005000' }))
  const rb = await resultado(deRobot(gb, 'SUBIDO', 'real', { numeroOP: 'X-0001-00005000' }))
  check('[D] el mismo N° de OP en dos cheques de una empresa no rompe el índice único (el segundo pago queda sin N°)', rb.registrados === 1 && (await pg(b.pago)).numero_op === null && (await pg(a.pago)).numero_op === 'X-0001-00005000')
  // un cheque que paga dos facturas = dos pagos con la misma OP
  const f1 = await pagoNuevo({ estado: 'CONTABILIZADO', gestion: 'HOJA', cheque: '8004', estadoXubioPago: 'CARGAR_A_MANO', xubioId: 'CARGAR_A_MANO', importe: 600 })
  const f2 = await pagoNuevo({ estado: 'CONTABILIZADO', gestion: 'HOJA', cheque: '8004', estadoXubioPago: 'CARGAR_A_MANO', xubioId: 'CARGAR_A_MANO', importe: 400 })
  const c4 = await cheque({ numero: '8004', pagos: [{ id: f1, importe: 600 }, { id: f2, importe: 400 }] })
  const g4 = (await grupos()).grupos.find((x) => x.cheque === '8004')
  const r4 = await resultado(deRobot(g4, 'SUBIDO', 'real', { numeroOP: 'X-0001-00005001' }))
  const ops = (await filas(`select numero_op from pagos where id in ($1, $2) order by numero_op nulls last`, [f1, f2])).map((x) => x.numero_op)
  check('[D] un cheque con dos pagos: la OP queda en uno solo y ambos pagos pasan a SUBIDO', r4.registrados === 1 && ops.filter((x) => x).length === 1 && (await pg(f1)).estado_xubio_pago === 'SUBIDO' && (await pg(f2)).estado_xubio_pago === 'SUBIDO', JSON.stringify(ops))
  // la OP ya cargada a mano en otro pago de la empresa con distinta mayúscula
  const m = await chequeHoja({ numero: '8005' })
  await db.query(`update pagos set numero_op = 'x-0001-00005002', estado = 'CONTABILIZADO' where id = (select id from pagos where numero_cheque is null limit 0)`)
  const gm = (await grupos()).grupos.find((x) => x.cheque === '8005')
  const rm = await resultado(deRobot(gm, 'SUBIDO', 'real', { numeroOP: ' X-0001-00005003 ' }))
  check('[D] el N° de OP se guarda sin espacios', (await pg(m.pago)).numero_op === 'X-0001-00005003', JSON.stringify((await pg(m.pago)).numero_op))

  // D3: ¿afecta al Flujo o a la conciliación? Los e-cheqs entran al Flujo por el cheque (medio ECHEQ queda fuera de pfuera): comparar antes/después
  const antes = (await val(`select count(*)::int n from pagos where numero_op is not null`)).n
  info('pagos con N° de OP', antes)

  // D4: espejo de la hoja: la hoja sigue diciendo CARGAR_A_MANO; cuando la fila cambia por otro motivo, la copia pisa lo que dejó el robot
  const hh = await chequeHoja({ numero: '8006' })
  const gh = (await grupos()).grupos.find((x) => x.cheque === '8006')
  await resultado(deRobot(gh, 'SUBIDO', 'real', { numeroOP: 'X-0001-00006000', detalle: 'Xubio: OP registrada' }))
  await db.query(`update pagos set hoja_id = 'P-8006', hoja_hash = 'h1' where id = $1`, [hh.pago])
  const fila = (await val(`select jsonb_build_object('hoja_id', 'P-8006', 'empresa_id', empresa_id, 'proveedor_id', proveedor_id, 'fecha', fecha::text, 'importe', importe, 'medio', medio::text,
      'forma_carga_xubio', forma_carga_xubio::text, 'estado', estado::text, 'xubio_id', xubio_id, 'contabilizado_por', 'Apps Script', 'estado_xubio_pago', 'CARGAR_A_MANO', 'xubio_detalle', null, 'hoja_hash', 'h2', 'sheets_fila_origen', 9,
      'tipo_pago', 'SIN_FACTURA', 'numero_cheque', numero_cheque, 'facturas', '[]'::jsonb, 'cargado_por', 'Apps Script') f from pagos where id = $1`, [hh.pago])).f
  let resEsp = null, e = null
  try { resEsp = (await val(`select espejar_pagos($1::jsonb, $2) r`, [JSON.stringify([fila]), org])).r } catch (x) { e = x.message }
  info('resultado de espejar_pagos', e ?? resEsp)
  if (e) info('espejar_pagos (no se pudo armar la fila de prueba)', e.slice(0, 200))
  else if ((resEsp.omitidas ?? []).length > 0) info('espejar_pagos omitió la fila de prueba', resEsp.omitidas)
  else {
    const p = await pg(hh.pago)
    info('pago de la hoja tras re-copiar la fila', { estado_xubio_pago: p.estado_xubio_pago, numero_op: p.numero_op, xubio_detalle: p.xubio_detalle })
    check('[D] la copia de la hoja no deshace en el pago lo que dejó el robot (estado_xubio_pago SUBIDO): mientras la hoja siga viva y diga CARGAR_A_MANO, un cambio cualquiera de esa fila lo vuelve a CARGAR_A_MANO',
      p.estado_xubio_pago === 'SUBIDO', `volvió a ${p.estado_xubio_pago}`)
  }
}

// ================================================================ E. Qué se le entrega al robot
{
  // E1: cheque sin cuenta de origen e-cheq / pago ECHEQ sin cheque: bloqueados; vencimiento
  const pHuerfano = await pagoNuevo({ estado: 'REVISADO', cheque: '9001', estadoXubioPago: 'CARGAR_A_MANO' })
  const gr = await grupos()
  check('[E] un pago con e-cheq que no tiene su cheque cargado figura como bloqueado con el motivo', gr.bloqueados.some((x) => x.cheque === '9001' && /no tiene su cheque/.test(x.motivo)))
  // E2: cheque con factura no subida: bloqueado
  const fNo = await factura({})
  await db.query(`update facturas set estado_xubio = 'PENDIENTE', xubio_id = null where id = $1`, [fNo])
  const pf = await pagoNuevo({ estado: 'CONTABILIZADO', gestion: 'HOJA', cheque: '9002', estadoXubioPago: 'CARGAR_A_MANO', xubioId: 'CARGAR_A_MANO' })
  await db.query(`insert into pagos_facturas (pago_id, factura_id, importe) values ($1, $2, 1000)`, [pf, fNo])
  await cheque({ numero: '9002', pagos: [{ id: pf, importe: 1000 }] })
  const gr2 = await grupos()
  check('[E] cheque con factura sin subir a Xubio queda bloqueado (no listo)', gr2.bloqueados.some((x) => x.cheque === '9002') && !gr2.grupos.some((x) => x.cheque === '9002'))
  // E3: cheque ya DEBITADO que nunca se subió: no sale ni en pendientes ni en bloqueados
  const hD = await chequeHoja({ numero: '9003' })
  await db.query(`update cheques set estado = 'DEBITADO', debitado_en = $2 where id = $1`, [hD.id, dia(-1)])
  const gr3 = await grupos()
  check('[E] un e-cheq con orden de pago sin cargar cuyo cheque ya se debitó queda visible (pendiente o bloqueado) en vez de desaparecer', gr3.grupos.some((x) => x.cheque === '9003') || gr3.bloqueados.some((x) => x.cheque === '9003'),
    'sale de la cola sin aviso: el débito dará SIN_OP')
  // E4: ERROR_DEBITO frena toda la corrida del robot; el candidato queda primero siempre
  const dd1 = await cheque({ numero: '9101', estado: 'DEBITADO', debitadoEn: dia(-10) })
  const dd2 = await cheque({ numero: '9102', estado: 'DEBITADO', debitadoEn: dia(-2) })
  const c1 = (await candidatos()).candidatos.find((x) => x.cheque === '9101')
  await resultadoDeb({ ...c1, estado: 'ERROR_DEBITO', detalle: 'no cerró', modo: 'real' })
  const cand = (await candidatos()).candidatos.map((x) => x.cheque)
  info('candidatos tras un ERROR_DEBITO real', cand.filter((x) => /^91/.test(x)))
  info('[E] (igual que el Apps Script) un ERROR_DEBITO real vuelve primero en la lista y robot.js frena toda la corrida en cada pasada; "Reintentar" en un débito no cambia nada porque el candidato no se excluye', cand.slice(0, 3))
  // E5: p_dias extremos
  const e = await error(`select robot_candidatos_debito($1, 1000000, null)`, [org])
  check('[E] dias gigante no rompe', e === null, e ?? '')
}

// ================================================================ F. ENVIO_REAL y modo
{
  // La base le entrega al robot el modo con ENVIO_REAL en falso como prueba, pero acepta resultados "real" que el robot declare igual.
  await como('teso@prueba.com'); await db.query(`select robot_pedir_corrida('real', 'op')`); await servidor()
  const t = (await val(`select robot_tomar_corrida($1, true) r`, [org])).r
  check('[F] con ENVIO_REAL apagado la corrida pedida en real se entrega como prueba', t.tomada === true && t.modo === 'prueba')
  const h = await chequeHoja({ numero: '9201' })
  const g = (await grupos()).grupos.find((x) => x.cheque === '9201')
  await resultado(deRobot(g, 'SUBIDO', 'real', { numeroOP: 'X-0001-00007000' }))
  const c = await chq(h.id)
  const corr = await val(`select modo_entregado from robot_corridas where estado = 'CORRIENDO' order by tomada_en desc limit 1`)
  check('[F] con la corrida entregada como prueba, un resultado que el robot declara "real" no debería marcar el cheque y los pagos como reales (robot.js:203 usa su --modo o cfg.modo por sobre el del servidor)',
    c.robot_op_modo !== 'real', `modo_entregado=${corr?.modo_entregado}, el cheque quedó SUBIDO real y el pago CONTABILIZADO`)
  await db.query(`update robot_corridas set estado = 'TERMINADA' where estado = 'CORRIENDO'`)
}

// ================================================================ G. Multi-organización
{
  await servidor()
  await db.exec(`
    insert into organizaciones (slug, nombre) values ('clienteb', 'Cliente B');
  `)
  const orgB = (await val(`select id from organizaciones where slug = 'clienteb'`)).id
  await db.query(`insert into empresas (id, nombre, nombre_corto, cuit, erp, organizacion_id) values ('indiasur', 'INDIA SERVICIOS S.A.', 'India Sur', '30999999991', 'XUBIO', $1)`, [orgB])
  await db.exec(`insert into usuarios (email, nombre, rol, todas_empresas, organizacion_id) values ('tesob@clienteb.com', 'Teso B', 'TESORERIA', true, '${orgB}')`)
  // El alta por defecto: la migración habilita a toda empresa XUBIO cuyo nombre contenga BERATUNG, INDIA, CONTROLB o YSD, de cualquier organización.
  await db.exec(`alter table empresas drop column robot_echeqs`)
  await aplicar(f0039)
  const hab = (await val(`select robot_echeqs r from empresas where id = 'indiasur'`)).r
  check('[G] el alta inicial de robot_echeqs solo habilita las empresas de la organización a la que el robot da servicio (una empresa de otra organización con "INDIA" en el nombre no queda habilitada)', hab === false, 'robot_echeqs=true en una organización que el robot no atiende')
  await db.query(`update empresas set robot_echeqs = true where id = 'indiasur'`)
  await como('tesob@clienteb.com')
  const r = (await val(`select robot_pedir_corrida('real', 'op') r`)).r
  await servidor()
  const est = (await val(`select robot_estado($1) r`, [org])).r
  info('pedido de la organización B', r.mensaje)
  check('[G] el pedido de una organización que el robot no atiende no promete "el robot la toma en menos de 5 minutos"', r.ok !== true || !/menos de 5 minutos/.test(r.mensaje ?? ''), 'robot_organizacion() siempre devuelve la proveedora: nadie va a tomar ese pedido')
  check('[G] el robot (organización proveedora) no ve el pedido de la B', est.solicitada === false)
  // datos de una organización no se mezclan en lo que ve el robot
  await db.query(`insert into cuentas_origen (empresa_id, nombre, banco, clase, tipo_cuenta) values ('indiasur', 'E-CHEQ X', 'ICBC', 'ECHEQ', 4)`)
  const gr = await grupos()
  check('[G] pendientes de la proveedora no trae nada de la B', gr.grupos.every((x) => x.empresa !== 'INDIA SERVICIOS S.A.') && gr.bloqueados.every((x) => x.empresa !== 'INDIA SERVICIOS S.A.'))
  await db.query(`update robot_corridas set estado = 'CANCELADA' where estado = 'PEDIDA'`)
}

console.log(`\n${ok} OK · ${bug} BUG`)
