import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { Cheque, TipoCheque } from '../types'
import { Badge, Btn, Desplegable, Empty, Field, inputCls, Kpi, Modal, Tabs } from '../components/ui'
import { AvisoTesoreria, CampoMonto, ModalAnulacionManual, ModalMotivo, PUEDE_ANULAR_XUBIO_A_MANO } from '../components/Tesoreria'
import { addDays, fecha, iso, money, parseIso } from '../lib/format'
import { ESTADO_CHEQUE, parseMonto, sumarHabiles } from '../lib/tesoreria'

type Vista = 'A_DEBITAR' | 'DEBITADOS' | 'ANULADOS' | 'TODOS'
const PUEDE = ['TESORERIA', 'ADMINISTRACION', 'ADMIN']
const TIPOS: Record<TipoCheque, string> = { FISICO: 'Cheque', ECHEQ: 'E-cheq', PAGARE: 'Pagaré' }

export function Cheques() {
  const { tesoreria, empresa, usuario, proveedor } = useStore()
  const [vista, setVista] = useState<Vista>('A_DEBITAR')
  const [empresaId, setEmpresaId] = useState('TODAS')
  const [emitir, setEmitir] = useState(false)
  const [debitar, setDebitar] = useState<Cheque | null>(null)
  const [anular, setAnular] = useState<Cheque | null>(null)
  const [aMano, setAMano] = useState<Cheque | null>(null)
  const [q, setQ] = useState('')
  const puede = PUEDE.includes(usuario.rol)
  const puedeXubio = PUEDE_ANULAR_XUBIO_A_MANO.includes(usuario.rol)

  const lista = useMemo(() => {
    if (!tesoreria) return []
    const t = q.trim().toLowerCase()
    return tesoreria.cheques
      .filter((c) => empresaId === 'TODAS' || c.empresaId === empresaId)
      .filter((c) =>
        vista === 'A_DEBITAR' ? c.estado === 'EMITIDO' || c.estado === 'ENTREGADO' : vista === 'DEBITADOS' ? c.estado === 'DEBITADO' : vista === 'ANULADOS' ? c.estado === 'ANULADO' || c.estado === 'RECHAZADO' : true,
      )
      .filter((c) => !t || [c.numero, c.beneficiario, c.acreedor, c.importe.toFixed(2)].join(' ').toLowerCase().includes(t))
      .sort((a, b) => (vista === 'DEBITADOS' ? (b.debitadoEn ?? '').localeCompare(a.debitadoEn ?? '') : a.fechaPago.localeCompare(b.fechaPago)))
  }, [tesoreria, empresaId, vista, q])

  if (!tesoreria || !tesoreria.disponible) return <AvisoTesoreria />
  const t = tesoreria
  const fer = new Set(t.feriados)
  const cuenta = (id: string) => t.cuentas.find((c) => c.id === id)
  const base = t.cheques.filter((c) => empresaId === 'TODAS' || c.empresaId === empresaId)
  const abiertos = base.filter((c) => c.estado === 'EMITIDO' || c.estado === 'ENTREGADO')
  const en7 = sumarHabiles(t.hoy, 5, fer)
  const vencidos = abiertos.filter((c) => c.fechaPago < t.hoy)
  const proximos = abiertos.filter((c) => c.fechaPago >= t.hoy && c.fechaPago <= en7)
  const mes = t.hoy.slice(0, 7)
  const debitadosMes = base.filter((c) => c.estado === 'DEBITADO' && (c.debitadoEn ?? '').startsWith(mes))
  const suma = (xs: Cheque[]) => xs.reduce((a, c) => a + c.importe, 0)
  const empresas = [...new Set(t.cuentas.map((c) => c.empresaId))]

  // Agrupados por fecha de pago (o de débito en "Debitados").
  const grupos = new Map<string, Cheque[]>()
  for (const c of lista) {
    const k = vista === 'DEBITADOS' ? (c.debitadoEn ?? c.fechaPago) : c.fechaPago
    grupos.set(k, [...(grupos.get(k) ?? []), c])
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Cheques</h2>
          <p className="text-sm text-seco">Cheques y e-cheqs emitidos: el Flujo los proyecta en su fecha de pago y pasan a real cuando se marcan debitados.</p>
        </div>
        <div className="flex gap-2">
          <Desplegable compacto value={empresaId} onChange={setEmpresaId} opciones={[{ value: 'TODAS', label: 'Todas las empresas' }, ...empresas.map((e) => ({ value: e, label: empresa(e).nombre }))]} />
          {puede && <Btn onClick={() => setEmitir(true)}>Emitir cheque</Btn>}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Emitidos sin debitar" value={money(suma(abiertos))} sub={`${abiertos.length} cheque(s)`} tone="dorado" />
        <Kpi label="Se debitan en 5 días hábiles" value={money(suma(proximos))} sub={`${proximos.length} hasta el ${fecha(en7)}`} />
        <Kpi label="Vencidos sin marcar" value={String(vencidos.length)} sub={vencidos.length ? `${money(suma(vencidos))} · ¿se debitaron?` : 'al día'} tone={vencidos.length ? 'rojo' : 'verde'} />
        <Kpi label="Debitados este mes" value={money(suma(debitadosMes))} sub={`${debitadosMes.length} cheque(s)`} tone="verde" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={vista}
          onChange={setVista}
          tabs={[
            { id: 'A_DEBITAR', label: 'A debitar', n: abiertos.length },
            { id: 'DEBITADOS', label: 'Debitados', n: base.filter((c) => c.estado === 'DEBITADO').length },
            { id: 'ANULADOS', label: 'Anulados', n: base.filter((c) => c.estado === 'ANULADO' || c.estado === 'RECHAZADO').length },
            { id: 'TODOS', label: 'Todos' },
          ]}
        />
        <input className={`${inputCls} max-w-xs h-9`} placeholder="Buscar número, beneficiario o importe" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {lista.length === 0 && <Empty texto="No hay cheques para esta selección." />}
      <div className="space-y-5">
        {[...grupos.entries()].map(([dia, cs]) => {
          const vencido = vista !== 'DEBITADOS' && dia < t.hoy && cs.some((c) => c.estado === 'EMITIDO' || c.estado === 'ENTREGADO')
          return (
            <div key={dia} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className={`text-[0.6875rem] uppercase tracking-[0.16em] font-bold ${vencido ? 'text-red-300' : dia === t.hoy ? 'text-acento' : 'text-seco'}`}>
                  {vista === 'DEBITADOS' ? 'Debitado el' : 'Pago'} {fecha(dia)}
                  {dia === t.hoy && ' · hoy'}
                  {vencido && ' · vencido sin marcar'}
                </p>
                <p className="text-xs text-seco tabular">{money(suma(cs))}</p>
              </div>
              {cs.map((c) => {
                const est = ESTADO_CHEQUE[c.estado]
                const abierto = c.estado === 'EMITIDO' || c.estado === 'ENTREGADO'
                return (
                  <div key={c.id} data-cheque={c.numero} className={`flex items-center gap-4 px-4 py-3 rounded-xl border ${abierto && c.fechaPago < t.hoy ? 'border-red-800 bg-red-950/20' : 'border-borde bg-pino'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-0.5">
                        <Badge tone="dorado">{empresa(c.empresaId).corto}</Badge>
                        <Badge tone={est.tone}>{est.label}</Badge>
                        <Badge>{TIPOS[c.tipo]}</Badge>
                        {c.origen !== 'PAGO' && <Badge tone="azul">{c.origen === 'FINANCIERA' ? 'Financiera' : 'Manual'}</Badge>}
                        {c.pagos.length > 1 && <Badge tone="azul">Lote de {c.pagos.length} pagos</Badge>}
                        {(c.anulacionXubio === 'PENDIENTE' || c.anulacionXubio === 'ERROR') && (
                          <Badge tone={c.anulacionXubio === 'ERROR' ? 'rojo' : 'naranja'} title="La emisión es una orden de pago: Xubio no la borra por API">
                            Falta anular en Xubio
                          </Badge>
                        )}
                      </div>
                      <p className="font-semibold truncate">
                        {c.acreedor ?? c.beneficiario}
                        {c.acreedor && c.acreedor !== c.beneficiario && <span className="text-seco font-normal"> · {c.beneficiario}</span>}
                      </p>
                      <p className="text-xs text-seco">
                        N.º <span className="font-mono">{c.numero}</span> · {cuenta(c.cuentaId)?.nombre} · emitido {fecha(c.fechaEmision)}
                        {c.debitadoEn && ` · debitado ${fecha(c.debitadoEn)}${c.marcadoPor ? ` por ${c.marcadoPor}` : ''}`}
                        {c.proveedorId && !c.acreedor && proveedor(c.proveedorId) && c.beneficiario !== proveedor(c.proveedorId)?.nombre ? ` · ${proveedor(c.proveedorId)?.nombre}` : ''}
                      </p>
                      {c.motivoAnulacion && <p className="text-[0.6875rem] text-seco">Anulado por {c.anuladoPor}: {c.motivoAnulacion}</p>}
                      {c.anulacionManualPor && (
                        <p className="text-[0.6875rem] text-seco">
                          Anulado a mano en Xubio por {c.anulacionManualPor}: {c.anulacionManualNota}
                        </p>
                      )}
                      {c.observaciones && !c.motivoAnulacion && <p className="text-[0.6875rem] text-seco">{c.observaciones}</p>}
                    </div>
                    <div className="text-right">
                      <p className="font-serif text-xl tabular">{money(c.importe)}</p>
                      {puede && abierto && (
                        <div className="flex gap-3 justify-end text-[0.75rem] mt-1">
                          <button className="text-acento underline" onClick={() => setDebitar(c)}>
                            Marcar debitado
                          </button>
                          <button className="text-red-300 underline" onClick={() => setAnular(c)}>
                            Anular
                          </button>
                        </div>
                      )}
                      {puedeXubio && (c.anulacionXubio === 'PENDIENTE' || c.anulacionXubio === 'ERROR') && (
                        <button className="text-acento underline text-[0.75rem] mt-1" onClick={() => setAMano(c)}>
                          Ya la anulé en Xubio
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {emitir && <ModalEmitir onClose={() => setEmitir(false)} />}
      {debitar && <ModalDebitado cheque={debitar} onClose={() => setDebitar(null)} />}
      {anular && <ModalAnular cheque={anular} onClose={() => setAnular(null)} />}
      {aMano && (
        <ModalAnulacionManual
          tipo="CHEQUE"
          id={aMano.id}
          titulo="Anulación del cheque en Xubio"
          detalle={
            <>
              N.º <span className="font-mono">{aMano.numero}</span> a {aMano.beneficiario} por {money(aMano.importe)}. La emisión está en Xubio como orden de pago y Xubio no la deja borrar por API.
            </>
          }
          onClose={() => setAMano(null)}
        />
      )}
    </div>
  )
}

function ModalDebitado({ cheque, onClose }: { cheque: Cheque; onClose: () => void }) {
  const { tesoreria, marcarChequeDebitado } = useStore()
  const hoy = tesoreria!.hoy
  const [numero, setNumero] = useState('')
  const [f, setF] = useState(cheque.fechaPago < hoy ? cheque.fechaPago : hoy)
  const [enviando, setEnviando] = useState(false)
  const coincide = numero.trim() === cheque.numero
  return (
    <Modal titulo="Marcar cheque debitado" onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <div className="rounded-xl border border-borde px-4 py-3 text-sm">
          <p className="font-semibold">{cheque.acreedor ?? cheque.beneficiario}</p>
          <p className="text-seco text-xs">
            {money(cheque.importe)} · pago {fecha(cheque.fechaPago)}
          </p>
        </div>
        <Field label="Número del cheque" hint="Escribilo para confirmar que es el que se debitó. Si no coincide, no se marca." marcado={numero && !coincide ? 'falta' : undefined}>
          <input className={`${inputCls} font-mono`} value={numero} onChange={(e) => setNumero(e.target.value)} autoFocus aria-label="Número del cheque" placeholder="N.º del cheque" />
        </Field>
        <Field label="Fecha de débito" hint="El Flujo lo pasa a real en esta fecha.">
          <input type="date" className={inputCls} value={f} max={hoy} onChange={(e) => setF(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!numero.trim() || !f || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await marcarChequeDebitado(cheque.id, numero.trim(), f)
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Marcar debitado
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function ModalAnular({ cheque, onClose }: { cheque: Cheque; onClose: () => void }) {
  const { anularCheque } = useStore()
  return (
    <ModalMotivo
      titulo="Anular cheque"
      texto={
        <>
          N.º <span className="font-mono">{cheque.numero}</span> a {cheque.beneficiario} por {money(cheque.importe)}. Sale del Flujo; si ya estaba en Xubio, queda pendiente de anular allá.
        </>
      }
      confirmar="Anular cheque"
      peligro
      onConfirmar={(m) => anularCheque(cheque.id, m)}
      onClose={onClose}
    />
  )
}

function ModalEmitir({ onClose }: { onClose: () => void }) {
  const { tesoreria, pagos, proveedor, empresa, emitirCheque } = useStore()
  const t = tesoreria!
  const empresas = [...new Set(t.cuentas.map((c) => c.empresaId))]
  const [empresaId, setEmpresaId] = useState(empresas[0] ?? '')
  const chequeras = t.cuentas.filter((c) => c.empresaId === empresaId && (c.clase === 'CC' || c.clase === 'ECHEQ'))
  const [cuentaId, setCuentaId] = useState(chequeras[0]?.id ?? '')
  const [tipo, setTipo] = useState<TipoCheque>('ECHEQ')
  const [numero, setNumero] = useState('')
  const [origen, setOrigen] = useState<Cheque['origen']>('PAGO')
  const [sel, setSel] = useState<string[]>([])
  const [beneficiario, setBeneficiario] = useState('')
  const [importe, setImporte] = useState('')
  const [emision, setEmision] = useState(t.hoy)
  const [pago, setPago] = useState(iso(addDays(parseIso(t.hoy), 30)))
  const [obs, setObs] = useState('')
  const [enviando, setEnviando] = useState(false)

  // Pagos con cheque de la empresa que todavía no tienen su cheque cargado.
  const usados = new Set(t.cheques.flatMap((c) => (c.estado === 'ANULADO' ? [] : c.pagos.map((p) => p.pagoId))))
  const candidatos = pagos.filter((p) => p.empresaId === empresaId && (p.medio === 'CHEQUE' || p.medio === 'ECHEQ') && p.estado !== 'ANULADO' && !usados.has(p.id))
  const elegidos = candidatos.filter((p) => sel.includes(p.id))
  const sumaLote = Math.round(elegidos.reduce((a, p) => a + p.importe, 0) * 100) / 100
  const imp = elegidos.length ? sumaLote : parseMonto(importe)
  const benef = beneficiario || (elegidos.length ? (proveedor(elegidos[0].proveedorId)?.nombre ?? elegidos[0].proveedorDestino ?? '') : '')
  const listo = !!cuentaId && numero.trim() !== '' && benef.trim() !== '' && imp !== null && imp > 0 && pago >= emision

  return (
    <Modal titulo="Emitir cheque" onClose={onClose} ancho="max-w-3xl">
      <div className="space-y-5">
        <div className="grid md:grid-cols-3 gap-3">
          <Field label="Empresa">
            <Desplegable
              value={empresaId}
              onChange={(v) => {
                setEmpresaId(v)
                setSel([])
                setCuentaId(t.cuentas.find((c) => c.empresaId === v && (c.clase === 'CC' || c.clase === 'ECHEQ'))?.id ?? '')
              }}
              opciones={empresas.map((e) => ({ value: e, label: empresa(e).nombre }))}
            />
          </Field>
          <Field label="Chequera (banco que debita)">
            <Desplegable value={cuentaId} onChange={setCuentaId} opciones={chequeras.map((c) => ({ value: c.id, label: c.nombre }))} />
          </Field>
          <Field label="Tipo">
            <Desplegable value={tipo} onChange={(v) => setTipo(v as TipoCheque)} opciones={(Object.keys(TIPOS) as TipoCheque[]).map((k) => ({ value: k, label: TIPOS[k] }))} />
          </Field>
          <Field label="Número">
            <input className={`${inputCls} font-mono`} value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="00000000" aria-label="Número" />
          </Field>
          <Field label="Origen">
            <Desplegable
              value={origen}
              onChange={(v) => setOrigen(v as Cheque['origen'])}
              opciones={[
                { value: 'PAGO', label: 'Pago a proveedor' },
                { value: 'FINANCIERA', label: 'Financiera' },
                { value: 'MANUAL', label: 'Manual' },
              ]}
            />
          </Field>
          <Field label="Beneficiario">
            <input className={inputCls} value={benef} onChange={(e) => setBeneficiario(e.target.value)} placeholder="Como figura en el cheque" aria-label="Beneficiario" />
          </Field>
          <Field label="Fecha de emisión">
            <input type="date" className={inputCls} value={emision} onChange={(e) => setEmision(e.target.value)} />
          </Field>
          <Field label="Fecha de pago" hint={pago < emision ? 'No puede ser anterior a la emisión' : 'El Flujo lo proyecta este día.'} marcado={pago < emision ? 'falta' : undefined}>
            <input type="date" className={inputCls} value={pago} onChange={(e) => setPago(e.target.value)} />
          </Field>
          <Field label="Importe" hint={elegidos.length ? `Suma de ${elegidos.length} pago(s) del lote` : undefined}>
            {elegidos.length ? <input className={`${inputCls} text-right tabular`} value={money(sumaLote)} readOnly aria-label="Importe" /> : <CampoMonto value={importe} onChange={setImporte} />}
          </Field>
        </div>

        <div>
          <p className="text-[0.625rem] uppercase tracking-[0.14em] font-bold text-seco mb-2">Pagos que cubre (opcional: uno o un lote)</p>
          {candidatos.length === 0 ? (
            <p className="text-sm text-seco italic">No hay pagos con cheque de esta empresa sin su cheque cargado.</p>
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto">
              {candidatos.map((p) => {
                const m = sel.includes(p.id)
                return (
                  <label key={p.id} className={`flex items-center gap-3 px-3 py-2 rounded-xl border cursor-pointer text-sm ${m ? 'border-dorado bg-dorado/10' : 'border-borde'}`}>
                    <input type="checkbox" className="accent-dorado w-4 h-4" checked={m} onChange={() => setSel((s) => (m ? s.filter((x) => x !== p.id) : [...s, p.id]))} />
                    <span className="flex-1 truncate">
                      {proveedor(p.proveedorId)?.nombre ?? p.proveedorDestino ?? p.descripcion} <span className="text-seco">· {fecha(p.fecha)}</span>
                    </span>
                    <span className="tabular">{money(p.importe)}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <Field label="Observaciones">
          <input className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!listo || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await emitirCheque({
                empresaId,
                cuentaId,
                tipo,
                numero: numero.trim(),
                beneficiario: benef.trim(),
                proveedorId: elegidos[0]?.proveedorId,
                importe: imp!,
                fechaEmision: emision,
                fechaPago: pago,
                origen,
                observaciones: obs.trim() || undefined,
                pagos: elegidos.map((p) => ({ pagoId: p.id, importe: p.importe })),
              })
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Emitir {imp ? money(imp) : ''}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
