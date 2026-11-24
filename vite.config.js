import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { printerMiddleware, closeLiveFeed } from './server/printer.mjs'

function attachCockpit(server) {
  if (server.httpServer) server.httpServer.requestTimeout = 0
  server.middlewares.use(printerMiddleware)
  server.httpServer?.once('close', closeLiveFeed)
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'printer-cockpit',
      configureServer: attachCockpit,
      configurePreviewServer: attachCockpit,
    },
  ],
  build: { chunkSizeWarningLimit: 750 },
})
