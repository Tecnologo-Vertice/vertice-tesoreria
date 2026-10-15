# El sistema nuevo, explicado para el equipo

Para Santi, Vivi, Guido y dirección. No hace falta saber de sistemas para leerlo. Fecha: 13/10/2026.

## 1. Qué es, en una frase

Una página web privada de Vértice donde las facturas llegan solas, se aprueban con un clic, los pagos se cargan subiendo el comprobante, y todo queda registrado con nombre y hora, hablando el mismo idioma que Xubio: la cuenta contable.

## 2. Qué cambia para cada persona

| Persona | Hoy | Con el sistema nuevo |
|---|---|---|
| **Vivi (Tesorería)** | Busca en la hoja qué vence, paga, sube el comprobante, tipea importe y banco, deja observaciones. | Abre "Pagos" y ve lo que vence ordenado por urgencia. Sube el comprobante y la IA completa importe, fecha y banco. Escribe un comentario para Guido si hace falta. Listo. |
| **Guido (Administración)** | Revisa lo que cargó Vivi, decide cuenta y forma de carga, carga en Xubio a mano, marca contabilizado. | Abre "Contabilización": cada pago viene con el comentario de Vivi, la cuenta sugerida y la forma de carga (orden de pago, salida de fondos, asiento manual). Revisa y toca "Contabilizar en Xubio". El sistema lo registra en Xubio y guarda el número. Si la cuenta falta, el botón no se habilita. |
| **Quien aprueba facturas** (a definir) | Revisa facturas en el dashboard, elige categoría y método de pago. | Abre "Aprobación": ve lo que leyó la IA, si el CAE y los totales cierran, elige cuenta contable y método de pago, aprueba o rechaza. Queda registrado quién y cuándo. |
| **Dirección** | Pide los números. | Abre "Vencimientos" y "Flujo de fondos": deuda del grupo, qué vence esta semana, caja proyectada a 30 días. "Auditoría" muestra quién hizo cada cosa. |
| **Santi** | Mantiene el Apps Script y el Cash Flow. | El Apps Script se achica a leer el mail. Su Cash Flow sigue siendo suyo: lee una hoja que el sistema arma solo, en lugar de copiar y pegar. |

## 3. De qué está hecho (el "stack")

Pensalo como una casa con cuatro partes.

| Parte | Qué hace | Con qué está hecho | Por qué eso |
|---|---|---|---|
| **La pantalla** | Lo que ven Vivi, Guido y dirección en el navegador. | Una página web moderna (React), publicada en Netlify. | Rápida, funciona en celular, y Netlify la publica en minutos sin servidores que mantener. La empresa ya tiene cuenta. |
| **La base de datos** | Donde viven facturas, pagos, cheques, cuentas y el registro de quién hizo qué. | PostgreSQL, alojado en Supabase. | Es la base que usan los bancos y los sistemas contables. No permite duplicados, no pierde decimales y guarda cada cambio. Supabase además trae el login con Google y el guardado de PDFs. Hoy todo eso vive en una planilla con filas numeradas: si alguien ordena la hoja, los números cambian. |
| **El motor** | Llama a la IA, habla con Xubio, manda mails, arma el flujo. | Funciones pequeñas en la nube (Netlify Functions), escritas en TypeScript. | Cada tarea corre sola, con reintentos, y sin el límite de 6 minutos del Apps Script. |
| **El cartero** | Lee el Gmail de proveedores y las carpetas de Drive. | El Apps Script de hoy, reducido a esa única tarea. | Dentro de Google Workspace, leer el mail de la empresa no pide permisos especiales. Afuera sí. Así no se rompe nada que ya funciona. |

**La IA.** Lee facturas y comprobantes y devuelve los datos en un formato fijo. Hoy es Gemini con claves gratuitas de cuentas personales. Pasa a una cuenta paga de la empresa por dos motivos: los términos del nivel gratuito permiten que personas de Google revisen lo que se envía, y las claves personales se cortan si alguien se va. Si Gemini o Claude, se decide con una prueba de 50 facturas reales.

**Xubio.** Sigue siendo "la verdad contable". El sistema le manda órdenes de pago y asientos por su API, con una cuenta de API por empresa, y guarda lo que mandó y lo que Xubio respondió. Antes de cada envío real hay un modo "en seco" que arma todo sin mandarlo.

**Google Sheets.** Deja de ser la base de datos y pasa a ser una vista: el sistema arma una hoja `Export_CashFlow` que el Cash Flow de Santi lee con IMPORTRANGE, igual que hoy lee los extractos.

## 4. Cuánto cuesta

Precios de lista a octubre de 2026, en dólares. Confirmar en la web de cada servicio antes de contratar.

| Etapa | Qué incluye | Por mes |
|---|---|---|
| **Demo** (ahora) | Página publicada en Netlify con datos ficticios | **USD 0** |
| **Piloto** (semanas 3 a 8) | Base en Supabase gratis, Netlify gratis, IA paga por uso, Vivi y Guido usándolo en paralelo con la hoja | **USD 5 a 20** (solo la IA) |
| **Producción** (desde el mes 2 o 3) | Supabase Pro con copias de seguridad diarias (USD 25), Netlify (gratis o USD 19 si hace falta más), IA por uso, avisos de error (Sentry gratis) | **USD 30 a 60** más la IA |

**La IA por documento.** Una factura cuesta entre medio centavo y cinco centavos de dólar según el modelo. Con las 450 facturas y pagos por mes de hoy: entre USD 5 y USD 25 por mes.

**Lo que no cambia.** Xubio lo paga cada empresa como hoy. Google Workspace ya está. El dominio verticebi.com ya está.

**Lo que no se cobra en dólares.** El tiempo de desarrollo, que es el costo principal, y media hora de capacitación por persona.

**Por qué no "gratis para siempre".** Los planes gratuitos pausan o suspenden el servicio cuando se pasan de un límite o cuando no se usan. Para una demo está bien. Para el sistema que registra los pagos de ocho empresas, no. USD 25 por mes compran copias de seguridad diarias y que nunca se pause.

## 5. Dónde se publica y quién entra

- **Dirección web:** un subdominio de la empresa, por ejemplo `tesoreria.verticebi.com`, servido por Netlify. Sin costo extra.
- **Quién entra:** solo cuentas de Google del dominio verticebi.com (y las que se autoricen explícitamente, por ejemplo la de Santi si es de otro dominio). Cada persona entra con su propio Google, sin contraseñas nuevas.
- **Roles:** Tesorería (carga pagos), Administración (contabiliza), Aprobador (aprueba facturas), Dirección (ve todo, no modifica), Admin técnico (configura, no opera).
- **Es solo para el equipo.** No es para clientes ni proveedores. Los proveedores siguen recibiendo el mail con la factura y el comprobante, como hoy. Si más adelante se quiere ofrecer a otras empresas, la base ya está preparada, pero es otra conversación.
- **Dónde están los datos.** Base de datos en Supabase (servidores en Estados Unidos o Europa, a elegir), PDFs en Supabase Storage, y una copia de lo que necesita el Cash Flow en Google Sheets. Como las facturas tienen datos de personas (prestadores médicos), antes de escalar conviene una consulta con un abogado por la Ley 25.326.

## 6. Cómo se pone en marcha con el equipo

La regla es **no apagar nada hasta que lo nuevo demuestre que funciona**. El Apps Script y la hoja siguen vivos durante toda la transición.

### Semana 1 y 2: ordenar la casa (sin sistema nuevo todavía)

Son arreglos al Apps Script actual que hacen falta sí o sí, con o sin sistema nuevo.

| Qué | Quién | Cómo se verifica |
|---|---|---|
| Cerrar el dashboard a cuentas del dominio | Tecnología con Santi | Una cuenta ajena no lo abre |
| Que las alertas lleguen a alguien real (hoy van a una dirección de ejemplo) | Tecnología | Llega un mail de prueba |
| Claves de la IA y de Xubio fuera del código, en la cuenta de la empresa | Tecnología con Santi | Cero claves en el código |
| Que Control B e YSD no pasen a "contabilizadas" sin estar en Xubio | Tecnología | Prueba con una factura de cada una |
| Definir quién aprueba facturas y quién carga en Ralpharma | Santi y dirección | Nombres escritos |

### Semana 3 a 6: piloto de pagos en paralelo

1. **Se arma la base y la pantalla** con los datos reales de facturas aprobadas (se copian de la hoja, no se borran de ahí).
2. **Capacitación de 30 minutos** a Vivi y Guido, con esta demo como guía. Los dos la usan en la misma sesión: Vivi carga un pago de prueba, Guido lo contabiliza en seco.
3. **Dos semanas en paralelo.** Vivi carga cada pago en el sistema nuevo **y** en la hoja, como hasta ahora. Guido contabiliza en Xubio a mano como siempre, pero además lo marca en el sistema nuevo. Al final de cada semana se comparan las dos listas: deberían ser iguales.
4. **Qué se mide:** pagos cargados en los dos lados, diferencias, minutos por pago, y qué le molestó a cada uno. Se ajusta la pantalla con lo que digan.

### Semana 6 a 8: primer pago real a Xubio

1. Se elige un pago chico de Beratung, a un proveedor que ya exista en Xubio.
2. Se corre en seco y Guido revisa lo que se va a mandar.
3. Se manda de verdad, con Guido al lado, y se verifica en Xubio.
4. Si sale bien, se habilita empresa por empresa. Si algo sale mal, Xubio permite borrar asientos manuales; las órdenes de pago no, por eso se empieza en seco.
5. Desde acá, **Vivi y Guido dejan de cargar pagos en la hoja**. La hoja queda como consulta.

### Mes 2 y 3: aprobación, flujo y mails

- La bandeja de aprobación pasa al sistema nuevo. Las facturas que lee el Apps Script aparecen ahí directamente.
- El Cash Flow de Santi empieza a leer la hoja `Export_CashFlow`. Santi decide cómo y cuándo.
- Los mails a proveedores salen desde el sistema, con el remitente que se defina.
- Se agrega la IA auditora nocturna: un mail diario con lo que no cierra.

### Mes 3 a 6: extractos y conciliación

- Se importan los extractos de todos los bancos (incluidos los cinco que hoy faltan).
- El sistema cruza cada movimiento del banco con un pago registrado y muestra los que no coinciden.
- Recién acá tiene sentido hablar de los económicos automáticos.

### Cuándo se apaga el Apps Script

Cuando pasen dos o tres meses sin que nadie necesite abrir la hoja. No antes.

## 7. Qué no cambia

- El mail de proveedores y las carpetas de Drive siguen igual.
- Xubio sigue siendo donde nacen y mueren los asientos.
- Ralpharma sigue siendo carga manual; lo único nuevo es que queda registrado quién la hizo.
- El Cash Flow de Santi sigue siendo su planilla. El sistema no escribe en ella.

## 8. Preguntas que seguro aparecen

**¿Y si se cae internet?** No se puede cargar, igual que hoy con la hoja. Nada se pierde: lo que ya está cargado queda en la base.

**¿Y si la IA lee mal un importe?** Los campos leídos aparecen marcados y se pueden corregir antes de confirmar. Cuando la imagen es poco legible, el sistema avisa. Lo que corrige Guido se recuerda para la próxima vez con ese proveedor.

**¿Puede alguien borrar un pago?** No. Los pagos se anulan con un registro nuevo que dice quién y por qué. La auditoría no se puede editar.

**¿Quién arregla si algo falla?** Tecnología recibe un aviso automático cuando una función falla. Para que no dependa de una sola persona, todo el código y la documentación quedan en un repositorio de la empresa.

**¿Esto reemplaza a Xubio o al contador?** No. Les ahorra la carga manual y les da la información ordenada.
