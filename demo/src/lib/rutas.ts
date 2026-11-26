// Rutas de los archivos que guarda la pantalla. Sin imports: se prueba con Node (supabase/pruebas/probar.mjs).

/**
 * Ruta del comprobante de un pago: <organización>/<empresa>/año/archivo. La base (migración 0019) deja
 * subir y leer por carpeta (hay que ser de esa organización y ver esa empresa), y registrar_pago rechaza
 * un comprobante que no esté en la carpeta de la empresa del pago.
 * Sin organización (la base todavía no tiene la migración 0017) queda la ruta de antes: año/archivo.
 */
export function rutaComprobante(organizacionId: string | undefined, empresaId: string, nombreArchivo: string, ahora: Date = new Date()): string {
  const limpio = nombreArchivo.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const archivo = `${ahora.getFullYear()}/${ahora.getTime()}_${limpio}`
  return organizacionId && empresaId ? `${organizacionId}/${empresaId}/${archivo}` : archivo
}
