// Piezas compartidas por Bancos, Cheques y Flujo.

import { useState, type ReactNode } from 'react'
import { useStore } from '../store'
import type { Factura, TipoPagoFactura } from '../types'
import { Btn, Desplegable, Field, inputCls, Modal } from './ui'
import { fecha, money, nroComprobante, pendiente } from '../lib/format'
import { parseMonto, sumarHabiles } from '../lib/tesoreria'

/** Aviso cuando la base todavía no tiene las migraciones de Tesorería. */
export function AvisoTesoreria(): ReactNode {
  const { tesoreria, modo } = useStore()
  if (!tesoreria) return <p className="text-seco">Cargando Tesorería…</p>
  if (tesoreria.disponible) return null
  return (
    <div className="rounded-2xl border border-amber-600 bg-amber-950/30 p-6 text-sm text-amber-100 space-y-1">
      <p className="font-bold">Tesorería todavía no está disponible en esta base.</p>
      <p>Faltan las migraciones 0023 a 0027 (bancos, cheques y Flujo sin planillas){modo === 'conectado' ? ' o tu usuario no tiene acceso' : ''}.</p>
      {tesoreria.error && <p className="text-xs opacity-80">Detalle: {tesoreria.error}</p>}
    </div>
  )
}

/** Campo de importe en formato argentino (1.234,56). */
export function CampoMonto({ value, onChange, placeholder = '0,00', autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const n = parseMonto(value)
  return (
    <div>
      <input className={`${inputCls} text-right tabular`} inputMode="decimal" value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
      {value && n === null && <span className="text-[0.75rem] text-red-300">No es un importe válido</span>}
      {value && n !== null && <span className="text-[0.75rem] text-seco">{money(n)}</span>}
    </div>
  )
}

/** Pide el motivo (obligatorio) antes de una acción que queda en el historial. */
export function ModalMotivo({
  titulo,
  texto,
  confirmar,
  peligro,
  children,
  listo = true,
  onConfirmar,
  onClose,
}: {
  titulo: string
  texto?: ReactNode
  confirmar: string
  peligro?: boolean
  children?: ReactNode
  /** Los campos extra están completos. */
  listo?: boolean
  onConfirmar: (motivo: string) => Promise<boolean>
  onClose: () => void
}) {
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  return (
    <Modal titulo={titulo} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        {texto && <div className="text-sm text-seco">{texto}</div>}
        {children}
        <Field label="Motivo" hint="Queda en el historial con tu nombre.">
          <input className={inputCls} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Por qué" autoFocus={!children} aria-label="Motivo" />
        </Field>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            variant={peligro ? 'peligro' : 'primario'}
            disabled={!motivo.trim() || !listo || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await onConfirmar(motivo.trim())
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            {confirmar}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

export const FORMAS_PAGO: Record<TipoPagoFactura, string> = {
  CUENTA_CORRIENTE: 'Cuenta corriente',
  ANTICIPADO: 'Anticipado',
  ANTICIPO_PARCIAL: 'Anticipo % + Cta. Cte.',
}

export function etiquetaFormaPago(f: Pick<Factura, 'tipoPago' | 'anticipoPct'>): string | null {
  if (!f.tipoPago) return null
  return f.tipoPago === 'ANTICIPO_PARCIAL' ? `Anticipo ${String(f.anticipoPct ?? '').replace('.', ',')} % + Cta. Cte.` : FORMAS_PAGO[f.tipoPago]
}

/** Forma de pago de una factura (definir_pago_factura): con anticipo, el Flujo la proyecta en dos tramos. */
export function ModalFormaPago({ factura, onClose }: { factura: Factura; onClose: () => void }) {
  const { definirPagoFactura, tesoreria, proveedor } = useStore()
  const [tipo, setTipo] = useState<TipoPagoFactura>(factura.tipoPago ?? 'CUENTA_CORRIENTE')
  const [pct, setPct] = useState(factura.anticipoPct ? String(factura.anticipoPct).replace('.', ',') : '30')
  const unidades = tesoreria?.unidades.filter((u) => u.empresaId === factura.empresaId) ?? []
  const [unidad, setUnidad] = useState(factura.unidadId ?? unidades.find((u) => u.porDefecto)?.id ?? '')
  const [enviando, setEnviando] = useState(false)
  const p = parseMonto(pct)
  const pctOk = tipo !== 'ANTICIPO_PARCIAL' || (p !== null && p > 0 && p < 100)
  const resto = pendiente(factura)
  const anticipo = tipo === 'ANTICIPO_PARCIAL' && p ? Math.max(Math.round(factura.total * p) / 100 - factura.pagado, 0) : 0
  const fer = new Set(tesoreria?.feriados ?? [])
  const manana = tesoreria ? sumarHabiles(tesoreria.hoy, 1, fer) : undefined
  return (
    <Modal titulo="Forma de pago" onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-seco">
          {proveedor(factura.proveedorId)?.nombre} · {factura.tipo} {nroComprobante(factura.puntoVenta, factura.numero)} · pendiente {money(resto)}
        </p>
        <div className="grid gap-2">
          {(Object.keys(FORMAS_PAGO) as TipoPagoFactura[]).map((t) => (
            <label key={t} className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer ${tipo === t ? 'border-dorado bg-dorado/10' : 'border-borde'}`}>
              <input type="radio" name="forma" checked={tipo === t} onChange={() => setTipo(t)} className="accent-dorado" />
              <span className="font-bold text-sm">{FORMAS_PAGO[t]}</span>
            </label>
          ))}
        </div>
        {tipo === 'ANTICIPO_PARCIAL' && (
          <Field label="Porcentaje de anticipo" hint={pctOk ? `Anticipo pendiente ${money(anticipo)} el ${fecha(manana)} (próximo día hábil); el resto, ${money(Math.max(resto - anticipo, 0))}, a su fecha de pago.` : 'Entre 0 y 100 %'}>
            <input className={`${inputCls} text-right`} value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" aria-label="Porcentaje de anticipo" />
          </Field>
        )}
        {unidades.length > 1 && (
          <Field label="Pestaña del Flujo">
            <Desplegable value={unidad} onChange={setUnidad} opciones={unidades.map((u) => ({ value: u.id, label: u.nombre }))} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!pctOk || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await definirPagoFactura(factura.id, tipo, tipo === 'ANTICIPO_PARCIAL' ? p : null, unidad || null)
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Guardar
          </Btn>
        </div>
      </div>
    </Modal>
  )
}
