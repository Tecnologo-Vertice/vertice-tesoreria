// Pruebas de la base de Tesorería sin planillas (migraciones 0023 a 0027): bancos, conciliación, FCI,
// comprobante de gastos, asientos, cheques, Flujo, ajustes y control. Casos con resultado conocido, varios
// tomados de lo que pasó en VBI+ el 26/11/2026 (con importes ficticios o redondos).
// Uso (desde demo/): npm run test:tesoreria
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
  catch (e) { check(nombre, patron.test(e.message), e.message.slice(0, 120)) }
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
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones 0001 a 0027 aplican', true)

// ---------------------------------------------------------------- Datos de prueba (ficticios)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('admin@prueba.com', 'Admin', 'ADMIN', true),
    ('dir@prueba.com', 'Dire', 'DIRECCION', true), ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('solober@prueba.com', 'beratung');
  insert into cuentas_contables (empresa_id, nombre) values (null, 'Banco Hipotecario CA'), (null, 'Mercado Pago');
`)
const cc = async (nombre) => (await val(`select id from cuentas_contables where nombre = $1`, [nombre])).id
const ca = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, cuenta_contable_id, patrones)
  values ('india', 'HIPOTECARIO CA-0010', 'HIPOTECARIO', 'CA', '30500011072', $1, '{hipotecario ca-0010}') returning id`, [await cc('Banco Hipotecario CA')])).id
const fci = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuenta_madre_id)
  values ('india', 'HIPOTECARIO FCI', 'HIPOTECARIO', 'FCI', $1) returning id`, [ca])).id
const mp = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, rinde_diario, cuenta_contable_id)
  values ('india', 'MERCADO PAGO', 'MP', 'BILLETERA', true, $1) returning id`, [await cc('Mercado Pago')])).id
const unidadIndia = (await val(`select unidad_por_defecto('india') u`)).u
check('cada empresa tiene su unidad por defecto', (await val(`select count(*)::int n from empresas e where unidad_por_defecto(e.id) is null`)).n === 0)
check('Beratung tiene dos unidades (S/Dax y Dax Salud)', (await val(`select count(*)::int n from unidades where empresa_id = 'beratung'`)).n === 2)
check('la cuenta toma la unidad de su empresa', (await val(`select unidad_id = $1 x from cuentas_origen where id = $2`, [unidadIndia, ca])).x)
check('cada unidad tiene su fila "Sin clasificar"', (await val(`select count(*)::int n from unidades u where fila_especial(u.id, 'SIN_CLASIFICAR') is null`)).n === 0)
check('días hábiles: sábado 28/11/2026 → lunes 30/11', (await val(`select dia_habil_desde('2026-11-28') d`)).d.toISOString().startsWith('2026-11-30'))

// ---------------------------------------------------------------- Importar extracto
const extracto = (hash, movs, saldos) => ({ cuenta_origen_id: ca, usuario: 'teso@prueba.com', archivo: { nombre: hash + '.csv', hash }, movimientos: movs, saldos })
const dia1 = [
  { fecha: '2026-11-23', descripcion: 'TRANSFERENCIA RECIBIDA', importe: 1000, saldo: 1000 },
]
const dia2 = [
  { fecha: '2026-11-24', descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 994 },
  { fecha: '2026-11-24', descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 988 },
  { fecha: '2026-11-24', descripcion: 'COMISION MANTENIMIENTO CUENTA', importe: -100, saldo: 888 },
  { fecha: '2026-11-24', descripcion: 'I.V.A. BASE', importe: -21, saldo: 867 },
  { fecha: '2026-11-24', descripcion: 'PERCEPCION IVA RG 2408', importe: -3, saldo: 864 },
  { fecha: '2026-11-24', descripcion: 'SIRCREB RETENCION', importe: -4, saldo: 860 },
  { fecha: '2026-11-24', descripcion: 'MOVIMIENTO RARO SIN REGLA', importe: -10, saldo: 850 },
]
await servidor()
let r = (await val(`select importar_extracto($1) r`, [extracto('a1', [...dia1, ...dia2])])).r
check('importar: 8 movimientos nuevos (los dos impuestos iguales entran los dos)', r.nuevos === 8, JSON.stringify(r))
r = (await val(`select importar_extracto($1) r`, [extracto('a1', [...dia1, ...dia2])])).r
check('el mismo archivo no entra dos veces', r.repetido === true)
r = (await val(`select importar_extracto($1) r`, [extracto('a2', [...dia2, { fecha: '2026-11-25', descripcion: 'IMP LEY 25413 S/DEB', importe: -6, saldo: 844 }])])).r
check('archivo superpuesto: solo entra lo nuevo', r.nuevos === 1, JSON.stringify(r))
check('saldo de cierre por día = el del último movimiento', n((await val(`select saldo from saldos_bancarios where cuenta_origen_id = $1 and fecha = '2026-11-24'`, [ca])).saldo) === 850)

const cat = async (desc) => val(`select categoria, destino_xubio, componente, estado from movimientos_bancarios where descripcion = $1 limit 1`, [desc])
check('Ley 25413 → impuesto al asiento', JSON.stringify(await cat('IMP LEY 25413 S/DEB')) === JSON.stringify({ categoria: 'IMPUESTO', destino_xubio: 'ASIENTO', componente: null, estado: 'PENDIENTE' }))
check('comisión → neto del comprobante', (await cat('COMISION MANTENIMIENTO CUENTA')).componente === 'NETO')
check('percepción IVA gana a "IVA" por orden', (await cat('PERCEPCION IVA RG 2408')).componente === 'PERCEPCION_IVA')
check('IVA → IVA del comprobante', (await cat('I.V.A. BASE')).componente === 'IVA')
check('SIRCREB → dentro del comprobante (19/11)', (await cat('SIRCREB RETENCION')).componente === 'PERCEPCION_IIBB')
check('sin regla → A_REVISAR', (await cat('MOVIMIENTO RARO SIN REGLA')).estado === 'A_REVISAR')

// ---------------------------------------------------------------- Conciliación
const conc = async (cuenta, fecha) => val(`select * from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = $2`, [cuenta, fecha])
let c = await conc(ca, '2026-11-24')
check('conciliación 24/11: 1000 − 150 = 850 → OK', c.estado === 'OK' && n(c.saldo_calculado) === 850 && n(c.diferencia) === 0, `${c.saldo_anterior} ${c.debitos} ${c.saldo_extracto}`)
c = await conc(ca, '2026-11-23')
check('primer saldo de la cuenta → PRIMER_SALDO', c.estado === 'PRIMER_SALDO')
await db.query(`update saldos_bancarios set saldo = 840 where cuenta_origen_id = $1 and fecha = '2026-11-25'`, [ca])
c = await conc(ca, '2026-11-25')
check('saldo del banco 840 contra 844 calculado → DIFERENCIA −4', c.estado === 'DIFERENCIA' && n(c.diferencia) === -4)
await db.query(`update saldos_bancarios set saldo = 844 where cuenta_origen_id = $1 and fecha = '2026-11-25'`, [ca])

// Xubio contra banco
await db.query(`select registrar_lectura_xubio('india', 'Banco Hipotecario CA', '2026-11-24', 845, 'servidor')`)
c = await conc(ca, '2026-11-24')
check('lectura de Xubio: se asocia a la cuenta y muestra la diferencia (850 − 845 = 5)', n(c.saldo_xubio) === 845 && n(c.diferencia_xubio) === 5)

// ---------------------------------------------------------------- FCI: el rendimiento sale de la tenencia (caso India 25/11)
await como('teso@prueba.com')
await db.query(`select registrar_saldo($1, '2026-11-24', 7902.63)`, [fci])
await db.query(`select registrar_saldo($1, '2026-11-25', 7907.01)`, [fci])
c = await conc(fci, '2026-11-25')
check('FCI: 7.907,01 − 7.902,63 = rendimiento 4,38 (estado OK)', n(c.rendimiento) === 4.38 && c.estado === 'OK', JSON.stringify({ r: c.rendimiento, e: c.estado }))
let l = await val(`select importe, fila, naturaleza from flujo_lineas where origen_tipo = 'RENDIMIENTO' and origen_id = $1 and fecha = '2026-11-25'`, [fci])
check('el rendimiento entra solo al Flujo, real, en "Rendimientos FCI"', l && n(l.importe) === 4.38 && l.fila === 'Rendimientos FCI' && l.naturaleza === 'REAL')

// Suscripción desde la CA al FCI: no cambia la caja total y el FCI no la cuenta como rendimiento
await servidor()
await db.query(`select importar_extracto($1)`, [extracto('a3', [{ fecha: '2026-11-26', descripcion: 'SUSCRIPCION FCI TORONTO', importe: -500, saldo: 344 }])])
await db.query(`update movimientos_bancarios set contraparte_cuenta_id = $1 where descripcion = 'SUSCRIPCION FCI TORONTO'`, [fci])
await como('teso@prueba.com')
await db.query(`select registrar_saldo($1, '2026-11-26', 8407.50)`, [fci])
c = await conc(fci, '2026-11-26')
check('FCI con suscripción de 500: rendimiento = 8.407,50 − 7.907,01 − 500 = 0,49', n(c.rendimiento) === 0.49, c.rendimiento)
const neto = await val(`select sum(importe) s from flujo_lineas where origen_tipo = 'MOVIMIENTO' and concepto = 'SUSCRIPCION FCI TORONTO'`)
check('la suscripción suma cero en el Flujo (las dos patas)', n(neto.s) === 0)

// ---------------------------------------------------------------- Sin movimientos
await falla('Mercado Pago rinde todos los días: "Sin movimientos" pide confirmación', `select marcar_sin_movimientos($1, '2026-11-25')`, [mp], /rinde todos los días/)
await falla('sin saldo anterior no se inventa', `select marcar_sin_movimientos($1, '2026-11-25', true)`, [mp], /No hay un saldo anterior/)
await db.query(`select registrar_saldo($1, '2026-11-24', 282802.87, 'MANUAL')`, [mp])
check('confirmado: repite el saldo anterior (282.802,87)', n((await val(`select marcar_sin_movimientos($1, '2026-11-25', true) s`, [mp])).s) === 282802.87)
await falla('un día con movimientos no se marca sin movimientos', `select marcar_sin_movimientos($1, '2026-11-24')`, [ca], /tiene movimientos/)

// ---------------------------------------------------------------- Comprobante "Extracto Bancario" (caso ICBC/Chubut)
const fid = (await val(`select generar_comprobante_gastos($1, '2026-11-24') id`, [ca])).id
let f = await val(`select f.*, p.cuit from facturas f join proveedores p on p.id = f.proveedor_id where f.id = $1`, [fid])
check('comprobante: neto 100 + IVA 21 + percepciones 7 = 128', n(f.neto) === 100 && n(f.iva) === 21 && n(f.percepciones) === 7 && n(f.total) === 128, `${f.neto} ${f.iva} ${f.percepciones}`)
check('comprobante: 09990-20261124 del banco (por CUIT), nace pagado', f.punto_venta === 9990 && f.numero === 20261124 && f.cuit === '30500011072' && n(f.pagado) === 128)
check('regenerar el mismo día no duplica', (await val(`select generar_comprobante_gastos($1, '2026-11-24') = $2 x`, [ca, fid])).x)
await como('admin@prueba.com')
await db.query(`select aprobar_factura($1, 'GASTOS BANCARIOS', 'DEBITO')`, [fid])
check('aprobado: queda PAGADA, no "para pagar"', (await val(`select estado from facturas where id = $1`, [fid])).estado === 'PAGADA')
check('el comprobante no se proyecta como deuda en el Flujo', (await val(`select count(*)::int n from flujo_lineas where origen_id = $1`, [fid])).n === 0)
await servidor()
await db.query(`update facturas set estado_xubio = 'SUBIDA', xubio_id = 'X1' where id = $1`, [fid])
await como('teso@prueba.com')
await falla('subido a Xubio, no se regenera', `select generar_comprobante_gastos($1, '2026-11-24')`, [ca], /ya está en Xubio/)

// ---------------------------------------------------------------- Asiento del día
await servidor()
await db.query(`update movimientos_bancarios set cuenta_contable = null where cuenta_origen_id = $1 and fecha = '2026-11-24' and orden = 1 and destino_xubio = 'ASIENTO'`, [ca])
await como('teso@prueba.com')
await falla('asiento con movimientos sin cuenta: pide clasificarlos', `select generar_asiento_bancario($1, '2026-11-24')`, [ca], /sin cuenta contable/)
await servidor()
await db.query(`update movimientos_bancarios set cuenta_contable = 'IMPUESTO DEB/CRED BANCARIO' where cuenta_origen_id = $1 and fecha = '2026-11-24' and destino_xubio = 'ASIENTO'`, [ca])
const a24 = (await val(`select generar_asiento_bancario($1, '2026-11-24') id`, [ca])).id
check('asiento 24/11: los dos impuestos iguales netos en una línea de 12', n((await val(`select debe from asiento_lineas where asiento_id = $1 and debe > 0`, [a24])).debe) === 12)
await como('teso@prueba.com')
const aid = (await val(`select generar_asiento_bancario($1, '2026-11-25') id`, [ca])).id
const ls = await filas(`select cuenta_contable, debe::float, haber::float from asiento_lineas where asiento_id = $1 order by debe desc`, [aid])
check('asiento 25/11: Imp. deb/cred 6 al debe, banco 6 al haber', ls.length === 2 && ls[0].debe === 6 && ls[1].haber === 6 && ls[1].cuenta_contable === 'Banco Hipotecario CA', JSON.stringify(ls))
await servidor()
await falla('un asiento que no balancea se rechaza', `insert into asiento_lineas (asiento_id, cuenta_contable, debe) values ($1, 'X', 1)`, [aid], /no balancea/)
await db.query(`select resultado_asiento_xubio($1, true, 'AS-1', null)`, [aid])
check('asiento subido: sus movimientos quedan CONTABILIZADOS', (await val(`select count(*)::int n from movimientos_bancarios where asiento_id = $1 and estado = 'CONTABILIZADO'`, [aid])).n === 1)
await falla('un movimiento contabilizado no cambia de importe', `update movimientos_bancarios set importe = -7 where asiento_id = $1`, [aid], /ya está contabilizado/)
await como('admin@prueba.com')
await db.query(`select anular_asiento($1, 'prueba')`, [aid])
check('anular un asiento subido lo deja pendiente de anular en Xubio (25/11)', (await val(`select anulacion_xubio from asientos where id = $1`, [aid])).anulacion_xubio === 'PENDIENTE')

// ---------------------------------------------------------------- Cheques
await como('teso@prueba.com')
const chq = (await val(`select emitir_cheque($1) id`, [{ empresa_id: 'india', cuenta_origen_id: ca, tipo: 'ECHEQ', numero: '13506485',
  beneficiario: 'COOPERATIVA UNICRED', importe: 768767.13, fecha_emision: '2026-11-20', fecha_pago: '2026-12-10', origen: 'FINANCIERA' }])).id
l = await val(`select naturaleza, fecha, importe from flujo_lineas where origen_tipo = 'CHEQUE' and origen_id = $1`, [chq])
check('cheque emitido: proyectado en su fecha de pago', l.naturaleza === 'PROYECTADO' && l.fecha.toISOString().startsWith('2026-12-10') && n(l.importe) === -768767.13)
await falla('cheque repetido (misma chequera y número) se rechaza', `select emitir_cheque($1)`, [{ empresa_id: 'india', cuenta_origen_id: ca, tipo: 'ECHEQ', numero: '13506485',
  beneficiario: 'X', importe: 1, fecha_emision: '2026-11-20', fecha_pago: '2026-12-10' }], /unique|duplicate|duplicad/i)
await falla('marcar debitado con otro número no marca nada', `select marcar_cheque_debitado($1, '13506490', '2026-12-10')`, [chq], /no coincide/)
await db.query(`select marcar_cheque_debitado($1, '13506485', '2026-12-10')`, [chq])
l = await val(`select naturaleza from flujo_lineas where origen_tipo = 'CHEQUE' and origen_id = $1`, [chq])
check('debitado: pasa a real en la fecha del débito', l.naturaleza === 'REAL')
await falla('un cheque debitado no se anula', `select anular_cheque($1, 'x')`, [chq], /ya se debitó/)

// ---------------------------------------------------------------- Facturas: anticipo % + cuenta corriente
await servidor()
const hoy = (await val(`select current_date d`)).d
const vto = new Date(hoy.getTime() + 20 * 86400000).toISOString().slice(0, 10)
const fac = (await val(`select ingresar_factura($1) id`, [{ empresa_id: 'india', proveedor: 'Proveedor Prueba', cuit_proveedor: '30-71111111-1',
  tipo: 'Factura A', letra: 'A', punto_venta: 1, numero: 77, fecha: hoy.toISOString().slice(0, 10), vencimiento: vto, neto: 826.45, iva: 173.55,
  total: 1000, estado: 'PENDIENTE_APROBACION', validacion_ok: true }])).id
await como('admin@prueba.com')
await db.query(`select aprobar_factura($1, 'PROVEEDORES LOCALES', 'TRANSFERENCIA')`, [fac])
await como('teso@prueba.com')
await db.query(`select definir_pago_factura($1, 'ANTICIPO_PARCIAL', 30)`, [fac])
let tr = await filas(`select ocurrencia, fecha, importe::float from flujo_lineas where origen_id = $1 order by ocurrencia`, [fac])
const manana = (await val(`select dia_habil_desde(current_date + 1) d`)).d
check('anticipo 30 %: 300 el próximo día hábil y 700 al vencimiento',
  tr.length === 2 && tr[0].ocurrencia === 'ANTICIPO' && tr[0].importe === -300 && +tr[0].fecha === +manana && tr[1].importe === -700 && tr[1].fecha.toISOString().startsWith(vto), JSON.stringify(tr))
await falla('el % va solo con anticipo parcial', `select definir_pago_factura($1, 'CUENTA_CORRIENTE', 30)`, [fac], /porcentaje/)

// ---------------------------------------------------------------- Ajustes: mover, editar, eliminar (lo de hoy con los PFP)
const fechaMover = new Date(hoy.getTime() + 30 * 86400000).toISOString().slice(0, 10)
await db.query(`select ajustar_linea_flujo('FACTURA', $1, 'SALDO', $2, null, false, 'Lo pagamos a fin de mes')`, [fac, fechaMover])
check('mover el saldo de una factura cambia su fecha de pago (no el vencimiento)',
  (await val(`select fecha_pago::text = $2 and vencimiento::text = $3 x from facturas where id = $1`, [fac, fechaMover, vto])).x)
await db.query(`select ajustar_linea_flujo('FACTURA', $1, 'ANTICIPO', null, 250, false, 'Acordamos 250')`, [fac])
check('editar el anticipo: 250', n((await val(`select importe from flujo_lineas where origen_id = $1 and ocurrencia = 'ANTICIPO'`, [fac])).importe) === -250)
await db.query(`select restaurar_linea_flujo('FACTURA', $1, 'ANTICIPO')`, [fac])
check('restaurar: vuelve a 300', n((await val(`select importe from flujo_lineas where origen_id = $1 and ocurrencia = 'ANTICIPO'`, [fac])).importe) === -300)

const fila = (await val(`select id from flujo_filas where unidad_id = $1 and seccion = 'SIN_CLASIFICAR'`, [unidadIndia])).id
const inicio = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1).toISOString().slice(0, 10)
const pfp = (await val(`select crear_proyeccion($1) id`, [{ empresa_id: 'india', unidad_id: unidadIndia, fila_id: fila, concepto: 'PFP V116427 (ficticio)',
  importe: -682187, fecha_inicio: inicio, recurrencia: 'MENSUAL', dia_mes: 16, cuotas: 3, origen: 'PLAN_PAGO' }])).id
let occ = await filas(`select ocurrencia, fecha, importe::float from flujo_lineas where origen_id = $1 order by fecha`, [pfp])
check('plan de pago mensual en 3 cuotas: 3 líneas de −682.187, en día hábil', occ.length === 3 && occ.every((o) => o.importe === -682187 && o.fecha.getUTCDay() % 6 !== 0), JSON.stringify(occ.map((o) => o.fecha)))
await db.query(`select ajustar_linea_flujo('PROYECCION', $1, $2, null, null, true, 'Plan cancelado')`, [pfp, occ[0].ocurrencia])
check('eliminar una cuota: quedan 2', (await val(`select count(*)::int n from flujo_lineas where origen_id = $1`, [pfp])).n === 2)
await db.query(`select cancelar_proyeccion($1, 'Plan caduco')`, [pfp])
check('cancelar el plan: no queda ninguna', (await val(`select count(*)::int n from flujo_lineas where origen_id = $1`, [pfp])).n === 0)
await falla('lo real no se edita (pago o débito)', `select ajustar_linea_flujo('PAGO', gen_random_uuid(), 'PAGO', null, 1, false, 'x')`, [], /real/)
await falla('un cheque debitado ya no es proyectado', `select ajustar_linea_flujo('CHEQUE', $1, 'CHEQUE', null, 1, false, 'x')`, [chq], /ya no está proyectada/)
await falla('ajuste sin motivo se rechaza', `select ajustar_linea_flujo('FACTURA', $1, 'SALDO', null, 1, false, '')`, [fac], /motivo/)
await como('dir@prueba.com')
await falla('Dirección ve pero no ajusta el Flujo', `select ajustar_linea_flujo('FACTURA', $1, 'SALDO', null, 1, false, 'x')`, [fac], /rol/)

// ---------------------------------------------------------------- Control del Flujo contra bancos
// Unidad de India con tres cuentas que exigen extracto; el FCI se vio arriba. Día 25: CA 844, FCI 7.907,01, MP 282.802,87.
// Día 26: CA 344 (−500 suscripción), FCI 8.407,50 (+500 + 0,49), MP 282.802,87 (sin mov., confirmado).
await como('teso@prueba.com')
await db.query(`select marcar_sin_movimientos($1, '2026-11-26', true)`, [mp])
const ctrl = await val(`select * from flujo_control where unidad_id = $1 and fecha = '2026-11-26'`, [unidadIndia])
check('control 26/11: el cambio en bancos (0,49) = lo real del día → OK', ctrl && ctrl.estado === 'OK', JSON.stringify(ctrl && { d: ctrl.diferencia, r: ctrl.real_del_periodo, e: ctrl.estado }))
await servidor()
await db.query(`update saldos_bancarios set saldo = 340 where cuenta_origen_id = $1 and fecha = '2026-11-26'`, [ca])
check('si el banco dice 4 menos y el Flujo no lo tiene → F', (await val(`select estado from flujo_control where unidad_id = $1 and fecha = '2026-11-26'`, [unidadIndia])).estado === 'F')
await db.query(`update saldos_bancarios set saldo = 344 where cuenta_origen_id = $1 and fecha = '2026-11-26'`, [ca])

// ---------------------------------------------------------------- Control diario
const ctl = await filas(`select control, sujeto from control_bancos where empresa_id = 'india'`)
check('control diario: lista el movimiento a revisar', ctl.some((x) => x.control === 'A_REVISAR'))
check('control diario: lista la anulación pendiente en Xubio', ctl.some((x) => x.control === 'ANULAR_EN_XUBIO'))

// ---------------------------------------------------------------- Bloqueos
check('bloqueo: el primero lo toma', (await val(`select tomar_bloqueo('extracto:india', 'a') x`)).x)
check('bloqueo: el segundo no', !(await val(`select tomar_bloqueo('extracto:india', 'b') x`)).x)
await db.query(`select soltar_bloqueo('extracto:india', 'a')`)
check('bloqueo: soltado, lo toma el otro', (await val(`select tomar_bloqueo('extracto:india', 'b') x`)).x)

// ---------------------------------------------------------------- Seguridad
await como('solober@prueba.com')
check('quien ve solo Beratung no ve movimientos de India', (await val(`select count(*)::int n from movimientos_bancarios`)).n === 0)
check('… ni su Flujo', (await val(`select count(*)::int n from flujo_lineas`)).n === 0)
check('… ni su conciliación', (await val(`select count(*)::int n from conciliacion_bancaria`)).n === 0)
await falla('… ni puede marcar "Sin movimientos" en India', `select marcar_sin_movimientos($1, '2026-11-27', true)`, [mp], /acceso/)
await servidor()
for (const t of ['saldos_bancarios', 'movimientos_bancarios', 'cheques', 'proyecciones', 'flujo_ajustes', 'flujo_lineas', 'conciliacion_bancaria', 'bloqueos'])
  check(`anon no lee ${t}`, !(await val(`select has_table_privilege('anon', $1, 'select') p`, [t])).p)
for (const t of ['saldos_bancarios', 'cheques', 'proyecciones', 'flujo_ajustes'])
  check(`authenticated no escribe directo en ${t}`, !(await val(`select has_table_privilege('authenticated', $1, 'insert') p`, [t])).p)
check('authenticated no puede importar extractos (solo el servidor)', !(await val(`select has_function_privilege('authenticated', 'importar_extracto(jsonb)', 'execute') p`)).p)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
