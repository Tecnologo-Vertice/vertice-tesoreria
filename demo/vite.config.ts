import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Node resuelve "localhost" a ::1 (IPv6) y el reenvío de puertos de VS Code entra por 127.0.0.1.
  // allowedHosts: Vite bloquea hosts desconocidos; *.devtunnels.ms es el "Forward a Port" de VS Code.
  server: { host: '127.0.0.1', allowedHosts: ['.devtunnels.ms'] },
  preview: { host: '127.0.0.1', allowedHosts: ['.devtunnels.ms'] },
})
