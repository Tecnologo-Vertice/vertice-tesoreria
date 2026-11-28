import { useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { USUARIOS } from '../data/demo'
import { supabase } from '../lib/supabase'
import type { EstadoEspejo, Rol } from '../types'
import { BotonLetra, BotonTema, Desplegable } from './ui'

export type Pantalla = 'vencimientos' | 'aprobacion' | 'pagos' | 'cheques' | 'robot' | 'bancos' | 'contabilizacion' | 'ralpharma' | 'flujo' | 'auditoria'

/** Quién ve el panel del robot de e-cheqs (los mismos roles que acepta robot_estado_panel). */
const ROLES_ROBOT: Rol[] = ['TESORERIA', 'ADMINISTRACION', 'DIRECCION', 'CONTROLLER', 'ADMIN']

const ROLES: Record<Rol, string> = {
  TESORERIA: 'Tesorería',
  ADMINISTRACION: 'Administración',
  APROBADOR: 'Aprobador',
  DIRECCION: 'Dirección',
  CONTROLLER: 'Controller',
  ADMIN: 'Admin técnico',
}

/** Íconos de línea, 20 px, color del texto. */
const ICONOS: Record<Pantalla, ReactNode> = {
  vencimientos: <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />,
  aprobacion: <path d="M9 12l2 2 4-4M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />,
  pagos: <path d="M3 9h18M7 15h3M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />,
  cheques: <path d="M3 7h18v10H3zM7 13h6M16 11h2" />,
  robot: <path d="M12 3v3M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9 13h.01M15 13h.01M9 17h6" />,
  bancos: <path d="M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18" />,
  contabilizacion: <path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14l-4-2-4 2-4-2-4 2zM8 8h8M8 12h8" />,
  ralpharma: <path d="M12 3a9 9 0 1 0 0 18V3zM12 3a9 9 0 0 1 0 18" />,
  flujo: <path d="M3 17l5-5 4 4 8-8M15 8h5v5" />,
  auditoria: <path d="M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01" />,
}

interface Item {
  id: Pantalla
  titulo: string
  sub: string
  n?: number
}

export function Layout({ pantalla, onNav, children }: { pantalla: Pantalla; onNav: (p: Pantalla) => void; children: ReactNode }) {
  const { modo, cargando, usuario, setUsuario, facturas, pagos, documentos, espejo, toasts, reiniciar, recargar, empresa, tesoreria } = useStore()
  const [actualizando, setActualizando] = useState(false)
  const hoyT = tesoreria?.hoy ?? ''

  const items: Item[] = ([
    { id: 'vencimientos', titulo: 'Vencimientos', sub: 'Deuda del grupo' },
    {
      id: 'aprobacion',
      titulo: 'Aprobación',
      sub: 'Facturas nuevas',
      n: facturas.filter((f) => f.estado === 'PENDIENTE_APROBACION' || f.estado === 'ERROR').length + documentos.filter((d) => d.estado === 'ERROR').length,
    },
    { id: 'pagos', titulo: 'Pagos', sub: 'Tesorería', n: facturas.filter((f) => f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL').length },
    {
      id: 'cheques',
      titulo: 'Cheques',
      sub: 'Emitidos y a debitar',
      n: tesoreria?.cheques.filter((c) => (c.estado === 'EMITIDO' || c.estado === 'ENTREGADO') && c.fechaPago < hoyT).length,
    },
    { id: 'robot', titulo: 'Robot e-cheqs', sub: 'Subida y débito en Xubio' },
    { id: 'bancos', titulo: 'Bancos', sub: 'Extractos y conciliación', n: tesoreria?.movimientos.filter((m) => m.estado === 'A_REVISAR').length },
    { id: 'contabilizacion', titulo: 'Contabilización', sub: 'Administración', n: pagos.filter((p) => p.estado === 'CARGADO' || p.estado === 'REVISADO').length },
    {
      id: 'ralpharma',
      titulo: 'Ralpharma',
      sub: 'Carga manual',
      n:
        facturas.filter((f) => f.estadoXubio === 'PENDIENTE_RALPHARMA' && empresa(f.empresaId).erp === 'RALPHARMA' && ['PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA'].includes(f.estado)).length +
        pagos.filter((p) => p.estado === 'PENDIENTE_RALPHARMA').length,
    },
    { id: 'flujo', titulo: 'Flujo de caja', sub: 'Grilla real y proyectada' },
    { id: 'auditoria', titulo: 'Auditoría', sub: 'Quién hizo qué' },
  ] as Item[]).filter((i) => i.id !== 'robot' || ROLES_ROBOT.includes(usuario.rol))
  const actual = items.find((i) => i.id === pantalla)

  return (
    <div className="min-h-screen flex bg-botella">
      {/* Barra lateral */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-borde bg-pino sticky top-0 h-screen">
        <div className="px-6 pt-6 pb-5">
          <img src="/logo-oscuro.svg" alt="Vértice" className="logo-oscuro h-9 w-auto" />
          <img src="/logo-claro.svg" alt="Vértice" className="logo-claro h-9 w-auto" />
          <p className="mt-2 text-[0.625rem] uppercase tracking-[0.2em] font-bold text-seco">Tesorería y administración</p>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 space-y-1">
          {items.map((it) => {
            const activo = it.id === pantalla
            return (
              <button
                key={it.id}
                onClick={() => onNav(it.id)}
                className={`group relative w-full text-left pl-4 pr-3 py-2.5 rounded-xl flex items-center gap-3 transition-colors ${activo ? 'bg-suave text-crema' : 'text-seco hover:text-crema hover:bg-suave/60'}`}
              >
                {activo && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-dorado" />}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={activo ? 'text-acento' : ''}>
                  {ICONOS[it.id]}
                </svg>
                <span className="flex-1 min-w-0">
                  <span className="block text-[0.875rem] font-bold leading-tight">{it.titulo}</span>
                  <span className="block text-[0.6875rem] opacity-75">{it.sub}</span>
                </span>
                {it.n !== undefined && it.n > 0 && (
                  <span className={`text-[0.6875rem] font-bold tabular px-2 py-0.5 rounded-md ${activo ? 'bg-dorado text-sobre-oro' : 'bg-borde/60 text-crema'}`}>{it.n}</span>
                )}
              </button>
            )
          })}
        </nav>
        <div className="mx-3 mb-3 mt-4 rounded-xl border border-borde bg-suave/60 p-4 text-[0.75rem] text-seco space-y-1">
          <p className="text-crema font-bold">{usuario.nombre}</p>
          <p>{ROLES[usuario.rol]}</p>
          {modo === 'demo' ? (
            <p className="text-[0.6875rem] pt-1">Demo con datos ficticios. Nada toca Xubio, Gmail ni Sheets.</p>
          ) : (
            <EstadoCopia espejo={espejo} />
          )}
        </div>
        <p className="px-6 pb-5 text-[0.5625rem] tracking-[0.2em] text-seco/70">VÉRTICE · 2026</p>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Encabezado */}
        <header className="sticky top-0 z-40 h-16 border-b border-borde bg-botella/90 backdrop-blur px-5 md:px-10 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="md:hidden">
              <img src="/logo-oscuro.svg" alt="Vértice" className="logo-oscuro h-7 w-auto" />
              <img src="/logo-claro.svg" alt="Vértice" className="logo-claro h-7 w-auto" />
            </div>
            <p className="hidden md:block text-[0.6875rem] uppercase tracking-[0.2em] font-bold text-seco">
              Vértice <span className="text-borde mx-1.5">/</span> <span className="text-crema">{actual?.titulo}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {modo === 'demo' ? (
              <>
                <Desplegable
                  compacto
                  value={usuario.nombre}
                  onChange={(v) => setUsuario(USUARIOS.find((u) => u.nombre === v)!)}
                  title="Entrar como"
                  opciones={USUARIOS.map((u) => ({ value: u.nombre, label: `${u.nombre} · ${ROLES[u.rol]}` }))}
                />
                <button onClick={() => void reiniciar()} title="Vuelve los datos ficticios al inicio" className="h-9 px-3 rounded-xl text-[0.8125rem] text-seco hover:text-acento">
                  Reiniciar
                </button>
              </>
            ) : (
              <>
                <span className="hidden sm:inline text-sm text-seco mr-1">
                  <span className="font-bold text-crema">{usuario.nombre}</span> · {ROLES[usuario.rol]}
                </span>
                <button
                  onClick={() => { setActualizando(true); void recargar().finally(() => setActualizando(false)) }}
                  disabled={actualizando}
                  className="h-9 px-3 rounded-xl text-[0.8125rem] font-bold text-seco hover:text-acento border border-borde hover:border-acento disabled:opacity-60 disabled:cursor-wait"
                >
                  {actualizando ? 'Actualizando…' : 'Actualizar'}
                </button>
                <button onClick={() => supabase?.auth.signOut()} className="h-9 px-3 rounded-xl text-[0.8125rem] text-seco hover:text-acento">
                  Salir
                </button>
              </>
            )}
            <BotonLetra />
            <BotonTema />
          </div>
        </header>

        <main className="flex-1 min-w-0 px-5 py-8 md:px-10 md:py-10">
          <nav className="md:hidden flex gap-2 overflow-x-auto pb-3 mb-4 -mx-1 px-1">
            {items.map((it) => (
              <button
                key={it.id}
                onClick={() => onNav(it.id)}
                className={`shrink-0 h-9 px-3 rounded-xl text-xs font-bold border ${it.id === pantalla ? 'bg-dorado text-sobre-oro border-dorado' : 'border-borde text-crema'}`}
              >
                {it.titulo}
                {it.n ? ` · ${it.n}` : ''}
              </button>
            ))}
          </nav>
          <div className="max-w-[1400px] mx-auto">
            {cargando ? (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-dorado mb-4" />
                <p className="text-seco">Cargando…</p>
              </div>
            ) : (
              children
            )}
          </div>
        </main>
      </div>

      <div className="fixed top-5 right-5 z-[60] space-y-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fade-up px-4 py-3 rounded-xl text-sm border ${t.tipo === 'ok' ? 'bg-emerald-950 border-emerald-700 text-emerald-100' : t.tipo === 'error' ? 'bg-red-950 border-red-700 text-red-100' : 'bg-pino border-borde text-crema'}`}
          >
            {t.texto}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Cuándo se copió por última vez la hoja real (Facturas, Facturas_Aprobadas, Pagos) y qué filas quedaron afuera. */
function EstadoCopia({ espejo }: { espejo: EstadoEspejo[] }) {
  const pestanas = espejo.filter((e) => e.hoja !== 'Catalogos')
  if (pestanas.length === 0) return <p className="text-[0.6875rem] pt-1">Sin copia de la hoja real todavía.</p>
  const ultima = Math.max(...pestanas.map((e) => new Date(e.ultimaEn).getTime()))
  const minutos = Math.max(0, Math.round((Date.now() - ultima) / 60000))
  const omitidas = pestanas.flatMap((e) => e.detalle.map((d) => `${e.hoja}${d.fila ? ' fila ' + d.fila : ''}: ${d.motivo}`))
  return (
    <div className="text-[0.6875rem] pt-1 space-y-0.5">
      <p className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${minutos <= 25 ? 'bg-emerald-400/80' : 'bg-red-400/80'}`} />
        <span className={minutos <= 25 ? 'text-emerald-300' : 'text-amber-300'}>
          Copia de la hoja real: {minutos < 1 ? 'recién' : minutos < 120 ? `hace ${minutos} min` : `hace ${Math.round(minutos / 60)} h`}
        </span>
      </p>
      {omitidas.length > 0 && (
        <p className="cursor-help underline decoration-dotted" title={omitidas.slice(0, 30).join('\n')}>
          {omitidas.length} fila(s) de la hoja sin copiar
        </p>
      )}
    </div>
  )
}
