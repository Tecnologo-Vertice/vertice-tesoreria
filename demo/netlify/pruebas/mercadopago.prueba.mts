// Mercado Pago por API y FCI diario (0040), contra el simulador: sin Mercado Pago ni Supabase reales.
// Cubre el CSV del informe, el armado del extracto, el token por variable de entorno, "sin token no hace nada y avisa",
// que solo se lee (GET) y que lo cargado va por importar_extracto. Datos ficticios.
// Uso: node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/mercadopago.prueba.mts
import { cerrar, check, json, simular, type Fila, type Mundo } from './simulador.mts'

for (const k of Object.keys(process.env)) if (k.startsWith('MERCADOPAGO_TOKEN')) delete process.env[k]

const mp = await import('../functions/lib/mercadopago.ts')
const fci = await import('../functions/lib/fci.ts')
const { supabaseAdmin } = await import('../functions/lib/comun.ts')
const db = supabaseAdmin()

// ---------------------------------------------------------------- Token
check('nombre de la variable por empresa', mp.nombreVariableToken('beratung') === 'MERCADOPAGO_TOKEN_BERATUNG' && mp.nombreVariableToken('india-adv') === 'MERCADOPAGO_TOKEN_INDIA_ADV')
check('token propio de la empresa', mp.tokenDeMercadoPago('beratung', 3, { MERCADOPAGO_TOKEN_BERATUNG: ' tk-propio ', MERCADOPAGO_TOKEN: 'tk-general' }) === 'tk-propio')
check(
  'el token general sirve solo con una única cuenta de Mercado Pago',
  mp.tokenDeMercadoPago('beratung', 1, { MERCADOPAGO_TOKEN: 'tk-general' }) === 'tk-general' && mp.tokenDeMercadoPago('beratung', 2, { MERCADOPAGO_TOKEN: 'tk-general' }) === null,
)
check('sin ninguna variable: no hay token', mp.tokenDeMercadoPago('beratung', 1, {}) === null)

// ---------------------------------------------------------------- CSV
check(
  'números: punto, coma y miles',
  mp.numeroMP('1234.56') === 1234.56 && mp.numeroMP('1.234,56') === 1234.56 && mp.numeroMP('1,234.56') === 1234.56 && mp.numeroMP('') === 0 && mp.numeroMP('-12.5') === -12.5 && Number.isNaN(mp.numeroMP('abc')) && mp.numeroMP('1,234') === 1234 && mp.numeroMP('1,5') === 1.5,
)
const CSV = [
  'DATE,SOURCE_ID,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT,GROSS_AMOUNT,MP_FEE_AMOUNT,TAXES_AMOUNT,PAYMENT_METHOD',
  '2026-11-20T00:00:00.000-03:00,,initial_available_balance,,1000.00,0.00,,,,',
  '2026-11-20T09:10:00.000-03:00,111,release,payment,500.00,0.00,520.00,15.00,5.00,master',
  '2026-11-20T10:00:00.000-03:00,222,release,reserve_for_payment,0.00,100.00,,,,',
  '2026-11-21T08:00:00.000-03:00,333,release,payout,0.00,"1,200.50",,,,',
  '2026-11-21T09:00:00.000-03:00,444,release,reserve_for_payment,100.00,0.00,,,,',
  '2026-11-21T09:30:00.000-03:00,555,release,refund,0.00,0.00,,,,',
  ',,total,,0,0,,,,',
].join('\n')
const filas = mp.leerInformeLiberaciones(CSV)
check('lee el informe sin la fila de totales', filas.length === 6 && filas[0].tipo === 'initial_available_balance' && filas[1].fecha === '2026-11-20' && filas[3].debito === 1200.5, JSON.stringify(filas[3]))
const CSV_PUNTO_Y_COMA = ['DATE;RECORD_TYPE;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT', '2026-11-20T00:00:00.000-03:00;initial_available_balance;;1000,50;0,00', '2026-11-20T09:10:00.000-03:00;release;payment;500,25;0,00'].join('\n')
const fpc = mp.leerInformeLiberaciones(CSV_PUNTO_Y_COMA)
check('el separador ";" con coma decimal también', fpc.length === 2 && fpc[0].credito === 1000.5 && fpc[1].credito === 500.25, JSON.stringify(fpc))
let falla = ''
try {
  mp.leerInformeLiberaciones('A,B\n1,2')
} catch (e) {
  falla = String(e)
}
check('si faltan columnas, falla con un mensaje claro', /no trae la columna/.test(falla), falla)
falla = ''
try {
  mp.leerInformeLiberaciones('DATE,RECORD_TYPE,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT\nayer,release,1,0')
} catch (e) {
  falla = String(e)
}
check('una fecha que no se entiende falla (no se importa a medias)', /fecha/.test(falla), falla)

// ---------------------------------------------------------------- Extracto
const e = mp.armarExtractoMP(filas)
check(
  'movimientos: neto con signo; las reservas no son movimiento; los de neto cero tampoco',
  e.movimientos.length === 2 &&
    e.movimientos[0].importe === 500 &&
    /^MP ingreso master 111$/.test(e.movimientos[0].descripcion) &&
    e.movimientos[1].importe === -1200.5 &&
    /^MP payout 333$/.test(e.movimientos[1].descripcion) &&
    !e.movimientos.some((m) => /reserva/i.test(m.descripcion)),
  JSON.stringify(e.movimientos),
)
check('saldo de cierre por día: corre desde el inicial y sin las reservas (así cierra con los movimientos)', JSON.stringify(e.saldos) === JSON.stringify([{ fecha: '2026-11-20', saldo: 1500 }, { fecha: '2026-11-21', saldo: 299.5 }]), JSON.stringify(e.saldos))
check('desde y hasta', e.desde === '2026-11-20' && e.hasta === '2026-11-21')
check('el saldo de cada movimiento es el corrido', e.movimientos.map((m) => m.saldo).join() === '1500,299.5', e.movimientos.map((m) => m.saldo).join())
check('un día solo con el saldo inicial queda con ese saldo', mp.armarExtractoMP(mp.leerInformeLiberaciones('DATE,RECORD_TYPE,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT\n2026-11-22,initial_available_balance,77,0')).saldos[0].saldo === 77)

// ---------------------------------------------------------------- Orquestación contra el simulador
const EMPRESAS = [
  { id: 'beratung', nombre: 'Beratung S.A.' },
  { id: 'india', nombre: 'India ADV S.A.' },
]
type Llamadas = Record<string, Record<string, unknown>[]>
const llamadas = (m: Mundo, fn: string) => ((m as Mundo & { llamadas: Llamadas }).llamadas[fn] ?? [])
function mundo(tablas: Record<string, Fila[]>, repetido = false): Mundo {
  const llam: Llamadas = {}
  const m = simular({
    tablas,
    rpc: {
      tomar_bloqueo: () => true,
      soltar_bloqueo: () => null,
      importar_extracto: (a) => {
        ;(llam.importar_extracto ??= []).push(a)
        return { repetido, nuevos: 4 }
      },
    },
  })
  ;(m as Mundo & { llamadas: Llamadas }).llamadas = llam
  return m
}
const pedidosMP: { metodo: string; url: string; auth: string }[] = []
const apiMP = async (url: string, init?: RequestInit) => {
  pedidosMP.push({ metodo: init?.method ?? 'GET', url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') })
  if (url.endsWith('/v1/account/release_report/list'))
    return json([{ file_name: 'release-report-1.csv', end_date: '2026-11-21', status: 'processed' }, { file_name: 'prueba.csv', is_test: true }, { id: 9 }])
  if (url.includes('/v1/account/release_report/release-report-1.csv')) return new Response(CSV, { status: 200 })
  if (url.endsWith('/users/me')) return json({ id: 42 })
  if (url.endsWith('/mercadopago_account/balance')) return json({ available_balance: 321.5 })
  return json({ error: 'no esperado' }, 500)
}
const cuentaMP = { id: 'c-mp', empresa_id: 'beratung', nombre: 'MERCADO PAGO BERATUNG', banco: 'MP', activa: true }

// Sin token: no hace nada y avisa.
pedidosMP.length = 0
let m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] })
let r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: {}, fetch: apiMP })
check(
  'sin token: no llama a Mercado Pago, no importa nada y lo avisa',
  pedidosMP.length === 0 && llamadas(m, 'importar_extracto').length === 0 && r.importados === 0 && /falta MERCADOPAGO_TOKEN_BERATUNG/.test(r.lineas.join('|')),
  JSON.stringify(r),
)
check('… y queda en procesos_log como OMITIDO', (m.tablas.procesos_log ?? []).some((p) => p.estado === 'OMITIDO' && p.proceso === 'IMPORTAR_EXTRACTO' && /falta/.test(String(p.detalle))))

// Sin cuentas de Mercado Pago: nada.
m = mundo({ empresas: EMPRESAS, cuentas_origen: [] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk-secreto' }, fetch: apiMP })
check('sin cuentas de Mercado Pago: no hace nada', r.lineas.length === 0 && pedidosMP.length === 0)

// Con token.
pedidosMP.length = 0
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk-secreto' }, fetch: apiMP })
const imp = llamadas(m, 'importar_extracto')
const p0 = (imp[0]?.p ?? {}) as { cuenta_origen_id?: string; movimientos?: unknown[]; saldos?: unknown[]; archivo?: { formato?: string; hash?: string }; origen_saldos?: string }
check(
  'con token: importa el informe por importar_extracto en la cuenta de Mercado Pago',
  imp.length === 1 && p0.cuenta_origen_id === 'c-mp' && p0.movimientos?.length === 2 && p0.saldos?.length === 2 && p0.archivo?.formato === 'MERCADOPAGO_API' && p0.origen_saldos === 'EXTRACTO',
  JSON.stringify(imp),
)
check('… ignora los informes de prueba y los que no tienen archivo (uno solo)', imp.length === 1)
check('… con una huella del archivo (para no duplicar)', /^[0-9a-f]{64}$/.test(String(p0.archivo?.hash)))
check('SOLO LECTURA: todos los pedidos a Mercado Pago son GET con el token', pedidosMP.length > 0 && pedidosMP.every((p) => p.metodo === 'GET' && p.auth === 'Bearer tk-secreto'), JSON.stringify(pedidosMP.map((p) => p.metodo)))
check('informa el saldo disponible (solo informativo)', r.lineas.some((l) => /saldo disponible hoy en Mercado Pago \$ 321\.50/.test(l)))
check('el token no aparece en ningún mensaje ni registro', !JSON.stringify([r, m.tablas.procesos_log]).includes('tk-secreto'))
check('queda en procesos_log como OK', (m.tablas.procesos_log ?? []).some((p) => p.estado === 'OK' && p.proceso === 'IMPORTAR_EXTRACTO'))

// Informe ya importado: no cuenta de nuevo.
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] }, true)
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk-secreto' }, fetch: apiMP })
check('un informe que ya estaba importado no se vuelve a contar', r.importados === 0)

// Token general con dos cuentas de empresas distintas: no se usa; con su token propio, sí.
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP, { ...cuentaMP, id: 'c-mp2', empresa_id: 'india' }] })
pedidosMP.length = 0
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN: 'tk-general', MERCADOPAGO_TOKEN_INDIA: 'tk-india' }, fetch: apiMP })
check(
  'con dos cuentas el token general no se usa (Beratung sin token propio no lee); India con el suyo sí',
  llamadas(m, 'importar_extracto').length === 1 &&
    (llamadas(m, 'importar_extracto')[0].p as { cuenta_origen_id: string }).cuenta_origen_id === 'c-mp2' &&
    pedidosMP.every((p) => p.auth === 'Bearer tk-india') &&
    /Beratung S.A.: falta/.test(r.lineas.join('|')),
)

// Dos cuentas de MP en la misma empresa: no adivina.
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP, { ...cuentaMP, id: 'c-mp3' }] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk' }, fetch: apiMP })
check('dos cuentas de Mercado Pago en una empresa: avisa y no carga nada', llamadas(m, 'importar_extracto').length === 0 && /2 cuentas de Mercado Pago/.test(r.lineas.join('|')))

// Mercado Pago responde mal: error claro, sin romper.
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk' }, fetch: async () => json({ message: 'unauthorized' }, 401) })
check('si Mercado Pago rechaza el token: avisa con el código y no carga nada', llamadas(m, 'importar_extracto').length === 0 && /respondió 401/.test(r.lineas.join('|')) && (m.tablas.procesos_log ?? []).some((p) => p.estado === 'ERROR'))
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk' }, fetch: async () => json({ no: 'es una lista' }) })
check('si la lista de informes tiene otra forma: avisa y no carga nada', llamadas(m, 'importar_extracto').length === 0 && /forma que no se esperaba/.test(r.lineas.join('|')))
let nombreRaro = ''
try {
  await mp.bajarInforme(apiMP, 'tk', '../../etc/passwd')
} catch (x) {
  nombreRaro = String(x)
}
check('un nombre de informe raro no se baja', /raro/.test(nombreRaro))

// Un informe roto se registra y se sigue con los demás; con más de 5 sin importar se bajan todos.
const listaMuchos = Array.from({ length: 8 }, (_, i) => ({ file_name: `rep-${i + 1}.csv`, end_date: `2026-11-1${i}`, status: 'processed' }))
const apiMuchos = (rotos: string[]) => async (url: string, init?: RequestInit) => {
  pedidosMP.push({ metodo: init?.method ?? 'GET', url, auth: '' })
  if (url.endsWith('/v1/account/release_report/list')) return json(listaMuchos)
  const nombre = url.split('/release_report/')[1]
  if (nombre?.startsWith('rep-')) return new Response(rotos.includes(nombre) ? 'DATE,RECORD_TYPE,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT\nayer,release,1,0' : CSV, { status: 200 })
  return json({ error: 'no esperado' }, 404)
}
pedidosMP.length = 0
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk' }, fetch: apiMuchos(['rep-1.csv']) })
check('8 informes sin importar con el más viejo roto: se cargan los otros 7 y el roto queda registrado', llamadas(m, 'importar_extracto').length === 7 && r.importados === 7
  && (m.tablas.procesos_log ?? []).some((p) => p.estado === 'ERROR' && /rep-1\.csv/.test(String(p.detalle))), JSON.stringify(r.lineas))
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP], extractos: [{ cuenta_origen_id: 'c-mp', archivo_nombre: 'Mercado Pago API · rep-2.csv' }] })
pedidosMP.length = 0
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk' }, fetch: apiMuchos([]) })
check('los que ya están importados (por nombre) no se bajan de nuevo', !pedidosMP.some((p) => p.url.endsWith('/rep-2.csv')) && llamadas(m, 'importar_extracto').length === 7)
m = mundo({ empresas: EMPRESAS, cuentas_origen: [cuentaMP] })
r = await mp.leerMercadoPago(db, { organizacionId: 'org-prueba', entorno: { MERCADOPAGO_TOKEN_BERATUNG: 'tk' }, fetch: apiMuchos([]), presupuestoMs: -1 })
check('sin tiempo en la corrida: avisa cuántos faltan y sigue en la próxima', llamadas(m, 'importar_extracto').length === 0 && /sin tiempo: faltan 8/.test(r.lineas.join('|')), JSON.stringify(r.lineas))
// Paginación: una primera página llena pide la siguiente; una API que repite la misma página no hace un bucle.
let pagsPedidas = 0
const apiPaginada = async (url: string) => {
  if (url.includes('/release_report/list')) {
    pagsPedidas++
    const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0)
    return json(Array.from({ length: off === 0 ? 100 : off === 100 ? 5 : 0 }, (_, i) => ({ file_name: `p-${off + i}.csv`, end_date: '2026-11-01', status: 'processed' })))
  }
  return json({}, 404)
}
check('la lista se pide por páginas hasta que no hay más (105 informes)', (await mp.listarInformes(apiPaginada, 'tk')).length === 105 && pagsPedidas === 2, String(pagsPedidas))
let repetida = 0
const apiRepite = async () => { repetida++; return json(Array.from({ length: 100 }, (_, i) => ({ file_name: `r-${i}.csv`, status: 'processed' }))) }
check('si la API ignora la paginación, corta (no queda en bucle)', (await mp.listarInformes(apiRepite, 'tk')).length === 100 && repetida === 2, String(repetida))

// ---------------------------------------------------------------- FCI diario
m = mundo({ empresas: EMPRESAS })
const sincro: Record<string, unknown>[] = []
m.rpc.sincronizar_capital_fci = (a) => {
  sincro.push(a)
  return a.p_empresa === 'beratung' ? { asignados: 2, dudosos: 1 } : { asignados: 0, dudosos: 0 }
}
m.rpc.clasificar_intereses_remunerada = (a) => (a.p_empresa === 'beratung' ? 3 : 0)
const f = await fci.sincronizarCapitalFci(db, 'org-prueba')
check('FCI diario: llama a la base por cada empresa y suma lo asignado', sincro.length === 2 && f.asignados === 2 && f.dudosos === 1 && /Beratung S.A.: 2 suscripciones/.test(f.lineas.join('|')) && f.intereses === 3, JSON.stringify(f))
check('… deja constancia en procesos_log solo de lo que hizo algo', (m.tablas.procesos_log ?? []).length === 1)
sincro.length = 0
m.rpc.sincronizar_capital_fci = () => ({ asignados: 0, dudosos: 2 })
m.rpc.clasificar_intereses_remunerada = () => 0
m.tablas.procesos_log = []
const fd = await fci.sincronizarCapitalFci(db, 'org-prueba')
check('FCI diario: los dudosos de siempre se muestran pero no se vuelven a registrar', fd.dudosos === 4 && (m.tablas.procesos_log ?? []).length === 0 && /con más de un fondo/.test(fd.lineas.join('|')), JSON.stringify(fd))
m = mundo({ empresas: EMPRESAS })
m.rpc.clasificar_intereses_remunerada = () => 0
m.rpc.sincronizar_capital_fci = () => {
  throw new Error('boom')
}
const f2 = await fci.sincronizarCapitalFci(db, 'org-prueba')
check('FCI diario: si la base falla, avisa y sigue con la otra empresa', f2.lineas.length === 2 && /no se pudo sincronizar/.test(f2.lineas[0]))

check('ningún pedido salió del simulador (a Mercado Pago solo por la función inyectada)', m.pedidos.every((p) => p.url.startsWith('http://supabase.prueba')))
cerrar()
