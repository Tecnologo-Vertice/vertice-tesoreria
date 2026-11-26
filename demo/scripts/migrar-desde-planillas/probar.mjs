// Prueba del script de migración con planillas FICTICIAS (fixtures.mjs): arma el plan, lo carga en PGlite,
// verifica el control (planilla = a cargar + cubiertas + no mapeadas), lo vuelve a cargar (no duplica) y revisa
// casos puntuales. Uso (desde demo/): npm run test:migracion
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformar } from './transformar.mjs'
import { cargar, verificar } from './cargar.mjs'
import { armarReporte } from './reporte.mjs'
import { basePrueba, opciones } from './migrar.mjs'
import { planillasFicticias } from './fixtures.mjs'
import { centavosDeTexto, fecha } from './leer.mjs'

const aqui = dirname(fileURLToPath(import.meta.url))
let ok = 0, mal = 0
const check = (nombre, cond, extra = '') => { if (cond) ok++; else mal++; console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra !== '' ? ' · ' + extra : ''}`) }

// ---------------------------------------------------------------- Lectura de celdas
check('importe AR "1.234.567,89" → 123456789 centavos', centavosDeTexto('1.234.567,89') === 123456789n)
check('importe "-164321,19" → negativo', centavosDeTexto('-164321,19') === -16432119n)
check('importe "24301.31" (punto decimal) → 2430131', centavosDeTexto('24301.31') === 2430131n)
check('importe "$10.980.750" → 1098075000', centavosDeTexto('$10.980.750') === 1098075000n)
check('fecha "11/20/2026" con mdy → 2026-11-20', fecha({ t: '11/20/2026', n: null }, { mdy: true }) === '2026-11-20')
check('fecha "05/11/2026" (d/m) → 2026-11-05', fecha({ t: '05/11/2026', n: null }) === '2026-11-05')
check('fecha como número de serie (46351) → 2026-11-25', fecha({ t: 'x', n: 46351 }) === '2026-11-25')

// ---------------------------------------------------------------- Transformación + carga
const op = opciones(['--hoy', '2026-11-26'])
const { plan, control } = transformar(planillasFicticias(), op)
const db = await basePrueba(join(aqui, '../../supabase/migrations'))
const c1 = await cargar(db, plan)
const c2 = await cargar(db, plan)
const verificado = await verificar(db, plan)
const { cierra, verifOk, idem, texto } = armarReporte({ control, carga1: c1, carga2: c2, verificado, op, origen: 'fixtures ficticios', generado: 'prueba' })
check('control: planilla = a cargar + cubiertas + no mapeadas en todas las tablas', cierra)
check('lo que quedó en la base = lo planeado', verifOk)
check('segunda corrida: 0 altas y 0 cambios (idempotente)', idem, JSON.stringify(Object.fromEntries(Object.entries(c2).filter(([, v]) => v.altas || v.cambios))))
check('el reporte enmascara números largos (no aparece "02104552")', !texto.includes('02104552'))

const q = async (sql, p = []) => (await db.query(sql, p)).rows
const uno = async (sql, p = []) => (await q(sql, p))[0]
const nm = (t) => control.tablas[t].noMapeadas.map((x) => x.motivo).join(' | ')

// Cuentas
check('cuenta con [FALTA] en la planilla: no se carga y queda en la lista', /\[FALTA\]/.test(nm('cuentas_origen')))
check('FCI con cuenta madre (la CC del mismo banco)', (await uno(`select m.nombre from cuentas_origen c join cuentas_origen m on m.id = c.cuenta_madre_id where c.nombre = 'PRUEBA FCI'`))?.nombre === 'PRUEBA CC 1111')
check('Mercado Pago: billetera que rinde todos los días', (await uno(`select clase, rinde_diario from cuentas_origen where empresa_id = 'india' and nombre = 'MERCADO PAGO'`))?.rinde_diario === true)
check('BERATUNG/DAX → unidad Dax Salud', (await uno(`select u.codigo from cuentas_origen c join unidades u on u.id = c.unidad_id where c.nombre = 'PRUEBA CC 2222'`))?.codigo === 'dax-salud')
check('cheque de un banco sin cuenta → chequera creada y avisada', (await uno(`select clase, requiere_extracto from cuentas_origen where nombre = 'CHEQUERA GALICIA'`))?.requiere_extracto === false)

// Reglas de extracto
check('regla que ya está (0024) no se duplica; la nueva se agrega', (await uno(`select count(*)::int n from reglas_extracto where orden in (10, 91)`)).n === 2)

// Movimientos y saldos
check('movimientos antes del corte quedan fuera', !(await uno(`select 1 from movimientos_bancarios where huella = 'VBI:EXT-viejo'`)))
check('dos impuestos iguales del mismo día y referencia entran los dos', (await uno(`select count(*)::int n from movimientos_bancarios where huella in ('VBI:EXT-a2', 'VBI:EXT-a3')`)).n === 2)
check('CONTABILIZADO en VBI+ → CONTABILIZADO (no se vuelve a mandar a Xubio)', (await uno(`select estado from movimientos_bancarios where huella = 'VBI:EXT-a3'`)).estado === 'CONTABILIZADO')
check('banco desconocido → no mapeada con motivo', /no reconocida/.test(nm('movimientos_bancarios')))
check('Bancos Movimientos: lo que ya está en Extractos no se duplica; lo nuevo entra A_REVISAR',
  (await uno(`select count(*)::int n from movimientos_bancarios where huella like 'MOTOR:%' and estado = 'A_REVISAR'`)).n === 1)
check('saldo "SIN MOVIMIENTOS" con fecha 11/20/2026 (m/d)', (await uno(`select s.origen from saldos_bancarios s join cuentas_origen c on c.id = s.cuenta_origen_id where c.nombre = 'PRUEBA CC 1111' and fecha = '2026-11-20'`))?.origen === 'SIN_MOVIMIENTOS')
check('dos filas el mismo día y cuenta: queda la última (5001,50, tenencia de FCI)',
  JSON.stringify(await uno(`select s.saldo::text, s.origen from saldos_bancarios s join cuentas_origen c on c.id = s.cuenta_origen_id where c.nombre = 'PRUEBA FCI'`)) === JSON.stringify({ saldo: '5001.50', origen: 'TENENCIA' }))
check('Flujo original: completa los días sin conciliación (24/11 = 1970) como MANUAL',
  JSON.stringify(await uno(`select s.saldo::text, s.origen from saldos_bancarios s join cuentas_origen c on c.id = s.cuenta_origen_id where c.nombre = 'PRUEBA CC 1111' and fecha = '2026-11-24'`)) === JSON.stringify({ saldo: '1970.00', origen: 'MANUAL' }))

// Proyecciones
const pr = await q(`select concepto, importe::text, recurrencia, hasta::text, origen, f.etiqueta from proyecciones p join flujo_filas f on f.id = p.fila_id where p.empresa_id = 'india' order by concepto, fecha_inicio`)
const pfp = pr.find((x) => x.concepto.startsWith('PFP X000001') && x.recurrencia === 'MENSUAL')
check('PFP de Gastos Fijos: mensual, egreso, hasta según el rótulo (12 cuotas desde 10-2026 → 30/09/2027)', pfp && pfp.importe === '-1000.00' && pfp.hasta === '2027-09-30' && pfp.origen === 'PLAN_PAGO', JSON.stringify(pfp))
const seg = pr.find((x) => x.concepto === '53001007 SEGUROS' && x.recurrencia === 'MENSUAL')
check('gasto fijo sin HASTA: hasta el horizonte (a confirmar)', seg?.hasta === op.horizonte)
check('celda del original que ya cubre el gasto fijo del mes no se duplica (10/12 SEGUROS)', !pr.some((x) => x.concepto === '53001007 SEGUROS' && x.recurrencia === 'UNICA'))
check('otras celdas del mismo mes en otra fila sí entran (300 y 500)', pr.filter((x) => x.concepto.startsWith('PROVEEDORES LOCALES') && x.recurrencia === 'UNICA').length === 2)
check('celda del original antes de hoy no es proyección (nada con fecha < 26/11)', (await uno(`select count(*)::int n from proyecciones where recurrencia = 'UNICA' and fecha_inicio < '2026-11-26'`)).n === 0)
check('cobranza del original: proyección positiva', pr.some((x) => x.importe === '5000.00' && x.origen === 'COBRANZA'))
check('fila de plan CANCELADO: no se carga', !pr.some((x) => x.concepto.includes('CANCELADO')))
check('gasto fijo de una fila que no existe: va a "Sin clasificar" y avisa', pr.some((x) => x.concepto === 'FILA QUE NO EXISTE' && x.etiqueta === 'Sin clasificar'))

// Ajustes
check('cambio manual ELIMINAR con "antes" que coincide → ajuste eliminada', (await uno(`select count(*)::int n from flujo_ajustes where eliminada`)).n === 1)
check('cambio manual con "antes" que no coincide → no mapeado (decidir a mano)', /no coincide/.test(nm('flujo_ajustes')))
check('el ajuste ELIMINAR saca la línea del Flujo', (await uno(`select count(*)::int n from flujo_lineas l join proyecciones p on p.id = l.origen_id where p.concepto like 'PROVEEDORES LOCALES%' and l.fecha_calculada = '2026-12-10'`)).n === 0)

// Reglas del Flujo
check('Mapa: PROVEEDOR → regla con texto y fila', (await uno(`select count(*)::int n from flujo_reglas r join flujo_filas f on f.id = r.fila_id where r.si_texto = 'ASEGURADORA FICTICIA' and f.etiqueta = '53001007 SEGUROS'`)).n >= 1)
check('Mapa: "(banco)" queda cubierto por la regla general', control.tablas.flujo_reglas.motivosCubiertas['"(banco)": la regla general ya pone la cuenta en la fila de la unidad del banco'] === 1)
check('Llave: dos filas del mismo proveedor y cuenta → una regla', (await uno(`select count(*)::int n from flujo_reglas where si_texto = 'Proveedor Ficticio SRL' and not excluir`)).n === 1)
check('Llave: transferencia propia → regla que excluye pagos', (await uno(`select count(*)::int n from flujo_reglas where si_texto = 'INDIA ADV SA' and excluir and si_origen = 'PAGO'`)).n === 1)
check('Feriado del Mapa → feriados', !!(await uno(`select 1 from feriados where fecha = '2026-12-08'`)))

// Cheques y acreedores
const ch = await uno(`select c.importe::text, c.estado, c.tipo, a.nombre as acreedor from cheques c left join acreedores a on a.id = c.acreedor_id where numero = '777'`)
check('cheque pendiente: EMITIDO, con centavos reales (no los del formato) y su acreedor',
  ch?.importe === '1234567.89' && ch.estado === 'EMITIDO' && ch.tipo === 'ECHEQ' && ch.acreedor === 'PROVEEDOR FICTICIO SRL', JSON.stringify(ch))
check('cheque Pagado: fuera de alcance', !(await uno(`select 1 from cheques where numero = '700'`)))
check('cheque Vencido: no mapeado, [FALTA] confirmar', /Vencido/.test(nm('cheques')))
check('acreedor repetido con otra mayúscula: uno solo', (await uno(`select count(*)::int n from acreedores where texto_banco(nombre) = 'PROVEEDOR FICTICIO SRL'`)).n === 1)
check('el cheque pendiente aparece en el Flujo como proyectado', (await uno(`select count(*)::int n from flujo_lineas where origen_tipo = 'CHEQUE' and naturaleza = 'PROYECTADO'`)).n === 2)

// Lecturas, cobros, log
check('lectura TOTAL: fuera; cuenta de Xubio de una sola cuenta bancaria (FCI) → asociada',
  (await uno(`select count(*)::int n from lecturas_xubio`)).n === 2
  && (await uno(`select c.nombre from lecturas_xubio l join cuentas_origen c on c.id = l.cuenta_origen_id where l.cuenta_xubio like 'Fondos%'`))?.nombre === 'PRUEBA FCI')
check('lectura de un banco: asociada a su cuenta', (await uno(`select c.nombre from lecturas_xubio l join cuentas_origen c on c.id = l.cuenta_origen_id where l.cuenta_xubio = 'Banco Prueba CC 1111'`))?.nombre === 'PRUEBA CC 1111')
check('cobro con su cuenta', (await uno(`select c.nombre, b.importe::text from cobros b join cuentas_origen c on c.id = b.cuenta_origen_id`))?.importe === '1500.25')
check('log del robot: tres filas (dos del mismo minuto distintas)', (await uno(`select count(*)::int n from procesos_log`)).n === 3)

// Con más de una organización hay que decir en cuál se carga (T-208, revisión T-207 hallazgo 21)
const slug = (await uno(`select o.slug from organizaciones o join empresas e on e.organizacion_id = o.id limit 1`)).slug
const otraOrg = (await uno(`insert into organizaciones (slug, nombre) values ('otra-prueba', 'Otra Organización de Prueba') returning id`)).id
await db.query(`insert into empresas (id, nombre, nombre_corto, organizacion_id, cuit) values ('otra-prueba-sa', 'Otra Prueba SA', 'Otra', $1, '30000000007')`, [otraOrg])
const intento = async (o) => { try { await cargar(db, plan, o); return 'ok' } catch (e) { return e.message } }
check('dos organizaciones sin --organizacion: no carga y pide cuál', /indicá en cuál cargar con --organizacion/.test(await intento({})))
check('…con la organización correcta: carga (y sigue sin duplicar)', (await intento({ organizacion: slug })) === 'ok')
check('…con la organización equivocada: no carga empresas ajenas', /son de otra organización/.test(await intento({ organizacion: 'otra-prueba' })))
check('…organización inexistente: lo dice', /No existe la organización/.test(await intento({ organizacion: 'no-existe' })))
check('…nada quedó en la otra organización', (await uno(`select (select count(*) from flujo_reglas where organizacion_id = $1)::int + (select count(*) from acreedores where organizacion_id = $1)::int n`, [otraOrg])).n === 0)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
