import type { ReactNode } from 'react'
import { diasHasta } from '../lib/format'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-pino/50 border border-borde rounded-xl p-5 fade-up ${className}`}>{children}</div>
}

export function Kpi({ label, value, sub, tone = 'crema' }: { label: string; value: string; sub?: string; tone?: 'crema' | 'dorado' | 'rojo' | 'verde' }) {
  const color = { crema: 'text-crema', dorado: 'text-dorado', rojo: 'text-red-300', verde: 'text-emerald-300' }[tone]
  return (
    <Card className="py-4">
      <p className="text-[10px] uppercase tracking-widest text-seco">{label}</p>
      <p className={`font-serif text-3xl mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-seco mt-1">{sub}</p>}
    </Card>
  )
}

type Tone = 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja'
const TONES: Record<Tone, string> = {
  neutro: 'border-borde text-seco',
  dorado: 'border-dorado/60 text-dorado',
  rojo: 'border-red-700 text-red-300 bg-red-950/30',
  verde: 'border-emerald-700 text-emerald-300 bg-emerald-950/30',
  azul: 'border-sky-700 text-sky-300 bg-sky-950/30',
  naranja: 'border-amber-600 text-amber-300 bg-amber-950/30',
}

export function Badge({ children, tone = 'neutro', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  )
}

export function BadgeVencimiento({ vencimiento }: { vencimiento: string }) {
  const d = diasHasta(vencimiento)
  if (d < 0) return <Badge tone="rojo">Vencida hace {-d} d</Badge>
  if (d === 0) return <Badge tone="naranja">Vence hoy</Badge>
  if (d <= 7) return <Badge tone="dorado">Vence en {d} d</Badge>
  return <Badge>En {d} d</Badge>
}

export function Btn({
  children,
  onClick,
  variant = 'primario',
  disabled,
  type = 'button',
  className = '',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primario' | 'secundario' | 'peligro' | 'fantasma'
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
  title?: string
}) {
  const base = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed'
  const v = {
    primario: 'bg-dorado text-botella hover:bg-yellow-300',
    secundario: 'bg-transparent border border-borde text-crema hover:border-dorado hover:text-dorado',
    peligro: 'bg-red-900/60 border border-red-800 text-red-200 hover:bg-red-800',
    fantasma: 'text-seco hover:text-dorado',
  }[variant]
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={`${base} ${v} ${className}`}>
      {children}
    </button>
  )
}

export function Field({ label, children, hint, marcado }: { label: string; children: ReactNode; hint?: string; marcado?: 'ia' | 'falta' }) {
  const borde = marcado === 'ia' ? 'ring-1 ring-dorado/70' : marcado === 'falta' ? 'ring-1 ring-red-500/70' : ''
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-widest text-seco flex items-center gap-2">
        {label}
        {marcado === 'ia' && <span className="text-dorado normal-case tracking-normal">✦ leído por IA</span>}
        {marcado === 'falta' && <span className="text-red-300 normal-case tracking-normal">falta</span>}
      </span>
      <div className={`mt-1 rounded-lg ${borde}`}>{children}</div>
      {hint && <span className="text-[11px] text-seco mt-1 block">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full bg-botella border border-borde text-crema text-sm rounded-lg px-3 py-2 focus:border-dorado outline-none'

export function Modal({ titulo, children, onClose, ancho = 'max-w-2xl' }: { titulo: string; children: ReactNode; onClose: () => void; ancho?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className={`bg-pino border border-borde rounded-xl w-full ${ancho} max-h-[92vh] overflow-y-auto shadow-2xl fade-up`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-borde sticky top-0 bg-pino z-10">
          <h3 className="font-serif text-2xl text-crema">{titulo}</h3>
          <button onClick={onClose} className="text-seco hover:text-dorado text-xl leading-none">
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

export function Empty({ texto }: { texto: string }) {
  return <div className="text-center py-16 text-seco italic">{texto}</div>
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; n?: number; tone?: Tone }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((t) => {
        const activo = t.id === value
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all border ${activo ? 'bg-dorado text-botella border-dorado' : 'bg-transparent border-borde text-crema hover:border-dorado'}`}
          >
            {t.label}
            {t.n !== undefined && <span className={`ml-2 px-1.5 rounded-full text-[10px] ${activo ? 'bg-botella/20' : 'bg-borde'}`}>{t.n}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-borde">
      <table className="w-full text-sm">
        <thead className="bg-pino/80 text-[10px] uppercase tracking-widest text-seco">
          <tr>
            {head.map((h) => (
              <th key={h} className="text-left px-4 py-3 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-borde/60">{children}</tbody>
      </table>
    </div>
  )
}
