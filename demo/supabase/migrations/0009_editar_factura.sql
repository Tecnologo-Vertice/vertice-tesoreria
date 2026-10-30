-- Edición a mano de lo que leyó la IA (como el formulario de la tarjeta en el dashboard de producción).
-- Se puede editar mientras la factura no tiene pagos ni está en Xubio. Al guardar se vuelve a validar
-- igual que validarFactura_ de producción: si queda bien sale de Excepciones; si no, el motivo queda a la vista.
-- La edición pasa la factura a gestion = 'SISTEMA': la copia de la hoja ya no la pisa.

create or replace function editar_factura(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u usuarios; f facturas; n facturas; v_cuit text; v_prov uuid; v_tipo text; v_cae text;
  v_neto numeric; v_iva numeric; v_exento numeric; v_perc numeric; v_total numeric; v_dif numeric;
  v_motivo text; v_estado estado_factura; v_cambios text;
begin
  u := exigir_rol('APROBADOR', 'ADMIN', 'ADMINISTRACION');
  select * into f from facturas where id = p_id for update;
  if f.id is null then raise exception 'Factura inexistente'; end if;
  if f.estado not in ('PENDIENTE_APROBACION', 'ERROR', 'PARA_PAGAR') or f.pagado > 0 then
    raise exception 'Solo se editan facturas sin pagos (pendientes, en excepciones o para pagar)';
  end if;
  if f.estado_xubio = 'SUBIDA' then
    raise exception 'La factura ya está en Xubio: corregila en Xubio y volvé a traerla';
  end if;

  v_cuit := regexp_replace(coalesce(p ->> 'cuit_proveedor', ''), '\D', '', 'g');
  if length(v_cuit) <> 11 then raise exception 'El CUIT del proveedor tiene que tener 11 dígitos'; end if;
  if not exists (select 1 from empresas where id = p ->> 'empresa_id') then raise exception 'Elegí la empresa que recibe la factura'; end if;
  if coalesce((p ->> 'numero')::int, 0) <= 0 then raise exception 'Falta el número del comprobante'; end if;
  if (p ->> 'fecha') is null then raise exception 'Falta la fecha de emisión'; end if;

  insert into proveedores (cuit, nombre) values (v_cuit, coalesce(nullif(trim(p ->> 'proveedor'), ''), 'Sin nombre'))
  on conflict (cuit) do update set nombre = coalesce(nullif(trim(excluded.nombre), ''), proveedores.nombre)
  returning id into v_prov;

  -- Validación de producción (validarFactura_): tipo, CAE de 14 dígitos y que cierre el total (±1 peso).
  v_tipo := nullif(trim(p ->> 'tipo'), '');
  v_cae := regexp_replace(coalesce(p ->> 'cae', ''), '\D', '', 'g');
  v_neto := coalesce((p ->> 'neto')::numeric, 0);
  v_iva := coalesce((p ->> 'iva')::numeric, 0);
  v_exento := coalesce((p ->> 'exento')::numeric, 0);
  select coalesce(sum((x ->> 'importe')::numeric), 0) into v_perc from jsonb_array_elements(coalesce(p -> 'percepciones_json', '[]'::jsonb)) x;
  v_total := coalesce((p ->> 'total')::numeric, 0);
  v_dif := round(v_total - (v_neto + v_iva + v_exento + v_perc), 2);
  v_motivo := case
    when v_tipo is null or v_tipo = 'Sin tipo' then 'Comprobante sin tipo válido'
    when v_total <= 0 then 'El total tiene que ser mayor a cero'
    when length(v_cae) <> 14 then 'El CAE tiene que tener 14 dígitos (tiene ' || length(v_cae) || ')'
    when abs(v_dif) >= 1 then 'Descuadre de $' || abs(v_dif) || ' entre el total y neto + IVA + exento + percepciones'
  end;
  v_estado := case
    when f.estado = 'PARA_PAGAR' then 'PARA_PAGAR'
    when v_motivo is null then 'PENDIENTE_APROBACION'
    else 'ERROR'
  end;

  begin
    update facturas set
      empresa_id = p ->> 'empresa_id', proveedor_id = v_prov, tipo = coalesce(v_tipo, 'Sin tipo'),
      letra = nullif(upper(left(trim(coalesce(p ->> 'letra', '')), 1)), ''),
      punto_venta = coalesce((p ->> 'punto_venta')::int, 0), numero = (p ->> 'numero')::int,
      fecha = (p ->> 'fecha')::date, vencimiento = coalesce(nullif(p ->> 'vencimiento', '')::date, (p ->> 'fecha')::date),
      moneda = coalesce(nullif(p ->> 'moneda', ''), 'ARS'), cotizacion = coalesce(nullif(p ->> 'cotizacion', '')::numeric, 1),
      neto = v_neto, iva = v_iva, exento = v_exento, percepciones = v_perc,
      percepciones_json = coalesce(p -> 'percepciones_json', '[]'::jsonb), total = v_total,
      cae = nullif(v_cae, ''), cae_vencimiento = nullif(p ->> 'cae_vencimiento', '')::date,
      categoria_vertice = coalesce(nullif(p ->> 'categoria_vertice', ''), categoria_vertice),
      cuenta_contable = coalesce(nullif(p ->> 'cuenta_contable', ''), cuenta_contable),
      codigo_producto = coalesce(nullif(p ->> 'codigo_producto', ''), codigo_producto),
      validacion_ok = v_motivo is null, motivo_validacion = v_motivo, estado = v_estado,
      gestion = 'SISTEMA', actualizado_en = now()
    where id = p_id
    returning * into n;
  exception when unique_violation then
    raise exception 'Ya hay otra factura de ese proveedor con el mismo tipo y número en esa empresa';
  end;

  -- Qué cambió, para la auditoría.
  select string_agg(o.key, ', ' order by o.key) into v_cambios
  from jsonb_each(to_jsonb(f)) o join jsonb_each(to_jsonb(n)) x using (key)
  where o.value is distinct from x.value and o.key not in ('actualizado_en', 'gestion', 'validacion_ok', 'motivo_validacion', 'estado', 'percepciones');
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle, antes, despues)
  values (u.nombre, u.rol, 'EDICION', 'FACTURA', p_id::text,
          'Datos corregidos a mano: ' || coalesce(v_cambios, 'sin cambios') || case when v_motivo is null then '' else ' · queda en excepciones: ' || v_motivo end,
          to_jsonb(f), to_jsonb(n));
  return jsonb_build_object('estado', v_estado, 'motivo', v_motivo, 'cambios', v_cambios);
end $$;

revoke execute on function editar_factura(uuid, jsonb) from public, anon;
grant execute on function editar_factura(uuid, jsonb) to authenticated, service_role;
