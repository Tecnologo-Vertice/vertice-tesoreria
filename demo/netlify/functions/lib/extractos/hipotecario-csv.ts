// Banco Hipotecario · "Descarga_Movimientos (N).csv" (Home Banking empresas, CC y CA).
// Separador ";", fechas dd/mm/aaaa, importes con coma decimal y punto de miles.
//   FECHA;DESCRIPCION;SUCURSAL;REFERENCIA;DEBITO EN $;CREDITO EN $;SALDO EN $
//   03/11/2026;N/D - COMISION ...;0;33 Chq: 0;1.000,00;;9.000,00
// Al final trae una fila ";;;Total:;<débitos>;<créditos>;" y una leyenda: los totales se usan de control.

import { avisoSaldos, buscarEncabezado, fechaObligatoria, importeDesde, numero, numeroCheque, ordenCronologico, redondear2, texto, totales } from './normalizar'
import { ErrorExtracto, type Lector, type MovimientoExtracto } from './tipos'

const COLUMNAS = ['FECHA', 'DESCRIPCION', 'SUCURSAL', 'REFERENCIA', 'DEBITO EN $', 'CREDITO EN $', 'SALDO EN $']

export const hipotecarioCsv: Lector = {
  formato: 'HIPOTECARIO_CSV',
  banco: 'HIPOTECARIO',
  tenencia: false,
  tipos: ['CSV'],
  reconoce: (a) => buscarEncabezado(a.filas().slice(0, 5), COLUMNAS) != null,
  leer(a) {
    const filas = a.filas()
    const enc = buscarEncabezado(filas, COLUMNAS)!
    const c = enc.col
    const movs: MovimientoExtracto[] = []
    let control: { debitos: number; creditos: number } | null = null
    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i]
      if (f.every((x) => texto(x) === '')) continue
      // Fila de totales: sin fecha y con "Total:" en alguna columna.
      if (texto(f[c.FECHA]) === '' && f.some((x) => /^TOTAL:?$/i.test(texto(x)))) {
        control = { debitos: numero(f[c['DEBITO EN $']]) ?? 0, creditos: numero(f[c['CREDITO EN $']]) ?? 0 }
        continue
      }
      if (texto(f[c.FECHA]) === '' || f.length < 5) continue // leyenda del pie
      const ref = texto(f[c.REFERENCIA])
      movs.push({
        fecha: fechaObligatoria(f[c.FECHA], i + 1),
        descripcion: texto(f[c.DESCRIPCION]),
        referencia: ref || null,
        importe: importeDesde(f[c['DEBITO EN $']], f[c['CREDITO EN $']], i + 1),
        saldo: numero(f[c['SALDO EN $']]),
        numero_cheque: numeroCheque(ref),
      })
    }
    if (!movs.length) throw new ErrorExtracto('El archivo del Hipotecario no tiene movimientos')
    const avisos = avisoSaldos(movs)
    if (control) {
      const t = totales(movs)
      if (redondear2(t.debitos - control.debitos) !== 0 || redondear2(t.creditos - control.creditos) !== 0) {
        throw new ErrorExtracto(
          `Los totales del archivo no cierran: débitos ${t.debitos} contra ${control.debitos} del banco, créditos ${t.creditos} contra ${control.creditos}. No se importó nada.`,
        )
      }
    } else avisos.push('El archivo no trae la fila de totales del banco: no se pudo controlar contra ella')
    return { cuentas: [{ parte: 'UNICA', movimientos: ordenCronologico(movs), saldos: [] }], avisos }
  },
}
