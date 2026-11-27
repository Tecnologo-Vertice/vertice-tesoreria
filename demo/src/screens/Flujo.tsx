import { Fragment, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import type { Factura, FilaFlujo, LineaFlujo, Proyeccion, RefLinea } from '../types'
import { Badge, Btn, Card, Desplegable, Field, inputCls, Kpi, Modal, Tabs } from '../components/ui'
import { AvisoTesoreria, CampoMonto, ModalFormaPago, ModalMotivo, etiquetaFormaPago } from '../components/Tesoreria'
import { fecha, money } from '../lib/format'
import {
  armarGrilla,
  bloqueDetalle,
  compararFoto,
  diaCorto,
  diasDelMes,
  diasHabiles,
  esDiaHabil,
  grillaACsv,
  num,
  parseMonto,
  resumenDias,
  sumarHabiles,
  type EstadoItemBloque,
  type FilaGrilla,
} from '../lib/tesoreria'

const COLUMNAS = 15
const PUEDE = ['TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN']
const ORIGEN: Record<LineaFlujo['origenTipo'], string> = {
  PAGO: 'Pago',
  CHEQUE: 'Cheque',
  COBRO: 'Cobro',
  MOVIMIENTO: 'Banco',
  RENDIMIENTO: 'Rendimiento',
  FACTURA: 'Factura',
  PROYECCION: 'Proyección',
}

const ESTADO_ITEM: Record<EstadoItemBloque, { label: string; tone: 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja' }> = {
  PAGADO: { label: 'Pagado', tone: 'verde' },
  BANCO: { label: 'Banco', tone: 'verde' },
  DEBITADO: { label: 'Debitado', tone: 'verde' },
  'A DEBITAR': { label: 'A debitar', tone: 'dorado' },
  PROGRAMADO: { label: 'Programado', tone: 'dorado' },
  PARCIAL: { label: 'Pago parcial', tone: 'naranja' },
  PROYECTADO: { label: 'Proyectado', tone: 'dorado' },
  MANUAL: { label: 'Carga manual', tone: 'azul' },
  PLANILLA: { label: 'Planilla de gastos', tone: 'azul' },
}

type Accion = { tipo: 'mover' | 'importe' | 'eliminar'; linea: LineaFlujo; fecha?: string }
const refDe = (l: LineaFlujo): RefLinea => ({ origenTipo: l.origenTipo as RefLinea['origenTipo'], origenId: l.origenId, ocurrencia: l.ocurrencia })
const claveLinea = (l: LineaFlujo) => `${l.origenTipo}|${l.origenId}|${l.ocurrencia}`

export function Flujo() {
  const { tesoreria, empresa, usuario, toast, facturas, pagos, restaurarLineaFlujo } = useStore()
  const [unidadSel, setUnidadSel] = useState('')
  const [corrimiento, setCorrimiento] = useState(0)
  const [ocultarVacias, setOcultarVacias] = useState(true)
  const [celda, setCelda] = useState<{ filaId: string; dia: string } | null>(null)
  const [accion, setAccion] = useState<Accion | null>(null)
  const [nueva, setNueva] = useState(false)
  const [verProyecciones, setVerProyecciones] = useState(false)
  const [cargaManual, setCargaManual] = useState(false)
  const [verFotos, setVerFotos] = useState(false)
  const [configFila, setConfigFila] = useState<FilaFlujo | null>(null)
  const [formaPago, setFormaPago] = useState<Factura | null>(null)
  const [arrastrando, setArrastrando] = useState<string | null>(null)

  const fer = useMemo(() => new Set(tesoreria?.feriados ?? []), [tesoreria])
  const unidades = tesoreria?.unidades ?? []
  const unidadId = unidadSel || unidades[0]?.id || ''
  const dias = useMemo(() => (tesoreria ? diasHabiles(sumarHabiles(tesoreria.hoy, -5 + corrimiento, fer), COLUMNAS, fer) : []), [tesoreria, corrimiento, fer])
  const grilla = useMemo(
    () =>
      tesoreria
        ? armarGrilla({ unidadId, dias, filas: tesoreria.filas, lineas: tesoreria.lineas, cuentas: tesoreria.cuentas, saldos: tesoreria.saldos, control: tesoreria.control, feriados: fer })
        : null,
    [tesoreria, unidadId, dias, fer],
  )

  if (!tesoreria || !tesoreria.disponible || !grilla) return <AvisoTesoreria />
  const t = tesoreria
  const hoy = t.hoy
  const puede = PUEDE.includes(usuario.rol)
  const unidad = unidades.find((u) => u.id === unidadId)
  const lineasCelda = celda ? t.lineas.filter((l) => l.unidadId === unidadId && l.filaId === celda.filaId && l.fecha === celda.dia) : []
  const filaCelda = celda ? t.filas.find((f) => f.id === celda.filaId) : undefined
  const ultimo = dias[dias.length - 1]
  const futuras = dias.filter((d) => d >= hoy)
  const minimo = futuras.reduce<{ d: string; v: number } | null>((m, d) => (!m || grilla.cajaFinal[d] < m.v ? { d, v: grilla.cajaFinal[d] } : m), null)
  const efes = dias.filter((d) => grilla.control[d]?.estado === 'F').length
  const nombreUnidad = (u: (typeof unidades)[number]) => (unidades.filter((x) => x.nombre === u.nombre).length > 1 ? `${empresa(u.empresaId).corto} · ${u.nombre}` : u.nombre)

  // Exportar la grilla que se ve (como fbExportar del Apps Script): un CSV con la misma estructura, para abrir en una planilla.
  function exportar() {
    const blob = new Blob([grillaACsv(grilla!)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Flujo en bloques · ${unidad ? nombreUnidad(unidad) : ''} · ${hoy}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast('Grilla exportada: se descargó un CSV con los días que ves')
  }

  const detalleCelda = celda
    ? bloqueDetalle(lineasCelda, { hoy, facturas, pagos, cheques: t.cheques, cuentas: t.cuentas, proyecciones: t.proyecciones, fila: filaCelda })
    : null

  function soltar(e: DragEvent, filaId: string, dia: string) {
    e.preventDefault()
    const k = e.dataTransfer.getData('text/plain')
    setArrastrando(null)
    const l = t.lineas.find((x) => claveLinea(x) === k && x.unidadId === unidadId)
    if (!l) return
    if (!l.editable) return toast('Lo real no se mueve: sale del banco, de un pago o de un cobro ya hechos', 'error')
    if (l.filaId !== filaId) return toast('Solo se mueve de día: soltala en la misma fila', 'error')
    if (dia === l.fecha) return
    if (dia < hoy) return toast('No se proyecta en el pasado', 'error')
    setAccion({ tipo: 'mover', linea: l, fecha: dia })
  }

  const celdaCls = (d: string) => `${d === hoy ? 'bg-dorado/[0.07]' : d < hoy ? 'bg-suave/30' : ''}`

  const filaValores = (fg: FilaGrilla, nivel: 'cuenta' | 'interna') => {
    if (ocultarVacias && fg.vacia && nivel === 'cuenta') return null
    return (
      <tr key={fg.fila.id} className="group">
        <th scope="row" className={`sticky left-0 z-10 bg-pino text-left font-normal px-3 py-1.5 whitespace-nowrap ${nivel === 'interna' ? 'text-seco italic' : 'pl-7'}`}>
          {fg.fila.etiqueta}
          {fg.fila.manual && <span className="ml-1 text-[0.625rem] text-sky-300" title="Fila manual: el importe se carga a mano de un día">(manual)</span>}
          {fg.fila.personaFisica && <span className="ml-1 text-[0.625rem] text-seco" title="Acá caen las personas físicas pagadas desde esta unidad">(personas físicas)</span>}
          {puede && nivel === 'cuenta' && (
            <button className="ml-2 text-seco/60 hover:text-acento opacity-0 group-hover:opacity-100 focus:opacity-100" title="Marcar la fila como manual o como la de personas físicas" aria-label={`Configurar la fila ${fg.fila.etiqueta}`} onClick={() => setConfigFila(fg.fila)}>
              ⚙
            </button>
          )}
          {!fg.fila.mueveCaja && <span className="ml-1 text-[0.625rem] text-seco">(no mueve caja)</span>}
        </th>
        {dias.map((d) => {
          const v = fg.valores[d]
          const proy = fg.proyectado[d]
          const sel = celda?.filaId === fg.fila.id && celda.dia === d
          return (
            <td
              key={d}
              data-fila={fg.fila.etiqueta}
              data-dia={d}
              // Una celda vacía de hoy en adelante también se abre (para cargar un importe a mano, el "+" de la grilla).
              onClick={() => (v !== undefined || (puede && d >= hoy && nivel === 'cuenta') ? setCelda({ filaId: fg.fila.id, dia: d }) : setCelda(null))}
              onDragOver={(e) => {
                if (arrastrando) e.preventDefault()
              }}
              onDrop={(e) => soltar(e, fg.fila.id, d)}
              className={`px-2 py-1.5 text-right tabular whitespace-nowrap border-l border-borde/40 ${celdaCls(d)} ${v !== undefined ? 'cursor-pointer hover:bg-dorado/10' : ''} ${sel ? 'ring-2 ring-inset ring-dorado' : ''} ${arrastrando ? 'outline-dashed outline-1 outline-borde/60' : ''}`}
            >
              {v !== undefined && (
                <span className={`${proy ? 'italic text-acento' : v < 0 ? 'text-red-300' : 'text-emerald-300'}`} title={proy ? 'Tiene proyectado' : 'Real'}>
                  {num(v)}
                </span>
              )}
            </td>
          )
        })}
        <td className={`px-3 py-1.5 text-right tabular whitespace-nowrap border-l border-borde font-semibold ${fg.total < 0 ? 'text-red-300' : fg.total > 0 ? 'text-emerald-300' : 'text-seco'}`}>{fg.total ? num(fg.total) : ''}</td>
      </tr>
    )
  }

  const filaTotal = (titulo: ReactNode, valores: (d: string) => ReactNode, cls = '', total?: ReactNode) => (
    <tr className={cls}>
      <th scope="row" className={`sticky left-0 z-10 bg-pino text-left px-3 py-2 whitespace-nowrap ${cls.replace(/\bbg-\S+/g, '')}`}>
        {titulo}
      </th>
      {dias.map((d) => (
        <td key={d} className={`px-2 py-2 text-right tabular whitespace-nowrap border-l border-borde/40 ${celdaCls(d)}`}>
          {valores(d)}
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular whitespace-nowrap border-l border-borde">{total}</td>
    </tr>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Flujo de caja</h2>
          <p className="text-sm text-seco">Una pestaña por unidad, columnas por día hábil. Lo real sale de bancos, pagos, cobros y cheques; lo proyectado se mueve con motivo.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant="secundario" onClick={exportar} title="Descarga la grilla como CSV para abrir en una planilla">
            Exportar
          </Btn>
          <Btn variant="secundario" onClick={() => setVerFotos(true)} title="Cómo se veía el mes cuando se sacó la foto, contra cómo está hoy">
            Fotos del mes
          </Btn>
          {puede && (
            <>
              <Btn variant="secundario" onClick={() => setVerProyecciones(true)}>
                Proyecciones
              </Btn>
              <Btn onClick={() => setNueva(true)}>Nueva proyección</Btn>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={unidadId} onChange={(v) => (setUnidadSel(v), setCelda(null))} tabs={unidades.map((u) => ({ id: u.id, label: nombreUnidad(u) }))} />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-seco mr-2">
            <input type="checkbox" className="accent-dorado" checked={ocultarVacias} onChange={(e) => setOcultarVacias(e.target.checked)} />
            Ocultar filas sin movimiento
          </label>
          <Btn variant="secundario" className="h-9" onClick={() => setCorrimiento((c) => c - 5)} title="Semana anterior">
            ◀
          </Btn>
          <Btn variant="secundario" className="h-9" onClick={() => setCorrimiento(0)} disabled={corrimiento === 0}>
            Hoy
          </Btn>
          <Btn variant="secundario" className="h-9" onClick={() => setCorrimiento((c) => c + 5)} title="Semana siguiente">
            ▶
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Caja al inicio de hoy" value={money(grilla.cajaInicial[hoy] ?? 0)} sub={grilla.cajaInicialReal[hoy] ? 'saldo real de los bancos' : 'falta algún extracto de ayer'} />
        <Kpi label={`Caja al ${fecha(ultimo).slice(0, 5)}`} value={money(grilla.cajaFinal[ultimo] ?? 0)} tone={(grilla.cajaFinal[ultimo] ?? 0) < 0 ? 'rojo' : 'dorado'} sub="real + proyectado" />
        <Kpi label="Mínimo de caja" value={minimo ? money(minimo.v) : '—'} tone={minimo && minimo.v < 0 ? 'rojo' : 'verde'} sub={minimo ? `el ${fecha(minimo.d)}` : undefined} />
        <Kpi label="Control del Flujo" value={efes ? `${efes} día(s) en F` : 'OK'} tone={efes ? 'rojo' : 'verde'} sub="bancos vs real del período" />
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh]">
          <table className="text-[0.8125rem] border-separate border-spacing-0 min-w-full" data-testid="grilla-flujo">
            <thead className="sticky top-0 z-20">
              <tr className="bg-suave text-[0.625rem] uppercase tracking-[0.12em] text-seco">
                <th className="sticky left-0 z-30 bg-suave text-left px-3 py-2.5 min-w-[240px]">{unidad ? nombreUnidad(unidad) : ''}</th>
                {dias.map((d) => (
                  <th
                    key={d}
                    className={`px-2 py-2.5 text-right whitespace-nowrap min-w-[112px] border-l border-borde/40 ${d === hoy ? 'text-acento' : ''}`}
                    data-dia={d}
                  >
                    {diaCorto(d)}
                    <span className="block text-[0.5625rem] tracking-normal normal-case font-normal">{d < hoy ? 'real' : d === hoy ? 'hoy' : 'proyectado'}</span>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right border-l border-borde min-w-[120px]">Total</th>
              </tr>
            </thead>
            <tbody>
              {filaTotal(
                'Caja inicial',
                (d) => <span className={grilla.cajaInicialReal[d] ? '' : 'italic text-seco'}>{num(grilla.cajaInicial[d])}</span>,
                'font-bold border-b border-borde',
              )}
              {grilla.bloques.map((b) => (
                <Fragment key={b.seccion.id}>
                  <tr className="bg-suave/60">
                    <th scope="row" className="sticky left-0 z-10 bg-suave text-left px-3 py-1.5 text-[0.6875rem] uppercase tracking-[0.1em] font-bold text-crema whitespace-nowrap">
                      {b.seccion.etiqueta}
                    </th>
                    {dias.map((d) => (
                      <td key={d} className={`px-2 py-1.5 text-right tabular font-bold border-l border-borde/40 ${b.subtotal[d] < 0 ? 'text-red-300' : b.subtotal[d] > 0 ? 'text-emerald-300' : 'text-seco/50'}`}>
                        {b.subtotal[d] ? num(b.subtotal[d]) : '–'}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right tabular font-bold border-l border-borde">{b.total ? num(b.total) : ''}</td>
                  </tr>
                  {b.filas.map((f) => filaValores(f, 'cuenta'))}
                </Fragment>
              ))}
              {grilla.internas.map((f) => filaValores(f, 'interna'))}
              {filaTotal(
                'Flujo neto del día',
                (d) => <span className={grilla.neto[d] < 0 ? 'text-red-300' : 'text-emerald-300'}>{num(grilla.neto[d])}</span>,
                'font-bold border-t border-borde',
                num(dias.reduce((a, d) => a + grilla.neto[d], 0)),
              )}
              {filaTotal(
                'Caja final (acumulada)',
                (d) => <span className={`font-bold ${grilla.cajaFinal[d] < 0 ? 'text-red-300' : 'text-crema'}`}>{num(grilla.cajaFinal[d])}</span>,
                'bg-dorado/10 font-bold',
              )}
              <tr>
                <td colSpan={dias.length + 2} className="sticky left-0 px-3 pt-4 pb-1 text-[0.625rem] uppercase tracking-[0.16em] font-bold text-seco">
                  Saldos por banco
                </td>
              </tr>
              {grilla.bancos.map((b) => (
                <Fragment key={b.cuenta.id}>
                  {filaTotal(
                    <span className="font-normal pl-4">{b.cuenta.nombre}</span>,
                    (d) => {
                      const s = b.saldos[d]
                      if (!s) return <span className="text-seco/50">{d < hoy ? 'falta' : ''}</span>
                      return (
                        <span title={s.origen === 'SIN_MOVIMIENTOS' ? 'Sin movimientos: repite el saldo anterior' : s.origen === 'TENENCIA' ? 'Tenencia del fondo' : 'Extracto'}>
                          {num(s.saldo)}
                          {s.origen === 'SIN_MOVIMIENTOS' && <sup className="text-sky-300 ml-0.5">s/m</sup>}
                        </span>
                      )
                    },
                  )}
                </Fragment>
              ))}
              {filaTotal('Total bancos', (d) => (grilla.totalBancos[d] !== undefined ? num(grilla.totalBancos[d]!) : ''), 'font-bold border-t border-borde/60')}
              {filaTotal(
                'Control (bancos vs real)',
                (d) => {
                  const c = grilla.control[d]
                  if (c?.estado === 'OK') return <Badge tone="verde">OK</Badge>
                  if (c?.estado === 'F')
                    return (
                      <span title={`Bancos ${money(c.saldoBancos)} · real del período ${money(c.realDelPeriodo)} · diferencia ${money(c.diferencia)}`}>
                        <Badge tone="rojo">F {num(c.diferencia)}</Badge>
                      </span>
                    )
                  if (c?.estado === 'PRIMER_SALDO') return <Badge>Inicio</Badge>
                  if (d < hoy) return <Badge tone="naranja">Sin extracto</Badge>
                  return <span className="text-seco/50">—</span>
                },
                'border-t border-borde/60',
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-4 px-5 py-3 border-t border-borde text-[0.6875rem] text-seco">
          <span>
            <span className="text-emerald-300">1.234,56</span> / <span className="text-red-300">-1.234,56</span> real
          </span>
          <span>
            <span className="italic text-acento">1.234,56</span> con proyectado (tocá la celda para moverlo)
          </span>
          <span>Caja inicial en gris: no están todos los extractos del día anterior, se arrastra la caja proyectada.</span>
        </div>
      </Card>

      {celda && filaCelda && (
        <Card className="fade-up">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-serif text-xl">
                {filaCelda.etiqueta} · {diaCorto(celda.dia)}
              </h3>
              <p className="text-xs text-seco">Arrastrá una línea proyectada a otro día de la misma fila, o usá "Mover". Lo real no se edita.</p>
            </div>
            <div className="flex items-center gap-3">
              {puede && celda.dia >= hoy && (
                <Btn variant="secundario" className="h-9" onClick={() => setCargaManual(true)}>
                  + Cargar importe
                </Btn>
              )}
              <button onClick={() => setCelda(null)} className="text-seco hover:text-acento text-xl leading-none" aria-label="Cerrar">
                ×
              </button>
            </div>
          </div>
          {detalleCelda && detalleCelda.items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-3 text-sm" data-testid="resumen-bloque">
              <Badge tone={detalleCelda.estado === 'PAGADO' ? 'verde' : detalleCelda.estado === 'PARCIAL' ? 'naranja' : 'dorado'}>{detalleCelda.estado === 'PROYECTADO' ? 'Proyectado' : detalleCelda.estado === 'PROGRAMADO' ? 'Programado' : detalleCelda.estado === 'PARCIAL' ? 'Pago parcial' : 'Pagado'}</Badge>
              <span className="text-seco">{detalleCelda.ingreso ? 'Ingreso' : 'Egreso'} del bloque:</span>
              <span className="font-semibold tabular">{money(detalleCelda.total)}</span>
              <span className="text-seco">· real {money(detalleCelda.pagado)}</span>
              {filaCelda.manual && <Badge tone="azul">Fila manual: lo que cargues suma acá</Badge>}
              {detalleCelda.manual !== 0 && <span className="text-seco">· cargado a mano {money(Math.abs(detalleCelda.manual))}</span>}
            </div>
          )}
          <div className="space-y-2">
            {lineasCelda.length === 0 && <p className="text-sm text-seco italic">{filaCelda.manual ? 'Fila manual: todavía no hay nada cargado ese día.' : 'La celda está vacía.'}</p>}
            {detalleCelda?.items.map((it) => {
              const l = it.linea
              const real = l.naturaleza === 'REAL'
              const f = l.origenTipo === 'FACTURA' ? facturas.find((x) => x.id === l.origenId) : undefined
              const fp = f ? etiquetaFormaPago(f) : null
              return (
                <div
                  key={claveLinea(l)}
                  draggable
                  data-linea={l.concepto}
                  data-naturaleza={l.naturaleza}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', claveLinea(l))
                    e.dataTransfer.effectAllowed = 'move'
                    setArrastrando(claveLinea(l))
                  }}
                  onDragEnd={() => setArrastrando(null)}
                  className={`flex items-center gap-4 px-4 py-3 rounded-xl border ${real ? 'border-borde bg-suave/40 cursor-not-allowed' : 'border-dorado/50 bg-dorado/5 cursor-grab'}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-0.5">
                      {real ? <Badge tone="verde">🔒 Real</Badge> : <Badge tone="dorado">Proyectado</Badge>}
                      <Badge>{ORIGEN[l.origenTipo]}</Badge>
                      <Badge tone={ESTADO_ITEM[it.estado].tone}>{ESTADO_ITEM[it.estado].label}</Badge>
                      {l.ajustada && <Badge tone="azul">Ajustada</Badge>}
                      {l.vencido && <Badge tone="rojo">Vencida: era el {fecha(l.fechaCalculada)}</Badge>}
                      {!l.vencido && l.fechaCalculada !== l.fecha && <Badge tone="azul">Calculada el {fecha(l.fechaCalculada)}</Badge>}
                      {fp && <Badge tone="naranja">{fp}</Badge>}
                    </div>
                    <p className="font-semibold truncate">{l.contraparte}</p>
                    <p className="text-xs text-seco truncate">{l.concepto}</p>
                    {it.detalle.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[0.6875rem] text-seco" data-testid="detalle-linea">
                        {it.detalle.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className={`font-serif text-xl tabular ${l.importe < 0 ? 'text-red-300' : 'text-emerald-300'}`}>{money(l.importe)}</p>
                  <div className="flex flex-col items-end gap-1 text-[0.75rem] min-w-[120px]">
                    {real ? (
                      <>
                        <button disabled title="Lo real no se edita desde el Flujo" className="text-seco/60 cursor-not-allowed" data-accion="editar-real" onClick={() => toast('Lo real no se edita desde el Flujo', 'error')}>
                          Editar (no disponible)
                        </button>
                        <span className="text-[0.6875rem] text-seco">sale de {ORIGEN[l.origenTipo].toLowerCase()}</span>
                      </>
                    ) : puede ? (
                      <>
                        <button className="text-acento underline" onClick={() => setAccion({ tipo: 'mover', linea: l })}>
                          Mover de día
                        </button>
                        <button className="text-acento underline" onClick={() => setAccion({ tipo: 'importe', linea: l })}>
                          Editar importe
                        </button>
                        <button className="text-red-300 underline" onClick={() => setAccion({ tipo: 'eliminar', linea: l })}>
                          Eliminar
                        </button>
                        {l.ajustada && (
                          <button className="text-sky-300 underline" onClick={() => void restaurarLineaFlujo(refDe(l))}>
                            Restaurar
                          </button>
                        )}
                        {f && (
                          <button className="text-acento underline" onClick={() => setFormaPago(f)}>
                            Forma de pago
                          </button>
                        )}
                      </>
                    ) : (
                      <span className="text-seco">Solo consulta</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {accion && (
        <ModalAccion
          accion={accion}
          hoy={hoy}
          feriados={fer}
          proyeccion={accion.linea.origenTipo === 'PROYECCION' ? t.proyecciones.find((p) => p.id === accion.linea.origenId) : undefined}
          onClose={() => setAccion(null)}
        />
      )}
      {cargaManual && celda && filaCelda && unidad && <ModalCargaManual fila={filaCelda} dia={celda.dia} unidadId={unidad.id} onClose={() => setCargaManual(false)} />}
      {configFila && <ModalConfigFila fila={t.filas.find((f) => f.id === configFila.id) ?? configFila} onClose={() => setConfigFila(null)} />}
      {verFotos && unidad && <ModalFotos unidadId={unidad.id} onClose={() => setVerFotos(false)} />}
      {nueva && unidad && <ModalProyeccion unidadId={unidad.id} onClose={() => setNueva(false)} />}
      {verProyecciones && unidad && <ModalProyecciones unidadId={unidad.id} onClose={() => setVerProyecciones(false)} />}
      {formaPago && <ModalFormaPago factura={formaPago} onClose={() => setFormaPago(null)} />}
    </div>
  )
}

function ModalAccion({ accion, hoy, feriados, proyeccion, onClose }: { accion: Accion; hoy: string; feriados: Set<string>; proyeccion?: Proyeccion; onClose: () => void }) {
  const { ajustarLineaFlujo, cambiarProyeccion } = useStore()
  const l = accion.linea
  // En una proyección recurrente se elige: solo esta ocurrencia o esta y las siguientes (fbProyCambiar del Apps Script).
  const recurrente = !!proyeccion && proyeccion.recurrencia !== 'UNICA'
  const [alcance, setAlcance] = useState<'SOLO_ESTA' | 'DESDE_ESTA'>('SOLO_ESTA')
  const [f, setF] = useState(accion.fecha ?? l.fecha)
  const [importe, setImporte] = useState(String(Math.abs(l.importe)).replace('.', ','))
  const n = parseMonto(importe)
  const fechaOk = f >= hoy && esDiaHabil(f, feriados)
  const titulo = accion.tipo === 'mover' ? 'Mover línea proyectada' : accion.tipo === 'importe' ? 'Editar importe' : 'Eliminar línea proyectada'
  const esSaldoFactura = l.origenTipo === 'FACTURA' && l.ocurrencia === 'SALDO'
  return (
    <ModalMotivo
      titulo={titulo}
      texto={
        <>
          <span className="text-crema font-semibold">{l.contraparte}</span> · {l.concepto} · {money(l.importe)} · hoy en el {fecha(l.fecha)}
          {accion.tipo === 'mover' && esSaldoFactura && <span className="block mt-1">Mover una factura cambia su fecha de pago programada, no el vencimiento.</span>}
          {accion.tipo === 'eliminar' && <span className="block mt-1">Sale del Flujo. Se puede volver con "Restaurar".</span>}
        </>
      }
      confirmar={accion.tipo === 'mover' ? `Mover al ${fecha(f)}` : accion.tipo === 'importe' ? 'Guardar importe' : 'Eliminar'}
      peligro={accion.tipo === 'eliminar'}
      listo={accion.tipo === 'mover' ? fechaOk && f !== l.fecha : accion.tipo === 'importe' ? n !== null && n > 0 : true}
      onConfirmar={(motivo) =>
        recurrente && alcance === 'DESDE_ESTA'
          ? cambiarProyeccion(l.origenId, l.ocurrencia, 'DESDE_ESTA', accion.tipo === 'eliminar' ? 'BORRAR' : 'EDITAR', accion.tipo === 'mover' ? { fecha: f } : accion.tipo === 'importe' ? { importe: n! } : {}, motivo)
          : ajustarLineaFlujo(refDe(l), accion.tipo === 'mover' ? { fecha: f } : accion.tipo === 'importe' ? { importe: n! } : { eliminar: true }, motivo)
      }
      onClose={onClose}
    >
      {recurrente && (
        <Field label="Alcance" hint={alcance === 'DESDE_ESTA' ? 'La serie vieja termina el día anterior y sigue una nueva desde esta ocurrencia.' : 'Las demás ocurrencias no cambian.'}>
          <Desplegable
            value={alcance}
            onChange={(v) => setAlcance(v as 'SOLO_ESTA' | 'DESDE_ESTA')}
            opciones={[
              { value: 'SOLO_ESTA', label: 'Solo esta ocurrencia' },
              { value: 'DESDE_ESTA', label: 'Esta y las siguientes' },
            ]}
          />
        </Field>
      )}
      {accion.tipo === 'mover' && (
        <Field label="Nueva fecha" hint={fechaOk ? undefined : f < hoy ? 'No se proyecta en el pasado' : 'Elegí un día hábil'} marcado={fechaOk ? undefined : 'falta'}>
          <input type="date" className={inputCls} value={f} min={hoy} onChange={(e) => setF(e.target.value)} aria-label="Nueva fecha" />
        </Field>
      )}
      {accion.tipo === 'importe' && (
        <Field label={`Nuevo importe (${l.importe < 0 ? 'egreso' : 'ingreso'})`}>
          <CampoMonto value={importe} onChange={setImporte} autoFocus />
        </Field>
      )}
    </ModalMotivo>
  )
}

const RECURRENCIAS: Record<Proyeccion['recurrencia'], string> = { UNICA: 'Puntual (una vez)', SEMANAL: 'Semanal', QUINCENAL: 'Quincenal', MENSUAL: 'Mensual' }
const ORIGENES: Record<Proyeccion['origen'], string> = {
  MANUAL: 'Manual',
  GASTO_FIJO: 'Gasto fijo',
  PLAN_PAGO: 'Plan de pagos',
  PRESTAMO: 'Préstamo',
  SUELDOS: 'Sueldos',
  COBRANZA: 'Cobranza',
  PLANILLA_GASTOS: 'Planilla de gastos',
}

function ModalProyeccion({ unidadId, onClose }: { unidadId: string; onClose: () => void }) {
  const { tesoreria, crearProyeccion } = useStore()
  const t = tesoreria!
  const unidad = t.unidades.find((u) => u.id === unidadId)!
  const filas = t.filas.filter((f) => f.unidadId === unidadId && (f.tipo === 'CUENTA' || f.tipo === 'APERTURA')).sort((a, b) => a.orden - b.orden)
  const seccionDe = (f: FilaFlujo) => t.filas.find((x) => x.unidadId === unidadId && x.tipo === 'SECCION' && x.seccion === f.seccion)?.etiqueta ?? ''
  const [filaId, setFilaId] = useState(filas[0]?.id ?? '')
  const [concepto, setConcepto] = useState('')
  const [sentido, setSentido] = useState<'EGRESO' | 'INGRESO'>('EGRESO')
  const [importe, setImporte] = useState('')
  const [recurrencia, setRecurrencia] = useState<Proyeccion['recurrencia']>('UNICA')
  const [inicio, setInicio] = useState(sumarHabiles(t.hoy, 1, new Set(t.feriados)))
  const [diaMes, setDiaMes] = useState('10')
  const [fin, setFin] = useState<'HASTA' | 'CUOTAS'>('CUOTAS')
  const [hasta, setHasta] = useState('')
  const [cuotas, setCuotas] = useState('6')
  const [ajuste, setAjuste] = useState('0')
  const [origen, setOrigen] = useState<Proyeccion['origen']>('MANUAL')
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState(false)
  const n = parseMonto(importe)
  const recurrente = recurrencia !== 'UNICA'
  const finOk = !recurrente || (fin === 'HASTA' ? hasta >= inicio : Number(cuotas) > 0)
  const listo = !!filaId && concepto.trim() !== '' && n !== null && n > 0 && !!inicio && finOk && (recurrencia !== 'MENSUAL' || (Number(diaMes) >= 1 && Number(diaMes) <= 31))
  return (
    <Modal titulo={`Nueva proyección · ${unidad.nombre}`} onClose={onClose} ancho="max-w-2xl">
      <div className="space-y-4">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Fila del Flujo">
            <Desplegable value={filaId} onChange={setFilaId} buscar opciones={filas.map((f) => ({ value: f.id, label: f.etiqueta, detalle: seccionDe(f) }))} anchoMenu={320} />
          </Field>
          <Field label="Concepto">
            <input className={inputCls} value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej.: Alquiler depósito" aria-label="Concepto" />
          </Field>
          <Field label="Tipo">
            <Desplegable value={sentido} onChange={(v) => setSentido(v as 'EGRESO' | 'INGRESO')} opciones={[{ value: 'EGRESO', label: 'Egreso (sale plata)' }, { value: 'INGRESO', label: 'Ingreso (entra plata)' }]} />
          </Field>
          <Field label="Importe">
            <CampoMonto value={importe} onChange={setImporte} />
          </Field>
          <Field label="Recurrencia">
            <Desplegable value={recurrencia} onChange={(v) => setRecurrencia(v as Proyeccion['recurrencia'])} opciones={(Object.keys(RECURRENCIAS) as Proyeccion['recurrencia'][]).map((k) => ({ value: k, label: RECURRENCIAS[k] }))} />
          </Field>
          <Field label={recurrente ? 'Desde' : 'Fecha'} hint="Si cae en un día no hábil, el Flujo la pasa al siguiente.">
            <input type="date" className={inputCls} value={inicio} min={t.hoy} onChange={(e) => setInicio(e.target.value)} />
          </Field>
          {recurrencia === 'MENSUAL' && (
            <Field label="Día del mes" hint="En meses cortos, el último día.">
              <input className={inputCls} value={diaMes} onChange={(e) => setDiaMes(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
            </Field>
          )}
          {recurrente && (
            <>
              <Field label="Termina">
                <Desplegable value={fin} onChange={(v) => setFin(v as 'HASTA' | 'CUOTAS')} opciones={[{ value: 'CUOTAS', label: 'Después de N cuotas' }, { value: 'HASTA', label: 'En una fecha' }]} />
              </Field>
              {fin === 'CUOTAS' ? (
                <Field label="Cuotas">
                  <input className={inputCls} value={cuotas} onChange={(e) => setCuotas(e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
                </Field>
              ) : (
                <Field label="Hasta" marcado={hasta && hasta < inicio ? 'falta' : undefined}>
                  <input type="date" className={inputCls} value={hasta} min={inicio} onChange={(e) => setHasta(e.target.value)} />
                </Field>
              )}
              <Field label="Ajuste mensual %" hint="Ej.: 2,5 = +2,5 % por mes, compuesto desde el inicio.">
                <input className={inputCls} value={ajuste} onChange={(e) => setAjuste(e.target.value)} inputMode="decimal" />
              </Field>
            </>
          )}
          <Field label="Origen">
            <Desplegable value={origen} onChange={(v) => setOrigen(v as Proyeccion['origen'])} opciones={(Object.keys(ORIGENES) as Proyeccion['origen'][]).map((k) => ({ value: k, label: ORIGENES[k] }))} />
          </Field>
          <Field label="Nota">
            <input className={inputCls} value={nota} onChange={(e) => setNota(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!listo || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await crearProyeccion({
                empresaId: unidad.empresaId,
                unidadId,
                filaId,
                concepto: concepto.trim(),
                importe: sentido === 'EGRESO' ? -n! : n!,
                fechaInicio: inicio,
                recurrencia,
                diaMes: recurrencia === 'MENSUAL' ? Number(diaMes) : undefined,
                hasta: recurrente && fin === 'HASTA' ? hasta : undefined,
                cuotas: recurrente && fin === 'CUOTAS' ? Number(cuotas) : undefined,
                ajustePctMensual: recurrente ? (parseMonto(ajuste) ?? 0) : 0,
                origen,
                nota: nota.trim() || undefined,
              })
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Crear proyección
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function ModalProyecciones({ unidadId, onClose }: { unidadId: string; onClose: () => void }) {
  const { tesoreria, cancelarProyeccion } = useStore()
  const t = tesoreria!
  const [cancelar, setCancelar] = useState<Proyeccion | null>(null)
  const lista = t.proyecciones.filter((p) => p.unidadId === unidadId && p.estado === 'ACTIVA')
  const fila = (id: string) => t.filas.find((f) => f.id === id)?.etiqueta
  return (
    <Modal titulo="Proyecciones activas" onClose={onClose} ancho="max-w-3xl">
      <div className="space-y-2">
        {lista.length === 0 && <p className="text-sm text-seco italic">No hay proyecciones activas en esta pestaña.</p>}
        {lista.map((p) => (
          <div key={p.id} className="flex items-center gap-4 px-4 py-3 rounded-xl border border-borde">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap gap-2 mb-0.5">
                <Badge tone="dorado">{RECURRENCIAS[p.recurrencia]}</Badge>
                <Badge>{ORIGENES[p.origen]}</Badge>
                {p.ajustePctMensual ? <Badge tone="azul">+{String(p.ajustePctMensual).replace('.', ',')} % mensual</Badge> : null}
              </div>
              <p className="font-semibold truncate">{p.concepto}</p>
              <p className="text-xs text-seco">
                {fila(p.filaId)} · desde {fecha(p.fechaInicio)}
                {p.recurrencia === 'MENSUAL' && ` · día ${p.diaMes}`}
                {p.cuotas ? ` · ${p.cuotas} cuotas` : p.hasta ? ` · hasta ${fecha(p.hasta)}` : ''}
              </p>
            </div>
            <p className={`font-serif text-lg tabular ${p.importe < 0 ? 'text-red-300' : 'text-emerald-300'}`}>{money(p.importe)}</p>
            <button className="text-[0.75rem] text-red-300 underline" onClick={() => setCancelar(p)}>
              Cancelar
            </button>
          </div>
        ))}
      </div>
      {cancelar && (
        <ModalMotivo
          titulo="Cancelar proyección"
          texto={`${cancelar.concepto}: deja de proyectarse desde hoy. Lo ya pasado no cambia.`}
          confirmar="Cancelar proyección"
          peligro
          onConfirmar={(m) => cancelarProyeccion(cancelar.id, m)}
          onClose={() => setCancelar(null)}
        />
      )}
    </Modal>
  )
}

/**
 * El "+" de la grilla (fbAgregarDesdeGrilla del Apps Script): carga un importe de un día en una fila. En una fila MANUAL (sueldos,
 * cargas sociales, préstamos…) es lo único que se puede cargar; en las demás es una proyección puntual más (para repetirla está
 * "Nueva proyección"). Entra en el subtotal de la sección y en la caja como cualquier otra línea.
 */
function ModalCargaManual({ fila, dia, unidadId, onClose }: { fila: FilaFlujo; dia: string; unidadId: string; onClose: () => void }) {
  const { tesoreria, crearProyeccion } = useStore()
  const unidad = tesoreria!.unidades.find((u) => u.id === unidadId)!
  const ingresoPorDefecto = fila.seccion === 'INGRESOS_OPERATIVOS' || fila.seccion === 'INGRESOS_FINANCIEROS' || fila.seccion === 'TOMA_DEUDA'
  const [concepto, setConcepto] = useState('')
  const [sentido, setSentido] = useState<'EGRESO' | 'INGRESO'>(ingresoPorDefecto ? 'INGRESO' : 'EGRESO')
  const [importe, setImporte] = useState('')
  const [enviando, setEnviando] = useState(false)
  const n = parseMonto(importe)
  const listo = concepto.trim() !== '' && n !== null && n > 0
  return (
    <Modal titulo={`Cargar importe · ${fila.etiqueta} · ${diaCorto(dia)}`} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <p className="text-sm text-seco">
          {fila.manual ? 'Esta fila se carga a mano: el motor no suma nada acá. ' : ''}
          El importe se suma a lo que ya hay ese día y entra en el subtotal de la sección y en la caja. Después se puede editar, mover o eliminar desde la celda.
        </p>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="Concepto">
            <input className={inputCls} value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Ej.: Sueldos de la quincena" aria-label="Concepto" autoFocus />
          </Field>
          <Field label="Tipo">
            <Desplegable value={sentido} onChange={(v) => setSentido(v as 'EGRESO' | 'INGRESO')} opciones={[{ value: 'EGRESO', label: 'Egreso (sale plata)' }, { value: 'INGRESO', label: 'Ingreso (entra plata)' }]} />
          </Field>
          <Field label="Importe">
            <CampoMonto value={importe} onChange={setImporte} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={!listo || enviando}
            onClick={async () => {
              setEnviando(true)
              const ok = await crearProyeccion({
                empresaId: unidad.empresaId,
                unidadId,
                filaId: fila.id,
                concepto: concepto.trim(),
                importe: sentido === 'EGRESO' ? -n! : n!,
                fechaInicio: dia,
                recurrencia: 'UNICA',
                ajustePctMensual: 0,
                origen: 'MANUAL',
                nota: 'Cargado desde la grilla del Flujo',
              })
              setEnviando(false)
              if (ok) onClose()
            }}
          >
            Cargar
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

/** Fotos mensuales de la proyección: cómo se veía el mes el día que se sacó la foto, contra cómo está hoy ("Real vs Proyectado"). */
function ModalFotos({ unidadId, onClose }: { unidadId: string; onClose: () => void }) {
  const { tesoreria, usuario, sacarFotoFlujo } = useStore()
  const t = tesoreria!
  const unidad = t.unidades.find((u) => u.id === unidadId)!
  const puede = PUEDE.includes(usuario.rol)
  const fer = useMemo(() => new Set(t.feriados), [t])
  const mesActual = t.hoy.slice(0, 7)
  const delUnidad = t.fotos.filter((f) => f.unidadId === unidadId)
  const meses = [...new Set([...delUnidad.map((f) => f.mes), mesActual])].sort().reverse()
  const [mes, setMes] = useState(meses.includes(mesActual) && delUnidad.some((f) => f.mes === mesActual) ? mesActual : (meses.find((m) => delUnidad.some((f) => f.mes === m)) ?? mesActual))
  const [enviando, setEnviando] = useState(false)
  const [confirmar, setConfirmar] = useState(false)
  const fotos = delUnidad.filter((f) => f.mes === mes)
  const dias = useMemo(() => [...new Set([...diasDelMes(mes, t.lineas, unidadId, fer), ...fotos.map((f) => f.dia)])].sort(), [mes, t, unidadId, fer, fotos])
  const filas = useMemo(() => compararFoto(fotos, resumenDias(t.lineas, t.filas, unidadId, dias)), [fotos, t, unidadId, dias])
  const tomada = fotos[0]
  const suma = (f: (x: (typeof filas)[number]) => number) => Math.round(filas.reduce((a, x) => a + f(x), 0) * 100) / 100
  const rango = t.lineas.length ? t.lineas.reduce((m, l) => (l.fecha < m ? l.fecha : m), t.hoy) : t.hoy
  const fueraDelRango = mes + '-01' < rango && mes !== mesActual
  const col = (v: number | undefined, ahora = false) =>
    v === undefined ? <span className="text-seco/50">—</span> : <span className={ahora ? 'font-semibold' : ''}>{v ? num(v) : <span className="text-seco/50">–</span>}</span>
  return (
    <Modal titulo={`Fotos del mes · ${unidad.nombre}`} onClose={onClose} ancho="max-w-6xl">
      <div className="space-y-4">
        <p className="text-sm text-seco">
          La foto se saca una vez por mes (todos los días a las 10 de Argentina, solo el primero sin foto del mes) y guarda cómo se veía el mes en el Flujo. Acá se compara con cómo está hoy:
          la diferencia es lo que cambió desde la foto en la variación de caja de cada día.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Mes">
            <Desplegable value={mes} onChange={setMes} opciones={meses.map((m) => ({ value: m, label: `${m.slice(5, 7)}/${m.slice(0, 4)}${delUnidad.some((f) => f.mes === m) ? '' : ' · sin foto'}` }))} />
          </Field>
          {tomada ? (
            <p className="text-xs text-seco pb-2" data-testid="foto-datos">
              Foto sacada el {fecha(tomada.tomadaEn.slice(0, 10))} por {tomada.tomadaPor}
              {tomada.parcial ? ' · parcial' : ''}
            </p>
          ) : (
            <p className="text-xs text-naranja pb-2">Este mes no tiene foto.</p>
          )}
          {puede && mes === mesActual && (
            <div className="ml-auto flex gap-2 pb-1">
              {!tomada && (
                <Btn
                  disabled={enviando}
                  onClick={async () => {
                    setEnviando(true)
                    await sacarFotoFlujo(false)
                    setEnviando(false)
                  }}
                >
                  Sacar la foto ahora
                </Btn>
              )}
              {tomada && (
                <Btn variant="secundario" disabled={enviando} onClick={() => setConfirmar(true)}>
                  Reemplazar la foto del mes
                </Btn>
              )}
            </div>
          )}
        </div>
        {confirmar && (
          <div className="rounded-xl border border-dorado/50 bg-dorado/5 p-3 text-sm flex flex-wrap items-center gap-3">
            <span>Se reemplaza la foto de todas las unidades que ves por el Flujo de hoy. La anterior no se recupera.</span>
            <Btn
              variant="peligro"
              disabled={enviando}
              onClick={async () => {
                setEnviando(true)
                await sacarFotoFlujo(true)
                setEnviando(false)
                setConfirmar(false)
              }}
            >
              Reemplazar
            </Btn>
            <Btn variant="secundario" onClick={() => setConfirmar(false)}>
              No
            </Btn>
          </div>
        )}
        {fueraDelRango && <p className="text-xs text-naranja">Los días de este mes que quedan fuera de lo que carga la pantalla (45 días atrás) se comparan contra cero.</p>}
        <div className="overflow-x-auto max-h-[55vh]">
          <table className="text-[0.75rem] border-separate border-spacing-0 min-w-full" data-testid="tabla-fotos">
            <thead className="sticky top-0 bg-suave text-[0.625rem] uppercase tracking-[0.1em] text-seco">
              <tr>
                <th className="text-left px-2 py-2">Día</th>
                <th className="text-right px-2 py-2">Ingresos</th>
                <th className="text-right px-2 py-2">Costos</th>
                <th className="text-right px-2 py-2">Gastos</th>
                <th className="text-right px-2 py-2">Impuestos</th>
                <th className="text-right px-2 py-2">Subtotal</th>
                <th className="text-right px-2 py-2">Socios</th>
                <th className="text-right px-2 py-2">Intercompany</th>
                <th className="text-right px-2 py-2 border-l border-borde">Variación foto</th>
                <th className="text-right px-2 py-2">Variación hoy</th>
                <th className="text-right px-2 py-2">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((x) => (
                <tr key={x.dia} className={x.dia === t.hoy ? 'bg-dorado/[0.07]' : ''} data-dia={x.dia}>
                  <td className="px-2 py-1 whitespace-nowrap">{diaCorto(x.dia)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.ingresosOperativos)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.costos)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.gastosOperativos)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.impuestos)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.subtotal)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.socios)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.foto?.intercompany)}</td>
                  <td className="px-2 py-1 text-right tabular border-l border-borde font-semibold">{col(x.foto?.variacionCaja)}</td>
                  <td className="px-2 py-1 text-right tabular">{col(x.ahora.variacionCaja, true)}</td>
                  <td className={`px-2 py-1 text-right tabular font-semibold ${x.diferencia < 0 ? 'text-red-300' : x.diferencia > 0 ? 'text-emerald-300' : 'text-seco/50'}`}>{x.diferencia ? num(x.diferencia) : '–'}</td>
                </tr>
              ))}
              <tr className="font-bold border-t border-borde">
                <td className="px-2 py-2">Mes</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.ingresosOperativos ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.costos ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.gastosOperativos ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.impuestos ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.subtotal ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.socios ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.foto?.intercompany ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular border-l border-borde">{num(suma((x) => x.foto?.variacionCaja ?? 0))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.ahora.variacionCaja))}</td>
                <td className="px-2 py-2 text-right tabular">{num(suma((x) => x.diferencia))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}

/** Marcar una fila: MANUAL (el importe se carga a mano de un día, sin recurrencia) o la de personas físicas de su unidad (marcar_fila_flujo, 0038). */
function ModalConfigFila({ fila, onClose }: { fila: FilaFlujo; onClose: () => void }) {
  const { marcarFilaFlujo } = useStore()
  const [manual, setManual] = useState(!!fila.manual)
  const [pf, setPf] = useState(!!fila.personaFisica)
  const [enviando, setEnviando] = useState(false)
  return (
    <Modal titulo={`Fila · ${fila.etiqueta}`} onClose={onClose} ancho="max-w-lg">
      <div className="space-y-4">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="accent-dorado mt-1" checked={manual} onChange={(e) => setManual(e.target.checked)} />
          <span>
            <span className="font-semibold">Fila manual</span>
            <span className="block text-seco text-xs">Sueldos, cargas sociales, préstamos, intereses… Ahí solo se carga el importe de un día, sin recurrencia, y no suman las proyecciones que no sean cargas manuales.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="accent-dorado mt-1" checked={pf} disabled={fila.tipo !== 'CUENTA'} onChange={(e) => setPf(e.target.checked)} />
          <span>
            <span className="font-semibold">Fila de las personas físicas</span>
            <span className="block text-seco text-xs">
              Los prestadores que son personas (no S.A., S.R.L., SAS…) pagados desde una cuenta de esta unidad, sin otra regla y sin cuenta clara, caen acá (en Dax Salud, Consultorios). Hay una sola por unidad: marcar esta le saca la marca a la otra.
              {fila.tipo !== 'CUENTA' ? ' Una apertura no puede serlo.' : ''}
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Btn variant="secundario" onClick={onClose}>
            Cancelar
          </Btn>
          <Btn
            disabled={enviando || (manual === !!fila.manual && pf === !!fila.personaFisica)}
            onClick={async () => {
              setEnviando(true)
              const ok = await marcarFilaFlujo(fila.id, manual, pf)
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
