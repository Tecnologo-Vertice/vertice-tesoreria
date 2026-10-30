import { useState } from 'react'
import { useStore } from '../store'
import { Badge, BadgeVencimiento, Btn, Card, Empty, Kpi, Tabs } from '../components/ui'
import { fecha, fechaHora, money, moneyShort, nroComprobante } from '../lib/format'
import { puede } from '../lib/permisos'

/**
 * Sector Ralpharma: Droguería Robles, Héctor Robles y Farma Control no usan Xubio y Ralpharma no
 * tiene API. Acá Guido ve todo lo que tiene que cargar a mano allá y confirma cada carga con su nombre.
 */
export function Ralpharma() {
  const { facturas, pagos, empresa, proveedor, usuario, abrirArchivo, marcarFacturaRalpharma, marcarRalpharma } = useStore()
  const [tab, setTab] = useState<'FACTURAS' | 'PAGOS' | 'HECHO'>('FACTURAS')
  const puedeConfirmar = puede(usuario.rol, 'CONTABILIZAR')
  const esRalpharma = (empresaId: string) => empresa(empresaId).erp === 'RALPHARMA'

  const facturasPend = facturas
    .filter((f) => esRalpharma(f.empresaId) && f.estadoXubio === 'PENDIENTE_RALPHARMA' && ['PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA'].includes(f.estado))
    .sort((a, b) => (a.aprobadoEn ?? '').localeCompare(b.aprobadoEn ?? ''))
  const pagosPend = pagos.filter((p) => p.estado === 'PENDIENTE_RALPHARMA').sort((a, b) => a.cargadoEn.localeCompare(b.cargadoEn))
  const facturasHechas = facturas.filter((f) => esRalpharma(f.empresaId) && f.estadoXubio === 'CARGADA_RALPHARMA')
  const pagosHechos = pagos.filter((p) => esRalpharma(p.empresaId) && p.xubioId === 'RALPHARMA')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="titulo-pagina">Ralpharma</h2>
        <p className="text-sm text-seco">
          Droguería Robles, Héctor Robles y Farma Control no usan Xubio y Ralpharma no tiene conexión automática. Acá está todo lo que hay que cargar a mano allá. Nada se da por
          cargado hasta que alguien lo confirma con su nombre.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Facturas por cargar" value={String(facturasPend.length)} sub={moneyShort(facturasPend.reduce((a, f) => a + f.total, 0))} tone={facturasPend.length ? 'rojo' : 'verde'} />
        <Kpi label="Pagos por cargar" value={String(pagosPend.length)} sub={moneyShort(pagosPend.reduce((a, p) => a + p.importe, 0))} tone={pagosPend.length ? 'rojo' : 'verde'} />
        <Kpi label="Facturas cargadas" value={String(facturasHechas.length)} tone="verde" />
        <Kpi label="Pagos cargados" value={String(pagosHechos.length)} tone="verde" />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'FACTURAS', label: 'Facturas por cargar', n: facturasPend.length },
          { id: 'PAGOS', label: 'Pagos por cargar', n: pagosPend.length },
          { id: 'HECHO', label: 'Ya cargado', n: facturasHechas.length + pagosHechos.length },
        ]}
      />

      {tab === 'FACTURAS' && (
        <div className="space-y-3">
          {facturasPend.length === 0 && <Empty texto="No hay facturas aprobadas pendientes de cargar en Ralpharma." />}
          {facturasPend.map((f) => (
            <Card key={f.id} className="flex flex-col md:flex-row md:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <Badge tone="dorado">{empresa(f.empresaId).corto}</Badge>
                  <Badge tone="naranja">Cargar en Ralpharma</Badge>
                  <BadgeVencimiento vencimiento={f.vencimiento} />
                </div>
                <p className="font-semibold truncate">{proveedor(f.proveedorId)?.nombre ?? f.proveedorId}</p>
                <p className="text-xs text-seco">
                  {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · emitida {fecha(f.fecha)} · cuenta <span className="text-crema">{f.cuentaContable ?? '—'}</span> · aprobada por{' '}
                  {f.aprobadoPor ?? '—'}
                </p>
                <p className="text-xs text-seco">
                  Neto {money(f.neto)} · IVA {money(f.iva)} · percepciones {money(f.percepciones)} · CAE <span className="font-mono">{f.cae || '—'}</span>
                  {f.pdfPath && (
                    <>
                      {' '}
                      ·{' '}
                      <button onClick={() => void abrirArchivo('facturas', f.pdfPath!)} className="text-acento underline">
                        ver PDF
                      </button>
                    </>
                  )}
                </p>
              </div>
              <div className="text-right space-y-2 shrink-0">
                <p className="font-serif text-xl">{money(f.total)}</p>
                {puedeConfirmar ? (
                  <Btn variant="secundario" onClick={() => void marcarFacturaRalpharma(f.id)}>
                    Confirmo que la cargué
                  </Btn>
                ) : (
                  <p className="text-[0.6875rem] text-seco">La confirma Administración</p>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'PAGOS' && (
        <div className="space-y-3">
          {pagosPend.length === 0 && <Empty texto="No hay pagos pendientes de cargar en Ralpharma." />}
          {pagosPend.map((p) => (
            <Card key={p.id} className="flex flex-col md:flex-row md:items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <Badge tone="dorado">{empresa(p.empresaId).corto}</Badge>
                  <Badge>{p.medio}</Badge>
                  <Badge tone="naranja">Cargar en Ralpharma</Badge>
                </div>
                <p className="font-semibold truncate">{proveedor(p.proveedorId)?.nombre ?? p.descripcion}</p>
                <p className="text-xs text-seco">
                  {fecha(p.fecha)} · desde {p.cuentaOrigen} · cuenta <span className="text-crema">{p.cuentaContable ?? '—'}</span> · cargado por {p.cargadoPor} el {fechaHora(p.cargadoEn)}
                  {p.numeroCheque ? ` · cheque ${p.numeroCheque}, vence ${fecha(p.fechaAcreditacion)}` : ''}
                </p>
                {p.observaciones && <p className="text-xs italic text-crema mt-1">"{p.observaciones}"</p>}
              </div>
              <div className="text-right space-y-2 shrink-0">
                <p className="font-serif text-xl">{money(p.importe)}</p>
                {puedeConfirmar ? (
                  <Btn variant="secundario" onClick={() => void marcarRalpharma(p.id)}>
                    Confirmo que lo cargué
                  </Btn>
                ) : (
                  <p className="text-[0.6875rem] text-seco">Lo confirma Administración</p>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === 'HECHO' && (
        <div className="space-y-2">
          {facturasHechas.length + pagosHechos.length === 0 && <Empty texto="Todavía no se confirmó ninguna carga." />}
          {facturasHechas.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-2 rounded-xl border border-borde bg-pino text-sm">
              <Badge tone="verde">Factura</Badge>
              <span className="flex-1 truncate">
                {empresa(f.empresaId).corto} · {proveedor(f.proveedorId)?.nombre} · {nroComprobante(f.puntoVenta, f.numero)}
              </span>
              <span className="text-xs text-seco">
                {f.ralpharmaPor ?? '—'} · {fechaHora(f.ralpharmaEn)}
              </span>
              <span className="font-semibold">{money(f.total)}</span>
            </div>
          ))}
          {pagosHechos.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-2 rounded-xl border border-borde bg-pino text-sm">
              <Badge tone="verde">Pago</Badge>
              <span className="flex-1 truncate">
                {empresa(p.empresaId).corto} · {proveedor(p.proveedorId)?.nombre ?? p.descripcion}
              </span>
              <span className="text-xs text-seco">
                {p.contabilizadoPor ?? '—'} · {fechaHora(p.contabilizadoEn)}
              </span>
              <span className="font-semibold">{money(p.importe)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
