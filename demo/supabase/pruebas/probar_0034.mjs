// Pruebas de 0034: ajustes por lo que hace el Apps Script del 26/11/2026. SIRCREB y comisiones sin IVA al asiento,
// pagos del Flujo solo si están en Xubio (y el débito sigue contando), "sin movimientos" solo de días cerrados,
// doble conteo de facturas ya pagadas según el extracto y feriados. Datos ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_0034.mjs supabase/migrations
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
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones aplican (con 0034)', true)

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values ('teso@prueba.com', 'Teso', 'TESORERIA', true);
  insert into cuentas_contables (empresa_id, nombre) values (null, 'Banco Prueba CA'), (null, 'Banco Prueba CC');
`)
const org = (await val(`select organizacion_id o from empresas where id = 'india'`)).o
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const cuentaContable = async (nombre) => (await val(`select id from cuentas_contables where nombre = $1`, [nombre])).id
const cuenta = async (nombre, clase, extra = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, cuenta_contable_id, unidad_id, requiere_extracto, digito_comprobante)
   values ('india', $1, 'BANCOPRUEBA', $2, '30999999991', $3, $4, $5, $6) returning id`,
  [nombre, clase, extra.contable ?? null, uIndia, extra.requiere ?? false, extra.digito ?? null])).id
const ca = await cuenta('BANCO PRUEBA CA-0010', 'CA', { contable: await cuentaContable('Banco Prueba CA') })
const importar = async (c, hash, movs) => (await val(`select importar_extracto($1) r`,
  [{ cuenta_origen_id: c, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash }, movimientos: movs }])).r
const cat = async (desc) => val(`select categoria, destino_xubio, componente, cuenta_contable from movimientos_bancarios where descripcion = $1 limit 1`, [desc])

// ================================================================ 1. SIRCREB y compañía al asiento
const reglas = await filas(`select orden, destino_xubio, componente from reglas_extracto where orden in (8, 9, 12, 15, 20) order by orden`)
const reg = (o) => reglas.find((r) => r.orden === o)
check('regla 15 (IIBB Tucumán) y 20 (SIRCREB/IIBB): al asiento, sin componente', reg(15)?.destino_xubio === 'ASIENTO' && reg(15)?.componente === null && reg(20)?.destino_xubio === 'ASIENTO' && reg(20)?.componente === null, JSON.stringify(reglas))
check('reglas nuevas: SELLOS y COBRO COM VALORES al asiento; percepción de IIBB al comprobante',
  reg(8)?.destino_xubio === 'ASIENTO' && reg(9)?.destino_xubio === 'ASIENTO' && reg(12)?.destino_xubio === 'COMPROBANTE' && reg(12)?.componente === 'PERCEPCION_IIBB')
const D1 = dia(-10)
await importar(ca, 'x1', [
  { fecha: D1, descripcion: 'SIRCREB RETENCION', importe: -4, saldo: 996 },
  { fecha: D1, descripcion: 'IIBB TUCUMAN RECAUDACION', importe: -3, saldo: 993 },
  { fecha: D1, descripcion: 'SELLOS CTA', importe: -5, saldo: 988 },
  { fecha: D1, descripcion: 'COBRO COM VALORES', importe: -7, saldo: 981 },
  { fecha: D1, descripcion: 'PERCEPCION IIBB CABA', importe: -2, saldo: 979 },
])
check('SIRCREB → asiento (cuenta de la retención)', (await cat('SIRCREB RETENCION')).destino_xubio === 'ASIENTO' && (await cat('SIRCREB RETENCION')).componente === null)
check('IIBB Tucumán → asiento', (await cat('IIBB TUCUMAN RECAUDACION')).destino_xubio === 'ASIENTO')
check('SELLOS → asiento, gastos bancarios', (await cat('SELLOS CTA')).destino_xubio === 'ASIENTO' && (await cat('SELLOS CTA')).cuenta_contable === 'GASTOS BANCARIOS')
check('COBRO COM VALORES → asiento (comisión sin IVA)', (await cat('COBRO COM VALORES')).destino_xubio === 'ASIENTO')
check('una percepción de IIBB (dice PERCEPCION) sigue en el comprobante', (await cat('PERCEPCION IIBB CABA')).componente === 'PERCEPCION_IIBB' && (await cat('PERCEPCION IIBB CABA')).destino_xubio === 'COMPROBANTE')

// Lo que ya estaba cargado (SIRCREB en un comprobante sin subir) pasa al asiento al aplicar 0034: se simula con una base "de antes".
{
  const db2 = new PGlite()
  const sql = (n) => readFileSync(join(dir, n), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
  await db2.exec(`
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
    alter default privileges in schema public grant execute on functions to service_role;`)
  const archivos = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
  for (const f of archivos.filter((x) => !x.startsWith('0034'))) {
    if (f.startsWith('0021')) await db2.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant all on sequences to anon, authenticated;
      alter default privileges in schema public grant execute on functions to anon, authenticated;`)
    await db2.exec(sql(f))
  }
  const c = (await db2.query(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco) values ('india', 'VIEJA CA', 'BANCOVIEJO', 'CA', '30888888881') returning id`)).rows[0].id
  await db2.query(`select importar_extracto($1)`, [{ cuenta_origen_id: c, usuario: 't', archivo: { nombre: 'v', hash: 'v' }, movimientos: [
    { fecha: '2026-11-10', descripcion: 'COMISION MANTENIMIENTO', importe: -100, saldo: 900 }, { fecha: '2026-11-10', descripcion: 'I.V.A. BASE', importe: -21, saldo: 879 },
    { fecha: '2026-11-10', descripcion: 'SIRCREB RETENCION', importe: -4, saldo: 875 },
    { fecha: '2026-11-11', descripcion: 'SIRCREB RETENCION', importe: -6, saldo: 869 }] }])
  const fid = (await db2.query(`select generar_comprobante_gastos($1, '2026-11-10') id`, [c])).rows[0].id
  const antes = (await db2.query(`select total::text t from facturas where id = $1`, [fid])).rows[0].t
  const fid11 = (await db2.query(`select generar_comprobante_gastos($1, '2026-11-11') id`, [c])).rows[0].id
  await db2.query(`update facturas set estado_xubio = 'SUBIDA', xubio_id = '77' where id = $1`, [fid11])
  await db2.exec(sql(archivos.find((x) => x.startsWith('0034'))))
  const t = (await db2.query(`select total::text t from facturas where id = $1`, [fid])).rows[0].t
  const m10 = (await db2.query(`select destino_xubio, factura_id from movimientos_bancarios where descripcion = 'SIRCREB RETENCION' and fecha = '2026-11-10'`)).rows[0]
  const m11 = (await db2.query(`select destino_xubio, factura_id from movimientos_bancarios where descripcion = 'SIRCREB RETENCION' and fecha = '2026-11-11'`)).rows[0]
  check('fila existente: el SIRCREB de un comprobante sin subir pasa al asiento y el comprobante se rehace (125 → 121)', antes === '125.00' && t === '121.00' && m10.destino_xubio === 'ASIENTO' && m10.factura_id === null, `${antes} ${t} ${JSON.stringify(m10)}`)
  check('fila existente: si el comprobante ya subió a Xubio, no se toca', m11.destino_xubio === 'COMPROBANTE' && m11.factura_id === fid11, JSON.stringify(m11))
  await db2.close()
}

// Comisión en un día sin IVA ni percepciones → al asiento; si después llega el IVA, vuelve al comprobante.
const D2 = dia(-9)
await importar(ca, 'x2', [{ fecha: D2, descripcion: 'COMISION MANTENIMIENTO', importe: -100, saldo: 880 }])
await como('teso@prueba.com')
check('día con comisión y sin IVA: no hay comprobante (la comisión va al asiento)', (await val(`select generar_comprobante_gastos($1, $2) id`, [ca, D2])).id === null)
check('… la comisión quedó para el asiento, marcada', (await val(`select destino_xubio, sin_iva_auto from movimientos_bancarios where fecha = $1 and descripcion like 'COMISION%'`, [D2])).destino_xubio === 'ASIENTO')
const a2 = (await val(`select generar_asiento_bancario($1, $2) id`, [ca, D2])).id
check('… y el asiento del día la lleva a gastos bancarios (100 al debe, banco 100 al haber)',
  a2 !== null && (await filas(`select cuenta_contable, debe::float, haber::float from asiento_lineas where asiento_id = $1 order by debe desc`, [a2])).map((l) => `${l.cuenta_contable}:${l.debe}:${l.haber}`).join('|') === 'GASTOS BANCARIOS:100:0|Banco Prueba CA:0:100')
await servidor()
await importar(ca, 'x3', [{ fecha: D2, descripcion: 'I.V.A. BASE', importe: -21, saldo: 859 }])
await como('teso@prueba.com')
const f2 = (await val(`select generar_comprobante_gastos($1, $2) id`, [ca, D2])).id
check('llega el IVA de ese día: la comisión vuelve al comprobante (100 + IVA 21)',
  f2 !== null && (await val(`select total::text t from facturas where id = $1`, [f2])).t === '121.00')
check('… y el asiento que la llevaba se fue', (await val(`select count(*)::int n from asientos where cuenta_origen_id = $1 and fecha = $2`, [ca, D2])).n === 0)
// Comprobante ya subido: no se toca.
await servidor()
await db.query(`update facturas set estado_xubio = 'SUBIDA', xubio_id = '9' where id = $1`, [f2])
const D3 = dia(-8)
await importar(ca, 'x4', [{ fecha: D3, descripcion: 'COMISION MANTENIMIENTO', importe: -50, saldo: 800 }, { fecha: D3, descripcion: 'I.V.A. BASE', importe: -10.5, saldo: 789.5 }])
await como('teso@prueba.com')
const f3 = (await val(`select generar_comprobante_gastos($1, $2) id`, [ca, D3])).id
check('día con comisión e IVA: todo en el comprobante (no pasa al asiento)', f3 !== null && (await val(`select total::text t from facturas where id = $1`, [f3])).t === '60.50')

// ================================================================ 3. Sin movimientos: solo días cerrados
await servidor()
const mp = await cuenta('MP PRUEBA', 'CC')
await db.query(`insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, 'india', 500, 'MANUAL', 't')`, [mp, dia(-5)])
await como('teso@prueba.com')
check('sin movimientos de HOY: no (el día todavía no cerró)', /ya cerrado/.test(await error(`select marcar_sin_movimientos($1, $2)`, [mp, hoy]) ?? ''))
check('… ni de un día futuro', /ya cerrado/.test(await error(`select marcar_sin_movimientos($1, $2)`, [mp, dia(2)]) ?? ''))
check('de ayer: sí, repite el saldo anterior', Number((await val(`select marcar_sin_movimientos($1, $2) s`, [mp, dia(-1)])).s) === 500 || (await val(`select count(*)::int n from saldos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [mp, dia(-1)])).n === 1)

// ================================================================ 6. Feriados
await servidor()
check('feriados: la lista del Apps Script quedó cargada (14)', (await val(`select count(*)::int n from feriados where nombre like '%Apps Script%'`)).n === 14)
check('el 8/12 y el 25/12 no son días hábiles; el 9/12 sí', !(await val(`select es_dia_habil('2026-12-08') h`)).h && !(await val(`select es_dia_habil('2026-12-25') h`)).h && (await val(`select es_dia_habil('2026-12-09') h`)).h)

// ================================================================ 2. Flujo: pagos en Xubio
const prov = (await val(`insert into proveedores (cuit, nombre, organizacion_id) values ('30111111118', 'PROVEEDOR X SA', $1) returning id`, [org])).id
const cb = await cuenta('BANCO PRUEBA FLUJO CC', 'CC', { requiere: true })
let nh = 0
const mov = async (c, fecha, importe, desc = 'TRANSF PRUEBA', categoria = 'SIN_CLASIFICAR') => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
   values ('india', $1, $2, $3, $4, $5, $6, 'PENDIENTE') returning id`, [c, fecha, desc, importe, `F-${nh++}`, categoria])).id
const pago = async (importe, fecha, extra = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, cuenta_origen_id, estado_xubio_pago, estado, xubio_id, gestion, contabilizado_por)
   values ('india', $1, $2, $3, $4, 'prueba', $5, $6, $7, $8, $9, 'prueba') returning id`,
  [prov, fecha, importe, extra.medio ?? 'TRANSFERENCIA', extra.cuenta ?? cb, extra.xubio ?? null, extra.estado ?? 'CARGADO', extra.xid ?? null, extra.gestion ?? 'SISTEMA'])).id
const linea = (tipo, id) => val(`select fecha::text, importe::text, afecta_bancos from flujo_lineas where origen_tipo = $1 and origen_id = $2 and naturaleza = 'REAL'`, [tipo, id])
const F0 = dia(-6)
await mov(cb, dia(-12), 100000, 'DEPOSITO INICIAL', 'COBRO')   // un saldo de apertura cualquiera: da cobertura del extracto

const pOk = await pago(1000, F0, { xubio: 'SUBIDO' })
const pYa = await pago(1100, F0, { xubio: 'YA_EN_XUBIO', cuenta: null })
const pMano = await pago(1200, F0, { xubio: 'cargado_a_mano', cuenta: null })
const pSin = await pago(1300, F0, { xubio: null })
const pHoja = await pago(1400, F0, { xubio: 'SIN_ERP_XUBIO', estado: 'CONTABILIZADO', xid: 'RALPHARMA', gestion: 'HOJA' })
const pNativo = await pago(1500, F0, { xubio: null, estado: 'CONTABILIZADO', xid: '7001', cuenta: null })
const pViejo = await pago(1600, '2026-11-10', { xubio: null, cuenta: null })
const pCaja = await pago(1700, F0, { medio: 'CAJA', xubio: 'SUBIDO', cuenta: null })
// Sus débitos en el banco (los de los pagos que no están en Xubio y el de caja no existe)
const dOk = await mov(cb, F0, -1000), dSin = await mov(cb, F0, -1300), dHoja = await mov(cb, F0, -1400)
const dYa = await mov(cb, F0, -1100), dMano = await mov(cb, F0, -1200), dNat = await mov(cb, F0, -1500)
await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [pOk, dOk])
await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [pSin, dSin])
await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [pHoja, dHoja])
await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [pYa, dYa])
await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [pMano, dMano])
await db.query(`update movimientos_bancarios set pago_id = $1 where id = $2`, [pNativo, dNat])
await como('teso@prueba.com')
check('pago SUBIDO / YA_EN_XUBIO / CARGADO_A_MANO (cualquier mayúscula): entran', !!(await linea('PAGO', pOk)) && !!(await linea('PAGO', pYa)) && !!(await linea('PAGO', pMano)))
check('pago que no está en Xubio: no entra como pago', !(await linea('PAGO', pSin)) && !(await linea('PAGO', pHoja)))
check('pago cargado en el sistema con su id de Xubio (contabilizado): entra', !!(await linea('PAGO', pNativo)))
check('pago anterior al corte (17/11): entra aunque no tenga estado', !!(await linea('PAGO', pViejo)))
check('pago de caja: no entra, ni con estado SUBIDO', !(await linea('PAGO', pCaja)))
check('el débito de un pago que no entra SIGUE contando (como movimiento, −1.300 y −1.400)',
  (await val(`select importe::text i from flujo_lineas where origen_tipo = 'MOVIMIENTO' and origen_id = $1`, [dSin])).i === '-1300.00'
  && (await val(`select importe::text i from flujo_lineas where origen_tipo = 'MOVIMIENTO' and origen_id = $1`, [dHoja])).i === '-1400.00')
check('el débito de un pago que sí entra no cuenta dos veces', (await val(`select count(*)::int n from flujo_lineas where origen_tipo = 'MOVIMIENTO' and origen_id = $1`, [dOk])).n === 0)
const ctrl = await val(`select (-sum(importe))::text s from flujo_lineas where unidad_id = $1 and naturaleza = 'REAL' and afecta_bancos and cuenta_origen_id = $3 and fecha = $2`, [uIndia, F0, cb])
check('lo que salió del banco ese día = lo que cuenta el Flujo (7.500: cuatro pagos que entran + los dos débitos de los que no), sin perder el débito del pago excluido', ctrl.s === '7500.00', JSON.stringify(ctrl))

// Débito en lote: dos pagos en Xubio y uno que no; el débito cuenta solo la parte del que no entra.
await servidor()
const F1 = dia(-5)
const l1 = await pago(200, F1, { xubio: 'SUBIDO' }), l2 = await pago(300, F1, { xubio: 'SUBIDO' }), l3 = await pago(500, F1, { xubio: null })
const dl = await mov(cb, F1, -1000, 'TRANSF LOTE')
await db.query(`select conciliar_movimientos('india')`)
check('el débito de 1.000 quedó vinculado a los tres pagos (lote, 0032)', (await val(`select count(*)::int n from movimientos_pagos where movimiento_id = $1`, [dl])).n === 3)
await como('teso@prueba.com')
check('lote: los dos pagos en Xubio cuentan el día del débito y el débito suma solo el pago que no entra (−500)',
  !!(await linea('PAGO', l1)) && !!(await linea('PAGO', l2)) && !(await linea('PAGO', l3))
  && (await val(`select importe::text i from flujo_lineas where origen_tipo = 'MOVIMIENTO' and origen_id = $1`, [dl])).i === '-500.00')
check('… el total del día es el del banco (−1.000)', (await val(`select sum(importe)::text s from flujo_lineas where unidad_id = $1 and naturaleza = 'REAL' and afecta_bancos and fecha = $2`, [uIndia, F1])).s === '-1000.00')

// ================================================================ 4. Doble conteo: factura proyectada ya pagada según el extracto
await servidor()
const factura = async (total, vence, num) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable, origen)
   values ('india', $1, 'Factura A', 'A', 7, $2, $3, $4, $5, $5, 'PARA_PAGAR', 0, 'PROVEEDORES', 'MANUAL') returning id`, [prov, num, dia(-20), vence, total])).id
const proyecta = async (f) => (await val(`select count(*)::int n from flujo_lineas where origen_tipo = 'FACTURA' and origen_id = $1`, [f])).n
const fA = await factura(7777, dia(10), 1001)
check('sin débito parecido, la factura se proyecta', (await proyecta(fA)) === 1)
const dA = await mov(cb, dia(-3), -7777, 'TRANSF A PROVEEDOR')
await como('teso@prueba.com')
check('un débito sin documento por el mismo importe dentro de la ventana (−30/+3): la factura deja de proyectarse (el débito ya cuenta)',
  (await proyecta(fA)) === 0 && (await val(`select importe::text i from flujo_lineas where origen_tipo = 'MOVIMIENTO' and origen_id = $1`, [dA])).i === '-7777.00')
await servidor()
// Fuera de la ventana: 40 días antes del vencimiento no cuenta.
const fB = await factura(8888, dia(60), 1002)
await mov(cb, dia(-3), -8888, 'TRANSF OTRA')
check('débito fuera de la ventana (más de 30 días antes del vencimiento): la factura sigue proyectada', (await proyecta(fB)) === 1)
// Dos facturas iguales y un débito: ambigua, no se toca.
const fC1 = await factura(9999, dia(8), 1003), fC2 = await factura(9999, dia(9), 1004)
await mov(cb, dia(-2), -9999, 'TRANSF AMBIGUA')
check('dos facturas posibles para un débito: no se toca ninguna', (await proyecta(fC1)) === 1 && (await proyecta(fC2)) === 1)
// Una factura y dos débitos iguales: ambigua.
const fD = await factura(6543, dia(8), 1005)
await mov(cb, dia(-2), -6543, 'TRANSF D1'); await mov(cb, dia(-1), -6543, 'TRANSF D2')
check('un débito con dos candidatos del otro lado (dos débitos para una factura): no se toca', (await proyecta(fD)) === 1)
// Un débito ya vinculado a un pago no cuenta como candidato.
const fE = await factura(4321, dia(8), 1006)
const pE = await pago(4321, dia(-2), { xubio: 'SUBIDO' })
await mov(cb, dia(-2), -4321, 'TRANSF VINCULADA')
await db.query(`update movimientos_bancarios set pago_id = $1 where descripcion = 'TRANSF VINCULADA'`, [pE])
check('un débito ya vinculado a un pago no se usa para saldar la factura', (await proyecta(fE)) === 1)
// Débito de otra empresa: no.
const fF = await factura(2468, dia(8), 1007)
const cBer = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id) values ('beratung', 'BANCO PRUEBA BERATUNG', 'BANCOPRUEBA', 'CC', (select id from unidades where empresa_id = 'beratung' and codigo = 'beratung')) returning id`)).id
await db.query(`insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado) values ('beratung', $1, $2, 'TRANSF OTRA EMPRESA', -2468, 'F-otra', 'SIN_CLASIFICAR', 'PENDIENTE')`, [cBer, dia(-2)])
check('un débito de otra empresa no salda la factura', (await proyecta(fF)) === 1)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
