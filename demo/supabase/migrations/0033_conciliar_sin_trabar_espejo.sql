-- Revisión de la integración de Tesorería (26/11): la conciliación automática no puede trabar ni volver lenta
-- la copia de la hoja.
--
-- 0030 agregó disparadores por sentencia sobre pagos, cobros, cheques y movimientos que llaman a
-- conciliar_movimientos (y desde 0032, a conciliar_lotes). La copia de la hoja (espejar_pagos) escribe pago por
-- pago, así que cada fila disparaba la conciliación completa de la empresa; y si la conciliación fallaba, se caía
-- también la copia de los pagos.
--
-- Ahora:
--   · Lo que escribe el servidor por la API (rol service_role: copia de la hoja, marcas del Cash Flow, envíos a
--     Xubio, cobros) no concilia fila por fila. El servidor concilia una vez al terminar: la copia de la hoja al
--     final de cada lote de pagos (netlify/functions/espejo.mts) e importar_extracto al final del archivo (0031).
--   · Lo que hace una persona desde la app (marcar un cheque debitado, cargar un pago) sigue conciliando al momento.
--   · Si la conciliación falla, queda un aviso y el cambio que la disparó se guarda igual.

create or replace function conciliar_tras_cambio()
returns trigger language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if pg_trigger_depth() > 1 then return null; end if;
  -- importar_extracto concilia una sola vez cuando termina de cargar el archivo.
  if current_setting('tesoreria.conciliar_al_final', true) = '1' then return null; end if;
  -- El servidor por la API concilia al final de su lote (copia de la hoja, importación de extractos).
  if coalesce(current_setting('role', true), '') = 'service_role' then return null; end if;
  for e in select distinct empresa_id from nuevos loop
    begin
      perform conciliar_movimientos(e);
    exception when others then
      raise warning 'No se pudo conciliar %: %', e, sqlerrm;
    end;
  end loop;
  return null;
end $$;
revoke execute on function conciliar_tras_cambio() from public, anon, authenticated;
