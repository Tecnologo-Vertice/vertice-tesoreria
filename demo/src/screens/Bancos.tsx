import { useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { CategoriaMovimiento, Conciliacion, CuentaBancaria, MovimientoBancario } from '../types'
import type { ResultadoExtracto } from '../data/fuente'
import { Badge, Btn, Card, Desplegable, Empty, Field, inputCls, Kpi, Modal, SelectorCuenta, Table, Tabs } from '../components/ui'
import { AvisoTesoreria, CampoMonto } from '../components/Tesoreria'
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
  const [tab, setTab] = useState<'MOVIMIENTOS' | 'CONCILIACION'>('MOVIMIENTOS')
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
        ]}
      />

      {tab === 'MOVIMIENTOS' ? <Movimientos cuentas={cuentas} dia={diaSel} puede={puede} /> : <ConciliacionTab cuentas={cuentas} dia={diaSel} onDia={setDia} />}
    </div>
  )
}

// ---------------------------------------------------------------- Movimientos bancarios

function Movimientos({ cuentas, dia, puede }: { cuentas: CuentaBancaria[]; dia: string; puede: boolean }) {
  const { tesoreria, empresa, subirExtracto, generarComprobanteGastos, generarAsientoBancario } = useStore()
  const t = tesoreria!
  const [resultado, setResultado] = useState<{ cuenta: string; r: ResultadoExtracto } | null>(null)
  const [subiendo, setSubiendo] = useState<string | null>(null)
  const [vista, setVista] = useState<'REVISAR' | 'DIA' | 'TODOS'>('REVISAR')
  const [reclasificar, setReclasificar] = useState<MovimientoBancario | null>(null)
  const [sinMov, setSinMov] = useState<CuentaBancaria | null>(null)
  const [tenencia, setTenencia] = useState<CuentaBancaria | null>(null)
  const archivo = useRef<HTMLInputElement>(null)
  const cuentaArchivo = useRef<string>('')
  const nombre = (id: string) => t.cuentas.find((c) => c.id === id)?.nombre ?? id
  const unidad = (id?: string) => t.unidades.find((u) => u.id === id)?.nombre

  const ids = new Set(cuentas.map((c) => c.id))
  const movs = t.movimientos
    .filter((m) => ids.has(m.cuentaId))
    .filter((m) => (vista === 'REVISAR' ? m.estado === 'A_REVISAR' : vista === 'DIA' ? m.fecha === dia : true))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || a.cuentaId.localeCompare(b.cuentaId))

  async function elegido(f: File | undefined) {
    if (!f) return
    const cid = cuentaArchivo.current
    setSubiendo(cid)
    const r = await subirExtracto(f, cid)
    setSubiendo(null)
    if (r) setResultado({ cuenta: nombre(cid), r })
    if (archivo.current) archivo.current.value = ''
  }

  return (
    <div className="space-y-6">
      <input ref={archivo} type="file" className="hidden" accept=".csv,.xlsx,.xls,.txt,.pdf" onChange={(e) => void elegido(e.target.files?.[0])} data-testid="archivo-extracto" />

      {resultado && (
        <div className={`rounded-2xl border px-5 py-4 text-sm flex items-start justify-between gap-4 ${resultado.r.repetido ? 'border-amber-600 bg-amber-950/30 text-amber-100' : 'border-emerald-700 bg-emerald-950/30 text-emerald-100'}`}>
          <div>
            <p className="font-bold">
              {resultado.cuenta}: {resultado.r.repetido ? 'ese archivo ya estaba importado' : `${resultado.r.nuevos} movimiento(s) nuevo(s)${resultado.r.movimientos !== undefined ? ` de ${resultado.r.movimientos} en el archivo` : ''}`}
            </p>
            <p className="opacity-80">
              {resultado.r.formato && `Formato ${resultado.r.formato}. `}
              {resultado.r.aRevisar ? `${resultado.r.aRevisar} quedaron "A revisar". ` : ''}
              {resultado.r.detalle ?? (resultado.r.repetido ? 'No se duplicó nada.' : 'Los saldos de cierre ya están en la conciliación.')}
            </p>
          </div>
          <button onClick={() => setResultado(null)} className="text-lg leading-none opacity-70 hover:opacity-100" aria-label="Cerrar">
            ×
          </button>
        </div>
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
                const asi = t.documentos.find((d) => d.tipo === 'ASIENTO' && d.cuentaId === c.id && d.fecha === dia)
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
                      {s ? money(s.saldo) : '—'}
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
                      {!comp && !asi && <span className="text-seco">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {puede ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[0.75rem]">
                          <button
                            className="text-acento underline disabled:opacity-40"
                            disabled={subiendo !== null}
                            onClick={() => {
                              cuentaArchivo.current = c.id
                              archivo.current?.click()
                            }}
                          >
                            {subiendo === c.id ? 'Subiendo…' : 'Subir extracto'}
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
          <Table head={['Importado', 'Cuenta', 'Archivo', 'Período', 'Movimientos', 'Nuevos', 'Por']}>
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
                </tr>
              ))}
          </Table>
        )}
      </Card>

      {reclasificar && <ModalReclasificar mov={reclasificar} onClose={() => setReclasificar(null)} />}
      {sinMov && <ModalSinMovimientos cuenta={sinMov} dia={dia} onClose={() => setSinMov(null)} />}
      {tenencia && <ModalTenencia cuenta={tenencia} dia={dia} onClose={() => setTenencia(null)} />}
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

function ModalTenencia({ cuenta, dia, onClose }: { cuenta: CuentaBancaria; dia: string; onClose: () => void }) {
  const { tesoreria, registrarSaldo } = useStore()
  const [f, setF] = useState(dia)
  const [saldo, setSaldo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const n = parseMonto(saldo)
  const ant = tesoreria!.saldos.filter((s) => s.cuentaId === cuenta.id && s.fecha < f).sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
  return (
    <Modal titulo={`Tenencia · ${cuenta.nombre}`} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-seco">El valor de la tenencia según el informe del fondo. El rendimiento del día sale solo: saldo − anterior − suscripciones + rescates, y entra real al Flujo.</p>
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
