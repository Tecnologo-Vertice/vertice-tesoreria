# Guion de la demo · 13/10/2026 · 8 minutos

Abrir la app en una ventana limpia (o incógnito). Entrar como **Vivi**. Tocar "Reiniciar demo" antes de empezar.

## 0. Problema (1 min)

"Hoy facturas, pagos y caja viven en planillas distintas. Vivi carga un pago, Guido no sabe si ya fue a Xubio ni con qué cuenta, y nadie sabe quién aprobó qué. Esto es la misma lógica que ya corre en producción, pero con base propia, usuarios y auditoría."

## 1. Vencimientos (1 min)

- Pantalla **Vencimientos**. Señalar las cinco cifras: vencidas, hoy, 7 días, 30 días, deuda total.
- "Este resumen sale por mail todos los días a las 8. Ya está probado en la copia de desarrollo."
- Cambiar el filtro a **Beratung**: la tabla por empresa y el detalle se filtran.

## 2. Aprobación (1,5 min)

- Cambiar sesión a **Aprobador**. Pantalla **Aprobación**.
- Abrir la primera tarjeta (Insumos Médicos del Sur). Mostrar lo que leyó la IA: neto, IVA, CAE, "CAE y totales OK".
- Elegir cuenta contable **COSTO DE INSUMOS** y método **Transferencia**. "Regla de oro de Santi: siempre la cuenta del plan de Xubio, nunca una categoría genérica."
- **Aprobar**. Ver el toast y el contador de la bandeja.
- Pestaña **Excepciones**: "Hoy esto llega como un mail que nadie recibe. Acá queda en una bandeja con responsable."

## 3. Pago con IA (2 min)

- Cambiar sesión a **Vivi**. Pantalla **Pagos**.
- Marcar **Laboratorio Modelo S.A.** (vencida hace 9 días) y tocar **Pagar seleccionada**.
- Elegir el comprobante `transferencia_galicia_8841.pdf`. Esperar el "✦ La IA está leyendo…" (1 a 2 s). Los campos se completan en dorado.
- Mostrar: "Vinculado … cancela el 100 %", cuenta sugerida por regla, "Forma de carga: ORDEN PAGO".
- **Subir y pasar a Guido**. Toast: "Pago cargado y en la bandeja de Guido". "Vivi no tipeó ningún importe."
- Opcional: **Pago sin factura** con `captura_app_banco_borrosa.jpg`: confianza 62 %, aviso de imagen poco legible, la IA sugiere IMPUESTO DEB/CRED BANCARIO por el texto "Ley 25413".

## 4. Contabilización (1,5 min)

- Cambiar sesión a **Guido**. Pantalla **Contabilización**.
- Primera tarjeta: el pago que acaba de cargar Vivi, con su comentario, la cuenta sugerida y la forma de carga.
- **Contabilizar en Xubio** → 1 segundo → "Registrado en Xubio como OP-xxxx". "En producción esto crea la orden de pago real; primero lo probamos en seco con Guido."
- Mostrar la tarjeta de YSD "sin cuenta definida" con el campo en rojo: "el sistema no deja contabilizar sin cuenta".
- Pestaña **Pendiente Ralpharma**: "Hoy Robles y Farma Control pasaban a contabilizadas solas. Acá alguien tiene que confirmar la carga, con su nombre."

## 5. Flujo de fondos (1 min)

- Pantalla **Flujo de fondos**. Barras: real, proyectado, vencido, cheques. Caja proyectada a 30 días.
- **Exportar para el Cash Flow**: baja un CSV. "Esto es lo que el Cash Flow de Santi lee con IMPORTRANGE. No tocamos su planilla."

## 6. Auditoría y cierre (1 min)

- Pantalla **Auditoría**. Filtrar por **Guido**: aparece el OP que acaba de registrar, con fecha y hora.
- Cierre: "Costo de software cero para esta etapa. Tres decisiones para avanzar:"
  1. Quién aprueba facturas.
  2. Presupuesto mensual para base con backups e IA paga (del orden de USD 25 a 50).
  3. Primer pago real a Xubio, chico, en Beratung, con Guido al lado.

## Checklist previa

- [ ] `npm run build` sin errores y `npm run preview` abre en localhost.
- [ ] URL de Netlify abre en incógnito (o plan B: `npm run preview` en la notebook).
- [ ] "Reiniciar demo" antes de empezar.
- [ ] Buscar en el repo: ningún CUIT real, ningún `AIza`, ningún `secret`.
- [ ] Video de respaldo de 2 minutos grabado.
- [ ] Hoja impresa con las tres decisiones.

## Plan B

| Falla | Respuesta |
|---|---|
| Netlify caído o sin red | `npm run preview` local; la demo no usa red para nada |
| Se traba el navegador | "Reiniciar demo" y seguir desde la pantalla donde estaba (el hash de la URL la recuerda) |
| Pregunta "¿y la seguridad?" | Login con Google por dominio y roles van en la primera semana; hoy el dashboard está abierto a cualquier cuenta de Google |
| Pregunta "¿cuánto cuesta?" | Demo USD 0; producción USD 25 a 50 por mes más IA por documento (centavos) |
