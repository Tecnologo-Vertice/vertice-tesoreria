// Qué rol puede hacer qué. Es el mismo criterio que exige_rol() en supabase/migrations/0003_funciones.sql
// y exigirRol() en netlify/functions: la pantalla solo esconde botones, la base es la que decide.

import type { Rol } from '../types'

export type Accion = 'APROBAR' | 'PAGAR' | 'CONTABILIZAR' | 'ANULAR_PAGO'

const PERMISOS: Record<Accion, Rol[]> = {
  APROBAR: ['APROBADOR', 'ADMINISTRACION', 'ADMIN'],
  PAGAR: ['TESORERIA', 'ADMINISTRACION', 'ADMIN'],
  CONTABILIZAR: ['ADMINISTRACION', 'ADMIN'],
  ANULAR_PAGO: ['TESORERIA', 'ADMINISTRACION', 'ADMIN'],
}

export function puede(rol: Rol, accion: Accion): boolean {
  return PERMISOS[accion].includes(rol)
}
