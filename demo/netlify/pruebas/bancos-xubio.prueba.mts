// T-202 · Envíos bancarios a Xubio y mail del control diario, contra el simulador (sin Supabase, Xubio ni mail reales).
// Uso: node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/bancos-xubio.prueba.mts
import { cerrar, check, json, noResponde, pedido, simular, ORG_PRUEBA, type Externo, type Fila, type Mundo, type Pedido } from './simulador.mts'

delete process.env.XUBIO_BANCOS_ENVIO_REAL
delete process.env.XUBIO_BORRAR_ASIENTO_CONFIRMADO
delete process.env.XUBIO_FACTURAS_ENVIO_REAL
delete process.env.CONTROL_DIARIO_ENVIO_REAL
process.env.XUBIO_CREDS_JSON = JSON.stringify({ beratung: { clientId: 'id-prueba', secret: 'secreto-prueba' } })

const bancos = await import('../functions/lib/xubio-bancos.ts')
const control = await import('../functions/lib/control-diario.ts')
const manual = (await import('../functions/xubio-bancos.mts')).default
const { supabaseAdmin } = await import('../functions/lib/comun.ts')
const { procesarPendientesBancos, problemaDeAsiento, idNumerico } = bancos

const EMPRESA = { id: 'beratung', nombre: 'Beratung S.A.', erp: 'XUBIO' }
const CUENTA_BANCO = 'cuenta-hipotecario'
const F1 = 'f0000000-0000-0000-0000-000000000001'
const A1 = 'a0000000-0000-0000-0000-000000000001'

// ---------------------------------------------------------------- Xubio simulado

interface OpcXubio {
  rechazarAsiento?: boolean
  asiento?: Externo
  borrar?: number
}
function xubioFalso(opc: OpcXubio = {}) {
  const creadas: Fila[] = []
  const handler: Externo = (p, corte) => {
    const r = p.ruta.replace('/API/1.1/', '')
    if (r === 'TokenEndpoint') return json({ access_token: 't', token_type: 'Bearer' })
    if (r === 'ProveedorBean') return json([{ proveedorid: 300, nombre: 'BANCO HIPOTECARIO S.A.', CUIT: '30-99999999-1' }])
    // El nombre no coincide con la cuenta: se elige por el código GASTOS_BANCARIOS.
    if (r === 'ProductoCompraBean') return json([{ productoid: 40, nombre: 'Comisiones y gastos de banco', codigo: 'GASTOS_BANCARIOS' }])
    if (r === 'comprobanteCompraBean' && p.metodo === 'GET') return json(creadas)
    if (r === 'comprobanteCompraBean' && p.metodo === 'POST') {
      creadas.push({ ...(p.cuerpo as Fila), transaccionid: 9001 })
      return json({ transaccionid: 9001 })
    }
    if (r === 'cuenta') return json([{ ID: 1, nombre: 'IMPUESTO DEB/CRED BANCARIO', codigo: 'IDCB' }, { ID: 2, nombre: 'Banco Hipotecario CC 0319', codigo: 'BH' }])
    if (r === 'asientoContableManualBean' && p.metodo === 'POST') {
      if (opc.asiento) return opc.asiento(p, corte)
      return opc.rechazarAsiento ? json({ error: 'La cuenta IMPUESTO DEB/CRED BANCARIO está inactiva' }, 400) : json({ transaccionid: 7001 })
    }
    if (r.startsWith('asientoContableManualBean/') && p.metodo === 'DELETE') return opc.borrar && opc.borrar !== 200 ? json({ error: 'No existe' }, opc.borrar) : json(null, 204)
    return json({ error: `La prueba no esperaba ${p.metodo} ${r}` }, 500)
  }
  return { handler, creadas }
}

const factura = (extra: Fila = {}): Fila => ({
  id: F1, empresa_id: 'beratung', tipo: 'Extracto Bancario', estado: 'PAGADA', estado_xubio: 'PENDIENTE', xubio_envio_en: null, xubio_id: null,
  cuenta_origen_extracto_id: CUENTA_BANCO, letra: null, punto_venta: 9990, numero: 20261125, fecha: '2026-11-25', vencimiento: '2026-11-25', cotizacion: 1,
  neto: 1000, iva: 210, exento: 0, percepciones: 50, total: 1260, codigo_producto: null, cuenta_contable: 'GASTOS BANCARIOS',
  percepciones_json: [{ tipo: 'PERCEPCION_IIBB', cuenta: 'RETENCIÓN BANCARIA IIBB (SIRCREB)', importe: 50, movimiento: 'm3' }],
  proveedores: { nombre: 'BANCO HIPOTECARIO S.A.', cuit: '30999999991' }, empresas: EMPRESA, ...extra,
})
const asiento = (extra: Fila = {}): Fila => ({
  id: A1, empresa_id: 'beratung', cuenta_origen_id: CUENTA_BANCO, fecha: '2026-11-25', tipo: 'BANCARIO_DIARIO', descripcion: 'Movimientos del extracto Hipotecario 25/11/2026',
  estado_xubio: 'PENDIENTE', xubio_id: null, xubio_error: null, envio_xubio_en: null, anulado_en: null, anulacion_xubio: null, ...extra,
})
const lineas = (asientoId = A1, debe = 120, haber = 120): Fila[] => [
  { id: 1, asiento_id: asientoId, cuenta_contable: 'IMPUESTO DEB/CRED BANCARIO', debe, haber: 0, detalle: 'IMPUESTO' },
  { id: 2, asiento_id: asientoId, cuenta_contable: 'Banco Hipotecario CC 0319', debe: 0, haber, detalle: 'Banco' },
]

function mundo(tablas: Record<string, Fila[]> = {}, xubio: Externo = xubioFalso().handler): Mundo {
  return simular({
    sesiones: { guido: 'administracion@prueba.com', vivi: 'tesoreria@prueba.com' },
    tablas: {
      empresas: [EMPRESA],
      usuarios: [
        { email: 'administracion@prueba.com', nombre: 'Guido', rol: 'ADMINISTRACION', activo: true, todas_empresas: true },
        { email: 'tesoreria@prueba.com', nombre: 'Vivi', rol: 'TESORERIA', activo: true, todas_empresas: true },
        { email: 'controller@prueba.com', nombre: 'Santi', rol: 'CONTROLLER', activo: true, todas_empresas: true },
        { email: 'baja@prueba.com', nombre: 'Baja', rol: 'TESORERIA', activo: false, todas_empresas: true },
      ],
      facturas: [], asientos: [], asiento_lineas: [], movimientos_bancarios: [], pagos: [], cheques: [],
      xubio_log: [], procesos_log: [], conexiones_erp: [], control_envios: [], control_bancos: [],
      ...tablas,
    },
    rpc: {
      tomar_bloqueo: () => true,
      soltar_bloqueo: () => null,
      es_dia_habil: () => true,
      empresas_visibles_de: () => ['beratung'],
      reservar_factura_xubio: (a, m) => {
        const f = m.tablas.facturas.find((x) => x.id === a.p_id)
        if (!f || !['PENDIENTE', 'ERROR'].includes(String(f.estado_xubio)) || f.xubio_envio_en) return false
        f.xubio_envio_en = 'ahora'
        return true
      },
      resultado_factura_xubio: (a, m) => {
        const f = m.tablas.facturas.find((x) => x.id === a.p_id)!
        Object.assign(f, {
          estado_xubio: a.p_estado, xubio_id: a.p_xubio_id ?? f.xubio_id, xubio_error: a.p_estado === 'SUBIDA' ? null : a.p_error,
          xubio_envio_en: a.p_liberar || a.p_estado === 'SUBIDA' ? null : f.xubio_envio_en,
        })
      },
      // Igual que la función de 0024: al subir, sus movimientos quedan contabilizados.
      resultado_asiento_xubio: (a, m) => {
        const x = m.tablas.asientos.find((y) => y.id === a.p_id)!
        Object.assign(x, { estado_xubio: a.p_ok ? 'SUBIDA' : 'ERROR', xubio_id: a.p_xubio_id ?? x.xubio_id, xubio_error: a.p_ok ? null : a.p_error, envio_xubio_en: null })
        if (a.p_ok) for (const mv of m.tablas.movimientos_bancarios) if (mv.asiento_id === a.p_id && ['PENDIENTE', 'A_REVISAR'].includes(String(mv.estado))) mv.estado = 'CONTABILIZADO'
      },
    },
    xubio,
  })
}

const aXubio = (m: Mundo, metodo: string, ruta: string) => m.pedidos.filter((p) => p.metodo === metodo && p.ruta === `/API/1.1/${ruta}`)
const log = (m: Mundo, entidad?: string) => m.tablas.procesos_log.filter((l) => !entidad || l.entidad === entidad)
// El cliente de Supabase va al simulador (fetch reemplazado); el mundo activo es el último que se armó.
const correr = (_m: Mundo, real: boolean, extra: Partial<Parameters<typeof procesarPendientesBancos>[1]> = {}) =>
  procesarPendientesBancos(supabaseAdmin(), { organizacionId: ORG_PRUEBA, real, ...extra })

// ================================================================ Armado
check('asiento balanceado pasa la validación', problemaDeAsiento(lineas().map((l) => ({ cuenta_contable: String(l.cuenta_contable), debe: Number(l.debe), haber: Number(l.haber) }))) === null)
check('asiento que no balancea se detecta', /no balancea/.test(problemaDeAsiento(lineas(A1, 120, 100).map((l) => ({ cuenta_contable: String(l.cuenta_contable), debe: Number(l.debe), haber: Number(l.haber) }))) ?? ''))
check('id de Xubio: "OP-7002" → 7002; "FC-9" no es un asiento', idNumerico('OP-7002') === '7002' && idNumerico('7001') === '7001' && idNumerico('FC-9') === null)

// ================================================================ a) Comprobante "Extracto Bancario"
// En seco: no se crea nada y no cambia ningún estado; queda el payload en xubio_log.
let m = mundo({ facturas: [factura()] })
let r = await correr(m, false)
let enviado = m.tablas.xubio_log.find((l) => l.entidad === 'FACTURA')?.request as { payload: Fila } | undefined
check('en seco: el comprobante no se sube y sigue PENDIENTE', aXubio(m, 'POST', 'comprobanteCompraBean').length === 0 && m.tablas.facturas[0].estado_xubio === 'PENDIENTE' && r.items[0]?.estado === 'PRUEBA_OK', JSON.stringify(r.items))
check('…el payload es comprobante de compra tipo 8, 09990-20261125, al banco por CUIT', enviado?.payload.tipo === 8 && enviado?.payload.numeroDocumento === '09990-20261125' && (enviado?.payload.proveedor as Fila | undefined)?.ID === 300)
const item = (enviado?.payload.transaccionProductoItems as Fila[] | undefined)?.[0]
check('…neto al producto GASTOS_BANCARIOS (por código) e IVA en el ítem', (item?.producto as Fila | undefined)?.codigo === 'GASTOS_BANCARIOS' && item?.precio === 1000 && item?.iva === 210)
const perc = (enviado?.payload.transaccionPercepcionItems as Fila[] | undefined) ?? []
check('…la percepción de IIBB va en percepciones, con la cuenta de la regla', perc.length === 1 && perc[0].importe === 50 && (perc[0].percepcionImpuesto as Fila).codigo === 'PERCEPCION_IIBB' && (perc[0].percepcionImpuesto as Fila).nombre === 'RETENCIÓN BANCARIA IIBB (SIRCREB)')
check('…y queda en procesos_log en modo PRUEBA', log(m, 'COMPROBANTE')[0]?.modo === 'PRUEBA' && log(m, 'COMPROBANTE')[0]?.estado === 'PRUEBA_OK')

// Real: sube una vez; la segunda corrida no lo vuelve a mandar.
let xf = xubioFalso()
m = mundo({ facturas: [factura()] }, xf.handler)
await correr(m, true)
await correr(m, true)
check('real: el comprobante sube una sola vez en dos corridas', aXubio(m, 'POST', 'comprobanteCompraBean').length === 1 && m.tablas.facturas[0].estado_xubio === 'SUBIDA' && m.tablas.facturas[0].xubio_id === '9001')
// Si la base lo perdió (vuelve a PENDIENTE) pero ya está en Xubio (mismo número + CUIT del banco): se vincula, no se duplica.
Object.assign(m.tablas.facturas[0], { estado_xubio: 'PENDIENTE', xubio_id: null })
r = await correr(m, true)
check('…y si ya está en Xubio con el mismo número y banco, se vincula sin duplicar', aXubio(m, 'POST', 'comprobanteCompraBean').length === 1 && m.tablas.facturas[0].estado_xubio === 'SUBIDA' && /Ya estaba en Xubio/.test(r.items[0]?.detalle ?? ''), JSON.stringify(r.items))
check('…procesos_log: OK en modo REAL', log(m, 'COMPROBANTE').some((l) => l.estado === 'OK' && l.modo === 'REAL'))

// Una factura común no la toca este circuito (la sube el subidor de facturas).
m = mundo({ facturas: [factura({ tipo: 'Factura A', cuenta_origen_extracto_id: null })] })
r = await correr(m, true)
check('una factura de proveedor común no entra en los envíos bancarios', r.items.length === 0 && aXubio(m, 'POST', 'comprobanteCompraBean').length === 0)

// ================================================================ b) Asientos
const movs = (): Fila[] => [
  { id: 'm1', asiento_id: A1, estado: 'PENDIENTE', importe: -100 },
  { id: 'm2', asiento_id: A1, estado: 'PENDIENTE', importe: -20 },
  { id: 'm9', asiento_id: null, estado: 'PENDIENTE', importe: -5 },
]
m = mundo({ asientos: [asiento()], asiento_lineas: lineas(), movimientos_bancarios: movs() })
r = await correr(m, false)
check('en seco: el asiento no se sube ni cambia', aXubio(m, 'POST', 'asientoContableManualBean').length === 0 && m.tablas.asientos[0].estado_xubio === 'PENDIENTE' && r.items[0]?.estado === 'PRUEBA_OK', JSON.stringify(r.items))

m = mundo({ asientos: [asiento()], asiento_lineas: lineas(), movimientos_bancarios: movs() })
r = await correr(m, true)
let posts = aXubio(m, 'POST', 'asientoContableManualBean')
const cuerpo = posts[0]?.cuerpo as { asientoContableManualItem: Fila[]; externalId: string; importetotal: number } | undefined
check('real: el asiento balanceado sube con sus dos líneas (debe y haber)', posts.length === 1 && cuerpo?.asientoContableManualItem.length === 2 && cuerpo.asientoContableManualItem[0].debeHaber === 1 && cuerpo.asientoContableManualItem[1].debeHaber === -1 && cuerpo.importetotal === 120 && cuerpo.externalId === A1)
check('…las cuentas son las del plan de Xubio (por nombre exacto)', (cuerpo?.asientoContableManualItem[0]?.cuenta as Fila | undefined)?.ID === 1 && (cuerpo?.asientoContableManualItem[1]?.cuenta as Fila | undefined)?.ID === 2)
check('…queda SUBIDA con el id de Xubio (resultado_asiento_xubio)', m.tablas.asientos[0].estado_xubio === 'SUBIDA' && m.tablas.asientos[0].xubio_id === '7001')
check('…y sus movimientos quedan CONTABILIZADOS (los de otro asiento no)', m.tablas.movimientos_bancarios.filter((x) => x.asiento_id === A1).every((x) => x.estado === 'CONTABILIZADO') && m.tablas.movimientos_bancarios[2].estado === 'PENDIENTE')
await correr(m, true)
check('…una segunda corrida no lo vuelve a mandar', aXubio(m, 'POST', 'asientoContableManualBean').length === 1)

// Error de Xubio: queda ERROR con el detalle.
m = mundo({ asientos: [asiento()], asiento_lineas: lineas(), movimientos_bancarios: movs() }, xubioFalso({ rechazarAsiento: true }).handler)
r = await correr(m, true)
check('Xubio rechaza el asiento: queda ERROR con el detalle de Xubio', m.tablas.asientos[0].estado_xubio === 'ERROR' && /400.*inactiva/.test(String(m.tablas.asientos[0].xubio_error)), String(m.tablas.asientos[0].xubio_error))
check('…los movimientos no se contabilizan', m.tablas.movimientos_bancarios.every((x) => x.estado === 'PENDIENTE'))
check('…y procesos_log lo registra como ERROR con el motivo', log(m, 'ASIENTO').some((l) => l.estado === 'ERROR' && /inactiva/.test(String(l.detalle))))

// Asiento que no balancea: no se llama a Xubio.
m = mundo({ asientos: [asiento()], asiento_lineas: lineas(A1, 120, 100) })
await correr(m, true)
check('asiento que no balancea: ERROR sin llamar a Xubio', aXubio(m, 'POST', 'asientoContableManualBean').length === 0 && m.tablas.asientos[0].estado_xubio === 'ERROR' && /no balancea/.test(String(m.tablas.asientos[0].xubio_error)))

// Cuenta que no existe en Xubio.
m = mundo({ asientos: [asiento()], asiento_lineas: [{ ...lineas()[0], cuenta_contable: 'Rendimientos FCI' }, lineas()[1]] })
await correr(m, true)
check('cuenta que no está en el plan de Xubio: ERROR que la nombra', aXubio(m, 'POST', 'asientoContableManualBean').length === 0 && /Rendimientos FCI/.test(String(m.tablas.asientos[0].xubio_error)))

// Xubio no contesta: ERROR "sin confirmar" con la reserva puesta (no se reintenta a ciegas).
process.env.XUBIO_TIMEOUT_MS = '200'
m = mundo({ asientos: [asiento()], asiento_lineas: lineas() }, xubioFalso({ asiento: noResponde }).handler)
await correr(m, true)
check('Xubio no responde: ERROR sin confirmar y la reserva queda puesta', m.tablas.asientos[0].estado_xubio === 'ERROR' && /sin confirmar/.test(String(m.tablas.asientos[0].xubio_error)) && m.tablas.asientos[0].envio_xubio_en != null)
await correr(m, true)
check('…y la corrida siguiente no lo reintenta', aXubio(m, 'POST', 'asientoContableManualBean').length === 1)
delete process.env.XUBIO_TIMEOUT_MS

// ================================================================ c) Anulaciones
const anulaciones = (): Record<string, Fila[]> => ({
  asientos: [asiento({ estado_xubio: 'SUBIDA', xubio_id: '7001', anulado_en: '2026-11-26T10:00:00Z', anulacion_xubio: 'PENDIENTE' })],
  pagos: [
    { id: 'p-op', empresa_id: 'beratung', xubio_id: 'OP-555', forma_carga_xubio: 'ORDEN_PAGO', anulacion_xubio: 'PENDIENTE' },
    { id: 'p-as', empresa_id: 'beratung', xubio_id: 'OP-7002', forma_carga_xubio: 'ASIENTO_MANUAL', anulacion_xubio: 'PENDIENTE' },
  ],
  cheques: [{ id: 'ch-1', empresa_id: 'beratung', numero: '12345678', xubio_emision_id: '880', anulacion_xubio: 'PENDIENTE' }],
})

// Sin confirmar el endpoint de borrado: no se llama a Xubio y el asiento sigue PENDIENTE.
m = mundo(anulaciones())
r = await correr(m, true)
check('[FALTA confirmar endpoint]: sin confirmación no se borra nada y queda PENDIENTE', m.pedidos.every((p) => p.metodo !== 'DELETE') && m.tablas.asientos[0].anulacion_xubio === 'PENDIENTE' && r.items.some((i) => i.estado === 'OMITIDO' && /FALTA confirmar endpoint/.test(i.detalle)))

process.env.XUBIO_BORRAR_ASIENTO_CONFIRMADO = 'true'
m = mundo(anulaciones())
r = await correr(m, false)
check('en seco: no se borra nada ni cambia ningún estado', m.pedidos.every((p) => p.metodo !== 'DELETE') && m.tablas.asientos[0].anulacion_xubio === 'PENDIENTE' && m.tablas.pagos.every((p) => p.anulacion_xubio === 'PENDIENTE') && m.tablas.cheques[0].anulacion_xubio === 'PENDIENTE')

m = mundo(anulaciones())
r = await correr(m, true)
check('anulación pendiente de un asiento → DELETE en Xubio y HECHA', aXubio(m, 'DELETE', 'asientoContableManualBean/7001').length === 1 && m.tablas.asientos[0].anulacion_xubio === 'HECHA')
check('pago cargado como asiento manual → se borra ese asiento y HECHA', aXubio(m, 'DELETE', 'asientoContableManualBean/7002').length === 1 && m.tablas.pagos[1].anulacion_xubio === 'HECHA')
check('pago con orden de pago → ERROR "anular a mano" (Xubio no borra OP por API)', m.tablas.pagos[0].anulacion_xubio === 'ERROR' && log(m, 'ANULAR_PAGO').some((l) => l.estado === 'ERROR' && /a mano/.test(String(l.detalle))))
check('cheque → ERROR "anular a mano"', m.tablas.cheques[0].anulacion_xubio === 'ERROR')
await correr(m, true)
check('…una segunda corrida no vuelve a borrar', m.pedidos.filter((p) => p.metodo === 'DELETE').length === 2)

m = mundo({ asientos: anulaciones().asientos }, xubioFalso({ borrar: 404 }).handler)
await correr(m, true)
check('Xubio no encuentra el asiento al borrar: ERROR con el detalle', m.tablas.asientos[0].anulacion_xubio === 'ERROR' && log(m, 'ANULAR_ASIENTO').some((l) => /404/.test(String(l.detalle))))
delete process.env.XUBIO_BORRAR_ASIENTO_CONFIRMADO

// ================================================================ Corrida manual (POST /api/xubio/bancos)
m = mundo({ asientos: [asiento()], asiento_lineas: lineas() })
let resp = await manual(pedido('vivi'))
check('corrida manual: Tesorería no puede (rol)', resp.status === 403)
process.env.XUBIO_BANCOS_ENVIO_REAL = 'true'
resp = await manual(pedido('guido', { enSeco: true }))
let rj = await resp.json()
check('corrida manual con enSeco: no envía aunque el envío real esté prendido', resp.status === 200 && rj.real === false && aXubio(m, 'POST', 'asientoContableManualBean').length === 0)
check('…y avisa a la pantalla que el servidor sí tiene el envío real prendido (T-205)', rj.envioRealHabilitado === true && Array.isArray(rj.items))
delete process.env.XUBIO_BANCOS_ENVIO_REAL
// T-205 · La pantalla pide enviar (sin enSeco) y el servidor está en seco: no se manda nada y la respuesta lo dice.
m = mundo({ asientos: [asiento()], asiento_lineas: lineas() })
resp = await manual(pedido('guido', { enSeco: false }))
rj = await resp.json()
check('corrida manual "enviar" con el servidor en seco: real=false, envioRealHabilitado=false, nada a Xubio',
  resp.status === 200 && rj.real === false && rj.envioRealHabilitado === false && aXubio(m, 'POST', 'asientoContableManualBean').length === 0 && m.tablas.asientos[0].estado_xubio === 'PENDIENTE', JSON.stringify(rj))

// ================================================================ d) Control diario
const AHORA = new Date('2026-11-26T11:00:00Z') // 8:00 en Buenos Aires
const hallazgos = (): Fila[] => [
  { empresa_id: 'beratung', control: 'A_REVISAR', sujeto: 'Hipotecario', fecha: '2026-11-25', detalle: 'TRANSF <script>x</script>', importe: -5, gravedad: 2 },
  { empresa_id: 'beratung', control: 'FALTA_EXTRACTO', sujeto: 'Brubank', fecha: '2026-11-25', detalle: 'Subí el extracto', importe: null, gravedad: 1 },
]
function enviadorFalso(falla = false) {
  const enviados: { para: string[]; asunto: string; html: string }[] = []
  return {
    enviados,
    enviador: { nombre: 'Correo de prueba', enviar: async (x: { para: string[]; asunto: string; html: string }) => { if (falla) throw new Error('servidor caído'); enviados.push(x); return { id: 'msg-1' } } },
  }
}

check('hoy en Buenos Aires a las 11 UTC es el mismo día', control.hoyBuenosAires(AHORA) === '2026-11-26' && control.hoyBuenosAires(new Date('2026-11-27T01:00:00Z')) === '2026-11-26')

m = mundo({ control_bancos: hallazgos() })
let ev = enviadorFalso()
let rc = await control.enviarControlDiario(supabaseAdmin(), { organizacionId: ORG_PRUEBA, real: false, enviador: ev.enviador, ahora: AHORA })
check('control en seco: no manda ni registra envío', rc.estado === 'PRUEBA_OK' && ev.enviados.length === 0 && m.tablas.control_envios.length === 0 && log(m)[0]?.proceso === 'CONTROL_DIARIO')

m = mundo({ control_bancos: hallazgos() })
rc = await control.enviarControlDiario(supabaseAdmin(), { organizacionId: ORG_PRUEBA, real: true, enviador: null, ahora: AHORA })
check('control real sin proveedor de mail: no manda nada (PENDIENTE DE FIRMA)', rc.estado === 'OMITIDO' && /PENDIENTE DE FIRMA/.test(rc.detalle) && m.tablas.control_envios.length === 0)

m = mundo({ control_bancos: hallazgos() })
ev = enviadorFalso()
const db = supabaseAdmin()
rc = await control.enviarControlDiario(db, { organizacionId: ORG_PRUEBA, real: true, enviador: ev.enviador, ahora: AHORA })
const rc2 = await control.enviarControlDiario(db, { organizacionId: ORG_PRUEBA, real: true, enviador: ev.enviador, ahora: AHORA })
check('control diario: el primero se manda y queda en control_envios', rc.estado === 'OK' && m.tablas.control_envios.length === 1 && m.tablas.control_envios[0].fecha === '2026-11-26')
check('…el segundo del mismo día no se manda', rc2.estado === 'OMITIDO' && ev.enviados.length === 1 && m.tablas.control_envios.length === 1)
const mail = ev.enviados[0]
check('…destinatarios: Controller y Tesorería activos (no Administración ni bajas)', JSON.stringify(mail?.para) === JSON.stringify(['controller@prueba.com', 'tesoreria@prueba.com']), JSON.stringify(mail?.para))
check('…asunto con la cantidad y los urgentes', mail?.asunto === 'Control diario de bancos 26/11/2026 · 2 pendientes (1 urgente)', mail?.asunto)
check('…tabla por empresa, urgentes primero y el texto escapado', /Beratung S\.A\./.test(mail?.html ?? '') && (mail?.html ?? '').indexOf('Falta el extracto') < (mail?.html ?? '').indexOf('Movimiento sin clasificar') && !(mail?.html ?? '').includes('<script>') && (mail?.html ?? '').includes('&lt;script&gt;'))

m = mundo({ control_bancos: hallazgos() })
ev = enviadorFalso(true)
rc = await control.enviarControlDiario(db, { organizacionId: ORG_PRUEBA, real: true, enviador: ev.enviador, ahora: AHORA })
check('si el mail no sale: ERROR y se libera el día para reintentar', rc.estado === 'ERROR' && m.tablas.control_envios.length === 0 && log(m).some((l) => l.estado === 'ERROR' && /servidor caído/.test(String(l.detalle))))

m = mundo({ control_bancos: hallazgos() })
m.rpc.es_dia_habil = () => false
ev = enviadorFalso()
rc = await control.enviarControlDiario(db, { organizacionId: ORG_PRUEBA, real: true, enviador: ev.enviador, ahora: AHORA })
check('feriado: no se manda', rc.estado === 'OMITIDO' && ev.enviados.length === 0)

m = mundo({ control_bancos: [] })
ev = enviadorFalso()
rc = await control.enviarControlDiario(db, { organizacionId: ORG_PRUEBA, real: true, enviador: ev.enviador, ahora: AHORA })
check('sin pendientes: igual sale el mail "sin pendientes"', rc.estado === 'OK' && /sin pendientes/.test(ev.enviados[0]?.asunto ?? ''))

// Cada destinatario recibe solo las empresas que ve (T-208, revisión T-207 hallazgo 11).
m = mundo({
  empresas: [EMPRESA, { ...EMPRESA, id: 'india', nombre: 'India de Prueba S.A.' }],
  usuarios: [
    { email: 'tesoreria@prueba.com', nombre: 'Vivi', rol: 'TESORERIA', activo: true, todas_empresas: true, organizacion_id: ORG_PRUEBA },
    { email: 'controller@prueba.com', nombre: 'Santi', rol: 'CONTROLLER', activo: true, todas_empresas: true, organizacion_id: ORG_PRUEBA },
    { email: 'solo-beratung@prueba.com', nombre: 'Solo Beratung', rol: 'TESORERIA', activo: true, todas_empresas: false, organizacion_id: ORG_PRUEBA },
    { email: 'sin-empresas@prueba.com', nombre: 'Sin empresas', rol: 'TESORERIA', activo: true, todas_empresas: false, organizacion_id: ORG_PRUEBA },
  ],
  control_bancos: [...hallazgos(), { empresa_id: 'india', control: 'DIFERENCIA', sujeto: 'Banco de India', fecha: '2026-11-25', detalle: 'Banco 10 · calculado 8', importe: 2, gravedad: 1 }],
})
m.rpc.empresas_visibles_de = (a) => (a.p_email === 'solo-beratung@prueba.com' ? ['beratung'] : a.p_email === 'sin-empresas@prueba.com' ? [] : ['beratung', 'india'])
ev = enviadorFalso()
rc = await control.enviarControlDiario(db, { organizacionId: ORG_PRUEBA, real: true, enviador: ev.enviador, ahora: AHORA })
const mailSolo = ev.enviados.find((x) => x.para.includes('solo-beratung@prueba.com'))
const mailTodo = ev.enviados.find((x) => x.para.includes('controller@prueba.com'))
check('control por destinatario: un mail por cada conjunto de empresas visibles', rc.estado === 'OK' && ev.enviados.length === 2 && JSON.stringify(mailTodo?.para) === JSON.stringify(['controller@prueba.com', 'tesoreria@prueba.com']) && JSON.stringify(mailSolo?.para) === JSON.stringify(['solo-beratung@prueba.com']), JSON.stringify(ev.enviados.map((x) => x.para)))
check('…quien ve solo una empresa no recibe datos de la otra', !!mailSolo && !/India de Prueba|Banco de India/.test(mailSolo.html) && /Beratung/.test(mailSolo.html) && /2 pendientes/.test(mailSolo.asunto), mailSolo?.asunto)
check('…quien ve todas recibe todas', !!mailTodo && /India de Prueba/.test(mailTodo.html) && /Banco de India/.test(mailTodo.html) && /3 pendientes/.test(mailTodo.asunto), mailTodo?.asunto)
check('…quien no ve ninguna empresa no recibe nada, y queda un solo registro del día', ev.enviados.every((x) => !x.para.includes('sin-empresas@prueba.com')) && m.tablas.control_envios.length === 1 && (m.tablas.control_envios[0].destinatarios as string[]).length === 3)

// Nada de lo de arriba habló con un servicio que no fuera el simulado.
check('ningún pedido salió del simulador', m.pedidos.every((p: Pedido) => p.url.startsWith('http://supabase.prueba') || p.url.startsWith('https://xubio.com/')))

cerrar()
