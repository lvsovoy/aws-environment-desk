import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [command, ...args] = process.argv.slice(2);

// Ensure frontend assets and icons are prepared before running cargo or tauri cli
if (!existsSync(join(root, 'dist-tauri', 'index.html')) || !existsSync(join(root, 'dist', 'icons', 'tray.png'))) {
  const result = spawnSync(process.execPath, [join(root, 'desktop', 'build-tauri.js')], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
}
const cache = process.platform === 'win32'
  ? process.env.LOCALAPPDATA
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : join(homedir(), '.cache');
if (!cache) throw new Error('LOCALAPPDATA is required for a local, non-OneDrive build cache.');
const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(cache, 'STPEnvironmentDesk', 'build') };
if (command === 'smoke') {
  mkdirSync(join(root, 'test-results'), { recursive: true });
  env.DESK_SMOKE_REPORT = join(root, 'test-results', 'tauri-smoke.json');
}
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const cargo = command === 'test' || command === 'check' || command === 'smoke';
const child = cargo
  ? spawn('cargo', [
    command === 'smoke' ? 'run' : command,
    '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'),
    ...args,
    ...(command === 'smoke' ? ['--', '--smoke-test'] : []),
  ], { cwd: root, env, stdio: 'inherit' })
  : spawn(process.execPath, [cli, command, ...(command === 'dev' ? [
    '--port', '1430', '--additional-watch-folders', join(root, 'config'), '--config', JSON.stringify({
      app: { security: {
        devCsp: "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost ws://127.0.0.1:1430; base-uri 'none'; frame-src 'none'; object-src 'none'; form-action 'none'",
        capabilities: [{
          identifier: 'main-dev',
          windows: ['main'],
          local: true,
          remote: { urls: ['http://127.0.0.1:1430/*'] },
          permissions: ['core:default'],
        }],
      } },
    }),
  ] : []), ...args], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(`Cannot start native tooling: ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
