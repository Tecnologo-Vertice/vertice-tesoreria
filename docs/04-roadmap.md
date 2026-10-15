# Hoja de ruta después de la demo

| Fase | Plazo | Entregables | Criterio de aceptación |
|---|---|---|---|
| **1 · Ordenar la casa** (en Apps Script, sin reescribir) | Semanas 1-2 | Web app con acceso `DOMAIN`; `MAIL_ADMINISTRACION` real; claves a Script Properties y rotadas; Gemini en el proyecto de la empresa; tabla de empresas para `marcarComoContabilizada`; estado "Pendiente Ralpharma"; anular las 7 facturas mal cargadas en Beratung | Una cuenta ajena no abre el dashboard; llega un mail de prueba; 0 claves en el código; Control B e YSD no pasan a contabilizadas sin id de Xubio |
| **2 · Base y bandeja de contabilización** | Semanas 3-6 | Proyecto Supabase dev + prod; migraciones del esquema de `02-modelo-datos.md`; login con Google por dominio; API en Netlify Functions; Apps Script hace POST de cada factura leída a la API; pantallas Pagos y Contabilización conectadas a la base; `Export_CashFlow` + IMPORTRANGE en el Cash Flow | Vivi y Guido usan la app nueva para pagos durante dos semanas en paralelo con la hoja; 0 pagos perdidos; auditoría completa |
| **3 · Xubio real** | Semanas 6-8 | Cliente Xubio con modo en seco y `xubio_log`; primer pago real chico en Beratung con Guido; alta gradual por empresa; control de duplicados contra Xubio antes de escribir | Orden de pago en Xubio con cuenta correcta validada por Guido; 0 duplicados en 2 semanas |
| **4 · Aprobación y proyección** | Meses 2-3 | Bandeja de aprobación en la app; facturas aprobadas proyectadas en el flujo; IA auditora nocturna (totales que no cierran, CAE vencidos, CUIT distinto al histórico) | 100 % de lo aprobado proyectado; reporte diario con hallazgos que Guido acepta |
| **5 · Conciliación** | Meses 3-6 | Importación de extractos por archivo para todos los bancos (incluidos BBVA, Macro, Mercado Pago, Credicoop y Belo); motor de match importe + fecha ± días + referencia; bandeja de no conciliados | ≥ 80 % conciliado solo; diferencias explicadas |
| **6 · Apagar Apps Script** | Cuando 2-5 estén estables | Ingesta de Gmail y Drive migrada o reducida a un reenvío; hoja Facturas en solo lectura; historial migrado con `sheets_fila_origen` | Un mes sin tocar la hoja |

## Decisiones que se le piden a Santi

1. ¿Quién aprueba facturas y por qué monto? ¿Qué hace el "Controller"?
2. Conexión con el Cash Flow: ¿lee `Export_CashFlow` con IMPORTRANGE? (recomendado)
3. ¿Dónde vive el Apps Script de producción: su cuenta, unidad compartida o cuenta funcional?
4. ¿Gemini pago en el proyecto de la empresa, o se evalúa Claude? Prueba con 50 facturas reales.
5. ¿Qué plan de Xubio tiene cada empresa y si incluye API? ¿Hay sandbox?
6. ¿Quién carga en Ralpharma y qué datos necesita?
7. Primer pago real a Xubio: fecha, empresa (Beratung), proveedor existente, con Guido.
