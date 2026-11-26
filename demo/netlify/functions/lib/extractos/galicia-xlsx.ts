// Banco Galicia · "Extracto_CC<cuenta>.xlsx" (Office Banking, hoja "Movimientos").
//   Fecha | Descripción | Origen | Débitos | Créditos | Grupo de Conceptos | Concepto | Número de Terminal |
//   Observaciones Cliente | Número de Comprobante | Leyendas Adicionales 1..4 | Tipo de Movimiento | Saldo
// Fecha como fecha de Excel; importes como número (débito y crédito en positivo). La descripción sola es
// pobre ("Iva", "Comision Servicio De Cuenta"): se le suman concepto y leyendas para que las reglas
// la reconozcan, igual que en VBI+ (separadas por " · ").

import { avisoSaldos, buscarEncabezado, clave, fechaObligatoria, importeDesde, numero, ordenCronologico, referencia, texto } from './normalizar'
import { ErrorExtracto, type Lector, type MovimientoExtracto } from './tipos'

const COLUMNAS = ['Fecha', 'Descripción', 'Débitos', 'Créditos', 'Grupo de Conceptos', 'Concepto', 'Saldo']
const DETALLE = ['Grupo de Conceptos', 'Concepto', 'Observaciones Cliente', 'Leyendas Adicionales 1', 'Leyendas Adicionales 2', 'Leyendas Adicionales 3', 'Leyendas Adicionales 4', 'Tipo de Movimiento']

export const galiciaXlsx: Lector = {
  formato: 'GALICIA_XLSX',
  banco: 'GALICIA',
  tenencia: false,
  tipos: ['XLSX'],
  reconoce: (a) => buscarEncabezado(a.filas().slice(0, 5), COLUMNAS) != null,
  leer(a) {
    const filas = a.filas()
    const enc = buscarEncabezado(filas, COLUMNAS)!
    const c = enc.col
    const encabezado = filas[enc.fila].map(clave)
    const detalle = DETALLE.map((d) => encabezado.indexOf(clave(d))).filter((j) => j >= 0)
    const comp = encabezado.indexOf(clave('Número de Comprobante'))
    const movs: MovimientoExtracto[] = []
    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i]
      if (texto(f[c.Fecha] ?? null) === '') continue
      const partes = [texto(f[c['Descripción']] ?? null)]
      for (const j of detalle) if (texto(f[j] ?? null) !== '') partes.push(texto(f[j]))
      movs.push({
        fecha: fechaObligatoria(f[c.Fecha], i + 1),
        descripcion: partes.join(' · '),
        referencia: comp >= 0 ? referencia(f[comp] ?? null) : null,
        importe: importeDesde(f[c['Débitos']] ?? null, f[c['Créditos']] ?? null, i + 1),
        saldo: numero(f[c.Saldo] ?? null),
        numero_cheque: null, // [FALTA ejemplo] de un cheque debitado en Galicia
      })
    }
    if (!movs.length) throw new ErrorExtracto('El Excel de Galicia no tiene movimientos')
    const orden = ordenCronologico(movs)
    return { cuentas: [{ parte: 'UNICA', movimientos: orden, saldos: [] }], avisos: avisoSaldos(orden) }
  },
}
