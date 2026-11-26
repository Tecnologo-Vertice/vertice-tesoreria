-- Tanda A1 · Separación entre empresas en el servidor y control que falla cerrado.
--
--   1. El control de escritura por empresa (0010 y 0011) solo actuaba si el rol de la conexión se
--      llamaba exactamente 'authenticated': con cualquier otro valor dejaba pasar todo sin avisar.
--      Desde acá es al revés: se saltea solo para el servidor conocido y controla a todos los demás.
--   2. Un documento subido por una persona guarda para qué empresas se puede cargar. La factura que
--      salga de leerlo tiene que ser de una de esas; si no, no se guarda.
--   3. Funciones para que el servidor limite lo que hace en nombre de una persona a sus empresas.

-- ---------------------------------------------------------------- 1. Control que falla cerrado

-- ¿La conexión es del servidor? Verdadero solo en dos casos:
--   · rol 'service_role': las funciones de Netlify (ingesta, copia de la hoja, Xubio), que entran por la
--     API con la clave de servicio;
--   · postgres o supabase_admin, entrando directo (sin "set role") o con ese rol puesto a mano: el editor
--     SQL de Supabase y las migraciones. Quien puede tomar esos roles ya administra la base.
-- Todo lo demás (authenticated, anon, un rol nuevo, un nombre que cambie) se trata como una persona y
-- pasa por el control de empresa. El setting 'role' y session_user no cambian dentro de una función
-- SECURITY DEFINER, así que dicen quién abrió la conexión y no quién es el dueño de la función.
create or replace function es_servidor()
returns boolean language sql stable set search_path = public as $$
  select case coalesce(current_setting('role', true), '')
    when 'service_role' then true
    when 'postgres' then true
    when 'supabase_admin' then true
    when 'none' then session_user in ('postgres', 'supabase_admin')
    else false
  end
$$;

create or replace function aislar_por_empresa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if es_servidor() then return coalesce(new, old); end if;
  if tg_op in ('UPDATE', 'DELETE') and not puede_ver_empresa(old.empresa_id) then
    raise exception 'No tenés acceso a la empresa %', old.empresa_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and not puede_ver_empresa(new.empresa_id) then
    raise exception 'No tenés acceso a la empresa %', new.empresa_id;
  end if;
  return coalesce(new, old);
end $$;

create or replace function aislar_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_empresa text;
begin
  if es_servidor() then return coalesce(new, old); end if;
  if ve_todas_las_empresas() then return coalesce(new, old); end if;
  select empresa_id into v_empresa from facturas where id = coalesce(old.factura_id, new.factura_id);
  if v_empresa is null or not puede_ver_empresa(v_empresa) then
    raise exception 'No tenés acceso a este documento';
  end if;
  return coalesce(new, old);
end $$;

create or replace function exigir_empresa(p_empresa text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not es_servidor() and not puede_ver_empresa(p_empresa) then
    raise exception 'No tenés acceso a la empresa %', p_empresa;
  end if;
end $$;

-- ---------------------------------------------------------------- 2. Para qué empresas es un documento

-- null  = lo trajo el servidor (Gmail, Drive): puede ser de cualquier empresa.
-- lista = lo subió una persona: las empresas que eligió o, si no eligió, las que ve.
alter table documentos add column empresas_permitidas text[];

create or replace function registrar_documento(p jsonb)
returns table (id uuid, nuevo boolean) language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into documentos (origen, gmail_message_id, nombre_archivo, mime_type, storage_path, tamano, remitente, asunto, cargado_por,
                          empresas_permitidas)
  values (p ->> 'origen', nullif(p ->> 'gmail_message_id', ''), p ->> 'nombre_archivo', p ->> 'mime_type', p ->> 'storage_path',
          (p ->> 'tamano')::int, p ->> 'remitente', p ->> 'asunto', p ->> 'cargado_por',
          case when jsonb_typeof(p -> 'empresas_permitidas') = 'array'
               then array(select jsonb_array_elements_text(p -> 'empresas_permitidas')) end)
  on conflict (gmail_message_id, nombre_archivo) do nothing
  returning documentos.id into v_id;
  if v_id is not null then return query select v_id, true; return; end if;
  return query select d.id, false from documentos d
    where d.gmail_message_id = nullif(p ->> 'gmail_message_id', '') and d.nombre_archivo = p ->> 'nombre_archivo';
end $$;

-- La factura que sale de un documento tiene que ser de una empresa permitida para ese documento.
-- Va como trigger para cubrir cualquier camino que cree la factura (hoy, guardar_factura_leida), y corre
-- antes de mirar si ya existía: quien no puede cargarla tampoco se entera de que estaba cargada.
create or replace function factura_respeta_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_permitidas text[];
begin
  if new.documento_id is null then return new; end if;
  select empresas_permitidas into v_permitidas from documentos where id = new.documento_id;
  if v_permitidas is not null and not (new.empresa_id = any(v_permitidas)) then
    raise exception 'La factura es de la empresa % y quien subió el archivo no tiene acceso a esa empresa', new.empresa_id;
  end if;
  return new;
end $$;
create trigger trg_factura_respeta_documento before insert on facturas
  for each row execute function factura_respeta_documento();

-- ---------------------------------------------------------------- 3. Límites para el servidor

-- Empresas activas que ve una persona. El servidor la usa para limitar lo que hace en su nombre.
create or replace function empresas_visibles_de(p_email text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(e.id order by e.id), '{}')
  from empresas e where e.activa and usuario_ve_empresa(p_email, e.id)
$$;

-- Igual que tomar_documentos, pero solo los documentos subidos para empresas de la lista. Es lo que
-- lee "leer ahora" cuando lo pide alguien que no ve todas las empresas: nunca los de Gmail o Drive
-- (sin lista) ni los subidos para una empresa que esa persona no ve.
create or replace function tomar_documentos_de_empresas(p_max integer, p_empresas text[])
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id in (
    select id from documentos
    where (estado = 'PENDIENTE' or (estado = 'LEYENDO' and tomado_en < now() - interval '5 minutes'))
      and intentos < 3
      and empresas_permitidas is not null and empresas_permitidas <@ coalesce(p_empresas, '{}')
    order by recibido_en
    limit p_max
    for update skip locked
  )
  returning *
$$;

-- ---------------------------------------------------------------- Permisos

revoke execute on function es_servidor(), factura_respeta_documento(), empresas_visibles_de(text),
  tomar_documentos_de_empresas(integer, text[]) from public, anon, authenticated;
grant execute on function es_servidor(), empresas_visibles_de(text), tomar_documentos_de_empresas(integer, text[]) to service_role;
