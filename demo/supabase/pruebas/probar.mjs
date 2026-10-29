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
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated;
`)

for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')); check(`migración ${f}`, true) }
  catch (e) { check(`migración ${f}`, false, e.message); process.exit(1) }
}
// Proyecto creado con "Automatically expose new tables" desmarcado: los únicos permisos son los de 0007.
await db.exec(`insert into usuarios (email, nombre, rol) values ('aprobador@verticebi.com', 'Aprobador', 'APROBADOR'), ('direccion@verticebi.com', 'Dirección', 'DIRECCION')`)
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

// Guido lo contabiliza (en seco) en el sistema nuevo: desde ahí la hoja no lo pisa.
await db.query(`select marcar_pago_revisado($1, 'Gastos Generales', 'ORDEN_PAGO', 'En seco', 'Guido', 'ADMINISTRACION')`, [pe1.id])
check('contabilizado en el sistema nuevo: gestión SISTEMA', (await val(`select gestion from pagos where id = $1`, [pe1.id])).gestion === 'SISTEMA')
ep = await espPag([filaP({ CUENTA_CONTABLE: 'Otra cuenta', OBSERVACIONES_TESORERIA: 'cambio en la hoja' })])
check('la hoja cambia la cuenta: no pisa lo que decidió el sistema', (await val(`select estado, cuenta_contable from pagos where id = $1`, [pe1.id])).estado === 'REVISADO')
ep = await espPag([filaP({ _fila: 8, ID_PAGO: 'PAGO-1792698007000-0', FACTURA_ASOCIADA: '', TIPO_PAGO: 'SIN_FACTURA', EMPRESA: 'Droguería Robles', ESTADO_CONTABLE: 'CONTABILIZADA', ESTADO_XUBIO_PAGO: 'SIN_ERP_XUBIO' })])
check('pago de Robles contabilizado en producción sin cargar en Ralpharma: bandeja Ralpharma', (await val(`select estado from pagos where hoja_id = 'PAGO-1792698007000-0'`)).estado === 'PENDIENTE_RALPHARMA')

const malo = trad([filaF({ NUMERO: '00007-00000999' })], 'Facturas').map((x) => ({ ...x, estado: 'INVENTADO' }))
const rMalo = (await val(`select espejar_facturas($1) r`, [JSON.stringify(malo)])).r
check('una fila que la base rechaza se omite con el motivo, sin cortar la copia', rMalo.omitidas.length === 1 && /estado_factura|invalid/i.test(rMalo.omitidas[0].motivo), rMalo.omitidas[0]?.motivo)
for (const r of ['anon', 'authenticated'])
  check(`${r} NO puede copiar facturas de la hoja`, !(await val(`select has_function_privilege($1, 'espejar_facturas(jsonb)', 'execute') p`, [r])).p)
check('los usuarios ven el estado de la copia', (await val(`select has_table_privilege('authenticated', 'espejo_estado', 'select') p`)).p)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
