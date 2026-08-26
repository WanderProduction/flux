import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Locks the packaged renderer down to its own bundle. It is build-only because
 * Vite's dev server injects an inline HMR preamble that `script-src 'self'`
 * would kill, taking hot reload with it.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'"

const injectCspOnBuild = (): Plugin => ({
  name: 'flux-inject-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<title>',
      `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <title>`,
    ),
})

export default defineConfig({
  plugins: [react(), injectCspOnBuild()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Electron loads the production build over file:// — relative paths are required.
  base: './',
  server: {
    // Pinned to IPv4 on purpose. Left as the default "localhost", Vite binds
    // ::1 on Windows while Electron resolves 127.0.0.1, and the app window
    // opens to ERR_CONNECTION_REFUSED against a dev server that is clearly up.
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
