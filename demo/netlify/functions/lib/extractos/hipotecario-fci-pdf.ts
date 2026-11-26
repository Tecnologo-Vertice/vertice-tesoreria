// Banco Hipotecario · FCI Toronto Trust (BACS) · "Informe_FCI_<n>.pdf" (resumen de cuenta del fondo).
//   FONDO: 1 - TORONTO TRUST AHORRO - Clase B - PESOS
//   Fecha Concepto Valor de Cuota Cantidad de Cuotas Monto
//   24/11/2026 Saldo Anterior 50,000000 200,000000 10.000,00
//   Total de su Inversión al 25/11/2026 $ 50,027500 200,00000000 $ 10.005,50
// Es una tenencia: se toman los saldos (el anterior y el total) y ningún movimiento. Las suscripciones y
// rescates del informe ya están en la cuenta madre (CC/CA del Hipotecario); la conciliación del FCI
// calcula el rendimiento con ellos (vista conciliacion_bancaria).

import { fechaObligatoria, numero, redondear2 } from './normalizar'
import { ErrorExtracto, type Lector, type SaldoExtracto } from './tipos'

const MONTO = '(-?[\\d.]+,\\d{2})'

export const hipotecarioFciPdf: Lector = {
  formato: 'HIPOTECARIO_FCI_PDF',
  banco: 'HIPOTECARIO',
  tenencia: true,
  tipos: ['PDF'],
  reconoce: (a) => /Total de su Inversi[oó]n al/i.test(a.texto()) && /(TORONTO|BACS)/i.test(a.texto()),
  leer(a) {
    const lineas = a.texto().split('\n')
    const totales = lineas.map((l) => new RegExp(`Total de su Inversi[oó]n al (\\d{2}/\\d{2}/\\d{4}).*?\\$?\\s*${MONTO}\\s*$`, 'i').exec(l)).filter((m) => m != null)
    if (totales.length !== 1) {
      throw new ErrorExtracto(
        totales.length ? 'El informe trae más de un fondo: [FALTA ejemplo] de informe con varios fondos, subilo para armar el lector' : 'No se encontró el total de la inversión en el informe',
      )
    }
    const saldos: SaldoExtracto[] = []
    const anterior = lineas.map((l) => new RegExp(`^(\\d{2}/\\d{2}/\\d{4})\\s+Saldo Anterior\\b.*\\s${MONTO}\\s*$`, 'i').exec(l)).find((m) => m != null)
    if (anterior) saldos.push({ fecha: fechaObligatoria(anterior[1], 0), saldo: redondear2(numero(anterior[2])!) })
    const total = totales[0]!
    const fechaTotal = fechaObligatoria(total[1], 0)
    if (saldos[0]?.fecha === fechaTotal) saldos.pop()
    saldos.push({ fecha: fechaTotal, saldo: redondear2(numero(total[2])!) })

    const avisos: string[] = []
    const fondo = lineas.find((l) => /^FONDO:/i.test(l))
    if (fondo) avisos.push(fondo.trim())
    const otros = lineas.filter((l) => /^\d{2}\/\d{2}\/\d{4}\s/.test(l) && !/Saldo Anterior/i.test(l))
    if (otros.length) {
      avisos.push(`El informe trae ${otros.length} movimiento(s) del fondo (suscripciones/rescates): no se importan acá, entran por la cuenta madre`)
    }
    return { cuentas: [{ parte: 'UNICA', movimientos: [], saldos }], avisos }
  },
}
