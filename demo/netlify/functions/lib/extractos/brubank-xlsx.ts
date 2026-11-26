// Brubank · "Estado de cuenta Brubank <empresa> <desde> al <hasta>.xlsx".
// La cuenta corriente y la remunerada vienen en el MISMO Excel; la columna "Cuenta" dice de cuál es cada
// fila ("Cuenta corriente" / "Cuenta remunerada"). Se separan en dos partes: CC y REMUNERADA.
//   Fecha | Referencia | Descripcion | Moneda | Creditos | Debitos | Saldo | Cuenta
//   30-10-26 | 1000000001 | Cobro Interese por Sobregiro | ARS | - | $ 5,00 | - $ 5,00 | Cuenta corriente
// Los importes vienen como texto ("$ 1.234,56", "- $ 6,36", "-" = vacío); las fechas, dd-mm-aa.

import { avisoSaldos, buscarEncabezado, clave, fechaObligatoria, importeDesde, numero, ordenCronologico, referencia, texto } from './normalizar'
import { ErrorExtracto, type CuentaLeida, type Lector, type MovimientoExtracto } from './tipos'

const COLUMNAS = ['Fecha', 'Referencia', 'Descripcion', 'Moneda', 'Creditos', 'Debitos', 'Saldo', 'Cuenta']

function parte(v: string, fila: number): 'CC' | 'REMUNERADA' {
  const k = clave(v)
  if (k.includes('REMUNERADA')) return 'REMUNERADA'
  if (k.includes('CORRIENTE')) return 'CC'
  throw new ErrorExtracto(`Fila ${fila}: cuenta "${v}" desconocida (se esperaba Cuenta corriente o Cuenta remunerada)`)
}

export const brubankXlsx: Lector = {
  formato: 'BRUBANK_XLSX',
  banco: 'BRUBANK',
  tenencia: false,
  tipos: ['XLSX'],
  reconoce: (a) => buscarEncabezado(a.filas().slice(0, 5), COLUMNAS) != null,
  leer(a) {
    const filas = a.filas()
    const enc = buscarEncabezado(filas, COLUMNAS)!
    const c = enc.col
    const porParte = { CC: [] as MovimientoExtracto[], REMUNERADA: [] as MovimientoExtracto[] }
    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i]
      if (texto(f[c.Fecha]) === '') continue
      const moneda = texto(f[c.Moneda]).toUpperCase()
      if (moneda && moneda !== 'ARS') throw new ErrorExtracto(`Fila ${i + 1}: movimiento en ${moneda}; solo se importan cuentas en pesos`)
      porParte[parte(texto(f[c.Cuenta]), i + 1)].push({
        fecha: fechaObligatoria(f[c.Fecha], i + 1),
        descripcion: texto(f[c.Descripcion]),
        referencia: referencia(f[c.Referencia]),
        importe: importeDesde(f[c.Debitos], f[c.Creditos], i + 1),
        saldo: numero(f[c.Saldo]),
        // Brubank no informa el n.º de cheque ("Pago de Cheque Emitido" trae solo la referencia de la operación).
        numero_cheque: null,
      })
    }
    const cuentas: CuentaLeida[] = []
    const avisos: string[] = []
    for (const p of ['CC', 'REMUNERADA'] as const) {
      if (!porParte[p].length) continue
      const movs = ordenCronologico(porParte[p])
      cuentas.push({ parte: p, movimientos: movs, saldos: [] })
      avisos.push(...avisoSaldos(movs).map((x) => `${p === 'CC' ? 'Cuenta corriente' : 'Remunerada'}: ${x}`))
    }
    if (!cuentas.length) throw new ErrorExtracto('El Excel de Brubank no tiene movimientos')
    return { cuentas, avisos }
  },
}
