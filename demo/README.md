# Vértice · Tesorería · app

Circuito facturas → aprobación → pago con IA → contabilización → flujo → auditoría. La misma app corre en dos modos:

| Modo | Datos | Login | Cómo se activa |
|---|---|---|---|
| **Demo** | Ficticios, en memoria y `localStorage` | Selector "Entrar como" | Sin variables de entorno (default) |
| **Conectado** | PostgreSQL en Supabase | Google, solo cuentas habilitadas | `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` |

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck app + funciones, y dist/ para Netlify
npm run preview    # sirve dist/ en http://localhost:4173
npm run typecheck  # solo tipos
npm run test:sql   # corre las migraciones en un Postgres local (PGlite) y prueba pagos, reingesta y seguridad
```

Para que otros en la misma red abran la demo: `npm run dev -- --host` y pasarles la dirección `Network:`.

Para el modo conectado en local: copiar `.env.example` a `.env`, completar, y usar `netlify dev` (sirve la app y las funciones juntas) en vez de `npm run dev`.

## Estructura

| Carpeta | Qué hay |
|---|---|
| `src/types.ts` | Modelo de dominio. Espejo del esquema SQL. |
| `src/data/fuente.ts` | Contrato de datos. `fuenteDemo.ts` lo implementa en memoria; `fuenteSupabase.ts` contra la base real. |
| `src/data/demo.ts` | Datos ficticios: empresas del grupo con nombre real, proveedores, CUIT e importes inventados. |
| `src/lib/ia.ts` | Reglas de sugerencia de cuenta y forma de carga (corren en el navegador en ambos modos) y la IA simulada de la demo. |
| `src/store.tsx` | Estado y acciones; delega en la fuente activa y recarga después de cada acción. |
| `src/screens/` | Una pantalla por bandeja. |
| `supabase/migrations/` | SQL: esquema, seguridad (RLS y login por lista), funciones de negocio, semilla. |
| `netlify/functions/` | `ia-leer-comprobante` (Gemini), `contabilizar` (Xubio, en seco o real), `ingesta-factura` (recibe del Apps Script). |
| `gas/EnviarAlSistema.gs` | Para pegar en el Apps Script: manda cada factura leída a la base nueva. |

## Qué está simulado en modo demo

- La IA devuelve JSON precargado para tres comprobantes de ejemplo.
- "Contabilizar en Xubio" devuelve un id inventado.
- El mail al proveedor solo se registra en la auditoría.
- Los saldos bancarios son fijos.

## Qué falta en modo conectado

Ver `../docs/07-puesta-en-produccion.md`, sección "Lo que todavía no está".
