// Xubio de ida y vuelta, contra el simulador (sin Supabase ni Xubio reales): N° de OP, saldo de Xubio, cobranzas,
// facturas pagadas y anulación de la orden de pago por API (detrás de XUBIO_ANULAR_ENVIO_REAL).
// Uso: node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/ida-vuelta.prueba.mts
import { cerrar, check, json, noResponde, simular, ORG_PRUEBA, type Externo, type Fila, type Mundo } from './simulador.mts'

delete process.env.XUBIO_ANULAR_ENVIO_REAL
delete process.env.XUBIO_BANCOS_ENVIO_REAL
delete process.env.XUBIO_CREDS_JSON
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: 'id-prueba', secret: 'secreto-prueba' } })

const lib = await import('../functions/lib/xubio-ida-vuelta.ts')
const anular = await import('../functions/lib/xubio-anular.ts')
const bancos = await import('../functions/lib/xubio-bancos.ts')
const { supabaseAdmin } = await import('../functions/lib/comun.ts')
const db = supabaseAdmin()

const EMPRESAS = [
  { id: 'beratung', nombre: 'Beratung S.A.', erp: 'XUBIO' },
  { id: 'india', nombre: 'India ADV S.A.', erp: 'XUBIO' }, // sin credenciales
  { id: 'robles', nombre: 'Droguería Robles', erp: 'RALPHARMA' },
]

const aXubio = (m: Mundo, metodo: string, ruta: string) => m.pedidos.filter((p) => p.metodo === metodo && p.ruta === `/API/1.1/${ruta}`)
const escrituras = (m: Mundo) => m.pedidos.filter((p) => p.url.startsWith('https://xubio.com/') && p.metodo !== 'GET' && !p.ruta.endsWith('TokenEndpoint'))
const llamadas = (m: Mundo, fn: string) => (m as Mundo & { llamadas: Record<string, Record<string, unknown>[]> }).llamadas[fn] ?? []

/** Un mundo con las funciones de la base que usan los procesos; cada llamada queda anotada. */
function mundo(tablas: Record<string, Fila[]> = {}, xubio: Externo = () => json({ error: 'sin Xubio' }, 500), rpc: Mundo['rpc'] = {}): Mundo {
  const llamadas: Record<string, Record<string, unknown>[]> = {}
  const anotar = (nombre: string, f?: Mundo['rpc'][string]): Mundo['rpc'][string] => (a, m) => {
    ;(llamadas[nombre] ??= []).push(a)
    return f ? f(a, m) : null
  }
  const base: Mundo['rpc'] = {
    tomar_bloqueo: () => true,
    soltar_bloqueo: () => null,
    dia_habil_anterior: () => '2026-11-26',
    aplicar_numero_op_xubio: anotar('aplicar_numero_op_xubio', () => true),
    registrar_lecturas_xubio: anotar('registrar_lecturas_xubio', (a) => ({ guardadas: (a.p_lecturas as unknown[]).length, repetidas: 0, invalidas: 0, sin_cuenta: [] })),
    importar_cobros_xubio: anotar('importar_cobros_xubio', (a) => ({ nuevas: (a.p_cobros as unknown[]).length, ya_estaban: 0, omitidas: 0 })),
    sincronizar_facturas_pagadas: anotar('sincronizar_facturas_pagadas', () => ({ aplicado: true, cambios: [], manual: [] })),
    resultado_anulacion_xubio: anotar('resultado_anulacion_xubio', (a, m) => {
      const x = m.tablas.pagos.find((y) => y.id === a.p_id)
      if (x) x.anulacion_xubio = a.p_estado
      return true
    }),
  }
  const m = simular({
    tablas: { empresas: EMPRESAS, usuarios: [], pagos: [], asientos: [], cheques: [], xubio_log: [], procesos_log: [], conexiones_erp: [], ...tablas },
    rpc: { ...base, ...Object.fromEntries(Object.entries(rpc).map(([k, f]) => [k, anotar(k, f)])) },
    xubio,
  })
  Object.assign(m, { llamadas })
  return m
}
const procesos = (m: Mundo, entidad?: string) => m.tablas.procesos_log.filter((l) => !entidad || l.entidad === entidad)

// ================================================================ Piezas sin red
check('N° de OP: se reconoce por la forma, en el campo que sea', lib.numeroOPDeObjetoXubio({ numeroDocumento: 'X-0001-00002312' }) === 'X-0001-00002312'
  && lib.numeroOPDeObjetoXubio({ otro: ' X-0001-00000042 ' }) === 'X-0001-00000042' && lib.numeroOPDeObjetoXubio({ numero: '12' }) === '' && lib.numeroOPDeObjetoXubio(null) === '')
check('proveedor: sin SA ni laboratorio, y el nombre corto dentro del largo (5 letras o más)', lib.mismoProveedor('Laboratorios Gamma SA', 'GAMMA S.A.') && lib.mismoProveedor('Delta Servicios SRL', 'Servicios Delta Argentina')
  && !lib.mismoProveedor('Gamma SA', 'Delta SA') && !lib.mismoProveedor('', 'Gamma') && !lib.mismoProveedor('Ab SA', 'Ab Cd Ef'))
check('anulación: el importe de la OP es la suma de sus instrumentos; el del asiento, su debe', anular.importeDeOP({ transaccionInstrumentoDePago: [{ importe: 1000 }, { importe: 500 }] }) === 1500 && anular.importeDeOP({ cuotas: 12 }) === 0
  && anular.importeDeAsiento({ asientoContableManualItem: [{ importe: 70, debeHaber: 1 }, { importe: 70, debeHaber: -1 }] }) === 70)
check('saldo de la cuenta: número o texto numérico; sin campo, null', lib.saldoDeCuentaXubio({ saldo: 12.5 }) === 12.5 && lib.saldoDeCuentaXubio({ saldoActual: '-300.20' }) === -300.2 && lib.saldoDeCuentaXubio({ nombre: 'x' }) === null)

// ================================================================ 1. N° de orden de pago
const pagoSin = (id: string, extra: Fila = {}): Fila => ({ id, empresa_id: 'beratung', fecha: '2026-11-24', importe: 1000, proveedor: 'Laboratorios Gamma SA', xubio_id: null, ...extra })
const op = (transaccionid: number, numero: string, importe: number, proveedor: string, fecha = '2026-11-24'): Fila => ({ transaccionid, numeroDocumento: numero, fecha, proveedor: { nombre: proveedor }, transaccionInstrumentoDePago: [{ importe }] })
function xubioOps(ops: Fila[], extra: Externo = () => json({ error: 'no esperado' }, 500)): Externo {
  return (p, corte) => {
    const r = p.ruta.replace('/API/1.1/', '')
    if (r === 'TokenEndpoint') return json({ access_token: 't', token_type: 'Bearer' })
    if (r === 'pagoBean' && p.metodo === 'GET') return json(ops)
    return extra(p, corte)
  }
}
const pend = (pendientes: Fila[], usados: { empresa_id: string; numero: string }[] = []) => ({ numero_op_pendientes: () => ({ pendientes, usados }) })

let m = mundo({}, xubioOps([op(7001, 'X-0001-00002312', 1000, 'GAMMA'), op(7002, 'X-0001-00002313', 2000, 'Delta Servicios SRL'), op(7003, 'X-0001-00002314', 2000, 'Delta Servicios SRL'), op(7004, 'X-0001-00002315', 500, 'Otro SA'), op(7005, 'X-0001-00002316', 700, 'Epsilon SA')]),
  pend([
    pagoSin('p1', { xubio_id: 'OP-7001' }),                                         // por el id de Xubio
    pagoSin('p2', { importe: 700, proveedor: 'Epsilon SA' }),                       // sin id: proveedor + importe + fecha
    pagoSin('p3', { importe: 2000, proveedor: 'Delta Servicios SRL' }),             // dos OP posibles: no elige
    pagoSin('p4', { xubio_id: 'OP-7004' }),                                         // esa OP ya la usó otro pago
    pagoSin('p5', { empresa_id: 'india' }),                                         // India no tiene credenciales
  ], [{ empresa_id: 'beratung', numero: 'X-0001-00002315' }, { empresa_id: 'india', numero: 'X-0001-00002312' }]))
let r = await lib.completarNumerosOP(db, { organizacionId: ORG_PRUEBA })
const puestos = llamadas(m, 'aplicar_numero_op_xubio').map((a) => `${a.p_pago}=${a.p_numero}`)
check('N° de OP: por el id de Xubio del pago encuentra su número', puestos.includes('p1=X-0001-00002312'), puestos.join(' '))
check('N° de OP: sin id empareja por proveedor, importe y fecha', puestos.includes('p2=X-0001-00002316'), puestos.join(' '))
check('N° de OP: con varias OP posibles no elige y avisa', !puestos.some((x) => x.startsWith('p3=')) && r.lineas.some((l) => /2 OP posibles/.test(l)), r.lineas.join(' | '))
check('N° de OP: no repite un número que ya usa otro pago', !puestos.some((x) => x.startsWith('p4=')) && puestos.length === 2)
check('N° de OP: una empresa sin credenciales se salta con aviso', r.lineas.some((l) => /India ADV S\.A\.: sin credenciales/.test(l)) && r.guardados === 2)
check('N° de OP: solo LEE de Xubio (ningún POST, PUT ni DELETE además del token)', escrituras(m).length === 0 && aXubio(m, 'GET', 'pagoBean').length === 1)
check('N° de OP: pide las OP con ±10 días alrededor de los pagos', /fechaDesde=2026-11-14&fechaHasta=2026-12-04/.test(m.pedidos.find((p) => p.ruta.endsWith('/pagoBean'))?.url ?? ''))
check('N° de OP: queda en procesos_log (XUBIO_PAGOS) lo hecho y lo que no se pudo', procesos(m, 'NUMERO_OP').some((l) => l.estado === 'OK' && l.proceso === 'XUBIO_PAGOS' && /2 completados/.test(String(l.detalle))) && procesos(m, 'NUMERO_OP').some((l) => l.estado === 'ERROR' && l.empresa_id === 'india'))

m = mundo({}, (p) => (p.ruta.endsWith('TokenEndpoint') ? json({ access_token: 't', token_type: 'Bearer' }) : json({ error: 'caído' }, 500)), pend([pagoSin('p6', { fecha: '2026-11-20' })]))
r = await lib.completarNumerosOP(db, { organizacionId: ORG_PRUEBA })
check('N° de OP: si Xubio falla, avisa y no guarda nada', r.guardados === 0 && r.lineas.some((l) => /no se pudo leer Xubio/.test(l)) && llamadas(m, 'aplicar_numero_op_xubio').length === 0 && procesos(m, 'NUMERO_OP').some((l) => l.estado === 'ERROR'))

m = mundo({}, xubioOps([]), pend([]))
r = await lib.completarNumerosOP(db, { organizacionId: ORG_PRUEBA })
check('N° de OP: sin pagos esperando su número no llama a Xubio', m.pedidos.every((p) => !p.url.startsWith('https://xubio.com/')) && /no hay pagos/.test(r.lineas[0]))

m = mundo({}, xubioOps([{ transaccionid: 7001, fecha: '2026-11-24', proveedor: { nombre: 'X' }, campoRaro: 1 }]), pend([pagoSin('p7', { xubio_id: 'OP-7001' })]))
r = await lib.completarNumerosOP(db, { organizacionId: ORG_PRUEBA })
check('N° de OP: si las OP de Xubio no traen un número reconocible, avisa qué campos trae', r.guardados === 0 && r.lineas.some((l) => /no traen un número reconocible.*campoRaro/.test(l)))

// ================================================================ 2. Saldo de Xubio
const xubioCuentas = (cuentas: Fila[]): Externo => (p) => {
  const r = p.ruta.replace('/API/1.1/', '')
  if (r === 'TokenEndpoint') return json({ access_token: 't', token_type: 'Bearer' })
  if (r === 'cuenta') return json(cuentas)
  return json({ error: 'no esperado' }, 500)
}
m = mundo({}, xubioCuentas([{ ID: 1, nombre: 'Banco Hipotecario CC 0319', saldo: 845 }, { ID: 2, nombre: 'Caja', saldo: '10.50' }, { ID: 3, nombre: 'Sin saldo' }]))
let s = await lib.leerSaldosXubio(db, { organizacionId: ORG_PRUEBA })
let ll = llamadas(m, 'registrar_lecturas_xubio')
check('saldo de Xubio: lee las cuentas y manda las que traen saldo, con el día hábil anterior', ll.length === 1 && s.fecha === '2026-11-26' && ll[0].p_fecha === '2026-11-26'
  && JSON.stringify(ll[0].p_lecturas) === JSON.stringify([{ cuenta: 'Banco Hipotecario CC 0319', saldo: 845 }, { cuenta: 'Caja', saldo: 10.5 }]), JSON.stringify(ll))
check('saldo de Xubio: guarda solo las que se emparejan con una cuenta bancaria', ll[0].p_solo_emparejadas === true && ll[0].p_empresa === 'beratung')
check('saldo de Xubio: solo lee (GET cuenta) y lo deja en procesos_log', escrituras(m).length === 0 && aXubio(m, 'GET', 'cuenta').length === 1 && procesos(m, 'SALDO').some((l) => l.estado === 'OK' && l.proceso === 'LECTURA_XUBIO'))
check('saldo de Xubio: la empresa sin credenciales se salta con aviso', s.lineas.some((l) => /India ADV S\.A\.: sin credenciales/.test(l)))
m = mundo({}, xubioCuentas([{ ID: 1, nombre: 'Banco Hipotecario CC 0319' }]))
s = await lib.leerSaldosXubio(db, { organizacionId: ORG_PRUEBA, fecha: '2026-11-20' })
check('saldo de Xubio: si la API no trae saldos, avisa (a confirmar) y no guarda nada', llamadas(m, 'registrar_lecturas_xubio').length === 0 && s.guardados === 0 && procesos(m, 'SALDO').some((l) => l.estado === 'OMITIDO' && /no informa el saldo/.test(String(l.detalle))))
check('saldo de Xubio: con fecha pedida no calcula el día hábil', llamadas(m, 'dia_habil_anterior').length === 0 && s.fecha === '2026-11-20')

// ================================================================ 3. Cobranzas
const cobranza = (id: number, fecha: string, cliente: number | null, instrumentos: Fila[]): Fila => ({ transaccionid: id, fecha, numeroRecibo: `R-0001-0000000${id % 10}`, observacion: 'obs', cliente: cliente ? { ID: cliente } : undefined, transaccionInstrumentoDeCobro: instrumentos })
const ins = (id: number, cuenta: string, importe: number, descripcion = ''): Fila => ({ transaccionICId: id, cuenta: { nombre: cuenta, codigo: 'C' }, importe, descripcion })
m = mundo({}, (p) => {
  const r = p.ruta.replace('/API/1.1/', '')
  if (r === 'TokenEndpoint') return json({ access_token: 't', token_type: 'Bearer' })
  if (r === 'cobranzaBean') return json([cobranza(880, '2026-11-24T00:00:00', 55, [ins(1, 'Banco Hipotecario CC 0319', 1500.5, 'Transferencia'), ins(2, 'Caja', 200)]), cobranza(881, '2026-11-25', 56, [ins(3, 'Mercado Pago', 300)])])
  if (r === 'clienteBean/55') return json({ nombre: 'Cliente Uno SA' })
  if (r === 'clienteBean/56') return json({ error: 'no' }, 404)
  return json({ error: 'no esperado' }, 500)
})
let c = await lib.traerCobranzasXubio(db, { organizacionId: ORG_PRUEBA, ahora: new Date('2026-11-27T11:30:00Z') })
let imp = llamadas(m, 'importar_cobros_xubio')
check('cobranzas: pide los últimos 5 días hasta ayer, con la fecha de Argentina', /fechaDesde=2026-11-22&fechaHasta=2026-11-26/.test(m.pedidos.find((p) => p.ruta.endsWith('/cobranzaBean'))?.url ?? ''))
check('cobranzas: una fila por instrumento, con recibo, cuenta, importe y el nombre del cliente', imp.length === 1 && (imp[0].p_cobros as Fila[]).length === 3 && (imp[0].p_cobros as Fila[])[0].cliente === 'Cliente Uno SA'
  && (imp[0].p_cobros as Fila[])[0].transaccion_id === '880' && (imp[0].p_cobros as Fila[])[1].instrumento_id === '2' && (imp[0].p_cobros as Fila[])[0].fecha === '2026-11-24', JSON.stringify(imp))
check('cobranzas: si no se lee el nombre del cliente queda su número', (imp[0].p_cobros as Fila[])[2].cliente === '56')
check('cobranzas: solo lee de Xubio y queda en procesos_log', escrituras(m).length === 0 && c.guardados === 3 && procesos(m, 'COBRANZA').some((l) => l.estado === 'OK' && /3 nuevas/.test(String(l.detalle))))
m = mundo({}, (p) => (p.ruta.endsWith('TokenEndpoint') ? json({ access_token: 't', token_type: 'Bearer' }) : json([])))
c = await lib.traerCobranzasXubio(db, { organizacionId: ORG_PRUEBA, ahora: new Date('2026-11-27T11:30:00Z') })
check('cobranzas: sin cobranzas no llama a la base', llamadas(m, 'importar_cobros_xubio').length === 0 && c.lineas.some((l) => /0 cobranzas, 0 nuevas/.test(l)))
m = mundo({}, (p) => (p.ruta.endsWith('TokenEndpoint') ? json({ access_token: 't', token_type: 'Bearer' }) : json({ error: 'caído' }, 500)))
c = await lib.traerCobranzasXubio(db, { organizacionId: ORG_PRUEBA, ahora: new Date('2026-11-27T11:30:00Z') })
check('cobranzas: si Xubio falla, avisa y no guarda', c.guardados === 0 && c.lineas.some((l) => /error/.test(l)) && llamadas(m, 'importar_cobros_xubio').length === 0)

// ================================================================ 4. Facturas pagadas
m = mundo({}, undefined, { sincronizar_facturas_pagadas: () => ({ aplicado: true, cambios: [{ factura: 'f1', numero: '1-701', proveedor: 'Gamma', total: 1000, pagado: 1000, tipo: 'PAGADA' }], manual: [] }) })
let sf = await lib.sincronizarFacturasPagadas(db, { organizacionId: ORG_PRUEBA })
check('facturas pagadas: llama a la base por la organización, aplicando, y deja el registro', sf.cambios.length === 1 && llamadas(m, 'sincronizar_facturas_pagadas')[0].p_organizacion === ORG_PRUEBA && llamadas(m, 'sincronizar_facturas_pagadas')[0].p_aplicar === true
  && procesos(m, 'FACTURAS_PAGADAS').length === 1 && m.pedidos.every((p) => !p.url.startsWith('https://xubio.com/')))
m = mundo()
sf = await lib.sincronizarFacturasPagadas(db, { organizacionId: ORG_PRUEBA })
check('facturas pagadas: si no hubo nada, no llena el registro cada hora', sf.cambios.length === 0 && procesos(m).length === 0)

// ================================================================ Horarios (UTC → Buenos Aires, UTC−3)
const cron = async (archivo: string) => ((await import(`../functions/${archivo}.mts`)) as { config: { schedule: string } }).config.schedule
check('N° de OP: 9 y 14 h de Argentina = 12:00 y 17:00 UTC, todos los días', (await cron('xubio-numeros-op')) === '0 12,17 * * *')
check('cobranzas: 8:30 de Argentina = 11:30 UTC, de lunes a viernes', (await cron('xubio-cobranzas')) === '30 11 * * 1-5')
check('saldo de Xubio: 8:20 de Argentina = 11:20 UTC, de lunes a viernes', (await cron('xubio-saldos')) === '20 11 * * 1-5')
check('facturas pagadas: cada hora', (await cron('sincronizar-facturas-pagadas')) === '0 * * * *')

// ================================================================ 5. Anulación de la orden de pago por API
process.env.XUBIO_TIMEOUT_MS = '200'
const pagoAnular = (extra: Fila = {}): Fila => ({ id: 'pa1', empresa_id: 'beratung', xubio_id: 'OP-555', forma_carga_xubio: 'ORDEN_PAGO', importe: 1000, anulacion_xubio: 'PENDIENTE', gestion: 'SISTEMA', anulado_en: '2026-11-27T10:00:00Z', fecha: '2026-11-24', proveedor_destino: 'Laboratorios Gamma SA', ...extra })
interface OpcA {
  pagoBean?: Externo
  asiento?: Externo
  borrarPago?: Externo
  borrarAsiento?: Externo
}
function xubioAnular(o: OpcA = {}): Externo {
  return (p, corte) => {
    const r = p.ruta.replace('/API/1.1/', '')
    if (r === 'TokenEndpoint') return json({ access_token: 't', token_type: 'Bearer' })
    if (r === 'pagoBean/555' && p.metodo === 'GET') return o.pagoBean ? o.pagoBean(p, corte) : json({ transaccionid: 555, fecha: '2026-11-24', proveedor: { nombre: 'GAMMA S.A.' }, transaccionInstrumentoDePago: [{ importe: 1000 }] })
    if (r === 'pagoBean/555' && p.metodo === 'DELETE') return o.borrarPago ? o.borrarPago(p, corte) : json(null, 204)
    if (r === 'asientoContableManualBean/555' && p.metodo === 'GET') return o.asiento ? o.asiento(p, corte) : json({ error: 'no existe' }, 404)
    if (r === 'asientoContableManualBean/555' && p.metodo === 'DELETE') return o.borrarAsiento ? o.borrarAsiento(p, corte) : json(null, 204)
    return json({ error: `no esperado ${p.metodo} ${r}` }, 500)
  }
}
const correr = (real: boolean) => bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real })
const borrados = (mm: Mundo) => mm.pedidos.filter((p) => p.metodo === 'DELETE')
const ultimaAnulacion = (mm: Mundo) => llamadas(mm, 'resultado_anulacion_xubio').at(-1)

// Variable apagada (por defecto): sigue como siempre, la orden de pago queda para anular a mano y no se llama a Xubio.
m = mundo({ pagos: [pagoAnular()] }, xubioAnular())
await correr(true)
check('apagada: la orden de pago sigue "anular a mano" y no se toca Xubio', borrados(m).length === 0 && m.pedidos.every((p) => !p.url.startsWith('https://xubio.com/')) && m.tablas.pagos[0].anulacion_xubio === 'ERROR'
  && procesos(m, 'ANULAR_PAGO').some((l) => /Anularlo a mano/.test(String(l.detalle))) && llamadas(m, 'resultado_anulacion_xubio').length === 0)

process.env.XUBIO_ANULAR_ENVIO_REAL = 'true'
process.env.XUBIO_ANULAR_DESDE = '2026-11-27'
// Prendida pero la corrida es en seco: no se borra nada ni cambia el estado.
m = mundo({ pagos: [pagoAnular()] }, xubioAnular())
await correr(false)
check('prendida, en seco: no borra ni cambia el estado, deja el aviso y lo que haría', borrados(m).length === 0 && m.tablas.pagos[0].anulacion_xubio === 'PENDIENTE' && procesos(m, 'ANULAR_PAGO').some((l) => l.estado === 'PRUEBA_OK' && /verificando antes importe 1000, proveedor y fecha/.test(String(l.detalle)))
  && m.tablas.xubio_log.some((l) => l.en_seco === true))

// Prendida y real: lee la OP, verifica el importe, la borra y marca HECHA (con auditoría por la base).
m = mundo({ pagos: [pagoAnular()] }, xubioAnular())
await correr(true)
check('prendida y real: GET de la OP, verifica el importe y la borra (DELETE pagoBean/555)', aXubio(m, 'GET', 'pagoBean/555').length === 1 && aXubio(m, 'DELETE', 'pagoBean/555').length === 1 && borrados(m).length === 1)
check('…queda HECHA por resultado_anulacion_xubio y en procesos_log como OK', ultimaAnulacion(m)?.p_estado === 'HECHA' && m.tablas.pagos[0].anulacion_xubio === 'HECHA' && procesos(m, 'ANULAR_PAGO').some((l) => l.estado === 'OK'))
check('…y deja el DELETE real en xubio_log', m.tablas.xubio_log.some((l) => l.en_seco === false && (l.request as { metodo?: string }).metodo === 'DELETE' && l.http_status === 204))
await correr(true)
check('…una segunda corrida no vuelve a borrar', borrados(m).length === 1)

m = mundo({ pagos: [pagoAnular()] }, xubioAnular({ pagoBean: () => json({ transaccionid: 555, fecha: '2026-11-24', proveedor: { nombre: 'GAMMA' }, transaccionInstrumentoDePago: [{ importe: 999 }] }) }))
await correr(true)
check('el importe de Xubio no coincide: no se borra por seguridad y queda ERROR', borrados(m).length === 0 && ultimaAnulacion(m)?.p_estado === 'ERROR' && /suma 999 y el pago es de 1000/.test(String(ultimaAnulacion(m)?.p_detalle)) && m.tablas.pagos[0].anulacion_xubio === 'ERROR')

m = mundo({ pagos: [pagoAnular({ forma_carga_xubio: 'ASIENTO_MANUAL' })] }, xubioAnular({ pagoBean: () => json({ error: 'no' }, 404), asiento: () => json({ transaccionid: 555, fecha: '2026-11-25', asientoContableManualItem: [{ importe: 1000, debeHaber: 1 }, { importe: 1000, debeHaber: -1 }] }) }))
await correr(true)
check('si no es una OP, prueba como asiento manual (transferencias entre cuentas propias) y lo borra', aXubio(m, 'DELETE', 'asientoContableManualBean/555').length === 1 && aXubio(m, 'DELETE', 'pagoBean/555').length === 0 && ultimaAnulacion(m)?.p_estado === 'HECHA')
check('…la OP no encontrada (404) no es un error: sigue con el asiento', aXubio(m, 'GET', 'pagoBean/555').length === 1)

m = mundo({ pagos: [pagoAnular()] }, xubioAnular({ pagoBean: () => json({ error: 'no' }, 404) }))
await correr(true)
check('no está ni como OP ni como asiento: ERROR "no encontrado" y no se borra nada', borrados(m).length === 0 && ultimaAnulacion(m)?.p_estado === 'ERROR' && /no encontrado/.test(String(ultimaAnulacion(m)?.p_detalle)))

m = mundo({ pagos: [pagoAnular()] }, xubioAnular({ pagoBean: () => json({ error: 'caído' }, 500) }))
await correr(true)
check('Xubio falla al leer la OP (5xx): no se borra nada y queda PENDIENTE para reintentar', borrados(m).length === 0 && ultimaAnulacion(m) === undefined && m.tablas.pagos[0].anulacion_xubio === 'PENDIENTE')

m = mundo({ pagos: [pagoAnular()] }, xubioAnular({ borrarPago: noResponde }))
await correr(true)
check('Xubio no contesta al borrar: ERROR "no se sabe si Xubio la borró"', ultimaAnulacion(m)?.p_estado === 'ERROR' && /no se sabe si Xubio borró/.test(String(ultimaAnulacion(m)?.p_detalle)))

m = mundo({ pagos: [pagoAnular()] }, xubioAnular({ borrarPago: () => json({ error: 'No se puede' }, 409) }))
await correr(true)
check('Xubio rechaza el borrado (409): ERROR con el código', ultimaAnulacion(m)?.p_estado === 'ERROR' && /\(409\)/.test(String(ultimaAnulacion(m)?.p_detalle)))

m = mundo({ pagos: [pagoAnular({ xubio_id: 'FC-77' })] }, xubioAnular())
await correr(true)
check('pago dentro de una factura (FC-…): no tiene OP, sigue "anular a mano" aunque esté prendida', borrados(m).length === 0 && m.tablas.pagos[0].anulacion_xubio === 'ERROR' && llamadas(m, 'resultado_anulacion_xubio').length === 0)

m = mundo({ pagos: [pagoAnular({ empresa_id: 'india' })] }, xubioAnular())
await correr(true)
check('empresa sin credenciales: ERROR claro y no se llama a Xubio', borrados(m).length === 0 && ultimaAnulacion(m)?.p_estado === 'ERROR' && /credenciales/.test(String(ultimaAnulacion(m)?.p_detalle)))
delete process.env.XUBIO_ANULAR_ENVIO_REAL
delete process.env.XUBIO_TIMEOUT_MS

check('ningún pedido salió del simulador', m.pedidos.every((p) => p.url.startsWith('http://supabase.prueba') || p.url.startsWith('https://xubio.com/')))
cerrar()
