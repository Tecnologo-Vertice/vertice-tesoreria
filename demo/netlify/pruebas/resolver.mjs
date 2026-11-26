// Las funciones de Netlify importan sus bibliotecas sin extensión ('./lib/comun'), que es como las
// empaqueta Netlify. Node necesita la extensión: este gancho la agrega solo para correr las pruebas.
// Uso: node --import ./netlify/pruebas/resolver.mjs netlify/pruebas/<archivo>.prueba.mts
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (e) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context)
      throw e
    }
  },
})
