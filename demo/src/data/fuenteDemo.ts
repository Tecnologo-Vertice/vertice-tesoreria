// Modo demo: datos ficticios en memoria, persistidos en localStorage del navegador.
// Toda la lógica de negocio de acá tiene su equivalente en supabase/migrations/0003_funciones.sql.

import type { Auditoria, ComprobanteEjemplo, Documento, Factura, LecturaComprobante, Pago, Usuario } from '../types'
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
