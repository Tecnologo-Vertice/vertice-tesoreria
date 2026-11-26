// De dónde salen las planillas: la API de Google Sheets (solo lectura) o instantáneas guardadas antes.
// Los IDs de las planillas NO están en el repo: van por variable de entorno.
import { createSign } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Pestañas y columnas que lee cada paso. Solo lectura: el script nunca escribe en una planilla.
export const PLANILLAS = {
  vbi: {
    env: 'PLANILLA_VBI', nombre: 'VBI+',
    rangos: ['Cuentas_Extracto!A1:F300', 'Extractos_Reglas!A1:F300', 'Extractos_Movimientos!A1:R5000', 'Conciliacion_Diaria!A1:P5000',
      'Proyecciones!A1:P2000', 'Flujo_Cambios_Manuales!A1:J5000', 'Cobros_Xubio!A1:M5000', 'Robot_Echeqs_Log!A1:J5000',
      'Catalogo_Percepciones_IIBB!A1:D500'],
  },
  motor: {
    env: 'PLANILLA_MOTOR', nombre: 'Motor del Flujo',
    rangos: ['Cuentas Bancarias!A1:F300', 'Gastos Fijos!A1:H1000', 'Mapa Flujo!A1:F3000', 'Llave Flujo v2!A1:L10000',
      'Saldos Xubio Historial!A1:G10000', 'Bancos Movimientos!A1:L10000',
      'Beratung S/Dax v2!A1:F2000', 'Dax Salud v2!A1:F2000', 'India v2!A1:F2000', 'Vertice v2!A1:F2000'],
  },
  original: {
    env: 'PLANILLA_FLUJO_ORIGINAL', nombre: 'Flujo original',
    rangos: ['Beratung S/Dax!A1:BA1500', 'Dax Salud!A1:BA1500', 'India!A1:BA1500', 'Vertice!A1:CQ1500'],
  },
  cashflow: {
    env: 'PLANILLA_CASHFLOW', nombre: 'Cash Flow de cheques',
    rangos: ['CHEQUES EMITIDOS!A1:N10000', 'Categoría!A1:F3000'],
  },
}

const CAMPOS = 'sheets(properties.title,data.rowData.values(formattedValue,effectiveValue.numberValue,userEnteredValue.formulaValue))'

export function idsDePlanillas(env = process.env) {
  const ids = {}, faltan = []
  for (const [k, p] of Object.entries(PLANILLAS)) {
    if (env[p.env]) ids[k] = env[p.env]; else faltan.push(`${p.env} (${p.nombre})`)
  }
  return { ids, faltan }
}

/** Lee las cuatro planillas. origen = { instantaneas: dir } o { google: true }. */
export async function leerPlanillas(ids, origen, { guardarEn = null, repo = null } = {}) {
  const out = {}
  let token = null
  for (const [k, id] of Object.entries(ids)) {
    if (origen.instantaneas) {
      const f = join(origen.instantaneas, `${id}.json`)
      if (!existsSync(f)) throw new Error(`No está la instantánea de ${PLANILLAS[k].nombre}: ${f}`)
      const d = JSON.parse(readFileSync(f, 'utf8'))
      out[k] = d.content ?? d
    } else {
      token ??= await tokenGoogle()
      out[k] = await leerDeGoogle(id, PLANILLAS[k].rangos, token)
    }
    if (guardarEn) {
      if (repo && resolve(guardarEn).startsWith(resolve(repo))) throw new Error('Las instantáneas tienen datos reales: no se guardan dentro del repo')
      mkdirSync(guardarEn, { recursive: true, mode: 0o700 })
      writeFileSync(join(guardarEn, `${id}.json`), JSON.stringify(out[k]), { mode: 0o600 })
    }
  }
  return out
}

async function leerDeGoogle(id, rangos, token) {
  const u = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`)
  u.searchParams.set('includeGridData', 'true')
  u.searchParams.set('fields', CAMPOS)
  for (const r of rangos) u.searchParams.append('ranges', r)
  const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

/** Token de solo lectura: GOOGLE_ACCESS_TOKEN, o una cuenta de servicio (GOOGLE_APPLICATION_CREDENTIALS = ruta al JSON). */
async function tokenGoogle(env = process.env) {
  if (env.GOOGLE_ACCESS_TOKEN) return env.GOOGLE_ACCESS_TOKEN
  if (!env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Falta GOOGLE_ACCESS_TOKEN o GOOGLE_APPLICATION_CREDENTIALS (cuenta de servicio con lectura de las planillas)')
  const sa = JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const ahora = Math.floor(Date.now() / 1000)
  const cuerpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3000,
  })}`
  const firma = createSign('RSA-SHA256').update(cuerpo).sign(sa.private_key).toString('base64url')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cuerpo}.${firma}` }),
  })
  if (!res.ok) throw new Error(`Token de Google ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).access_token
}
