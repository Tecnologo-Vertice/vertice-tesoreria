// Banco Credicoop · "SaldMovs_CC-<cuenta>_<dd-mm-aaaa>.xls" (Excel 97-2003, hoja "saldos_y_movimientos").
//   Fecha | Concepto | Nro.Cpbte. | Débito | Crédito | Saldo | Cód.
//   12/11/2026 | Impuesto Ley 25.413 ... | 0 | 300 | 0 | 49700 | IDCC3
// Viene del más nuevo al más viejo y con filas vacías entre medio: se ordena por la cadena de saldos.

import { avisoSaldos, buscarEncabezado, fechaObligatoria, importeDesde, numero, ordenCronologico, referencia, texto } from './normalizar'
import { ErrorExtracto, type Lector, type MovimientoExtracto } from './tipos'

const COLUMNAS = ['Fecha', 'Concepto', 'Nro.Cpbte.', 'Débito', 'Crédito', 'Saldo']

export const credicoopXls: Lector = {
  formato: 'CREDICOOP_XLS',
  banco: 'CREDICOOP',
  tenencia: false,
  tipos: ['XLS'],
  reconoce: (a) => buscarEncabezado(a.filas().slice(0, 10), COLUMNAS) != null,
  leer(a) {
    const filas = a.filas()
    const enc = buscarEncabezado(filas, COLUMNAS)!
    const c = enc.col
    const movs: MovimientoExtracto[] = []
    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i] ?? []
      if (texto(f[c.Fecha] ?? null) === '') continue
      movs.push({
        fecha: fechaObligatoria(f[c.Fecha], i + 1),
        descripcion: texto(f[c.Concepto]),
        referencia: referencia(f[c['Nro.Cpbte.']] ?? null),
        importe: importeDesde(f[c['Débito']] ?? null, f[c['Crédito']] ?? null, i + 1),
        saldo: numero(f[c.Saldo] ?? null),
        numero_cheque: null, // [FALTA ejemplo] de un cheque debitado en Credicoop para saber dónde viene el número
      })
    }
    if (!movs.length) throw new ErrorExtracto('El archivo de Credicoop no tiene movimientos')
    const orden = ordenCronologico(movs)
    return { cuentas: [{ parte: 'UNICA', movimientos: orden, saldos: [] }], avisos: avisoSaldos(orden) }
  },
}
