// Pruebas de 0040: FCI y saldos (Tanda 9 de PARIDAD_COMPLETA.md, 27/11/2026).
//   1. Aviso "fondo sin movimientos del banco".
//   2. Intereses de la remunerada de Brubank (regla, clasificación de los ya cargados, detalle del día).
//   3. Segundo asiento del día cuando el primero ya subió a Xubio (complemento).
//   4. Arrastre de saldo hasta el día hábil anterior (solo lectura).
//   5. Capital del FCI al Flujo (contraparte en la cuenta madre).
//   (El punto 6, Mercado Pago por API, es de Netlify: lo prueba `npm run test:mercadopago`.)
//   + permisos, re-ejecución y que el Flujo existente no cambie.
// Datos ficticios. Las fechas salen siempre de hoy_ar(), nunca de current_date.
// Uso (desde demo/): node supabase/pruebas/probar_0040.mjs supabase/migrations
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
const comoAnon = async () => { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role anon`) }
const servidor = async () => { actual = null; await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const sqlDe = (f) => readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')

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
// Todas las migraciones menos la 0040: con ellas se arma el Flujo "de antes" para comparar.
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && !x.startsWith('0040')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(sqlDe(f)) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones anteriores a 0040 aplican', true)

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
// Los últimos 12 días hábiles anteriores a hoy, del más viejo al más nuevo.
const hab = (await filas(`select d::date::text f from generate_series(hoy_ar() - 40, hoy_ar() - 1, interval '1 day') d where es_dia_habil(d::date) order by d`)).map((x) => x.f).slice(-12)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('aprob@prueba.com', 'Aprob', 'APROBADOR', true),
    ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
  insert into cuentas_contables (empresa_id, nombre) values (null, 'Banco Prueba CC'), (null, 'Banco Prueba CA'), (null, 'Fondos Comun de Inversion Bancos');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const cc = async (nombre) => (await val(`select id from cuentas_contables where nombre = $1`, [nombre])).id
let nh = 0
const cuenta = async (nombre, clase, extra = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, cuenta_contable_id, unidad_id, requiere_extracto, cuenta_madre_id, rinde_diario)
   values ($7, $1, $8, $2, '30999999991', $3, $4, $5, $6, $9) returning id`,
  [nombre, clase, extra.contable ?? null, extra.unidad ?? uIndia, extra.requiere ?? false, extra.madre ?? null, extra.empresa ?? 'india', extra.banco ?? 'BANCOPRUEBA', extra.rinde ?? false])).id
// importar_extracto es solo del servidor: se llama como servidor y se vuelve a la sesión que había.
const importar = async (c, hash, movs, extra = {}) => {
  const antes = actual
  await servidor()
  try {
    return (await val(`select importar_extracto($1) r`, [{ cuenta_origen_id: c, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash }, movimientos: movs, ...extra }])).r
  } finally { if (antes) await como(antes) }
}
const comoServidor = async (fn) => { const antes = actual; await servidor(); try { return await fn() } finally { if (antes) await como(antes) } }
const mov = (c, fecha, importe, desc = 'MOV PRUEBA', categoria = 'SIN_CLASIFICAR', estado = 'PENDIENTE') => comoServidor(async () => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
   values ((select empresa_id from cuentas_origen where id = $1), $1, $2, $3, $4, $5, $6, $7) returning id`, [c, fecha, desc, importe, `H40-${nh++}`, categoria, estado])).id)
const saldo = (c, fecha, s, origen = 'EXTRACTO') => comoServidor(() => db.query(
  `insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por)
   values ($1, $2, (select empresa_id from cuentas_origen where id = $1), $3, $4, 'prueba')
   on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, origen = excluded.origen`, [c, fecha, s, origen]))

// Cuentas: Hipotecario (madre) con su FCI; Brubank CC con su remunerada; un banco con dos fondos; una cuenta con asientos.
const hipo = await cuenta('HIPOTECARIO CC PRUEBA', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true })
const fciTor = await cuenta('FCI TORONTO PRUEBA', 'FCI', { madre: hipo, requiere: false })
const bru = await cuenta('BRUBANK CC PRUEBA', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'BRUBANK' })
const bruRem = await cuenta('BRUBANK REMUNERADA PRUEBA', 'REMUNERADA', { madre: bru, banco: 'BRUBANK', rinde: true })
const icbc = await cuenta('ICBC CC PRUEBA', 'CC', { contable: await cc('Banco Prueba CC'), requiere: true, banco: 'ICBC' })
const fciA = await cuenta('FCI ALPHA A', 'FCI', { madre: icbc })
const fciB = await cuenta('FCI ALPHA B', 'FCI', { madre: icbc })
const ca = await cuenta('BANCO PRUEBA CA-0010', 'CA', { contable: await cc('Banco Prueba CA'), requiere: true, banco: 'GALICIA' })
const cuentaBer = await cuenta('BER CC PRUEBA', 'CC', { empresa: 'beratung', unidad: (await val(`select id from unidades where empresa_id = 'beratung' and por_defecto`)).id, banco: 'GALICIA' })

// ---------------------------------------------------------------- El Flujo de antes de 0040 (para comparar)
const prov = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30111111118', 'PROVEEDOR X SA', $1) returning id`, [org])).id
await db.query(`insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable, origen)
  values ('india', $1, 'Factura A', 'A', 7, 1001, $2, $3, 5000, 5000, 'PARA_PAGAR', 0, 'PROVEEDORES', 'MANUAL')`, [prov, dia(-20), dia(10)])
await mov(hipo, hab[0], 500000, 'DEPOSITO INICIAL', 'COBRO')
await mov(hipo, hab[2], -3000, 'IMP LEY 25413 DEB', 'IMPUESTO')
await mov(hipo, hab[3], -80000, 'SUSCRIPCION FCI TORONTO', 'FCI')           // el motor (0030) le pone su fondo
await mov(bru, hab[1], 120000, 'DEPOSITO INICIAL', 'COBRO')
await mov(bru, hab[4], -2000, 'Transferencia a cuenta remunerada')          // sin categoría: lo completa 0040
await mov(ca, hab[5], 1500, 'COBRO CLIENTE', 'COBRO')
await saldo(fciTor, hab[2], 1000000, 'TENENCIA'); await saldo(fciTor, hab[3], 1080500, 'TENENCIA'); await saldo(fciTor, hab[6], 1081000, 'TENENCIA')
await saldo(bruRem, hab[3], 5000, 'EXTRACTO'); await saldo(bruRem, hab[4], 7010, 'EXTRACTO')
await saldo(ca, hab[5], 1500, 'EXTRACTO')
const lineasFlujo = async () => val(
  `select count(*)::int n, md5(coalesce(string_agg(t::text, E'\n' order by t::text), '')) h,
          count(*) filter (where naturaleza = 'PROYECTADO')::int p, count(*) filter (where naturaleza = 'REAL')::int r
   from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 200, null, false) t`)
const antes = await lineasFlujo()
check('hay un Flujo de antes con líneas reales y proyectadas', antes.p > 0 && antes.r > 0, JSON.stringify(antes))
const defAntes = (await val(`select md5(pg_get_functiondef('flujo_lineas_entre(date,date,uuid,boolean)'::regprocedure)) h`)).h

// ---------------------------------------------------------------- Se aplica 0040 (y de nuevo: re-ejecutable)
const f40 = readdirSync(dir).find((x) => x.startsWith('0040'))
check('existe 0040_fci_y_saldos.sql', f40 === '0040_fci_y_saldos.sql', f40)
try { await db.exec(sqlDe(f40)); check('0040 aplica', true) } catch (e) { check('0040 aplica', false, e.message); process.exit(1) }
try { await db.exec(sqlDe(f40)); check('0040 se puede ejecutar dos veces', true) } catch (e) { check('0040 se puede ejecutar dos veces', false, e.message) }
check('re-ejecutada no duplica las reglas (una 55 y una 85 por organización)',
  (await val(`select count(*)::int n from reglas_extracto where orden in (55, 85) and organizacion_id = $1`, [org])).n === 2)
check('0040 no cambia flujo_lineas_entre (misma definición)', (await val(`select md5(pg_get_functiondef('flujo_lineas_entre(date,date,uuid,boolean)'::regprocedure)) h`)).h === defAntes)
const despues = await lineasFlujo()
check('el Flujo existente no cambia con 0040 (mismas líneas, mismo contenido)', despues.h === antes.h && despues.n === antes.n && despues.p === antes.p && despues.r === antes.r,
  JSON.stringify({ antes, despues }))

// ================================================================ 5. Capital del FCI al Flujo
const rend = async (cuentaId, fecha) => (await val(`select rendimiento::float r from conciliacion_calculo(true) where cuenta_origen_id = $1 and fecha = $2`, [cuentaId, fecha]))?.r
const lineaRend = async (cuentaId, fecha) => (await val(
  `select importe::float i from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 200, null, true) where origen_tipo = 'RENDIMIENTO' and origen_id = $1 and fecha = $2`, [cuentaId, fecha]))?.i
check('[5] antes de sincronizar: la transferencia a la remunerada cuenta como rendimiento (2.010 en vez de 10)', await rend(bruRem, hab[4]) === 2010, String(await rend(bruRem, hab[4])))
check('[5] … y el Flujo lo muestra así (rendimiento de 2.010)', (await lineaRend(bruRem, hab[4])) === 2010, String(await lineaRend(bruRem, hab[4])))
// ICBC: dos fondos, un movimiento FCI dudoso, uno que se completa solo.
const mIcbcDudoso = await mov(icbc, hab[7], -500, 'SUSCRIPCION FCI', 'FCI')
const mRemEspejo = await mov(bruRem, hab[8], 300, 'Transferencia desde cuenta corriente')
const mBruConEspejo = await mov(bru, hab[8], -300, 'Transferencia a cuenta remunerada')
const mSinFondo = await mov(hipo, hab[9], 45, 'ACREDITACION CLIENTE', 'COBRO')   // no es capital: no se toca
const mFciReg = await mov(hipo, hab[10], -700, 'SUSC.FCI TORONTO', 'SIN_CLASIFICAR')   // por el texto solo NO es capital (el Apps Script pedía CATEGORIA = FCI)
const mFciCat = await mov(hipo, hab[10], -900, 'DEBITO FONDO', 'FCI')
await como('aprob@prueba.com')
await falla('[5] APROBADOR no sincroniza el capital del FCI', `select sincronizar_capital_fci('india')`, [], /no puede/)
await como('solober@prueba.com')
await falla('[5] quien no ve India no la sincroniza', `select sincronizar_capital_fci('india')`, [], /No tenés acceso/)
await como('teso@prueba.com')
const r1 = (await val(`select sincronizar_capital_fci('india') r`)).r
check('[5] asigna la transferencia a la remunerada (el de categoría FCI ya lo había resuelto 0030); el dudoso queda aparte', r1.asignados === 1 && r1.dudosos === 1, JSON.stringify(r1) + JSON.stringify(await filas(`select descripcion, contraparte_cuenta_id is not null c from movimientos_bancarios where fecha >= $1 order by fecha`, [hab[3]])))
const cp = async (m) => (await val(`select contraparte_cuenta_id c from movimientos_bancarios where id = $1`, [m])).c
const idTransfer = (await val(`select id from movimientos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [bru, hab[4]])).id
check('[5] la transferencia a la remunerada quedó con su fondo', (await cp(idTransfer)) === bruRem)
check('[5] el de categoría FCI también', (await cp(mFciCat)) === fciTor)
check('[5] un "SUSC" sin categoría FCI NO se toma como capital', (await cp(mFciReg)) === null)
check('[5] el movimiento con dos fondos no se adivina (queda sin contraparte)', (await cp(mIcbcDudoso)) === null)
check('[5] el que ya tiene su pata en el fondo no se toca', (await cp(mBruConEspejo)) === null)
check('[5] un cobro cualquiera de la cuenta madre no se toca', (await cp(mSinFondo)) === null)
check('[5] después: el rendimiento de la remunerada es el real (10)', await rend(bruRem, hab[4]) === 10, String(await rend(bruRem, hab[4])))
check('[5] … y el Flujo muestra ese rendimiento (10) en vez del inflado', (await lineaRend(bruRem, hab[4])) === 10, String(await lineaRend(bruRem, hab[4])))
check('[5] el Flujo cuenta la otra pata del capital (suma cero con la cuenta madre)',
  (await val(`select round(sum(importe))::int s from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 200, null, true) where origen_id = $1`, [idTransfer])).s === 0)
const r2 = (await val(`select sincronizar_capital_fci('india') r`)).r
check('[5] volver a correrlo no cambia nada (asigna 0)', r2.asignados === 0, JSON.stringify(r2))
check('[5] con p_desde reciente no mira lo viejo', (await val(`select (sincronizar_capital_fci('india', hoy_ar() + 1)->>'asignados')::int n`)).n === 0)
const aud = (await val(`select count(*)::int n from auditoria where accion = 'FCI_CAPITAL'`)).n
check('[5] deja auditoría cuando una persona asigna', aud === 1, String(aud))

// ================================================================ 2. Intereses de la remunerada
const reglas = await filas(`select orden, categoria, destino_xubio, sentido, cuenta_contable from reglas_extracto where orden in (55, 85) and organizacion_id = $1 order by orden`, [org])
check('[2] la regla de INTERESES PAGADOS: rendimiento al asiento, solo créditos', reglas[0]?.categoria === 'FCI_RENDIMIENTO' && reglas[0]?.destino_xubio === 'ASIENTO' && reglas[0]?.sentido === 'CREDITO' && reglas[0]?.cuenta_contable === 'Rendimientos FCI', JSON.stringify(reglas))
const D2 = hab[11]
await importar(bruRem, 'rem1', [
  { fecha: D2, descripcion: 'Intereses Pagados', importe: 12.34, saldo: 7022.34, referencia: 'I1' },
  { fecha: D2, descripcion: 'Intereses pagados (ajuste)', importe: -1, saldo: 7021.34, referencia: 'I2' },
  { fecha: D2, descripcion: 'MP reserva para pago 123', importe: -50, saldo: 6971.34, referencia: 'R1' },
])
const cat = async (desc) => val(`select categoria, destino_xubio, cuenta_contable, estado from movimientos_bancarios where descripcion = $1 limit 1`, [desc])
const ci = await cat('Intereses Pagados')
check('[2] al importar, los intereses pagados quedan como rendimiento, al asiento, pendientes', ci.categoria === 'FCI_RENDIMIENTO' && ci.destino_xubio === 'ASIENTO' && ci.cuenta_contable === 'Rendimientos FCI' && ci.estado === 'PENDIENTE', JSON.stringify(ci))
check('[2] un débito con ese texto no es rendimiento', (await cat('Intereses pagados (ajuste)')).categoria !== 'FCI_RENDIMIENTO')
check('[2] la reserva de Mercado Pago es informativa (no queda "a revisar")', (await cat('MP reserva para pago 123')).categoria === 'INFORMATIVO')
// Uno que entró antes de la regla: "A revisar".
const mViejo = await mov(bruRem, hab[10], 8.5, 'Intereses Pagados 10', 'SIN_CLASIFICAR', 'A_REVISAR')
const mCc = await mov(bru, hab[10], 9, 'Intereses Pagados CC', 'SIN_CLASIFICAR', 'A_REVISAR')
await como('aprob@prueba.com')
await falla('[2] APROBADOR no clasifica intereses', `select clasificar_intereses_remunerada('india')`, [], /no puede/)
await como('solober@prueba.com')
await falla('[2] quien no ve India no los clasifica', `select clasificar_intereses_remunerada('india')`, [], /No tenés acceso/)
await como('teso@prueba.com')
check('[2] clasifica los ya cargados (solo remuneradas): 1', (await val(`select clasificar_intereses_remunerada('india') n`)).n === 1)
check('[2] … el de la remunerada quedó como rendimiento y el de la cuenta corriente no se tocó',
  (await val(`select categoria c, estado e from movimientos_bancarios where id = $1`, [mViejo])).c === 'FCI_RENDIMIENTO'
  && (await val(`select categoria c from movimientos_bancarios where id = $1`, [mCc])).c === 'SIN_CLASIFICAR')
check('[2] volver a correrla no hace nada', (await val(`select clasificar_intereses_remunerada('india') n`)).n === 0)
// La regla 55 es solo de la remunerada de Brubank.
await servidor()
await importar(ca, 'ca-int', [{ fecha: hab[9], descripcion: 'Intereses Pagados', importe: 3, referencia: 'CA1' }])
check('[2] los intereses pagados de una caja de ahorro común NO son rendimiento de un fondo', (await val(`select categoria c from movimientos_bancarios where cuenta_origen_id = $1 and referencia = 'CA1'`, [ca])).c !== 'FCI_RENDIMIENTO')
await importar(icbc, 'icbc-int', [{ fecha: hab[9], descripcion: 'Intereses Pagados', importe: 3, referencia: 'IC1' }])
check('[2] ni los de otro banco', (await val(`select categoria c from movimientos_bancarios where cuenta_origen_id = $1 and referencia = 'IC1'`, [icbc])).c !== 'FCI_RENDIMIENTO')
await como('teso@prueba.com')
// El asiento del día de la remunerada lleva los intereses: banco / Rendimientos FCI (necesita su cuenta contable).
await servidor()
await db.query(`update cuentas_origen set cuenta_contable_id = $2 where id = $1`, [bruRem, await cc('Banco Prueba CA')])
await como('teso@prueba.com')
const asRem = (await val(`select generar_asiento_bancario($1, $2) id`, [bruRem, D2])).id
const lr = await filas(`select cuenta_contable, debe::float d, haber::float h from asiento_lineas where asiento_id = $1 order by cuenta_contable`, [asRem])
check('[2] el asiento de la remunerada: Debe banco 12,34 / Haber Rendimientos FCI 12,34 (la reserva informativa no entra)',
  lr.length === 2 && lr.some((l) => l.cuenta_contable === 'Rendimientos FCI' && l.h === 12.34) && lr.some((l) => l.cuenta_contable === 'Banco Prueba CA' && l.d === 12.34), JSON.stringify(lr))
// Detalle del día.
await saldo(bruRem, D2, 7021.34, 'EXTRACTO')
const dr = await filas(`select importe::float i, detalle, aviso from rendimientos_fci_dia($1, $2)`, [D2, bruRem])
check('[2] rendimientos_fci_dia: informa los intereses pagados por el banco', dr.length === 1 && dr[0].i === 12.34 && /ntereses pagados informados por el banco 12\.34/.test(dr[0].detalle), JSON.stringify(dr))

// ================================================================ 1. Aviso: fondo sin movimientos del banco
await servidor()
const dF = hab[6]   // tenencia del Toronto ese día; la cuenta madre (Hipotecario) no tiene nada ese día
const av = async (cuentaId, fecha) => (await val(`select count(*)::int n from avisos_fci where cuenta_origen_id = $1 and fecha = $2`, [cuentaId, fecha])).n
check('[1] tenencia de un fondo sin movimientos ni extracto de su banco ese día: avisa', (await av(fciTor, dF)) === 1)
check('[1] el aviso dice qué hacer', /subí antes el extracto del banco/.test((await val(`select detalle d from avisos_fci where cuenta_origen_id = $1 and fecha = $2`, [fciTor, dF])).d))
check('[1] un día con movimientos del banco no avisa (hab[3] tiene la suscripción)', (await av(fciTor, hab[3])) === 0)
await saldo(fciTor, hab[8], 1081000, 'TENENCIA')
check('[1] tenencia de otro día sin nada del banco: avisa', (await av(fciTor, hab[8])) === 1)
await saldo(hipo, hab[8], 410000, 'SIN_MOVIMIENTOS')
check('[1] marcando el día "sin movimientos" en el banco, el aviso se va', (await av(fciTor, hab[8])) === 0)
await saldo(hipo, dF, 410000, 'EXTRACTO')
check('[1] con el extracto del banco de ese día, tampoco avisa', (await av(fciTor, dF)) === 0)
await saldo(fciTor, hab[9], 1081000, 'MANUAL')
check('[1] un saldo cargado a mano no es una tenencia: no avisa', (await av(fciTor, hab[9])) === 0)
await db.query(`delete from saldos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [hipo, dF])
await como('teso@prueba.com')
check('[1] rendimientos_fci_dia marca el aviso del día', (await val(`select aviso a from rendimientos_fci_dia($1, $2)`, [dF, fciTor])).a === true)
check('[1] … y el detalle trae saldo, anterior, rescates y suscripciones', /^Saldo 1081000\.00 - anterior 1080500\.00 \+ rescates 0\.00 - suscripciones 0\.00/.test((await val(`select detalle d from rendimientos_fci_dia($1, $2)`, [dF, fciTor])).d))
await como('solober@prueba.com')
check('[1] quien no ve India no ve sus avisos', (await val(`select count(*)::int n from avisos_fci`)).n === 0)

// ================================================================ 3. Segundo asiento del día
await servidor()
const D3 = hab[7]
const lin = async (id) => filas(`select cuenta_contable, debe::float d, haber::float h from asiento_lineas where asiento_id = $1`, [id])
const balancea = async (id) => Math.abs((await lin(id)).reduce((a, l) => a + l.d - l.h, 0)) < 0.005
await importar(ca, 'c1', [{ fecha: D3, descripcion: 'SIRCREB RETENCION', importe: -40 }, { fecha: D3, descripcion: 'SELLOS CTA', importe: -10 }])
await como('aprob@prueba.com')
await falla('[3] APROBADOR no genera el asiento', `select generar_asiento_del_dia($1, $2)`, [ca, D3], /no puede/)
await como('solober@prueba.com')
await falla('[3] quien no ve India no genera el asiento', `select generar_asiento_del_dia($1, $2)`, [ca, D3], /No tenés acceso/)
await como('teso@prueba.com')
await falla('[3] el complemento no se hace si el asiento del día todavía no está en Xubio', `select generar_asiento_complemento($1, $2)`, [ca, D3], /todavía no está en Xubio/)
const a1 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D3])).id
check('[3] sin asiento previo, el botón hace el asiento del día de siempre', (await val(`select tipo t from asientos where id = $1`, [a1])).t === 'BANCARIO_DIARIO' && (await balancea(a1)))
await falla('[3] llamarlo de nuevo sin nada nuevo no hace un complemento', `select generar_asiento_complemento($1, $2)`, [ca, D3], /todavía no está en Xubio/)
await servidor()
await db.query(`select resultado_asiento_xubio($1, true, '5001', null)`, [a1])
await como('teso@prueba.com')
check('[3] el asiento del día quedó subido y sus movimientos contabilizados', (await val(`select estado_xubio::text e from asientos where id = $1`, [a1])).e === 'SUBIDA'
  && (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1 and estado = 'CONTABILIZADO'`, [a1])).n === 2)
check('[3] sin movimientos nuevos, el complemento no genera nada', (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D3])).id === null)
// Llega un impuesto tarde y la suscripción de un FCI.
await importar(ca, 'c2', [{ fecha: D3, descripcion: 'IMP LEY 25413 DEBITO', importe: -7 }])
await falla('[3] el asiento del día no se rehace estando subido (como antes)', `select generar_asiento_bancario($1, $2)`, [ca, D3], /ya está en Xubio/)
const a2 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D3])).id
const asi2 = await val(`select tipo, estado_xubio::text e, descripcion, empresa_id from asientos where id = $1`, [a2])
check('[3] con el del día ya subido, hace un asiento COMPLEMENTARIO pendiente de subir', asi2.tipo === 'BANCARIO_COMPLEMENTO' && asi2.e === 'PENDIENTE' && /Complemento/.test(asi2.descripcion), JSON.stringify(asi2))
check('[3] … balancea y solo lleva lo nuevo (7 contra el banco)', (await balancea(a2)) && (await lin(a2)).some((l) => l.h === 7 && l.cuenta_contable === 'Banco Prueba CA'), JSON.stringify(await lin(a2)))
check('[3] … el asiento del día subido no se tocó', (await val(`select estado_xubio::text e from asientos where id = $1`, [a1])).e === 'SUBIDA' && (await lin(a1)).length === 3)
check('[3] … el movimiento nuevo quedó en el complemento y los viejos siguen en el primero',
  (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [a2])).n === 1 && (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [a1])).n === 2)
// Otro impuesto antes de que suba: el complemento pendiente se rehace con los dos.
await importar(ca, 'c3', [{ fecha: D3, descripcion: 'SELLOS EXTRA', importe: -3 }])
const a3 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D3])).id
check('[3] un complemento que no subió se rehace con lo nuevo (hay uno solo pendiente, 10 en total)',
  (await val(`select count(*)::int n from asientos where cuenta_origen_id = $1 and fecha = $2 and tipo = 'BANCARIO_COMPLEMENTO' and anulado_en is null`, [ca, D3])).n === 1
  && (await lin(a3)).some((l) => l.h === 10) && (await balancea(a3)))
// Si se está enviando, no se toca.
await servidor()
await db.query(`update asientos set envio_xubio_en = now() where id = $1`, [a3])
await importar(ca, 'c4', [{ fecha: D3, descripcion: 'SELLOS OTRO', importe: -1 }])
await como('teso@prueba.com')
await falla('[3] uno que se está enviando a Xubio no se toca', `select generar_asiento_del_dia($1, $2)`, [ca, D3], /se está enviando/)
await servidor()
await db.query(`update asientos set envio_xubio_en = null where id = $1`, [a3])
await db.query(`select resultado_asiento_xubio($1, true, '5002', null)`, [a3])
await como('teso@prueba.com')
check('[3] subido el complemento, sus movimientos quedan contabilizados', (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1 and estado = 'CONTABILIZADO'`, [a3])).n === 2)
const a4 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D3])).id
check('[3] otro movimiento tardío: un tercer asiento (complemento nuevo, el anterior queda subido)',
  a4 !== a3 && (await val(`select tipo t from asientos where id = $1`, [a4])).t === 'BANCARIO_COMPLEMENTO' && (await val(`select estado_xubio::text e from asientos where id = $1`, [a3])).e === 'SUBIDA' && (await lin(a4)).some((l) => l.h === 1))
// Sale por el mismo camino de siempre: la vista de pendientes de Xubio lo ve, en seco (nada de esto escribe en Xubio).
check('[3] el complemento pendiente aparece en "pendientes de Xubio" (mismo camino que los demás asientos)',
  (await val(`select count(*)::int n from xubio_bancos_pendientes where tipo = 'ASIENTO' and id = $1`, [a4])).n === 1)
await servidor()
await db.query(`update usuarios set rol = 'ADMIN' where email = 'teso@prueba.com'`)
await como('teso@prueba.com')
await db.query(`select anular_asiento($1, 'prueba')`, [a4])
check('[3] anular el complemento suelta sus movimientos como cualquier asiento', (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [a4])).n === 0)
await servidor()
await db.query(`update usuarios set rol = 'TESORERIA' where email = 'teso@prueba.com'`)

// ================================================================ 4. Arrastre de saldo
await servidor()
const cA = await cuenta('ARRASTRE A', 'CC', { requiere: true })
const cB = await cuenta('ARRASTRE B (sin extracto)', 'CC', { requiere: false })
const cC = await cuenta('ARRASTRE C', 'CC', { requiere: true })
await saldo(cA, hab[0], 100); await saldo(cA, hab[4], 130)
await mov(cA, hab[2], 5, 'MOV SIN SALDO')
await db.query(`insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_hash, hasta, importado_por, importado_en) values ('india', $1, 'a.csv', 'arr-a', $2, 't', ($2::date + 1)::timestamp + interval '15 hours')`, [cA, hab[6]])
await saldo(cB, hab[8], 77)
await saldo(cC, hab[9], 50); await saldo(cC, hab[11], 60)
await db.query(`insert into extractos (empresa_id, cuenta_origen_id, archivo_nombre, archivo_hash, hasta, importado_por) values ('india', $1, 'c.csv', 'arr-c', $2, 't')`, [cC, hab[11]])   // subido hoy
await como('teso@prueba.com')
const antesS = (await val(`select count(*)::int n from saldos_bancarios`)).n
const arr = async (nombre) => filas(`select fecha::text f, saldo::float s, arrastrado a, saldo_de::text de from saldos_arrastrados($1, null, 'india') where cuenta = $2 order by fecha`, [hab[0], nombre])
const a = await arr('ARRASTRE A')
const esperadoA = [[hab[0], 100, false], [hab[1], 100, true], [hab[3], 100, true], [hab[4], 130, false], [hab[5], 130, true], [hab[6], 130, true]]
check('[4] entre dos saldos repite el anterior; un día con movimientos no se arrastra; después del último, hasta donde llega el extracto',
  JSON.stringify(a.map((x) => [x.f, x.s, x.a])) === JSON.stringify(esperadoA), JSON.stringify(a))
check('[4] dice de qué día viene el saldo repetido', a.find((x) => x.f === hab[5])?.de === hab[4] && a.find((x) => x.f === hab[0])?.de === null)
check('[4] sin extracto subido, después del último saldo no inventa nada', (await arr('ARRASTRE B (sin extracto)')).map((x) => x.f).join() === hab[8])
const c3 = await arr('ARRASTRE C')
check('[4] llega hasta el día hábil anterior a hoy: el último cerrado es el último que se arrastra', c3.map((x) => x.f).join() === [hab[9], hab[10], hab[11]].join() && c3[1].a && c3[1].s === 50 && !c3[2].a, JSON.stringify(c3))
check('[4] nunca incluye hoy ni días futuros', (await val(`select count(*)::int n from saldos_arrastrados(hoy_ar() - 5, hoy_ar() + 30, 'india') where fecha >= hoy_ar()`)).n === 0)
check('[4] solo días hábiles (sin fines de semana)', (await val(`select count(*)::int n from saldos_arrastrados(hoy_ar() - 40, null, 'india') where extract(isodow from fecha) >= 6`)).n === 0)
await servidor()
await db.query(`insert into feriados (fecha, nombre) values ($1, 'Feriado de prueba')`, [hab[1]])
const ferA = await filas(`select fecha::text f from saldos_arrastrados($1, null, 'india') where cuenta = 'ARRASTRE A' and arrastrado order by fecha`, [hab[0]])
check('[4] un feriado no es día hábil: no se arrastra', !ferA.some((x) => x.f === hab[1]) && ferA.some((x) => x.f === hab[3]), JSON.stringify(ferA))
await db.query(`delete from feriados where nombre = 'Feriado de prueba'`)
check('[4] es solo lectura: no escribió ningún saldo', (await val(`select count(*)::int n from saldos_bancarios`)).n === antesS)
await como('solober@prueba.com')
check('[4] quien no ve India no ve sus saldos', (await val(`select count(*)::int n from saldos_arrastrados(hoy_ar() - 40, null, 'india')`)).n === 0)

// ================================================================ Revisión (27/11): casos que fallaban
await servidor()
// (a) La pata propia llega después: la contraparte se suelta y no se cuenta dos veces.
const mCcT = await mov(bru, hab[11], -4000, 'Transferencia a cuenta remunerada')
await comoServidor(() => db.query(`select sincronizar_capital_fci('india')`))
check('[rev] la transferencia a la remunerada recibió su fondo', (await cp(mCcT)) === bruRem)
await mov(bruRem, hab[11], 4000, 'Transferencia desde cuenta corriente')
const rs = (await comoServidor(() => val(`select sincronizar_capital_fci('india') r`))).r
check('[rev] llegó la pata propia: la contraparte se suelta sola (disparador) y no se cuenta doble', (await cp(mCcT)) === null, JSON.stringify(rs))
check('[rev] volver a correrlo no la reasigna', (await comoServidor(() => val(`select (sincronizar_capital_fci('india')->>'asignados')::int n`))).n === 0 && (await cp(mCcT)) === null)
// (b) Anular el asiento del día con un complemento ya subido y rehacerlo: no repite lo del complemento.
await servidor()
const D6 = hab[5]
await importar(ca, 'r1', [{ fecha: D6, descripcion: 'SIRCREB RETENCION', importe: -400 }])
await como('teso@prueba.com')
const b1 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D6])).id
await servidor(); await db.query(`select resultado_asiento_xubio($1, true, '6001', null)`, [b1])
await importar(ca, 'r2', [{ fecha: D6, descripcion: 'SELLOS TARDE', importe: -70 }])
await como('teso@prueba.com')
const b2 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D6])).id
await servidor(); await db.query(`select resultado_asiento_xubio($1, true, '6002', null)`, [b2])
await db.query(`update usuarios set rol = 'ADMIN' where email = 'teso@prueba.com'`)
await como('teso@prueba.com')
await db.query(`select anular_asiento($1, 'rehacer')`, [b1])
const b3 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D6])).id
const sumaVigente = (await val(`select coalesce(sum(l.haber), 0)::float h from asiento_lineas l join asientos a on a.id = l.asiento_id
  where a.cuenta_origen_id = $1 and a.fecha = $2 and a.anulado_en is null and l.detalle = 'Banco'`, [ca, D6])).h
check('[rev] anulado el del día, el nuevo solo lleva lo suyo (400), no los 70 del complemento ya subido', b3 !== null && (await lin(b3)).some((l) => l.h === 400) && !(await lin(b3)).some((l) => l.h === 470), JSON.stringify(await lin(b3)))
check('[rev] nunca doble asiento: lo vigente del banco ese día es 470 (400 + 70)', sumaVigente === 470, String(sumaVigente))
check('[rev] el complemento subido conserva sus movimientos', (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1`, [b2])).n === 1)
await servidor()
await db.query(`update usuarios set rol = 'TESORERIA' where email = 'teso@prueba.com'`)
// (c) Un solo complemento pendiente por banco y día (índice único).
const D7 = hab[4]
await importar(ca, 'q1', [{ fecha: D7, descripcion: 'SELLOS Q1', importe: -5 }])
await como('teso@prueba.com')
const q1 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D7])).id
await servidor(); await db.query(`select resultado_asiento_xubio($1, true, '7001', null)`, [q1])
await importar(ca, 'q2', [{ fecha: D7, descripcion: 'SELLOS Q2', importe: -6 }])
await como('teso@prueba.com')
const q2 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D7])).id
await servidor()
const dup = await error(`insert into asientos (empresa_id, cuenta_origen_id, fecha, tipo, descripcion, creado_por) values ('india', $1, $2, 'BANCARIO_COMPLEMENTO', 'otro', 'x')`, [ca, D7])
check('[rev] la base no deja dos complementos pendientes del mismo banco y día', /asientos_un_complemento_pendiente|duplicate key|unique/i.test(dup ?? ''), dup ?? 'no falló')
await como('teso@prueba.com')
const q3 = (await val(`select generar_asiento_del_dia($1, $2) id`, [ca, D7])).id
check('[rev] "rehacer complemento" sin movimientos nuevos rearma el pendiente con lo mismo', q3 !== null && (await lin(q3)).some((l) => l.h === 6) && (await val(`select count(*)::int n from asientos where cuenta_origen_id = $1 and fecha = $2 and tipo = 'BANCARIO_COMPLEMENTO' and anulado_en is null and estado_xubio <> 'SUBIDA'`, [ca, D7])).n === 1)
// (d) El aviso de fondo es solo de FCI (no de remuneradas).
await servidor()
await saldo(bruRem, hab[9], 7000, 'TENENCIA')
check('[rev] la remunerada no genera aviso de "fondo sin movimientos"', (await av(bruRem, hab[9])) === 0)

// ================================================================ Permisos: nada queda abierto
await servidor()
const fns = ['generar_asiento_complemento(uuid, date)', 'generar_asiento_del_dia(uuid, date)', 'clasificar_intereses_remunerada(text)', 'rendimientos_fci_dia(date, uuid)',
  'sincronizar_capital_fci(text, date)', 'saldos_arrastrados(date, date, text)']
const priv = async (rol, f) => (await val(`select has_function_privilege($1, $2, 'execute') ok`, [rol, f])).ok
const anon = [], auth = [], serv = []
for (const f of fns) { if (await priv('anon', f)) anon.push(f); if (!(await priv('authenticated', f))) auth.push(f); if (!(await priv('service_role', f))) serv.push(f) }
check('[permisos] anon no ejecuta ninguna de las funciones nuevas', anon.length === 0, anon.join(', '))
check('[permisos] authenticated y service_role sí', auth.length === 0 && serv.length === 0, `${auth.join(', ')} / ${serv.join(', ')}`)
check('[permisos] la vista avisos_fci: anon no la lee, authenticated sí, nadie escribe', !(await val(`select has_table_privilege('anon', 'avisos_fci', 'select') a`)).a
  && (await val(`select has_table_privilege('authenticated', 'avisos_fci', 'select') a`)).a && !(await val(`select has_table_privilege('authenticated', 'avisos_fci', 'insert') a`)).a)
await comoAnon()
await falla('[permisos] anon no sincroniza el capital', `select sincronizar_capital_fci('india')`, [], /permission denied/)
await falla('[permisos] anon no lee los saldos arrastrados', `select * from saldos_arrastrados(hoy_ar() - 5)`, [], /permission denied/)
await servidor()
check('[permisos] el servidor sí sincroniza (sin sesión de persona)', (await val(`select (sincronizar_capital_fci('india')->>'asignados')::int n`)).n === 0)
check('[permisos] los usan SECURITY DEFINER con search_path fijo (las que escriben)', (await val(
  `select count(*)::int n from pg_proc p where p.proname in ('generar_asiento_complemento', 'generar_asiento_del_dia', 'clasificar_intereses_remunerada', 'sincronizar_capital_fci')
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')`)).n === 4)
check('[permisos] ninguna usa current_date', (await val(
  `select count(*)::int n from pg_proc p where p.proname in ('generar_asiento_complemento', 'generar_asiento_del_dia', 'clasificar_intereses_remunerada', 'sincronizar_capital_fci',
     'rendimientos_fci_dia', 'saldos_arrastrados') and p.prosrc ~* 'current_date'`)).n === 0)

console.log(`\n${ok} OK · ${mal} MAL`)
await db.close()
process.exit(mal ? 1 : 0)
