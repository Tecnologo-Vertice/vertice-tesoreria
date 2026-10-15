# Lo que pidió Santi y cómo lo resolvimos

Fuente: mensaje textual de Santi del 02/10/2026, pizarrón del 02/10 y deck "Ecosistema Financiero Integrado" (registrados en `contexto_santi_y_equipo.md`). Fecha de este cruce: 13/10/2026.

**Cómo leer la columna "Estado":**
- 🟢 Funciona hoy, en producción o en la copia de desarrollo del Apps Script.
- 🟡 Está resuelto en la demo (con datos ficticios o simulado) y diseñado en el sistema nuevo, pero todavía no corre con datos reales.
- 🔴 No está hecho. Tiene fase asignada en `04-roadmap.md`.

## 1. El mensaje de Santi, frase por frase

| # | Lo que pidió Santi (textual) | Cómo lo resolvimos | Estado |
|---|---|---|---|
| 1 | "las facturas llegan al mail y la IA las interpreta para el sistema vértice" | Ya existe en producción: Gmail con etiqueta PROVEEDORES cada 10 minutos, carpetas de Drive a las 4, carga manual. Gemini lee el PDF y devuelve CUIT, tipo, número, CAE, neto, IVA, percepciones y total. En la demo se ve en la bandeja **Aprobación**, tarjeta abierta: "Lo que leyó la IA". En el sistema nuevo el Apps Script sigue leyendo el mail y empuja cada factura a la base nueva. | 🟢 |
| 2 | "con esa información se cargan en xubio" | Existe en producción para Beratung, India, Control B e YSD, cada 15 minutos (con errores de productos inexistentes, 406). En la demo: botón "Aprobar y enviar a Xubio" que exige elegir la cuenta contable antes de enviar. | 🟢 producción · 🟡 demo |
| 3 | "y se proyectan con el vencimiento en el flujo en la cuenta contable asignada" | **No existía:** el Flujo 1 guardaba el vencimiento pero no escribía en ningún flujo. En la demo, la pantalla **Flujo de fondos** proyecta cada factura aprobada en la semana de su vencimiento, con su cuenta contable, y la pantalla **Vencimientos** las ordena por urgencia. En el sistema nuevo esto es una vista SQL (`export_cashflow`) que se vuelca a una hoja para el Cash Flow. | 🟡 |
| 4 | "después pasamos a tesorería que paga esas facturas y pone el pago en el sistema" | Existe en producción; en la copia se agregó la carga ágil (formulario que se completa solo). En la demo: bandeja **Pagos**, marcar factura, "Pagar seleccionada", elegir comprobante. | 🟢 |
| 5 | "esos pagos van a aparecer tanto en el flujo como en el sistema contable con lo que extrajo la IA del comprobante que cargó la tesorera" | En la copia: la IA lee el comprobante en unos 2 segundos (banco, importe, fecha, número de cheque), el pago se arma completo para Xubio y queda **SIMULADO**, y se escribe en la pestaña `Flujo_Fondos`. En la demo: los campos leídos aparecen en dorado, el pago vinculado se descuenta del flujo y Guido lo contabiliza con un clic que devuelve un id de Xubio simulado. **Falta el envío real a Xubio**, que se hace con un pago chico y Guido presente (fase 3). | 🟡 |
| 6 | "a la factura asociada, y los comprobantes sin factura asociada" | Las dos cosas. En la copia y en la demo: pago con factura (una, varias, parcial, con nota de crédito) y "Pago sin factura" con sugerencia de cuenta contable (primero reglas aprendidas, después IA con el comentario de la tesorera) y forma de carga en Xubio (orden de pago, salida de fondos o asiento manual). En la demo, el caso de la comisión bancaria y el VEP de IIBB muestran esto. | 🟢 copia · 🟡 demo |
| 7 | "en caso de ser cheques se va a alimentar el cheque en el sheet de cash flow" | En la copia: pestaña `Cheques` en la hoja del sistema, con fecha de acreditación estimada, **sin escribir en el Cash Flow de Santi** (es su hoja de uso diario). En la demo: tabla "Cheques emitidos" y botón "Exportar para el Cash Flow" que genera el archivo que su planilla leería con IMPORTRANGE. **Decisión pendiente de Santi:** opción A (escribimos en su hoja), B (su hoja lee la nuestra, recomendada), C (separadas). | 🟡 |
| 8 | "la tesorera va a enviar los mails de pagos a los proveedores proporcionándoles la factura que se pagó con su pago asociado" | En la copia: mail automático al pagar el 100 %, con factura y comprobante adjuntos (en prueba va a una casilla de pruebas). En la demo queda registrado en Auditoría como "Mail a proveedor". **Falta:** completar el catálogo de mails de proveedores con CUIT (hoy no tiene) y definir el remitente ("enviar como" Vivi o una casilla de pagos). | 🟡 |
| 9 | "se debe bajar los extractos bancarios para que se puedan leer la info de los gastos bancarios y los rendimientos financieros y los saldos finales del día" | **No está hecho.** Hoy el Cash Flow importa 7 planillas de extractos a mano y faltan BBVA, Macro, Mercado Pago, Credicoop y Belo. En el modelo de datos nuevo ya existe la tabla `movimientos_bancarios` y el estado "conciliado" del pago. Fase 5 del roadmap (meses 3 a 6). | 🔴 |
| 10 | "el flujo va a ser donde se concilian los pagos, igual a la conciliación bancaria, porque va a estar diagramado por cuentas contables" | **No está hecho.** La base está preparada: todo pago y toda factura llevan cuenta contable obligatoria, que es lo que hace posible comparar flujo, Xubio y banco. El motor de conciliación (importe + fecha ± días + referencia) es fase 5. | 🔴 |
| 11 | "al tener igualado el flujo con xubio, te va a alimentar la información de los económicos, con el último control financiero y las provisiones" | **No está hecho.** Depende de la conciliación. Se diseña después de la fase 5, con el Controller (rol que todavía no sabemos quién ocupa). | 🔴 |
| 12 | "se genera un control cruzado de todos los sistemas, entonces todos vamos a estar hablando de los mismos números, mismo idioma" | Es la **regla de oro** que atraviesa todo: ningún pago se contabiliza sin cuenta del plan de Xubio. En la demo, Guido no puede tocar "Contabilizar" si la cuenta está vacía (campo en rojo). En la base nueva es una restricción de la tabla, no una convención. Y cada acción queda con nombre y hora, que hoy la hoja no guarda. | 🟡 |

## 2. El pizarrón del 02/10

| Lo que decía el pizarrón | Cómo lo resolvimos | Estado |
|---|---|---|
| "Software (Login)" | Demo: selector "Entrar como" con cinco roles. Sistema nuevo: login con Google restringido a cuentas @verticebi.com, roles por persona. Hoy el dashboard está abierto a cualquier cuenta de Google con el link. | 🟡 demo · semana 1 cerrar acceso |
| "API keys Grupo India → todas Vértice" | Pendiente. Semana 1: proyecto de Google Cloud de la empresa, claves fuera del código, baja de las claves personales. | 🔴 semana 1 |
| "Pagos + pagos en el flujo" | Resuelto en copia y demo (filas 4, 5 y 7 de arriba). | 🟡 |
| "Facturas en el flujo" | Resuelto en la demo (fila 3). | 🟡 |
| "Conciliación bancaria + flujo" | Fase 5. | 🔴 |
| "Bot de mejora" (bot que corrige el prompt de la IA) | No está. Lo que sí hay en la copia es memoria por proveedor: la cuenta que Guido corrige se recuerda para la próxima. Es la versión simple del mismo objetivo. | 🟡 parcial |
| "Discriminación de productos" (5ª instancia) | No está en la demo. Hay un relevamiento hecho: `Beratung_Productos_y_Cuentas.xlsx` con la propuesta de productos nuevos. Se resuelve en Xubio, no en código. | 🔴 |
| "Reemplazar Gemini" | Decisión abierta: Gemini pago en el proyecto de la empresa, o Claude. Se decide con una prueba de 50 facturas reales midiendo precisión y costo. | 🔴 decisión |
| "IA auditora" | Fase 4: proceso nocturno que busca totales que no cierran, CAE vencidos, CUIT distinto al histórico, pagos repetidos. | 🔴 |
| "Formas de carga de pagos: asiento manual, orden de pago, salida de fondos" | Las tres están en la copia y en la demo, con regla automática: con factura es orden de pago; impuestos y sueldos van a asiento manual; el resto, salida de fondos. Guido puede cambiarla. | 🟢 |
| "Pendiente de aprobación / condición de pago" | Bandeja de aprobación con cuenta contable y método de pago (transferencia, cheque a N días, e-cheq, débito, tarjeta, caja). | 🟢 |
| "Rolpharma (no tiene API)" | Nuevo estado "Pendiente Ralpharma": las facturas de Droguería Robles, Héctor Robles y Farma Control ya no pasan a "contabilizadas" solas; alguien confirma la carga con su nombre. | 🟡 |
| "Color", "Caja", "Rodés" | Sin definir. Hay que preguntarle a Santi qué son. | 🔴 pregunta |

## 3. Lo que Santi pidió el 28/09 sobre el sistema en sí

Según `07-sistema-nuevo.md`: "salir de Apps Script y armar un sistema propio que haga todo lo que hace hoy, sume lo que falta, y se pueda compartir para que lo usen otros".

| Pedido | Cómo lo resolvimos |
|---|---|
| Salir de Apps Script | Stack nuevo en `01-decision-stack.md`: pantalla web propia, base PostgreSQL, funciones en la nube. Apps Script queda solo como "cartero" de Gmail y Drive hasta que se migre la ingesta. |
| Hacer todo lo que hace hoy | La demo cubre el circuito completo de facturas y pagos. La ingesta de mail y el envío a Xubio se reutilizan del sistema actual durante la transición; no se tira nada. |
| Sumar lo que falta | Flujo proyectado, cheques, auditoría, roles y "Pendiente Ralpharma" están en la demo. Extractos, conciliación y económicos tienen fase y fecha. |
| Que lo usen otros | Se interpretó como "más gente del equipo con roles". La base lleva `empresa_id` en todas las tablas, así que ofrecerlo a terceros es posible más adelante sin rehacer nada, pero no es parte de esta etapa. **Confirmar con Santi qué quiso decir.** |

## 3b. El deck "Ecosistema Financiero Integrado" (9 diapositivas, 22/09/2026)

El deck es la versión ordenada del mensaje de Santi. Se revisaron las 9 diapositivas completas. Cruce paso a paso:

| Flujo del deck | Pasos que dibuja | En la demo | Estado |
|---|---|---|---|
| **1 · Ingesta y registración dual** | Llega la factura (mail, Drive, manual) → la IA extrae CUIT, neto, IVA, CAE y asigna cuenta contable → ¿CAE y totales OK? → Xubio (asiento) + Flujo (proyección) · NO → Bandeja de Excepciones | Bandeja **Aprobación** con "Lo que leyó la IA", pestaña **Excepciones**, cuenta contable precargada por proveedor, "Aprobar y enviar a Xubio", y la factura aprobada aparece proyectada en **Flujo de fondos** | 🟡 completo en demo |
| **2 · Tesorería y ejecución de pagos** | Vence la factura → Tesorería paga y sube comprobante → la IA lee banco, importe, fecha, cheque → ¿cheque? → impacto dual (Xubio + Flujo) → mail al proveedor · SÍ cheque → hoja Cheques | **Vencimientos** (aviso diario), **Pagos** con lectura por IA, cheques con acreditación estimada en Flujo, **Contabilización** registra en Xubio (simulado), mail en auditoría | 🟡 completo en demo, Xubio y mail simulados |
| **3 · Conciliación bancaria y económicos** | Extracto → la IA lee comisiones, rendimientos, saldos → Xubio + Flujo → ¿Xubio = Flujo = Banco? → Controller carga provisiones → económicos (Rolling E, YSD, Estado de Resultados) | Solo saldos ficticios por cuenta y caja proyectada a 30 días | 🔴 fase 5 |

**Actores del deck y dónde están:**

| Actor | En la demo / sistema nuevo |
|---|---|
| Motor IA Vértice | `lib/ia.ts` en demo; función `ia-leer-comprobante` con Gemini en producción |
| Xubio, "la verdad contable" | Función `contabilizar` con modo en seco; `xubio_log` guarda cada envío |
| Flujo, "la verdad financiera" | Pantalla Flujo de fondos + vista SQL `export_cashflow` |
| Dashboard Vértice, "el puente humano" | La app: seis bandejas con roles |
| Equipo humano como auditor | Auditoría de solo inserción; nadie borra |
| Roles: Contabilidad, Tesorería, Dirección, **Controller** | Los cuatro existen como rol. El Controller no tiene pantalla todavía (provisiones son fase 5) |

**Lo que el deck no contempla y el sistema sí:** pagos sin factura, las tres formas de carga en Xubio, 8 empresas con 3 sin Xubio, notas de crédito, pagos parciales y múltiples, quién aprueba, y personas concretas. Está todo en la demo salvo notas de crédito (existen en la copia del Apps Script, no se trajeron a la demo).

**Veredicto:** la demo cubre los Flujos 1 y 2 del deck de punta a punta y es un MVP de lo que Santi pidió para facturas y pagos. El Flujo 3 es la etapa siguiente y la base ya tiene sus tablas.

## 4. Resumen en números

| | Cantidad |
|---|---|
| Frases del mensaje de Santi | 12 |
| Funcionan hoy (producción o copia) | 4 |
| Resueltas en la demo y diseñadas, sin datos reales todavía | 5 |
| No hechas, con fase asignada | 3 (extractos, conciliación, económicos) |

Lo que falta es, justamente, el Flujo 3 completo. Todo lo demás existe o está a un paso de existir con datos reales.
