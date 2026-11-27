import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { Badge, Btn, Card, Desplegable, Empty, Field, inputCls, Kpi, SelectorCuenta, TablaDatos, Tabs } from '../components/ui'
import { cuentasOrigenDe, cuentasPara, enLista, sugerirCuentaOrigen } from '../lib/cuentas'
import { useFiltro } from '../components/Filtros'
import { fecha, fechaHora, fmtCuit, money, moneyShort, nroComprobante } from '../lib/format'
import { puede } from '../lib/permisos'
import type { FormaCargaXubio, Pago } from '../types'

const FORMAS: { id: FormaCargaXubio; label: string; desc: string }[] = [
  { id: 'ORDEN_PAGO', label: 'Orden de pago', desc: 'Con factura asociada: cancela la deuda del proveedor' },
  { id: 'SALIDA_FONDOS', label: 'Salida de fondos', desc: 'Sin factura: gastos bancarios, anticipos' },
  { id: 'ASIENTO_MANUAL', label: 'Asiento manual', desc: 'Impuestos, sueldos y casos especiales' },
]

export function Contabilizacion() {
  const { pagos, empresa, proveedor, usuario, catalogosXubio } = useStore()
  const [trayendo, setTrayendo] = useState(false)
  const [tab, setTab] = useState<'PENDIENTES' | 'HECHOS'>('PENDIENTES')
  const pendientes = pagos.filter((p) => p.estado === 'CARGADO' || p.estado === 'REVISADO').sort((a, b) => b.cargadoEn.localeCompare(a.cargadoEn))
  const ralpharma = pagos.filter((p) => p.estado === 'PENDIENTE_RALPHARMA')
  const hechos = pagos.filter((p) => p.estado === 'CONTABILIZADO' || p.estado === 'CONCILIADO').sort((a, b) => (b.contabilizadoEn ?? '').localeCompare(a.contabilizadoEn ?? ''))
  const sinCuenta = pendientes.filter((p) => !p.cuentaContable).length
  const lista = tab === 'PENDIENTES' ? pendientes : hechos
  const filtro = useFiltro(lista, {
    clave: 'contabilizacion',
    texto: (p) =>
      [proveedor(p.proveedorId)?.nombre, proveedor(p.proveedorId)?.cuit, p.proveedorDestino, p.descripcion, p.observaciones, p.numeroCheque, p.cuentaOrigen, p.bancoOrigen,
        p.cuentaContable, p.medio, empresa(p.empresaId).nombre, p.importe.toFixed(2), p.numeroOp, p.xubioId].join(' '),
    empresa: (p) => p.empresaId,
    proveedor: (p) => proveedor(p.proveedorId)?.nombre ?? p.proveedorDestino ?? '',
    cuenta: (p) => p.cuentaContable,
    alta: (p) => p.cargadoEn,
    vencimiento: (p) => p.fecha,
    etiquetaFecha: 'Fecha del pago',
    importe: (p) => p.importe,
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Contabilización</h2>
          <p className="text-sm text-seco">
            La bandeja de Guido. Cada pago llega con el comentario de Vivi, la cuenta sugerida y la forma de carga en Xubio. Un clic lo registra. Nada pasa a "contabilizado" sin un id de Xubio o un responsable en Ralpharma.
          </p>
        </div>
        {puede(usuario.rol, 'CONTABILIZAR') && (
          <Btn
            variant="secundario"
            disabled={trayendo}
            title="Lee de Xubio el plan de cuentas y las cuentas de origen (bancos, cajas, e-cheqs) de cada empresa. Solo lectura."
            onClick={async () => {
              setTrayendo(true)
              await catalogosXubio()
              setTrayendo(false)
            }}
          >
            {trayendo ? 'Leyendo Xubio…' : 'Actualizar cuentas desde Xubio'}
          </Btn>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Para contabilizar" value={String(pendientes.length)} sub={moneyShort(pendientes.reduce((a, p) => a + p.importe, 0))} tone="dorado" />
        <Kpi label="Sin cuenta definida" value={String(sinCuenta)} sub="requieren decisión" tone={sinCuenta ? 'rojo' : 'verde'} />
        <Kpi label="Pendientes Ralpharma" value={String(ralpharma.length)} sub="en el sector Ralpharma" tone="crema" />
        <Kpi label="Contabilizados" value={String(hechos.length)} sub={`${hechos.filter((p) => p.xubioId?.startsWith('OP')).length} con orden de pago`} tone="verde" />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'PENDIENTES', label: 'Para contabilizar', n: pendientes.length },
          { id: 'HECHOS', label: 'Contabilizados', n: hechos.length },
        ]}
      />

      {lista.length > 0 && filtro.barra}
      {lista.length === 0 && <Empty texto="Bandeja vacía." />}
      {lista.length > 0 && filtro.visibles.length === 0 && <Empty texto="Nada coincide con la búsqueda o los filtros." />}
      <div className="space-y-4">
        {filtro.visibles.map((p) => (
          <TarjetaPago key={p.id} p={p} empresaNombre={empresa(p.empresaId).corto} erp={empresa(p.empresaId).erp} nueva={filtro.esNueva(p)} />
        ))}
      </div>
    </div>
  )
}

function TarjetaPago({ p, empresaNombre, erp, nueva }: { p: Pago; empresaNombre: string; erp: string; nueva?: boolean }) {
  const { facturas, proveedor, catalogos, usuario, contabilizarPago, marcarRalpharma, abrirArchivo, anularPago, liberarPagoXubio, guardarNumeroOp } = useStore()
  // Envío a Xubio sin confirmar: se reservó para enviar y nunca quedó contabilizado. No se sabe si Xubio lo creó.
  const trabado = !!p.envioXubioEn && (p.estado === 'CARGADO' || p.estado === 'REVISADO')
  // Hasta que pase el plazo que define la base, el envío puede estar todavía saliendo: no se ofrece resolverlo
  // (la base tampoco lo acepta). Sin el dato del plazo, tampoco.
  const plazoSeg = catalogos.plazoEnvioXubioSeg
  const resolubleDesde = trabado && plazoSeg ? new Date(p.envioXubioEn!).getTime() + plazoSeg * 1000 : null
  const [ahora, setAhora] = useState(() => Date.now())
  useEffect(() => {
    if (resolubleDesde == null || ahora >= resolubleDesde) return
    const t = setTimeout(() => setAhora(Date.now()), Math.min(resolubleDesde - ahora + 500, 30_000))
    return () => clearTimeout(t)
  }, [resolubleDesde, ahora])
  const envioEnCurso = trabado && (resolubleDesde == null || ahora < resolubleDesde)
  const [nroXubio, setNroXubio] = useState('')
  const [nroOp, setNroOp] = useState('')
  const [guardandoOp, setGuardandoOp] = useState(false)
  const [confirmandoLiberar, setConfirmandoLiberar] = useState(false)
  const puedeAnular = puede(usuario.rol, 'ANULAR_PAGO') && p.gestion !== 'HOJA' && !trabado && ['CARGADO', 'REVISADO', 'PENDIENTE_RALPHARMA'].includes(p.estado)
  const [anulando, setAnulando] = useState(false)
  const [motivoAnular, setMotivoAnular] = useState('')
  const puedeContabilizar = puede(usuario.rol, 'CONTABILIZAR')
  const planEmpresa = cuentasPara(catalogos, p.empresaId)
  const origenes = cuentasOrigenDe(catalogos.cuentasOrigen, p.empresaId)
  // Cuenta de origen: la que ya tiene el pago; si no, deducida del banco del comprobante (como producción).
  const sugeridaOrigen = p.cuentaOrigen ? null : sugerirCuentaOrigen(origenes, p.bancoOrigen, { esCheque: !!p.numeroCheque, numeroCuenta: p.numeroCuenta })
  const [cuenta, setCuenta] = useState(p.cuentaContable ?? '')
  const [origen, setOrigen] = useState(p.cuentaOrigen || sugeridaOrigen?.cuenta || '')
  const [forma, setForma] = useState<FormaCargaXubio>(p.formaCargaXubio)
  const [enviando, setEnviando] = useState(false)
  const facts = facturas.filter((f) => p.facturaIds.includes(f.id))
  const prov = proveedor(p.proveedorId)
  const hecho = p.estado === 'CONTABILIZADO' || p.estado === 'CONCILIADO'
  const cuentaValida = enLista(planEmpresa, cuenta)
  const sinLeer = p.estadoExtraccion === 'REVISION_MANUAL' || /^ERROR/.test(p.estadoExtraccion ?? '')
  const echeq = !!p.numeroCheque && (origenes.find((c) => c.nombre === origen)?.tipoCuenta === 4 || /cheq|chec/i.test(origen))
  const falta = p.importe <= 0 ? 'Falta el importe del pago' : !origen ? 'Falta la cuenta de origen' : !cuentaValida ? 'Falta la cuenta contable' : ''

  async function contabilizar() {
    setEnviando(true)
    await contabilizarPago(p.id, { cuentaContable: cuentaValida ?? cuenta, formaCargaXubio: forma, cuentaOrigen: origen })
    setEnviando(false)
  }

  const comprobante = p.comprobanteUrl ? (
    <a href={p.comprobanteUrl} target="_blank" rel="noreferrer" className="text-acento font-bold hover:underline">
      Abrir en Drive
    </a>
  ) : p.comprobante ? (
    <button onClick={() => void abrirArchivo('comprobantes', p.comprobante)} className="text-acento font-bold hover:underline">
      {p.comprobante.split('/').pop()}
    </button>
  ) : undefined

  return (
    <Card className="p-0 overflow-hidden">
      {/* Encabezado: quién, cuánto y en qué estado */}
      <div className="px-6 py-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {nueva && <Badge tone="azul">Nuevo</Badge>}
            <Badge tone="dorado">{empresaNombre}</Badge>
            <Badge>{p.medio}</Badge>
            <Badge tone={facts.length ? 'azul' : 'naranja'}>{facts.length ? `${facts.length} factura(s)` : 'Sin factura'}</Badge>
            {p.gestion === 'HOJA' && <Badge title="Copiado del dashboard de producción. Una prueba en seco no lo cambia de dueño; si lo contabilizás acá en real, la copia ya no lo pisa.">De la hoja</Badge>}
            {hecho && <Badge tone="verde">{p.xubioId === 'RALPHARMA' ? 'Cargado en Ralpharma' : `Xubio ${p.xubioId}`}</Badge>}
            {p.estado === 'REVISADO' && <Badge tone="verde">Revisado en seco</Badge>}
            {p.mailProveedorEnviado && <Badge tone="azul">Mail al proveedor</Badge>}
          </div>
          <p className="text-lg font-bold text-crema leading-tight">{prov?.nombre ?? p.proveedorDestino ?? p.descripcion}</p>
          <p className="text-sm text-seco">
            {fecha(p.fecha)}
            {p.descripcion && (prov?.nombre || p.proveedorDestino) ? ` · ${p.descripcion}` : ''}
          </p>
        </div>
        <div className="md:text-right shrink-0">
          <p className="font-serif text-[2.2rem] leading-none text-crema">{money(p.importe)}</p>
          <p className="text-[0.6875rem] text-seco mt-1.5">Cargado por {p.cargadoPor} · {fechaHora(p.cargadoEn)}</p>
        </div>
      </div>

      {/* Cuerpo: detalle a la izquierda, decisión a la derecha */}
      <div className="border-t border-borde p-6 grid lg:grid-cols-2 gap-6">
        <div className="space-y-3 min-w-0">
          <TablaDatos
            titulo="Detalle del pago"
            filas={[
              ['Pagado a', prov?.nombre ?? p.proveedorDestino],
              ['CUIT', prov?.cuit ? fmtCuit(prov.cuit) : undefined],
              ['Fecha', fecha(p.fecha)],
              ['Medio', p.medio],
              ['Desde', p.cuentaOrigen || p.bancoOrigen || 'Sin definir'],
              ['N° de cuenta', p.numeroCuenta],
              ['Banco destino', p.bancoDestino],
              ['Cheque', p.numeroCheque ? `N° ${p.numeroCheque}${p.tipoCheque ? ' · ' + p.tipoCheque : ''} · acredita ${fecha(p.fechaAcreditacion)}` : undefined],
              ['Comprobante', comprobante],
              ...facts.map((f): [string, ReactNode] => [
                `${f.tipo} ${nroComprobante(f.puntoVenta, f.numero)}`,
                <span key={f.id}>
                  {money(f.total)}
                  {f.pagadoPct < 100 && <span className="text-amber-300"> · {f.pagadoPct}% pagado</span>}
                </span>,
              ]),
              ['Contabilizado', p.contabilizadoEn ? `${p.contabilizadoPor} · ${fechaHora(p.contabilizadoEn)}` : undefined],
            ]}
          />
          {sinLeer && (
            <div className="rounded-xl bg-amber-950/40 border border-amber-900 text-amber-200 text-[0.8125rem] p-3">
              La IA no pudo leer el comprobante ({p.estadoExtraccion}). Revisá importe, banco y fecha mirándolo antes de contabilizar.
            </div>
          )}
          {p.avisoImporte && <div className="rounded-xl bg-amber-950/40 border border-amber-900 text-amber-200 text-[0.8125rem] p-3">{p.avisoImporte}</div>}
          {p.posibleDuplicado && (
            <div className="rounded-xl bg-amber-950/40 border border-amber-900 text-amber-200 text-[0.8125rem] p-3">
              Posible pago duplicado: se parece a {p.posibleDuplicado}. Revisalo antes de contabilizar; si es otro pago, seguí normal.
            </div>
          )}
          {p.avisoCheque && <div className="rounded-xl bg-suave border border-borde text-seco text-[0.8125rem] p-3">{p.avisoCheque}</div>}
          {p.observaciones && (
            <div className="rounded-xl bg-suave border border-borde p-4">
              <p className="text-[0.625rem] uppercase tracking-[0.16em] font-bold text-seco mb-1">Comentario de {p.cargadoPor}</p>
              <p className="italic text-crema">"{p.observaciones}"</p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-borde bg-suave/40 p-5 space-y-4 self-start w-full">
          <p className="text-[0.625rem] uppercase tracking-[0.16em] font-bold text-seco">{hecho ? 'Cómo quedó' : erp === 'XUBIO' ? 'Contabilizar en Xubio' : 'Carga en Ralpharma'}</p>
          {!hecho && !puedeContabilizar && <p className="text-sm text-seco">Lo contabiliza Administración.</p>}
          {envioEnCurso && (
            <div className="rounded-lg border border-borde bg-suave p-3">
              <p className="text-[0.8125rem] text-seco leading-snug">
                <b className="text-crema">Envío a Xubio en curso</b> (salió {fechaHora(p.envioXubioEn!)}). Mientras tanto no se puede volver a enviar ni anular.{' '}
                {resolubleDesde != null
                  ? `Si a las ${new Date(resolubleDesde).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} sigue sin quedar contabilizado, actualizá la pantalla: acá va a aparecer cómo resolverlo.`
                  : 'Actualizá la pantalla en unos minutos para ver cómo quedó.'}
              </p>
            </div>
          )}
          {trabado && !envioEnCurso && (
            <div className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 space-y-3">
              <p className="text-[0.8125rem] text-amber-200 leading-snug">
                <b>Envío a Xubio sin confirmar</b> ({fechaHora(p.envioXubioEn!)}). No se sabe si Xubio creó el comprobante, así que no se puede volver a enviar ni anular
                hasta resolverlo. {puedeContabilizar ? `Buscalo en Xubio de ${empresaNombre} y elegí qué pasó.` : 'Lo resuelve Administración.'}
              </p>
              {puedeContabilizar && (
                <>
                  <Field label="Número del comprobante en Xubio" hint="Solo si lo encontraste en Xubio. Queda contabilizado con la cuenta contable y la forma elegidas abajo, sin enviar nada.">
                    <input id={`xubio-${p.id}`} value={nroXubio} onChange={(ev) => setNroXubio(ev.target.value)} placeholder="Ej.: OP-1234" className={inputCls} />
                  </Field>
                  {confirmandoLiberar && (
                    <div className="rounded-lg border border-red-500/40 p-3 space-y-2">
                      <p className="text-[0.8125rem] text-red-200 leading-snug">
                        ¿Seguro que no está en Xubio de {empresaNombre}? Al liberar, el pago se puede volver a enviar: si el comprobante sí existe, quedaría cargado dos veces.
                      </p>
                      <div className="flex justify-end gap-2">
                        <Btn variant="fantasma" onClick={() => setConfirmandoLiberar(false)}>
                          Cancelar
                        </Btn>
                        <Btn variant="peligro" onClick={() => void liberarPagoXubio(p.id, '', {}).then(() => setConfirmandoLiberar(false))}>
                          Lo busqué y no está: liberar
                        </Btn>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Btn variant="secundario" disabled={!!nroXubio.trim() || confirmandoLiberar} onClick={() => setConfirmandoLiberar(true)} title={nroXubio.trim() ? 'Borrá el número para liberar' : undefined}>
                      No está en Xubio: liberar
                    </Btn>
                    <Btn
                      disabled={!nroXubio.trim() || !cuentaValida}
                      title={!nroXubio.trim() ? 'Falta el número de Xubio' : !cuentaValida ? 'Falta la cuenta contable' : undefined}
                      onClick={() => void liberarPagoXubio(p.id, nroXubio, { cuentaContable: cuentaValida ?? cuenta, formaCargaXubio: forma })}
                    >
                      Ya está en Xubio
                    </Btn>
                  </div>
                </>
              )}
            </div>
          )}
          {!hecho && puedeContabilizar && erp === 'XUBIO' && (
            <>
              <Field
                label="Cuenta de origen (de dónde salió la plata)"
                marcado={!origen ? 'falta' : sugeridaOrigen && origen === sugeridaOrigen.cuenta ? 'ia' : undefined}
                hint={sugeridaOrigen && origen === sugeridaOrigen.cuenta ? sugeridaOrigen.nota : origenes.length ? undefined : 'No hay cuentas de origen de esta empresa: falta copiar Xubio_Cuentas_Origen'}
              >
                <Desplegable
                  value={origen}
                  onChange={setOrigen}
                  opciones={[
                    ...(p.cuentaOrigen && !origenes.some((c) => c.nombre === p.cuentaOrigen) ? [{ value: p.cuentaOrigen, label: p.cuentaOrigen, detalle: 'La que vino en la hoja' }] : []),
                    ...origenes.map((c) => ({ value: c.nombre, label: c.nombre, detalle: sugeridaOrigen?.cuenta === c.nombre ? 'Sugerida' : undefined })),
                  ]}
                />
              </Field>
              {echeq && <p className="text-[0.75rem] text-amber-300 leading-snug">E-cheq: Xubio no deja crear esta orden de pago por API. En seco se verifica igual; en real hay que cargarla a mano.</p>}
              <Field
                label="Cuenta contable"
                marcado={!cuenta ? 'falta' : p.sugerenciaOrigen && !p.cuentaContable ? 'ia' : undefined}
                hint={p.sugerenciaOrigen ? `${p.sugerenciaOrigen === 'REGLA' ? 'Regla aprendida' : p.sugerenciaOrigen === 'IA' ? 'Sugerida por IA' : 'Elegida por Vivi'} · ${Math.round((p.sugerenciaConfianza ?? 0) * 100)}%` : 'Sin sugerencia: definila vos'}
              >
                <SelectorCuenta value={cuenta} onChange={setCuenta} opciones={planEmpresa} />
              </Field>
              <Field label="Forma de carga en Xubio" hint={FORMAS.find((f) => f.id === forma)?.desc}>
                <Desplegable value={forma} onChange={(v) => setForma(v as FormaCargaXubio)} opciones={FORMAS.map((f) => ({ value: f.id, label: f.label }))} />
              </Field>
              <div className="flex items-center justify-end gap-3 pt-1">
                {falta && <p className="text-[0.75rem] text-red-300">{falta}</p>}
                <Btn disabled={!!falta || enviando || trabado} onClick={contabilizar} title={trabado ? 'Primero resolvé el envío sin confirmar' : falta}>
                  {enviando ? 'Registrando en Xubio…' : 'Contabilizar en Xubio'}
                </Btn>
              </div>
            </>
          )}
          {!hecho && puedeContabilizar && erp === 'RALPHARMA' && (
            <>
              <p className="text-sm text-seco">Esta empresa no usa Xubio: se carga a mano en Ralpharma y acá se confirma con tu nombre.</p>
              <Btn className="w-full" variant="secundario" onClick={() => marcarRalpharma(p.id)}>
                Confirmo que lo cargué en Ralpharma
              </Btn>
            </>
          )}
          {puedeAnular && !anulando && (
            <button onClick={() => setAnulando(true)} className="text-[0.75rem] text-red-300 hover:underline">
              Anular este pago
            </button>
          )}
          {puedeAnular && anulando && (
            <div className="rounded-lg border border-red-500/40 p-3 space-y-2">
              <Field label="Motivo de la anulación" hint="Lo aplicado vuelve a sus facturas. Queda en la auditoría con tu nombre.">
                <input id={`anular-${p.id}`} autoFocus value={motivoAnular} onChange={(ev) => setMotivoAnular(ev.target.value)} placeholder="Ej.: comprobante equivocado, pago duplicado…" className={inputCls} />
              </Field>
              <div className="flex justify-end gap-2">
                <Btn variant="fantasma" onClick={() => setAnulando(false)}>
                  Cancelar
                </Btn>
                <Btn variant="peligro" disabled={!motivoAnular.trim()} onClick={() => void anularPago(p.id, motivoAnular.trim())}>
                  Confirmar anulación
                </Btn>
              </div>
            </div>
          )}
          {(hecho || p.estado === 'REVISADO') && p.detalleXubio && <p className="text-[0.8125rem] text-seco leading-snug">{p.detalleXubio}</p>}
          {hecho && erp === 'XUBIO' && p.xubioId !== 'RALPHARMA' && (
            <div className="rounded-lg border border-borde p-3 space-y-2">
              <p className="text-[0.8125rem] text-seco leading-snug">
                {p.numeroOp ? (
                  <>
                    N° de OP / asiento: <b className="text-crema">{p.numeroOp}</b> · {p.numeroOpOrigen === 'XUBIO' ? 'traído de Xubio' : 'cargado a mano'}
                  </>
                ) : (
                  'Todavía sin N° de OP / asiento. Se busca solo en Xubio a las 9 y a las 14 h; si no aparece (por ejemplo un asiento), cargalo a mano.'
                )}
              </p>
              {puede(usuario.rol, 'PAGAR') && (
                <div className="flex flex-wrap items-center gap-2">
                  <input value={nroOp} onChange={(ev) => setNroOp(ev.target.value)} placeholder={p.numeroOp ? 'Corregir el N°' : 'Ej.: X-0001-00002312'} aria-label="N° de OP o de asiento" className={inputCls + ' flex-1 min-w-[10rem]'} />
                  <Btn
                    variant="secundario"
                    disabled={!nroOp.trim() || guardandoOp}
                    onClick={async () => {
                      // Cambiar un número que ya está pide confirmación (la base también lo exige).
                      if (p.numeroOp && p.numeroOp !== nroOp.trim() && !window.confirm(`Este pago ya tiene el N° ${p.numeroOp}. ¿Lo cambiás por ${nroOp.trim()}?`)) return
                      setGuardandoOp(true)
                      if (await guardarNumeroOp(p.id, nroOp.trim(), !!p.numeroOp)) setNroOp('')
                      setGuardandoOp(false)
                    }}
                  >
                    Guardar N°
                  </Btn>
                </div>
              )}
            </div>
          )}
          {hecho && (
            <TablaDatos
              filas={[
                ['Cuenta', p.cuentaContable],
                ['Forma', FORMAS.find((f) => f.id === p.formaCargaXubio)?.label],
                ['Desde', p.cuentaOrigen],
              ]}
            />
          )}
        </div>
      </div>
    </Card>
  )
}
