// Barra de búsqueda, filtros y orden para las bandejas (como la del dashboard de producción), y la marca
// de "Nueva" para lo que entró desde la última visita a esa bandeja. Lo elegido queda guardado en el
// navegador para la próxima vez.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store'

export type Orden = 'NUEVO' | 'VENCIMIENTO' | 'IMPORTE'

export interface ConfigFiltro<T> {
  /** Clave de la bandeja: separa lo guardado y las visitas de cada una. */
  clave: string
  /** Texto donde busca el buscador: proveedor, CUIT, número, CAE, cuenta, descripción… */
  texto: (x: T) => string
  empresa: (x: T) => string
  proveedor: (x: T) => string
  cuenta?: (x: T) => string | undefined
  /** Cuándo entró al sistema (ISO): orden "más nuevo" y marca de nueva. */
  alta: (x: T) => string | undefined
  /** Fecha para ordenar por vencimiento (o por fecha del pago). */
  vencimiento?: (x: T) => string | undefined
  importe: (x: T) => number
  /** Nombre del orden por fecha: "Vencimiento" para facturas, "Fecha del pago" para pagos. */
  etiquetaFecha?: string
  /** Orden la primera vez que se entra a la bandeja. */
  ordenInicial?: Orden
}

interface Estado {
  q: string
  empresa: string
  proveedor: string
  cuenta: string
  orden: Orden
}

const VACIO: Estado = { q: '', empresa: '', proveedor: '', cuenta: '', orden: 'NUEVO' }

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

function leerGuardado(clave: string, orden: Orden): Estado {
  const base = { ...VACIO, orden }
  try {
    const raw = localStorage.getItem(`filtros:${clave}`)
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Estado>) } : base
  } catch {
    return base
  }
}

/** Última visita anterior a esta bandeja; si nunca entró, se muestran como nuevas las de las últimas 24 h. */
function leerVisita(clave: string): number {
  try {
    const v = Number(localStorage.getItem(`visto:${clave}`))
    if (v > 0) return v
  } catch {
    /* sin almacenamiento: se usa el día */
  }
  return Date.now() - 24 * 3600 * 1000
}

export function useFiltro<T>(items: T[], cfg: ConfigFiltro<T>) {
  const { empresa: empresaDe } = useStore()
  const [f, setF] = useState<Estado>(() => leerGuardado(cfg.clave, cfg.ordenInicial ?? 'NUEVO'))
  const [visitaAnterior] = useState(() => leerVisita(cfg.clave))

  useEffect(() => {
    try {
      localStorage.setItem(`visto:${cfg.clave}`, String(Date.now()))
    } catch {
      /* nada */
    }
  }, [cfg.clave])

  useEffect(() => {
    try {
      localStorage.setItem(`filtros:${cfg.clave}`, JSON.stringify(f))
    } catch {
      /* nada */
    }
  }, [cfg.clave, f])

  const esNueva = (x: T) => {
    const a = cfg.alta(x)
    return !!a && new Date(a).getTime() > visitaAnterior
  }

  const opciones = useMemo(() => {
    const unicos = (fn: (x: T) => string | undefined) => [...new Set(items.map(fn).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b))
    return { empresas: unicos(cfg.empresa), proveedores: unicos(cfg.proveedor), cuentas: cfg.cuenta ? unicos(cfg.cuenta) : [] }
    // cfg es un objeto literal en cada render: las funciones no cambian de lógica, alcanza con items.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const visibles = useMemo(() => {
    const palabras = norm(f.q).split(/\s+/).filter(Boolean)
    const filtrados = items.filter((x) => {
      if (f.empresa && cfg.empresa(x) !== f.empresa) return false
      if (f.proveedor && cfg.proveedor(x) !== f.proveedor) return false
      if (f.cuenta && cfg.cuenta?.(x) !== f.cuenta) return false
      if (palabras.length) {
        const t = norm(cfg.texto(x))
        // Números: "350" encuentra "00007-00000350"; sin guiones ni puntos, "30715555551" encuentra el CUIT con guiones.
        const tNum = t.replace(/[^a-z0-9]/g, '')
        if (!palabras.every((p) => t.includes(p) || tNum.includes(p.replace(/[^a-z0-9]/g, '')))) return false
      }
      return true
    })
    const porFecha = (x: T) => cfg.vencimiento?.(x) ?? ''
    return filtrados.sort((a, b) =>
      f.orden === 'IMPORTE'
        ? cfg.importe(b) - cfg.importe(a)
        : f.orden === 'VENCIMIENTO'
          ? porFecha(a).localeCompare(porFecha(b))
          : (cfg.alta(b) ?? '').localeCompare(cfg.alta(a) ?? ''),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, f])

  const nuevas = items.filter(esNueva).length
  const activos = !!(f.q || f.empresa || f.proveedor || f.cuenta)
  const sel = 'bg-botella border border-borde text-crema text-sm rounded-lg px-2 py-2 focus:border-dorado outline-none max-w-[220px]'

  const barra: ReactNode = (
    <div className="flex flex-wrap items-center gap-2 bg-pino border border-borde rounded-2xl p-3">
      <input
        value={f.q}
        onChange={(e) => setF({ ...f, q: e.target.value })}
        placeholder="Buscar por proveedor, CUIT, N° de comprobante, CAE, cuenta…"
        className="flex-1 min-w-[220px] bg-botella border border-borde text-crema text-sm rounded-lg px-3 py-2 focus:border-dorado outline-none"
      />
      <select value={f.empresa} onChange={(e) => setF({ ...f, empresa: e.target.value })} className={sel} title="Empresa">
        <option value="">Todas las empresas</option>
        {opciones.empresas.map((id) => (
          <option key={id} value={id}>
            {empresaDe(id).corto}
          </option>
        ))}
      </select>
      <select value={f.proveedor} onChange={(e) => setF({ ...f, proveedor: e.target.value })} className={sel} title="Proveedor">
        <option value="">Todos los proveedores</option>
        {opciones.proveedores.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      {cfg.cuenta && (
        <select value={f.cuenta} onChange={(e) => setF({ ...f, cuenta: e.target.value })} className={sel} title="Cuenta contable">
          <option value="">Todas las cuentas</option>
          {opciones.cuentas.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      <select value={f.orden} onChange={(e) => setF({ ...f, orden: e.target.value as Orden })} className={sel} title="Ordenar">
        <option value="NUEVO">Más nuevo primero</option>
        {cfg.vencimiento && <option value="VENCIMIENTO">{cfg.etiquetaFecha ?? 'Vencimiento'}</option>}
        <option value="IMPORTE">Importe mayor</option>
      </select>
      {activos && (
        <button onClick={() => setF({ ...VACIO, orden: f.orden })} className="text-xs text-seco hover:text-acento px-2">
          Limpiar
        </button>
      )}
      <span className="text-[11px] text-seco ml-auto">
        {visibles.length === items.length ? `${items.length}` : `${visibles.length} de ${items.length}`}
        {nuevas > 0 && <span className="text-sky-300"> · {nuevas} nueva{nuevas === 1 ? '' : 's'} desde tu última visita</span>}
      </span>
    </div>
  )

  return { visibles, barra, esNueva }
}
