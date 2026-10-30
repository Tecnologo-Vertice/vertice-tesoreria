import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { Badge, Card, Desplegable, Table } from '../components/ui'
import { fechaHora } from '../lib/format'

const ACCIONES: Record<string, { label: string; tone: 'neutro' | 'dorado' | 'rojo' | 'verde' | 'azul' | 'naranja' }> = {
  INGRESO: { label: 'Ingreso por IA', tone: 'neutro' },
  APROBACION: { label: 'Aprobación', tone: 'dorado' },
  RECHAZO: { label: 'Rechazo', tone: 'rojo' },
  CORRECCION: { label: 'Corrección', tone: 'naranja' },
  PAGO_CARGADO: { label: 'Pago cargado', tone: 'azul' },
  CONTABILIZADO: { label: 'Contabilizado', tone: 'verde' },
  CARGADO_RALPHARMA: { label: 'Cargado en Ralpharma', tone: 'verde' },
  MAIL_PROVEEDOR: { label: 'Mail a proveedor', tone: 'azul' },
  MAIL_PENDIENTE: { label: 'Mail pendiente', tone: 'naranja' },
  REVISADO_EN_SECO: { label: 'Revisado en seco', tone: 'dorado' },
}

export function Auditoria() {
  const { auditoria } = useStore()
  const [usuario, setUsuario] = useState('TODOS')
  const [accion, setAccion] = useState('TODAS')
  const usuarios = useMemo(() => Array.from(new Set(auditoria.map((a) => a.usuario))), [auditoria])
  const lista = useMemo(
    () => [...auditoria].reverse().filter((a) => (usuario === 'TODOS' || a.usuario === usuario) && (accion === 'TODAS' || a.accion === accion)),
    [auditoria, usuario, accion],
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="titulo-pagina">Auditoría</h2>
        <p className="text-sm text-seco">Registro de solo inserción: quién aprobó, pagó y contabilizó cada cosa. Hoy la hoja no guarda esto.</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Desplegable compacto value={usuario} onChange={setUsuario} opciones={[{ value: 'TODOS', label: 'Todas las personas' }, ...usuarios.map((u) => ({ value: u, label: u }))]} />
        <Desplegable compacto value={accion} onChange={setAccion} opciones={[{ value: 'TODAS', label: 'Todas las acciones' }, ...Object.entries(ACCIONES).map(([k, v]) => ({ value: k, label: v.label }))]} />
        <span className="self-center text-xs text-seco">{lista.length} eventos</span>
      </div>
      <Card className="p-0 overflow-hidden">
        <Table head={['Cuándo', 'Quién', 'Rol', 'Acción', 'Entidad', 'Detalle']}>
          {lista.slice(0, 120).map((a) => (
            <tr key={a.id} className="hover:bg-suave/60">
              <td className="px-4 py-2 text-xs text-seco whitespace-nowrap">{fechaHora(a.fecha)}</td>
              <td className="px-4 py-2 font-semibold">{a.usuario}</td>
              <td className="px-4 py-2 text-xs text-seco">{a.rol}</td>
              <td className="px-4 py-2">
                <Badge tone={ACCIONES[a.accion]?.tone ?? 'neutro'}>{ACCIONES[a.accion]?.label ?? a.accion}</Badge>
              </td>
              <td className="px-4 py-2 text-xs font-mono text-seco">
                {a.entidad} {a.entidadId}
              </td>
              <td className="px-4 py-2 text-xs">{a.detalle}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}
