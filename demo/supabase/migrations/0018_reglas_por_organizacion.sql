-- Tanda B2 · Organizaciones: reglas de acceso.
--
-- Hasta acá "ver todas las empresas" quería decir todas las de la base, y había tablas que veía cualquier
-- persona habilitada (proveedores, productos, estado de la copia, documentos sin leer, auditoría del
-- sistema). Con una segunda organización cargada, eso mostraba datos de un cliente a otro.
--
-- Desde acá:
--   · Una persona ve una empresa solo si es de su organización (y además tiene todas las de su
--     organización, o esa asignada). "Todas las empresas" pasa a ser "todas las de mi organización".
--     Con eso cambian solas las reglas y los controles de escritura que ya miraban la empresa.
--   · Las tablas con organización propia se ven solo dentro de esa organización.
--   · Una organización que no está ACTIVA no deja entrar a su gente.
--   · Las reglas por empresa se evalúan una vez por consulta (empresas_visibles) y no fila por fila.
-- Para Vértice, mientras sea la única organización, el resultado es el mismo de antes, con dos cambios
-- chicos que hoy no tocan a nadie (todo el equipo ve todas las empresas):
--   · quien no ve todas ahora ve (y puede reintentar o descartar) los archivos que se subieron para sus
--     empresas, aunque no hayan terminado en factura. Antes no los veía nadie más que quien ve todas;
--   · el registro de Xubio sin empresa ya no lo ve ninguna persona (no hay código que lo escriba así).

-- ---------------------------------------------------------------- Quién es la persona

-- Igual que en 0002, más: la organización de la persona tiene que estar activa.
create or replace function usuario_actual()
returns usuarios
language sql stable security definer set search_path = public as $$
  select u.* from usuarios u join organizaciones o on o.id = u.organizacion_id
  where u.email = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo and o.estado = 'ACTIVA'
$$;

create or replace function auth_solo_habilitados()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from usuarios u join organizaciones o on o.id = u.organizacion_id
                 where u.email = lower(new.email) and u.activo and o.estado = 'ACTIVA') then
    raise exception 'La cuenta % no está habilitada en Vértice Tesorería', new.email;
  end if;
  return new;
end $$;

-- La organización de la persona de la sesión. Null si no está habilitada.
create or replace function organizacion_actual()
returns uuid language sql stable security definer set search_path = public as $$
  select (usuario_actual()).organizacion_id
$$;

-- ---------------------------------------------------------------- Qué empresas ve

-- El corazón del cambio. Antes: "está activo y tiene todas las empresas, o tiene asignada esta".
-- Ahora: "está activo, su organización está activa, LA EMPRESA ES DE SU ORGANIZACIÓN, y tiene todas las
-- de su organización o tiene asignada esta". La usan el servidor (Netlify) y puede_ver_empresa.
create or replace function usuario_ve_empresa(p_email text, p_empresa text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select u.activo and o.estado = 'ACTIVA' and e.organizacion_id = u.organizacion_id
           and (u.todas_empresas or exists (
             select 1 from usuarios_empresas ue where ue.email = u.email and ue.empresa_id = e.id))
    from usuarios u
    join organizaciones o on o.id = u.organizacion_id
    join empresas e on e.id = p_empresa
    where u.email = lower(p_email)
  ), false)
$$;

-- "Ve todas las empresas" = todas las de su organización. Sola no alcanza para mostrar nada: las reglas
-- de abajo la combinan siempre con la organización del registro.
create or replace function ve_todas_las_empresas()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((usuario_actual()).todas_empresas, false)
$$;

-- Las empresas que ve la persona de la sesión, todas juntas. Las reglas la usan como
-- "empresa_id in (select empresas_visibles())", que se calcula una vez por consulta.
create or replace function empresas_visibles()
returns setof text
language sql stable security definer set search_path = public as $$
  select e.id
  from usuarios u
  join organizaciones o on o.id = u.organizacion_id and o.estado = 'ACTIVA'
  join empresas e on e.organizacion_id = u.organizacion_id
  where u.email = lower(coalesce(auth.jwt() ->> 'email', '')) and u.activo
    and (u.todas_empresas or exists (select 1 from usuarios_empresas ue where ue.email = u.email and ue.empresa_id = e.id))
$$;

-- ---------------------------------------------------------------- Lectura (RLS)

create policy leer_organizaciones on organizaciones for select to authenticated using (id = organizacion_actual());

drop policy leer_empresas on empresas;
create policy leer_empresas on empresas for select to authenticated using (id in (select empresas_visibles()));

-- Cada uno ve su propio usuario; quien ve todas las empresas de su organización ve al equipo de su organización.
drop policy leer_usuarios on usuarios;
create policy leer_usuarios on usuarios for select to authenticated
  using ((usuario_actual()).email is not null
         and (email = (usuario_actual()).email or (ve_todas_las_empresas() and organizacion_id = organizacion_actual())));

drop policy leer_usuarios_empresas on usuarios_empresas;
create policy leer_usuarios_empresas on usuarios_empresas for select to authenticated
  using ((usuario_actual()).email is not null
         and (email = (usuario_actual()).email or (ve_todas_las_empresas() and empresa_id in (select empresas_visibles()))));

-- Cuentas y reglas sin empresa: comunes de la organización (antes, de toda la base).
drop policy leer_cuentas_contables on cuentas_contables;
create policy leer_cuentas_contables on cuentas_contables for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));

drop policy leer_reglas on reglas_cuenta;
create policy leer_reglas on reglas_cuenta for select to authenticated
  using (organizacion_id = organizacion_actual() and (empresa_id is null or empresa_id in (select empresas_visibles())));

drop policy leer_cuentas_origen on cuentas_origen;
create policy leer_cuentas_origen on cuentas_origen for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_facturas on facturas;
create policy leer_facturas on facturas for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_pagos on pagos;
create policy leer_pagos on pagos for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_movimientos on movimientos_bancarios;
create policy leer_movimientos on movimientos_bancarios for select to authenticated using (empresa_id in (select empresas_visibles()));

drop policy leer_memoria on proveedores_empresa;
create policy leer_memoria on proveedores_empresa for select to authenticated using (empresa_id in (select empresas_visibles()));

-- pagos_facturas y notas_credito_aplicadas no cambian: miran facturas y pagos, que ya quedaron filtrados.

-- Registro de Xubio: siempre por empresa.
drop policy leer_xubio_log on xubio_log;
create policy leer_xubio_log on xubio_log for select to authenticated
  using ((usuario_actual()).rol in ('ADMIN', 'ADMINISTRACION') and empresa_id in (select empresas_visibles()));

-- Documentos: los de mi organización, y dentro de ella:
--   · todos, si veo todas las empresas de mi organización;
--   · los que terminaron en una factura que veo;
--   · los que se subieron para empresas que veo todas (lista de 0013). Los de Gmail o Drive no tienen
--     lista: pueden ser de cualquier empresa y los ve solo quien ve todas.
drop policy leer_documentos on documentos;
create policy leer_documentos on documentos for select to authenticated
  using (organizacion_id = organizacion_actual()
         and (ve_todas_las_empresas()
              or exists (select 1 from facturas f where f.id = factura_id)
              or (cardinality(empresas_permitidas) > 0 and empresas_permitidas <@ array(select empresas_visibles()))));

-- Auditoría: por la organización y la empresa que guarda el renglón (0017), sin comparar textos.
-- Lo que no tiene empresa (sistema, documentos sin factura), quien ve todas las de su organización.
drop policy leer_auditoria on auditoria;
create policy leer_auditoria on auditoria for select to authenticated
  using (organizacion_id = organizacion_actual()
         and (ve_todas_las_empresas() or empresa_id in (select empresas_visibles())));

-- Proveedores, productos de Xubio y estado de la copia: los de mi organización (antes, cualquier habilitado).
drop policy leer_proveedores on proveedores;
create policy leer_proveedores on proveedores for select to authenticated using (organizacion_id = organizacion_actual());

drop policy leer_productos_xubio on productos_xubio;
create policy leer_productos_xubio on productos_xubio for select to authenticated using (organizacion_id = organizacion_actual());

drop policy leer_espejo_estado on espejo_estado;
create policy leer_espejo_estado on espejo_estado for select to authenticated using (organizacion_id = organizacion_actual());

-- Los archivos (storage) se reescriben en la 0019.

-- ---------------------------------------------------------------- Escritura

-- aislar_por_empresa y exigir_empresa (0013) no cambian: preguntan puede_ver_empresa, que ya mira la organización.

-- Documentos (reintentar, descartar): la misma regla que para leerlos.
create or replace function aislar_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare d documentos; v_empresa text;
begin
  if es_servidor() then return coalesce(new, old); end if;
  d := coalesce(old, new);
  if d.organizacion_id is distinct from organizacion_actual() then
    raise exception 'No tenés acceso a este documento';
  end if;
  if ve_todas_las_empresas() then return coalesce(new, old); end if;
  select empresa_id into v_empresa from facturas where id = coalesce(old.factura_id, new.factura_id);
  if v_empresa is not null and puede_ver_empresa(v_empresa) then return coalesce(new, old); end if;
  if cardinality(d.empresas_permitidas) > 0 and d.empresas_permitidas <@ array(select empresas_visibles()) then
    return coalesce(new, old);
  end if;
  raise exception 'No tenés acceso a este documento';
end $$;

-- La factura que sale de un documento: de una empresa permitida para ese documento (0013) y, siempre,
-- de la organización del documento. Un adjunto de una organización nunca termina en una empresa de otra.
create or replace function factura_respeta_documento()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_permitidas text[]; v_org uuid;
begin
  if new.documento_id is null then return new; end if;
  select empresas_permitidas, organizacion_id into v_permitidas, v_org from documentos where id = new.documento_id;
  if v_org is distinct from organizacion_de_empresa(new.empresa_id) then
    raise exception 'La factura es de la empresa %, que es de otra organización que el archivo', new.empresa_id;
  end if;
  if v_permitidas is not null and not (new.empresa_id = any(v_permitidas)) then
    raise exception 'La factura es de la empresa % y quien subió el archivo no tiene acceso a esa empresa', new.empresa_id;
  end if;
  return new;
end $$;

-- Guardar el mail de un proveedor (0012): solo de un proveedor de mi organización. Antes alcanzaba con
-- conocer su identificador.
create or replace function guardar_email_proveedor(p_proveedor uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios; v text;
begin
  u := exigir_rol('TESORERIA', 'ADMINISTRACION', 'ADMIN');
  v := lower(trim(coalesce(p_email, '')));
  if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Mail inválido: %', p_email; end if;
  update proveedores set email = v where id = p_proveedor and organizacion_id = u.organizacion_id;
  if not found then raise exception 'Proveedor inexistente'; end if;
  perform registrar_auditoria(u, 'MAIL_PROVEEDOR_GUARDADO', 'SISTEMA', p_proveedor::text, v);
end $$;

-- ---------------------------------------------------------------- Cola de lectura, por organización

-- Igual que tomar_documentos (0005), pero solo los documentos de una organización. Es lo que usa "leer
-- ahora" cuando lo pide quien ve todas las empresas de la suya, para que no lea ni reciba el detalle de
-- documentos de otro cliente. La de un solo dato sigue igual y toma de toda la cola: la usa el lector
-- programado, que después lee cada documento con las empresas de su organización.
-- Lleva el mismo nombre con un dato más: sin organización (null) no toma nada.
create or replace function tomar_documentos(p_max integer, p_organizacion uuid)
returns setof documentos language sql security definer set search_path = public as $$
  update documentos set estado = 'LEYENDO', intentos = intentos + 1, tomado_en = now(), error = null
  where id in (
    select id from documentos
    where (estado = 'PENDIENTE' or (estado = 'LEYENDO' and tomado_en < now() - interval '5 minutes'))
      and intentos < 3
      and organizacion_id = p_organizacion
    order by recibido_en
    limit p_max
    for update skip locked
  )
  returning *
$$;

-- ---------------------------------------------------------------- Permisos

grant select on organizaciones to authenticated;
grant execute on function organizacion_actual(), empresas_visibles() to authenticated, service_role;
revoke execute on function organizacion_actual(), empresas_visibles() from public, anon;
revoke execute on function tomar_documentos(integer, uuid) from public, anon, authenticated;
grant execute on function tomar_documentos(integer, uuid) to service_role;
