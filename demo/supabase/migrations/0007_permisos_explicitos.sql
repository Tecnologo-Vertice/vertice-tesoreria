-- Permisos explícitos. El proyecto se crea con "Automatically expose new tables" DESMARCADO
-- (recomendación de Supabase): nada queda accesible por la API salvo lo que se habilita acá.
--   anon (sin sesión): nada.
--   authenticated (personas con Google): leer tablas (el RLS filtra) y ejecutar las acciones de negocio.
--   service_role (funciones de Netlify): todo.

grant usage on schema public to authenticated, service_role;

-- Lectura para personas. Cada tabla tiene RLS: solo ven datos los usuarios habilitados.
grant select on empresas, usuarios, proveedores, cuentas_contables, cuentas_origen, facturas, pagos,
  pagos_facturas, reglas_cuenta, movimientos_bancarios, xubio_log, auditoria, documentos,
  proveedores_empresa, export_cashflow
  to authenticated;

-- Las funciones de Netlify (rol de servicio) leen y escriben todo.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- usuario_actual() la evalúa el RLS con la sesión de la persona.
grant execute on function usuario_actual() to authenticated;

-- Acciones de negocio que la app llama con la sesión de la persona (cada una valida el rol adentro).
grant execute on function
  aprobar_factura(uuid, text, metodo_pago, integer),
  rechazar_factura(uuid, text),
  corregir_factura(uuid),
  registrar_pago(jsonb),
  marcar_ralpharma(uuid),
  reintentar_documento(uuid),
  descartar_documento(uuid, text),
  marcar_factura_ralpharma(uuid),
  liberar_factura_xubio(uuid, text)
  to authenticated;

-- Todo lo demás (ingesta, cola de lectura, subida a Xubio, auditoría) queda solo para el servidor.
revoke execute on function
  registrar_auditoria(usuarios, text, text, text, text),
  marcar_pago_contabilizado(uuid, text, forma_carga_xubio, text, text, rol),
  marcar_pago_revisado(uuid, text, forma_carga_xubio, text, text, rol),
  ingresar_factura(jsonb),
  registrar_documento(jsonb),
  tomar_documentos(integer),
  tomar_documento(uuid),
  documento_fallo(uuid, text, boolean),
  guardar_factura_leida(uuid, jsonb),
  documento_sin_factura(uuid, text, jsonb),
  reservar_factura_xubio(uuid),
  resultado_factura_xubio(uuid, estado_xubio, text, text, text, boolean),
  facturas_para_xubio(integer)
  from public, anon, authenticated;
