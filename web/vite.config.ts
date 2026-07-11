import { defineConfig } from "vite";

const apiTarget = process.env.SINAPSO_API_URL ?? "http://127.0.0.1:5175";
const apiUrl = new URL(apiTarget);

/**
 * Vite configuration for Sinapso frontend.
 *
 * Development:
 *   - Serves on port 5173 (Vite default)
 *   - Proxies /api requests to http://localhost:5175 (Express server)
 *   - Fast refresh on file change
 *
 * Production:
 *   - Bundles to ./dist/ (served by Express or Electron)
 *   - Chunk size warnings set to 1500 KB (web visualization is inherently large)
 */
export default defineConfig({
  server: {
    // Vite dev server port
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      // Proxy API requests to the Express backend (running on different port).
      // Use 127.0.0.1, not "localhost": the server binds IPv4 only, and
      // "localhost" prefers IPv6 (::1) on macOS — a stray IPv6 listener on
      // this port would then hijack the proxy and hang requests.
      // ws:true so the voice relay's WebSocket (/api/voice/ws) is proxied too;
      // scoped to /api, so Vite's own HMR socket is untouched.
      "/api": {
        target: apiTarget,
        ws: true,
        changeOrigin: true,
        // Keep server-side localOnly checks happy when the UI is served from a
        // remote LAN/Tailscale host and /api calls are proxied through Vite.
        headers: {
          host: apiUrl.host,
          origin: apiUrl.origin,
        },
      },
    },
  },
  build: {
    // Output directory for production builds
    outDir: "dist",
    // Visualization libraries (THREE.js, 3d-force-graph, etc.) are large;
    // warn only if chunk exceeds 1500 KB (default 500 KB would spam)
    chunkSizeWarningLimit: 1500,
  },
});
