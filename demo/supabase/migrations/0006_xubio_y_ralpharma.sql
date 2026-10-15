-- Xubio automático para facturas (subida al aprobar) y sector Ralpharma para Guido.

alter table facturas add column xubio_error text;            -- por qué no se pudo subir (para corregir y reintentar)
alter table facturas add column xubio_envio_en timestamptz;  -- envío real en curso: evita subir dos veces
alter table facturas add column xubio_subida_en timestamptz;
alter table facturas add column ralpharma_por text;           -- quién confirmó la carga en Ralpharma
alter table facturas add column ralpharma_en timestamptz;

-- ---------------------------------------------------------------- Subida de facturas a Xubio (solo servidor)

-- Reserva la factura para un envío real. False si ya se está enviando o ya está subida.
create or replace function reservar_factura_xubio(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update facturas set xubio_envio_en = now()
  where id = p_id and estado_xubio in ('PENDIENTE', 'ERROR') and xubio_envio_en is null
    and estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA');
  return found;
end $$;

-- Resultado de la subida. p_estado: SUBIDA (con id) · ERROR (con motivo, se puede reintentar).
-- p_liberar: false cuando no se sabe si Xubio la creó (queda reservada para no duplicar).
create or replace function resultado_factura_xubio(p_id uuid, p_estado estado_xubio, p_xubio_id text, p_error text, p_usuario text, p_liberar boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_estado = 'SUBIDA' and coalesce(p_xubio_id, '') = '' then raise exception 'Una factura SUBIDA necesita el id de Xubio'; end if;
  update facturas set
    estado_xubio = p_estado,
    xubio_id = coalesce(nullif(p_xubio_id, ''), xubio_id),
    xubio_error = case when p_estado = 'SUBIDA' then null else p_error end,
    xubio_subida_en = case when p_estado = 'SUBIDA' then now() else xubio_subida_en end,
    xubio_envio_en = case when p_liberar or p_estado = 'SUBIDA' then null else xubio_envio_en end,
    actualizado_en = now()
  where id = p_id;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (coalesce(p_usuario, 'Sistema'), 'ADMIN',
          case when p_estado = 'SUBIDA' then 'XUBIO_FACTURA' else 'XUBIO_FACTURA_ERROR' end, 'FACTURA', p_id::text,
          case when p_estado = 'SUBIDA' then 'Subida a Xubio, id ' || p_xubio_id else p_error end);
end $$;

-- Facturas aprobadas de empresas con Xubio que todavía no se subieron (para el subidor programado).
create or replace function facturas_para_xubio(p_max integer)
returns setof facturas language sql security definer set search_path = public as $$
  select f.* from facturas f join empresas e on e.id = f.empresa_id
  where e.erp = 'XUBIO' and f.estado_xubio = 'PENDIENTE' and f.xubio_envio_en is null
    and f.estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA')
  order by f.aprobado_en nulls last
  limit p_max
$$;

revoke execute on function reservar_factura_xubio, resultado_factura_xubio, facturas_para_xubio from public, anon, authenticated;

-- Quien aprueba puede liberar una factura trabada (envío sin confirmar) después de revisar en Xubio.
create or replace function liberar_factura_xubio(p_id uuid, p_xubio_id text)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  update facturas set
    xubio_envio_en = null,
    estado_xubio = case when coalesce(p_xubio_id, '') <> '' then 'SUBIDA' else 'ERROR' end::estado_xubio,
    xubio_id = coalesce(nullif(p_xubio_id, ''), xubio_id),
    xubio_error = case when coalesce(p_xubio_id, '') <> '' then null else 'Liberada a mano para reintentar' end
  where id = p_id and xubio_envio_en is not null;
  if not found then raise exception 'La factura no tiene un envío a Xubio trabado'; end if;
  perform registrar_auditoria(u, 'XUBIO_LIBERADA', 'FACTURA', p_id::text,
    case when coalesce(p_xubio_id, '') <> '' then 'Ya estaba en Xubio con id ' || p_xubio_id else 'Liberada para reintentar' end);
end $$;

-- ---------------------------------------------------------------- Ralpharma (sector de Guido)

-- Confirma que una factura aprobada de una empresa sin Xubio ya se cargó en Ralpharma.
create or replace function marcar_factura_ralpharma(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u usuarios;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  update facturas set estado_xubio = 'CARGADA_RALPHARMA', ralpharma_por = u.nombre, ralpharma_en = now(), actualizado_en = now()
  where id = p_id and estado_xubio = 'PENDIENTE_RALPHARMA' and estado in ('PARA_PAGAR', 'PAGADA_PARCIAL', 'PAGADA');
  if not found then raise exception 'La factura no está aprobada y pendiente de Ralpharma'; end if;
  perform registrar_auditoria(u, 'FACTURA_RALPHARMA', 'FACTURA', p_id::text, 'Carga de la factura confirmada en Ralpharma');
end $$;
