// Modo demo: datos ficticios en memoria, persistidos en localStorage del navegador.
// Toda la lógica de negocio de acá tiene su equivalente en supabase/migrations/0003_funciones.sql.

import type { Auditoria, ComprobanteEjemplo, Documento, Factura, LecturaComprobante, Pago, Usuario } from '../types'
import type { Datos, DatosAprobacion, DatosContabilizacion, Fuente, NuevoPago, ResultadoSubida, ResultadoXubio, ResultadoXubioFactura } from './fuente'
import {
  auditoriaInicial,
  comprobantesEjemplo,
  CUENTAS_ORIGEN,
  DOCUMENTOS_INICIALES,
  EMPRESAS,
  FACTURAS_INICIALES,
  PAGOS_INICIALES,
  PLAN_CUENTAS,
  PROVEEDORES,
} from './demo'
import { leerComprobante as leerSimulado, registrarEnXubio } from '../lib/ia'
import { iso, pendiente } from '../lib/format'

const STORAGE_KEY = 'vertice-demo-v4' // v4: documentos de entrada (Flujo 1)

interface EstadoDemo {
  facturas: Factura[]
  pagos: Pago[]
  auditoria: Auditoria[]
  documentos: Documento[]
  dia: string
}

function inicial(): EstadoDemo {
  return {
    facturas: FACTURAS_INICIALES,
    pagos: PAGOS_INICIALES,
    auditoria: auditoriaInicial(FACTURAS_INICIALES, PAGOS_INICIALES),
    documentos: DOCUMENTOS_INICIALES,
    dia: iso(new Date()),
  }
}

function leer(): EstadoDemo {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as EstadoDemo
      // Si cambió el día se regeneran los datos para que los vencimientos sigan relativos a hoy.
      if (p.dia === iso(new Date()) && p.facturas?.length) return p
    }
  } catch {
    /* sin storage */
  }
  return inicial()
}

function guardar(e: EstadoDemo) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(e))
  } catch {
    /* ignorar */
  }
}

const demora = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class FuenteDemo implements Fuente {
  modo = 'demo' as const
  private e: EstadoDemo = leer()

  private log(u: Usuario | { nombre: string; rol: Auditoria['rol'] }, a: Omit<Auditoria, 'id' | 'fecha' | 'usuario' | 'rol'>) {
    this.e.auditoria.push({ id: `a${Date.now()}${Math.floor(Math.random() * 1000)}`, fecha: new Date().toISOString(), usuario: u.nombre, rol: u.rol, ...a })
  }

  private commit() {
    this.e = { ...this.e, facturas: [...this.e.facturas], pagos: [...this.e.pagos], auditoria: [...this.e.auditoria], documentos: [...this.e.documentos] }
    guardar(this.e)
  }

  async cargar(): Promise<Datos> {
    return {
      facturas: this.e.facturas,
      pagos: this.e.pagos,
      auditoria: this.e.auditoria,
      documentos: this.e.documentos,
      catalogos: { empresas: EMPRESAS, proveedores: PROVEEDORES, cuentasOrigen: CUENTAS_ORIGEN, planCuentas: PLAN_CUENTAS, planPorEmpresa: {}, productos: [] },
      espejo: [],
    }
  }

  async aprobarFactura(id: string, d: DatosAprobacion, u: Usuario) {
    this.e.facturas = this.e.facturas.map((f): Factura =>
      f.id === id
        ? {
            ...f,
            estado: 'PARA_PAGAR',
            cuentaContable: d.cuentaContable,
            metodoPago: d.metodoPago,
            diasCheque: d.diasCheque,
            aprobadoPor: u.nombre,
            aprobadoEn: new Date().toISOString(),
            estadoXubio: EMPRESAS.find((x) => x.id === f.empresaId)?.erp === 'XUBIO' ? (f.estadoXubio === 'SUBIDA' ? 'SUBIDA' : 'PENDIENTE') : 'PENDIENTE_RALPHARMA',
          }
        : f,
    )
    this.log(u, { accion: 'APROBACION', entidad: 'FACTURA', entidadId: id, detalle: `Cuenta ${d.cuentaContable} · ${d.metodoPago}` })
    this.commit()
  }

  async rechazarFactura(id: string, motivo: string, u: Usuario) {
    this.e.facturas = this.e.facturas.map((f): Factura => (f.id === id ? { ...f, estado: 'RECHAZADA', motivoValidacion: motivo } : f))
    this.log(u, { accion: 'RECHAZO', entidad: 'FACTURA', entidadId: id, detalle: motivo })
    this.commit()
  }

  async corregirFactura(id: string, u: Usuario) {
    this.e.facturas = this.e.facturas.map((f): Factura => (f.id === id ? { ...f, estado: 'PENDIENTE_APROBACION', validacionOk: true, motivoValidacion: undefined } : f))
    this.log(u, { accion: 'CORRECCION', entidad: 'FACTURA', entidadId: id, detalle: 'Datos corregidos a mano; vuelve a pendientes' })
    this.commit()
  }

  async registrarPago(d: NuevoPago, u: Usuario): Promise<Pago> {
    // Mismas validaciones que registrar_pago en SQL.
    const vinculadas = this.e.facturas.filter((f) => d.facturaIds.includes(f.id))
    if ((d.medio === 'CHEQUE' || d.medio === 'ECHEQ') && (!d.numeroCheque || !d.fechaAcreditacion))
      throw new Error('Un pago con cheque necesita número y fecha de vencimiento del cheque')
    const totalPendiente = vinculadas.reduce((a, f) => a + pendiente(f), 0)
    if (vinculadas.length && d.importe > totalPendiente + 1)
      throw new Error('El pago supera lo pendiente de las facturas vinculadas. Cargá el excedente como un pago aparte.')
    const nuevo: Pago = {
      ...d,
      id: `pg${Date.now().toString().slice(-6)}`,
      estado: EMPRESAS.find((x) => x.id === d.empresaId)?.erp === 'RALPHARMA' ? 'PENDIENTE_RALPHARMA' : 'CARGADO',
      cargadoPor: u.nombre,
      cargadoEn: new Date().toISOString(),
    }
    let restante = d.importe
    this.e.facturas = this.e.facturas.map((f): Factura => {
      if (!d.facturaIds.includes(f.id)) return f
      const aplica = Math.min(pendiente(f), restante)
      restante -= aplica
      const pagado = Math.round((f.pagado + aplica) * 100) / 100
      const pct = Math.min(100, Math.floor((pagado / f.total) * 10000) / 100)
      return { ...f, pagado, pagadoPct: pct, estado: pagado >= f.total ? 'PAGADA' : 'PAGADA_PARCIAL' }
    })
    const completas = this.e.facturas.filter((f) => d.facturaIds.includes(f.id) && f.estado === 'PAGADA')
    nuevo.mailProveedorEnviado = completas.length > 0
    this.e.pagos.push(nuevo)
    this.log(u, { accion: 'PAGO_CARGADO', entidad: 'PAGO', entidadId: nuevo.id, detalle: `${nuevo.medio} · ${nuevo.cuentaOrigen} · ${nuevo.facturaIds.length} factura(s)` })
    if (completas.length)
      this.log({ nombre: 'Sistema', rol: 'ADMIN' }, { accion: 'MAIL_PROVEEDOR', entidad: 'PAGO', entidadId: nuevo.id, detalle: `Mail con factura y comprobante a ${completas.length} proveedor(es)` })
    this.commit()
    return nuevo
  }

  async contabilizarPago(id: string, d: DatosContabilizacion, u: Usuario): Promise<ResultadoXubio> {
    const p = this.e.pagos.find((x) => x.id === id)
    if (!p) return { ok: false, error: 'Pago inexistente' }
    const r = await registrarEnXubio({ ...p, ...d, cuentaOrigen: d.cuentaOrigen || p.cuentaOrigen })
    if (!r.ok) return { ok: false, error: r.error }
    this.e.pagos = this.e.pagos.map((x): Pago =>
      x.id === id ? { ...x, ...d, cuentaOrigen: d.cuentaOrigen || x.cuentaOrigen, estado: 'CONTABILIZADO', xubioId: r.id, contabilizadoPor: u.nombre, contabilizadoEn: new Date().toISOString() } : x,
    )
    this.log(u, { accion: 'CONTABILIZADO', entidad: 'PAGO', entidadId: id, detalle: `Xubio ${r.id} · ${d.formaCargaXubio} · ${d.cuentaContable}` })
    this.commit()
    return { ok: true, id: r.id, enSeco: true, detalle: 'Simulado en la demo' }
  }

  async marcarRalpharma(id: string, u: Usuario) {
    this.e.pagos = this.e.pagos.map((x): Pago =>
      x.id === id ? { ...x, estado: 'CONTABILIZADO', xubioId: 'RALPHARMA', contabilizadoPor: u.nombre, contabilizadoEn: new Date().toISOString() } : x,
    )
    this.log(u, { accion: 'CARGADO_RALPHARMA', entidad: 'PAGO', entidadId: id, detalle: 'Carga manual confirmada en Ralpharma' })
    this.commit()
  }

  async leerComprobante(archivo: File | ComprobanteEjemplo): Promise<LecturaComprobante> {
    if (archivo instanceof File) {
      // En demo no hay IA real: se devuelve una lectura vacía de baja confianza.
      await demora(1200)
      return { banco: '', importe: 0, fecha: iso(new Date()), medio: 'TRANSFERENCIA', referencia: archivo.name, confianza: 0.2 }
    }
    return leerSimulado(archivo)
  }

  async subirComprobante(archivo: File) {
    return archivo.name
  }

  async urlArchivo() {
    return null
  }

  /** Simula la lectura de la IA: arma una factura de un proveedor de la demo, con la memoria del proveedor. */
  async subirFactura(archivo: File, u: Usuario): Promise<ResultadoSubida> {
    await demora(1500)
    const prov = PROVEEDORES[Math.floor(Math.random() * PROVEEDORES.length)]
    const recordada = this.e.facturas.find((f) => f.proveedorId === prov.id && f.empresaId === 'beratung' && f.aprobadoEn)?.cuentaContable
    const neto = 50_000 + Math.round(Math.random() * 400) * 1_000
    const iva = Math.round(neto * 0.21 * 100) / 100
    const hoy = new Date()
    const factura: Factura = {
      id: `fm${Date.now().toString().slice(-6)}`,
      empresaId: 'beratung',
      proveedorId: prov.id,
      tipo: 'Factura A',
      puntoVenta: 2,
      numero: 10_000 + Math.floor(Math.random() * 80_000),
      fecha: iso(hoy),
      vencimiento: iso(new Date(hoy.getTime() + 30 * 86_400_000)),
      neto,
      iva,
      percepciones: 0,
      total: neto + iva,
      cae: '7' + String(Date.now()).slice(-13),
      caeVencimiento: iso(new Date(hoy.getTime() + 10 * 86_400_000)),
      origen: 'MANUAL',
      estado: 'PENDIENTE_APROBACION',
      estadoXubio: 'PENDIENTE',
      validacionOk: true,
      categoriaVertice: prov.categoriaVertice,
      cuentaContable: recordada,
      categoriaIa: 'Gastos Generales',
      pagado: 0,
      pagadoPct: 0,
    }
    this.e.facturas.push(factura)
    this.e.documentos.unshift({
      id: `d${Date.now()}`,
      origen: 'MANUAL',
      nombre: archivo.name,
      estado: 'LEIDO',
      cargadoPor: u.nombre,
      recibidoEn: new Date().toISOString(),
      intentos: 1,
      storagePath: archivo.name,
      facturaId: factura.id,
    })
    this.log({ nombre: 'Lector IA', rol: 'ADMIN' }, {
      accion: 'INGRESO',
      entidad: 'FACTURA',
      entidadId: factura.id,
      detalle: `Leída desde MANUAL (${archivo.name}); validación OK${recordada ? `; cuenta recordada: ${recordada}` : ''}`,
    })
    this.commit()
    return { estado: 'LEIDO', detalle: `${prov.nombre}: en la demo la lectura es simulada` }
  }

  /** En la demo Xubio está simulado: la factura queda subida con un id inventado. */
  async subirFacturaXubio(id: string, u: Usuario): Promise<ResultadoXubioFactura> {
    await demora(600)
    const f = this.e.facturas.find((x) => x.id === id)
    if (!f) throw new Error('Factura inexistente')
    if (EMPRESAS.find((e) => e.id === f.empresaId)?.erp !== 'XUBIO') return { estado: 'NO_APLICA', detalle: 'Esta empresa no usa Xubio' }
    const xubioId = String(95_000_000 + Math.floor(Math.random() * 900_000))
    this.e.facturas = this.e.facturas.map((x): Factura => (x.id === id ? { ...x, estadoXubio: 'SUBIDA', xubioId, xubioError: undefined } : x))
    this.log(u, { accion: 'XUBIO_FACTURA', entidad: 'FACTURA', entidadId: id, detalle: `Subida a Xubio, id ${xubioId} (simulado)` })
    this.commit()
    return { estado: 'SUBIDA', xubioId, detalle: `Subida a Xubio con id ${xubioId} (simulado en la demo)` }
  }

  async marcarFacturaRalpharma(id: string, u: Usuario) {
    this.e.facturas = this.e.facturas.map((x): Factura =>
      x.id === id ? { ...x, estadoXubio: 'CARGADA_RALPHARMA', ralpharmaPor: u.nombre, ralpharmaEn: new Date().toISOString() } : x,
    )
    this.log(u, { accion: 'FACTURA_RALPHARMA', entidad: 'FACTURA', entidadId: id, detalle: 'Carga de la factura confirmada en Ralpharma' })
    this.commit()
  }

  async leerAhora() {
    return 0
  }

  async reintentarDocumento(id: string, u: Usuario) {
    // En la demo no hay IA: el reintento vuelve a dar el mismo resultado.
    this.log(u, { accion: 'REINTENTO_LECTURA', entidad: 'SISTEMA', entidadId: id, detalle: 'Vuelve a la cola de lectura' })
    this.commit()
  }

  async descartarDocumento(id: string, motivo: string, u: Usuario) {
    this.e.documentos = this.e.documentos.map((d): Documento => (d.id === id ? { ...d, estado: 'DESCARTADO', error: motivo } : d))
    this.log(u, { accion: 'DESCARTE_DOCUMENTO', entidad: 'SISTEMA', entidadId: id, detalle: motivo })
    this.commit()
  }

  comprobantesEjemplo(facturas: Factura[]) {
    return comprobantesEjemplo(facturas)
  }

  async reiniciar() {
    this.e = inicial()
    guardar(this.e)
  }
}
