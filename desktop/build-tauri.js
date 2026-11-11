import { build, context } from 'esbuild';
import { watch } from 'node:fs';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { loadConfig, resolveSvg } from './config.js';
import { buildIcons } from './icons.js';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cacheIcons } from './cache-icons.js';

await mkdir(new URL('../dist-tauri/', import.meta.url), { recursive: true });
let appConfig = await loadConfig();
await buildIcons(appConfig);
let iconPaths = {};

/** Refresh static assets and validate the JSON configuration embedded by the native backend. */
async function prepareAssets() {
  appConfig = await loadConfig();
  await buildIcons(appConfig);
  for (const file of ['index.html', 'styles.css', 'dashboard-icons-LICENSE.txt']) {
    await copyFile(new URL(`../public/${file}`, import.meta.url), new URL(`../dist-tauri/${file}`, import.meta.url));
  }
  const svg = await resolveSvg(appConfig);
  await writeFile(new URL('../dist-tauri/logo.svg', import.meta.url), svg);
  await writeFile(new URL('../dist-tauri/favicon.svg', import.meta.url), svg);
  await writeFile(new URL('../dist-tauri/config.json', import.meta.url), JSON.stringify(appConfig, null, 2) + '\n', 'utf8');

  const cacheRoot = process.platform === 'win32' ? process.env.LOCALAPPDATA : join(homedir(), 'Library', 'Caches');
  if (!cacheRoot) throw new Error('A local cache directory is required for Dashboard Icons.');
  const cacheName = (appConfig.productName || appConfig.name || 'EnvironmentDesk').replace(/[^a-zA-Z0-9]/g, '');
  iconPaths = await cacheIcons(appConfig.apps || [], join(cacheRoot, cacheName, 'dashboard-icons'),
    fileURLToPath(new URL('../dist-tauri/app-icons/', import.meta.url)));
  return appConfig.apps?.length || 0;
}

const watching = process.argv.includes('--watch');
const options = {
  entryPoints: [fileURLToPath(new URL('./tauri-entry.js', import.meta.url))],
  bundle: true,
  minify: !watching,
  sourcemap: watching ? 'inline' : false,
  outfile: fileURLToPath(new URL('../dist-tauri/app.js', import.meta.url)),
  platform: 'browser',
  target: ['es2022'],
  plugins: [
    {
      name: 'cached-icons',
      /** Resolve cached icon paths freshly for each frontend rebuild, including catalogue edits. */
      setup(plugin) {
        plugin.onResolve({ filter: /^stp:icons$/ }, () => ({ path: 'icons', namespace: 'stp' }));
        plugin.onLoad({ filter: /^icons$/, namespace: 'stp' }, () => ({
          contents: `export default ${JSON.stringify(iconPaths)};`, loader: 'js',
        }));
      },
    },
    {
      name: 'app-config',
      /** Resolve runtime application configuration for the frontend bundle. */
      setup(plugin) {
        plugin.onResolve({ filter: /^stp:config$/ }, () => ({ path: 'config', namespace: 'stp' }));
        plugin.onLoad({ filter: /^config$/, namespace: 'stp' }, () => ({
          contents: `export default ${JSON.stringify(appConfig)};`, loader: 'js',
        }));
      },
    },
  ],
};
if (watching) {
  const builder = await context({
    ...options,
    plugins: [...options.plugins, {
      name: 'static-assets',
      /** Copy assets before the bundle is emitted so Tauri reloads a complete frontend. */
      setup(plugin) {
        plugin.onStart(async () => {
          await prepareAssets();
        });
        plugin.onEnd(result => {
          if (!result.errors.length) console.log('Tauri UI rebuilt; the development window will reload.');
        });
      },
    }],
  });
  await builder.watch();
  let timer;
  // esbuild watches imported JS; static assets and the catalogue need explicit file notifications.
  const watchers = [
    watch(new URL('../public/', import.meta.url), (event, name) => {
      if (!name || !/\.(html|css|svg)$/.test(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void builder.rebuild().catch(error => console.error(`UI rebuild failed: ${error.message}`)); }, 150);
    }),
    watch(new URL('../config/', import.meta.url), (event, name) => {
      if (!name || !/\.json$/.test(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void builder.rebuild().catch(error => console.error(`Catalogue rebuild failed: ${error.message}`)); }, 150);
    }),
  ];
  /** Release file watchers and esbuild when the development process stops. */
  async function stop() {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await builder.dispose();
    process.exit(process.exitCode || 0);
  }
  for (const watcher of watchers) watcher.on('error', error => {
    console.error(`Frontend watcher failed: ${error.message}`);
    process.exitCode = 1;
    void stop();
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  const count = await prepareAssets();
  await build(options);
  console.log(`Tauri frontend ready: ${count} resources.`);
}
