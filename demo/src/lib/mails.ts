// Mails a proveedores (MailsProveedores.gs de "facturas automatizadas", v6 del 11/11/2026).
// El sistema NO envía: arma destinatario, asunto y texto, y Tesorería lo abre en SU Gmail para revisarlo.
//  - Remitente: Droguería Robles y Héctor Robles → casilla de Tesorería de Robles; el resto → tesoreria@.
//  - Un mail por proveedor (y remitente y empresa). Primero las facturas, cada una con su monto y las NC
//    aplicadas; después los pagos UNA sola vez: un cheque que pagó varias facturas aparece con su total y,
//    si también pagó facturas que no se eligieron, se aclara. Las NC sueltas van como "Nota de Crédito".
//  - Comprobantes: como link en el texto (Gmail no deja adjuntar archivos desde otra página).

import type { Empresa, Factura, Pago, Proveedor } from '../types'

export const REMITENTE_TESORERIA = 'tesoreria@verticebi.com'
export const REMITENTE_TESORERIA_ROBLES = 'viviana.marzioni@drogueriarobles.com.ar'

const NOMBRE_EMPRESA_MAIL: Record<string, string> = {
  beratung: 'Beratung S.A.',
  india: 'India ADV S.A.',
  controlb: 'Control B S.A.',
  ysd: 'YSD Pharma S.A.',
  vertice: 'Vértice BI S.A.',
  robles: 'Droguería Robles S.A.',
  hrobles: 'Hector Robles S.H.',
  farmacontrol: 'Farma Control S.A.',
}

export function remitentePara(empresaId: string): string {
  return empresaId === 'robles' || empresaId === 'hrobles' ? REMITENTE_TESORERIA_ROBLES : REMITENTE_TESORERIA
}

export function nombreEmpresaMail(e: Pick<Empresa, 'id' | 'nombre'>): string {
  return NOMBRE_EMPRESA_MAIL[e.id] ?? e.nombre
}

/** $ 1.234,56 */
export function pesosMail(n: number): string {
  const [ent, dec] = Math.abs(n).toFixed(2).split('.')
  return `${n < 0 ? '-' : ''}$ ${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

/** aaaa-mm-dd → dd/mm/aaaa */
export function fechaMail(iso?: string): string {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? '')
}

const esNc = (f: Factura) => /nota de cr/i.test(f.tipo)
const nroFactura = (f: Factura) => `${String(f.puntoVenta).padStart(5, '0')}-${String(f.numero).padStart(8, '0')}`

export interface MailProveedor {
  clave: string
  proveedorId: string
  proveedor: string
  cuit: string
  to: string
  from: string
  empresa: string
  subject: string
  body: string
  facturaIds: string[]
  sinComprobante: boolean
}

export interface EntradaMails {
  /** Facturas elegidas (pagadas, o NC). */
  facturas: Factura[]
  /** Todas las facturas (para nombrar las que un cheque también canceló y las NC aplicadas). */
  todas: Factura[]
  pagos: Pago[]
  proveedores: Proveedor[]
  empresas: Empresa[]
  /** NC aplicadas a cada factura: facturaId → [{ ncId, importe }]. */
  ncAplicadas: Record<string, { ncId: string; importe: number }[]>
  /** Link del comprobante de cada pago (Drive o enlace firmado). */
  links: Record<string, string | null | undefined>
}

export function armarMails(e: EntradaMails): MailProveedor[] {
  const vivos = e.pagos.filter((p) => p.estado !== 'ANULADO')
  type Grupo = { proveedorId: string; proveedor: string; cuit: string; to: string; from: string; empresa: string; docs: Factura[]; pagos: Map<string, Pago>; links: string[] }
  const grupos = new Map<string, Grupo>()
  for (const f of e.facturas) {
    const prov = e.proveedores.find((p) => p.id === f.proveedorId)
    const emp = e.empresas.find((x) => x.id === f.empresaId) ?? { id: f.empresaId, nombre: f.empresaId }
    const to = prov?.email?.trim() ?? ''
    const from = remitentePara(f.empresaId)
    const empresa = nombreEmpresaMail(emp)
    const clave = `${to || 'SIN_MAIL:' + (prov?.cuit || f.proveedorId)}|${from}|${empresa}`
    const g: Grupo = grupos.get(clave) ?? { proveedorId: f.proveedorId, proveedor: prov?.nombre ?? '', cuit: prov?.cuit ?? '', to, from, empresa, docs: [], pagos: new Map<string, Pago>(), links: [] }
    grupos.set(clave, g)
    g.docs.push(f)
    if (!esNc(f)) for (const p of vivos.filter((p) => p.facturaIds.includes(f.id))) g.pagos.set(p.id, p)
  }
  const out: MailProveedor[] = []
  for (const [clave, g] of grupos) {
    const enMail = new Set(g.docs.map((d) => d.id))
    const ncAplicadasEnMail = new Set(g.docs.flatMap((d) => (e.ncAplicadas[d.id] ?? []).map((n) => n.ncId)))
    const lineasDocs: string[] = []
    for (const d of g.docs.filter((d) => !esNc(d))) {
      lineasDocs.push(`• Factura N° ${nroFactura(d)} · ${pesosMail(d.total)}`)
      for (const n of e.ncAplicadas[d.id] ?? []) {
        const nc = e.todas.find((x) => x.id === n.ncId)
        lineasDocs.push(`  Nota de Crédito N° ${nc ? nroFactura(nc) : n.ncId} aplicada · -${pesosMail(n.importe)}`)
      }
    }
    for (const d of g.docs.filter((d) => esNc(d) && !ncAplicadasEnMail.has(d.id))) lineasDocs.push(`• Nota de Crédito N° ${nroFactura(d)} · -${pesosMail(d.total)}`)

    const lineasPagos: string[] = []
    const vistos = new Set<string>()
    const addLink = (u?: string | null) => { if (u && !g.links.includes(u)) g.links.push(u) }
    for (const p of g.pagos.values()) {
      addLink(e.links[p.id])
      if (p.numeroCheque) {
        const banco = p.bancoOrigen || p.cuentaOrigen || ''
        const k = `${p.numeroCheque}|${banco}|${p.proveedorId ?? ''}|${p.empresaId}`
        if (vistos.has(k)) continue
        vistos.add(k)
        // El total del cheque: todos sus pagos (del mismo proveedor y banco), aunque hayan quedado partidos
        const mismos = vivos.filter((q) => q.numeroCheque === p.numeroCheque && (q.bancoOrigen || q.cuentaOrigen || '') === banco && q.proveedorId === p.proveedorId && q.empresaId === p.empresaId)
        mismos.forEach((q) => addLink(e.links[q.id]))
        const total = mismos.reduce((s, q) => s + q.importe, 0)
        const otras = [...new Set(mismos.flatMap((q) => q.facturaIds).filter((id) => !enMail.has(id)))]
          .map((id) => e.todas.find((x) => x.id === id))
          .filter((x): x is Factura => !!x)
          .map(nroFactura)
        const tipo = (p.tipoCheque ?? '').toUpperCase() === 'PAGARE' ? 'Pagaré N° ' : p.medio === 'ECHEQ' || (p.tipoCheque ?? '').toUpperCase() === 'ECHEQ' ? 'E-cheq N° ' : 'Cheque N° '
        lineasPagos.push(
          `• ${tipo}${p.numeroCheque}${banco ? ` · ${banco}` : ''}${p.fechaAcreditacion ? ` · fecha de cobro ${fechaMail(p.fechaAcreditacion)}` : ''} · ${pesosMail(total)}` +
            (otras.length ? ` (también cancela ${otras.length === 1 ? 'la Factura N° ' : 'las Facturas N° '}${otras.join(', ')})` : ''),
        )
      } else {
        const banco = p.bancoOrigen || p.cuentaOrigen || ''
        lineasPagos.push(`• ${banco ? `Transferencia · ${banco}` : 'Pago'}${p.fecha ? ` · ${fechaMail(p.fecha)}` : ''} · ${pesosMail(p.importe)}`)
      }
    }
    const facturasSinNc = g.docs.filter((d) => !esNc(d))
    const nFact = facturasSinNc.length || g.docs.length
    const provAsunto = g.proveedor ? `${g.proveedor} — ` : ''
    const subject = nFact === 1 ? `Comprobante de pago — ${provAsunto}Factura N° ${nroFactura(facturasSinNc[0] ?? g.docs[0])}` : `Comprobantes de pago — ${provAsunto}${nFact} facturas`
    const body =
      'Estimado/a,\n\n' +
      `Les informamos ${lineasPagos.length > 1 ? 'los pagos realizados' : 'el pago realizado'} por ${g.empresa}:\n\n` +
      lineasDocs.join('\n') + '\n\n' +
      (lineasPagos.length ? `${lineasPagos.length === 1 ? 'Pago:' : 'Pagos:'}\n${lineasPagos.join('\n')}\n\n` : '') +
      (g.links.length ? (g.links.length === 1 ? 'Comprobante de pago: ' : 'Comprobantes de pago:\n') + g.links.join('\n') + '\n\n' : '') +
      `Saludos cordiales,\nTesorería · ${g.empresa}`
    out.push({ clave, proveedorId: g.proveedorId, proveedor: g.proveedor, cuit: g.cuit, to: g.to, from: g.from, empresa: g.empresa, subject, body, facturaIds: g.docs.map((d) => d.id), sinComprobante: g.links.length === 0 })
  }
  return out
}

/** Link para abrir el borrador en Gmail, en la cuenta del remitente. */
export function linkGmail(m: Pick<MailProveedor, 'from' | 'to' | 'subject' | 'body'>, to = m.to): string {
  const q = new URLSearchParams({ authuser: m.from, view: 'cm', fs: '1', to, su: m.subject, body: m.body })
  return `https://mail.google.com/mail/?${q.toString()}`
}
