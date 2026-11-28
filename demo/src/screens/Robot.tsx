import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { supabase } from '../lib/supabase'
import { Badge, Btn, Card, Empty, Kpi, Table } from '../components/ui'
import { money } from '../lib/format'

// Panel del robot de e-cheqs (solicitarCorridaRobotEcheqs, cancelarCorridaRobotEcheqs y estadoRobotEcheqs del Apps Script).
// El robot corre en una PC y maneja la web de Xubio: acá solo se pide la corrida y se mira lo que hizo. Todo sale de las funciones
// robot_* de la migración 0039 (la persona entra con su sesión; la base controla el rol y las empresas).

const PUEDE = ['TESORERIA', 'ADMINISTRACION', 'ADMIN']
const PUEDE_VER = ['TESORERIA', 'ADMINISTRACION', 'DIRECCION', 'CONTROLLER', 'ADMIN']

interface Corrida {
  estado: 'pedida' | 'corriendo' | 'terminada' | 'error' | 'sin_fin' | 'cancelada'
  tipo: string
  modo: string
  modoEntregado: string
  origen: string
  pedidoPor: string
  pedida: string
  desde: string
  hasta: string
  aviso: string
  detalle: string
  op: Record<string, number>
  debito: Record<string, number>
  avisos: [string, string, string][]
}
interface Bloqueado {
  empresa: string
  cheque: string
  proveedor?: string
  motivo: string
}
interface Atencion {
  id: string
  tipo: 'op' | 'debito'
  empresa: string
  cheque: string
  importe: number
  estado: string
  detalle: string
  puedeReintentar: boolean
  puedeCerrar?: boolean
  intentos?: number
}
interface LineaOP {
  fecha: string
  modo: string
  empresa: string
  cheque: string
  proveedor: string
  importe: number | null
  estado: string
  numeroOP: string
  detalle: string
}
interface LineaDebito {
  fecha: string
  modo: string
  empresa: string
  cheque: string
  banco: string
  acreedor: string
  importe: number | null
  fechaCobro: string
  estado: string
  movimiento: string
  detalle: string
}
interface Panel {
  habilitado: boolean
  pendientes: number
  bloqueados: Bloqueado[]
  pendientesDebitos: number
  bloqueadosDebitos: Bloqueado[]
  solicitada: boolean
  corrida: Corrida | null
  ultimoLatido: string
  ultimoAviso: string
  ultimoAvisoDetalle: string
  ultimoAvisoEn: string
  ultimosOP: LineaOP[]
  ultimosDebitos: LineaDebito[]
  atencion: Atencion[]
}

const ESTADO_CORRIDA: Record<Corrida['estado'], { texto: string; tono: 'neutro' | 'dorado' | 'rojo' | 'verde' | 'naranja' }> = {
  pedida: { texto: 'Pedida: esperando al robot', tono: 'dorado' },
  corriendo: { texto: 'El robot está corriendo', tono: 'dorado' },
  terminada: { texto: 'Terminó', tono: 'verde' },
  error: { texto: 'Terminó con error', tono: 'rojo' },
  sin_fin: { texto: 'Se cerró sin aviso de fin (el robot no informó nada)', tono: 'naranja' },
  cancelada: { texto: 'Cancelada', tono: 'neutro' },
}
const ESTADO_ROBOT: Record<string, { texto: string; tono: 'neutro' | 'dorado' | 'rojo' | 'verde' | 'naranja' }> = {
  PRUEBA_OK: { texto: 'Prueba ok', tono: 'neutro' },
  SUBIDO: { texto: 'Subido', tono: 'verde' },
  SUBIDO_SIN_APLICAR: { texto: 'Subido, falta aplicar', tono: 'naranja' },
  YA_EN_XUBIO: { texto: 'Ya estaba en Xubio', tono: 'neutro' },
  ERROR_ROBOT: { texto: 'Error', tono: 'rojo' },
  DEBITADO: { texto: 'Debitado', tono: 'verde' },
  YA_DEBITADO: { texto: 'Ya estaba debitado', tono: 'neutro' },
  SIN_OP: { texto: 'Sin orden de pago', tono: 'naranja' },
  REVISAR: { texto: 'Revisar', tono: 'naranja' },
  ERROR_DEBITO: { texto: 'Error', tono: 'rojo' },
  OMITIDO: { texto: 'Omitido', tono: 'neutro' },
}
const badgeEstado = (e: string) => {
  const x = ESTADO_ROBOT[e] ?? { texto: e, tono: 'neutro' as const }
  return <Badge tone={x.tono}>{x.texto}</Badge>
}
const TIPOS: Record<string, string> = { op: 'subida de e-cheqs', debito: 'débito de cheques cobrados', ambos: 'e-cheqs y débitos' }
const resumirConteo = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([k, n]) => `${n} ${(ESTADO_ROBOT[k]?.texto ?? k).toLowerCase()}`)
    .join(' · ') || 'nada todavía'

export function Robot() {
  const { usuario, toast } = useStore()
  const [panel, setPanel] = useState<Panel | null>(null)
  const [error, setError] = useState('')
  const [trabajando, setTrabajando] = useState(false)
  const puede = PUEDE.includes(usuario.rol)

  const cargar = useCallback(async () => {
    if (!supabase || !PUEDE_VER.includes(usuario.rol)) return
    const { data, error: e } = await supabase.rpc('robot_estado_panel')
    if (e) setError(/function .*robot_estado_panel|does not exist|schema cache/i.test(e.message) ? 'Falta aplicar la migración 0039 (robot de e-cheqs) en esta base.' : e.message)
    else {
      setError('')
      setPanel(data as Panel)
    }
  }, [usuario.rol])

  useEffect(() => {
    void cargar()
    // Mientras la pantalla está a la vista se actualiza sola; con la pestaña oculta no consulta (cada consulta recorre los cheques).
    const t = setInterval(() => { if (document.visibilityState === 'visible') void cargar() }, 20_000)
    const alVolver = () => { if (document.visibilityState === 'visible') void cargar() }
    document.addEventListener('visibilitychange', alVolver)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', alVolver) }
  }, [cargar])

  if (!PUEDE_VER.includes(usuario.rol)) {
    return (
      <div className="space-y-4">
        <h1 className="font-serif text-3xl text-crema">Robot de e-cheqs</h1>
        <Card><p className="text-sm text-seco">Tu rol no tiene acceso a esta pantalla.</p></Card>
      </div>
    )
  }

  if (!supabase) {
    return (
      <div className="space-y-4">
        <h1 className="font-serif text-3xl text-crema">Robot de e-cheqs</h1>
        <Card>
          <p className="text-sm text-seco">
            El robot de e-cheqs carga los e-cheqs en Xubio y debita los cheques cobrados desde una PC de la oficina. En la demo con datos ficticios no hay robot: esta pantalla funciona conectada a la base.
          </p>
        </Card>
      </div>
    )
  }

  const llamar = async (fn: string, args: Record<string, unknown> | undefined, ok?: string) => {
    if (!supabase) return
    setTrabajando(true)
    try {
      const { data, error: e } = await supabase.rpc(fn, args)
      if (e) throw new Error(e.message)
      const r = data as { ok?: boolean; mensaje?: string } | null
      if (r && r.ok === false) toast(r.mensaje ?? 'No se pudo', 'error')
      else toast(r?.mensaje ?? ok ?? 'Listo')
      await cargar()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setTrabajando(false)
    }
  }
  const pedir = (modo: 'prueba' | 'real', tipo: 'op' | 'debito' | 'ambos') => {
    if (modo === 'real' && !window.confirm(`Esto le pide al robot ${TIPOS[tipo]} EN REAL: va a guardar en Xubio. ¿Seguimos?`)) return
    void llamar('robot_pedir_corrida', { p_modo: modo, p_tipo: tipo })
  }

  const c = panel?.corrida ?? null
  const ocupado = trabajando || panel?.solicitada === true || c?.estado === 'corriendo'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl text-crema">Robot de e-cheqs</h1>
        <p className="text-sm text-seco mt-1">Carga los e-cheqs en Xubio y debita los cheques cobrados desde la PC. Acá lo pedís y ves qué hizo.</p>
      </div>

      {error && <Card className="border-red-700"><p className="text-sm text-red-300">{error}</p></Card>}
      {!panel && !error && <p className="text-seco">Cargando…</p>}

      {panel && !panel.habilitado && (
        <Card>
          <p className="text-sm text-seco">El robot de e-cheqs no está habilitado para tu organización todavía.</p>
        </Card>
      )}

      {panel && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi label="Para subir" value={String(panel.pendientes)} sub="e-cheqs esperando al robot" tone={panel.pendientes ? 'dorado' : 'crema'} />
            <Kpi label="Para debitar" value={String(panel.pendientesDebitos)} sub="cobrados sin debitar en Xubio" tone={panel.pendientesDebitos ? 'dorado' : 'crema'} />
            <Kpi label="Para revisar" value={String(panel.atencion.length)} sub="con error o sin aplicar" tone={panel.atencion.length ? 'rojo' : 'verde'} />
            <Kpi label="Señal del robot" value={panel.ultimoLatido ? panel.ultimoLatido.slice(11) : '—'} sub={panel.ultimoLatido ? `el ${panel.ultimoLatido.slice(0, 10)}` : 'todavía no respondió'} />
          </div>

          <Card>
            <p className="text-[0.6875rem] uppercase tracking-[0.16em] font-bold text-seco mb-3">Pedir una corrida</p>
            <div className="flex flex-wrap gap-2">
              <Btn variant="secundario" disabled={!puede || ocupado} onClick={() => pedir('prueba', 'op')} title="Completa todo en Xubio y no guarda nada">Subir e-cheqs · prueba</Btn>
              <Btn disabled={!puede || ocupado} onClick={() => pedir('real', 'op')}>Subir e-cheqs · real</Btn>
              <Btn variant="secundario" disabled={!puede || ocupado} onClick={() => pedir('prueba', 'debito')}>Debitar cobrados · prueba</Btn>
              <Btn disabled={!puede || ocupado} onClick={() => pedir('real', 'debito')}>Debitar cobrados · real</Btn>
              <Btn variant="fantasma" disabled={!puede || trabajando || !panel.solicitada} onClick={() => void llamar('robot_cancelar_corrida', undefined)}>Cancelar pedido</Btn>
            </div>
            {!puede && <p className="text-xs text-seco mt-3">Tu rol puede mirar pero no pedir corridas.</p>}
            <p className="text-xs text-seco mt-3">El robot mira cada 5 minutos si hay un pedido (si la PC está prendida). La prueba completa el formulario y lo descarta; la real guarda en Xubio. Corridas automáticas: 13 y 17 h, días hábiles.</p>
          </Card>

          <Card>
            <p className="text-[0.6875rem] uppercase tracking-[0.16em] font-bold text-seco mb-3">Última corrida</p>
            {!c ? (
              <Empty texto="Todavía no se pidió ninguna corrida." />
            ) : (
              <div className="space-y-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={ESTADO_CORRIDA[c.estado].tono}>{ESTADO_CORRIDA[c.estado].texto}</Badge>
                  <span className="text-crema">{TIPOS[c.tipo] ?? c.tipo} · {c.modo}</span>
                  <span className="text-seco">pedida {c.pedida} por {c.pedidoPor || '—'}{c.origen === 'AUTOMATICA' ? ' (automática)' : ''}</span>
                </p>
                {c.modo === 'real' && c.modoEntregado === 'prueba' && (
                  <p className="text-amber-300">Se pidió en real pero el servidor la entregó como prueba: falta encender ROBOT_ECHEQS_ENVIO_REAL.</p>
                )}
                {c.desde && <p className="text-seco">La tomó a las {c.desde.slice(11)}{c.hasta ? ` y terminó a las ${c.hasta.slice(11)}` : ''}.</p>}
                {c.estado !== 'pedida' && c.estado !== 'cancelada' && (
                  <>
                    <p className="text-seco">E-cheqs: {resumirConteo(c.op)}</p>
                    <p className="text-seco">Débitos: {resumirConteo(c.debito)}</p>
                  </>
                )}
                {c.avisos.map((a, i) => (
                  <p key={i} className="text-red-300">{a[0].slice(11)} · {a[1]} {a[2]}</p>
                ))}
              </div>
            )}
            {panel.ultimoAviso && !panel.ultimoAviso.startsWith('FIN_CORRIDA') && (
              <p className="text-xs text-seco mt-3">Último aviso del robot ({panel.ultimoAvisoEn}): <span className="text-crema">{panel.ultimoAviso}</span> {panel.ultimoAvisoDetalle}</p>
            )}
          </Card>

          {panel.atencion.length > 0 && (
            <div className="space-y-2">
              <p className="text-[0.6875rem] uppercase tracking-[0.16em] font-bold text-seco">Para que alguien lo mire</p>
              <Table head={['Empresa', 'Cheque', 'Importe', 'Qué', 'Estado', 'Detalle', '']}>
                {panel.atencion.map((a) => (
                  <tr key={`${a.tipo}-${a.id}`}>
                    <td className="px-4 py-3">{a.empresa}</td>
                    <td className="px-4 py-3 tabular">{a.cheque}</td>
                    <td className="px-4 py-3 tabular text-right">{money(a.importe)}</td>
                    <td className="px-4 py-3">{a.tipo === 'op' ? 'Orden de pago' : 'Débito'}</td>
                    <td className="px-4 py-3">{badgeEstado(a.estado)}</td>
                    <td className="px-4 py-3 text-seco max-w-md">{a.detalle}</td>
                    <td className="px-4 py-3 text-right">
                      {puede && a.puedeCerrar && (
                        <Btn variant="secundario" disabled={trabajando} onClick={() => { if (window.confirm('¿Ya aplicaste la orden de pago a la factura en Xubio? El cheque pasa a "Subido".')) void llamar('robot_cerrar_sin_aplicar', { p_cheque: a.id }, 'Listo: el cheque quedó como subido') }} title="Usalo después de aplicarla a mano en Xubio">Ya la apliqué</Btn>
                      )}
                      {puede && a.puedeReintentar && (
                        <Btn variant="secundario" disabled={trabajando} onClick={() => void llamar('robot_reintentar_cheque', { p_cheque: a.id, p_que: a.tipo }, 'El cheque vuelve a la cola del robot')} title="Revisalo antes en Xubio: el robot comprueba que no esté duplicado">Reintentar</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          )}

          {(panel.bloqueados.length > 0 || panel.bloqueadosDebitos.length > 0) && (
            <div className="space-y-2">
              <p className="text-[0.6875rem] uppercase tracking-[0.16em] font-bold text-seco">Que el robot no puede tomar (hay que resolverlo a mano)</p>
              <Table head={['Empresa', 'Cheque', 'Proveedor', 'Motivo']}>
                {[...panel.bloqueados, ...panel.bloqueadosDebitos].map((b, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3">{b.empresa}</td>
                    <td className="px-4 py-3 tabular">{b.cheque}</td>
                    <td className="px-4 py-3 text-seco">{b.proveedor ?? ''}</td>
                    <td className="px-4 py-3 text-seco">{b.motivo}</td>
                  </tr>
                ))}
              </Table>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-[0.6875rem] uppercase tracking-[0.16em] font-bold text-seco">Últimos e-cheqs</p>
            {panel.ultimosOP.length === 0 ? (
              <Empty texto="El robot todavía no informó e-cheqs." />
            ) : (
              <Table head={['Fecha', 'Modo', 'Empresa', 'Cheque', 'Proveedor', 'Importe', 'Estado', 'N° de OP', 'Detalle']}>
                {panel.ultimosOP.map((l, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3 whitespace-nowrap">{l.fecha}</td>
                    <td className="px-4 py-3">{l.modo}</td>
                    <td className="px-4 py-3">{l.empresa}</td>
                    <td className="px-4 py-3 tabular">{l.cheque}</td>
                    <td className="px-4 py-3">{l.proveedor}</td>
                    <td className="px-4 py-3 tabular text-right">{l.importe != null ? money(Number(l.importe)) : ''}</td>
                    <td className="px-4 py-3">{badgeEstado(l.estado)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{l.numeroOP}</td>
                    <td className="px-4 py-3 text-seco max-w-md">{l.detalle}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-[0.6875rem] uppercase tracking-[0.16em] font-bold text-seco">Últimos débitos</p>
            {panel.ultimosDebitos.length === 0 ? (
              <Empty texto="El robot todavía no informó débitos." />
            ) : (
              <Table head={['Fecha', 'Modo', 'Empresa', 'Cheque', 'Banco', 'Acreedor', 'Importe', 'Cobro', 'Estado', 'Movimiento', 'Detalle']}>
                {panel.ultimosDebitos.map((l, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3 whitespace-nowrap">{l.fecha}</td>
                    <td className="px-4 py-3">{l.modo}</td>
                    <td className="px-4 py-3">{l.empresa}</td>
                    <td className="px-4 py-3 tabular">{l.cheque}</td>
                    <td className="px-4 py-3">{l.banco}</td>
                    <td className="px-4 py-3">{l.acreedor}</td>
                    <td className="px-4 py-3 tabular text-right">{l.importe != null ? money(Number(l.importe)) : ''}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{l.fechaCobro}</td>
                    <td className="px-4 py-3">{badgeEstado(l.estado)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{l.movimiento}</td>
                    <td className="px-4 py-3 text-seco max-w-md">{l.detalle}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
