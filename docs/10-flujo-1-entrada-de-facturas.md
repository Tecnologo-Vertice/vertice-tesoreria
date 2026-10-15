# Flujo 1 · Entrada de facturas en el sistema nuevo

Escrito el 14/10/2026, a partir del código real de la copia del Apps Script (`apps_script_copia/`, que no se commitea porque tiene claves).

## Cómo funciona

```
Mail con etiqueta PROVEEDORES ──► Apps Script "cartero" ──► /api/ingesta/adjunto ──► archivo guardado + documento en cola
Carga manual en la app ─────────────────────────────────► /api/facturas/subir ───┘
                                                                                     │
                     lector cada 2 min (o "Leer ahora") ◄────────────────────────────┘
                                │  IA (Gemini) + validación + memoria del proveedor
                                ▼
          Factura en Pendientes · Excepciones (con error) · Entrada (no es factura / duplicada / no se pudo leer)
```

- **El Apps Script solo es cartero** (`demo/gas/CarteroGmail.gs`): manda los adjuntos, no lee, no escribe en la hoja y no marca los mails como leídos. Puede convivir con `procesarFacturasDesdeGmail` mientras se comparan los resultados.
- **Nada se pierde:** primero se guarda el archivo y después se lee. Si la IA falla o se corta, el documento vuelve a la cola (hasta 3 intentos) y queda visible en la pestaña **Entrada**.

## Equivalencias con el Apps Script

| Apps Script (Code.gs y otros) | Sistema nuevo | Cambio |
|---|---|---|
| `procesarFacturasDesdeGmail` (cada 10 min, lee y procesa todo en una ejecución de 6 min) | `CarteroGmail.gs` (cada 5 min, solo manda adjuntos) + `leer-documentos` (cada 2 min) | Separar el envío de la lectura: un corte de la IA no deja mails a medias |
| `yaProcesadoAdjuntoGmail_` / hoja `Adjuntos_Gmail_Procesados` | Clave única `(gmail_message_id, nombre_archivo)` en `documentos` | La base garantiza que un adjunto entra una sola vez |
| `getAttachments()` | `getAttachments({ includeInlineImages: false })` | MEJORA: los logos de las firmas ya no se mandan a la IA |
| `extraerDatosConGemini` (prompt + esquema) | `lib/factura.ts` → `promptFactura`, `ESQUEMA_FACTURA` | Mismo manual de carga. MEJORA: lleva los CUIT reales del grupo (en Code.gs quedó "[CUIT India]") y pide el CUIT del receptor |
| Rotación de 5 claves personales de Gemini | Una clave de la empresa + modelo de respaldo ante 429/503 | Cuota paga en vez de esquivar límites |
| `validarFactura_` | `interpretarLectura` | Mismas reglas (CAE de 14 dígitos, totales, B/C con total en exento). MEJORAS abajo |
| `facturaYaExisteEnSheet_` | Clave única de `facturas` + documento DUPLICADO que apunta a la original | El duplicado se ve en Entrada, con link a la factura |
| `normalizarReceptorCanonico_` + regla Robles | `empresaReceptora` | Igual, pero primero por CUIT del receptor |
| `buscarMemoriaProveedor_` / `Catalogo_Proveedores_Por_Empresa` | Tabla `proveedores_empresa`; `aprobar_factura` la actualiza | La memoria se aprende sola al aprobar |
| `guardarPDFEnDrive_` (link público "cualquiera con el link") | Bucket privado `facturas`, link firmado de 10 minutos | MEJORA de seguridad: las facturas no quedan públicas |
| `guardarEnSheets` | `guardar_factura_leida` (SQL, en una transacción) | |
| `enviarAlertaFacturaM_` y `enviarAlertaError_` (mails) | Aviso amarillo en la tarjeta / pestaña Excepciones | Los mails de alerta vuelven en la fase de mails |
| `subirFacturaManual` | Botón **Subir factura** en Aprobación | Se lee en el momento |
| `CATEGORIA_CONTABLE` de la IA (lista genérica) | Se guarda como `categoria_ia`, solo de pista | La cuenta sale de la memoria del proveedor o la elige quien aprueba (regla de oro) |

## Mejoras en la validación (a confirmar con Guido)

| Caso | Apps Script | Sistema nuevo |
|---|---|---|
| CAE vencido **después** de emitir la factura | Error | Válida, con aviso |
| CAE vencido **antes** de la fecha de emisión | Error (si ya pasó) | Error |
| CUIT del proveedor con dígito verificador mal | No se controla | Error: probablemente la IA lo leyó mal |
| CUIT del proveedor = CUIT de una empresa del grupo | No se controla | Error: la IA confundió emisor y receptor |
| Número de comprobante ilegible | Se guarda como punto de venta 00001 | No se crea la factura; queda en Entrada |
| Empresa receptora desconocida | Se guarda como "Otros" | No se crea la factura; queda en Entrada |

**Pregunta para Guido:** ¿una factura que llega después del vencimiento de su CAE, pero se emitió antes, la toma como válida? El sistema nuevo asume que sí.

## Cómo probarlo con la copia

1. Supabase con las migraciones `0001` a `0005` (la `0005` es la de este flujo).
2. Netlify publicado, con `GEMINI_API_KEY` e `INGESTA_TOKEN`.
3. En la copia del Apps Script: archivo nuevo `CarteroGmail` con `demo/gas/CarteroGmail.gs`, Script Properties `SISTEMA_URL`, `INGESTA_TOKEN` y `CARTERO_ETIQUETA = PROVEEDORES_PRUEBA`.
4. Correr `probarCartero()` (muestra qué mandaría, sin mandar) y después `enviarAdjuntosAlSistema()`.
5. En la app, Aprobación → pestaña **Entrada** → **Leer ahora**. Las facturas aparecen en Pendientes o Excepciones.
6. Comparar con lo que escribió la copia en la hoja para el mismo mail.

Si ya se había enganchado `enviarFacturaAlSistema_` en `guardarEnSheets`, quitarlo: manda los datos antes de validar.

## Lo que todavía no está

- **No se probó contra Gemini ni Supabase reales:** las pruebas usan respuestas de IA de ejemplo (`npm run test:ia`, 28 casos) y un Postgres local (`npm run test:sql`, 50 casos).
- **Tiempo de Netlify:** la carga manual lee en el momento, pero Netlify corta a los 10 s. Si una factura tarda más, queda en la cola y la termina el lector programado.
- **Ingesta desde carpetas de Drive** (`procesarFacturasDesdeDrive`): el endpoint ya acepta `origen: 'DRIVE'`, falta el cartero de Drive.
- **Corregir a mano una factura en Excepciones** (editar importes o CUIT) y asignar la empresa a un documento que no la tenía.
- **Subir la factura aprobada a Xubio** (`subirUnaFilaAXubio_`): sigue en el Apps Script.
