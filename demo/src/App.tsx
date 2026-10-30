import { useEffect, useMemo, useState } from 'react'
import { StoreProvider } from './store'
import { Layout, type Pantalla } from './components/Layout'
import { Vencimientos } from './screens/Vencimientos'
import { Aprobacion } from './screens/Aprobacion'
import { Pagos } from './screens/Pagos'
import { Contabilizacion } from './screens/Contabilizacion'
import { Flujo } from './screens/Flujo'
import { Auditoria } from './screens/Auditoria'
import { Ralpharma } from './screens/Ralpharma'
import { FuenteDemo } from './data/fuenteDemo'
import { FuenteSupabase, usuarioActual } from './data/fuenteSupabase'
import { supabase } from './lib/supabase'
import { USUARIOS } from './data/demo'
import type { Fuente } from './data/fuente'
import type { Usuario } from './types'
import { Btn } from './components/ui'

const PANTALLAS: Pantalla[] = ['vencimientos', 'aprobacion', 'pagos', 'contabilizacion', 'ralpharma', 'flujo', 'auditoria']

function leerHash(): Pantalla {
  const h = location.hash.replace('#', '') as Pantalla
  return PANTALLAS.includes(h) ? h : 'vencimientos'
}

export default function App() {
  const [pantalla, setPantalla] = useState<Pantalla>(leerHash)
  useEffect(() => {
    const onHash = () => setPantalla(leerHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const nav = (p: Pantalla) => {
    location.hash = p
    setPantalla(p)
  }

  const fuente = useMemo<Fuente>(() => (supabase ? new FuenteSupabase(supabase) : new FuenteDemo()), [])

  return (
    <Sesion fuente={fuente}>
      {(usuario) => (
        <StoreProvider fuente={fuente} usuarioInicial={usuario}>
          <Layout pantalla={pantalla} onNav={nav}>
            {pantalla === 'vencimientos' && <Vencimientos />}
            {pantalla === 'aprobacion' && <Aprobacion />}
            {pantalla === 'pagos' && <Pagos />}
            {pantalla === 'contabilizacion' && <Contabilizacion />}
            {pantalla === 'ralpharma' && <Ralpharma />}
            {pantalla === 'flujo' && <Flujo />}
            {pantalla === 'auditoria' && <Auditoria />}
          </Layout>
        </StoreProvider>
      )}
    </Sesion>
  )
}

/** En demo no hay login. Conectado: Google por Supabase Auth y la tabla usuarios decide el rol. */
function Sesion({ fuente, children }: { fuente: Fuente; children: (u: Usuario) => React.ReactNode }) {
  const [estado, setEstado] = useState<'cargando' | 'sin-sesion' | 'sin-acceso' | 'ok'>(fuente.modo === 'demo' ? 'ok' : 'cargando')
  const [usuario, setUsuario] = useState<Usuario>(USUARIOS[0])
  const [email, setEmail] = useState('')

  useEffect(() => {
    if (!supabase) return
    const resolver = async () => {
      const { data } = await supabase!.auth.getSession()
      if (!data.session) return setEstado('sin-sesion')
      setEmail(data.session.user.email ?? '')
      const u = await usuarioActual(supabase!)
      if (!u) return setEstado('sin-acceso')
      setUsuario(u)
      setEstado('ok')
    }
    void resolver()
    const { data: sub } = supabase.auth.onAuthStateChange(() => void resolver())
    return () => sub.subscription.unsubscribe()
  }, [])

  if (estado === 'ok') return <>{children(usuario)}</>

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-pino border border-borde rounded-xl p-8 text-center space-y-4 fade-up">
        <h1 className="font-serif text-4xl">Vértice</h1>
        <p className="text-[0.625rem] tracking-[0.25em] uppercase text-acento">Tesorería y administración</p>
        {estado === 'cargando' && <p className="text-seco text-sm">Verificando sesión…</p>}
        {estado === 'sin-sesion' && (
          <>
            <p className="text-sm text-seco">Entrá con tu cuenta de Google de la empresa.</p>
            <Btn className="w-full justify-center" onClick={() => supabase!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } })}>
              Entrar con Google
            </Btn>
          </>
        )}
        {estado === 'sin-acceso' && (
          <>
            <p className="text-sm text-red-300">La cuenta {email} no está habilitada en el sistema.</p>
            <p className="text-xs text-seco">Pedile al administrador que la agregue a la tabla de usuarios con su rol.</p>
            <Btn variant="secundario" onClick={() => supabase!.auth.signOut()}>
              Salir
            </Btn>
          </>
        )}
      </div>
    </div>
  )
}
