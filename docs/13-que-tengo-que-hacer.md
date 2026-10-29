# 13 · Lo que tenés que hacer vos para encender la copia de la hoja real

Unos 15 minutos. Todo lo demás (código, pruebas, subir el puente) lo hace Claude.
Marcá cada casilla a medida que avanzás. Si algo no sale como dice acá, sacá una captura y pasala.

---

## Antes: ¿ya están Supabase y Netlify andando?

- [x] Abrí https://verticetesoreria.netlify.app y entrá con tecnologia@. ✅ 29/10: entra como Brian · Admin técnico.
  - **Entra y ves las bandejas** → seguí con el paso 1.
  - **No existe el sitio o no entra** → primero hay que hacer los pasos 2 a 5 de [11-puesta-en-marcha-hoy.md](11-puesta-en-marcha-hoy.md) (Supabase, login con Google, claves, Netlify). Avisale a Claude y lo hacen juntos.

---

## 1 · Supabase: agregar la copia a la base (3 min)

- [ ] En VS Code abrí `demo/supabase/migrations/0008_espejo_hoja.sql` → `Ctrl+A` → `Ctrl+C`.
- [ ] supabase.com → tu proyecto → **SQL Editor** → **New query** → `Ctrl+V` → **Run**.
- [ ] Tiene que decir **Success. No rows returned**.
  - Si dice `already exists`: ya estaba aplicada, seguí.
  - Si dice otra cosa: captura.

## 2 · Netlify: solo revisar (2 min)

La versión nueva se publica sola cuando Claude haga el commit y el push (al terminar el paso 2 de construcción).

- [ ] Netlify → el sitio → **Site configuration → Environment variables**. Tienen que estar así:

| Variable | Valor |
|---|---|
| `INGESTA_TOKEN` | cargado (cualquier valor largo; lo vas a necesitar en el paso 4) |
| `XUBIO_FACTURAS_ENVIO_REAL` | `false` |
| `XUBIO_ENVIO_REAL` | `false` |
| `XUBIO_PAGO_EN_FACTURA` | `false` |

- [ ] Copiá el valor de `INGESTA_TOKEN` en un lugar a mano (lo pegás en el paso 4). Si no existe, generá uno en PowerShell y cargalo en Netlify:
  ```powershell
  -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
  ```

## 3 · Darle permiso a Claude para crear el puente (1 min)

- [ ] En la terminal de VS Code:
  ```powershell
  clasp login
  ```
  Se abre el navegador: elegí **tecnologia@verticebi.com** → Permitir.
- [ ] Avisale a Claude "listo el clasp". Claude crea el proyecto **"Puente sistema nuevo"** (aparte, no toca producción ni el de Santi), sube el código y te pasa el link.

## 4 · Configurar el puente (3 min)

En el link que te pasa Claude:

- [ ] ⚙️ **Configuración del proyecto** → abajo de todo, **Propiedades del script** → **Agregar propiedad**, dos veces:

| Propiedad | Valor |
|---|---|
| `SISTEMA_URL` | `https://verticetesoreria.netlify.app` |
| `INGESTA_TOKEN` | el mismo valor que en Netlify |

- [ ] Guardar.

## 5 · Probar y encender (5 min)

En el editor del puente, arriba, elegí la función y tocá **Ejecutar**:

- [ ] `probarPuente`. La primera vez pide permisos: **Revisar permisos** → tecnologia@ → **Configuración avanzada → Ir a Puente sistema nuevo** → Permitir. Son tres: *ver hojas de cálculo* (solo ver), *conectarse a un servicio externo* y *ejecutar cuando no estás*. No manda nada: en el **Registro de ejecución** muestra cuántas filas copiaría.
- [ ] `espejarHojaReal`. La primera vez tarda uno o dos minutos. **Copiá todo el registro y pasáselo a Claude**: ahí se ve si alguna fila real quedó afuera.
- [ ] `crearActivadorPuente`. Desde ahí copia solo, cada 10 minutos.

## 6 · Ver que funciona (1 min)

- [ ] Entrá a la app (F5). Abajo a la izquierda tiene que decir **"Copia de la hoja real: hace N min"** en verde.
- [ ] En **Aprobación**, **Pagos** y **Contabilización** tienen que aparecer las mismas facturas y pagos que en el dashboard de producción.

---

### Si algo sale mal

| Qué ves | Qué es |
|---|---|
| `El sistema respondió 401` | `INGESTA_TOKEN` distinto en Netlify y en el puente |
| `El sistema respondió 404` | `SISTEMA_URL` mal escrita, o Netlify todavía no tiene la versión nueva |
| `El sistema respondió 422 … espejar_facturas does not exist` | Falta el paso 1 (Supabase) |
| La app dice "Sin copia de la hoja real todavía" | No corrió `espejarHojaReal`, o falló: mirar el registro |
| Querés apagarlo | Ejecutar `borrarActivadorPuente` |

Nada de esto escribe en la hoja real: el puente tiene permiso de Google de **solo lectura**.
