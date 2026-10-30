// Espejo de la hoja real "Facturas automatizadas" → base del sistema nuevo.
// El Apps Script puente (gas/PuenteHojas.gs) manda las filas tal cual (encabezado → valor); acá se
// traducen al modelo de la base con las mismas reglas que usa el Apps Script de producción.
// Funciones puras: se prueban con netlify/pruebas/espejo.prueba.mts sin tocar la hoja.

import { createHash } from 'node:crypto'

export type FilaHoja = Record<string, unknown>
export type Resultado<T> = { ok: true; dato: T } | { ok: false; motivo: string }

const EMPRESAS_SIN_XUBIO = ['robles', 'hrobles', 'farmacontrol']

/** Texto comparable: minúsculas, sin tildes ni símbolos (igual que normalizarTexto_ del Apps Script). */
export function normalizar(t: unknown): string {
  return String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Empresa del sistema a partir de cómo la escribió la IA o la persona ("BERATUNG SA", "D ROBLES DANIEL HECTOR").
 * Misma lógica que normalizarReceptorCanonico_, más "ROBLES, DANIEL HECT" que la IA corta a veces.
 */
export function empresaDesdeTexto(t: unknown): string | null {
  const n = normalizar(t)
  if (!n) return null
  if (n.includes('beratung')) return 'beratung'
  if (n.includes('india')) return 'india'
  if (n.includes('controlb')) return 'controlb'
  if (n.includes('ysd')) return 'ysd'
  if (n.includes('drogueria') && n.includes('robles')) return 'robles'
  if (n.includes('robles') && (n.includes('hector') || n.includes('daniel'))) return 'hrobles'
  if (n.includes('farmacontrol')) return 'farmacontrol'
  if (n.includes('vertice')) return 'vertice'
  return null
}

/** Importe: número tal cual; texto "1.234,56", "526,700.00", "$ -1.000" o "(1.234,56)". 0 si no se entiende. */
export function importe(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  let s = String(v ?? '').trim()
  if (!s) return 0
  const negativo = /^\(.*\)$/.test(s) || /^-|^\$\s*-/.test(s)
  s = s.replace(/[^\d.,]/g, '')
  if (!s) return 0
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.')
  if (coma !== -1 && punto !== -1) s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  else if (coma !== -1) s = s.split(',').length === 2 && s.split(',')[1].length !== 3 ? s.replace(',', '.') : s.replace(/,/g, '')
  else if (punto !== -1 && (s.split('.').length > 2 || s.split('.')[1].length === 3)) s = s.replace(/\./g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? (negativo ? -n : n) : 0
}

const redondear = (n: number) => Math.round(n * 100) / 100

/**
 * Fecha de una celda con formato de fecha, como la manda el puente: número de serie de la planilla
 * (días desde el 30/12/1899, la fracción es la hora). Así no importa si la celda muestra 2026-10-09
 * o 10/9/2026 (Facturas_Aprobadas tiene formato de EE.UU.). Devuelve "aaaa-mm-ddTHH:MM" en hora local.
 */
function desdeSerial(v: number): string | null {
  if (!(v > 20000 && v < 80000)) return null
  return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 16)
}

/** Fecha ISO (aaaa-mm-dd) desde número de serie, aaaa-mm-dd[...] o dd/mm/aaaa (texto escrito por producción). null si no hay fecha válida. */
export function fecha(v: unknown): string | null {
  if (typeof v === 'number') return desdeSerial(v)?.slice(0, 10) ?? null
  const s = String(v ?? '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) {
    const anio = m[3].length === 2 ? '20' + m[3] : m[3]
    if (+m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) return null
    return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return null
}

/** Fecha y hora de la hoja ("2026-10-28 14:05", hora de Buenos Aires) como timestamp con zona. */
export function fechaHora(v: unknown): string | null {
  if (typeof v === 'number') {
    const d = desdeSerial(v)
    return d ? `${d}:00-03:00` : null
  }
  const s = String(v ?? '').trim()
  const d = fecha(s)
  if (!d) return null
  const h = s.match(/[ T](\d{1,2}):(\d{2})/)
  return `${d}T${h ? h[1].padStart(2, '0') + ':' + h[2] : '12:00'}:00-03:00`
}

/** Porcentaje pagado, de 0 a 100 como lo escribe producción (setValue(porcFinal)): 100, "100%", "50,5". null si está vacío. */
export function porcentaje(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null
  return importe(v)
}

/** "00004-00000106", "A-0004-00000106", "4-106" → { puntoVenta: 4, numero: 106 }. */
export function numeroComprobante(v: unknown): { puntoVenta: number; numero: number } | null {
  const grupos = String(v ?? '').match(/\d+/g)
  if (!grupos || grupos.length === 0) return null
  const numero = parseInt(grupos[grupos.length - 1], 10)
  const puntoVenta = grupos.length >= 2 ? parseInt(grupos[grupos.length - 2], 10) : 0
  return Number.isFinite(numero) && numero > 0 ? { puntoVenta, numero } : null
}

/** Medio de pago del sistema a partir del texto de la hoja ("Tarjeta de Crédito", "E-cheq", "Efectivo"). */
export function metodoPago(v: unknown): string | null {
  const n = normalizar(v)
  if (!n) return null
  if (n.includes('echeq') || n.includes('echeck') || n.includes('echq')) return 'ECHEQ'
  if (n.includes('cheq') || n.includes('check')) return 'CHEQUE'
  if (n.includes('tarjeta') || n.includes('credito')) return 'TARJETA'
  if (n.includes('debito')) return 'DEBITO'
  if (n.includes('efectivo') || n.includes('caja')) return 'CAJA'
  if (n.includes('transf')) return 'TRANSFERENCIA'
  return null
}

const texto = (v: unknown) => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}
const json = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v
  try {
    const r = JSON.parse(String(v ?? '') || '[]')
    return Array.isArray(r) ? r : []
  } catch {
    return []
  }
}
/** Categoría Vértice de la hoja (filtros del dashboard de producción) → la del sistema. */
export function categoriaVertice(v: unknown): string | null {
  const n = normalizar(v)
  if (!n) return null
  if (n.includes('medic') && !n.includes('insumo')) return 'PRESTADOR_MEDICO'
  if (n.includes('insumo')) return 'INSUMOS_MEDICOS'
  if (n.includes('financ')) return 'FINANCIERA'
  if (n.includes('impuesto') || n.includes('servicio')) return 'IMPUESTOS_SERVICIOS'
  return 'PROVEEDOR'
}

const huella = (o: unknown) => createHash('md5').update(JSON.stringify(o)).digest('hex')
const esNotaDeCredito = (tipo: unknown) => /nota de cr[eé]dito/i.test(String(tipo ?? ''))

// ---------------------------------------------------------------- Facturas

export type HojaFacturas = 'Facturas' | 'Facturas_Aprobadas'

/**
 * Una fila de "Facturas" o "Facturas_Aprobadas" → factura de la base (claves = columnas de la tabla facturas).
 * Estados, igual que el dashboard de producción:
 *  - ESTADO_APROBACION PENDIENTE_APROBACION → PENDIENTE_APROBACION, o ERROR si la validación falló.
 *  - APROBADA → según lo pagado (PORCENTAJE_PAGADO): PARA_PAGAR, PAGADA_PARCIAL o PAGADA.
 *  - Facturas_Aprobadas → contabilizadas: pagadas salvo que el porcentaje diga otra cosa.
 *  - Nota de crédito aprobada → PAGADA (no se paga; su saldo va en saldo_nc).
 */
export function facturaDesdeFila(f: FilaHoja, hoja: HojaFacturas, fila: number): Resultado<Record<string, unknown>> {
  const empresa = empresaDesdeTexto(f.RECEPTOR)
  if (!empresa) return { ok: false, motivo: `Receptor no reconocido: "${String(f.RECEPTOR ?? '')}"` }
  const cuit = String(f.CUIT_PROVEEDOR ?? '').replace(/\D/g, '')
  if (cuit.length !== 11) return { ok: false, motivo: `CUIT de proveedor inválido: "${String(f.CUIT_PROVEEDOR ?? '')}"` }
  const nro = numeroComprobante(f.NUMERO)
  if (!nro) return { ok: false, motivo: `Número de comprobante ilegible: "${String(f.NUMERO ?? '')}"` }
  const fechaEmision = fecha(f.FECHA)
  if (!fechaEmision) return { ok: false, motivo: `Sin fecha de emisión` }
  // Sin tipo (la IA no lo reconoció): producción la guarda igual con "Comprobante sin TIPO válido" y el
  // equipo la aprueba y la paga. Entra como "Sin tipo", con la validación en error, para que se vea.
  const tipo = texto(f.TIPO) ?? 'Sin tipo'

  const total = redondear(Math.abs(importe(f.TOTAL)))
  const nc = esNotaDeCredito(tipo)
  // "APROBADA" (ojo: "PENDIENTE_APROBACION" también contiene "aprob").
  const aprobada = hoja === 'Facturas_Aprobadas' || normalizar(f.ESTADO_APROBACION).startsWith('aprobad')
  const validacionOk = !normalizar(f.ESTADO_VALIDACION).includes('error')
  const estadoPago = normalizar(f.ESTADO_PAGO)

  let estado: string
  let pagado = 0
  if (!aprobada) {
    estado = validacionOk ? 'PENDIENTE_APROBACION' : 'ERROR'
  } else if (nc) {
    estado = 'PAGADA'
    pagado = total
  } else {
    const pagadaSegunHoja = hoja === 'Facturas_Aprobadas' || ['pagada', 'contabilizada', 'nocontabilizada'].includes(estadoPago)
    const pct = porcentaje(f.PORCENTAJE_PAGADO) ?? (pagadaSegunHoja ? 100 : 0)
    pagado = redondear(Math.min(total, (total * Math.max(0, pct)) / 100))
    if (pagadaSegunHoja && pct >= 99.99) pagado = total
    estado = pagado >= total && total > 0 ? 'PAGADA' : pagado > 0 ? 'PAGADA_PARCIAL' : 'PARA_PAGAR'
  }

  // Xubio: SUBIDO / YA EXISTE → SUBIDA; error u OMITIDA → ERROR con el motivo; empresas sin Xubio → Ralpharma.
  const x = String(f.ESTADO_XUBIO ?? '').trim()
  const xn = normalizar(x)
  let estadoXubio = 'PENDIENTE'
  let xubioError: string | null = null
  if (EMPRESAS_SIN_XUBIO.includes(empresa)) estadoXubio = 'PENDIENTE_RALPHARMA'
  else if (xn.startsWith('subido') || xn.includes('yaexiste')) estadoXubio = 'SUBIDA'
  else if (xn.includes('sinerp')) estadoXubio = 'SIN_ERP'
  else if (xn.includes('error') || xn.startsWith('omitida')) {
    estadoXubio = 'ERROR'
    xubioError = x
  }
  if (!xubioError && normalizar(f.ESTADO_PAGO) === 'nocontabilizada') xubioError = texto(f.MOTIVO_NO_CONTABILIZADA)

  const percepcionesJson = json(f.PERCEPCIONES_JSON) as { importe?: unknown }[]
  const percepciones = redondear(percepcionesJson.reduce((a, p) => a + importe(p?.importe), 0))
  const xubioId = String(f.XUBIO_ID_FACTURA ?? '').replace(/\D/g, '')
  const vinculado = String(f.COMPROBANTE_VINCULADO ?? '').trim()

  const dato: Record<string, unknown> = {
    empresa_id: empresa,
    cuit_proveedor: cuit,
    proveedor: texto(f.PROVEEDOR) ?? 'Sin nombre',
    tipo,
    letra: texto(f.LETRA)?.slice(0, 1).toUpperCase() ?? null,
    punto_venta: nro.puntoVenta,
    numero: nro.numero,
    fecha: fechaEmision,
    vencimiento: fecha(f.VENCIMIENTODELPAGO) ?? fechaEmision,
    moneda: texto(f.MONEDA) ?? 'ARS',
    cotizacion: importe(f.COTIZACION) || 1,
    neto: redondear(Math.abs(importe(f.IMPORTE))),
    iva: redondear(Math.abs(importe(f.IVA))),
    exento: redondear(Math.abs(importe(f.NETO_NO_GRAVADO_EXENTO))),
    percepciones,
    percepciones_json: percepcionesJson,
    total,
    cae: texto(f.CAE),
    cae_vencimiento: fecha(f.CAE_VENCIMIENTO),
    origen: 'GMAIL',
    drive_url: texto(f.DRIVE_URL),
    estado,
    estado_xubio: estadoXubio,
    xubio_id: xubioId || null,
    xubio_error: xubioError,
    validacion_ok: validacionOk,
    motivo_validacion: texto(f.MOTIVO_VALIDACION),
    categoria_vertice: categoriaVertice(f.CATEGORIA_VERTICE),
    cuenta_contable: texto(f.CATEGORIA_CONTABLE),
    codigo_producto: texto(f.CODIGO_PRODUCTO),
    metodo_pago: metodoPago(f.METODO_PAGO),
    pagado,
    saldo_nc: nc ? redondear(f.SALDO_NC === '' || f.SALDO_NC == null ? total : Math.abs(importe(f.SALDO_NC))) : 0,
    comprobante_vinculado: vinculado && vinculado !== '0' ? vinculado : null,
    tipo_pago: texto(f.TIPO_PAGO),
    fecha_pago: fecha(f.FECHA_PAGO),
    mail_enviado: texto(f.MAIL_ENVIADO_FECHA),
    comprobantes_pago: json(f.URLS_COMPROBANTE_PAGO_JSON),
    nc_aplicadas: json(f.NC_APLICADAS_JSON),
    hoja,
    sheets_fila_origen: fila,
  }
  // La huella no incluye la fila: si la hoja se reordena (una factura pasa al historial), no cuenta como cambio.
  const { sheets_fila_origen: _f, hoja: _h, ...contenido } = dato
  dato.hoja_hash = huella(contenido)
  return { ok: true, dato }
}

// ---------------------------------------------------------------- Pagos

/**
 * Una fila de "Pagos" → pago de la base. La empresa sale de EMPRESA, si no de REALIZADO_POR; si tampoco,
 * la base la toma de la factura vinculada. Las facturas se vinculan por punto de venta y número.
 */
export function pagoDesdeFila(f: FilaHoja, fila: number): Resultado<Record<string, unknown>> {
  const id = texto(f.ID_PAGO)
  if (!id) return { ok: false, motivo: 'Sin ID_PAGO' }
  const estadoContable = normalizar(f.ESTADO_CONTABLE)
  if (/anulad|rechazad|eliminad/.test(estadoContable)) return { ok: false, motivo: `Pago ${estadoContable}` }

  const ms = String(id).match(/\d{13}/)
  const cargadoEn = ms ? new Date(parseInt(ms[0], 10)).toISOString() : null
  const fechaPago = fecha(f.FECHA_PAGO) ?? (cargadoEn ? cargadoEn.slice(0, 10) : null)
  if (!fechaPago) return { ok: false, motivo: 'Sin fecha de pago' }

  const tipoPago = texto(f.TIPO_PAGO) ?? 'SIN_FACTURA'
  const asociada = String(f.FACTURA_ASOCIADA ?? '').trim()
  const sinFactura = tipoPago === 'SIN_FACTURA' || ['', 'sn', 'sd'].includes(normalizar(asociada))
  const facturas = sinFactura
    ? []
    : asociada
        .split(/[,;]/)
        .map((p) => numeroComprobante(p))
        .filter((x): x is { puntoVenta: number; numero: number } => !!x)
        .map((x) => ({ punto_venta: x.puntoVenta, numero: x.numero }))

  const numeroCheque = texto(f.NUMERO_CHEQUE)
  const tipoCheque = normalizar(f.TIPO_CHEQUE)
  const bancoOrigen = texto(f.BANCO_ORIGEN)
  const pista = `${String(f.DESCRIPCION_PAGO ?? '')} ${String(f.OBSERVACIONES_TESORERIA ?? '')}`
  const medio = numeroCheque
    ? tipoCheque === 'fisico'
      ? 'CHEQUE'
      : 'ECHEQ'
    : /^(caja|efectivo)/.test(normalizar(bancoOrigen))
      ? 'CAJA'
      : (metodoPago(pista.match(/tarjeta|d[eé]bito|efectivo/i)?.[0]) ?? 'TRANSFERENCIA')

  const forma = String(f.FORMA_CARGA ?? '').trim().toUpperCase()
  const formaOk = ['ORDEN_PAGO', 'SALIDA_FONDOS', 'ASIENTO_MANUAL'].includes(forma) ? forma : sinFactura ? 'SALIDA_FONDOS' : 'ORDEN_PAGO'

  // Estado: PENDIENTE → CARGADO; CONTABILIZADA → CONTABILIZADO, salvo empresas sin Xubio todavía no cargadas en Ralpharma.
  const estadoXubio = texto(f.ESTADO_XUBIO_PAGO)
  const ralpharma = texto(f.RALPHARMA_CARGADO)
  let estado = 'CARGADO'
  let xubioId: string | null = texto(f.XUBIO_ID_PAGO)
  if (estadoContable === 'contabilizada') {
    if (estadoXubio === 'SIN_ERP_XUBIO' && !ralpharma) estado = 'PENDIENTE_RALPHARMA'
    else {
      estado = 'CONTABILIZADO'
      xubioId = xubioId ?? (estadoXubio === 'SIN_ERP_XUBIO' ? 'RALPHARMA' : (estadoXubio ?? 'HOJA'))
    }
  }

  const empresa = empresaDesdeTexto(f.EMPRESA) ?? empresaDesdeTexto(f.REALIZADO_POR)
  const dato: Record<string, unknown> = {
    hoja_id: id,
    empresa_id: empresa,
    facturas,
    proveedor_destino: texto(f.PROVEEDOR_DESTINO),
    fecha: fechaPago,
    importe: redondear(Math.abs(importe(f.IMPORTE))),
    medio,
    cuenta_origen: texto(f.CUENTA_ORIGEN),
    banco_origen: bancoOrigen,
    numero_cuenta: texto(f.NUMERO_CUENTA),
    banco_destino: texto(f.BANCO_DESTINO),
    numero_cheque: numeroCheque,
    fecha_acreditacion: fecha(f.FECHA_VTO_CHEQUE),
    tipo_cheque: texto(f.TIPO_CHEQUE),
    descripcion: texto(f.DESCRIPCION_PAGO),
    observaciones: texto(f.OBSERVACIONES_TESORERIA),
    cuenta_contable: texto(f.CUENTA_CONTABLE),
    sugerencia_origen: texto(f.SUGERENCIA_ORIGEN),
    sugerencia_motivo: texto(f.SUGERENCIA_MOTIVO),
    forma_carga_xubio: formaOk,
    estado,
    xubio_id: xubioId,
    estado_xubio_pago: estadoXubio,
    xubio_detalle: texto(f.XUBIO_DETALLE),
    detalle_contabilizacion: texto(f.DETALLE_CONTABILIZACION),
    contabilizado_por: estado === 'CONTABILIZADO' ? (texto(f.CONTABILIZADO_POR) ?? 'Apps Script') : texto(f.CONTABILIZADO_POR),
    contabilizado_en: fechaHora(f.FECHA_CONTABILIZACION),
    cargado_por: texto(f.CARGADO_POR) ?? 'Apps Script',
    cargado_en: cargadoEn,
    comprobante_url: texto(f.URL_COMPROBANTE) ?? texto(f.DRIVE_URL_ORIGEN),
    tipo_pago: tipoPago,
    factura_asociada: asociada || null,
    realizado_por: texto(f.REALIZADO_POR),
    estado_extraccion: texto(f.ESTADO_EXTRACCION_IA),
    aviso_importe: texto(f.AVISO_IMPORTE),
    cheque_cashflow: texto(f.CHEQUE_CASHFLOW),
    ralpharma_cargado: ralpharma,
    sheets_fila_origen: fila,
  }
  const { sheets_fila_origen: _f, ...contenido } = dato
  dato.hoja_hash = huella(contenido)
  return { ok: true, dato }
}

// ---------------------------------------------------------------- Catálogos

export interface CatalogosHoja {
  cuentas?: FilaHoja[] // Catalogo_Cuentas_Contables: CODIGO, NOMBRE, CUENTA_COMPLETA, XUBIO_ID, EMPRESA
  origen?: FilaHoja[] // Xubio_Cuentas_Origen: EMPRESA, TIPO_CUENTA, CUENTA_ID, NOMBRE, CODIGO, USOS_180_DIAS, ULTIMO_USO
  porEmpresa?: FilaHoja[] // Catalogo_Proveedores_Por_Empresa: RECEPTOR, CUIT, NOMBRE_XUBIO, CUENTA_CONTABLE, SALTAR_XUBIO
  emails?: FilaHoja[] // Catalogo_Emails_Proveedores: CUIT_PROVEEDOR, PROVEEDOR, EMAIL
  productos?: FilaHoja[] // Catalogo_Productos: nombre (columna A) y código (columna B)
}

/** Valor de la primera columna cuyo encabezado normalizado empieza con alguno de los nombres. */
function col(f: FilaHoja, ...nombres: string[]): unknown {
  const claves = Object.keys(f)
  for (const n of nombres) {
    const k = claves.find((c) => normalizar(c).startsWith(normalizar(n)))
    if (k) return f[k]
  }
  return undefined
}

export function catalogosDesdeHoja(c: CatalogosHoja) {
  const omitidas: string[] = []
  const cuentas = (c.cuentas ?? []).flatMap((f) => {
    const empresa = empresaDesdeTexto(col(f, 'EMPRESA'))
    const completa = texto(col(f, 'CUENTA_COMPLETA')) ?? [texto(col(f, 'CODIGO')), texto(col(f, 'NOMBRE'))].filter(Boolean).join(' ')
    if (!empresa || !completa) return []
    return [{ empresa_id: empresa, nombre: completa, codigo: texto(col(f, 'CODIGO')), xubio_id: texto(col(f, 'XUBIO_ID')) }]
  })
  const origen = (c.origen ?? []).flatMap((f) => {
    const empresa = empresaDesdeTexto(col(f, 'EMPRESA'))
    const nombre = texto(col(f, 'NOMBRE'))
    if (!empresa || !nombre) return []
    const tipo = parseInt(String(col(f, 'TIPO_CUENTA') ?? ''), 10)
    return [{
      empresa_id: empresa, nombre, xubio_id: texto(col(f, 'CUENTA_ID')), codigo: texto(col(f, 'CODIGO')),
      tipo_cuenta: Number.isFinite(tipo) ? tipo : null, usos: parseInt(String(col(f, 'USOS') ?? ''), 10) || 0, ultimo_uso: fecha(col(f, 'ULTIMO_USO')),
    }]
  })
  const porEmpresa = (c.porEmpresa ?? []).flatMap((f) => {
    const empresa = empresaDesdeTexto(col(f, 'RECEPTOR'))
    const cuit = String(col(f, 'CUIT') ?? '').replace(/\D/g, '')
    if (!empresa || cuit.length !== 11) {
      if (texto(col(f, 'CUIT'))) omitidas.push(`Proveedor por empresa: ${String(col(f, 'RECEPTOR') ?? '')} · ${String(col(f, 'CUIT') ?? '')}`)
      return []
    }
    return [{
      empresa_id: empresa, cuit, nombre_xubio: texto(col(f, 'NOMBRE_XUBIO')), cuenta_contable: texto(col(f, 'CUENTA_CONTABLE')),
      saltar_xubio: ['true', 'si', 'verdadero', '1'].includes(normalizar(col(f, 'SALTAR_XUBIO'))),
    }]
  })
  const emails = (c.emails ?? []).flatMap((f) => {
    const cuit = String(col(f, 'CUIT') ?? '').replace(/\D/g, '')
    const email = texto(col(f, 'EMAIL'))
    if (cuit.length !== 11 || !email || !email.includes('@')) return []
    return [{ cuit, proveedor: texto(col(f, 'PROVEEDOR')) ?? 'Sin nombre', email: email.toLowerCase() }]
  })
  const productos = (c.productos ?? []).flatMap((f) => {
    const valores = Object.entries(f).filter(([k]) => k !== '_fila').map(([, v]) => v)
    const nombre = texto(valores[0]), codigo = texto(valores[1])
    return nombre && codigo ? [{ nombre, codigo }] : []
  })
  return { cuentas, origen, porEmpresa, emails, productos, omitidas }
}
