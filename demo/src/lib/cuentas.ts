// Qué cuentas ofrecer en cada pantalla y cómo deducir la cuenta de origen de un pago.
// Funciones puras: se prueban en netlify/pruebas/espejo.prueba.mts.

import type { Catalogos } from '../data/fuente'
import type { CuentaOrigen } from '../types'

/** Plan de cuentas de la empresa (el real, copiado de Xubio); si no hay, el común. */
export function cuentasPara(c: Catalogos, empresaId: string): string[] {
  const propias = c.planPorEmpresa[empresaId]
  return propias && propias.length ? propias : c.planCuentas
}

/** Para aprobar una factura: los productos de compra de Xubio (lo que usa producción); si no hay, el plan de la empresa. */
export function cuentasFactura(c: Catalogos, empresaId: string): string[] {
  return c.productos.length ? c.productos : cuentasPara(c, empresaId)
}

const norm = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** El valor está en la lista (sin distinguir mayúsculas, tildes ni espacios). Devuelve cómo está escrito en la lista. */
export function enLista(lista: string[], valor: string): string | null {
  const v = norm(valor)
  if (!v) return null
  return lista.find((x) => norm(x) === v) ?? null
}

/** Cuentas de origen de la empresa, las más usadas primero. */
export function cuentasOrigenDe(cuentas: CuentaOrigen[], empresaId: string): CuentaOrigen[] {
  return cuentas.filter((c) => c.empresaId === empresaId).sort((a, b) => (b.usos ?? 0) - (a.usos ?? 0) || a.nombre.localeCompare(b.nombre))
}

export interface SugerenciaOrigen {
  cuenta: string
  /** true si había varias posibles y se eligió la más usada: hay que confirmarla. */
  revisar: boolean
  nota: string
}

/**
 * Cuenta de origen a partir del banco que leyó la IA ("Banco Hipotecario", "Brubank", "Caja"), como
 * cuentaOrigenDesdeXubio_ de producción: con cheque, la cuenta de e-cheqs de ese banco; si no, la bancaria.
 * Si hay varias, decide el N° de cuenta del comprobante; si tampoco, la más usada, marcada para revisar.
 */
export function sugerirCuentaOrigen(cuentas: CuentaOrigen[], banco: string | undefined, opciones: { esCheque?: boolean; numeroCuenta?: string } = {}): SugerenciaOrigen | null {
  const b = norm(banco)
  if (!b || cuentas.length === 0) return null
  if (/^(caja|efectivo)/.test(b)) {
    const caja = cuentas.find((c) => c.tipoCuenta === 1 || norm(c.nombre).startsWith('caja'))
    return caja ? { cuenta: caja.nombre, revisar: false, nota: 'Caja' } : null
  }
  const nucleo = b.replace(/^banco/, '')
  const coincide = (c: CuentaOrigen) => {
    const n = norm(c.nombre)
    return n.includes(b) || b.includes(n) || (nucleo.length >= 4 && n.includes(nucleo))
  }
  let candidatas = cuentas.filter((c) => c.tipoCuenta !== 1 && coincide(c))
  if (candidatas.length === 0) return null
  const esEcheq = (c: CuentaOrigen) => c.tipoCuenta === 4 || /cheq|chec/.test(norm(c.nombre))
  const preferidas = candidatas.filter((c) => (opciones.esCheque ? esEcheq(c) : !esEcheq(c)))
  if (preferidas.length) candidatas = preferidas
  if (candidatas.length === 1) return { cuenta: candidatas[0].nombre, revisar: false, nota: `Deducida del banco del comprobante (${banco})` }
  const nro = String(opciones.numeroCuenta ?? '').replace(/\D/g, '')
  if (nro.length >= 4) {
    const porNumero = candidatas.filter((c) => (c.nombre.match(/\d{4,}/g) ?? []).some((r) => nro.includes(r) || r.includes(nro.slice(-4))))
    if (porNumero.length === 1) return { cuenta: porNumero[0].nombre, revisar: false, nota: 'Elegida por el N° de cuenta del comprobante' }
  }
  const ordenadas = [...candidatas].sort((x, y) => (y.usos ?? 0) - (x.usos ?? 0))
  return { cuenta: ordenadas[0].nombre, revisar: true, nota: `Hay ${candidatas.length} cuentas de ${banco}: se propone la más usada, confirmala` }
}
