import type { ReactNode } from 'react'
import { useStore } from '../store'
import { USUARIOS } from '../data/demo'
import { supabase } from '../lib/supabase'
import type { Rol } from '../types'

export type Pantalla = 'vencimientos' | 'aprobacion' | 'pagos' | 'contabilizacion' | 'flujo' | 'auditoria'

const ROLES: Record<Rol, string> = {
  TESORERIA: 'Tesorería',
  ADMINISTRACION: 'Administración',
  APROBADOR: 'Aprobador',
  DIRECCION: 'Dirección',
  CONTROLLER: 'Controller',
  ADMIN: 'Admin técnico',
}

interface Item {
  id: Pantalla
  titulo: string
  sub: string
  icono: string
  n?: number
}

export function Layout({ pantalla, onNav, children }: { pantalla: Pantalla; onNav: (p: Pantalla) => void; children: ReactNode }) {
  const { modo, cargando, usuario, setUsuario, facturas, pagos, documentos, toasts, reiniciar, recargar } = useStore()

  const items: Item[] = [
    { id: 'vencimientos', titulo: 'Vencimientos', sub: 'Deuda del grupo', icono: '◷' },
    {
      id: 'aprobacion',
      titulo: 'Aprobación',
      sub: 'Facturas nuevas',
      icono: '✓',
      n: facturas.filter((f) => f.estado === 'PENDIENTE_APROBACION' || f.estado === 'ERROR').length + documentos.filter((d) => d.estado === 'ERROR').length,
    },
    { id: 'pagos', titulo: 'Pagos', sub: 'Tesorería', icono: '⇄', n: facturas.filter((f) => f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL').length },
    { id: 'contabilizacion', titulo: 'Contabilización', sub: 'Administración', icono: '▤', n: pagos.filter((p) => p.estado === 'CARGADO' || p.estado === 'REVISADO' || p.estado === 'PENDIENTE_RALPHARMA').length },
    { id: 'flujo', titulo: 'Flujo de fondos', sub: 'Real y proyectado', icono: '∿' },
    { id: 'auditoria', titulo: 'Auditoría', sub: 'Quién hizo qué', icono: '≡' },
  ]

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-borde py-4 px-5 md:px-8 bg-botella/95 backdrop-blur sticky top-0 z-40">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="font-serif text-3xl tracking-wide text-crema">
              Vértice <span className="text-[10px] tracking-[0.25em] uppercase font-sans text-dorado md:ml-3">Tesorería y administración</span>
            </h1>
            <p className="text-xs text-seco mt-0.5">Facturas, pagos y caja con un solo idioma: la cuenta contable de Xubio</p>
          </div>
          <div className="flex items-center gap-3">
            {modo === 'demo' ? (
              <>
                <span className="hidden md:inline text-[10px] uppercase tracking-widest text-seco">Entrar como</span>
                <select
                  value={usuario.nombre}
                  onChange={(e) => setUsuario(USUARIOS.find((u) => u.nombre === e.target.value)!)}
                  className="bg-pino border border-borde text-crema text-sm rounded-lg px-3 py-2 focus:border-dorado outline-none"
                >
                  {USUARIOS.map((u) => (
                    <option key={u.nombre} value={u.nombre}>
                      {u.nombre} · {ROLES[u.rol]}
                    </option>
                  ))}
                </select>
                <button onClick={() => void reiniciar()} title="Vuelve los datos ficticios al inicio" className="text-xs text-seco hover:text-dorado px-2">
                  Reiniciar demo
                </button>
              </>
            ) : (
              <>
                <span className="text-sm">
                  <span className="font-semibold">{usuario.nombre}</span> <span className="text-seco text-xs">· {ROLES[usuario.rol]}</span>
                </span>
                <button onClick={() => void recargar()} className="text-xs text-seco hover:text-dorado px-2">
                  Actualizar
                </button>
                <button onClick={() => supabase?.auth.signOut()} className="text-xs text-seco hover:text-dorado px-2">
                  Salir
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="hidden md:block w-60 shrink-0 border-r border-borde bg-pino/40 p-4 sticky top-[81px] self-start h-[calc(100vh-81px)]">
          <p className="text-[10px] uppercase tracking-widest text-seco mb-3 px-2">Bandejas</p>
          {items.map((it) => {
            const activo = it.id === pantalla
            return (
              <button
                key={it.id}
                onClick={() => onNav(it.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg mb-1.5 border transition-all flex items-center gap-3 ${activo ? 'bg-dorado border-dorado text-botella' : 'border-transparent text-crema hover:border-borde'}`}
              >
                <span className="text-lg w-5 text-center opacity-80">{it.icono}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-bold leading-tight">{it.titulo}</span>
                  <span className="block text-[10px] opacity-70">{it.sub}</span>
                </span>
                {it.n !== undefined && it.n > 0 && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${activo ? 'bg-botella/20' : 'bg-borde text-crema'}`}>{it.n}</span>
                )}
              </button>
            )
          })}
          <div className="border-t border-borde/60 mt-4 pt-4 px-2 text-[11px] text-seco space-y-1">
            <p>
              Sesión: <span className="text-crema font-semibold">{usuario.nombre}</span>
            </p>
            <p>{ROLES[usuario.rol]}</p>
            {modo === 'demo' ? (
              <p className="text-[10px] text-seco/70 mt-3">Demo con datos ficticios. Ninguna acción toca Xubio, Gmail ni Sheets.</p>
            ) : (
              <p className="text-[10px] text-seco/70 mt-3">Conectado a la base de Vértice.</p>
            )}
          </div>
          <p className="absolute bottom-4 left-6 text-[9px] tracking-widest text-seco/60">LLEVAMOS TU PYME A LA CIMA · VÉRTICE 2026</p>
        </aside>

        <main className="flex-1 min-w-0 p-5 md:p-8">
          <nav className="md:hidden flex gap-2 overflow-x-auto pb-3 mb-3 -mx-1 px-1">
            {items.map((it) => (
              <button
                key={it.id}
                onClick={() => onNav(it.id)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${it.id === pantalla ? 'bg-dorado text-botella border-dorado' : 'border-borde text-crema'}`}
              >
                {it.titulo}
                {it.n ? ` · ${it.n}` : ''}
              </button>
            ))}
          </nav>
          {cargando ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-dorado mb-4" />
              <p className="text-seco italic">Cargando…</p>
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      <div className="fixed top-5 right-5 z-[60] space-y-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fade-up px-4 py-3 rounded-lg shadow-xl text-sm border ${t.tipo === 'ok' ? 'bg-emerald-950 border-emerald-700 text-emerald-100' : t.tipo === 'error' ? 'bg-red-950 border-red-700 text-red-100' : 'bg-pino border-borde text-crema'}`}
          >
            {t.texto}
          </div>
        ))}
      </div>
    </div>
  )
}
