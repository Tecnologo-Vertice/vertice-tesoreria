// Modo demo: datos ficticios en memoria, persistidos en localStorage del navegador.
// Toda la lógica de negocio de acá tiene su equivalente en supabase/migrations/0003_funciones.sql.

import type { Auditoria, ComprobanteEjemplo, Documento, Factura, LecturaComprobante, Pago, Usuario } from '../types'
import type { CambioLinea, DatosTesoreria, NuevaProyeccion, NuevoCheque, OpcionesExtracto, ResultadoCorridaBancos, ResultadoExtracto } from './fuente'
import type { CategoriaMovimiento, Cheque, MovimientoBancario, OrigenSaldo, RefLinea, TipoPagoFactura } from '../types'
import { pendientesXubioDemo, reglaPara, tesoreriaInicial, vistaTesoreria, type EstadoTesoreria } from './tesoreriaDemo'
import { diaHabilAnterior, textoBanco } from '../lib/tesoreria'
import type { Datos, DatosAprobacion, DatosContabilizacion, DatosEdicion, DatosLiberacion, DatosYaPagada, Fuente, ResultadoLiberacion, ResultadoYaPagada, ResultadoEdicion, NuevoPago, ResultadoSubida, ResultadoXubio, ResultadoXubioFactura } from './fuente'
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

const STORAGE_KEY = 'vertice-demo-v5' // v5: Tesorería sin planillas (bancos, cheques, Flujo en grilla)

interface EstadoDemo {
  facturas: Factura[]
  pagos: Pago[]
  auditoria: Auditoria[]
  documentos: Documento[]
  tesoreria: EstadoTesoreria
  dia: string
}

function inicial(): EstadoDemo {
  const hoyIso = iso(new Date())
  return {
    // Una factura de Beratung con "Anticipo 30 % + Cta. Cte." para que el Flujo muestre los dos tramos.
    facturas: FACTURAS_INICIALES.map((f): Factura => (f.id === 'f026' ? { ...f, tipoPago: 'ANTICIPO_PARCIAL', anticipoPct: 30 } : f)),
    tesoreria: tesoreriaInicial(hoyIso),
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
      if (p.dia === iso(new Date()) && p.facturas?.length && p.tesoreria?.cuentas?.length) return p
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
    this.e = { ...this.e, facturas: [...this.e.facturas], pagos: [...this.e.pagos], auditoria: [...this.e.auditoria], documentos: [...this.e.documentos], tesoreria: { ...this.e.tesoreria } }
    guardar(this.e)
  }

  async cargar(): Promise<Datos> {
    return {
      facturas: this.e.facturas,
      pagos: this.e.pagos,
      auditoria: this.e.auditoria,
      documentos: this.e.documentos,
      catalogos: { empresas: EMPRESAS, proveedores: PROVEEDORES, cuentasOrigen: CUENTAS_ORIGEN, planCuentas: PLAN_CUENTAS, planPorEmpresa: {}, productos: [], codigosProducto: {} },
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

  /** Mismas reglas que aprobar_factura_ya_pagada en SQL. */
  async aprobarYaPagada(id: string, d: DatosAprobacion, p: DatosYaPagada, u: Usuario): Promise<ResultadoYaPagada> {
    const cheque = d.metodoPago === 'CHEQUE' || d.metodoPago === 'ECHEQ'
    const conPago = p.yaEnXubio || !!p.cuentaOrigen?.trim() || d.metodoPago === 'CAJA'
    if (cheque && conPago && (!p.numeroCheque || !p.fechaAcreditacion)) throw new Error('Un pago con cheque necesita número y fecha de vencimiento del cheque')
    await this.aprobarFactura(id, d, u)
    const f = this.e.facturas.find((x) => x.id === id)!
    if (!conPago) {
      this.e.facturas = this.e.facturas.map((x): Factura => (x.id === id ? { ...x, yaPagadaSegunAdmin: `Ya pagada según ${u.nombre} (${d.metodoPago}), falta el comprobante` } : x))
      this.log(u, { accion: 'APROBADA_YA_PAGADA', entidad: 'FACTURA', entidadId: id, detalle: 'Sin banco: queda en Para pagar para que Tesorería adjunte el comprobante' })
      this.commit()
      return 'PARA_PAGAR'
    }
    const erp = EMPRESAS.find((x) => x.id === f.empresaId)?.erp
    const ahora = new Date().toISOString()
    const nuevo: Pago = {
      id: `pg${Date.now().toString().slice(-6)}`, empresaId: f.empresaId, proveedorId: f.proveedorId, fecha: p.fecha || iso(new Date()),
      importe: pendiente(f), medio: d.metodoPago, cuentaOrigen: p.cuentaOrigen?.trim() || 'Caja', numeroCheque: p.numeroCheque, fechaAcreditacion: p.fechaAcreditacion,
      facturaIds: [id], descripcion: `Factura ${f.puntoVenta}-${f.numero} pagada antes de aprobar`, observaciones: p.observaciones, cuentaContable: d.cuentaContable,
      formaCargaXubio: 'ORDEN_PAGO', estado: p.yaEnXubio ? 'CONTABILIZADO' : erp === 'RALPHARMA' ? 'PENDIENTE_RALPHARMA' : 'CARGADO', comprobante: '',
      cargadoPor: u.nombre, cargadoEn: ahora,
      ...(p.yaEnXubio ? { xubioId: 'CARGADO_A_MANO', contabilizadoPor: u.nombre, contabilizadoEn: ahora } : {}),
    }
    this.e.pagos.push(nuevo)
    this.e.facturas = this.e.facturas.map((x): Factura => (x.id === id ? { ...x, pagado: x.total, pagadoPct: 100, estado: 'PAGADA' } : x))
    this.log(u, { accion: 'APROBADA_YA_PAGADA', entidad: 'PAGO', entidadId: nuevo.id, detalle: p.yaEnXubio ? 'Ya cargado a mano en Xubio: queda contabilizado sin enviar nada' : 'Pago creado al aprobar: va a Contabilización' })
    this.commit()
    return p.yaEnXubio ? 'CONTABILIZADO' : 'PARA_CONTABILIZAR'
  }

  /** Mismas reglas que aplicar_nota_credito en SQL. */
  async aplicarNotaCredito(ncId: string, facturaId: string, importe: number, u: Usuario) {
    const nc = this.e.facturas.find((x) => x.id === ncId)
    const f = this.e.facturas.find((x) => x.id === facturaId)
    if (!nc || !f) throw new Error('Nota de crédito o factura inexistente')
    const saldo = nc.saldoNc ?? nc.total
    const imp = Math.round(importe * 100) / 100
    if (nc.empresaId !== f.empresaId) throw new Error('La nota de crédito es de otra empresa')
    if (nc.proveedorId !== f.proveedorId) throw new Error('La nota de crédito es de otro proveedor')
    if (!['PARA_PAGAR', 'PAGADA_PARCIAL'].includes(nc.estado)) throw new Error('La nota de crédito tiene que estar aprobada')
    if (!['PARA_PAGAR', 'PAGADA_PARCIAL'].includes(f.estado)) throw new Error('La factura no está para pagar')
    if (!(imp > 0)) throw new Error('El importe a aplicar debe ser mayor a cero')
    if (imp > saldo) throw new Error(`La nota de crédito tiene saldo ${saldo} y se quiere aplicar ${imp}`)
    if (imp > pendiente(f)) throw new Error(`La factura tiene pendiente ${pendiente(f)} y se quiere aplicar ${imp}`)
    this.e.facturas = this.e.facturas.map((x): Factura => {
      if (x.id === facturaId) {
        const pagado = Math.round((x.pagado + imp) * 100) / 100
        return { ...x, ncAplicadas: [...(x.ncAplicadas ?? []), { ncId, importe: imp }], pagado, pagadoPct: Math.min(100, Math.floor((pagado / x.total) * 10000) / 100), estado: pagado >= x.total ? 'PAGADA' : 'PAGADA_PARCIAL' }
      }
      if (x.id === ncId) {
        const resto = Math.round((saldo - imp) * 100) / 100
        return { ...x, saldoNc: resto, estado: resto <= 0 ? 'PAGADA' : x.estado }
      }
      return x
    })
    this.log(u, { accion: 'NC_APLICADA', entidad: 'FACTURA', entidadId: facturaId, detalle: `NC ${nc.puntoVenta}-${nc.numero} aplicada por $ ${imp}` })
    this.commit()
  }

  async guardarEmailProveedor(proveedorId: string, email: string, u: Usuario) {
    const v = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error(`Mail inválido: ${email}`)
    const p = PROVEEDORES.find((x) => x.id === proveedorId)
    if (!p) throw new Error('Proveedor inexistente')
    p.email = v
    this.log(u, { accion: 'MAIL_PROVEEDOR_GUARDADO', entidad: 'SISTEMA', entidadId: proveedorId, detalle: v })
    this.commit()
  }

  async marcarMailPreparado(facturaIds: string[], u: Usuario) {
    const d = new Date()
    const dd = (n: number) => String(n).padStart(2, '0')
    const texto = `Preparado en Gmail ${dd(d.getDate())}/${dd(d.getMonth() + 1)}/${d.getFullYear()} ${dd(d.getHours())}:${dd(d.getMinutes())}`
    this.e.facturas = this.e.facturas.map((f): Factura => (facturaIds.includes(f.id) ? { ...f, mailEnviado: texto } : f))
    this.e.pagos = this.e.pagos.map((p): Pago => (p.facturaIds.some((id) => facturaIds.includes(id)) && p.estado !== 'ANULADO' ? { ...p, mailProveedorEnviado: true } : p))
    this.log(u, { accion: 'MAIL_PREPARADO', entidad: 'SISTEMA', entidadId: '', detalle: `${facturaIds.length} factura(s) · ${texto}` })
    this.commit()
  }

  async linksComprobantes(pagos: Pago[]) {
    return Object.fromEntries(pagos.map((p) => [p.id, null]))
  }

  async catalogosXubio() {
    return ['En la demo no hay conexión con Xubio: el plan de cuentas es el de ejemplo.']
  }

  /** Mismas reglas que anular_pago en SQL. La demo no guarda cuánto se aplicó a cada factura: lo devuelve en el mismo orden. */
  async anularPago(id: string, motivo: string, u: Usuario) {
    const p = this.e.pagos.find((x) => x.id === id)
    if (!p) throw new Error('Pago inexistente')
    if (!motivo.trim()) throw new Error('Falta el motivo de la anulación')
    if (!['CARGADO', 'REVISADO', 'PENDIENTE_RALPHARMA'].includes(p.estado)) throw new Error(`Un pago ${p.estado} no se anula acá: si ya está en Xubio, anulalo primero en Xubio`)
    let restante = p.importe
    this.e.facturas = this.e.facturas.map((f): Factura => {
      if (!p.facturaIds.includes(f.id) || restante <= 0) return f
      const quita = Math.min(f.pagado, restante)
      restante -= quita
      const pagado = Math.round((f.pagado - quita) * 100) / 100
      return { ...f, pagado, pagadoPct: Math.min(100, Math.floor((pagado / f.total) * 10000) / 100), estado: pagado <= 0 ? 'PARA_PAGAR' : 'PAGADA_PARCIAL' }
    })
    this.e.pagos = this.e.pagos.map((x): Pago => (x.id === id ? { ...x, estado: 'ANULADO', anuladoPor: u.nombre, anuladoEn: new Date().toISOString(), motivoAnulacion: motivo.trim() } : x))
    this.log(u, { accion: 'PAGO_ANULADO', entidad: 'PAGO', entidadId: id, detalle: motivo.trim() })
    this.commit()
  }

  /** Mismas reglas que liberar_pago_xubio en SQL. En la demo ningún envío queda trabado: está para completar la interfaz. */
  async liberarPagoXubio(id: string, xubioId: string, d: DatosLiberacion, u: Usuario): Promise<ResultadoLiberacion> {
    const p = this.e.pagos.find((x) => x.id === id)
    if (!p) throw new Error('Pago inexistente')
    if (!p.envioXubioEn || !['CARGADO', 'REVISADO'].includes(p.estado)) throw new Error('El pago no tiene un envío a Xubio trabado')
    const nro = xubioId.trim()
    const cuenta = d.cuentaContable || p.cuentaContable
    if (nro && !cuenta) throw new Error('Falta la cuenta contable (regla de oro)')
    this.e.pagos = this.e.pagos.map((x): Pago =>
      x.id !== id ? x
        : nro ? { ...x, estado: 'CONTABILIZADO', xubioId: nro, cuentaContable: cuenta, formaCargaXubio: d.formaCargaXubio ?? x.formaCargaXubio, contabilizadoPor: u.nombre, contabilizadoEn: new Date().toISOString() }
        : { ...x, envioXubioEn: undefined },
    )
    this.log(u, { accion: 'XUBIO_PAGO_LIBERADO', entidad: 'PAGO', entidadId: id, detalle: nro ? `Envío sin confirmar: ya estaba en Xubio como ${nro}` : 'Envío sin confirmar: no estaba en Xubio. Liberado' })
    this.commit()
    return nro ? 'CONTABILIZADO' : 'LIBERADO'
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

  /** Misma validación que editar_factura en SQL. En la demo el proveedor no cambia (los CUIT son ficticios). */
  async editarFactura(id: string, d: DatosEdicion, u: Usuario): Promise<ResultadoEdicion> {
    const f = this.e.facturas.find((x) => x.id === id)
    if (!f) throw new Error('Factura inexistente')
    if (f.pagado > 0 || !['PENDIENTE_APROBACION', 'ERROR', 'PARA_PAGAR'].includes(f.estado)) throw new Error('Solo se editan facturas sin pagos')
    const percepciones = d.percepciones.reduce((a, p) => a + (Number(p.importe) || 0), 0)
    const dif = Math.round((d.total - (d.neto + d.iva + d.exento + percepciones)) * 100) / 100
    const cae = d.cae.replace(/\D/g, '')
    const motivo = !d.tipo || d.tipo === 'Sin tipo' ? 'Comprobante sin tipo válido' : d.total <= 0 ? 'El total tiene que ser mayor a cero'
      : cae.length !== 14 ? `El CAE tiene que tener 14 dígitos (tiene ${cae.length})` : Math.abs(dif) >= 1 ? `Descuadre de ${Math.abs(dif)} entre el total y neto + IVA + exento + percepciones` : null
    const estado = f.estado === 'PARA_PAGAR' ? 'PARA_PAGAR' : motivo ? 'ERROR' : 'PENDIENTE_APROBACION'
    this.e.facturas = this.e.facturas.map((x): Factura =>
      x.id === id
        ? { ...x, empresaId: d.empresaId, tipo: d.tipo as Factura['tipo'], letra: d.letra, puntoVenta: d.puntoVenta, numero: d.numero, fecha: d.fecha, vencimiento: d.vencimiento || d.fecha,
            moneda: d.moneda, cotizacion: d.cotizacion, neto: d.neto, iva: d.iva, exento: d.exento, percepciones, percepcionesJson: d.percepciones, total: d.total, cae, caeVencimiento: d.caeVencimiento,
            categoriaVertice: (d.categoriaVertice || x.categoriaVertice) as Factura['categoriaVertice'], cuentaContable: d.cuentaContable || x.cuentaContable, codigoProducto: d.codigoProducto || x.codigoProducto,
            validacionOk: !motivo, motivoValidacion: motivo ?? undefined, estado }
        : x,
    )
    this.log(u, { accion: 'EDICION', entidad: 'FACTURA', entidadId: id, detalle: 'Datos corregidos a mano' + (motivo ? ` · queda en excepciones: ${motivo}` : '') })
    this.commit()
    return { estado, motivo }
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

  async subirComprobante(archivo: File, _empresaId: string) {
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
  // ---------------------------------------------------------------- Tesorería (mismas reglas que 0024 a 0026)

  private get t() {
    return this.e.tesoreria
  }

  private exigirRol(u: Usuario, roles: Usuario['rol'][]) {
    if (!roles.includes(u.rol)) throw new Error(`Tu rol (${u.rol}) no puede hacer esto`)
  }

  async cargarTesoreria(facturas: Factura[]): Promise<DatosTesoreria> {
    return vistaTesoreria(this.t, facturas, iso(new Date()))
  }

  /** Mismo contrato que POST /api/bancos/extracto: totales, una entrada por cuenta y, en un FCI, tenencia (0029). */
  async subirExtracto(archivo: File, cuentaId: string, u: Usuario, o: OpcionesExtracto = {}): Promise<ResultadoExtracto> {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    await demora(700)
    const c = this.t.cuentas.find((x) => x.id === cuentaId)
    if (!c) throw new Error('Cuenta bancaria inexistente')
    const huella = `${archivo.name}|${archivo.size}`
    const formato = `${c.banco}_${c.clase === 'FCI' ? 'FCI' : 'CSV'}`
    if (this.t.extractos.some((x) => x.cuentaId === cuentaId && x.huella === huella)) {
      return { repetido: true, nuevos: 0, movimientos: 0, aRevisar: 0, formato, detalle: `${c.nombre}: ya estaba importado`, cuentas: [{ cuentaId, cuenta: c.nombre, parte: 'UNICA', repetido: true, movimientos: 0, nuevos: 0, aRevisar: 0, origenSaldos: 'EXTRACTO' }] }
    }
    const fer = new Set(this.t.feriados)
    const ayer = diaHabilAnterior(iso(new Date()), fer)

    // Un FCI no trae movimientos: el informe del fondo trae la tenencia (saldo) y el rendimiento sale de la conciliación.
    if (c.clase === 'FCI') {
      const fecha = o.fechaTenencia ?? ayer
      const ant = [...this.t.saldos].filter((s) => s.cuentaId === cuentaId && s.fecha < fecha).sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
      const saldo = Math.round((ant?.saldo ?? 1_000_000) * 1.00095 * 100) / 100
      const previo = this.t.saldos.find((s) => s.cuentaId === cuentaId && s.fecha === fecha)
      if (previo?.origen !== 'MANUAL') this.t.saldos = [...this.t.saldos.filter((s) => !(s.cuentaId === cuentaId && s.fecha === fecha)), { cuentaId, fecha, saldo, origen: 'TENENCIA' }]
      this.t.extractos = [{ id: `ex${Date.now()}`, cuentaId, archivo: archivo.name, desde: fecha, hasta: fecha, movimientos: 0, nuevos: 0, importadoPor: u.nombre, importadoEn: new Date().toISOString(), huella }, ...this.t.extractos]
      this.log(u, { accion: 'IMPORTAR_TENENCIA', entidad: 'CUENTA', entidadId: cuentaId, detalle: `${c.nombre}: tenencia ${fecha} ${saldo}` })
      this.commit()
      return {
        repetido: false, movimientos: 0, nuevos: 0, aRevisar: 0, formato, banco: c.banco, tenencia: true,
        detalle: `${c.nombre}: tenencia al ${fecha.split('-').reverse().join('/')} (el rendimiento sale de la conciliación)`,
        cuentas: [{ cuentaId, cuenta: c.nombre, parte: 'UNICA', repetido: false, movimientos: 0, nuevos: 0, aRevisar: 0, origenSaldos: 'TENENCIA', hasta: fecha, saldoFinal: saldo }],
      }
    }

    // La demo simula el archivo: trae el último día hábil que le falta a la cuenta (hasta ayer).
    const falta = !this.t.saldos.some((s) => s.cuentaId === cuentaId && s.fecha === ayer)
    const nuevos: MovimientoBancario[] = []
    let saldoFinal: number | undefined
    if (falta) {
      const ant = [...this.t.saldos].filter((s) => s.cuentaId === cuentaId && s.fecha < ayer).sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
      const filas: [string, number][] = c.rindeDiario ? [['RENDIMIENTO ACREDITADO', Math.round((ant?.saldo ?? 0) * 0.00095 * 100) / 100]] : [['IMP. LEY 25413 DEB 0,6%', -1_250.4], ['COMISION MANTENIMIENTO CUENTA', -4_200], ['IVA 21% S/COMISION', -882]]
      for (const [desc, imp] of filas) {
        const r = reglaPara(this.t.reglas, desc, imp)
        nuevos.push({
          id: `mv${Date.now()}${nuevos.length}`, empresaId: c.empresaId, cuentaId, fecha: ayer, descripcion: desc, importe: imp,
          categoria: r?.categoria ?? 'SIN_CLASIFICAR', cuentaContable: r?.cuenta, destinoXubio: r?.destino ?? 'NINGUNO', componente: r?.componente,
          estado: r ? 'PENDIENTE' : 'A_REVISAR',
        })
      }
      saldoFinal = Math.round(((ant?.saldo ?? 0) + nuevos.reduce((a, m) => a + m.importe, 0)) * 100) / 100
      this.t.movimientos = [...this.t.movimientos, ...nuevos]
      this.t.saldos = [...this.t.saldos.filter((s) => !(s.cuentaId === cuentaId && s.fecha === ayer)), { cuentaId, fecha: ayer, saldo: saldoFinal, origen: 'EXTRACTO' }]
    }
    const total = nuevos.length || 12
    const aRevisar = nuevos.filter((m) => m.estado === 'A_REVISAR').length
    this.t.extractos = [
      { id: `ex${Date.now()}`, cuentaId, archivo: archivo.name, desde: falta ? ayer : undefined, hasta: falta ? ayer : undefined, movimientos: total, nuevos: nuevos.length, importadoPor: u.nombre, importadoEn: new Date().toISOString(), huella },
      ...this.t.extractos,
    ]
    this.log(u, { accion: 'IMPORTAR_EXTRACTO', entidad: 'CUENTA', entidadId: cuentaId, detalle: `${c.nombre}: ${nuevos.length} nuevos` })
    this.commit()
    return {
      repetido: false,
      movimientos: total,
      nuevos: nuevos.length,
      formato,
      banco: c.banco,
      tenencia: false,
      aRevisar,
      detalle: nuevos.length ? `${c.nombre}: ${nuevos.length} nuevo(s) de ${total}` : 'El archivo se superpone con lo ya importado: no hay movimientos nuevos',
      cuentas: [{ cuentaId, cuenta: c.nombre, parte: 'UNICA', repetido: false, movimientos: total, nuevos: nuevos.length, aRevisar, origenSaldos: 'EXTRACTO', hasta: falta ? ayer : undefined, saldoFinal }],
    }
  }

  async reclasificarMovimiento(id: string, categoria: CategoriaMovimiento, cuenta: string | null, aprender: string | null, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const mv = this.t.movimientos.find((m) => m.id === id)
    if (!mv) throw new Error('Movimiento inexistente')
    if (mv.estado === 'CONTABILIZADO' || mv.estado === 'CARGADO_A_MANO') throw new Error('El movimiento ya está contabilizado')
    const asiento = ['IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES'].includes(categoria)
    // Como en la base (0031): un gasto bancario va al comprobante, como neto.
    const comprobante = categoria === 'GASTO_BANCARIO'
    const destino = comprobante ? 'COMPROBANTE' : asiento ? 'ASIENTO' : 'NINGUNO'
    if (aprender?.trim()) {
      if (!textoBanco(mv.descripcion).includes(textoBanco(aprender))) throw new Error('El texto a aprender no está en la descripción del movimiento')
      this.t.reglas = [
        ...this.t.reglas,
        { orden: 5, patrones: [textoBanco(aprender)], sentido: mv.importe < 0 ? 'DEBITO' : 'CREDITO', categoria, cuenta: cuenta ?? undefined, destino },
      ]
    }
    this.t.movimientos = this.t.movimientos.map((m) =>
      m.id === id ? { ...m, categoria, cuentaContable: cuenta ?? undefined, destinoXubio: destino, componente: comprobante ? 'NETO' : undefined, estado: 'PENDIENTE', revisadoPor: u.nombre } : m,
    )
    this.log(u, { accion: 'RECLASIFICAR', entidad: 'MOVIMIENTO', entidadId: id, detalle: `${categoria} · ${cuenta ?? ''}${aprender ? ` · regla "${aprender}"` : ''}` })
    this.commit()
  }

  async asignarContraparte(movimientoId: string, cuentaId: string | null, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const mv = this.t.movimientos.find((m) => m.id === movimientoId)
    if (!mv) throw new Error('Movimiento inexistente')
    const c = cuentaId ? this.t.cuentas.find((x) => x.id === cuentaId) : undefined
    if (cuentaId && (!c || c.empresaId !== mv.empresaId || c.id === mv.cuentaId)) throw new Error('La contraparte tiene que ser otra cuenta de la misma empresa')
    this.t.movimientos = this.t.movimientos.map((m) => (m.id === movimientoId ? { ...m, contraparteCuentaId: cuentaId ?? undefined, revisadoPor: u.nombre } : m))
    this.log(u, { accion: 'CONTRAPARTE', entidad: 'MOVIMIENTO', entidadId: movimientoId, detalle: c?.nombre ?? 'sin contraparte' })
    this.commit()
  }

  async marcarSinMovimientos(cuentaId: string, fecha: string, confirmo: boolean, u: Usuario): Promise<number> {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const c = this.t.cuentas.find((x) => x.id === cuentaId)
    if (!c) throw new Error('Cuenta bancaria inexistente')
    if (c.rindeDiario && !confirmo) throw new Error(`${c.nombre} rinde todos los días: subí el extracto o confirmá que no hubo rendimiento`)
    if (this.t.movimientos.some((m) => m.cuentaId === cuentaId && m.fecha === fecha && m.estado !== 'IGNORADO')) throw new Error('Ese día tiene movimientos: no se puede marcar sin movimientos')
    if (this.t.saldos.some((s) => s.cuentaId === cuentaId && s.fecha === fecha && s.origen !== 'SIN_MOVIMIENTOS')) throw new Error('Ese día ya tiene saldo del banco')
    const ant = this.t.saldos.filter((s) => s.cuentaId === cuentaId && s.fecha < fecha).sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
    if (!ant) throw new Error(`No hay un saldo anterior: cargá el saldo de ${c.nombre} a mano`)
    if (this.t.movimientos.some((m) => m.cuentaId === cuentaId && m.fecha > ant.fecha && m.fecha < fecha && m.estado !== 'IGNORADO'))
      throw new Error(`Hay movimientos entre ${ant.fecha} y ${fecha} sin saldo de cierre: subí ese extracto primero`)
    this.t.saldos = [...this.t.saldos.filter((s) => !(s.cuentaId === cuentaId && s.fecha === fecha)), { cuentaId, fecha, saldo: ant.saldo, origen: 'SIN_MOVIMIENTOS' }]
    this.log(u, { accion: 'SIN_MOVIMIENTOS', entidad: 'CUENTA', entidadId: cuentaId, detalle: `${c.nombre} ${fecha} · saldo ${ant.saldo} (de ${ant.fecha})` })
    this.commit()
    return ant.saldo
  }

  async registrarSaldo(cuentaId: string, fecha: string, saldo: number, origen: Extract<OrigenSaldo, 'TENENCIA' | 'MANUAL'>, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const c = this.t.cuentas.find((x) => x.id === cuentaId)
    if (!c) throw new Error('Cuenta bancaria inexistente')
    this.t.saldos = [...this.t.saldos.filter((s) => !(s.cuentaId === cuentaId && s.fecha === fecha)), { cuentaId, fecha, saldo: Math.round(saldo * 100) / 100, origen }]
    this.log(u, { accion: `SALDO_${origen}`, entidad: 'CUENTA', entidadId: cuentaId, detalle: `${c.nombre} ${fecha} · ${saldo}` })
    this.commit()
  }

  async generarComprobanteGastos(cuentaId: string, fecha: string, u: Usuario): Promise<string | null> {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const c = this.t.cuentas.find((x) => x.id === cuentaId)
    if (!c) throw new Error('Cuenta bancaria inexistente')
    const movs = this.t.movimientos.filter((m) => m.cuentaId === cuentaId && m.fecha === fecha && m.destinoXubio === 'COMPROBANTE' && m.estado !== 'IGNORADO')
    const total = Math.round(-movs.reduce((a, m) => a + m.importe, 0) * 100) / 100
    if (total === 0) return null
    const numero = `09990-${fecha.replace(/-/g, '')}`
    const prev = this.t.documentos.find((d) => d.tipo === 'COMPROBANTE' && d.cuentaId === cuentaId && d.fecha === fecha)
    if (prev?.estadoXubio === 'SUBIDA') throw new Error(`El comprobante ${numero} ya está en Xubio: no se regenera`)
    const id = prev?.id ?? `doc${Date.now()}`
    this.t.documentos = [...this.t.documentos.filter((d) => d.id !== id), { id, tipo: 'COMPROBANTE', cuentaId, fecha, numero, total, estado: 'PENDIENTE_APROBACION', estadoXubio: 'PENDIENTE' }]
    this.t.movimientos = this.t.movimientos.map((m) => (movs.some((x) => x.id === m.id) ? { ...m, facturaId: id } : m))
    this.log(u, { accion: 'COMPROBANTE_GASTOS', entidad: 'CUENTA', entidadId: cuentaId, detalle: `${numero} · ${total}` })
    this.commit()
    return id
  }

  async generarAsientoBancario(cuentaId: string, fecha: string, u: Usuario): Promise<string | null> {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const movs = this.t.movimientos.filter((m) => m.cuentaId === cuentaId && m.fecha === fecha && m.destinoXubio === 'ASIENTO' && m.estado !== 'IGNORADO')
    if (!movs.length) return null
    if (movs.some((m) => !m.cuentaContable)) throw new Error('Hay movimientos del asiento sin cuenta contable: clasificalos primero')
    const prev = this.t.documentos.find((d) => d.tipo === 'ASIENTO' && d.cuentaId === cuentaId && d.fecha === fecha)
    if (prev?.estadoXubio === 'SUBIDA') throw new Error('El asiento de ese día ya está en Xubio: anulalo para rehacerlo')
    const id = prev?.id ?? `as${Date.now()}`
    const total = Math.round(movs.reduce((a, m) => a + Math.abs(m.importe), 0) * 100) / 100
    this.t.documentos = [...this.t.documentos.filter((d) => d.id !== id), { id, tipo: 'ASIENTO', cuentaId, fecha, total, estado: 'GENERADO', estadoXubio: 'PENDIENTE' }]
    this.log(u, { accion: 'ASIENTO_BANCARIO', entidad: 'CUENTA', entidadId: cuentaId, detalle: `${fecha} · ${movs.length} movimientos` })
    this.commit()
    return id
  }

  async emitirCheque(n: NuevoCheque, u: Usuario): Promise<string> {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const c = this.t.cuentas.find((x) => x.id === n.cuentaId)
    if (!c || c.empresaId !== n.empresaId) throw new Error('La chequera es de otra empresa')
    if (!n.numero.trim()) throw new Error('Falta el número del cheque')
    if (!(n.importe > 0)) throw new Error('El importe tiene que ser mayor a cero')
    if (n.fechaPago < n.fechaEmision) throw new Error('La fecha de pago no puede ser anterior a la de emisión')
    if (this.t.cheques.some((x) => x.cuentaId === n.cuentaId && x.tipo === n.tipo && x.numero === n.numero.trim())) throw new Error(`Ya hay un cheque ${n.numero} en esa chequera`)
    if (n.pagos.some((p) => this.e.pagos.find((x) => x.id === p.pagoId)?.empresaId !== n.empresaId)) throw new Error('Un pago del lote es de otra empresa')
    const suma = Math.round(n.pagos.reduce((a, p) => a + p.importe, 0) * 100) / 100
    if (n.pagos.length && suma !== Math.round(n.importe * 100) / 100) throw new Error(`Los pagos del lote suman ${suma} y el cheque es de ${n.importe}`)
    const id = `ch${Date.now()}`
    const ch: Cheque = { id, empresaId: n.empresaId, cuentaId: n.cuentaId, tipo: n.tipo, numero: n.numero.trim(), beneficiario: n.beneficiario.trim(), proveedorId: n.proveedorId, importe: Math.round(n.importe * 100) / 100, fechaEmision: n.fechaEmision, fechaPago: n.fechaPago, estado: 'EMITIDO', origen: n.origen, observaciones: n.observaciones, pagos: n.pagos }
    this.t.cheques = [...this.t.cheques, ch]
    this.log(u, { accion: 'EMITIR_CHEQUE', entidad: 'CHEQUE', entidadId: id, detalle: `${n.tipo} ${n.numero} · ${n.importe}` })
    this.commit()
    return id
  }

  async marcarChequeDebitado(id: string, numero: string, fecha: string, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const ch = this.t.cheques.find((x) => x.id === id)
    if (!ch) throw new Error('Cheque inexistente')
    if (numero.trim() !== ch.numero) throw new Error(`El número no coincide con el cheque (${ch.numero}): no se marcó`)
    if (ch.estado !== 'EMITIDO' && ch.estado !== 'ENTREGADO') throw new Error(`El cheque está ${ch.estado}`)
    this.t.cheques = this.t.cheques.map((x): Cheque => (x.id === id ? { ...x, estado: 'DEBITADO', debitadoEn: fecha, marcadoPor: u.nombre } : x))
    this.log(u, { accion: 'CHEQUE_DEBITADO', entidad: 'CHEQUE', entidadId: id, detalle: `${ch.numero} · ${fecha}` })
    this.commit()
  }

  async anularCheque(id: string, motivo: string, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    if (!motivo.trim()) throw new Error('Falta el motivo')
    const ch = this.t.cheques.find((x) => x.id === id)
    if (!ch) throw new Error('Cheque inexistente')
    if (ch.estado === 'DEBITADO') throw new Error('El cheque ya se debitó: no se anula')
    // En la demo los cheques de un pago se emitieron en Xubio (orden de pago): quedan pendientes de anular allá.
    const anulacionXubio = ch.origen === 'PAGO' ? 'PENDIENTE' : 'HECHA'
    this.t.cheques = this.t.cheques.map((x): Cheque => (x.id === id ? { ...x, estado: 'ANULADO', anuladoPor: u.nombre, motivoAnulacion: motivo, anulacionXubio } : x))
    this.log(u, { accion: 'ANULAR', entidad: 'CHEQUE', entidadId: id, detalle: motivo })
    this.commit()
  }

  /** Igual que marcar_anulacion_xubio_manual (0029). La demo modela cheques y pagos; no tiene asientos anulados. */
  async marcarAnulacionXubioManual(tipo: 'PAGO' | 'CHEQUE' | 'ASIENTO', id: string, nota: string, u: Usuario) {
    this.exigirRol(u, ['ADMINISTRACION', 'ADMIN'])
    if (!nota.trim()) throw new Error('Falta la nota: qué se hizo en Xubio (n.º de anulación, fecha)')
    if (tipo === 'CHEQUE') {
      const ch = this.t.cheques.find((x) => x.id === id)
      if (!ch) throw new Error('No existe ese cheque')
      if (!ch.anulacionXubio) throw new Error('No está anulado en el sistema: anulalo primero')
      if (ch.anulacionXubio === 'HECHA') throw new Error('La anulación en Xubio ya figura hecha')
      this.t.cheques = this.t.cheques.map((x): Cheque => (x.id === id ? { ...x, anulacionXubio: 'HECHA', anulacionManualPor: u.nombre, anulacionManualNota: nota.trim() } : x))
    } else if (tipo === 'PAGO') {
      const p = (this.t.anulacionesPago ?? []).find((x) => x.id === id)
      if (!p) throw new Error('No existe ese pago')
      if (p.estado === 'HECHA') throw new Error('La anulación en Xubio ya figura hecha')
      this.t.anulacionesPago = (this.t.anulacionesPago ?? []).map((x) => (x.id === id ? { ...x, estado: 'HECHA', manualPor: u.nombre, manualNota: nota.trim() } : x))
    } else {
      throw new Error('No existe ese asiento')
    }
    this.log(u, { accion: 'ANULACION_XUBIO_MANUAL', entidad: tipo, entidadId: id, detalle: nota.trim() })
    this.commit()
  }

  /** Simula POST /api/xubio/bancos: en seco lista lo que haría; "real" sube comprobantes aprobados y asientos (simulado). */
  async correrEnviosBancos(enSeco: boolean, u: Usuario): Promise<ResultadoCorridaBancos> {
    this.exigirRol(u, ['ADMINISTRACION', 'ADMIN'])
    await demora(500)
    const items: ResultadoCorridaBancos['items'] = []
    for (const p of pendientesXubioDemo(this.t)) {
      if (p.estado === 'FALTA_APROBAR') {
        items.push({ entidad: p.tipo, id: p.id, estado: 'OMITIDO', detalle: `${p.descripcion}: falta aprobarlo` })
      } else if (p.aMano) {
        items.push({ entidad: p.tipo, id: p.id, estado: enSeco ? 'PRUEBA_OK' : 'ERROR', detalle: `${enSeco ? 'En seco: ' : ''}${p.descripcion}: Xubio no permite borrarlo por API. Anularlo a mano en Xubio.` })
      } else if (enSeco) {
        items.push({ entidad: p.tipo, id: p.id, estado: 'PRUEBA_OK', detalle: `En seco: se subiría ${p.descripcion}` })
      } else {
        const xubioId = `DEMO-${Math.floor(Math.random() * 90000 + 10000)}`
        this.t.documentos = this.t.documentos.map((d) => (d.id === p.id ? { ...d, estadoXubio: 'SUBIDA' } : d))
        if (p.tipo === 'ASIENTO') this.t.movimientos = this.t.movimientos.map((m) => (m.cuentaId === p.cuentaId && m.fecha === p.fecha && m.destinoXubio === 'ASIENTO' && m.estado === 'PENDIENTE' ? { ...m, estado: 'CONTABILIZADO' } : m))
        items.push({ entidad: p.tipo, id: p.id, estado: 'OK', detalle: `Subido a Xubio (simulado) con id ${xubioId}` })
      }
    }
    if (!enSeco) {
      this.log(u, { accion: 'XUBIO_BANCOS', entidad: 'SISTEMA', entidadId: 'xubio-bancos', detalle: `${items.filter((i) => i.estado === 'OK').length} subidos (simulado)` })
      this.commit()
    }
    return { real: !enSeco, envioRealHabilitado: true, items }
  }

  /** linea_proyectada_de: lo proyectado sigue proyectado; lo real no se toca. */
  private empresaDeLinea(ref: RefLinea): string {
    let empresa: string | undefined
    let ok = false
    if (ref.origenTipo === 'FACTURA') {
      const f = this.e.facturas.find((x) => x.id === ref.origenId)
      empresa = f?.empresaId
      ok = !!f && (f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL')
    } else if (ref.origenTipo === 'CHEQUE') {
      const c = this.t.cheques.find((x) => x.id === ref.origenId)
      empresa = c?.empresaId
      ok = !!c && (c.estado === 'EMITIDO' || c.estado === 'ENTREGADO')
    } else if (ref.origenTipo === 'PROYECCION') {
      const p = this.t.proyecciones.find((x) => x.id === ref.origenId)
      empresa = p?.empresaId
      ok = p?.estado === 'ACTIVA'
    } else {
      throw new Error('Lo real (pagos, débitos, cobros, movimientos) no se edita desde el Flujo')
    }
    if (!empresa) throw new Error('La línea no existe')
    if (!ok) throw new Error('La línea ya no está proyectada (está pagada, debitada o cancelada)')
    return empresa
  }

  async ajustarLineaFlujo(ref: RefLinea, cambio: CambioLinea, motivo: string, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN'])
    if (!motivo.trim()) throw new Error('Falta el motivo')
    const empresa = this.empresaDeLinea(ref)
    if (ref.origenTipo === 'FACTURA' && !['ANTICIPO', 'SALDO'].includes(ref.ocurrencia)) throw new Error('Ocurrencia de factura inválida')
    if (ref.origenTipo === 'CHEQUE' && ref.ocurrencia !== 'CHEQUE') throw new Error('Ocurrencia de cheque inválida')
    const hoyIso = iso(new Date())
    let fecha = cambio.fecha
    if (fecha && fecha < hoyIso) throw new Error('No se proyecta en el pasado')
    // Mover el saldo de una factura = cambiar su fecha de pago programada (no el vencimiento).
    if (ref.origenTipo === 'FACTURA' && ref.ocurrencia === 'SALDO' && fecha && !cambio.eliminar) {
      const nueva = fecha
      this.e.facturas = this.e.facturas.map((f): Factura => (f.id === ref.origenId ? { ...f, fechaPago: nueva } : f))
      fecha = undefined
      if (cambio.importe === undefined) {
        this.log(u, { accion: 'FLUJO_MOVER', entidad: 'FACTURA', entidadId: ref.origenId, detalle: `Fecha de pago ${nueva} · ${motivo}` })
        this.commit()
        return
      }
    }
    const prev = this.t.ajustes.find((a) => !a.reemplazadoEn && a.origenTipo === ref.origenTipo && a.origenId === ref.origenId && a.ocurrencia === ref.ocurrencia)
    const ahora = new Date().toISOString()
    this.t.ajustes = [
      ...this.t.ajustes.map((a) => (a === prev ? { ...a, reemplazadoEn: ahora } : a)),
      {
        id: `aj${Date.now()}`, empresaId: empresa, origenTipo: ref.origenTipo, origenId: ref.origenId, ocurrencia: ref.ocurrencia,
        fechaNueva: fecha ?? (!cambio.eliminar ? prev?.fechaNueva : undefined),
        importeNuevo: cambio.importe !== undefined ? Math.abs(cambio.importe) : !cambio.eliminar ? prev?.importeNuevo : undefined,
        eliminada: !!cambio.eliminar, motivo, creadoPor: u.nombre, creadoEn: ahora,
      },
    ]
    this.log(u, { accion: cambio.eliminar ? 'FLUJO_ELIMINAR' : 'FLUJO_AJUSTAR', entidad: 'FLUJO', entidadId: ref.origenId, detalle: `${ref.ocurrencia} · ${fecha ?? ''} · ${cambio.importe ?? ''} · ${motivo}` })
    this.commit()
  }

  async restaurarLineaFlujo(ref: RefLinea, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN'])
    this.empresaDeLinea(ref)
    const ahora = new Date().toISOString()
    this.t.ajustes = this.t.ajustes.map((a) =>
      !a.reemplazadoEn && a.origenTipo === ref.origenTipo && a.origenId === ref.origenId && a.ocurrencia === ref.ocurrencia ? { ...a, reemplazadoEn: ahora } : a,
    )
    this.log(u, { accion: 'FLUJO_RESTAURAR', entidad: 'FLUJO', entidadId: ref.origenId, detalle: ref.ocurrencia })
    this.commit()
  }

  async crearProyeccion(p: NuevaProyeccion, u: Usuario): Promise<string> {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN'])
    const fila = this.t.filas.find((f) => f.id === p.filaId)
    const unidad = this.t.unidades.find((x) => x.id === p.unidadId)
    if (!fila || !unidad || fila.unidadId !== p.unidadId || unidad.empresaId !== p.empresaId) throw new Error('La fila no es de esa unidad o la unidad no es de esa empresa')
    if (!p.concepto.trim()) throw new Error('Falta el concepto')
    if (!p.importe) throw new Error('El importe no puede ser cero')
    if (p.recurrencia !== 'UNICA' && !p.hasta && !p.cuotas) throw new Error('Una proyección recurrente necesita "hasta" o cantidad de cuotas')
    if (p.recurrencia === 'MENSUAL' && !p.diaMes) throw new Error('Una proyección mensual necesita el día del mes')
    const id = `pr${Date.now()}`
    this.t.proyecciones = [...this.t.proyecciones, { ...p, id, estado: 'ACTIVA', creadoPor: u.nombre }]
    this.log(u, { accion: 'CREAR', entidad: 'PROYECCION', entidadId: id, detalle: `${p.concepto} · ${p.importe}` })
    this.commit()
    return id
  }

  async cancelarProyeccion(id: string, motivo: string, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'CONTROLLER', 'ADMIN'])
    if (!motivo.trim()) throw new Error('Falta el motivo')
    if (!this.t.proyecciones.some((p) => p.id === id)) throw new Error('Proyección inexistente')
    this.t.proyecciones = this.t.proyecciones.map((p) => (p.id === id ? { ...p, estado: 'CANCELADA', nota: [p.nota, motivo].filter(Boolean).join(' · ') } : p))
    this.log(u, { accion: 'CANCELAR', entidad: 'PROYECCION', entidadId: id, detalle: motivo })
    this.commit()
  }

  async definirPagoFactura(id: string, tipoPago: TipoPagoFactura, anticipoPct: number | null, unidadId: string | null, u: Usuario) {
    this.exigirRol(u, ['TESORERIA', 'ADMINISTRACION', 'ADMIN'])
    const f = this.e.facturas.find((x) => x.id === id)
    if (!f) throw new Error('Factura inexistente')
    if ((tipoPago === 'ANTICIPO_PARCIAL') !== (anticipoPct !== null)) throw new Error('El porcentaje va solo con "Anticipo % + Cta. Cte."')
    if (anticipoPct !== null && !(anticipoPct > 0 && anticipoPct < 100)) throw new Error('El anticipo tiene que estar entre 0 y 100 %')
    if (unidadId && !this.t.unidades.some((x) => x.id === unidadId && x.empresaId === f.empresaId)) throw new Error('La unidad es de otra empresa')
    this.e.facturas = this.e.facturas.map((x): Factura => (x.id === id ? { ...x, tipoPago, anticipoPct: anticipoPct ?? undefined, unidadId: unidadId ?? x.unidadId } : x))
    this.log(u, { accion: 'FORMA_PAGO', entidad: 'FACTURA', entidadId: id, detalle: `${tipoPago}${anticipoPct !== null ? ` ${anticipoPct} %` : ''}` })
    this.commit()
  }
}
