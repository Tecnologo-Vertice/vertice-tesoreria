// Pruebas de 0041: pagos contra proyecciones del Flujo, fecha de pago al aprobar, cuentas propias y extracto repetido (27/11/2026).
//   [1-3] Pago manual o sin factura asociado a una proyección: el descuento espera a que el pago cuente en el Flujo (cargado →
//         contabilizado), caja descuenta ya, anulación por delta, tope, otra empresa, 30 días, ingresos.
//   [4]   "Esta y las siguientes" (cambiar_proyeccion) arrastra los pagos.
//   [5]   Fecha de pago obligatoria al aprobar (no pasada, tope de un año, cheque y tarjeta exentos), vencimiento original una sola vez,
//         firmas viejas de 4 argumentos cerradas.
//   [6]   CUIT propios (toda la organización): solo transferencias, después de conciliar, sin el fondo de la cuenta madre.
//   [7-8] El mismo extracto en otra empresa (archivo o contenido), confirmación y borrar_extracto.
//   [9]   Control de caja contra el Flujo: ya estaba (control_bancos, FLUJO_F de 0031).
//   + permisos, re-ejecución y que el Flujo existente no cambie.
// Datos ficticios. Las fechas salen siempre de hoy_ar(), nunca de current_date.
// Uso (desde demo/): node supabase/pruebas/probar_0041.mjs supabase/migrations
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
const comoServidor = async (fn) => { const antes = actual; await servidor(); try { return await fn() } finally { if (antes) await como(antes) } }
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
// Todas las migraciones menos la 0041: con ellas se arma el Flujo "de antes" para comparar.
for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql') && !x.startsWith('0041')).sort()) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(sqlDe(f)) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
check('migraciones anteriores a 0041 aplican', true)

// ---------------------------------------------------------------- Datos ficticios
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('aprob@prueba.com', 'Aprob', 'APROBADOR', true),
    ('dir@prueba.com', 'Dirección', 'DIRECCION', true), ('admin@prueba.com', 'Admin', 'ADMIN', true),
    ('soloind@prueba.com', 'Solo India', 'TESORERIA', false), ('solober@prueba.com', 'Solo Beratung', 'TESORERIA', false);
  insert into usuarios_empresas (email, empresa_id) values ('soloind@prueba.com', 'india'), ('solober@prueba.com', 'beratung');
`)
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const uBer = (await val(`select id from unidades where empresa_id = 'beratung' and por_defecto`)).id
const fila = async (unidad, etiqueta, seccion, cuenta, orden = 500) => (await val(
  `insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable) values ($1, 'x', $2, 'CUENTA', $3, $4, $5) returning id`,
  [unidad, orden, seccion, etiqueta, cuenta])).id
const fAlq = await fila(uIndia, 'Alquiler', 'GASTOS_OPERATIVOS', 'ALQUILER DE OFICINA', 320)
const fCobr = await fila(uIndia, 'Cobranzas', 'INGRESOS_OPERATIVOS', 'DEUDORES POR VENTAS', 110)
const fBer = await fila(uBer, 'Alquiler', 'GASTOS_OPERATIVOS', 'ALQUILER DE OFICINA', 320)
await db.query(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id) values ('india', 'BANCO PRUEBA', 'BANCOPRUEBA', 'CC', $1)`, [uIndia])
const prov = (await val(`insert into proveedores (cuit, nombre) values ('30710000001', 'Proveedor Uno SA') returning id`)).id
const alServidor = (fn) => async (...a) => comoServidor(() => fn(...a))
let nro = 700
const factura = alServidor(async (empresa, total, extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable)
   values ($1, $2, $3, 'A', 1, $4, $5, $6, $7, $7, 'PENDIENTE_APROBACION', 0, 'PROVEEDORES LOCALES') returning id`,
  [empresa, prov, extra.tipo ?? 'Factura A', nro++, dia(-10), extra.vence ?? dia(10), total])).id)
const fac = async (id) => val(`select estado::text, fecha_pago::text, vencimiento::text, vencimiento_factura::text from facturas where id = $1`, [id])
const crear = async (extra) => (await val(`select crear_proyeccion($1) id`, [{
  empresa_id: 'india', unidad_id: uIndia, fila_id: fAlq, concepto: 'Alquiler', importe: -1000, fecha_inicio: dia(5), recurrencia: 'UNICA', ...extra }])).id
const lineasDe = (id) => filas(
  `select ocurrencia, importe::float as importe, ajustada from flujo_lineas_entre(hoy_ar(), hoy_ar() + 60, null, false) where origen_tipo = 'PROYECCION' and origen_id = $1 order by ocurrencia`, [id])
const proy = (id) => val(`select estado, nota from proyecciones where id = $1`, [id])
const pagoDe = (id) => val(`select * from pagos where id = $1`, [id])
const ajustesVigentes = async (id) => (await val(`select count(*)::int n from flujo_ajustes where origen_tipo = 'PROYECCION' and origen_id = $1 and reemplazado_en is null`, [id])).n
const registrar = async (extra) => (await val(`select registrar_pago($1) id`, [{
  empresa_id: 'india', fecha: hoy, importe: 1000, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA', forma_carga_xubio: 'SALIDA_FONDOS', ...extra }])).id
const pagoSF = alServidor(async (empresa, importe, gestion = 'SISTEMA', medio = 'TRANSFERENCIA') => (await val(
  `insert into pagos (empresa_id, fecha, importe, medio, cargado_por, forma_carga_xubio, estado, gestion)
   values ($1, $2, $3, $5, 'teso@prueba.com', 'ORDEN_PAGO', 'CARGADO', $4) returning id`, [empresa, hoy, importe, gestion, medio])).id)

// ---------------------------------------------------------------- El Flujo de antes de 0041 (para comparar)
await como('teso@prueba.com')
await crear({ concepto: 'Alquiler base', importe: -700, fecha_inicio: dia(12) })
await crear({ concepto: 'Cobro base', fila_id: fCobr, importe: 900, fecha_inicio: dia(9) })
await comoServidor(async () => {
  await db.query(`insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable, origen)
    values ('india', $1, 'Factura A', 'A', 7, 1001, $2, $3, 5000, 5000, 'PARA_PAGAR', 0, 'PROVEEDORES', 'MANUAL')`, [prov, dia(-20), dia(10)])
})
const lineasFlujo = async () => val(
  `select count(*)::int n, md5(coalesce(string_agg(t::text, E'\n' order by t::text), '')) h,
          count(*) filter (where naturaleza = 'PROYECTADO')::int p, count(*) filter (where naturaleza = 'REAL')::int r
   from flujo_lineas_entre(hoy_ar() - 45, hoy_ar() + 200, null, false) t`)
await servidor()
const antes = await lineasFlujo()
check('hay un Flujo de antes con líneas proyectadas', antes.p >= 3, JSON.stringify(antes))
const defAntes = (await val(`select md5(pg_get_functiondef('flujo_lineas_entre(date,date,uuid,boolean)'::regprocedure)) h`)).h

// ---------------------------------------------------------------- Se aplica 0041 (y de nuevo: re-ejecutable)
const f41 = readdirSync(dir).find((x) => x.startsWith('0041'))
check('existe 0041_pagos_proyeccion_y_fecha.sql', f41 === '0041_pagos_proyeccion_y_fecha.sql', f41)
try { await db.exec(sqlDe(f41)); check('0041 aplica', true) } catch (e) { check('0041 aplica', false, e.message); process.exit(1) }
try { await db.exec(sqlDe(f41)); check('0041 se puede ejecutar dos veces', true) } catch (e) { check('0041 se puede ejecutar dos veces', false, e.message) }
check('re-ejecutada no duplica los CUIT propios (3 de la lista)', (await val(`select count(*)::int n from cuits_propios`)).n === 3)
check('0041 no cambia flujo_lineas_entre (misma definición)', (await val(`select md5(pg_get_functiondef('flujo_lineas_entre(date,date,uuid,boolean)'::regprocedure)) h`)).h === defAntes)
const despues = await lineasFlujo()
check('el Flujo existente no cambia con 0041 (mismas líneas, mismo contenido)', despues.h === antes.h && despues.n === antes.n && despues.p === antes.p && despues.r === antes.r,
  JSON.stringify({ antes, despues }))

// ================================================================ 1. Pago contra una proyección
await como('teso@prueba.com')
const pU = await crear({ concepto: 'Alquiler oficina', importe: -1000, fecha_inicio: dia(5) })           // puntual
const pRec = await crear({ concepto: 'Servicio semanal', importe: -200, fecha_inicio: dia(2), recurrencia: 'SEMANAL', cuotas: 3 })
const pLejos = await crear({ concepto: 'Lejana', importe: -500, fecha_inicio: dia(40) })
const pIng = await crear({ concepto: 'Cobro esperado', fila_id: fCobr, importe: 800, fecha_inicio: dia(6) })
const pBer = await crear({ empresa_id: 'beratung', unidad_id: uBer, fila_id: fBer, concepto: 'Alquiler Beratung', importe: -300, fecha_inicio: dia(3) })
const lista = async (empresa = 'india') => filas(`select proyeccion_id, ocurrencia::text, fecha::text as fecha, importe::float, concepto from proyecciones_para_pago($1)`, [empresa])
// El recorrido real de un pago: cargado → contabilizado en Xubio (lo hace la función de Netlify con marcar_pago_contabilizado).
let nx = 0
const contabilizar = (id) => comoServidor(() => db.query(`select marcar_pago_contabilizado($1, 'GASTOS', 'SALIDA_FONDOS', $2, 'sistema', 'ADMIN')`, [id, `OP-${++nx}`]))
const aplicada = async (id) => (await pagoDe(id)).proyeccion_aplicada

let l = await lista()
check('[1] la lista trae solo egresos de hoy a 30 días de la empresa (la puntual, la de base y las 3 de la semanal)',
  l.length === 5 && l.filter((x) => x.proyeccion_id === pU).length === 1 && l.filter((x) => x.proyeccion_id === pRec).length === 3, JSON.stringify(l))
check('[1] no trae la de más de 30 días, ni el ingreso, ni la de otra empresa', !l.some((x) => [pLejos, pIng, pBer].includes(x.proyeccion_id)))
check('[1] … y la lista está ordenada por fecha', l.every((x, i) => i === 0 || l[i - 1].fecha <= x.fecha))
// Una ocurrencia que el Flujo adelantó de más de 30 días a menos: sí aparece (la fecha que cuenta es la efectiva).
const pMov = await crear({ concepto: 'Adelantada', importe: -111, fecha_inicio: dia(50) })
await db.query(`select ajustar_linea_flujo('PROYECCION', $1, $2, $3, null, false, 'adelanto')`, [pMov, dia(50), dia(12)])
check('[1] una ocurrencia del día +50 adelantada al +12 aparece en la lista (fecha efectiva)', (await lista()).some((x) => x.proyeccion_id === pMov))
await como('aprob@prueba.com')
await falla('[1] un aprobador no pide la lista', `select * from proyecciones_para_pago('india')`, [], /rol/)
await como('solober@prueba.com')
await falla('[1] quien no ve la empresa no pide su lista', `select * from proyecciones_para_pago('india')`, [], /acceso a la empresa/)
await comoAnon()
await falla('[1] anon no pide la lista', `select * from proyecciones_para_pago('india')`, [], /permission denied/)
await como('teso@prueba.com')

// ---- Transferencia: el descuento espera a que el pago cuente en el Flujo
const pg1 = await registrar({ importe: 400, descripcion: 'Anticipo alquiler', proyeccion_id: pU, proyeccion_ocurrencia: dia(5) })
let x = await pagoDe(pg1)
check('[2] pago cargado (aún no en Xubio): queda la relación y el descuento esperando', x.proyeccion_id === pU && x.proyeccion_ocurrencia === dia(5) && x.proyeccion_aplicada === false && x.proyeccion_importe === null)
let ls = await lineasDe(pU)
check('[2] … y el Flujo sigue mostrando la proyección completa (-1000) sin ajustes', (await proy(pU)).estado === 'ACTIVA' && ls.length === 1 && ls[0].importe === -1000 && ls[0].ajustada === false, JSON.stringify(ls))
check('[2] el pago cargado todavía no cuenta como real en el Flujo', (await val(`select count(*)::int n from flujo_lineas_entre(hoy_ar() - 3, hoy_ar() + 60, null, false) where origen_tipo = 'PAGO' and origen_id = $1`, [pg1])).n === 0)
const pg1b = await registrar({ importe: 700, descripcion: 'Resto alquiler', proyeccion_id: pU, proyeccion_ocurrencia: dia(5) })
await falla('[2] lo ya reservado por pagos que esperan no se vuelve a ofrecer (400 + 700 cubren los 1.000)', `select registrar_pago($1)`, [{
  empresa_id: 'india', fecha: hoy, importe: 50, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA', proyeccion_id: pU, proyeccion_ocurrencia: dia(5) }], /ya está cubierta/)
await contabilizar(pg1)
x = await pagoDe(pg1)
ls = await lineasDe(pU)
check('[2] al contabilizar el pago: aplica el descuento (400) y en el Flujo queda el saldo (-600)', x.proyeccion_aplicada === true && Number(x.proyeccion_importe) === 400 && x.proyeccion_baja === false
  && (await proy(pU)).estado === 'ACTIVA' && ls.length === 1 && ls[0].importe === -600, JSON.stringify(ls))
const realPago = (await val(`select coalesce(sum(importe), 0)::float s from flujo_lineas_entre(hoy_ar() - 3, hoy_ar() + 60, null, false) where origen_tipo = 'PAGO' and origen_id = $1`, [pg1])).s
check('[2] el Flujo no cuenta doble: pago real (-400) + saldo de la proyección (-600) = lo proyectado (-1000)', realPago + ls[0].importe === -1000, `${realPago} ${ls[0].importe}`)
check('[2] la auditoría del pago y de la proyección', (await val(`select count(*)::int n from auditoria where (accion = 'PAGO_PROYECCION' and entidad_id = $1) or (accion = 'PROYECCION_DESCUENTO_POR_PAGO' and entidad_id = $2)`, [pg1, pU])).n === 2)
await contabilizar(pg1b)
x = await pagoDe(pg1b)
check('[2] el segundo (700) descuenta solo lo que queda (600) y da de baja: nunca más de lo que había', Number(x.proyeccion_importe) === 600 && x.proyeccion_baja === true)
check('[2] la proyección queda CANCELADA con el motivo "Pago <id>: baja de la proyección"', (await proy(pU)).estado === 'CANCELADA' && (await proy(pU)).nota.includes(`Pago ${pg1b}: baja de la proyección`))
check('[2] y la auditoría de la proyección lleva ese motivo', (await val(`select count(*)::int n from auditoria where accion = 'PROYECCION_BAJA_POR_PAGO' and entidad_id = $1 and detalle = $2`, [pU, `Pago ${pg1b}: baja de la proyección`])).n === 1)
check('[2] el Flujo ya no tiene la proyección y la lista tampoco', (await lineasDe(pU)).length === 0 && !(await lista()).some((r) => r.proyeccion_id === pU))
await falla('[2] no se puede asociar de nuevo a lo que ya no queda', `select registrar_pago($1)`, [{
  empresa_id: 'india', fecha: hoy, importe: 50, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA', proyeccion_id: pU, proyeccion_ocurrencia: dia(5) }], /ya no está activa/)
check('[2] … y ese pago rechazado no quedó cargado', (await val(`select count(*)::int n from pagos where importe = 50 and cargado_por = 'Teso'`)).n === 0)

// Un pago que se anula antes de contar no descontó nada
const pF = await crear({ concepto: 'Para anular antes', importe: -300, fecha_inicio: dia(8) })
const pgF = await registrar({ importe: 100, proyeccion_id: pF, proyeccion_ocurrencia: dia(8) })
await db.query(`select anular_pago($1, 'error de carga')`, [pgF])
check('[2] anular un pago que esperaba: la proyección sigue intacta y el pago no descuenta después', (await lineasDe(pF))[0].importe === -300 && (await ajustesVigentes(pF)) === 0 && (await aplicada(pgF)) === false)
await comoServidor(() => db.query(`update pagos set observaciones = 'toque' where id = $1`, [pgF]))
check('[2] … ni siquiera si se lo toca después (anulado no se aplica)', (await lineasDe(pF))[0].importe === -300)

// ---- Efectivo (caja): el descuento pesa en el momento
const pfl = (id) => comoServidor(async () => (await val(`select pago_cuenta_en_flujo(p) t from pagos p where id = $1`, [id])).t)
check('[2] pago_cuenta_en_flujo: caja y cheque cuentan desde el momento; una transferencia cargada, no',
  (await pfl(await pagoSF('india', 10, 'SISTEMA', 'CAJA'))) === true && (await pfl(await pagoSF('india', 10, 'SISTEMA', 'CHEQUE'))) === true && (await pfl(await pagoSF('india', 10))) === false)
const pD = await crear({ concepto: 'Gasto en efectivo', importe: -1000, fecha_inicio: dia(6) })
const pgA = await registrar({ importe: 400, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pD, proyeccion_ocurrencia: dia(6) })
ls = await lineasDe(pD)
check('[3] pago en efectivo: descuenta en el momento (400) y en el Flujo queda el saldo (-600)', (await aplicada(pgA)) === true && Number((await pagoDe(pgA)).proyeccion_importe) === 400 && ls.length === 1 && ls[0].importe === -600, JSON.stringify(ls))
const pgB = await registrar({ importe: 900, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pD, proyeccion_ocurrencia: dia(6) })
check('[3] A=400 y B=900: B descuenta 600 y da de baja', Number((await pagoDe(pgB)).proyeccion_importe) === 600 && (await proy(pD)).estado === 'CANCELADA')
await db.query(`select anular_pago($1, 'se cargó mal')`, [pgA])
ls = await lineasDe(pD)
check('[3] anular A (400) estando cerrada por B: se reabre con exactamente 400 (delta)', (await proy(pD)).estado === 'ACTIVA' && ls.length === 1 && ls[0].importe === -400, JSON.stringify(ls))
await db.query(`select anular_pago($1, 'también')`, [pgB])
ls = await lineasDe(pD)
check('[3] anular B: vuelve a -1000 y no queda ningún ajuste', ls.length === 1 && ls[0].importe === -1000 && ls[0].ajustada === false && (await ajustesVigentes(pD)) === 0, JSON.stringify(ls))
check('[3] la auditoría de la devolución', (await val(`select count(*)::int n from auditoria where accion = 'PROYECCION_DEVOLUCION' and entidad_id = $1`, [pD])).n === 2)
await falla('[3] un pago anulado no se asocia', `select asociar_pago_proyeccion($1, $2, $3)`, [pgA, pD, dia(6)], /anulado/)

// Más grande que el saldo, de una
const pgG = await registrar({ importe: 5000, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pD, proyeccion_ocurrencia: dia(6) })
check('[3] un pago de 5.000 contra una proyección de 1.000 descuenta 1.000, no 5.000', Number((await pagoDe(pgG)).proyeccion_importe) === 1000 && (await proy(pD)).estado === 'CANCELADA')
await db.query(`select anular_pago($1, 'x')`, [pgG])

// Un aumento a mano no se pierde al anular
const pE = await crear({ concepto: 'Con aumento', importe: -1000, fecha_inicio: dia(7) })
const pgE = await registrar({ importe: 300, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pE, proyeccion_ocurrencia: dia(7) })
await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 1500, null, 'sube el alquiler')`, [pE, dia(7)])
check('[3] el aumento a mano deja la línea en 1.500', (await lineasDe(pE))[0].importe === -1500)
await db.query(`select anular_pago($1, 'x')`, [pgE])
check('[3] anular el pago de 300 suma los 300 al importe de ahora (1.800): el aumento no se pierde', (await lineasDe(pE))[0].importe === -1800, JSON.stringify(await lineasDe(pE)))

// Una cancelada a mano: anular el pago la reabre con lo descontado
const pMano = await crear({ concepto: 'Para cancelar', importe: -400, fecha_inicio: dia(4) })
const pgM = await registrar({ importe: 100, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pMano, proyeccion_ocurrencia: dia(4) })
await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'BORRAR', null, null, 'ya no va')`, [pMano, dia(4)])
await db.query(`select anular_pago($1, 'no va')`, [pgM])
check('[3] cerrada por una persona: al anular el pago vuelve lo que ese pago había descontado (100)', (await proy(pMano)).estado === 'ACTIVA' && (await lineasDe(pMano))[0]?.importe === -100, JSON.stringify(await lineasDe(pMano)))

// Proyección que se repite: se ajusta solo la ocurrencia elegida
const pgR = await registrar({ importe: 50, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pRec, proyeccion_ocurrencia: dia(9) })
ls = await lineasDe(pRec)
check('[3] serie semanal: el pago descuenta solo la ocurrencia elegida (-150) y las otras siguen en -200',
  ls.length === 3 && ls.find((r) => r.ocurrencia === dia(9))?.importe === -150 && ls.filter((r) => r.importe === -200).length === 2, JSON.stringify(ls))
const pgR2 = await registrar({ importe: 200, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pRec, proyeccion_ocurrencia: dia(2) })
ls = await lineasDe(pRec)
check('[3] serie semanal: cubrir una ocurrencia entera la saca del Flujo y la serie sigue (2 líneas)', ls.length === 2 && !ls.some((r) => r.ocurrencia === dia(2)) && (await proy(pRec)).estado === 'ACTIVA', JSON.stringify(ls))
await db.query(`select anular_pago($1, 'x')`, [pgR2]); await db.query(`select anular_pago($1, 'x')`, [pgR])
ls = await lineasDe(pRec)
check('[3] anuladas las dos, la serie vuelve a sus 3 líneas de -200 sin ajustes', ls.length === 3 && ls.every((r) => r.importe === -200) && (await ajustesVigentes(pRec)) === 0, JSON.stringify(ls))

// ---- "Esta y las siguientes" arrastra el descuento de los pagos (cambiar_proyeccion)
const pS = await crear({ concepto: 'Serie que se mueve', importe: -200, fecha_inicio: dia(3), recurrencia: 'SEMANAL', cuotas: 4 })   // dia 3, 10, 17, 24
const pgS = await registrar({ importe: 50, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pS, proyeccion_ocurrencia: dia(10) })
check('[4] antes de mover: la ocurrencia del día 10 queda en -150', (await lineasDe(pS)).find((r) => r.ocurrencia === dia(10))?.importe === -150)
const pgS2 = await registrar({ importe: 20, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pS, proyeccion_ocurrencia: dia(17) })
await falla('[4] con pagos en ocurrencias posteriores no se cambia la fecha de "esta y las siguientes"', `select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'muevo')`, [pS, dia(10), dia(11)], /pagos asociados a ocurrencias posteriores/)
await db.query(`select anular_pago($1, 'x')`, [pgS2])
const nueva = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'muevo un día') id`, [pS, dia(10), dia(11)])).id
const lsN = await lineasDe(nueva)
check('[4] la serie nueva arranca en la fecha nueva con el descuento ya aplicado (-150, no -200): no hay doble conteo', lsN.length === 3 && lsN[0].ocurrencia === dia(11) && lsN[0].importe === -150 && lsN.slice(1).every((r) => r.importe === -200), JSON.stringify(lsN))
x = await pagoDe(pgS)
check('[4] el pago quedó apuntado a la ocurrencia nueva', x.proyeccion_id === nueva && x.proyeccion_ocurrencia === dia(11))
await db.query(`select anular_pago($1, 'x')`, [pgS])
check('[4] y al anularlo, el descuento vuelve a la serie nueva (-200)', (await lineasDe(nueva))[0].importe === -200 && (await ajustesVigentes(nueva)) === 0, JSON.stringify(await lineasDe(nueva)))
// Sin cambiar la fecha, los pagos de ocurrencias posteriores siguen a su serie
const pS2 = await crear({ concepto: 'Serie que sigue', importe: -200, fecha_inicio: dia(3), recurrencia: 'SEMANAL', cuotas: 4 })
const pgS3 = await registrar({ importe: 30, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: pS2, proyeccion_ocurrencia: dia(17) })
const nueva2 = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', 250, null, 'sube desde el 10') id`, [pS2, dia(10)])).id
const l2 = await lineasDe(nueva2)
check('[4] el pago de una ocurrencia posterior sigue a la serie nueva (sin doble conteo: 250 - 30 = 220)', (await pagoDe(pgS3)).proyeccion_id === nueva2 && l2.find((r) => r.ocurrencia === dia(17))?.importe === -220, JSON.stringify(l2))

// Rechazos
await falla('[1] de otra empresa', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proyeccion_id: pBer, proyeccion_ocurrencia: dia(3) }], /otra empresa/)
await falla('[1] a más de 30 días', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proyeccion_id: pLejos, proyeccion_ocurrencia: dia(40) }], /hoy a 30 días/)
await falla('[1] un ingreso no se asocia a un pago', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proyeccion_id: pIng, proyeccion_ocurrencia: dia(6) }], /egreso/)
await falla('[1] una ocurrencia que no existe', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proyeccion_id: pE, proyeccion_ocurrencia: dia(9) }], /no tiene una ocurrencia/)
await falla('[1] sin la fecha de la ocurrencia', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proyeccion_id: pE }], /Falta la fecha de la ocurrencia/)
const fPara = await comoServidor(async () => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable)
   values ('india', $1, 'Factura A', 'A', 1, 9999, $2, $3, 100, 100, 'PARA_PAGAR', 0, 'X') returning id`, [prov, dia(-1), dia(3)])).id)
await falla('[1] un pago con facturas no se asocia a una proyección', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proveedor_id: prov, factura_ids: [fPara], proyeccion_id: pE, proyeccion_ocurrencia: dia(7) }], /facturas vinculadas/)
await como('dir@prueba.com')
await falla('[1] Dirección no carga pagos', `select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X', proyeccion_id: pE, proyeccion_ocurrencia: dia(7) }], /rol/)
await como('soloind@prueba.com')
await falla('[1] quien no ve la empresa no asocia una proyección ajena', `select asociar_pago_proyeccion($1, $2, $3)`, [await pagoSF('beratung', 10), pBer, dia(3)], /acceso a la empresa/)
await como('teso@prueba.com')

// Un pago ya cargado: se asocia después; el de la hoja no
const pgSF = await pagoSF('india', 250)
const r1 = (await val(`select asociar_pago_proyeccion($1, $2, $3) r`, [pgSF, pE, dia(7)])).r
check('[1] asociar un pago ya cargado (transferencia): queda esperando, sin tocar el Flujo todavía', r1.pendiente === true && Number(r1.descontado) === 0, JSON.stringify(r1))
const pgSFc = await pagoSF('india', 250, 'SISTEMA', 'CAJA')
const r1c = (await val(`select asociar_pago_proyeccion($1, $2, $3) r`, [pgSFc, pE, dia(7)])).r
check('[1] asociar un pago de caja ya cargado: descuenta en el momento', r1c.pendiente === false && Number(r1c.descontado) === 250, JSON.stringify(r1c))
await falla('[1] el mismo pago no se asocia dos veces', `select asociar_pago_proyeccion($1, $2, $3)`, [pgSF, pE, dia(7)], /ya está asociado/)
const pgHoja = await pagoSF('india', 100, 'HOJA')
await falla('[1] un pago de la hoja del Apps Script se asocia en la hoja', `select asociar_pago_proyeccion($1, $2, $3)`, [pgHoja, pE, dia(7)], /hoja del Apps Script/)
check('[1] el pago de la hoja no tiene relación con ninguna proyección (el espejo no se toca)', (await pagoDe(pgHoja)).proyeccion_id === null)
await falla('[1] otra empresa por asociar_pago_proyeccion', `select asociar_pago_proyeccion($1, $2, $3)`, [await pagoSF('india', 10), pBer, dia(3)], /otra empresa/)

// ================================================================ 2. Fecha de pago al aprobar
await como('aprob@prueba.com')
const f1 = await factura('india', 1000, { vence: dia(15) })
await falla('[5] sin fecha de pago no se aprueba (transferencia)', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, null)`, [f1], /Falta la fecha de pago/)
await falla('[5] con fecha pasada tampoco', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [f1, dia(-1)], /anterior a hoy/)
await falla('[5] ni a más de un año', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [f1, dia(400)], /más de un año/)
check('[5] la factura quedó pendiente', (await fac(f1)).estado === 'PENDIENTE_APROBACION')
await db.query(`select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [f1, dia(20)])
let q = await fac(f1)
check('[5] aprobada con fecha: PARA_PAGAR, fecha de pago y vencimiento = la nueva, vencimiento_factura = el original', q.estado === 'PARA_PAGAR' && q.fecha_pago === dia(20) && q.vencimiento === dia(20) && q.vencimiento_factura === dia(15), JSON.stringify(q))
check('[5] la auditoría dice la fecha', (await val(`select count(*)::int n from auditoria where accion = 'APROBACION' and entidad_id = $1 and detalle like $2`, [f1, `%fecha de pago ${dia(20).slice(8, 10)}/${dia(20).slice(5, 7)}/${dia(20).slice(0, 4)}%`])).n === 1)
check('[5] el Flujo proyecta la factura en esa fecha', (await val(`select count(*)::int n from flujo_lineas_entre(hoy_ar(), hoy_ar() + 60, null, false) where origen_tipo = 'FACTURA' and origen_id = $1 and fecha >= $2::date`, [f1, dia(20)])).n === 1)
await comoServidor(() => db.query(`update facturas set estado = 'PENDIENTE_APROBACION' where id = $1`, [f1]))
await db.query(`select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [f1, dia(25)])
q = await fac(f1)
check('[5] una segunda aprobación no pisa el vencimiento original', q.vencimiento_factura === dia(15) && q.vencimiento === dia(25) && q.fecha_pago === dia(25), JSON.stringify(q))
const f2 = await factura('india', 500)
await db.query(`select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [f2, hoy])
check('[5] la fecha de hoy se acepta', (await fac(f2)).fecha_pago === hoy)
const f2b = await factura('india', 500)
await db.query(`select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [f2b, dia(365)])
check('[5] y la de dentro de un año justo también', (await fac(f2b)).fecha_pago === dia(365))
for (const medio of ['CHEQUE', 'ECHEQ']) {
  const fc = await factura('india', 800, { vence: dia(12) })
  await db.query(`select aprobar_factura($1, 'GASTOS', $2, 30, null)`, [fc, medio])
  q = await fac(fc)
  check(`[5] con ${medio} no se pide fecha y el vencimiento queda como estaba`, q.estado === 'PARA_PAGAR' && q.fecha_pago === null && q.vencimiento === dia(12) && q.vencimiento_factura === null, JSON.stringify(q))
}
const f3 = await factura('india', 300, { vence: dia(30) })
await db.query(`select aprobar_factura($1, 'GASTOS', 'TARJETA', null, null)`, [f3])
q = await fac(f3)
check('[5] la tarjeta no pide fecha: nace pagada hoy y no toca el vencimiento', q.estado === 'PAGADA' && q.fecha_pago === hoy && q.vencimiento === dia(30) && q.vencimiento_factura === null, JSON.stringify(q))
const f3b = await factura('india', 300, { vence: dia(30) })
await db.query(`select aprobar_factura($1, 'GASTOS', 'TARJETA', null, $2)`, [f3b, dia(60)])
q = await fac(f3b)
check('[5] … ni siquiera si le pasan una fecha (se ignora)', q.estado === 'PAGADA' && q.vencimiento === dia(30) && q.fecha_pago === hoy, JSON.stringify(q))
const nc = await factura('india', 300, { tipo: 'Nota de Crédito A' })
await db.query(`select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, null)`, [nc])
check('[5] una nota de crédito no pide fecha (no se paga)', (await fac(nc)).estado === 'PARA_PAGAR')
const f4 = await factura('india', 600)
await falla('[5] aprobar_factura_y_vincular también exige la fecha', `select aprobar_factura_y_vincular($1, 'GASTOS', 'TRANSFERENCIA', null, null)`, [f4], /Falta la fecha de pago/)
const rv = (await val(`select aprobar_factura_y_vincular($1, 'GASTOS', 'TRANSFERENCIA', null, $2) r`, [f4, dia(7)])).r
check('[5] aprobar_factura_y_vincular con fecha devuelve cómo quedó', rv.estado === 'PARA_PAGAR' && rv.fecha_pago === dia(7), JSON.stringify(rv))
// Las firmas viejas ya no se pueden llamar con una sesión
const f5 = await factura('india', 100)
await falla('[5] la firma vieja de 4 argumentos no la ejecuta una persona (sin fecha se saltearía la regla)', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA')`, [f5], /permission denied/)
await falla('[5] ni aprobar_factura_y_vincular de 4 argumentos', `select aprobar_factura_y_vincular($1, 'GASTOS', 'TRANSFERENCIA')`, [f5], /permission denied/)
check('[5] la factura no se aprobó por la puerta vieja', (await fac(f5)).estado === 'PENDIENTE_APROBACION')
await como('teso@prueba.com')
await falla('[5] Tesorería no aprueba', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [await factura('india', 10), dia(3)], /rol/)
await como('dir@prueba.com')
await falla('[5] Dirección tampoco', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, [await factura('india', 10), dia(3)], /rol/)
await comoAnon()
await falla('[5] anon no aprueba', `select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA', null, $2)`, ['00000000-0000-0000-0000-000000000000', dia(3)], /permission denied/)
await servidor()
check('[5] a un Xubio real viaja el vencimiento original: está guardado en vencimiento_factura', (await fac(f1)).vencimiento_factura === dia(15))

// ================================================================ 3. CUIT propios y cuentas propias
await servidor()
check('[6] los CUIT de Beratung, Vértice e India están en la lista de cuits propios', (await filas(`select empresa_id, cuit from cuits_propios order by empresa_id`)).map((r) => `${r.empresa_id}:${r.cuit}`).join(',')
  === 'beratung:33716515929,india:30718077180,vertice:30719561507')
const cuentaIndia = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, unidad_id, requiere_extracto) values ('india', 'BANCO PRUEBA CC INDIA', 'BANCOPRUEBA', 'CC', '30999999991', $1, true) returning id`, [uIndia])).id
const cuentaBer = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, unidad_id, requiere_extracto) values ('beratung', 'BANCO PRUEBA CC BER', 'BANCOPRUEBA', 'CC', '30999999991', $1, true) returning id`, [uBer])).id
const hipo = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, unidad_id, requiere_extracto) values ('india', 'HIPO CC INDIA', 'HIPO', 'CC', '30999999991', $1, true) returning id`, [uIndia])).id
const fci = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, unidad_id, cuenta_madre_id) values ('india', 'FCI HIPO UNICO', 'HIPO', 'FCI', '30999999991', $1, $2) returning id`, [uIndia, hipo])).id
const importar = (c, hash, movs, extra = {}) => comoServidor(async () => (await val(`select importar_extracto($1) r`, [{ cuenta_origen_id: c, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash }, movimientos: movs, ...extra }])).r)
const hab = (await filas(`select d::date::text f from generate_series(hoy_ar() - 45, hoy_ar() - 1, interval '1 day') d where es_dia_habil(d::date) order by d`)).map((r) => r.f)
const r3 = await importar(cuentaIndia, 'H41-A', [
  { fecha: hab[0], descripcion: 'TRANSF A CUENTA CUIT 30-71807718-0 INDIA ADV', importe: -5000, saldo: 95000 },
  { fecha: hab[1], descripcion: 'TRANSFERENCIA RECIBIDA 30718077180 TITULAR', importe: 8000, saldo: 103000 },
  { fecha: hab[2], descripcion: 'TRANSF A 33716515929 BERATUNG', importe: -700, saldo: 102300 },
  { fecha: hab[3], descripcion: 'PAGO A 33716515929 BERATUNG', importe: -300, saldo: 102000 },
  { fecha: hab[4], descripcion: 'PAGO PROVEEDOR 20111111112', importe: -10, saldo: 101990 },
  { fecha: hab[5], descripcion: 'COMPRA 3071807718099 REF', importe: -10, saldo: 101980 },
  { fecha: hab[6], descripcion: 'VEP AFIP TRANSF 30718077180 IVA', importe: -4000, saldo: 97980 },
  { fecha: hab[7], descripcion: 'PAGO IMPUESTOS TRANSFERENCIA CBU 30718077180', importe: -900, saldo: 97080 }])
const cat = async (desc) => val(`select categoria, estado, destino_xubio, propia_por_cuit from movimientos_bancarios where descripcion = $1`, [desc])
check('[6] el CUIT propio (con o sin guiones) en una transferencia la marca como entre cuentas propias', (await cat('TRANSF A CUENTA CUIT 30-71807718-0 INDIA ADV')).categoria === 'TRANSFERENCIA_PROPIA'
  && (await cat('TRANSFERENCIA RECIBIDA 30718077180 TITULAR')).categoria === 'TRANSFERENCIA_PROPIA')
check('[6] … queda PENDIENTE, sin destino en Xubio', (await cat('TRANSF A CUENTA CUIT 30-71807718-0 INDIA ADV')).estado === 'PENDIENTE' && (await cat('TRANSF A CUENTA CUIT 30-71807718-0 INDIA ADV')).destino_xubio === 'NINGUNO')
check('[6] los CUIT propios valen para toda la organización: el de Beratung visto desde India también es propio', (await cat('TRANSF A 33716515929 BERATUNG')).categoria === 'TRANSFERENCIA_PROPIA')
check('[6] sin palabra de transferencia no se reconoce (pago a un CUIT propio, compra, CUIT ajeno, 11 dígitos dentro de otro número)',
  (await cat('PAGO A 33716515929 BERATUNG')).categoria === 'SIN_CLASIFICAR' && (await cat('PAGO PROVEEDOR 20111111112')).categoria === 'SIN_CLASIFICAR' && (await cat('COMPRA 3071807718099 REF')).categoria === 'SIN_CLASIFICAR')
check('[6] un VEP/AFIP o un pago de impuestos con el CUIT de la empresa como contribuyente no es transferencia propia',
  (await cat('VEP AFIP TRANSF 30718077180 IVA')).categoria === 'IMPUESTO' && (await cat('PAGO IMPUESTOS TRANSFERENCIA CBU 30718077180')).categoria === 'SIN_CLASIFICAR')
check('[6] la importación informa cuántas reconoció y las que quedan por revisar', r3.cuentas_propias === 3 && r3.a_revisar === 4 && r3.nuevos === 8, JSON.stringify(r3))
// Un movimiento conciliado con un pago no se toca
const pgConc = await pagoSF('india', 1234.5)
const mConc = await comoServidor(async () => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, pago_id)
   values ('india', $1, $2, 'TRANSF PROVEEDOR CUIT 30718077180', -1234.5, 'H41-CONC', 'SIN_CLASIFICAR', 'A_REVISAR', $3) returning id`, [cuentaIndia, hab[8], pgConc])).id)
await como('teso@prueba.com')
await db.query(`select reconocer_cuentas_propias('india')`)
check('[6] un movimiento ya conciliado con un pago no se marca como transferencia propia', (await val(`select categoria from movimientos_bancarios where id = $1`, [mConc])).categoria === 'SIN_CLASIFICAR')
// A otro banco propio: no se le pone el fondo de la cuenta madre solo
await importar(hipo, 'H41-HIPO', [{ fecha: hab[9], descripcion: 'TRANSF A 30718077180 CUENTA GALICIA', importe: -7000, saldo: 1000 }])
const mH = await val(`select id, categoria, contraparte_cuenta_id, propia_por_cuit from movimientos_bancarios where descripcion = 'TRANSF A 30718077180 CUENTA GALICIA'`)
check('[6] una transferencia a otro banco propio queda propia pero SIN el fondo de la cuenta madre como contraparte', mH.categoria === 'TRANSFERENCIA_PROPIA' && mH.propia_por_cuit === true && mH.contraparte_cuenta_id === null, JSON.stringify(mH))
await comoServidor(() => db.query(`select conciliar_movimientos('india')`))
check('[6] … ni después de volver a conciliar', (await val(`select contraparte_cuenta_id from movimientos_bancarios where id = $1`, [mH.id])).contraparte_cuenta_id === null)
await db.query(`select asignar_contraparte($1, $2)`, [mH.id, fci])
check('[6] si Tesorería la asigna a mano al fondo, sí vale', (await val(`select contraparte_cuenta_id from movimientos_bancarios where id = $1`, [mH.id])).contraparte_cuenta_id === fci)
// Configurable por empresa, solo ADMIN
await como('teso@prueba.com')
await falla('[6] Tesorería no cambia los CUIT propios (solo ADMIN)', `select definir_cuit_propio('india', '20-12345678-6', 'Socio gerente', true)`, [], /rol/)
await como('admin@prueba.com')
await db.query(`select definir_cuit_propio('india', '20-12345678-6', 'Socio gerente', true)`)
await falla('[6] el CUIT tiene que tener 11 dígitos', `select definir_cuit_propio('india', '123')`, [], /11 dígitos/)
const mAdhoc = await comoServidor(async () => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado)
   values ('india', $1, $2, 'TRANSF 20123456786 SOCIO', -900, 'H41-ADHOC', 'SIN_CLASIFICAR', 'A_REVISAR') returning id`, [cuentaIndia, hab[10]])).id)
await como('teso@prueba.com')
check('[6] reconocer_cuentas_propias marca lo ya cargado con un CUIT agregado a mano', (await val(`select reconocer_cuentas_propias('india') n`)).n === 1
  && (await val(`select categoria from movimientos_bancarios where id = $1`, [mAdhoc])).categoria === 'TRANSFERENCIA_PROPIA')
check('[6] y repetirlo no hace nada más', (await val(`select reconocer_cuentas_propias('india') n`)).n === 0)
await como('solober@prueba.com')
await falla('[6] quien no ve la empresa no reconoce sus cuentas', `select reconocer_cuentas_propias('india')`, [], /acceso a la empresa/)
await como('soloind@prueba.com')
check('[6] quien ve India lee sus CUIT propios y no los de Beratung', (await filas(`select empresa_id from cuits_propios`)).every((r) => r.empresa_id === 'india') && (await filas(`select 1 from cuits_propios`)).length === 2)
await comoAnon()
await falla('[6] anon no lee los CUIT propios', `select * from cuits_propios`, [], /permission denied/)

// ================================================================ 4. El mismo extracto en la cuenta de otra empresa
await servidor()
const movs = [{ fecha: hab[11], descripcion: 'DEPOSITO UNICO 41', importe: 1234, saldo: 1234 }]
await importar(cuentaIndia, 'H41-B', movs)
const intentar = (c, hash, m, extra = {}) => comoServidor(() => error(`select importar_extracto($1)`, [{ cuenta_origen_id: c, usuario: 'x', archivo: { nombre: hash, hash }, movimientos: m, ...extra }]))
const eOtra = await intentar(cuentaBer, 'H41-B', movs)
check('[7] el mismo archivo en la cuenta de otra empresa se rechaza, con el aviso [OTRA_EMPRESA], y dice dónde está', eOtra !== null && /^\[OTRA_EMPRESA\] .*ya está cargado en la cuenta BANCO PRUEBA CC INDIA de India/.test(eOtra), eOtra ?? 'no falló')
check('[7] … y no dejó nada cargado en la otra empresa', (await val(`select count(*)::int n from extractos where empresa_id = 'beratung'`)).n === 0)
check('[7] repetirlo en la misma cuenta sigue devolviendo "repetido"', (await importar(cuentaIndia, 'H41-B', movs)).repetido === true)
const rOk = await importar(cuentaBer, 'H41-B', movs, { confirmar_otra_empresa: 'true' })
check('[7] con confirmación expresa se deja pasar', rOk.repetido === false && rOk.nuevos === 1, JSON.stringify(rOk))
// Mismo contenido con otros bytes (el banco lo bajó de nuevo)
const cuerpo = [4, 5, 6, 7].map((k) => ({ fecha: hab[k], descripcion: `MOV REPETIDO ${k}`, importe: 100 + k, saldo: 1000 + k }))
await importar(cuentaIndia, 'H41-D', cuerpo)
const eCont = await intentar(cuentaBer, 'H41-D-OTROS-BYTES', cuerpo)
check('[7] el mismo contenido con otra huella de archivo también se detecta (mayoría de movimientos iguales)', eCont !== null && /^\[OTRA_EMPRESA\] .*parece ya cargado.*4 de 4 movimientos iguales/.test(eCont), eCont ?? 'no falló')
const eMayoria = await intentar(cuentaBer, 'H41-D-MAYORIA', [...cuerpo.slice(0, 3), { fecha: hab[12], descripcion: 'OTRO MOV', importe: 7, saldo: 1 }])
check('[7] con 3 de 4 iguales también (más de la mitad)', eMayoria !== null && /parece ya cargado/.test(eMayoria), eMayoria ?? 'no falló')
check('[7] pocos movimientos en común no es el mismo extracto', (await intentar(cuentaBer, 'H41-D-POCOS', [cuerpo[0], { fecha: hab[13], descripcion: 'X1', importe: 1, saldo: 1 }, { fecha: hab[14], descripcion: 'X2', importe: 2, saldo: 2 }, { fecha: hab[15], descripcion: 'X3', importe: 3, saldo: 3 }])) === null)
const rC = await importar(cuentaBer, 'H41-D-OTROS-BYTES', cuerpo, { confirmar_otra_empresa: 'true' })
check('[7] con confirmación el mismo contenido entra (uno de los 4 ya había entrado en el caso anterior)', rC.nuevos === 3, JSON.stringify(rC))
check('[7] un extracto distinto entra normal en la otra empresa', (await importar(cuentaBer, 'H41-C', [{ fecha: hab[16], descripcion: 'OTRO', importe: 1, saldo: 1 }])).nuevos === 1)
await comoAnon()
await falla('[7] la comparación es solo del servidor', `select extracto_duplicado_en_otra_empresa('{}'::jsonb)`, [], /permission denied/)
// Deshacer un extracto subido a la cuenta equivocada
await servidor()
const cuentaBer2 = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, unidad_id, requiere_extracto) values ('beratung', 'BANCO PRUEBA CC BER 2', 'BANCOPRUEBA', 'CC', '30999999991', $1, true) returning id`, [uBer])).id
const cuerpoE = [2, 3, 4].map((k) => ({ fecha: hab[k], descripcion: `EQUIVOCADO ${k}`, importe: 5000 + k, saldo: 1000 + k }))
const rEq = await importar(cuentaBer2, 'H41-EQ', cuerpoE)
const idEq = rEq.extracto_id
await como('aprob@prueba.com')
await falla('[8] un aprobador no deshace un extracto', `select borrar_extracto($1)`, [idEq], /rol/)
await como('soloind@prueba.com')
await falla('[8] quien no ve la empresa tampoco', `select borrar_extracto($1)`, [idEq], /acceso a la empresa/)
await como('teso@prueba.com')
const mq = await val(`select id from movimientos_bancarios where extracto_id = $1 limit 1`, [idEq])
const pgBloq = await pagoSF('beratung', 5002)
await comoServidor(() => db.query(`update movimientos_bancarios set pago_id = $2 where id = $1`, [mq.id, pgBloq]))
await falla('[8] con un movimiento conciliado con un pago no se deshace', `select borrar_extracto($1)`, [idEq], /ya están conciliados/)
await comoServidor(() => db.query(`update movimientos_bancarios set pago_id = null where id = $1`, [mq.id]))
const rb = (await val(`select borrar_extracto($1) r`, [idEq])).r
check('[8] sin conciliar, se deshace: borra sus movimientos y saldos', rb.movimientos === 3 && (await val(`select count(*)::int n from extractos where id = $1`, [idEq])).n === 0
  && (await val(`select count(*)::int n from movimientos_bancarios where descripcion like 'EQUIVOCADO%'`)).n === 0 && (await val(`select count(*)::int n from saldos_bancarios where extracto_id = $1`, [idEq])).n === 0, JSON.stringify(rb))
check('[8] y queda en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'EXTRACTO_DESHECHO' and entidad_id = $1`, [idEq])).n === 1)
check('[8] después se puede subir a la cuenta correcta', (await importar(cuentaIndia, 'H41-EQ', cuerpoE, { confirmar_otra_empresa: 'true' })).nuevos === 3)

// ================================================================ 5. Control de caja contra el Flujo (ya estaba)
check('[9] control_bancos ya trae FLUJO_F (control del Flujo contra bancos, 0031): no se duplica', /FLUJO_F/.test((await val(`select pg_get_viewdef('control_bancos'::regclass) d`)).d))

// ================================================================ Permisos y definición
await servidor()
const priv = async (rol, f) => (await val(`select has_function_privilege($1, $2, 'execute') ok`, [rol, f])).ok
const publicas = ['proyecciones_para_pago(text)', 'asociar_pago_proyeccion(uuid, uuid, date)', 'registrar_pago(jsonb)', 'anular_pago(uuid, text)',
  'cambiar_proyeccion(uuid, date, text, text, numeric, date, text)', 'aprobar_factura(uuid, text, metodo_pago, integer, date)', 'aprobar_factura_y_vincular(uuid, text, metodo_pago, integer, date)',
  'definir_cuit_propio(text, text, text, boolean)', 'reconocer_cuentas_propias(text, date)', 'borrar_extracto(uuid)']
const internas = ['proyeccion_estado_ocurrencia(proyecciones, date)', 'proyeccion_poner_ajuste(proyecciones, date, numeric, boolean, text, usuarios)', 'pago_cuenta_en_flujo(pagos)',
  'efectuar_descuento_proyeccion(uuid, usuarios)', 'aplicar_pago_a_proyeccion(uuid, uuid, date, usuarios)', 'devolver_pago_a_proyeccion(uuid, usuarios)',
  'aprobar_factura_interna(uuid, text, metodo_pago, integer, boolean, date, boolean)', 'reconocer_cuentas_propias_interna(text, uuid, date)', 'extracto_duplicado_en_otra_empresa(jsonb)',
  'aprobar_factura(uuid, text, metodo_pago, integer)', 'aprobar_factura_y_vincular(uuid, text, metodo_pago, integer)']
const anon = [], noAuth = [], authInt = [], noServ = []
for (const f of publicas) { if (await priv('anon', f)) anon.push(f); if (!(await priv('authenticated', f))) noAuth.push(f); if (!(await priv('service_role', f))) noServ.push(f) }
for (const f of internas) { if (await priv('anon', f)) anon.push(f); if (await priv('authenticated', f)) authInt.push(f); if (!(await priv('service_role', f))) noServ.push(f) }
check('[permisos] anon no ejecuta ninguna función nueva ni redefinida (tampoco registrar_pago ni anular_pago)', anon.length === 0, anon.join(', '))
check('[permisos] las de la pantalla las ejecuta authenticated; las internas y las firmas viejas de 4 argumentos, solo el servidor', noAuth.length === 0 && authInt.length === 0 && noServ.length === 0, `${noAuth} / ${authInt} / ${noServ}`)
check('[permisos] importar_extracto sigue siendo solo del servidor', !(await priv('authenticated', 'importar_extracto(jsonb)')) && !(await priv('anon', 'importar_extracto(jsonb)')) && (await priv('service_role', 'importar_extracto(jsonb)')))
check('[permisos] cuits_propios: anon no lee, authenticated lee y no escribe', !(await val(`select has_table_privilege('anon', 'cuits_propios', 'select') a`)).a
  && (await val(`select has_table_privilege('authenticated', 'cuits_propios', 'select') a`)).a && !(await val(`select has_table_privilege('authenticated', 'cuits_propios', 'insert') a`)).a)
const nombres = [...publicas, ...internas].map((f) => f.split('(')[0])
check('[permisos] las que escriben son SECURITY DEFINER con search_path fijo', (await val(
  `select count(*)::int n from pg_proc p where p.proname = any($1) and p.pronamespace = 'public'::regnamespace and not (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`, [nombres])).n === 0)
check('[permisos] ninguna usa current_date', (await val(
  `select count(*)::int n from pg_proc p where p.proname = any($1) and p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'current_date'`, [[...nombres, 'importar_extracto']])).n === 0)

console.log(`\n${ok} OK · ${mal} MAL`)
await db.close()
process.exit(mal ? 1 : 0)
