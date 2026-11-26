-- Tanda B4 · Los nombres de las empresas salen del código y pasan a ser datos.
--
-- Para saber de qué empresa es una factura cuando no trae CUIT del receptor (o al copiar la hoja, que
-- solo trae el nombre), el código buscaba textos escritos a mano: "beratung", "india", "drogueria" y
-- "robles"... Eso solo sirve para las empresas de Vértice, y con otra organización cargada podía asignar
-- la factura de un cliente a una empresa de otro. Desde acá esos textos son columnas de la empresa, y el
-- código compara contra las empresas de la organización del documento y ninguna más.
--
--   alias         Formas en que aparece el nombre de la empresa como RECEPTORA. Un alias puede tener
--                 varias partes unidas con "+": tienen que aparecer todas ("drogueria+robles").
--                 Se compara sin mayúsculas, tildes, espacios ni signos ("Control B" = "controlb").
--   alias_emisor  Lo mismo, pero para el EMISOR: una factura emitida por alguien que coincide se asigna
--                 a esta empresa aunque el receptor diga otra cosa (regla del Apps Script para Robles).
--   alias_orden   Si un texto coincide con más de una empresa, gana la de orden menor.
--
-- Una empresa sin alias se reconoce solo por su CUIT.

alter table empresas add column alias text[] not null default '{}';
alter table empresas add column alias_emisor text[] not null default '{}';
alter table empresas add column alias_orden integer not null default 100;

-- Las 8 empresas de Vértice, con los mismos textos y en el mismo orden en que los buscaba el código
-- (lib/factura.ts y lib/espejo.ts). "robles+daniel" viene de la copia de la hoja: la IA a veces corta
-- "ROBLES, DANIEL HECT".
update empresas e set alias = v.alias, alias_emisor = v.alias_emisor, alias_orden = v.orden
from (values
  ('beratung',     array['beratung'],                        array[]::text[],            10),
  ('india',        array['india'],                           array[]::text[],            20),
  ('controlb',     array['control b'],                       array[]::text[],            30),
  ('ysd',          array['ysd'],                             array[]::text[],            40),
  ('robles',       array['drogueria+robles'],                array['droguer+robles'],    50),
  ('hrobles',      array['robles+hector', 'robles+daniel'],  array['hector+robles'],     60),
  ('farmacontrol', array['farma control'],                   array[]::text[],            70),
  ('vertice',      array['vertice'],                         array[]::text[],            80)
) as v(id, alias, alias_emisor, orden)
where e.id = v.id and e.organizacion_id = (select id from organizaciones where slug = 'vertice');
