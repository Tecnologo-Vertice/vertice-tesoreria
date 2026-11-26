// Planillas FICTICIAS con la misma forma que las reales (respuesta de spreadsheets.get con grid data).
// Bancos, proveedores, números e importes inventados. Sirven para probar el script sin datos reales.
const serie = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000)
const dmy = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Celda: 'texto' · 123.45 (número) · { fecha: 'AAAA-MM-DD' } · { formula: 10 } (valor calculado) · { texto, n }. */
function celda(v) {
  if (v === null || v === undefined || v === '') return {}
  if (typeof v === 'number') return { formattedValue: String(v).replace('.', ','), effectiveValue: { numberValue: v } }
  if (typeof v === 'string') return { formattedValue: v }
  if (v.fecha) return { formattedValue: dmy(v.fecha), effectiveValue: { numberValue: serie(v.fecha) } }
  if ('formula' in v) return { formattedValue: String(v.formula), effectiveValue: { numberValue: v.formula }, userEnteredValue: { formulaValue: '=X' } }
  return { formattedValue: v.texto, ...(v.n !== undefined ? { effectiveValue: { numberValue: v.n } } : {}) }
}
const hoja = (title, filas) => ({ properties: { title }, data: [{ rowData: filas.map((f) => ({ values: f.map(celda) })) }] })

const v2 = (titulo, filas) => hoja(titulo, [['Tipo', 'Código Xubio', 'Cuenta Xubio', 'Apertura', '', 'Flujo v2 (ficticio)'], [], ...filas])
const V2_COMUN = [
  ['SECCIÓN', '', '', '', '', '1. INGRESOS OPERATIVOS'],
  ['CUENTA', 'DEUDORES_POR_VENTA', 'DEUDORES POR VENTAS', '', '', '11003101 DEUDORES POR VENTAS'],
  ['SECCIÓN', '', '', '', '', '3. GASTOS OPERATIVOS'],
  ['CUENTA', 'SEGUROS', 'SEGUROS', '', '', '53001007 SEGUROS'],
  ['APERTURA', 'PROVEEDORES', 'PROVEEDORES LOCALES', 'Proveedor Ficticio', '', 'PROVEEDORES LOCALES - Proveedor Ficticio'],
  ['TOTAL', '', '', '', '', 'Total gastos'],
  ['SECCIÓN', '', '', '', '', '8. DEVOLUCIÓN DE DEUDA'],
  ['APERTURA', 'MIS_FACILIDADES', 'MIS FACILIDADES', 'PFP X000001', '', 'PFP X000001 $1.000 dsd 10-2026 (12 cuotas)'],
  ['MEMO', '', '', '', '', 'Nota'],
  ['SALDO', 'BANCO_PRUEBA', 'BANCO PRUEBA CC 1111', '', '', '11001999 BANCO PRUEBA CC 1111'],
]

export function planillasFicticias() {
  const vbi = { sheets: [
    hoja('Cuentas_Extracto', [
      ['EMPRESA', 'BANCO_CASHFLOW', 'SUBCUENTA', 'TIPO', 'FILA EN EL FLUJO ORIGINAL', 'NOTA'],
      ['INDIA ADV', 'PRUEBA', 'PRUEBA CC 1111', 'BASE', '11001999 BANCO PRUEBA CC 1111'],
      ['INDIA ADV', 'PRUEBA', 'PRUEBA FCI', 'FCI', '11002102 FCI - Prueba'],
      ['INDIA ADV', 'MP', 'MERCADO PAGO', 'BASE', '11001410 Mercado Pago'],
      ['BERATUNG/DAX', 'PRUEBA', 'PRUEBA CC 2222', 'BASE', 'Banco Prueba 2222'],
      ['HECTOR ROBLES', 'PRUEBA', 'PRUEBA [FALTA: 1 o 2]', 'BASE', ''],
      ['', '', '', '', '', 'nota sin empresa'],
    ]),
    hoja('Extractos_Reglas', [
      ['ORDEN', 'CONTIENE', 'SOLO', 'CATEGORIA', 'CUENTA_CONTABLE', 'NOTA'],
      ['10', 'LEY 25413|IMP DEB', 'AMBOS', 'IMPUESTO', 'IMPUESTO_DEBCRED_BANCARIO IMPUESTO DEB/CRED BANCARIO', 'igual a 0024'],
      ['91', 'PATRON FICTICIO', 'DEBITO', 'GASTO_BANCARIO', 'GASTOS_BANCARIOS GASTOS BANCARIOS', 'nueva'],
    ]),
    hoja('Extractos_Movimientos', [
      ['ID', 'FECHA', 'EMPRESA', 'BANCO', 'DESCRIPCION', 'REFERENCIA', 'DEBITO', 'CREDITO', 'SALDO', 'CATEGORIA', 'CUENTA_CONTABLE', 'REGLA', 'NUMERO_CHEQUE', 'CHEQUE_CASHFLOW', 'ESTADO', 'REVISADO_POR', 'ARCHIVO', 'IMPORTADO'],
      ['EXT-viejo', '2026-10-30', 'INDIA ADV', 'PRUEBA', 'ANTES DEL CORTE', '', 10, '', 990, 'SIN_CLASIFICAR', '', '', '', '', 'INFORMATIVO'],
      ['EXT-a1', '2026-11-02', 'INDIA ADV', 'PRUEBA', 'TRANSFERENCIA RECIBIDA', 'R1', '', 1000, 1990, 'SIN_CLASIFICAR', '', '', '', '', 'INFORMATIVO'],
      ['EXT-a2', '2026-11-02', 'INDIA ADV', 'PRUEBA', 'IMP DEB LEY 25413', 'R2', 6, '', 1984, 'IMPUESTO', 'IMPUESTO_DEBCRED_BANCARIO IMPUESTO DEB/CRED BANCARIO', '', '', '', 'A_REVISAR'],
      ['EXT-a3', '2026-11-02', 'INDIA ADV', 'PRUEBA', 'IMP DEB LEY 25413', 'R2', 6, '', 1978, 'IMPUESTO', 'IMPUESTO_DEBCRED_BANCARIO IMPUESTO DEB/CRED BANCARIO', '', '', '', 'CONTABILIZADO · asiento 1'],
      ['EXT-a4', '2026-11-03', 'INDIA ADV', 'NO EXISTE', 'SIN CUENTA', '', 1, '', '', 'SIN_CLASIFICAR', '', '', '', '', 'A_REVISAR'],
    ]),
    hoja('Conciliacion_Diaria', [
      ['FECHA', 'EMPRESA', 'BANCO', 'SALDO_INICIAL', 'CREDITOS', 'DEBITOS', 'SALDO_CALCULADO', 'SALDO_EXTRACTO', 'DIFERENCIA', 'SALDO_FLUJO', 'DIF_FLUJO', 'MOVIMIENTOS', 'CHEQUES_PAGADOS', 'SIN_CLASIFICAR', 'ESTADO', 'ACTUALIZADO'],
      ['2026-10-30', 'INDIA ADV', 'PRUEBA', '', '', '', '', 990, '', '', '', '', '', '', 'OK'],
      ['2026-11-02', 'INDIA ADV', 'PRUEBA', 990, 1000, 12, 1978, 1978, 0, '', '', 3, 0, 1, 'OK'],
      ['11/20/2026', 'INDIA ADV', 'PRUEBA', 1978, 0, 0, 1978, 1978, 0, '', '', 0, 0, 0, 'SIN MOVIMIENTOS'],
      ['11/20/2026', 'INDIA ADV S.A.', 'PRUEBA FCI', '', 0, 0, '', 5000.5, '', '', '', 0, '', '', 'EXTRACTO'],
      ['11/20/2026', 'INDIA ADV', 'PRUEBA FCI', '', 0, 0, '', 5001.5, '', '', '', 0, '', '', 'EXTRACTO'],
    ]),
    hoja('Proyecciones', [['ID', 'EMPRESA', 'FILA_FLUJO', 'CONCEPTO', 'PROVEEDOR', 'IMPORTE', 'FECHA', 'RECURRENCIA', 'HASTA', 'VECES', 'AJUSTE_PCT_MENSUAL', 'ESTADO']]),
    hoja('Flujo_Cambios_Manuales', [
      ['FECHA_CAMBIO', 'USUARIO', 'EMPRESA', 'FILA', 'CUENTA', 'DIA', 'ACCION', 'ANTES', 'DESPUES', 'MOTIVO'],
      ['25/11/2026 10:00', 'teso@prueba.com', 'India', '9', 'PROVEEDORES LOCALES - Proveedor Ficticio', '2026-12-10', 'ELIMINAR', 300, 0, 'ya llegó la factura'],
      ['25/11/2026 10:05', 'teso@prueba.com', 'India', '9', 'PROVEEDORES LOCALES - Proveedor Ficticio', '2026-12-15', 'EDITAR', 999, 1, 'antes no coincide'],
    ]),
    hoja('Cobros_Xubio', [
      ['EMPRESA', 'FECHA', 'RECIBO', 'TRANSACCION_ID', 'INSTRUMENTO_ID', 'CLIENTE_ID', 'CLIENTE', 'CUENTA', 'CUENTA_CODIGO', 'IMPORTE', 'DESCRIPCION', 'OBSERVACION', 'IMPORTADO'],
      ['INDIA ADV S.A.', '2026-11-18', 'X-0001-00000001', '111', '111', '1', 'CLIENTE FICTICIO SA', 'Banco Prueba CC 1111', 'BANCO_PRUEBA', 1500.25, '', 'TRANSFERENCIA'],
    ]),
    hoja('Robot_Echeqs_Log', [
      ['FECHA', 'MODO', 'EMPRESA', 'CHEQUE', 'PROVEEDOR', 'IMPORTE', 'FILAS_PAGOS', 'ESTADO', 'NUMERO_OP', 'DETALLE'],
      ['2026-11-18 12:42', 'prueba', 'India ADV S.A.', '900001', 'Proveedor Ficticio', 100, '5', 'PRUEBA_OK', '', 'prueba'],
      ['2026-11-25 12:43', '', '', '', '', '', '', 'SESION_VENCIDA', '', ''],
      ['2026-11-25 12:43', '', '', '', '', '', '', 'FIN_CON_ERROR', '', ''],
    ]),
    hoja('Catalogo_Percepciones_IIBB', [['Nombre', 'Codigo'], ['Ingresos Brutos Ficticia (Percepción)', 'IIBB_FICTICIA']]),
  ] }

  const motor = { sheets: [
    hoja('Cuentas Bancarias', [
      ['PATRON', 'PESTANA', 'FILA_SALDO', 'CUENTA_XUBIO', 'NOTA', 'EMPRESA'],
      ['PRUEBA FCI', 'India', '11002102 FCI - Prueba', 'Fondos Comun de Inversion Bancos', '', 'INDIA'],
      ['PRUEBA', 'India', '11001999 BANCO PRUEBA CC 1111', 'Banco Prueba CC 1111', '', 'INDIA'],
      ['MERCADO PAGO', 'India', '11001410 Mercado Pago', 'Mercado pago', '', 'INDIA'],
      ['PRUEBA', 'Dax Salud', 'Banco Prueba 2222', 'Banco Prueba 2222 BERATUNG'],
    ]),
    hoja('Gastos Fijos', [
      ['ACTIVO', 'PESTANA', 'FILA', 'IMPORTE', 'DIA_DEL_MES', 'DESDE', 'HASTA', 'NOTA'],
      ['SI', 'India', '53001007 SEGUROS', 1000.5, 10, { fecha: '2026-11-20' }, '', 'ficticio'],
      ['SI', 'India', 'PFP X000001 $1.000 dsd 10-2026 (12 cuotas)', 1000, 30, { fecha: '2026-11-20' }, '', 'plan'],
      ['NO', 'India', '53001007 SEGUROS', 5, 1, { fecha: '2026-11-20' }, '', 'inactivo'],
      ['SI', 'India', 'FILA QUE NO EXISTE', 77, 5, { fecha: '2026-11-20' }, '', 'a reubicar'],
    ]),
    hoja('Mapa Flujo', [
      ['TIPO', 'EMPRESA', 'VALOR', 'PESTANA', 'FILA', 'NOTA'],
      ['BANCO', 'India', 'PRUEBA', 'India'],
      ['PROVEEDOR', 'India', 'ASEGURADORA FICTICIA', 'India', '53001007 SEGUROS'],
      ['CUENTA', 'India', 'IMPUESTO DEB/CRED BANCARIO', '(banco)', '55001005 IMPUESTO'],
      ['CUENTA', 'India', 'CUENTA SIN FILA', 'India', 'NO EXISTE'],
      ['FERIADO', '', { fecha: '2026-12-08' }],
    ]),
    hoja('Llave Flujo v2', [
      ['FECHA', 'TIPO', 'PESTANA', 'ID', 'IMPORTE', 'PROVEEDOR', 'CODIGO_XUBIO', 'APERTURA', 'FILA_V2', 'ORIGEN', 'PRODUCTO', 'NOTA'],
      ['01/11/2026', 'REAL', 'India', 'PAGO-1', 100, 'Proveedor Ficticio SRL', 'PROVEEDORES', '', '7', 'Regla del estudio'],
      ['02/11/2026', 'REAL', 'India', 'PAGO-2', 200, 'Proveedor Ficticio SRL', 'PROVEEDORES', '', '7', 'Regla del estudio'],
      ['02/11/2026', 'REAL', 'India', 'PAGO-3', 50, 'INDIA ADV SA', 'EXCLUIDO', '', '', 'Transferencia propia'],
      ['02/11/2026', 'REAL', 'India', 'PAGO-4', 50, 'Otro', 'SEGUROS', '', '6', 'Producto de la factura'],
    ]),
    hoja('Saldos Xubio Historial', [
      ['FECHA_LECTURA', 'HORA', 'EMPRESA', 'CUENTA_XUBIO', 'SALDO', 'LEIDO_DE', 'NOTA'],
      [{ fecha: '2026-11-20' }, { texto: '17:19', n: 0.7215277777777778 }, 'INDIA ADV S.A.', 'Banco Prueba CC 1111', { texto: '1.978,00', n: 1978 }, 'Xubio · Finanzas › Fondos'],
      [{ fecha: '2026-11-20' }, { texto: '17:19', n: 0.7215277777777778 }, 'INDIA ADV S.A.', 'Fondos Comun de Inversion Bancos', 5000, 'Xubio · Finanzas › Fondos'],
      [{ fecha: '2026-11-20' }, { texto: '17:19', n: 0.7215277777777778 }, 'INDIA ADV S.A.', 'TOTAL INDIA ADV', 6978, 'Xubio · Finanzas › Fondos'],
    ]),
    hoja('Bancos Movimientos', [
      ['FECHA', 'PESTANA', 'BANCO', 'CUENTA', 'CONCEPTO', 'IMPORTE', 'SALDO', 'TIPO', 'CODIGO_XUBIO', 'APERTURA', 'ORIGEN'],
      ['02/11/2026', 'India', 'Prueba', 'Prueba CC 1111', 'Transferencia', 1000, 1990, 'OTRO'],
      ['03/11/2026', 'India', 'Mercado Pago', 'Mercado Pago', 'Rendimiento', 2.5, 102.5, 'FCI'],
    ]),
    v2('Beratung S/Dax v2', V2_COMUN), v2('Dax Salud v2', V2_COMUN), v2('India v2', V2_COMUN), v2('Vertice v2', V2_COMUN),
  ] }

  const fechas = ['2026-11-24', '2026-11-25', '2026-12-10', '2026-12-15', '2026-12-30']
  const original = (titulo, conValores) => hoja(titulo, [
    ['6'],
    ['', 'Cuenta', 'Concepto', ...fechas.map((f) => ({ fecha: f }))],
    ['', '', '1. INGRESOS OPERATIVOS', { formula: 0 }, { formula: 0 }, { formula: 0 }, { formula: 0 }, { formula: 0 }],
    ['', '11003101', 'DEUDORES POR VENTAS', '', '', conValores ? 5000 : '', '', ''],
    ['', '', '3. GASTOS OPERATIVOS'],
    ['', '53001007', 'SEGUROS', '', '', conValores ? 1000.5 : '', '', ''],
    ['', '', 'PROVEEDORES LOCALES - Proveedor Ficticio', conValores ? 40 : '', '', conValores ? 300 : '', conValores ? 500 : '', ''],
    ['', '', '8. DEVOLUCIÓN DE DEUDA'],
    ['', '', 'PFP X000001 $1.000 dsd 10-2026 (12 cuotas)', '', '', '', '', conValores ? 1000 : ''],
    ['', '', 'PFP X000002 $50 CANCELADO', '', '', '', conValores ? 50 : '', ''],
    ['', '', 'VARIACIÓN DE CAJA', { formula: 1 }],
    ['', '', 'Caja Acumulada', { formula: 1 }],
    ['', '11001999', 'BANCO PRUEBA CC 1111', conValores ? 1970 : '', conValores ? 1978 : '', '', '', ''],
    ['', '', 'Conciliación Bancaria', { formula: 0 }],
  ])
  const orig = { sheets: [original('Beratung S/Dax', false), original('Dax Salud', false), original('India', true), original('Vertice', false)] }

  const cashflow = { sheets: [
    hoja('CHEQUES EMITIDOS', [
      ['EMISIÓN', 'DEPÓSITO', 'COBRO', 'EMPRESA', 'BANCO', 'NÚMERO', 'TIPO', 'Categoría', 'ACREEDORES', 'IMPORTE', 'SEMANA', 'ESTADO', 'OBSERVACIONES'],
      [{ fecha: '2026-11-01' }, { fecha: '2026-12-01' }, { fecha: '2026-12-02' }, 'INDIA ADV', 'PRUEBA', 777, 'ECHEQ', 'P', 'PROVEEDOR FICTICIO SRL', { texto: '$1.234.567', n: 1234567.89 }, '', 'Pendiente', ''],
      [{ fecha: '2026-11-01' }, { fecha: '2026-12-01' }, { fecha: '2026-12-02' }, 'INDIA ADV', 'GALICIA', 778, 'ECHEQ', 'F', 'FINANCIERA FICTICIA', 5000, '', 'Pendiente', ''],
      [{ fecha: '2026-10-01' }, { fecha: '2026-10-02' }, { fecha: '2026-10-03' }, 'INDIA ADV', 'PRUEBA', 700, 'ECHEQ', 'P', 'PROVEEDOR FICTICIO SRL', 99, '', 'Pagado', ''],
      [{ fecha: '2026-10-01' }, { fecha: '2026-10-02' }, { fecha: '2026-10-03' }, 'INDIA ADV', 'PRUEBA', 701, 'ECHEQ', 'P', 'PROVEEDOR FICTICIO SRL', 88, '', 'Vencido', ''],
    ]),
    hoja('Categoría', [['X'], ['', '', 'Proveedor', 'Categoría'], ['', '', 'PROVEEDOR FICTICIO SRL', 'P'], ['', '', 'Proveedor ficticio srl', 'P']]),
  ] }

  return { vbi, motor, original: orig, cashflow }
}
