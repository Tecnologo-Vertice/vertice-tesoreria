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

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
