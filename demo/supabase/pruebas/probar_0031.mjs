// Pruebas de 0031 (T-208): las correcciones de la revisión técnica T-207. Cada bloque reproduce el escenario del
// revisor (n.º del hallazgo entre corchetes) y verifica que ya no pasa. Bancos, importes y proveedores ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_0031.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
const como = async (email) => {
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const servidor = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const error = async (sql, p = []) => { try { await db.query(sql, p); return null } catch (e) { return e.message } }
const falla = async (nombre, sql, p, patron) => { const e = await error(sql, p); check(nombre, e !== null && patron.test(e), e ?? 'no falló') }
const n = (x) => Number(x)
const ext = (cuenta, hash, movs, saldos) => ({ cuenta_origen_id: cuenta, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash }, movimientos: movs, saldos })
const importar = async (cuenta, hash, movs, saldos) => (await val(`select importar_extracto($1) r`, [ext(cuenta, hash, movs, saldos)])).r

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

// Lo que había en la base ANTES de 0031 (con el error del hallazgo 2): dos cuentas del mismo banco y un
// comprobante 09990 que juntó movimientos de las dos.
let legCa, legCc, legFactura
async function antesDe0031() {
  await db.exec(`insert into usuarios (email, nombre, rol, todas_empresas) values ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMIN', true)`)
  // La CA se crea primero (y ordena primero), pero el comprobante 09990 que existe es de la CC.
  legCa = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, orden) values ('india', 'BANCO VIEJO CA', 'BANCOVIEJO', 'CA', '30888888881', 10) returning id`)).id
  legCc = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, orden) values ('india', 'BANCO VIEJO CC', 'BANCOVIEJO', 'CC', '30888888881', 20) returning id`)).id
  await importar(legCc, 'leg-cc', [{ fecha: '2026-11-10', descripcion: 'COMISION MANTENIMIENTO', importe: -200, saldo: 800 }, { fecha: '2026-11-10', descripcion: 'IVA 21%', importe: -42, saldo: 758 }])   // con IVA: 0034 deja sin IVA las comisiones al asiento
  legFactura = (await val(`select generar_comprobante_gastos($1, '2026-11-10') id`, [legCc])).id
  await importar(legCa, 'leg-ca', [{ fecha: '2026-11-10', descripcion: 'COMISION MANTENIMIENTO', importe: -100, saldo: 900 }, { fecha: '2026-11-10', descripcion: 'IVA 21%', importe: -21, saldo: 879 }])
  const pisado = (await val(`select generar_comprobante_gastos($1, '2026-11-10') id`, [legCa])).id
  check('[2] antes de 0031: la segunda cuenta pisa el comprobante de la primera (el error a corregir)',
    pisado === legFactura && n((await val(`select total from facturas where id = $1`, [legFactura])).total) === 121)
}

for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  if (f.startsWith('0031')) await antesDe0031()
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (con 0031, sobre una base con datos)', true)

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values ('aprob@prueba.com', 'Aprob', 'APROBADOR', true), ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
  insert into cuentas_contables (empresa_id, nombre) values (null, 'Banco Prueba CA'), (null, 'Banco Prueba CC');
  update cuentas_origen set requiere_extracto = false;
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const cuentaContable = async (nombre) => (await val(`select id from cuentas_contables where nombre = $1`, [nombre])).id
const cuenta = async (empresa, nombre, clase, extra = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, cuenta_contable_id, cuenta_madre_id, unidad_id, requiere_extracto)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
  [empresa, nombre, extra.banco ?? 'BANCOPRUEBA', clase, extra.cuit ?? null, extra.contable ?? null, extra.madre ?? null, extra.unidad ?? null, extra.requiere ?? false])).id
const ca = await cuenta('india', 'BANCO PRUEBA CA-0010', 'CA', { cuit: '30999999991', contable: await cuentaContable('Banco Prueba CA') })
const cc2 = await cuenta('india', 'BANCO PRUEBA CC-0020', 'CC', { cuit: '30999999991', contable: await cuentaContable('Banco Prueba CC') })
const fci = await cuenta('india', 'BANCO PRUEBA FCI UNO', 'FCI', { madre: ca })
const provX = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30111111118', 'PROVEEDOR X SA', $1) returning id`, [org])).id

// ================================================================ [17] Hoy, en Buenos Aires
check('[17] hoy_ar() es la fecha de Buenos Aires', (await val(`select hoy_ar() = (now() at time zone 'America/Argentina/Buenos_Aires')::date x`)).x)
check('[17] a las 22:30 de Buenos Aires (01:30 UTC del día siguiente) sigue siendo hoy',
  (await val(`select (timestamptz '2026-11-27 01:30:00+00' at time zone 'America/Argentina/Buenos_Aires')::date::text d`)).d === '2026-11-26')
const conFechaUtc = await filas(`
  select p.proname as nombre from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosrc ~* 'current_date'
    and p.proname in ('flujo_lineas_entre', 'flujo_control_entre', 'conciliacion_calculo', 'ajustar_linea_flujo', 'marcar_cheque_debitado', 'flujo_rango', 'flujo_control_rango')
  union all
  select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind = 'v' and c.relname in ('flujo_lineas', 'flujo_control', 'control_bancos', 'conciliacion_bancaria')
    and pg_get_viewdef(c.oid) ~* 'current_date'`)
check('[17] el Flujo, su control y el control diario ya no usan la fecha del servidor (current_date)', conFechaUtc.length === 0, JSON.stringify(conFechaUtc))
check('[17] control_envios.fecha nace con la fecha de Buenos Aires',
  /hoy_ar/.test((await val(`select pg_get_expr(d.adbin, d.adrelid) d from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = 'control_envios'::regclass and a.attname = 'fecha'`)).d))

// ================================================================ [2] Comprobante por cuenta (0999X)
const dig = async (id) => (await val(`select digito_comprobante d from cuentas_origen where id = $1`, [id])).d
check('[2] dígito de las cuentas que ya estaban: la que tiene comprobantes 09990 conserva el 0', (await dig(legCc)) === 0 && (await dig(legCa)) === 1, `${await dig(legCc)} ${await dig(legCa)}`)
check('[2] el movimiento que quedó en el comprobante de otra cuenta se soltó',
  (await val(`select count(*)::int n from movimientos_bancarios where cuenta_origen_id = $1 and factura_id is not null`, [legCa])).n === 0
  && (await val(`select count(*)::int n from movimientos_bancarios where cuenta_origen_id = $1 and factura_id = $2`, [legCc, legFactura])).n === 2)
await como('teso@prueba.com')
const legNuevo = (await val(`select generar_comprobante_gastos($1, '2026-11-10') id`, [legCa])).id
const legMismo = (await val(`select generar_comprobante_gastos($1, '2026-11-10') id`, [legCc])).id
let fs = await filas(`select id, punto_venta, total::text, cuenta_origen_extracto_id from facturas where id in ($1, $2)`, [legNuevo, legMismo])
check('[2] al regenerar: el comprobante viejo (09990) queda con lo de su cuenta y la otra tiene el suyo (09991)',
  legMismo === legFactura && legNuevo !== legFactura
  && fs.find((f) => f.id === legFactura)?.punto_venta === 9990 && fs.find((f) => f.id === legFactura)?.total === '242.00'
  && fs.find((f) => f.id === legNuevo)?.punto_venta === 9991 && fs.find((f) => f.id === legNuevo)?.total === '121.00', JSON.stringify(fs))

check('[2] cuentas nuevas del mismo banco y empresa: dígitos 0 y 1, solos', (await dig(ca)) === 0 && (await dig(cc2)) === 1)
await servidor()
const D_GASTO = dia(-12)
await importar(ca, 'h1a', [{ fecha: D_GASTO, descripcion: 'COMISION MANTENIMIENTO', importe: -100, saldo: 900 }, { fecha: D_GASTO, descripcion: 'IVA 21%', importe: -21, saldo: 879 }])   // 0034: con IVA el día queda en el comprobante
await importar(cc2, 'h1b', [{ fecha: D_GASTO, descripcion: 'COMISION MANTENIMIENTO', importe: -200, saldo: 800 }, { fecha: D_GASTO, descripcion: 'IVA 21%', importe: -42, saldo: 758 }])
await como('teso@prueba.com')
const f1 = (await val(`select generar_comprobante_gastos($1, $2) id`, [ca, D_GASTO])).id
const f2 = (await val(`select generar_comprobante_gastos($1, $2) id`, [cc2, D_GASTO])).id
fs = await filas(`select id, punto_venta, numero, total::text, cuenta_origen_extracto_id as cta from facturas where id in ($1, $2)`, [f1, f2])
const F1 = fs.find((f) => f.id === f1), F2 = fs.find((f) => f.id === f2)
check('[2] dos cuentas del mismo banco el mismo día: dos comprobantes (09990 y 09991), $121 y $242 (comisión + IVA)',
  f1 !== f2 && F1.punto_venta === 9990 && F2.punto_venta === 9991 && F1.total === '121.00' && F2.total === '242.00' && F1.cta === ca && F2.cta === cc2, JSON.stringify(fs))
check('[2] cada movimiento apunta al comprobante de su cuenta',
  (await val(`select count(*)::int n from movimientos_bancarios m join facturas f on f.id = m.factura_id where f.id in ($1, $2) and f.cuenta_origen_extracto_id <> m.cuenta_origen_id`, [f1, f2])).n === 0
  && (await val(`select count(*)::int n from movimientos_bancarios where factura_id in ($1, $2)`, [f1, f2])).n === 4)
check('[2] regenerar el de una cuenta no toca el de la otra',
  (await val(`select generar_comprobante_gastos($1, $2) id`, [ca, D_GASTO])).id === f1 && (await val(`select total::text t from facturas where id = $1`, [f2])).t === '242.00')
await servidor()
const tercera = await cuenta('india', 'BANCO PRUEBA USD', 'CC', { cuit: '30999999991' })
check('[2] una tercera cuenta del banco toma el 2; sin CUIT de banco no tiene dígito',
  (await dig(tercera)) === 2 && (await dig(fci)) === null)
await falla('[2] dos cuentas del mismo banco no pueden compartir dígito', `update cuentas_origen set digito_comprobante = 0 where id = $1`, [tercera], /cuentas_origen_digito_comprobante|duplicate|unique/i)
await db.query(`update cuentas_origen set nombre = nombre || ' (renombrada)', orden = 1 where id = $1`, [cc2])
check('[2] el dígito es estable: cambiar otros datos de la cuenta no lo mueve', (await dig(cc2)) === 1)
check('[2] el pendiente de Xubio y el control muestran el número real (09991)',
  (await val(`select count(*)::int n from xubio_bancos_pendientes where tipo = 'COMPROBANTE' and descripcion like '09991-%'`)).n === 2
  && (await val(`select count(*)::int n from control_bancos where control = 'COMPROBANTE_PENDIENTE' and detalle like '09991-%'`)).n === 2)

// ---------------------------------------------------------------- [13] Comprobante que se está enviando
await db.query(`update facturas set xubio_envio_en = now() where id = $1`, [f1])
await como('teso@prueba.com')
await falla('[13] un comprobante que se está enviando a Xubio no se regenera', `select generar_comprobante_gastos($1, $2)`, [ca, D_GASTO], /se está enviando a Xubio/)
await servidor()
await db.query(`update facturas set xubio_envio_en = null, estado_xubio = 'SUBIDA', xubio_id = '501' where id = $1`, [f1])
await como('teso@prueba.com')
await falla('[13] uno ya subido tampoco, y dice su número', `select generar_comprobante_gastos($1, $2)`, [ca, D_GASTO], /09990-\d+ ya está en Xubio/)
await servidor()
await importar(ca, 'h13', [{ fecha: D_GASTO, descripcion: 'COMISION EXTRA', importe: -30, saldo: 870 }])
check('[13] lo facturable que llega después de subir el comprobante aparece en el control diario',
  (await val(`select count(*)::int n from control_bancos where control = 'SIN_COMPROBANTE' and detalle like 'COMISION EXTRA%'`)).n === 1)

// ================================================================ [12] El subidor general no toma comprobantes bancarios
await db.query(`update facturas set estado = 'PARA_PAGAR', aprobado_en = now() - interval '1 day' where cuenta_origen_extracto_id is not null and estado = 'PENDIENTE_APROBACION'`)
for (let i = 0; i < 4; i++) {
  await importar(cc2, 'c' + i, [{ fecha: dia(-20 - i), descripcion: 'COMISION MANTENIMIENTO', importe: -10, saldo: 1000 }, { fecha: dia(-20 - i), descripcion: 'IVA 21%', importe: -2.1, saldo: 997.9 }])
  await db.query(`select generar_comprobante_gastos($1, $2)`, [cc2, dia(-20 - i)])
}
await db.query(`update facturas set estado = 'PARA_PAGAR', aprobado_en = now() - interval '1 day' where cuenta_origen_extracto_id is not null and estado = 'PENDIENTE_APROBACION'`)
const facComun = (await val(`insert into facturas (empresa_id, proveedor_id, tipo, punto_venta, numero, fecha, total, neto, origen, estado, aprobado_en)
  values ('india', $1, 'Factura A', 1, 1, $2, 100, 100, 'MANUAL', 'PARA_PAGAR', now()) returning id`, [provX, dia(-6)])).id
const lote = await filas(`select id, cuenta_origen_extracto_id from facturas_para_xubio(5, $1)`, [org])
check('[12] con 6 o más comprobantes bancarios pendientes, el lote de 5 trae la factura común',
  (await val(`select count(*)::int n from facturas where cuenta_origen_extracto_id is not null and estado_xubio = 'PENDIENTE' and estado = 'PAGADA'`)).n >= 6
  && lote.some((f) => f.id === facComun) && lote.every((f) => f.cuenta_origen_extracto_id === null), JSON.stringify(lote))

// ================================================================ [5] Regenerar el asiento del día
const D_AS = dia(-11)
await importar(ca, 'h2a', [{ fecha: D_AS, descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 894 }])
await como('teso@prueba.com')
const a1 = (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D_AS])).id
check('[5] sin nada nuevo y sin subir: se rehace igual (antes devolvía null)', (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D_AS])).id !== null)
await servidor()
await importar(ca, 'h2b', [{ fecha: D_AS, descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 894 }, { fecha: D_AS, descripcion: 'IMP LEY 25413 S/CRED', importe: -3, saldo: 891 }])
await como('teso@prueba.com')
const a2 = (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D_AS])).id
const lin = await filas(`select cuenta_contable, debe::text, haber::text from asiento_lineas where asiento_id = $1 order by debe desc`, [a2])
check('[5] llega otro movimiento del día: el asiento se regenera con los dos ($9)', a2 && a2 !== a1 && lin.length === 2 && lin[0].debe === '9.00' && lin[1].haber === '9.00', JSON.stringify(lin))
check('[5] queda un solo asiento vigente y los dos movimientos apuntan a él',
  (await val(`select count(*)::int n from asientos where cuenta_origen_id = $1 and fecha = $2`, [ca, D_AS])).n === 1
  && (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [a2])).n === 2)
await servidor()
await db.query(`select resultado_asiento_xubio($1, false, null, 'Xubio no respondió')`, [a2])
await como('teso@prueba.com')
const a3 = (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D_AS])).id
check('[5] después de un error de Xubio se puede regenerar', a3 && a3 !== a2 && (await val(`select estado_xubio::text e from asientos where id = $1`, [a3])).e === 'PENDIENTE')

// ---------------------------------------------------------------- [6] Asiento anulado mientras se envía
await servidor()
await db.query(`update asientos set envio_xubio_en = now() where id = $1`, [a3])
await como('teso@prueba.com')
await falla('[6] un asiento que se está enviando no se regenera', `select generar_asiento_bancario($1, $2)`, [ca, D_AS], /se está enviando a Xubio/)
await como('admin@prueba.com')
await falla('[6] ni se anula: hay que esperar el resultado', `select anular_asiento($1, 'error')`, [a3], /se está enviando a Xubio/)
await servidor()
// Si igual quedó anulado en el medio (dos pedidos a la vez) y Xubio lo aceptó, no se pierde: queda para anular allá.
await db.query(`update asientos set anulado_en = now(), anulado_por = 'admin@prueba.com', motivo_anulacion = 'carrera', anulacion_xubio = 'HECHA' where id = $1`, [a3])
await db.query(`select resultado_asiento_xubio($1, true, '7001', null)`, [a3])
const an = await val(`select estado_xubio::text e, xubio_id, anulacion_xubio from asientos where id = $1`, [a3])
check('[6] anulado + aceptado por Xubio: queda pendiente de anular en Xubio (no HECHA)', an.e === 'SUBIDA' && an.xubio_id === '7001' && an.anulacion_xubio === 'PENDIENTE', JSON.stringify(an))
check('[6] …y aparece en el control diario', (await val(`select count(*)::int n from control_bancos where control = 'ANULAR_EN_XUBIO'`)).n >= 1)
await db.query(`update movimientos_bancarios set asiento_id = null where asiento_id = $1`, [a3])
await como('teso@prueba.com')
const a4 = (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D_AS])).id
await servidor()
await db.query(`select resultado_asiento_xubio($1, true, '7002', null)`, [a4])
await como('teso@prueba.com')
check('[5] ya subido y sin movimientos nuevos: no hay nada que hacer', (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D_AS])).id === null)
await como('admin@prueba.com')
check('[6] un asiento subido (sin envío en curso) se anula como siempre', (await error(`select anular_asiento($1, 'prueba')`, [a4])) === null
  && (await val(`select anulacion_xubio a from asientos where id = $1`, [a4])).a === 'PENDIENTE')

// ================================================================ [1] Contraparte de FCI y rendimiento
await servidor()
const D0 = dia(-4), D1 = dia(-3), D2 = dia(-2)
await importar(ca, 'h4', [{ fecha: D1, descripcion: 'SUSCRIPCION FCI UNO', importe: -500, saldo: 3500 }])
await como('teso@prueba.com')
await db.query(`select registrar_saldo($1, $2, 7907.01)`, [fci, D0])
await db.query(`select registrar_saldo($1, $2, 8407.50)`, [fci, D1])
let mvFci = await val(`select id, contraparte_cuenta_id from movimientos_bancarios where descripcion = 'SUSCRIPCION FCI UNO'`)
let kf = await val(`select rendimiento::text r, estado from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = $2`, [fci, D1])
check('[1] un solo fondo: la suscripción toma su contraparte sola (0030) y el rendimiento es 0,49, no 500,49',
  mvFci.contraparte_cuenta_id === fci && kf.r === '0.49' && kf.estado === 'OK', JSON.stringify(kf))
// Segundo fondo en la misma cuenta: ya no se puede saber solo.
await servidor()
const fci2 = await cuenta('india', 'BANCO PRUEBA FCI DOS', 'FCI', { madre: ca })
await importar(ca, 'h4b', [{ fecha: D2, descripcion: 'SUSCRIPCION FCI DOS', importe: -1000, saldo: 2500 }])
await como('teso@prueba.com')
await db.query(`select registrar_saldo($1, $2, 5000)`, [fci2, D1])
await db.query(`select registrar_saldo($1, $2, 6000.80)`, [fci2, D2])
mvFci = await val(`select id, contraparte_cuenta_id from movimientos_bancarios where descripcion = 'SUSCRIPCION FCI DOS'`)
kf = await val(`select rendimiento::text r, estado from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = $2`, [fci2, D2])
check('[1] dos fondos: sin contraparte, el "rendimiento" de 1.000,80 (20 %) queda REVISAR, no OK',
  mvFci.contraparte_cuenta_id === null && kf.r === '1000.80' && kf.estado === 'REVISAR', JSON.stringify(kf))
const avisos = (await filas(`select control from control_bancos where control in ('RENDIMIENTO_A_REVISAR', 'FCI_SIN_CONTRAPARTE')`)).map((x) => x.control).sort().join()
check('[1] …y el control diario avisa las dos cosas', avisos === 'FCI_SIN_CONTRAPARTE,RENDIMIENTO_A_REVISAR', avisos)
await falla('[1] la persona no puede escribir la contraparte directo en la tabla', `update movimientos_bancarios set contraparte_cuenta_id = $1 where id = $2`, [fci2, mvFci.id], /permission denied/)
await como('aprob@prueba.com')
await falla('[1] asignar_contraparte: solo Tesorería, Administración o Admin', `select asignar_contraparte($1, $2)`, [mvFci.id, fci2], /rol/i)
await como('teso@prueba.com')
const cuentaBeratung = await (async () => { await servidor(); const id = await cuenta('beratung', 'BANCO PRUEBA BERATUNG', 'CC'); await como('teso@prueba.com'); return id })()
await falla('[1] la contraparte tiene que ser de la misma empresa', `select asignar_contraparte($1, $2)`, [mvFci.id, cuentaBeratung], /misma empresa/)
await db.query(`select asignar_contraparte($1, $2)`, [mvFci.id, fci2])
kf = await val(`select rendimiento::text r, estado from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = $2`, [fci2, D2])
check('[1] con la contraparte asignada por Tesorería: rendimiento 0,80 y OK', kf.r === '0.80' && kf.estado === 'OK', JSON.stringify(kf))
check('[1] …y el Flujo muestra 0,80 en "Rendimientos FCI"',
  (await val(`select importe::text i from flujo_lineas where origen_tipo = 'RENDIMIENTO' and origen_id = $1 and fecha = $2`, [fci2, D2]))?.i === '0.80')
check('[1] …y los avisos del control se van',
  (await val(`select count(*)::int n from control_bancos where control in ('RENDIMIENTO_A_REVISAR', 'FCI_SIN_CONTRAPARTE')`)).n === 0)

// ================================================================ [14] Reclasificar como gasto bancario
await servidor()
const D_RE = dia(-9)
await importar(ca, 'h7', [{ fecha: D_RE, descripcion: 'DEBITO PAQ XYZ', importe: -50, saldo: 3450 }, { fecha: D_RE, descripcion: 'IVA 21%', importe: -20, saldo: 3430 }])
const mid = (await val(`select id from movimientos_bancarios where descripcion = 'DEBITO PAQ XYZ'`)).id
await como('teso@prueba.com')
await db.query(`select reclasificar_movimiento($1, 'GASTO_BANCARIO', 'GASTOS BANCARIOS', 'PAQ XYZ')`, [mid])
let mv = await val(`select categoria, destino_xubio, componente from movimientos_bancarios where id = $1`, [mid])
check('[14] reclasificado como gasto bancario: va al comprobante, como neto', mv.destino_xubio === 'COMPROBANTE' && mv.componente === 'NETO', JSON.stringify(mv))
const reglaNueva = await val(`select destino_xubio, componente from reglas_extracto where creada_por = 'teso@prueba.com' and patrones = array['PAQ XYZ']`)
check('[14] la regla aprendida también', reglaNueva?.destino_xubio === 'COMPROBANTE' && reglaNueva?.componente === 'NETO', JSON.stringify(reglaNueva))
const fRe = (await val(`select generar_comprobante_gastos($1, $2) id`, [ca, D_RE])).id
check('[14] el comprobante del día lo incluye ($70)', fRe !== null && (await val(`select total::text t from facturas where id = $1`, [fRe])).t === '70.00')
await db.query(`select reclasificar_movimiento($1, 'IMPUESTO', 'IVA COMPRAS', null, 'IVA')`, [mid])
mv = await val(`select destino_xubio, componente, factura_id from movimientos_bancarios where id = $1`, [mid])
const fRe2 = await val(`select neto::text, iva::text, total::text from facturas where id = $1`, [fRe])
check('[14] con componente: IVA dentro del comprobante, que se rehace solo (IVA 20 + 50 reclasificado)',
  mv.componente === 'IVA' && mv.factura_id === fRe && fRe2.neto === '0.00' && fRe2.iva === '70.00' && fRe2.total === '70.00', JSON.stringify([mv, fRe2]))
await db.query(`select reclasificar_movimiento($1, 'INFORMATIVO', null)`, [mid])
mv = await val(`select destino_xubio, componente, factura_id from movimientos_bancarios where id = $1`, [mid])
check('[14] si sale del comprobante, se suelta y el comprobante baja a $20',
  mv.destino_xubio === 'NINGUNO' && mv.componente === null && mv.factura_id === null && (await val(`select total::text t from facturas where id = $1`, [fRe])).t === '20.00')
await falla('[14] categoría inválida: no pasa', `select reclasificar_movimiento($1, 'CUALQUIERA', null)`, [mid], /categoria_check/)

// ================================================================ [8] [7] [15] Cheques
await servidor()
const org2 = (await val(`insert into organizaciones (slug, nombre) values ('otra', 'Otra SA') returning id`)).id
await db.query(`insert into empresas (id, nombre, nombre_corto, organizacion_id, cuit) values ('otra-sa', 'Otra SA', 'Otra', $1, '30333333338')`, [org2])
const acr2 = (await val(`insert into acreedores (organizacion_id, nombre) values ($1, 'ACREEDOR DE OTRA ORG') returning id`, [org2])).id
const prov2 = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30222222228', 'PROV OTRA ORG', $1) returning id`, [org2])).id
const cheque = (extra) => ({ empresa_id: 'india', cuenta_origen_id: ca, tipo: 'ECHEQ', beneficiario: 'PROVEEDOR X SA', importe: 1000, fecha_emision: dia(-8), fecha_pago: dia(20), ...extra })
await como('teso@prueba.com')
await falla('[8] cheque con acreedor de otra organización: no', `select emitir_cheque($1)`, [cheque({ numero: '111', acreedor_id: acr2 })], /acreedor es de otra organización/)
await falla('[8] cheque con proveedor de otra organización: no', `select emitir_cheque($1)`, [cheque({ numero: '112', proveedor_id: prov2 })], /proveedor es de otra organización/)
await servidor()
await falla('[8] ni por otro camino (alta directa del servidor)',
  `insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, beneficiario, importe, fecha_emision, fecha_pago, creado_por) values ('india', $1, 'ECHEQ', '113', $2, 'X', 10, $3, $3, 'prueba')`,
  [ca, acr2, dia(-8)], /acreedor es de otra organización/)
const pagoCh = (await val(`insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por) values ('india', $1, $2, 1000, 'ECHEQ', 'teso@prueba.com') returning id`, [provX, dia(-8)])).id
await como('teso@prueba.com')
const ch1 = (await val(`select emitir_cheque($1) id`, [cheque({ numero: '201', pagos: [{ pago_id: pagoCh, importe: 1000 }] })])).id
await falla('[7] el mismo pago en un segundo cheque: no', `select emitir_cheque($1)`, [cheque({ numero: '202', pagos: [{ pago_id: pagoCh, importe: 1000 }] })], /ya está cubierto por otro cheque/)
check('[7] el Flujo proyecta el pago una sola vez (−1.000)', (await val(`select sum(importe)::text s from flujo_lineas where origen_tipo = 'CHEQUE' and naturaleza = 'PROYECTADO'`)).s === '-1000.00')
await db.query(`select anular_cheque($1, 'se rehace')`, [ch1])
const ch2 = (await val(`select emitir_cheque($1) id`, [cheque({ numero: '203', pagos: [{ pago_id: pagoCh, importe: 1000 }] })])).id
check('[7] anulado el primero, el pago se puede cubrir con otro cheque', !!ch2)
await servidor()
await importar(ca, 'h9', [{ fecha: dia(-1), descripcion: 'ECHEQ 203', importe: -1000, saldo: 0 }])
const mvCh = (await val(`select id from movimientos_bancarios where descripcion = 'ECHEQ 203'`)).id
await db.query(`update movimientos_bancarios set estado = 'CONTABILIZADO' where id = $1`, [mvCh])
await como('teso@prueba.com')
await falla('[15] débito anterior a la emisión del cheque: no', `select marcar_cheque_debitado($1, '203', '2020-01-01')`, [ch2], /anterior a la emisión/)
await falla('[15] débito con fecha futura: no', `select marcar_cheque_debitado($1, '203', $2)`, [ch2, dia(3)], /fecha futura/)
await db.query(`select marcar_cheque_debitado($1, '203', $2, $3)`, [ch2, dia(-1), mvCh])
check('[15] marcar debitado no reabre un movimiento ya contabilizado',
  (await val(`select estado, cheque_id from movimientos_bancarios where id = $1`, [mvCh])).estado === 'CONTABILIZADO'
  && (await val(`select estado from cheques where id = $1`, [ch2])).estado === 'DEBITADO')

// ================================================================ [10] [19] Importar después de migrar; movimientos iguales
await servidor()
const D_MIG = dia(-15)
await db.query(`insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, saldo, huella, categoria, estado)
  values ('india', $1, $2, 'IMP LEY 25413 S/DEB', -6, 994, 'VBI:4711', 'IMPUESTO', 'PENDIENTE')`, [cc2, D_MIG])
let r = await importar(cc2, 'post-migracion', [{ fecha: D_MIG, descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 994 }])
let cuantos = await val(`select count(*)::int n, sum(importe)::text s from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [cc2, D_MIG])
check('[10] el extracto que se superpone con lo migrado de la planilla no duplica', r.nuevos === 0 && r.ya_migrados === 1 && cuantos.n === 1 && cuantos.s === '-6.00', JSON.stringify([r, cuantos]))
r = await importar(cc2, 'post-migracion-2', [
  { fecha: D_MIG, descripcion: 'Imp Ley 25413  s/Deb', importe: -6, saldo: 994, referencia: 'A1' },
  { fecha: D_MIG, descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 988, referencia: 'A2' },
  { fecha: D_MIG, descripcion: 'OTRO DEBITO', importe: -6, saldo: 982 }])
cuantos = await val(`select count(*)::int n from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [cc2, D_MIG])
check('[10] dos iguales en el archivo y uno migrado: entra uno (y lo distinto entra)', r.nuevos === 2 && r.ya_migrados === 1 && cuantos.n === 3, JSON.stringify([r, cuantos]))
const D_IG = dia(-16)
r = await importar(cc2, 'iguales', [
  { fecha: D_IG, descripcion: 'A  X', importe: -5, saldo: 1 }, { fecha: D_IG, descripcion: 'A B', importe: -5, saldo: 1 }, { fecha: D_IG, descripcion: 'A X', importe: -5, saldo: 1 }])
check('[19] "A  X", "A B" y "A X" del mismo día e importe: entran los tres (antes se perdía uno)', r.nuevos === 3 && r.movimientos === 3, JSON.stringify(r))
r = await importar(cc2, 'iguales-otra-vez', [
  { fecha: D_IG, descripcion: 'A X', importe: -5, saldo: 1 }, { fecha: D_IG, descripcion: 'A B', importe: -5, saldo: 1 }, { fecha: D_IG, descripcion: 'A  X', importe: -5, saldo: 1 }])
check('[19] el mismo contenido en otro archivo y otro orden: nada nuevo', r.nuevos === 0, JSON.stringify(r))

// ================================================================ [16] Reglas del Flujo consistentes
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const uDax = (await val(`select id from unidades where empresa_id = 'beratung' and codigo = 'dax-salud'`)).id
const uBer = (await val(`select id from unidades where empresa_id = 'beratung' and codigo = 'beratung'`)).id
const fila = async (unidad, etiqueta, extra = {}) => (await val(
  `insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable, apertura) values ($1, 'x', $2, $3, 'GASTOS_OPERATIVOS', $4, $5, $6) returning id`,
  [unidad, extra.orden ?? 310, extra.tipo ?? 'CUENTA', etiqueta, extra.cuenta ?? null, extra.apertura ?? null])).id
const filaDaxAlq = await fila(uDax, 'Alquileres', { cuenta: 'ALQUILERES' })
await fila(uIndia, 'Alquileres', { cuenta: 'ALQUILERES' })
const regla = (cols, vals) => error(`insert into flujo_reglas (${cols}) values (${vals.map((_, i) => '$' + (i + 1)).join(', ')})`, vals)
check('[16] regla de toda la organización con unidad: no', /no puede elegir unidad ni fila/.test(await regla('organizacion_id, unidad_id', [org, uDax]) ?? ''))
check('[16] fila de otra empresa: no', /fila es de otra empresa/.test(await regla('empresa_id, fila_id', ['india', filaDaxAlq]) ?? ''))
check('[16] unidad de otra empresa: no', /unidad es de otra empresa/.test(await regla('empresa_id, unidad_id', ['india', uDax]) ?? ''))
check('[16] fila que no es de esa unidad: no', /fila no es de esa unidad/.test(await regla('empresa_id, unidad_id, fila_id', ['beratung', uBer, filaDaxAlq]) ?? ''))
check('[16] una regla bien armada entra; sin unidad, toma la de su fila',
  (await regla('empresa_id, si_texto, fila_id, nota', ['beratung', 'ALQUILER LOCAL', filaDaxAlq, 'prueba'])) === null
  && (await val(`select unidad_id from flujo_reglas where nota = 'prueba'`)).unidad_id === uDax)
check('[16] una regla de la organización que solo excluye sigue valiendo', (await regla('organizacion_id, si_texto, excluir, nota', [org, 'NO VA AL FLUJO', true, 'excluir'])) === null)

// ================================================================ [18] Funciones que salteaban las reglas de lectura
const seg = await filas(`select p.proname, p.prosecdef, has_function_privilege('anon', p.oid, 'execute') as anon
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname in ('unidad_por_defecto', 'fila_especial', 'flujo_destino')`)
check('[18] unidad_por_defecto, fila_especial y flujo_destino: sin privilegios de dueño y cerradas a anónimos', seg.length === 3 && seg.every((f) => !f.prosecdef && !f.anon), JSON.stringify(seg))
await como('solober@prueba.com')
check('[18] quien ve solo Beratung no saca ids de India',
  (await val(`select unidad_por_defecto('india') u`)).u === null && (await val(`select fila_especial($1, 'SIN_CLASIFICAR') f`, [uIndia])).f === null
  && (await val(`select unidad_por_defecto('beratung') u`)).u === uBer)
await servidor()
const nuevas = await filas(`select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    and p.proname in ('hoy_ar', 'conciliacion_calculo', 'flujo_lineas_entre', 'flujo_rango', 'flujo_control_entre', 'flujo_control_rango', 'asignar_contraparte',
                      'cuenta_con_digito', 'flujo_regla_consistente', 'reclasificar_movimiento', 'importar_extracto', 'conciliar_tras_cambio')`)
check('[18] ninguna función nueva queda ejecutable por anónimos', nuevas.length === 0, JSON.stringify(nuevas))
check('las vistas rehechas siguen sin lectura para anónimos ni escritura para personas',
  (await val(`select count(*)::int n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public'
     and c.relname in ('conciliacion_bancaria', 'flujo_lineas', 'flujo_control', 'control_bancos', 'xubio_bancos_pendientes')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert') or not has_table_privilege('authenticated', c.oid, 'select')
          or not coalesce(c.reloptions @> array['security_invoker=true'], false))`)).n === 0)

// ================================================================ [4] [3] El Flujo: pago y débito, destino por conjuntos, rango y control
// Unidad Dax Salud (empresa Beratung) con una sola cuenta que exige extracto.
const dx = await cuenta('beratung', 'BANCO PRUEBA DAX CC', 'CC', { unidad: uDax, requiere: true })
const provDax = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30111111126', 'INSUMOS DEL SUR SRL', $1) returning id`, [org])).id
await fila(uDax, 'Gastos bancarios', { cuenta: 'GASTOS BANCARIOS', orden: 320 })
await fila(uDax, 'Proveedores', { cuenta: 'PROVEEDORES', orden: 330 })
await fila(uDax, 'Proveedores · Insumos del Sur', { cuenta: 'PROVEEDORES', apertura: 'Insumos del Sur', tipo: 'APERTURA', orden: 331 })
const P0 = dia(-7), P1 = dia(-6), P2 = dia(-5), P3 = dia(-4)
await db.query(`insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cuenta_contable, cargado_por, cuenta_origen_id, estado_xubio_pago) values ('beratung', $1, $2, 1000, 'TRANSFERENCIA', 'PROVEEDORES', 'teso@prueba.com', $3, 'SUBIDO')`, [provDax, P1, dx])
r = await importar(dx, 'h3', [
  { fecha: P0, descripcion: 'DEPOSITO INICIAL', importe: 5000, saldo: 5000 },
  { fecha: P1, descripcion: 'TRANSF. A PROVEEDOR CBU 0000', importe: -1000, saldo: 4000 },
  { fecha: P2, descripcion: 'COMISION MANTENIMIENTO', importe: -300, saldo: 3700 },
  { fecha: P2, descripcion: 'PAGO ALQUILER LOCAL CENTRO', importe: -700, saldo: 3000 },
  { fecha: P3, descripcion: 'DEBITO NO VA AL FLUJO', importe: -50, saldo: 2950 }])
check('[3] importar concilia una sola vez al final y el débito queda vinculado a su pago',
  (await val(`select count(*)::int n from movimientos_bancarios where cuenta_origen_id = $1 and pago_id is not null`, [dx])).n === 1)
await como('teso@prueba.com')
let lineas = await filas(`select origen_tipo, fila, importe::text, fecha::text from flujo_lineas where unidad_id = $1 and naturaleza = 'REAL' order by fecha, importe`, [uDax])
const delDia = (d) => lineas.filter((l) => l.fecha === d)
check('[4] pago y su débito sin clasificar: el Flujo cuenta −1.000 una sola vez (ya resuelto en 0030)',
  delDia(P1).length === 1 && delDia(P1)[0].origen_tipo === 'PAGO' && delDia(P1)[0].importe === '-1000.00', JSON.stringify(delDia(P1)))
check('[3] destino por conjuntos: apertura del proveedor, fila de la cuenta contable y regla por texto',
  delDia(P1)[0].fila === 'Proveedores · Insumos del Sur'
  && delDia(P2).find((l) => l.importe === '-300.00')?.fila === 'Gastos bancarios'
  && delDia(P2).find((l) => l.importe === '-700.00')?.fila === 'Alquileres', JSON.stringify(lineas))
check('[3] lo real de un banco que una regla excluye va a "Entre cuentas propias" de su unidad (0030), no desaparece',
  delDia(P3).length === 1 && delDia(P3)[0].fila === 'Entre cuentas propias', JSON.stringify(delDia(P3)))
check('[3] sin regla ni cuenta: "Sin clasificar"', delDia(P0)[0]?.fila === 'Sin clasificar')
// El destino por conjuntos da lo mismo que la función flujo_destino, línea por línea.
const distintas = await val(`
  select count(*)::int n from (
    select m.id, l.fila_id as por_conjuntos, d.fila_id as por_funcion, d.excluir
    from movimientos_bancarios m
    join cuentas_origen co on co.id = m.cuenta_origen_id
    join flujo_lineas l on l.origen_tipo = 'MOVIMIENTO' and l.origen_id = m.id and l.ocurrencia = 'MOVIMIENTO'
    cross join lateral flujo_destino(m.empresa_id, co.unidad_id, 'MOVIMIENTO', null, m.cuenta_contable, m.cuenta_origen_id, m.categoria,
                                     coalesce(co.nombre, '') || ' ' || coalesce(m.descripcion, '')) d
    where not d.excluir
  ) x where x.por_conjuntos is distinct from x.por_funcion`)
check('[3] mismo destino que flujo_destino() en todos los movimientos de la base', distintas.n === 0, JSON.stringify(distintas))
check('[3] el Flujo ya no llama a una función por línea (flujo_destino, extracto_cubre, unidad_por_defecto, fila_especial)',
  !(await val(`select prosrc ~* '(flujo_destino|extracto_cubre|unidad_por_defecto|fila_especial)\\s*\\(' as x from pg_proc where proname = 'flujo_lineas_entre'`)).x)

// flujo_rango = la vista filtrada, en una llamada.
const comparar = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clave = `origen_tipo, origen_id::text, ocurrencia, naturaleza, fecha::text, fecha_calculada::text, importe::text, fila_id::text, unidad_id::text, contraparte, concepto, vencido, ajustada, editable`
const orden = `order by fecha, origen_tipo, origen_id, ocurrencia`
const deVista = await filas(`select ${clave} from flujo_lineas where fecha between $1 and $2 ${orden}`, [P1, dia(30)])
const deRango = await filas(`select ${clave.replace(/(\w+)::text/g, "x->>'$1' as $1").replace(/\b(contraparte|concepto)\b/g, "x->>'$1' as $1").replace(/\b(vencido|ajustada|editable)\b/g, "(x->>'$1')::boolean as $1").replace(/\b(origen_tipo|ocurrencia|naturaleza)\b/g, "x->>'$1' as $1")}
  from jsonb_array_elements(flujo_rango(null, $1, $2)) x`, [P1, dia(30)])
check('[3] flujo_rango(todas, desde, hasta) = flujo_lineas filtrada por fecha, mismas líneas y mismo orden',
  deVista.length > 5 && comparar(deVista, deRango), `${deVista.length} vs ${deRango.length}`)
const deUnidad = await val(`select jsonb_array_length(flujo_rango($1, $2, $3)) n, (select count(*)::int from flujo_lineas where unidad_id = $1 and fecha between $2 and $3) v`, [uDax, P1, dia(30)])
check('[3] flujo_rango de una unidad trae solo esa unidad', deUnidad.n === deUnidad.v && deUnidad.n >= 4 && deUnidad.n < deVista.length, JSON.stringify(deUnidad))
check('[3] fuera del rango no trae nada real', (await val(`select count(*)::int n from jsonb_array_elements(flujo_rango(null, $1, $1)) x where x->>'fecha' <> $1::date::text`, [P2])).n === 0
  && (await val(`select jsonb_array_length(flujo_rango($1, $2, $2)) n`, [uDax, P2])).n === 2)
await como('solober@prueba.com')
check('[3] flujo_rango respeta las empresas que ve la persona',
  (await val(`select count(*)::int n from jsonb_array_elements(flujo_rango(null, $1, $2)) x where x->>'empresa_id' <> 'beratung'`, [dia(-30), dia(30)])).n === 0
  && (await val(`select jsonb_array_length(flujo_rango(null, $1, $2)) n`, [dia(-30), dia(30)])).n >= 4)
await como('teso@prueba.com')

// Control contra bancos: mismo resultado que sumando el Flujo día por día (la forma de antes).
const ctl = await filas(`select fecha::text, saldo_anterior::text, saldo_bancos::text, real_del_periodo::text, diferencia::text, estado from flujo_control where unidad_id = $1 order by fecha`, [uDax])
check('[4] [3] control del Flujo de la unidad: primer saldo y después OK día por día',
  ctl.length === 4 && ctl[0].estado === 'PRIMER_SALDO' && ctl.slice(1).every((c) => c.estado === 'OK')
  && ctl[1].real_del_periodo === '-1000.00' && ctl[2].real_del_periodo === '-1000.00' && ctl[3].real_del_periodo === '-50.00', JSON.stringify(ctl))
const ctlDistinto = await val(`
  select count(*)::int n, (select count(*)::int from flujo_control) total from flujo_control k
  left join lateral (select sum(l.importe) as movido from flujo_lineas l
                     where l.unidad_id = k.unidad_id and l.naturaleza = 'REAL' and l.afecta_bancos and l.fecha > k.fecha_anterior and l.fecha <= k.fecha) r on true
  where k.real_del_periodo is distinct from r.movido`)
check('[3] flujo_control = lo real del Flujo sumado día por día (cálculo anterior), en todas las unidades', ctlDistinto.n === 0 && ctlDistinto.total >= 4, JSON.stringify(ctlDistinto))
const ctlRango = await val(`select flujo_control_rango($1) j`, [P2])
check('[3] flujo_control_rango(desde) = la vista desde ese día',
  comparar(ctlRango.j.filter((c) => c.unidad_id === uDax).map((c) => [c.fecha, String(c.estado), Number(c.real_del_periodo)]), ctl.slice(2).map((c) => [c.fecha, c.estado, Number(c.real_del_periodo)])), JSON.stringify(ctlRango.j))
// Un F de verdad se sigue viendo, en el control y en el mail.
await servidor()
await db.query(`insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, 'beratung', 2000, 'EXTRACTO', 'prueba')`, [dx, dia(-3)])
check('[3] una diferencia real sigue dando F y sale en el control diario',
  (await val(`select estado, diferencia::text d from flujo_control where unidad_id = $1 and fecha = $2`, [uDax, dia(-3)])).d === '-950.00'
  && (await val(`select count(*)::int n from control_bancos where control = 'FLUJO_F' and fecha = $1`, [dia(-3)])).n === 1)

// Conciliación con ventanas = la de antes (subconsulta por fila), fila por fila, en toda la base de la prueba.
// Se suman días con movimientos y sin saldo de cierre (tramos de varios días) y un movimiento ignorado.
await db.query(`insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
  select 'india', $1, $2::date + g, 'SIN SALDO ' || g, case when g = 2 then 80 else -40 end, 'PRUEBA-SS-' || g, 'INFORMATIVO', case when g = 3 then 'IGNORADO' else 'INFORMATIVO' end
  from generate_series(0, 3) g`, [ca, dia(-40)])
await db.query(`insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, 'india', 500, 'MANUAL', 'prueba'), ($1, $3, 'india', 500, 'EXTRACTO', 'prueba')`, [ca, dia(-42), dia(-36)])
await db.exec(`create view conc_anterior as
with mov as (
  select cuenta_origen_id as cuenta_id, fecha, importe from movimientos_bancarios where estado <> 'IGNORADO'
  union all
  select contraparte_cuenta_id, fecha, -importe from movimientos_bancarios where contraparte_cuenta_id is not null and estado <> 'IGNORADO'
), dias as (
  select cuenta_origen_id as cuenta_id, fecha from saldos_bancarios union select cuenta_id, fecha from mov
)
select d.cuenta_id, d.fecha, s.saldo as saldo_extracto, ant.fecha as fecha_anterior, ant.saldo as saldo_anterior,
       coalesce(m.creditos, 0) as creditos, coalesce(m.debitos, 0) as debitos, coalesce(m.n, 0) as movimientos
from dias d
left join saldos_bancarios s on s.cuenta_origen_id = d.cuenta_id and s.fecha = d.fecha
left join lateral (select a.fecha, a.saldo from saldos_bancarios a where a.cuenta_origen_id = d.cuenta_id and a.fecha < d.fecha order by a.fecha desc limit 1) ant on true
left join lateral (select sum(importe) filter (where importe > 0) as creditos, -sum(importe) filter (where importe < 0) as debitos, count(*) as n
                   from mov x where x.cuenta_id = d.cuenta_id and x.fecha <= d.fecha and (ant.fecha is null or x.fecha > ant.fecha)) m on true`)
const conc = await val(`
  select (select count(*)::int from conciliacion_bancaria) as nuevas, (select count(*)::int from conc_anterior) as viejas,
         (select count(*)::int from conc_anterior v full join conciliacion_bancaria k on k.cuenta_origen_id = v.cuenta_id and k.fecha = v.fecha
          where (v.saldo_extracto, v.fecha_anterior, v.saldo_anterior, v.creditos, v.debitos, v.movimientos)
                is distinct from (k.saldo_extracto, k.fecha_anterior, k.saldo_anterior, k.creditos, k.debitos, k.movimientos)) as distintas,
         (select count(*)::int from conciliacion_bancaria where saldo_extracto is null) as sin_saldo,
         (select count(*)::int from conciliacion_bancaria where movimientos > 1) as con_varios`)
check('[3] conciliación con funciones de ventana = la anterior, fila por fila (con días sin saldo y tramos de varios días)',
  conc.nuevas === conc.viejas && conc.distintas === 0 && conc.nuevas > 20 && conc.sin_saldo > 0 && conc.con_varios > 0, JSON.stringify(conc))

// ================================================================ [20] Ajuste de importe con pago sin factura (ESPERA_FC)
await servidor()
const provE = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30111111134', 'PROVEEDOR CON ANTICIPO SA', $1) returning id`, [org])).id
const facE = (await val(`insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable)
  values ('india', $1, 'Factura A', 'A', 1, 900, $2, $3, 1000, 1000, 'PARA_PAGAR', 0, 'PROVEEDORES') returning id`, [provE, dia(-10), dia(15)])).id
await db.query(`insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, estado)
  values ('india', $1, $2, 400, 'CAJA', 'teso@prueba.com', 'SIN_FACTURA', 'SALIDA_FONDOS', 'CARGADO')`, [provE, dia(-3)])
const totalFac = async () => (await val(`select coalesce(sum(importe), 0)::numeric::text t from flujo_lineas where origen_tipo = 'FACTURA' and origen_id = $1`, [facE])).t
check('[20] factura de 1.000 con 400 pagados sin factura: se proyectan −600', (await totalFac()) === '-600.00')
await como('teso@prueba.com')
await db.query(`select ajustar_linea_flujo('FACTURA', $1, 'SALDO', null, 1000, false, 'Importe de la factura')`, [facE])
check('[20] un ajuste a 1.000 no vuelve a sumar los 400 ya pagados: siguen −600', (await totalFac()) === '-600.00', await totalFac())
await db.query(`select ajustar_linea_flujo('FACTURA', $1, 'SALDO', null, 450, false, 'Acordamos 450')`, [facE])
check('[20] un ajuste por menos de lo que queda manda (−450)', (await totalFac()) === '-450.00', await totalFac())
await falla('[17] no se proyecta en el pasado (ayer de Buenos Aires)', `select ajustar_linea_flujo('FACTURA', $1, 'SALDO', $2, null, false, 'atrás')`, [facE, dia(-1)], /pasado/)
check('[17] hoy (de Buenos Aires) sí se puede', (await error(`select ajustar_linea_flujo('FACTURA', $1, 'SALDO', $2, null, false, 'hoy')`, [facE, hoy])) === null)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
