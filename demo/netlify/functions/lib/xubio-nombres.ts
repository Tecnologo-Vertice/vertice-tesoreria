// Comparar nombres de proveedores. El "núcleo" es el nombre de fondo, sin SA, SRL, laboratorio… (nucleoAcreedor_ del Apps Script;
// igual que nucleo_acreedor en SQL, 0036).

const PALABRAS_GENERICAS = new Set(['sa', 'srl', 'sas', 'sau', 'sh', 'saic', 'sacif', 'sacifia', 'sacifi', 'cia', 'compania', 'de', 'del', 'la', 'las', 'los', 'el', 'y',
  'seguros', 'laboratorio', 'laboratorios', 'lab', 'drogueria', 'droguerias', 'group', 'argentina', 'arg', 'hnos', 'inc', 'ltda'])

/** El nombre "de fondo" de un acreedor. */
export function nucleoAcreedor(t: string): string[] {
  const partes = String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const unidas: { txt: string; suelta: boolean }[] = []
  for (const w of partes) {
    const ult = unidas[unidas.length - 1]
    if (w.length === 1 && ult?.suelta) ult.txt += w
    else unidas.push({ txt: w, suelta: w.length === 1 })
  }
  return unidas.map((u) => u.txt).filter((w) => w.length > 1 && !PALABRAS_GENERICAS.has(w))
}

/**
 * ¿Es el mismo proveedor? Coincidencia COMPLETA del núcleo (mismas palabras, en cualquier orden): "Laboratorios Gamma SA" y
 * "GAMMA S.A." sí; "Perez" y "Maria Perez" no. El Apps Script aceptaba que un nombre corto estuviera contenido en el otro,
 * pero acá un apellido solo no alcanza (esto decide si se borra una orden de pago o se le pone un número a un pago).
 */
export function mismoProveedor(a: string, b: string): boolean {
  const x = nucleoAcreedor(a)
  const y = nucleoAcreedor(b)
  if (!x.length || !y.length) return false
  return [...x].sort().join(' ') === [...y].sort().join(' ')
}
