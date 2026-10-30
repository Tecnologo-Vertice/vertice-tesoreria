// Corrección a mano de lo que leyó la IA, con los mismos campos que la tarjeta del dashboard de producción.
// Muestra en vivo si neto + IVA + exento + percepciones cierra con el total y si el CAE tiene 14 dígitos;
// al guardar, la base vuelve a validar (editar_factura) y decide si queda para aprobar o en Excepciones.

import { useState } from 'react'
import { useStore } from '../store'
import { CATEGORIAS } from '../data/demo'
import { cuentasFactura } from '../lib/cuentas'
import { money } from '../lib/format'
import type { DatosEdicion } from '../data/fuente'
import type { Factura } from '../types'
import { Btn, Field, inputCls, SelectorCuenta } from './ui'

const TIPOS = ['Factura A', 'Factura B', 'Factura C', 'Factura M', 'Factura E', 'Nota de Crédito A', 'Nota de Crédito B', 'Nota de Crédito C', 'Nota de Débito A', 'Nota de Débito B', 'Recibo C', 'Sin tipo']

const num = (v: string) => {
  const n = parseFloat(v.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

export function FormFactura({ f, onCerrar }: { f: Factura; onCerrar: () => void }) {
  const { proveedor, catalogos, editarFactura } = useStore()
  const p = proveedor(f.proveedorId)
  const [d, setD] = useState<DatosEdicion>(() => ({
    empresaId: f.empresaId,
    proveedor: p?.nombre ?? '',
    cuit: p?.cuit ?? '',
    tipo: f.tipo,
    letra: f.letra ?? (/ ([A-EM])$/.exec(f.tipo)?.[1] ?? ''),
    puntoVenta: f.puntoVenta,
    numero: f.numero,
    fecha: f.fecha,
    vencimiento: f.vencimiento,
    moneda: f.moneda ?? 'ARS',
    cotizacion: f.cotizacion ?? 1,
    neto: f.neto,
    iva: f.iva,
    exento: f.exento ?? 0,
    percepciones: f.percepcionesJson?.length ? f.percepcionesJson : f.percepciones > 0 ? [{ nombre: 'Percepciones', importe: f.percepciones }] : [],
    total: f.total,
    cae: f.cae,
    caeVencimiento: f.caeVencimiento,
    categoriaVertice: f.categoriaVertice,
    cuentaContable: f.cuentaContable ?? '',
    codigoProducto: f.codigoProducto ?? '',
  }))
  const [guardando, setGuardando] = useState(false)
  const set = <K extends keyof DatosEdicion>(k: K, v: DatosEdicion[K]) => setD((x) => ({ ...x, [k]: v }))

  const suma = d.neto + d.iva + d.exento + d.percepciones.reduce((a, x) => a + (Number(x.importe) || 0), 0)
  const dif = Math.round((d.total - suma) * 100) / 100
  const digitosCae = d.cae.replace(/\D/g, '').length
  const cuitOk = d.cuit.replace(/\D/g, '').length === 11

  async function guardar() {
    setGuardando(true)
    const ok = await editarFactura(f.id, d)
    setGuardando(false)
    if (ok) onCerrar()
  }

  const numero = (k: 'neto' | 'iva' | 'exento' | 'total' | 'cotizacion', label: string) => (
    <Field label={label}>
      <input type="number" step="0.01" value={d[k]} onChange={(e) => set(k, num(e.target.value))} className={inputCls} />
    </Field>
  )

  return (
    <div className="md:col-span-2 space-y-4 fade-up">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] uppercase tracking-widest text-seco">Corregir los datos de la factura</h4>
        <span className="text-[11px] text-seco">Queda en la auditoría con tu nombre y lo que cambiaste</span>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Proveedor">
          <input value={d.proveedor} onChange={(e) => set('proveedor', e.target.value)} className={inputCls} />
        </Field>
        <Field label="CUIT" marcado={cuitOk ? undefined : 'falta'}>
          <input value={d.cuit} onChange={(e) => set('cuit', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Empresa que recibe">
          <select value={d.empresaId} onChange={(e) => set('empresaId', e.target.value)} className={inputCls}>
            {catalogos.empresas.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Categoría Vértice">
          <select value={d.categoriaVertice} onChange={(e) => set('categoriaVertice', e.target.value)} className={inputCls}>
            {Object.entries(CATEGORIAS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tipo">
          <input list={`tipos-${f.id}`} value={d.tipo} onChange={(e) => set('tipo', e.target.value)} className={inputCls} />
          <datalist id={`tipos-${f.id}`}>
            {TIPOS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="Letra">
          <input value={d.letra} maxLength={1} onChange={(e) => set('letra', e.target.value.toUpperCase())} className={inputCls} />
        </Field>
        <Field label="Punto de venta">
          <input type="number" value={d.puntoVenta} onChange={(e) => set('puntoVenta', Math.trunc(num(e.target.value)))} className={inputCls} />
        </Field>
        <Field label="Número">
          <input type="number" value={d.numero} onChange={(e) => set('numero', Math.trunc(num(e.target.value)))} className={inputCls} />
        </Field>

        <Field label="Fecha de emisión">
          <input type="date" value={d.fecha} onChange={(e) => set('fecha', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Vencimiento del pago">
          <input type="date" value={d.vencimiento} onChange={(e) => set('vencimiento', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Moneda">
          <input value={d.moneda} onChange={(e) => set('moneda', e.target.value.toUpperCase())} className={inputCls} />
        </Field>
        {numero('cotizacion', 'Cotización')}

        <Field label="CAE" marcado={digitosCae === 14 ? undefined : 'falta'} hint={digitosCae === 14 ? undefined : `Tiene ${digitosCae} dígitos: tienen que ser 14`}>
          <input value={d.cae} onChange={(e) => set('cae', e.target.value)} className={inputCls} />
        </Field>
        <Field label="Vence el CAE">
          <input type="date" value={d.caeVencimiento} onChange={(e) => set('caeVencimiento', e.target.value)} className={inputCls} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Producto / cuenta (Xubio)">
            <SelectorCuenta
              value={d.cuentaContable}
              onChange={(v) => setD((x) => ({ ...x, cuentaContable: v, codigoProducto: catalogos.codigosProducto[v] ?? x.codigoProducto }))}
              opciones={cuentasFactura(catalogos, d.empresaId)}
            />
          </Field>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {numero('neto', 'Neto gravado')}
        {numero('iva', 'IVA')}
        {numero('exento', 'Exento / no gravado')}
        <Field label="Código de producto">
          <input value={d.codigoProducto} onChange={(e) => set('codigoProducto', e.target.value)} className={inputCls} />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-seco">Percepciones e impuestos</span>
          <button onClick={() => set('percepciones', [...d.percepciones, { nombre: '', importe: 0 }])} className="text-xs text-acento hover:text-crema">
            + Agregar percepción
          </button>
        </div>
        {d.percepciones.length === 0 && <p className="text-xs text-seco">Sin percepciones.</p>}
        {d.percepciones.map((x, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input
              value={x.nombre}
              placeholder="Ej.: Percepción IIBB CABA"
              onChange={(e) => set('percepciones', d.percepciones.map((y, j) => (j === i ? { ...y, nombre: e.target.value } : y)))}
              className={inputCls}
            />
            <input
              type="number"
              step="0.01"
              value={x.importe}
              onChange={(e) => set('percepciones', d.percepciones.map((y, j) => (j === i ? { ...y, importe: num(e.target.value) } : y)))}
              className={`${inputCls} max-w-[160px]`}
            />
            <button onClick={() => set('percepciones', d.percepciones.filter((_, j) => j !== i))} className="text-red-300 hover:text-red-200 px-2" title="Quitar">
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end">
        <div className={`rounded-lg border p-3 text-xs ${Math.abs(dif) < 1 ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-red-800 bg-red-950/30 text-red-200'}`}>
          Neto + IVA + exento + percepciones = <strong>{money(suma)}</strong>
          {Math.abs(dif) < 1 ? ' · cierra con el total ✓' : ` · no cierra: diferencia de ${money(dif)}`}
        </div>
        <div className="sm:w-56">{numero('total', 'Total')}</div>
      </div>

      <div className="flex justify-end gap-2">
        <Btn variant="fantasma" onClick={onCerrar}>
          Cancelar
        </Btn>
        <Btn disabled={guardando || !cuitOk} onClick={() => void guardar()}>
          {guardando ? 'Guardando…' : 'Guardar cambios'}
        </Btn>
      </div>
    </div>
  )
}
