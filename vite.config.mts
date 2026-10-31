import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The production CSP in index.html is strict (no inline scripts). Vite's dev
 * server injects the React Refresh preamble as an inline script, so dev needs
 * `'unsafe-inline'`; this transform only applies while serving and never
 * touches the built index.html.
 */
function devCsp(): Plugin {
  const devPolicy =
    "default-src 'self'; script-src 'self' 'unsafe-inline' http://127.0.0.1:5173; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173; object-src 'none'; base-uri 'none'; form-action 'none'";
  return {
    name: 'insomniaz-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
        `<meta http-equiv="Content-Security-Policy" content="${devPolicy}" />`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), devCsp()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
