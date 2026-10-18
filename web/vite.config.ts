import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The built app is served by the API Worker as static assets (wrangler.jsonc `assets`), so in production the UI
 * and /v1 share an origin and the session cookie is first-party. In development the same holds through the
 * proxy: MAILYARD_API (default: a local `wrangler dev`) answers /v1, /mcp and the public routes.
 */
const api = process.env.MAILYARD_API ?? "http://localhost:8787"
const proxied = ["/v1", "/mcp", "/openapi.json"]

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true, routesDirectory: "src/routes" }),
    react(),
  ],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      proxied.map((p) => [p, { target: api, changeOrigin: true, ws: p === "/v1", cookieDomainRewrite: "" }]),
    ),
  },
  // No source maps in dist: every file there is uploaded as a public asset and base64-encoded into the Flareyard
  // release bundle (capped at 50 MB). The source is open, and `vite build --sourcemap` makes them for debugging.
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
})
