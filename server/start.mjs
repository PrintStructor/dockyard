import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printerMiddleware, closeLiveFeed } from './printer.mjs'
import { serverHost, serverPort } from './config.mjs'
import { getActivePrinter, getEffectiveAllowedOrigins, isLanOriginAllowed } from './settings.mjs'

const distRoot = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)))

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
}

export function resolveStaticPath(urlPath, rootDir = distRoot) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const clean = decoded.replace(/^\/+/, '')
  const candidate = path.resolve(rootDir, clean || 'index.html')
  if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) return null
  return candidate
}

async function serveFile(res, filePath, isHead) {
  const ext = path.extname(filePath).toLowerCase()
  const contentType = mimeTypes[ext] ?? 'application/octet-stream'
  const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`)
  const cacheControl =
    ext === '.html'
      ? 'no-store'
      : isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600'

  const body = await readFile(filePath)
  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', body.byteLength)
  res.setHeader('Cache-Control', cacheControl)
  res.end(isHead ? undefined : body)
}

export function createProductionServer({ rootDir = distRoot } = {}) {
  const server = http.createServer((req, res) => {
    printerMiddleware(req, res, async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Method Not Allowed')
        return
      }

      const isHead = req.method === 'HEAD'
      const pathname = new URL(req.url, 'http://localhost').pathname
      const resolved = resolveStaticPath(pathname, rootDir)
      if (!resolved) {
        res.statusCode = 400
        res.end('Bad Request')
        return
      }

      try {
        const info = await stat(resolved)
        if (info.isFile()) {
          await serveFile(res, resolved, isHead)
          return
        }
      } catch {
        // Fall through to SPA index fallback for extension-less routes.
      }

      if (!path.extname(pathname)) {
        try {
          await serveFile(res, path.join(rootDir, 'index.html'), isHead)
          return
        } catch {
          res.statusCode = 503
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Build missing. Run `npm run build` first.')
          return
        }
      }

      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Not Found')
    })
  })

  // Disable Node's 5-minute default requestTimeout so SSE streams stay open indefinitely.
  server.requestTimeout = 0
  return server
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntrypoint) {
  const server = createProductionServer()
  const shutdown = () => {
    closeLiveFeed()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  server.listen(serverPort, serverHost, () => {
    const active = getActivePrinter()
    const effectiveOrigins = getEffectiveAllowedOrigins()
    const displayHost = serverHost.includes(':') && !serverHost.startsWith('[') ? `[${serverHost}]` : serverHost
    const nameSuffix = active.name ? ` (${active.name})` : ''
    console.log(`DOCKYARD${nameSuffix} listening on http://${displayHost}:${serverPort}/`)
    console.log(`Printer origin: ${active.url}`)
    if (effectiveOrigins.length) console.log(`Trusted origins: ${effectiveOrigins.join(', ')}`)
    if (isLanOriginAllowed()) console.log('LAN Meet mode: enabled (private LAN / .local same-origin writes allowed)')
  })
}
