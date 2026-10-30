import { useMemo, useState } from 'react'
import { useFlujo, useStore } from '../store'
import { Badge, Btn, Card, Desplegable, Kpi, Table } from '../components/ui'
import { fecha, iso, money, moneyShort, pendiente } from '../lib/format'

export function Flujo() {
  const { modo, pagos, facturas, empresa, proveedor, toast, catalogos } = useStore()
  const EMPRESAS = catalogos.empresas
  const CUENTAS_ORIGEN = catalogos.cuentasOrigen
  const [empresaId, setEmpresaId] = useState<string>('TODAS')
  const semanas = useFlujo(empresaId)
  const max = Math.max(1, ...semanas.map((s) => Math.max(s.real, s.proyectado + s.vencido, s.cheques)))
  const saldo = CUENTAS_ORIGEN.filter((c) => empresaId === 'TODAS' || c.empresaId === empresaId).reduce((a, c) => a + c.saldo, 0)
  const proyectado30 = semanas.slice(2, 6).reduce((a, s) => a + s.proyectado + s.vencido, 0)
  const cheques = useMemo(
    () => pagos.filter((p) => p.numeroCheque && (empresaId === 'TODAS' || p.empresaId === empresaId)).sort((a, b) => (a.fechaAcreditacion ?? '').localeCompare(b.fechaAcreditacion ?? '')),
    [pagos, empresaId],
  )
  const chequesPend = cheques.filter((c) => (c.fechaAcreditacion ?? '') >= iso(new Date())).reduce((a, c) => a + c.importe, 0)

  // Export_CashFlow: lo que el Cash Flow de Santi leería con IMPORTRANGE.
  function exportar() {
    const filas = [
      ['FECHA', 'EMPRESA', 'CUENTA_CONTABLE', 'CONCEPTO', 'PROVEEDOR', 'INGRESO', 'EGRESO', 'MEDIO', 'CUENTA_ORIGEN', 'ESTADO', 'REFERENCIA', 'FACTURA_ASOCIADA'],
      ...pagos.map((p) => [p.fecha, empresa(p.empresaId).nombre, p.cuentaContable ?? '', p.descripcion, proveedor(p.proveedorId)?.nombre ?? '', '', p.importe.toFixed(2), p.medio, p.cuentaOrigen, 'REAL', p.xubioId ?? '', p.facturaIds.join(' ')]),
      ...facturas
        .filter((f) => f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL')
        .map((f) => [f.vencimiento, empresa(f.empresaId).nombre, f.cuentaContable ?? '', `Vence ${f.tipo}`, proveedor(f.proveedorId)?.nombre ?? '', '', pendiente(f).toFixed(2), f.metodoPago ?? '', '', 'PROYECTADO', '', f.id]),
    ]
    const csv = filas.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'Export_CashFlow.csv'
    a.click()
    toast('Export_CashFlow.csv generado: esto es lo que lee el Cash Flow de Santi', 'info')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Flujo de fondos</h2>
          <p className="text-sm text-seco">Pagos reales, facturas aprobadas por vencer y cheques a acreditar, por cuenta contable. Hoy esto se arma a mano.</p>
        </div>
        <div className="flex gap-2">
          <Desplegable compacto value={empresaId} onChange={setEmpresaId} opciones={[{ value: 'TODAS', label: 'Todas las empresas' }, ...EMPRESAS.map((e) => ({ value: e.id, label: e.nombre }))]} />
          <Btn variant="secundario" onClick={exportar}>
            Exportar para el Cash Flow
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Saldo en bancos y cajas" value={moneyShort(saldo)} sub={modo === 'demo' ? 'saldos ficticios' : 'cargados a mano, sin extractos todavía'} />
        <Kpi label="Egresos próximas 4 semanas" value={moneyShort(proyectado30)} sub="facturas aprobadas" tone="dorado" />
        <Kpi label="Cheques a acreditar" value={moneyShort(chequesPend)} sub={`${cheques.length} emitidos`} />
        <Kpi label="Caja proyectada a 30 días" value={moneyShort(saldo - proyectado30 - chequesPend)} tone={saldo - proyectado30 - chequesPend < 0 ? 'rojo' : 'verde'} />
      </div>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-serif text-xl">Semana a semana</h3>
          <div className="flex gap-3 text-[0.625rem] uppercase tracking-widest text-seco">
            <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-emerald-400/80" /> real</span>
            <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-dorado/80" /> proyectado</span>
            <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-red-400/80" /> vencido</span>
            <span className="flex items-center gap-1"><i className="inline-block w-3 h-3 rounded-sm bg-sky-400/80" /> cheques</span>
          </div>
        </div>
        <div className="grid grid-cols-8 gap-2 items-end h-56">
          {semanas.map((s, i) => {
            const esActual = i === 2
            return (
              <div key={i} className={`flex flex-col items-center justify-end h-full gap-1 rounded-lg px-1 ${esActual ? 'bg-dorado/5 border border-dorado/30' : ''}`}>
                <div className="flex items-end gap-0.5 w-full h-full justify-center">
                  <Barra v={s.real} max={max} cls="bg-emerald-400/80" titulo={`Real ${money(s.real)}`} />
                  <div className="flex flex-col justify-end w-1/3 h-full">
                    <Barra v={s.vencido} max={max} cls="bg-red-400/80" titulo={`Vencido ${money(s.vencido)}`} full />
                    <Barra v={s.proyectado} max={max} cls="bg-dorado/80" titulo={`Proyectado ${money(s.proyectado)}`} full />
                  </div>
                  <Barra v={s.cheques} max={max} cls="bg-sky-400/80" titulo={`Cheques ${money(s.cheques)}`} />
                </div>
                <p className={`text-[0.625rem] ${esActual ? 'text-acento font-bold' : 'text-seco'}`}>{esActual ? 'esta sem.' : fecha(iso(s.ini)).slice(0, 5)}</p>
              </div>
            )
          })}
        </div>
      </Card>

      <div className="grid lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-2">
          <h3 className="font-serif text-xl mb-3">Saldos por cuenta</h3>
          <Table head={['Empresa', 'Cuenta', 'Saldo']}>
            {CUENTAS_ORIGEN.filter((c) => empresaId === 'TODAS' || c.empresaId === empresaId).map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2 text-seco">{empresa(c.empresaId).corto}</td>
                <td className="px-4 py-2">{c.nombre}</td>
                <td className="px-4 py-2 font-semibold">{money(c.saldo)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card className="lg:col-span-3">
          <h3 className="font-serif text-xl mb-3">Cheques emitidos</h3>
          {cheques.length === 0 && <p className="text-sm text-seco italic">Sin cheques para esta selección.</p>}
          {cheques.length > 0 && (
            <Table head={['Acredita', 'Empresa', 'N°', 'Beneficiario', 'Importe']}>
              {cheques.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2">
                    <Badge tone={(c.fechaAcreditacion ?? '') >= iso(new Date()) ? 'azul' : 'neutro'}>{fecha(c.fechaAcreditacion)}</Badge>
                  </td>
                  <td className="px-4 py-2 text-seco">{empresa(c.empresaId).corto}</td>
                  <td className="px-4 py-2 font-mono text-xs">{c.numeroCheque}</td>
                  <td className="px-4 py-2 truncate max-w-[180px]">{proveedor(c.proveedorId)?.nombre ?? c.descripcion}</td>
                  <td className="px-4 py-2 font-semibold">{money(c.importe)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}

function Barra({ v, max, cls, titulo, full }: { v: number; max: number; cls: string; titulo: string; full?: boolean }) {
  const h = v > 0 ? Math.max(3, (v / max) * 100) : 0
  return <div title={titulo} className={`${full ? 'w-full' : 'w-1/3'} rounded-t ${cls} transition-all`} style={{ height: `${h}%` }} />
}
