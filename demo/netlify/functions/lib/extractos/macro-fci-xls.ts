// Banco Macro · "consulta_tenencias_FCI (N).xls" (Banca Internet Empresas, Excel 97-2003).
//   Tenencias en FCI
//   Nombre | Tenencias a la fecha | Cuotapartes | Ultimo valor de cuota disponible
//   <nombre del fondo> - Clase B | 1000000.50 | 15000.1234 | 66.665
//   Fecha de descarga: dd/mm/aaaa hh:mm:ss / Empresa: ... / Operador: ...
// Es una tenencia: un saldo, sin movimientos. Si hay varios fondos, el saldo de la cuenta es la suma.
// Fecha del saldo: el valor de cuota disponible a la mañana es el del cierre del día hábil anterior, así
// que se toma el día hábil anterior a la descarga (en VBI+ la descarga del 25/11 quedó al 24/11).
// Se puede indicar otra con opciones.fechaTenencia.

import { buscarEncabezado, diaHabilAnterior, fechaISO, numero, redondear2, texto } from './normalizar'
import { ErrorExtracto, type Lector } from './tipos'

const COLUMNAS = ['Nombre', 'Tenencias a la fecha', 'Cuotapartes']

export const macroFciXls: Lector = {
  formato: 'MACRO_FCI_TENENCIA_XLS',
  banco: 'MACRO',
  tenencia: true,
  tipos: ['XLS'],
  reconoce: (a) => buscarEncabezado(a.filas().slice(0, 10), COLUMNAS) != null,
  leer(a, o) {
    const filas = a.filas()
    const enc = buscarEncabezado(filas, COLUMNAS)!
    const c = enc.col
    let total = 0
    const fondos: string[] = []
    let descarga: string | null = null
    for (let i = enc.fila + 1; i < filas.length; i++) {
      const f = filas[i]
      const nombre = texto(f[c.Nombre] ?? null)
      if (!nombre) continue
      const m = /^Fecha de descarga:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(nombre)
      if (m) {
        descarga = fechaISO(m[1])
        continue
      }
      if (/^(empresa|operador):/i.test(nombre)) continue
      const tenencia = numero(f[c['Tenencias a la fecha']] ?? null)
      if (tenencia == null) throw new ErrorExtracto(`Fila ${i + 1}: el fondo "${nombre}" no tiene tenencia`)
      total += tenencia
      fondos.push(`${nombre}: ${tenencia.toFixed(2)} (${texto(f[c.Cuotapartes] ?? null)} cuotapartes)`)
    }
    if (!fondos.length) throw new ErrorExtracto('El informe de tenencias de Macro no tiene fondos')
    const fecha = o.fechaTenencia ?? (descarga ? diaHabilAnterior(descarga) : null)
    if (!fecha) throw new ErrorExtracto('El informe no dice la fecha de descarga: indicá la fecha del saldo (fechaTenencia)')
    const avisos = [`Tenencia al ${fecha}${o.fechaTenencia ? ' (fecha indicada a mano)' : ` (día hábil anterior a la descarga del ${descarga})`}: ${fondos.join('; ')}`]
    return { cuentas: [{ parte: 'UNICA', movimientos: [], saldos: [{ fecha, saldo: redondear2(total) }] }], avisos }
  },
}
