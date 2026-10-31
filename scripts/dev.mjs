import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

console.log('[dev] compiling helper…');
const helper = spawnSync('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  join(root, 'scripts', 'build-helper.ps1'),
], { stdio: 'inherit' });
if (helper.status !== 0) {
  process.exit(helper.status ?? 1);
}

const server = await createServer({ configFile: join(root, 'vite.config.mts') });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') {
  throw new Error('Vite did not expose a local address');
}
const url = `http://127.0.0.1:${address.port}/`;

console.log(`[dev] renderer at ${url}`);
console.log('[dev] building main process…');
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-main.mjs'), '--dev'], {
  stdio: 'inherit',
});
if (build.status !== 0) {
  await server.close();
  process.exit(build.status ?? 1);
}

const electronBinary = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronBinary, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: url,
    NODE_ENV: 'development',
  },
});

const shutdown = async () => {
  if (!child.killed) child.kill();
  await server.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
