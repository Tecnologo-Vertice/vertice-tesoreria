// Cifrado de las credenciales que se guardan en la base (tabla conexiones_erp, migración 0021).
// AES-256-GCM de node:crypto, sin dependencias. La clave vive solo en una variable del servidor:
//   CREDENCIALES_CLAVE           32 bytes al azar en base64 (la actual: con esta se cifra todo lo nuevo).
//   CREDENCIALES_CLAVE_ANTERIOR  opcional, la clave de antes durante un cambio de clave: solo se usa para leer.
// Cada dato cifrado lleva la huella de la clave con que se cifró (8 caracteres del SHA-256 de la clave, que
// no permite reconstruirla) y queda atado a su lugar (por ejemplo, empresa y ERP): copiado a otra empresa
// no se puede descifrar. Ningún mensaje de error incluye la clave ni el dato en claro.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { ErrorHttp } from './comun'

const VERSION = 'v1'
/** Largo de la etiqueta de GCM. Se exige exacto: Node acepta etiquetas recortadas (de 4 bytes en adelante). */
const LARGO_ETIQUETA = 16
const LARGO_IV = 12
export const VARIABLE_CLAVE = 'CREDENCIALES_CLAVE'
export const VARIABLE_CLAVE_ANTERIOR = 'CREDENCIALES_CLAVE_ANTERIOR'

interface Clave {
  bytes: Buffer
  huella: string
}

const b64 = (b: Buffer) => b.toString('base64url')

function leerClave(nombre: string): Clave | null {
  const texto = (process.env[nombre] ?? '').trim()
  if (!texto) return null
  const bytes = Buffer.from(texto, 'base64')
  if (bytes.length !== 32) throw new ErrorHttp(500, `${nombre} está mal configurada: tiene que ser una clave de 32 bytes escrita en base64 (44 caracteres).`)
  return { bytes, huella: createHash('sha256').update(bytes).digest('hex').slice(0, 8) }
}

/** ¿Hay clave para cifrar? Sin ella, el alta de credenciales en la base se rechaza y todo sigue con las variables. */
export const hayClave = () => leerClave(VARIABLE_CLAVE) !== null

/** Cifra `texto` atado a `lugar` (por ejemplo "conexiones_erp:beratung:XUBIO"). */
export function cifrar(texto: string, lugar: string): string {
  const clave = leerClave(VARIABLE_CLAVE)
  if (!clave) throw new ErrorHttp(503, `Falta configurar ${VARIABLE_CLAVE} en las variables del servidor: sin esa clave no se guardan credenciales en la base. Mientras tanto se siguen usando las variables de siempre.`)
  const iv = randomBytes(LARGO_IV)
  const c = createCipheriv('aes-256-gcm', clave.bytes, iv, { authTagLength: LARGO_ETIQUETA })
  c.setAAD(Buffer.from(lugar, 'utf8'))
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  return [VERSION, clave.huella, b64(iv), b64(c.getAuthTag()), b64(datos)].join(':')
}

export interface Descifrado {
  texto: string
  /** Se descifró con la clave anterior: conviene volver a cifrarlo con la actual. */
  conClaveAnterior: boolean
}

/** Descifra lo que devolvió `cifrar` para el mismo `lugar`. `nombre` es cómo se nombra el dato en los errores. */
export function descifrar(cifrado: string, lugar: string, nombre: string): Descifrado {
  const partes = cifrado.split(':')
  if (partes.length !== 5 || partes[0] !== VERSION) throw new ErrorHttp(500, `${nombre}: el dato guardado no tiene el formato esperado.`)
  const [, huella, iv, etiqueta, datos] = partes
  const actual = leerClave(VARIABLE_CLAVE)
  const anterior = leerClave(VARIABLE_CLAVE_ANTERIOR)
  const clave = [actual, anterior].find((k) => k?.huella === huella)
  if (!clave)
    throw new ErrorHttp(500, `${nombre}: se guardaron con una clave que no está configurada (huella ${huella}). Revisar ${VARIABLE_CLAVE} y ${VARIABLE_CLAVE_ANTERIOR}, o volver a cargarlas.`)
  const bytesIv = Buffer.from(iv, 'base64url')
  const bytesEtiqueta = Buffer.from(etiqueta, 'base64url')
  try {
    if (bytesIv.length !== LARGO_IV || bytesEtiqueta.length !== LARGO_ETIQUETA) throw new Error('largo')
    const d = createDecipheriv('aes-256-gcm', clave.bytes, bytesIv, { authTagLength: LARGO_ETIQUETA })
    d.setAAD(Buffer.from(lugar, 'utf8'))
    d.setAuthTag(bytesEtiqueta)
    const texto = Buffer.concat([d.update(Buffer.from(datos, 'base64url')), d.final()]).toString('utf8')
    return { texto, conClaveAnterior: clave !== actual }
  } catch {
    throw new ErrorHttp(500, `${nombre}: no se pudieron descifrar. El dato se alteró o no corresponde a este lugar; hay que volver a cargarlas.`)
  }
}
