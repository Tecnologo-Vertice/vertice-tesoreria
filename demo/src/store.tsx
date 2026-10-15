import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Auditoria, ComprobanteEjemplo, Documento, Empresa, Factura, LecturaComprobante, Pago, Proveedor, Usuario } from './types'
import type { Bucket, Catalogos, DatosAprobacion, DatosContabilizacion, Fuente, NuevoPago } from './data/fuente'
import { addDays, parseIso, pendiente } from './lib/format'

type Toast = { id: number; texto: string; tipo: 'ok' | 'error' | 'info' }

interface Store {
  modo: Fuente['modo']
  cargando: boolean
  facturas: Factura[]
  pagos: Pago[]
  auditoria: Auditoria[]
  documentos: Documento[]
  catalogos: Catalogos
  usuario: Usuario
  setUsuario: (u: Usuario) => void
  aprobarFactura: (id: string, datos: DatosAprobacion) => Promise<void>
  rechazarFactura: (id: string, motivo: string) => Promise<void>
  corregirFactura: (id: string) => Promise<void>
  registrarPago: (p: NuevoPago) => Promise<Pago | null>
  contabilizarPago: (id: string, datos: DatosContabilizacion) => Promise<void>
  marcarRalpharma: (id: string) => Promise<void>
  leerComprobante: (archivo: File | ComprobanteEjemplo) => Promise<LecturaComprobante>
  comprobantesEjemplo: () => ComprobanteEjemplo[]
  subirComprobante: (archivo: File) => Promise<string>
  abrirArchivo: (bucket: Bucket, path: string) => Promise<void>
  subirFactura: (archivo: File) => Promise<void>
  leerAhora: () => Promise<void>
  reintentarDocumento: (id: string) => Promise<void>
  descartarDocumento: (id: string, motivo: string) => Promise<void>
  reiniciar: () => Promise<void>
  recargar: () => Promise<void>
  toasts: Toast[]
  toast: (texto: string, tipo?: Toast['tipo']) => void
  proveedor: (id?: string) => Proveedor | undefined
  empresa: (id: string) => Empresa
}

const Ctx = createContext<Store | null>(null)

const CATALOGOS_VACIOS: Catalogos = { empresas: [], proveedores: [], cuentasOrigen: [], planCuentas: [] }

export function StoreProvider({ fuente, usuarioInicial, children }: { fuente: Fuente; usuarioInicial: Usuario; children: ReactNode }) {
  const [facturas, setFacturas] = useState<Factura[]>([])
  const [pagos, setPagos] = useState<Pago[]>([])
  const [auditoria, setAuditoria] = useState<Auditoria[]>([])
  const [documentos, setDocumentos] = useState<Documento[]>([])
  const [catalogos, setCatalogos] = useState<Catalogos>(CATALOGOS_VACIOS)
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
    return {
      modo: fuente.modo,
      cargando,
      facturas,
      pagos,
      auditoria,
      documentos,
      catalogos,
      usuario,
      setUsuario,
      aprobarFactura: async (id, d) => {
        // Conectado, la subida a Xubio la sigue haciendo el Apps Script: no prometer lo que no pasa.
        await accion(
          () => fuente.aprobarFactura(id, d, usuario),
          fuente.modo === 'demo' ? 'Factura aprobada y enviada a Xubio con la cuenta contable' : 'Factura aprobada con la cuenta contable; pasa a Pagos',
        )
      },
      rechazarFactura: async (id, m) => {
        await accion(() => fuente.rechazarFactura(id, m, usuario), 'Factura rechazada; queda registrado quién y por qué')
      },
      corregirFactura: async (id) => {
        await accion(() => fuente.corregirFactura(id, usuario), 'Corregida: vuelve a la bandeja de aprobación')
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
      subirComprobante: (a) => fuente.subirComprobante(a),
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
      toasts,
      toast,
      proveedor: (id) => catalogos.proveedores.find((p) => p.id === id),
      empresa: empresaDe,
    }
  }, [fuente, cargando, facturas, pagos, auditoria, documentos, catalogos, usuario, toasts, toast, accion, recargar])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore fuera del provider')
  return s
}

/** Proyección semanal: pagos reales + facturas aprobadas por vencer + cheques a acreditar. */
export function useFlujo(empresaId: string | 'TODAS') {
  const { facturas, pagos } = useStore()
  return useMemo(() => {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    const lunes = new Date(t)
    const dow = lunes.getDay() === 0 ? 7 : lunes.getDay()
    lunes.setDate(lunes.getDate() - (dow - 1))
    const semanas = Array.from({ length: 8 }, (_, i) => {
      const ini = addDays(lunes, (i - 2) * 7)
      return { ini, fin: addDays(ini, 6), real: 0, proyectado: 0, cheques: 0, vencido: 0 }
    })
    const enRango = (d: Date) => semanas.findIndex((s) => d >= s.ini && d <= s.fin)
    const filtro = (eid: string) => empresaId === 'TODAS' || eid === empresaId
    for (const p of pagos) {
      if (!filtro(p.empresaId)) continue
      // Un cheque sale del banco cuando se acredita, no cuando se entrega: va a una sola barra.
      if (p.fechaAcreditacion) {
        const j = enRango(parseIso(p.fechaAcreditacion))
        if (j >= 0) semanas[j].cheques += p.importe
      } else {
        const i = enRango(parseIso(p.fecha))
        if (i >= 0) semanas[i].real += p.importe
      }
    }
    for (const f of facturas) {
      if (!filtro(f.empresaId)) continue
      if (f.estado !== 'PARA_PAGAR' && f.estado !== 'PAGADA_PARCIAL') continue
      const resto = pendiente(f)
      const v = parseIso(f.vencimiento)
      if (v < t) {
        const i = enRango(t)
        if (i >= 0) semanas[i].vencido += resto
      } else {
        const i = enRango(v)
        if (i >= 0) semanas[i].proyectado += resto
      }
    }
    return semanas
  }, [facturas, pagos, empresaId])
}
