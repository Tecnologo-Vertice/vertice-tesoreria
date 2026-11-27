// Reglas de pagos que comparten las pantallas y la demo. Las de verdad están en la base (migración 0036).
import type { Pago } from '../types'

/**
 * Un pago que espera su factura (ESPERA_FC del Apps Script): no anulado, con importe, sin factura vinculada y marcado
 * sin factura (o cargado como orden de pago). Es la misma condición de la vista pagos_sin_factura.
 */
export function esperaFactura(p: Pago): boolean {
  return (
    p.estado !== 'ANULADO' &&
    p.importe > 0 &&
    p.facturaIds.length === 0 &&
    !(p.facturaAsociada ?? '').trim() &&
    ((p.tipoPago ?? '').toUpperCase() === 'SIN_FACTURA' || p.formaCargaXubio === 'ORDEN_PAGO')
  )
}

/** Un pago "ya pagado" que Administración registró al aprobar y al que todavía le falta el comprobante. */
export const faltaComprobante = (p: Pago): boolean => p.estado !== 'ANULADO' && p.faltaComprobante === true && !p.comprobante && !p.comprobanteUrl
