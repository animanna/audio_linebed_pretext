import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Bind all interfaces so Tailscale Funnel/Serve can proxy in
    host: true,
    // Allow Tailscale Funnel/Serve hostnames (leading dot = match all subdomains)
    allowedHosts: ['.ts.net', '0.0.0.0'],
    // HMR websocket goes back through Funnel's public HTTPS (port 443)
    hmr: {
      protocol: 'wss',
      host: 'sophium.discus-liberty.ts.net',
      clientPort: 443
    }
  },
  preview: {
    host: true,
    port: 5173,
    allowedHosts: ['.ts.net']
  }
})
