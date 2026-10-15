# Decisión de stack · 12/10/2026

**Estado:** propuesta. Se valida con Santi después de la demo.

## Resumen

| Capa | Elección | Alternativa descartada |
|---|---|---|
| Lenguaje | TypeScript en todo | Python como principal (no está instalado; sirve solo como satélite para extractos) |
| Frontend | Vite + React + Tailwind, SPA | Next.js (más piezas de las necesarias para un CRUD interno); HTML inline como el dashboard actual (no se puede mantener ni probar) |
| Hosting web | Netlify Free, cuenta de la empresa | Vercel Hobby (prohíbe uso comercial) |
| Base de datos | PostgreSQL en Supabase | Seguir en Sheets (sin transacciones, sin claves, filas como id); Neon (Postgres solo, habría que armar auth y storage aparte) |
| Auth | Supabase Auth con Google, restringido al dominio verticebi.com | Apps Script web app `DOMAIN` (sirve como parche de la semana 1, no como destino) |
| Backend | Netlify Functions en Node/TypeScript | Apps Script como API definitiva (6 min por ejecución, CORS a los golpes, sin tests locales) |
| Ingesta | Apps Script se queda para Gmail y Drive, y hace POST a la API nueva | Leer Gmail desde afuera (exige verificación de Google y CASA) |
| Sheets | Vista de exportación `Export_CashFlow` que el Cash Flow lee con IMPORTRANGE | Que el sistema escriba en la planilla de Santi |
| IA | Nivel pago de Gemini en el proyecto de la empresa, o Claude Haiku; se decide con 50 facturas reales | Nivel gratis de Gemini (los términos permiten revisión humana de los datos) |
| Xubio | Paquete propio con modo "en seco" obligatorio y log de cada envío | Escribir desde la SPA |

## Por qué Postgres y no seguir en Sheets

El dolor que nombró el usuario ("qué cargar y qué contabilizar") es un problema de modelo de datos. Hoy un pago vive entre filas de dos hojas, identificado por número de fila, sin vínculo N a N con facturas y sin saber quién hizo qué. Con Postgres:

- `NUMERIC(14,2)` para importes, nunca float.
- Clave natural única `(empresa_id, cuit_emisor, punto_venta, numero, tipo)`: anti-duplicados en la base, no en el código.
- Tabla `pagos_facturas` para pagos parciales, múltiples y notas de crédito.
- Tabla `auditoria` de solo inserción.
- Transacciones: o se registra el pago y se actualiza la factura, o no se hace nada.

## Por qué Supabase y no Neon

Para una persona sola, Supabase trae en un servicio lo que con Neon habría que armar en tres: Postgres, login con Google por dominio, storage para PDFs y seguridad por fila. El plan gratis tiene dos proyectos: uno "dev" y uno "prod". Eso evita Docker, que no está instalado.

Riesgo conocido: el plan gratis no tiene backups automáticos. Para producción se paga el plan Pro (USD 25/mes al 12/10/2026, confirmar en supabase.com/pricing). **Costo cero es para la demo, no para operar un sistema de tesorería.**

## Qué NO se hace ahora

- Multi-tenant SaaS para terceros. Se pone `empresa_id` en todas las tablas y nada más.
- Colas de trabajos (Trigger.dev, Inngest). Con 450 documentos por mes alcanza con funciones y `pg_cron`.
- Plantillas SaaS. Es un sistema interno con login de Google.
- Reemplazar Ralpharma. Solo se agrega el estado "Pendiente Ralpharma" con responsable.

## Entorno de desarrollo

| Herramienta | Estado en la máquina (12/10/2026) | Para qué |
|---|---|---|
| Node 24, npm 11, git | instalados | todo |
| VS Code + Claude Code | instalados | desarrollo |
| sqlite3 | instalado | no hace falta |
| Netlify CLI | falta (`npm i -g netlify-cli`) | deploy |
| Supabase CLI | falta (`npm i -g supabase`) | migraciones, fase 2 |
| clasp | falta (`npm i -g @google/clasp`) | bajar el Apps Script de producción a git, solo lectura |
| Docker, Python | faltan | no se necesitan en este plan |
