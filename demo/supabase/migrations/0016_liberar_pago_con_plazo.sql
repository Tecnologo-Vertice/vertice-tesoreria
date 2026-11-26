-- Corrección de la tanda A3 (revisión del agente 06, problemas 1 y 4) · reemplaza la función de 0015.
--
--   1. liberar_pago_xubio trataba igual un envío cortado y uno que todavía está saliendo: cualquier pago
--      reservado y sin contabilizar se podía liberar al instante. Liberar un envío en curso y volver a
--      contabilizar creaba dos órdenes de pago en Xubio. Desde acá, ninguna de las dos salidas ("ya está
--      en Xubio" y "no está, liberar") se acepta hasta que la reserva tenga más que el plazo de abajo.
--   2. El número de Xubio que se carga a mano no se validaba: aceptaba RALPHARMA (la pantalla lo mostraba
--      como "Cargado en Ralpharma"), CARGADO_A_MANO o cualquier texto.

-- ---------------------------------------------------------------- El plazo, en un solo lugar

-- Cuánto tiene que pasar desde la reserva para dar un envío por cortado. La base y la pantalla lo leen de acá.
-- Por qué 5 minutos: con los topes por defecto (8 s por llamada a Xubio), contabilizar puede tardar unos
-- 37 s en el peor caso medido (lecturas lentas y envío colgado), y Xubio puede terminar de crear el
-- comprobante después de que la función cortó. 5 minutos es 8 veces ese peor caso y es el mismo criterio
-- que ya usa la cola de documentos para dar por caído a un lector (0005). Si se suben los topes
-- (XUBIO_TIMEOUT_MS) por encima de unos 30 s por llamada, hay que subir también este plazo.
create or replace function plazo_envio_xubio()
returns interval language sql immutable as $$ select interval '5 minutes' $$;

-- El mismo plazo en segundos, para la pantalla (que no ofrece las salidas hasta que pase).
create or replace function plazo_envio_xubio_segundos()
returns integer language sql immutable as $$ select extract(epoch from plazo_envio_xubio())::integer $$;

-- ---------------------------------------------------------------- Liberar, con plazo y número validado

create or replace function liberar_pago_xubio(p_id uuid, p_xubio_id text, p_cuenta text, p_forma forma_carga_xubio)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; p pagos; v_id text; v_cuenta text; v_falta interval;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  select * into p from pagos where id = p_id for update;
  if p.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.envio_xubio_en is null or p.estado::text not in ('CARGADO', 'REVISADO') then
    raise exception 'El pago no tiene un envío a Xubio trabado';
  end if;
  -- Vale para las dos salidas: mientras el envío pueda estar en curso, tampoco sirve mirar Xubio.
  v_falta := p.envio_xubio_en + plazo_envio_xubio() - now();
  if v_falta > interval '0' then
    raise exception 'El envío a Xubio de este pago todavía puede estar en curso (salió hace % s). Esperá % min % s y volvé a mirar: si para entonces no quedó contabilizado, buscalo en Xubio y resolvelo acá.',
      greatest(0, floor(extract(epoch from now() - p.envio_xubio_en)))::int,
      ceil(extract(epoch from v_falta))::int / 60, ceil(extract(epoch from v_falta))::int % 60;
  end if;

  v_id := trim(coalesce(p_xubio_id, ''));
  if v_id <> '' then
    -- Solo números de comprobante: letras, dígitos, guiones, puntos y barras, con al menos un dígito.
    -- Deja afuera las marcas internas (RALPHARMA, CARGADO_A_MANO, EN-SECO) y los textos libres.
    if upper(v_id) in ('RALPHARMA', 'CARGADO_A_MANO', 'EN-SECO') or length(v_id) > 40
       or v_id !~ '^[A-Za-z0-9][A-Za-z0-9./-]*$' or v_id !~ '[0-9]' then
      raise exception 'El número de Xubio "%" no es válido. Cargá el número del comprobante como figura en Xubio (por ejemplo OP-1234 o X-0001-00000483).', v_id;
    end if;
    -- Solo dígitos: se guarda como los envíos automáticos (OP-1234).
    if v_id ~ '^[0-9]+$' then v_id := 'OP-' || v_id; end if;
    v_cuenta := coalesce(nullif(trim(coalesce(p_cuenta, '')), ''), p.cuenta_contable);
    if coalesce(v_cuenta, '') = '' then raise exception 'Falta la cuenta contable (regla de oro)'; end if;
    update pagos set estado = 'CONTABILIZADO', xubio_id = v_id, cuenta_contable = v_cuenta,
      forma_carga_xubio = coalesce(p_forma, forma_carga_xubio), contabilizado_por = u.nombre, contabilizado_en = now(),
      detalle_contabilizacion = 'Envío sin confirmar, resuelto a mano: ya estaba en Xubio como ' || v_id
    where id = p_id;
    perform registrar_auditoria(u, 'XUBIO_PAGO_LIBERADO', 'PAGO', p_id::text,
      'Envío sin confirmar: ya estaba en Xubio como ' || v_id || ' · ' || v_cuenta || '. Queda contabilizado sin enviar nada');
    return 'CONTABILIZADO';
  end if;

  update pagos set envio_xubio_en = null,
    detalle_contabilizacion = 'Envío a Xubio sin confirmar, liberado por ' || u.nombre || ': no estaba en Xubio'
  where id = p_id;
  perform registrar_auditoria(u, 'XUBIO_PAGO_LIBERADO', 'PAGO', p_id::text,
    'Envío sin confirmar: no estaba en Xubio. Liberado para volver a enviar o anular');
  return 'LIBERADO';
end $$;

-- ---------------------------------------------------------------- Permisos

revoke execute on function plazo_envio_xubio(), plazo_envio_xubio_segundos() from public, anon;
grant execute on function plazo_envio_xubio(), plazo_envio_xubio_segundos() to authenticated, service_role;
