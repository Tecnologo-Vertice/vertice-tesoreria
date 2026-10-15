import { useState } from 'react'
import { useStore } from '../store'
import { Badge, Btn, Card, Empty, Field, inputCls, Kpi, Tabs } from '../components/ui'
import { fecha, fechaHora, money, moneyShort, nroComprobante } from '../lib/format'
import { puede } from '../lib/permisos'
import type { FormaCargaXubio, Pago } from '../types'

const FORMAS: { id: FormaCargaXubio; label: string; desc: string }[] = [
  { id: 'ORDEN_PAGO', label: 'Orden de pago', desc: 'Con factura asociada: cancela la deuda del proveedor' },
  { id: 'SALIDA_FONDOS', label: 'Salida de fondos', desc: 'Sin factura: gastos bancarios, anticipos' },
  { id: 'ASIENTO_MANUAL', label: 'Asiento manual', desc: 'Impuestos, sueldos y casos especiales' },
]

export function Contabilizacion() {
  const { pagos, empresa } = useStore()
  const [tab, setTab] = useState<'PENDIENTES' | 'HECHOS'>('PENDIENTES')
  const pendientes = pagos.filter((p) => p.estado === 'CARGADO' || p.estado === 'REVISADO').sort((a, b) => b.cargadoEn.localeCompare(a.cargadoEn))
  const ralpharma = pagos.filter((p) => p.estado === 'PENDIENTE_RALPHARMA')
  const hechos = pagos.filter((p) => p.estado === 'CONTABILIZADO' || p.estado === 'CONCILIADO').sort((a, b) => (b.contabilizadoEn ?? '').localeCompare(a.contabilizadoEn ?? ''))
  const sinCuenta = pendientes.filter((p) => !p.cuentaContable).length
  const lista = tab === 'PENDIENTES' ? pendientes : hechos

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

      {lista.length === 0 && <Empty texto="Bandeja vacía." />}
      <div className="space-y-4">
        {lista.map((p) => (
          <TarjetaPago key={p.id} p={p} empresaNombre={empresa(p.empresaId).corto} erp={empresa(p.empresaId).erp} />
        ))}
      </div>
    </div>
  )
}

function TarjetaPago({ p, empresaNombre, erp }: { p: Pago; empresaNombre: string; erp: string }) {
  const { facturas, proveedor, catalogos, usuario, contabilizarPago, marcarRalpharma, abrirArchivo } = useStore()
  const puedeContabilizar = puede(usuario.rol, 'CONTABILIZAR')
  const PLAN_CUENTAS = catalogos.planCuentas
  const [cuenta, setCuenta] = useState(p.cuentaContable ?? '')
  const [forma, setForma] = useState<FormaCargaXubio>(p.formaCargaXubio)
  const [enviando, setEnviando] = useState(false)
  const facts = facturas.filter((f) => p.facturaIds.includes(f.id))
  const prov = proveedor(p.proveedorId)
  const hecho = p.estado === 'CONTABILIZADO' || p.estado === 'CONCILIADO'

  async function contabilizar() {
    setEnviando(true)
    await contabilizarPago(p.id, { cuentaContable: cuenta, formaCargaXubio: forma })
    setEnviando(false)
  }

  return (
    <Card>
      <div className="flex flex-col lg:flex-row gap-5">
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="dorado">{empresaNombre}</Badge>
            <Badge>{p.medio}</Badge>
            <Badge tone={facts.length ? 'azul' : 'naranja'}>{facts.length ? `${facts.length} factura(s)` : 'Sin factura'}</Badge>
            {p.numeroCheque && <Badge>Cheque {p.numeroCheque} · acredita {fecha(p.fechaAcreditacion)}</Badge>}
            {hecho && <Badge tone="verde">{p.xubioId === 'RALPHARMA' ? 'Cargado en Ralpharma' : `Xubio ${p.xubioId}`}</Badge>}
            {p.mailProveedorEnviado && <Badge tone="azul">Mail al proveedor</Badge>}
          </div>
          <div>
            <p className="font-semibold">{prov?.nombre ?? p.descripcion}</p>
            <p className="text-xs text-seco">
              {fecha(p.fecha)} · desde {p.cuentaOrigen}
              {p.bancoDestino ? ` → ${p.bancoDestino}` : ''} · comprobante{' '}
              <button onClick={() => void abrirArchivo('comprobantes', p.comprobante)} className="text-dorado underline hover:text-crema">
                {p.comprobante.split('/').pop()}
              </button>
            </p>
          </div>
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
                label="Cuenta contable"
                marcado={!cuenta ? 'falta' : p.sugerenciaOrigen && !p.cuentaContable ? 'ia' : undefined}
                hint={p.sugerenciaOrigen ? `${p.sugerenciaOrigen === 'REGLA' ? 'Regla aprendida' : p.sugerenciaOrigen === 'IA' ? 'Sugerida por IA' : 'Elegida por Vivi'} · ${Math.round((p.sugerenciaConfianza ?? 0) * 100)}%` : 'Sin sugerencia: definila vos'}
              >
                <select value={cuenta} onChange={(e) => setCuenta(e.target.value)} className={inputCls}>
                  <option value="">Elegir…</option>
                  {PLAN_CUENTAS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
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
              <Btn className="w-full justify-center" disabled={!cuenta || enviando} onClick={contabilizar}>
                {enviando ? 'Registrando en Xubio…' : 'Contabilizar en Xubio'}
              </Btn>
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
