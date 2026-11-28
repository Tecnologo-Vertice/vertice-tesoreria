import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { CategoriaMovimiento, Conciliacion, CuentaBancaria, MovimientoBancario } from '../types'
import type { OpcionesExtracto, PendienteXubio, ResultadoCorridaBancos, ResultadoExtracto } from '../data/fuente'
import { Badge, Btn, Card, Desplegable, Empty, Field, inputCls, Kpi, Modal, SelectorCuenta, Table, Tabs } from '../components/ui'
import { AvisoTesoreria, CampoMonto, ModalAnulacionManual, PUEDE_ANULAR_XUBIO_A_MANO } from '../components/Tesoreria'
import { fecha, fechaHora, money } from '../lib/format'
import { CATEGORIAS_MOV, CLASES, ESTADO_CONCILIACION, diaCorto, diaHabilAnterior, diasHabiles, num, parseMonto, sumarHabiles, textoBanco } from '../lib/tesoreria'

const PUEDE_OPERAR = ['TESORERIA', 'ADMINISTRACION', 'ADMIN']

const ESTADO_MOV: Record<MovimientoBancario['estado'], { label: string; tone: 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja' }> = {
  A_REVISAR: { label: 'A revisar', tone: 'naranja' },
  PENDIENTE: { label: 'Clasificado', tone: 'azul' },
  CONTABILIZADO: { label: 'Contabilizado', tone: 'verde' },
  CARGADO_A_MANO: { label: 'Cargado a mano', tone: 'verde' },
  INFORMATIVO: { label: 'Informativo', tone: 'neutro' },
  IGNORADO: { label: 'Ignorado', tone: 'neutro' },
}

export function Bancos() {
  const { tesoreria, empresa, usuario } = useStore()
  const [tab, setTab] = useState<'MOVIMIENTOS' | 'CONCILIACION' | 'XUBIO'>('MOVIMIENTOS')
  const [empresaId, setEmpresaId] = useState('TODAS')
  const fer = useMemo(() => new Set(tesoreria?.feriados ?? []), [tesoreria])
  const ayer = tesoreria ? diaHabilAnterior(tesoreria.hoy, fer) : ''
  const [dia, setDia] = useState<string>('')
  const diaSel = dia || ayer

  if (!tesoreria || !tesoreria.disponible) return <AvisoTesoreria />

  const empresas = [...new Set(tesoreria.cuentas.map((c) => c.empresaId))]
  const cuentas = tesoreria.cuentas.filter((c) => empresaId === 'TODAS' || c.empresaId === empresaId)
  const aRevisar = tesoreria.movimientos.filter((m) => m.estado === 'A_REVISAR' && cuentas.some((c) => c.id === m.cuentaId)).length
  const opcionesDia = diasHabiles(sumarHabiles(tesoreria.hoy, -15, fer), 16, fer).reverse()
  const puede = PUEDE_OPERAR.includes(usuario.rol)
  const pendientes = tesoreria.pendientesXubio.filter((p) => empresaId === 'TODAS' || p.empresaId === empresaId)
  const pendXubio = pendientes.length
  const errXubio = pendientes.some((p) => p.estado === 'ERROR')

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Bancos</h2>
          <p className="text-sm text-seco">Extractos, clasificación y conciliación por cuenta y día. Lo que antes vivía en Extractos_Movimientos y Conciliacion_Diaria.</p>
        </div>
        <div className="flex gap-2">
          <Desplegable compacto value={empresaId} onChange={setEmpresaId} opciones={[{ value: 'TODAS', label: 'Todas las empresas' }, ...empresas.map((e) => ({ value: e, label: empresa(e).nombre }))]} />
          <Desplegable compacto value={diaSel} onChange={setDia} title="Día" opciones={opcionesDia.map((d) => ({ value: d, label: `${diaCorto(d)}${d === ayer ? ' · ayer hábil' : d === tesoreria.hoy ? ' · hoy' : ''}` }))} />
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'MOVIMIENTOS', label: 'Movimientos bancarios', n: aRevisar },
          { id: 'CONCILIACION', label: 'Conciliación bancaria' },
          { id: 'XUBIO', label: 'Pendiente en Xubio', n: pendXubio, tone: errXubio ? 'rojo' : undefined },
        ]}
      />

      {tab === 'MOVIMIENTOS' ? (
        <Movimientos cuentas={cuentas} dia={diaSel} puede={puede} />
      ) : tab === 'CONCILIACION' ? (
        <ConciliacionTab cuentas={cuentas} dia={diaSel} onDia={setDia} />
      ) : (
        <PendientesXubioTab empresaId={empresaId} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Movimientos bancarios

function Movimientos({ cuentas, dia, puede }: { cuentas: CuentaBancaria[]; dia: string; puede: boolean }) {
  const { tesoreria, empresa, subirExtracto, borrarExtracto, generarComprobanteGastos, generarAsientoBancario, asignarContraparte } = useStore()
  const t = tesoreria!
  const [resultado, setResultado] = useState<{ cuenta: string; r: ResultadoExtracto } | null>(null)
  const [subiendo, setSubiendo] = useState<string | null>(null)
  // El extracto parece ya cargado en otra empresa: se pregunta antes de subirlo igual.
  const [otraEmpresa, setOtraEmpresa] = useState<{ cuenta: CuentaBancaria; archivo: File; opciones: OpcionesExtracto; mensaje: string } | null>(null)
  const [vista, setVista] = useState<'REVISAR' | 'DIA' | 'TODOS'>('REVISAR')
  const [reclasificar, setReclasificar] = useState<MovimientoBancario | null>(null)
  const [sinMov, setSinMov] = useState<CuentaBancaria | null>(null)
  const [tenencia, setTenencia] = useState<CuentaBancaria | null>(null)
  const [extracto, setExtracto] = useState<CuentaBancaria | null>(null)
  const nombre = (id: string) => t.cuentas.find((c) => c.id === id)?.nombre ?? id
  const sugerido = (movimientoId: string) => t.chequesSugeridos.find((x) => x.movimientoId === movimientoId)
  const unidad = (id?: string) => t.unidades.find((u) => u.id === id)?.nombre
  const fondosDe = (cuentaId: string) => t.cuentas.filter((c) => c.cuentaMadreId === cuentaId && (c.clase === 'FCI' || c.clase === 'REMUNERADA'))

  const ids = new Set(cuentas.map((c) => c.id))
  const avisosDeFondos = t.avisosFci.filter((a) => ids.has(a.cuentaId))
  const movs = t.movimientos
    .filter((m) => ids.has(m.cuentaId))
    .filter((m) => (vista === 'REVISAR' ? m.estado === 'A_REVISAR' : vista === 'DIA' ? m.fecha === dia : true))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || a.cuentaId.localeCompare(b.cuentaId))

  async function importar(c: CuentaBancaria, f: File, o: OpcionesExtracto): Promise<boolean> {
    setSubiendo(c.id)
    const r = await subirExtracto(f, c.id, o)
    setSubiendo(null)
    if (r?.otraEmpresa) {
      setOtraEmpresa({ cuenta: c, archivo: f, opciones: o, mensaje: r.otraEmpresa })
      return true
    }
    if (r) setResultado({ cuenta: c.nombre, r })
    return r !== null
  }

  return (
    <div className="space-y-6">

      {resultado && (
        <div className={`rounded-2xl border px-5 py-4 text-sm flex items-start justify-between gap-4 ${resultado.r.repetido ? 'border-amber-600 bg-amber-950/30 text-amber-100' : 'border-emerald-700 bg-emerald-950/30 text-emerald-100'}`}>
          <div>
            <p className="font-bold">
              {resultado.cuenta}:{' '}
              {resultado.r.repetido
                ? 'ese archivo ya estaba importado'
                : resultado.r.tenencia
                  ? 'tenencia del fondo importada'
                  : `${resultado.r.nuevos} movimiento(s) nuevo(s)${resultado.r.movimientos !== undefined ? ` de ${resultado.r.movimientos} en el archivo` : ''}`}
            </p>
            {(resultado.r.cuentas?.length ?? 0) > 1 && (
              <ul className="opacity-90 list-disc pl-5 my-1">
                {resultado.r.cuentas!.map((c) => (
                  <li key={c.cuentaId}>
                    {c.cuenta}: {c.repetido ? 'ya estaba importado' : `${c.nuevos} nuevo(s) de ${c.movimientos}${c.aRevisar ? ` · ${c.aRevisar} a revisar` : ''}`}
                    {c.saldoFinal !== undefined && ` · saldo ${money(c.saldoFinal)}`}
                  </li>
                ))}
              </ul>
            )}
            <p className="opacity-80">
              {resultado.r.formato && `Formato ${resultado.r.formato}. `}
              {resultado.r.aRevisar ? `${resultado.r.aRevisar} quedaron "A revisar". ` : ''}
              {resultado.r.tenencia
                ? `Saldo${resultado.r.cuentas?.[0]?.saldoFinal !== undefined ? ` ${money(resultado.r.cuentas[0].saldoFinal!)}` : ''} guardado como tenencia: el rendimiento sale solo de la conciliación. `
                : ''}
              {(resultado.r.cuentas?.length ?? 0) > 1 || resultado.r.tenencia
                ? (resultado.r.avisos ?? []).join(' · ')
                : (resultado.r.detalle ?? (resultado.r.repetido ? 'No se duplicó nada.' : 'Los saldos de cierre ya están en la conciliación.'))}
            </p>
          </div>
          <button onClick={() => setResultado(null)} className="text-lg leading-none opacity-70 hover:opacity-100" aria-label="Cerrar">
            ×
          </button>
        </div>
      )}

      {avisosDeFondos.length > 0 && (
        <Card className="p-4" data-aviso="fondos-sin-movimientos">
          <p className="text-sm font-semibold text-dorado">Fondos sin movimientos de su banco ({avisosDeFondos.length})</p>
          <ul className="mt-1 text-xs text-seco list-disc pl-5 space-y-0.5">
            {avisosDeFondos.slice(0, 6).map((a) => (
              <li key={a.cuentaId + a.fecha}>
                {a.cuenta} · {fecha(a.fecha).slice(0, 5)}: {a.detalle}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-borde flex items-center justify-between">
          <h3 className="font-serif text-xl">Cuentas · {fecha(dia)}</h3>
          <p className="text-xs text-seco">Subí el extracto, o marcá el día sin movimientos. Los gastos van al comprobante "Extracto Bancario"; impuestos y FCI, al asiento.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-suave text-[0.625rem] uppercase tracking-[0.14em] text-seco">
              <tr>
                {['Cuenta', 'Último extracto', 'Saldo del día', 'Estado', 'Xubio del día', 'Acciones'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 font-bold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-borde/60">
              {cuentas.map((c) => {
                const s = t.saldos.find((x) => x.cuentaId === c.id && x.fecha === dia)
                const k = t.conciliacion.find((x) => x.cuentaId === c.id && x.fecha === dia)
                const estado = k?.estado ?? 'SIN_EXTRACTO'
                const ex = t.extractos.find((x) => x.cuentaId === c.id)
                const movsDia = t.movimientos.filter((m) => m.cuentaId === c.id && m.fecha === dia && m.estado !== 'IGNORADO')
                const conComprobante = movsDia.some((m) => m.destinoXubio === 'COMPROBANTE')
                const conAsiento = movsDia.some((m) => m.destinoXubio === 'ASIENTO')
                const comp = t.documentos.find((d) => d.tipo === 'COMPROBANTE' && d.cuentaId === c.id && d.fecha === dia)
                const asi = t.documentos.find((d) => d.tipo === 'ASIENTO' && !d.complemento && d.cuentaId === c.id && d.fecha === dia)
                const complementos = t.documentos.filter((d) => d.tipo === 'ASIENTO' && d.complemento && d.cuentaId === c.id && d.fecha === dia)
                const arrastre = !s ? t.saldosArrastrados.find((x) => x.cuentaId === c.id && x.fecha === dia && x.arrastrado) : undefined
                return (
                  <tr key={c.id} data-cuenta={c.nombre}>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{c.nombre}</p>
                      <p className="text-[0.6875rem] text-seco">
                        {empresa(c.empresaId).corto} · {unidad(c.unidadId)} · {CLASES[c.clase]}
                        {c.rindeDiario && ' · rinde todos los días'}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs text-seco">
                      {ex ? (
                        <>
                          hasta {fecha(ex.hasta)}
                          <br />
                          <span className="opacity-70">{ex.archivo}</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 tabular font-semibold whitespace-nowrap">
                      {s ? money(s.saldo) : arrastre ? <span className="text-seco">{money(arrastre.saldo)}</span> : '—'}
                      {arrastre && <span className="block text-[0.625rem] text-seco font-normal">repite el del {fecha(arrastre.saldoDe ?? '').slice(0, 5)} (arrastre)</span>}
                      {s && s.origen !== 'EXTRACTO' && <span className="block text-[0.625rem] text-seco font-normal">{s.origen === 'SIN_MOVIMIENTOS' ? 'repite el anterior' : s.origen === 'TENENCIA' ? 'tenencia del fondo' : 'cargado a mano'}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={ESTADO_CONCILIACION[estado].tone}>{ESTADO_CONCILIACION[estado].label}</Badge>
                      {k?.diferencia !== undefined && estado === 'DIFERENCIA' && <p className="text-[0.6875rem] text-red-300 mt-1 tabular">{money(k.diferencia)}</p>}
                      {k?.rendimiento ? <p className="text-[0.6875rem] text-emerald-300 mt-1 tabular">rinde {money(k.rendimiento)}</p> : null}
                    </td>
                    <td className="px-4 py-3 text-[0.6875rem] space-y-1">
                      {comp && <Badge tone={comp.estadoXubio === 'SUBIDA' ? 'verde' : 'dorado'}>{comp.numero} {comp.estadoXubio === 'SUBIDA' ? 'en Xubio' : 'generado'}</Badge>}
                      {asi && (
                        <div>
                          <Badge tone={asi.estadoXubio === 'SUBIDA' ? 'verde' : 'dorado'}>Asiento {asi.estadoXubio === 'SUBIDA' ? 'en Xubio' : 'generado'}</Badge>
                        </div>
                      )}
                      {complementos.map((k) => (
                        <div key={k.id}>
                          <Badge tone={k.estadoXubio === 'SUBIDA' ? 'verde' : k.estadoXubio === 'ERROR' ? 'rojo' : 'dorado'}>
                            Complemento {k.estadoXubio === 'SUBIDA' ? 'en Xubio' : k.estadoXubio === 'ERROR' ? 'con error' : 'generado'}
                          </Badge>
                        </div>
                      ))}
                      {!comp && !asi && complementos.length === 0 && <span className="text-seco">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {puede ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.75rem]">
                          <button
                            className="text-acento underline disabled:opacity-40"
                            disabled={subiendo !== null}
                            onClick={() => setExtracto(c)}
                          >
                            {subiendo === c.id ? 'Subiendo…' : c.clase === 'FCI' ? 'Subir informe' : 'Subir extracto'}
                          </button>
                          {!s && movsDia.length === 0 && dia < t.hoy && (
                            <button className="text-acento underline" onClick={() => setSinMov(c)}>
                              Sin movimientos
                            </button>
                          )}
                          {(c.clase === 'FCI' || c.clase === 'REMUNERADA') && (
                            <button className="text-acento underline" onClick={() => setTenencia(c)}>
                              Cargar tenencia
                            </button>
                          )}
                          {conComprobante && comp?.estadoXubio !== 'SUBIDA' && (
                            <button className="text-acento underline" onClick={() => void generarComprobanteGastos(c.id, dia)}>
                              {comp ? 'Rehacer comprobante' : 'Comprobante de gastos'}
                            </button>
                          )}
                          {conAsiento && asi?.estadoXubio !== 'SUBIDA' && (
                            <button className="text-acento underline" onClick={() => void generarAsientoBancario(c.id, dia)}>
                              {asi ? 'Rehacer asiento' : 'Asiento del día'}
                            </button>
                          )}
                          {asi?.estadoXubio === 'SUBIDA' &&
                            (movsDia.some((m) => m.destinoXubio === 'ASIENTO' && !m.asientoId && m.estado !== 'CONTABILIZADO' && m.estado !== 'CARGADO_A_MANO') ||
                              complementos.some((k) => k.estadoXubio !== 'SUBIDA')) && (
                              <button className="text-acento underline" title="El asiento del día ya está en Xubio: lo nuevo va en un asiento aparte" onClick={() => void generarAsientoBancario(c.id, dia)}>
                                {complementos.some((k) => k.estadoXubio !== 'SUBIDA') ? 'Rehacer complemento' : 'Asiento complementario'}
                              </button>
                            )}
                        </div>
                      ) : (
                        <span className="text-xs text-seco">Solo consulta</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            value={vista}
            onChange={setVista}
            tabs={[
              { id: 'REVISAR', label: 'A revisar', n: t.movimientos.filter((m) => ids.has(m.cuentaId) && m.estado === 'A_REVISAR').length },
              { id: 'DIA', label: `Del ${fecha(dia).slice(0, 5)}`, n: t.movimientos.filter((m) => ids.has(m.cuentaId) && m.fecha === dia).length },
              { id: 'TODOS', label: 'Últimos 45 días' },
            ]}
          />
          <p className="text-xs text-seco">Lo que ninguna regla reconoce queda "A revisar". Al reclasificar podés enseñarle la regla.</p>
        </div>
        {movs.length === 0 ? (
          <Empty texto={vista === 'REVISAR' ? 'No hay movimientos para revisar.' : 'No hay movimientos.'} />
        ) : (
          <Table head={['Fecha', 'Cuenta', 'Descripción', 'Importe', 'Clasificación', 'Va a Xubio', 'Estado', '']}>
            {movs.slice(0, 400).map((m) => (
              <tr key={m.id} className={m.estado === 'A_REVISAR' ? 'bg-amber-950/10' : ''}>
                <td className="px-4 py-2 whitespace-nowrap">{fecha(m.fecha)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-seco">{nombre(m.cuentaId)}</td>
                <td className="px-4 py-2 max-w-[320px]">
                  <p className="truncate" title={m.descripcion}>
                    {m.descripcion}
                  </p>
                  {m.contraparteCuentaId && <p className="text-[0.6875rem] text-seco">contra {nombre(m.contraparteCuentaId)}</p>}
                  {/* Débito de cheque sin número con un único cheque emitido por el mismo importe (±$1): solo se sugiere, marcar debitado es a mano en Cheques. */}
                  {!m.chequeId && sugerido(m.id) && (
                    <p className="text-[0.6875rem] text-amber-300">
                      Puede ser el cheque {sugerido(m.id)!.numero} (mismo importe): confirmalo en Cheques con «Marcar debitado».
                    </p>
                  )}
                  {/* Suscripción o rescate en una cuenta con más de un fondo: Tesorería dice a cuál corresponde (0031). */}
                  {puede && !m.contraparteCuentaId && m.categoria === 'FCI' && fondosDe(m.cuentaId).length > 1 && (
                    <select
                      className="mt-1 text-[0.6875rem] bg-suave border border-borde rounded px-1 py-0.5"
                      defaultValue=""
                      aria-label="Fondo de la suscripción o el rescate"
                      onChange={(e) => e.target.value && void asignarContraparte(m.id, e.target.value)}
                    >
                      <option value="">¿De qué fondo es?</option>
                      {fondosDe(m.cuentaId).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.nombre}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className={`px-4 py-2 text-right tabular whitespace-nowrap font-semibold ${m.importe < 0 ? 'text-red-300' : 'text-emerald-300'}`}>{num(m.importe)}</td>
                <td className="px-4 py-2">
                  <p className="text-xs">{CATEGORIAS_MOV[m.categoria]}</p>
                  <p className="text-[0.6875rem] text-seco truncate max-w-[200px]">{m.cuentaContable ?? '—'}</p>
                </td>
                <td className="px-4 py-2 text-xs text-seco">{m.destinoXubio === 'COMPROBANTE' ? 'Comprobante' : m.destinoXubio === 'ASIENTO' ? 'Asiento' : '—'}</td>
                <td className="px-4 py-2">
                  <Badge tone={ESTADO_MOV[m.estado].tone}>{ESTADO_MOV[m.estado].label}</Badge>
                </td>
                <td className="px-4 py-2 text-right">
                  {puede && m.estado !== 'CONTABILIZADO' && m.estado !== 'CARGADO_A_MANO' && (
                    <button className="text-[0.75rem] text-acento underline whitespace-nowrap" onClick={() => setReclasificar(m)}>
                      Reclasificar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      <Card>
        <h3 className="font-serif text-xl mb-3">Extractos importados</h3>
        {t.extractos.length === 0 ? (
          <p className="text-sm text-seco italic">Todavía no se importó ninguno.</p>
        ) : (
          <Table head={['Importado', 'Cuenta', 'Archivo', 'Período', 'Movimientos', 'Nuevos', 'Por', '']}>
            {t.extractos
              .filter((x) => ids.has(x.cuentaId))
              .slice(0, 15)
              .map((x) => (
                <tr key={x.id}>
                  <td className="px-4 py-2 whitespace-nowrap">{fechaHora(x.importadoEn)}</td>
                  <td className="px-4 py-2">{nombre(x.cuentaId)}</td>
                  <td className="px-4 py-2 text-xs text-seco truncate max-w-[260px]">{x.archivo}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-xs">{x.desde ? `${fecha(x.desde)} a ${fecha(x.hasta)}` : '—'}</td>
                  <td className="px-4 py-2 tabular">{x.movimientos}</td>
                  <td className="px-4 py-2 tabular">{x.nuevos}</td>
                  <td className="px-4 py-2 text-seco">{x.importadoPor}</td>
                  <td className="px-4 py-2 text-right">
                    {puede && (
                      <button
                        className="text-[0.6875rem] text-acento underline"
                        title="Si lo subiste a la cuenta equivocada: borra el archivo importado, sus movimientos y sus saldos. No se puede si algo ya está conciliado."
                        onClick={() => {
                          if (window.confirm(`¿Deshacer este extracto (${x.archivo})? Se borran sus ${x.movimientos} movimientos y sus saldos. Solo se puede si ninguno está conciliado ni en un asiento.`)) void borrarExtracto(x.id)
                        }}
                      >
                        Deshacer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </Table>
        )}
      </Card>

      {reclasificar && <ModalReclasificar mov={reclasificar} onClose={() => setReclasificar(null)} />}
      {sinMov && <ModalSinMovimientos cuenta={sinMov} dia={dia} onClose={() => setSinMov(null)} />}
      {tenencia && <ModalTenencia cuenta={tenencia} dia={dia} onClose={() => setTenencia(null)} />}
      {extracto && <ModalExtracto cuenta={extracto} onImportar={(f, o) => importar(extracto, f, o)} onClose={() => setExtracto(null)} />}
      {otraEmpresa && (
        <Modal titulo="Este extracto parece de otra empresa" onClose={() => setOtraEmpresa(null)} ancho="max-w-lg">
          <div className="space-y-4">
            <p className="text-sm">{otraEmpresa.mensaje}</p>
            <p className="text-xs text-seco">Si te equivocaste de cuenta, cancelá y subilo en la correcta. Si de verdad es de {otraEmpresa.cuenta.nombre}, podés subirlo igual: queda anotado en la auditoría.</p>
            <div className="flex justify-end gap-2">
              <Btn variant="secundario" onClick={() => setOtraEmpresa(null)}>
                Cancelar
              </Btn>
              <Btn
                onClick={async () => {
                  const o = otraEmpresa
                  setOtraEmpresa(null)
                  await importar(o.cuenta, o.archivo, { ...o.opciones, confirmarOtraEmpresa: true })
                }}
              >
                Subir igual
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Sugerencia para "aprender": la descripción sin números ni códigos. */
function patronSugerido(desc: string): string {
  return textoBanco(desc)
    .split(' ')
    .filter((w) => !/\d/.test(w))
    .slice(0, 4)
    .join(' ')
}

function ModalReclasificar({ mov, onClose }: { mov: MovimientoBancario; onClose: () => void }) {
  const { tesoreria, catalogos, reclasificarMovimiento } = useStore()
  const [categoria, setCategoria] = useState<CategoriaMovimiento>(mov.categoria === 'SIN_CLASIFICAR' ? (mov.importe < 0 ? 'GASTO_BANCARIO' : 'COBRO') : mov.categoria)
  const [cuenta, setCuenta] = useState(mov.cuentaContable ?? '')
  const [aprender, setAprender] = useState(mov.estado === 'A_REVISAR')
  const [patron, setPatron] = useState(patronSugerido(mov.descripcion))
  const [enviando, setEnviando] = useState(false)
  const opciones = [...new Set([...(tesoreria?.cuentasContables ?? []), ...catalogos.planCuentas, ...(catalogos.planPorEmpresa[mov.empresaId] ?? [])])].sort((a, b) => a.localeCompare(b))
  const patronOk = !aprender || (patron.trim() !== '' && textoBanco(mov.descripcion).includes(textoBanco(patron)))
  return (
    <Modal titulo="Reclasificar movimiento" onClose={onClose} ancho="max-w-xl">
      <div className="space-y-4">
        <div className="rounded-xl border border-borde px-4 py-3 text-sm">
          <p className="font-semibold">{mov.descripcion}</p>
          <p className="text-seco text-xs">
            {fecha(mov.fecha)} · <span className={mov.importe < 0 ? 'text-red-300' : 'text-emerald-300'}>{money(mov.importe)}</span>
          </p>
        </div>
        <Field label="Clasificación">
          <Desplegable
            value={categoria}
            onChange={(v) => setCategoria(v as CategoriaMovimiento)}
            opciones={(Object.keys(CATEGORIAS_MOV) as CategoriaMovimiento[]).filter((k) => k !== 'SIN_CLASIFICAR').map((k) => ({ value: k, label: CATEGORIAS_MOV[k] }))}
          />
        </Field>
        <Field label="Cuenta contable" hint="La fila del Flujo sale de esta cuenta.">
          <SelectorCuenta value={cuenta} onChange={setCuenta} opciones={opciones} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={aprender} onChange={(e) => setAprender(e.target.checked)} className="accent-dorado w-4 h-4" />
          Aprender regla: la próxima vez que aparezca este texto entra clasificado solo
        </label>
        {aprender && (
          <Field label="Texto que reconoce la regla" hint={patronOk ? 'Tiene que estar en la descripción del movimiento.' : 'Ese texto no está en la descripción.'} marcado={patronOk ? undefined : 'falta'}>
            <input className={inputCls} value={patron} onChange={(e) => setPatron(e.target.value)} aria-label="Texto de la regla" />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!patronOk || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await reclasificarMovimiento(mov.id, categoria, cuenta.trim() || null, aprender ? patron.trim() : null)
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

function ModalSinMovimientos({ cuenta, dia, onClose }: { cuenta: CuentaBancaria; dia: string; onClose: () => void }) {
  const { tesoreria, marcarSinMovimientos } = useStore()
  const [confirmo, setConfirmo] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const ant = tesoreria!.saldos.filter((s) => s.cuentaId === cuenta.id && s.fecha < dia).sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
  return (
    <Modal titulo={`Sin movimientos · ${cuenta.nombre}`} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4 text-sm">
        <p>
          El {fecha(dia)} queda con el saldo anterior{ant ? ` (${money(ant.saldo)} del ${fecha(ant.fecha)})` : ''}. Nunca se inventa un saldo: si no hay saldo anterior, se carga a mano.
        </p>
        {cuenta.rindeDiario && (
          <div className="rounded-xl border border-amber-600 bg-amber-950/30 p-4 space-y-2 text-amber-100">
            <p className="font-bold">Esta cuenta rinde todos los días.</p>
            <p>Lo normal es que haya un rendimiento. Lo correcto es subir el extracto; marcalo sin movimientos solo si confirmaste que ese día no rindió.</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={confirmo} onChange={(e) => setConfirmo(e.target.checked)} className="accent-dorado w-4 h-4" />
              Confirmo que el {fecha(dia)} no hubo rendimiento ni movimientos
            </label>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={(cuenta.rindeDiario && !confirmo) || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await marcarSinMovimientos(cuenta.id, dia, confirmo)
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Marcar sin movimientos
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Subir el archivo del banco (POST /api/bancos/extracto). El servidor detecta el banco y el formato.
 *  · Brubank trae la CC y la remunerada en el mismo Excel: cada parte va a su cuenta. Si la CC tiene más de
 *    una remunerada hay que decir cuál.
 *  · El informe de un FCI es una tenencia: guarda el saldo (origen TENENCIA) y el rendimiento sale de la
 *    conciliación. Si el informe no dice la fecha, se indica acá.
 */
function ModalExtracto({ cuenta, onImportar, onClose }: { cuenta: CuentaBancaria; onImportar: (f: File, o: { fechaTenencia?: string; cuentaRemuneradaId?: string }) => Promise<boolean>; onClose: () => void }) {
  const { tesoreria } = useStore()
  const t = tesoreria!
  const [archivo, setArchivo] = useState<File | null>(null)
  const [fechaTenencia, setFechaTenencia] = useState('')
  const remuneradas = t.cuentas.filter((c) => c.cuentaMadreId === cuenta.id && c.clase === 'REMUNERADA')
  const [remunerada, setRemunerada] = useState('')
  const [enviando, setEnviando] = useState(false)
  const esFondo = cuenta.clase === 'FCI' || cuenta.clase === 'REMUNERADA'
  const faltaRemunerada = remuneradas.length > 1 && !remunerada
  return (
    <Modal titulo={`${cuenta.clase === 'FCI' ? 'Informe del fondo' : 'Extracto'} · ${cuenta.nombre}`} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-seco">
          {cuenta.clase === 'FCI'
            ? 'Subí el informe de tenencia tal como lo baja el banco (PDF o Excel). Se guarda el saldo del fondo como tenencia y el rendimiento del día sale solo de la conciliación.'
            : 'Subí el archivo tal como lo baja el banco (CSV, Excel o PDF). El sistema reconoce el banco y el formato; el mismo archivo no entra dos veces.'}
        </p>
        <Field label="Archivo">
          <input type="file" accept=".csv,.xlsx,.xls,.txt,.pdf" className={`${inputCls} pt-2`} onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} data-testid="archivo-extracto" aria-label="Archivo del banco" />
        </Field>
        {remuneradas.length === 1 && <p className="text-xs text-seco">Si el archivo trae también la cuenta remunerada (Brubank), esa parte va a {remuneradas[0].nombre}.</p>}
        {remuneradas.length > 1 && (
          <Field label="Cuenta remunerada" hint="El archivo de Brubank trae la CC y la remunerada: decí a cuál va la remunerada.">
            <Desplegable value={remunerada} onChange={setRemunerada} opciones={[{ value: '', label: 'Elegí la remunerada' }, ...remuneradas.map((c) => ({ value: c.id, label: c.nombre }))]} />
          </Field>
        )}
        {esFondo && (
          <Field label="Fecha de la tenencia (opcional)" hint="Solo si el informe no dice la fecha del saldo. Si la dice, se usa la del informe.">
            <input type="date" className={inputCls} value={fechaTenencia} max={t.hoy} onChange={(e) => setFechaTenencia(e.target.value)} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!archivo || faltaRemunerada || enviando}
            onClick={async () => {
              if (!archivo) return
              setEnviando(true)
              const ok = await onImportar(archivo, { fechaTenencia: esFondo && fechaTenencia ? fechaTenencia : undefined, cuentaRemuneradaId: remunerada || undefined })
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            {enviando ? 'Importando…' : 'Importar'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

const sumarDias = (d: string, n: number) => {
  const x = new Date(d + 'T12:00:00Z')
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}

function ModalTenencia({ cuenta, dia, onClose }: { cuenta: CuentaBancaria; dia: string; onClose: () => void }) {
  const { tesoreria, registrarSaldo } = useStore()
  const [f, setF] = useState(dia)
  const [saldo, setSaldo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const n = parseMonto(saldo)
  const ant = tesoreria!.saldos.filter((s) => s.cuentaId === cuenta.id && s.fecha < f).sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
  // Aviso "fondo sin movimientos del banco": sin extracto, movimientos ni "sin movimientos" de la cuenta madre ese día, un rescate o una
  // suscripción haría que el rendimiento salga mal.
  const madre = cuenta.cuentaMadreId ? tesoreria!.cuentas.find((c) => c.id === cuenta.cuentaMadreId) : undefined
  const hoyT = tesoreria!.hoy
  const dow = f ? new Date(f + 'T12:00:00').getDay() : 0
  // Solo FCI, solo días hábiles y solo dentro de lo que la pantalla tiene cargado (45 días): más atrás no se sabe.
  const sinBanco =
    cuenta.clase === 'FCI' &&
    !!madre &&
    !!f &&
    dow !== 0 &&
    dow !== 6 &&
    !tesoreria!.feriados.includes(f) &&
    f >= sumarDias(hoyT, -40) &&
    !tesoreria!.movimientos.some((m) => m.cuentaId === madre.id && m.fecha === f && m.estado !== 'IGNORADO') &&
    !tesoreria!.saldos.some((s) => s.cuentaId === madre.id && s.fecha === f && (s.origen === 'EXTRACTO' || s.origen === 'SIN_MOVIMIENTOS'))
  return (
    <Modal titulo={`Tenencia · ${cuenta.nombre}`} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-seco">El valor de la tenencia según el informe del fondo. El rendimiento del día sale solo: saldo − anterior − suscripciones + rescates, y entra real al Flujo.</p>
        {sinBanco && (
          <p className="text-sm text-dorado" data-aviso="fondo-sin-movimientos">
            OJO: no hay movimientos de {madre!.nombre} el {fecha(f)}. Si hubo rescate o suscripción, subí antes el extracto del banco.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha">
            <input type="date" className={inputCls} value={f} max={tesoreria!.hoy} onChange={(e) => setF(e.target.value)} />
          </Field>
          <Field label="Tenencia" hint={ant ? `Anterior: ${money(ant.saldo)} (${fecha(ant.fecha)})` : undefined}>
            <CampoMonto value={saldo} onChange={setSaldo} autoFocus />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={n === null || !f || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await registrarSaldo(cuenta.id, f, n!, 'TENENCIA')
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Guardar tenencia
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- Conciliación bancaria

function ConciliacionTab({ cuentas, dia, onDia }: { cuentas: CuentaBancaria[]; dia: string; onDia: (d: string) => void }) {
  const { tesoreria, empresa } = useStore()
  const t = tesoreria!
  const fer = new Set(t.feriados)
  const ayer = diaHabilAnterior(t.hoy, fer)
  const dias = diasHabiles(sumarHabiles(ayer, -7, fer), 8, fer)
  const fila = (cid: string, d: string): Conciliacion | undefined => t.conciliacion.find((k) => k.cuentaId === cid && k.fecha === d)
  const estadoDe = (cid: string, d: string) => fila(cid, d)?.estado ?? (d < t.hoy ? 'SIN_EXTRACTO' : undefined)
  const delDia = cuentas.map((c) => ({ c, k: fila(c.id, dia) }))
  const ok = delDia.filter((x) => x.k?.estado === 'OK' || x.k?.estado === 'SIN_MOVIMIENTOS').length
  const dif = delDia.filter((x) => x.k?.estado === 'DIFERENCIA').length
  const sin = delDia.filter((x) => !x.k || x.k.estado === 'SIN_EXTRACTO').length
  const rinde = delDia.reduce((a, x) => a + (x.k?.rendimiento ?? 0), 0)
  const unidades = t.unidades.filter((u) => cuentas.some((c) => c.unidadId === u.id))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label={`Cuentas OK · ${fecha(dia).slice(0, 5)}`} value={`${ok} / ${cuentas.length}`} tone="verde" />
        <Kpi label="Con diferencia" value={String(dif)} tone={dif ? 'rojo' : 'crema'} sub="banco ≠ calculado" />
        <Kpi label="Sin extracto" value={String(sin)} tone={sin ? 'dorado' : 'crema'} sub="subir o marcar sin movimientos" />
        <Kpi label="Rendimiento FCI del día" value={money(rinde)} tone="verde" sub="sale de la tenencia" />
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-borde">
          <h3 className="font-serif text-xl">Últimos 8 días hábiles</h3>
          <p className="text-xs text-seco">Saldo anterior + movimientos = calculado, contra el saldo del banco. Tocá un día para ver el detalle.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-suave text-[0.625rem] uppercase tracking-[0.14em] text-seco">
              <tr>
                <th className="text-left px-4 py-3 font-bold">Cuenta</th>
                {dias.map((d) => (
                  <th key={d} className={`px-2 py-3 font-bold text-center whitespace-nowrap ${d === dia ? 'text-acento' : ''}`}>
                    <button onClick={() => onDia(d)}>{diaCorto(d)}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-borde/60">
              {unidades.map((u) => (
                <FilasUnidad key={u.id} titulo={`${empresa(u.empresaId).corto} · ${u.nombre}`} cuentas={cuentas.filter((c) => c.unidadId === u.id)} dias={dias} dia={dia} estadoDe={estadoDe} fila={fila} onDia={onDia} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-borde">
          <h3 className="font-serif text-xl">Detalle del {fecha(dia)}</h3>
          <p className="text-xs text-seco">Banco vs calculado vs Xubio. En un FCI lo que no explican los movimientos es el rendimiento.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-suave text-[0.625rem] uppercase tracking-[0.14em] text-seco">
              <tr>
                {['Cuenta', 'Saldo anterior', 'Créditos', 'Débitos', 'Calculado', 'Banco', 'Diferencia', 'Xubio', 'Dif. Xubio', 'Rendimiento', 'Estado'].map((h, i) => (
                  <th key={h} className={`px-3 py-3 font-bold whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-borde/60">
              {delDia.map(({ c, k }) => {
                const est = k?.estado ?? 'SIN_EXTRACTO'
                const m = (v?: number) => (v === undefined ? '—' : num(v))
                return (
                  <tr key={c.id}>
                    <td className="px-3 py-2">
                      <p className="font-semibold whitespace-nowrap">{c.nombre}</p>
                      <p className="text-[0.6875rem] text-seco">{empresa(c.empresaId).corto}</p>
                    </td>
                    <td className="px-3 py-2 text-right tabular">{m(k?.saldoAnterior)}</td>
                    <td className="px-3 py-2 text-right tabular text-emerald-300">{k ? num(k.creditos) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular text-red-300">{k ? num(k.debitos) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular">{m(k?.saldoCalculado)}</td>
                    <td className="px-3 py-2 text-right tabular font-semibold">{m(k?.saldoExtracto)}</td>
                    <td className={`px-3 py-2 text-right tabular ${k?.estado === 'DIFERENCIA' ? 'text-red-300 font-bold' : 'text-seco'}`}>{c.clase === 'FCI' || c.clase === 'REMUNERADA' ? '—' : m(k?.diferencia)}</td>
                    <td className="px-3 py-2 text-right tabular">{m(k?.saldoXubio)}</td>
                    <td className={`px-3 py-2 text-right tabular ${k?.diferenciaXubio ? 'text-amber-300 font-bold' : 'text-seco'}`}>{m(k?.diferenciaXubio)}</td>
                    <td className="px-3 py-2 text-right tabular text-emerald-300">{k?.rendimiento !== undefined ? num(k.rendimiento) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Badge tone={ESTADO_CONCILIACION[est].tone}>{ESTADO_CONCILIACION[est].label}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function FilasUnidad({
  titulo,
  cuentas,
  dias,
  dia,
  estadoDe,
  fila,
  onDia,
}: {
  titulo: string
  cuentas: CuentaBancaria[]
  dias: string[]
  dia: string
  estadoDe: (c: string, d: string) => Conciliacion['estado'] | undefined
  fila: (c: string, d: string) => Conciliacion | undefined
  onDia: (d: string) => void
}) {
  return (
    <>
      <tr className="bg-suave/40">
        <td colSpan={dias.length + 1} className="px-4 py-1.5 text-[0.625rem] uppercase tracking-[0.16em] font-bold text-seco">
          {titulo}
        </td>
      </tr>
      {cuentas.map((c) => (
        <tr key={c.id}>
          <td className="px-4 py-2 whitespace-nowrap">{c.nombre}</td>
          {dias.map((d) => {
            const e = estadoDe(c.id, d)
            const k = fila(c.id, d)
            return (
              <td key={d} className={`px-2 py-2 text-center ${d === dia ? 'bg-dorado/5' : ''}`}>
                {e ? (
                  <button onClick={() => onDia(d)} title={k?.diferencia ? `Diferencia ${money(k.diferencia)}` : undefined}>
                    <Badge tone={ESTADO_CONCILIACION[e].tone}>{e === 'DIFERENCIA' && k?.diferencia !== undefined ? num(k.diferencia) : ESTADO_CONCILIACION[e].label}</Badge>
                  </button>
                ) : (
                  <span className="text-seco">—</span>
                )}
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- Pendiente en Xubio (lo bancario)

const QUE_XUBIO: Record<PendienteXubio['tipo'], string> = {
  COMPROBANTE: 'Comprobante "Extracto Bancario"',
  ASIENTO: 'Asiento del banco',
  ANULAR_ASIENTO: 'Anular asiento',
  ANULAR_PAGO: 'Anular pago',
  ANULAR_CHEQUE: 'Anular cheque',
}
const ESTADO_XUBIO: Record<PendienteXubio['estado'], { label: string; tone: 'neutro' | 'dorado' | 'rojo' | 'azul' | 'naranja' }> = {
  FALTA_APROBAR: { label: 'Falta aprobar', tone: 'naranja' },
  PENDIENTE: { label: 'Pendiente', tone: 'dorado' },
  EN_CURSO: { label: 'Enviándose', tone: 'azul' },
  ERROR: { label: 'Error', tone: 'rojo' },
}
const ESTADO_ITEM: Record<ResultadoCorridaBancos['items'][number]['estado'], { label: string; tone: 'neutro' | 'verde' | 'rojo' | 'azul' }> = {
  OK: { label: 'Hecho', tone: 'verde' },
  PRUEBA_OK: { label: 'En seco', tone: 'azul' },
  ERROR: { label: 'Error', tone: 'rojo' },
  OMITIDO: { label: 'Omitido', tone: 'neutro' },
}

/**
 * Lo bancario que falta en Xubio (vista xubio_bancos_pendientes): comprobantes, asientos y anulaciones. El
 * robot (xubio-bancos-pendientes) lo sube cada 15 minutos si el servidor está en real. Administración puede
 * correrlo a mano, en seco (no cambia nada, deja registro) o de verdad, y marcar lo que Xubio no deja anular
 * por API (órdenes de pago, cheques) cuando ya lo anuló a mano.
 */
function PendientesXubioTab({ empresaId }: { empresaId: string }) {
  const { tesoreria, empresa, usuario, modo, correrEnviosBancos } = useStore()
  const t = tesoreria!
  const [corrida, setCorrida] = useState<ResultadoCorridaBancos | null>(null)
  const [corriendo, setCorriendo] = useState<'SECO' | 'REAL' | null>(null)
  const [confirmarReal, setConfirmarReal] = useState(false)
  const [aMano, setAMano] = useState<PendienteXubio | null>(null)
  const puedeCorrer = PUEDE_ANULAR_XUBIO_A_MANO.includes(usuario.rol)
  const lista = t.pendientesXubio.filter((p) => empresaId === 'TODAS' || p.empresaId === empresaId)
  const cuantos = (f: (p: PendienteXubio) => boolean) => lista.filter(f).length
  const anulaciones = cuantos((p) => p.tipo.startsWith('ANULAR_'))
  const errores = cuantos((p) => p.estado === 'ERROR')
  const manuales = cuantos((p) => p.aMano)

  async function correr(enSeco: boolean) {
    setCorriendo(enSeco ? 'SECO' : 'REAL')
    const r = await correrEnviosBancos(enSeco)
    setCorriendo(null)
    setConfirmarReal(false)
    if (r) setCorrida(r)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Comprobantes y asientos" value={String(lista.length - anulaciones)} tone={lista.length - anulaciones ? 'dorado' : 'crema'} sub="por subir a Xubio" />
        <Kpi label="Anulaciones" value={String(anulaciones)} tone={anulaciones ? 'dorado' : 'crema'} sub="anulado acá, vivo en Xubio" />
        <Kpi label="A mano" value={String(manuales)} tone={manuales ? 'rojo' : 'crema'} sub="Xubio no deja por API" />
        <Kpi label="Con error" value={String(errores)} tone={errores ? 'rojo' : 'verde'} />
      </div>

      <Card>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="text-sm text-seco max-w-2xl">
            <p>
              El envío automático corre cada 15 minutos en días hábiles (8 a 19:45) cuando el servidor está en real. Desde acá se puede correr ahora: <b className="text-crema">en seco</b> muestra lo que haría
              sin cambiar nada; <b className="text-crema">enviar</b> sube de verdad (solo si el servidor tiene el envío real prendido).
            </p>
            {modo === 'demo' && <p className="mt-1">En la demo el envío es simulado: no se conecta con Xubio.</p>}
          </div>
          {puedeCorrer ? (
            <div className="flex gap-2 shrink-0">
              <Btn variant="secundario" disabled={corriendo !== null} onClick={() => void correr(true)}>
                {corriendo === 'SECO' ? 'Probando…' : 'Probar en seco'}
              </Btn>
              {confirmarReal ? (
                <>
                  <Btn variant="fantasma" onClick={() => setConfirmarReal(false)}>
                    Cancelar
                  </Btn>
                  <Btn disabled={corriendo !== null} onClick={() => void correr(false)}>
                    {corriendo === 'REAL' ? 'Enviando…' : 'Confirmar envío'}
                  </Btn>
                </>
              ) : (
                <Btn disabled={corriendo !== null} onClick={() => setConfirmarReal(true)}>
                  Enviar a Xubio ahora
                </Btn>
              )}
            </div>
          ) : (
            <p className="text-xs text-seco">La corrida manual y las anulaciones a mano son de Administración.</p>
          )}
        </div>
        {corrida && (
          <div className="mt-4 rounded-xl border border-borde p-4 space-y-2 text-sm" data-testid="resultado-corrida">
            <p className="font-bold">
              {corrida.omitido ? `No se corrió: ${corrida.omitido}` : corrida.real ? `Envío real · ${corrida.items.length} procesado(s)` : `En seco · ${corrida.items.length} procesado(s), sin cambiar nada`}
            </p>
            {!corrida.real && !corrida.envioRealHabilitado && <p className="text-xs text-seco">El servidor está en seco (XUBIO_BANCOS_ENVIO_REAL apagado): aunque pidas enviar, no se manda nada a Xubio.</p>}
            {corrida.items.length > 0 && (
              <ul className="space-y-1">
                {corrida.items.map((i) => (
                  <li key={`${i.entidad}-${i.id}`} className="flex gap-2 items-start">
                    <Badge tone={ESTADO_ITEM[i.estado].tone}>{ESTADO_ITEM[i.estado].label}</Badge>
                    <span className="text-xs">{i.detalle}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      {lista.length === 0 ? (
        <Empty texto="No hay nada bancario pendiente con Xubio." />
      ) : (
        <Table head={['Fecha', 'Empresa', 'Qué', 'Detalle', 'Importe', 'Estado', 'Último intento', '']}>
          {lista.map((p) => (
            <tr key={`${p.tipo}-${p.id}`} data-pendiente={p.tipo} className={p.estado === 'ERROR' ? 'bg-red-950/10' : ''}>
              <td className="px-4 py-2 whitespace-nowrap">{fecha(p.fecha)}</td>
              <td className="px-4 py-2 whitespace-nowrap">{empresa(p.empresaId).corto}</td>
              <td className="px-4 py-2 whitespace-nowrap text-xs">
                {QUE_XUBIO[p.tipo]}
                {p.aMano && (
                  <span className="block">
                    <Badge tone="rojo" title="Xubio no lo deja anular por API">
                      A mano en Xubio
                    </Badge>
                  </span>
                )}
              </td>
              <td className="px-4 py-2 max-w-[320px]">
                <p className="truncate text-xs" title={p.descripcion}>
                  {p.descripcion}
                </p>
                {p.xubioId && <p className="text-[0.6875rem] text-seco">Xubio {p.xubioId}</p>}
                {p.error && <p className="text-[0.6875rem] text-red-300">{p.error}</p>}
              </td>
              <td className="px-4 py-2 text-right tabular whitespace-nowrap">{p.importe !== undefined ? money(p.importe) : '—'}</td>
              <td className="px-4 py-2">
                <Badge tone={ESTADO_XUBIO[p.estado].tone}>{ESTADO_XUBIO[p.estado].label}</Badge>
              </td>
              <td className="px-4 py-2 text-[0.6875rem] text-seco max-w-[260px]">
                {p.ultimoIntentoEn && (
                  <span className="block">
                    {fechaHora(p.ultimoIntentoEn)}
                    {p.ultimoIntentoModo === 'PRUEBA' ? ' · en seco' : ''}
                  </span>
                )}
                {p.ultimoIntentoDetalle ? <span className="block truncate" title={p.ultimoIntentoDetalle}>{p.ultimoIntentoDetalle}</span> : !p.ultimoIntentoEn && '—'}
              </td>
              <td className="px-4 py-2 text-right">
                {puedeCorrer && p.tipo.startsWith('ANULAR_') && (
                  <button className="text-[0.75rem] text-acento underline whitespace-nowrap" onClick={() => setAMano(p)}>
                    Ya lo anulé en Xubio
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {aMano && (
        <ModalAnulacionManual
          tipo={aMano.tipo === 'ANULAR_PAGO' ? 'PAGO' : aMano.tipo === 'ANULAR_CHEQUE' ? 'CHEQUE' : 'ASIENTO'}
          id={aMano.id}
          titulo={`${QUE_XUBIO[aMano.tipo]} · hecho a mano`}
          detalle={
            <>
              {aMano.descripcion}
              {aMano.importe !== undefined && ` · ${money(aMano.importe)}`}
              {aMano.xubioId && ` · Xubio ${aMano.xubioId}`}
            </>
          }
          onClose={() => setAMano(null)}
        />
      )}
    </div>
  )
}
