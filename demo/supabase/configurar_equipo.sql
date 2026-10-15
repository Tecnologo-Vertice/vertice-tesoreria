-- ============================================================================
-- CONFIGURAR EL EQUIPO · correr DESPUÉS de instalar_todo.sql, en el SQL Editor de Supabase.
-- Reemplazar todo lo que dice COMPLETAR. Se puede correr de nuevo sin duplicar nada.
-- ============================================================================

-- 1) Personas que pueden entrar, con su rol. Si un mail no está acá, Google no deja entrar.
--    Roles: ADMIN (todo) · ADMINISTRACION (aprueba, contabiliza en Xubio, confirma Ralpharma)
--           TESORERIA (carga pagos) · APROBADOR (solo aprueba facturas) · DIRECCION (ve todo, no modifica)
insert into usuarios (email, nombre, rol) values
  ('tecnologia@verticebi.com',     'Brian',   'ADMIN'),
  ('COMPLETAR-mail-de-felipe@verticebi.com',  'Felipe',  'ADMIN'),            -- dirección, con todos los permisos
  ('COMPLETAR-mail-de-mariela@verticebi.com', 'Mariela', 'ADMINISTRACION'),   -- contabilidad
  ('tesoreria@verticebi.com',      'Vivi',    'TESORERIA'),
  ('administracion@verticebi.com', 'Guido',   'ADMINISTRACION')
on conflict (email) do update set nombre = excluded.nombre, rol = excluded.rol, activo = true;

-- 2) CUIT reales de las empresas (11 dígitos, sin guiones). Sirven para que la IA reconozca la
--    empresa receptora de cada factura y nunca tome su CUIT como el del proveedor.
update empresas set cuit = 'COMPLETAR' where id = 'beratung';      -- Beratung S.A.
update empresas set cuit = 'COMPLETAR' where id = 'india';         -- INDIA ADV S.A.
update empresas set cuit = 'COMPLETAR' where id = 'controlb';      -- Control B
update empresas set cuit = 'COMPLETAR' where id = 'ysd';           -- YSD Pharma S.A.
update empresas set cuit = 'COMPLETAR' where id = 'vertice';       -- Vértice BI S.A.
update empresas set cuit = 'COMPLETAR' where id = 'robles';        -- Droguería Robles S.A.
update empresas set cuit = 'COMPLETAR' where id = 'hrobles';       -- Héctor Daniel Robles
update empresas set cuit = 'COMPLETAR' where id = 'farmacontrol';  -- Farma Control S.A.

-- 3) Cuentas de origen (bancos, cajas, cheques diferidos) con el NOMBRE EXACTO de Xubio.
--    Sin esto, Vivi no puede elegir desde dónde pagó. Agregar una línea por cuenta.
insert into cuentas_origen (empresa_id, nombre) values
  ('beratung', 'COMPLETAR nombre exacto en Xubio, ej.: Banco Galicia CC $')
  -- ,('india', 'Cheque Diferido BRUBANK')
on conflict (empresa_id, nombre) do nothing;

-- Verificación: tiene que mostrar los mails reales activos y ningún CUIT 'COMPLETAR'.
select 'usuario' as que, email as detalle, rol::text as extra from usuarios where activo
union all select 'empresa', nombre, cuit from empresas
union all select 'cuenta origen', empresa_id, nombre from cuentas_origen;
