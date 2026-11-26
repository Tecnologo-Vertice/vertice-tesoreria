-- Tanda A2 · Convivencia con la hoja: quién gestiona cada fila (corrige reglas de 0008).
--
-- Regla de 0008: la hoja manda sobre una factura o un pago (gestion = 'HOJA') hasta que alguien lo
-- aprueba, paga o contabiliza en el sistema nuevo (gestion = 'SISTEMA'); desde ahí la copia no lo pisa.
-- Tres casos en que la regla no se cumplía:
--   1. Bajar el saldo de una nota de crédito no contaba como decisión del sistema: la copia podía
--      devolverle el saldo entero.
--   2. La copia borraba la marca "Preparado en Gmail" que deja el sistema nuevo en una factura de la hoja.
--   3. Una prueba en seco de contabilización pasaba el pago a 'SISTEMA' aunque no se hubiera
--      contabilizado nada: desde ahí la copia dejaba de actualizarlo y quedaba distinto de la hoja.

-- ---------------------------------------------------------------- 1 y 2. Facturas

create or replace function facturas_gestion_sistema()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('vertice.espejo', true), '') = 'si' then
    -- La copia trae la marca de mail de la hoja, pero no borra la que ya hay: preparar un mail no cambia
    -- quién gestiona la factura (la hoja la sigue actualizando), así que la marca se cuida acá.
    if new.mail_enviado is null and old.mail_enviado is not null then new.mail_enviado := old.mail_enviado; end if;
    return new;
  end if;
  if new.estado is distinct from old.estado or new.pagado is distinct from old.pagado
     or new.cuenta_contable is distinct from old.cuenta_contable or new.metodo_pago is distinct from old.metodo_pago
     or new.saldo_nc is distinct from old.saldo_nc then
    new.gestion := 'SISTEMA';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- 3. Pagos: la prueba en seco no cambia de dueño

-- Deja el pago REVISADO con la cuenta y la forma probadas, pero sin cambiar quién lo gestiona: si venía
-- de la hoja, la hoja lo sigue actualizando (por ejemplo, cuando se contabilice de verdad en producción).
-- La contabilización real (marcar_pago_contabilizado) sí lo pasa a 'SISTEMA', por el cambio de estado.
create or replace function marcar_pago_revisado(p_id uuid, p_cuenta text, p_forma forma_carga_xubio, p_detalle text, p_usuario text, p_rol rol)
returns void language plpgsql security definer set search_path = public as $$
declare v_gestion text;
begin
  select gestion into v_gestion from pagos where id = p_id and estado in ('CARGADO', 'REVISADO') for update;
  if not found then raise exception 'El pago no está pendiente de contabilizar'; end if;
  update pagos set estado = 'REVISADO', cuenta_contable = p_cuenta, forma_carga_xubio = p_forma where id = p_id;
  update pagos set gestion = v_gestion where id = p_id and gestion is distinct from v_gestion;
  insert into auditoria (usuario, rol, accion, entidad, entidad_id, detalle)
  values (p_usuario, p_rol, 'REVISADO_EN_SECO', 'PAGO', p_id::text, p_detalle);
end $$;
