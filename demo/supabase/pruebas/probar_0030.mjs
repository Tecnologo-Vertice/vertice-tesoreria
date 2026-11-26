// Pruebas de 0030 (T-206, simulacro del período en paralelo): vínculo movimiento ↔ documento, cuenta del pago desde el
// texto de la hoja, pagos sin débito, contraparte de FCI, destino de cheques por categoría y unidad, control contra
// bancos. Bancos, importes y proveedores ficticios.
// Uso (desde demo/): node supabase/pruebas/probar_0030.mjs supabase/migrations
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'supabase/migrations'
const db = new PGlite()
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }
const val = async (sql, p = []) => (await db.query(sql, p)).rows[0]
const filas = async (sql, p = []) => (await db.query(sql, p)).rows

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
check('migraciones aplican (con 0030)', true)

// ---------------------------------------------------------------- Datos ficticios
const dax = (await val(`select id from unidades where empresa_id = 'beratung' and codigo = 'dax-salud'`)).id
const ber = (await val(`select id from unidades where empresa_id = 'beratung' and codigo = 'beratung'`)).id
const cuenta = async (nombre, banco, clase, unidad, extra = {}) => (await val(
  `insert into cuentas_origen (empresa_id, nombre, banco, clase, unidad_id, patrones, cuenta_madre_id) values ('beratung', $1, $2, $3, $4, $5, $6) returning id`,
  [nombre, banco, clase, unidad, extra.patrones ?? [], extra.madre ?? null])).id
const hipA = await cuenta('PRUEBA HIPOTECARIO CC 1111', 'HIPOTECARIO', 'CC', dax, { patrones: ['BANCO PRUEBA HIPOTECARIO CC 1111 BERATUNG'] })
const hipB = await cuenta('PRUEBA HIPOTECARIO CA 2222', 'HIPOTECARIO', 'CA', dax)
const icbc = await cuenta('PRUEBA ICBC CC 3333', 'ICBC', 'CC', ber)
const fci = await cuenta('PRUEBA FCI ICBC', 'ICBC', 'FCI', ber, { madre: icbc })
let n = 0
const mov = async (c, fecha, importe, extra = {}) => (await val(
  `insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, huella, categoria, estado, numero_cheque)
   values ('beratung', $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
  [c, fecha, extra.desc ?? 'MOVIMIENTO DE PRUEBA', importe, `PRUEBA-${n++}`, extra.categoria ?? 'SIN_CLASIFICAR', extra.estado ?? 'INFORMATIVO', extra.cheque ?? null])).id
const saldo = (c, fecha, s, origen = 'EXTRACTO') => db.query(
  `insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, 'beratung', $3, $4, 'prueba')
   on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, origen = excluded.origen`, [c, fecha, s, origen])
const pago = async (importe, fecha, extra = {}) => (await val(
  `insert into pagos (empresa_id, fecha, importe, medio, cargado_por, cuenta_origen, banco_origen, numero_cuenta, proveedor_destino, estado, estado_xubio_pago)
   values ('beratung', $1, $2, $3, 'prueba', $4, $5, $6, $7, 'CARGADO', 'SUBIDO')   -- 0034: al Flujo entran los pagos que están en Xubio
   returning id, cuenta_origen_id`,
  [fecha, importe, extra.medio ?? 'TRANSFERENCIA', extra.cuenta ?? null, extra.banco ?? null, extra.numero ?? null, extra.proveedor ?? 'Proveedor Prueba SRL']))
const linea = async (tipo, id) => val(`select l.fecha::text, l.importe::text, u.codigo as unidad, l.fila, l.afecta_bancos
  from flujo_lineas l join unidades u on u.id = l.unidad_id where l.origen_tipo = $1 and l.origen_id = $2 and l.naturaleza = 'REAL'`, [tipo, id])

// ---------------------------------------------------------------- 3. La cuenta del pago desde el texto de la hoja
check('cuenta por patrón contenido en el texto ("BANCO_PRUEBA_HIPOTECARIO_CC_1111_BERATUNG …")',
  (await pago(10, '2026-11-02', { cuenta: 'BANCO_PRUEBA_HIPOTECARIO_CC_1111_BERATUNG Banco Prueba Hipotecario CC 1111 BERATUNG' })).cuenta_origen_id === hipA)
check('cuenta por banco + últimos 4 dígitos ("Banco Hipotecario", "XXXX - 2222")',
  (await pago(11, '2026-11-02', { banco: 'Banco Hipotecario', numero: 'XXXX - 2222' })).cuenta_origen_id === hipB)
check('dos cuentas del mismo banco y sin número: no adivina (queda vacía)',
  (await pago(12, '2026-11-02', { banco: 'Banco Hipotecario' })).cuenta_origen_id === null)
check('banco con una sola cuenta: esa ("ICBC")', (await pago(13, '2026-11-02', { banco: 'ICBC' })).cuenta_origen_id === icbc)
check('banco desconocido: vacía', (await pago(14, '2026-11-02', { banco: 'Banco Inexistente' })).cuenta_origen_id === null)
await db.exec(`delete from pagos`)

// ---------------------------------------------------------------- 1, 2. Pago ↔ débito: no se cuenta dos veces
// Para el control de la unidad, solo esta cuenta exige extracto (las demás de Dax Salud quedan afuera en la prueba).
await db.query(`update cuentas_origen set requiere_extracto = (id = $1) where unidad_id = $2`, [hipA, dax])
await saldo(hipA, '2026-11-03', 1000)
const p1 = (await pago(250, '2026-11-04', { banco: 'Banco Hipotecario', numero: 'XXXX-1111' })).id
const m1 = await mov(hipA, '2026-11-05', -250, { desc: 'N/D - TRANSF ENV INMEDIATA' })
check('el débito (INFORMATIVO) se vincula al pago: mismo importe, misma cuenta, 1 día después',
  (await val(`select pago_id from movimientos_bancarios where id = $1`, [m1])).pago_id === p1)
check('el débito vinculado no entra al Flujo (entra el pago)', !(await linea('MOVIMIENTO', m1)))
const l1 = await linea('PAGO', p1)
check('el pago entra el día del banco (05/11) y en la unidad de la cuenta (Dax Salud)', l1?.fecha === '2026-11-05' && l1?.unidad === 'dax-salud', JSON.stringify(l1))
await saldo(hipA, '2026-11-05', 750)
check('control: banco −250 = real −250 → Ok', (await val(`select estado from flujo_control where unidad_id = $1 and fecha = '2026-11-05'`, [dax]))?.estado === 'OK')

// Débito sin documento: cuenta igual (aunque su categoría sea PAGO).
const m2 = await mov(hipA, '2026-11-06', -40, { categoria: 'PAGO', estado: 'PENDIENTE' })
check('un débito con categoría PAGO sin pago vinculado SÍ entra al Flujo (antes desaparecía)', (await linea('MOVIMIENTO', m2))?.importe === '-40.00')
await saldo(hipA, '2026-11-06', 710)
check('… y el control cierra con ese débito', (await val(`select estado from flujo_control where unidad_id = $1 and fecha = '2026-11-06'`, [dax]))?.estado === 'OK')

// ---------------------------------------------------------------- 7. Pago sin débito
const p3 = (await pago(999, '2026-11-06', { banco: 'Banco Hipotecario', numero: '1111' })).id
check('pago de una cuenta con extracto que el banco no muestra: no entra al Flujo', !(await linea('PAGO', p3)))
await mov(hipA, '2026-11-12', -1, { desc: 'COMISION' })
check('… y aparece en pagos_sin_debito cuando el extracto cubre 5 días después',
  (await val(`select count(*)::int n from pagos_sin_debito where id = $1`, [p3])).n === 1)
const p4 = (await pago(999, '2026-11-07', { banco: 'Banco Hipotecario', numero: '1111' })).id
check('otro pago igual al mismo proveedor dentro de 5 días: marcado como posible duplicado',
  (await val(`select posible_duplicado from pagos_sin_debito where id = $1`, [p4])).posible_duplicado === true)
const pFut = (await pago(77, '2026-11-20', { banco: 'Banco Hipotecario', numero: '1111' })).id
check('pago con fecha que el extracto todavía no cubre: cuenta en su fecha (provisorio)', (await linea('PAGO', pFut))?.fecha === '2026-11-20')
const m4 = await mov(hipA, '2026-11-08', -999, { desc: 'TRANSF' })
check('cuando llega el débito, se vincula al pago igual de fecha más cercana (07/11) y ese pago vuelve al Flujo el 08/11',
  (await val(`select pago_id from movimientos_bancarios where id = $1`, [m4])).pago_id === p4 && (await linea('PAGO', p4))?.fecha === '2026-11-08')
check('… el otro (06/11) sigue sin débito: no cuenta', !(await linea('PAGO', p3)))
await db.query(`update pagos set estado = 'ANULADO' where id = $1`, [p4])
check('anular el pago vinculado suelta el débito y lo toma el otro pago igual (06/11)',
  (await val(`select pago_id from movimientos_bancarios where id = $1`, [m4])).pago_id === p3 && (await linea('PAGO', p3))?.fecha === '2026-11-08')

// ---------------------------------------------------------------- 6. Efectivo
const pc = (await pago(30, '2026-11-06', { medio: 'CAJA', banco: 'Caja' })).id
check('pago en efectivo: no entra al Flujo (0034: se excluye como el motor; impacta por la reposición del fondo fijo)', !(await linea('PAGO', pc)))

// ---------------------------------------------------------------- 4. FCI: la suscripción no es rendimiento
await saldo(icbc, '2026-11-03', 5000); await saldo(fci, '2026-11-03', 0, 'TENENCIA')
const mf = await mov(icbc, '2026-11-04', -4000, { categoria: 'FCI', desc: 'DEB SUSCR FCI', estado: 'CONTABILIZADO' })
check('suscripción desde la cuenta madre: el FCI único queda como contraparte',
  (await val(`select contraparte_cuenta_id from movimientos_bancarios where id = $1`, [mf])).contraparte_cuenta_id === fci)
await saldo(icbc, '2026-11-04', 1000); await saldo(fci, '2026-11-04', 4001.5, 'TENENCIA')
check('rendimiento del FCI ese día = 1,50 (no 4.001,50)',
  (await val(`select rendimiento::text r from conciliacion_bancaria where cuenta_origen_id = $1 and fecha = '2026-11-04'`, [fci])).r === '1.50')

// ---------------------------------------------------------------- 5. Cheques por categoría del acreedor y unidad
const org = (await val(`select organizacion_id from empresas where id = 'beratung'`)).organizacion_id
const acr = (await val(`insert into acreedores (organizacion_id, nombre, tipo, categoria) values ($1, 'FINANCIERA PRUEBA', 'FINANCIERA', 'FPRUEBA') returning id`, [org])).id
const filaFin = (await val(`insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta) values ($1, 'beratung', 850, 'CUENTA', 'DEVOLUCION_DEUDA', 'Cheques Financieras PRUEBA') returning id`, [ber])).id
await db.query(`insert into flujo_reglas (organizacion_id, empresa_id, prioridad, si_origen, si_categoria, si_unidad_id, unidad_id, fila_id, nota)
                values ($1, 'beratung', 50, 'CHEQUE', 'FPRUEBA', $2, $2, $3, 'prueba')`, [org, ber, filaFin])
const ch = (await val(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, beneficiario, importe, fecha_emision, fecha_pago, estado, debitado_en, creado_por)
  values ('beratung', $1, 'ECHEQ', '55551234', $2, 'FINANCIERA PRUEBA', 500, '2026-10-01', '2026-11-04', 'DEBITADO', '2026-11-04', 'prueba') returning id`, [icbc, acr])).id
const mc = await mov(icbc, '2026-11-05', -500, { categoria: 'CHEQUE_PAGADO', estado: 'PENDIENTE', cheque: '1234' })
check('el débito del cheque se vincula al cheque debitado (mismo importe y cuenta, número coincide)',
  (await val(`select cheque_id from movimientos_bancarios where id = $1`, [mc])).cheque_id === ch)
check('el cheque va a la fila de su categoría en su unidad, no a "Sin clasificar"', (await linea('CHEQUE', ch))?.fila === 'Cheques Financieras PRUEBA')
const chDax = (await val(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, beneficiario, importe, fecha_emision, fecha_pago, estado, debitado_en, creado_por)
  values ('beratung', $1, 'ECHEQ', '77770001', $2, 'FINANCIERA PRUEBA', 80, '2026-10-01', '2026-11-04', 'DEBITADO', '2026-11-04', 'prueba') returning id`, [hipB, acr])).id
const lDax = await linea('CHEQUE', chDax)
check('la regla pide unidad (si_unidad_id): un cheque de Dax Salud con la misma categoría no la toma', lDax?.unidad === 'dax-salud' && lDax?.fila === 'Sin clasificar', JSON.stringify(lDax))

// ---------------------------------------------------------------- 8. Lo real de un banco no se excluye ni cambia de unidad
await db.query(`insert into flujo_reglas (organizacion_id, empresa_id, prioridad, si_origen, si_texto, excluir, nota)
                values ($1, 'beratung', 1, 'PAGO', 'BERATUNG S.A.', true, 'transferencia propia (prueba)')`, [org])
const pt = (await pago(321, '2026-11-04', { banco: 'ICBC', proveedor: 'BERATUNG S.A.' })).id
const mt = await mov(icbc, '2026-11-04', -321, { desc: 'TRANSF CTA PROPIA' })
const lt = await linea('PAGO', pt)
check('transferencia propia registrada como pago y vinculada a su débito: no se excluye; va a "Entre cuentas propias" de la unidad de la cuenta',
  lt?.unidad === 'beratung' && lt?.fila === 'Entre cuentas propias', JSON.stringify(lt))
const ptSin = (await pago(654, '2026-11-25', { proveedor: 'BERATUNG S.A.' })).id
check('… un pago sin cuenta que la regla excluye sigue excluido', !(await linea('PAGO', ptSin)) && mt !== null)

// ---------------------------------------------------------------- Seguridad
await db.exec(`set role authenticated`)
let negado = false
try { await db.query(`select conciliar_movimientos('beratung')`) } catch { negado = true }
check('conciliar_movimientos no la puede llamar un usuario (solo el servidor)', negado)
await db.exec(`reset role`)

console.log(`\n${ok} OK · ${mal} MAL`)
if (mal) process.exit(1)
