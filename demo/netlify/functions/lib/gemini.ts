// Lectura de comprobantes de pago con Gemini. El prompt es el que usa producción
// (extraerDatosPagoConGemini_ en Code.gs), con salida forzada a un esquema JSON fijo.
// Cambiar de proveedor de IA es cambiar este archivo; el contrato (LecturaComprobante) no cambia.

import { env, ErrorHttp } from './comun'

export interface LecturaComprobante {
  banco: string
  importe: number
  fecha: string
  medio: 'TRANSFERENCIA' | 'CHEQUE' | 'ECHEQ' | 'DEBITO' | 'TARJETA' | 'CAJA'
  numeroCheque?: string
  bancoDestino?: string
  beneficiario?: string
  referencia?: string
  confianza: number
}

const PROMPT = `Actuá como un extractor experto en comprobantes bancarios argentinos (transferencias, cheques, e-cheqs, débitos, recibos).
Extraé la siguiente información en formato JSON estricto:
- BENEFICIARIO: nombre o razón social de quien RECIBE el pago.
- PAGADOR: nombre o razón social de quien REALIZA el pago.
- DESCRIPCION: concepto o motivo del pago.
- BANCO_ORIGEN: banco desde donde SALE el dinero.
- NUMERO_CUENTA_ORIGEN: número de cuenta o CBU emisor, si aparece.
- BANCO_DESTINO: banco donde RECIBE el dinero el beneficiario. Si es un cheque, el banco contra el que se emite.
- MEDIO: uno de TRANSFERENCIA, CHEQUE, ECHEQ, DEBITO, TARJETA, CAJA.
- NUMERO_CHEQUE: número de cheque o e-cheq, si corresponde; si no, vacío.
- FECHA: fecha del comprobante en formato YYYY-MM-DD.
- IMPORTE: monto total numérico, sin separadores de miles, con punto decimal.
- REFERENCIA: número de operación, de transferencia o de VEP, si aparece.
- CONFIANZA: número entre 0 y 1 que indique qué tan legible y completo es el comprobante.
Reglas:
1. No confundas el banco de origen con el de destino. El BANCO_DESTINO siempre pertenece a quien cobra.
2. Si el banco no está explícito pero hay un CBU, inferilo por los primeros 3 dígitos (007 Galicia, 014 BBVA, 072 Santander, 011 Nación, 029 Ciudad, 027 Provincia, 285 Macro, 191 Credicoop).
3. Si un dato no está, devolvé cadena vacía o 0. No inventes.`

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    BENEFICIARIO: { type: 'STRING' },
    PAGADOR: { type: 'STRING' },
    DESCRIPCION: { type: 'STRING' },
    BANCO_ORIGEN: { type: 'STRING' },
    NUMERO_CUENTA_ORIGEN: { type: 'STRING' },
    BANCO_DESTINO: { type: 'STRING' },
    MEDIO: { type: 'STRING' },
    NUMERO_CHEQUE: { type: 'STRING' },
    FECHA: { type: 'STRING' },
    IMPORTE: { type: 'NUMBER' },
    REFERENCIA: { type: 'STRING' },
    CONFIANZA: { type: 'NUMBER' },
  },
  required: ['IMPORTE', 'FECHA', 'MEDIO', 'CONFIANZA'],
}

const MEDIOS = new Set(['TRANSFERENCIA', 'CHEQUE', 'ECHEQ', 'DEBITO', 'TARJETA', 'CAJA'])

/** Tope de tiempo de cada llamada a la IA. Se cambia con GEMINI_TIMEOUT_MS. */
export const topeGeminiMs = () => Number(env('GEMINI_TIMEOUT_MS', false)) || 25_000

/**
 * Una llamada a Gemini con salida JSON forzada. Si el modelo principal está saturado (503) o sin
 * cuota (429), prueba una vez con el de respaldo, como hace Code.gs. ErrorHttp 422 = el archivo no
 * se puede leer (no tiene sentido reintentar); 429/502/504 = problema transitorio de la IA.
 * Si la IA no contesta dentro del tope, corta con 504 y no prueba el modelo de respaldo.
 */
export async function llamarGemini(args: { prompt: string; schema: unknown; mimeType: string; data: string }): Promise<Record<string, unknown>> {
  const key = env('GEMINI_API_KEY')
  const modelos = [env('GEMINI_MODEL', false) || 'gemini-3.5-flash-lite', env('GEMINI_MODEL_RESPALDO', false) || 'gemini-3.6-flash']
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: args.prompt }, { inlineData: { mimeType: args.mimeType, data: args.data } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: args.schema },
  })
  const ms = topeGeminiMs()
  let r: { status: number; ok: boolean; cuerpo: string } | null = null
  for (const modelo of modelos) {
    try {
      // La clave va en un header y no en la URL, para que no quede en logs de red.
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(ms),
      })
      r = { status: resp.status, ok: resp.ok, cuerpo: await resp.text() }
    } catch (e) {
      const nombre = e instanceof Error ? e.name : ''
      if (nombre === 'TimeoutError' || nombre === 'AbortError') throw new ErrorHttp(504, `La IA no respondió en ${Math.max(1, Math.round(ms / 1000))} s; probá de nuevo en un minuto`)
      throw new ErrorHttp(502, `No se pudo conectar con la IA: ${e instanceof Error ? e.message : e}`)
    }
    if (r.status !== 429 && r.status !== 503) break
  }
  if (!r) throw new ErrorHttp(502, 'Sin respuesta de la IA')
  if (r.status === 400) throw new ErrorHttp(422, 'La IA rechazó el archivo (PDF dañado, protegido o vacío)')
  if (r.status === 429) throw new ErrorHttp(429, 'Cuota de IA agotada; probá en un minuto')
  if (!r.ok) throw new ErrorHttp(502, `Error de IA (${r.status})`)
  let j: { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  try {
    j = JSON.parse(r.cuerpo)
  } catch {
    throw new ErrorHttp(502, 'La IA devolvió una respuesta que no es JSON')
  }
  const texto = j.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  try {
    return JSON.parse(texto) as Record<string, unknown>
  } catch {
    throw new ErrorHttp(502, 'La IA devolvió una respuesta que no es JSON')
  }
}

export async function leerComprobanteConGemini(args: { nombre: string; mimeType: string; data: string }): Promise<LecturaComprobante> {
  const raw = await llamarGemini({ prompt: `${PROMPT}\nEl archivo se llama "${args.nombre}".`, schema: SCHEMA, mimeType: args.mimeType, data: args.data })
  const s = (k: string) => String(raw[k] ?? '').trim()
  const medio = MEDIOS.has(s('MEDIO').toUpperCase()) ? (s('MEDIO').toUpperCase() as LecturaComprobante['medio']) : s('NUMERO_CHEQUE') ? 'CHEQUE' : 'TRANSFERENCIA'
  const confianzaIA = Number(raw.CONFIANZA)
  const presentes = ['IMPORTE', 'FECHA', 'BANCO_ORIGEN', 'BENEFICIARIO'].filter((k) => raw[k] && raw[k] !== 0).length / 4
  return {
    banco: s('BANCO_ORIGEN'),
    importe: Number(raw.IMPORTE) || 0,
    // Hoy en Argentina: el servidor corre en UTC y después de las 21 h daría mañana.
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(s('FECHA')) ? s('FECHA') : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date()),
    medio,
    numeroCheque: s('NUMERO_CHEQUE') || undefined,
    bancoDestino: s('BANCO_DESTINO') || undefined,
    beneficiario: s('BENEFICIARIO') || undefined,
    referencia: [s('REFERENCIA'), s('DESCRIPCION')].filter(Boolean).join(' · ') || undefined,
    confianza: Math.max(0, Math.min(1, Number.isFinite(confianzaIA) ? confianzaIA * 0.7 + presentes * 0.3 : presentes)),
  }
}
