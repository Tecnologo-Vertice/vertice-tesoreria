-- Tanda C1 · Credenciales de Xubio en la base, cifradas, una fila por empresa.
--
-- Hasta acá las credenciales de Xubio de todas las empresas vivían en una variable de Netlify
-- (XUBIO_CREDS_JSON). Cambiar una obligaba a redesplegar y un cliente nuevo no podía cargar la suya.
-- Desde esta migración pueden vivir acá, cifradas por el servidor antes de guardarlas:
--
--   · El cifrado lo hace la función de Netlify (lib/cifrado.ts, AES-256-GCM) con una clave que vive solo
--     en una variable del servidor (CREDENCIALES_CLAVE). La base nunca ve la credencial en claro ni la clave.
--   · El servidor usa la fila de la empresa si existe; si no, la variable de siempre. Las empresas de hoy
--     siguen andando el día del cambio y se pasan a la base de a una.
--   · Ninguna persona la lee, ni siquiera un administrador: sin permisos para anon ni authenticated y con
--     RLS sin reglas. Solo el servidor (service_role) la lee y la escribe.
--   · El alta la hace el servidor (POST /api/xubio/credenciales): prueba la credencial pidiendo un token a
--     Xubio y recién entonces la cifra y la guarda. La credencial nunca vuelve al navegador ni se escribe
--     en la auditoría ni en xubio_log.

create table conexiones_erp (
  empresa_id      text not null references empresas on delete cascade,
  erp             text not null check (erp in ('XUBIO')),
  -- v1:<huella de la clave>:<iv>:<etiqueta>:<datos>. Solo se acepta ese formato: nunca un texto en claro.
  secreto_cifrado text not null check (secreto_cifrado ~ '^v1:[0-9a-f]{8}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'),
  -- Los últimos 4 caracteres del identificador, para saber cuál está cargada sin descifrar nada.
  pista           text not null default '' check (length(pista) <= 4),
  verificado_en   timestamptz,
  cargado_por     text not null,
  cargado_en      timestamptz not null default now(),
  primary key (empresa_id, erp)
);

alter table conexiones_erp enable row level security;   -- sin reglas: ninguna sesión de persona lee una fila
revoke all on conexiones_erp from public, anon, authenticated;
grant select, insert, update, delete on conexiones_erp to service_role;
