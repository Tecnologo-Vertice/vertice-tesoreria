import { useEffect, useId, useState, type ReactNode } from 'react'
import { diasHasta } from '../lib/format'
import { enLista } from '../lib/cuentas'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  // Padding por defecto, salvo que la tarjeta pida el suyo (p-0 para encabezado y cuerpo con borde propio).
  const pad = /(^|\s)p-\d/.test(className) ? '' : 'p-6'
  return <div className={`bg-pino border border-borde rounded-2xl ${pad} fade-up ${className}`}>{children}</div>
}

export function Kpi({ label, value, sub, tone = 'crema' }: { label: string; value: string; sub?: string; tone?: 'crema' | 'dorado' | 'rojo' | 'verde' }) {
  const color = { crema: 'text-crema', dorado: 'text-acento', rojo: 'text-red-300', verde: 'text-emerald-300' }[tone]
  const barra = { crema: 'bg-borde', dorado: 'bg-dorado', rojo: 'bg-red-400/80', verde: 'bg-emerald-400/80' }[tone]
  return (
    <div className="relative overflow-hidden bg-pino border border-borde rounded-2xl px-5 py-4 fade-up">
      <span className={`absolute left-0 top-4 bottom-4 w-[3px] rounded-r ${barra}`} />
      <p className="text-[10px] uppercase tracking-[0.16em] text-seco font-bold">{label}</p>
      <p className={`font-serif text-[2.1rem] leading-tight mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-seco mt-0.5">{sub}</p>}
    </div>
  )
}

type Tone = 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja'
const TONES: Record<Tone, string> = {
  neutro: 'border-borde text-seco',
  dorado: 'border-dorado/60 text-acento bg-dorado/10',
  rojo: 'border-red-700 text-red-300 bg-red-950/30',
  verde: 'border-emerald-700 text-emerald-300 bg-emerald-950/30',
  azul: 'border-sky-700 text-sky-300 bg-sky-950/30',
  naranja: 'border-amber-600 text-amber-300 bg-amber-950/30',
}

export function Badge({ children, tone = 'neutro', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-[3px] rounded-md border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${TONES[tone]}`}>
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
  const base = 'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl text-[13px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const v = {
    primario: 'bg-dorado text-sobre-oro hover:bg-[#ffd966]',
    secundario: 'bg-transparent border border-borde text-crema hover:border-acento hover:text-acento',
    peligro: 'bg-red-900/60 border border-red-800 text-red-200 hover:bg-red-800',
    fantasma: 'text-seco hover:text-acento px-2',
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
      <span className="text-[10px] uppercase tracking-[0.14em] font-bold text-seco flex items-center gap-2">
        {label}
        {marcado === 'ia' && <span className="text-acento normal-case tracking-normal font-semibold">✦ leído por IA</span>}
        {marcado === 'falta' && <span className="text-red-300 normal-case tracking-normal font-semibold">falta</span>}
      </span>
      <div className={`mt-1.5 rounded-xl ${borde}`}>{children}</div>
      {hint && <span className="text-[12px] text-seco mt-1 block leading-snug">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full h-10 bg-botella border border-borde text-crema text-sm rounded-xl px-3 focus:border-acento focus:ring-2 focus:ring-dorado/30 outline-none transition-shadow'

/**
 * Cuenta contable con buscador: el plan real tiene cientos de cuentas por empresa. Solo vale lo que está
 * en la lista (regla de oro: siempre una cuenta de Xubio); si se escribe otra cosa, queda marcado en rojo.
 */
export function SelectorCuenta({ value, onChange, opciones, placeholder = 'Escribí para buscar…' }: { value: string; onChange: (v: string) => void; opciones: string[]; placeholder?: string }) {
  const id = useId()
  const valido = !value || enLista(opciones, value) !== null
  return (
    <>
      <input
        list={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          const exacta = enLista(opciones, value)
          if (exacta && exacta !== value) onChange(exacta)
        }}
        placeholder={placeholder}
        className={`${inputCls} ${valido ? '' : 'border-red-600'}`}
      />
      <datalist id={id}>
        {opciones.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {!valido && <span className="text-[12px] text-red-300 mt-1 block">No está en el plan de cuentas de esta empresa: elegí una de la lista.</span>}
    </>
  )
}

/**
 * Datos en una tabla de dos columnas con esquinas redondeadas (lo que leyó la IA, el detalle de un pago).
 * Las filas sin valor no se muestran.
 */
export function TablaDatos({ filas, titulo, accion }: { filas: [string, ReactNode][]; titulo?: string; accion?: ReactNode }) {
  const visibles = filas.filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
  return (
    <div className="rounded-xl border border-borde overflow-hidden">
      {(titulo || accion) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-suave border-b border-borde">
          {titulo && <span className="text-[10px] uppercase tracking-[0.16em] font-bold text-seco">{titulo}</span>}
          {accion}
        </div>
      )}
      <table className="w-full text-sm">
        <tbody>
          {visibles.map(([k, v], i) => (
            <tr key={k} className={i % 2 ? 'bg-suave/50' : ''}>
              <th scope="row" className="text-left font-normal text-seco px-4 py-2 w-[42%] align-top">
                {k}
              </th>
              <td className="px-4 py-2 text-right text-crema tabular align-top">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Modal({ titulo, children, onClose, ancho = 'max-w-2xl' }: { titulo: string; children: ReactNode; onClose: () => void; ancho?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className={`bg-pino border border-borde rounded-2xl w-full ${ancho} max-h-[92vh] overflow-y-auto fade-up`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-borde sticky top-0 bg-pino z-10">
          <h3 className="font-serif text-2xl text-crema">{titulo}</h3>
          <button onClick={onClose} className="text-seco hover:text-acento text-xl leading-none" aria-label="Cerrar">
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

export function Empty({ texto }: { texto: string }) {
  return <div className="text-center py-14 text-seco border border-dashed border-borde rounded-2xl">{texto}</div>
}

/** Pestañas como control segmentado. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; n?: number; tone?: Tone }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1 p-1 rounded-2xl bg-suave border border-borde">
      {tabs.map((t) => {
        const activo = t.id === value
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`h-9 px-4 rounded-xl text-[13px] font-bold transition-colors ${activo ? 'bg-pino text-crema border border-borde' : 'text-seco hover:text-crema border border-transparent'}`}
          >
            {t.label}
            {t.n !== undefined && (
              <span className={`ml-2 inline-block min-w-5 px-1.5 rounded-md text-[11px] tabular ${activo ? 'bg-dorado text-sobre-oro' : 'bg-borde/60 text-crema'}`}>{t.n}</span>
            )}
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
        <thead className="bg-suave text-[10px] uppercase tracking-[0.14em] text-seco">
          <tr>
            {head.map((h) => (
              <th key={h} className="text-left px-4 py-3 font-bold whitespace-nowrap">
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

/** Modo claro / oscuro. Lo elegido queda guardado; el primer día sigue al del sistema. */
export function BotonTema() {
  const [tema, setTema] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'))
  useEffect(() => {
    document.documentElement.dataset.theme = tema
    try {
      localStorage.setItem('tema', tema)
    } catch {
      /* sin almacenamiento */
    }
  }, [tema])
  const claro = tema === 'light'
  return (
    <button
      onClick={() => setTema(claro ? 'dark' : 'light')}
      title={claro ? 'Pasar a modo oscuro' : 'Pasar a modo claro'}
      aria-label={claro ? 'Pasar a modo oscuro' : 'Pasar a modo claro'}
      className="h-9 w-9 inline-flex items-center justify-center rounded-xl border border-borde text-seco hover:text-acento hover:border-acento transition-colors"
    >
      {claro ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  )
}
