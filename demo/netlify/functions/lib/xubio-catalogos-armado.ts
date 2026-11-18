// Armado puro (sin red) del plan de cuentas y las cuentas de origen que devuelve Xubio. Se prueba en
// netlify/pruebas/mails.prueba.mts. La lectura y el guardado están en xubio-catalogos.ts.

export interface CuentaXubio { ID?: number; id?: number; codigo?: string; nombre?: string }
export interface PagoXubio { fecha?: string; transaccionInstrumentoDePago?: { tipoCuenta?: number; cuenta?: CuentaXubio }[] }

/** Una fila por cuenta, con "CÓDIGO NOMBRE" como CUENTA_COMPLETA (igual que la pestaña Catalogo_Cuentas_Contables). */
export function cuentasDesdeXubio(lista: CuentaXubio[], empresaId: string) {
  return (Array.isArray(lista) ? lista : [])
    .map((c) => {
      const codigo = String(c.codigo ?? '').trim()
      const nombre = String(c.nombre ?? '').trim()
      return { empresa_id: empresaId, nombre: [codigo, nombre].filter(Boolean).join(' '), codigo: codigo || null, xubio_id: String(c.ID ?? c.id ?? '') || null }
    })
    .filter((c) => c.nombre)
    .sort((a, b) => String(a.codigo ?? '').localeCompare(String(b.codigo ?? '')))
}

/** Cuentas de origen usadas en los pagos de los últimos 180 días: tipo, cuántas veces y último uso. */
export function origenDesdePagos(pagos: PagoXubio[], empresaId: string) {
  const mapa = new Map<string, { empresa_id: string; nombre: string; xubio_id: string | null; codigo: string | null; tipo_cuenta: number | null; usos: number; ultimo_uso: string | null }>()
  for (const p of Array.isArray(pagos) ? pagos : []) {
    for (const i of p.transaccionInstrumentoDePago ?? []) {
      const c = i.cuenta ?? {}
      const k = String(c.ID ?? c.id ?? c.nombre ?? '')
      if (!k || !c.nombre) continue
      const m = mapa.get(k) ?? { empresa_id: empresaId, nombre: String(c.nombre).trim(), xubio_id: String(c.ID ?? c.id ?? '') || null, codigo: c.codigo ? String(c.codigo) : null, tipo_cuenta: i.tipoCuenta ?? null, usos: 0, ultimo_uso: null }
      m.usos++
      const f = String(p.fecha ?? '').slice(0, 10)
      if (f && (!m.ultimo_uso || f > m.ultimo_uso)) m.ultimo_uso = f
      mapa.set(k, m)
    }
  }
  return [...mapa.values()].sort((a, b) => b.usos - a.usos)
}
