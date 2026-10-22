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
  "img-src 'self' data: blob: flux-asset:; media-src 'self' blob: flux-asset:; " +
  "connect-src 'self' flux-asset:"

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
    /*
     * Overridable, because only one checkout can hold this port and FLUX is
     * developed in worktrees. electron/main.js reads the same variable and
     * explains at length what goes wrong without it — the short version is that
     * a harness in one worktree will happily verify another worktree's code.
     */
    port: Number(process.env.FLUX_DEV_PORT) || 5273,
    strictPort: true,
    watch: {
      /*
       * The watcher must not follow the build output.
       *
       * `release/` is where electron-builder extracts a ~400MB Electron and
       * then *renames* the directory into place. Chokidar walking into that
       * extract holds handles on it, and the rename then fails with EPERM —
       * so a dev server left running in one terminal makes `npm run dist` in
       * another fail, with an error that points at the packager and says
       * nothing about the real cause. Vite ignores node_modules and dist by
       * default; this one it does not know about.
       */
      ignored: ['**/release/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
