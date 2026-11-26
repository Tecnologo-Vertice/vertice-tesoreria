// Lectura de CSV y texto: encoding (UTF-8 o Latin-1, como bajan los bancos), separador y comillas.

import type { FilaPlanilla } from './tipos'

/** UTF-8 si es válido; si no, Windows-1252/Latin-1 (los CSV de home banking suelen venir así). Sin BOM. */
export function decodificar(bytes: Uint8Array): string {
  let t: string
  try {
    t = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    t = new TextDecoder('windows-1252').decode(bytes)
  }
  return t.replace(/^﻿/, '')
}

/** Separador más probable según la primera línea con contenido: ; , o tabulador. */
function separador(texto: string): string {
  const primera = texto.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const cuenta = (c: string) => primera.split(c).length - 1
  return [';', '\t', ','].sort((a, b) => cuenta(b) - cuenta(a))[0]
}

/** Filas del CSV. Respeta comillas dobles ("" dentro de comillas es una comilla). Las celdas quedan como texto. */
export function leerCsv(texto: string, sep = separador(texto)): FilaPlanilla[] {
  const filas: string[][] = []
  let fila: string[] = []
  let celda = ''
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          celda += '"'
          i++
        } else comillas = false
      } else celda += c
    } else if (c === '"' && celda.trim() === '') {
      comillas = true
      celda = ''
    } else if (c === sep) {
      fila.push(celda)
      celda = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++
      fila.push(celda)
      filas.push(fila)
      fila = []
      celda = ''
    } else celda += c
  }
  if (celda !== '' || fila.length) {
    fila.push(celda)
    filas.push(fila)
  }
  return filas.map((f) => f.map((x) => x.trim()))
}
