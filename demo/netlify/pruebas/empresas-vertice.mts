// Las 8 empresas de Vértice como las devuelve la base después de la migración 0020: con sus alias.
// Las pruebas de lectura (factura.prueba.mts) y de la copia de la hoja (espejo.prueba.mts) las reciben
// como datos, igual que el código en producción, que las lee de la tabla empresas.
// supabase/pruebas/probar.mjs comprueba que esta lista sea igual a lo que carga la migración.
import type { EmpresaRef } from '../functions/lib/factura.ts'

export const EMPRESAS_VERTICE: EmpresaRef[] = [
  { id: 'beratung', nombre: 'Beratung S.A.', cuit: '00000000000', erp: 'XUBIO', alias: ['beratung'], alias_emisor: [], alias_orden: 10 },
  { id: 'india', nombre: 'INDIA ADV S.A.', cuit: '00000000001', erp: 'XUBIO', alias: ['india'], alias_emisor: [], alias_orden: 20 },
  { id: 'controlb', nombre: 'Control B', cuit: '00000000002', erp: 'XUBIO', alias: ['control b'], alias_emisor: [], alias_orden: 30 },
  { id: 'ysd', nombre: 'YSD Pharma S.A.', cuit: '00000000003', erp: 'XUBIO', alias: ['ysd'], alias_emisor: [], alias_orden: 40 },
  { id: 'vertice', nombre: 'Vértice BI S.A.', cuit: '00000000004', erp: 'XUBIO', alias: ['vertice'], alias_emisor: [], alias_orden: 80 },
  { id: 'robles', nombre: 'Droguería Robles S.A.', cuit: '00000000005', erp: 'RALPHARMA', alias: ['drogueria+robles'], alias_emisor: ['droguer+robles'], alias_orden: 50 },
  { id: 'hrobles', nombre: 'Héctor Daniel Robles', cuit: '00000000006', erp: 'RALPHARMA', alias: ['robles+hector', 'robles+daniel'], alias_emisor: ['hector+robles'], alias_orden: 60 },
  { id: 'farmacontrol', nombre: 'Farma Control S.A.', cuit: '00000000007', erp: 'RALPHARMA', alias: ['farma control'], alias_emisor: [], alias_orden: 70 },
]

/** Completa una lista corta de empresas de una prueba con el ERP y los alias de la lista de arriba. */
export function conAlias(empresas: EmpresaRef[]): EmpresaRef[] {
  return empresas.map((e) => {
    const v = EMPRESAS_VERTICE.find((x) => x.id === e.id)
    return v ? { ...e, erp: v.erp, alias: v.alias, alias_emisor: v.alias_emisor, alias_orden: v.alias_orden } : e
  })
}
