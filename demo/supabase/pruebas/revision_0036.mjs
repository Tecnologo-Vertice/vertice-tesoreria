// Revisión independiente de 0036 (agente 06, 27/11/2026). Los "BUG" son comportamientos que el Apps Script no tiene o
// que rompen algo; los "OK" son controles. Datos ficticios. No toca producción.
// Uso (desde demo/): node supabase/pruebas/revision_0036.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, bug = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else bug++; console.log(`${cond ? 'OK ' : 'BUG'} ${nombre}${!cond && extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
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
const archivos = readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()
const aplicar = async (f) => db.exec(readFileSync(join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''))
for (const f of archivos.filter((x) => x < '0036')) {
  if (f.startsWith('0021')) await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  await aplicar(f)
}

// ---------------------------------------------------------------- Base "real" antes de 0036: datos que ya existen
await servidor()
const hoy = (await val(`select hoy_ar()::text d`)).d
const dia = (k) => new Date(Date.parse(hoy) + k * 86400000).toISOString().slice(0, 10)
await db.exec(`
  insert into usuarios (email, nombre, rol, todas_empresas) values
    ('teso@prueba.com', 'Teso', 'TESORERIA', true), ('aprob@prueba.com', 'Aprob', 'APROBADOR', true);`)
const uIndia = (await val(`select id from unidades where empresa_id = 'india' and por_defecto`)).id
const chq = (await val(`insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id) values ('india', 'BANCO PRUEBA CC-0001', 'BANCOPRUEBA', 'CC', $1) returning id`, [uIndia])).id
const prov = async (cuit, nombre) => (await val(`insert into proveedores (cuit, nombre) values ($1, $2) returning id`, [cuit, nombre])).id
const pA = await prov('30710000001', 'Proveedor Uno SA')
const pB = await prov('30710000002', 'Proveedor Dos SRL')
// Cheques cargados desde planillas: uno con ceros a la izquierda, uno ANULADO.
await db.query(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, beneficiario, importe, fecha_emision, fecha_pago, origen, creado_por)
  values ('india', $1, 'FISICO', '000123', 'Planilla SA', 1000, $2, $3, 'MANUAL', 'planilla'),
         ('india', $1, 'FISICO', '777', 'Planilla SA', 1000, $2, $3, 'MANUAL', 'planilla')`, [chq, dia(-20), dia(20)])
await db.query(`update cheques set estado = 'ANULADO', anulado_por = 'x', anulado_en = now(), motivo_anulacion = 'x' where numero = '777'`)
// Pagos viejos: tarjeta "pagada antes de aprobar" sin comprobante, uno de la hoja con la misma descripción, uno de caja.
const pagoViejo = async (extra) => (await val(
  `insert into pagos (empresa_id, proveedor_id, fecha, importe, medio, cargado_por, descripcion, estado, gestion, hoja_id, forma_carga_xubio, cuenta_origen, xubio_id, contabilizado_por, contabilizado_en)
   values ('india', $1, $2, $3, $4, 'x', $5, $6, $7, $8, 'ORDEN_PAGO', $9, 'X1', 'x', now()) returning id`,
  [extra.prov ?? pA, dia(-3), extra.importe ?? 500, extra.medio ?? 'TRANSFERENCIA', extra.desc ?? 'Factura 1-5 pagada antes de aprobar', extra.estado ?? 'CONTABILIZADO', extra.gestion ?? 'SISTEMA', extra.hoja ?? null, extra.cuenta ?? 'BANCO PRUEBA CC-0001'])).id
const vTarjeta = await pagoViejo({ medio: 'TARJETA', importe: 111 })
const vHoja = await pagoViejo({ gestion: 'HOJA', hoja: 'H-1', importe: 222 })
const vCaja = await pagoViejo({ medio: 'CAJA', importe: 333, cuenta: 'Caja' })
const vBanco = await pagoViejo({ importe: 444 })
// Pago de la hoja sin proveedor_id, con destino distinto (así llegan muchos de la copia de la hoja).
await db.query(`update pagos set proveedor_destino = 'Otro Distinto SA', proveedor_id = null where id = $1`, [vHoja])

// ---------------------------------------------------------------- Se aplica 0036 sobre esa base
const e1 = await error(`select 1`)
let falloMig = null
try { await aplicar('0036_pagos_y_cheques.sql') } catch (e) { falloMig = e.message }
check('0036 se aplica sobre una base con cheques de planilla y pagos viejos', falloMig === null, falloMig ?? '')
if (falloMig) process.exit(1)
const flag = async (id) => (await val(`select falta_comprobante f from pagos where id = $1`, [id])).f
check('backfill: pago viejo por banco sin comprobante queda marcado', (await flag(vBanco)) === true)
check('backfill: pago de caja no se marca', (await flag(vCaja)) === false)
check('backfill: pago viejo con TARJETA no se marca (el Apps Script excluye "tarjeta de crédito": se paga con el resumen)', (await flag(vTarjeta)) === false,
  'queda en la solapa "Falta comprobante" y nadie tiene un comprobante que cargar')
check('backfill: un pago de la hoja (gestion = HOJA) no debería marcarse desde acá', (await flag(vHoja)) === false, 'la hoja es la que manda; se marcó por la descripción')

// Segunda corrida de 0036 (se puede correr dos veces) y qué pasa con lo ya completado.
await db.query(`update pagos set comprobante_path = null, falta_comprobante = false where id = $1`, [vBanco])
let seg = null
try { await aplicar('0036_pagos_y_cheques.sql') } catch (e) { seg = e.message }
check('0036 se puede volver a correr', seg === null, seg ?? '')
check('segunda corrida: un pago al que se le quitó el comprobante vuelve a marcarse solo por el backfill (informativo)', (await flag(vBanco)) === true)

// ---------------------------------------------------------------- Nuevo flujo
await servidor()
const factura = async (empresa, proveedor, total, extra = {}) => (await val(
  `insert into facturas (empresa_id, proveedor_id, tipo, letra, punto_venta, numero, fecha, vencimiento, neto, total, estado, pagado, cuenta_contable)
   values ($1, $2, 'Factura A', 'A', 1, $3, $4, $5, $6, $6, $7, 0, 'PROVEEDORES LOCALES') returning id`,
  [empresa, proveedor, 9000 + Math.floor(Math.random() * 900000), dia(-10), dia(10), total, extra.estado ?? 'PENDIENTE_APROBACION'])).id
await como('teso@prueba.com')
const registrar = async (extra) => (await val(`select registrar_pago($1) id`, [{
  empresa_id: 'india', fecha: hoy, importe: 1000, medio: 'TRANSFERENCIA', cuenta_origen: 'BANCO PRUEBA CC-0001', forma_carga_xubio: 'SALIDA_FONDOS', ...extra }])).id
const pagoDe = async (id) => val(`select * from pagos where id = $1`, [id])

// Cheque que ya estaba en la planilla (con ceros): no se duplica.
const pPl = await registrar({ proveedor_id: pA, medio: 'CHEQUE', numero_cheque: '123', fecha_acreditacion: dia(20), importe: 1000 })
check('cheque de planilla "000123" y pago con "123": no se duplica, se vincula', (await val(`select count(*)::int n from cheques where ltrim(numero, '0') = '123'`)).n === 1
  && (await val(`select count(*)::int n from cheques_pagos where pago_id = $1`, [pPl])).n === 1, (await pagoDe(pPl)).aviso_cheque)

// Cheque ANULADO con el mismo número: la clave única (chequera, tipo, número) lo rechaza.
const pAn = await registrar({ proveedor_id: pA, medio: 'CHEQUE', numero_cheque: '777', fecha_acreditacion: dia(20), importe: 1000 })
const pAnD = await pagoDe(pAn)
check('cheque con el número de uno ANULADO: el pago se carga igual', pAnD.id === pAn)
check('…y el aviso es entendible (no una clave única de la base)', !/duplicate key|violates|unique/i.test(pAnD.aviso_cheque ?? ''), pAnD.aviso_cheque)
check('…y no se carga solo: el aviso dice qué hacer (decisión: un número anulado no se reutiliza solo)', (await val('select count(*)::int n from cheques_pagos where pago_id = $1', [pAn])).n === 0 && /anulado o rechazado/.test(pAnD.aviso_cheque ?? '') && /cargalo desde Cheques/.test(pAnD.aviso_cheque ?? ''), pAnD.aviso_cheque)

// Posible duplicado contra un pago de la hoja sin proveedor_id y con otro destino.
const pDup = await registrar({ proveedor_id: pB, importe: 222, fecha: dia(-3) })
check('posible duplicado: un pago de OTRO destino (la hoja lo trae solo como texto, sin proveedor_id) no se marca por el solo importe', (await pagoDe(pDup)).posible_duplicado === null,
  (await pagoDe(pDup)).posible_duplicado)

// SIN_FACTURA y el resto de los pagos a proveedor
const pSF = await registrar({ proveedor_id: pB, importe: 5000 })
check('registrar_pago a proveedor sin facturas: queda SIN_FACTURA', (await pagoDe(pSF)).tipo_pago === 'SIN_FACTURA')
const pBanco = await registrar({ importe: 5001 })
check('registrar_pago sin proveedor: no queda SIN_FACTURA', (await pagoDe(pBanco)).tipo_pago === null)

// Quitar comprobante: no vuelve a "falta comprobante", y se puede en un pago anulado.
await servidor()
await db.query(`update pagos set comprobante_path = 'x/y.pdf' where id = $1`, [pSF])
await como('teso@prueba.com')
await db.query(`select quitar_comprobante_pago($1)`, [pSF])
check('(informativo) quitar comprobante vuelve a marcar "falta comprobante"', (await pagoDe(pSF)).falta_comprobante === true,
  'queda sin comprobante y fuera de la solapa Falta comprobante')

// ya pagada con TARJETA: falta_comprobante
await como('aprob@prueba.com')
await servidor(); const fT = await factura('india', pA, 700); const fT2 = await factura('india', pA, 800); await como('aprob@prueba.com')
await db.query(`select aprobar_factura_ya_pagada($1, 'GASTOS VARIOS', 'TARJETA', $2)`, [fT, { cuenta_origen: 'BANCO PRUEBA CC-0001', fecha: hoy }])
const pT = await val(`select p.falta_comprobante f from pagos p join pagos_facturas pf on pf.pago_id = p.id where pf.factura_id = $1`, [fT])
check('aprobar ya pagada con TARJETA: el pago no queda "falta comprobante" (Apps Script: tarjeta no entra a la solapa)', pT.f === false)

// Factura aprobada con tarjeta: "Pagadas" la muestra sin pago (para la pantalla).

await db.query(`select aprobar_factura_y_vincular($1, 'GASTOS VARIOS', 'TARJETA')`, [fT2])
check('factura de tarjeta PAGADA no tiene fila en pagos (la pantalla Pagadas mostraba "Para contabilizar" y "por undefined")', (await val(`select count(*)::int n from pagos_facturas where factura_id = $1`, [fT2])).n === 0)

// Permisos
await servidor()
const priv = async (fn, rol) => (await val(`select has_function_privilege($1, $2::regprocedure, 'execute') t`, [rol, fn])).t
for (const fn of ['aprobar_factura_interna(uuid,text,metodo_pago,integer,boolean)', 'vincular_pago_interno(uuid,uuid,usuarios)', 'crear_cheque_de_pago(uuid,usuarios)', 'posible_duplicado_pago(uuid)', 'acreedor_mas_usado(uuid[])'])
  check(`permiso: ${fn} no es llamable por authenticated ni anon`, !(await priv(fn, 'authenticated')) && !(await priv(fn, 'anon')))
for (const fn of ['aprobar_factura_y_vincular(uuid,text,metodo_pago,integer)', 'vincular_pago_sin_factura(uuid,uuid)', 'corregir_proveedor_pago(uuid,uuid)', 'adjuntar_comprobante_pago(uuid,text,text)', 'quitar_comprobante_pago(uuid)'])
  { const a = await priv(fn, 'authenticated'), n = await priv(fn, 'anon'); check(`permiso: ${fn} lo llama authenticated`, a); check(`permiso: ${fn} no lo llama anon (falta revoke from public, anon)`, !n) }
check('vistas nuevas: anon sin acceso', !(await val(`select has_table_privilege('anon', 'pagos_sin_factura', 'select') a`)).a && !(await val(`select has_table_privilege('anon', 'movimientos_cheque_sugerido', 'select') a`)).a)

console.log(`\n${ok} OK · ${bug} BUG`)
process.exit(0)
