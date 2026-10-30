import { useRef, useState } from 'react'
import { useStore } from '../store'
import { CATEGORIAS } from '../data/demo'
import { Badge, BadgeVencimiento, Btn, Card, Empty, Field, inputCls, SelectorCuenta, Tabs } from '../components/ui'
import { cuentasFactura, enLista } from '../lib/cuentas'
import { useFiltro } from '../components/Filtros'
import { FormFactura } from '../components/FormFactura'
import { fecha, fechaHora, fmtCuit, money, nroComprobante } from '../lib/format'
import { puede } from '../lib/permisos'
import type { Documento, Factura, MetodoPago } from '../types'

const METODOS: { id: MetodoPago; label: string }[] = [
  { id: 'TRANSFERENCIA', label: 'Transferencia' },
  { id: 'CHEQUE', label: 'Cheque' },
  { id: 'ECHEQ', label: 'E-cheq' },
  { id: 'DEBITO', label: 'Débito automático' },
  { id: 'TARJETA', label: 'Tarjeta' },
  { id: 'CAJA', label: 'Caja' },
]

/** Documentos que entraron y no terminaron en una factura nueva: en lectura, con error o duplicados. */
const enEntrada = (d: Documento) => d.estado === 'PENDIENTE' || d.estado === 'LEYENDO' || d.estado === 'ERROR' || d.estado === 'DUPLICADO'

export function Aprobacion() {
  const { modo, facturas, documentos, usuario, toast, subirFactura, leerAhora, proveedor, empresa } = useStore()
  const [tab, setTab] = useState<'PENDIENTES' | 'ERRORES' | 'ENTRADA' | 'HISTORIAL'>('PENDIENTES')
  const [subiendo, setSubiendo] = useState(false)
  const inputArchivo = useRef<HTMLInputElement>(null)
  const pendientes = facturas.filter((f) => f.estado === 'PENDIENTE_APROBACION')
  const errores = facturas.filter((f) => f.estado === 'ERROR')
  const historial = facturas.filter((f) => f.aprobadoEn || f.estado === 'RECHAZADA').sort((a, b) => (b.aprobadoEn ?? '').localeCompare(a.aprobadoEn ?? ''))
  const entrada = documentos.filter(enEntrada)
  const enCola = entrada.filter((d) => d.estado === 'PENDIENTE' || d.estado === 'LEYENDO').length
  const puedeSubir = puede(usuario.rol, 'APROBAR') || puede(usuario.rol, 'PAGAR')

  const lista = tab === 'PENDIENTES' ? pendientes : tab === 'ERRORES' ? errores : historial
  const filtro = useFiltro(lista, {
    clave: 'aprobacion',
    texto: (f) => {
      const p = proveedor(f.proveedorId)
      return [p?.nombre, p?.cuit, f.tipo, nroComprobante(f.puntoVenta, f.numero), f.cae, f.cuentaContable, empresa(f.empresaId).nombre, f.total.toFixed(2)].join(' ')
    },
    empresa: (f) => f.empresaId,
    proveedor: (f) => proveedor(f.proveedorId)?.nombre ?? '',
    cuenta: (f) => f.cuentaContable,
    alta: (f) => f.creadoEn ?? f.fecha,
    vencimiento: (f) => f.vencimiento,
    importe: (f) => f.total,
  })

  async function elegir(archivo: File) {
    if (archivo.size > 4 * 1024 * 1024) return toast('El archivo pesa más de 4 MB. Mandá un PDF más liviano o una foto.', 'error')
    setSubiendo(true)
    await subirFactura(archivo)
    setSubiendo(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-3xl">Bandeja de aprobación</h2>
          <p className="text-sm text-seco">
            Las facturas llegan solas desde el mail de proveedores o se suben a mano. La IA las lee y valida CAE y totales. Acá se decide cuenta contable y método de pago.
          </p>
        </div>
        {puedeSubir && (
          <div className="flex gap-2 shrink-0">
            <input
              ref={inputArchivo}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={(e) => {
                const a = e.target.files?.[0]
                e.target.value = ''
                if (a) void elegir(a)
              }}
            />
            <Btn variant="secundario" disabled={subiendo} onClick={() => inputArchivo.current?.click()}>
              {subiendo ? '✦ La IA está leyendo…' : 'Subir factura'}
            </Btn>
          </div>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'PENDIENTES', label: 'Pendientes', n: pendientes.length },
          { id: 'ERRORES', label: 'Excepciones', n: errores.length },
          { id: 'ENTRADA', label: 'Entrada', n: entrada.length },
          { id: 'HISTORIAL', label: 'Historial', n: historial.length },
        ]}
      />

      {tab === 'ENTRADA' ? (
        <div className="space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
            <p className="text-sm text-seco">
              Archivos que llegaron y no se convirtieron en una factura nueva: en lectura, con error o repetidos. Nada se pierde: se vuelve a leer o se descarta con motivo.
            </p>
            {modo === 'conectado' && enCola > 0 && (
              <Btn variant="secundario" onClick={() => void leerAhora()}>
                Leer ahora ({enCola})
              </Btn>
            )}
          </div>
          {entrada.length === 0 && <Empty texto="Todo lo que llegó ya está en Pendientes o Excepciones." />}
          {entrada.map((d) => (
            <TarjetaDocumento key={d.id} d={d} />
          ))}
        </div>
      ) : (
        <>
          {lista.length > 0 && filtro.barra}
          {lista.length === 0 && <Empty texto="Nada pendiente en esta bandeja." />}
          {lista.length > 0 && filtro.visibles.length === 0 && <Empty texto="Nada coincide con la búsqueda o los filtros." />}
          <div className="space-y-4">
            {filtro.visibles.map((f) => (
              <TarjetaFactura key={f.id} f={f} modo={tab} nueva={filtro.esNueva(f)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const ESTADO_DOC: Record<Documento['estado'], { label: string; tone: 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja' }> = {
  PENDIENTE: { label: 'Esperando lectura', tone: 'azul' },
  LEYENDO: { label: 'La IA está leyendo', tone: 'dorado' },
  LEIDO: { label: 'Leída', tone: 'verde' },
  DUPLICADO: { label: 'Ya estaba cargada', tone: 'naranja' },
  ERROR: { label: 'No se pudo leer', tone: 'rojo' },
  DESCARTADO: { label: 'Descartado', tone: 'neutro' },
}

function TarjetaDocumento({ d }: { d: Documento }) {
  const { usuario, abrirArchivo, reintentarDocumento, descartarDocumento } = useStore()
  const puedeActuar = puede(usuario.rol, 'APROBAR')
  const [descartando, setDescartando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const est = ESTADO_DOC[d.estado]
  const quien = d.remitente ? `${d.remitente} · ` : d.cargadoPor ? `Subida por ${d.cargadoPor} · ` : ''
  const asunto = d.asunto ? `"${d.asunto}" · ` : ''

  return (
    <Card className="space-y-3">
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <Badge tone={est.tone}>{est.label}</Badge>
            <Badge>{d.origen}</Badge>
            {d.intentos > 1 && <Badge>{d.intentos} intentos</Badge>}
          </div>
          <button
            onClick={() => void abrirArchivo('facturas', d.storagePath)}
            className="font-semibold text-crema underline decoration-borde hover:decoration-dorado truncate block max-w-full text-left"
          >
            {d.nombre}
          </button>
          <p className="text-xs text-seco truncate">
            {quien}
            {asunto}
            {fechaHora(d.recibidoEn)}
          </p>
        </div>
        {puedeActuar && !descartando && (d.estado === 'ERROR' || d.estado === 'DUPLICADO') && (
          <div className="flex gap-2 shrink-0">
            <Btn variant="fantasma" onClick={() => setDescartando(true)}>
              Descartar
            </Btn>
            <Btn variant="secundario" onClick={() => void reintentarDocumento(d.id)}>
              Volver a leer
            </Btn>
          </div>
        )}
      </div>
      {d.error && (
        <p className={`text-xs p-2 rounded-lg border ${d.estado === 'DUPLICADO' ? 'border-borde text-seco' : 'bg-red-950/40 border-red-900 text-red-200'}`}>{d.error}</p>
      )}
      {descartando && (
        <div className="flex flex-col md:flex-row gap-2 md:items-end">
          <div className="flex-1">
            <Field label="Motivo" hint="Queda en la auditoría con tu nombre">
              <input autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: es un presupuesto, es una factura de otra empresa…" className={inputCls} />
            </Field>
          </div>
          <Btn variant="fantasma" onClick={() => setDescartando(false)}>
            Cancelar
          </Btn>
          <Btn variant="peligro" disabled={!motivo.trim()} onClick={() => void descartarDocumento(d.id, motivo.trim())}>
            Confirmar descarte
          </Btn>
        </div>
      )}
    </Card>
  )
}

function TarjetaFactura({ f, modo, nueva }: { f: Factura; modo: 'PENDIENTES' | 'ERRORES' | 'HISTORIAL'; nueva?: boolean }) {
  const { modo: modoApp, proveedor, empresa, catalogos, usuario, aprobarFactura, rechazarFactura, abrirArchivo } = useStore()
  const opcionesCuenta = cuentasFactura(catalogos, f.empresaId)
  const p = proveedor(f.proveedorId) ?? { nombre: f.proveedorId, cuit: '', cuentaHabitual: undefined }
  const e = empresa(f.empresaId)
  const puedeAprobar = puede(usuario.rol, 'APROBAR')
  const [abierta, setAbierta] = useState(false)
  const [cuenta, setCuenta] = useState(f.cuentaContable ?? p.cuentaHabitual ?? '')
  const [metodo, setMetodo] = useState<MetodoPago>(f.metodoPago ?? 'TRANSFERENCIA')
  const [dias, setDias] = useState(30)
  const [rechazando, setRechazando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [editando, setEditando] = useState(false)
  const editable = puedeAprobar && modo !== 'HISTORIAL' && f.pagado === 0 && f.estadoXubio !== 'SUBIDA'
  const esCheque = metodo === 'CHEQUE' || metodo === 'ECHEQ'
  const cuentaValida = enLista(opcionesCuenta, cuenta)

  const panelRechazo = (
    <div className="space-y-2">
      <Field label="Motivo del rechazo" hint="Queda en la auditoría con tu nombre">
        <input autoFocus value={motivo} onChange={(ev) => setMotivo(ev.target.value)} placeholder="Ej.: factura duplicada, importe mal facturado…" className={inputCls} />
      </Field>
      <div className="flex justify-end gap-2">
        <Btn variant="fantasma" onClick={() => setRechazando(false)}>
          Cancelar
        </Btn>
        <Btn variant="peligro" disabled={!motivo.trim()} onClick={() => rechazarFactura(f.id, motivo.trim())}>
          Confirmar rechazo
        </Btn>
      </div>
    </div>
  )

  return (
    <Card className="p-0 overflow-hidden">
      <button onClick={() => setAbierta((a) => !a)} className="w-full text-left px-5 py-4 flex flex-col md:flex-row md:items-center gap-3 hover:bg-pino/70 transition-colors">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {nueva && <Badge tone="azul">Nueva</Badge>}
            <Badge tone="dorado">{e.corto}</Badge>
            <Badge>{f.origen}</Badge>
            <Badge>{CATEGORIAS[f.categoriaVertice] ?? f.categoriaVertice}</Badge>
            {f.tipo === 'Factura M' && <Badge tone="naranja">Factura M: revisar retención</Badge>}
            {!f.validacionOk && <Badge tone="rojo">Validación con error</Badge>}
            {f.validacionOk && modo !== 'HISTORIAL' && <Badge tone="verde">CAE y totales OK</Badge>}
            {f.estado === 'RECHAZADA' && <Badge tone="rojo">Rechazada</Badge>}
            {f.aprobadoEn && f.estado !== 'RECHAZADA' && <Badge tone="verde">Aprobada</Badge>}
          </div>
          <p className="font-semibold text-crema truncate">{p.nombre}</p>
          <p className="text-xs text-seco">
            CUIT {fmtCuit(p.cuit)} · {f.tipo} {nroComprobante(f.puntoVenta, f.numero)} · emitida {fecha(f.fecha)}
          </p>
        </div>
        <div className="text-right">
          <p className="font-serif text-2xl text-crema">{money(f.total)}</p>
          <BadgeVencimiento vencimiento={f.vencimiento} />
        </div>
      </button>

      {abierta && editando && (
        <div className="px-5 pb-5 border-t border-borde pt-4 grid md:grid-cols-2 gap-5">
          <FormFactura f={f} onCerrar={() => setEditando(false)} />
        </div>
      )}

      {abierta && !editando && (
        <div className="px-5 pb-5 border-t border-borde pt-4 grid md:grid-cols-2 gap-5 fade-up">
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <h4 className="text-[10px] uppercase tracking-widest text-seco">Lo que leyó la IA</h4>
              {editable && (
                <button onClick={() => setEditando(true)} className="text-xs text-dorado hover:text-crema underline">
                  Editar datos
                </button>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-y-1 text-xs">
              <dt className="text-seco">Neto</dt>
              <dd>{money(f.neto)}</dd>
              <dt className="text-seco">IVA</dt>
              <dd>{money(f.iva)}</dd>
              <dt className="text-seco">Percepciones</dt>
              <dd>{money(f.percepciones)}</dd>
              <dt className="text-seco">Total</dt>
              <dd className="font-semibold">{money(f.total)}</dd>
              <dt className="text-seco">CAE</dt>
              <dd className="font-mono">{f.cae}</dd>
              <dt className="text-seco">CAE vence</dt>
              <dd>{fecha(f.caeVencimiento)}</dd>
              <dt className="text-seco">Vencimiento</dt>
              <dd>{fecha(f.vencimiento)}</dd>
              <dt className="text-seco">PDF</dt>
              <dd>
                {f.pdfPath ? (
                  <button onClick={() => void abrirArchivo('facturas', f.pdfPath!)} className="text-dorado underline">
                    Abrir PDF
                  </button>
                ) : f.driveUrl ? (
                  <a href={f.driveUrl} target="_blank" rel="noreferrer" className="text-dorado underline">
                    Abrir en Drive
                  </a>
                ) : (
                  <span className="text-seco">{modoApp === 'demo' ? `Drive › ${e.corto} › ${p.nombre.split(' ')[0]}` : 'Sin link a Drive'}</span>
                )}
              </dd>
            </dl>
            {f.advertencia && (
              <div className="mt-3 p-3 rounded-lg bg-amber-950/40 border border-amber-900 text-amber-200 text-xs">
                <strong>Aviso:</strong> {f.advertencia}
              </div>
            )}
            {f.motivoValidacion && (
              <div className="mt-3 p-3 rounded-lg bg-red-950/40 border border-red-900 text-red-200 text-xs">
                <strong>Motivo:</strong> {f.motivoValidacion}
              </div>
            )}
            {f.aprobadoEn && (
              <p className="text-xs text-seco mt-2">
                Aprobada por <span className="text-crema">{f.aprobadoPor}</span> el {new Date(f.aprobadoEn).toLocaleString('es-AR')}
              </p>
            )}
          </div>

          {modo !== 'HISTORIAL' && !puedeAprobar && <p className="text-xs text-seco self-end">Solo consulta: aprueba el responsable de aprobaciones o Administración.</p>}

          {modo === 'PENDIENTES' && puedeAprobar && rechazando && panelRechazo}

          {modo === 'PENDIENTES' && puedeAprobar && !rechazando && (
            <div className="space-y-3">
              <Field
                label="Cuenta contable (plan de Xubio)"
                hint={`Regla de oro: siempre la cuenta del plan, nunca una categoría genérica.${f.categoriaIa ? ` La IA lo clasificó como "${f.categoriaIa}".` : ''}${f.cuentaContable && modo === 'PENDIENTES' ? ' La cuenta viene de lo que se eligió la última vez para este proveedor.' : ''}`}
                marcado={cuenta ? undefined : 'falta'}
              >
                <SelectorCuenta value={cuenta} onChange={setCuenta} opciones={opcionesCuenta} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Método de pago">
                  <select value={metodo} onChange={(ev) => setMetodo(ev.target.value as MetodoPago)} className={inputCls}>
                    {METODOS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {esCheque && (
                  <Field label="Días del cheque">
                    <input type="number" value={dias} onChange={(ev) => setDias(Number(ev.target.value))} className={inputCls} />
                  </Field>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Btn variant="peligro" onClick={() => setRechazando(true)}>
                  Rechazar
                </Btn>
                <Btn disabled={!cuentaValida} onClick={() => aprobarFactura(f.id, { cuentaContable: cuentaValida!, metodoPago: metodo, diasCheque: esCheque ? dias : undefined })}>
                  {e.erp !== 'XUBIO' ? 'Aprobar (carga manual en Ralpharma)' : modoApp === 'demo' ? 'Aprobar y enviar a Xubio' : 'Aprobar'}
                </Btn>
              </div>
            </div>
          )}

          {modo === 'ERRORES' && puedeAprobar && rechazando && panelRechazo}

          {modo === 'ERRORES' && puedeAprobar && !rechazando && (
            <div className="space-y-3">
              <p className="text-sm text-seco">
                Esta factura no pasó la validación automática. Hoy esto llega como un mail de alerta; acá queda en una bandeja de excepciones con responsable.
              </p>
              <div className="flex justify-end gap-2">
                <Btn variant="peligro" onClick={() => setRechazando(true)}>
                  Descartar
                </Btn>
                <Btn variant="secundario" onClick={() => setEditando(true)}>
                  Corregir datos
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
