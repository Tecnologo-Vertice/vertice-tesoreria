# Flujo de trabajo real y preguntas abiertas

Actualizado 13/10/2026 con las respuestas de Guido. Marcas: ✅ confirmado · ❓ falta preguntar.

## El circuito

| Paso | Quién | Qué hace | Dónde | Estado |
|---|---|---|---|---|
| 1 | Sistema | Lee el mail PROVEEDORES, la IA extrae los datos, la factura cae en "Pendientes aprobación" | Apps Script | ✅ |
| 2 | **Guido** | Revisa, corrige, aprueba. La factura sube a Xubio como comprobante de compra y pasa a "Para pagar" | Apps Script → Xubio | ✅ |
| 3 | **Vivi** | Paga en el homebanking, carga el comprobante, confirma | Apps Script | ✅ |
| 4 | **Guido** | Crea la orden de pago en Xubio a mano y tilda la factura que cancela | Xubio | ✅ es lo que se automatiza ahora |
| 5 | **Guido** | Concilia contra el extracto | Xubio, Ralpharma o Claude, según la empresa | ✅ fragmentado |

## Respuestas de Guido (13/10/2026)

### Orden de pago

| Pregunta | Respuesta | Qué implica para el sistema |
|---|---|---|
| ¿Elegís la factura o Xubio la imputa sola? | La elige y la tilda | La OP automática **tiene que llevar la factura imputada**. El payload de la copia no la lleva: hay que agregarla. |
| ¿Qué cuenta de origen? | La cuenta exacta | Coincide con el diseño: cuenta de origen con el nombre exacto de Xubio. |
| ¿Retenciones? | No, no son agentes de recaudación | Simplifica: `transaccionRetencionItems` siempre vacío. |
| ¿Varias facturas del mismo proveedor? | Una sola OP, tilda varias facturas | Coincide con `pagos_facturas`: un pago, N facturas, una OP. |
| ¿Pago parcial? | Hace la OP y tilda la factura; Xubio anota cuánto se pagó | Hay que mandar el importe aplicado a cada factura, no solo el total. |
| ¿Pagos sin factura? | Casi siempre salida de fondos, a veces asiento manual | ⚠️ La API de Xubio no tiene salida de fondos. La copia la registra como asiento manual. **Hay que confirmar con Guido que eso le sirve.** |
| ¿Cómo sabés que el pago coincide? | Por importe; el software de Vértice ya muestra proveedor y factura | El vínculo pago-factura que arma Vivi es la fuente de la imputación. |
| ¿Cuánto tarda una OP? | Un minuto aprox.; la cantidad varía por día | El ahorro de tiempo por OP es chico. El valor está en no cargar dos veces, no equivocarse de factura o importe, y dejar registro. |

### Conciliación

| Empresa | Cómo concilia hoy |
|---|---|
| Héctor Robles y Droguería Robles | En Ralpharma (el mismo sistema donde se cargan sus facturas, porque no usan Xubio) |
| Beratung | En Xubio **no funciona** (no sabe por qué). La hace con Claude subiendo los Excel |
| Las demás | En Xubio |

- **Extractos:** Claude los baja de forma programada los lunes y a fin de mes. El Hipotecario falló hoy y lo bajó a mano.
- **Cobranzas de hospitales:** las mira directo en el homebanking.
- **Diferencias:** antes las anotaba en un archivo de su notebook; desde que concilia con Claude ya no lo usa.

## La OP de ejemplo que pasó Guido

OP X-0001-00000483 de INDIA ADV, 14/09/2026, a El Jumillano S.A., por $298.931,21.

| Qué muestra | Qué implica |
|---|---|
| Una OP cancela **6 facturas**, cada una con su importe cancelado | Confirma el modelo: un pago, N facturas, importe por factura. |
| Una de las 6 cancela **$0,01** | Guido limpia centavos que quedaron de pagos anteriores. El sistema tiene que detectar saldos residuales chicos y ofrecer incluirlos. |
| Facturas identificadas como `A-00105-02121138` (letra, punto de venta, número) | Es el mismo formato con que el Apps Script sube la factura. **Se puede encontrar cada factura en Xubio por proveedor y número**, sin haber guardado el id. Alivia el problema del id. |
| Pago con **cheque diferido**: cuenta "Cheque Diferido BRUBANK", cheque N° 29598, vence 18/09/2026 | La cuenta de origen no es el banco sino una cuenta de cheques diferidos, y el instrumento lleva número y vencimiento. El armado actual no manda número ni vencimiento: hay que agregarlos. |
| Observación "CHEQUE DIFERIDO" | Texto libre; se puede armar solo. |

### Lo que devolvió la API (13/10/2026, `gas/VerOrdenDePago.gs` en la copia)

- La OP tiene id interno 95139854. Trae proveedor, fecha, número de recibo, observación y el instrumento de pago.
- Cheque verificado: `tipoCuenta: 4`, cuenta "Cheque Diferido BRUBANK", `chequePropio: "29598"`, `vencimientoCheque: "2026-09-18"`, `banco: Banco Brubank SAU`. **Ya se agregó al armado de la OP del sistema nuevo.**
- **No trae las seis facturas canceladas.** La especificación oficial de la API lo confirma: `PagoBean` no tiene ningún campo para imputar facturas, y no hay otro recurso de imputación.

### Qué significa

Por API se puede crear la OP con el cheque o la transferencia, pero **queda a cuenta del proveedor, sin facturas tildadas.** Guido tendría que entrar igual a Xubio a imputarla. Con un minuto por OP, el ahorro así es casi nulo.

### Caminos posibles

| Camino | Cómo | Riesgo | Siguiente paso |
|---|---|---|---|
| **A. Preguntar a Xubio** | Soporte de Xubio: ¿la API permite imputar una OP a comprobantes de compra? ¿Hay un recurso no documentado? | Ninguno | Mandar la consulta (lo puede hacer Guido o Santi desde la cuenta) |
| **B. Pagar desde la factura** | `comprobanteCompraBean` tiene `transaccionOrdenPagoItems` (cuenta, importe, cheque, banco) y admite modificación (PUT). Podría registrar el pago dentro de la factura, quedando imputado | Es una escritura real y no hay sandbox. No sirve para una OP con varias facturas | Una prueba en el Xubio de Vértice BI con una factura de prueba de $1, que después se borra (la API permite borrar comprobantes de compra). Con OK de Guido |
| **C. OP a cuenta + imputación manual** | El sistema crea la OP; Guido solo tilda las facturas en Xubio | Ahorro chico | Solo si A y B fallan |
| **D. Cambiar el foco** | Dejar la OP como está (un minuto) y automatizar la conciliación, que hoy está repartida en tres métodos y con Beratung roto | Ninguno | Hablar con Guido sobre cuál le pesa más |

### Camino B explicado

En Xubio, una factura de compra se carga con una **condición de pago**: `1 = Cuenta Corriente` (se paga después, con una OP) o `2 = Al Contado` (se carga ya pagada, con la cuenta, el importe y el cheque dentro de la misma factura). Hoy el Apps Script sube todas como cuenta corriente. La idea del camino B es que, cuando Vivi paga, el sistema **modifique esa factura en Xubio y le agregue el pago adentro**, en vez de crear una OP aparte. Si Xubio lo acepta, la factura queda pagada e imputada sin que Guido tilde nada.

Lo que no sabemos: si Xubio deja pasar una factura de cuenta corriente a contado después de cargada, y cómo se ve eso en la cuenta del proveedor y en el banco.

### Resultado del paso 1 (13/10/2026)

- Las facturas que canceló la OP 483 (`A-00105-02121138` y `A-00105-02099926`) figuran en Xubio con **condición cuenta corriente y sin ningún dato del pago.** La API no muestra la imputación OP-factura **desde ningún lado**: ni se puede escribir ni se puede leer.
- Consecuencia: el sistema no puede preguntarle a Xubio si una factura está pagada. **La base propia es la fuente de verdad de lo pagado**, a partir de lo que carga Vivi.
- `A-00105-02099926` totaliza $67.636,37 y la OP le canceló $0,01: confirma el resto de un pago anterior.
- **No hay ninguna factura al contado** en INDIA en el período: no hay un ejemplo real para copiar. El camino B solo se puede saber probándolo (pasos 2 y 3, con `gas/PruebaPagoEnFactura.gs`).
- Las facturas se encuentran por proveedor y número, tal como suponíamos.

### Prueba en tres pasos

| Paso | Qué | Escribe en Xubio | Quién |
|---|---|---|---|
| 1 | Correr `gas/VerFacturasDeCompra.gs` en la copia: muestra cómo quedaron las facturas que pagó la OP 483 y una factura al contado real | No | Tecnología |
| 2 | En el Xubio de **Vértice BI** (la empresa con menos movimiento): cargar por API una factura de prueba de $1 de un proveedor de prueba, **al contado**, con el pago adentro. Guido la mira en Xubio. Después se borra | Sí, $1, se borra | Tecnología + Guido mirando |
| 3 | Misma empresa: cargar otra factura de prueba de $1 en **cuenta corriente** y después modificarla para agregarle el pago, que es el caso real. Guido la mira. Se borra | Sí, $1, se borra | Tecnología + Guido mirando |

**Qué tiene que mirar Guido en los pasos 2 y 3:**
1. ¿La factura figura como pagada o cancelada?
2. ¿Aparece el movimiento en la cuenta bancaria o de cheques correcta, con el importe y la fecha?
3. ¿El saldo del proveedor queda en cero?
4. ¿Aparece una OP, o algo que él tenga que tocar después?
5. ¿Le sirve así para conciliar, o le cambia algo?
6. ¿Se borra limpio, sin dejar rastro en el banco?

**Vivi no necesita ver la prueba.** Su trabajo no cambia: sigue subiendo el comprobante y confirmando el pago. Lo único que cambia es lo que pasa en Xubio después, que es terreno de Guido. Vivi entra en el piloto, cuando todo el circuito corre junto.

**Límite conocido:** este camino sirve para pagos de **una factura por vez** (o pagos parciales de una factura). Para una OP con varias facturas, como la de El Jumillano, habría que dividir el pago entre facturas y Guido tiene que decir si eso le sirve contablemente.

### ¿Qué le pesa más a Guido? (13/10/2026)

> "Conciliar te lleva más tiempo, pero ahora con Claude ya no es problema, pero por otro lado... hay muchos pagos también. Igual Claude lo hace, salvo con Héctor Robles y Droguería Robles."

**Conclusión:** el camino D (pasar el foco a la conciliación) se descarta para las empresas con Xubio, porque Guido ya la resolvió con Claude. **La prioridad sigue siendo la OP**, por volumen de pagos. Queda abierta la conciliación de Héctor Robles y Droguería Robles en Ralpharma, que es donde Claude no llega.

Falta aclarar con Guido: cuando dice "igual Claude lo hace", ¿se refiere solo a conciliar, o también usa Claude para cargar los pagos?

## Lo que esto cambia en el plan

1. **Sigue siendo prioridad la OP automática**, pero el valor a vender es control y cero doble carga, no minutos.
2. **Falta el id de Xubio de cada factura.** Hoy el Apps Script marca "SUBIDO" y no guarda el id que devuelve Xubio. Sin ese id no se puede tildar la factura en la OP. Dos caminos:
   - Guardar el id al subir (cambio chico en `subirUnaFilaAXubio_`, coordinado con Santi).
   - Buscarlo en Xubio por proveedor y número antes de armar la OP (ya existe `comprobanteYaExiste_`, que hace esa búsqueda).
   - Recomendado: los dos. El primero para lo nuevo, el segundo para el histórico.
3. **Falta el nombre exacto del campo de imputación** en la orden de pago de Xubio. Se resuelve leyendo una OP real que Guido ya haya cargado con facturas tildadas (`inspeccionarXubioPagos` en la copia, solo lectura).
4. **Conciliación queda para después**, y ya no parte de cero: Guido usa Claude con Excel. El sistema puede darle el archivo de pagos del período listo para cruzar, y más adelante hacer el cruce solo. La falla de Beratung en Xubio hay que mirarla aparte; puede ser configuración de la cuenta bancaria en Xubio.

## Preguntas que quedan

### Para Guido
1. Los pagos sin factura que hoy cargás como salida de fondos, ¿te sirve que el sistema los registre como asiento manual (débito a la cuenta de gasto, crédito al banco)? Por API no existe la salida de fondos.
2. ¿Podés pasarme el número de una OP reciente que tenga dos o más facturas tildadas, de cualquier empresa? Con eso leo cómo la guarda Xubio.
3. La conciliación de Beratung en Xubio, ¿qué pasa exactamente: da error, no trae movimientos, no cierra el saldo?

### Para Vivi
4. ¿Qué comprobante subís: PDF del banco, captura de la app, o depende?
5. Con cheque o e-cheq, ¿dónde anotás número y fecha de acreditación?
6. El mail al proveedor, ¿lo mandás vos o sale solo?
7. ¿Qué es lo que más tiempo te lleva al cargar un pago?

### Para Santi
8. ¿Le parece bien que el Apps Script guarde el id de Xubio de cada factura al subirla? Es una línea en `subirUnaFilaAXubio_`.
9. Robles y Farma Control en Ralpharma: ¿quién las carga y cuándo?

## Dónde queda esto en la app nueva

| Paso | Bandeja |
|---|---|
| 2 · Guido aprueba | **Aprobación** |
| 3 · Vivi paga | **Pagos** |
| 4 · Guido confirma la OP | **Contabilización**: la OP llega armada con las facturas tildadas; un clic la manda a Xubio |
| 5 · Guido concilia | Sin pantalla todavía. Primero: exportar los pagos del período para cruzar con el extracto. Después: cruce automático |
