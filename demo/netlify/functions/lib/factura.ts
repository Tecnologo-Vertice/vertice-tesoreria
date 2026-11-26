// Lectura de facturas de proveedores: prompt, esquema, normalización y validación.
// Es el Flujo 1 del Apps Script (extraerDatosConGemini, procesarFacturaCompleta_ y validarFactura_
// en Code.gs) pasado al sistema nuevo. Diferencias deliberadas, marcadas con "MEJORA":
//  - El prompt lleva los CUIT reales de las empresas del grupo (en Code.gs quedaron "[CUIT India]").
//  - La IA devuelve también el CUIT del receptor: la empresa se identifica por CUIT, no solo por nombre.
//  - Se valida el dígito verificador del CUIT del proveedor.
//  - CAE: es error si venció ANTES de la fecha de emisión; si venció después, es un aviso.
//    (Code.gs marcaba error toda factura procesada después del vencimiento del CAE.)
//  - La categoría genérica de la IA se guarda como sugerencia; la cuenta contable sale de la memoria
//    del proveedor o la elige quien aprueba (regla de oro: cuenta del plan de Xubio).
// Sin imports: se prueba solo con Node (netlify/pruebas/factura.prueba.mts).

/** Una empresa de la organización, como está en la tabla empresas. */
export interface EmpresaRef {
  id: string
  nombre: string
  cuit: string
  /** ERP de la empresa (XUBIO, RALPHARMA, NINGUNO). Lo usa la copia de la hoja. */
  erp?: string | null
  /** Formas en que aparece su nombre como receptora (migración 0020). Partes unidas con "+": tienen que estar todas. */
  alias?: string[] | null
  /** Lo mismo para el emisor: una factura emitida por alguien que coincide se asigna a esta empresa. */
  alias_emisor?: string[] | null
  /** Si un texto coincide con más de una empresa, gana la de orden menor. */
  alias_orden?: number | null
}

export const ESQUEMA_FACTURA = {
  type: 'OBJECT',
  properties: {
    RECEPTOR: { type: 'STRING', description: 'Empresa o persona que recibe la factura.' },
    CUIT_RECEPTOR: { type: 'STRING', description: 'CUIT del receptor (11 dígitos, sin guiones). Vacío si no figura.' },
    PROVEEDOR: { type: 'STRING', description: 'Nombre o Razón Social del emisor.' },
    CUIT_PROVEEDOR: { type: 'STRING', description: 'CUIT del proveedor emisor (11 dígitos, sin guiones).' },
    LETRA: { type: 'STRING', description: 'Una sola letra: A, B, C, E, M. OTRA si no se sabe.', enum: ['A', 'B', 'C', 'E', 'M', 'OTRA'] },
    TIPO: { type: 'STRING', description: "Ej. 'Factura A', 'Nota de Crédito B', 'Nota de Débito M'. Vacío si no es un comprobante válido de compra." },
    NUMERO: { type: 'STRING', description: 'Número completo de la factura (ej. 0001-00002604).' },
    CAE: { type: 'STRING', description: 'Código de Autorización Electrónico. Vacío si no figura.' },
    CAE_VENCIMIENTO: { type: 'STRING', description: 'Fecha de vencimiento del CAE (YYYY-MM-DD).' },
    COMPROBANTE_VINCULADO: { type: 'STRING', description: 'Número del comprobante original vinculado. Vacío si no aplica.' },
    FECHA: { type: 'STRING', description: 'Fecha de emisión (YYYY-MM-DD).' },
    VENCIMIENTODELPAGO: { type: 'STRING', description: 'Fecha de vencimiento del pago (YYYY-MM-DD). Si no figura, igual a FECHA.' },
    MONEDA: { type: 'STRING', description: 'Moneda (ARS, USD, EUR, etc.).' },
    COTIZACION: { type: 'NUMBER', description: "Cotización si es moneda extranjera. Si es ARS, 1. Si es 'E' sin cotización explícita, 0." },
    PRODUCTOSERVICIOPERCEPCION: { type: 'STRING', description: 'Descripción del principal producto o servicio.' },
    IMPORTE: { type: 'NUMBER', description: 'Neto gravado (base imponible), siempre positivo.' },
    IVA: { type: 'NUMBER', description: 'Monto de IVA, siempre positivo. 0 si la letra es B/C/E.' },
    NETO_NO_GRAVADO_EXENTO: {
      type: 'NUMBER',
      description: 'Importe exento/no gravado. Usar ÚNICAMENTE para pagos extras no deducibles (ej. impuesto a la nafta) o montos verdaderamente exentos. NO usar este campo para volcar el total de facturas B o C.',
    },
    PERCEPCION_IVA: { type: 'NUMBER', description: 'Monto de Percepción de IVA, si no tiene es 0.00.' },
    PERCEPCIONES_IIBB: {
      type: 'ARRAY',
      description:
        'Lista de TODAS las percepciones de Ingresos Brutos (IIBB) del comprobante, una entrada por cada jurisdicción/provincia distinta detectada. Si hay dos o más provincias, NUNCA las sumes en un solo número. Si no hay ninguna, devolvé [].',
      items: {
        type: 'OBJECT',
        properties: {
          PROVINCIA: { type: 'STRING', description: "Provincia u organismo de esa percepción IIBB (ej: 'Buenos Aires', 'CABA')." },
          MONTO: { type: 'NUMBER', description: 'Monto de esa percepción IIBB puntual, siempre positivo.' },
        },
        required: ['PROVINCIA', 'MONTO'],
      },
    },
    RETENCION: { type: 'NUMBER', description: 'Monto total de retenciones, si no aplica es 0.00.' },
    TOTAL: { type: 'NUMBER', description: 'Monto final total del comprobante, siempre positivo.' },
    CATEGORIA_CONTABLE: {
      type: 'STRING',
      description: "Clasificá el gasto en una categoría exacta o 'Gastos Generales'.",
      enum: [
        'Gastos Generales', 'Gastos Varios Administracion', 'Gastos Varios Oficina', 'Gastos de Libreria 21', 'Gastos de Libreria 10.5',
        'Honorarios Profesionales 21', 'Honorarios Profesionales Exentos', 'Honorarios Contables', 'Honorarios Legales', 'Software', 'Seguros',
        'Alquiler Oficina', 'Alquiler Oficina Exento', 'Gastos Bancarios 21', 'Gastos Bancarios 10.5', 'Movilidad y Viaticos',
        'Celulares y Telefonia', 'Servicios de Electricidad', 'Muebles y Utiles', 'Gasto Automotor', 'Mantenimiento de Oficina', 'Servicios de Publicidad',
      ],
    },
  },
  required: [
    'RECEPTOR', 'CUIT_RECEPTOR', 'PROVEEDOR', 'CUIT_PROVEEDOR', 'LETRA', 'TIPO', 'NUMERO', 'CAE', 'CAE_VENCIMIENTO', 'COMPROBANTE_VINCULADO',
    'FECHA', 'VENCIMIENTODELPAGO', 'MONEDA', 'COTIZACION', 'PRODUCTOSERVICIOPERCEPCION', 'IMPORTE', 'IVA', 'NETO_NO_GRAVADO_EXENTO',
    'PERCEPCION_IVA', 'PERCEPCIONES_IIBB', 'RETENCION', 'TOTAL', 'CATEGORIA_CONTABLE',
  ],
}

/** El manual de carga de Code.gs (extraerDatosConGemini), con los CUIT del grupo completos. */
export function promptFactura(empresas: EmpresaRef[], hoy: string): string {
  const cuits = empresas
    .filter((e) => /^\d{11}$/.test(e.cuit) && !/^0+\d?$/.test(e.cuit))
    .map((e) => `${e.cuit} (${e.nombre})`)
    .join(', ')
  return `Actúa como un Agente de Inteligencia Artificial experto en Auditoría Contable y Visión por Computadora, especializado en la legislación tributaria argentina (AFIP), y seguí AL PIE DE LA LETRA el manual interno de carga de comprobantes que se detalla a continuación.

MANUAL DE CARGA (reglas de negocio obligatorias):

1. LETRA del comprobante (recuadro superior central):
   - EXTRAÉ EXCLUSIVAMENTE UNA SOLA LETRA: "A", "B", "C", "E", o "M". Si no identificás la letra con claridad, usá "OTRA".
   - "A" (Responsable Inscripto): separá SIEMPRE el Neto (IMPORTE), el IVA y las Percepciones en campos distintos. Nunca vuelques el total en el neto.
   - "M" (proveedor bajo lupa de AFIP, sujeto a retención): cargá igual que "A" (Neto e IVA separados), y marcá LETRA="M" explícitamente.
   - "B" o "C" (sin IVA discriminado): volcá el TOTAL completo de la factura en el campo IMPORTE y dejá IVA en 0. NETO_NO_GRAVADO_EXENTO debe ir en 0.
   - "E" (Importación del exterior): todo el importe va a IMPORTE y dejá IVA en 0. Si no hay cotización explícita, dejá COTIZACION en 0.

2. CUIT_PROVEEDOR: el CUIT del EMISOR de la factura (quien vende/factura, bloque superior, junto a "Ingresos Brutos" y/o "Fecha de Inicio de Actividades").
   NUNCA tomes como CUIT_PROVEEDOR el CUIT del bloque "Apellido y Nombre / Razón Social" o "Denominación": ese es SIEMPRE el RECEPTOR (cliente). Hay DOS bloques con CUIT en casi toda factura argentina: el de ARRIBA es el PROVEEDOR, el de ABAJO es el RECEPTOR.
   Devolvé el CUIT del receptor en CUIT_RECEPTOR.
${cuits ? `   Estos CUIT son SIEMPRE receptores (empresas del grupo), nunca proveedores: ${cuits}. Si el CUIT que ibas a poner como proveedor coincide con alguno, buscá el otro CUIT del documento.\n` : ''}   Devolvé los CUIT con 11 dígitos, sin guiones ni espacios.

3. Campos sin valor: los NUMBER en 0, los texto en "". No uses null.

4. CAE: el Código de Autorización Electrónico (abajo a la derecha) y su fecha de vencimiento. Si el documento dice "Documento no válido como factura" o no tiene CAE visible, devolvé CAE vacío.

5. TIPO de documento: "Factura A/B/C/E/M", "Nota de Crédito A/B/C/M" o "Nota de Débito A/B/C/M". Un Recibo con CAE se trata igual que una Factura. Un recibo común sin CAE (tipo "X") NO es válido: devolvé TIPO vacío.

6. Notas de Crédito y Débito: TODOS los importes POSITIVOS. Número original en COMPROBANTE_VINCULADO; si no lo indica, vacío.

7. Percepciones de IIBB: identificá el organismo ("ARBA" -> "Buenos Aires", "AGIP" -> "CABA"). Una entrada por provincia en PERCEPCIONES_IIBB, nunca sumadas.

8. Consistencia: IMPORTE + IVA + NETO_NO_GRAVADO_EXENTO + PERCEPCION_IVA + PERCEPCIONES_IIBB = TOTAL.

9. NETO_NO_GRAVADO_EXENTO es ÚNICAMENTE para impuestos internos no deducibles o conceptos verdaderamente exentos. NUNCA pongas el total de una factura B o C en este campo.

10. Formato: números planos sin $. Las fechas de los documentos están en formato argentino DD/MM/YYYY (día primero): "03/04/2026" es 3 de abril. Devolvelas en YYYY-MM-DD.

Fecha de procesamiento actual: ${hoy}.`
}

// ---------------------------------------------------------------- Utilidades

export const soloDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '')
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const r2 = (n: number) => Math.round(n * 100) / 100
export const normalizarTexto = (s: unknown) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

/** Dígito verificador de CUIT (módulo 11). MEJORA: Code.gs solo contaba 11 dígitos. */
export function cuitValido(cuit: string): boolean {
  const d = soloDigitos(cuit)
  if (d.length !== 11) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((a, p, i) => a + p * Number(d[i]), 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(d[10])
}

/** Igual que parsearNumeroComprobante_ de Code.gs, pero sin inventar "00001" si no se entiende. */
export function parsearNumero(texto: unknown): { puntoVenta: number; numero: number } | null {
  const crudo = String(texto ?? '').trim()
  const m = crudo.match(/(\d{4,5})[-\s]*(\d{6,8})/)
  if (m) return { puntoVenta: Number(m[1]), numero: Number(m[2]) }
  const solo = soloDigitos(crudo)
  if (solo.length >= 9 && solo.length <= 13) {
    const largoPV = solo.length === 12 ? 4 : 5
    return { puntoVenta: Number(solo.slice(0, largoPV)), numero: Number(solo.slice(largoPV)) }
  }
  return null
}

/**
 * Empresa cuyo alias coincide con el texto, entre las empresas recibidas y ninguna más. Los alias son
 * datos de cada empresa (tabla empresas): acá no hay ningún nombre escrito. Un alias puede tener varias
 * partes unidas con "+" ("drogueria+robles"): tienen que aparecer todas en el texto. Se compara sin
 * mayúsculas, tildes, espacios ni signos. Si coincide más de una empresa, gana la de alias_orden menor.
 */
export function empresaPorAlias(t: unknown, empresas: EmpresaRef[], campo: 'alias' | 'alias_emisor' = 'alias'): string | null {
  const texto = normalizarTexto(t)
  if (!texto) return null
  const coincide = (alias: string) => {
    const partes = alias.split('+').map((p) => normalizarTexto(p)).filter(Boolean)
    return partes.length > 0 && partes.every((p) => texto.includes(p))
  }
  const enOrden = [...empresas].sort((a, b) => (a.alias_orden ?? 100) - (b.alias_orden ?? 100) || a.id.localeCompare(b.id))
  return enOrden.find((e) => (e[campo] ?? []).some(coincide))?.id ?? null
}

/**
 * Empresa receptora, siempre entre las empresas recibidas (las de la organización del documento):
 *  1. por el emisor, si coincide con el alias_emisor de una empresa (Code.gs: las facturas EMITIDAS por
 *     Robles se asignan a la empresa Robles correspondiente);
 *  2. por el CUIT del receptor (MEJORA);
 *  3. por el nombre del receptor contra los alias, como normalizarReceptorCanonico_.
 */
export function empresaReceptora(receptor: string, cuitReceptor: string, proveedor: string, empresas: EmpresaRef[]): string | null {
  const porEmisor = empresaPorAlias(proveedor, empresas, 'alias_emisor')
  if (porEmisor) return porEmisor

  const c = soloDigitos(cuitReceptor)
  const porCuit = c.length === 11 ? empresas.find((e) => soloDigitos(e.cuit) === c) : undefined
  if (porCuit) return porCuit.id

  return empresaPorAlias(receptor, empresas)
}

const fechaIso = (s: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(s ?? '')) ? String(s).slice(0, 10) : '')

// ---------------------------------------------------------------- Normalizar y validar

export interface FacturaLeida {
  empresa_id: string
  proveedor: string
  cuit_proveedor: string
  tipo: string
  letra: string
  punto_venta: number
  numero: number
  fecha: string
  vencimiento: string
  moneda: string
  cotizacion: number
  neto: number
  iva: number
  exento: number
  percepciones: number
  percepciones_json: { nombre: string; descripcion: string; importe: number }[]
  total: number
  cae: string
  cae_vencimiento: string
  comprobante_vinculado: string
  categoria_ia: string
  validacion_ok: boolean
  motivo_validacion: string
  advertencia: string
}

export type ResultadoLectura =
  | { tipo: 'FACTURA'; factura: FacturaLeida }
  /** No se puede guardar como factura: falta algo que identifica al comprobante. */
  | { tipo: 'SIN_FACTURA'; motivo: string }

/**
 * Convierte lo que devolvió la IA en una factura validada. Los errores de contenido (CAE, totales)
 * dejan la factura en Excepciones; los que impiden identificarla (empresa, CUIT, número) no la crean.
 */
export function interpretarLectura(raw: Record<string, unknown>, empresas: EmpresaRef[], hoy: string): ResultadoLectura {
  const tipo = String(raw.TIPO ?? '').trim()
  if (!tipo) return { tipo: 'SIN_FACTURA', motivo: 'No es un comprobante de compra válido (sin tipo: recibo X, presupuesto, otro documento).' }

  const empresaId = empresaReceptora(String(raw.RECEPTOR ?? ''), String(raw.CUIT_RECEPTOR ?? ''), String(raw.PROVEEDOR ?? ''), empresas)
  if (!empresaId) return { tipo: 'SIN_FACTURA', motivo: `No se reconoce la empresa receptora ("${raw.RECEPTOR ?? ''}").` }

  const cuitProv = soloDigitos(raw.CUIT_PROVEEDOR)
  if (cuitProv.length !== 11) return { tipo: 'SIN_FACTURA', motivo: `El CUIT del proveedor no tiene 11 dígitos ("${raw.CUIT_PROVEEDOR ?? ''}").` }

  const nro = parsearNumero(raw.NUMERO)
  if (!nro) return { tipo: 'SIN_FACTURA', motivo: `No se entiende el número de comprobante ("${raw.NUMERO ?? ''}").` }

  const fecha = fechaIso(raw.FECHA)
  if (!fecha) return { tipo: 'SIN_FACTURA', motivo: `Fecha de emisión ilegible ("${raw.FECHA ?? ''}").` }

  const letra = String(raw.LETRA ?? '').toUpperCase()
  const esAjuste = /nota de (cr[eé]dito|d[eé]bito)/i.test(tipo)
  let neto = esAjuste ? Math.abs(num(raw.IMPORTE)) : num(raw.IMPORTE)
  const iva = esAjuste ? Math.abs(num(raw.IVA)) : num(raw.IVA)
  let exento = num(raw.NETO_NO_GRAVADO_EXENTO)
  const total = num(raw.TOTAL)
  const advertencias: string[] = []

  // Code.gs: en B/C, si el total cayó en exento, va al neto.
  if ((letra === 'B' || letra === 'C') && exento > 0 && neto === 0 && total > 0) {
    neto = exento
    exento = 0
  }

  const percIva = num(raw.PERCEPCION_IVA)
  const iibb = Array.isArray(raw.PERCEPCIONES_IIBB) ? (raw.PERCEPCIONES_IIBB as { PROVINCIA?: string; MONTO?: number }[]) : []
  const percepcionesJson = [
    ...(percIva > 0 ? [{ nombre: 'Percepción IVA', descripcion: 'Percepción IVA', importe: r2(percIva) }] : []),
    ...iibb
      .filter((p) => num(p.MONTO) > 0)
      .map((p) => ({ nombre: `Percepción IIBB ${p.PROVINCIA ?? ''}`.trim(), descripcion: `Percepción IIBB ${p.PROVINCIA ?? ''}`.trim(), importe: r2(num(p.MONTO)) })),
  ]
  const percepciones = r2(percepcionesJson.reduce((a, p) => a + p.importe, 0))

  // ---- Validación (validarFactura_ de Code.gs, con las mejoras marcadas)
  const errores: string[] = []
  const cae = soloDigitos(raw.CAE)
  const caeVto = fechaIso(raw.CAE_VENCIMIENTO)
  if (!cae) errores.push("Falta el CAE o el documento indica 'no válido como factura'.")
  else if (cae.length !== 14) errores.push(`CAE con longitud inválida (${cae.length} dígitos). Debe tener 14.`)
  if (cae && caeVto) {
    if (caeVto < fecha) errores.push(`El CAE venció (${caeVto}) antes de la fecha de emisión (${fecha}).`)
    else if (caeVto < hoy) advertencias.push(`CAE vencido el ${caeVto} (la factura se emitió antes: es válida).`)
  }
  if (!cuitValido(cuitProv)) errores.push(`El CUIT del proveedor ${cuitProv} tiene el dígito verificador mal: la IA pudo leerlo mal.`)
  if (empresas.some((e) => soloDigitos(e.cuit) === cuitProv)) errores.push('El CUIT del proveedor es de una empresa del grupo: la IA confundió emisor y receptor.')
  if (total <= 0) errores.push('El total debe ser mayor a cero.')

  const diferencia = r2(total - (neto + iva + exento + percepciones))
  if (Math.abs(diferencia) >= 1)
    errores.push(`Descuadre de $${Math.abs(diferencia).toFixed(2)} entre el total ($${total.toFixed(2)}) y neto + IVA + exento + percepciones ($${(total - diferencia).toFixed(2)}).`)
  else if (diferencia !== 0) advertencias.push(`Diferencia de redondeo de $${diferencia.toFixed(2)}.`)

  if (letra === 'M') advertencias.push('Factura M: preparar las retenciones.')
  const retencion = num(raw.RETENCION)
  if (retencion > 0) advertencias.push(`El comprobante informa retenciones por $${retencion.toFixed(2)}.`)

  const moneda = String(raw.MONEDA ?? '').trim().toUpperCase() || 'ARS'
  return {
    tipo: 'FACTURA',
    factura: {
      empresa_id: empresaId,
      proveedor: String(raw.PROVEEDOR ?? '').trim(),
      cuit_proveedor: cuitProv,
      tipo,
      letra: letra === 'OTRA' ? '' : letra,
      punto_venta: nro.puntoVenta,
      numero: nro.numero,
      fecha,
      vencimiento: fechaIso(raw.VENCIMIENTODELPAGO) || fecha,
      moneda,
      cotizacion: moneda === 'ARS' ? 1 : num(raw.COTIZACION),
      neto: r2(neto),
      iva: r2(iva),
      exento: r2(exento),
      percepciones,
      percepciones_json: percepcionesJson,
      total: r2(total),
      cae,
      cae_vencimiento: caeVto,
      comprobante_vinculado: soloDigitos(raw.COMPROBANTE_VINCULADO) === '0' ? '' : String(raw.COMPROBANTE_VINCULADO ?? '').trim(),
      categoria_ia: String(raw.CATEGORIA_CONTABLE ?? '').trim(),
      validacion_ok: errores.length === 0,
      motivo_validacion: errores.join(' '),
      advertencia: advertencias.join(' '),
    },
  }
}
