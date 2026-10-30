// Pruebas de lib/espejo.ts: traducción de filas de la hoja real a la base.
// Las filas imitan las de "Facturas automatizadas" tal como las manda gas/PuenteHojas.gs. Uso: npm run test:espejo
import { cuentasFactura, cuentasOrigenDe, cuentasPara, enLista, sugerirCuentaOrigen } from '../../src/lib/cuentas.ts'
import { catalogosDesdeHoja, categoriaVertice, empresaDesdeTexto, facturaDesdeFila, fecha, fechaHora, importe, metodoPago, numeroComprobante, pagoDesdeFila } from '../functions/lib/espejo.ts'

let ok = 0
let mal = 0
function check(nombre: string, cond: boolean, extra = '') {
  if (cond) ok++
  else mal++
  console.log(`${cond ? 'OK ' : 'MAL'} ${nombre}${extra ? ' · ' + extra : ''}`)
}

// --- Empresas como las escribe la IA en la hoja real
const casos: [string, string | null][] = [
  ['BERATUNG SA', 'beratung'], ['beratung sa', 'beratung'], ['India Adv SA', 'india'], ['CONTROL B SA', 'controlb'], ['YSD PHARMA S.A.', 'ysd'],
  ['DROGUERIA ROBLES S.A.', 'robles'], ['Droguería Robles', 'robles'], ['ROBLES DANIEL HECTOR', 'hrobles'], ['D ROBLES DANIEL HECTOR', 'hrobles'],
  ['ROBLES, DANIEL HECT', 'hrobles'], ['ROBLES DANI EL HECTOR', 'hrobles'], ['FARMA CONTROL S.A.', 'farmacontrol'], ['VERTICE BI S. A.', 'vertice'],
  ['SORAIRES SANTACRUZ MARIA CRISTINA', null], ['', null],
]
for (const [t, esperado] of casos) check(`empresa "${t}" → ${esperado}`, empresaDesdeTexto(t) === esperado)

// --- Números, fechas, comprobantes
check('importe: número tal cual', importe(526700) === 526700)
check('importe: "526,700.00" (formato de la hoja)', importe('526,700.00') === 526700)
check('importe: "1.234,56" (formato argentino)', importe('1.234,56') === 1234.56)
check('importe: vacío es 0', importe('') === 0)
check('fecha: aaaa-mm-dd', fecha('2026-08-28') === '2026-08-28')
check('fecha: dd/mm/aaaa es día primero', fecha('03/04/2026') === '2026-04-03')
check('fecha: basura es null', fecha('S/D') === null)
check('fecha como número de serie (así la manda el puente): 46304 = 09/10/2026', fecha(46304) === '2026-10-09')
check('serie con hora: 28/10/2026 14:05', fechaHora(46323 + 14 / 24 + 5 / 1440) === '2026-10-28T14:05:00-03:00')
check('un número que no es fecha (CUIT) no se toma como fecha', fecha(30574876474) === null)
check('fecha y hora de Buenos Aires', fechaHora('2026-10-28 14:05') === '2026-10-28T14:05:00-03:00')
check('comprobante 00004-00000106', JSON.stringify(numeroComprobante('00004-00000106')) === '{"puntoVenta":4,"numero":106}')
check('comprobante con letra A-0005-00001001', JSON.stringify(numeroComprobante('A-0005-00001001')) === '{"puntoVenta":5,"numero":1001}')
check('medios: Tarjeta de Crédito, E-cheq, Efectivo, Transferencia',
  metodoPago('Tarjeta de Crédito') === 'TARJETA' && metodoPago('E-cheq') === 'ECHEQ' && metodoPago('Efectivo') === 'CAJA' && metodoPago('Transferencia') === 'TRANSFERENCIA')

// --- Factura: la primera fila real de la hoja (recibo de alquiler, aprobado, pagado, Xubio lo omitió)
const base = {
  _fila: 2, RECEPTOR: 'BERATUNG S.A.', PROVEEDOR: 'DEVETAC FABIAN EDGARDO', CUIT_PROVEEDOR: '20170444168', LETRA: 'C', TIPO: 'Recibo C',
  NUMERO: '00004-00000106', CAE: '86350274640244', CAE_VENCIMIENTO: '2026-09-07', COMPROBANTE_VINCULADO: '0', FECHA: '2026-08-28',
  VENCIMIENTODELPAGO: '2026-08-28', MONEDA: 'ARS', COTIZACION: 1, IMPORTE: 526700, IVA: 0, TOTAL: 526700, NETO_NO_GRAVADO_EXENTO: 526700,
  CATEGORIA_CONTABLE: 'Alquiler Oficina Exento', DRIVE_URL: 'https://drive.google.com/file/d/x/view', ESTADO_VALIDACION: 'OK', MOTIVO_VALIDACION: '',
  ESTADO_XUBIO: "OMITIDA: TIPO 'Recibo C' no válido", ESTADO_APROBACION: 'APROBADA', METODO_PAGO: 'Transferencia', TIPO_PAGO: 'CUENTA_CORRIENTE',
  ESTADO_PAGO: 'NO_CONTABILIZADA', MOTIVO_NO_CONTABILIZADA: "Nunca se pudo subir a Xubio: OMITIDA: TIPO 'Recibo C' no válido",
  CODIGO_PRODUCTO: 'ALQUILER_OFICINA_EXENTO', PERCEPCIONES_JSON: '[]', URLS_COMPROBANTE_PAGO_JSON: '[{"url":"https://drive.google.com/file/d/y/view","nombre":"Pago.pdf"}]',
  MAIL_ENVIADO_FECHA: '07/09/2026 14:52', PORCENTAJE_PAGADO: 100, FECHA_PAGO: '2026-09-07', CATEGORIA_VERTICE: 'PROVEEDOR', XUBIO_ID_FACTURA: '',
}
let r = facturaDesdeFila(base, 'Facturas', 2)
let f = r.ok ? r.dato : {}
check('factura real: se traduce', r.ok)
check('factura real: Beratung, pv 4, número 106', f.empresa_id === 'beratung' && f.punto_venta === 4 && f.numero === 106)
check('factura real: pagada al 100 %', f.estado === 'PAGADA' && f.pagado === 526700)
check('factura real: Xubio con error y el motivo', f.estado_xubio === 'ERROR' && String(f.xubio_error).includes('Recibo C'))
check('factura real: medio y comprobantes de pago', f.metodo_pago === 'TRANSFERENCIA' && (f.comprobantes_pago as unknown[]).length === 1)
check('factura real: vinculado "0" queda vacío', f.comprobante_vinculado === null)

const huella1 = f.hoja_hash
r = facturaDesdeFila(base, 'Facturas_Aprobadas', 40)
check('misma factura en otra fila u otra pestaña: misma huella (no cuenta como cambio)', r.ok && r.dato.hoja_hash === huella1)
r = facturaDesdeFila({ ...base, PORCENTAJE_PAGADO: 50, ESTADO_PAGO: 'PARA_PAGAR' }, 'Facturas', 2)
check('pagada al 50 %: PAGADA_PARCIAL con la mitad en pesos', r.ok && r.dato.estado === 'PAGADA_PARCIAL' && r.dato.pagado === 263350)
check('un cambio en la hoja cambia la huella', r.ok && r.dato.hoja_hash !== huella1)
r = facturaDesdeFila({ ...base, PORCENTAJE_PAGADO: '', ESTADO_PAGO: 'PARA_PAGAR' }, 'Facturas', 2)
check('aprobada sin pagos: PARA_PAGAR', r.ok && r.dato.estado === 'PARA_PAGAR' && r.dato.pagado === 0)
r = facturaDesdeFila({ ...base, PORCENTAJE_PAGADO: 0.5, ESTADO_PAGO: 'PARA_PAGAR' }, 'Facturas', 2)
check('0,5 % es medio por ciento (no 50 %)', r.ok && r.dato.pagado === 2633.5)
r = facturaDesdeFila({ ...base, ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_PAGO: '', PORCENTAJE_PAGADO: '' }, 'Facturas', 2)
check('pendiente de aprobación', r.ok && r.dato.estado === 'PENDIENTE_APROBACION' && r.dato.pagado === 0)
r = facturaDesdeFila({ ...base, ESTADO_APROBACION: 'PENDIENTE_APROBACION', ESTADO_VALIDACION: 'ERROR', MOTIVO_VALIDACION: 'Descuadre de $10' }, 'Facturas', 2)
check('pendiente con validación en error: ERROR (Excepciones)', r.ok && r.dato.estado === 'ERROR' && r.dato.validacion_ok === false)
r = facturaDesdeFila({ ...base, ESTADO_PAGO: 'CONTABILIZADA', PORCENTAJE_PAGADO: '' }, 'Facturas_Aprobadas', 300)
check('historial sin porcentaje: pagada', r.ok && r.dato.estado === 'PAGADA')
r = facturaDesdeFila({ ...base, ESTADO_XUBIO: 'SUBIDO', XUBIO_ID_FACTURA: 95139854 }, 'Facturas', 2)
check('subida a Xubio con su id', r.ok && r.dato.estado_xubio === 'SUBIDA' && r.dato.xubio_id === '95139854')
r = facturaDesdeFila({ ...base, ESTADO_XUBIO: 'YA EXISTE EN XUBIO (no se volvió a subir)' }, 'Facturas', 2)
check('"YA EXISTE EN XUBIO" cuenta como subida', r.ok && r.dato.estado_xubio === 'SUBIDA')
r = facturaDesdeFila({ ...base, RECEPTOR: 'ROBLES DANIEL HECTOR', ESTADO_XUBIO: 'SIN_ERP_XUBIO' }, 'Facturas', 2)
check('Héctor Robles sin contabilizar en producción: pendiente en el sector Ralpharma', r.ok && r.dato.empresa_id === 'hrobles' && r.dato.estado_xubio === 'PENDIENTE_RALPHARMA')
r = facturaDesdeFila({ ...base, RECEPTOR: 'ROBLES DANIEL HECTOR', ESTADO_XUBIO: 'SIN_ERP_XUBIO', ESTADO_PAGO: 'CONTABILIZADA' }, 'Facturas', 2)
check('Robles CONTABILIZADA en producción: ya cargada en Ralpharma (no infla la bandeja)', r.ok && r.dato.estado_xubio === 'CARGADA_RALPHARMA')
r = facturaDesdeFila({ ...base, RECEPTOR: 'DROGUERIA ROBLES SA', ESTADO_XUBIO: 'SIN_ERP_XUBIO' }, 'Facturas_Aprobadas', 9)
check('Robles en el historial: ya cargada en Ralpharma', r.ok && r.dato.estado_xubio === 'CARGADA_RALPHARMA')
r = facturaDesdeFila({ ...base, TIPO: 'Nota de Crédito A', SALDO_NC: 100000, TOTAL: 300000 }, 'Facturas', 2)
check('nota de crédito aprobada: no se paga, conserva su saldo', r.ok && r.dato.estado === 'PAGADA' && r.dato.saldo_nc === 100000)
r = facturaDesdeFila({ ...base, PERCEPCIONES_JSON: '[{"importe":3000},{"importe":"1500"}]' }, 'Facturas', 2)
check('percepciones sumadas desde PERCEPCIONES_JSON', r.ok && r.dato.percepciones === 4500)
// Fila 24 de la hoja real: alquiler sin tipo, aprobado y pagado, que Xubio omitió
r = facturaDesdeFila({ ...base, RECEPTOR: 'INDIA ADV S.A.', CUIT_PROVEEDOR: 30710100337, TIPO: '', LETRA: 'OTRA', NUMERO: '00001-003336', ESTADO_VALIDACION: 'ERROR',
  MOTIVO_VALIDACION: 'Comprobante sin TIPO válido. No se carga como factura de compra.', ESTADO_XUBIO: "OMITIDA: TIPO '' no válido" }, 'Facturas', 24)
check('sin tipo pero con CUIT y número: entra como "Sin tipo" con la validación en error', r.ok && r.dato.tipo === 'Sin tipo' && r.dato.validacion_ok === false && r.dato.estado === 'PAGADA' && r.dato.estado_xubio === 'ERROR')
check('CUIT que viene como número de la planilla', r.ok && r.dato.cuit_proveedor === '30710100337')
r = facturaDesdeFila({ ...base, RECEPTOR: 'SORAIRES SANTACRUZ MARIA CRISTINA' }, 'Facturas', 2)
check('receptor desconocido: se omite con motivo', !r.ok && r.motivo.includes('Receptor'))
r = facturaDesdeFila({ ...base, CUIT_PROVEEDOR: '20-1704' }, 'Facturas', 2)
check('CUIT incompleto: se omite', !r.ok && r.motivo.includes('CUIT'))

// --- Pagos: filas reales de la pestaña Pagos
const pagoSinFactura = {
  _fila: 2, ID_PAGO: 'PAGO-1787959267128', TIPO_PAGO: 'SIN_FACTURA', FACTURA_ASOCIADA: '', PROVEEDOR_DESTINO: 'BERATUNG S.A.', DESCRIPCION_PAGO: 'Varios',
  REALIZADO_POR: 'INDIA ADV SA', BANCO_ORIGEN: 'Banco Hipotecario', NUMERO_CUENTA: 'XXXX-0010', NUMERO_CHEQUE: '', FECHA_PAGO: '2026-08-28', IMPORTE: 800000,
  URL_COMPROBANTE: 'https://drive.google.com/file/d/1/view', ESTADO_CONTABLE: 'CONTABILIZADA', BANCO_DESTINO: 'ICBC',
}
let rp = pagoDesdeFila(pagoSinFactura, 2)
let pg = rp.ok ? rp.dato : {}
check('pago sin factura: se traduce', rp.ok)
check('pago sin factura: empresa desde REALIZADO_POR (India paga a Beratung)', pg.empresa_id === 'india')
check('pago sin factura: transferencia, salida de fondos, sin facturas', pg.medio === 'TRANSFERENCIA' && pg.forma_carga_xubio === 'SALIDA_FONDOS' && (pg.facturas as unknown[]).length === 0)
check('pago contabilizado en producción: CONTABILIZADO con respaldo', pg.estado === 'CONTABILIZADO' && !!pg.xubio_id && !!pg.contabilizado_por)
check('cargado_en sale de la hora del ID', pg.cargado_en === new Date(1787959267128).toISOString())

rp = pagoDesdeFila({ ...pagoSinFactura, ID_PAGO: 'PAGO-MULTIPLE-1789492143223-74', TIPO_PAGO: 'FACTURA', FACTURA_ASOCIADA: '00004-00000106, 0002-00000777', ESTADO_CONTABLE: 'PENDIENTE', EMPRESA: '', REALIZADO_POR: '' }, 9)
check('pago múltiple: dos facturas por punto de venta y número', rp.ok && JSON.stringify(rp.dato.facturas) === '[{"punto_venta":4,"numero":106},{"punto_venta":2,"numero":777}]')
check('pago pendiente: CARGADO, orden de pago, empresa la resuelve la base', rp.ok && rp.dato.estado === 'CARGADO' && rp.dato.forma_carga_xubio === 'ORDEN_PAGO' && rp.dato.empresa_id === null)
rp = pagoDesdeFila({ ...pagoSinFactura, TIPO_PAGO: 'FACTURA', FACTURA_ASOCIADA: 'S/N' }, 2)
check('factura "S/N" (expensas): se trata como sin factura', rp.ok && (rp.dato.facturas as unknown[]).length === 0 && rp.dato.forma_carga_xubio === 'SALIDA_FONDOS')
rp = pagoDesdeFila({ ...pagoSinFactura, NUMERO_CHEQUE: '29598', TIPO_CHEQUE: 'ECHEQ', FECHA_VTO_CHEQUE: '2026-11-18' }, 2)
check('e-cheq con fecha de cobro', rp.ok && rp.dato.medio === 'ECHEQ' && rp.dato.fecha_acreditacion === '2026-11-18')
rp = pagoDesdeFila({ ...pagoSinFactura, NUMERO_CHEQUE: '1234', TIPO_CHEQUE: 'FISICO' }, 2)
check('cheque físico', rp.ok && rp.dato.medio === 'CHEQUE')
rp = pagoDesdeFila({ ...pagoSinFactura, EMPRESA: 'Droguería Robles', ESTADO_XUBIO_PAGO: 'SIN_ERP_XUBIO', RALPHARMA_CARGADO: '' }, 2)
check('Robles contabilizado sin cargar en Ralpharma: PENDIENTE_RALPHARMA', rp.ok && rp.dato.estado === 'PENDIENTE_RALPHARMA' && rp.dato.empresa_id === 'robles')
rp = pagoDesdeFila({ ...pagoSinFactura, EMPRESA: 'Droguería Robles', ESTADO_XUBIO_PAGO: 'SIN_ERP_XUBIO', RALPHARMA_CARGADO: '2026-10-28 10:00 · guido' }, 2)
check('Robles ya cargado en Ralpharma: CONTABILIZADO', rp.ok && rp.dato.estado === 'CONTABILIZADO' && rp.dato.xubio_id === 'RALPHARMA')
rp = pagoDesdeFila({ ...pagoSinFactura, IMPORTE: '', ESTADO_CONTABLE: 'PENDIENTE', ESTADO_EXTRACCION_IA: 'ERROR_1' }, 2)
check('pago sin leer todavía: importe 0 (la base lo admite solo para copias)', rp.ok && rp.dato.importe === 0 && rp.dato.estado_extraccion === 'ERROR_1')
rp = pagoDesdeFila({ ...pagoSinFactura, ESTADO_CONTABLE: 'ANULADO' }, 2)
check('pago anulado: se omite', !rp.ok)

// --- Catálogos con los encabezados reales
const cat = catalogosDesdeHoja({
  cuentas: [{ _fila: 2, CODIGO: 'GASTOS_BANCARIOS', NOMBRE: 'GASTOS BANCARIOS', CUENTA_COMPLETA: 'GASTOS_BANCARIOS GASTOS BANCARIOS', XUBIO_ID: 977973, EMPRESA: 'Beratung S.A.' }],
  origen: [{ _fila: 2, EMPRESA: 'Beratung S.A.', TIPO_CUENTA: 2, TIPO: 'Banco', CUENTA_ID: 665247, NOMBRE: 'Banco Hipotecario CC 0319 BERATUNG', CODIGO: 'BANCO_HIPOTECARIO_CC_0319_BERATUNG', USOS_180_DIAS: 548, ULTIMO_USO: '2026-09-29' }],
  porEmpresa: [{ _fila: 2, RECEPTOR: 'YSD', CUIT: '30-50000173-5', NOMBRE_XUBIO: 'BANCO DE GALICIA Y BUENOS AIRES S A U', CUENTA_CONTABLE: '', SALTAR_XUBIO: '' },
    { _fila: 3, RECEPTOR: 'YSD', CUIT: 'pendiente', NOMBRE_XUBIO: 'X' }],
  emails: [{ _fila: 2, CUIT_PROVEEDOR: '30648586989', PROVEEDOR: 'ALCOFRAC S.A.', EMAIL: 'Sanicol@alcofrac.com.ar' }],
  productos: [{ _fila: 2, 'Columna A (Nombre)': 'ALQUILER CONSULTORIO TUCUMAN', 'Columna B (Codigo)': 'ALQUILER_CONSULTORIO_TUCUMAN' }],
})
check('plan de cuentas: nombre completo como lo usa producción', cat.cuentas[0]?.nombre === 'GASTOS_BANCARIOS GASTOS BANCARIOS' && cat.cuentas[0]?.empresa_id === 'beratung')
check('cuentas de origen: tipo de cuenta y usos', cat.origen[0]?.tipo_cuenta === 2 && cat.origen[0]?.usos === 548 && cat.origen[0]?.xubio_id === '665247')
check('proveedor por empresa: CUIT con guiones limpio', cat.porEmpresa[0]?.cuit === '30500001735' && cat.porEmpresa[0]?.empresa_id === 'ysd')
check('proveedor con CUIT inválido: queda anotado como omitido', cat.porEmpresa.length === 1 && cat.omitidas.length === 1)
check('mails en minúscula', cat.emails[0]?.email === 'sanicol@alcofrac.com.ar')
check('productos: nombre y código (no el número de fila)', cat.productos[0]?.nombre === 'ALQUILER CONSULTORIO TUCUMAN' && cat.productos[0]?.codigo === 'ALQUILER_CONSULTORIO_TUCUMAN')

check('categorías de la hoja: MEDICO es prestador médico', categoriaVertice('MEDICO') === 'PRESTADOR_MEDICO' && categoriaVertice('INSUMOS_MEDICOS') === 'INSUMOS_MEDICOS' && categoriaVertice('') === null)

// --- Pantallas con datos reales: cuentas por empresa y cuenta de origen (src/lib/cuentas.ts)
const catal = { empresas: [], proveedores: [], cuentasOrigen: [], planCuentas: ['GASTOS GENERALES'], productos: [] as string[],
  planPorEmpresa: { beratung: ['GASTOS_BANCARIOS GASTOS BANCARIOS', 'IMPUESTO_DEBCRED_BANCARIO IMPUESTO DEB/CRED BANCARIO'] } as Record<string, string[]> }
check('plan de la empresa si existe; si no, el común', cuentasPara(catal, 'beratung').length === 2 && cuentasPara(catal, 'robles')[0] === 'GASTOS GENERALES')
check('facturas: sin productos de Xubio usa el plan', cuentasFactura(catal, 'beratung').length === 2)
check('facturas: con productos de Xubio usa los productos', cuentasFactura({ ...catal, productos: ['Alquiler Oficina Exento'] }, 'beratung')[0] === 'Alquiler Oficina Exento')
check('enLista: ignora mayúsculas y tildes, devuelve como está escrita', enLista(['Alquiler Oficina Exento'], 'alquiler oficina exento') === 'Alquiler Oficina Exento')
check('enLista: texto que no está en el plan es null (regla de oro)', enLista(['GASTOS BANCARIOS'], 'GASTOS VARIOS') === null && enLista(['X'], '') === null)

const co = (nombre: string, tipoCuenta: number, usos: number, empresaId = 'beratung') => ({ id: nombre, empresaId, nombre, saldo: 0, tipoCuenta, usos })
const origenesBer = cuentasOrigenDe([
  co('BANCO HIPOTECARIO CA 5701 BERATUNG', 2, 10), co('Banco Hipotecario CC 0319 BERATUNG', 2, 548), co('E-CHECS EMITIDOS - BANCO ICBC', 4, 32),
  co('Banco ICBC CC 0867-02104552-84', 2, 31), co('CAJA', 1, 21), co('BRUBANK', 2, 6), co('E-CHEQS BRUBANK', 4, 27), co('Banco Hipotecario CA-0010', 2, 84, 'india'),
], 'beratung')
check('cuentas de origen: solo la empresa, la más usada primero', origenesBer.length === 7 && origenesBer[0].nombre.startsWith('Banco Hipotecario CC 0319'))
let so = sugerirCuentaOrigen(origenesBer, 'Banco ICBC')
check('banco con una sola cuenta bancaria: esa, sin dudas', so?.cuenta === 'Banco ICBC CC 0867-02104552-84' && so.revisar === false)
so = sugerirCuentaOrigen(origenesBer, 'Banco ICBC', { esCheque: true })
check('con cheque: la cuenta de e-cheqs de ese banco', so?.cuenta === 'E-CHECS EMITIDOS - BANCO ICBC')
so = sugerirCuentaOrigen(origenesBer, 'Banco Hipotecario', { numeroCuenta: 'XXXX-0319' })
check('dos cuentas del mismo banco: decide el N° de cuenta del comprobante', so?.cuenta === 'Banco Hipotecario CC 0319 BERATUNG' && so.revisar === false)
so = sugerirCuentaOrigen(origenesBer, 'Banco Hipotecario')
check('dos cuentas sin N° de cuenta: la más usada, marcada para revisar', so?.cuenta === 'Banco Hipotecario CC 0319 BERATUNG' && so.revisar === true)
check('efectivo → caja', sugerirCuentaOrigen(origenesBer, 'Efectivo')?.cuenta === 'CAJA')
check('banco que la empresa no tiene: sin sugerencia', sugerirCuentaOrigen(origenesBer, 'Banco Galicia') === null && sugerirCuentaOrigen(origenesBer, '') === null)

console.log(`\n${ok} OK · ${mal} MAL`)
process.exit(mal ? 1 : 0)
