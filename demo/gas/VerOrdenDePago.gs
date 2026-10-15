/**
 * ============================================================================
 * SOLO LECTURA · Ver cómo guarda Xubio una orden de pago con facturas tildadas
 * ============================================================================
 * No escribe nada en Xubio ni en la hoja. Solo lee y muestra en el registro.
 *
 * CÓMO USARLO (en la COPIA de desarrollo, que ya tiene las credenciales):
 *  1) Archivo nuevo "VerOrdenDePago", pegar esto.
 *  2) Completar EMPRESA y FECHA con lo que pase Guido.
 *  3) Elegir la función verOrdenDePago arriba y tocar "Ejecutar".
 *  4) Ver → Registros de ejecución. Copiar TODO el texto y pasárselo a Claude.
 *
 * Usa getXubioToken_ de Code.gs (ya existe en la copia).
 * ============================================================================
 */

// Completar con los datos de Guido:
const VER_OP_EMPRESA = "INDIA ADV S.A.";  // como figura en RECEPTOR: "Beratung S.A.", "INDIA ADV S.A.", "Control B", "YSD"
const VER_OP_FECHA = "2026-09-14";        // fecha de la OP, formato AAAA-MM-DD
const VER_OP_PROVEEDOR = "JUMILLANO";     // opcional: parte del nombre del proveedor, para filtrar

function verOrdenDePago() {
  const token = getXubioToken_(VER_OP_EMPRESA);
  const headers = { Authorization: token.token_type + " " + token.access_token, Accept: "application/json" };

  // Busca las OP de ese día (±1 día por si la fecha difiere).
  const f = new Date(VER_OP_FECHA + "T12:00:00");
  const desde = Utilities.formatDate(new Date(f.getTime() - 86400000), "GMT-3", "yyyy-MM-dd");
  const hasta = Utilities.formatDate(new Date(f.getTime() + 86400000), "GMT-3", "yyyy-MM-dd");
  const url = XUBIO_API_URI + "pagoBean?fechaDesde=" + desde + "&fechaHasta=" + hasta;
  const resp = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    Logger.log("Xubio respondió " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 300));
    return;
  }

  let lista = JSON.parse(resp.getContentText());
  if (!Array.isArray(lista)) lista = [lista];
  if (VER_OP_PROVEEDOR) {
    const filtro = VER_OP_PROVEEDOR.toLowerCase();
    lista = lista.filter(p => String((p.proveedor || {}).nombre || "").toLowerCase().indexOf(filtro) >= 0);
  }
  Logger.log("Órdenes de pago encontradas: " + lista.length);

  // El listado puede venir resumido: se pide cada OP completa por su id.
  lista.slice(0, 5).forEach(p => {
    const id = p.transaccionid || p.transaccionId || p.ID || p.id;
    let completa = p;
    if (id) {
      const r = UrlFetchApp.fetch(XUBIO_API_URI + "pagoBean/" + id, { headers: headers, muteHttpExceptions: true });
      if (r.getResponseCode() === 200) completa = JSON.parse(r.getContentText());
    }
    Logger.log("========== OP id " + id + " · " + ((completa.proveedor || {}).nombre || "") + " ==========");
    Logger.log(JSON.stringify(completa, null, 1));
  });
}
