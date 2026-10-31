import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dev = process.argv.includes('--dev');

if (!existsSync(join(root, 'resources', 'helper', 'InsomniaZHelper.exe'))) {
  console.warn('[build] helper binary missing; run npm run build:helper');
}

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
};

await build({
  ...common,
  entryPoints: [join(root, 'electron', 'main.ts')],
  outfile: join(root, 'dist', 'main', 'main.cjs'),
});

await build({
  ...common,
  entryPoints: [join(root, 'electron', 'preload.ts')],
  outfile: join(root, 'dist', 'main', 'preload.cjs'),
});

console.log('[build] main and preload built');
