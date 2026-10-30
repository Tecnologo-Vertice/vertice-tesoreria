import { useState } from 'react'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, inputCls, Kpi, SelectorCuenta, Tabs } from '../components/ui'
import { cuentasOrigenDe, cuentasPara, enLista, sugerirCuentaOrigen } from '../lib/cuentas'
import { useFiltro } from '../components/Filtros'
import { fecha, fechaHora, money, moneyShort, nroComprobante } from '../lib/format'
import { puede } from '../lib/permisos'
import type { FormaCargaXubio, Pago } from '../types'

const FORMAS: { id: FormaCargaXubio; label: string; desc: string }[] = [
  { id: 'ORDEN_PAGO', label: 'Orden de pago', desc: 'Con factura asociada: cancela la deuda del proveedor' },
  { id: 'SALIDA_FONDOS', label: 'Salida de fondos', desc: 'Sin factura: gastos bancarios, anticipos' },
  { id: 'ASIENTO_MANUAL', label: 'Asiento manual', desc: 'Impuestos, sueldos y casos especiales' },
]

export function Contabilizacion() {
  const { pagos, empresa, proveedor } = useStore()
  const [tab, setTab] = useState<'PENDIENTES' | 'HECHOS'>('PENDIENTES')
  const pendientes = pagos.filter((p) => p.estado === 'CARGADO' || p.estado === 'REVISADO').sort((a, b) => b.cargadoEn.localeCompare(a.cargadoEn))
  const ralpharma = pagos.filter((p) => p.estado === 'PENDIENTE_RALPHARMA')
  const hechos = pagos.filter((p) => p.estado === 'CONTABILIZADO' || p.estado === 'CONCILIADO').sort((a, b) => (b.contabilizadoEn ?? '').localeCompare(a.contabilizadoEn ?? ''))
  const sinCuenta = pendientes.filter((p) => !p.cuentaContable).length
  const lista = tab === 'PENDIENTES' ? pendientes : hechos
  const filtro = useFiltro(lista, {
    clave: 'contabilizacion',
    texto: (p) =>
      [proveedor(p.proveedorId)?.nombre, proveedor(p.proveedorId)?.cuit, p.proveedorDestino, p.descripcion, p.observaciones, p.numeroCheque, p.cuentaOrigen, p.bancoOrigen,
        p.cuentaContable, p.medio, empresa(p.empresaId).nombre, p.importe.toFixed(2)].join(' '),
    empresa: (p) => p.empresaId,
    proveedor: (p) => proveedor(p.proveedorId)?.nombre ?? p.proveedorDestino ?? '',
    cuenta: (p) => p.cuentaContable,
    alta: (p) => p.cargadoEn,
    vencimiento: (p) => p.fecha,
    etiquetaFecha: 'Fecha del pago',
    importe: (p) => p.importe,
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-serif text-3xl">Contabilización</h2>
        <p className="text-sm text-seco">
          La bandeja de Guido. Cada pago llega con el comentario de Vivi, la cuenta sugerida y la forma de carga en Xubio. Un clic lo registra. Nada pasa a "contabilizado" sin un id de Xubio o un responsable en Ralpharma.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Para contabilizar" value={String(pendientes.length)} sub={moneyShort(pendientes.reduce((a, p) => a + p.importe, 0))} tone="dorado" />
        <Kpi label="Sin cuenta definida" value={String(sinCuenta)} sub="requieren decisión" tone={sinCuenta ? 'rojo' : 'verde'} />
        <Kpi label="Pendientes Ralpharma" value={String(ralpharma.length)} sub="en el sector Ralpharma" tone="crema" />
        <Kpi label="Contabilizados" value={String(hechos.length)} sub={`${hechos.filter((p) => p.xubioId?.startsWith('OP')).length} con orden de pago`} tone="verde" />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'PENDIENTES', label: 'Para contabilizar', n: pendientes.length },
          { id: 'HECHOS', label: 'Contabilizados', n: hechos.length },
        ]}
      />

      {lista.length > 0 && filtro.barra}
      {lista.length === 0 && <Empty texto="Bandeja vacía." />}
      {lista.length > 0 && filtro.visibles.length === 0 && <Empty texto="Nada coincide con la búsqueda o los filtros." />}
      <div className="space-y-4">
        {filtro.visibles.map((p) => (
          <TarjetaPago key={p.id} p={p} empresaNombre={empresa(p.empresaId).corto} erp={empresa(p.empresaId).erp} nueva={filtro.esNueva(p)} />
        ))}
      </div>
    </div>
  )
}

function TarjetaPago({ p, empresaNombre, erp, nueva }: { p: Pago; empresaNombre: string; erp: string; nueva?: boolean }) {
  const { facturas, proveedor, catalogos, usuario, contabilizarPago, marcarRalpharma, abrirArchivo } = useStore()
  const puedeContabilizar = puede(usuario.rol, 'CONTABILIZAR')
  const planEmpresa = cuentasPara(catalogos, p.empresaId)
  const origenes = cuentasOrigenDe(catalogos.cuentasOrigen, p.empresaId)
  // Cuenta de origen: la que ya tiene el pago; si no, deducida del banco del comprobante (como producción).
  const sugeridaOrigen = p.cuentaOrigen ? null : sugerirCuentaOrigen(origenes, p.bancoOrigen, { esCheque: !!p.numeroCheque, numeroCuenta: p.numeroCuenta })
  const [cuenta, setCuenta] = useState(p.cuentaContable ?? '')
  const [origen, setOrigen] = useState(p.cuentaOrigen || sugeridaOrigen?.cuenta || '')
  const [forma, setForma] = useState<FormaCargaXubio>(p.formaCargaXubio)
  const [enviando, setEnviando] = useState(false)
  const facts = facturas.filter((f) => p.facturaIds.includes(f.id))
  const prov = proveedor(p.proveedorId)
  const hecho = p.estado === 'CONTABILIZADO' || p.estado === 'CONCILIADO'
  const cuentaValida = enLista(planEmpresa, cuenta)
  const sinLeer = p.estadoExtraccion === 'REVISION_MANUAL' || /^ERROR/.test(p.estadoExtraccion ?? '')
  const echeq = !!p.numeroCheque && (origenes.find((c) => c.nombre === origen)?.tipoCuenta === 4 || /cheq|chec/i.test(origen))
  const falta = p.importe <= 0 ? 'Falta el importe del pago' : !origen ? 'Falta la cuenta de origen' : !cuentaValida ? 'Falta la cuenta contable' : ''

  async function contabilizar() {
    setEnviando(true)
    await contabilizarPago(p.id, { cuentaContable: cuentaValida ?? cuenta, formaCargaXubio: forma, cuentaOrigen: origen })
    setEnviando(false)
  }

  return (
    <Card>
      <div className="flex flex-col lg:flex-row gap-5">
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {nueva && <Badge tone="azul">Nuevo</Badge>}
            <Badge tone="dorado">{empresaNombre}</Badge>
            <Badge>{p.medio}</Badge>
            {p.gestion === 'HOJA' && <Badge title="Copiado del dashboard de producción. Si lo contabilizás acá, la copia ya no lo pisa.">De la hoja</Badge>}
            <Badge tone={facts.length ? 'azul' : 'naranja'}>{facts.length ? `${facts.length} factura(s)` : 'Sin factura'}</Badge>
            {p.numeroCheque && <Badge>Cheque {p.numeroCheque} · acredita {fecha(p.fechaAcreditacion)}</Badge>}
            {hecho && <Badge tone="verde">{p.xubioId === 'RALPHARMA' ? 'Cargado en Ralpharma' : `Xubio ${p.xubioId}`}</Badge>}
            {p.mailProveedorEnviado && <Badge tone="azul">Mail al proveedor</Badge>}
          </div>
          <div>
            <p className="font-semibold">{prov?.nombre ?? p.proveedorDestino ?? p.descripcion}</p>
            <p className="text-xs text-seco">
              {fecha(p.fecha)} · desde {p.cuentaOrigen || p.bancoOrigen || 'cuenta sin definir'}
              {p.bancoDestino ? ` → ${p.bancoDestino}` : ''}
              {p.comprobanteUrl ? (
                <>
                  {' · '}
                  <a href={p.comprobanteUrl} target="_blank" rel="noreferrer" className="text-dorado underline hover:text-crema">
                    comprobante en Drive
                  </a>
                </>
              ) : p.comprobante ? (
                <>
                  {' · comprobante '}
                  <button onClick={() => void abrirArchivo('comprobantes', p.comprobante)} className="text-dorado underline hover:text-crema">
                    {p.comprobante.split('/').pop()}
                  </button>
                </>
              ) : null}
            </p>
          </div>
          {sinLeer && (
            <div className="rounded-lg bg-amber-950/40 border border-amber-900 text-amber-200 text-xs p-3">
              La IA no pudo leer el comprobante ({p.estadoExtraccion}). Revisá importe, banco y fecha mirándolo antes de contabilizar.
            </div>
          )}
          {p.avisoImporte && <div className="rounded-lg bg-amber-950/40 border border-amber-900 text-amber-200 text-xs p-3">{p.avisoImporte}</div>}
          {p.observaciones && (
            <div className="rounded-lg bg-botella border border-borde p-3 text-sm">
              <p className="text-[10px] uppercase tracking-widest text-seco mb-1">Comentario de {p.cargadoPor}</p>
              <p className="italic text-crema">"{p.observaciones}"</p>
            </div>
          )}
          {facts.length > 0 && (
            <ul className="text-xs space-y-1">
              {facts.map((f) => (
                <li key={f.id} className="flex justify-between gap-3 border-b border-borde/40 pb-1">
                  <span className="text-seco">
                    {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · {f.cuentaContable}
                  </span>
                  <span>
                    {money(f.total)} {f.pagadoPct < 100 && <span className="text-amber-300">({f.pagadoPct}%)</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-seco">
            Cargado por <span className="text-crema">{p.cargadoPor}</span> el {fechaHora(p.cargadoEn)}
            {p.contabilizadoEn && (
              <>
                {' '}
                · contabilizado por <span className="text-crema">{p.contabilizadoPor}</span> el {fechaHora(p.contabilizadoEn)}
              </>
            )}
          </p>
        </div>

        <div className="lg:w-80 shrink-0 space-y-3 lg:border-l lg:border-borde lg:pl-5">
          <p className="font-serif text-2xl text-right">{money(p.importe)}</p>
          {!hecho && !puedeContabilizar && <p className="text-xs text-seco text-right">Lo contabiliza Administración.</p>}
          {!hecho && puedeContabilizar && erp === 'XUBIO' && (
            <>
              <Field
                label="Cuenta de origen (de dónde salió la plata)"
                marcado={!origen ? 'falta' : sugeridaOrigen && origen === sugeridaOrigen.cuenta ? 'ia' : undefined}
                hint={sugeridaOrigen && origen === sugeridaOrigen.cuenta ? sugeridaOrigen.nota : origenes.length ? undefined : 'No hay cuentas de origen de esta empresa: falta copiar Xubio_Cuentas_Origen'}
              >
                <select value={origen} onChange={(e) => setOrigen(e.target.value)} className={inputCls}>
                  <option value="">Elegir…</option>
                  {p.cuentaOrigen && !origenes.some((c) => c.nombre === p.cuentaOrigen) && <option value={p.cuentaOrigen}>{p.cuentaOrigen}</option>}
                  {origenes.map((c) => (
                    <option key={c.id} value={c.nombre}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </Field>
              {echeq && <p className="text-[11px] text-amber-300">E-cheq: Xubio no deja crear esta orden de pago por API. En seco se verifica igual; en real hay que cargarla a mano.</p>}
              <Field
                label="Cuenta contable"
                marcado={!cuenta ? 'falta' : p.sugerenciaOrigen && !p.cuentaContable ? 'ia' : undefined}
                hint={p.sugerenciaOrigen ? `${p.sugerenciaOrigen === 'REGLA' ? 'Regla aprendida' : p.sugerenciaOrigen === 'IA' ? 'Sugerida por IA' : 'Elegida por Vivi'} · ${Math.round((p.sugerenciaConfianza ?? 0) * 100)}%` : 'Sin sugerencia: definila vos'}
              >
                <SelectorCuenta value={cuenta} onChange={setCuenta} opciones={planEmpresa} />
              </Field>
              <Field label="Forma de carga en Xubio" hint={FORMAS.find((f) => f.id === forma)?.desc}>
                <select value={forma} onChange={(e) => setForma(e.target.value as FormaCargaXubio)} className={inputCls}>
                  {FORMAS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Btn className="w-full justify-center" disabled={!!falta || enviando} onClick={contabilizar} title={falta}>
                {enviando ? 'Registrando en Xubio…' : 'Contabilizar en Xubio'}
              </Btn>
              {falta && <p className="text-[11px] text-red-300 text-right">{falta}</p>}
            </>
          )}
          {!hecho && puedeContabilizar && erp === 'RALPHARMA' && (
            <>
              <p className="text-xs text-seco">Esta empresa no usa Xubio. Hoy estas facturas pasaban a "contabilizadas" solas; acá alguien tiene que confirmar la carga.</p>
              <Btn className="w-full justify-center" variant="secundario" onClick={() => marcarRalpharma(p.id)}>
                Confirmo que lo cargué en Ralpharma
              </Btn>
            </>
          )}
          {(hecho || p.estado === 'REVISADO') && p.detalleXubio && <p className="text-[11px] text-seco">{p.detalleXubio}</p>}
          {hecho && (
            <div className="text-xs text-seco space-y-1">
              <p>
                Cuenta: <span className="text-crema">{p.cuentaContable}</span>
              </p>
              <p>
                Forma: <span className="text-crema">{FORMAS.find((f) => f.id === p.formaCargaXubio)?.label}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
