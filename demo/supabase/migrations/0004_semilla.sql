-- Datos iniciales. Las empresas son reales; los usuarios son un EJEMPLO que hay que editar
-- con los mails reales antes de que alguien intente entrar. Las cuentas contables y de origen
-- se cargan después desde Xubio (función cargar_plan_cuentas, pendiente) o a mano.

insert into empresas (id, nombre, nombre_corto, cuit, erp) values
  ('beratung',     'Beratung S.A.',          'Beratung',      '00000000000', 'XUBIO'),
  ('india',        'INDIA ADV S.A.',         'India',         '00000000001', 'XUBIO'),
  ('controlb',     'Control B',              'Control B',     '00000000002', 'XUBIO'),
  ('ysd',          'YSD Pharma S.A.',        'YSD',           '00000000003', 'XUBIO'),
  ('vertice',      'Vértice BI S.A.',        'Vértice',       '00000000004', 'XUBIO'),
  ('robles',       'Droguería Robles S.A.',  'Drog. Robles',  '00000000005', 'RALPHARMA'),
  ('hrobles',      'Héctor Daniel Robles',   'H. Robles',     '00000000006', 'RALPHARMA'),
  ('farmacontrol', 'Farma Control S.A.',     'Farma Control', '00000000007', 'RALPHARMA')
on conflict (id) do nothing;
-- TODO: reemplazar los CUIT de arriba por los reales (están como marcador para no inventar).

-- Usuarios: EDITAR con los mails reales. Si el mail no está acá, Google no deja entrar.
insert into usuarios (email, nombre, rol) values
  ('tecnologia@verticebi.com', 'Tecnología', 'ADMIN'),
  ('tesoreria@verticebi.com',  'Vivi',       'TESORERIA'),
  ('administracion@verticebi.com', 'Guido',  'ADMINISTRACION')
on conflict (email) do nothing;

-- Plan de cuentas de resultado común (tomado del export de Xubio del 06/10/2026). Cada empresa
-- puede tener cuentas propias con empresa_id; estas valen para todas.
insert into cuentas_contables (empresa_id, nombre) values
  (null, 'COSTO DE INSUMOS'),
  (null, 'COSTO DE PRESTACIONES MEDICAS CONSULTORIO'),
  (null, 'HONORARIOS PROFESIONALES'),
  (null, 'HONORARIOS EXTERNOS CONTABLES'),
  (null, 'HONORARIOS EXTERNOS LEGALES'),
  (null, 'HONORARIOS EXTERNOS TECNICOS'),
  (null, 'ALQUILER DE OFICINA'),
  (null, 'GASTOS VARIOS OFICINA'),
  (null, 'GASTOS GENERALES'),
  (null, 'GASTOS BANCARIOS'),
  (null, 'IMPUESTO DEB/CRED BANCARIO'),
  (null, 'IMPUESTOS Y TASAS'),
  (null, 'INSUMOS INFORMÁTICOS'),
  (null, 'SOFTWARE DE GESTION'),
  (null, 'SEGUROS'),
  (null, 'MOVILIDAD Y VIATICOS'),
  (null, 'PROMOCIÓN Y PUBLICIDAD'),
  (null, 'SERVICIO DE TERCEROS'),
  (null, 'GASTOS DE FLETES'),
  (null, 'SERVICIOS DE SEGURIDAD'),
  (null, 'INTERESES PAGADOS'),
  (null, 'SUELDOS Y JORNALES')
on conflict do nothing;
