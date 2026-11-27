import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { diasHasta } from '../lib/format'
import { enLista, norm } from '../lib/cuentas'

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
      <p className="text-[0.625rem] uppercase tracking-[0.16em] text-seco font-bold">{label}</p>
      {/* Montos largos (miles de millones): letra más chica en vez de cortarse. */}
      <p title={value} className={`font-serif leading-tight mt-1 whitespace-nowrap ${value.length > 16 ? 'text-[1.35rem]' : value.length > 13 ? 'text-[1.65rem]' : 'text-[2.1rem]'} ${color}`}>{value}</p>
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
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-[3px] rounded-md border text-[0.625rem] font-bold uppercase tracking-wider whitespace-nowrap ${TONES[tone]}`}>
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
  const base = 'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl text-[0.8125rem] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
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
      <span className="text-[0.625rem] uppercase tracking-[0.14em] font-bold text-seco flex items-center gap-2">
        {label}
        {marcado === 'ia' && <span className="text-acento normal-case tracking-normal font-semibold">✦ leído por IA</span>}
        {marcado === 'falta' && <span className="text-red-300 normal-case tracking-normal font-semibold">falta</span>}
      </span>
      <div className={`mt-1.5 rounded-xl ${borde}`}>{children}</div>
      {hint && <span className="text-[0.75rem] text-seco mt-1 block leading-snug">{hint}</span>}
    </label>
  )
}

export const inputCls = 'w-full h-10 bg-botella border border-borde text-crema text-sm rounded-xl px-3 focus:border-acento focus:ring-2 focus:ring-dorado/30 outline-none transition-shadow'

/**
 * Menú que flota sobre la pantalla debajo (o arriba, si no entra) de su ancla. Va en un portal porque las
 * tarjetas recortan lo que se sale de ellas. Se cierra con un clic afuera.
 */
function MenuFlotante({ ancla, onCerrar, children, anchoMin = 0 }: { ancla: HTMLElement | null; onCerrar: () => void; children: ReactNode; anchoMin?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const cerrar = useRef(onCerrar)
  cerrar.current = onCerrar
  const [pos, setPos] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!ancla) return
    const ubicar = () => {
      const r = ancla.getBoundingClientRect()
      const abajo = window.innerHeight - r.bottom - 12
      // Alto del contenido (no de la caja, que ya puede estar recortada)
      const alto = Math.min(Array.from(ref.current?.children ?? []).reduce((s, h) => s + h.scrollHeight, 2), 340)
      const arriba = abajo < alto && r.top > abajo
      const ancho = Math.min(Math.max(r.width, anchoMin), window.innerWidth - 16)
      setPos({
        position: 'fixed',
        left: Math.max(8, Math.min(r.left, window.innerWidth - ancho - 8)),
        width: ancho,
        maxHeight: Math.min(340, arriba ? r.top - 12 : abajo),
        ...(arriba ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      })
    }
    ubicar()
    // Si la lista se achica o agranda (al filtrar), se vuelve a ubicar
    const obs = new ResizeObserver(ubicar)
    for (const h of Array.from(ref.current?.children ?? [])) obs.observe(h)
    window.addEventListener('scroll', ubicar, true)
    window.addEventListener('resize', ubicar)
    return () => {
      obs.disconnect()
      window.removeEventListener('scroll', ubicar, true)
      window.removeEventListener('resize', ubicar)
    }
  }, [ancla, anchoMin])

  useEffect(() => {
    const fuera = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !ancla?.contains(t)) cerrar.current()
    }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [ancla])

  return createPortal(
    <div ref={ref} style={pos} className="z-[70] flex flex-col overflow-hidden rounded-xl border border-borde bg-pino menu-flotante">
      {children}
    </div>,
    document.body,
  )
}

function OpcionMenu({ activa, elegida, onElegir, onActivar, children, detalle, i }: { activa: boolean; elegida: boolean; onElegir: () => void; onActivar: () => void; children: ReactNode; detalle?: string; i: number }) {
  return (
    <div
      role="option"
      aria-selected={elegida}
      data-i={i}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onActivar}
      onClick={onElegir}
      className={`flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer text-sm leading-snug ${activa ? 'bg-suave' : ''} ${elegida ? 'text-acento font-bold' : 'text-crema'}`}
    >
      <span className="flex-1 min-w-0 break-words">
        {children}
        {detalle && <span className="block text-[0.75rem] font-normal text-seco">{detalle}</span>}
      </span>
      {elegida && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
          <path d="M5 12l5 5 9-10" />
        </svg>
      )}
    </div>
  )
}

const Flecha = ({ abierto }: { abierto?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-seco transition-transform ${abierto ? 'rotate-180' : ''}`}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

/** Flechas, Enter y Escape para moverse en una lista abierta. */
function teclasLista(e: ReactKeyboardEvent, n: number, setActivo: (f: (i: number) => number) => void, elegir: () => void, cerrar: () => void) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setActivo((i) => Math.min(i + 1, n - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setActivo((i) => Math.max(i - 1, 0))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    elegir()
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    cerrar()
  }
}

export interface Opcion {
  value: string
  label: string
  detalle?: string
}

/**
 * Desplegable propio en lugar del <select> del navegador (que no respeta el diseño).
 * Con más de 8 opciones aparece un buscador arriba. `compacto` es para las barras de filtros.
 */
export function Desplegable({
  value,
  onChange,
  opciones,
  placeholder = 'Elegir…',
  disabled,
  buscar,
  compacto,
  className = '',
  title,
  anchoMenu = 240,
}: {
  value: string
  onChange: (v: string) => void
  opciones: Opcion[]
  placeholder?: string
  disabled?: boolean
  buscar?: boolean
  compacto?: boolean
  className?: string
  title?: string
  anchoMenu?: number
}) {
  const [abierto, setAbierto] = useState(false)
  const [q, setQ] = useState('')
  const [activo, setActivo] = useState(0)
  const boton = useRef<HTMLButtonElement>(null)
  const lista = useRef<HTMLDivElement>(null)
  const elegida = opciones.find((o) => o.value === value)
  const conBuscador = buscar ?? opciones.length > 8
  const visibles = useMemo(() => (q ? opciones.filter((o) => norm(`${o.label} ${o.detalle ?? ''}`).includes(norm(q))) : opciones), [opciones, q])
  const cerrar = useCallback(() => setAbierto(false), [])

  useEffect(() => {
    if (abierto) lista.current?.querySelector(`[data-i="${activo}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activo, abierto])

  const abrir = () => {
    setQ('')
    setActivo(Math.max(0, opciones.findIndex((o) => o.value === value)))
    setAbierto(true)
  }
  const elegir = (o: Opcion | undefined) => {
    if (!o) return
    onChange(o.value)
    setAbierto(false)
    boton.current?.focus()
  }
  const teclas = (e: ReactKeyboardEvent) =>
    teclasLista(e, visibles.length, setActivo, () => elegir(visibles[activo]), () => {
      setAbierto(false)
      if (e.key === 'Escape') boton.current?.focus()
    })

  return (
    <>
      <button
        ref={boton}
        type="button"
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        onClick={() => (abierto ? setAbierto(false) : abrir())}
        onKeyDown={(e) => {
          if (!abierto && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            abrir()
          } else if (abierto && !conBuscador) teclas(e)
        }}
        className={`${compacto ? 'h-9 rounded-xl px-3 bg-botella max-w-[15rem]' : 'w-full h-10 rounded-xl px-3 bg-botella'} inline-flex items-center gap-2 border text-sm text-left outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          abierto ? 'border-acento ring-2 ring-dorado/30' : 'border-borde hover:border-acento/60 focus-visible:border-acento focus-visible:ring-2 focus-visible:ring-dorado/30'
        } ${className}`}
      >
        <span className={`flex-1 min-w-0 truncate ${elegida ? 'text-crema' : 'text-seco'}`}>{elegida?.label ?? placeholder}</span>
        <Flecha abierto={abierto} />
      </button>
      {abierto && (
        <MenuFlotante ancla={boton.current} onCerrar={cerrar} anchoMin={anchoMenu}>
          {conBuscador && (
            <div className="p-2 border-b border-borde">
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setActivo(0)
                }}
                onKeyDown={teclas}
                placeholder="Buscar…"
                className="w-full h-9 bg-botella border border-borde text-crema text-sm rounded-lg px-3 outline-none focus:border-acento"
              />
            </div>
          )}
          <div ref={lista} role="listbox" className="flex-1 overflow-y-auto p-1.5">
            {visibles.length === 0 && <p className="px-3 py-2 text-sm text-seco">Sin resultados</p>}
            {visibles.map((o, i) => (
              <OpcionMenu key={o.value} i={i} activa={i === activo} elegida={o.value === value} detalle={o.detalle} onActivar={() => setActivo(i)} onElegir={() => elegir(o)}>
                {o.label}
              </OpcionMenu>
            ))}
          </div>
        </MenuFlotante>
      )}
    </>
  )
}

/**
 * Campo de texto con sugerencias propias (en lugar del <datalist> del navegador). Muestra hasta 80 coincidencias.
 * `soloLista`: lo escrito tiene que ser una de las opciones; si no, queda marcado en rojo con ese mensaje.
 */
export function Combo({ value, onChange, opciones, placeholder = 'Escribí para buscar…', soloLista }: { value: string; onChange: (v: string) => void; opciones: string[]; placeholder?: string; soloLista?: string }) {
  const [abierto, setAbierto] = useState(false)
  const [activo, setActivo] = useState(0)
  const caja = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const lista = useRef<HTMLDivElement>(null)
  const exacta = enLista(opciones, value)
  // Mientras se está eligiendo no se marca error: recién al salir del campo
  const valido = !soloLista || !value || exacta !== null || abierto
  const coinciden = useMemo(() => (value && !exacta ? opciones.filter((o) => norm(o).includes(norm(value))) : opciones), [opciones, value, exacta])
  const visibles = coinciden.slice(0, 80)
  const cerrar = useCallback(() => setAbierto(false), [])

  useEffect(() => {
    if (abierto) lista.current?.querySelector(`[data-i="${activo}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activo, abierto])

  const elegir = (o: string | undefined) => {
    if (o === undefined) return
    onChange(o)
    setAbierto(false)
  }

  return (
    <>
      <div ref={caja} className="relative">
        <input
          ref={input}
          value={value}
          role="combobox"
          aria-expanded={abierto}
          onFocus={() => {
            setActivo(Math.max(0, exacta ? opciones.indexOf(exacta) : 0))
            setAbierto(true)
          }}
          onClick={() => setAbierto(true)}
          onChange={(e) => {
            onChange(e.target.value)
            setActivo(0)
            setAbierto(true)
          }}
          onKeyDown={(e) => {
            if (!abierto && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setAbierto(true)
              return
            }
            if (abierto) teclasLista(e, visibles.length, setActivo, () => elegir(visibles[activo]), cerrar)
          }}
          onBlur={() => {
            setAbierto(false)
            if (exacta && exacta !== value) onChange(exacta)
          }}
          placeholder={placeholder}
          className={`${inputCls} pr-9 ${valido ? '' : 'border-red-600'}`}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          <Flecha abierto={abierto} />
        </span>
      </div>
      {abierto && visibles.length > 0 && (
        <MenuFlotante ancla={caja.current} onCerrar={cerrar} anchoMin={280}>
          <div ref={lista} role="listbox" className="flex-1 overflow-y-auto p-1.5">
            {visibles.map((o, i) => (
              <OpcionMenu key={o} i={i} activa={i === activo} elegida={o === exacta} onActivar={() => setActivo(i)} onElegir={() => elegir(o)}>
                {o}
              </OpcionMenu>
            ))}
          </div>
          {coinciden.length > visibles.length && <p className="px-4 py-2 border-t border-borde text-[0.75rem] text-seco">y {coinciden.length - visibles.length} más: escribí para achicar la lista</p>}
        </MenuFlotante>
      )}
      {!valido && <span className="text-[0.75rem] text-red-300 mt-1 block">{soloLista}</span>}
    </>
  )
}

/**
 * Cuenta contable con buscador: el plan real tiene cientos de cuentas por empresa. Solo vale lo que está
 * en la lista (regla de oro: siempre una cuenta de Xubio); si se escribe otra cosa, queda marcado en rojo.
 */
export function SelectorCuenta({ value, onChange, opciones, placeholder }: { value: string; onChange: (v: string) => void; opciones: string[]; placeholder?: string }) {
  return <Combo value={value} onChange={onChange} opciones={opciones} placeholder={placeholder} soloLista="No está en el plan de cuentas de esta empresa: elegí una de la lista." />
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
          {titulo && <span className="text-[0.625rem] uppercase tracking-[0.16em] font-bold text-seco">{titulo}</span>}
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
            className={`h-9 px-4 rounded-xl text-[0.8125rem] font-bold transition-colors ${activo ? 'bg-pino text-crema border border-borde' : 'text-seco hover:text-crema border border-transparent'}`}
          >
            {t.label}
            {t.n !== undefined && (
              <span className={`ml-2 inline-block min-w-5 px-1.5 rounded-md text-[0.6875rem] tabular ${activo ? 'bg-dorado text-sobre-oro' : 'bg-borde/60 text-crema'}`}>{t.n}</span>
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
        <thead className="bg-suave text-[0.625rem] uppercase tracking-[0.14em] text-seco">
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

const LETRAS = [
  { id: 'normal', label: 'Letra normal', tam: 'text-[0.75rem]' },
  { id: 'grande', label: 'Letra grande', tam: 'text-[0.9rem]' },
  { id: 'mayor', label: 'Letra más grande', tam: 'text-[1.05rem]' },
] as const
type Letra = (typeof LETRAS)[number]['id']

/** Tamaño de letra en tres niveles: agranda todo el sistema en proporción (texto, botones y espacios). Queda guardado. */
export function BotonLetra() {
  const [letra, setLetra] = useState<Letra>(() => (LETRAS.find((l) => l.id === document.documentElement.dataset.letra)?.id ?? 'normal'))
  useEffect(() => {
    document.documentElement.dataset.letra = letra
    try {
      localStorage.setItem('letra', letra)
    } catch {
      /* sin almacenamiento */
    }
  }, [letra])
  return (
    <div role="group" aria-label="Tamaño de letra" className="inline-flex items-center h-9 p-0.5 rounded-xl border border-borde">
      {LETRAS.map((l) => (
        <button
          key={l.id}
          onClick={() => setLetra(l.id)}
          title={l.label}
          aria-label={l.label}
          aria-pressed={letra === l.id}
          className={`h-full w-8 rounded-[0.6rem] font-serif font-bold leading-none transition-colors ${l.tam} ${letra === l.id ? 'bg-suave text-acento' : 'text-seco hover:text-acento'}`}
        >
          A
        </button>
      ))}
    </div>
  )
}
