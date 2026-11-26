import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Auditoria, ComprobanteEjemplo, Documento, Empresa, EstadoEspejo, Factura, LecturaComprobante, Pago, Proveedor, Usuario } from './types'
import type { Bucket, CambioLinea, Catalogos, DatosAprobacion, DatosContabilizacion, DatosEdicion, DatosLiberacion, DatosTesoreria, DatosYaPagada, Fuente, NuevaProyeccion, NuevoCheque, NuevoPago, ResultadoExtracto } from './data/fuente'
import type { CategoriaMovimiento, OrigenSaldo, RefLinea, TipoPagoFactura } from './types'
import { fecha as fmtFecha, money } from './lib/format'

type Toast = { id: number; texto: string; tipo: 'ok' | 'error' | 'info' }

interface Store {
  modo: Fuente['modo']
  cargando: boolean
  facturas: Factura[]
  pagos: Pago[]
  auditoria: Auditoria[]
  documentos: Documento[]
  catalogos: Catalogos
  espejo: EstadoEspejo[]
  usuario: Usuario
  setUsuario: (u: Usuario) => void
  aprobarFactura: (id: string, datos: DatosAprobacion) => Promise<void>
  rechazarFactura: (id: string, motivo: string) => Promise<void>
  aprobarYaPagada: (id: string, datos: DatosAprobacion, pago: DatosYaPagada) => Promise<boolean>
  aplicarNotaCredito: (ncId: string, facturaId: string, importe: number) => Promise<boolean>
  anularPago: (id: string, motivo: string) => Promise<boolean>
  liberarPagoXubio: (id: string, xubioId: string, datos: DatosLiberacion) => Promise<void>
  guardarEmailProveedor: (proveedorId: string, email: string) => Promise<boolean>
  marcarMailPreparado: (facturaIds: string[]) => Promise<void>
  linksComprobantes: (pagos: Pago[]) => Promise<Record<string, string | null>>
  catalogosXubio: () => Promise<void>
  corregirFactura: (id: string) => Promise<void>
  editarFactura: (id: string, datos: DatosEdicion) => Promise<boolean>
  registrarPago: (p: NuevoPago) => Promise<Pago | null>
  contabilizarPago: (id: string, datos: DatosContabilizacion) => Promise<void>
  marcarRalpharma: (id: string) => Promise<void>
  leerComprobante: (archivo: File | ComprobanteEjemplo) => Promise<LecturaComprobante>
  comprobantesEjemplo: () => ComprobanteEjemplo[]
  subirComprobante: (archivo: File, empresaId: string) => Promise<string>
  abrirArchivo: (bucket: Bucket, path: string) => Promise<void>
  subirFactura: (archivo: File) => Promise<void>
  leerAhora: () => Promise<void>
  reintentarDocumento: (id: string) => Promise<void>
  subirFacturaXubio: (id: string) => Promise<void>
  marcarFacturaRalpharma: (id: string) => Promise<void>
  descartarDocumento: (id: string, motivo: string) => Promise<void>
  reiniciar: () => Promise<void>
  recargar: () => Promise<void>
  /** Bancos, cheques y Flujo (0023 a 0027). Null mientras carga. */
  tesoreria: DatosTesoreria | null
  subirExtracto: (archivo: File, cuentaId: string) => Promise<ResultadoExtracto | null>
  reclasificarMovimiento: (id: string, categoria: CategoriaMovimiento, cuenta: string | null, aprender: string | null) => Promise<boolean>
  marcarSinMovimientos: (cuentaId: string, fecha: string, confirmo: boolean) => Promise<boolean>
  registrarSaldo: (cuentaId: string, fecha: string, saldo: number, origen: Extract<OrigenSaldo, 'TENENCIA' | 'MANUAL'>) => Promise<boolean>
  generarComprobanteGastos: (cuentaId: string, fecha: string) => Promise<void>
  generarAsientoBancario: (cuentaId: string, fecha: string) => Promise<void>
  emitirCheque: (c: NuevoCheque) => Promise<boolean>
  marcarChequeDebitado: (id: string, numero: string, fecha: string) => Promise<boolean>
  anularCheque: (id: string, motivo: string) => Promise<boolean>
  ajustarLineaFlujo: (ref: RefLinea, cambio: CambioLinea, motivo: string) => Promise<boolean>
  restaurarLineaFlujo: (ref: RefLinea) => Promise<boolean>
  crearProyeccion: (p: NuevaProyeccion) => Promise<boolean>
  cancelarProyeccion: (id: string, motivo: string) => Promise<boolean>
  definirPagoFactura: (id: string, tipoPago: TipoPagoFactura, anticipoPct: number | null, unidadId: string | null) => Promise<boolean>
  toasts: Toast[]
  toast: (texto: string, tipo?: Toast['tipo']) => void
  proveedor: (id?: string) => Proveedor | undefined
  empresa: (id: string) => Empresa
}

const Ctx = createContext<Store | null>(null)

const CATALOGOS_VACIOS: Catalogos = { empresas: [], proveedores: [], cuentasOrigen: [], planCuentas: [], planPorEmpresa: {}, productos: [], codigosProducto: {} }

export function StoreProvider({ fuente, usuarioInicial, children }: { fuente: Fuente; usuarioInicial: Usuario; children: ReactNode }) {
  const [facturas, setFacturas] = useState<Factura[]>([])
  const [pagos, setPagos] = useState<Pago[]>([])
  const [auditoria, setAuditoria] = useState<Auditoria[]>([])
  const [documentos, setDocumentos] = useState<Documento[]>([])
  const [catalogos, setCatalogos] = useState<Catalogos>(CATALOGOS_VACIOS)
  const [espejo, setEspejo] = useState<EstadoEspejo[]>([])
  const [tesoreria, setTesoreria] = useState<DatosTesoreria | null>(null)
  const [usuario, setUsuario] = useState<Usuario>(usuarioInicial)
  const [cargando, setCargando] = useState(true)
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback((texto: string, tipo: Toast['tipo'] = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, texto, tipo }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800)
  }, [])

  const recargar = useCallback(async () => {
    try {
      const d = await fuente.cargar()
      setFacturas(d.facturas)
      setPagos(d.pagos)
      setAuditoria(d.auditoria)
      setDocumentos(d.documentos)
      setCatalogos(d.catalogos)
      setEspejo(d.espejo)
      // Tesorería se lee aparte: si la base todavía no tiene 0023 a 0027, el resto sigue andando.
      setTesoreria(await fuente.cargarTesoreria(d.facturas))
    } catch (e) {
      toast(`No se pudieron cargar los datos: ${e instanceof Error ? e.message : e}`, 'error')
    } finally {
      setCargando(false)
    }
  }, [fuente, toast])

  useEffect(() => {
    void recargar()
  }, [recargar])

  /** Ejecuta una acción de la fuente, recarga y muestra el resultado. */
  const accion = useCallback(
    async <T,>(fn: () => Promise<T>, okMsg?: string | ((r: T) => string)): Promise<T | null> => {
      try {
        const r = await fn()
        await recargar()
        if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg)
        return r
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error')
        return null
      }
    },
    [recargar, toast],
  )

  const value = useMemo<Store>(() => {
    const empresaDe = (id: string) => catalogos.empresas.find((e) => e.id === id) ?? { id, nombre: id, corto: id, cuit: '', erp: 'NINGUNO' as const }
    const subirXubio = async (id: string) => {
      const r = await accion(() => fuente.subirFacturaXubio(id, usuario))
      if (!r) return
      if (r.estado === 'SUBIDA') toast(r.detalle)
      else if (r.estado === 'EN_SECO') toast(`Xubio en modo prueba: ${r.detalle}`, 'info')
      else if (r.estado === 'ERROR') toast(`No se pudo subir a Xubio: ${r.detalle}`, 'error')
    }
    return {
      modo: fuente.modo,
      cargando,
      facturas,
      pagos,
      auditoria,
      documentos,
      catalogos,
      espejo,
      usuario,
      setUsuario,
      aprobarFactura: async (id, d) => {
        const f = facturas.find((x) => x.id === id)
        const erp = f ? empresaDe(f.empresaId).erp : 'NINGUNO'
        const ok = await accion(
          () => fuente.aprobarFactura(id, d, usuario).then(() => true),
          erp === 'XUBIO' ? 'Factura aprobada; subiendo a Xubio…' : 'Factura aprobada; queda en el sector Ralpharma para Guido',
        )
        // Xubio automático: al aprobar, la factura se sube sola. Si falla, queda el motivo y se reintenta.
        if (ok && erp === 'XUBIO') await subirXubio(id)
      },
      aprobarYaPagada: async (id, d, p) => {
        const f = facturas.find((x) => x.id === id)
        const erp = f ? empresaDe(f.empresaId).erp : 'NINGUNO'
        const r = await accion(
          () => fuente.aprobarYaPagada(id, d, p, usuario),
          (r) =>
            r === 'CONTABILIZADO'
              ? 'Aprobada y pagada: el pago ya estaba en Xubio y queda contabilizado'
              : r === 'PARA_CONTABILIZAR'
                ? 'Aprobada y pagada: el pago quedó en la bandeja de Contabilización'
                : 'Aprobada: queda en Para pagar marcada como ya pagada; Tesorería adjunta el comprobante',
        )
        if (r && erp === 'XUBIO') await subirXubio(id)
        return r !== null
      },
      aplicarNotaCredito: async (nc, f, imp) =>
        (await accion(() => fuente.aplicarNotaCredito(nc, f, imp, usuario).then(() => true), 'Nota de crédito aplicada; queda registrado quién y por cuánto')) === true,
      guardarEmailProveedor: async (id, email) =>
        (await accion(() => fuente.guardarEmailProveedor(id, email, usuario).then(() => true), 'Mail del proveedor guardado para la próxima')) === true,
      // Se registra sin recargar ni avisar: la pantalla ya abrió Gmail y sigue con el próximo mail.
      marcarMailPreparado: async (ids) => {
        try {
          await fuente.marcarMailPreparado(ids, usuario)
          await recargar()
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error')
        }
      },
      linksComprobantes: (ps) => fuente.linksComprobantes(ps),
      catalogosXubio: async () => {
        const log = await accion(() => fuente.catalogosXubio())
        if (log) toast(log.join(' · '), 'info')
      },
      anularPago: async (id, m) =>
        (await accion(() => fuente.anularPago(id, m, usuario).then(() => true), 'Pago anulado: lo aplicado vuelve a sus facturas')) === true,
      liberarPagoXubio: async (id, nro, d) => {
        await accion(
          () => fuente.liberarPagoXubio(id, nro, d, usuario),
          (r) => (r === 'CONTABILIZADO' ? 'Queda contabilizado con el número de Xubio que cargaste, sin enviar nada' : 'Liberado: se puede volver a enviar a Xubio o anular'),
        )
      },
      rechazarFactura: async (id, m) => {
        await accion(() => fuente.rechazarFactura(id, m, usuario), 'Factura rechazada; queda registrado quién y por qué')
      },
      corregirFactura: async (id) => {
        await accion(() => fuente.corregirFactura(id, usuario), 'Corregida: vuelve a la bandeja de aprobación')
      },
      editarFactura: async (id, d) => {
        const r = await accion(() => fuente.editarFactura(id, d, usuario))
        if (!r) return false
        if (r.motivo) toast(`Guardado. Queda en Excepciones: ${r.motivo}`, 'info')
        else toast(r.estado === 'PENDIENTE_APROBACION' ? 'Guardado: los datos cierran y la factura queda lista para aprobar' : 'Guardado')
        return true
      },
      registrarPago: (p) =>
        accion(
          () => fuente.registrarPago(p, usuario),
          (r) => (r.estado === 'PENDIENTE_RALPHARMA' ? 'Pago cargado; queda pendiente de carga en Ralpharma' : 'Pago cargado y en la bandeja de Guido'),
        ),
      contabilizarPago: async (id, d) => {
        const r = await accion(() => fuente.contabilizarPago(id, d, usuario))
        if (!r) return
        if (!r.ok) toast(r.error, 'error')
        else if (r.enSeco && fuente.modo === 'conectado') toast(`Prueba en seco OK: ${r.detalle ?? 'Xubio aceptaría el comprobante'}. Queda como revisado.`, 'info')
        else toast(`Registrado en Xubio como ${r.id}`)
      },
      marcarRalpharma: async (id) => {
        await accion(() => fuente.marcarRalpharma(id, usuario), 'Marcado como cargado en Ralpharma, con tu nombre')
      },
      leerComprobante: (a) => fuente.leerComprobante(a),
      comprobantesEjemplo: () => fuente.comprobantesEjemplo(facturas),
      subirComprobante: (a, empresaId) => fuente.subirComprobante(a, empresaId),
      abrirArchivo: async (bucket, path) => {
        if (fuente.modo === 'demo') return toast('En la demo los archivos son de ejemplo: no hay nada para abrir', 'info')
        // La pestaña se abre antes del await: si no, el navegador la bloquea como popup.
        const ventana = window.open('', '_blank')
        try {
          const url = await fuente.urlArchivo(bucket, path)
          if (url && ventana) ventana.location.href = url
          else ventana?.close()
        } catch (e) {
          ventana?.close()
          toast(e instanceof Error ? e.message : String(e), 'error')
        }
      },
      subirFactura: async (archivo) => {
        await accion(
          () => fuente.subirFactura(archivo, usuario),
          (r) =>
            r.estado === 'LEIDO'
              ? `Factura leída: quedó en Pendientes${r.detalle ? ` (${r.detalle})` : ''}`
              : r.estado === 'DUPLICADO'
                ? 'Esa factura ya estaba cargada'
                : r.estado === 'PENDIENTE'
                  ? 'La factura quedó en la cola de lectura: aparece en unos minutos'
                  : `La IA no pudo leerla: ${r.detalle ?? 'ver la pestaña Entrada'}`,
        )
      },
      leerAhora: async () => {
        await accion(() => fuente.leerAhora(), (n) => (n ? `Se leyeron ${n} documento(s)` : 'No había nada esperando lectura'))
      },
      subirFacturaXubio: subirXubio,
      marcarFacturaRalpharma: async (id) => {
        await accion(() => fuente.marcarFacturaRalpharma(id, usuario), 'Factura marcada como cargada en Ralpharma, con tu nombre')
      },
      reintentarDocumento: async (id) => {
        await accion(() => fuente.reintentarDocumento(id, usuario), 'Vuelve a la cola de lectura')
      },
      descartarDocumento: async (id, motivo) => {
        await accion(() => fuente.descartarDocumento(id, motivo, usuario), 'Documento descartado; queda registrado quién y por qué')
      },
      reiniciar: async () => {
        await fuente.reiniciar()
        await recargar()
        toast('Demo reiniciada', 'info')
      },
      recargar,
      tesoreria,
      subirExtracto: (a, c) =>
        accion(
          () => fuente.subirExtracto(a, c, usuario),
          (r) =>
            r.repetido
              ? 'Ese archivo ya estaba importado: no se agregó nada'
              : `Extracto importado: ${r.nuevos} movimiento(s) nuevo(s)${r.movimientos !== undefined ? ` de ${r.movimientos}` : ''}${r.aRevisar ? ` · ${r.aRevisar} a revisar` : ''}`,
        ),
      reclasificarMovimiento: async (id, cat, cta, apr) =>
        (await accion(() => fuente.reclasificarMovimiento(id, cat, cta, apr, usuario).then(() => true), apr ? 'Reclasificado. Regla aprendida: la próxima vez entra sola' : 'Reclasificado')) === true,
      marcarSinMovimientos: async (c, f, conf) =>
        (await accion(() => fuente.marcarSinMovimientos(c, f, conf, usuario).then((s) => s), (s) => `Sin movimientos el ${fmtFecha(f)}: se repitió el saldo ${money(s)}`)) !== null,
      registrarSaldo: async (c, f, s, o) =>
        (await accion(() => fuente.registrarSaldo(c, f, s, o, usuario).then(() => true), o === 'TENENCIA' ? 'Tenencia cargada: el rendimiento sale solo de la conciliación' : 'Saldo cargado')) === true,
      generarComprobanteGastos: async (c, f) => {
        await accion(() => fuente.generarComprobanteGastos(c, f, usuario), (id) => (id ? 'Comprobante de gastos generado: queda para aprobar, ya nace pagado' : 'Ese día no hubo gastos facturables del banco'))
      },
      generarAsientoBancario: async (c, f) => {
        await accion(() => fuente.generarAsientoBancario(c, f, usuario), (id) => (id ? 'Asiento del día generado: queda pendiente de subir a Xubio' : 'Ese día no hubo nada para el asiento'))
      },
      emitirCheque: async (c) => (await accion(() => fuente.emitirCheque(c, usuario), 'Cheque emitido: el Flujo lo proyecta en su fecha de pago')) !== null,
      marcarChequeDebitado: async (id, nro, f) =>
        (await accion(() => fuente.marcarChequeDebitado(id, nro, f, usuario).then(() => true), `Cheque marcado debitado el ${fmtFecha(f)}: pasa a real en el Flujo`)) === true,
      anularCheque: async (id, m) => (await accion(() => fuente.anularCheque(id, m, usuario).then(() => true), 'Cheque anulado; queda registrado quién y por qué')) === true,
      ajustarLineaFlujo: async (ref, c, m) =>
        (await accion(() => fuente.ajustarLineaFlujo(ref, c, m, usuario).then(() => true), c.eliminar ? 'Línea eliminada del Flujo (se puede restaurar)' : c.fecha ? `Línea movida al ${fmtFecha(c.fecha)}` : 'Importe cambiado')) === true,
      restaurarLineaFlujo: async (ref) => (await accion(() => fuente.restaurarLineaFlujo(ref, usuario).then(() => true), 'Línea restaurada: vuelve a como la calcula el sistema')) === true,
      crearProyeccion: async (p) => (await accion(() => fuente.crearProyeccion(p, usuario), 'Proyección creada')) !== null,
      cancelarProyeccion: async (id, m) => (await accion(() => fuente.cancelarProyeccion(id, m, usuario).then(() => true), 'Proyección cancelada')) === true,
      definirPagoFactura: async (id, t, pct, u) => (await accion(() => fuente.definirPagoFactura(id, t, pct, u, usuario).then(() => true), 'Forma de pago guardada: el Flujo la proyecta en tramos')) === true,
      toasts,
      toast,
      proveedor: (id) => catalogos.proveedores.find((p) => p.id === id),
      empresa: empresaDe,
    }
  }, [fuente, cargando, facturas, pagos, auditoria, documentos, catalogos, espejo, tesoreria, usuario, toasts, toast, accion, recargar])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore fuera del provider')
  return s
}
