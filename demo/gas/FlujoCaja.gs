/**
 * ============================================================================
 * FLUJO DE CAJA · carga automática · puente del sistema nuevo
 * ----------------------------------------------------------------------------
 * Misma lógica que FlujoCaja.gs de "facturas automatizadas" (reglas acordadas con el
 * Controller, documento "Automatización del Flujo"), pero los pagos y las facturas salen
 * del sistema nuevo (POST /api/flujo/datos), con los mismos encabezados que las pestañas
 * Pagos y Facturas de la hoja. En la COPIA del Flujo de caja arma:
 *  - "Mapa Flujo": qué fila del Flujo le corresponde a cada pago o factura. Se crea con
 *    una precarga la primera vez; después se edita a mano y el script NUNCA la pisa.
 *  - "Aux Pagos": un renglón por pago hecho (sin cheques ni pagarés: esos entran por
 *    CHEQUES EMITIDOS). Incluye los pagos sin factura (ESPERA_FC).
 *  - "Aux Proyeccion": un renglón por factura aprobada y no pagada, en la fecha en que se va a pagar.
 *  - "Comparacion": para cada fila y día, lo cargado a mano vs. lo automático.
 *
 * Reglas:
 *  A. Fila: cuenta contable → proveedor → detalle → categoría; si nada coincide, SIN CUENTA ASIGNADA.
 *  B. Transferencias entre cuentas propias: salida en "Transferencias Realizadas" y entrada en
 *     "Transferencias recibidas".
 *  C. Gasto de una unidad pagado desde el banco de la otra: el gasto en su unidad + transferencia
 *     recibida ahí + transferencia realizada en la otra (solo si se sabe el banco).
 *  D/E. Proyección por saldo. Fecha: programada por Tesorería → cheque a N días → vencimiento.
 *     Vencidas y sin fecha → próximo día hábil.
 *  G. Al pagarse, la factura sale de la proyección.
 *  Pagos sin factura (ESPERA_FC) se descuentan de la proyección del mismo proveedor, de la más vieja a la más nueva.
 *
 * Script Properties:
 *   SISTEMA_URL         = https://<sitio>.netlify.app
 *   INGESTA_TOKEN       = el mismo de Netlify
 *   FLUJO_SHEET_ID      = id de la copia del Flujo de caja ("Copy of Flujo de Caja Por empresa")
 *   FLUJO_PERMITIR_REAL = true solo con OK, para escribir en el Flujo real
 *
 * Uso: fxActualizarFlujo() → fxCompararConManual() → fxInstalarActivadorDiario().
 * ============================================================================
 */

// Empresas que se automatizan y sus pestañas en el Flujo (por ahora, Beratung)
var FX_EMPRESAS = {
  "beratung": { nombre: "Beratung S.A.", pestanas: ["Beratung S/Dax", "Dax Salud"], principal: "Beratung S/Dax" }
};
// Unidades que Tesorería pone en "Realizado por" sin nombrar la empresa (pagos múltiples a prestadores)
var FX_UNIDADES = { "entrerios": "beratung", "consultoriostucuman": "beratung", "idtucuman": "beratung", "daxsalud": "beratung" };
// Nombres de las otras empresas del grupo: una "transferencia a cuentas propias" hacia ellas es intercompany
var FX_OTRAS_EMPRESAS = ["india", "robles", "vertice", "controlb", "ysd", "farmacontrol", "serviclima"];
// Cheque a N días: desde qué fecha se cuentan ("FECHA" = fecha de la factura)
var FX_BASE_DIAS_CHEQUE = "FECHA";
// Columnas opcionales de la fecha y el monto que programa Tesorería (si algún día existen, se usan primero)
var FX_COL_FECHA_PROGRAMADA = ["FECHA_PAGO_PROGRAMADA", "FECHA_PROGRAMADA"];
var FX_COL_MONTO_PROGRAMADO = ["MONTO_PROGRAMADO", "IMPORTE_PROGRAMADO"];

var FX_TAB_MAPA = "Mapa Flujo";
var FX_TAB_PAGOS = "Aux Pagos";
var FX_TAB_PROY = "Aux Proyeccion";
var FX_TAB_COMP = "Comparacion";
var FX_FILA_SIN_CLASIFICAR = "SIN CUENTA ASIGNADA";
var FX_FILA_SIN_FECHA = "SIN FECHA";
var FX_FILA_VENCIDAS = ""; // "" = vencidas a su fila en el próximo día hábil
var FX_FILA_TR_REALIZADA = "Transferencias Realizadas";
var FX_FILA_TR_RECIBIDA = "Transferencias recibidas";
var FX_PESTANA_BANCO = "(banco)";
var FX_ESTADO_PARA_PAGAR = "PARA_PAGAR";
var FX_ESTADO_ESPERA_FC = "ESPERA_FC";

var FX_COLS_MAPA = ["TIPO", "EMPRESA", "VALOR", "PESTANA", "FILA", "NOTA"];
var FX_COLS_PAGOS = ["FECHA", "EMPRESA", "PESTANA", "FILA", "CLAVE", "IMPORTE", "MOVIMIENTO", "ID_PAGO",
  "PROVEEDOR", "CUENTA_CONTABLE", "BANCO", "REGLA", "POSIBLE_DUPLICADO", "ACTUALIZADO"];
var FX_COLS_PROY = ["FECHA", "EMPRESA", "PESTANA", "FILA", "CLAVE", "IMPORTE", "ORIGEN_FECHA", "FACTURA",
  "PROVEEDOR", "CATEGORIA", "VENCIMIENTO", "REGLA", "ACTUALIZADO"];
var FX_COLS_COMP = ["PESTANA", "FILA", "FECHA", "MANUAL", "AUTOMATICO", "DIFERENCIA"];

// ---------------------------------------------------------------- Entradas

/** Arma Aux Pagos y Aux Proyeccion de cero con los datos del sistema. Crea el Mapa la primera vez. */
function fxActualizarFlujo() {
  var cache = CacheService.getScriptCache();
  if (cache.get("FX_FLUJO_CORRIENDO")) return "Hay otra actualización del Flujo en curso.";
  cache.put("FX_FLUJO_CORRIENDO", "1", 600);
  try {
    var flujo = fxAbrirFlujo_();
    var mapa = fxLeerMapa_(flujo);
    var datos = fxDatosDelSistema_();
    var tPagos = fxTablaDesdeFilas_(datos.pagos);
    var pagos = fxPagosAuxiliares_(tPagos, mapa);
    var proy = fxProyeccionAuxiliar_(fxTablaDesdeFilas_(datos.facturas), mapa, fxAnticiposSinFactura_(tPagos));
    fxEscribirTabla_(flujo, FX_TAB_PAGOS, FX_COLS_PAGOS, pagos);
    fxEscribirTabla_(flujo, FX_TAB_PROY, FX_COLS_PROY, proy);
    var sinFila = pagos.concat(proy).filter(function (r) { return r.FILA === FX_FILA_SIN_CLASIFICAR; }).length;
    var msg = "Aux Pagos: " + pagos.length + " renglones · Aux Proyeccion: " + proy.length +
      " · sin clasificar: " + sinFila + " (completá el Mapa Flujo).";
    Logger.log(msg);
    return msg;
  } finally {
    cache.remove("FX_FLUJO_CORRIENDO");
  }
}

/** Compara lo cargado a mano en la grilla contra lo automático. No toca la grilla. */
function fxCompararConManual() {
  var flujo = fxAbrirFlujo_();
  var auto = {};
  var sumar = function (tab, soloFuturo) {
    var t = fxLeerTablaPorNombre_(flujo, tab);
    if (!t) return;
    var hoy = fxHoy_();
    t.filas.forEach(function (f) {
      var fecha = fxFecha_(f[t.c("FECHA")]);
      if (!fecha) return;
      if (soloFuturo && fecha <= hoy) return; // la proyección cuenta desde mañana
      if (!soloFuturo && fecha > hoy) return; // lo pagado, hasta hoy
      var k = f[t.c("CLAVE")] + "|" + fxFechaTxt_(fecha);
      auto[k] = (auto[k] || 0) + fxMonto_(f[t.c("IMPORTE")]);
    });
  };
  sumar(FX_TAB_PAGOS, false);
  sumar(FX_TAB_PROY, true);
  var salida = [];
  Object.keys(FX_EMPRESAS).forEach(function (k) {
    FX_EMPRESAS[k].pestanas.forEach(function (nombre) {
      var sh = flujo.getSheetByName(nombre);
      if (!sh) return;
      var datos = sh.getDataRange().getValues();
      var fechas = (datos[1] || []).map(fxFecha_);
      var filasUsadas = {}, vistas = {};
      Object.keys(auto).forEach(function (key) { var p = key.split("|"); if (p[0] === nombre) filasUsadas[fxNorm_(p[1])] = p[1]; });
      for (var r = 2; r < datos.length; r++) {
        var etiqueta = String(datos[r][1] || "").trim();
        if (!etiqueta || !filasUsadas[fxNorm_(etiqueta)] || vistas[fxNorm_(etiqueta)]) continue;
        vistas[fxNorm_(etiqueta)] = true; // una fila repetida se compara una sola vez
        for (var c = 2; c < fechas.length; c++) {
          if (!fechas[c]) continue;
          var manual = fxMonto_(datos[r][c]) || 0;
          var automatico = auto[nombre + "|" + filasUsadas[fxNorm_(etiqueta)] + "|" + fxFechaTxt_(fechas[c])] || 0;
          if (!manual && !automatico) continue;
          salida.push({ PESTANA: nombre, FILA: etiqueta, FECHA: fechas[c], MANUAL: manual, AUTOMATICO: automatico,
            DIFERENCIA: Math.round((automatico - manual) * 100) / 100 });
        }
      }
    });
  });
  fxEscribirTabla_(flujo, FX_TAB_COMP, FX_COLS_COMP, salida);
  var conDif = salida.filter(function (s) { return Math.abs(s.DIFERENCIA) >= 1; }).length;
  var msg = "Comparación: " + salida.length + " celdas con datos · " + conDif + " con diferencia.";
  Logger.log(msg);
  return msg;
}

/** Instala el activador diario (7 h). Correrlo una sola vez, con OK. */
function fxInstalarActivadorDiario() {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === "fxActualizarFlujo"; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("fxActualizarFlujo").timeBased().everyDays(1).atHour(7).create();
  return "Activador diario de fxActualizarFlujo instalado (7 h).";
}

// ---------------------------------------------------------------- Datos del sistema

function fxDatosDelSistema_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty("SISTEMA_URL") || "").replace(/\/$/, "");
  var token = p.getProperty("INGESTA_TOKEN") || "";
  if (!url || !token) throw new Error("Faltan SISTEMA_URL o INGESTA_TOKEN en Script Properties.");
  var resp = UrlFetchApp.fetch(url + "/api/flujo/datos", {
    method: "post", contentType: "application/json", payload: "{}", headers: { "x-ingesta-token": token }, muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error("Sistema /api/flujo/datos → " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 200));
  return JSON.parse(resp.getContentText());
}

/** Lista de objetos (con los encabezados de la hoja) → { headers, c, filas } como fxLeerTablaPorNombre_. */
function fxTablaDesdeFilas_(lista) {
  var h = [];
  (lista || []).forEach(function (o) { Object.keys(o).forEach(function (k) { if (h.indexOf(k) === -1) h.push(k); }); });
  return {
    headers: h,
    c: function (n) { return h.indexOf(n); },
    filas: (lista || []).map(function (o) { return h.map(function (k) { return o[k] === null || o[k] === undefined ? "" : o[k]; }); })
  };
}

// ---------------------------------------------------------------- Pagos → Aux Pagos

function fxPagosAuxiliares_(t, mapa) {
  if (!t) throw new Error("El sistema no devolvió pagos.");
  var salida = [];
  var ahora = new Date();
  t.filas.forEach(function (f) {
    var g = function (n) { return t.c(n) === -1 ? "" : f[t.c(n)]; };
    if (/ANULAD|RECHAZAD|ELIMINAD/.test(String(g("ESTADO_CONTABLE")).trim().toUpperCase())) return;
    // Cheques, e-cheqs y pagarés entran por CHEQUES EMITIDOS: no se cuentan dos veces
    if (String(g("NUMERO_CHEQUE")).trim() || String(g("TIPO_CHEQUE")).trim() || String(g("FECHA_VTO_CHEQUE")).trim()) return;
    var emp = fxEmpresa_(g("EMPRESA")) || fxEmpresa_(g("REALIZADO_POR")) || fxEmpresaDeUnidad_(g("REALIZADO_POR"));
    if (!emp) return;
    var fechaPago = fxFecha_(g("FECHA_PAGO"));
    var fecha = fechaPago ? fxProximoHabil_(fechaPago, mapa.feriados) : null; // sábado/domingo → lunes
    var importe = fxMonto_(g("IMPORTE"));
    if (!fecha || !(importe > 0)) return;
    var conf = FX_EMPRESAS[emp];
    var banco = String(g("BANCO_ORIGEN") || g("CUENTA_ORIGEN") || "").trim();
    var pestBancoReal = fxPestanaDeBanco_(mapa, emp, banco);
    var pestBanco = pestBancoReal || conf.principal;
    var base = {
      FECHA: fecha, EMPRESA: conf.nombre, IMPORTE: importe, ID_PAGO: String(g("ID_PAGO")),
      PROVEEDOR: String(g("PROVEEDOR_DESTINO")), CUENTA_CONTABLE: String(g("CUENTA_CONTABLE")),
      BANCO: banco, ACTUALIZADO: ahora
    };
    var add = function (pestana, fila, movimiento, regla) {
      var r = {};
      Object.keys(base).forEach(function (k) { r[k] = base[k]; });
      r.PESTANA = pestana; r.FILA = fila; r.CLAVE = pestana + "|" + fila; r.MOVIMIENTO = movimiento; r.REGLA = regla;
      salida.push(r);
    };
    // B. Transferencia entre cuentas propias de la misma empresa
    var destNorm = fxNorm_(g("PROVEEDOR_DESTINO"));
    var esPropia = /cuentas?\s+propias?/i.test(String(g("DESCRIPCION_PAGO"))) &&
      !FX_OTRAS_EMPRESAS.some(function (o) { return destNorm.indexOf(o) !== -1; });
    if (esPropia) {
      var pestDestino = fxPestanaDeBanco_(mapa, emp, g("BANCO_DESTINO")) || pestBanco;
      add(pestBanco, FX_FILA_TR_REALIZADA, "TRANSFERENCIA_PROPIA", "Cuentas propias · sale de " + banco);
      add(pestDestino, FX_FILA_TR_RECIBIDA, "TRANSFERENCIA_PROPIA", "Cuentas propias · entra en " + (g("BANCO_DESTINO") || "?"));
      return;
    }
    // A. Fila por cuenta → proveedor → detalle → categoría
    var r = fxResolverFila_(mapa, emp, String(g("CUENTA_CONTABLE")), String(g("PROVEEDOR_DESTINO")), String(g("CUENTA_CONTABLE")),
      [g("REALIZADO_POR"), g("DESCRIPCION_PAGO"), g("OBSERVACIONES_TESORERIA")].join(" "));
    var espera = String(g("ESTADO_CONTABLE")).trim().toUpperCase() === FX_ESTADO_ESPERA_FC ? " · pago sin FC" : "";
    var sinBanco = pestBancoReal ? "" : " · sin banco de origen";
    if (!r) { add(pestBanco, FX_FILA_SIN_CLASIFICAR, "PAGO", "Sin coincidencia en el Mapa" + espera + sinBanco); return; }
    var pestGasto = r.pestana === FX_PESTANA_BANCO ? pestBanco : r.pestana;
    add(pestGasto, r.fila, "PAGO", r.regla + espera + sinBanco);
    // C. Gasto de una unidad pagado desde el banco de la otra (solo si se sabe el banco)
    if (pestBancoReal && pestGasto !== pestBancoReal) {
      add(pestBancoReal, FX_FILA_TR_REALIZADA, "PRESTAMO_ENTRE_UNIDADES", "Pagó " + pestBancoReal + " un gasto de " + pestGasto);
      add(pestGasto, FX_FILA_TR_RECIBIDA, "PRESTAMO_ENTRE_UNIDADES", "Pagó " + pestBancoReal + " un gasto de " + pestGasto);
    }
  });
  fxMarcarPosiblesDuplicados_(salida);
  return salida;
}

/** Mismo proveedor e importe, hasta 3 días de diferencia y distinto ID: solo avisa. */
function fxMarcarPosiblesDuplicados_(filas) {
  var pagos = filas.filter(function (r) { return r.MOVIMIENTO === "PAGO" && fxProvKey_(r.PROVEEDOR); });
  pagos.forEach(function (a, i) {
    pagos.slice(i + 1).forEach(function (b) {
      if (a.ID_PAGO === b.ID_PAGO || Math.abs(a.IMPORTE - b.IMPORTE) > 0.01) return;
      if (fxProvKey_(a.PROVEEDOR) !== fxProvKey_(b.PROVEEDOR)) return;
      if (Math.abs(a.FECHA - b.FECHA) > 3 * 864e5) return;
      a.POSIBLE_DUPLICADO = (a.POSIBLE_DUPLICADO ? a.POSIBLE_DUPLICADO + ", " : "con ") + b.ID_PAGO;
      b.POSIBLE_DUPLICADO = (b.POSIBLE_DUPLICADO ? b.POSIBLE_DUPLICADO + ", " : "con ") + a.ID_PAGO;
    });
  });
}

// ---------------------------------------------------------------- Facturas → Aux Proyeccion

function fxProyeccionAuxiliar_(t, mapa, anticipos) {
  if (!t) throw new Error("El sistema no devolvió facturas.");
  var salida = [];
  var ahora = new Date();
  var feriados = mapa.feriados;
  var manana = fxProximoHabil_(fxSumarDias_(fxHoy_(), 1), feriados);
  t.filas.forEach(function (f) {
    var g = function (n) { return t.c(n) === -1 ? "" : f[t.c(n)]; };
    var gAlguna = function (lista) { for (var i = 0; i < lista.length; i++) { var v = g(lista[i]); if (String(v).trim()) return v; } return ""; };
    if (String(g("ESTADO_APROBACION")).trim().toUpperCase() !== "APROBADA") return;
    if (String(g("ESTADO_PAGO")).trim().toUpperCase() !== FX_ESTADO_PARA_PAGAR) return;
    if (String(g("YA_PAGADA_SEGUN_ADMIN")).trim()) return;
    if (/credito/i.test(fxNormSuave_(g("TIPO")))) return; // notas de crédito
    var emp = fxEmpresa_(g("RECEPTOR"));
    if (!emp) return;
    var pct = fxMonto_(g("PORCENTAJE_PAGADO")) || 0;
    if (pct > 0 && pct <= 1) pct = pct * 100;
    var saldo = Math.round((fxMonto_(g("TOTAL")) || 0) * (1 - Math.min(pct, 100) / 100) * 100) / 100;
    if (!(saldo > 0)) return;
    // E. Fecha por prioridad
    var fecha = null, origen = "";
    var fProg = fxFecha_(gAlguna(FX_COL_FECHA_PROGRAMADA));
    if (fProg) {
      fecha = fProg; origen = "Programada por Tesorería";
      var mProg = fxMonto_(gAlguna(FX_COL_MONTO_PROGRAMADO));
      if (mProg > 0 && mProg < saldo) saldo = mProg;
    }
    if (!fecha) {
      var m = String(g("METODO_PAGO")).match(/cheque\D{0,3}(\d{1,3})/i);
      var baseDias = fxFecha_(g(FX_BASE_DIAS_CHEQUE));
      if (m && baseDias) { fecha = fxSumarDias_(baseDias, Number(m[1])); origen = "Cheque a " + m[1] + " días"; }
    }
    if (!fecha) { var v = fxFecha_(g("VENCIMIENTODELPAGO")); if (v) { fecha = v; origen = "Vencimiento"; } }
    var conf = FX_EMPRESAS[emp];
    var pestana, fila, regla;
    var r = fxResolverFila_(mapa, emp, String(g("CATEGORIA_CONTABLE")), String(g("PROVEEDOR")), String(g("CATEGORIA_CONTABLE")),
      String(g("OBSERVACIONES")) + " " + String(g("PRODUCTOSERVICIOPERCEPCION")));
    if (r) { pestana = r.pestana === FX_PESTANA_BANCO ? conf.principal : r.pestana; fila = r.fila; regla = r.regla; }
    else { pestana = conf.principal; fila = FX_FILA_SIN_CLASIFICAR; regla = "Sin coincidencia en el Mapa"; }
    if (!fecha) { fecha = manana; fila = FX_FILA_SIN_FECHA; origen = "Sin fecha"; }
    else {
      fecha = fxProximoHabil_(fecha, feriados);
      if (fecha < manana) {
        origen += " (vencida)"; fecha = manana;
        if (FX_FILA_VENCIDAS) { pestana = conf.principal; fila = FX_FILA_VENCIDAS; }
      }
    }
    salida.push({
      FECHA: fecha, EMPRESA: conf.nombre, PESTANA: pestana, FILA: fila, CLAVE: pestana + "|" + fila, IMPORTE: saldo,
      ORIGEN_FECHA: origen, FACTURA: String(g("NUMERO")), PROVEEDOR: String(g("PROVEEDOR")),
      CATEGORIA: String(g("CATEGORIA_CONTABLE")), VENCIMIENTO: fxFecha_(g("VENCIMIENTODELPAGO")) || "",
      REGLA: regla, ACTUALIZADO: ahora,
      _prov: emp + "|" + fxProvKey_(g("PROVEEDOR")), _cuit: fxCuit_(g("CUIT_PROVEEDOR"))
    });
  });
  return fxDescontarAnticipos_(salida, anticipos || {});
}

/** Pagos sin factura que esperan su factura (ESPERA_FC, sin factura asociada): importe por proveedor. */
function fxAnticiposSinFactura_(t) {
  var out = {};
  if (!t) return out;
  t.filas.forEach(function (f) {
    var g = function (n) { return t.c(n) === -1 ? "" : f[t.c(n)]; };
    if (String(g("ESTADO_CONTABLE")).trim().toUpperCase() !== FX_ESTADO_ESPERA_FC) return;
    if (String(g("FACTURA_ASOCIADA")).trim()) return;
    var emp = fxEmpresa_(g("EMPRESA")) || fxEmpresa_(g("REALIZADO_POR")) || fxEmpresaDeUnidad_(g("REALIZADO_POR"));
    var imp = fxMonto_(g("IMPORTE"));
    if (!emp || !(imp > 0)) return;
    var cuit = fxCuit_(g("CUIT_DESTINO"));
    var k = emp + "|" + (cuit ? "#" + cuit : fxProvKey_(g("PROVEEDOR_DESTINO")));
    out[k] = (out[k] || 0) + imp;
  });
  return out;
}

/** Descuenta los anticipos de las facturas del mismo proveedor, de la más vieja a la más nueva. */
function fxDescontarAnticipos_(filas, anticipos) {
  var resto = {};
  Object.keys(anticipos).forEach(function (k) { resto[k] = anticipos[k]; });
  var claveAnticipo = function (prov, cuit) {
    var emp = prov.split("|")[0];
    if (cuit && resto[emp + "|#" + cuit] > 0) return emp + "|#" + cuit;
    return Object.keys(resto).filter(function (k) {
      if (!(resto[k] > 0)) return false;
      var a = k.split("|"), b = prov.split("|");
      if (a[0] !== b[0] || !a[1] || !b[1] || a[1].charAt(0) === "#") return false;
      return a[1] === b[1] || (Math.min(a[1].length, b[1].length) >= 5 && (a[1].indexOf(b[1]) !== -1 || b[1].indexOf(a[1]) !== -1));
    })[0];
  };
  var salida = [];
  filas.slice().sort(function (x, y) { return x.FECHA - y.FECHA; }).forEach(function (r) {
    var k = claveAnticipo(r._prov, r._cuit);
    if (k) {
      var desc = Math.min(r.IMPORTE, resto[k]);
      resto[k] = Math.round((resto[k] - desc) * 100) / 100;
      r.IMPORTE = Math.round((r.IMPORTE - desc) * 100) / 100;
      r.REGLA += " · menos pago sin factura $" + desc.toFixed(2);
      if (!(r.IMPORTE > 0)) return;
    }
    delete r._prov;
    delete r._cuit;
    salida.push(r);
  });
  return salida;
}

function fxProvKey_(s) {
  return fxNorm_(String(s || "").replace(/\b(s\.?\s*r\.?\s*l|s\.?\s*a\.?\s*s|s\.?\s*a\.?\s*c\.?\s*i\.?\s*f\.?\s*i\.?\s*a|s\.?\s*h|s\.?\s*a)\.?\s*$/i, ""));
}

function fxCuit_(s) {
  var d = String(s || "").replace(/\D/g, "");
  return d.length === 11 ? d : "";
}

// ---------------------------------------------------------------- Mapa Flujo

function fxLeerMapa_(flujo) {
  var sh = flujo.getSheetByName(FX_TAB_MAPA);
  if (!sh) {
    sh = flujo.insertSheet(FX_TAB_MAPA);
    var filas = [FX_COLS_MAPA].concat(FX_MAPA_INICIAL);
    sh.getRange(1, 1, filas.length, FX_COLS_MAPA.length).setValues(filas);
    sh.setFrozenRows(1);
  }
  return fxMapaDesdeFilas_(sh.getDataRange().getValues());
}

function fxMapaDesdeFilas_(datos) {
  var h = datos[0].map(function (x) { return String(x).trim().toUpperCase(); });
  var c = function (n) { return h.indexOf(n); };
  var mapa = { reglas: [], bancos: {}, feriados: {} };
  datos.slice(1).forEach(function (f) {
    var tipo = String(f[c("TIPO")] || "").trim().toUpperCase();
    var valor = String(f[c("VALOR")] || "").trim();
    if (!tipo || !valor) return;
    if (tipo === "FERIADO") { var d = fxFecha_(f[c("VALOR")]); if (d) mapa.feriados[fxFechaTxt_(d)] = true; return; }
    var emp = fxEmpresa_(f[c("EMPRESA")]);
    if (!emp) return;
    var pestana = String(f[c("PESTANA")] || "").trim(), fila = String(f[c("FILA")] || "").trim();
    if (tipo === "BANCO") { (mapa.bancos[emp] = mapa.bancos[emp] || []).push({ valor: fxNorm_(valor), pestana: pestana }); return; }
    if (["CUENTA", "PROVEEDOR", "DETALLE", "CATEGORIA"].indexOf(tipo) === -1 || !pestana || !fila) return;
    mapa.reglas.push({ tipo: tipo, emp: emp, valor: fxNorm_(valor), texto: valor, pestana: pestana, fila: fila });
  });
  mapa.reglas.sort(function (a, b) { return b.valor.length - a.valor.length; }); // lo más largo primero
  return mapa;
}

/** A: cuenta exacta → proveedor (contiene) → detalle (contiene) → categoría exacta. */
function fxResolverFila_(mapa, emp, cuenta, proveedor, categoria, detalle) {
  var cta = fxNorm_(cuenta), prov = fxNorm_(proveedor), cat = fxNorm_(categoria);
  var de = function (tipo) { return mapa.reglas.filter(function (r) { return r.emp === emp && r.tipo === tipo; }); };
  var porCuenta = cta && de("CUENTA").filter(function (r) { return cta === r.valor || cta.slice(-r.valor.length) === r.valor; })[0];
  if (porCuenta) return { pestana: porCuenta.pestana, fila: porCuenta.fila, regla: "Cuenta: " + porCuenta.texto };
  var porProv = prov && de("PROVEEDOR").filter(function (r) { return prov.indexOf(r.valor) !== -1; })[0];
  if (porProv) return { pestana: porProv.pestana, fila: porProv.fila, regla: "Proveedor: " + porProv.texto };
  var det = fxNorm_(detalle);
  var porDet = det && de("DETALLE").filter(function (r) { return det.indexOf(r.valor) !== -1; })[0];
  if (porDet) return { pestana: porDet.pestana, fila: porDet.fila, regla: "Detalle: " + porDet.texto };
  var porCat = cat && de("CATEGORIA").filter(function (r) { return cat === r.valor; })[0];
  if (porCat) return { pestana: porCat.pestana, fila: porCat.fila, regla: "Categoría: " + porCat.texto };
  return null;
}

function fxPestanaDeBanco_(mapa, emp, banco) {
  var b = fxNorm_(banco);
  if (!b) return "";
  var r = (mapa.bancos[emp] || []).filter(function (x) { return b.indexOf(x.valor) !== -1; })[0];
  return r ? r.pestana : "";
}

// Precarga de Beratung (la misma de producción). Se revisa y se completa a mano en "Mapa Flujo".
var FX_MAPA_INICIAL = [
  ["BANCO", "Beratung", "HIPOTECARIO", "Dax Salud", "", "Banco de la unidad"],
  ["BANCO", "Beratung", "ICBC", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "INDUSTRIAL AND COMMERCIAL", "Beratung S/Dax", "", "ICBC con su nombre largo"],
  ["BANCO", "Beratung", "SANTANDER", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "MACRO", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "CHUBUT", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "BRUBANK", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "MERCADO PAGO", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "CREDICOOP", "Beratung S/Dax", "", ""],
  ["BANCO", "Beratung", "CAJA", "Beratung S/Dax", "", "Efectivo: revisar si es caja chica de Tucumán (Dax)"],
  ["CUENTA", "Beratung", "PROVEEDORES LOCALES", "Beratung S/Dax", "22001001 PROVEEDORES LOCALES", ""],
  ["CUENTA", "Beratung", "SUELDOS A PAGAR", "Beratung S/Dax", "22005001 SUELDOS A PAGAR", ""],
  ["CUENTA", "Beratung", "MIS FACILIDADES", "Beratung S/Dax", "22003004 MIS FACILIDADES", ""],
  ["CUENTA", "Beratung", "Beltramino Aime - Cta. Particular", "Beratung S/Dax", "Beltramino Aime - Cta. Particular", ""],
  ["CUENTA", "Beratung", "Nicolas Siseles", "Beratung S/Dax", "SISELES, NICOLAS", ""],
  ["CUENTA", "Beratung", "Siseles Alejo - Cta. Particular", "Beratung S/Dax", "Siseles Alejo - Cta. Particular", ""],
  ["CUENTA", "Beratung", "CUENTA CON INDIA", "(banco)", "11003206 CUENTA CON INDIA", "En la unidad del banco"],
  ["CUENTA", "Beratung", "CUENTA CON HECTOR ROBLES", "(banco)", "11003205 CUENTA CON HÉCTOR ROBLES", ""],
  ["CUENTA", "Beratung", "PRESTAMOS- INDIA", "(banco)", "22003008 PRÉSTAMOS - INDIA", ""],
  ["CUENTA", "Beratung", "PRESTAMOS - HECTOR ROBLES", "(banco)", "22003007 PRÉSTAMOS - HÉCTOR ROBLES", ""],
  ["CUENTA", "Beratung", "CREDITOS FINANCIERAS", "(banco)", "11003212 CRÉDITOS FINANCIERAS", ""],
  ["CUENTA", "Beratung", "IMPUESTO DEB/CRED BANCARIO", "(banco)", "55001005 IMPUESTO DEB/CRED BANCARIO", ""],
  ["CUENTA", "Beratung", "GASTOS BANCARIOS", "(banco)", "55001001 GASTOS BANCARIOS - Comisiones", ""],
  ["CUENTA", "Beratung", "CUENTA CON VERTICE", "Dax Salud", "11003214 CUENTA CON VÉRTICE", ""],
  ["CUENTA", "Beratung", "HONORARIOS PROFESIONALES INTERNOS", "Dax Salud", "53002002 HONORARIOS PROFESIONALES INTERNOS", ""],
  ["CUENTA", "Beratung", "CARGAS SOCIALES A PAGAR", "Dax Salud", "22005002 CARGAS SOCIALES A PAGAR", ""],
  ["CUENTA", "Beratung", "INGRESOS BRUTOS A PAGAR", "Dax Salud", "22008003 INGRESOS BRUTOS A PAGAR", ""],
  ["CUENTA", "Beratung", "GASTOS PREPAGA/CONTROL DE SALUD", "Dax Salud", "52002005 GASTOS PREPAGA/CONTROL DE SALUD - Medife", ""],
  ["CUENTA", "Beratung", "ALQUILER ENTRE RIOS", "Dax Salud", "53001003 ALQUILER ENTRE RIOS", ""],
  ["CUENTA", "Beratung", "ALQUILER CONSULTORIO TUCUMAN", "Dax Salud", "53001002 ALQUILER CONSULTORIO TUCUMAN - C/FC", "Revisar C/FC vs S/FC"],
  ["CUENTA", "Beratung", "ALQUILER OFICINA TUCUMAN", "Dax Salud", "53001001 ALQUILER OFICINA TUCUMAN - San Martín C/FC", "Revisar C/FC vs S/FC"],
  ["CUENTA", "Beratung", "COSTO DE INTERNACION DOMICILIARIA PRESTACIONES- ENTRE RIOS", "Dax Salud", "ID Entre Rios", ""],
  ["CUENTA", "Beratung", "Honorarios ID Entre Rios", "Dax Salud", "ID Entre Rios", ""],
  ["CUENTA", "Beratung", "Honorarios ID Tucuman", "Dax Salud", "ID", ""],
  ["CUENTA", "Beratung", "Honorarios Prestadores Tucuman", "Dax Salud", "Consultorios", ""],
  ["PROVEEDOR", "Beratung", "COVERLINE", "Beratung S/Dax", "COVERLINE", ""],
  ["PROVEEDOR", "Beratung", "ALLIANZ", "Beratung S/Dax", "53001007 SEGUROS - Allianz Póliza 260040766668", ""],
  ["PROVEEDOR", "Beratung", "VARGAS", "Dax Salud", "VARGAS S.R.L.", ""],
  ["PROVEEDOR", "Beratung", "PLAZA OÑA", "Dax Salud", "DROGUERIA PLAZA OÑA", ""],
  ["PROVEEDOR", "Beratung", "INSUR", "Dax Salud", "COMPAÑIA DE SEGURO INSUR", ""],
  ["PROVEEDOR", "Beratung", "SALAZAR", "Dax Salud", "SALAZAR GUSTAVO", ""],
  ["PROVEEDOR", "Beratung", "HERMIDA", "Dax Salud", "PAOLA HERMIDA", ""],
  ["PROVEEDOR", "Beratung", "CONSULTORES M", "Dax Salud", "CONSULTORES M&B", ""],
  ["PROVEEDOR", "Beratung", "VYF", "Dax Salud", "ESTUDIO VYF", ""],
  ["PROVEEDOR", "Beratung", "PIUR", "Dax Salud", "PIUR", ""],
  ["PROVEEDOR", "Beratung", "TODOLANDIA", "Dax Salud", "TODOLANDIA", ""],
  ["PROVEEDOR", "Beratung", "ENERSA", "Dax Salud", "53001009 ENERGIA - Enersa Entre Ríos", ""],
  ["PROVEEDOR", "Beratung", "EDENOR", "Dax Salud", "53001009 ENERGIA - Edenor", ""],
  ["PROVEEDOR", "Beratung", "AMX", "Dax Salud", "53001010 TELEFONÍA E INTERNET - Claro Tucumán", "Claro"],
  ["PROVEEDOR", "Beratung", "PERSONAL", "Dax Salud", "53001010 TELEFONÍA E INTERNET - Personal Entre Ríos", ""],
  ["PROVEEDOR", "Beratung", "AKAROMSOFT", "Dax Salud", "53002004 SOFTWARE DE GESTION - Akaromsoft (ID Tucumán)", ""],
  ["PROVEEDOR", "Beratung", "PANACEA", "Dax Salud", "53002004 SOFTWARE DE GESTION - Panacea", ""],
  ["PROVEEDOR", "Beratung", "SOLUCIONES ONLINE", "Dax Salud", "53002004 SOFTWARE DE GESTION - Xubio (Soluciones Online)", ""],
  ["PROVEEDOR", "Beratung", "ANFIBIA", "Dax Salud", "53002004 SOFTWARE DE GESTION - Anfibia (ID)", ""],
  ["PROVEEDOR", "Beratung", "INTERBANKING", "Dax Salud", "53001014 GASTOS VARIOS OFICINA - Interbanking", ""],
  ["PROVEEDOR", "Beratung", "GOOGLE", "Dax Salud", "53001014 GASTOS VARIOS OFICINA - Google", ""],
  ["PROVEEDOR", "Beratung", "MEDIFE", "Dax Salud", "52002005 GASTOS PREPAGA/CONTROL DE SALUD - Medife", ""],
  ["PROVEEDOR", "Beratung", "MERIDIONAL", "Dax Salud", "53001007 SEGUROS - Integral de Comercio", ""],
  ["FERIADO", "", "2026-11-23", "", "", ""], ["FERIADO", "", "2026-12-07", "", "", ""],
  ["FERIADO", "", "2026-12-08", "", "", ""], ["FERIADO", "", "2026-12-25", "", "", ""],
  ["FERIADO", "", "2027-01-01", "", "", ""], ["FERIADO", "", "2027-02-08", "", "", ""],
  ["FERIADO", "", "2027-02-09", "", "", ""], ["FERIADO", "", "2027-03-24", "", "", ""],
  ["FERIADO", "", "2027-03-26", "", "", ""], ["FERIADO", "", "2027-04-02", "", "", ""],
  ["FERIADO", "", "2027-05-01", "", "", ""], ["FERIADO", "", "2027-05-25", "", "", ""],
  ["FERIADO", "", "2027-06-15", "", "", ""], ["FERIADO", "", "2027-06-20", "", "", ""]
];

// ---------------------------------------------------------------- Utilidades

function fxAbrirFlujo_() {
  var p = PropertiesService.getScriptProperties();
  var id = String(p.getProperty("FLUJO_SHEET_ID") || "").trim();
  if (!id) throw new Error("Falta FLUJO_SHEET_ID en Script Properties (la copia del Flujo de caja).");
  var real = String(p.getProperty("FLUJO_PERMITIR_REAL") || "").toLowerCase() === "true";
  var ss = SpreadsheetApp.openById(id);
  if (!real && !/cop(y|ia)/i.test(ss.getName())) {
    throw new Error("Mientras FLUJO_PERMITIR_REAL no sea true solo se escribe en una copia del Flujo (\"" + ss.getName() + "\").");
  }
  return ss;
}

function fxLeerTablaPorNombre_(ss, nombre) {
  var sh = ss.getSheetByName(nombre);
  if (!sh || sh.getLastRow() < 1) return null;
  var datos = sh.getDataRange().getValues();
  var h = datos[0].map(function (x) { return String(x).trim(); });
  return { headers: h, c: function (n) { return h.indexOf(n); }, filas: datos.slice(1) };
}

/** Borra y reescribe una pestaña auxiliar (solo las que crea este archivo). */
function fxEscribirTabla_(ss, nombre, cols, filas) {
  if ([FX_TAB_PAGOS, FX_TAB_PROY, FX_TAB_COMP].indexOf(nombre) === -1) throw new Error("Pestaña no permitida: " + nombre);
  var sh = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
  sh.clearContents();
  var valores = [cols].concat(filas.map(function (f) { return cols.map(function (n) { return (f[n] === undefined || f[n] === null) ? "" : f[n]; }); }));
  sh.getRange(1, 1, valores.length, cols.length).setValues(valores);
  sh.setFrozenRows(1);
  var cImp = cols.indexOf("IMPORTE");
  if (cImp !== -1 && valores.length > 1) sh.getRange(2, cImp + 1, valores.length - 1, 1).setNumberFormat("#,##0.00");
  var cFec = cols.indexOf("FECHA");
  if (cFec !== -1 && valores.length > 1) sh.getRange(2, cFec + 1, valores.length - 1, 1).setNumberFormat("dd/mm/yyyy");
}

function fxEmpresa_(texto) {
  var t = fxNorm_(texto);
  if (!t) return "";
  return Object.keys(FX_EMPRESAS).filter(function (k) { return t.indexOf(k) !== -1; })[0] || "";
}

function fxEmpresaDeUnidad_(texto) {
  var t = fxNorm_(texto);
  if (!t) return "";
  var k = Object.keys(FX_UNIDADES).filter(function (u) { return t.indexOf(u) !== -1; })[0];
  return k ? FX_UNIDADES[k] : "";
}

function fxNorm_(s) {
  return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ]/g, "");
}

function fxNormSuave_(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** "518,000.00", "1.234,56", 1234.5 → número. */
function fxMonto_(v) {
  if (typeof v === "number") return v;
  var s = String(v || "").replace(/[$\s]/g, "");
  if (!s) return 0;
  var neg = /^-|^\(.*\)$/.test(s);
  s = s.replace(/[()-]/g, "");
  var iC = s.lastIndexOf(","), iP = s.lastIndexOf(".");
  if (iC > iP) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  var n = parseFloat(s);
  return isNaN(n) ? 0 : (neg ? -n : n);
}

/** Date o texto (aaaa-mm-dd, dd/mm/aaaa, dd/mm/aa) → Date a medianoche, o null. */
function fxFecha_(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  var s = String(v || "").trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { var a = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return new Date(a, +m[2] - 1, +m[1]); }
  return null;
}

function fxFechaTxt_(d) {
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}
function fxHoy_() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function fxSumarDias_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function fxProximoHabil_(d, feriados) {
  var x = new Date(d.getTime());
  while (x.getDay() === 0 || x.getDay() === 6 || (feriados && feriados[fxFechaTxt_(x)])) x = fxSumarDias_(x, 1);
  return x;
}
