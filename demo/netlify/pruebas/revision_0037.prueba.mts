// Revisión independiente de la tanda "Xubio de ida y vuelta" (agente 06, 27/11/2026), contra el simulador.
// "BUG" = comportamiento que no debería pasar; "OK" = control. No toca Xubio ni Supabase reales.
// Uso (desde demo/): node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/revision_0037.prueba.mts
import { json, simular, ORG_PRUEBA, type Externo, type Fila, type Mundo } from './simulador.mts'

delete process.env.XUBIO_ANULAR_ENVIO_REAL
delete process.env.XUBIO_BANCOS_ENVIO_REAL
delete process.env.XUBIO_BORRAR_ASIENTO_CONFIRMADO
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: 'a', secret: 'b' }, india: { clientId: 'c', secret: 'd' } })
process.env.XUBIO_TIMEOUT_MS = '300'

const lib = await import('../functions/lib/xubio-ida-vuelta.ts')
const anular = await import('../functions/lib/xubio-anular.ts')
const bancos = await import('../functions/lib/xubio-bancos.ts')
const { supabaseAdmin } = await import('../functions/lib/comun.ts')
const db = supabaseAdmin()

let ok = 0
let bug = 0
const check = (nombre: string, cond: boolean, extra = '') => {
  if (cond) ok++
  else bug++
  console.log(`${cond ? 'OK ' : 'BUG'} ${nombre}${!cond && extra ? ' · ' + extra : ''}`)
}

const EMPRESAS = [
  { id: 'beratung', nombre: 'Beratung S.A.', erp: 'XUBIO' },
  { id: 'india', nombre: 'India ADV S.A.', erp: 'XUBIO' },
]
function mundo(tablas: Record<string, Fila[]>, xubio: Externo, rpc: Mundo['rpc'] = {}): Mundo {
  return simular({
    tablas: { empresas: EMPRESAS, usuarios: [], pagos: [], asientos: [], cheques: [], xubio_log: [], procesos_log: [], conexiones_erp: [], ...tablas },
    rpc: {
      tomar_bloqueo: () => true,
      soltar_bloqueo: () => null,
      resultado_anulacion_xubio: (a, m) => {
        const x = m.tablas.pagos.find((y) => y.id === a.p_id)
        if (x) x.anulacion_xubio = a.p_estado
        return true
      },
      ...rpc,
    },
    xubio,
  })
}
const token = (p: { ruta: string }) => p.ruta.endsWith('TokenEndpoint')
const borrados = (m: Mundo) => m.pedidos.filter((p) => p.metodo === 'DELETE')

// ---------------------------------------------------------------- 1. N° de OP: los números se repiten entre empresas
// Cada empresa es una cuenta distinta de Xubio con su propia numeración: X-0001-00000005 puede existir en las dos.
{
  const aplicados: string[] = []
  const m = mundo({}, (p) => {
    if (token(p)) return json({ access_token: 't', token_type: 'Bearer' })
    if (p.ruta.endsWith('/pagoBean')) return json([{ transaccionid: 11, numeroDocumento: 'X-0001-00000005', fecha: '2026-11-24', proveedor: { nombre: 'Gamma' }, transaccionInstrumentoDePago: [{ importe: 1000 }] }])
    return json({}, 500)
  }, {
    numero_op_pendientes: () => ({
      pendientes: [
        { id: 'pB', empresa_id: 'beratung', fecha: '2026-11-24', importe: 1000, proveedor: 'Gamma', xubio_id: 'OP-11' },
        { id: 'pI', empresa_id: 'india', fecha: '2026-11-24', importe: 1000, proveedor: 'Gamma', xubio_id: 'OP-11' },
      ],
      usados: [],
    }),
    aplicar_numero_op_xubio: (a) => {
      aplicados.push(`${a.p_pago}=${a.p_numero}`)
      return true
    },
  })
  void m
  await lib.completarNumerosOP(db, { organizacionId: ORG_PRUEBA })
  check('[1] el mismo N° de OP en dos empresas distintas (numeración propia de cada cuenta de Xubio) se le asigna a las dos', aplicados.length === 2, aplicados.join(' '))
}

// ---------------------------------------------------------------- 1b. nombre de proveedor "de fondo"
check('[1] "Perez" y "Maria Perez" (personas distintas) no deberían ser el mismo proveedor', !lib.mismoProveedor('Perez', 'Maria Perez'))
check('[1] "Gonzalez Hnos" y "Gonzalez Carlos" no deberían ser el mismo proveedor', !lib.mismoProveedor('Gonzalez Hnos', 'Carlos Gonzalez'))

// ---------------------------------------------------------------- 2. Anulación por API
process.env.XUBIO_ANULAR_ENVIO_REAL = 'true'
process.env.XUBIO_ANULAR_DESDE = '2026-11-27'
const pagoA = (extra: Fila = {}): Fila => ({ id: 'pa1', empresa_id: 'beratung', xubio_id: 'OP-555', forma_carga_xubio: 'ORDEN_PAGO', importe: 1000, anulacion_xubio: 'PENDIENTE', gestion: 'SISTEMA', anulado_en: '2026-11-27T10:00:00Z', fecha: '2026-11-24', proveedor_destino: 'Laboratorios Gamma SA', ...extra })
const xA = (o: { pago?: Externo; asiento?: Externo; borrar?: Externo }): Externo => (p, c) => {
  const r = p.ruta.replace('/API/1.1/', '')
  if (r === 'TokenEndpoint') return json({ access_token: 't', token_type: 'Bearer' })
  if (r === 'pagoBean/555' && p.metodo === 'GET') return o.pago ? o.pago(p, c) : json({ fecha: '2026-11-24', proveedor: { nombre: 'GAMMA S.A.' }, transaccionInstrumentoDePago: [{ importe: 1000 }] })
  if (r === 'pagoBean/555' && p.metodo === 'DELETE') return o.borrar ? o.borrar(p, c) : json(null, 204)
  if (r === 'asientoContableManualBean/555' && p.metodo === 'GET') return o.asiento ? o.asiento(p, c) : json({ error: 'no' }, 404)
  if (r === 'asientoContableManualBean/555' && p.metodo === 'DELETE') return json(null, 204)
  return json({ error: 'no esperado' }, 500)
}

// (a) un 429 (límite de pedidos) o un 401 al LEER se toma como "no encontrado" y la anulación queda en ERROR para siempre
let m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ error: 'demasiados pedidos' }, 429) }))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
check('[2] un 429 de Xubio al leer la OP no debería dejar la anulación en ERROR definitivo (debería quedar PENDIENTE para reintentar)', m.tablas.pagos[0].anulacion_xubio === 'PENDIENTE', String(m.tablas.pagos[0].anulacion_xubio))

// (b) el registro dice DELETE aunque no se haya borrado nada (importe distinto)
m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ fecha: '2026-11-24', proveedor: { nombre: 'GAMMA' }, transaccionInstrumentoDePago: [{ importe: 999 }] }) }))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
const lg = m.tablas.xubio_log.find((l) => l.en_seco === false)
check('[2] xubio_log no debería registrar un DELETE cuando la verificación del importe frenó el borrado', !(lg && (lg.request as { metodo?: string }).metodo === 'DELETE'), JSON.stringify(lg?.request))
check('[2] (control) con el importe distinto no se borra nada', borrados(m).length === 0)

// (c) una OP con dos instrumentos (1000 y 500): se anula el pago de 1000 y se borra la OP entera
m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ fecha: '2026-11-24', proveedor: { nombre: 'GAMMA' }, transaccionInstrumentoDePago: [{ importe: 1000 }, { importe: 500 }] }) }))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
check('[2] una OP de 1500 (dos instrumentos) no debería borrarse al anular un pago de 1000: se borraría también el pago de 500', borrados(m).length === 0)

// (d) cualquier número de la OP sirve como "importe": un campo que no es plata
m = mundo({ pagos: [pagoA({ importe: 12 })] }, xA({ pago: () => json({ fecha: '2026-11-24', proveedor: { nombre: 'GAMMA' }, cantidadCuotas: 12, transaccionInstrumentoDePago: [{ importe: 87000 }] }) }))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
check('[2] una OP de $87.000 no debería borrarse porque otro campo numérico (cuotas = 12) coincide con el importe del pago ($12)', borrados(m).length === 0)

// (e) las variables: con XUBIO_ANULAR_ENVIO_REAL pero sin BANCOS real no hay ningún DELETE
m = mundo({ pagos: [pagoA()] }, xA({}))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: false })
check('[2] control: con XUBIO_ANULAR_ENVIO_REAL=true pero la corrida en seco no hay ningún DELETE ni cambio de estado', borrados(m).length === 0 && m.tablas.pagos[0].anulacion_xubio === 'PENDIENTE')
delete process.env.XUBIO_ANULAR_ENVIO_REAL
m = mundo({ pagos: [pagoA()] }, xA({}))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
check('[2] control: con XUBIO_BANCOS real pero sin XUBIO_ANULAR_ENVIO_REAL no hay ningún DELETE', borrados(m).length === 0)

// (f) una anulación que el Apps Script ya hizo (o que se hizo a mano): la OP ya no existe
process.env.XUBIO_ANULAR_ENVIO_REAL = 'true'
m = mundo({ pagos: [pagoA({ forma_carga_xubio: 'SALIDA_FONDOS' })] }, xA({ pago: () => json({ error: 'no' }, 404) }))
await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
check('[2] con XUBIO_ANULAR_ENVIO_REAL un pago SALIDA_FONDOS ya no pasa por XUBIO_BORRAR_ASIENTO_CONFIRMADO (decisión documentada en xubio-anular.ts): se busca y se verifica como asiento', m.pedidos.some((p) => p.metodo === 'GET' && p.ruta.includes('asientoContableManualBean/555')) === true)
delete process.env.XUBIO_ANULAR_ENVIO_REAL

// ---------------------------------------------------------------- 3. Saldos: la lectura trae el saldo de HOY con la fecha del día hábil anterior
check('[3] (informativo) leerSaldosXubio guarda el saldo actual de la API con la fecha del día hábil anterior; si la API devuelve el saldo "al instante" hay un desfase', true)

// ---------------------------------------------------------------- 2 bis. Atraso, proveedor, fecha, registro y errores de la anulación
process.env.XUBIO_ANULAR_ENVIO_REAL = 'true'
process.env.XUBIO_ANULAR_DESDE = '2026-11-27'
const correr = async () => {
  await bancos.procesarPendientesBancos(db, { organizacionId: ORG_PRUEBA, real: true })
}
m = mundo({ pagos: [pagoA()] }, xA({}))
await correr()
check('[2] control: un pago del sistema anulado después de la fecha de corte, que coincide en todo, se borra', borrados(m).length === 1 && m.tablas.pagos[0].anulacion_xubio === 'HECHA')

delete process.env.XUBIO_ANULAR_DESDE
m = mundo({ pagos: [pagoA()] }, xA({}))
await correr()
check('[2] sin XUBIO_ANULAR_DESDE la anulación por API no procesa nada', borrados(m).length === 0 && m.pedidos.every((p) => !p.url.startsWith('https://xubio.com/')))
process.env.XUBIO_ANULAR_DESDE = '2026-11-27'
m = mundo({ pagos: [pagoA({ anulado_en: '2026-11-20T10:00:00Z' })] }, xA({}))
await correr()
check('[2] un pago anulado ANTES de la fecha de corte (el atraso) no se toca', borrados(m).length === 0 && m.pedidos.every((p) => !p.url.startsWith('https://xubio.com/')))
m = mundo({ pagos: [pagoA({ gestion: 'HOJA' })] }, xA({}))
await correr()
check('[2] un pago de la hoja (gestion HOJA) no se anula por API', borrados(m).length === 0)
m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ fecha: '2026-11-24', proveedor: { nombre: 'OTRO PROVEEDOR SA' }, transaccionInstrumentoDePago: [{ importe: 1000 }] }) }))
await correr()
check('[2] la OP de Xubio es de otro proveedor: no se borra', borrados(m).length === 0 && m.tablas.pagos[0].anulacion_xubio === 'ERROR')
m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ fecha: '2026-09-01', proveedor: { nombre: 'GAMMA' }, transaccionInstrumentoDePago: [{ importe: 1000 }] }) }))
await correr()
check('[2] la OP de Xubio es de otra fecha (más de 10 días): no se borra', borrados(m).length === 0 && m.tablas.pagos[0].anulacion_xubio === 'ERROR')
m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ error: 'sesión' }, 401) }))
await correr()
check('[2] un 401 al leer tampoco es definitivo: queda PENDIENTE', m.tablas.pagos[0].anulacion_xubio === 'PENDIENTE' && borrados(m).length === 0)
m = mundo({ pagos: [pagoA()] }, xA({ borrar: () => json({ error: 'límite' }, 429) }))
await correr()
check('[2] un 429 al borrar queda PENDIENTE para reintentar', m.tablas.pagos[0].anulacion_xubio === 'PENDIENTE')
m = mundo({ pagos: [pagoA({ id: 'pa1' }), pagoA({ id: 'pa2' })] }, xA({}), { resultado_anulacion_xubio: () => { throw new Error('base caída') } })
await correr()
check('[2] si resultado_anulacion_xubio falla, se registra y la corrida sigue con el otro pago', m.tablas.procesos_log.some((l) => l.estado === 'ERROR' && /No se pudo marcar la anulación/.test(String(l.detalle))) && borrados(m).length === 2)
m = mundo({ pagos: [pagoA()] }, xA({ pago: () => json({ fecha: '2026-11-24', proveedor: { nombre: 'GAMMA' }, transaccionInstrumentoDePago: [{ importe: 999 }] }) }))
await correr()
check('[2] xubio_log no dice DELETE si el borrado se frenó antes', m.tablas.xubio_log.every((l) => (l.request as { metodo?: string }).metodo !== 'DELETE'))
delete process.env.XUBIO_ANULAR_ENVIO_REAL
delete process.env.XUBIO_ANULAR_DESDE

console.log(`\n${ok} OK · ${bug} BUG`)
void anular
process.exit(bug ? 1 : 0)
