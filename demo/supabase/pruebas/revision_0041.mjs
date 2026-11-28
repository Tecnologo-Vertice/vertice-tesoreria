// Revisión independiente de 0041 (agente 06, 27/11/2026): pagos contra proyecciones, fecha de pago al aprobar,
// CUIT propios y extracto repetido en otra empresa.
// Los "BUG" son comportamientos que rompen algo o que no coinciden con lo pedido; los "OK" son controles (lo que sí anda);
// los "INFO" son dudas para confirmar con Santi. Datos ficticios. No toca producción.
// Uso (desde demo/): node supabase/pruebas/revision_0041.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, bug = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else bug++; console.log(`${cond ? 'OK ' : 'BUG'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const info = (nombre, dato) => console.log(`INFO ${nombre} · ${typeof dato === 'string' ? dato : JSON.stringify(dato)}`)
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows
const error = async (sql, p = []) => { try { await db.query(sql, p); return null } catch (e) { return e.message } }
let actual = null
const como = async (email) => {
  actual = email
  await db.exec(`reset role`)
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])
  if (email) await db.exec(`set role authenticated`)
}
const comoAnon = async () => { actual = null; await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role anon`) }
const servidor = async () => { actual = null; await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`) }
const comoServidor = async (fn) => { const antes = actual; await servidor(); try { return await fn() } finally { if (antes) await como(antes) } }
const sqlDe = (f) => readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const codigo = (dirs) => dirs.flatMap((d) => { const r = []; const rec = (p) => { for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'pruebas') rec(q) } else if (/[.](ts|tsx|mts)$/.test(e.name)) r.push(q) } }; rec(d); return r })

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
// La base "real" ya tiene 0001-0040 con datos; 0041 se aplica después.
const todas = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
const f41 = todas.find((x) => x.startsWith('0041'))
for (const f of todas.filter((x) => !x.startsWith('0041'))) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  try { await db.exec(sqlDe(f)) } catch (e) { console.log(`BUG migración ${f} no aplica: ${e.message}`); process.exit(1) }
}

// ---------------------------------------------------------------- Datos "reales" previos a 0041
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('aprob@prueba.com', 'Aprob', 'APROBADOR', true);
`)
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const uBer = (await val(`select id from unidades where empresa_id = 'beratung' and por_defecto`)).id
const fila = async (unidad, etiqueta, seccion, cuenta, orden = 500) => (await val(
  `insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable) values ($1, 'x', $2, 'CUENTA', $3, $4, $5) returning id`,
  [unidad, orden, seccion, etiqueta, cuenta])).id
const fAlq = await fila(uIndia, 'Alquiler', 'GASTOS_OPERATIVOS', 'ALQUILER DE OFICINA', 320)
await db.query(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id) values ('india', 'BANCO PRUEBA', 'BANCOPRUEBA', 'CC', $1)`, [uIndia])
const prov = (await val(`insert into proveedores (cuit, nombre) values ('30710000001', 'Proveedor Uno SA') returning id`)).id
// 937 pagos de la hoja (gestion HOJA), como en la base real
await db.exec(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, forma_carga_xubio, estado, gestion)
  select 'india', hoy_ar() - 60, 100 + g, 'TRANSFERENCIA', 'hoja', 'ORDEN_PAGO', 'CARGADO', 'HOJA' from generate_series(1, 937) g`)
try { await db.exec(sqlDe(f41)); check('0041 aplica sobre una base con 937 pagos de la hoja', true) } catch (e) { console.log('BUG 0041 no aplica: ' + e.message); process.exit(1) }
try { await db.exec(sqlDe(f41)); check('0041 se puede ejecutar dos veces', true) } catch (e) { check('0041 se puede ejecutar dos veces', false, e.message) }

let nro = 800
const factura = async (empresa, total, extra = {}) => comoServidor(async () => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable)
   values ($1, $2, $3, 'A', 1, $4, $5, $6, $7, $7, 'PENDIENTE_APROBACION', 0, 'PROVEEDORES LOCALES') returning id`,
  [empresa, prov, extra.tipo ?? 'Factura A', nro++, dia(-10), extra.vence ?? dia(10), total])).id)
const crear = async (extra) => (await val(`select crear_proyeccion($1) id`, [{
  empresa_id: 'india', unidad_id: uIndia, fila_id: fAlq, concepto: 'Alquiler', importe: -1000, fecha_inicio: dia(5), recurrencia: 'UNICA', ...extra }])).id
const lineasDe = (id) => filas(
  `select ocurrencia, fecha::text as fecha, importe::float as importe, ajustada from flujo_lineas_entre(hoy_ar(), hoy_ar() + 90, null, false) where origen_tipo = 'PROYECCION' and origen_id = $1 order by ocurrencia`, [id])
const proy = (id) => val(`select estado from proyecciones where id = $1`, [id])
const registrar = async (extra) => (await val(`select registrar_pago($1) id`, [{
  empresa_id: 'india', fecha: hoy, importe: 1000, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA', forma_carga_xubio: 'SALIDA_FONDOS', ...extra }])).id
const netoFlujo = async (proyId, pagos) => (await val(
  `select coalesce(sum(importe), 0)::float s from flujo_lineas_entre(hoy_ar() - 3, hoy_ar() + 90, null, false)
   where (origen_tipo = 'PROYECCION' and origen_id = $1) or (origen_tipo = 'PAGO' and origen_id = any($2::uuid[]))`, [proyId, pagos])).s

// ================================================================ A. Fecha de pago: ¿se puede saltear?
await como('aprob@prueba.com')
{
  const priv = async (rol, f) => (await val(`select has_function_privilege($1, $2, 'execute') ok`, [rol, f])).ok
  check('[fecha] la firma vieja aprobar_factura(4 args) no la puede ejecutar quien tiene sesión (saltea la fecha obligatoria)',
    !(await priv('authenticated', 'aprobar_factura(uuid, text, metodo_pago, integer)')), 'authenticated la ejecuta')
  check('[fecha] la firma vieja aprobar_factura_y_vincular(4 args) tampoco',
    !(await priv('authenticated', 'aprobar_factura_y_vincular(uuid, text, metodo_pago, integer)')), 'authenticated la ejecuta')
  const f1 = await factura('india', 1000)
  const e1 = await error(`select aprobar_factura($1, 'GASTOS', 'TRANSFERENCIA')`, [f1])
  const q1 = await val(`select estado::text, fecha_pago::text, vencimiento_factura::text from facturas where id = $1`, [f1])
  check('[fecha] aprobar una transferencia SIN fecha de pago llamando a la firma vieja es rechazado', e1 !== null, `quedó ${q1.estado} sin fecha de pago (fecha_pago=${q1.fecha_pago}, vencimiento_factura=${q1.vencimiento_factura})`)
  const f2 = await factura('india', 1000)
  const e2 = await error(`select aprobar_factura_y_vincular($1, 'GASTOS', 'TRANSFERENCIA', 30)`, [f2])
  check('[fecha] lo mismo con aprobar_factura_y_vincular de 4 args (la que usa el PostgREST sin p_fecha_pago)', e2 !== null, 'se aprobó sin fecha')
  const llaman = codigo(['src', 'netlify/functions']).filter((q) => /rpc[^\n]*['"]aprobar_factura(_y_vincular)?['"]/.test(readFileSync(q, 'utf8')))
  info('quién llama aprobar_factura / aprobar_factura_y_vincular fuera de las pruebas (solo la pantalla, con y sin fecha en el catch)', llaman)
  // Tarjeta: nace pagada, pero se le exige una fecha y se pisa el vencimiento con ella
  const f3 = await factura('india', 500, { vence: dia(15) })
  await db.query(`select aprobar_factura($1, 'GASTOS', 'TARJETA', null, $2)`, [f3, dia(40)])
  const q3 = await val(`select estado::text, fecha_pago::text, vencimiento::text, vencimiento_factura::text from facturas where id = $1`, [f3])
  check('[fecha] tarjeta (nace PAGADA hoy): la fecha obligatoria no pisa el vencimiento con una fecha en la que nunca se paga',
    q3.estado === 'PAGADA' && q3.vencimiento === dia(15), JSON.stringify(q3))
  // Xubio recibe fechaVto = facturas.vencimiento
  const armado = readFileSync('netlify/functions/lib/xubio-armado.ts', 'utf8')
  check('[fecha] la factura que se sube a Xubio al aprobar lleva el vencimiento original (vencimiento_factura), no la fecha de pago',
    /vencimiento_factura/.test(armado) || /vencimiento_factura/.test(readFileSync('netlify/functions/lib/xubio-facturas.ts', 'utf8')),
    'xubio-armado.ts arma fechaVto con f.vencimiento, que ahora es la fecha de pago')
}

// ================================================================ B. Permisos
await servidor()
{
  const priv = async (rol, f) => (await val(`select has_function_privilege($1, $2, 'execute') ok`, [rol, f])).ok
  info('anon ejecuta registrar_pago / anular_pago', { registrar_pago: await priv('anon', 'registrar_pago(jsonb)'), anular_pago: await priv('anon', 'anular_pago(uuid, text)') })
  await comoAnon()
  const e1 = await error(`select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'X' }])
  const e2 = await error(`select anular_pago('00000000-0000-0000-0000-000000000000', 'x')`)
  check('[permisos] anon no puede registrar ni anular (la base lo rechaza)', e1 !== null && e2 !== null, `${e1} / ${e2}`)
  await servidor()
  const anon = (await filas(`select p.oid::regprocedure::text f from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('aplicar_pago_a_proyeccion','devolver_pago_a_proyeccion','proyeccion_poner_ajuste','proyeccion_estado_ocurrencia','reconocer_cuentas_propias_interna','aprobar_factura_interna','importar_extracto',
                      'proyecciones_para_pago','asociar_pago_proyeccion','aprobar_factura','aprobar_factura_y_vincular','definir_cuit_propio','reconocer_cuentas_propias')
    and has_function_privilege('anon', p.oid, 'execute')`)).map((r) => r.f)
  check('[permisos] ninguna función redefinida o nueva de 0041 queda ejecutable por anon', anon.length === 0, anon.join(', '))
  info('definir_cuit_propio la puede usar TESORERIA (cambia qué movimientos se dan por "entre cuentas propias")', await val(`select has_function_privilege('authenticated', 'definir_cuit_propio(text,text,text,boolean)', 'execute') a`))
}

// ================================================================ C. Proyecciones
await como('teso@prueba.com')
{
  // C1. Flujo: el pago nuevo todavía no cuenta (pfuera) pero la proyección ya bajó
  const p = await crear({ concepto: 'Alquiler C1', importe: -1000, fecha_inicio: dia(5) })
  const antes = await netoFlujo(p, [])
  const pg = await registrar({ importe: 1000, proyeccion_id: p, proyeccion_ocurrencia: dia(5) })
  const durante = await netoFlujo(p, [pg])
  check('[flujo] recién cargado el pago (sin contabilizar), el Flujo conserva los -1000 (no pierde plata)', durante === antes, `antes ${antes}, con el pago cargado ${durante}`)
  await comoServidor(() => db.query(`update pagos set estado = 'CONTABILIZADO', xubio_id = 'OP-1', contabilizado_por = 'x' where id = $1`, [pg]))
  info('al contabilizarse en Xubio el pago entra al Flujo y vuelve a -1000', { neto: await netoFlujo(p, [pg]) })
  // C1b. Caja: el efectivo nunca entra como pago (pfuera por CAJA)
  const p2 = await crear({ concepto: 'Gasto caja', importe: -300, fecha_inicio: dia(6) })
  const pgC = await registrar({ importe: 300, medio: 'CAJA', proyeccion_id: p2, proyeccion_ocurrencia: dia(6) })
  await comoServidor(() => db.query(`update pagos set estado = 'CONTABILIZADO', xubio_id = 'OP-2', contabilizado_por = 'x' where id = $1`, [pgC]))
  const netoC = await netoFlujo(p2, [pgC])
  // Decidido: el Flujo nunca cuenta el efectivo y el banco no lo va a pagar, así que el descuento pesa en el momento (neto 0, la plata del efectivo entra por la reposición del fondo).
  check('[flujo] un pago en efectivo (Caja) contra una proyección: descuenta en el momento (decisión: el Flujo nunca lo cuenta)', netoC === 0, `neto ${netoC}: la proyección bajó y el pago de Caja nunca entra (impacta por la reposición del fondo)`)

  // (Decidido por el coordinador: el descuento espera a que el pago cuente en el Flujo; Caja y cheque descuentan en el momento.
  //  Por eso C2 a C4 usan pagos de Caja: con una transferencia cargada el descuento todavía no se aplicó.)
  // C2. Anular el parcial mientras otro pago la tiene dada de baja: se pierden los 400 que no se pagaron
  const q = await crear({ concepto: 'Alquiler C2', importe: -1000, fecha_inicio: dia(7) })
  const a = await registrar({ importe: 400, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: q, proyeccion_ocurrencia: dia(7) })
  const b = await registrar({ importe: 900, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: q, proyeccion_ocurrencia: dia(7) })      // descuenta 600 y da de baja
  await db.query(`select anular_pago($1, 'se cargó mal')`, [a])
  const ls = await lineasDe(q)
  check('[proyección] anulado el pago de 400 (el otro cubrió solo 600), vuelven los 400 que quedaron sin pagar',
    ls.length === 1 && ls[0].importe === -400, `líneas de la proyección: ${JSON.stringify(ls.map((x) => x.importe))} · estado ${(await proy(q)).estado}`)
  await db.query(`select anular_pago($1, 'también')`, [b])
  const ls2 = await lineasDe(q)
  check('[proyección] anulados los dos, vuelve entera (-1000)', ls2.length === 1 && ls2[0].importe === -1000, JSON.stringify(ls2))

  // C3. Una persona subió el importe de la ocurrencia: anular el pago no se lo devuelve
  const r = await crear({ concepto: 'Alquiler C3', importe: -1000, fecha_inicio: dia(8) })
  await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', 1500, null, 'aumento')`, [r, dia(8)])
  const pgR = await registrar({ importe: 300, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: r, proyeccion_ocurrencia: dia(8) })
  await db.query(`select anular_pago($1, 'x')`, [pgR])
  const lr = await lineasDe(r)
  check('[proyección] la ocurrencia editada a 1.500 vuelve a 1.500 al anular un pago de 300 (no pierde el aumento)', lr.length === 1 && lr[0].importe === -1500, JSON.stringify(lr.map((x) => x.importe)))

  // C4. DESDE_ESTA después de un pago parcial: la serie nueva nace con el importe de base y olvida lo pagado
  const s = await crear({ concepto: 'Serie C4', importe: -200, fecha_inicio: dia(2), recurrencia: 'SEMANAL', cuotas: 3 })
  await registrar({ importe: 50, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: s, proyeccion_ocurrencia: dia(9) })
  const nueva = (await val(`select cambiar_proyeccion($1, $2, 'DESDE_ESTA', 'EDITAR', null, $3, 'mover un día') id`, [s, dia(9), dia(10)])).id
  const ln = await lineasDe(nueva)
  check('[proyección] mover "esta y las siguientes" una ocurrencia con un pago de 50 ya descontado: la serie nueva sigue con 150, no con 200',
    ln.length > 0 && ln[0].importe === -150, `primera línea de la serie nueva ${ln[0]?.importe} (el pago de 50 sigue vivo)`)
  // Sano: solo mover la fecha de esa ocurrencia conserva el descuento
  const s2 = await crear({ concepto: 'Serie C4b', importe: -200, fecha_inicio: dia(3), recurrencia: 'SEMANAL', cuotas: 3 })
  await registrar({ importe: 50, medio: 'CAJA', cuenta_origen: 'Caja', proyeccion_id: s2, proyeccion_ocurrencia: dia(10) })
  await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', null, $3, 'mover')`, [s2, dia(10), dia(12)])
  check('[proyección] mover solo esa ocurrencia de fecha conserva el descuento (150)', (await lineasDe(s2)).some((x) => x.importe === -150 && x.fecha >= dia(12)), JSON.stringify(await lineasDe(s2)))

  // C5. Una ocurrencia adelantada (fecha_nueva dentro de la ventana) no aparece en la lista pero se puede pagar
  const t = await crear({ concepto: 'Lejana adelantada', importe: -300, fecha_inicio: dia(50) })
  await db.query(`select cambiar_proyeccion($1, $2, 'SOLO_ESTA', 'EDITAR', null, $3, 'se adelantó')`, [t, dia(50), dia(10)])
  const enFlujo = (await lineasDe(t)).some((x) => x.fecha <= dia(30))
  const enLista = (await filas(`select proyeccion_id from proyecciones_para_pago('india')`)).some((x) => x.proyeccion_id === t)
  const pudo = (await error(`select registrar_pago($1)`, [{ empresa_id: 'india', fecha: hoy, importe: 10, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA', proyeccion_id: t, proyeccion_ocurrencia: dia(50) }])) === null
  check('[proyección] una ocurrencia del Flujo que cae dentro de los 30 días (por haberla adelantado) aparece en la lista para elegir',
    !(enFlujo && pudo) || enLista, `está en el Flujo antes del día 30: ${enFlujo}; registrar_pago la acepta: ${pudo}; la lista la trae: ${enLista}`)
}

// ================================================================ D. Pantalla (lectura de código)
{
  const store = readFileSync('src/store.tsx', 'utf8')
  const pagos = readFileSync('src/screens/Pagos.tsx', 'utf8')
  const deps = (store.match(/\}, \[fuente, cargando[^\]]*\]\)/) ?? [''])[0]
  const efecto = /useEffect\(\(\) => \{\s*let vigente = true\s*setProyElegida\(''\)[\s\S]*?\[empresaId, proyeccionesParaPago\]\)/.test(pagos)
  check('[pantalla, lectura de código] la proyección elegida no se borra sola cuando el store se refresca (el efecto depende de una función que se recrea con toasts y recargas)',
    !(efecto && /toasts/.test(deps) && /proyeccionesParaPago: \(empresaId\) =>/.test(store)),
    'el efecto hace setProyElegida("") y depende de proyeccionesParaPago, que se recrea con cada cambio de facturas, pagos, toasts, etc.')
  info('[pantalla] asociar_pago_proyeccion (pago ya cargado) existe en la base pero ninguna pantalla la llama; solo se puede elegir la proyección al cargar el pago', !/asociar_pago_proyeccion|asociarPagoProyeccion/.test(readFileSync('src/data/fuenteSupabase.ts', 'utf8')))
}

// ================================================================ E. CUIT propios
await servidor()
const cuenta = async (nombre, clase, x = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, cuit_banco, unidad_id, requiere_extracto, cuenta_madre_id)
   values ($1, $2, 'BANCOPRUEBA', $3, '30999999991', $4, $5, $6) returning id`, [x.empresa ?? 'india', nombre, clase, x.unidad ?? uIndia, x.requiere ?? true, x.madre ?? null])).id
const importar = (c, hash, movs, extra = {}) => comoServidor(async () => (await val(`select importar_extracto($1) r`, [{ cuenta_origen_id: c, usuario: 'teso@prueba.com', archivo: { nombre: hash, hash }, movimientos: movs, ...extra }])).r)
const hab = (await filas(`select d::date::text f from generate_series(hoy_ar() - 25, hoy_ar() - 1, interval '1 day') d where es_dia_habil(d::date) order by d`)).map((r) => r.f)
const cat = async (desc) => val(`select categoria, estado, contraparte_cuenta_id, pago_id from movimientos_bancarios where descripcion = $1`, [desc])
{
  const cc = await cuenta('CC INDIA UNO', 'CC')
  const fondo = await cuenta('FCI UNICO', 'FCI', { madre: cc, requiere: false })
  const D = {
    otraCuenta: 'TRANSF A CUENTA DE LA EMPRESA EN OTRO BANCO CUIT 30-71807718-0',
    vep: 'PAGO VEP AFIP IMPUESTO CUIT 30-71807718-0 PERIODO 10/2026',
    pago: 'TRANSF A PROVEEDOR UNO ORDENANTE CUIT 30718077180',
    ber: 'PAGO A 33716515929 BERATUNG',
  }
  await comoServidor(() => db.query(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, forma_carga_xubio, estado, gestion, proveedor_id)
    values ('india', $1, 777, 'TRANSFERENCIA', 'teso@prueba.com', 'ORDEN_PAGO', 'CARGADO', 'SISTEMA', $2)`, [hab[3], prov]))
  const r = await importar(cc, 'R41-CUIT', [
    { fecha: hab[0], descripcion: D.otraCuenta, importe: -5000, saldo: 95000 },
    { fecha: hab[1], descripcion: D.vep, importe: -2000, saldo: 93000 },
    { fecha: hab[2], descripcion: D.ber, importe: -700, saldo: 92300 },
    { fecha: hab[3], descripcion: D.pago, importe: -777, saldo: 91523 }])
  info('importación con CUIT propios', r)
  const m1 = await cat(D.otraCuenta)
  check('[cuit] una transferencia a otra cuenta propia (otro banco) queda entre cuentas propias SIN contraparte inventada en el único fondo de la cuenta',
    m1.categoria === 'TRANSFERENCIA_PROPIA' && m1.contraparte_cuenta_id === null, `categoría ${m1.categoria}, contraparte ${m1.contraparte_cuenta_id === fondo ? 'el FCI UNICO (equivocada)' : m1.contraparte_cuenta_id}`)
  const m2 = await cat(D.vep)
  check('[cuit] un pago de impuestos (VEP) que lleva el CUIT de la empresa como contribuyente NO se toma por transferencia entre cuentas propias',
    m2.categoria === 'SIN_CLASIFICAR', `quedó ${m2.categoria}/${m2.estado}: sale de "A revisar"`)
  const m3 = await cat(D.pago)
  check('[cuit] un pago a proveedor que el sistema concilia con su pago cargado no queda marcado como transferencia propia',
    !(m3.pago_id && m3.categoria === 'TRANSFERENCIA_PROPIA'), `vinculado al pago y categoría ${m3.categoria}`)
  const m4 = await cat(D.ber)
  info('[cuit] el Apps Script (ConciliacionBancaria.js líneas 900 y 1268) trata 33716515929/BERATUNG como propia desde cualquier cuenta; con 0041 solo lo es en Beratung', { categoria: m4.categoria })
  info('siembra de cuits_propios', await filas(`select empresa_id, cuit from cuits_propios order by 1`))
}

// ================================================================ F. Extracto en otra empresa
{
  const ci = await cuenta('BANCO F INDIA', 'CC')
  const cb = await cuenta('BANCO F BER', 'CC', { empresa: 'beratung', unidad: uBer })
  const movs = [{ fecha: hab[5], descripcion: 'DEPOSITO F 41', importe: 1234, saldo: 1234 }]
  await importar(ci, 'F41-A', movs)
  const e1 = await comoServidor(() => error(`select importar_extracto($1)`, [{ cuenta_origen_id: cb, usuario: 'x', archivo: { nombre: 'a', hash: 'F41-A' }, movimientos: movs }]))
  check('[extracto] el mismo archivo en otra empresa se bloquea', e1 !== null)
  // Mismos movimientos en un archivo distinto (se volvió a bajar del banco): no se detecta
  const e2 = await comoServidor(() => error(`select importar_extracto($1)`, [{ cuenta_origen_id: cb, usuario: 'x', archivo: { nombre: 'b', hash: 'F41-A-BAJADO-DE-NUEVO' }, movimientos: movs }]))
  check('[extracto] el mismo extracto bajado otra vez (otro archivo, mismos movimientos) también se avisa/bloquea', e2 !== null, 'entró sin aviso: se compara solo la huella del archivo, no los movimientos')
  // Subir mal y no poder arreglarlo
  const cx = await cuenta('BANCO G INDIA (equivocada)', 'CC')
  const cy = await cuenta('BANCO G BER (correcta)', 'CC', { empresa: 'beratung', unidad: uBer })
  await importar(cx, 'F41-G', [{ fecha: hab[6], descripcion: 'DEPOSITO G', importe: 50, saldo: 50 }])
  const e3 = await comoServidor(() => error(`select importar_extracto($1)`, [{ cuenta_origen_id: cy, usuario: 'x', archivo: { nombre: 'g', hash: 'F41-G' }, movimientos: [{ fecha: hab[6], descripcion: 'DEPOSITO G', importe: 50, saldo: 50 }] }]))
  const borra = (await val(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~* 'delete from extractos'`)).n
  const confirma = codigo(['src', 'netlify']).filter((q) => /confirmar_otra_empresa/.test(readFileSync(q, 'utf8')))
  check('[extracto] si se cargó en la empresa equivocada hay una salida (confirmación desde la pantalla/servidor o forma de deshacer el extracto)',
    e3 === null || confirma.length > 0 || borra > 0, `bloqueado en la correcta; funciones que borran extractos: ${borra}; código que manda confirmar_otra_empresa: ${confirma.length}`)
  const srv = readFileSync('netlify/functions/importar-extracto.mts', 'utf8')
  check('[extracto] el servidor guarda el archivo en el storage solo después de que la base lo aceptó', srv.indexOf('extracto_duplicado_en_otra_empresa') >= 0 && srv.indexOf('extracto_duplicado_en_otra_empresa') < srv.lastIndexOf('guardarArchivo(db'),
    'el control de "otra empresa" tiene que ir antes de guardarArchivo (importar_extracto necesita la ruta del archivo, por eso la comparación se hace antes con extracto_duplicado_en_otra_empresa)')
}

console.log(`\n${ok} OK · ${bug} BUG`)
await db.close()
process.exit(bug ? 1 : 0)
