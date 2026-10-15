import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { Badge, BadgeVencimiento, Btn, Empty, Field, inputCls, Modal, Tabs } from '../components/ui'
import { addDays, diasHasta, fecha, iso, money, nroComprobante, parseIso, pendiente } from '../lib/format'
import { formaDeCarga, sugerirCuenta, type Sugerencia } from '../lib/ia'
import { puede } from '../lib/permisos'
import type { ComprobanteEjemplo, EstadoXubio, LecturaComprobante, MetodoPago } from '../types'

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
  const [tab, setTab] = useState<'PARA_PAGAR' | 'PAGADAS'>('PARA_PAGAR')
  const [sel, setSel] = useState<string[]>([])
  const [modal, setModal] = useState<null | { facturaIds: string[] }>(null)

  const paraPagar = useMemo(
    () => facturas.filter((f) => f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL').sort((a, b) => diasHasta(a.vencimiento) - diasHasta(b.vencimiento)),
    [facturas],
  )
  const pagadas = useMemo(() => facturas.filter((f) => f.estado === 'PAGADA'), [facturas])

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const empresaSel = sel.length ? facturas.find((f) => f.id === sel[0])?.empresaId : undefined

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-3xl">Pagos</h2>
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
        ]}
      />

      {tab === 'PARA_PAGAR' && (
        <div className="space-y-2">
          {paraPagar.length === 0 && <Empty texto="No hay facturas para pagar." />}
          {paraPagar.map((f) => {
            const p = proveedor(f.proveedorId)
            const e = empresa(f.empresaId)
            const marcada = sel.includes(f.id)
            const otraEmpresa = empresaSel !== undefined && empresaSel !== f.empresaId
            const xubio = ESTADO_XUBIO[f.estadoXubio] ?? { label: f.estadoXubio, tone: 'neutro' as const }
            return (
              <div
                key={f.id}
                onClick={() => puedePagar && !otraEmpresa && toggle(f.id)}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors ${puedePagar ? 'cursor-pointer' : ''} ${marcada ? 'border-dorado bg-dorado/10' : 'border-borde bg-pino/40 hover:bg-pino/70'} ${otraEmpresa ? 'opacity-40 cursor-not-allowed' : ''}`}
                title={otraEmpresa ? 'Un pago agrupa facturas de una sola empresa' : ''}
              >
                {puedePagar && <input type="checkbox" readOnly checked={marcada} className="accent-dorado w-4 h-4" />}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <Badge tone="dorado">{e.corto}</Badge>
                    <BadgeVencimiento vencimiento={f.vencimiento} />
                    <Badge tone={xubio.tone}>{xubio.label}</Badge>
                    {f.pagadoPct > 0 && <Badge tone="azul">{f.pagadoPct}% pagado</Badge>}
                  </div>
                  <p className="font-semibold truncate">{p?.nombre ?? f.proveedorId}</p>
                  <p className="text-xs text-seco">
                    {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · {f.metodoPago} · {f.cuentaContable}
                  </p>
                  {f.xubioError && <p className="text-[11px] text-red-300 mt-0.5">Xubio: {f.xubioError}</p>}
                  {puedeXubio && e.erp === 'XUBIO' && (f.estadoXubio === 'PENDIENTE' || f.estadoXubio === 'ERROR') && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        void subirFacturaXubio(f.id)
                      }}
                      className="text-[11px] text-dorado underline mt-0.5"
                    >
                      {f.estadoXubio === 'ERROR' ? 'Reintentar subida a Xubio' : modo === 'demo' ? 'Subir a Xubio (simulado)' : 'Subir a Xubio'}
                    </button>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-serif text-xl">{money(pendiente(f))}</p>
                  <p className="text-[10px] text-seco">vence {fecha(f.vencimiento)}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'PAGADAS' && (
        <div className="space-y-2">
          {pagadas.length === 0 && <Empty texto="Todavía no hay facturas pagadas." />}
          {pagadas.map((f) => {
            const p = proveedor(f.proveedorId)
            const pg = pagos.find((x) => x.facturaIds.includes(f.id))
            return (
              <div key={f.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border border-borde bg-pino/40">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <Badge tone="dorado">{empresa(f.empresaId).corto}</Badge>
                    <Badge tone="verde">Pagada</Badge>
                    {pg?.estado === 'CONTABILIZADO' ? <Badge tone="verde">Contabilizada {pg.xubioId}</Badge> : <Badge tone="naranja">Para contabilizar</Badge>}
                    {pg?.mailProveedorEnviado && <Badge tone="azul">Mail al proveedor enviado</Badge>}
                  </div>
                  <p className="font-semibold truncate">{p?.nombre ?? f.proveedorId}</p>
                  <p className="text-xs text-seco">
                    {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · pagada el {fecha(pg?.fecha)} por {pg?.cargadoPor} · {pg?.medio}
                  </p>
                </div>
                <p className="font-serif text-xl">{money(f.total)}</p>
              </div>
            )
          })}
        </div>
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

const MEDIOS: MetodoPago[] = ['TRANSFERENCIA', 'CHEQUE', 'ECHEQ', 'DEBITO', 'TARJETA', 'CAJA']

function ModalCargarPago({ facturaIds, onClose }: { facturaIds: string[]; onClose: () => void }) {
  const { modo, facturas, pagos, catalogos, proveedor, registrarPago, leerComprobante, comprobantesEjemplo, subirComprobante, toast } = useStore()
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
  const inputArchivo = useRef<HTMLInputElement>(null)

  const cuentasEmpresa = catalogos.cuentasOrigen.filter((c) => c.empresaId === empresaId)
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
      if (origen instanceof File) {
        const path = await subirComprobante(origen)
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
  const falta = !archivo || !importe || !cuentaOrigen || (esCheque && !nroCheque)
  const motivoFalta = !archivo ? 'Falta el comprobante' : !importe ? 'Falta el importe' : !cuentaOrigen ? 'Falta la cuenta de origen' : esCheque && !nroCheque ? 'Falta el número de cheque' : ''
  const marcado = (campo: string, valorIA: unknown) => (lectura && valorIA && !editados.has(campo) ? 'ia' : undefined)

  async function confirmar() {
    const p = proveedor(proveedorId)
    setGuardando(true)
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
      comprobante: archivo!.nombre,
    })
    setGuardando(false)
    if (r) onClose()
  }

  return (
    <Modal titulo={facturaIds.length ? 'Confirmar pago' : 'Cargar pago sin factura'} onClose={onClose} ancho="max-w-4xl">
      <div className="grid md:grid-cols-5 gap-6">
        <div className="md:col-span-2 space-y-3">
          <p className="text-[10px] uppercase tracking-widest text-seco">1 · Comprobante</p>
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
                  className="text-xs text-seco hover:text-dorado"
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
                  <p className="text-xs text-dorado">✦ La IA está leyendo el comprobante…</p>
                </div>
              )}
              {lectura && (
                <div className="text-xs space-y-1">
                  <p className="text-dorado">✦ Leído · confianza {Math.round(lectura.confianza * 100)}%</p>
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
          <p className="text-[10px] uppercase tracking-widest text-seco">2 · Datos del pago</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Empresa">
              <select
                value={empresaId}
                disabled={facts.length > 0}
                onChange={(e) => {
                  setEmpresaId(e.target.value)
                  setVinculadas([])
                }}
                className={inputCls}
              >
                {catalogos.empresas.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nombre}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Proveedor / destinatario">
              <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={inputCls}>
                <option value="">Sin proveedor (banco, impuestos)</option>
                {catalogos.proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
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
              <select
                value={medio}
                onChange={(e) => {
                  setMedio(e.target.value as MetodoPago)
                  marcar('medio')
                }}
                className={inputCls}
              >
                {MEDIOS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Cuenta de origen"
              hint={bancoLeido && !cuentaOrigen ? `La IA leyó "${bancoLeido}": elegí la cuenta exacta` : 'Nombre exacto de la cuenta en Xubio'}
              marcado={!cuentaOrigen ? 'falta' : marcado('cuentaOrigen', lectura?.banco)}
            >
              <select
                value={cuentaOrigen}
                onChange={(e) => {
                  setCuentaOrigen(e.target.value)
                  marcar('cuentaOrigen')
                }}
                className={inputCls}
              >
                <option value="">Elegir…</option>
                {cuentasEmpresa.map((c) => (
                  <option key={c.id} value={c.nombre}>
                    {c.nombre}
                  </option>
                ))}
              </select>
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

          <p className="text-[10px] uppercase tracking-widest text-seco pt-2">3 · Facturas que cancela</p>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-borde divide-y divide-borde/60">
            {facturasEmpresa.length === 0 && <p className="p-3 text-xs text-seco">Esta empresa no tiene facturas para pagar.</p>}
            {facturasEmpresa.map((f) => {
              const on = vinculadas.includes(f.id)
              return (
                <label key={f.id} className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer ${on ? 'bg-dorado/10' : 'hover:bg-pino/60'}`}>
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

          <p className="text-[10px] uppercase tracking-widest text-seco pt-2">4 · Cuenta contable (regla de oro)</p>
          <Field
            label="Cuenta del plan de Xubio"
            marcado={cuenta && !editados.has('cuenta') && sug?.cuenta ? 'ia' : !cuenta ? 'falta' : undefined}
            hint={sug ? `${sug.origen === 'REGLA' ? 'Regla aprendida' : sug.origen === 'IA' ? 'Sugerencia de la IA' : 'Manual'} · ${sug.motivo} · confianza ${Math.round(sug.confianza * 100)}%` : undefined}
          >
            <select
              value={cuenta}
              onChange={(e) => {
                setCuenta(e.target.value)
                marcar('cuenta')
              }}
              className={inputCls}
            >
              <option value="">Guido la define al contabilizar</option>
              {catalogos.planCuentas.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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
