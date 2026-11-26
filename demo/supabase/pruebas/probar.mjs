// Corre las migraciones reales contra Postgres (PGlite) con un Supabase mínimo simulado,
// y prueba los casos corregidos en la auditoría del 13/10/2026. Uso: npm run test:sql (desde demo/)
import { PGlite } from '@electric-sql/pglite'
// pgcrypto no hace falta: gen_random_uuid() es nativo desde Postgres 13
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
async function falla(nombre, sql, p, patron) {
  try { await db.query(sql, p); check(nombre, false, 'no falló') }
  catch (e) { check(nombre, patron.test(e.message), e.message.slice(0, 110)) }
}
const como = (email) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email })])

// --- Supabase mínimo: roles, auth.users, auth.jwt(), storage.
const SUPABASE_MINIMO = `
  create role anon; create role authenticated; create role service_role bypassrls; -- como en Supabase: la clave de servicio salta el RLS
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant select, insert on storage.objects to authenticated; -- como en Supabase: el RLS decide
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated;
`
await db.exec(SUPABASE_MINIMO)

for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')); check(`migración ${f}`, true) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
// Proyecto creado con "Automatically expose new tables" desmarcado: los únicos permisos son los de 0007.
// todas_empresas = true: estos usuarios de prueba ven las 8 empresas, como el equipo hoy (0010).
await db.exec(`insert into usuarios (email, nombre, rol, todas_empresas) values ('aprobador@verticebi.com', 'Aprobador', 'APROBADOR', true), ('direccion@verticebi.com', 'Dirección', 'DIRECCION', true)`)
check('anon no tiene ningún permiso sobre las tablas', !(await val(`select has_table_privilege('anon', 'facturas', 'select') p`)).p && !(await val(`select has_table_privilege('anon', 'pagos', 'select') p`)).p)
check('authenticated solo lee (no escribe directo en las tablas)', (await val(`select has_table_privilege('authenticated', 'pagos', 'select') p`)).p && !(await val(`select has_table_privilege('authenticated', 'pagos', 'insert') p`)).p)
check('service_role (funciones de Netlify) escribe', (await val(`select has_table_privilege('service_role', 'documentos', 'insert') p`)).p)

// --- Semilla
check('semilla: 8 empresas', (await val(`select count(*)::int n from empresas`)).n === 8)
const nCuentas = (await val(`select count(*)::int n from cuentas_contables`)).n
await db.exec(readFileSync(join(dir, '0004_semilla.sql'), 'utf8'))
check('semilla dos veces no duplica cuentas comunes', (await val(`select count(*)::int n from cuentas_contables`)).n === nCuentas, `${nCuentas} cuentas`)

// --- Seguridad
check('vista export_cashflow con security_invoker', (await val(`select reloptions::text o from pg_class where relname = 'export_cashflow'`)).o?.includes('security_invoker=true'))
for (const r of ['anon', 'authenticated'])
  check(`${r} NO puede ejecutar registrar_auditoria`, !(await val(`select has_function_privilege($1, 'registrar_auditoria(usuarios,text,text,text,text)', 'execute') p`, [r])).p)
check('authenticated SÍ puede ejecutar registrar_pago', (await val(`select has_function_privilege('authenticated', 'registrar_pago(jsonb)', 'execute') p`)).p)

// --- Ingesta desde el Apps Script (rol de servicio = superusuario acá)
const factura = (extra = {}) => ({ empresa_id: 'beratung', proveedor: 'Lab Prueba', cuit_proveedor: '30-71234567-8', tipo: 'Factura A', letra: 'A',
  punto_venta: 5, numero: 1001, fecha: '2026-10-01', vencimiento: '2026-10-20', neto: 8264462.81, iva: 1735537.19, total: 10000000,
  estado: 'PENDIENTE_APROBACION', validacion_ok: true, ...extra })
const f1 = (await val(`select ingresar_factura($1) id`, [factura()])).id
const f2 = (await val(`select ingresar_factura($1) id`, [factura({ numero: 1002, total: 298931.21, neto: 247050.59, iva: 51880.62 })])).id
const f3 = (await val(`select ingresar_factura($1) id`, [factura({ numero: 1003, total: 500000, estado: 'PAGADA_PARCIAL', pagado: 200000 })])).id
const f5 = (await val(`select ingresar_factura($1) id`, [factura({ numero: 1005, total: 1000 })])).id
check('histórico: PAGADA_PARCIAL entra con lo pagado en pesos', Number((await val(`select pagado from facturas where id = $1`, [f3])).pagado) === 200000)
await db.query(`select ingresar_factura($1)`, [factura()])
check('reingesta idempotente: una sola factura 1001', (await val(`select count(*)::int n from facturas where numero = 1001`)).n === 1)

// --- Aprobación con sesión de usuario
await db.exec(`set role authenticated`)
await como('direccion@verticebi.com')
await falla('Dirección no puede aprobar', `select aprobar_factura($1, 'COSTO DE INSUMOS', 'TRANSFERENCIA')`, [f1], /rol/)
await como('aprobador@verticebi.com')
await falla('rechazo sin motivo falla', `select rechazar_factura($1, '  ')`, [f1], /motivo/)
await db.query(`select aprobar_factura($1, 'COSTO DE INSUMOS', 'TRANSFERENCIA')`, [f1])
await db.query(`select aprobar_factura($1, 'COSTO DE INSUMOS', 'TRANSFERENCIA')`, [f2])
check('aprobada pasa a PARA_PAGAR', (await val(`select estado from facturas where id = $1`, [f1])).estado === 'PARA_PAGAR')
await db.exec(`reset role; set role anon`)
await como('')
await falla('anon NO puede leer la vista export_cashflow', `select count(*) from export_cashflow`, [], /permission denied/)
await db.exec(`reset role; set role authenticated`)
await como('aprobador@verticebi.com')
check('usuario habilitado SÍ ve la vista', (await val(`select count(*)::int n from export_cashflow`)).n > 0)

// --- Pagos
await como('tesoreria@verticebi.com')
const pago = (extra) => ({ empresa_id: 'beratung', fecha: '2026-10-13', medio: 'TRANSFERENCIA', cuenta_origen: 'Banco Galicia CC $', descripcion: 'x', ...extra })
await falla('pago que supera lo vinculado falla', `select registrar_pago($1)`, [pago({ importe: 10000002, factura_ids: [f1] })], /supera/)
await falla('cheque sin número falla', `select registrar_pago($1)`, [pago({ importe: 100, medio: 'CHEQUE', factura_ids: [f1] })], /cheque/)
await falla('no se paga una factura rechazada o sin aprobar', `select registrar_pago($1)`, [pago({ importe: 100, factura_ids: [f5] })], /no está para pagar/)
await db.query(`select registrar_pago($1)`, [pago({ importe: 9999999.99, factura_ids: [f1] })])
let r = await val(`select estado, pagado, pagado_pct from facturas where id = $1`, [f1])
check('$10 M pagando todo menos 1 centavo queda PARCIAL al 99,99 % (antes: PAGADA)', r.estado === 'PAGADA_PARCIAL' && Number(r.pagado_pct) === 99.99, `pagado ${r.pagado} · ${r.pagado_pct}%`)
await db.query(`select registrar_pago($1)`, [pago({ importe: 0.01, factura_ids: [f1] })])
r = await val(`select estado, pagado from facturas where id = $1`, [f1])
check('el centavo restante la cancela (caso OP 483 de Guido)', r.estado === 'PAGADA' && Number(r.pagado) === 10000000)
await db.query(`select registrar_pago($1)`, [pago({ importe: 298931.21, medio: 'ECHEQ', numero_cheque: '29598', fecha_acreditacion: '2026-11-12', factura_ids: [f2] })])
check('e-cheq con número y vencimiento se registra', (await val(`select estado from facturas where id = $1`, [f2])).estado === 'PAGADA')
check('MAIL_PENDIENTE en auditoría al cancelar', (await val(`select count(*)::int n from auditoria where accion = 'MAIL_PENDIENTE'`)).n === 2)

// --- Reingesta no pisa lo decidido en el sistema nuevo
await db.exec(`reset role`)
await db.query(`select ingresar_factura($1)`, [factura({ estado: 'PENDIENTE_APROBACION' })])
r = await val(`select estado, pagado from facturas where id = $1`, [f1])
check('reingesta con estado viejo NO revierte una factura pagada', r.estado === 'PAGADA' && Number(r.pagado) === 10000000, r.estado)
await db.query(`select ingresar_factura($1)`, [factura({ numero: 1004 })])
await db.query(`select ingresar_factura($1)`, [factura({ numero: 1004, estado: 'PARA_PAGAR', cuenta_contable: 'SEGUROS' })])
check('reingesta SÍ actualiza una factura todavía pendiente', (await val(`select estado from facturas where numero = 1004`)).estado === 'PARA_PAGAR')

// --- Auditoría inmutable, incluso para el superusuario / rol de servicio
await falla('nadie puede borrar auditoría', `delete from auditoria`, [], /auditoría/)
await falla('nadie puede editar auditoría', `update auditoria set detalle = 'x'`, [], /auditoría/)

// --- Vista: proyecta lo pendiente en pesos
const v = await val(`select count(*)::int n, sum(egreso) filter (where referencia = $1) resto from export_cashflow where estado = 'PROYECTADO'`, [f3])
check('export_cashflow proyecta lo pendiente en pesos', v.n === 2 && Number(v.resto) === 300000, `${v.n} proyectadas · resto f3 ${v.resto}`)

// ================================================================ Flujo 1 · entrada de facturas (0005)
await db.exec(`reset role`)
check('bucket privado "facturas"', (await val(`select public from storage.buckets where id = 'facturas'`))?.public === false)
for (const fn of ['guardar_factura_leida(uuid,jsonb)', 'registrar_documento(jsonb)', 'tomar_documentos(integer)'])
  check(`authenticated NO puede ejecutar ${fn.split('(')[0]}`, !(await val(`select has_function_privilege('authenticated', $1, 'execute') p`, [fn])).p)

const doc = (msg, nombre = 'factura.pdf') => ({ origen: 'GMAIL', gmail_message_id: msg, nombre_archivo: nombre, mime_type: 'application/pdf', storage_path: `2026/10/${msg}_${nombre}`, tamano: 1000 })
const d1 = await val(`select * from registrar_documento($1)`, [doc('msg-1')])
const d1b = await val(`select * from registrar_documento($1)`, [doc('msg-1')])
check('mismo adjunto del mismo mail entra una sola vez', d1.nuevo === true && d1b.nuevo === false && d1b.id === d1.id)

let tomados = (await db.query(`select * from tomar_documentos(5)`)).rows
check('el lector toma el documento pendiente y lo marca LEYENDO', tomados.length === 1 && tomados[0].estado === 'LEYENDO' && tomados[0].intentos === 1)
check('un documento tomado no se toma dos veces', (await db.query(`select * from tomar_documentos(5)`)).rows.length === 0)

const leida = (extra = {}) => ({ empresa_id: 'india', proveedor: 'Distribuidora Nueva SRL', cuit_proveedor: '20123456786', tipo: 'Factura A', letra: 'A',
  punto_venta: 3, numero: 777, fecha: '2026-10-10', vencimiento: '2026-11-09', moneda: 'ARS', cotizacion: 1, neto: 1000, iva: 210, exento: 0,
  percepciones: 0, percepciones_json: [], total: 1210, cae: '74123456789012', cae_vencimiento: '2026-10-20', categoria_ia: 'Gastos Generales',
  validacion_ok: true, motivo_validacion: '', advertencia: '', ...extra })
const fa = (await val(`select guardar_factura_leida($1, $2) id`, [d1.id, leida()])).id
r = await val(`select f.estado, f.pdf_path, f.documento_id, f.origen, f.cuenta_contable, d.estado doc_estado from facturas f join documentos d on d.factura_id = f.id where f.id = $1`, [fa])
check('documento leído crea factura PENDIENTE_APROBACION con su PDF', r.estado === 'PENDIENTE_APROBACION' && r.doc_estado === 'LEIDO' && r.pdf_path === '2026/10/msg-1_factura.pdf' && r.origen === 'GMAIL')
check('sin memoria del proveedor, la cuenta queda vacía (la elige quien aprueba)', r.cuenta_contable === null)

// La misma factura reenviada en otro mail: duplicado, apunta a la existente.
const d2 = await val(`select * from registrar_documento($1)`, [doc('msg-2')])
await db.query(`select tomar_documento($1)`, [d2.id])
const fa2 = (await val(`select guardar_factura_leida($1, $2) id`, [d2.id, leida()])).id
r = await val(`select estado, factura_id from documentos where id = $1`, [d2.id])
check('la misma factura en otro mail queda DUPLICADO y apunta a la original', r.estado === 'DUPLICADO' && r.factura_id === fa && fa2 === fa)

// Con error de validación: va a Excepciones.
const d3 = await val(`select * from registrar_documento($1)`, [doc('msg-3')])
await db.query(`select tomar_documento($1)`, [d3.id])
const fe = (await val(`select guardar_factura_leida($1, $2) id`, [d3.id, leida({ numero: 778, validacion_ok: false, motivo_validacion: 'Descuadre de $500' })])).id
r = await val(`select estado, motivo_validacion from facturas where id = $1`, [fe])
check('factura con error de validación queda en ERROR (Excepciones)', r.estado === 'ERROR' && r.motivo_validacion === 'Descuadre de $500')

// Memoria: aprobar recuerda la cuenta; la próxima factura del proveedor la trae.
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await db.query(`select aprobar_factura($1, 'COSTO DE INSUMOS', 'TRANSFERENCIA')`, [fa])
await db.exec(`reset role`)
const d4 = await val(`select * from registrar_documento($1)`, [doc('msg-4')])
await db.query(`select tomar_documento($1)`, [d4.id])
const fm = (await val(`select guardar_factura_leida($1, $2) id`, [d4.id, leida({ numero: 779 })])).id
r = await val(`select cuenta_contable, metodo_pago from facturas where id = $1`, [fm])
check('aprobar recuerda la cuenta: la próxima factura del proveedor ya la trae', r.cuenta_contable === 'COSTO DE INSUMOS' && r.metodo_pago === 'TRANSFERENCIA')
check('auditoría dice que la cuenta fue recordada', (await val(`select count(*)::int n from auditoria where entidad_id = $1 and detalle like '%cuenta recordada%'`, [fm])).n === 1)

// Fallas de lectura: transitoria vuelve a la cola; al tercer intento queda en ERROR.
const d5 = await val(`select * from registrar_documento($1)`, [doc('msg-5')])
for (let i = 1; i <= 3; i++) {
  await db.query(`select tomar_documento($1)`, [d5.id])
  await db.query(`select documento_fallo($1, 'Cuota de IA agotada', true)`, [d5.id])
}
r = await val(`select estado, intentos from documentos where id = $1`, [d5.id])
check('falla transitoria se reintenta hasta 3 veces y después queda ERROR', r.estado === 'ERROR' && r.intentos === 3, `${r.estado} · ${r.intentos} intentos`)
const d6 = await val(`select * from registrar_documento($1)`, [doc('msg-6')])
await db.query(`select tomar_documento($1)`, [d6.id])
await db.query(`select documento_fallo($1, 'PDF protegido', false)`, [d6.id])
check('archivo ilegible va directo a ERROR, sin reintentos', (await val(`select estado from documentos where id = $1`, [d6.id])).estado === 'ERROR')

// Acciones de las personas sobre documentos con error.
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await falla('Tesorería no puede reintentar lecturas', `select reintentar_documento($1)`, [d6.id], /rol/)
await como('aprobador@verticebi.com')
await db.query(`select reintentar_documento($1)`, [d6.id])
r = await val(`select estado, intentos from documentos where id = $1`, [d6.id])
check('reintentar devuelve el documento a la cola con intentos en cero', r.estado === 'PENDIENTE' && r.intentos === 0)
await falla('descartar sin motivo falla', `select descartar_documento($1, '')`, [d6.id], /motivo/)
await db.query(`select descartar_documento($1, 'Es un presupuesto, no una factura')`, [d6.id])
check('descartar con motivo', (await val(`select estado from documentos where id = $1`, [d6.id])).estado === 'DESCARTADO')
check('el usuario habilitado ve la cola de documentos', (await val(`select count(*)::int n from documentos`)).n === 6)
await db.exec(`reset role`)

// ================================================================ Xubio automático y Ralpharma (0006)
await db.exec(`reset role`)
// fa: factura de India aprobada en la sección anterior (PARA_PAGAR, estado_xubio PENDIENTE)
check('aprobada aparece en la lista para subir a Xubio', (await db.query(`select * from facturas_para_xubio(10)`)).rows.some((x) => x.id === fa))
check('reservar para envío real: la primera vez sí', (await val(`select reservar_factura_xubio($1) r`, [fa])).r === true)
check('reservar dos veces: no (evita subirla duplicada)', (await val(`select reservar_factura_xubio($1) r`, [fa])).r === false)
check('reservada no aparece para el subidor', !(await db.query(`select * from facturas_para_xubio(10)`)).rows.some((x) => x.id === fa))
await falla('SUBIDA sin id de Xubio falla', `select resultado_factura_xubio($1, 'SUBIDA', '', null, 'x', true)`, [fa], /id de Xubio/)
await db.query(`select resultado_factura_xubio($1, 'ERROR', null, 'Proveedor no existe en Xubio', 'Lector', true)`, [fa])
r = await val(`select estado_xubio, xubio_error, xubio_envio_en from facturas where id = $1`, [fa])
check('error de Xubio: queda el motivo y se libera para reintentar', r.estado_xubio === 'ERROR' && r.xubio_error === 'Proveedor no existe en Xubio' && r.xubio_envio_en === null)
await db.query(`select reservar_factura_xubio($1)`, [fa])
await db.query(`select resultado_factura_xubio($1, 'SUBIDA', '95139854', null, 'Lector', true)`, [fa])
r = await val(`select estado_xubio, xubio_id, xubio_error, xubio_subida_en from facturas where id = $1`, [fa])
check('subida: guarda el id de Xubio y limpia el error', r.estado_xubio === 'SUBIDA' && r.xubio_id === '95139854' && r.xubio_error === null && r.xubio_subida_en !== null)
check('auditoría de la subida a Xubio', (await val(`select count(*)::int n from auditoria where entidad_id = $1 and accion = 'XUBIO_FACTURA'`, [fa])).n === 1)

// Ralpharma: factura de Droguería Robles aprobada
const dR = await val(`select * from registrar_documento($1)`, [doc('msg-r')])
await db.query(`select tomar_documento($1)`, [dR.id])
const fr = (await val(`select guardar_factura_leida($1, $2) id`, [dR.id, leida({ empresa_id: 'robles', numero: 900 })])).id
check('factura de empresa sin Xubio entra como PENDIENTE_RALPHARMA', (await val(`select estado_xubio from facturas where id = $1`, [fr])).estado_xubio === 'PENDIENTE_RALPHARMA')
check('empresa sin Xubio no aparece para el subidor', !(await db.query(`select * from facturas_para_xubio(50)`)).rows.some((x) => x.id === fr))
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await falla('no se confirma Ralpharma de una factura sin aprobar', `select marcar_factura_ralpharma($1)`, [fr], /rol|pendiente de Ralpharma/)
await db.query(`select aprobar_factura($1, 'COSTO DE INSUMOS', 'TRANSFERENCIA')`, [fr])
await falla('el aprobador no confirma cargas de Ralpharma (es tarea de Administración)', `select marcar_factura_ralpharma($1)`, [fr], /rol/)
await como('administracion@verticebi.com')
await db.query(`select marcar_factura_ralpharma($1)`, [fr])
r = await val(`select estado_xubio, ralpharma_por from facturas where id = $1`, [fr])
check('Guido confirma la carga en Ralpharma con su nombre', r.estado_xubio === 'CARGADA_RALPHARMA' && r.ralpharma_por === 'Guido')
await db.exec(`reset role`)

// ================================================================ Espejo de la hoja real (0008)
// Filas con la forma real de la hoja → lib/espejo.ts (la misma traducción que usa /api/espejo) → SQL.
const espejo = await import('../../netlify/functions/lib/espejo.ts')
await db.exec(`reset role`)
const trad = (filas, hoja) => filas.map((x) => (hoja === 'Pagos' ? espejo.pagoDesdeFila(x, x._fila) : espejo.facturaDesdeFila(x, hoja, x._fila))).filter((t) => t.ok).map((t) => t.dato)
const espFact = async (filas, hoja = 'Facturas') => (await val(`select espejar_facturas($1) r`, [JSON.stringify(trad(filas, hoja))])).r
const espPag = async (filas) => (await val(`select espejar_pagos($1) r`, [JSON.stringify(trad(filas, 'Pagos'))])).r
const filaF = (x = {}) => ({ _fila: 2, RECEPTOR: 'BERATUNG SA', PROVEEDOR: 'LIMPIEZA SUR SRL', CUIT_PROVEEDOR: '30-71555555-1', LETRA: 'A', TIPO: 'Factura A',
  NUMERO: '00007-00000350', CAE: '76350274640244', FECHA: '2026-10-20', VENCIMIENTODELPAGO: '2026-11-05', MONEDA: 'ARS', COTIZACION: 1, IMPORTE: 100000, IVA: 21000,
  TOTAL: 121000, CATEGORIA_CONTABLE: 'Gastos Generales', ESTADO_VALIDACION: 'OK', ESTADO_XUBIO: 'SUBIDO', XUBIO_ID_FACTURA: 99887766, ESTADO_APROBACION: 'APROBADA',
  METODO_PAGO: 'Transferencia', ESTADO_PAGO: 'PARA_PAGAR', PORCENTAJE_PAGADO: '', PERCEPCIONES_JSON: '[]', ...x })

const cat = espejo.catalogosDesdeHoja({
  cuentas: [{ CODIGO: 'GASTOS_BANCARIOS', NOMBRE: 'GASTOS BANCARIOS', CUENTA_COMPLETA: 'GASTOS_BANCARIOS GASTOS BANCARIOS', XUBIO_ID: 977973, EMPRESA: 'Beratung S.A.' }],
  origen: [{ EMPRESA: 'Beratung S.A.', TIPO_CUENTA: 2, CUENTA_ID: 665247, NOMBRE: 'Banco Hipotecario CC 0319 BERATUNG', CODIGO: 'BH', USOS_180_DIAS: 548, ULTIMO_USO: '2026-09-29' }],
  porEmpresa: [{ RECEPTOR: 'Beratung S.A.', CUIT: '30-71555555-1', NOMBRE_XUBIO: 'LIMPIEZA SUR S.R.L.', CUENTA_CONTABLE: 'Gastos Generales', SALTAR_XUBIO: '' }],
  emails: [{ CUIT_PROVEEDOR: '30715555551', PROVEEDOR: 'LIMPIEZA SUR SRL', EMAIL: 'cobranzas@limpiezasur.com' }],
  productos: [{ 'Columna A (Nombre)': 'Gastos Generales', 'Columna B (Codigo)': 'GASTOS_GENERALES' }],
})
await db.query(`select espejar_catalogos($1)`, [JSON.stringify(cat)])
check('catálogos: cuenta de origen real con su tipo e id de Xubio', (await val(`select tipo_cuenta, xubio_id from cuentas_origen where empresa_id = 'beratung' and nombre like 'Banco Hipotecario%'`))?.xubio_id === '665247')
check('catálogos: plan de cuentas de Beratung con el nombre completo', (await val(`select count(*)::int n from cuentas_contables where empresa_id = 'beratung' and nombre = 'GASTOS_BANCARIOS GASTOS BANCARIOS'`)).n === 1)
check('catálogos: proveedor por empresa con nombre de Xubio y mail', (await val(`select pe.nombre_xubio, p.email from proveedores_empresa pe join proveedores p on p.id = pe.proveedor_id where p.cuit = '30715555551'`))?.email === 'cobranzas@limpiezasur.com')
await db.query(`select espejar_catalogos($1)`, [JSON.stringify(cat)])
check('catálogos dos veces: no duplica', (await val(`select count(*)::int n from cuentas_origen where empresa_id = 'beratung' and nombre like 'Banco Hipotecario%'`)).n === 1)

let e1 = await espFact([filaF(), filaF({ _fila: 3, NUMERO: '00007-00000351', ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_PAGO: '', ESTADO_XUBIO: '', XUBIO_ID_FACTURA: '' })])
check('espejo de facturas: 2 nuevas', e1.nuevas === 2 && e1.omitidas.length === 0, JSON.stringify(e1))
const fe1 = await val(`select id, estado, gestion, xubio_id, estado_xubio from facturas where numero = 350 and punto_venta = 7`)
const fe2 = await val(`select id, estado, gestion from facturas where numero = 351 and punto_venta = 7`)
check('copiada: la gestiona la hoja, aprobada y subida a Xubio con su id', fe1.gestion === 'HOJA' && fe1.estado === 'PARA_PAGAR' && fe1.estado_xubio === 'SUBIDA' && fe1.xubio_id === '99887766')
check('copiada: auditoría "copiada de la hoja"', (await val(`select count(*)::int n from auditoria where entidad_id = $1 and accion = 'COPIA_HOJA'`, [fe1.id])).n === 1)
e1 = await espFact([filaF(), filaF({ _fila: 3, NUMERO: '00007-00000351', ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_PAGO: '', ESTADO_XUBIO: '', XUBIO_ID_FACTURA: '' })])
check('segunda copia sin cambios: no reescribe nada', e1.nuevas === 0 && e1.actualizadas === 0 && e1.sin_cambios === 2)
e1 = await espFact([filaF({ PORCENTAJE_PAGADO: 50 })])
check('la hoja registra un pago del 50 %: se actualiza', e1.actualizadas === 1 && Number((await val(`select pagado from facturas where id = $1`, [fe1.id])).pagado) === 60500)

// Brian aprueba en el sistema nuevo la pendiente: desde ahí la hoja no la pisa.
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await db.query(`select aprobar_factura($1, 'Gastos Generales', 'TRANSFERENCIA')`, [fe2.id])
await db.exec(`reset role`)
check('aprobada en el sistema nuevo: pasa a gestión SISTEMA', (await val(`select gestion from facturas where id = $1`, [fe2.id])).gestion === 'SISTEMA')
e1 = await espFact([filaF({ _fila: 3, NUMERO: '00007-00000351', ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_PAGO: '', ESTADO_XUBIO: '', XUBIO_ID_FACTURA: '', MOTIVO_VALIDACION: 'cambio en la hoja' })])
check('la hoja sigue diciendo pendiente: no vuelve atrás lo aprobado en el sistema', (await val(`select estado from facturas where id = $1`, [fe2.id])).estado === 'PARA_PAGAR')
e1 = await espFact([filaF({ PORCENTAJE_PAGADO: 50, _fila: 120 })], 'Facturas_Aprobadas')
check('pasó al historial con los mismos datos: no cuenta como cambio, se anota la pestaña', e1.sin_cambios === 1 && (await val(`select hoja from facturas where id = $1`, [fe1.id])).hoja === 'Facturas_Aprobadas')

const filaP = (x = {}) => ({ _fila: 5, ID_PAGO: 'PAGO-1792698005398-0', TIPO_PAGO: 'FACTURA', FACTURA_ASOCIADA: '00007-00000350', PROVEEDOR_DESTINO: 'LIMPIEZA SUR SRL',
  DESCRIPCION_PAGO: 'Pago 50% Factura 00007-00000350', REALIZADO_POR: '', EMPRESA: '', BANCO_ORIGEN: 'Banco Hipotecario', FECHA_PAGO: '2026-10-22', IMPORTE: 60500,
  URL_COMPROBANTE: 'https://drive.google.com/file/d/c/view', ESTADO_CONTABLE: 'PENDIENTE', FORMA_CARGA: 'ORDEN_PAGO', CUENTA_CONTABLE: 'Gastos Generales', CARGADO_POR: 'tesoreria@verticebi.com', ...x })
let ep = await espPag([filaP(), filaP({ _fila: 6, ID_PAGO: 'PAGO-1792698005999-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', IMPORTE: '', ESTADO_EXTRACCION_IA: 'ERROR_1' }),
  filaP({ _fila: 7, ID_PAGO: 'PAGO-1792698006000-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', PROVEEDOR_DESTINO: 'Nadie' })])
const pe1 = await val(`select id, empresa_id, proveedor_id, estado, gestion, importe from pagos where hoja_id = 'PAGO-1792698005398-0'`)
check('espejo de pagos: empresa y proveedor tomados de la factura vinculada', pe1?.empresa_id === 'beratung' && pe1?.proveedor_id && pe1?.gestion === 'HOJA' && pe1?.estado === 'CARGADO')
check('pago vinculado a su factura', (await val(`select count(*)::int n from pagos_facturas where pago_id = $1 and factura_id = $2`, [pe1.id, fe1.id])).n === 1)
check('el vínculo no toca lo pagado de la factura (lo sigue diciendo la hoja)', Number((await val(`select pagado from facturas where id = $1`, [fe1.id])).pagado) === 60500)
check('pago sin empresa ni factura: omitido con motivo', ep.omitidas.length === 2 && ep.omitidas.every((o) => /empresa/.test(o.motivo)), JSON.stringify(ep.omitidas))
await falla('un pago cargado en el sistema nunca puede tener importe 0',
  `insert into pagos (empresa_id, fecha, importe, medio, cargado_por) values ('beratung', '2026-10-01', 0, 'TRANSFERENCIA', 'x')`, [], /pagos_importe_check/)
ep = await espPag([filaP({ _fila: 6, ID_PAGO: 'PAGO-1792698005999-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', IMPORTE: '', EMPRESA: 'BERATUNG S.A.', ESTADO_EXTRACCION_IA: 'ERROR_1' })])
check('pago sin leer todavía (importe 0) se copia igual', ep.nuevas === 1 && Number((await val(`select importe from pagos where hoja_id = 'PAGO-1792698005999-0'`)).importe) === 0)

// Guido lo prueba en seco en el sistema nuevo: queda revisado, pero lo sigue gestionando la hoja (0014).
// Hasta 0013 la prueba lo pasaba a SISTEMA y la copia dejaba de actualizarlo sin que se hubiera contabilizado nada.
await db.query(`select marcar_pago_revisado($1, 'Gastos Generales', 'ORDEN_PAGO', 'En seco', 'Guido', 'ADMINISTRACION')`, [pe1.id])
r = await val(`select estado, gestion, cuenta_contable from pagos where id = $1`, [pe1.id])
check('prueba en seco: el pago queda REVISADO y sigue siendo de la hoja', r.estado === 'REVISADO' && r.gestion === 'HOJA' && r.cuenta_contable === 'Gastos Generales', JSON.stringify(r))
check('prueba en seco: queda en la auditoría', (await val(`select count(*)::int n from auditoria where entidad_id = $1 and accion = 'REVISADO_EN_SECO'`, [pe1.id])).n === 1)
ep = await espPag([filaP({ CUENTA_CONTABLE: 'Otra cuenta', OBSERVACIONES_TESORERIA: 'cambio en la hoja' })])
r = await val(`select estado, cuenta_contable, gestion from pagos where id = $1`, [pe1.id])
check('después de una prueba en seco la hoja sigue mandando: su cambio se copia', ep.actualizadas === 1 && r.cuenta_contable === 'Otra cuenta' && r.estado === 'CARGADO' && r.gestion === 'HOJA', JSON.stringify(r))
// Un pago del sistema nuevo probado en seco sigue siendo del sistema.
const pSis = (await val(`select id from pagos where gestion = 'SISTEMA' and estado = 'CARGADO' and empresa_id = 'beratung' limit 1`)).id
await db.query(`select marcar_pago_revisado($1, 'COSTO DE INSUMOS', 'ORDEN_PAGO', 'En seco', 'Guido', 'ADMINISTRACION')`, [pSis])
r = await val(`select estado, gestion from pagos where id = $1`, [pSis])
check('prueba en seco de un pago del sistema: sigue siendo del sistema', r.estado === 'REVISADO' && r.gestion === 'SISTEMA')
await falla('no se prueba en seco un pago que no está pendiente', `select marcar_pago_revisado($1, 'x', 'ORDEN_PAGO', 'En seco', 'Guido', 'ADMINISTRACION')`, ['00000000-0000-0000-0000-000000000000'], /no está pendiente/)
// La contabilización real sí lo pasa al sistema: desde ahí la hoja no lo pisa.
const pe2 = await val(`select id from pagos where hoja_id = 'PAGO-1792698005999-0'`)
await db.query(`update pagos set importe = 500 where id = $1`, [pe2.id])
await db.query(`update pagos set gestion = 'HOJA' where id = $1`, [pe2.id])
await db.query(`select marcar_pago_contabilizado($1, 'Gastos Generales', 'SALIDA_FONDOS', 'OP-9001', 'Guido', 'ADMINISTRACION')`, [pe2.id])
check('contabilizado de verdad en el sistema nuevo: gestión SISTEMA', (await val(`select gestion from pagos where id = $1`, [pe2.id])).gestion === 'SISTEMA')
ep = await espPag([filaP({ _fila: 6, ID_PAGO: 'PAGO-1792698005999-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', IMPORTE: 700, EMPRESA: 'BERATUNG S.A.', CUENTA_CONTABLE: 'Otra cuenta' })])
r = await val(`select estado, cuenta_contable, importe from pagos where id = $1`, [pe2.id])
check('la hoja cambia un pago contabilizado en el sistema: no lo pisa', r.estado === 'CONTABILIZADO' && r.cuenta_contable === 'Gastos Generales' && Number(r.importe) === 500, JSON.stringify(r))
ep = await espPag([filaP({ _fila: 8, ID_PAGO: 'PAGO-1792698007000-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', EMPRESA: 'Droguería Robles', ESTADO_CONTABLE: 'CONTABILIZADA', ESTADO_XUBIO_PAGO: 'SIN_ERP_XUBIO' })])
check('pago de Robles contabilizado en producción sin cargar en Ralpharma: bandeja Ralpharma', (await val(`select estado from pagos where hoja_id = 'PAGO-1792698007000-0'`)).estado === 'PENDIENTE_RALPHARMA')

const malo = trad([filaF({ NUMERO: '00007-00000999' })], 'Facturas').map((x) => ({ ...x, estado: 'INVENTADO' }))
const rMalo = (await val(`select espejar_facturas($1) r`, [JSON.stringify(malo)])).r
check('una fila que la base rechaza se omite con el motivo, sin cortar la copia', rMalo.omitidas.length === 1 && /estado_factura|invalid/i.test(rMalo.omitidas[0].motivo), rMalo.omitidas[0]?.motivo)
for (const r of ['anon', 'authenticated'])
  check(`${r} NO puede copiar facturas de la hoja`, !(await val(`select has_function_privilege($1, 'espejar_facturas(jsonb)', 'execute') p`, [r])).p)
check('los usuarios ven el estado de la copia', (await val(`select has_table_privilege('authenticated', 'espejo_estado', 'select') p`)).p)

// ================================================================ Edición a mano de la factura (0009)
await db.exec(`reset role`)
const fed = (await val(`select ingresar_factura($1) id`, [factura({ cuit_proveedor: '30-71666666-2', proveedor: 'Imprenta Sur', numero: 4401, total: 121000, neto: 100000, iva: 21000, cae: '86439916039416' })])).id
const fotra = (await val(`select ingresar_factura($1) id`, [factura({ cuit_proveedor: '30-71666666-2', proveedor: 'Imprenta Sur', numero: 4402, total: 121000, neto: 100000, iva: 21000, cae: '86439916039416' })])).id
const datosEd = (x = {}) => ({ empresa_id: 'beratung', proveedor: 'Imprenta Sur S.A.', cuit_proveedor: '30-71666666-2', tipo: 'Factura A', letra: 'a', punto_venta: 5, numero: 4401,
  fecha: '2026-10-01', vencimiento: '2026-10-31', moneda: 'ARS', cotizacion: 1, neto: 100000, iva: 21000, exento: 0, percepciones_json: [{ nombre: 'Percepción IIBB CABA', importe: 1500 }],
  total: 122500, cae: '86439916039416', cae_vencimiento: '2026-11-07', categoria_vertice: 'PROVEEDOR', cuenta_contable: 'Gastos Generales', codigo_producto: 'GASTOS_GENERALES', ...x })
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await falla('Tesorería no edita facturas', `select editar_factura($1, $2)`, [fed, JSON.stringify(datosEd())], /rol/)
await como('aprobador@verticebi.com')
let re = (await val(`select editar_factura($1, $2) r`, [fed, JSON.stringify(datosEd({ total: 130000 }))])).r
let fEd = await val(`select estado, validacion_ok, motivo_validacion, gestion from facturas where id = $1`, [fed])
check('edición que no cierra el total: pasa a Excepciones con el motivo', re.estado === 'ERROR' && fEd.estado === 'ERROR' && !fEd.validacion_ok && /Descuadre/.test(fEd.motivo_validacion), fEd.motivo_validacion)
check('editada a mano: la gestiona el sistema (la copia de la hoja no la pisa)', fEd.gestion === 'SISTEMA')
re = (await val(`select editar_factura($1, $2) r`, [fed, JSON.stringify(datosEd())])).r
fEd = await val(`select estado, validacion_ok, percepciones, total, letra, p.nombre from facturas f join proveedores p on p.id = f.proveedor_id where f.id = $1`, [fed])
check('corregida (neto + IVA + percepción = total): vuelve a Pendientes', re.estado === 'PENDIENTE_APROBACION' && fEd.estado === 'PENDIENTE_APROBACION' && fEd.validacion_ok)
check('percepciones sumadas desde la lista, letra en mayúscula, nombre del proveedor', Number(fEd.percepciones) === 1500 && Number(fEd.total) === 122500 && fEd.letra === 'A' && fEd.nombre === 'Imprenta Sur S.A.')
check('auditoría de la edición con lo que cambió, antes y después', (await val(`select count(*)::int n from auditoria where entidad_id = $1 and accion = 'EDICION' and detalle like '%total%' and antes is not null and despues is not null`, [fed])).n >= 1)
re = (await val(`select editar_factura($1, $2) r`, [fed, JSON.stringify(datosEd({ cae: '123' }))])).r
check('CAE corto: queda en Excepciones con el motivo', re.estado === 'ERROR' && (await val(`select motivo_validacion m from facturas where id = $1`, [fed])).m?.includes('CAE'))
await db.query(`select editar_factura($1, $2)`, [fed, JSON.stringify(datosEd())])
await falla('mismo proveedor, tipo y número que otra factura: mensaje claro', `select editar_factura($1, $2)`, [fotra, JSON.stringify(datosEd())], /Ya hay otra factura/)
await falla('CUIT incompleto', `select editar_factura($1, $2)`, [fed, JSON.stringify(datosEd({ cuit_proveedor: '30-7166' }))], /11 dígitos/)
await db.exec(`reset role`)
await db.query(`update facturas set estado = 'PAGADA_PARCIAL', pagado = 1000 where id = $1`, [fotra])
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await falla('factura con pagos: no se edita', `select editar_factura($1, $2)`, [fotra, JSON.stringify(datosEd({ numero: 4402 }))], /sin pagos/)
await db.exec(`reset role`)
check('anon no puede editar facturas', !(await val(`select has_function_privilege('anon', 'editar_factura(uuid,jsonb)', 'execute') p`)).p)

// ================================================================ Aislamiento por empresa (0010)
await db.exec(`reset role`)
check('los usuarios que ya existían siguen viendo todas las empresas', (await val(`select bool_and(todas_empresas) b from usuarios where email in ('tecnologia@verticebi.com', 'tesoreria@verticebi.com', 'administracion@verticebi.com')`)).b === true)
await db.exec(`insert into usuarios (email, nombre, rol) values
  ('aprob.india@verticebi.com', 'Aprobador India', 'APROBADOR'),
  ('teso.india@verticebi.com', 'Tesorería India', 'TESORERIA'),
  ('nuevo@verticebi.com', 'Sin asignar', 'APROBADOR')`)
await db.exec(`insert into usuarios_empresas (email, empresa_id) values ('aprob.india@verticebi.com', 'india'), ('teso.india@verticebi.com', 'india')`)
// Una factura y un pago de cada empresa, cargados por el servidor (sin control: no es una persona).
const fBer = (await val(`select ingresar_factura($1) id`, [factura({ numero: 9001, total: 1000, neto: 1000, iva: 0 })])).id
const fInd = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'india', numero: 9002, total: 2000, neto: 2000, iva: 0 })])).id
check('el servidor (ingesta) sigue escribiendo en cualquier empresa', !!fBer && !!fInd)
await db.query(`update facturas set pdf_path = 'aisl/ber.pdf' where id = $1`, [fBer])
await db.query(`update facturas set pdf_path = 'aisl/ind.pdf' where id = $1`, [fInd])
await db.exec(`insert into storage.objects (bucket_id, name) values ('facturas', 'aisl/ber.pdf'), ('facturas', 'aisl/ind.pdf')`)
const nEmpresas = (await val(`select count(*)::int n from empresas`)).n

await db.exec(`set role authenticated`)
await como('aprob.india@verticebi.com')
check('usuario de India ve solo su empresa', (await db.query(`select id from empresas`)).rows.map((x) => x.id).join() === 'india')
check('usuario de India no ve facturas de otras empresas', (await val(`select count(*)::int n from facturas where empresa_id <> 'india'`)).n === 0)
check('usuario de India sí ve las facturas de India', (await val(`select count(*)::int n from facturas where id = $1`, [fInd])).n === 1)
check('usuario de India no ve pagos de otras empresas', (await val(`select count(*)::int n from pagos where empresa_id <> 'india'`)).n === 0)
check('la vista del flujo solo trae India', (await val(`select count(*)::int n from export_cashflow where empresa <> 'INDIA ADV S.A.'`)).n === 0)
check('auditoría: no ve la de facturas de otras empresas', (await val(`select count(*)::int n from auditoria where entidad_id = $1`, [fBer])).n === 0)
check('auditoría: sí ve la de sus facturas', (await val(`select count(*)::int n from auditoria where entidad_id = $1`, [fInd])).n >= 1)
check('documentos sin empresa (sin leer) no los ve', (await val(`select count(*)::int n from documentos where factura_id is null`)).n === 0)
check('PDF de otra empresa: no lo ve', (await val(`select count(*)::int n from storage.objects where name = 'aisl/ber.pdf'`)).n === 0)
check('PDF de su empresa: sí lo ve', (await val(`select count(*)::int n from storage.objects where name = 'aisl/ind.pdf'`)).n === 1)
check('ve su propio usuario y no al resto del equipo', (await db.query(`select email from usuarios`)).rows.map((x) => x.email).join() === 'aprob.india@verticebi.com')
check('las cuentas comunes (sin empresa) las sigue viendo', (await val(`select count(*)::int n from cuentas_contables where empresa_id is null`)).n === nCuentas)
await falla('no puede aprobar una factura de Beratung', `select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fBer], /acceso a la empresa beratung/)
await falla('no puede rechazar una factura de Beratung', `select rechazar_factura($1, 'no')`, [fBer], /acceso a la empresa beratung/)
await falla('no puede editar una factura de Beratung', `select editar_factura($1, $2)`, [fBer, JSON.stringify(datosEd({ numero: 9101 }))], /acceso a la empresa/)
await db.query(`select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fInd])
check('sí aprueba una factura de India', (await val(`select estado from facturas where id = $1`, [fInd])).estado === 'PARA_PAGAR')
await falla('no puede reintentar un documento sin empresa', `select reintentar_documento($1)`, [d5.id], /acceso a este documento/)

await como('teso.india@verticebi.com')
await falla('Tesorería de India no carga pagos en Beratung', `select registrar_pago($1)`, [pago({ importe: 10 })], /acceso a la empresa beratung/)
await db.query(`select registrar_pago($1)`, [pago({ empresa_id: 'india', importe: 2000, factura_ids: [fInd] })])
check('Tesorería de India sí paga su factura', (await val(`select estado from facturas where id = $1`, [fInd])).estado === 'PAGADA')

await como('nuevo@verticebi.com')
check('usuario nuevo sin empresas asignadas no ve ninguna', (await val(`select count(*)::int n from empresas`)).n === 0 && (await val(`select count(*)::int n from facturas`)).n === 0)

await como('aprobador@verticebi.com')
check('usuario con todas_empresas sigue viendo las 8', (await val(`select count(*)::int n from empresas`)).n === nEmpresas)
check('y ve los documentos sin empresa', (await val(`select count(*)::int n from documentos where factura_id is null`)).n > 0)
await db.exec(`reset role`)

check('servidor: usuario_ve_empresa dice que India no ve Beratung', (await val(`select usuario_ve_empresa('aprob.india@verticebi.com', 'beratung') v`)).v === false)
check('servidor: usuario_ve_empresa dice que India ve India', (await val(`select usuario_ve_empresa('APROB.INDIA@verticebi.com', 'india') v`)).v === true)
await db.exec(`update usuarios set activo = false where email = 'aprob.india@verticebi.com'`)
check('usuario dado de baja no ve ninguna empresa', (await val(`select usuario_ve_empresa('aprob.india@verticebi.com', 'india') v`)).v === false)
check('authenticated no puede consultar usuario_ve_empresa de otros', !(await val(`select has_function_privilege('authenticated', 'usuario_ve_empresa(text,text)', 'execute') p`)).p)
check('authenticated no escribe en usuarios_empresas', !(await val(`select has_table_privilege('authenticated', 'usuarios_empresas', 'insert') p`)).p)

// ================================================================ NC, aprobar ya pagada, anular pago (0011)
await db.exec(`reset role`)
await db.exec(`update usuarios set activo = true where email = 'aprob.india@verticebi.com'`)
const fac = (n, extra = {}) => factura({ empresa_id: 'ysd', cuit_proveedor: '30-70000001-9', proveedor: 'Prov NC', numero: n, total: 1000, neto: 1000, iva: 0, ...extra })
const fFac = (await val(`select ingresar_factura($1) id`, [fac(5001)])).id
const fNc = (await val(`select ingresar_factura($1) id`, [fac(5002, { tipo: 'Nota de Crédito A', total: 300, neto: 300 })])).id
const fOtroProv = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'ysd', cuit_proveedor: '30-70000002-7', proveedor: 'Otro', numero: 5003, total: 500, neto: 500, iva: 0 })])).id
check('NC nueva arranca con todo su total como saldo', Number((await val(`select saldo_nc from facturas where id = $1`, [fNc])).saldo_nc) === 300)
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
for (const id of [fFac, fOtroProv]) await db.query(`select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [id])
await como('tesoreria@verticebi.com')
await falla('NC sin aprobar no se aplica', `select aplicar_nota_credito($1, $2, 100)`, [fNc, fFac], /aprobada/)
await como('aprobador@verticebi.com')
await db.query(`select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fNc])
await como('tesoreria@verticebi.com')
await falla('NC de otro proveedor no se aplica', `select aplicar_nota_credito($1, $2, 100)`, [fNc, fOtroProv], /otro proveedor/)
await falla('NC por más de su saldo no se aplica', `select aplicar_nota_credito($1, $2, 301)`, [fNc, fFac], /saldo/)
await falla('NC a otra NC no se aplica', `select aplicar_nota_credito($1, $2, 10)`, [fNc, fNc], /no a otra nota/)
await como('direccion@verticebi.com')
await falla('Dirección no aplica NC', `select aplicar_nota_credito($1, $2, 100)`, [fNc, fFac], /rol/)
await como('tesoreria@verticebi.com')
await db.query(`select aplicar_nota_credito($1, $2, 200)`, [fNc, fFac])
r = await val(`select f.estado, f.pagado, n.saldo_nc, n.estado nc_estado from facturas f, facturas n where f.id = $1 and n.id = $2`, [fFac, fNc])
check('NC parcial: la factura queda PAGADA_PARCIAL y la NC con saldo 100', r.estado === 'PAGADA_PARCIAL' && Number(r.pagado) === 200 && Number(r.saldo_nc) === 100 && r.nc_estado === 'PARA_PAGAR', JSON.stringify(r))
await db.query(`select aplicar_nota_credito($1, $2, 100)`, [fNc, fFac])
r = await val(`select n.saldo_nc, n.estado from facturas n where n.id = $1`, [fNc])
check('NC agotada queda PAGADA', Number(r.saldo_nc) === 0 && r.estado === 'PAGADA')
check('registro de NC aplicadas: 2 renglones', (await val(`select count(*)::int n from notas_credito_aplicadas where nc_id = $1`, [fNc])).n === 2)
check('la NC no se proyecta como egreso en el flujo', (await val(`select count(*)::int n from export_cashflow where referencia = $1`, [fNc])).n === 0)
await como('teso.india@verticebi.com')
await falla('Tesorería de India no aplica NC en YSD', `select aplicar_nota_credito($1, $2, 1)`, [fNc, fFac], /acceso a la empresa ysd/)

// --- Aprobar ya pagada
await db.exec(`reset role`)
const yp = async (n) => (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'ysd', numero: n, total: 800, neto: 800, iva: 0 })])).id
const fYa1 = await yp(6001), fYa2 = await yp(6002), fYa3 = await yp(6003), fYa4 = await yp(6004)
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await falla('Tesorería no aprueba ya pagada', `select aprobar_factura_ya_pagada($1, 'SEGUROS', 'TRANSFERENCIA', '{}')`, [fYa1], /rol/)
await como('aprobador@verticebi.com')
let res = (await val(`select aprobar_factura_ya_pagada($1, 'SEGUROS', 'TRANSFERENCIA', $2) r`, [fYa1, { ya_en_xubio: true }])).r
r = await val(`select f.estado, p.estado pe, p.xubio_id, p.importe from facturas f join pagos_facturas pf on pf.factura_id = f.id join pagos p on p.id = pf.pago_id where f.id = $1`, [fYa1])
check('ya pagada y ya en Xubio: factura PAGADA y pago CONTABILIZADO sin envío', res === 'CONTABILIZADO' && r.estado === 'PAGADA' && r.pe === 'CONTABILIZADO' && r.xubio_id === 'CARGADO_A_MANO' && Number(r.importe) === 800)
res = (await val(`select aprobar_factura_ya_pagada($1, 'SEGUROS', 'TRANSFERENCIA', $2) r`, [fYa2, { cuenta_origen: 'Banco Galicia CC $', fecha: '2026-11-10' }])).r
r = await val(`select f.estado, p.estado pe, p.cuenta_origen, p.fecha::text fecha from facturas f join pagos_facturas pf on pf.factura_id = f.id join pagos p on p.id = pf.pago_id where f.id = $1`, [fYa2])
check('ya pagada con banco: factura PAGADA y pago para Contabilización', res === 'PARA_CONTABILIZAR' && r.estado === 'PAGADA' && r.pe === 'CARGADO' && r.cuenta_origen === 'Banco Galicia CC $' && r.fecha === '2026-11-10')
res = (await val(`select aprobar_factura_ya_pagada($1, 'SEGUROS', 'TRANSFERENCIA', '{}') r`, [fYa3])).r
r = await val(`select estado, ya_pagada_segun_admin m, (select count(*)::int from pagos_facturas where factura_id = $1) n from facturas where id = $1`, [fYa3])
check('ya pagada sin banco: queda Para pagar marcada y sin pago', res === 'PARA_PAGAR' && r.estado === 'PARA_PAGAR' && /falta el comprobante/.test(r.m) && r.n === 0)
await falla('ya pagada con cheque sin número falla', `select aprobar_factura_ya_pagada($1, 'SEGUROS', 'CHEQUE', $2)`, [fYa4, { cuenta_origen: 'Banco Galicia CC $' }], /cheque/)
check('la falla no dejó la factura aprobada a medias', (await val(`select estado from facturas where id = $1`, [fYa4])).estado === 'PENDIENTE_APROBACION')
await como('tesoreria@verticebi.com')
await db.query(`select registrar_pago($1)`, [pago({ empresa_id: 'ysd', importe: 800, factura_ids: [fYa3] })])
check('al pagarla, la marca de ya pagada se limpia', (await val(`select ya_pagada_segun_admin m from facturas where id = $1`, [fYa3])).m === null)

// --- Anular pago
await db.exec(`reset role`)
const fAn = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'ysd', numero: 7001, total: 1000, neto: 1000, iva: 0 })])).id
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await db.query(`select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fAn])
await como('tesoreria@verticebi.com')
const pAn1 = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'ysd', importe: 400, factura_ids: [fAn] })])).id
const pAn2 = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'ysd', importe: 600, factura_ids: [fAn] })])).id
check('dos pagos cancelan la factura', (await val(`select estado from facturas where id = $1`, [fAn])).estado === 'PAGADA')
await falla('anular sin motivo falla', `select anular_pago($1, ' ')`, [pAn2], /motivo/)
await db.query(`select anular_pago($1, 'Comprobante equivocado')`, [pAn2])
r = await val(`select f.estado, f.pagado, p.estado pe, p.anulado_por from facturas f, pagos p where f.id = $1 and p.id = $2`, [fAn, pAn2])
check('anular devuelve lo aplicado: factura PAGADA_PARCIAL con 400', r.estado === 'PAGADA_PARCIAL' && Number(r.pagado) === 400 && r.pe === 'ANULADO' && r.anulado_por === 'Vivi', JSON.stringify(r))
await db.query(`select anular_pago($1, 'Duplicado')`, [pAn1])
check('anulando todo vuelve a PARA_PAGAR', (await val(`select estado, pagado from facturas where id = $1`, [fAn])).estado === 'PARA_PAGAR')
await falla('un pago anulado no se anula dos veces', `select anular_pago($1, 'otra vez')`, [pAn1], /no se anula/)
check('el flujo no cuenta pagos anulados', (await val(`select count(*)::int n from export_cashflow where estado = 'REAL' and egreso in (400, 600) and empresa = 'YSD Pharma S.A.'`)).n === 0)
check('el flujo vuelve a proyectar la factura', (await val(`select count(*)::int n from export_cashflow where referencia = $1`, [fAn])).n === 1)
await db.exec(`reset role`)
const pCont = (await val(`select id from pagos where estado = 'CONTABILIZADO' and empresa_id = 'ysd' limit 1`)).id
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await falla('un pago contabilizado no se anula acá', `select anular_pago($1, 'x')`, [pCont], /Xubio/)
await como('teso.india@verticebi.com')
await falla('Tesorería de India no anula pagos de YSD (ni ve su estado)', `select anular_pago($1, 'x')`, [pCont], /acceso a la empresa ysd/)
await como('aprob.india@verticebi.com')
await falla('Aprobador no anula pagos', `select anular_pago($1, 'x')`, [pAn1], /rol/)
await db.exec(`reset role`)
check('auditoría: NC, ya pagada y anulación quedan registradas', (await val(`select count(distinct accion)::int n from auditoria where accion in ('NC_APLICADA', 'APROBADA_YA_PAGADA', 'PAGO_ANULADO')`)).n === 3)

// ================================================================ Mails, cheques y flujo (0012)
await db.exec(`reset role`)
const provMail = (await val(`select proveedor_id id from facturas where id = $1`, [fAn])).id
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await falla('mail inválido no se guarda', `select guardar_email_proveedor($1, 'sin-arroba')`, [provMail], /inválido/)
await db.query(`select guardar_email_proveedor($1, ' Pagos@Proveedor.com.ar ')`, [provMail])
check('mail del proveedor guardado en minúscula', (await val(`select email from proveedores where id = $1`, [provMail])).email === 'pagos@proveedor.com.ar')
await como('direccion@verticebi.com')
await falla('Dirección no guarda mails', `select guardar_email_proveedor($1, 'a@b.com')`, [provMail], /rol/)
await como('tesoreria@verticebi.com')
check('marcar mail preparado devuelve cuántas', (await val(`select marcar_mail_preparado($1) n`, [[fYa2]])).n === 1)
r = await val(`select f.mail_enviado, p.mail_proveedor_en from facturas f join pagos_facturas pf on pf.factura_id = f.id join pagos p on p.id = pf.pago_id where f.id = $1`, [fYa2])
check('la factura queda "Preparado en Gmail" y el pago con fecha de mail', /^Preparado en Gmail \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(r.mail_enviado) && r.mail_proveedor_en !== null, r.mail_enviado)
await como('teso.india@verticebi.com')
await falla('Tesorería de India no marca mails de YSD', `select marcar_mail_preparado($1)`, [[fYa2]], /acceso a la empresa ysd/)
check('authenticated no ve los cheques pendientes ni el flujo (solo el servidor)',
  !(await val(`select has_function_privilege('authenticated', 'cheques_para_cashflow(timestamptz)', 'execute') p`)).p &&
  !(await val(`select has_function_privilege('authenticated', 'flujo_datos()', 'execute') p`)).p)

// --- Cheques
await db.exec(`reset role`)
const fCh = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'india', numero: 8001, total: 5000, neto: 5000, iva: 0 })])).id
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await db.query(`select aprobar_factura($1, 'SEGUROS', 'ECHEQ', 30)`, [fCh])
await como('tesoreria@verticebi.com')
const pCh = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'india', importe: 5000, medio: 'ECHEQ', numero_cheque: '0012345', fecha_acreditacion: '2026-12-15', factura_ids: [fCh] })])).id
const pSinFecha = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'india', importe: 10, descripcion: 'transferencia' })])).id
await db.exec(`reset role`)
let ch = (await db.query(`select * from cheques_para_cashflow('2000-01-01')`)).rows
check('cheque con fecha de cobro aparece para el Cash Flow', ch.some((x) => x.pago_id === pCh && x.numero === '0012345' && x.deposito.toISOString().slice(0, 10) === '2026-12-15' && Number(x.importe) === 5000))
check('un pago sin cheque no aparece', !ch.some((x) => x.pago_id === pSinFecha))
check('cargado antes de la fecha de activación no aparece', !(await db.query(`select * from cheques_para_cashflow(now() + interval '1 day')`)).rows.some((x) => x.pago_id === pCh))
await db.query(`update pagos set gestion = 'HOJA' where id = $1`, [pCh])
check('pago de la hoja no aparece (lo pasa el Apps Script de producción)', !(await db.query(`select * from cheques_para_cashflow('2000-01-01')`)).rows.some((x) => x.pago_id === pCh))
await db.query(`update pagos set gestion = 'SISTEMA' where id = $1`, [pCh])
check('marcar resultado', (await val(`select marcar_cheques_cashflow($1) n`, [JSON.stringify([{ pago_id: pCh, estado: 'AGREGADO 18/11/2026 10:00' }])])).n === 1)
check('ya marcado no vuelve a aparecer', !(await db.query(`select * from cheques_para_cashflow('2000-01-01')`)).rows.some((x) => x.pago_id === pCh))
check('la marca no se pisa', (await val(`select marcar_cheques_cashflow($1) n`, [JSON.stringify([{ pago_id: pCh, estado: 'ERROR: otra' }])])).n === 0)

// --- Flujo
const fl = (await val(`select flujo_datos() d`)).d
const filaFac = fl.facturas[0]
check('flujo: facturas con los encabezados de la hoja', !!filaFac && 'ESTADO_PAGO' in filaFac && 'VENCIMIENTODELPAGO' in filaFac && 'RECEPTOR' in filaFac)
check('flujo: solo facturas para pagar', fl.facturas.every((x) => x.ESTADO_PAGO === 'PARA_PAGAR' && x.ESTADO_APROBACION === 'APROBADA'))
check('flujo: cheque a N días como lo lee FlujoCaja.gs', fl.facturas.every((x) => !/^CHEQUE|^ECHEQ/.test(x.METODO_PAGO) || /^CHEQUE \d+ DIAS$|^ECHEQ$|^CHEQUE$/.test(x.METODO_PAGO)))
const pagoFl = fl.pagos.find((x) => x.ID_PAGO === pCh)
check('flujo: pagos con número de cheque y fecha de cobro', pagoFl && pagoFl.NUMERO_CHEQUE === '0012345' && pagoFl.FECHA_VTO_CHEQUE === '2026-12-15' && pagoFl.TIPO_CHEQUE === 'ECHEQ' && pagoFl.FACTURA_ASOCIADA === '8001')
check('flujo: anulados marcados ANULADO', fl.pagos.some((x) => x.ID_PAGO === pAn1 && x.ESTADO_CONTABLE === 'ANULADO'))

// ================================================================ Control que falla cerrado y documentos por empresa (0013)
await db.exec(`reset role`)
check('conexión directa (editor SQL, migraciones) cuenta como servidor', (await val(`select es_servidor() s`)).s === true)
await db.exec(`set role postgres`)
check('…también si el editor pone el rol postgres a mano', (await val(`select es_servidor() s`)).s === true)
await db.exec(`reset role`)
// Un rol que no es ni el de las personas ni el del servidor: el control por empresa tiene que actuar igual.
// Antes de 0013 solo actuaba si el rol se llamaba 'authenticated' y con cualquier otro dejaba pasar todo.
await db.exec(`create role rol_nuevo; grant usage on schema public, auth to rol_nuevo; grant execute on function es_servidor() to rol_nuevo`)
await db.exec(`set role rol_nuevo`)
check('un rol desconocido no cuenta como servidor', (await val(`select es_servidor() s`)).s === false)
await como('aprob.india@verticebi.com')
await falla('rol desconocido: el control de empresa rechaza la aprobación de otra empresa', `select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fBer], /acceso a la empresa beratung/)
await falla('rol desconocido: tampoco deja tocar un documento sin empresa', `select reintentar_documento($1)`, [d5.id], /acceso a este documento/)
await como('teso.india@verticebi.com')
await falla('rol desconocido: no carga pagos en otra empresa', `select registrar_pago($1)`, [pago({ importe: 10 })], /acceso a la empresa beratung/)
await falla('rol desconocido: no anula pagos de otra empresa (ni ve su estado)', `select anular_pago($1, 'x')`, [pCont], /acceso a la empresa ysd/)
await como('')
await falla('rol desconocido y sin sesión: no pasa nada', `select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fBer], /no habilitada|acceso/)
await db.exec(`reset role`)
check('la factura de Beratung sigue sin aprobar', (await val(`select estado from facturas where id = $1`, [fBer])).estado === 'PENDIENTE_APROBACION')
check('las personas no pueden ejecutar es_servidor()', !(await val(`select has_function_privilege('authenticated', 'es_servidor()', 'execute') p`)).p && !(await val(`select has_function_privilege('anon', 'es_servidor()', 'execute') p`)).p)
// Para preguntarle a la función qué responde con cada rol hay que darles permiso un momento.
await db.exec(`grant execute on function es_servidor() to authenticated, anon`)
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
check('una persona con sesión no cuenta como servidor', (await val(`select es_servidor() s`)).s === false)
await db.exec(`reset role; set role anon`)
await como('')
check('sin sesión (anon) tampoco cuenta como servidor', (await val(`select es_servidor() s`)).s === false)
await db.exec(`reset role`)
await db.exec(`revoke execute on function es_servidor() from authenticated, anon`)

// El servidor de verdad entra con el rol service_role: ingesta, copia de la hoja y cola siguen andando.
await db.exec(`set role service_role`)
await como('')
check('service_role cuenta como servidor', (await val(`select es_servidor() s`)).s === true)
const fSrv = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'controlb', numero: 9201, total: 100, neto: 100, iva: 0 })])).id
check('service_role: la ingesta escribe en cualquier empresa', !!fSrv)
e1 = await espFact([filaF({ _fila: 40, NUMERO: '00007-00000360' })])
check('service_role: la copia de la hoja crea facturas', e1.nuevas === 1 && e1.omitidas.length === 0, JSON.stringify(e1))
e1 = await espFact([filaF({ _fila: 40, NUMERO: '00007-00000360', PORCENTAJE_PAGADO: 25 })])
check('service_role: la copia de la hoja actualiza lo que gestiona la hoja', e1.actualizadas === 1 && e1.omitidas.length === 0, JSON.stringify(e1))
ep = await espPag([filaP({ _fila: 41, ID_PAGO: 'PAGO-1792698009000-0', FACTURA_ASOCIADA: '00007-00000360', IMPORTE: 1000 })])
check('service_role: la copia de la hoja crea pagos', ep.nuevas === 1 && ep.omitidas.length === 0, JSON.stringify(ep))
const dSrv = await val(`select * from registrar_documento($1)`, [doc('msg-srv')])
await db.query(`select tomar_documento($1)`, [dSrv.id])
check('service_role: un documento de Gmail (sin lista de empresas) se carga en cualquier empresa',
  !!(await val(`select guardar_factura_leida($1, $2) id`, [dSrv.id, leida({ empresa_id: 'controlb', numero: 9202 })])).id)

// Documento subido por una persona: lleva las empresas para las que se puede cargar.
const dInd = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'subida-india.pdf'), origen: 'MANUAL', empresas_permitidas: ['india'] }])
check('el documento guarda para qué empresas se subió', (await val(`select empresas_permitidas p from documentos where id = $1`, [dInd.id])).p.join() === 'india')
check('un documento de Gmail no lleva lista', (await val(`select empresas_permitidas p from documentos where id = $1`, [dSrv.id])).p === null)
await db.query(`select tomar_documento($1)`, [dInd.id])
await falla('subido para India y la factura es de Beratung: no se guarda', `select guardar_factura_leida($1, $2)`, [dInd.id, leida({ empresa_id: 'beratung', numero: 9203 })], /no tiene acceso a esa empresa/)
// leida() sin cambios es la factura 777 de India del principio; en Beratung, la 1001 ya existe con otro proveedor: se usa una que exista.
await db.query(`select ingresar_factura($1)`, [factura({ cuit_proveedor: '20123456786', proveedor: 'Distribuidora Nueva SRL', punto_venta: 3, numero: 9204, total: 1210, neto: 1000, iva: 210 })])
await falla('…ni se entera de que esa factura ya estaba cargada en Beratung', `select guardar_factura_leida($1, $2)`, [dInd.id, leida({ empresa_id: 'beratung', numero: 9204 })], /no tiene acceso a esa empresa/)
check('…y el documento no quedó apuntando a una factura de Beratung', (await val(`select estado, factura_id from documentos where id = $1`, [dInd.id])).factura_id === null)
const fDoc = (await val(`select guardar_factura_leida($1, $2) id`, [dInd.id, leida({ numero: 9205 })])).id
check('subido para India y la factura es de India: se guarda', (await val(`select empresa_id from facturas where id = $1`, [fDoc])).empresa_id === 'india')
await db.exec(`reset role`)

check('empresas que ve una persona asignada a India', (await val(`select empresas_visibles_de('aprob.india@verticebi.com') e`)).e.join() === 'india')
check('empresas que ve quien ve todas', (await val(`select empresas_visibles_de('aprobador@verticebi.com') e`)).e.length === nEmpresas)
check('sin empresas asignadas: ninguna', (await val(`select empresas_visibles_de('nuevo@verticebi.com') e`)).e.length === 0)
check('mail desconocido: ninguna', (await val(`select empresas_visibles_de('nadie@otro.com') e`)).e.length === 0)
await db.exec(`update usuarios set activo = false where email in ('aprob.india@verticebi.com', 'aprobador@verticebi.com')`)
r = await val(`select empresas_visibles_de('aprob.india@verticebi.com') a, empresas_visibles_de('aprobador@verticebi.com') b`)
check('dado de baja: ninguna, tuviera una empresa o todas', r.a.length === 0 && r.b.length === 0, JSON.stringify(r))
await db.exec(`update usuarios set activo = true where email in ('aprob.india@verticebi.com', 'aprobador@verticebi.com')`)
check('vuelto a dar de alta: las ve de nuevo', (await val(`select empresas_visibles_de('aprob.india@verticebi.com') e`)).e.join() === 'india')

// "Leer ahora" pedido por alguien de India: solo lo subido para India.
await db.exec(`update documentos set estado = 'DESCARTADO' where estado in ('PENDIENTE', 'LEYENDO')`)
const colaInd = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'cola-india.pdf'), origen: 'MANUAL', empresas_permitidas: ['india'] }])
const colaBer = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'cola-beratung.pdf'), origen: 'MANUAL', empresas_permitidas: ['beratung'] }])
const colaDos = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'cola-dos.pdf'), origen: 'MANUAL', empresas_permitidas: ['india', 'beratung'] }])
const colaGmail = await val(`select * from registrar_documento($1)`, [doc('msg-cola')])
tomados = (await db.query(`select * from tomar_documentos_de_empresas(5, $1)`, [['india']])).rows
check('cola limitada a India: toma solo el documento subido para India', tomados.length === 1 && tomados[0].id === colaInd.id && tomados[0].estado === 'LEYENDO',
  tomados.map((x) => x.nombre_archivo).join())
check('cola limitada sin empresas: no toma nada', (await db.query(`select * from tomar_documentos_de_empresas(5, $1)`, [[]])).rows.length === 0)
tomados = (await db.query(`select * from tomar_documentos(5)`)).rows
check('el lector programado sigue tomando todo lo demás', tomados.map((x) => x.id).sort().join() === [colaBer.id, colaDos.id, colaGmail.id].sort().join())
for (const fn of ['empresas_visibles_de(text)', 'tomar_documentos_de_empresas(integer,text[])'])
  check(`authenticated NO puede ejecutar ${fn.split('(')[0]}`, !(await val(`select has_function_privilege('authenticated', $1, 'execute') p`, [fn])).p
    && (await val(`select has_function_privilege('service_role', $1, 'execute') p`, [fn])).p)

// ================================================================ Convivencia con la hoja: NC y mail (0014)
await db.exec(`reset role`)
const filaNC = (x = {}) => filaF({ TIPO: 'Nota de Crédito A', IMPORTE: 300, IVA: 0, TOTAL: 300, ESTADO_XUBIO: '', XUBIO_ID_FACTURA: '', ...x })
// De la hoja: una factura aprobada, una NC todavía pendiente y otra NC ya aprobada allá.
e1 = await espFact([filaF({ _fila: 50, NUMERO: '00007-00000370' }),
  filaNC({ _fila: 51, NUMERO: '00007-00000371', ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_PAGO: '' }),
  filaNC({ _fila: 52, NUMERO: '00007-00000372' })])
const hFac = await val(`select id, gestion, estado from facturas where punto_venta = 7 and numero = 370`)
const hNc = await val(`select id, gestion, saldo_nc from facturas where punto_venta = 7 and numero = 371`)
const hNcAprobada = await val(`select id, gestion, estado, saldo_nc from facturas where punto_venta = 7 and numero = 372`)
check('de la hoja: factura para pagar y dos NC con todo su saldo', e1.nuevas === 3 && hFac.gestion === 'HOJA' && hFac.estado === 'PARA_PAGAR' && Number(hNc.saldo_nc) === 300 && Number(hNcAprobada.saldo_nc) === 300)

// Caso de la tanda: se aprueba la NC en el sistema nuevo, se aplica en parte y la hoja vuelve a copiarse con las filas cambiadas.
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
await db.query(`select aprobar_factura($1, 'Gastos Generales', 'TRANSFERENCIA')`, [hNc.id])
await como('tesoreria@verticebi.com')
await db.query(`select aplicar_nota_credito($1, $2, 100)`, [hNc.id, hFac.id])
await db.exec(`reset role`)
e1 = await espFact([filaF({ _fila: 50, NUMERO: '00007-00000370', MOTIVO_VALIDACION: 'cambio en la hoja' }),
  filaNC({ _fila: 51, NUMERO: '00007-00000371', ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_PAGO: '', MOTIVO_VALIDACION: 'cambio en la hoja' })])
r = await val(`select n.saldo_nc, n.gestion ng, n.estado ne, f.pagado, f.gestion fg from facturas n, facturas f where n.id = $1 and f.id = $2`, [hNc.id, hFac.id])
check('NC aplicada en parte: al volver a copiar la hoja cambiada el saldo no vuelve', Number(r.saldo_nc) === 200 && r.ng === 'SISTEMA' && r.ne === 'PARA_PAGAR', JSON.stringify(r))
check('…y la factura conserva lo aplicado', Number(r.pagado) === 100 && r.fg === 'SISTEMA')

// La regla en sí: bajar el saldo de una NC que gestiona la hoja es una decisión del sistema nuevo.
// (Sin 0014 la NC seguía siendo de la hoja y la copia siguiente le devolvía los 300.)
await db.query(`update facturas set saldo_nc = saldo_nc - 100 where id = $1`, [hNcAprobada.id])
check('bajar el saldo de una NC de la hoja la pasa a gestión SISTEMA', (await val(`select gestion from facturas where id = $1`, [hNcAprobada.id])).gestion === 'SISTEMA')
e1 = await espFact([filaNC({ _fila: 52, NUMERO: '00007-00000372', MOTIVO_VALIDACION: 'cambio en la hoja' })])
check('…y la copia de la hoja ya no le devuelve el saldo entero', Number((await val(`select saldo_nc from facturas where id = $1`, [hNcAprobada.id])).saldo_nc) === 200)

// Mail preparado en una factura que sigue gestionando la hoja.
e1 = await espFact([filaF({ _fila: 53, NUMERO: '00007-00000373', PORCENTAJE_PAGADO: 50 })])
const hMail = (await val(`select id from facturas where punto_venta = 7 and numero = 373`)).id
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await db.query(`select marcar_mail_preparado($1)`, [[hMail]])
await db.exec(`reset role`)
check('preparar el mail no cambia quién gestiona la factura', (await val(`select gestion from facturas where id = $1`, [hMail])).gestion === 'HOJA')
e1 = await espFact([filaF({ _fila: 53, NUMERO: '00007-00000373', PORCENTAJE_PAGADO: 75 })])
r = await val(`select mail_enviado, pagado, gestion from facturas where id = $1`, [hMail])
check('la hoja registra otro pago: se copia y la marca de mail preparado no se borra', e1.actualizadas === 1 && Number(r.pagado) === 90750 && /^Preparado en Gmail/.test(r.mail_enviado ?? ''), JSON.stringify(r))
e1 = await espFact([filaF({ _fila: 53, NUMERO: '00007-00000373', PORCENTAJE_PAGADO: 75, MAIL_ENVIADO_FECHA: 'Enviado 20/11/2026' })])
check('si la hoja trae su propia marca de mail, se copia la de la hoja', (await val(`select mail_enviado m from facturas where id = $1`, [hMail])).m === 'Enviado 20/11/2026')

// ================================================================ Liberar un pago trabado en Xubio (0015, corregida en 0016)
await db.exec(`reset role; set role authenticated`)
await como('tesoreria@verticebi.com')
const pTr1 = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'ysd', importe: 150, descripcion: 'trabado 1' })])).id
const pTr2 = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'ysd', importe: 250, descripcion: 'trabado 2' })])).id
await como('administracion@verticebi.com')
await falla('un pago sin envío en curso no se libera', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /no tiene un envío a Xubio trabado/)
const pTr3 = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'ysd', importe: 350, descripcion: 'trabado 3' })])).id
// contabilizar reserva el pago justo antes de enviarlo a Xubio (envio_xubio_en = ahora). Uno es de la hoja.
await db.exec(`reset role`)
const pHoja = await val(`select id, gestion, estado, cuenta_contable, forma_carga_xubio from pagos where hoja_id = 'PAGO-1792698009000-0'`)
await db.query(`update pagos set envio_xubio_en = now() where id in ($1, $2, $3, $4)`, [pTr1, pTr2, pTr3, pHoja.id])
r = await val(`select gestion, estado from pagos where id = $1`, [pHoja.id])
check('la reserva del envío no cambia quién gestiona un pago de la hoja ni su estado', pHoja.gestion === 'HOJA' && r.gestion === 'HOJA' && r.estado === pHoja.estado && r.estado === 'CARGADO', JSON.stringify(r))
check('…ni los del sistema', (await val(`select count(*)::int n from pagos where id in ($1, $2, $3) and estado = 'CARGADO' and gestion = 'SISTEMA' and envio_xubio_en is not null`, [pTr1, pTr2, pTr3])).n === 3)
await db.exec(`set role authenticated`)
await como('tesoreria@verticebi.com')
await falla('un pago trabado no se anula', `select anular_pago($1, 'x')`, [pTr1], /enviando a Xubio/)
await falla('Tesorería no libera pagos trabados (es de Administración)', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /rol/)

// Plazo (0016): el envío recién salió y puede estar en curso. Ninguna de las dos salidas se acepta todavía.
check('el plazo para dar un envío por cortado está en un solo lugar y la pantalla lo puede leer', (await val(`select plazo_envio_xubio_segundos() s, extract(epoch from plazo_envio_xubio())::int e`)).s === 300
  && (await val(`select plazo_envio_xubio_segundos() s, extract(epoch from plazo_envio_xubio())::int e`)).e === 300)
await como('administracion@verticebi.com')
await falla('envío recién salido: no se puede liberar (podría estar en curso)', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /todavía puede estar en curso.*Esperá [45] min \d+ s/)
await falla('envío recién salido: tampoco marcar "ya está en Xubio"', `select liberar_pago_xubio($1, 'OP-777', 'SEGUROS', 'ORDEN_PAGO')`, [pTr2], /todavía puede estar en curso/)
await db.exec(`reset role`)
check('…y los pagos siguen reservados, sin contabilizar', (await val(`select count(*)::int n from pagos where id in ($1, $2) and estado = 'CARGADO' and envio_xubio_en is not null and xubio_id is null`, [pTr1, pTr2])).n === 2)
await db.query(`update pagos set envio_xubio_en = now() - plazo_envio_xubio() + interval '20 seconds' where id in ($1, $2, $3, $4)`, [pTr1, pTr2, pTr3, pHoja.id])
await db.exec(`set role authenticated`)
await como('administracion@verticebi.com')
await falla('a 20 segundos de cumplirse el plazo: todavía no', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /Esperá 0 min (1\d|20) s/)
await db.exec(`reset role`)
// Pasó el plazo: el envío se cortó sin respuesta.
await db.query(`update pagos set envio_xubio_en = now() - plazo_envio_xubio() - interval '1 second' where id in ($1, $2, $3, $4)`, [pTr1, pTr2, pTr3, pHoja.id])

// Control de empresa propio de liberar_pago_xubio. Se apaga un momento el trigger de pagos, que rechaza
// con el mismo mensaje, para comprobar que la función controla por sí misma (antes de mirar nada del pago).
await db.exec(`insert into usuarios (email, nombre, rol) values ('admin.india@verticebi.com', 'Administración India', 'ADMINISTRACION');
  insert into usuarios_empresas (email, empresa_id) values ('admin.india@verticebi.com', 'india')`)
await db.exec(`alter table pagos disable trigger trg_aislar_pagos`)
await db.exec(`set role authenticated`)
await como('admin.india@verticebi.com')
await falla('Administración de India no libera pagos de YSD (control de la propia función)', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /acceso a la empresa ysd/)
await falla('…ni los marca como ya cargados en Xubio', `select liberar_pago_xubio($1, 'OP-1', 'SEGUROS', null)`, [pTr1], /acceso a la empresa ysd/)
await db.exec(`reset role`)
await db.exec(`alter table pagos enable trigger trg_aislar_pagos`)
check('…y el pago de YSD sigue reservado', (await val(`select count(*)::int n from pagos where id = $1 and envio_xubio_en is not null and estado = 'CARGADO'`, [pTr1])).n === 1)
await db.exec(`set role authenticated`)
await como('admin.india@verticebi.com')
await falla('con el trigger de pagos puesto, también', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /acceso a la empresa ysd/)
await como('administracion@verticebi.com')
// No estaba en Xubio: se libera.
check('liberar sin número devuelve LIBERADO', (await val(`select liberar_pago_xubio($1, '  ', null, null) r`, [pTr1])).r === 'LIBERADO')
r = await val(`select estado, envio_xubio_en, xubio_id, detalle_contabilizacion d from pagos where id = $1`, [pTr1])
check('liberado: sin reserva, mismo estado y sin número de Xubio', r.estado === 'CARGADO' && r.envio_xubio_en === null && r.xubio_id === null && /liberado por Guido/.test(r.d), JSON.stringify(r))
await falla('liberado: ya no hay nada que liberar', `select liberar_pago_xubio($1, '', null, null)`, [pTr1], /no tiene un envío a Xubio trabado/)
await como('tesoreria@verticebi.com')
await db.query(`select anular_pago($1, 'No salió')`, [pTr1])
check('liberado: ahora sí se puede anular', (await val(`select estado from pagos where id = $1`, [pTr1])).estado === 'ANULADO')
// Sí estaba en Xubio: queda contabilizado con ese número, sin enviar nada.
await como('administracion@verticebi.com')
await falla('ya estaba en Xubio pero falta la cuenta contable', `select liberar_pago_xubio($1, 'OP-777', null, null)`, [pTr2], /cuenta contable/)
// El número cargado a mano tiene que ser un número de comprobante, no una marca interna ni un texto.
for (const malo of ['RALPHARMA', 'ralpharma', 'CARGADO_A_MANO', 'EN-SECO', 'ya lo cargué', 'OP-', '-123', 'OP 1234; x', '1'.repeat(41)])
  await falla(`número de Xubio "${malo.slice(0, 16)}" rechazado`, `select liberar_pago_xubio($1, $2, 'SEGUROS', 'ORDEN_PAGO')`, [pTr2, malo], /no es válido/)
check('…y el pago sigue trabado, sin número', (await val(`select count(*)::int n from pagos where id = $1 and estado = 'CARGADO' and xubio_id is null`, [pTr2])).n === 1)
check('solo dígitos: se guarda como los envíos automáticos (OP-1234)', (await val(`select liberar_pago_xubio($1, '1234', 'SEGUROS', 'ORDEN_PAGO') r`, [pTr3])).r === 'CONTABILIZADO'
  && (await val(`select xubio_id from pagos where id = $1`, [pTr3])).xubio_id === 'OP-1234')
check('con número de Xubio devuelve CONTABILIZADO', (await val(`select liberar_pago_xubio($1, ' OP-777 ', 'SEGUROS', 'ORDEN_PAGO') r`, [pTr2])).r === 'CONTABILIZADO')
r = await val(`select estado, xubio_id, cuenta_contable, forma_carga_xubio, contabilizado_por, contabilizado_en from pagos where id = $1`, [pTr2])
check('queda contabilizado con el número, la cuenta, la forma y quién lo resolvió', r.estado === 'CONTABILIZADO' && r.xubio_id === 'OP-777' && r.cuenta_contable === 'SEGUROS'
  && r.forma_carga_xubio === 'ORDEN_PAGO' && r.contabilizado_por === 'Guido' && r.contabilizado_en !== null, JSON.stringify(r))
await falla('un pago ya contabilizado no se vuelve a liberar', `select liberar_pago_xubio($1, 'OP-778', 'SEGUROS', null)`, [pTr2], /no tiene un envío a Xubio trabado/)
await db.exec(`reset role`)
check('las dos salidas quedan en la auditoría', (await val(`select count(*)::int n from auditoria where accion = 'XUBIO_PAGO_LIBERADO' and entidad_id in ($1, $2)`, [pTr1, pTr2])).n === 2)

// Pago de la hoja con el envío sin confirmar: contabilizar guarda el aviso, la cuenta y la forma y lo pasa
// a gestión del sistema (mismo cambio que hace la función). La copia de la hoja ya no lo borra.
await db.query(`update pagos set cuenta_contable = $2, forma_carga_xubio = $3, gestion = 'SISTEMA', detalle_contabilizacion = 'Envío a Xubio sin confirmar: Xubio no respondió' where id = $1`,
  [pHoja.id, pHoja.cuenta_contable, pHoja.forma_carga_xubio])
ep = await espPag([filaP({ _fila: 41, ID_PAGO: 'PAGO-1792698009000-0', FACTURA_ASOCIADA: '00007-00000360', IMPORTE: 1000, CUENTA_CONTABLE: 'Otra cuenta', FORMA_CARGA: 'ASIENTO_MANUAL' })])
r = await val(`select gestion, cuenta_contable, forma_carga_xubio, detalle_contabilizacion d, envio_xubio_en from pagos where id = $1`, [pHoja.id])
check('pago de la hoja sin confirmar: la copia no borra el aviso, la cuenta ni la forma del envío', r.gestion === 'SISTEMA' && r.cuenta_contable === pHoja.cuenta_contable
  && r.forma_carga_xubio === pHoja.forma_carga_xubio && /sin confirmar/.test(r.d ?? '') && r.envio_xubio_en !== null, JSON.stringify(r))
await db.exec(`set role authenticated`)
await como('administracion@verticebi.com')
check('…y se resuelve desde la tarjeta con el formato de Xubio', (await val(`select liberar_pago_xubio($1, 'X-0001-00000483', null, null) r`, [pHoja.id])).r === 'CONTABILIZADO'
  && (await val(`select xubio_id from pagos where id = $1`, [pHoja.id])).xubio_id === 'X-0001-00000483')
await db.exec(`reset role`)
for (const fn of ['plazo_envio_xubio()', 'plazo_envio_xubio_segundos()'])
  check(`anon NO puede ejecutar ${fn.split('(')[0]}; las personas sí`, !(await val(`select has_function_privilege('anon', $1, 'execute') p`, [fn])).p && (await val(`select has_function_privilege('authenticated', $1, 'execute') p`, [fn])).p)
check('anon no puede liberar pagos', !(await val(`select has_function_privilege('anon', 'liberar_pago_xubio(uuid,text,text,forma_carga_xubio)', 'execute') p`)).p)

// ================================================================ Organizaciones: tablas y claves (0017)
await db.exec(`reset role`)
await como('')
const orgV = (await val(`select id from organizaciones where slug = 'vertice'`)).id
r = await val(`select count(*)::int n, bool_and(es_proveedor) p from organizaciones`)
check('hay una sola organización, Vértice, y es la que da el servicio', r.n === 1 && r.p === true && !!orgV)
r = await val(`select organizacion_unica() o, organizacion_del_servidor() s`)
check('con una sola organización, lo que no la trae se asigna a esa', r.o === orgV && r.s === orgV)
const CON_ORGANIZACION = ['empresas', 'usuarios', 'proveedores', 'documentos', 'auditoria', 'cuentas_contables', 'reglas_cuenta', 'productos_xubio', 'espejo_estado']
for (const tabla of CON_ORGANIZACION) {
  r = await val(`select count(*)::int n, count(*) filter (where organizacion_id is distinct from $1)::int ajenos from ${tabla}`, [orgV])
  check(`todo lo que había en ${tabla} quedó a nombre de Vértice`, r.ajenos === 0, `${r.n} filas`)
}
check('las tablas de las pruebas tienen datos (si no, lo de arriba no prueba nada)',
  (await val(`select least((select count(*) from proveedores), (select count(*) from documentos), (select count(*) from auditoria), (select count(*) from cuentas_contables), (select count(*) from productos_xubio))::int n`)).n > 0)
r = await val(`select count(*)::int n, count(*) filter (where a.empresa_id is distinct from f.empresa_id)::int mal from auditoria a join facturas f on f.id::text = a.entidad_id where a.entidad = 'FACTURA'`)
check('auditoría de facturas: cada renglón lleva la empresa de su factura', r.n > 0 && r.mal === 0, JSON.stringify(r))
r = await val(`select count(*)::int n, count(*) filter (where a.empresa_id is distinct from p.empresa_id)::int mal from auditoria a join pagos p on p.id::text = a.entidad_id where a.entidad = 'PAGO'`)
check('auditoría de pagos: cada renglón lleva la empresa de su pago', r.n > 0 && r.mal === 0, JSON.stringify(r))
check('auditoría del sistema (sin factura ni pago): sin empresa, con organización', (await val(`select count(*)::int n from auditoria where entidad = 'SISTEMA' and empresa_id is null and organizacion_id = $1`, [orgV])).n > 0)
check('las personas no ejecutan las funciones de apoyo de organizaciones',
  !(await val(`select has_function_privilege('authenticated', 'organizacion_del_servidor()', 'execute') p`)).p && !(await val(`select has_function_privilege('anon', 'organizacion_unica()', 'execute') p`)).p)
await falla('la organización de una empresa no se cambia', `update empresas set organizacion_id = gen_random_uuid() where id = 'india'`, [], /no se cambia/)

// --- Segunda organización, de mentira. Queda para el resto del archivo: es la prueba fija de separación.
const orgB = (await val(`insert into organizaciones (slug, nombre) values ('otra', 'Otra Organización S.A.') returning id`)).id
check('la segunda organización no es la que da el servicio', (await val(`select es_proveedor p from organizaciones where id = $1`, [orgB])).p === false)
await falla('no puede haber dos organizaciones que den el servicio', `insert into organizaciones (slug, nombre, es_proveedor) values ('tercera', 'Tercera', true)`, [], /organizaciones_un_solo_proveedor/)
check('con dos organizaciones ya no hay "la única"', (await val(`select organizacion_unica() o`)).o === null)
await falla('…y el servidor no adivina para cuál trabaja', `select organizacion_del_servidor()`, [], /más de una organización/)
await falla('con dos organizaciones, una empresa nueva tiene que decir de cuál es', `insert into empresas (id, nombre, nombre_corto, cuit) values ('huerfana', 'Huérfana', 'Huérfana', '30999999990')`, [], /No se sabe de qué organización/)
await falla('…y un usuario nuevo también', `insert into usuarios (email, nombre, rol) values ('huerfano@otra.com', 'Huérfano', 'ADMIN')`, [], /No se sabe de qué organización/)
await db.query(`insert into empresas (id, nombre, nombre_corto, cuit, erp, organizacion_id) values
  ('otra-uno', 'Otra Uno S.A.', 'Otra Uno', '30999999991', 'XUBIO', $1), ('otra-dos', 'Otra Dos S.R.L.', 'Otra Dos', '30999999992', 'NINGUNO', $1)`, [orgB])
await db.query(`insert into usuarios (email, nombre, rol, todas_empresas, organizacion_id) values
  ('admin@otra.com', 'Admin de Otra', 'ADMIN', true, $1), ('teso@otra.com', 'Tesorería de Otra', 'TESORERIA', true, $1),
  ('aprob.uno@otra.com', 'Aprobador de Otra Uno', 'APROBADOR', false, $1)`, [orgB])
await db.exec(`insert into usuarios_empresas (email, empresa_id) values ('aprob.uno@otra.com', 'otra-uno')`)
await falla('a una persona no se le asigna una empresa de otra organización', `insert into usuarios_empresas (email, empresa_id) values ('aprob.uno@otra.com', 'india')`, [], /otra organización/)
await falla('…ni a una de Vértice una empresa de la otra', `insert into usuarios_empresas (email, empresa_id) values ('aprob.india@verticebi.com', 'otra-uno')`, [], /otra organización/)
await falla('una persona no se pasa de organización', `update usuarios set organizacion_id = $1 where email = 'nuevo@verticebi.com'`, [orgB], /no se cambia/)

// El mismo CUIT puede ser proveedor de las dos: son dos proveedores distintos.
const provV = await val(`select id, nombre from proveedores where cuit = '30712345678' and organizacion_id = $1`, [orgV])
const fB1 = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'otra-uno', proveedor: 'Laboratorio (ficha de Otra)', numero: 1001 })])).id
r = await val(`select count(*)::int n, count(distinct organizacion_id)::int orgs from proveedores where cuit = '30712345678'`)
check('el mismo CUIT en dos organizaciones: dos proveedores', r.n === 2 && r.orgs === 2, JSON.stringify(r))
const provB = await val(`select p.id, p.nombre, p.organizacion_id from proveedores p join facturas f on f.proveedor_id = p.id where f.id = $1`, [fB1])
check('la factura de la otra organización usa su propio proveedor', provB.organizacion_id === orgB && provB.id !== provV.id && provB.nombre === 'Laboratorio (ficha de Otra)')
check('…y la ficha del proveedor de Vértice no cambió', (await val(`select nombre from proveedores where id = $1`, [provV.id])).nombre === provV.nombre)
check('la misma factura (mismo proveedor, tipo y número) existe en las dos sin pisarse', (await val(`select count(*)::int n from facturas where numero = 1001 and punto_venta = 5 and tipo = 'Factura A'`)).n === 2)
await falla('un pago no puede llevar el proveedor de otra organización', `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por) values ('otra-uno', $1, '2026-11-01', 10, 'TRANSFERENCIA', 'x')`, [provV.id], /proveedor es de otra organización/)
await falla('…ni una factura', `update facturas set proveedor_id = $2 where id = $1`, [fB1, provV.id], /proveedor es de otra organización/)
await falla('factura de una empresa que no existe: mensaje claro', `select ingresar_factura($1)`, [factura({ empresa_id: 'no-existe', numero: 1 })], /Empresa inexistente: no-existe/)

// Documentos: cada uno con su organización; el mismo adjunto puede llegar a las dos.
await falla('un adjunto que no dice de quién es no entra (con dos organizaciones)', `select * from registrar_documento($1)`, [doc('msg-org-0')], /más de una organización/)
const dOrgV = await val(`select * from registrar_documento($1)`, [{ ...doc('msg-org-1'), organizacion_id: orgV }])
const dOrgB = await val(`select * from registrar_documento($1)`, [{ ...doc('msg-org-1'), organizacion_id: orgB }])
check('el mismo adjunto del mismo mail entra una vez en cada organización', dOrgV.nuevo && dOrgB.nuevo && dOrgV.id !== dOrgB.id)
check('…y repetido en la misma, una sola', (await val(`select * from registrar_documento($1)`, [{ ...doc('msg-org-1'), organizacion_id: orgB }])).id === dOrgB.id)
const dListaB = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'subida-otra.pdf'), origen: 'MANUAL', empresas_permitidas: ['otra-uno'] }])
check('un documento subido para una empresa toma la organización de esa empresa', (await val(`select organizacion_id o from documentos where id = $1`, [dListaB.id])).o === orgB)
await falla('un documento de una organización no puede ser para una empresa de otra', `select * from registrar_documento($1)`,
  [{ ...doc('', 'cruzado.pdf'), origen: 'MANUAL', organizacion_id: orgV, empresas_permitidas: ['otra-uno'] }], /otra organización/)

// Copia de la hoja con dos organizaciones: lo que trae empresa sigue andando; lo que no, se rechaza.
ep = await espPag([filaP({ _fila: 60, ID_PAGO: 'PAGO-1792698010000-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', EMPRESA: 'BERATUNG S.A.' }),
  filaP({ _fila: 61, ID_PAGO: 'PAGO-1792698010001-0', FACTURA_ASOCIADA: '00007-00000350' })])
check('copia de pagos con dos organizaciones: el que trae empresa entra', ep.nuevas === 1 && (await val(`select empresa_id from pagos where hoja_id = 'PAGO-1792698010000-0'`))?.empresa_id === 'beratung', JSON.stringify(ep))
check('…y el que no trae empresa se omite con el motivo (no se adivina de quién es)', ep.omitidas.length === 1 && /más de una organización/.test(ep.omitidas[0].motivo), JSON.stringify(ep.omitidas))
e1 = await espFact([filaF({ _fila: 62, NUMERO: '00007-00000380' })])
check('copia de facturas con dos organizaciones: sigue andando (la empresa dice de quién es)', e1.nuevas === 1 && e1.omitidas.length === 0, JSON.stringify(e1))
// Un pago de la hoja de Vértice cuyo destinatario se llama igual que un proveedor que solo existe en la otra organización.
ep = await espPag([filaP({ _fila: 63, ID_PAGO: 'PAGO-1792698010002-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', EMPRESA: 'BERATUNG S.A.', PROVEEDOR_DESTINO: 'Laboratorio (ficha de Otra)' })])
r = await val(`select proveedor_id, empresa_id from pagos where hoja_id = 'PAGO-1792698010002-0'`)
check('copia de pagos: el proveedor por nombre se busca solo en la organización de la empresa', ep.nuevas === 1 && r?.empresa_id === 'beratung' && r?.proveedor_id === null, JSON.stringify({ ep, r }))
// El ID_PAGO de la hoja es único en toda la base: si lo tiene un pago de la otra organización, no se pisa.
await db.exec(`insert into pagos (empresa_id, fecha, importe, medio, cargado_por, hoja_id, gestion, descripcion) values ('otra-uno', '2026-11-01', 55, 'TRANSFERENCIA', 'x', 'PAGO-1792698010003-0', 'HOJA', 'pago de Otra')`)
ep = await espPag([filaP({ _fila: 64, ID_PAGO: 'PAGO-1792698010003-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', EMPRESA: 'BERATUNG S.A.', IMPORTE: 999 })])
r = await val(`select empresa_id, importe, descripcion from pagos where hoja_id = 'PAGO-1792698010003-0'`)
check('copia de pagos: un pago de otra organización con el mismo ID no se pisa', ep.omitidas.length === 1 && /otra organización/.test(ep.omitidas[0].motivo) && r.empresa_id === 'otra-uno' && Number(r.importe) === 55, JSON.stringify({ ep, r }))
r = (await val(`select espejar_catalogos($1) r`, [JSON.stringify({ cuentas: cat.cuentas, origen: cat.origen, porEmpresa: cat.porEmpresa })])).r
check('catálogos por empresa con dos organizaciones: siguen andando', r.cuentas === 1 && r.origen === 1 && r.porEmpresa === 1, JSON.stringify(r))
await falla('catálogos sin empresa (mails de proveedores) con dos organizaciones: se rechazan', `select espejar_catalogos($1)`, [JSON.stringify({ emails: cat.emails })], /más de una organización/)
await falla('…y los productos también', `select espejar_catalogos($1)`, [JSON.stringify({ productos: cat.productos })], /más de una organización/)
await db.query(`insert into cuentas_contables (organizacion_id, nombre) values ($1, 'SEGUROS'), ($1, 'CUENTA SOLO DE OTRA')`, [orgB])
check('cada organización tiene sus cuentas comunes: el mismo nombre no choca', (await val(`select count(*)::int n from cuentas_contables where empresa_id is null and nombre = 'SEGUROS'`)).n === 2)
await falla('…y dentro de una organización no se repite', `insert into cuentas_contables (organizacion_id, nombre) values ($1, 'SEGUROS')`, [orgB], /cuentas_contables_organizacion_empresa_nombre_key/)
await falla('una cuenta no puede decir una organización y ser de una empresa de otra', `insert into cuentas_contables (organizacion_id, empresa_id, nombre) values ($1, 'india', 'X')`, [orgB], /otra organización/)

// ================================================================ Dos organizaciones que no se ven ni se tocan (0018) · PRUEBA FIJA
// Vértice y "Otra" tienen cada una sus empresas, usuarios, proveedores, facturas, pagos, documentos y
// auditoría. Ninguna persona de una ve ni puede tocar nada de la otra. Si una tanda futura rompe la
// separación, esta sección falla.
await db.exec(`reset role`)
await como('')
const fB2 = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'otra-uno', proveedor: 'Laboratorio (ficha de Otra)', numero: 1002, total: 1000, neto: 1000, iva: 0 })])).id
const fBdos = (await val(`select ingresar_factura($1) id`, [factura({ empresa_id: 'otra-dos', cuit_proveedor: '30-70000001-9', proveedor: 'Proveedor de Otra Dos', numero: 3001, total: 500, neto: 500, iva: 0 })])).id
await db.query(`insert into cuentas_origen (empresa_id, nombre) values ('otra-uno', 'Banco de Otra CC')`)
await db.query(`insert into productos_xubio (organizacion_id, nombre, codigo) values ($1, 'Producto de Otra', 'PROD_OTRA')`, [orgB])
await db.query(`insert into espejo_estado (organizacion_id, hoja, filas) values ($1, 'Facturas', 3), ($2, 'Facturas', 7) on conflict do nothing`, [orgV, orgB])
await db.query(`insert into reglas_cuenta (organizacion_id, patron, cuenta_contable) values ($1, 'alquiler', 'ALQUILER DE OFICINA'), ($2, 'alquiler', 'CUENTA SOLO DE OTRA')`, [orgV, orgB])
await db.exec(`insert into reglas_cuenta (empresa_id, patron, cuenta_contable) values ('india', 'seguro', 'SEGUROS'), ('otra-uno', 'seguro', 'SEGUROS')`)
await db.exec(`insert into xubio_log (empresa_id, entidad, en_seco, usuario) values ('beratung', 'PAGO', true, 'Guido'), ('otra-uno', 'PAGO', true, 'Admin de Otra'), (null, 'PAGO', true, 'sin empresa')`)
// La gente de Otra trabaja en lo suyo: aprueba, paga, guarda un mail. Tiene que poder.
await db.exec(`set role authenticated`)
await como('admin@otra.com')
await db.query(`select aprobar_factura($1, 'CUENTA SOLO DE OTRA', 'TRANSFERENCIA')`, [fB1])
await db.query(`select aprobar_factura($1, 'CUENTA SOLO DE OTRA', 'TRANSFERENCIA')`, [fBdos])
await como('teso@otra.com')
const pB = (await val(`select registrar_pago($1) id`, [pago({ empresa_id: 'otra-uno', importe: 100, cuenta_origen: 'Banco de Otra CC', factura_ids: [fB1], proveedor_id: provB.id })])).id
await db.query(`select guardar_email_proveedor($1, 'cobranzas@otra-prov.com')`, [provB.id])
await db.exec(`reset role`)
check('la otra organización opera lo suyo: aprueba, paga y guarda el mail de su proveedor', (await val(`select estado from facturas where id = $1`, [fB1])).estado === 'PAGADA_PARCIAL'
  && (await val(`select email from proveedores where id = $1`, [provB.id])).email === 'cobranzas@otra-prov.com' && !!pB)
check('…y la auditoría de eso queda a nombre de la otra organización', (await val(`select count(*)::int n from auditoria where organizacion_id = $1 and empresa_id = 'otra-uno'`, [orgB])).n >= 3
  && (await val(`select count(*)::int n from auditoria where organizacion_id = $1 and accion = 'MAIL_PROVEEDOR_GUARDADO'`, [orgB])).n === 1)

// Cuántas filas de cada tabla son de una organización. Lo cuenta el servidor, sin reglas de acceso.
const porEmpresa = (tabla) => `select count(*)::int n from ${tabla} x join empresas e on e.id = x.empresa_id where e.organizacion_id = $1`
const porOrganizacion = (tabla) => `select count(*)::int n from ${tabla} where organizacion_id = $1`
const DE_LA_ORGANIZACION = {
  organizaciones: `select count(*)::int n from organizaciones where id = $1`,
  empresas: porOrganizacion('empresas'), usuarios: porOrganizacion('usuarios'), usuarios_empresas: porEmpresa('usuarios_empresas'),
  proveedores: porOrganizacion('proveedores'), proveedores_empresa: porEmpresa('proveedores_empresa'),
  facturas: porEmpresa('facturas'), pagos: porEmpresa('pagos'),
  pagos_facturas: `select count(*)::int n from pagos_facturas x join pagos p on p.id = x.pago_id join empresas e on e.id = p.empresa_id where e.organizacion_id = $1`,
  documentos: porOrganizacion('documentos'), auditoria: porOrganizacion('auditoria'),
  cuentas_contables: porOrganizacion('cuentas_contables'), cuentas_origen: porEmpresa('cuentas_origen'), reglas_cuenta: porOrganizacion('reglas_cuenta'),
  productos_xubio: porOrganizacion('productos_xubio'), espejo_estado: porOrganizacion('espejo_estado'), xubio_log: porEmpresa('xubio_log'),
}
const cuenta = { V: {}, B: {} }
for (const [tabla, sql] of Object.entries(DE_LA_ORGANIZACION)) {
  cuenta.V[tabla] = (await val(sql, [orgV])).n
  cuenta.B[tabla] = (await val(sql, [orgB])).n
}
check('las dos organizaciones tienen datos en todas las tablas (si no, lo que sigue no prueba nada)',
  Object.values(cuenta.V).every((n) => n > 0) && Object.values(cuenta.B).every((n) => n > 0), JSON.stringify(cuenta))
// Quien ve todo lo de su organización tiene que ver exactamente eso: ni una fila menos, ni una de la otra.
for (const [quien, email, lado] of [['Otra', 'admin@otra.com', 'B'], ['Vértice', 'tecnologia@verticebi.com', 'V']]) {
  await db.exec(`set role authenticated`)
  await como(email)
  for (const tabla of Object.keys(DE_LA_ORGANIZACION)) {
    const visto = (await val(`select count(*)::int n from ${tabla}`)).n
    check(`${quien} ve en ${tabla} lo suyo y nada de la otra organización`, visto === cuenta[lado][tabla], `ve ${visto}, son ${cuenta[lado][tabla]}`)
  }
  await db.exec(`reset role`)
}
await db.exec(`set role authenticated`)
await como('admin@otra.com')
check('Otra: sus dos empresas y ninguna más', (await db.query(`select id from empresas order by id`)).rows.map((x) => x.id).join() === 'otra-dos,otra-uno')
check('Otra: el flujo solo trae sus empresas', (await val(`select count(*)::int n, count(*) filter (where empresa not in ('Otra Uno S.A.', 'Otra Dos S.R.L.'))::int ajenas from export_cashflow`)).ajenas === 0
  && (await val(`select count(*)::int n from export_cashflow`)).n > 0)
check('Otra: no ve al proveedor de Vértice aunque tenga el mismo CUIT', (await db.query(`select id from proveedores where cuit = '30712345678'`)).rows.map((x) => x.id).join() === provB.id)
check('Otra: no ve las cuentas comunes de Vértice, sí las suyas', (await val(`select count(*) filter (where nombre = 'COSTO DE INSUMOS')::int v, count(*) filter (where nombre = 'CUENTA SOLO DE OTRA')::int b from cuentas_contables`)).v === 0
  && (await val(`select count(*)::int b from cuentas_contables where nombre = 'CUENTA SOLO DE OTRA'`)).b === 1)
check('Otra: de la tabla de organizaciones ve solo la suya', (await db.query(`select slug from organizaciones`)).rows.map((x) => x.slug).join() === 'otra')
check('Otra: puede_ver_empresa de una empresa de Vértice da falso', (await val(`select puede_ver_empresa('beratung') a, puede_ver_empresa('otra-uno') b`)).a === false
  && (await val(`select puede_ver_empresa('otra-uno') b`)).b === true)
// Tocar: cada acción de negocio sobre algo de Vértice.
await falla('Otra no aprueba una factura de Vértice', `select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fBer], /acceso a la empresa beratung/)
await falla('Otra no rechaza una factura de Vértice', `select rechazar_factura($1, 'no')`, [fBer], /acceso a la empresa beratung/)
await falla('Otra no edita una factura de Vértice', `select editar_factura($1, $2)`, [fBer, JSON.stringify(datosEd({ numero: 9102 }))], /acceso a la empresa/)
await falla('Otra no pasa una factura suya a una empresa de Vértice', `select editar_factura($1, $2)`, [fB2, JSON.stringify(datosEd({ numero: 9103 }))], /acceso a la empresa beratung/)
await falla('Otra no aprueba como ya pagada una factura de Vértice', `select aprobar_factura_ya_pagada($1, 'SEGUROS', 'TRANSFERENCIA', '{}')`, [fYa4], /acceso a la empresa ysd/)
await falla('Otra no aplica notas de crédito de Vértice', `select aplicar_nota_credito($1, $2, 1)`, [fNc, fFac], /acceso a la empresa ysd/)
await falla('Otra no marca mails de facturas de Vértice', `select marcar_mail_preparado($1)`, [[fYa2]], /acceso a la empresa ysd/)
await falla('Otra no reintenta un documento de Vértice', `select reintentar_documento($1)`, [d5.id], /acceso a este documento/)
await falla('Otra no descarta un documento de Vértice', `select descartar_documento($1, 'x')`, [dOrgV.id], /acceso a este documento/)
await falla('Otra no libera pagos de Vértice', `select liberar_pago_xubio($1, '', null, null)`, [pCont], /acceso a la empresa ysd/)
await falla('Otra no guarda el mail de un proveedor de Vértice', `select guardar_email_proveedor($1, 'x@otra.com')`, [provV.id], /Proveedor inexistente/)
await como('teso@otra.com')
await falla('Otra no carga pagos en una empresa de Vértice', `select registrar_pago($1)`, [pago({ importe: 10 })], /acceso a la empresa beratung/)
await falla('Otra no paga una factura de Vértice desde una empresa suya', `select registrar_pago($1)`, [pago({ empresa_id: 'otra-uno', importe: 10, factura_ids: [fYa4] })], /otra empresa|no está para pagar/)
await falla('Otra no carga un pago al proveedor de Vértice', `select registrar_pago($1)`, [pago({ empresa_id: 'otra-uno', importe: 10, proveedor_id: provV.id })], /proveedor es de otra organización/)
await falla('Otra no anula pagos de Vértice', `select anular_pago($1, 'x')`, [pCont], /acceso a la empresa ysd/)
await db.exec(`reset role`)
check('…y nada de Vértice cambió', (await val(`select estado from facturas where id = $1`, [fBer])).estado === 'PENDIENTE_APROBACION' && (await val(`select empresa_id from facturas where id = $1`, [fB2])).empresa_id === 'otra-uno'
  && (await val(`select email from proveedores where id = $1`, [provV.id])).email !== 'x@otra.com' && (await val(`select estado from pagos where id = $1`, [pCont])).estado === 'CONTABILIZADO'
  && (await val(`select estado from documentos where id = $1`, [dOrgV.id])).estado === 'PENDIENTE')

// Al revés: la gente de Vértice (incluido quien "ve todas las empresas") no toca nada de Otra.
await db.exec(`set role authenticated`)
await como('aprobador@verticebi.com')
check('Vértice, viendo "todas", sigue viendo sus 8 empresas y no las de Otra', (await val(`select count(*)::int n, count(*) filter (where id like 'otra-%')::int otras from empresas`)).n === nEmpresas
  && (await val(`select count(*)::int otras from empresas where id like 'otra-%'`)).otras === 0)
await falla('Vértice no aprueba una factura de Otra', `select aprobar_factura($1, 'SEGUROS', 'TRANSFERENCIA')`, [fB2], /acceso a la empresa otra-uno/)
await falla('Vértice no edita una factura de Otra', `select editar_factura($1, $2)`, [fB2, JSON.stringify(datosEd({ numero: 9104 }))], /acceso a la empresa otra-uno/)
await como('tesoreria@verticebi.com')
await falla('Vértice no carga pagos en una empresa de Otra', `select registrar_pago($1)`, [pago({ empresa_id: 'otra-uno', importe: 10 })], /acceso a la empresa otra-uno/)
await falla('Vértice no anula pagos de Otra', `select anular_pago($1, 'x')`, [pB], /acceso a la empresa otra-uno/)
await falla('Vértice no guarda el mail de un proveedor de Otra', `select guardar_email_proveedor($1, 'x@verticebi.com')`, [provB.id], /Proveedor inexistente/)
await falla('Vértice no marca mails de facturas de Otra', `select marcar_mail_preparado($1)`, [[fB1]], /acceso a la empresa otra-uno/)
await como('administracion@verticebi.com')
await falla('Vértice no descarta un documento de Otra', `select descartar_documento($1, 'x')`, [dOrgB.id], /acceso a este documento/)
await falla('Vértice no libera pagos de Otra', `select liberar_pago_xubio($1, '', null, null)`, [pB], /acceso a la empresa otra-uno/)
await db.exec(`reset role`)
check('…y nada de Otra cambió', (await val(`select estado from facturas where id = $1`, [fB2])).estado === 'PENDIENTE_APROBACION' && (await val(`select email from proveedores where id = $1`, [provB.id])).email === 'cobranzas@otra-prov.com'
  && (await val(`select estado from pagos where id = $1`, [pB])).estado === 'CARGADO' && (await val(`select estado from documentos where id = $1`, [dOrgB.id])).estado === 'PENDIENTE')

// Lo que pregunta el servidor (funciones de Netlify) antes de actuar en nombre de una persona.
r = await val(`select usuario_ve_empresa('admin@otra.com', 'beratung') a, usuario_ve_empresa('tecnologia@verticebi.com', 'otra-uno') b,
  usuario_ve_empresa('admin@otra.com', 'otra-uno') c, usuario_ve_empresa('tecnologia@verticebi.com', 'beratung') d`)
check('servidor: "ve todas" no cruza de organización, en ninguno de los dos sentidos', r.a === false && r.b === false && r.c === true && r.d === true, JSON.stringify(r))
check('servidor: las empresas de quien ve todas en Otra son las dos de Otra', (await val(`select empresas_visibles_de('admin@otra.com') e`)).e.join() === 'otra-dos,otra-uno')
check('servidor: las de quien ve todas en Vértice siguen siendo las 8', (await val(`select empresas_visibles_de('aprobador@verticebi.com') e`)).e.length === nEmpresas)
check('servidor: quien tiene una sola empresa en Otra', (await val(`select empresas_visibles_de('aprob.uno@otra.com') e`)).e.join() === 'otra-uno')

// Dentro de Otra sigue valiendo el permiso por empresa.
await db.exec(`set role authenticated`)
await como('aprob.uno@otra.com')
r = await val(`select (select string_agg(id, ',') from empresas) e, (select count(*) from facturas where empresa_id <> 'otra-uno')::int f, (select count(*) from facturas)::int n, (select count(*) from usuarios)::int u`)
check('en Otra, quien tiene una sola empresa ve solo esa (y solo su usuario)', r.e === 'otra-uno' && r.f === 0 && r.n > 0 && r.u === 1, JSON.stringify(r))
await falla('…y no aprueba facturas de la otra empresa de su organización', `select aprobar_factura($1, 'x', 'TRANSFERENCIA')`, [fBdos], /acceso a la empresa otra-dos|no está pendiente/)
await db.exec(`reset role`)

// Una organización suspendida no deja entrar a su gente; la otra sigue igual.
await db.query(`update organizaciones set estado = 'SUSPENDIDA' where id = $1`, [orgB])
check('organización suspendida: el servidor ya no le reconoce ninguna empresa', (await val(`select usuario_ve_empresa('admin@otra.com', 'otra-uno') v`)).v === false
  && (await val(`select empresas_visibles_de('admin@otra.com') e`)).e.length === 0)
await db.exec(`set role authenticated`)
await como('admin@otra.com')
r = await val(`select (select count(*) from empresas)::int e, (select count(*) from facturas)::int f, (select count(*) from proveedores)::int p, (select count(*) from usuarios)::int u, (select count(*) from documentos)::int d, (select count(*) from auditoria)::int a`)
check('organización suspendida: su gente no ve nada', r.e + r.f + r.p + r.u + r.d + r.a === 0, JSON.stringify(r))
await falla('organización suspendida: su gente no opera', `select aprobar_factura($1, 'x', 'TRANSFERENCIA')`, [fB2], /no habilitada/)
await como('aprobador@verticebi.com')
check('…y Vértice sigue viendo lo suyo', (await val(`select count(*)::int n from empresas`)).n === nEmpresas)
await db.exec(`reset role`)
await db.query(`update organizaciones set estado = 'ACTIVA' where id = $1`, [orgB])

// Documentos: la cola por organización, y un adjunto nunca termina en una empresa de otra organización.
tomados = (await db.query(`select * from tomar_documentos(10, $1)`, [orgB])).rows
check('cola de una organización: toma solo sus documentos', tomados.length === 2 && tomados.every((x) => x.organizacion_id === orgB) && tomados.some((x) => x.id === dOrgB.id), tomados.map((x) => x.nombre_archivo).join())
check('…y los de Vértice siguen esperando', (await val(`select estado from documentos where id = $1`, [dOrgV.id])).estado === 'PENDIENTE')
check('cola sin decir la organización (null): no toma nada', (await db.query(`select * from tomar_documentos(10, null)`)).rows.length === 0)
check('las personas no pueden tomar documentos de la cola', !(await val(`select has_function_privilege('authenticated', 'tomar_documentos(integer,uuid)', 'execute') p`)).p)
await falla('un adjunto de Otra no se guarda como factura de una empresa de Vértice', `select guardar_factura_leida($1, $2)`, [dOrgB.id, leida({ empresa_id: 'india', numero: 9301 })], /otra organización que el archivo/)
check('…ni queda apuntando a nada de Vértice', (await val(`select factura_id from documentos where id = $1`, [dOrgB.id])).factura_id === null && (await val(`select count(*)::int n from facturas where numero = 9301`)).n === 0)
const fDocB = (await val(`select guardar_factura_leida($1, $2) id`, [dOrgB.id, leida({ empresa_id: 'otra-uno', numero: 9302 })])).id
r = await val(`select f.empresa_id, p.organizacion_id from facturas f join proveedores p on p.id = f.proveedor_id where f.id = $1`, [fDocB])
check('el adjunto de Otra se guarda en su empresa, con un proveedor de Otra', r.empresa_id === 'otra-uno' && r.organizacion_id === orgB, JSON.stringify(r))

// Quien no ve todas las empresas ve los archivos que se subieron para las suyas, aunque no terminaron en factura.
const dParaInd = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'para-india.pdf'), origen: 'MANUAL', organizacion_id: orgV, empresas_permitidas: ['india'] }])
const dParaDos = await val(`select * from registrar_documento($1)`, [{ ...doc('', 'para-india-y-beratung.pdf'), origen: 'MANUAL', organizacion_id: orgV, empresas_permitidas: ['india', 'beratung'] }])
const nSoloIndia = (await val(`select count(*)::int n from documentos where factura_id is null and empresas_permitidas = '{india}'`)).n
await db.exec(`set role authenticated`)
await como('aprob.india@verticebi.com')
r = await val(`select count(*)::int n, count(*) filter (where empresas_permitidas is null)::int sin_lista, count(*) filter (where not empresas_permitidas <@ '{india}')::int ajenos from documentos where factura_id is null`)
check('usuario de India: ve los archivos sin factura subidos solo para India', r.n === nSoloIndia && nSoloIndia > 0 && r.sin_lista === 0 && r.ajenos === 0, JSON.stringify(r))
await falla('…no puede descartar uno subido también para Beratung', `select descartar_documento($1, 'x')`, [dParaDos.id], /acceso a este documento/)
await falla('…ni uno de Gmail (sin lista)', `select descartar_documento($1, 'x')`, [dOrgV.id], /acceso a este documento/)
await db.query(`select descartar_documento($1, 'No era una factura')`, [dParaInd.id])
await db.exec(`reset role`)
check('…y sí puede descartar el que se subió para India', (await val(`select estado from documentos where id = $1`, [dParaInd.id])).estado === 'DESCARTADO')

// Registro de Xubio: siempre por empresa.
await db.exec(`set role authenticated`)
await como('administracion@verticebi.com')
r = await val(`select count(*)::int n, count(*) filter (where empresa_id is null)::int sin_empresa, count(*) filter (where empresa_id like 'otra-%')::int otra from xubio_log`)
check('registro de Xubio: Administración de Vértice ve el de sus empresas, no el de Otra ni el que no tiene empresa', r.n === cuenta.V.xubio_log && r.sin_empresa === 0 && r.otra === 0, JSON.stringify(r))
await como('tesoreria@verticebi.com')
check('registro de Xubio: Tesorería sigue sin verlo', (await val(`select count(*)::int n from xubio_log`)).n === 0)
await db.exec(`reset role`)

// ================================================================ Migrar una base que ya tiene datos (0017 en adelante)
// La base real tiene datos: las migraciones nuevas se aplican sobre una base cargada con las anteriores.
{
  const db2 = new PGlite()
  await db2.exec(SUPABASE_MINIMO)
  const v2 = async (sql, p = []) => (await db2.query(sql, p)).rows[0]
  const archivos = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
  const aplicar = async (lista) => { for (const f of lista) await db2.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')) }
  await aplicar(archivos.filter((f) => f < '0017'))
  // Datos como los de la base real: facturas de dos empresas, documentos, un pago, catálogos y auditoría.
  await db2.exec(`insert into usuarios (email, nombre, rol, todas_empresas) values ('aprobador@verticebi.com', 'Aprobador', 'APROBADOR', true);
    insert into usuarios (email, nombre, rol) values ('teso.india@verticebi.com', 'Tesorería India', 'TESORERIA');
    insert into usuarios_empresas (email, empresa_id) values ('teso.india@verticebi.com', 'india')`)
  await db2.query(`select ingresar_factura($1)`, [factura()])
  await db2.query(`select ingresar_factura($1)`, [factura({ empresa_id: 'india', numero: 2001, cuit_proveedor: '30-70000001-9', proveedor: 'Otro proveedor' })])
  const gd = await v2(`select * from registrar_documento($1)`, [doc('msg-viejo')])
  await db2.query(`select * from registrar_documento($1)`, [{ ...doc('', 'manual-viejo.pdf'), origen: 'MANUAL', empresas_permitidas: ['india'] }])
  await db2.query(`select tomar_documento($1)`, [gd.id])
  await db2.query(`select guardar_factura_leida($1, $2)`, [gd.id, leida()])
  await db2.query(`select espejar_catalogos($1)`, [JSON.stringify(cat)])
  await db2.exec(`insert into espejo_estado (hoja, filas) values ('Facturas', 10), ('Pagos', 5);
    insert into reglas_cuenta (empresa_id, patron, cuenta_contable) values (null, 'alquiler', 'ALQUILER DE OFICINA'), ('india', 'seguro', 'SEGUROS');
    insert into pagos (empresa_id, fecha, importe, medio, cargado_por, comprobante_path) values ('india', '2026-10-01', 100, 'TRANSFERENCIA', 'Vivi', '2026/1700000000000_comprobante.pdf');
    insert into auditoria (usuario, accion, entidad, entidad_id, detalle) select 'Vivi', 'PAGO_CARGADO', 'PAGO', id::text, 'x' from pagos;
    insert into auditoria (usuario, accion, entidad, entidad_id, detalle) values ('Sistema', 'AVISO', 'SISTEMA', null, 'sin entidad'), ('Sistema', 'AVISO', 'SISTEMA', 'texto-que-no-es-un-id', 'x')`)
  const TABLAS = ['empresas', 'usuarios', 'usuarios_empresas', 'proveedores', 'proveedores_empresa', 'documentos', 'facturas', 'pagos', 'auditoria', 'cuentas_contables', 'cuentas_origen', 'reglas_cuenta', 'productos_xubio', 'espejo_estado']
  const contar = async () => {
    const c = {}
    for (const t of TABLAS) c[t] = (await v2(`select count(*)::int n from ${t}`)).n
    return c
  }
  const antes = await contar()
  let error = ''
  try { await aplicar(archivos.filter((f) => f >= '0017')) } catch (e) { error = e.message }
  check('las migraciones nuevas se aplican sobre una base con datos', error === '', error)
  const despues = await contar()
  check('migrar no agrega ni saca filas de ninguna tabla', JSON.stringify(antes) === JSON.stringify(despues) && antes.auditoria >= 5 && antes.proveedores >= 3 && antes.documentos === 2, JSON.stringify(despues))
  const idV = (await v2(`select id from organizaciones`)).id
  for (const tabla of CON_ORGANIZACION)
    check(`base con datos: ${tabla} queda entera a nombre de Vértice`, (await v2(`select count(*) filter (where organizacion_id is distinct from $1)::int n from ${tabla}`, [idV])).n === 0)
  r = await v2(`select count(*) filter (where entidad in ('FACTURA', 'PAGO') and empresa_id is null)::int sin, count(*) filter (where entidad = 'PAGO' and empresa_id = 'india')::int pago,
    count(*) filter (where entidad = 'SISTEMA' and empresa_id is null)::int sistema from auditoria`)
  check('base con datos: la auditoría vieja queda con la empresa de su factura o su pago', r.sin === 0 && r.pago === 1 && r.sistema === 2, JSON.stringify(r))
  let inmutable = false
  try { await db2.exec(`update auditoria set detalle = 'x'`) } catch (e) { inmutable = /auditoría/.test(e.message) }
  check('base con datos: la auditoría sigue sin poder modificarse después de migrar', inmutable)
  await db2.query(`select ingresar_factura($1)`, [factura()])
  r = await v2(`select (select count(*) from proveedores)::int p, (select count(*) from facturas)::int f`)
  check('base con datos: reingresar una factura no duplica el proveedor ni la factura', r.p === antes.proveedores && r.f === antes.facturas, JSON.stringify(r))
  check('base con datos: el mismo adjunto de antes no vuelve a entrar', (await v2(`select * from registrar_documento($1)`, [doc('msg-viejo')])).nuevo === false)
  const antesDeCatalogos = await contar()
  await db2.query(`select espejar_catalogos($1)`, [JSON.stringify(cat)])
  check('base con datos: volver a copiar los catálogos no duplica', JSON.stringify(await contar()) === JSON.stringify(antesDeCatalogos) && antesDeCatalogos.productos_xubio === 1 && antesDeCatalogos.cuentas_origen === 1)
  await db2.exec(`set role authenticated`)
  await db2.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email: 'teso.india@verticebi.com' })])
  r = await v2(`select (select count(*) from empresas)::int e, (select count(*) from facturas)::int f, (select count(*) from pagos)::int p`)
  check('base con datos: quien veía solo India sigue viendo solo India', r.e === 1 && r.f === 2 && r.p === 1, JSON.stringify(r))
  await db2.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email: 'aprobador@verticebi.com' })])
  r = await v2(`select (select count(*) from empresas)::int e, (select count(*) from facturas)::int f, (select count(*) from proveedores)::int p, (select count(*) from documentos)::int d`)
  check('base con datos: quien veía todo sigue viendo todo', r.e === 8 && r.f === antes.facturas && r.p === antes.proveedores && r.d === antes.documentos, JSON.stringify(r))
  await db2.close()
}

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
