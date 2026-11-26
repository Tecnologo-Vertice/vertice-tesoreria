-- Tanda A3 · Salida para un pago que quedó a medio enviar a Xubio.
--
-- contabilizar reserva el pago (envio_xubio_en) antes de enviarlo a Xubio, para no crear dos órdenes
-- de pago. Si el envío se corta sin respuesta (Xubio no contesta, o Netlify corta la función), no se
-- sabe si Xubio lo creó: la reserva queda puesta, que es lo correcto, pero no había forma de sacarla.
-- Existía para facturas (liberar_factura_xubio, 0006) y no para pagos: solo se arreglaba con SQL a mano.

-- Administración, después de mirar en Xubio, resuelve el pago trabado de una de dos formas:
--   · p_xubio_id con valor → el comprobante SÍ está en Xubio: el pago queda CONTABILIZADO con ese número,
--     sin enviar nada. Necesita la cuenta contable (la del pago o la que llegue en p_cuenta).
--   · p_xubio_id vacío     → NO está en Xubio: se saca la reserva y el pago se puede volver a enviar o anular.
-- Devuelve 'CONTABILIZADO' o 'LIBERADO'.
create or replace function liberar_pago_xubio(p_id uuid, p_xubio_id text, p_cuenta text, p_forma forma_carga_xubio)
returns text language plpgsql security definer set search_path = public as $$
declare u usuarios; p pagos; v_id text; v_cuenta text;
begin
  u := exigir_rol('ADMINISTRACION', 'ADMIN');
  select * into p from pagos where id = p_id for update;
  if p.id is null then raise exception 'Pago inexistente'; end if;
  perform exigir_empresa(p.empresa_id);
  if p.envio_xubio_en is null or p.estado::text not in ('CARGADO', 'REVISADO') then
    raise exception 'El pago no tiene un envío a Xubio trabado';
  end if;

  v_id := trim(coalesce(p_xubio_id, ''));
  if v_id <> '' then
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

revoke execute on function liberar_pago_xubio(uuid, text, text, forma_carga_xubio) from public, anon;
grant execute on function liberar_pago_xubio(uuid, text, text, forma_carga_xubio) to authenticated, service_role;
