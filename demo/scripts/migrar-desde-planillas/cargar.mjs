// Plan → base. Todo en una transacción; idempotente: cada tabla tiene su clave natural y correrlo dos veces
// no duplica (la segunda corrida da 0 altas). Nunca pisa lo que cargó una persona en la base:
//   · saldos: solo actualiza los que cargó esta migración; · cheques: solo los que siguen emitidos;
//   · proyecciones: no les cambia el estado (si alguien la canceló, queda cancelada);
//   · ajustes del Flujo: si ya hay uno vigente, no lo reemplaza.
// db = objeto con query(sql, params) → { rows } (PGlite o pg).
import { pesos, norm } from './leer.mjs'
import { MARCA } from './transformar.mjs'

const marca = (k) => `[mig:${k}]`

export async function cargar(db, plan) {
  const q = async (sql, p = []) => {
    try { return (await db.query(sql, p)).rows }
    catch (e) { e.message = `${e.message} · en: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`; throw e }
  }
  const uno = async (sql, p = []) => (await q(sql, p))[0]
  const res = {}
  const r = (t) => (res[t] ??= { altas: 0, cambios: 0, iguales: 0, omitidas: [] })
  const omitir = (t, ref, motivo) => r(t).omitidas.push({ ref, motivo })
  const contar = (t, k) => { r(t)[k]++ }

  await q('begin')
  try {
    const empresas = new Set((await q(`select id from empresas`)).map((x) => x.id))
    const org = (await uno(`select organizacion_id from empresas where id = any($1::text[]) and organizacion_id is not null limit 1`,
      [[...empresas]]))?.organizacion_id
    if (!org) throw new Error('No hay organización para las empresas')
    const unidades = new Map((await q(`select id, empresa_id, codigo from unidades`)).map((u) => [`${u.empresa_id}|${u.codigo}`, u.id]))
    const unidad = (emp, cod) => unidades.get(`${emp}|${cod}`) ?? unidades.get(`${emp}|${emp}`)

    // ---------------------------------------------------------- cuentas_origen
    const cuentas = new Map() // empresa|nombre del plan → id
    for (const c of plan.cuentas_origen) {
      const T = 'cuentas_origen', ref = `${c.empresa} · ${c.nombre}`
      if (!empresas.has(c.empresa)) { omitir(T, ref, 'la empresa no existe en la base'); continue }
      const u = unidad(c.empresa, c.unidad)
      if (!u) { omitir(T, ref, `no existe la unidad ${c.unidad}`); continue }
      const patrones = [...c.patrones].map(norm).filter(Boolean)
      // Si la cuenta ya está en la base con otro nombre (el de Xubio, p. ej.), se completa esa: no se duplica.
      const ya = await q(`select id, nombre from cuentas_origen where empresa_id = $1
                           and (texto_banco(nombre) = texto_banco($2) or texto_banco(nombre) = any($3::text[]) or patrones && $3::text[])
                         order by (texto_banco(nombre) = texto_banco($2)) desc`, [c.empresa, c.nombre, patrones])
      if (ya.length > 1) omitir(T, ref, `aviso: coincide con ${ya.length} cuentas de la base; se completa "${ya[0].nombre}"`)
      const cc = c.cuenta_xubio ? (await uno(`select id from cuentas_contables where texto_banco(nombre) = texto_banco($1)
                                               and (empresa_id = $2 or empresa_id is null) order by empresa_id nulls last limit 1`, [c.cuenta_xubio, c.empresa]))?.id ?? null : null
      if (ya.length) {
        const x = await q(`update cuentas_origen set banco = $2, clase = $3, numero = coalesce(numero, $4), unidad_id = $5, rinde_diario = $6,
                             requiere_extracto = $7, patrones = array(select distinct unnest(patrones || $8::text[])),
                             cuenta_contable_id = coalesce(cuenta_contable_id, $9), activa = true
                           where id = $1 and (banco is distinct from $2 or clase <> $3 or (numero is null and $4::text is not null) or unidad_id is distinct from $5
                             or rinde_diario <> $6 or requiere_extracto <> $7 or not ($8::text[] <@ patrones)
                             or (cuenta_contable_id is null and $9::uuid is not null) or not activa)
                           returning id`, [ya[0].id, c.banco, c.clase, c.numero, u, c.rinde_diario, c.requiere_extracto, patrones, cc])
        contar(T, x.length ? 'cambios' : 'iguales')
        cuentas.set(`${c.empresa}|${c.nombre}`, ya[0].id)
      } else {
        const x = await uno(`insert into cuentas_origen (empresa_id, nombre, banco, clase, numero, unidad_id, rinde_diario, requiere_extracto, patrones, orden, cuenta_contable_id)
                             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [c.empresa, c.nombre, c.banco, c.clase, c.numero, u, c.rinde_diario, c.requiere_extracto, patrones, c.orden, cc])
        r(T).altas++
        cuentas.set(`${c.empresa}|${c.nombre}`, x.id)
      }
    }
    for (const c of plan.cuentas_origen) {
      if (!c.madre) continue
      const id = cuentas.get(`${c.empresa}|${c.nombre}`), madre = cuentas.get(`${c.empresa}|${c.madre}`)
      if (id && madre) await q(`update cuentas_origen set cuenta_madre_id = $2 where id = $1 and cuenta_madre_id is distinct from $2`, [id, madre])
    }
    const cuenta = (emp, nombre) => (nombre ? cuentas.get(`${emp}|${nombre}`) : null)

    // ---------------------------------------------------------- reglas_extracto (las de 0024 ya están: solo se agregan las que falten)
    for (const x of plan.reglas_extracto) {
      const T = 'reglas_extracto'
      const ya = await uno(`select patrones, categoria from reglas_extracto where organizacion_id = $1 and orden = $2 and empresa_id is null and cuenta_origen_id is null`, [org, x.orden])
      if (ya) {
        const a = [...ya.patrones].map(norm).sort().join('|'), b = x.patrones.map(norm).sort().join('|')
        if (a === b && ya.categoria === x.categoria) r(T).iguales++
        else { r(T).iguales++; omitir(T, `orden ${x.orden}`, `aviso: la planilla dice ${x.categoria} y la base ${ya.categoria}${a === b ? '' : ' (y otros patrones)'}; queda la base (decisión de 0024)`) }
        continue
      }
      const destino = ['IMPUESTO', 'FCI', 'FCI_RENDIMIENTO', 'INTERESES'].includes(x.categoria) ? 'ASIENTO' : x.categoria === 'GASTO_BANCARIO' ? 'COMPROBANTE' : 'NINGUNO'
      await q(`insert into reglas_extracto (organizacion_id, orden, patrones, sentido, categoria, cuenta_contable, destino_xubio, componente, nota, creada_por)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [org, x.orden, x.patrones, x.sentido, x.categoria, x.cuenta_contable, destino, destino === 'COMPROBANTE' ? 'NETO' : null, x.nota, MARCA])
      r(T).altas++
    }

    // ---------------------------------------------------------- feriados
    for (const f of plan.feriados) {
      const x = await q(`insert into feriados (fecha, nombre) values ($1, $2) on conflict (fecha) do nothing returning fecha`, [f.fecha, f.nombre])
      contar('feriados', x.length ? 'altas' : 'iguales')
    }

    // ---------------------------------------------------------- flujo_filas
    for (const f of plan.flujo_filas) {
      const T = 'flujo_filas', u = unidad(f.empresa, f.unidad)
      if (!u) { omitir(T, f.etiqueta, `no existe la unidad ${f.unidad}`); continue }
      if (f.tipo === 'SECCION') {
        const x = await q(`update flujo_filas set etiqueta = $3, orden = $4 where unidad_id = $1 and tipo = 'SECCION' and seccion = $2
                             and (etiqueta, orden) is distinct from ($3, $4) returning id`, [u, f.seccion, f.etiqueta, f.orden])
        if (x.length) { r(T).cambios++; continue }
        const y = await q(`select 1 from flujo_filas where unidad_id = $1 and tipo = 'SECCION' and seccion = $2`, [u, f.seccion])
        if (y.length) { r(T).iguales++; continue }
      }
      const x = await uno(`insert into flujo_filas (unidad_id, empresa_id, orden, tipo, seccion, etiqueta, cuenta_contable, apertura, mueve_caja)
                           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                           on conflict (unidad_id, etiqueta) do update set orden = excluded.orden, tipo = excluded.tipo, seccion = excluded.seccion,
                             cuenta_contable = excluded.cuenta_contable, apertura = excluded.apertura, mueve_caja = excluded.mueve_caja, activa = true
                           where (flujo_filas.orden, flujo_filas.tipo, flujo_filas.seccion, flujo_filas.cuenta_contable, flujo_filas.apertura, flujo_filas.mueve_caja, flujo_filas.activa)
                             is distinct from (excluded.orden, excluded.tipo, excluded.seccion, excluded.cuenta_contable, excluded.apertura, excluded.mueve_caja, true)
                           returning (xmax = 0) as alta`, [u, f.empresa, f.orden, f.tipo, f.seccion, f.etiqueta, f.cuenta_contable, f.apertura, f.mueve_caja])
      contar(T, !x ? 'iguales' : x.alta ? 'altas' : 'cambios')
    }
    const filas = new Map((await q(`select id, unidad_id, etiqueta from flujo_filas`)).map((x) => [`${x.unidad_id}|${norm(x.etiqueta)}`, x.id]))
    const fila = (emp, uni, etiqueta) => filas.get(`${unidad(emp, uni)}|${norm(etiqueta)}`)

    // ---------------------------------------------------------- flujo_reglas
    for (const x of plan.flujo_reglas) {
      const T = 'flujo_reglas', u = unidad(x.empresa, x.unidad), fid = x.fila ? fila(x.empresa, x.unidad, x.fila) : null
      if (!x.excluir && !fid) { omitir(T, x.nota, `no está la fila "${x.fila}"`); continue }
      const vals = [org, x.empresa, x.prioridad, x.si_origen, x.si_cuenta_contable, x.si_texto, x.si_categoria, x.excluir ? null : u, fid, x.excluir, `${x.nota} ${marca(x.clave)}`]
      const ya = await uno(`select id from flujo_reglas where nota like '%' || $1`, [marca(x.clave)])
      if (ya) {
        const c = await q(`update flujo_reglas set empresa_id = $2, prioridad = $3, si_origen = $4, si_cuenta_contable = $5, si_texto = $6, si_categoria = $7,
                             unidad_id = $8, fila_id = $9, excluir = $10, nota = $11
                           where id = $1 and (empresa_id, prioridad, si_origen, si_cuenta_contable, si_texto, si_categoria, unidad_id, fila_id, excluir, nota)
                             is distinct from ($2::text, $3::int, $4::text, $5::text, $6::text, $7::text, $8::uuid, $9::uuid, $10::boolean, $11::text)
                           returning id`, [ya.id, ...vals.slice(1)])
        contar(T, c.length ? 'cambios' : 'iguales')
      } else {
        await q(`insert into flujo_reglas (organizacion_id, empresa_id, prioridad, si_origen, si_cuenta_contable, si_texto, si_categoria, unidad_id, fila_id, excluir, nota, creada_por)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '${MARCA}')`, vals)
        r(T).altas++
      }
    }

    // ---------------------------------------------------------- proyecciones
    const proy = new Map()
    for (const p of plan.proyecciones) {
      const T = 'proyecciones', u = unidad(p.empresa, p.unidad), fid = fila(p.empresa, p.unidad, p.fila)
      if (!u || !fid) { omitir(T, p.concepto, `sin unidad o sin la fila "${p.fila}"`); continue }
      const vals = [p.empresa, u, fid, p.concepto, pesos(p.importe), p.fecha_inicio, p.recurrencia, p.dia_mes, p.hasta, p.cuotas, p.ajuste_pct ?? '0', p.origen,
        `${p.nota} ${marca(p.clave)}`]
      const ya = await uno(`select id from proyecciones where nota like '%' || $1`, [marca(p.clave)])
      if (ya) {
        const c = await q(`update proyecciones set empresa_id = $2, unidad_id = $3, fila_id = $4, concepto = $5, importe = $6, fecha_inicio = $7, recurrencia = $8,
                             dia_mes = $9, hasta = $10, cuotas = $11, ajuste_pct_mensual = $12, origen = $13, nota = $14
                           where id = $1 and (empresa_id, unidad_id, fila_id, concepto, importe, fecha_inicio, recurrencia, dia_mes, hasta, cuotas, ajuste_pct_mensual, origen, nota)
                             is distinct from ($2::text, $3::uuid, $4::uuid, $5::text, $6::numeric, $7::date, $8::text, $9::int, $10::date, $11::int, $12::numeric, $13::text, $14::text)
                           returning id`, [ya.id, ...vals])
        contar(T, c.length ? 'cambios' : 'iguales')
        proy.set(p.clave, ya.id)
      } else {
        const x = await uno(`insert into proyecciones (empresa_id, unidad_id, fila_id, concepto, importe, fecha_inicio, recurrencia, dia_mes, hasta, cuotas,
                               ajuste_pct_mensual, origen, nota, creado_por)
                             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '${MARCA}') returning id`, vals)
        r(T).altas++
        proy.set(p.clave, x.id)
      }
    }

    // ---------------------------------------------------------- flujo_ajustes
    for (const a of plan.flujo_ajustes) {
      const T = 'flujo_ajustes', pid = proy.get(a.proyeccion)
      if (!pid) { omitir(T, a.motivo, 'no se cargó la proyección'); continue }
      const ya = await uno(`select eliminada, importe_nuevo::text from flujo_ajustes where origen_tipo = 'PROYECCION' and origen_id = $1 and ocurrencia = $2 and reemplazado_en is null`, [pid, a.ocurrencia])
      if (ya) { r(T).iguales++; if (ya.eliminada !== a.eliminada) omitir(T, a.motivo, 'aviso: ya hay otro ajuste vigente en la base; no se reemplaza'); continue }
      await q(`insert into flujo_ajustes (empresa_id, origen_tipo, origen_id, ocurrencia, importe_nuevo, eliminada, motivo, creado_por)
               values ($1, 'PROYECCION', $2, $3, $4, $5, $6, $7)`,
        [a.empresa, pid, a.ocurrencia, a.importe_nuevo === null ? null : pesos(a.importe_nuevo < 0n ? -a.importe_nuevo : a.importe_nuevo), a.eliminada, a.motivo, a.creado_por])
      r(T).altas++
    }

    // ---------------------------------------------------------- acreedores
    for (const a of plan.acreedores) {
      const T = 'acreedores'
      const ya = await uno(`select id from acreedores where organizacion_id = $1 and texto_banco(nombre) = texto_banco($2)`, [org, a.nombre])
      if (ya) { r(T).iguales++; continue }
      await q(`insert into acreedores (organizacion_id, nombre, tipo) values ($1, $2, $3)`, [org, a.nombre, a.tipo])
      r(T).altas++
    }

    // ---------------------------------------------------------- cheques (emitidos sin debitar)
    for (const c of plan.cheques) {
      const T = 'cheques', cid = cuenta(c.empresa, c.cuenta), ref = `${c.empresa} ${c.cuenta} ${c.tipo} ${c.numero}`
      if (!cid) { omitir(T, ref, 'sin cuenta en la base'); continue }
      const acr = c.acreedor ? (await uno(`select id from acreedores where organizacion_id = $1 and texto_banco(nombre) = texto_banco($2)`, [org, c.acreedor]))?.id ?? null : null
      const x = await uno(`insert into cheques (empresa_id, cuenta_origen_id, tipo, numero, acreedor_id, beneficiario, importe, fecha_emision, fecha_pago, origen, observaciones, creado_por)
                           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '${MARCA}')
                           on conflict (cuenta_origen_id, tipo, numero) do update set acreedor_id = excluded.acreedor_id, beneficiario = excluded.beneficiario,
                             importe = excluded.importe, fecha_emision = excluded.fecha_emision, fecha_pago = excluded.fecha_pago, observaciones = excluded.observaciones
                           where cheques.estado in ('EMITIDO', 'ENTREGADO')
                             and (cheques.acreedor_id, cheques.beneficiario, cheques.importe, cheques.fecha_emision, cheques.fecha_pago, cheques.observaciones)
                               is distinct from (excluded.acreedor_id, excluded.beneficiario, excluded.importe, excluded.fecha_emision, excluded.fecha_pago, excluded.observaciones)
                           returning (xmax = 0) as alta`,
        [c.empresa, cid, c.tipo, c.numero, acr, c.beneficiario, pesos(c.importe), c.fecha_emision, c.fecha_pago, c.origen, c.observaciones])
      contar(T, !x ? 'iguales' : x.alta ? 'altas' : 'cambios')
    }

    // ---------------------------------------------------------- saldos_bancarios
    for (const s of plan.saldos_bancarios) {
      const T = 'saldos_bancarios', cid = cuenta(s.empresa, s.cuenta)
      if (!cid) { omitir(T, `${s.cuenta} ${s.fecha}`, 'sin cuenta en la base'); continue }
      const x = await uno(`insert into saldos_bancarios (cuenta_origen_id, fecha, empresa_id, saldo, origen, cargado_por) values ($1, $2, $3, $4, $5, $6)
                           on conflict (cuenta_origen_id, fecha) do update set saldo = excluded.saldo, origen = excluded.origen, cargado_por = excluded.cargado_por, cargado_en = now()
                           where saldos_bancarios.cargado_por like '${MARCA}%' and (saldos_bancarios.saldo, saldos_bancarios.origen) is distinct from (excluded.saldo, excluded.origen)
                           returning (xmax = 0) as alta`, [cid, s.fecha, s.empresa, pesos(s.saldo), s.origen, s.cargado_por])
      if (x) { contar(T, x.alta ? 'altas' : 'cambios'); continue }
      const ya = await uno(`select saldo::text, cargado_por from saldos_bancarios where cuenta_origen_id = $1 and fecha = $2`, [cid, s.fecha])
      r(T).iguales++
      if (ya && !ya.cargado_por.startsWith(MARCA) && ya.saldo !== pesos(s.saldo)) omitir(T, `${s.cuenta} ${s.fecha}`, `aviso: la base ya tiene ${ya.saldo} (cargado por ${ya.cargado_por}); no se pisa`)
    }

    // ---------------------------------------------------------- movimientos_bancarios
    for (const m of plan.movimientos_bancarios) {
      const T = 'movimientos_bancarios', cid = cuenta(m.empresa, m.cuenta)
      if (!cid) { omitir(T, m.huella, 'sin cuenta en la base'); continue }
      const x = await q(`insert into movimientos_bancarios (empresa_id, cuenta_origen_id, fecha, descripcion, importe, saldo, referencia, numero_cheque, huella,
                           categoria, cuenta_contable, estado, revisado_por)
                         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                         on conflict (cuenta_origen_id, huella) do nothing returning id`,
        [m.empresa, cid, m.fecha, m.descripcion, pesos(m.importe), m.saldo === null ? null : pesos(m.saldo), m.referencia, m.numero_cheque, m.huella,
         m.categoria, m.cuenta_contable, m.estado, m.revisado_por])
      contar(T, x.length ? 'altas' : 'iguales')
    }
    // Lo que todavía no se contabilizó toma la regla de la base (destino en Xubio y componente), si coincide la categoría.
    await q(`update movimientos_bancarios m set regla_id = x.id, destino_xubio = x.destino_xubio, componente = x.componente
             from (select mm.id as mov, (regla_para_movimiento(mm.cuenta_origen_id, mm.descripcion, mm.importe)).*
                   from movimientos_bancarios mm
                   where (mm.huella like 'VBI:%' or mm.huella like 'MOTOR:%') and mm.estado in ('A_REVISAR', 'PENDIENTE') and mm.regla_id is null) x
             where m.id = x.mov and x.id is not null and x.categoria = m.categoria`)

    // ---------------------------------------------------------- cobros
    for (const c of plan.cobros) {
      const x = await q(`insert into cobros (empresa_id, cuenta_origen_id, fecha, cliente, recibo, importe, descripcion, xubio_transaccion_id, origen)
                         values ($1, $2, $3, $4, $5, $6, $7, $8, 'XUBIO') on conflict (empresa_id, xubio_transaccion_id) do nothing returning id`,
        [c.empresa, cuenta(c.empresa, c.cuenta), c.fecha, c.cliente, c.recibo, pesos(c.importe), c.descripcion, c.xubio_transaccion_id])
      contar('cobros', x.length ? 'altas' : 'iguales')
    }

    // ---------------------------------------------------------- lecturas_xubio
    for (const l of plan.lecturas_xubio) {
      const x = await q(`insert into lecturas_xubio (empresa_id, cuenta_origen_id, cuenta_xubio, fecha, saldo, leido_de, leido_en, leido_por)
                         select $1, $2, $3, $4, $5, $6, $7, '${MARCA}'
                         where not exists (select 1 from lecturas_xubio where empresa_id = $1 and cuenta_xubio = $3 and leido_en = $7::timestamptz)
                         returning id`, [l.empresa, cuenta(l.empresa, l.cuenta), l.cuenta_xubio, l.fecha, pesos(l.saldo), l.leido_de, l.leido_en])
      contar('lecturas_xubio', x.length ? 'altas' : 'iguales')
    }

    // ---------------------------------------------------------- percepciones_iibb + procesos_log
    for (const p of plan.percepciones_iibb) {
      const x = await uno(`insert into percepciones_iibb (organizacion_id, codigo, jurisdiccion) values ($1, $2, $3)
                           on conflict (organizacion_id, codigo) do update set jurisdiccion = excluded.jurisdiccion
                           where percepciones_iibb.jurisdiccion is distinct from excluded.jurisdiccion returning (xmax = 0) as alta`, [org, p.codigo, p.jurisdiccion])
      contar('percepciones_iibb', !x ? 'iguales' : x.alta ? 'altas' : 'cambios')
    }
    for (const p of plan.procesos_log) {
      const x = await q(`insert into procesos_log (organizacion_id, empresa_id, proceso, modo, entidad, entidad_id, estado, detalle, datos, creado_en)
                         select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
                         where not exists (select 1 from procesos_log where proceso = $3 and entidad_id is not distinct from $6 and creado_en = $10::timestamptz
                                             and datos = $9::jsonb)
                         returning id`, [org, p.empresa, p.proceso, p.modo, p.entidad, p.entidad_id, p.estado, p.detalle, JSON.stringify(p.datos), p.creado_en])
      contar('procesos_log', x.length ? 'altas' : 'iguales')
    }

    await q('commit')
  } catch (e) {
    await q('rollback')
    throw e
  }
  return res
}

/** Lo que quedó en la base de esta migración, por tabla y empresa: { tabla: { empresa: { filas, suma } } }. */
export async function verificar(db, plan) {
  const q = async (sql, p = []) => (await db.query(sql, p)).rows
  const cents = (t) => { const [e, d = ''] = String(t).split('.'); const neg = e.startsWith('-'); const v = BigInt(e.replace('-', '')) * 100n + BigInt((d + '00').slice(0, 2)); return neg ? -v : v }
  const agrupar = (filas) => {
    const o = {}
    for (const f of filas) { const e = (o[f.empresa_id ?? '(sin empresa)'] ??= { filas: 0, suma: 0n }); e.filas++; e.suma += f.importe == null ? 0n : cents(f.importe) }
    return o
  }
  const v = {}
  const nombres = plan.cuentas_origen.map((c) => [c.empresa, c.nombre])
  v.cuentas_origen = agrupar(await q(`select c.empresa_id, null as importe from cuentas_origen c
    join unnest($1::text[], $2::text[]) as x(e, n) on c.empresa_id = x.e and (c.nombre = x.n or texto_banco(x.n) = any(c.patrones))`,
    [nombres.map((x) => x[0]), nombres.map((x) => x[1])]))
  v.flujo_filas = agrupar(await q(`select f.empresa_id, null as importe from flujo_filas f join unidades u on u.id = f.unidad_id
    join unnest($1::text[], $2::text[], $3::text[]) as x(e, u, et) on u.empresa_id = x.e and u.codigo = x.u and f.etiqueta = x.et`,
    [plan.flujo_filas.map((f) => f.empresa), plan.flujo_filas.map((f) => f.unidad), plan.flujo_filas.map((f) => f.etiqueta)]))
  v.flujo_reglas = agrupar(await q(`select empresa_id, null as importe from flujo_reglas where nota like '%[mig:%'`))
  v.proyecciones = agrupar(await q(`select empresa_id, importe::text as importe from proyecciones where nota like '%[mig:%'`))
  v.flujo_ajustes = agrupar(await q(`select a.empresa_id, null as importe from flujo_ajustes a join proyecciones p on p.id = a.origen_id
    where a.origen_tipo = 'PROYECCION' and p.nota like '%[mig:%' and a.reemplazado_en is null`))
  v.cheques = agrupar(await q(`select empresa_id, importe::text as importe from cheques where creado_por = $1`, [MARCA]))
  v.saldos_bancarios = agrupar(await q(`select empresa_id, saldo::text as importe from saldos_bancarios where cargado_por like $1`, [`${MARCA}%`]))
  v.movimientos_bancarios = agrupar(await q(`select empresa_id, importe::text as importe from movimientos_bancarios where huella like 'VBI:%' or huella like 'MOTOR:%'`))
  v.cobros = agrupar(await q(`select empresa_id, importe::text as importe from cobros where xubio_transaccion_id = any($1::text[])`, [plan.cobros.map((c) => c.xubio_transaccion_id)]))
  v.lecturas_xubio = agrupar(await q(`select empresa_id, saldo::text as importe from lecturas_xubio where leido_por = $1`, [MARCA]))
  v.acreedores = agrupar(await q(`select null as empresa_id, null as importe from acreedores a join unnest($1::text[]) x(n) on texto_banco(a.nombre) = texto_banco(x.n)`,
    [plan.acreedores.map((a) => a.nombre)]))
  v.feriados = agrupar(await q(`select null as empresa_id, null as importe from feriados where fecha = any($1::date[])`, [plan.feriados.map((f) => f.fecha)]))
  v.reglas_extracto = agrupar(await q(`select null as empresa_id, null as importe from reglas_extracto where orden = any($1::int[]) and empresa_id is null and cuenta_origen_id is null`,
    [plan.reglas_extracto.map((x) => x.orden)]))
  v.percepciones_iibb = agrupar(await q(`select null as empresa_id, null as importe from percepciones_iibb where codigo = any($1::text[])`, [plan.percepciones_iibb.map((p) => p.codigo)]))
  v.procesos_log = agrupar(await q(`select empresa_id, (datos->>'importe')::numeric / 100 as importe from procesos_log where proceso = 'ROBOT_ECHEQS'`))
  return v
}
