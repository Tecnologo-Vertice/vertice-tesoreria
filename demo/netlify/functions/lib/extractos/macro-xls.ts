// Banco Macro · "Ultimos_Movimientos (N).xls" (Banca Internet Empresas, Excel 97-2003).
//   Últimos Movimientos / CUENTA CORRIENTE BANCARIA / Tipo / Número / Moneda (encabezado del informe)
//   Fecha | Nro. de Referencia | Causal | Concepto | Importe | Saldo
//   <fecha de Excel> | 1000000001 | 1684 | DBCR 25413 S/DB TASA GRAL | -150 | 24850.55
//   Fecha de descarga: ... / Empresa: ... / Operador: ... (pie)
// El importe ya viene con signo. Del más nuevo al más viejo: se ordena por la cadena de saldos.

import { avisoSaldos, buscarEncabezado, clave, fechaISO, fechaObligatoria, numero, ordenCronologico, redondear2, referencia, texto } from './normalizar'
import { ErrorExtracto, type Lector, type MovimientoExtracto } from './tipos'

const COLUMNAS = ['Fecha', 'Nro. de Referencia', 'Causal', 'Concepto', 'Importe', 'Saldo']

export const macroXls: Lector = {
  formato: 'MACRO_XLS',
  banco: 'MACRO',
  tenencia: false,
  tipos: ['XLS'],
  reconoce: (a) => buscarEncabezado(a.filas().slice(0, 15), COLUMNAS) != null,
  leer(a) {
    const filas = a.filas()
    const enc = buscarEncabezado(filas, COLUMNAS)!
    const c = enc.col
    const avisos: string[] = []
    // Encabezado del informe: "Moneda | PESOS" (el valor puede estar varias columnas a la derecha).
    const filaMoneda = filas.slice(0, enc.fila).find((f) => clave(f[0] ?? null) === 'MONEDA')
    const moneda = filaMoneda?.slice(1).map((x) => texto(x)).find((x) => x !== '') ?? ''
    if (moneda && clave(moneda) !== 'PESOS') throw new ErrorExtracto(`La cuenta es en ${moneda}: solo se importan cuentas en pesos`)
    const movs: MovimientoExtracto[] = []
    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i]
      const v = f[c.Fecha] ?? null
      if (texto(v) === '') continue
      if (!fechaISO(v)) {
        if (/^(fecha de descarga|empresa|operador)/i.test(texto(v))) continue // pie del informe
        throw new ErrorExtracto(`Fila ${i + 1}: no se entiende la fecha "${texto(v)}"`)
      }
      const importe = numero(f[c.Importe] ?? null)
      if (importe == null) throw new ErrorExtracto(`Fila ${i + 1}: falta el importe`)
      movs.push({
        fecha: fechaObligatoria(v, i + 1),
        descripcion: texto(f[c.Concepto] ?? null),
        referencia: referencia(f[c['Nro. de Referencia']] ?? null),
        importe: redondear2(importe),
        saldo: numero(f[c.Saldo] ?? null),
        numero_cheque: null, // [FALTA ejemplo] de un cheque debitado en Macro
      })
    }
    if (!movs.length) throw new ErrorExtracto('El archivo de Macro no tiene movimientos')
    const orden = ordenCronologico(movs)
    avisos.push(...avisoSaldos(orden))
    return { cuentas: [{ parte: 'UNICA', movimientos: orden, saldos: [] }], avisos }
  },
}
