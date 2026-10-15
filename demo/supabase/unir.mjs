// Une las migraciones en un solo archivo para pegar una vez en el SQL Editor de Supabase.
// Uso: npm run sql:unir  →  supabase/instalar_todo.sql
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
const dir = new URL('./migrations/', import.meta.url)
const partes = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
const cuerpo = partes.map((f) => `-- ======================================== ${f}\n${readFileSync(new URL(f, dir), 'utf8')}`).join('\n\n')
writeFileSync(new URL('./instalar_todo.sql', import.meta.url), `-- Vértice Tesorería · instalación completa (generado con npm run sql:unir, no editar a mano).\n-- Pegar entero en Supabase → SQL Editor → Run, UNA sola vez en un proyecto nuevo.\n-- Después: configurar_equipo.sql.\n\n${cuerpo}\n`)
console.log('supabase/instalar_todo.sql:', partes.join(', '))
