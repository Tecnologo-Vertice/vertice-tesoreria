import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Badge, BadgeVencimiento, Card, Kpi, Table } from '../components/ui'
import { diasHasta, fecha, money, moneyShort, nroComprobante, pendiente } from '../lib/format'

export function Vencimientos() {
  const { facturas, proveedor, empresa, catalogos } = useStore()
  const EMPRESAS = catalogos.empresas
  const [empresaId, setEmpresaId] = useState<string>('TODAS')

  const deuda = useMemo(() => {
    const base = facturas
      .filter((f) => (f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL') && (empresaId === 'TODAS' || f.empresaId === empresaId))
      .map((f) => ({ f, pendiente: pendiente(f), dias: diasHasta(f.vencimiento) }))
      .sort((a, b) => a.dias - b.dias)
    const suma = (pred: (d: number) => boolean) => base.filter((x) => pred(x.dias)).reduce((a, x) => a + x.pendiente, 0)
    return {
      lista: base,
      vencidas: suma((d) => d < 0),
      hoy: suma((d) => d === 0),
      d7: suma((d) => d > 0 && d <= 7),
      d30: suma((d) => d > 7 && d <= 30),
      total: suma(() => true),
      nVencidas: base.filter((x) => x.dias < 0).length,
    }
  }, [facturas, empresaId])

  const porEmpresa = useMemo(
    () =>
      EMPRESAS.filter((e) => empresaId === 'TODAS' || e.id === empresaId).map((e) => {
        const items = facturas.filter((f) => f.empresaId === e.id && (f.estado === 'PARA_PAGAR' || f.estado === 'PAGADA_PARCIAL'))
        const pend = (pred: (d: number) => boolean) => items.filter((f) => pred(diasHasta(f.vencimiento))).reduce((a, f) => a + pendiente(f), 0)
        return { e, vencido: pend((d) => d < 0), semana: pend((d) => d >= 0 && d <= 7), mes: pend((d) => d > 7 && d <= 30), total: pend(() => true), n: items.length }
      }).filter((x) => x.n > 0),
    [facturas, empresaId, EMPRESAS],
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
        <div>
          <h2 className="titulo-pagina">Vencimientos</h2>
          <p className="text-sm text-seco">Lo que el grupo debe pagar, ordenado por urgencia.</p>
        </div>
        <select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)} className="bg-pino border border-borde text-crema text-sm rounded-lg px-3 py-2 focus:border-dorado outline-none">
          <option value="TODAS">Todas las empresas</option>
          {EMPRESAS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Vencidas" value={moneyShort(deuda.vencidas)} sub={`${deuda.nVencidas} facturas`} tone="rojo" />
        <Kpi label="Vencen hoy" value={moneyShort(deuda.hoy)} tone="dorado" />
        <Kpi label="Próximos 7 días" value={moneyShort(deuda.d7)} />
        <Kpi label="8 a 30 días" value={moneyShort(deuda.d30)} />
        <Kpi label="Deuda aprobada" value={moneyShort(deuda.total)} sub="pendiente de pago" tone="crema" />
      </div>

      <Card>
        <h3 className="font-serif text-xl mb-3">Por empresa</h3>
        <Table head={['Empresa', 'ERP', 'Vencido', 'Esta semana', 'Hasta 30 días', 'Total pendiente']}>
          {porEmpresa.map(({ e, vencido, semana, mes, total }) => (
            <tr key={e.id} className="hover:bg-suave/60">
              <td className="px-4 py-2.5 font-semibold">{e.nombre}</td>
              <td className="px-4 py-2.5">
                <Badge tone={e.erp === 'XUBIO' ? 'verde' : 'naranja'}>{e.erp === 'XUBIO' ? 'Xubio' : 'Ralpharma'}</Badge>
              </td>
              <td className={`px-4 py-2.5 ${vencido > 0 ? 'text-red-300' : 'text-seco'}`}>{vencido > 0 ? money(vencido) : '—'}</td>
              <td className={`px-4 py-2.5 ${semana > 0 ? 'text-acento' : 'text-seco'}`}>{semana > 0 ? money(semana) : '—'}</td>
              <td className="px-4 py-2.5">{mes > 0 ? money(mes) : '—'}</td>
              <td className="px-4 py-2.5 font-semibold">{money(total)}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <h3 className="font-serif text-xl mb-3">Detalle por urgencia</h3>
        <Table head={['Vencimiento', 'Empresa', 'Proveedor', 'Comprobante', 'Cuenta contable', 'Método', 'Pendiente']}>
          {deuda.lista.map(({ f, pendiente }) => (
            <tr key={f.id} className="hover:bg-suave/60">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <BadgeVencimiento vencimiento={f.vencimiento} />
                  <span className="text-seco text-xs">{fecha(f.vencimiento)}</span>
                </div>
              </td>
              <td className="px-4 py-2.5">{empresa(f.empresaId).corto}</td>
              <td className="px-4 py-2.5">{proveedor(f.proveedorId)?.nombre}</td>
              <td className="px-4 py-2.5 text-seco text-xs">
                {f.tipo} {nroComprobante(f.puntoVenta, f.numero)}
              </td>
              <td className="px-4 py-2.5 text-xs">{f.cuentaContable}</td>
              <td className="px-4 py-2.5 text-xs">
                {f.metodoPago}
                {f.pagadoPct > 0 && <span className="text-seco"> · {f.pagadoPct}% pagado</span>}
              </td>
              <td className="px-4 py-2.5 font-semibold">{money(pendiente)}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}
