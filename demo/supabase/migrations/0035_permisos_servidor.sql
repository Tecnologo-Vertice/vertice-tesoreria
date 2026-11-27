-- Permisos del servidor sobre las funciones de Tesorería (26/11).
--
-- Desde 0021, en la base real las funciones nuevas que crea postgres no dan EXECUTE a service_role por defecto
-- (las pruebas con PGlite sí lo dan, por eso no se veía). Quedaban sin permiso funciones que el servidor llama por
-- la API (envío de asientos bancarios a Xubio: tomar_bloqueo, soltar_bloqueo, resultado_asiento_xubio) y la que
-- usa la carga desde planillas (regla_para_movimiento). service_role es el servidor: ya pasa por encima de RLS.
-- A anon y authenticated no se les da nada nuevo.

grant execute on function
  tomar_bloqueo(text, text, integer),
  soltar_bloqueo(text, text),
  resultado_asiento_xubio(uuid, boolean, text, text),
  regla_para_movimiento(uuid, text, numeric),
  acreedor_para(uuid, uuid, text),
  cuenta_de_pago(text, text, text, text),
  linea_proyectada_de(text, uuid),
  crear_filas_base(uuid),
  exigir_empresa(text),
  fila_especial(uuid, text)
to service_role;
