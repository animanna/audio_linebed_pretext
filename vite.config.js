import { defineConfig } from 'vite'
import { handleApi } from './bridge/now-playing-core.mjs'

// Mount the bridge's /api/now-playing + /api/audio onto Vite's own dev and
// preview servers, so system metadata + system-audio capture work on the SAME
// port as the app (5173 dev / 4173 preview) with no separate `npm run bridge`.
function nowPlayingApi() {
  const mw = (server) => {
    server.middlewares.use((req, res, next) => {
      if (!req.url.startsWith('/api/')) return next()
      const url = new URL(req.url, `http://localhost`)
      handleApi(req, res, url).then((handled) => {
        if (!handled) next()
      }).catch(next)
    })
  }
  return {
    name: 'now-playing-api',
    configureServer: mw,
    configurePreviewServer: mw
  }
}

export default defineConfig({
  plugins: [nowPlayingApi()],
  server: {
    // Bind all interfaces so Tailscale Funnel/Serve can proxy in
    host: true,
    // Pin the dev port. strictPort = fail loudly if taken instead of
    // silently hopping to 5174, 5175, … (that port churn was the confusion).
    port: 5173,
    strictPort: true,
    // Allow Tailscale Funnel/Serve hostnames (leading dot = match all subdomains)
    allowedHosts: ['.ts.net']
  },
  preview: {
    host: true,
    // Distinct fixed port so preview never collides with the dev server.
    port: 4173,
    strictPort: true,
    allowedHosts: ['.ts.net']
  }
})
