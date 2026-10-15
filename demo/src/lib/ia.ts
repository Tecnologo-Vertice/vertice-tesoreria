// Capa de IA simulada. En el sistema real esta función llama a una Netlify Function
// que a su vez llama a Gemini o Claude con un esquema JSON fijo (LecturaComprobante).
// El contrato queda igual: archivo entra, JSON tipado sale.

import type { ComprobanteEjemplo, Factura, LecturaComprobante, OrigenSugerencia, Pago, Proveedor } from '../types'

export function leerComprobante(c: ComprobanteEjemplo): Promise<LecturaComprobante> {
  const demora = 900 + Math.round(Math.random() * 900)
  return new Promise((resolve) => setTimeout(() => resolve(c.lectura), demora))
}

export interface Sugerencia {
  cuenta?: string
  origen: OrigenSugerencia
  confianza: number
  motivo: string
}

/**
 * Misma lógica que SugerenciaCuenta.gs: primero reglas aprendidas por proveedor y
 * empresa, después la IA con el plan de cuentas y el comentario de la tesorera.
 */
export function sugerirCuenta(args: {
  proveedor?: Proveedor
  facturas: Factura[]
  descripcion: string
  pagosPrevios: Pago[]
}): Sugerencia {
  const { proveedor, facturas, descripcion, pagosPrevios } = args
  if (facturas.length && facturas[0].cuentaContable) {
    return { cuenta: facturas[0].cuentaContable, origen: 'REGLA', confianza: 0.99, motivo: 'Cuenta de la factura aprobada' }
  }
  if (proveedor) {
    const previo = pagosPrevios.find((p) => p.proveedorId === proveedor.id && p.cuentaContable)
    if (previo) return { cuenta: previo.cuentaContable, origen: 'REGLA', confianza: 0.95, motivo: 'Último pago a este proveedor' }
    if (proveedor.cuentaHabitual) return { cuenta: proveedor.cuentaHabitual, origen: 'REGLA', confianza: 0.9, motivo: 'Cuenta habitual del proveedor' }
  }
  const d = descripcion.toLowerCase()
  const reglasIA: [RegExp, string, string][] = [
    [/comisi|mantenimiento de cuenta|gasto.*banc/, 'GASTOS BANCARIOS', 'El texto menciona comisiones bancarias'],
    [/25413|d[eé]b.*cr[eé]d|impuesto al cheque/, 'IMPUESTO DEB/CRED BANCARIO', 'Impuesto Ley 25.413'],
    [/iibb|ingresos brutos|vep|arca|afip|monotributo/, 'IMPUESTOS Y TASAS', 'Pago a organismo fiscal'],
    [/alquiler/, 'ALQUILER DE OFICINA', 'El texto menciona alquiler'],
    [/honorario|m[eé]dic|dr\.|dra\./, 'HONORARIOS PROFESIONALES', 'Honorarios de prestador'],
    [/insumo|laborator|farma/, 'COSTO DE INSUMOS', 'Compra de insumos'],
    [/seguro|p[oó]liza/, 'SEGUROS', 'Póliza de seguro'],
    [/flete|transporte|env[ií]o/, 'GASTOS DE FLETES', 'Servicio de transporte'],
    [/software|licencia|suscripci/, 'SOFTWARE DE GESTION', 'Licencia de software'],
    [/sueldo|jornal|haberes/, 'SUELDOS Y JORNALES', 'Pago de haberes'],
    [/inter[eé]s/, 'INTERESES PAGADOS', 'Intereses'],
  ]
  for (const [re, cuenta, motivo] of reglasIA) {
    if (re.test(d)) return { cuenta, origen: 'IA', confianza: 0.84, motivo }
  }
  return { cuenta: undefined, origen: 'IA', confianza: 0.3, motivo: 'Sin pistas suficientes; completar a mano' }
}

export function formaDeCarga(facturas: Factura[], descripcion: string): Pago['formaCargaXubio'] {
  if (facturas.length) return 'ORDEN_PAGO'
  if (/impuesto|iibb|arca|afip|vep|sueldo/i.test(descripcion)) return 'ASIENTO_MANUAL'
  return 'SALIDA_FONDOS'
}

/** Simula el POST a Xubio. El real crea una orden de pago y devuelve su id. */
export function registrarEnXubio(p: Pago): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  return new Promise((resolve) =>
    setTimeout(() => {
      if (!p.cuentaContable) resolve({ ok: false, error: 'Falta la cuenta contable (regla de oro)' })
      else resolve({ ok: true, id: `OP-${7200 + Math.floor(Math.random() * 700)}` })
    }, 1100),
  )
}
