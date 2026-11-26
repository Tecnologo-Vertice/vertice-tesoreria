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

-- Cada alta, reemplazo o baja deja un renglón en la auditoría: quién, cuándo, la empresa y la pista.
-- Nunca el dato cifrado ni la credencial. También si se hace a mano desde el editor SQL.
create or replace function auditar_conexion_erp()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fila conexiones_erp; v_accion text; v_usuario text;
begin
  if tg_op = 'DELETE' then v_fila := old; else v_fila := new; end if;
  -- Una actualización que no cambia la credencial (por ejemplo, volver a cifrarla con la clave nueva) no se anota.
  if tg_op = 'UPDATE' and new.pista is not distinct from old.pista and new.cargado_en is not distinct from old.cargado_en
     and new.cargado_por is not distinct from old.cargado_por then
    return new;
  end if;
  v_accion := case tg_op when 'INSERT' then 'CREDENCIAL_ERP_CARGADA' when 'UPDATE' then 'CREDENCIAL_ERP_REEMPLAZADA' else 'CREDENCIAL_ERP_BORRADA' end;
  v_usuario := case when tg_op = 'DELETE' then coalesce(nullif(auth.jwt() ->> 'email', ''), session_user::text) else v_fila.cargado_por end;
  insert into auditoria (usuario, accion, entidad, entidad_id, empresa_id, detalle)
  values (v_usuario, v_accion, 'EMPRESA', v_fila.empresa_id, v_fila.empresa_id,
          'Credencial de ' || v_fila.erp || ' (pista ' || coalesce(nullif(v_fila.pista, ''), 'sin pista') || ')');
  return null;
end $$;
create trigger trg_auditar_conexion_erp after insert or update or delete on conexiones_erp for each row execute function auditar_conexion_erp();
revoke execute on function auditar_conexion_erp() from public, anon, authenticated;
