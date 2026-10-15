// Armado de comprobantes para Xubio, sin llamadas de red (se prueba con Node: netlify/pruebas/xubio.prueba.mts).
// La factura de compra replica construirFacturaCompra_ de Code.gs, que ya sube facturas reales en producción.
// El pago dentro de la factura ("camino B", docs/08) usa TransaccionOrdenPagoItems de la especificación
// oficial de la API (https://xubio.com/API/1.1/swagger.json): es la ÚNICA forma de que un pago quede
// imputado a su factura por API; PagoBean (orden de pago) no tiene campo para tildar facturas.

export interface Ref {
  ID: number
  id: number
  nombre: string
  codigo: string
}

export const MONEDA_ARS = { ID: -2, nombre: 'Pesos Argentinos', codigo: 'PESOS_ARGENTINOS', id: -2 }
export const CIRCUITO = { ID: -2, nombre: 'default', codigo: 'DEFAULT', id: -2 }
const VACIO = { ID: 0, nombre: '', codigo: '', id: 0 }

/** XUBIO_MAPA_TIPO_COMPROBANTE de Code.gs. Acepta "Nota de Crédito A" además de "Nota de Crédito". */
export function tipoComprobante(tipo: string): number {
  const t = tipo.trim().toLowerCase()
  if (/^factura [abcemt]$/.test(t)) return 1
  if (t.startsWith('nota de crédito') || t.startsWith('nota de credito')) return 3
  if (t.startsWith('nota de débito') || t.startsWith('nota de debito')) return 2
  if (t.startsWith('recibo')) return 6
  return 0
}

/** "A-00105-02121138": el formato con que Code.gs sube y con el que Xubio la muestra. */
export function numeroDocumento(letra: string | null | undefined, puntoVenta: number, numero: number): string {
  const l = (letra ?? '').trim().toUpperCase()
  return `${l ? l + '-' : ''}${String(puntoVenta).padStart(5, '0')}-${String(numero).padStart(8, '0')}`
}

export interface FacturaParaXubio {
  id: string
  tipo: string
  letra: string | null
  punto_venta: number
  numero: number
  fecha: string
  vencimiento: string | null
  cotizacion: number
  neto: number
  iva: number
  exento: number
  total: number
  percepciones_json: { nombre?: string; codigo?: string; descripcion?: string; importe?: number }[]
  descripcion?: string
}

export function facturaCompra(f: FacturaParaXubio, proveedor: Ref, producto: Ref) {
  const percepciones = (f.percepciones_json ?? [])
    .filter((p) => Number(p.importe) > 0)
    .map((p) => ({
      percepcionImpuesto: { ID: 0, nombre: p.nombre || 'Otro', codigo: p.codigo || 'OTRO', id: 0 },
      transaccionId: 0,
      centroDeCosto: VACIO,
      descripcion: p.descripcion || p.nombre || 'Percepción',
      importe: Number(p.importe),
    }))
  const totalPercepciones = percepciones.reduce((a, p) => a + p.importe, 0)
  const importeImpuestos = Math.round((Number(f.iva) + totalPercepciones) * 100) / 100
  const neto = Number(f.neto)
  return {
    circuitoContable: CIRCUITO,
    comprobante: 0,
    fechaFiscal: f.fecha,
    cuentaBancaria: VACIO,
    transaccionid: 0,
    externalId: f.id, // MEJORA: Code.gs dejaba "". Con el id propio, la factura se encuentra en Xubio sin adivinar.
    tipo: tipoComprobante(f.tipo),
    nombre: '',
    fecha: f.fecha,
    fechaVto: f.vencimiento || f.fecha,
    puntoVenta: String(f.punto_venta).padStart(5, '0'),
    numeroDocumento: numeroDocumento(f.letra, f.punto_venta, f.numero),
    condicionDePago: 1, // cuenta corriente: se paga después
    deposito: VACIO,
    cotizacion: Number(f.cotizacion) || 1,
    importeMonPrincipal: Number(f.total),
    importetotal: Number(f.total),
    importeImpuestos,
    importeGravado: neto,
    provincia: { provincia_id: 0, codigo: '', nombre: '', pais: '' },
    fechaComprobante: f.fecha,
    proveedor,
    descripcion: f.descripcion ?? '',
    cbuinformada: true,
    transaccionProductoItems: [
      {
        transaccionCVItemId: 0,
        precioconivaincluido: 0,
        transaccionId: 0,
        producto,
        descripcion: producto.nombre,
        cantidad: 1,
        precio: neto,
        iva: Number(f.iva),
        importe: neto,
        total: Math.round((neto + Number(f.iva)) * 100) / 100,
        montoExento: Number(f.exento) || 0,
        porcentajeDescuento: 0,
      },
    ],
    transaccionPercepcionItems: percepciones,
    transaccionOrdenPagoItems: [] as unknown[],
  }
}

/** tipoCuenta de Xubio por el nombre de la cuenta: 1 caja · 4 cheque diferido / e-cheq · 2 banco. */
export function tipoCuentaPara(nombreCuenta: string, conCheque: boolean): number {
  if (conCheque) return 4
  const n = nombreCuenta.toLowerCase()
  if (n.includes('caja')) return 1
  if (n.includes('cheq')) return 4
  return 2
}

/**
 * Ítem de pago para agregar DENTRO de la factura de compra (camino B). Nombres de campo según
 * TransaccionOrdenPagoItems de la especificación oficial. Sin probar contra Xubio real: se activa
 * con XUBIO_PAGO_EN_FACTURA=true después de la prueba de $1 con Guido (gas/PruebaPagoEnFactura.gs).
 */
export function itemPagoEnFactura(args: { cuentaOrigen: Ref; importe: number; descripcion: string; cheque?: { numero: string; vencimiento: string } }) {
  return {
    transaccionid: 0,
    itemId: 0,
    cuentaTipo: String(tipoCuentaPara(args.cuentaOrigen.nombre, !!args.cheque)),
    cuentaId: args.cuentaOrigen.ID,
    moneda: MONEDA_ARS,
    cotizacionMonTransaccion: 1,
    importeMonPrincipal: args.importe,
    importeMonTransaccion: args.importe,
    ...(args.cheque ? { chequePropios: args.cheque.numero, fechaVto: args.cheque.vencimiento } : {}),
    descripcion: args.descripcion,
  }
}

/** El id que devuelve Xubio al crear un comprobante, o '' si no vino ninguno. */
export function idCreado(body: unknown): string {
  const b = body as { transaccionid?: number; transaccionId?: number; ID?: number; id?: number } | null
  const n = b?.transaccionid ?? b?.transaccionId ?? b?.ID ?? b?.id
  return n != null && Number(n) > 0 ? String(n) : ''
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Proveedor de Xubio: por CUIT; si no, por nombre exacto. Nunca por parecido (Code.gs sí lo hacía). */
export function elegirProveedor(lista: Record<string, unknown>[], cuit: string, nombre: string): Ref | null {
  const c = cuit.replace(/\D/g, '')
  const cuitDe = (p: Record<string, unknown>) =>
    String(p.CUIT ?? p.cuit ?? (p.identificacionTributaria as { numero?: string } | undefined)?.numero ?? '').replace(/\D/g, '')
  const hit = lista.find((p) => c.length === 11 && cuitDe(p) === c) ?? lista.find((p) => norm(String(p.nombre ?? '')) === norm(nombre))
  if (!hit) return null
  const id = Number(hit.proveedorid ?? hit.ID ?? hit.id)
  return { ID: id, id, nombre: String(hit.nombre ?? nombre), codigo: String(hit.codigo ?? '') }
}

/** Producto de compra: el código recordado para el proveedor; si no, el que se llama como la cuenta contable. */
export function elegirProducto(lista: Record<string, unknown>[], codigo: string | null | undefined, cuentaContable: string | null | undefined): Ref | null {
  const ref = (p: Record<string, unknown>): Ref => {
    const id = Number(p.productoid ?? p.ID ?? p.id ?? 0)
    return { ID: id, id, nombre: String(p.nombre ?? ''), codigo: String(p.codigo ?? '') }
  }
  if (codigo) {
    const porCodigo = lista.find((p) => String(p.codigo ?? '').trim().toLowerCase() === codigo.trim().toLowerCase())
    if (porCodigo) return ref(porCodigo)
  }
  if (cuentaContable) {
    const porNombre = lista.find((p) => norm(String(p.nombre ?? '')) === norm(cuentaContable))
    if (porNombre) return ref(porNombre)
  }
  return null
}

/** ¿Ya existe en Xubio una factura con este número para este proveedor? (comprobanteYaExiste_ de Code.gs) */
export function facturaYaExiste(lista: Record<string, unknown>[], numeroDoc: string, proveedorId: number): string | null {
  const hit = lista.find((c) => {
    const nd = String(c.numeroDocumento ?? '').trim().toUpperCase()
    const p = c.proveedor as { ID?: number; id?: number } | undefined
    return nd === numeroDoc.toUpperCase() && (!p || Number(p.ID ?? p.id) === proveedorId)
  })
  return hit ? idCreado(hit) || 'EXISTENTE' : null
}
