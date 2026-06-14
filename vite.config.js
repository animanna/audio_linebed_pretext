import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Allow Tailscale Funnel/Serve hostnames (leading dot = match all subdomains)
    allowedHosts: ['.ts.net']
  }
})
