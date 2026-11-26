// ¿El archivo es de la cuenta elegida? (revisión T-207, hallazgo 9)
// El lector reconoce el banco por el contenido, pero dos cuentas del mismo banco y la misma empresa (una CA y
// una CC, o las de dos unidades) tienen el mismo formato: si Tesorería elige mal la cuenta, el archivo entraba
// entero en la otra. Acá se busca el número de cuenta (o el CBU) en el nombre del archivo —así los baja el
// banco: "Extracto_CC0010012345.csv", "SaldMovs_CC-0010012345.xls"— y, en los CSV, en el encabezado.
//   · aparece el número de la cuenta elegida            → COINCIDE
//   · aparece el de otra cuenta del mismo banco y empresa → OTRA (no se importa)
//   · no aparece ninguno                                  → SIN_DATOS (se importa; si hay otra cuenta posible, avisa)
// Sin adivinar: solo se compara contra los números cargados en cuentas_origen.

export interface CuentaComparable {
  id: string
  nombre: string
  numero?: string | null
  cbu?: string | null
}

export type VerificacionCuenta =
  | { estado: 'COINCIDE' }
  | { estado: 'OTRA'; cuenta: CuentaComparable }
  | { estado: 'SIN_DATOS'; aviso: string | null }

const digitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

/** 20261124, 24112026: una fecha en el nombre del archivo no es un número de cuenta. */
function pareceFecha(d: string): boolean {
  if (d.length !== 8) return false
  const ok = (a: string, m: string, dd: string) => /^20\d\d$/.test(a) && Number(m) >= 1 && Number(m) <= 12 && Number(dd) >= 1 && Number(dd) <= 31
  return ok(d.slice(0, 4), d.slice(4, 6), d.slice(6, 8)) || ok(d.slice(4, 8), d.slice(2, 4), d.slice(0, 2))
}

/** ¿Los números de esta cuenta están en el nombre del archivo o en su encabezado? */
function aparece(c: CuentaComparable, nombreArchivo: string, encabezado: string): boolean {
  const corridas = (nombreArchivo.match(/\d+/g) ?? []).filter((d) => d.length >= 4 && !pareceFecha(d))
  const nombreJunto = digitos(nombreArchivo)
  const textoJunto = encabezado.split(/\r?\n/).map(digitos).join('\n')
  for (const clave of [digitos(c.numero), digitos(c.cbu)]) {
    if (clave.length < 4) continue
    // El número entero (6 dígitos o más), aunque el archivo lo escriba con guiones o barras.
    if (clave.length >= 6 && (nombreJunto.includes(clave) || textoJunto.includes(clave))) return true
    // O el nombre del archivo trae el final del número (los bancos suelen poner los últimos dígitos).
    if (corridas.some((d) => clave.endsWith(d) || d.endsWith(clave))) return true
  }
  return false
}

/**
 * @param hermanas las otras cuentas activas del mismo banco y la misma empresa en las que este archivo podría entrar
 * @param encabezado primeras líneas del archivo si es de texto (CSV); vacío si no
 */
export function verificarCuentaDelArchivo(nombreArchivo: string, encabezado: string, elegida: CuentaComparable, hermanas: CuentaComparable[]): VerificacionCuenta {
  if (aparece(elegida, nombreArchivo, encabezado)) return { estado: 'COINCIDE' }
  const otras = hermanas.filter((h) => h.id !== elegida.id && aparece(h, nombreArchivo, encabezado))
  if (otras.length) return { estado: 'OTRA', cuenta: otras[0] }
  if (!hermanas.length) return { estado: 'SIN_DATOS', aviso: null }
  const sinNumero = digitos(elegida.numero).length < 4 && digitos(elegida.cbu).length < 4
  return {
    estado: 'SIN_DATOS',
    aviso: sinNumero
      ? `No se pudo controlar que el archivo sea de ${elegida.nombre}: la cuenta no tiene número ni CBU cargados y hay ${hermanas.length} cuenta(s) más de ese banco. Revisalo.`
      : `El archivo no dice de qué cuenta es: revisá que sea de ${elegida.nombre} (hay ${hermanas.length} cuenta(s) más de ese banco).`,
  }
}
