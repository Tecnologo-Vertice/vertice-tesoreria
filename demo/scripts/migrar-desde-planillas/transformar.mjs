// Planillas → plan de carga, tabla por tabla. No toca ninguna base: arma registros con claves naturales
// (empresa, nombre de cuenta, unidad, etiqueta de fila) y lleva el control de cada fila de planilla:
//   planilla = a cargar + cubiertas (la base ya lo resuelve o lo trae otra fuente) + no mapeadas (con motivo).
// Lo que está fuera del alcance (otra fecha, filas de total, cheques ya pagados) se cuenta aparte.
import { hojas, celda, texto, vacia, norm, centavos, fecha, hora, clave, finDeMes, sumarMeses } from './leer.mjs'

export const MARCA = 'migracion-planillas'

// Pestaña del Flujo → empresa y unidad (código de la tabla unidades).
export const PESTANAS = {
  'Beratung S/Dax': { empresa: 'beratung', unidad: 'beratung' },
  'Dax Salud': { empresa: 'beratung', unidad: 'dax-salud' },
  'India': { empresa: 'india', unidad: 'india' },
  'Vertice': { empresa: 'vertice', unidad: 'vertice' },
}

// Cómo figura cada empresa en las planillas.
const EMPRESAS = [
  [/^BERATUNG/, 'beratung'], [/^INDIA/, 'india'], [/^VERTICE/, 'vertice'], [/^HECTOR ROBLES/, 'hrobles'],
  [/^(DROGUERIA ROBLES|DROG\.? ?ROBLES)/, 'robles'], [/^CONTROL B/, 'controlb'], [/^YSD/, 'ysd'], [/^FARMA ?CONTROL/, 'farmacontrol'],
]
export function empresaDe(t) {
  const s = norm(t)
  for (const [re, id] of EMPRESAS) if (re.test(s)) return id
  return null
}
// "BERATUNG/DAX" = las cuentas de Beratung que son de la unidad Dax Salud (Hipotecario, Brubank, Mercado Pago).
const unidadDeEtiqueta = (t, empresa) => (/^BERATUNG\s*\/\s*DAX/.test(norm(t)) ? 'dax-salud' : empresa)

const sinCodigo = (s) => String(s ?? '').replace(/^\s*\d{6,}\s+/, '').trim()
const conCodigo = (b, c) => [/^\d{6,}$/.test(String(b).trim()) ? String(b).trim() : '', c].filter(Boolean).join(' ').trim()
const SIGNO_POSITIVO = new Set(['INGRESOS_OPERATIVOS', 'INGRESOS_FINANCIEROS', 'TOMA_DEUDA'])

// T-206 · Fila de cheques de cada pestaña v2 para una categoría del Cash Flow (pestaña Categoría):
//   · P (proveedores) → la fila de cheques a proveedores de la pestaña ("Cheques ... insumos/proveedores", "E-checks emitidos").
//   · F… (financieras) → la fila "Cheques Financieras <X>" o "Pagaré <X>" cuyo <X> está en el nombre de algún acreedor
//     de esa categoría. Si la categoría es de pagarés (FP…) y hay fila de pagaré, gana esa. Sin nombres escritos acá:
//     sale de las planillas.
export const FILA_CHEQUES_PROVEEDORES = /^CHEQUES (INSUMOS|PROVEEDORES)|^E-CHECKS EMITIDOS|CHEQUES A PROVEEDORES/
export function filaDeCheques(cat, acreedoresDeCat, filas) {
  if (cat === 'P') return filas.find((x) => FILA_CHEQUES_PROVEEDORES.test(norm(x.etiqueta))) ?? null
  const cand = filas.map((x) => {
    const m = /^(CHEQUES FINANCIERAS|PAGARE)\s+(.+)$/.exec(norm(x.etiqueta))
    return m ? { fila: x, pagare: m[1] === 'PAGARE', clave: m[2].trim() } : null
  }).filter((x) => x && acreedoresDeCat.some((a) => norm(a).includes(x.clave)))
  if (!cand.length) return null
  const pag = /^FP/.test(cat) ? cand.filter((x) => x.pagare) : cand.filter((x) => !x.pagare)
  const lista = pag.length ? pag : cand
  return lista.length === 1 ? lista[0].fila : null
}

export function seccionDe(t) {
  const s = norm(t).replace(/^\d+\.\s*/, '')
  if (/^INGRESOS OPERATIVOS/.test(s)) return 'INGRESOS_OPERATIVOS'
  if (/^COSTOS/.test(s)) return 'COSTOS'
  if (/^GASTOS OPERATIVOS/.test(s)) return 'GASTOS_OPERATIVOS'
  if (/GANANCIAS|CAPEX/.test(s)) return 'CAPEX'
  if (/^IMPUESTOS/.test(s)) return 'IMPUESTOS'
  if (/^INGRESOS FINANCIEROS/.test(s)) return 'INGRESOS_FINANCIEROS'
  if (/^TOMA DE DEUDA/.test(s)) return 'TOMA_DEUDA'
  if (/^DEVOLUCION DE DEUDA/.test(s)) return 'DEVOLUCION_DEUDA'
  if (/^SOCIOS/.test(s)) return 'SOCIOS'
  if (/^INTERCOMPANY/.test(s)) return 'INTERCOMPANY'
  return null
}

// ---------------------------------------------------------------- Control

export class Control {
  constructor() { this.tablas = {} }
  t(tabla) {
    return (this.tablas[tabla] ??= { planilla: {}, cargar: {}, cubiertas: {}, noMapeadas: [], motivosCubiertas: {}, fuera: {}, avisos: [], fuentes: new Set() })
  }
  #sumar(bucket, emp, imp) {
    const e = (bucket[emp ?? '(sin empresa)'] ??= { filas: 0, suma: 0n })
    e.filas++; e.suma += imp ?? 0n
  }
  fuente(tabla, f) { this.t(tabla).fuentes.add(f) }
  planilla(tabla, emp, imp) { this.#sumar(this.t(tabla).planilla, emp, imp) }
  cargar(tabla, emp, imp) { this.#sumar(this.t(tabla).cargar, emp, imp) }
  cubierta(tabla, emp, imp, motivo) {
    const t = this.t(tabla); this.#sumar(t.cubiertas, emp, imp); t.motivosCubiertas[motivo] = (t.motivosCubiertas[motivo] ?? 0) + 1
  }
  noMapeada(tabla, emp, imp, ref, motivo) {
    const t = this.t(tabla); t.noMapeadas.push({ empresa: emp ?? '(sin empresa)', importe: imp ?? 0n, ref, motivo })
  }
  fuera(tabla, motivo, n = 1) { const t = this.t(tabla); t.fuera[motivo] = (t.fuera[motivo] ?? 0) + n }
  aviso(tabla, txt) { this.t(tabla).avisos.push(txt) }
}

// ---------------------------------------------------------------- Transformación

/**
 * @param planillas { vbi, motor, original, cashflow }: respuestas de spreadsheets.get
 * @param op { hoy: 'AAAA-MM-DD', desde: 'AAAA-MM-DD', horizonte: 'AAAA-MM-DD' }
 */
export function transformar(planillas, op) {
  const V = hojas(planillas.vbi), M = hojas(planillas.motor), O = hojas(planillas.original), C = hojas(planillas.cashflow)
  const ctl = new Control()
  const plan = {
    cuentas_origen: [], reglas_extracto: [], feriados: [], flujo_filas: [], flujo_reglas: [], proyecciones: [], flujo_ajustes: [],
    acreedores: [], cheques: [], saldos_bancarios: [], movimientos_bancarios: [], cobros: [], lecturas_xubio: [],
    percepciones_iibb: [], procesos_log: [],
  }
  const hoja = (mapa, nombre, planilla) => {
    const h = mapa.get(nombre)
    if (!h) throw new Error(`Falta la pestaña "${nombre}" en ${planilla}`)
    return h
  }

  // ============================================================ cuentas_origen
  const cuentas = plan.cuentas_origen
  const T = 'cuentas_origen'
  ctl.fuente(T, 'VBI+ › Cuentas_Extracto'); ctl.fuente(T, 'Motor › Cuentas Bancarias (unidad, cuenta de Xubio, patrones)')
  const ce = hoja(V, 'Cuentas_Extracto', 'VBI+')
  ce.slice(1).forEach((f, i) => {
    const etiqueta = texto(f, 0), banco = texto(f, 1), sub = texto(f, 2), tipo = norm(texto(f, 3)), filaFlujo = texto(f, 4)
    if (!etiqueta) { ctl.fuera(T, 'fila de nota (sin empresa)'); return }
    const emp = empresaDe(etiqueta)
    ctl.planilla(T, emp)
    const ref = `Cuentas_Extracto fila ${i + 2} · ${sub}`
    if (!emp) return ctl.noMapeada(T, null, 0n, ref, `empresa "${etiqueta}" desconocida`)
    if (/\[FALTA/i.test(sub)) return ctl.noMapeada(T, emp, 0n, ref, '[FALTA] en la planilla: no se sabe cuál es la cuenta')
    const n = norm(sub)
    const clase = /REMUNERADA/.test(n) ? 'REMUNERADA' : tipo === 'FCI' || /\bFCI\b/.test(n) ? 'FCI'
      : /^(MP|MERCADO PAGO)/.test(n) || norm(banco) === 'MP' ? 'BILLETERA' : tipo === 'CA' || /\bCA\b/.test(n) ? 'CA' : 'CC'
    const numero = (/(\d[\d\-/]{3,})\s*$/.exec(sub) ?? [])[1] ?? null
    const c = {
      empresa: emp, unidad: unidadDeEtiqueta(etiqueta, emp), nombre: sub.trim(), banco: norm(banco), clase, numero,
      rinde_diario: clase === 'REMUNERADA' || clase === 'BILLETERA', requiere_extracto: true, es_base: tipo === 'BASE',
      patrones: new Set([n, norm(filaFlujo), norm(sinCodigo(filaFlujo))].filter(Boolean)), cuenta_xubio: null, madre: null,
      orden: (i + 1) * 10, chequera: false,
    }
    cuentas.push(c)
    ctl.cargar(T, emp)
  })
  // Cuenta madre: la cuenta corriente/caja del mismo banco y empresa (prefiere la BASE).
  for (const c of cuentas) {
    if (!['FCI', 'REMUNERADA'].includes(c.clase)) continue
    const m = cuentas.filter((x) => x.empresa === c.empresa && x.banco === c.banco && ['CC', 'CA', 'BILLETERA'].includes(x.clase))
      .sort((a, b) => (b.unidad === c.unidad) - (a.unidad === c.unidad) || b.es_base - a.es_base)[0]
    if (m) c.madre = m.nombre
    else ctl.aviso(T, `${c.empresa} · ${c.nombre}: sin cuenta madre en el mismo banco (queda vacía)`)
  }
  // Cuentas Bancarias del Motor: unidad (pestaña), cuenta de Xubio y patrones del texto del banco.
  const patronesBanco = [] // [{empresa, patron, cuenta}] en el orden de la planilla (lo más específico primero)
  const porCuentaXubio = {} // empresa|cuenta de Xubio → cuentas bancarias que la usan
  const cb = hoja(M, 'Cuentas Bancarias', 'Motor')
  cb.slice(1).forEach((f, i) => {
    const patron = norm(texto(f, 0)), pest = texto(f, 1), filaSaldo = texto(f, 2), cxubio = texto(f, 3), empTxt = texto(f, 5)
    if (!patron || !PESTANAS[pest]) return
    const emp = empTxt ? empresaDe(empTxt) : 'beratung'
    const objetivo = norm(filaSaldo)
    const cand = cuentas.filter((c) => c.empresa === emp)
    const c = cand.find((x) => x.patrones.has(objetivo) || x.patrones.has(norm(sinCodigo(filaSaldo))))
      ?? cand.find((x) => norm(x.nombre).includes(patron))
    if (!c) { ctl.aviso(T, `Cuentas Bancarias fila ${i + 2} (${patron}): no coincide con ninguna cuenta de Cuentas_Extracto`); return }
    patronesBanco.push({ empresa: emp, patron, cuenta: c })
    if (cxubio) (porCuentaXubio[`${emp}|${norm(cxubio)}`] ??= { texto: cxubio.trim(), cuentas: new Set() }).cuentas.add(c)
    if (filaSaldo) c.patrones.add(norm(filaSaldo))
    const u = PESTANAS[pest].unidad
    if (PESTANAS[pest].empresa === emp && u !== c.unidad) {
      ctl.aviso(T, `${c.nombre}: Cuentas_Extracto la pone en ${c.unidad} y Cuentas Bancarias en ${u} (queda ${u}, la del Motor)`)
      c.unidad = u
    }
  })

  // La cuenta de Xubio es alias solo si es de UNA cuenta bancaria (Xubio junta todos los FCI en una sola cuenta).
  for (const { texto: tx, cuentas: cs } of Object.values(porCuentaXubio)) {
    if (cs.size === 1) { const [c] = cs; c.patrones.add(norm(tx)); c.cuenta_xubio ??= tx }
    else ctl.aviso(T, `La cuenta de Xubio "${tx}" es de ${cs.size} cuentas bancarias (${[...cs].map((c) => c.nombre).join(', ')}): no se usa como alias`)
  }

  /** La cuenta de un texto de banco. estricto = solo coincidencia exacta con el nombre o un alias. */
  function cuentaDe(emp, txt, { estricto = false } = {}) {
    const n = norm(txt)
    if (!emp || !n) return null
    const cand = cuentas.filter((c) => c.empresa === emp && !c.chequera)
    const exactas = cand.filter((c) => norm(c.nombre) === n || c.patrones.has(n))
    if (exactas.length) return exactas.sort((a, b) => b.es_base - a.es_base)[0]
    if (estricto) return null
    const porBanco = cand.filter((c) => c.banco === n)
    if (porBanco.length) return porBanco.sort((a, b) => b.es_base - a.es_base)[0]
    const p = patronesBanco.find((x) => x.empresa === emp && n.includes(x.patron))
    if (p) return p.cuenta
    const contenida = cand.filter((c) => n.includes(norm(c.nombre)) || norm(c.nombre).includes(n))
    return contenida.length === 1 ? contenida[0] : null
  }
  /** Chequera para cheques de un banco donde la empresa no tiene cuenta cargada (se crea marcada). */
  function chequera(emp, banco) {
    const nombre = `CHEQUERA ${norm(banco)}`
    let c = cuentas.find((x) => x.empresa === emp && x.nombre === nombre)
    if (!c) {
      c = { empresa: emp, unidad: emp, nombre, banco: norm(banco), clase: 'ECHEQ', numero: null, rinde_diario: false, requiere_extracto: false,
        es_base: false, patrones: new Set([nombre]), cuenta_xubio: null, madre: null, orden: 900, chequera: true }
      cuentas.push(c)
      ctl.fuente(T, 'Cash Flow › CHEQUES EMITIDOS (chequeras de bancos sin cuenta cargada)')
      ctl.planilla(T, emp); ctl.cargar(T, emp)
      ctl.aviso(T, `${emp} · ${nombre}: chequera creada para los cheques del Cash Flow (no hay cuenta de ese banco en Cuentas_Extracto) · a confirmar`)
    }
    return c
  }

  // ============================================================ reglas_extracto
  {
    const T = 'reglas_extracto'; ctl.fuente(T, 'VBI+ › Extractos_Reglas')
    hoja(V, 'Extractos_Reglas', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      ctl.planilla(T, null)
      const orden = Number(texto(f, 0)), patrones = texto(f, 1).split('|').map((x) => x.trim()).filter(Boolean)
      if (!Number.isInteger(orden) || !patrones.length) return ctl.noMapeada(T, null, 0n, `Extractos_Reglas fila ${i + 2}`, 'sin orden o sin patrones')
      const cta = texto(f, 4), m = /^([A-Z0-9_]*_[A-Z0-9_]*)\s+(.+)$/.exec(cta)
      plan.reglas_extracto.push({ orden, patrones, sentido: norm(texto(f, 2)) || 'AMBOS', categoria: norm(texto(f, 3)).replace(/\s/g, '_'),
        cuenta_contable: m ? m[2].trim() : cta || null, nota: texto(f, 5) || null })
      ctl.cargar(T, null)
    })
  }

  // ============================================================ flujo_filas (pestañas v2)
  const filasPorUnidad = {} // unidad → [{...fila, filaPlanilla}]
  {
    const T = 'flujo_filas'
    for (const [pest, { empresa, unidad }] of Object.entries(PESTANAS)) {
      const h = hoja(M, `${pest} v2`, 'Motor')
      ctl.fuente(T, `Motor › ${pest} v2`)
      const lista = (filasPorUnidad[unidad] = [])
      const vistas = new Set()
      let seccion = 'SIN_CLASIFICAR'
      h.forEach((f, i) => {
        if (i < 2) return
        const tipo = norm(texto(f, 0)), cod = texto(f, 1), cuenta = texto(f, 2), apertura = texto(f, 3)
        let etiqueta = texto(f, 5) || [cuenta, apertura].filter(Boolean).join(' - ')
        const fila = i + 1
        if (tipo === 'SECCION' || tipo === 'SECCIÓN'.normalize('NFD').replace(/[̀-ͯ]/g, '')) {
          seccion = seccionDe(etiqueta) ?? seccion
          ctl.planilla(T, empresa)
          lista.push({ empresa, unidad, tipo: 'SECCION', seccion, etiqueta, cuenta_contable: null, apertura: null, codigo: null, mueve_caja: true, orden: fila * 10, fila })
          ctl.cargar(T, empresa)
          return
        }
        const esFciInterno = tipo === 'SALDO' && /RESCATE|SUSCRIPCION/.test(norm(apertura))
        if (['TOTAL', 'MEMO', 'SACAR', ''].includes(tipo) || (tipo === 'SALDO' && !esFciInterno)) {
          ctl.fuera(T, tipo === 'SALDO' ? 'fila SALDO (saldo de banco: va a cuentas y saldos)' : tipo ? `fila ${tipo}` : 'fila vacía')
          return
        }
        ctl.planilla(T, empresa)
        if (!etiqueta) return ctl.noMapeada(T, empresa, 0n, `${pest} v2 fila ${fila}`, 'fila sin etiqueta')
        if (vistas.has(norm(etiqueta))) {
          ctl.aviso(T, `${pest} v2 fila ${fila}: etiqueta repetida "${etiqueta}" → se carga como "${etiqueta} (fila ${fila})"`)
          etiqueta = `${etiqueta} (fila ${fila})`
        }
        vistas.add(norm(etiqueta))
        lista.push({
          empresa, unidad, etiqueta, fila, orden: fila * 10, codigo: cod || null,
          tipo: tipo === 'APERTURA' ? 'APERTURA' : tipo === 'INTERNO' || esFciInterno ? 'INTERNO' : 'CUENTA',
          seccion, cuenta_contable: cuenta || null, apertura: apertura || null, mueve_caja: !esFciInterno,
        })
        ctl.cargar(T, empresa)
      })
      plan.flujo_filas.push(...lista)
    }
  }
  // Código de Xubio → nombre de la cuenta (de las v2).
  const nombreDeCodigo = new Map()
  for (const f of plan.flujo_filas) if (f.codigo && f.cuenta_contable) nombreDeCodigo.set(norm(f.codigo), f.cuenta_contable)

  /** La fila de una unidad para una etiqueta del Flujo original, de Gastos Fijos o del Mapa. */
  function filaDe(unidad, etiqueta) {
    const lista = (filasPorUnidad[unidad] ?? []).filter((f) => f.tipo !== 'SECCION')
    const n = norm(etiqueta), ns = norm(sinCodigo(etiqueta))
    if (!n) return null
    return lista.find((f) => norm(f.etiqueta) === n)
      ?? lista.find((f) => norm(sinCodigo(f.etiqueta)) === ns)
      ?? lista.find((f) => norm(f.apertura) === ns)
      ?? (() => { const c = ns.length >= 6 ? lista.filter((f) => norm(f.etiqueta).includes(ns)) : []; return c.length === 1 ? c[0] : null })()
  }
  const SIN_CLASIFICAR = 'Sin clasificar'

  // ============================================================ feriados + flujo_reglas (Mapa Flujo)
  {
    const T = 'flujo_reglas'
    ctl.fuente(T, 'Motor › Mapa Flujo'); ctl.fuente(T, 'Motor › Llave Flujo v2')
    ctl.fuente('feriados', 'Motor › Mapa Flujo (TIPO = FERIADO)')
    const prioridad = { CUENTA: 10, PROVEEDOR: 20, DETALLE: 30, CATEGORIA: 40 }
    hoja(M, 'Mapa Flujo', 'Motor').slice(1).forEach((f, i) => {
      const tipo = norm(texto(f, 0)), valor = texto(f, 2), pest = texto(f, 3), etiqueta = texto(f, 4), nota = texto(f, 5)
      if (!tipo || !valor) return
      const ref = `Mapa Flujo fila ${i + 2} · ${tipo} ${valor}`
      if (tipo === 'FERIADO') {
        ctl.planilla('feriados', null)
        const d = fecha(celda(f, 2))
        if (!d) return ctl.noMapeada('feriados', null, 0n, ref, 'fecha ilegible')
        plan.feriados.push({ fecha: d, nombre: 'Feriado (Mapa Flujo)' }); ctl.cargar('feriados', null)
        return
      }
      const emp = empresaDe(texto(f, 1))
      ctl.planilla(T, emp)
      if (tipo === 'BANCO') return ctl.cubierta(T, emp, 0n, 'BANCO: es la unidad de la cuenta bancaria (cuentas_origen.unidad_id)')
      if (!prioridad[tipo]) return ctl.noMapeada(T, emp, 0n, ref, `tipo ${tipo} sin equivalente`)
      if (pest === '(banco)') return ctl.cubierta(T, emp, 0n, '"(banco)": la regla general ya pone la cuenta en la fila de la unidad del banco')
      const pe = PESTANAS[pest]
      if (!pe || pe.empresa !== emp) return ctl.noMapeada(T, emp, 0n, ref, `pestaña "${pest}" desconocida o de otra empresa`)
      const fila = filaDe(pe.unidad, etiqueta)
      if (!fila) return ctl.noMapeada(T, emp, 0n, ref, `la fila "${etiqueta}" no existe en ${pest} v2`)
      plan.flujo_reglas.push({
        clave: clave('MAPA', tipo, emp, valor), empresa: emp, prioridad: prioridad[tipo] * 100 - Math.min(valor.length, 99),
        si_origen: null, si_cuenta_contable: tipo === 'CUENTA' ? valor : null, si_texto: tipo === 'CUENTA' ? null : valor, si_categoria: null,
        unidad: pe.unidad, fila: fila.etiqueta, excluir: false, nota: `Mapa Flujo · ${tipo} ${valor}${nota ? ' · ' + nota : ''}`,
      })
      ctl.cargar(T, emp)
    })

    // Llave Flujo v2: las decisiones del estudio y las transferencias propias pasan a reglas (proveedor + cuenta → fila).
    const reglasLlave = new Map()
    const CUBIERTAS = {
      'REGLA DEL MAPA': 'la resuelve la regla del Mapa Flujo',
      'PRODUCTO DE LA FACTURA': 'regla general: fila de la cuenta contable',
      'CUENTA ASIGNADA (VBI+)': 'regla general: fila de la cuenta contable',
      'EXTRACTO BANCARIO': 'regla general: fila de la cuenta contable del movimiento',
      'SIN CLASIFICAR': 'sin regla: en la base también cae en "Sin clasificar"',
    }
    hoja(M, 'Llave Flujo v2', 'Motor').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const tipo = norm(texto(f, 1)), pest = texto(f, 2), prov = texto(f, 5), cod = norm(texto(f, 6)), filaV2 = Number(texto(f, 8)), origen = norm(texto(f, 9))
      const pe = PESTANAS[pest], emp = pe?.empresa ?? null, imp = 0n // flujo_reglas no suma importes
      ctl.planilla(T, emp)
      const ref = `Llave Flujo v2 fila ${i + 2} · ${pest} · ${prov} · ${cod}`
      if (!pe) return ctl.noMapeada(T, emp, 0n, ref, `pestaña "${pest}" desconocida`)
      if (CUBIERTAS[origen]) return ctl.cubierta(T, emp, 0n, CUBIERTAS[origen])
      if (cod === 'SIN_CUENTA') return ctl.cubierta(T, emp, 0n, CUBIERTAS['SIN CLASIFICAR'])
      if (!['REGLA DEL ESTUDIO', 'TRANSFERENCIA PROPIA', 'EXTRACTO (REGLA DEL ESTUDIO)', 'PRESTADOR PAGADO DESDE DAX (CRITERIO FLUJO REAL)'].includes(origen))
        return ctl.noMapeada(T, emp, imp, ref, `criterio "${texto(f, 9)}" sin equivalente en la base`)
      if (!prov) return ctl.noMapeada(T, emp, imp, ref, 'sin proveedor ni texto para reconocerla')
      const excluir = cod === 'EXCLUIDO'
      let fila = null
      if (!excluir) {
        const v2 = (filasPorUnidad[pe.unidad] ?? []).find((x) => x.fila === filaV2)
        if (!v2 || v2.tipo === 'SECCION') return ctl.noMapeada(T, emp, imp, ref, `la fila ${texto(f, 8) || '(vacía)'} de ${pest} v2 no es una fila de cuenta`)
        fila = v2.etiqueta
      }
      const cuenta = excluir ? null : nombreDeCodigo.get(cod) ?? null
      if (!excluir && !cuenta) return ctl.noMapeada(T, emp, imp, ref, `código ${cod} sin cuenta en las v2`)
      const origenBase = tipo.startsWith('BANCO') || origen.startsWith('EXTRACTO') ? 'MOVIMIENTO' : excluir ? 'PAGO' : null
      const k = clave('LLAVE', emp, norm(prov), excluir ? 'EXCLUIDO' : cuenta, origenBase ?? '')
      const r = reglasLlave.get(k)
      if (r && !excluir && (r.fila !== fila || r.unidad !== pe.unidad)) { r.conflicto = true; r.refs.push(ref); return }
      if (r) { r.refs.push(ref); return }
      reglasLlave.set(k, { clave: k, empresa: emp, prioridad: excluir ? 1 : 5, si_origen: origenBase, si_cuenta_contable: cuenta, si_texto: prov,
        si_categoria: null, unidad: pe.unidad, fila, excluir, nota: `Llave Flujo v2 · ${texto(f, 9)} · ${prov}`, refs: [ref] })
    })
    for (const r of reglasLlave.values()) {
      if (r.conflicto) { for (const ref of r.refs) ctl.noMapeada(T, r.empresa, 0n, ref, 'el mismo proveedor y cuenta van a filas distintas en la Llave: decidir'); continue }
      plan.flujo_reglas.push(r)
      for (let j = 0; j < r.refs.length; j++) ctl.cargar(T, r.empresa)
    }
    ctl.aviso(T, `Llave Flujo v2 → ${[...reglasLlave.values()].filter((r) => !r.conflicto).length} reglas (proveedor + cuenta → fila); la cuenta "a cargar" de arriba cuenta filas de la Llave, no reglas`)

    // T-206 · Destino de los cheques por categoría del acreedor (Cash Flow › Categoría) y unidad: las filas
    // "(circuito de cheques)" de cada pestaña v2. Sin esto, un cheque sin pago vinculado cae en "Sin clasificar".
    if (op.correcciones !== false) {
      ctl.fuente(T, 'Cash Flow › Categoría (categorías de cheques) × filas "(circuito de cheques)" de las v2')
      const porCat = new Map() // categoría → nombres de acreedores
      hoja(C, 'Categoría', 'Cash Flow').slice(2).forEach((f) => {
        const nombre = texto(f, 2), cat = norm(texto(f, 3))
        if (nombre && /^(P|F[A-Z]*)$/.test(cat)) (porCat.get(cat) ?? porCat.set(cat, []).get(cat)).push(nombre)
      })
      for (const [pest, { empresa, unidad }] of Object.entries(PESTANAS)) {
        const lista = (filasPorUnidad[unidad] ?? []).filter((x) => x.tipo !== 'SECCION')
        for (const [cat, nombres] of porCat) {
          ctl.planilla(T, empresa)
          const fila = filaDeCheques(cat, nombres, lista)
          const ref = `cheques ${cat} · ${pest}`
          if (!fila) { if (cat === 'P') ctl.noMapeada(T, empresa, 0n, ref, `[FALTA] ${pest} v2 no tiene fila de cheques a proveedores`); else ctl.cubierta(T, empresa, 0n, 'la pestaña no tiene una fila única para esa categoría de cheques'); continue }
          plan.flujo_reglas.push({ clave: clave('CHEQUE', unidad, cat), empresa, prioridad: 50, si_origen: 'CHEQUE', si_cuenta_contable: null, si_texto: null,
            si_categoria: cat, si_unidad: unidad, unidad, fila: fila.etiqueta, excluir: false, nota: `Cheques categoría ${cat} · ${pest} → ${fila.etiqueta}` })
          ctl.cargar(T, empresa)
        }
      }
    }
  }

  // ============================================================ proyecciones (Gastos Fijos, Proyecciones, Flujo original)
  const proyPorClave = new Map()
  {
    const T = 'proyecciones'
    ctl.fuente(T, 'Motor › Gastos Fijos (mensuales)'); ctl.fuente(T, 'VBI+ › Proyecciones'); ctl.fuente(T, 'Flujo original › celdas cargadas a mano desde hoy')
    const cobertura = new Map() // unidad|etiqueta|AAAA-MM → cuántas ocurrencias de Gastos Fijos hay ese mes (desde hoy)
    const ultimaFechaOriginal = new Map() // unidad|etiqueta → última fecha con valor en el original
    const original = leerOriginal(O)
    for (const c of original.celdas) {
      const k = `${c.unidad}|${norm(sinCodigo(c.etiqueta))}`
      if (!ultimaFechaOriginal.has(k) || ultimaFechaOriginal.get(k) < c.fecha) ultimaFechaOriginal.set(k, c.fecha)
    }

    // Gastos Fijos → MENSUAL
    hoja(M, 'Gastos Fijos', 'Motor').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const activo = norm(texto(f, 0)), pest = texto(f, 1), etiqueta = texto(f, 2), dia = Number(celda(f, 4).n ?? texto(f, 4))
      const pe = PESTANAS[pest], emp = pe?.empresa ?? null, imp = centavos(celda(f, 3))
      const ref = `Gastos Fijos fila ${i + 2} · ${pest} · ${etiqueta}`
      if (activo !== 'SI') { ctl.fuera(T, 'Gastos Fijos inactivo'); return }
      const fila = pe ? filaDe(pe.unidad, etiqueta) : null
      const signo = SIGNO_POSITIVO.has(fila?.seccion) ? 1n : -1n
      const importe = imp === null ? null : signo * (imp < 0n ? -imp : imp)
      ctl.planilla(T, emp, importe)
      if (!pe) return ctl.noMapeada(T, emp, importe, ref, `pestaña "${pest}" desconocida`)
      if (!imp) return ctl.noMapeada(T, emp, importe, ref, 'sin importe')
      if (!(dia >= 1 && dia <= 31)) return ctl.noMapeada(T, emp, importe, ref, 'día del mes inválido')
      const desde = fecha(celda(f, 5)) ?? op.hoy
      if (!fila) ctl.aviso(T, `${ref}: la fila no existe en la v2 → va a "Sin clasificar" (a reubicar)`)
      const esPfp = /^PFP\b/i.test(etiqueta)
      let hasta = fecha(celda(f, 6)), notaHasta = ''
      if (!hasta && esPfp) {
        hasta = finDePlan(etiqueta)
        const ult = ultimaFechaOriginal.get(`${pe.unidad}|${norm(sinCodigo(etiqueta))}`)
        if (hasta && ult && ult > hasta) {
          ctl.aviso(T, `${ref}: el rótulo dice que termina el ${hasta} pero el Flujo original lo proyecta hasta el ${ult} → se usa ${ult} · a confirmar`)
          hasta = ult; notaHasta = ' · hasta según el Flujo original'
        }
        if (hasta && hasta < op.hoy) ctl.aviso(T, `${ref}: el plan ya terminó (${hasta}): no genera líneas`)
      }
      if (!hasta) { hasta = op.horizonte; notaHasta = ` · sin HASTA en la planilla: horizonte ${op.horizonte} (a confirmar)` }
      const p = {
        clave: clave('GF', pest, etiqueta, dia), empresa: emp, unidad: pe.unidad, fila: fila?.etiqueta ?? SIN_CLASIFICAR, concepto: etiqueta,
        importe, fecha_inicio: desde, recurrencia: 'MENSUAL', dia_mes: dia, hasta, cuotas: null,
        origen: esPfp ? 'PLAN_PAGO' : /SUELDO/i.test(etiqueta) ? 'SUELDOS' : 'GASTO_FIJO',
        nota: `Gastos Fijos fila ${i + 2}${texto(f, 7) ? ' · ' + texto(f, 7) : ''}${notaHasta}`,
      }
      plan.proyecciones.push(p); proyPorClave.set(p.clave, p)
      ctl.cargar(T, emp, importe)
      // Qué meses cubre desde hoy (para no duplicar con las celdas del original).
      let [a, m] = desde.split('-').map(Number)
      for (let n = 0; n < 400; n++) {
        const [aa, mm] = sumarMeses(a, m, n)
        const d = `${aa}-${String(mm).padStart(2, '0')}-${String(Math.min(dia, +finDeMes(aa, mm).slice(8))).padStart(2, '0')}`
        if (d > hasta || d > op.horizonte) break
        if (d < desde || d < op.hoy) continue
        const k = `${pe.unidad}|${norm(sinCodigo(p.concepto))}|${d.slice(0, 7)}`
        if (!cobertura.has(k)) cobertura.set(k, [])
        cobertura.get(k).push({ fecha: d, importe })
      }
    })

    // Proyecciones de VBI+ (hoy vacía; se lee igual para cuando tenga filas).
    hoja(V, 'Proyecciones', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const emp = empresaDe(texto(f, 1)), imp = centavos(celda(f, 5))
      ctl.planilla(T, emp, imp)
      const pe = Object.values(PESTANAS).find((x) => x.empresa === emp)
      const ref = `Proyecciones fila ${i + 2} · ${texto(f, 3)}`
      if (!emp || !pe) return ctl.noMapeada(T, emp, imp, ref, 'empresa desconocida')
      const estado = norm(texto(f, 11)) || 'ACTIVA'
      if (estado !== 'ACTIVA') return ctl.cubierta(T, emp, imp, `estado ${estado}`)
      const fila = filaDe(pe.unidad, texto(f, 2))
      const rec = norm(texto(f, 7)) || 'UNICA', d0 = fecha(celda(f, 6))
      if (!imp || !d0) return ctl.noMapeada(T, emp, imp, ref, 'sin importe o sin fecha')
      const p = { clave: clave('PROY', texto(f, 0) || `${i}`), empresa: emp, unidad: pe.unidad, fila: fila?.etiqueta ?? SIN_CLASIFICAR, concepto: texto(f, 3),
        importe: imp, fecha_inicio: d0, recurrencia: ['UNICA', 'SEMANAL', 'QUINCENAL', 'MENSUAL'].includes(rec) ? rec : 'UNICA',
        dia_mes: rec === 'MENSUAL' ? +d0.slice(8) : null, hasta: fecha(celda(f, 8)) ?? (rec === 'UNICA' ? null : op.horizonte),
        cuotas: Number(texto(f, 9)) || null, ajuste_pct: texto(f, 10) || '0', origen: 'MANUAL', nota: `Proyecciones (VBI+) ${texto(f, 0)}` }
      plan.proyecciones.push(p); proyPorClave.set(p.clave, p); ctl.cargar(T, emp, imp)
    })

    // Flujo original: cada celda cargada a mano desde hoy que no cubre un Gasto Fijo → proyección única.
    // Cada ocurrencia de un Gasto Fijo en el mes cubre UNA celda de esa fila: la del mismo importe o, si no hay,
    // la de fecha más cercana. Las demás celdas del mes se cargan.
    const futuras = original.celdas.filter((c) => c.fecha >= op.hoy)
    const cubiertas = new Set()
    const dias = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000
    for (const [k, ocurrencias] of cobertura) {
      const libres = futuras.filter((c) => `${c.unidad}|${norm(sinCodigo(c.etiqueta))}|${c.fecha.slice(0, 7)}` === k)
      for (const o of ocurrencias) {
        const cand = libres.filter((c) => !cubiertas.has(c))
          .sort((a, b) => (a.importe !== o.importe) - (b.importe !== o.importe) || dias(a.fecha, o.fecha) - dias(b.fecha, o.fecha))[0]
        if (cand) cubiertas.add(cand)
      }
    }
    for (const c of futuras) {
      ctl.planilla(T, c.empresa, c.importe)
      if (cubiertas.has(c)) {
        ctl.cubierta(T, c.empresa, c.importe, 'el mes ya lo proyecta un Gasto Fijo (mensual)')
        continue
      }
      const fila = filaDe(c.unidad, c.etiqueta)
      if (!fila) ctl.aviso(T, `${c.pestana} fila ${c.fila} "${c.etiqueta}": no está en la v2 → va a "Sin clasificar" (a reubicar)`)
      const p = {
        clave: clave('ORIG', c.pestana, c.etiqueta, c.fecha), empresa: c.empresa, unidad: c.unidad, fila: fila?.etiqueta ?? SIN_CLASIFICAR,
        concepto: c.etiqueta, importe: c.importe, fecha_inicio: c.fecha, recurrencia: 'UNICA', dia_mes: null, hasta: null, cuotas: null,
        origen: /^PFP\b|MIS FACILIDADES/i.test(c.etiqueta) ? 'PLAN_PAGO' : c.seccion === 'INGRESOS_OPERATIVOS' ? 'COBRANZA' : /SUELDO/i.test(c.etiqueta) ? 'SUELDOS' : 'MANUAL',
        nota: `Flujo original · ${c.pestana} fila ${c.fila} · ${c.fecha}`, pestana: c.pestana, celda: c.importe,
      }
      plan.proyecciones.push(p); proyPorClave.set(p.clave, p)
      ctl.cargar(T, c.empresa, c.importe)
    }
    for (const [motivo, n] of Object.entries(original.fuera)) ctl.fuera(T, motivo, n)

    // ============================================================ flujo_ajustes (Flujo_Cambios_Manuales)
    const TA = 'flujo_ajustes'; ctl.fuente(TA, 'VBI+ › Flujo_Cambios_Manuales')
    const grupos = new Map()
    hoja(V, 'Flujo_Cambios_Manuales', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const k = `${texto(f, 2)}|${norm(sinCodigo(texto(f, 4)))}|${fecha(celda(f, 5))}`
      if (!grupos.has(k)) grupos.set(k, [])
      grupos.get(k).push({ f, fila: i + 2 })
    })
    for (const lista of grupos.values()) {
      const { f, fila } = lista[lista.length - 1]
      const pest = texto(f, 2), pe = PESTANAS[pest], emp = pe?.empresa ?? null
      const accion = norm(texto(f, 6)), antes = centavos(celda(f, 7)) ?? 0n, despues = centavos(celda(f, 8)) ?? 0n, dia = fecha(celda(f, 5))
      const ref = `Flujo_Cambios_Manuales fila ${fila} · ${pest} · ${texto(f, 4)} · ${dia} · ${accion}`
      for (let j = 0; j < lista.length - 1; j++) { ctl.planilla(TA, emp, 0n); ctl.cubierta(TA, emp, 0n, 'cambio intermedio: vale el último del mismo día y fila') }
      ctl.planilla(TA, emp, 0n)
      const primero = centavos(celda(lista[0].f, 7)) ?? 0n
      if (accion === 'REVERSION' && despues === primero) { ctl.cubierta(TA, emp, 0n, 'revertido: quedó el valor original'); continue }
      if (!pe) { ctl.noMapeada(TA, emp, 0n, ref, `pestaña "${pest}" desconocida`); continue }
      if (accion === 'ELIMINAR' && antes === 0n) { ctl.cubierta(TA, emp, 0n, 'fila sin importe (plan cancelado): no hay nada que eliminar'); continue }
      const p = [...proyPorClave.values()].find((x) => x.pestana === pest && x.fecha_inicio === dia &&
        (norm(sinCodigo(x.concepto)) === norm(sinCodigo(texto(f, 4))) || norm(x.concepto) === norm(texto(f, 4))))
      if (!p) { ctl.noMapeada(TA, emp, 0n, ref, 'no hay una proyección del Flujo original en esa fila y día'); continue }
      const actual = p.celda < 0n ? -p.celda : p.celda
      if (accion === 'EDITAR' && actual === despues) { ctl.cubierta(TA, emp, 0n, 'el Flujo original ya tiene el valor nuevo'); continue }
      const dif = actual - antes
      if (dif > 100n || dif < -100n) {
        ctl.noMapeada(TA, emp, 0n, ref, `el valor "antes" del cambio (${antes / 100n}) no coincide con el Flujo original (${actual / 100n}): decidir a mano`); continue
      }
      if (!['ELIMINAR', 'EDITAR'].includes(accion)) { ctl.noMapeada(TA, emp, 0n, ref, `acción ${accion} sin equivalente`); continue }
      plan.flujo_ajustes.push({ proyeccion: p.clave, empresa: emp, ocurrencia: dia, eliminada: accion === 'ELIMINAR',
        importe_nuevo: accion === 'EDITAR' ? despues : null, motivo: texto(f, 9) || accion, creado_por: texto(f, 1) || MARCA })
      ctl.cargar(TA, emp, 0n)
    }
  }

  // ============================================================ acreedores + cheques (Cash Flow)
  {
    const TA = 'acreedores', TC = 'cheques'
    ctl.fuente(TA, 'Cash Flow › Categoría'); ctl.fuente(TC, op.correcciones !== false ? `Cash Flow › CHEQUES EMITIDOS (ESTADO = Pendiente; Pagado cobrado desde el ${op.desde} → DEBITADO)` : 'Cash Flow › CHEQUES EMITIDOS (ESTADO = Pendiente)')
    const tipoAcreedor = (cat) => (/^P$/i.test(cat) ? 'PROVEEDOR' : /^F/i.test(cat) ? 'FINANCIERA' : 'OTRO')
    const acreedores = new Map()
    hoja(C, 'Categoría', 'Cash Flow').slice(2).forEach((f) => {
      const nombre = texto(f, 2), cat = texto(f, 3)
      if (!nombre) return
      ctl.planilla(TA, null)
      const k = norm(nombre)
      if (acreedores.has(k)) return ctl.cubierta(TA, null, 0n, 'repetido en Categoría (mismo nombre)')
      acreedores.set(k, { nombre: nombre.trim(), tipo: tipoAcreedor(cat), categoria: cat, alias: [] })
      ctl.cargar(TA, null)
    })
    const vistos = new Set()
    hoja(C, 'CHEQUES EMITIDOS', 'Cash Flow').slice(1).forEach((f, i) => {
      const estado = norm(texto(f, 11))
      if (!estado && vacia(f)) return
      // T-206: un cheque "Pagado" que se cobró desde el inicio de la carga entra DEBITADO (si no, el débito del banco
      // queda sin documento y el Flujo no lo puede clasificar). Los pagados antes quedan fuera, como siempre.
      const pagado = op.correcciones !== false && estado === 'PAGADO'
      if (pagado) {
        const cobro = fecha(celda(f, 2)) ?? fecha(celda(f, 1))
        if (!cobro || cobro < op.desde || cobro > op.hoy) { ctl.fuera(TC, 'estado "Pagado" cobrado fuera del período'); return }
      }
      if (!pagado && !['PENDIENTE', 'VENCIDO', 'ROLL'].includes(estado)) { ctl.fuera(TC, `estado "${texto(f, 11) || 'vacío'}"`); return }
      const emp = empresaDe(texto(f, 3)), imp = centavos(celda(f, 9))
      ctl.planilla(TC, emp, imp)
      const numero = texto(f, 5).replace(/^0+(?=\d)/, ''), banco = texto(f, 4), tipoTxt = norm(texto(f, 6))
      const ref = `CHEQUES EMITIDOS fila ${i + 2} · ${texto(f, 3)} ${banco} ${numero} · ${texto(f, 8)}`
      if (!pagado && estado !== 'PENDIENTE') return ctl.noMapeada(TC, emp, imp, ref, `[FALTA] estado "${texto(f, 11)}": ¿se debitó o sigue pendiente?`)
      if (!emp) return ctl.noMapeada(TC, emp, imp, ref, `empresa "${texto(f, 3)}" desconocida`)
      if (!imp || imp <= 0n) return ctl.noMapeada(TC, emp, imp, ref, 'sin importe')
      if (!numero || !banco) return ctl.noMapeada(TC, emp, imp, ref, 'sin número o sin banco')
      const tipo = tipoTxt === 'ECHEQ' ? 'ECHEQ' : tipoTxt.includes('FISICO') ? 'FISICO' : tipoTxt === 'PAGARE' ? 'PAGARE' : null
      if (!tipo) return ctl.noMapeada(TC, emp, imp, ref, 'sin tipo (ECHEQ, físico o pagaré)')
      const pago = fecha(celda(f, 2)) ?? fecha(celda(f, 1)), emision = fecha(celda(f, 0)) ?? fecha(celda(f, 1)) ?? pago
      if (!pago || !emision) return ctl.noMapeada(TC, emp, imp, ref, 'sin fechas')
      if (pago < emision) return ctl.noMapeada(TC, emp, imp, ref, `cobro (${pago}) antes de la emisión (${emision})`)
      const cuenta = cuentaDeCheque(emp, banco)
      const k = `${emp}|${cuenta.nombre}|${tipo}|${numero}`
      if (vistos.has(k)) return ctl.noMapeada(TC, emp, imp, ref, 'número repetido en la misma chequera')
      vistos.add(k)
      const benef = texto(f, 8).trim(), cat = texto(f, 7)
      if (benef && !acreedores.has(norm(benef))) {
        acreedores.set(norm(benef), { nombre: benef, tipo: tipoAcreedor(cat), categoria: cat, alias: [], desdeCheque: true })
        ctl.planilla(TA, null); ctl.cargar(TA, null)
      }
      plan.cheques.push({ estado: pagado ? 'DEBITADO' : 'EMITIDO', debitado_en: pagado ? pago : null, empresa: emp, cuenta: cuenta.nombre, tipo, numero, beneficiario: benef || '(sin beneficiario)', acreedor: benef || null,
        importe: imp, fecha_emision: emision, fecha_pago: pago, origen: /^F/i.test(cat) ? 'FINANCIERA' : 'MANUAL',
        observaciones: [texto(f, 12), cat ? `Categoría Cash Flow: ${cat}` : ''].filter(Boolean).join(' · ') || null })
      ctl.cargar(TC, emp, imp)
    })
    const desdeCheque = [...acreedores.values()].filter((a) => a.desdeCheque).length
    if (desdeCheque) ctl.aviso(TA, `${desdeCheque} acreedores no estaban en Categoría y se toman del cheque (tipo según su columna Categoría)`)
    plan.acreedores.push(...acreedores.values())
  }
  function cuentaDeCheque(emp, banco) {
    const b = norm(banco)
    const c = cuentas.filter((x) => x.empresa === emp && !x.chequera && x.banco === b && ['CC', 'CA', 'BILLETERA'].includes(x.clase))
      .sort((a, z) => z.es_base - a.es_base)[0]
    return c ?? chequera(emp, banco)
  }

  // ============================================================ saldos_bancarios
  {
    const T = 'saldos_bancarios'
    ctl.fuente(T, `VBI+ › Conciliacion_Diaria (SALDO_EXTRACTO, desde ${op.desde})`)
    ctl.fuente(T, `Flujo original › filas de saldo por banco (días sin conciliación, antes de hoy)`)
    const porClave = new Map()
    hoja(V, 'Conciliacion_Diaria', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const d = fecha(celda(f, 0), { mdy: true })
      if (!d || d < op.desde) { ctl.fuera(T, `Conciliacion_Diaria antes del ${op.desde}`); return }
      const emp = empresaDe(texto(f, 1)), saldo = centavos(celda(f, 7))
      ctl.planilla(T, emp, saldo ?? 0n)
      const ref = `Conciliacion_Diaria fila ${i + 2} · ${d} · ${texto(f, 1)} ${texto(f, 2)}`
      const c = cuentaDe(emp, texto(f, 2))
      if (!c) return ctl.noMapeada(T, emp, saldo ?? 0n, ref, 'cuenta no reconocida')
      if (saldo === null) return ctl.noMapeada(T, emp, 0n, ref, 'sin SALDO_EXTRACTO')
      const est = norm(texto(f, 14))
      const origen = est === 'SIN MOVIMIENTOS' ? 'SIN_MOVIMIENTOS' : c.clase === 'FCI' && est === 'EXTRACTO' ? 'TENENCIA' : 'EXTRACTO'
      const k = `${emp}|${c.nombre}|${d}`
      const prev = porClave.get(k)
      if (prev) {
        ctl.cubierta(T, emp, prev.saldo, 'repetido mismo día y cuenta: queda la última fila')
        ctl.t(T).cargar[emp].filas--; ctl.t(T).cargar[emp].suma -= prev.saldo
        plan.saldos_bancarios.splice(plan.saldos_bancarios.indexOf(prev), 1)
      }
      const s = { empresa: emp, cuenta: c.nombre, fecha: d, saldo, origen, cargado_por: `${MARCA} (Conciliacion_Diaria)`, ref: `Conciliacion_Diaria fila ${i + 2}` }
      porClave.set(k, s); plan.saldos_bancarios.push(s); ctl.cargar(T, emp, saldo)
    })
    // Flujo original: saldo por banco cargado a mano en los días que la conciliación no tiene.
    const vbiPorClave = new Map() // empresa|cuenta|fecha → fila de Conciliacion_Diaria (estado y saldo calculado)
    hoja(V, 'Conciliacion_Diaria', 'VBI+').slice(1).forEach((f, i) => {
      const s = plan.saldos_bancarios.find((x) => x.ref === `Conciliacion_Diaria fila ${i + 2}`)
      if (s) vbiPorClave.set(`${s.empresa}|${s.cuenta}|${s.fecha}`, { estado: norm(texto(f, 14)), calculado: centavos(celda(f, 6)) })
    })
    for (const s of leerOriginal(O).saldos) {
      if (s.fecha < op.desde || s.fecha >= op.hoy) continue
      // Sin correcciones (como antes de T-206) los saldos que son fórmula no se cargaban.
      if (s.formula && op.correcciones === false) continue
      ctl.planilla(T, s.empresa, s.saldo)
      const ref = `Flujo original ${s.pestana} fila ${s.fila} · ${s.etiqueta} · ${s.fecha}`
      const c = cuentaDe(s.empresa, s.etiqueta, { estricto: true }) ?? cuentaDe(s.empresa, sinCodigo(s.etiqueta), { estricto: true })
      if (!c) { ctl.noMapeada(T, s.empresa, s.saldo, ref, 'fila de saldo sin cuenta en Cuentas_Extracto'); continue }
      const k = `${s.empresa}|${c.nombre}|${s.fecha}`
      const ya = porClave.get(k)
      if (ya) {
        const dif = ya.saldo - s.saldo
        const v = vbiPorClave.get(k)
        const dc = v?.calculado == null ? null : v.calculado - s.saldo
        // T-206: si VBI+ marcó DIFERENCIA y el saldo del Flujo es justo el que explican los movimientos, el extracto
        // tomó mal el saldo de cierre (p. ej. tomó el saldo de un movimiento intermedio). Vale el del Flujo.
        if (op.correcciones !== false && (dif > 100n || dif < -100n) && v?.estado === 'DIFERENCIA' && dc !== null && dc <= 100n && dc >= -100n) {
          ctl.aviso(T, `${c.nombre} ${s.fecha}: Conciliacion_Diaria dice ${ya.saldo / 100n} (DIFERENCIA) y el Flujo original ${s.saldo / 100n}, que es el saldo calculado por los movimientos → queda el del Flujo`)
          ctl.cubierta(T, ya.empresa, ya.saldo, 'Conciliacion_Diaria con saldo de cierre mal tomado: lo reemplaza el del Flujo original')
          ctl.t(T).cargar[ya.empresa].filas--; ctl.t(T).cargar[ya.empresa].suma -= ya.saldo
          plan.saldos_bancarios.splice(plan.saldos_bancarios.indexOf(ya), 1)
          const r = { empresa: s.empresa, cuenta: c.nombre, fecha: s.fecha, saldo: s.saldo, origen: 'MANUAL', cargado_por: `${MARCA} (Flujo original)`, ref: ya.ref, reemplaza: true }
          porClave.set(k, r); plan.saldos_bancarios.push(r); ctl.cargar(T, s.empresa, s.saldo)
          continue
        }
        if (dif > 100n || dif < -100n) ctl.aviso(T, `${c.nombre} ${s.fecha}: Flujo original ${s.saldo / 100n} vs Conciliacion_Diaria ${ya.saldo / 100n} (queda la conciliación)`)
        ctl.cubierta(T, s.empresa, s.saldo, 'ese día ya está en Conciliacion_Diaria')
        continue
      }
      const r = { empresa: s.empresa, cuenta: c.nombre, fecha: s.fecha, saldo: s.saldo, origen: 'MANUAL', cargado_por: `${MARCA} (Flujo original)` }
      porClave.set(k, r); plan.saldos_bancarios.push(r); ctl.cargar(T, s.empresa, s.saldo)
    }
  }

  // ============================================================ movimientos_bancarios
  {
    const T = 'movimientos_bancarios'
    ctl.fuente(T, `VBI+ › Extractos_Movimientos (desde ${op.desde})`); ctl.fuente(T, 'Motor › Bancos Movimientos (solo lo que no está en Extractos_Movimientos)')
    const CATS = new Set(['SIN_CLASIFICAR', 'PAGO', 'COBRO', 'IMPUESTO', 'GASTO_BANCARIO', 'FCI', 'FCI_RENDIMIENTO', 'TRANSFERENCIA_PROPIA', 'CHEQUE_PAGADO', 'INTERESES', 'PRESTAMO', 'INFORMATIVO'])
    const yaEstan = new Map() // empresa|cuenta|fecha|importe → cantidad
    const em = hoja(V, 'Extractos_Movimientos', 'VBI+')
    // T-206 · Archivo superpuesto: el mismo día de la misma cuenta subido en dos archivos (p. ej. el CSV
    // del home banking y el PDF, con descripciones en mayúsculas y minúsculas). Como hace importar_extracto en la base,
    // el archivo que se importó después solo agrega lo nuevo: sus movimientos con un importe que ya trajo el anterior
    // (contando repetidos) son duplicados.
    const duplicados = new Set()
    if (op.correcciones !== false) {
      const grupos = new Map() // empresa|banco|fecha → archivo → [{i, imp}]
      em.slice(1).forEach((f, i) => {
        if (vacia(f) || !texto(f, 16)) return
        const k = `${norm(texto(f, 2))}|${norm(texto(f, 3))}|${texto(f, 1)}`
        const g = grupos.get(k) ?? new Map(); grupos.set(k, g)
        const a = g.get(texto(f, 16)) ?? { desde: `${texto(f, 17)}|${String(i).padStart(6, '0')}`, filas: [] }; g.set(texto(f, 16), a)
        a.filas.push({ i, imp: (centavos(celda(f, 7)) ?? 0n) - (centavos(celda(f, 6)) ?? 0n) })
      })
      for (const g of grupos.values()) {
        if (g.size < 2) continue
        const archivos = [...g.values()].sort((a, b) => (a.desde < b.desde ? -1 : 1))
        const vistos = new Map() // importe → cuántos trajeron los archivos anteriores
        for (const [n, a] of archivos.entries()) {
          const propios = new Map()
          for (const x of a.filas) {
            const k = String(x.imp), antes = vistos.get(k) ?? 0, usados = propios.get(k) ?? 0
            if (n > 0 && usados < antes) duplicados.add(x.i)
            propios.set(k, usados + 1)
          }
          for (const [k, v] of propios) vistos.set(k, Math.max(vistos.get(k) ?? 0, v))
        }
      }
    }
    em.slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const d = fecha(celda(f, 1))
      if (!d || d < op.desde) { ctl.fuera(T, `Extractos_Movimientos antes del ${op.desde}`); return }
      const emp = empresaDe(texto(f, 2))
      const deb = centavos(celda(f, 6)) ?? 0n, cred = centavos(celda(f, 7)) ?? 0n, imp = cred - deb
      ctl.planilla(T, emp, imp)
      const ref = `Extractos_Movimientos fila ${i + 2} · ${texto(f, 0)}`
      // T-209: la línea "Saldo anterior / inicial / final" de un informe (p. ej. la tenencia de un FCI) no es un
      // movimiento: cargada como tal, la conciliación del fondo la toma como un rendimiento negativo del mismo importe.
      if (op.correcciones !== false && op.rescatesFci !== false && /^SALDO (ANTERIOR|INICIAL|FINAL|AL\b)/.test(norm(texto(f, 4)))) {
        ctl.aviso(T, `${ref}: "${texto(f, 4)}" es una línea de saldo del informe, no un movimiento → no se carga`)
        return ctl.cubierta(T, emp, imp, 'línea de saldo del informe (saldo anterior/inicial/final): no es un movimiento')
      }
      if (duplicados.has(i)) {
        ctl.aviso(T, `${ref}: ${texto(f, 3)} ${d} ${texto(f, 4)} ya vino en otro archivo del mismo día (archivo superpuesto "${texto(f, 16)}") → no se carga`)
        return ctl.cubierta(T, emp, imp, 'archivo superpuesto: el mismo movimiento ya vino en otro archivo del mismo día y cuenta')
      }
      const c = cuentaDe(emp, texto(f, 3))
      if (!c) return ctl.noMapeada(T, emp, imp, ref, `cuenta "${texto(f, 2)} · ${texto(f, 3)}" no reconocida`)
      if (!texto(f, 0)) return ctl.noMapeada(T, emp, imp, ref, 'sin ID (no se puede asegurar que no se duplique)')
      let cat = norm(texto(f, 9)).replace(/\s/g, '_') || 'SIN_CLASIFICAR'
      if (!CATS.has(cat)) { ctl.aviso(T, `${ref}: categoría "${cat}" desconocida → SIN_CLASIFICAR`); cat = 'SIN_CLASIFICAR' }
      const est = norm(texto(f, 14))
      const estado = est === 'INFORMATIVO' ? 'INFORMATIVO' : est === 'A_REVISAR' || !est ? 'A_REVISAR' : est === 'CONFIRMADO' ? 'PENDIENTE'
        : /CARGADO A MANO/.test(est) ? 'CARGADO_A_MANO' : /^CONTABILIZADO|^FACTURA 0999/.test(est) ? 'CONTABILIZADO' : 'A_REVISAR'
      const cta = texto(f, 10), m = /^([A-Z0-9_]*_[A-Z0-9_]*)\s+(.+)$/.exec(cta)
      plan.movimientos_bancarios.push({
        empresa: emp, cuenta: c.nombre, huella: `VBI:${texto(f, 0)}`, fecha: d, descripcion: texto(f, 4), referencia: texto(f, 5) || null,
        importe: imp, saldo: centavos(celda(f, 8)), categoria: cat, cuenta_contable: m ? m[2].trim() : cta || null, estado,
        numero_cheque: texto(f, 12) || null,
        revisado_por: [texto(f, 15), est && !['INFORMATIVO', 'A_REVISAR'].includes(est) ? `VBI+: ${texto(f, 14)}` : ''].filter(Boolean).join(' · ') || null,
      })
      ctl.cargar(T, emp, imp)
      const k = `${emp}|${c.nombre}|${d}|${imp}`
      yaEstan.set(k, (yaEstan.get(k) ?? 0) + 1)
    })
    const n = new Map()
    hoja(M, 'Bancos Movimientos', 'Motor').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const d = fecha(celda(f, 0)), pe = PESTANAS[texto(f, 1)], emp = pe?.empresa ?? null
      if (!d || d < op.desde) { ctl.fuera(T, `Bancos Movimientos antes del ${op.desde}`); return }
      const imp = centavos(celda(f, 5)) ?? 0n
      ctl.planilla(T, emp, imp)
      const ref = `Bancos Movimientos fila ${i + 2} · ${d} · ${texto(f, 3)} · ${texto(f, 4)}`
      const c = cuentaDe(emp, texto(f, 3))
      if (!c) return ctl.noMapeada(T, emp, imp, ref, `cuenta "${texto(f, 3)}" no reconocida`)
      const k = `${emp}|${c.nombre}|${d}|${imp}`
      if ((yaEstan.get(k) ?? 0) > 0) { yaEstan.set(k, yaEstan.get(k) - 1); return ctl.cubierta(T, emp, imp, 'ya está en Extractos_Movimientos (misma cuenta, día e importe)') }
      const kk = `${k}|${norm(texto(f, 4))}`; n.set(kk, (n.get(kk) ?? 0) + 1)
      plan.movimientos_bancarios.push({
        empresa: emp, cuenta: c.nombre, huella: `MOTOR:${clave(kk, n.get(kk))}`, fecha: d, descripcion: texto(f, 4), referencia: null,
        importe: imp, saldo: centavos(celda(f, 6)), categoria: 'SIN_CLASIFICAR', cuenta_contable: null, estado: 'A_REVISAR', numero_cheque: null,
        revisado_por: `Motor · Bancos Movimientos · ${texto(f, 7)}${texto(f, 10) ? ' · ' + texto(f, 10) : ''}`,
      })
      ctl.cargar(T, emp, imp)
      ctl.aviso(T, `${ref}: no estaba en Extractos_Movimientos → entra A_REVISAR`)
    })
  }

  // ============================================================ T-209 · rescates y suscripciones de FCI sin clasificar
  // Un crédito SIN_CLASIFICAR en una cuenta del mismo banco que es (casi) igual a lo que bajó el saldo de un FCI o
  // remunerada (y que no explican ni los movimientos del fondo ni los FCI de su madre) es un rescate; un débito igual
  // a lo que subió, una suscripción. Se cargan con categoría FCI y el fondo como contraparte: el rendimiento del FCI
  // deja de incluirlos. Tolerancia: el rendimiento del día (0,2 % del importe, mínimo $1). Si hay más de un
  // candidato, solo vale el que lo dice en la descripción; si no, queda sin clasificar (con aviso).
  if (op.correcciones !== false && op.rescatesFci !== false) {
    const T = 'movimientos_bancarios'
    const saldosDe = new Map() // empresa|cuenta → [{fecha, saldo}] ordenado
    for (const x of plan.saldos_bancarios) { const k = `${x.empresa}|${x.cuenta}`; saldosDe.set(k, [...(saldosDe.get(k) ?? []), x]) }
    for (const l of saldosDe.values()) l.sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    const abs = (x) => (x < 0n ? -x : x)
    let n = 0, suma = 0n
    const RE_FCI = /RESCATE|SUSCRIP|FONDO|FCI/
    const fondosTodos = cuentas.filter((c) => ['FCI', 'REMUNERADA'].includes(c.clase))
    for (const f of fondosTodos) {
      const l = saldosDe.get(`${f.empresa}|${f.nombre}`) ?? []
      for (let i = 1; i < l.length; i++) {
        const fecha = l[i].fecha, d0 = l[i].saldo - l[i - 1].saldo
        // Lo que el fondo no explica: ni sus propios movimientos ni los movimientos FCI de su cuenta madre.
        const propios = plan.movimientos_bancarios.filter((o) => o.empresa === f.empresa && o.cuenta === f.nombre && o.fecha > l[i - 1].fecha && o.fecha <= fecha)
        const deMadre = plan.movimientos_bancarios.filter((o) => o.empresa === f.empresa && o.cuenta === f.madre && o.fecha > l[i - 1].fecha && o.fecha <= fecha && o.categoria === 'FCI')
        const d = d0 - propios.reduce((a, o) => a + o.importe, 0n) + deMadre.reduce((a, o) => a + o.importe, 0n)
        if (abs(d) < 100000n) continue
        // Candidatos: movimientos SIN_CLASIFICAR del mismo banco y empresa, en el período, por (casi) lo mismo al revés.
        const cand = plan.movimientos_bancarios.filter((m) => m.categoria === 'SIN_CLASIFICAR' && m.empresa === f.empresa && m.fecha > l[i - 1].fecha && m.fecha <= fecha
          && cuentas.some((c) => c.empresa === m.empresa && c.nombre === m.cuenta && c.banco === f.banco && ['CC', 'CA', 'BILLETERA'].includes(c.clase))
          && abs(d + m.importe) <= (abs(m.importe) / 500n > 100n ? abs(m.importe) / 500n : 100n))
        // Si hay más de uno, el que dice FCI/rescate/suscripción en la descripción; si sigue habiendo más de uno, nada.
        const elegidos = cand.length > 1 ? cand.filter((m) => RE_FCI.test(norm(m.descripcion))) : cand
        if (elegidos.length !== 1) { if (cand.length > 1) ctl.aviso(T, `${f.nombre} ${fecha}: ${cand.length} movimientos podrían ser el rescate o la suscripción del fondo · sin clasificar`); continue }
        const m = elegidos[0]
        m.categoria = 'FCI'; m.reclasificado = m.importe > 0n ? 'RESCATE_FCI' : 'SUSCRIPCION_FCI'
        if (m.cuenta !== f.madre) m.contraparte = f.nombre // la base completa sola solo la de la madre
        n++; suma += m.importe
        ctl.aviso(T, `${m.cuenta} ${m.fecha} ${m.descripcion}: ${m.importe > 0n ? 'rescate' : 'suscripción'} de ${f.nombre} (el fondo cambió ${d0 / 100n}, sin explicar ${d / 100n}) → categoría FCI`)
      }
    }
    if (n) ctl.aviso(T, `${n} movimientos SIN_CLASIFICAR reclasificados como FCI (rescate o suscripción del fondo de la cuenta) · neto ${suma / 100n}`)
  }

  // ============================================================ cobros
  {
    const T = 'cobros'; ctl.fuente(T, 'VBI+ › Cobros_Xubio')
    hoja(V, 'Cobros_Xubio', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const emp = empresaDe(texto(f, 0)), imp = centavos(celda(f, 9))
      ctl.planilla(T, emp, imp ?? 0n)
      const ref = `Cobros_Xubio fila ${i + 2} · recibo ${texto(f, 2)}`
      if (!emp) return ctl.noMapeada(T, emp, imp, ref, 'empresa desconocida')
      if (!imp || imp <= 0n) return ctl.noMapeada(T, emp, imp, ref, 'sin importe')
      if (!texto(f, 3)) return ctl.noMapeada(T, emp, imp, ref, 'sin TRANSACCION_ID (no se puede asegurar que no se duplique)')
      const c = cuentaDe(emp, texto(f, 7))
      if (!c) ctl.aviso(T, `${ref}: cuenta "${texto(f, 7)}" no reconocida (queda sin cuenta)`)
      plan.cobros.push({ empresa: emp, cuenta: c?.nombre ?? null, fecha: fecha(celda(f, 1)), cliente: texto(f, 6), recibo: texto(f, 2) || null,
        importe: imp, descripcion: [texto(f, 10), texto(f, 11)].filter(Boolean).join(' · ') || null, xubio_transaccion_id: texto(f, 3) })
      ctl.cargar(T, emp, imp)
    })
  }

  // ============================================================ lecturas_xubio
  {
    const T = 'lecturas_xubio'; ctl.fuente(T, 'Motor › Saldos Xubio Historial')
    const vistas = new Map()
    hoja(M, 'Saldos Xubio Historial', 'Motor').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const cuentaX = texto(f, 3)
      if (/^TOTAL\b/i.test(cuentaX)) { ctl.fuera(T, 'fila TOTAL (control de la lectura)'); return }
      const emp = empresaDe(texto(f, 2)), saldo = centavos(celda(f, 4)), d = fecha(celda(f, 0)), h = hora(celda(f, 1)) ?? '00:00'
      ctl.planilla(T, emp, saldo ?? 0n)
      const ref = `Saldos Xubio Historial fila ${i + 2} · ${d} ${h} · ${texto(f, 2)} · ${cuentaX}`
      if (!emp) return ctl.noMapeada(T, emp, saldo, ref, 'empresa desconocida')
      if (!d || saldo === null || !cuentaX) return ctl.noMapeada(T, emp, saldo, ref, 'sin fecha, cuenta o saldo')
      const k = `${emp}|${norm(cuentaX)}|${d}|${h}`
      const prev = vistas.get(k)
      if (prev) {
        ctl.cubierta(T, emp, prev.saldo, 'misma lectura repetida (empresa, cuenta, fecha y hora): queda la última')
        ctl.t(T).cargar[emp].filas--; ctl.t(T).cargar[emp].suma -= prev.saldo
        plan.lecturas_xubio.splice(plan.lecturas_xubio.indexOf(prev), 1)
      }
      const c = cuentaDe(emp, cuentaX, { estricto: true })
      const r = { empresa: emp, cuenta: c?.nombre ?? null, cuenta_xubio: cuentaX, fecha: d, saldo, leido_en: `${d}T${h}:00-03:00`,
        leido_de: texto(f, 5) || 'Xubio · Finanzas › Fondos' }
      vistas.set(k, r); plan.lecturas_xubio.push(r); ctl.cargar(T, emp, saldo)
    })
  }

  // ============================================================ percepciones_iibb + procesos_log
  {
    const T = 'percepciones_iibb'; ctl.fuente(T, 'VBI+ › Catalogo_Percepciones_IIBB')
    hoja(V, 'Catalogo_Percepciones_IIBB', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      ctl.planilla(T, null)
      if (!texto(f, 1)) return ctl.noMapeada(T, null, 0n, `fila ${i + 2}`, 'sin código')
      plan.percepciones_iibb.push({ codigo: texto(f, 1), jurisdiccion: texto(f, 0) }); ctl.cargar(T, null)
    })
    const TP = 'procesos_log'; ctl.fuente(TP, 'VBI+ › Robot_Echeqs_Log')
    hoja(V, 'Robot_Echeqs_Log', 'VBI+').slice(1).forEach((f, i) => {
      if (vacia(f)) return
      const emp = empresaDe(texto(f, 2)), imp = centavos(celda(f, 5)) ?? 0n
      ctl.planilla(TP, emp, imp)
      const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/.exec(texto(f, 0))
      const cuando = m ? `${m[1]}T${m[2].padStart(5, '0')}:00-03:00` : null
      if (!cuando) return ctl.noMapeada(TP, emp, imp, `Robot_Echeqs_Log fila ${i + 2}`, 'fecha ilegible')
      const est = norm(texto(f, 7))
      plan.procesos_log.push({ empresa: emp, proceso: 'ROBOT_ECHEQS', modo: norm(texto(f, 1)) === 'REAL' ? 'REAL' : 'PRUEBA', entidad: 'CHEQUE',
        entidad_id: texto(f, 3) || null,
        estado: est === 'PRUEBA_OK' ? 'PRUEBA_OK' : /^(SUBIDO|DEBITADO|OK|FIN_CORRIDA)/.test(est) ? 'OK' : /ERROR|VENCIDA/.test(est) ? 'ERROR' : 'OMITIDO',
        detalle: texto(f, 9), datos: { proveedor: texto(f, 4), importe: imp.toString(), filas_pagos: texto(f, 6), numero_op: texto(f, 8), estado_planilla: texto(f, 7) },
        creado_en: cuando })
      ctl.cargar(TP, emp, imp)
    })
  }

  return { plan, control: ctl }
}

// ---------------------------------------------------------------- Flujo original

/** Celdas cargadas a mano (no fórmula) en las filas de cuentas, y saldos por banco por día. */
const cacheOriginal = new WeakMap()
function leerOriginal(O) {
  if (cacheOriginal.has(O)) return cacheOriginal.get(O)
  const celdas = [], saldos = [], fuera = {}
  for (const [pest, { empresa, unidad }] of Object.entries(PESTANAS)) {
    const h = O.get(pest)
    if (!h) throw new Error(`Falta la pestaña "${pest}" en el Flujo original`)
    const cab = h[1] ?? []
    const cols = []
    cab.forEach((c, j) => { const d = j >= 3 ? fecha(c) : null; if (d) cols.push([j, d]) })
    let seccion = null, zona = 'FLUJO'
    h.forEach((f, i) => {
      if (i < 2) return
      const b = texto(f, 1), cTxt = texto(f, 2), et = conCodigo(b, cTxt) || cTxt || b
      const n = norm(cTxt || b)
      if (/^\d+\.\s/.test(cTxt)) { seccion = seccionDe(cTxt); return }
      if (/^VARIACION DE CAJA/.test(n)) { zona = 'POST'; return }
      if (/^CAJA ACUMULADA/.test(n)) { zona = 'SALDOS'; return }
      if (/^CONCILIACION BANCARIA/.test(n)) { zona = 'FIN'; return }
      if (zona === 'FLUJO' && seccion) {
        for (const [j, d] of cols) {
          const c = f[j]
          if (!c || c.f) continue
          const v = centavos(c)
          if (v === null || v === 0n) continue
          if (/CANCELADO|CADUCO/i.test(et)) { fuera['fila de plan cancelado o caduco'] = (fuera['fila de plan cancelado o caduco'] ?? 0) + 1; continue }
          const signo = SIGNO_POSITIVO.has(seccion) ? 1n : -1n
          celdas.push({ pestana: pest, empresa, unidad, fila: i + 1, etiqueta: et, seccion, fecha: d, importe: signo * v })
        }
      } else if (zona === 'SALDOS' && et) {
        for (const [j, d] of cols) {
          const c = f[j]
          if (!c) continue
          const v = centavos(c)
          if (v === null) continue
          // formula: el saldo de ese día es una fórmula (p. ej. repite el anterior o suma un rescate). Es el que usa el Flujo.
          saldos.push({ pestana: pest, empresa, unidad, fila: i + 1, etiqueta: et, fecha: d, saldo: v, formula: c.f })
        }
      }
    })
  }
  const r = { celdas, saldos, fuera }
  cacheOriginal.set(O, r)
  return r
}

/** Último mes de un plan de pagos según su rótulo: "d/07-25 al 02-29", "d/03-2026 (60 cuotas)", "dsd 04-2026 (12 cuotas)". */
export function finDePlan(rotulo) {
  const anio = (s) => (s.length === 2 ? 2000 + +s : +s)
  let m = /(?:d\/|dsd\s*)(\d{2})-(\d{2,4})\s*(?:al|a)\s*(\d{2})-(\d{2,4})/i.exec(rotulo)
  if (m) return finDeMes(anio(m[4]), +m[3])
  m = /(?:d\/|dsd\s*)(\d{2})-(\d{2,4}).*?\((\d+)\s*cuotas\)/i.exec(rotulo)
  if (m) { const [a, mm] = sumarMeses(anio(m[2]), +m[1], +m[3] - 1); return finDeMes(a, mm) }
  return null
}
