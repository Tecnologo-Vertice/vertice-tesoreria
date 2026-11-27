// Pruebas de 0037: Xubio de ida y vuelta (Tanda 5 de PARIDAD_COMPLETA.md, 27/11/2026).
//   1. N° de orden de pago o de asiento: a mano desde la pantalla y traído por el servidor desde Xubio.
//   2. Saldo de Xubio: emparejar la cuenta de Xubio con la cuenta bancaria por los dígitos y llenar lecturas_xubio.
//   3. Cobranzas de Xubio → cobros.   4. Sincronizar facturas pagadas con los pagos cargados.
//   5. Resultado de la anulación por API (queda en la auditoría).
// Datos ficticios. Las fechas salen de hoy_ar(), nunca de current_date.
// Uso (desde demo/): node supabase/pruebas/probar_0037.mjs supabase/migrations
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

// ---------------------------------------------------------------- Datos ficticios
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
const pDelta = await prov('30710000012', 'Delta Servicios SRL')
const pago = async (extra = {}) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, tipo_pago, forma_carga_xubio, estado, xubio_id, contabilizado_por, gestion, factura_asociada, proveedor_destino, detalle_contabilizacion)
   values ($1, $2, $3, $4, 'TRANSFERENCIA', 'teso@prueba.com', $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
  [extra.empresa ?? 'india', extra.proveedor ?? pGamma, extra.fecha ?? dia(-3), extra.importe ?? 1000, extra.tipoPago ?? 'SIN_FACTURA', extra.forma ?? 'ORDEN_PAGO',
   extra.estado ?? 'CONTABILIZADO', extra.xubioId === undefined ? 'OP-7001' : extra.xubioId, (extra.estado ?? 'CONTABILIZADO') === 'CONTABILIZADO' ? 'admin@prueba.com' : null,
   extra.gestion ?? 'SISTEMA', extra.facturaAsociada ?? null, extra.destino ?? null, extra.detalle ?? null])).id
const pagoDe = async (id) => val(`select * from pagos where id = $1`, [id])

// ================================================================ 1. N° de OP o de asiento
const pA = await pago({ importe: 1000, xubioId: 'OP-7001' })
await como('admin@prueba.com')
await db.query(`select guardar_numero_op($1, ' X-0001-00002312 ')`, [pA])
let p = await pagoDe(pA)
check('[1] a mano: guarda el N° (sin espacios), quién y cuándo, con origen MANUAL', p.numero_op === 'X-0001-00002312' && p.numero_op_origen === 'MANUAL' && p.numero_op_por === 'Admin' && p.numero_op_en !== null)
check('[1] a mano: el detalle de contabilización lleva el N° y el nombre', /N° X-0001-00002312 \(Admin\)/.test(p.detalle_contabilizacion))
check('[1] a mano: queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'NUMERO_OP_MANUAL' and entidad_id = $1`, [pA])).n === 1)
await falla('[1] a mano: cambiar un número ya cargado pide confirmación', `select guardar_numero_op($1, 'X-0001-00002399')`, [pA], /ya tiene el N° X-0001-00002312/)
await db.query(`select guardar_numero_op($1, 'X-0001-00002399', true)`, [pA])
p = await pagoDe(pA)
check('[1] a mano: se puede corregir y la auditoría dice cuál había', p.numero_op === 'X-0001-00002399' && (await val(`select count(*)::int n from auditoria where accion = 'NUMERO_OP_MANUAL' and entidad_id = $1 and detalle like '%antes X-0001-00002312%'`, [pA])).n === 1)
await falla('[1] a mano: el número no puede ir vacío', `select guardar_numero_op($1, '   ')`, [pA], /Escribí/)
await falla('[1] a mano: "PENDIENTE" no es un número', `select guardar_numero_op($1, 'pendiente')`, [pA], /número que le dio Xubio/)
await servidor()
const pCargado = await pago({ estado: 'CARGADO', xubioId: null, importe: 50 })
const pRalph = await pago({ estado: 'CONTABILIZADO', xubioId: 'RALPHARMA', importe: 60 })
await como('admin@prueba.com')
await falla('[1] a mano: un pago que todavía no está contabilizado no tiene número', `select guardar_numero_op($1, '1')`, [pCargado], /todavía no está contabilizado/)
await falla('[1] a mano: un pago cargado en Ralpharma no tiene N° de Xubio', `select guardar_numero_op($1, '1')`, [pRalph], /Ralpharma/)
await como('aprob@prueba.com')
await falla('[1] a mano: un aprobador no carga números', `select guardar_numero_op($1, '1')`, [pA], /rol/)
await como('solober@prueba.com')
await falla('[1] a mano: quien no ve la empresa del pago no puede', `select guardar_numero_op($1, '1')`, [pA], /acceso/)
await como('teso@prueba.com')
const pT = await (async () => { await servidor(); const id = await pago({ importe: 70, xubioId: 'OP-7002' }); await como('teso@prueba.com'); return id })()
await db.query(`select guardar_numero_op($1, 'X-0001-00002400')`, [pT])
check('[1] Tesorería también puede cargarlo', (await pagoDe(pT)).numero_op === 'X-0001-00002400')

// Lo que busca el servidor: solo órdenes de pago contabilizadas en Xubio, de los últimos 90 días, sin número.
await servidor()
const pSin1 = await pago({ importe: 2000, xubioId: 'OP-7010', fecha: dia(-2) })
const pSin2 = await pago({ importe: 3000, xubioId: 'OP-7011', fecha: dia(-5), proveedor: pDelta })
const pFc = await pago({ importe: 4000, xubioId: 'FC-123' })
const pAsiento = await pago({ importe: 5000, xubioId: 'OP-7012', forma: 'SALIDA_FONDOS' })
const pVieja = await pago({ importe: 6000, xubioId: 'OP-7013', fecha: dia(-120) })
const pBera = await pago({ empresa: 'beratung', importe: 7000, xubioId: 'OP-7014' })
const pRobles = await pago({ empresa: 'robles', importe: 8000, xubioId: 'OP-7015' })
const pend = (await val(`select numero_op_pendientes($1) r`, [org])).r
const ids = pend.pendientes.map((x) => x.id)
check('[1] el servidor ve los pagos de OP contabilizados sin número (de India y de Beratung)', ids.includes(pSin1) && ids.includes(pSin2) && ids.includes(pBera), JSON.stringify(ids))
check('[1] no entran: con número, dentro de una factura (FC-), asiento, de más de 90 días, Ralpharma ni no contabilizados',
  !ids.includes(pA) && !ids.includes(pT) && !ids.includes(pFc) && !ids.includes(pAsiento) && !ids.includes(pVieja) && !ids.includes(pRobles) && !ids.includes(pCargado) && !ids.includes(pRalph))
check('[1] trae el proveedor y los números ya usados', pend.pendientes.find((x) => x.id === pSin2).proveedor === 'Delta Servicios SRL' && pend.usados.some((x) => x.empresa_id === 'india' && x.numero === 'X-0001-00002399') && pend.usados.some((x) => x.numero === 'X-0001-00002400'))
check('[1] otra organización no ve nada de estos pagos', (await val(`select numero_op_pendientes(gen_random_uuid()) r`)).r.pendientes.length === 0)
await como('admin@prueba.com')
await falla('[1] una persona no puede pedir la lista del servidor', `select numero_op_pendientes($1)`, [org], /permission denied|servidor/)
await servidor()
check('[1] el servidor guarda el N° que encontró en Xubio (origen XUBIO) y lo deja en la auditoría',
  (await val(`select aplicar_numero_op_xubio($1, 'X-0001-00002500') r`, [pSin1])).r === true
  && (await pagoDe(pSin1)).numero_op_origen === 'XUBIO' && /automático desde Xubio/.test((await pagoDe(pSin1)).detalle_contabilizacion)
  && (await val(`select count(*)::int n from auditoria where accion = 'NUMERO_OP_XUBIO' and entidad_id = $1`, [pSin1])).n === 1)
check('[1] no pisa un número ya cargado (ni el de Xubio ni el manual)', (await val(`select aplicar_numero_op_xubio($1, 'X-0001-00009999') r`, [pSin1])).r === false
  && (await val(`select aplicar_numero_op_xubio($1, 'X-0001-00009999') r`, [pA])).r === false && (await pagoDe(pA)).numero_op === 'X-0001-00002399')
check('[1] no pone número a un pago que no está contabilizado', (await val(`select aplicar_numero_op_xubio($1, 'X-0001-00009998') r`, [pCargado])).r === false)
await como('admin@prueba.com')
await falla('[1] una persona no puede usar la función del servidor', `select aplicar_numero_op_xubio($1, 'X-1')`, [pSin2], /permission denied|servidor/)
await servidor()
check('[1] el pago con número ya no figura como pendiente', !(await val(`select numero_op_pendientes($1) r`, [org])).r.pendientes.some((x) => x.id === pSin1))

// ================================================================ 2. Saldo de Xubio: emparejar por dígitos
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const cuenta = async (nombre, extra = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, numero) values ('india', $1, $2, $3, $4, $5) returning id`,
  [nombre, extra.banco ?? 'BANCO', extra.clase ?? 'CC', uIndia, extra.numero ?? null])).id
const cHip = await cuenta('HIPOTECARIO CC-0319', { banco: 'HIPOTECARIO', numero: '0319' })
const cBru = await cuenta('BRUBANK CA 11001411', { banco: 'BRUBANK', clase: 'CA' })
const cMp = await cuenta('MERCADO PAGO', { banco: 'MERCADOPAGO', clase: 'BILLETERA' })
const cFci = await cuenta('FCI HIPOTECARIO', { banco: 'HIPOTECARIO', clase: 'FCI' })
const cIcbc1 = await cuenta('ICBC CC 4455', { banco: 'ICBC' })
const cIcbc2 = await cuenta('ICBC CA 4455', { banco: 'ICBC', clase: 'CA' })
const emp = async (x) => (await val(`select emparejar_cuenta_xubio('india', $1) id`, [x])).id
check('[2] empareja por dígitos: "Banco Hipotecario CC 0319" es HIPOTECARIO CC-0319', (await emp('Banco Hipotecario CC 0319')) === cHip)
check('[2] empareja si el número de Xubio es más largo y termina en los dígitos del banco', (await emp('Hipotecario Cta Cte 00000319')) === cHip)
check('[2] empareja el número largo de Brubank por sus dígitos', (await emp('11001411 BRUBANK')) === cBru)
check('[2] ya no hay emparejamiento por una palabra: "Mercado Pago Cobros" (otra cuenta del plan) no es la billetera, pero el nombre exacto sí', (await emp('Mercado Pago Cobros')) === null && (await emp('Mercado Pago')) === cMp)
check('[2] cuentas de gasto, deudores e impuestos no se emparejan aunque nombren al banco o tengan los mismos dígitos', (await emp('Gastos Bancarios Hipotecario 0319')) === null && (await emp('Deudores por ventas 0319')) === null && (await emp('Hipotecario 0319 Comisiones')) === null)
check('[2] los dígitos solos no alcanzan: tiene que nombrar al banco de la cuenta', (await emp('Cuenta 0319')) === null)
check('[2] dos cuentas con los mismos dígitos: no se adivina', (await emp('Banco ICBC 4455')) === null)
check('[2] cuentas de cheques, e-cheqs y fondos comunes no se emparejan', (await emp('Cheque Diferido BRUBANK 11001411')) === null && (await emp('FCI Hipotecario 0319')) === null && (await emp('Fondos Comun de Inversion Bancos')) === null)
check('[2] una cuenta que no se parece a ninguna: sin cuenta', (await emp('Caja chica oficina')) === null && (await emp('')) === null)
check('[2] el nombre exacto de la cuenta o de su cuenta contable sigue valiendo', (await emp('hipotecario cc-0319')) === cHip)

await db.query(`insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, 'india', 850, 'MANUAL', 'teso@prueba.com')`, [cHip, dia(-1)])
const conc = async (cta, fecha) => val(`select * from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = $2`, [cta, fecha])
let r = (await val(`select registrar_lecturas_xubio('india', $1, $2::jsonb, 'Saldo de Xubio', true) r`, [dia(-1), JSON.stringify([
  { cuenta: 'Banco Hipotecario CC 0319', saldo: 845 }, { cuenta: 'Caja chica oficina', saldo: 10 }, { cuenta: 'Fondos Comun de Inversion Bancos', saldo: 99 }, { cuenta: 'Rota', saldo: 'abc' }, { cuenta: '', saldo: 1 }])])).r
check('[2] lectura en lote: guarda solo la que se empareja con una cuenta bancaria y cuenta las demás', r.guardadas === 1 && r.sin_cuenta.length === 2 && r.invalidas === 2, JSON.stringify(r))
const k = await conc(cHip, dia(-1))
check('[2] la conciliación muestra el saldo de Xubio y la diferencia con el extracto (850 − 845 = 5)', n(k.saldo_xubio) === 845 && n(k.diferencia_xubio) === 5, JSON.stringify([k.saldo_xubio, k.diferencia_xubio]))
check('[2] la lectura queda con la cuenta emparejada y quién la leyó', (await val(`select cuenta_origen_id c, leido_por p from lecturas_xubio where cuenta_xubio = 'Banco Hipotecario CC 0319'`)).c === cHip)
r = (await val(`select registrar_lecturas_xubio('india', $1, $2::jsonb, 'Saldo de Xubio', true) r`, [dia(-1), JSON.stringify([{ cuenta: 'Banco Hipotecario CC 0319', saldo: 845 }])])).r
check('[2] repetir la misma lectura no agrega otra fila', r.guardadas === 0 && r.repetidas === 1 && (await val(`select count(*)::int n from lecturas_xubio where cuenta_xubio = 'Banco Hipotecario CC 0319'`)).n === 1)
await db.query(`select registrar_lecturas_xubio('india', $1, $2::jsonb, 'Saldo de Xubio', true)`, [dia(-1), JSON.stringify([{ cuenta: 'Banco Hipotecario CC 0319', saldo: 850 }])])
check('[2] si el saldo cambió se guarda otra y la conciliación usa la última (diferencia 0)', n((await conc(cHip, dia(-1))).diferencia_xubio) === 0 && (await val(`select count(*)::int n from lecturas_xubio where cuenta_xubio = 'Banco Hipotecario CC 0319'`)).n === 2)
check('[2] la lectura queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'LECTURA_XUBIO' and entidad_id = 'india'`)).n >= 2)
await falla('[2] una fecha futura no vale', `select registrar_lecturas_xubio('india', $1, '[{"cuenta":"X","saldo":1}]'::jsonb, null, false)`, [dia(1)], /futura/)
await falla('[2] sin lecturas falla', `select registrar_lecturas_xubio('india', $1, null, null, false)`, [dia(-1)], /Faltan/)
// Una sola cuenta (la función de siempre): ahora empareja por dígitos y no repite.
const idA = (await val(`select registrar_lectura_xubio('india', 'Banco Hipotecario CC 0319', $1, 850, 'servidor') id`, [dia(-1)])).id
check('[2] registrar_lectura_xubio (una cuenta) empareja por dígitos y no duplica una lectura igual', (await val(`select count(*)::int n from lecturas_xubio where cuenta_xubio = 'Banco Hipotecario CC 0319'`)).n === 2 && idA !== null)
await como('teso@prueba.com')
await db.query(`select registrar_lecturas_xubio('india', $1, '[{"cuenta":"Mercado Pago","saldo":500.5}]'::jsonb, null, true)`, [dia(-1)])
check('[2] Tesorería puede cargar un saldo a mano y queda con su mail', (await val(`select leido_por p, cuenta_origen_id c from lecturas_xubio where cuenta_xubio = 'Mercado Pago'`)).p === 'teso@prueba.com')
await como('aprob@prueba.com')
await falla('[2] un aprobador no carga saldos', `select registrar_lecturas_xubio('india', $1, '[{"cuenta":"X","saldo":1}]'::jsonb, null, false)`, [dia(-1)], /rol/)
await como('solober@prueba.com')
await falla('[2] quien no ve la empresa no carga saldos', `select registrar_lecturas_xubio('india', $1, '[{"cuenta":"X","saldo":1}]'::jsonb, null, false)`, [dia(-1)], /acceso/)
await servidor()

// ================================================================ 3. Cobranzas de Xubio
const cobros = [
  { fecha: dia(-2), recibo: 'R-0001-00000050', transaccion_id: '880', instrumento_id: '1', cliente: 'Cliente Uno SA', cuenta: 'Banco Hipotecario CC 0319', importe: 1500.5, descripcion: 'Transferencia' },
  { fecha: dia(-2), recibo: 'R-0001-00000050', transaccion_id: '880', instrumento_id: '2', cliente: 'Cliente Uno SA', cuenta: 'Caja chica oficina', importe: 200, descripcion: '' },
  { fecha: dia(-1), recibo: 'R-0001-00000051', transaccion_id: '881', instrumento_id: '3', cliente: '', cuenta: 'Mercado Pago', importe: 300, descripcion: 'MP' },
  { fecha: dia(-1), recibo: 'R-0001-00000052', transaccion_id: '882', instrumento_id: '4', cliente: 'Sin importe', cuenta: 'X', importe: 0, descripcion: '' },
  { fecha: 'no es fecha', recibo: 'R-9', transaccion_id: '883', instrumento_id: '5', cliente: 'Fecha mala', cuenta: 'X', importe: 10, descripcion: '' },
]
r = (await val(`select importar_cobros_xubio('india', $1::jsonb, 'Cobranzas de Xubio') r`, [JSON.stringify(cobros)])).r
check('[3] cobranzas: entran los de importe positivo (una fila por instrumento) y se descartan los inválidos', r.nuevas === 3 && r.ya_estaban === 0 && r.omitidas === 2, JSON.stringify(r))
const cb = await filas(`select * from cobros where empresa_id = 'india' and origen = 'XUBIO' order by xubio_transaccion_id`)
check('[3] la clave es transacción + instrumento y trae recibo, cliente e importe', cb.length === 3 && cb[0].xubio_transaccion_id === '880:1' && cb[0].recibo === 'R-0001-00000050' && n(cb[0].importe) === 1500.5 && cb[0].cliente === 'Cliente Uno SA')
check('[3] el cobro se empareja con la cuenta bancaria por los dígitos; el de caja queda sin cuenta; sin cliente: "Sin nombre"',
  cb[0].cuenta_origen_id === cHip && cb[1].cuenta_origen_id === null && cb[2].cuenta_origen_id === cMp && cb[2].cliente === 'Sin nombre')
r = (await val(`select importar_cobros_xubio('india', $1::jsonb, null) r`, [JSON.stringify(cobros)])).r
check('[3] traer lo mismo otra vez no repite ningún cobro', r.nuevas === 0 && r.ya_estaban === 3 && (await val(`select count(*)::int n from cobros where origen = 'XUBIO'`)).n === 3, JSON.stringify(r))
check('[3] queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'COBROS_XUBIO' and entidad_id = 'india'`)).n === 1)
await falla('[3] una empresa que no existe', `select importar_cobros_xubio('nadie', '[]'::jsonb, null)`, [], /Empresa inexistente/)
await como('admin@prueba.com')
await falla('[3] una persona no puede importar cobranzas', `select importar_cobros_xubio('india', '[]'::jsonb, null)`, [], /permission denied|servidor/)
await como('aprob@prueba.com')
check('[3] quien ve la empresa ve los cobros; quien no, no', (await val(`select count(*)::int n from cobros`)).n === 3)
await como('solober@prueba.com')
check('[3] un usuario de Beratung no ve los cobros de India (RLS)', (await val(`select count(*)::int n from cobros`)).n === 0)
await servidor()

// ================================================================ 4. Sincronizar facturas pagadas
let nro = 700
const factura = async (extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, gestion, cuenta_contable)
   values ($1, $2, $3, 'A', 1, $4, $5, $6, $7, $7, $8, $9, $10, 'PROVEEDORES LOCALES') returning id`,
  [extra.empresa ?? 'india', extra.proveedor ?? pGamma, extra.tipo ?? 'Factura A', extra.numero ?? nro++, dia(-20), dia(5), extra.total ?? 1000, extra.estado ?? 'PARA_PAGAR', extra.pagado ?? 0, extra.gestion ?? 'SISTEMA'])).id
const num = (x) => `00001-${String(x).padStart(8, '0')}`
const fac = async (id) => val(`select estado::text, pagado::float, fecha_pago::text from facturas where id = $1`, [id])
const pagoFc = (facturaAsociada, importe, extra = {}) => pago({ facturaAsociada, importe, destino: extra.destino ?? 'GAMMA S.A.', tipoPago: 'FACTURA', gestion: extra.gestion ?? 'HOJA', fecha: extra.fecha ?? dia(-4), estado: extra.estado ?? 'CONTABILIZADO', proveedor: extra.proveedor ?? null, xubioId: extra.xubioId ?? 'OP-1' })

const f1 = await factura({ numero: 701, total: 1000 })
const f2 = await factura({ numero: 702, total: 1000 })
const f3 = await factura({ numero: 703, total: 500 })
const f4 = await factura({ numero: 704, total: 800, proveedor: pDelta })
const f5 = await factura({ numero: 705, total: 400 })
const f6 = await factura({ numero: 706, total: 400 })
const fHoja = await factura({ numero: 707, total: 300, gestion: 'HOJA' })
const fNc = await factura({ numero: 708, total: 300, tipo: 'Nota de Crédito A' })
const fVieja = await factura({ numero: 709, total: 600, estado: 'PAGADA' })
await pagoFc(num(701), 1000)                          // paga todo, un pago
await pagoFc(num(702), 400, { fecha: dia(-6) })       // parcial
await pagoFc(num(703), 500, { estado: 'ANULADO', xubioId: null })   // anulado: no cuenta
await pagoFc(num(704), 800, { destino: 'OTRO PROVEEDOR SA' })        // otro proveedor: no cuenta
await pagoFc(`${num(705)}, ${num(706)}`, 800)         // un pago para dos facturas: alcanza para las dos
await pagoFc(num(707), 300)
await pagoFc(num(708), 300)
await pagoFc(num(709), 600)

const seco = (await val(`select sincronizar_facturas_pagadas($1, false) r`, [org])).r
check('[4] en seco dice qué haría y no toca nada', seco.aplicado === false && seco.cambios.length === 4 && (await fac(f1)).estado === 'PARA_PAGAR' && (await fac(f5)).pagado === 0, JSON.stringify(seco.cambios.map((c) => [c.numero, c.tipo])))
r = (await val(`select sincronizar_facturas_pagadas($1) r`, [org])).r
check('[4] aplica: un pago que cubre el total deja la factura PAGADA con la fecha del pago', (await fac(f1)).estado === 'PAGADA' && (await fac(f1)).pagado === 1000 && (await fac(f1)).fecha_pago === dia(-4), JSON.stringify(await fac(f1)))
check('[4] un pago parcial deja PAGADA_PARCIAL por lo pagado, sin fecha de pago', (await fac(f2)).estado === 'PAGADA_PARCIAL' && (await fac(f2)).pagado === 400 && (await fac(f2)).fecha_pago === null)
check('[4] un pago de varias facturas que alcanza para todas las paga a las dos', (await fac(f5)).estado === 'PAGADA' && (await fac(f6)).estado === 'PAGADA')
check('[4] no cuentan: pago anulado, pago de otro proveedor, factura de la hoja, nota de crédito ni factura ya pagada',
  (await fac(f3)).estado === 'PARA_PAGAR' && (await fac(f4)).estado === 'PARA_PAGAR' && (await fac(fHoja)).estado === 'PARA_PAGAR' && (await fac(fNc)).estado === 'PARA_PAGAR' && (await fac(fVieja)).pagado === 0)
check('[4] cada pago queda vinculado a su factura (pagos_facturas) y deja la auditoría', (await val(`select count(*)::int n from pagos_facturas where factura_id = $1`, [f1])).n === 1
  && (await val(`select count(*)::int n from auditoria where accion = 'FACTURA_PAGADA_SINCRONIZADA'`)).n === 4)
r = (await val(`select sincronizar_facturas_pagadas($1) r`, [org])).r
check('[4] correrlo otra vez no cambia nada (no cuenta dos veces)', r.cambios.length === 0 && (await fac(f2)).pagado === 400 && (await fac(f1)).pagado === 1000, JSON.stringify(r))
// Un pago que no alcanza para las dos facturas que nombra: queda para revisar a mano.
const f7 = await factura({ numero: 711, total: 700 })
const f8 = await factura({ numero: 712, total: 700 })
await pagoFc(`${num(711)}; ${num(712)}`, 900)
r = (await val(`select sincronizar_facturas_pagadas($1) r`, [org])).r
check('[4] un pago de varias facturas que no alcanza: no adivina, la factura va a la lista "a mano"', r.cambios.length === 0 && r.manual.length === 2 && (await fac(f7)).estado === 'PARA_PAGAR')
// Una factura que ya tenía algo pagado por un pago vinculado y otro pago sin vincular: se suman, una sola vez.
const f9 = await factura({ numero: 713, total: 1000, estado: 'PAGADA_PARCIAL', pagado: 300 })
await pagoFc(num(713), 700, { fecha: dia(-1) })
await sincronizarYa()
async function sincronizarYa() { await db.query(`select sincronizar_facturas_pagadas($1)`, [org]) }
check('[4] suma lo que ya estaba pagado con el pago nuevo: 300 + 700 = pagada', (await fac(f9)).estado === 'PAGADA' && (await fac(f9)).pagado === 1000 && (await fac(f9)).fecha_pago === dia(-1))
check('[4] otra organización: no toca nada de esta', (await val(`select sincronizar_facturas_pagadas(gen_random_uuid()) r`)).r.cambios.length === 0)
await como('admin@prueba.com')
await falla('[4] una persona no puede sincronizar', `select sincronizar_facturas_pagadas($1)`, [org], /permission denied|servidor/)
await servidor()
check('[4] los números de factura del pago se entienden con letra, ceros y separadores',
  JSON.stringify((await val(`select numeros_de_facturas('A-00001-00000701, A-1-702;0003-9') r`)).r) === JSON.stringify(['1-701', '1-702', '3-9']))
check('[4] mismo proveedor: una palabra de 4 letras en común, sin SA, SRL ni laboratorio', (await val(`select mismo_proveedor_palabras('Laboratorios Gamma SA', 'GAMMA S.A.') r`)).r === true
  && (await val(`select mismo_proveedor_palabras('Laboratorios Gamma SA', 'Laboratorios Delta SA') r`)).r === false)

// ================================================================ 5. Resultado de la anulación por API
const pAn = await pago({ estado: 'CONTABILIZADO', importe: 90, xubioId: 'OP-7777' })
await db.query(`update pagos set estado = 'ANULADO', anulacion_xubio = 'PENDIENTE' where id = $1`, [pAn])
check('[5] marca la anulación como HECHA y la deja en la auditoría', (await val(`select resultado_anulacion_xubio('pagos', $1, 'HECHA', 'Anulado en Xubio: orden de pago 7777') r`, [pAn])).r === true
  && (await pagoDe(pAn)).anulacion_xubio === 'HECHA' && (await val(`select count(*)::int n from auditoria where accion = 'ANULADO_EN_XUBIO' and entidad_id = $1`, [pAn])).n === 1)
check('[5] solo toca lo que está PENDIENTE (no pisa un resultado ya puesto)', (await val(`select resultado_anulacion_xubio('pagos', $1, 'ERROR', 'otra vez') r`, [pAn])).r === false && (await pagoDe(pAn)).anulacion_xubio === 'HECHA')
const pAn2 = await pago({ estado: 'CONTABILIZADO', importe: 91, xubioId: 'OP-7778' })
await db.query(`update pagos set estado = 'ANULADO', anulacion_xubio = 'PENDIENTE' where id = $1`, [pAn2])
await db.query(`select resultado_anulacion_xubio('pagos', $1, 'ERROR', 'en Xubio el orden de pago 7778 no tiene el importe 91')`, [pAn2])
check('[5] un error queda como ERROR con el motivo en la auditoría', (await pagoDe(pAn2)).anulacion_xubio === 'ERROR' && (await val(`select count(*)::int n from auditoria where accion = 'ANULACION_XUBIO_ERROR' and detalle like '%no tiene el importe%'`)).n === 1)
await falla('[5] estado inválido', `select resultado_anulacion_xubio('pagos', $1, 'LISTO', '')`, [pAn2], /Estado inválido/)
await falla('[5] tabla inválida', `select resultado_anulacion_xubio('usuarios', $1, 'HECHA', '')`, [pAn2], /Tabla inválida/)
await como('admin@prueba.com')
await falla('[5] una persona no puede marcar anulaciones', `select resultado_anulacion_xubio('pagos', $1, 'HECHA', '')`, [pAn2], /permission denied|servidor/)
await servidor()

// ================================================================ Arreglos de la revisión
await servidor()
r = (await val(`select registrar_lecturas_xubio('india', $1, $2::jsonb, 'Saldo de Xubio', true) r`, [dia(-5), JSON.stringify([
  { cuenta: 'Banco Hipotecario CC 0319', saldo: 100 }, { cuenta: 'Hipotecario Cta Cte 00000319', saldo: 200 }, { cuenta: '11001411 BRUBANK', saldo: 300 }])])).r
check('[R] dos cuentas de Xubio para la misma cuenta bancaria: se descartan las dos y se avisa; la otra se guarda',
  r.guardadas === 1 && r.duplicadas.length === 2 && (await val(`select count(*)::int n from lecturas_xubio where fecha = $1`, [dia(-5)])).n === 1
  && (await val(`select count(*)::int n from auditoria where accion = 'LECTURA_XUBIO' and detalle like '%DESCARTADAS%'`)).n === 1, JSON.stringify(r))
const dosInstr = [
  { fecha: dia(-1), recibo: 'R-7', transaccion_id: '990', instrumento_id: '', cliente: 'Cli', cuenta: 'x', importe: 100 },
  { fecha: dia(-1), recibo: 'R-7', transaccion_id: '990', instrumento_id: '', cliente: 'Cli', cuenta: 'y', importe: 200 }]
r = (await val(`select importar_cobros_xubio('india', $1::jsonb, null) r`, [JSON.stringify(dosInstr)])).r
check('[R] dos instrumentos de una cobranza sin id de instrumento no se pisan, y repetir no duplica', r.nuevas === 2
  && (await val(`select importar_cobros_xubio('india', $1::jsonb, null) r`, [JSON.stringify(dosInstr)])).r.nuevas === 0)
check('[R] el N° de OP es único por empresa en la base (índice)', /duplicate key|unique/i.test((await error(`update pagos set numero_op = 'X-0001-00002399' where id = $1`, [pT])) ?? ''))

// ================================================================ Permisos: lo del servidor no se ve desde la pantalla
await como('admin@prueba.com')
for (const fn of ['emparejar_cuenta_xubio', 'guardar_lectura_xubio', 'numeros_de_facturas', 'mismo_proveedor_palabras']) {
  const e = await error(`select ${fn}(${fn === 'numeros_de_facturas' ? `'1'` : fn === 'mismo_proveedor_palabras' ? `'a', 'b'` : fn === 'emparejar_cuenta_xubio' ? `'india', 'x'` : `'india', 'x', '${hoy}', 1, 'u'`})`)
  check(`permisos: ${fn} solo para el servidor`, e !== null && /permission denied/.test(e), e ?? 'no falló')
}
await servidor()
await db.exec(`reset role; set role anon`)
const eAnon = await error(`select guardar_numero_op(gen_random_uuid(), '1')`)
check('permisos: anon no ejecuta guardar_numero_op ni registrar_lecturas_xubio', eAnon !== null && /permission denied/.test(eAnon) && /permission denied/.test(await error(`select registrar_lecturas_xubio('india', '${hoy}', '[]'::jsonb, null, false)`) ?? ''), eAnon ?? '')
await servidor()

console.log(`\n${ok} OK · ${mal} MAL`)
await db.close()
process.exit(mal ? 1 : 0)
