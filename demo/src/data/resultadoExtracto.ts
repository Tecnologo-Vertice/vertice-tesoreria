// Contrato pantalla ↔ POST /api/bancos/extracto (netlify/functions/importar-extracto.mts).
// Puro (sin red ni React) para poder probarlo con la respuesta real de la función:
// netlify/pruebas/extractos.prueba.mts.

import type { CuentaImportada, ResultadoExtracto } from './fuente'

type Row = Record<string, unknown>
const s = (v: unknown) => (v == null || v === '' ? undefined : String(v))
const n = (v: unknown) => (v == null ? 0 : Number(v))
const nu = (v: unknown) => (v == null ? undefined : Number(v))

function cuenta(r: Row): CuentaImportada {
  return {
    cuentaId: String(r.cuenta_origen_id ?? ''),
    cuenta: String(r.cuenta ?? ''),
    parte: String(r.parte ?? 'UNICA'),
    repetido: r.repetido === true,
    movimientos: n(r.movimientos),
    nuevos: n(r.nuevos),
    aRevisar: n(r.a_revisar),
    origenSaldos: r.origen_saldos === 'TENENCIA' ? 'TENENCIA' : 'EXTRACTO',
    hasta: s(r.hasta),
    saldoFinal: nu(r.saldo_final),
  }
}

/** Respuesta de la función → lo que muestra la pantalla Bancos. Tolera la respuesta vieja (solo `cuentas`). */
export function leerResultadoExtracto(r: Row): ResultadoExtracto {
  const cuentas = Array.isArray(r.cuentas) ? (r.cuentas as Row[]).map(cuenta) : []
  const suma = (k: 'movimientos' | 'nuevos' | 'aRevisar') => cuentas.reduce((a, c) => a + c[k], 0)
  return {
    repetido: r.repetido != null ? r.repetido === true : cuentas.length > 0 && cuentas.every((c) => c.repetido),
    movimientos: r.movimientos != null ? n(r.movimientos) : cuentas.length ? suma('movimientos') : undefined,
    nuevos: r.nuevos != null ? n(r.nuevos) : suma('nuevos'),
    formato: s(r.formato),
    banco: s(r.banco),
    tenencia: r.tenencia === true,
    aRevisar: r.a_revisar != null ? n(r.a_revisar) : r.aRevisar != null ? n(r.aRevisar) : cuentas.length ? suma('aRevisar') : undefined,
    detalle: s(r.detalle),
    avisos: Array.isArray(r.avisos) ? r.avisos.map(String) : [],
    cuentas,
  }
}
