# proyecto_futuro · Vértice Tesorería fuera de Apps Script

Carpeta del sistema nuevo. Acá vive todo lo que reemplaza, por etapas, al Apps Script de producción. Nada de esta carpeta toca Xubio, Gmail, Drive ni la hoja de Santi.

## Qué hay

| Carpeta / archivo | Qué es |
|---|---|
| [demo/](demo/) | La app (Vite + React + TypeScript + Tailwind). Corre en **modo demo** con datos ficticios, o en **modo conectado** con base real. Incluye `supabase/` (SQL), `netlify/functions/` (IA, Xubio, ingesta) y `gas/` (puente del Apps Script). |
| [docs/01-decision-stack.md](docs/01-decision-stack.md) | Stack elegido y por qué. Qué se descartó. |
| [docs/02-modelo-datos.md](docs/02-modelo-datos.md) | Esquema SQL de la base nueva (PostgreSQL). Es el mismo modelo que usa la demo en memoria. |
| [docs/03-guion-demo.md](docs/03-guion-demo.md) | Guion de 8 minutos para la presentación y checklist previa. |
| [docs/04-roadmap.md](docs/04-roadmap.md) | Fases, entregables y criterios de aceptación después de la demo. |
| [docs/05-pedido-de-santi-vs-resuelto.md](docs/05-pedido-de-santi-vs-resuelto.md) | El mensaje de Santi frase por frase, con qué se resolvió y qué falta. |
| [docs/06-sistema-explicado-para-el-equipo.md](docs/06-sistema-explicado-para-el-equipo.md) | Para Santi, Vivi, Guido y dirección: qué es, de qué está hecho, cuánto cuesta, dónde se publica y cómo se pone en marcha. |
| [docs/07-puesta-en-produccion.md](docs/07-puesta-en-produccion.md) | Pasos para crear las cuentas (Supabase, Google Cloud, Netlify, Xubio) y encender el modo conectado. Qué falta. |
| [docs/08-flujo-de-trabajo-y-preguntas.md](docs/08-flujo-de-trabajo-y-preguntas.md) | El circuito real según Guido, lo que permite la API de Xubio y las preguntas abiertas. |
| [docs/09-prueba-con-el-equipo.md](docs/09-prueba-con-el-equipo.md) | Preparación de la prueba con Vivi y Guido: copia del Apps Script y app nueva (demo o conectada). Correcciones del 13/10. |
| [docs/10-flujo-1-entrada-de-facturas.md](docs/10-flujo-1-entrada-de-facturas.md) | Flujo 1 en el sistema nuevo: mail → IA → Aprobación. Equivalencias con el Apps Script, mejoras y cómo probarlo. |
| [docs/11-puesta-en-marcha-hoy.md](docs/11-puesta-en-marcha-hoy.md) | **Empezar acá.** Qué hace el sistema hoy, los pasos para encenderlo (cuentas, claves, mails) y lo que falta. |
| `apps_script_copia/` | Copia del código de la copia de desarrollo del Apps Script, para leer. **Tiene claves: no se commitea** (está en `.gitignore`). |

## Correr la demo

```bash
cd demo
npm install
npm run dev        # http://localhost:5173
npm run build      # genera dist/ para publicar
npm run preview    # sirve dist/ en http://localhost:4173
```

## Publicar en Netlify (cuenta de la empresa)

Opción A, desde la terminal:

```bash
npm install -g netlify-cli
cd demo
netlify login
netlify init          # crear sitio nuevo, build "npm run build", publish "dist"
netlify deploy --prod
```

Opción B, sin instalar nada: `npm run build` y arrastrar la carpeta `demo/dist` en https://app.netlify.com/drop.

El archivo `demo/netlify.toml` ya trae el comando de build, el redirect para la SPA y el header `noindex`.

## Reglas de esta carpeta

- Solo datos ficticios. Si algún día entra un PDF o CUIT real, va a `.gitignore` y no se commitea.
- Ninguna clave en el código. Cuando haya backend, las claves van a variables de entorno de Netlify o a Supabase Vault.
- Lo que se decide con Santi se anota en `docs/` como decisión fechada, no en el chat.
