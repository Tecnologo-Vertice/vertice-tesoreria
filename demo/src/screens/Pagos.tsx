import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { Badge, BadgeVencimiento, Btn, Desplegable, Empty, Field, inputCls, Modal, SelectorCuenta, Tabs } from '../components/ui'
import { cuentasOrigenDe, cuentasPara, enLista } from '../lib/cuentas'
import { useFiltro } from '../components/Filtros'
import { ModalFormaPago, etiquetaFormaPago } from '../components/Tesoreria'
import { addDays, diasHasta, fecha, fmtCuit, iso, money, nroComprobante, parseIso, pendiente } from '../lib/format'
import { formaDeCarga, sugerirCuenta, type Sugerencia } from '../lib/ia'
import { puede } from '../lib/permisos'
import { armarMails, linkGmail, type MailProveedor } from '../lib/mails'
import { esperaFactura, faltaComprobante } from '../lib/pagos'
import type { ProyeccionParaPago } from '../data/fuente'
import type { ComprobanteEjemplo, EstadoXubio, Factura, LecturaComprobante, MetodoPago, Pago } from '../types'

const ESTADO_XUBIO: Record<EstadoXubio, { label: string; tone: 'verde' | 'rojo' | 'naranja' | 'neutro' }> = {
  SUBIDA: { label: 'En Xubio', tone: 'verde' },
  ERROR: { label: 'Error Xubio', tone: 'rojo' },
  PENDIENTE: { label: 'Falta subir a Xubio', tone: 'naranja' },
  SIN_ERP: { label: 'Sin ERP', tone: 'neutro' },
  PENDIENTE_RALPHARMA: { label: 'Pend. Ralpharma', tone: 'naranja' },
  CARGADA_RALPHARMA: { label: 'En Ralpharma', tone: 'verde' },
}

/** Nombre de banco comparable: sin tildes, mayúsculas ni signos. */
const normal = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export function Pagos() {
  const { modo, facturas, pagos, proveedor, empresa, usuario, subirFacturaXubio } = useStore()
  const puedePagar = puede(usuario.rol, 'PAGAR')
  const puedeXubio = puede(usuario.rol, 'APROBAR')
  const { quitarComprobantePago } = useStore()
  const [tab, setTab] = useState<'PARA_PAGAR' | 'PAGADAS' | 'SIN_FACTURA' | 'FALTA_COMPROBANTE'>('PARA_PAGAR')
  const [vincular, setVincular] = useState<null | { pagoId?: string; facturaId?: string }>(null)
  const [corregir, setCorregir] = useState<Pago | null>(null)
  const [adjuntar, setAdjuntar] = useState<Pago | null>(null)
  const [sel, setSel] = useState<string[]>([])
  const [modal, setModal] = useState<null | { facturaIds: string[] }>(null)
  const [ncModal, setNcModal] = useState<string | null>(null)
  const [selPagadas, setSelPagadas] = useState<string[]>([])
  const [mailsModal, setMailsModal] = useState<string[] | null>(null)
  const [formaPago, setFormaPago] = useState<Factura | null>(null)

  const paraPagar = useMemo(
    () => facturas.filter((f) => f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL').sort((a, b) => diasHasta(a.vencimiento) - diasHasta(b.vencimiento)),
    [facturas],
  )
  const pagadas = useMemo(() => facturas.filter((f) => f.estado === 'PAGADA'), [facturas])
  // Pagos que esperan su factura (ESPERA_FC), del más viejo al más nuevo.
  const sinFactura = useMemo(() => pagos.filter(esperaFactura).sort((a, b) => a.cargadoEn.localeCompare(b.cargadoEn)), [pagos])
  // "Ya pagada, falta comprobante": facturas marcadas sin pago todavía, y pagos que Administración registró al aprobar sin comprobante.
  const yaPagadasSinPago = useMemo(() => facturas.filter((f) => f.estado === 'PARA_PAGAR' && f.yaPagadaSegunAdmin), [facturas])
  const pagosFaltaComprobante = useMemo(() => pagos.filter(faltaComprobante), [pagos])
  const nFaltaComprobante = yaPagadasSinPago.length + pagosFaltaComprobante.length

  const filtro = useFiltro(tab === 'PARA_PAGAR' ? paraPagar : pagadas, {
    clave: 'pagos',
    texto: (f) => {
      const p = proveedor(f.proveedorId)
      return [p?.nombre, p?.cuit, f.tipo, nroComprobante(f.puntoVenta, f.numero), f.cae, f.cuentaContable, f.metodoPago, empresa(f.empresaId).nombre, f.total.toFixed(2)].join(' ')
    },
    empresa: (f) => f.empresaId,
    proveedor: (f) => proveedor(f.proveedorId)?.nombre ?? '',
    cuenta: (f) => f.cuentaContable,
    // Para Tesorería, "nueva" es la que se aprobó desde la última visita.
    alta: (f) => f.aprobadoEn ?? f.creadoEn ?? f.fecha,
    vencimiento: (f) => f.vencimiento,
    importe: (f) => pendiente(f),
    ordenInicial: 'VENCIMIENTO',
  })

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const empresaSel = sel.length ? facturas.find((f) => f.id === sel[0])?.empresaId : undefined

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Pagos</h2>
          <p className="text-sm text-seco">Vivi sube el comprobante, la IA lo lee y el pago queda vinculado a su factura. Nada se tipea dos veces.</p>
        </div>
        {puedePagar ? (
          <div className="flex gap-2">
            <Btn variant="secundario" onClick={() => setModal({ facturaIds: [] })}>
              Pago sin factura
            </Btn>
            <Btn disabled={sel.length === 0} onClick={() => setModal({ facturaIds: sel })}>
              Pagar {sel.length > 1 ? `${sel.length} seleccionadas` : 'seleccionada'}
            </Btn>
          </div>
        ) : (
          <p className="text-xs text-seco">Solo consulta: los pagos los carga Tesorería.</p>
        )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'PARA_PAGAR', label: 'Para pagar', n: paraPagar.length },
          { id: 'PAGADAS', label: 'Pagadas', n: pagadas.length },
          { id: 'SIN_FACTURA', label: 'Sin factura', n: sinFactura.length, tone: sinFactura.length ? 'naranja' : undefined },
          { id: 'FALTA_COMPROBANTE', label: 'Falta comprobante', n: nFaltaComprobante, tone: nFaltaComprobante ? 'naranja' : undefined },
        ]}
      />

      {tab === 'PARA_PAGAR' && (
        <div className="space-y-2">
          {paraPagar.length > 0 && filtro.barra}
          {paraPagar.length === 0 && <Empty texto="No hay facturas para pagar." />}
          {paraPagar.length > 0 && filtro.visibles.length === 0 && <Empty texto="Nada coincide con la búsqueda o los filtros." />}
          {filtro.visibles.map((f) => {
            const p = proveedor(f.proveedorId)
            const e = empresa(f.empresaId)
            const marcada = sel.includes(f.id)
            const esNc = esNotaCredito(f)
            const otraEmpresa = esNc || (empresaSel !== undefined && empresaSel !== f.empresaId)
            const xubio = ESTADO_XUBIO[f.estadoXubio] ?? { label: f.estadoXubio, tone: 'neutro' as const }
            return (
              <div
                key={f.id}
                onClick={() => puedePagar && !otraEmpresa && toggle(f.id)}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors ${puedePagar && !esNc ? 'cursor-pointer' : ''} ${marcada ? 'border-dorado bg-dorado/10' : 'border-borde bg-pino hover:bg-suave/60'} ${otraEmpresa && !esNc ? 'opacity-40 cursor-not-allowed' : ''}`}
                title={esNc ? 'Una nota de crédito no se paga: se aplica a una factura' : otraEmpresa ? 'Un pago agrupa facturas de una sola empresa' : ''}
              >
                {puedePagar && !esNc && <input type="checkbox" readOnly checked={marcada} className="accent-dorado w-4 h-4" />}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    {filtro.esNueva(f) && <Badge tone="azul">Nueva</Badge>}
                    <Badge tone="dorado">{e.corto}</Badge>
                    <BadgeVencimiento vencimiento={f.vencimiento} />
                    <Badge tone={xubio.tone}>{xubio.label}</Badge>
                    {f.pagadoPct > 0 && !esNc && <Badge tone="azul">{f.pagadoPct}% pagado</Badge>}
                    {esNc && <Badge tone="verde">Nota de crédito · saldo {money(f.saldoNc ?? f.total)}</Badge>}
                    {f.yaPagadaSegunAdmin && <Badge tone="naranja" title={f.yaPagadaSegunAdmin}>Ya pagada: falta el comprobante</Badge>}
                    {etiquetaFormaPago(f) && <Badge tone="azul">{etiquetaFormaPago(f)}</Badge>}
                  </div>
                  <p className="font-semibold truncate">{p?.nombre ?? f.proveedorId}</p>
                  <p className="text-xs text-seco">
                    {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · {f.metodoPago} · {f.cuentaContable}
                  </p>
                  {f.xubioError && <p className="text-[0.6875rem] text-red-300 mt-0.5">Xubio: {f.xubioError}</p>}
                  {esNc && puedePagar && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setNcModal(f.id)
                      }}
                      className="text-[0.6875rem] text-acento underline mt-0.5 mr-3"
                    >
                      Aplicar a una factura
                    </button>
                  )}
                  {!esNc && puedePagar && sinFactura.some((x) => x.empresaId === f.empresaId && x.proveedorId === f.proveedorId) && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setVincular({ facturaId: f.id })
                      }}
                      className="text-[0.6875rem] text-acento underline mt-0.5 mr-3"
                    >
                      Vincular pago sin factura
                    </button>
                  )}
                  {!esNc && puedePagar && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setFormaPago(f)
                      }}
                      className="text-[0.6875rem] text-acento underline mt-0.5 mr-3"
                    >
                      Forma de pago
                    </button>
                  )}
                  {puedeXubio && e.erp === 'XUBIO' && (f.estadoXubio === 'PENDIENTE' || f.estadoXubio === 'ERROR') && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void subirFacturaXubio(f.id)
                      }}
                      className="text-[0.6875rem] text-acento underline mt-0.5"
                    >
                      {f.estadoXubio === 'ERROR' ? 'Reintentar subida a Xubio' : modo === 'demo' ? 'Subir a Xubio (simulado)' : 'Subir a Xubio'}
                    </button>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-serif text-xl">{money(esNc ? (f.saldoNc ?? f.total) : pendiente(f))}</p>
                  <p className="text-[0.625rem] text-seco">vence {fecha(f.vencimiento)}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'PAGADAS' && (
        <div className="space-y-2">
          {pagadas.length > 0 && filtro.barra}
          {puedePagar && pagadas.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-seco">Marcá las facturas pagadas para armar los mails a los proveedores. El sistema no los envía: se abren en tu Gmail.</p>
              <Btn disabled={selPagadas.length === 0} onClick={() => setMailsModal(selPagadas)}>
                Preparar mails{selPagadas.length ? ` (${selPagadas.length})` : ''}
              </Btn>
            </div>
          )}
          {pagadas.length === 0 && <Empty texto="Todavía no hay facturas pagadas." />}
          {pagadas.length > 0 && filtro.visibles.length === 0 && <Empty texto="Nada coincide con la búsqueda o los filtros." />}
          {filtro.visibles.map((f) => {
            const p = proveedor(f.proveedorId)
            const pg = pagos.find((x) => x.facturaIds.includes(f.id) && x.estado !== 'ANULADO')
            const marcadaMail = selPagadas.includes(f.id)
            return (
              <div
                key={f.id}
                onClick={() => puedePagar && setSelPagadas((s) => (s.includes(f.id) ? s.filter((x) => x !== f.id) : [...s, f.id]))}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl border ${puedePagar ? 'cursor-pointer' : ''} ${marcadaMail ? 'border-dorado bg-dorado/10' : 'border-borde bg-pino'}`}
              >
                {puedePagar && <input type="checkbox" readOnly checked={marcadaMail} className="accent-dorado w-4 h-4" aria-label="Elegir para el mail" />}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <Badge tone="dorado">{empresa(f.empresaId).corto}</Badge>
                    <Badge tone="verde">Pagada</Badge>
                    {!pg ? <Badge tone="azul">Tarjeta de crédito</Badge> : pg.estado === 'CONTABILIZADO' ? <Badge tone="verde">Contabilizada {pg.xubioId}</Badge> : <Badge tone="naranja">Para contabilizar</Badge>}
                    {f.mailEnviado ? <Badge tone="azul" title={f.mailEnviado}>Mail preparado</Badge> : pg?.mailProveedorEnviado && <Badge tone="azul">Mail al proveedor</Badge>}
                  </div>
                  <p className="font-semibold truncate">{p?.nombre ?? f.proveedorId}</p>
                  <p className="text-xs text-seco">
                    {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} ·{' '}
                    {pg ? `pagada el ${fecha(pg.fecha)} por ${pg.cargadoPor} · ${pg.medio}` : `Tarjeta de crédito · pagada el ${fecha(f.fechaPago)}`}
                  </p>
                  {puedePagar && pg && (
                    <div className="flex flex-wrap gap-3 mt-0.5 text-[0.6875rem]">
                      <button
                        className="text-acento underline"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          setAdjuntar(pg)
                        }}
                      >
                        {pg.comprobante || pg.comprobanteUrl ? 'Cambiar comprobante' : 'Adjuntar comprobante'}
                      </button>
                      {pg.comprobante && (
                        <button
                          className="text-red-300 underline"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            if (window.confirm('¿Quitar el comprobante de este pago? El archivo no se borra, pero el pago queda sin comprobante.')) void quitarComprobantePago(pg.id)
                          }}
                        >
                          Quitar comprobante
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <p className="font-serif text-xl">{money(f.total)}</p>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'SIN_FACTURA' && (
        <div className="space-y-2">
          <p className="text-xs text-seco">
            Pagos a un proveedor que todavía no tiene factura. Cuando llega la factura se vinculan solos al aprobarla (si hay uno solo) o desde acá: la factura baja por lo pagado.
          </p>
          {sinFactura.length === 0 && <Empty texto="No hay pagos esperando factura." />}
          {sinFactura.map((p) => {
            const prov = proveedor(p.proveedorId)
            const dias = Math.max(0, Math.floor((Date.now() - new Date(p.cargadoEn).getTime()) / 86400000))
            return (
              <div key={p.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border border-borde bg-pino">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <Badge tone="dorado">{empresa(p.empresaId).corto}</Badge>
                    <Badge tone="naranja">
                      Espera factura · {dias} día{dias === 1 ? '' : 's'}
                    </Badge>
                    <Badge>{p.medio}</Badge>
                    {p.gestion === 'HOJA' && <Badge title="Viene de la hoja del Apps Script: se vincula y se corrige allá.">De la hoja</Badge>}
                    {p.posibleDuplicado && (
                      <Badge tone="rojo" title={p.posibleDuplicado}>
                        Posible duplicado
                      </Badge>
                    )}
                  </div>
                  <p className="font-semibold truncate">{prov?.nombre ?? p.proveedorDestino ?? 'Sin proveedor'}</p>
                  <p className="text-xs text-seco">
                    {fecha(p.fecha)} · {p.cuentaOrigen || 'sin cuenta de origen'}
                    {p.numeroCheque ? ` · cheque ${p.numeroCheque}` : ''}
                    {p.estado === 'CONTABILIZADO' ? ' · ya en Xubio' : ''}
                  </p>
                  {puedePagar && p.gestion !== 'HOJA' && (
                    <div className="flex flex-wrap gap-3 mt-0.5 text-[0.6875rem]">
                      <button className="text-acento underline" onClick={() => setVincular({ pagoId: p.id })}>
                        Vincular a una factura
                      </button>
                      <button className="text-acento underline" onClick={() => setCorregir(p)}>
                        Corregir proveedor
                      </button>
                    </div>
                  )}
                </div>
                <p className="font-serif text-xl">{money(p.importe)}</p>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'FALTA_COMPROBANTE' && (
        <div className="space-y-2">
          <p className="text-xs text-seco">Facturas que Administración aprobó diciendo que ya estaban pagadas y a las que todavía les falta el comprobante del pago. Se completan sin crear otro pago.</p>
          {nFaltaComprobante === 0 && <Empty texto="No hay pagos esperando comprobante." />}
          {yaPagadasSinPago.map((fa) => (
            <div key={fa.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border border-borde bg-pino">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-0.5">
                  <Badge tone="dorado">{empresa(fa.empresaId).corto}</Badge>
                  <Badge tone="naranja">Falta el banco y el comprobante</Badge>
                </div>
                <p className="font-semibold truncate">{proveedor(fa.proveedorId)?.nombre ?? fa.proveedorId}</p>
                <p className="text-xs text-seco">
                  {fa.tipo} {nroComprobante(fa.puntoVenta, fa.numero)} · {fa.yaPagadaSegunAdmin}
                </p>
                {puedePagar && (
                  <button className="text-[0.6875rem] text-acento underline mt-0.5" onClick={() => setModal({ facturaIds: [fa.id] })}>
                    Cargar el pago con su comprobante
                  </button>
                )}
              </div>
              <p className="font-serif text-xl">{money(pendiente(fa))}</p>
            </div>
          ))}
          {pagosFaltaComprobante.map((p) => (
            <div key={p.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border border-borde bg-pino">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-0.5">
                  <Badge tone="dorado">{empresa(p.empresaId).corto}</Badge>
                  <Badge tone="naranja">{p.cuentaOrigen ? 'Falta el comprobante' : 'Falta el banco y el comprobante'}</Badge>
                  <Badge>{p.medio}</Badge>
                  {p.estado === 'CONTABILIZADO' && <Badge tone="verde">Ya en Xubio</Badge>}
                </div>
                <p className="font-semibold truncate">{proveedor(p.proveedorId)?.nombre ?? p.proveedorDestino ?? 'Sin proveedor'}</p>
                <p className="text-xs text-seco">
                  {p.descripcion} · pagado el {fecha(p.fecha)}
                  {p.cuentaOrigen ? ` · ${p.cuentaOrigen}` : ''}
                </p>
                {puedePagar && (
                  <button className="text-[0.6875rem] text-acento underline mt-0.5" onClick={() => setAdjuntar(p)}>
                    Adjuntar el comprobante
                  </button>
                )}
              </div>
              <p className="font-serif text-xl">{money(p.importe)}</p>
            </div>
          ))}
        </div>
      )}

      {vincular && <ModalVincular pagoId={vincular.pagoId} facturaId={vincular.facturaId} onClose={() => setVincular(null)} />}
      {corregir && <ModalCorregirProveedor pago={corregir} onClose={() => setCorregir(null)} />}
      {adjuntar && <ModalAdjuntarComprobante pago={adjuntar} onClose={() => setAdjuntar(null)} />}
      {formaPago && <ModalFormaPago factura={formaPago} onClose={() => setFormaPago(null)} />}
      {ncModal && <ModalAplicarNc ncId={ncModal} onClose={() => setNcModal(null)} />}
      {mailsModal && (
        <ModalMails
          facturaIds={mailsModal}
          onClose={() => {
            setMailsModal(null)
            setSelPagadas([])
          }}
        />
      )}

      {modal && (
        <ModalCargarPago
          facturaIds={modal.facturaIds}
          onClose={() => {
            setModal(null)
            setSel([])
          }}
        />
      )}
    </div>
  )
}

const esNotaCredito = (f: Factura) => f.tipo.startsWith('Nota de Cr')

/** Mails a proveedores (MailsProveedores.gs): uno por proveedor, se abren en el Gmail de Tesorería. */
function ModalMails({ facturaIds, onClose }: { facturaIds: string[]; onClose: () => void }) {
  const { facturas, pagos, catalogos, linksComprobantes, guardarEmailProveedor, marcarMailPreparado } = useStore()
  const [mails, setMails] = useState<MailProveedor[] | null>(null)
  const [para, setPara] = useState<Record<string, string>>({})
  const [abiertos, setAbiertos] = useState<string[]>([])
  useEffect(() => {
    let vivo = true
    const elegidas = facturas.filter((f) => facturaIds.includes(f.id))
    const directos = pagos.filter((p) => p.estado !== 'ANULADO' && p.facturaIds.some((id) => facturaIds.includes(id)))
    const cheques = new Set(directos.map((p) => p.numeroCheque).filter(Boolean))
    const involucrados = pagos.filter((p) => p.estado !== 'ANULADO' && (directos.includes(p) || (p.numeroCheque && cheques.has(p.numeroCheque))))
    void linksComprobantes(involucrados).then((links) => {
      if (!vivo) return
      const ncAplicadas = Object.fromEntries(facturas.filter((f) => f.ncAplicadas?.length).map((f) => [f.id, f.ncAplicadas!]))
      const m = armarMails({ facturas: elegidas, todas: facturas, pagos, proveedores: catalogos.proveedores, empresas: catalogos.empresas, ncAplicadas, links })
      setMails(m)
      setPara(Object.fromEntries(m.map((x) => [x.clave, x.to])))
    })
    return () => {
      vivo = false
    }
    // Se arma una vez al abrir: si se recargan los datos (al guardar un mail), no se pierde lo escrito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Modal titulo="Mails a proveedores" onClose={onClose} ancho="max-w-3xl">
      {!mails ? (
        <p className="text-sm text-seco">Armando los mails…</p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-seco">
            {mails.length} mail{mails.length === 1 ? '' : 's'}. Revisá cada uno y tocá "Abrir en Gmail": se abre el borrador en la cuenta del remitente y queda registrado como preparado. El envío lo hacés vos desde Gmail.
          </p>
          {mails.map((m) => {
            const to = para[m.clave] ?? ''
            const cambio = to.trim() !== m.to
            const valido = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim())
            const hecho = abiertos.includes(m.clave)
            return (
              <div key={m.clave} className={`rounded-xl border p-4 space-y-3 ${hecho ? 'border-dorado/60' : 'border-borde'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{m.proveedor || 'Proveedor sin nombre'}</p>
                  <Badge tone="dorado">{m.empresa}</Badge>
                  {m.sinComprobante && <Badge tone="naranja">Sin comprobante adjunto</Badge>}
                  {hecho && <Badge tone="verde">Abierto en Gmail</Badge>}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Para" marcado={valido ? undefined : 'falta'} hint={m.to ? undefined : 'No hay mail de este proveedor: escribilo y queda guardado'}>
                    <div className="flex gap-2">
                      <input id={`para-${m.clave}`} value={to} onChange={(ev) => setPara((p) => ({ ...p, [m.clave]: ev.target.value }))} className={inputCls} placeholder="mail@proveedor.com" />
                      {cambio && valido && (
                        <Btn variant="secundario" onClick={() => void guardarEmailProveedor(m.proveedorId, to.trim())}>
                          Guardar
                        </Btn>
                      )}
                    </div>
                  </Field>
                  <Field label="De">
                    <p className="text-sm py-2">{m.from}</p>
                  </Field>
                </div>
                <Field label="Asunto">
                  <p className="text-sm">{m.subject}</p>
                </Field>
                <pre className="text-[0.8125rem] whitespace-pre-wrap rounded-lg bg-suave/50 p-3 max-h-64 overflow-auto font-sans">{m.body}</pre>
                <div className="flex justify-end">
                  {valido ? (
                    <a
                      href={linkGmail(m, to.trim())}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => {
                        setAbiertos((a) => (a.includes(m.clave) ? a : [...a, m.clave]))
                        void marcarMailPreparado(m.facturaIds)
                      }}
                      className="inline-flex items-center h-10 px-4 rounded-xl bg-dorado text-pino font-bold text-sm hover:opacity-90"
                    >
                      Abrir en Gmail
                    </a>
                  ) : (
                    <p className="text-xs text-red-300">Falta el mail del proveedor</p>
                  )}
                </div>
              </div>
            )
          })}
          <div className="flex justify-end">
            <Btn variant="fantasma" onClick={onClose}>
              Cerrar
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** Aplicar una nota de crédito (aplicarNotaCreditoAFactura del Apps Script): mismo proveedor y empresa. */
function ModalAplicarNc({ ncId, onClose }: { ncId: string; onClose: () => void }) {
  const { facturas, proveedor, aplicarNotaCredito } = useStore()
  const nc = facturas.find((f) => f.id === ncId)
  const candidatas = facturas.filter(
    (f) => nc && f.id !== nc.id && !esNotaCredito(f) && f.empresaId === nc.empresaId && f.proveedorId === nc.proveedorId && (f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL'),
  )
  const [facturaId, setFacturaId] = useState(candidatas[0]?.id ?? '')
  const saldo = nc ? (nc.saldoNc ?? nc.total) : 0
  const destino = candidatas.find((f) => f.id === facturaId)
  const tope = destino ? Math.min(saldo, pendiente(destino)) : saldo
  const [importe, setImporte] = useState(tope)
  const [guardando, setGuardando] = useState(false)
  if (!nc) return null
  const excede = importe > tope + 0.001
  return (
    <Modal titulo="Aplicar nota de crédito" onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-seco">
          {proveedor(nc.proveedorId)?.nombre} · NC {nroComprobante(nc.puntoVenta, nc.numero)} · saldo {money(saldo)}
        </p>
        {candidatas.length === 0 ? (
          <Empty texto="No hay facturas para pagar de este proveedor en esta empresa." />
        ) : (
          <>
            <Field label="Factura">
              <Desplegable
                value={facturaId}
                onChange={(v) => {
                  setFacturaId(v)
                  const f = candidatas.find((x) => x.id === v)
                  if (f) setImporte(Math.min(saldo, pendiente(f)))
                }}
                opciones={candidatas.map((f) => ({ value: f.id, label: `${f.tipo} ${nroComprobante(f.puntoVenta, f.numero)} · pendiente ${money(pendiente(f))}` }))}
              />
            </Field>
            <Field label="Importe a aplicar" hint={`Hasta ${money(tope)}`} marcado={excede ? 'falta' : undefined}>
              <input id="nc-importe" type="number" step="0.01" value={importe} onChange={(ev) => setImporte(Number(ev.target.value))} className={inputCls} />
            </Field>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="fantasma" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!destino || !(importe > 0) || excede || guardando}
            onClick={async () => {
              setGuardando(true)
              const ok = await aplicarNotaCredito(nc.id, facturaId, importe)
              setGuardando(false)
              if (ok) onClose()
            }}
          >
            Aplicar
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/** Vincular un pago sin factura a su factura: se elige la factura (desde el pago) o el pago (desde la factura). */
function ModalVincular({ pagoId, facturaId, onClose }: { pagoId?: string; facturaId?: string; onClose: () => void }) {
  const { facturas, pagos, proveedor, empresa, vincularPagoSinFactura } = useStore()
  const pago = pagos.find((p) => p.id === pagoId)
  const factura = facturas.find((x) => x.id === facturaId)
  const [elegido, setElegido] = useState('')
  const [enviando, setEnviando] = useState(false)
  // Desde el pago: facturas de la misma empresa y proveedor, aprobadas y con saldo. Desde la factura: pagos sin factura del mismo proveedor.
  const facturasPosibles = pago
    ? facturas.filter((f) => f.empresaId === pago.empresaId && (!pago.proveedorId || f.proveedorId === pago.proveedorId) && (f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL') && !esNotaCredito(f) && pendiente(f) > 0.009)
    : []
  const pagosPosibles = factura ? pagos.filter((p) => esperaFactura(p) && p.gestion !== 'HOJA' && p.empresaId === factura.empresaId && p.proveedorId === factura.proveedorId) : []
  const facturaElegida = pago ? facturasPosibles.find((f) => f.id === elegido) : factura
  const pagoElegido = pago ?? pagosPosibles.find((p) => p.id === elegido)
  const sobra = facturaElegida && pagoElegido ? Math.round((pagoElegido.importe - pendiente(facturaElegida)) * 100) / 100 : 0
  const queda = facturaElegida && pagoElegido ? Math.round((pendiente(facturaElegida) - pagoElegido.importe) * 100) / 100 : 0
  async function confirmar() {
    if (!facturaElegida || !pagoElegido) return
    setEnviando(true)
    const ok = await vincularPagoSinFactura(pagoElegido.id, facturaElegida.id)
    setEnviando(false)
    if (ok) onClose()
  }
  return (
    <Modal titulo="Vincular pago sin factura" onClose={onClose} ancho="max-w-xl">
      <div className="space-y-4">
        <div className="rounded-xl border border-borde px-4 py-3 text-sm">
          {pago ? (
            <>
              <p className="font-semibold">
                Pago de {money(pago.importe)} · {fecha(pago.fecha)}
              </p>
              <p className="text-xs text-seco">
                {proveedor(pago.proveedorId)?.nombre ?? pago.proveedorDestino ?? 'Sin proveedor'} · {empresa(pago.empresaId).nombre}
              </p>
            </>
          ) : factura ? (
            <>
              <p className="font-semibold">
                {factura.tipo} {nroComprobante(factura.puntoVenta, factura.numero)} · pendiente {money(pendiente(factura))}
              </p>
              <p className="text-xs text-seco">
                {proveedor(factura.proveedorId)?.nombre} · {empresa(factura.empresaId).nombre}
              </p>
            </>
          ) : null}
        </div>
        <p className="text-xs text-seco">
          {pago ? 'Elegí la factura a la que corresponde.' : 'Elegí el pago que corresponde a esta factura.'} La factura baja por lo pagado y el pago pasa a ser el pago de esa factura; no se crea otro pago ni otro envío a Xubio.
        </p>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-borde divide-y divide-borde/60">
          {pago && facturasPosibles.length === 0 && <p className="p-3 text-xs text-seco">No hay facturas aprobadas de este proveedor con saldo. Cuando llegue y se apruebe, se puede vincular desde acá.</p>}
          {!pago && pagosPosibles.length === 0 && <p className="p-3 text-xs text-seco">No hay pagos sin factura de este proveedor.</p>}
          {pago &&
            facturasPosibles.map((f) => (
              <label key={f.id} className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${elegido === f.id ? 'bg-dorado/10' : 'hover:bg-suave/60'}`}>
                <input type="radio" name="vinculo" checked={elegido === f.id} onChange={() => setElegido(f.id)} className="accent-dorado" />
                <span className="flex-1 truncate">
                  {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · vence {fecha(f.vencimiento)}
                </span>
                <span className="font-semibold">{money(pendiente(f))}</span>
              </label>
            ))}
          {!pago &&
            pagosPosibles.map((p) => (
              <label key={p.id} className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${elegido === p.id ? 'bg-dorado/10' : 'hover:bg-suave/60'}`}>
                <input type="radio" name="vinculo" checked={elegido === p.id} onChange={() => setElegido(p.id)} className="accent-dorado" />
                <span className="flex-1 truncate">
                  {fecha(p.fecha)} · {p.medio} · {p.cuentaOrigen || 'sin cuenta'}
                </span>
                <span className="font-semibold">{money(p.importe)}</span>
              </label>
            ))}
        </div>
        {elegido && sobra >= 1 && <p className="text-xs text-amber-300">El pago es {money(sobra)} mayor que el saldo de la factura: se aplica el saldo y la diferencia queda anotada en el pago.</p>}
        {elegido && queda >= 1 && <p className="text-xs text-seco">Queda un saldo de {money(queda)} por pagar en la factura.</p>}
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn disabled={!facturaElegida || !pagoElegido || enviando} onClick={() => void confirmar()}>
            {enviando ? 'Vinculando…' : 'Vincular'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/** Corregir el proveedor de un pago sin factura que todavía no está en Xubio. */
function ModalCorregirProveedor({ pago, onClose }: { pago: Pago; onClose: () => void }) {
  const { catalogos, proveedor, corregirProveedorPago } = useStore()
  const [provId, setProvId] = useState(pago.proveedorId ?? '')
  const [enviando, setEnviando] = useState(false)
  const yaEnXubio = !['CARGADO', 'REVISADO', 'PENDIENTE_RALPHARMA'].includes(pago.estado) || !!pago.envioXubioEn
  return (
    <Modal titulo="Corregir proveedor del pago" onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm">
          Pago de {money(pago.importe)} del {fecha(pago.fecha)} · hoy figura a nombre de <span className="font-semibold">{proveedor(pago.proveedorId)?.nombre ?? pago.proveedorDestino ?? 'nadie'}</span>.
        </p>
        {yaEnXubio && <p className="text-xs text-red-300">Este pago ya está registrado en Xubio. Si quedó con otro proveedor, primero hay que anular esa orden de pago en Xubio.</p>}
        <Field label="Proveedor correcto">
          <Desplegable
            value={provId}
            onChange={setProvId}
            anchoMenu={320}
            opciones={[{ value: '', label: 'Elegí un proveedor' }, ...catalogos.proveedores.map((p) => ({ value: p.id, label: p.nombre, detalle: p.cuit ? fmtCuit(p.cuit) : undefined }))]}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!provId || provId === pago.proveedorId || yaEnXubio || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await corregirProveedorPago(pago.id, provId)
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Guardar proveedor
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/** Adjuntar (o cambiar) el comprobante de un pago ya cargado. Si el pago no tenía banco, se completa acá. */
function ModalAdjuntarComprobante({ pago, onClose }: { pago: Pago; onClose: () => void }) {
  const { catalogos, adjuntarComprobantePago } = useStore()
  const [archivo, setArchivo] = useState<File | null>(null)
  const [cuenta, setCuenta] = useState('')
  const [enviando, setEnviando] = useState(false)
  const pideBanco = !!pago.faltaComprobante && !pago.cuentaOrigen
  return (
    <Modal titulo={pago.comprobante || pago.comprobanteUrl ? 'Cambiar el comprobante' : 'Adjuntar el comprobante'} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm">
          Pago de {money(pago.importe)} del {fecha(pago.fecha)} · {pago.medio}. No se crea otro pago ni otra orden en Xubio.
        </p>
        <Field label="Comprobante (PDF o captura)" hint="Hasta 4 MB. Si ya tenía uno, se reemplaza.">
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} className={inputCls} aria-label="Comprobante" />
        </Field>
        {pideBanco && (
          <Field label="Banco o cuenta desde la que se pagó" marcado={!cuenta ? 'falta' : undefined}>
            <Desplegable value={cuenta} onChange={setCuenta} anchoMenu={300} opciones={cuentasOrigenDe(catalogos.cuentasOrigen, pago.empresaId).map((c) => ({ value: c.nombre, label: c.nombre }))} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!archivo || (pideBanco && !cuenta) || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await adjuntarComprobantePago(pago.id, archivo!, pideBanco ? cuenta : undefined)
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            {enviando ? 'Subiendo…' : 'Adjuntar'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

const MEDIOS: MetodoPago[] = ['TRANSFERENCIA', 'CHEQUE', 'ECHEQ', 'DEBITO', 'TARJETA', 'CAJA']

function ModalCargarPago({ facturaIds, onClose }: { facturaIds: string[]; onClose: () => void }) {
  const { modo, facturas, pagos, catalogos, proveedor, registrarPago, proyeccionesParaPago, leerComprobante, comprobantesEjemplo, subirComprobante, toast } = useStore()
  const ejemplos = useMemo(() => comprobantesEjemplo(), [comprobantesEjemplo])
  const facts = facturas.filter((f) => facturaIds.includes(f.id))
  const [empresaId, setEmpresaId] = useState(facts[0]?.empresaId ?? catalogos.empresas[0]?.id ?? '')
  const [proveedorId, setProveedorId] = useState(facts[0]?.proveedorId ?? '')
  const [archivo, setArchivo] = useState<{ nombre: string } | null>(null)
  const [leyendo, setLeyendo] = useState(false)
  const [lectura, setLectura] = useState<LecturaComprobante | null>(null)
  const [importe, setImporte] = useState<number>(facts.reduce((a, f) => a + pendiente(f), 0))
  const [fechaPago, setFechaPago] = useState(iso(new Date()))
  const [medio, setMedio] = useState<MetodoPago>(facts[0]?.metodoPago ?? 'TRANSFERENCIA')
  const [cuentaOrigen, setCuentaOrigen] = useState('')
  const [bancoLeido, setBancoLeido] = useState('')
  const [bancoDestino, setBancoDestino] = useState('')
  const [nroCheque, setNroCheque] = useState('')
  const [vtoCheque, setVtoCheque] = useState('')
  const [obs, setObs] = useState('')
  const [cuenta, setCuenta] = useState(facts[0]?.cuentaContable ?? '')
  const [sug, setSug] = useState<Sugerencia | null>(null)
  const [editados, setEditados] = useState<Set<string>>(new Set())
  const [guardando, setGuardando] = useState(false)
  // Proyección del Flujo que cubre este pago (solo pagos sin factura): egresos de la empresa, de hoy a 30 días.
  const [proyecciones, setProyecciones] = useState<ProyeccionParaPago[]>([])
  const [proyElegida, setProyElegida] = useState('')
  const inputArchivo = useRef<HTMLInputElement>(null)
  // El comprobante se guarda en la carpeta de la empresa elegida al subirlo. Se recuerda el archivo por si
  // después se cambia la empresa: al confirmar se guarda de nuevo en la carpeta de la empresa del pago.
  const subido = useRef<{ archivo: File; empresaId: string } | null>(null)

  const cuentasEmpresa = cuentasOrigenDe(catalogos.cuentasOrigen, empresaId)
  const esCheque = medio === 'CHEQUE' || medio === 'ECHEQ'
  const facturasEmpresa = facturas.filter((f) => f.empresaId === empresaId && (f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL'))
  const [vinculadas, setVinculadas] = useState<string[]>(facturaIds)
  const totalVinculado = facturasEmpresa.filter((f) => vinculadas.includes(f.id)).reduce((a, f) => a + pendiente(f), 0)
  const excede = vinculadas.length > 0 && importe > totalVinculado + 1

  const marcar = (campo: string) => setEditados((s) => new Set(s).add(campo))

  /** La IA lee "Banco Galicia"; Xubio necesita el nombre exacto de la cuenta ("Banco Galicia CC $").
   *  Solo se completa si hay una única cuenta de la empresa que coincide; si no, elige la persona. */
  function cuentaParaBanco(banco: string): string {
    const b = normal(banco)
    if (!b) return ''
    const exacta = cuentasEmpresa.find((c) => normal(c.nombre) === b)
    if (exacta) return exacta.nombre
    const parecidas = cuentasEmpresa.filter((c) => normal(c.nombre).includes(b.replace(/^banco /, '')))
    return parecidas.length === 1 ? parecidas[0].nombre : ''
  }

  function aplicarLectura(r: LecturaComprobante) {
    setLectura(r)
    if (!editados.has('importe') && r.importe) setImporte(r.importe)
    if (!editados.has('fecha') && r.fecha) setFechaPago(r.fecha)
    if (!editados.has('medio') && r.medio) setMedio(r.medio)
    setBancoLeido(r.banco)
    if (!editados.has('cuentaOrigen') && r.banco) setCuentaOrigen(cuentaParaBanco(r.banco))
    if (r.bancoDestino && !editados.has('bancoDestino')) setBancoDestino(r.bancoDestino)
    if (r.numeroCheque) setNroCheque(r.numeroCheque)
    if (r.referencia && !obs) setObs(r.referencia)
    if (vinculadas.length === 0 && r.importe) {
      const match = facturasEmpresa.find((f) => Math.abs(pendiente(f) - r.importe) < 1)
      if (match) {
        setVinculadas([match.id])
        setProveedorId(match.proveedorId)
      } else if (r.beneficiario) {
        const p = catalogos.proveedores.find((x) => x.nombre === r.beneficiario)
        if (p) setProveedorId(p.id)
      }
    }
  }

  async function elegir(origen: File | ComprobanteEjemplo) {
    if (origen instanceof File && origen.size > 4 * 1024 * 1024) {
      toast('El archivo pesa más de 4 MB. Mandá una captura o un PDF más liviano.', 'error')
      return
    }
    setArchivo({ nombre: origen instanceof File ? origen.name : origen.nombre })
    setLeyendo(true)
    setLectura(null)
    try {
      subido.current = null
      if (origen instanceof File) {
        const path = await subirComprobante(origen, empresaId)
        subido.current = { archivo: origen, empresaId }
        setArchivo({ nombre: path })
      }
      aplicarLectura(await leerComprobante(origen))
    } catch (e) {
      toast(`La IA no pudo leer el comprobante: ${e instanceof Error ? e.message : e}. Completá los datos a mano.`, 'error')
    } finally {
      setLeyendo(false)
    }
  }

  useEffect(() => {
    const s = sugerirCuenta({
      proveedor: proveedor(proveedorId),
      facturas: facturasEmpresa.filter((f) => vinculadas.includes(f.id)),
      descripcion: `${obs} ${lectura?.referencia ?? ''} ${lectura?.beneficiario ?? ''}`,
      pagosPrevios: pagos,
    })
    setSug(s)
    if (!editados.has('cuenta') && s.cuenta) setCuenta(s.cuenta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proveedorId, vinculadas, obs, lectura])

  // Vencimiento del cheque: por defecto, fecha de pago + los días que se aprobaron en la factura.
  const vtoChequeFinal = vtoCheque || iso(addDays(parseIso(fechaPago), facts[0]?.diasCheque ?? 30))
  // Se vuelve a pedir la lista solo cuando cambia la empresa. La función del store se recrea con cada recarga o aviso: se lee por ref
  // para que eso no borre la proyección elegida ni vuelva a pedir la lista.
  const pedirProyecciones = useRef(proyeccionesParaPago)
  pedirProyecciones.current = proyeccionesParaPago
  useEffect(() => {
    let vigente = true
    setProyElegida('')
    if (!empresaId) return
    pedirProyecciones.current(empresaId).then((l) => vigente && setProyecciones(l)).catch(() => vigente && setProyecciones([]))
    return () => {
      vigente = false
    }
  }, [empresaId])
  const proyDelPago = proyecciones.find((x) => `${x.proyeccionId}|${x.ocurrencia}` === proyElegida)

  const cuentaFuera = !!cuenta && !enLista(cuentasPara(catalogos, empresaId), cuenta)
  const falta = !archivo || !importe || !cuentaOrigen || (esCheque && !nroCheque) || cuentaFuera
  const motivoFalta = !archivo ? 'Falta el comprobante' : !importe ? 'Falta el importe' : !cuentaOrigen ? 'Falta la cuenta de origen' : esCheque && !nroCheque ? 'Falta el número de cheque' : cuentaFuera ? 'La cuenta contable no está en el plan de la empresa' : ''
  const marcado = (campo: string, valorIA: unknown) => (lectura && valorIA && !editados.has(campo) ? 'ia' : undefined)

  async function confirmar() {
    const p = proveedor(proveedorId)
    setGuardando(true)
    let comprobante = archivo!.nombre
    if (subido.current && subido.current.empresaId !== empresaId) {
      // Se cambió la empresa después de subir el comprobante: va a la carpeta de la empresa del pago.
      try {
        comprobante = await subirComprobante(subido.current.archivo, empresaId)
        subido.current = { archivo: subido.current.archivo, empresaId }
        setArchivo({ nombre: comprobante })
      } catch (e) {
        toast(`No se pudo guardar el comprobante en la empresa elegida: ${e instanceof Error ? e.message : e}`, 'error')
        setGuardando(false)
        return
      }
    }
    const r = await registrarPago({
      empresaId,
      proveedorId: proveedorId || undefined,
      fecha: fechaPago,
      importe,
      medio,
      cuentaOrigen,
      bancoDestino: bancoDestino || undefined,
      numeroCheque: esCheque ? nroCheque : undefined,
      fechaAcreditacion: esCheque ? vtoChequeFinal : undefined,
      facturaIds: vinculadas,
      descripcion: vinculadas.length ? `Pago a ${p?.nombre ?? 'proveedor'}` : obs || 'Pago sin factura',
      observaciones: obs || undefined,
      cuentaContable: cuenta || undefined,
      sugerenciaOrigen: editados.has('cuenta') ? 'MANUAL' : sug?.origen,
      sugerenciaConfianza: editados.has('cuenta') ? 1 : sug?.confianza,
      formaCargaXubio: formaDeCarga(facturasEmpresa.filter((f) => vinculadas.includes(f.id)), obs),
      comprobante,
      proyeccionId: vinculadas.length === 0 ? proyDelPago?.proyeccionId : undefined,
      proyeccionOcurrencia: vinculadas.length === 0 ? proyDelPago?.ocurrencia : undefined,
    })
    setGuardando(false)
    if (r) onClose()
  }

  return (
    <Modal titulo={facturaIds.length ? 'Confirmar pago' : 'Cargar pago sin factura'} onClose={onClose} ancho="max-w-4xl">
      <div className="grid md:grid-cols-5 gap-6">
        <div className="md:col-span-2 space-y-3">
          <p className="text-[0.625rem] uppercase tracking-widest text-seco">1 · Comprobante</p>
          {!archivo && (
            <div className="border border-dashed border-borde rounded-xl p-4 text-center space-y-3">
              <input
                ref={inputArchivo}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void elegir(f)
                }}
              />
              <Btn variant="secundario" className="w-full justify-center" onClick={() => inputArchivo.current?.click()}>
                Elegir PDF o captura del homebanking
              </Btn>
              {modo === 'demo' && ejemplos.length > 0 && (
                <>
                  <p className="text-xs text-seco">O probá con uno de ejemplo:</p>
                  {ejemplos.map((c) => (
                    <button key={c.id} onClick={() => void elegir(c)} className="w-full text-left p-3 rounded-lg border border-borde hover:border-dorado transition-colors">
                      <p className="text-sm font-semibold text-crema">{c.nombre}</p>
                      <p className="text-xs text-seco">{c.descripcion}</p>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          {archivo && (
            <div className="rounded-xl border border-borde p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold truncate">{archivo.nombre}</p>
                <button
                  className="text-xs text-seco hover:text-acento"
                  onClick={() => {
                    setArchivo(null)
                    setLectura(null)
                  }}
                >
                  cambiar
                </button>
              </div>
              <div className="h-36 rounded-lg bg-botella border border-borde flex items-center justify-center text-seco text-xs">vista previa del comprobante</div>
              {leyendo && (
                <div className="space-y-2">
                  <div className="h-3 rounded shimmer" />
                  <div className="h-3 rounded shimmer w-3/4" />
                  <p className="text-xs text-acento">✦ La IA está leyendo el comprobante…</p>
                </div>
              )}
              {lectura && (
                <div className="text-xs space-y-1">
                  <p className="text-acento">✦ Leído · confianza {Math.round(lectura.confianza * 100)}%</p>
                  {lectura.confianza < 0.7 && <p className="text-amber-300">Imagen poco legible: revisá importe y fecha antes de confirmar.</p>}
                  {lectura.beneficiario && (
                    <p className="text-seco">
                      Beneficiario: <span className="text-crema">{lectura.beneficiario}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="md:col-span-3 space-y-3">
          <p className="text-[0.625rem] uppercase tracking-widest text-seco">2 · Datos del pago</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Empresa">
              <Desplegable
                value={empresaId}
                disabled={facts.length > 0}
                onChange={(v) => {
                  setEmpresaId(v)
                  setVinculadas([])
                }}
                opciones={catalogos.empresas.map((e) => ({ value: e.id, label: e.nombre }))}
              />
            </Field>
            <Field label="Proveedor / destinatario">
              <Desplegable
                value={proveedorId}
                onChange={setProveedorId}
                anchoMenu={320}
                opciones={[{ value: '', label: 'Sin proveedor (banco, impuestos)' }, ...catalogos.proveedores.map((p) => ({ value: p.id, label: p.nombre, detalle: p.cuit ? fmtCuit(p.cuit) : undefined }))]}
              />
            </Field>
            <Field label="Importe" marcado={marcado('importe', lectura?.importe) ?? (!importe ? 'falta' : undefined)}>
              <input
                type="number"
                value={importe || ''}
                onChange={(e) => {
                  setImporte(Number(e.target.value))
                  marcar('importe')
                }}
                className={inputCls}
              />
            </Field>
            <Field label="Fecha" marcado={marcado('fecha', lectura?.fecha)}>
              <input
                type="date"
                value={fechaPago}
                onChange={(e) => {
                  setFechaPago(e.target.value)
                  marcar('fecha')
                }}
                className={inputCls}
              />
            </Field>
            <Field label="Medio" marcado={marcado('medio', lectura?.medio)}>
              <Desplegable
                value={medio}
                onChange={(v) => {
                  setMedio(v as MetodoPago)
                  marcar('medio')
                }}
                opciones={MEDIOS.map((m) => ({ value: m, label: m }))}
              />
            </Field>
            <Field
              label="Cuenta de origen"
              hint={bancoLeido && !cuentaOrigen ? `La IA leyó "${bancoLeido}": elegí la cuenta exacta` : 'Nombre exacto de la cuenta en Xubio'}
              marcado={!cuentaOrigen ? 'falta' : marcado('cuentaOrigen', lectura?.banco)}
            >
              <Desplegable
                value={cuentaOrigen}
                onChange={(v) => {
                  setCuentaOrigen(v)
                  marcar('cuentaOrigen')
                }}
                anchoMenu={300}
                opciones={cuentasEmpresa.map((c) => ({ value: c.nombre, label: c.nombre }))}
              />
            </Field>
            {esCheque ? (
              <>
                <Field label="N° de cheque" marcado={!nroCheque ? 'falta' : marcado('nroCheque', lectura?.numeroCheque)}>
                  <input value={nroCheque} onChange={(e) => setNroCheque(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Vence el cheque" hint="Fecha en que se acredita; va a Xubio y al flujo">
                  <input type="date" value={vtoChequeFinal} onChange={(e) => setVtoCheque(e.target.value)} className={inputCls} />
                </Field>
              </>
            ) : (
              <Field label="Banco destino" marcado={marcado('bancoDestino', lectura?.bancoDestino)}>
                <input
                  value={bancoDestino}
                  onChange={(e) => {
                    setBancoDestino(e.target.value)
                    marcar('bancoDestino')
                  }}
                  className={inputCls}
                />
              </Field>
            )}
            <Field label="Observación para Guido" hint="¿Qué se pagó? Con esto la IA afina la cuenta.">
              <input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ej.: comisión del banco, anticipo, IIBB…" className={inputCls} />
            </Field>
          </div>

          <p className="text-[0.625rem] uppercase tracking-widest text-seco pt-2">3 · Facturas que cancela</p>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-borde divide-y divide-borde/60">
            {facturasEmpresa.length === 0 && <p className="p-3 text-xs text-seco">Esta empresa no tiene facturas para pagar.</p>}
            {facturasEmpresa.map((f) => {
              const on = vinculadas.includes(f.id)
              return (
                <label key={f.id} className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${on ? 'bg-dorado/10' : 'hover:bg-suave/60'}`}>
                  <input type="checkbox" checked={on} onChange={() => setVinculadas((v) => (on ? v.filter((x) => x !== f.id) : [...v, f.id]))} className="accent-dorado" />
                  <span className="flex-1 truncate">
                    {proveedor(f.proveedorId)?.nombre} · {f.tipo} {nroComprobante(f.puntoVenta, f.numero)}
                  </span>
                  <BadgeVencimiento vencimiento={f.vencimiento} />
                  <span className="font-semibold">{money(pendiente(f))}</span>
                </label>
              )
            })}
          </div>
          {vinculadas.length > 0 && (
            <p className="text-xs text-seco">
              Vinculado {money(totalVinculado)} · pago {money(importe)} ·{' '}
              {Math.abs(totalVinculado - importe) < 1 ? (
                <span className="text-emerald-300">cancela el 100 %</span>
              ) : importe < totalVinculado ? (
                <span className="text-amber-300">pago parcial ({Math.round((importe / totalVinculado) * 100)} %)</span>
              ) : (
                <span className="text-red-300">el pago supera lo vinculado: cargá el excedente como un pago aparte</span>
              )}
            </p>
          )}

          {vinculadas.length === 0 && proyecciones.length > 0 && (
            <>
              <p className="text-[0.625rem] uppercase tracking-widest text-seco pt-2">Proyección del Flujo que cubre este pago (opcional)</p>
              <div className="max-h-40 overflow-y-auto rounded-lg border border-borde divide-y divide-borde/60">
                <label className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${proyElegida === '' ? 'bg-dorado/10' : 'hover:bg-suave/60'}`}>
                  <input type="radio" name="proyeccion" checked={proyElegida === ''} onChange={() => setProyElegida('')} className="accent-dorado" />
                  <span className="flex-1">Ninguna</span>
                </label>
                {proyecciones.map((x) => {
                  const clave = `${x.proyeccionId}|${x.ocurrencia}`
                  return (
                    <label key={clave} className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${proyElegida === clave ? 'bg-dorado/10' : 'hover:bg-suave/60'}`}>
                      <input type="radio" name="proyeccion" checked={proyElegida === clave} onChange={() => setProyElegida(clave)} className="accent-dorado" />
                      <span className="flex-1 truncate">
                        {fecha(x.fecha)} · {x.concepto}
                        {x.proveedor ? ` · ${x.proveedor}` : ''} · {x.fila}
                      </span>
                      <span className="font-semibold">{money(x.importe)}</span>
                    </label>
                  )
                })}
              </div>
              {proyDelPago && (
                <p className="text-xs text-seco">
                  {importe >= proyDelPago.importe
                    ? 'El pago cubre toda la proyección: se da de baja del Flujo.'
                    : `Se descuentan ${money(importe)} de la proyección y en el Flujo quedan ${money(proyDelPago.importe - importe)}.`}{' '}
                  Si anulás el pago, el importe vuelve a la proyección.
                </p>
              )}
            </>
          )}

          <p className="text-[0.625rem] uppercase tracking-widest text-seco pt-2">4 · Cuenta contable (regla de oro)</p>
          <Field
            label="Cuenta del plan de Xubio"
            marcado={cuenta && !editados.has('cuenta') && sug?.cuenta ? 'ia' : !cuenta ? 'falta' : undefined}
            hint={sug ? `${sug.origen === 'REGLA' ? 'Regla aprendida' : sug.origen === 'IA' ? 'Sugerencia de la IA' : 'Manual'} · ${sug.motivo} · confianza ${Math.round(sug.confianza * 100)}%` : undefined}
          >
            <SelectorCuenta
              value={cuenta}
              onChange={(v) => {
                setCuenta(v)
                marcar('cuenta')
              }}
              opciones={cuentasPara(catalogos, empresaId)}
              placeholder="Vacío: Guido la define al contabilizar"
            />
          </Field>
          <p className="text-xs text-seco">
            Forma de carga en Xubio: <span className="text-crema">{formaDeCarga(facturasEmpresa.filter((f) => vinculadas.includes(f.id)), obs).replace('_', ' ')}</span>
            {esCheque && (
              <>
                {' '}
                · se registra en <span className="text-crema">Cheques</span> con acreditación estimada
              </>
            )}
          </p>

          <div className="flex justify-end gap-2 pt-3 border-t border-borde">
            <Btn variant="fantasma" onClick={onClose}>
              Cancelar
            </Btn>
            <Btn disabled={falta || excede || leyendo || guardando} onClick={() => void confirmar()} title={motivoFalta || (excede ? 'El pago supera lo vinculado' : '')}>
              {guardando ? 'Guardando…' : 'Subir y pasar a Guido'}
            </Btn>
          </div>
        </div>
      </div>
    </Modal>
  )
}
