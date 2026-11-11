import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp } from 'node:fs/promises';

const project = fileURLToPath(new URL('..', import.meta.url));

/** Parse bounded stable versions rather than accepting prereleases or numeric overflow. */
export function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid stable release version: ${version}`);
  }
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger) || parts[2] === Number.MAX_SAFE_INTEGER) {
    throw new Error('Release version exceeds the safe numeric range.');
  }
  return parts;
}

/** Increment the greater source/channel version so failed builds and older checkouts cannot reuse releases. */
export function nextVersion(source, published = source) {
  const a = versionParts(source);
  const b = versionParts(published);
  let selected = a;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue;
    selected = a[index] > b[index] ? a : b;
    break;
  }
  return `${selected[0]}.${selected[1]}.${selected[2] + 1}`;
}

/** Run tooling without a shell or .ps1 shims; propagate every failure. */
function execute(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}).`);
}

/** Reject placing signing keys in a directory that is going to be shared. */
function outsideRelease(key, destination) {
  const path = relative(destination, key);
  if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) {
    throw new Error('Signing keys must remain outside the shared distribution directory.');
  }
}

/** Build and publish one platform channel; macOS universal bytes serve both native architectures. */
export async function release(platform, {
  root = project, host = process.platform, environment = process.env, run = execute,
} = {}) {
  const windows = platform === 'windows';
  if (!['windows', 'macos'].includes(platform)) throw new Error('Choose windows or macos.');
  if (host !== (windows ? 'win32' : 'darwin')) {
    throw new Error(`${platform} releases must run on ${windows ? 'Windows' : 'macOS'}; cross-OS packaging is not supported.`);
  }
  const destination = environment.DESK_RELEASE_DIRECTORY || (windows ? join(dirname(root), 'stp-landing-dist') : '');
  if (!isAbsolute(destination)) throw new Error('Set DESK_RELEASE_DIRECTORY to the absolute local synced distribution directory on this Mac.');
  const key = environment.TAURI_SIGNING_PRIVATE_KEY_PATH || join(dirname(root), 'keys', 'stp-preview.key');
  const publicFile = environment.DESK_UPDATE_PUBLIC_KEY_PATH || `${key}.pub`;
  if (!isAbsolute(key) || !isAbsolute(publicFile)) throw new Error('Signing-key paths must be absolute.');
  outsideRelease(key, destination);
  outsideRelease(publicFile, destination);
  if (!(await stat(key)).isFile()) throw new Error('Private signing key is not a file.');
  if ((await stat(publicFile)).size > 65_536) throw new Error('Public key exceeds 64 KiB.');
  const publicKey = (await readFile(publicFile, 'utf8')).trim();
  if (!publicKey) throw new Error('The public verification key is empty.');
  const cache = windows ? environment.LOCALAPPDATA : join(homedir(), 'Library', 'Caches');
  if (!cache && !environment.CARGO_TARGET_DIR) throw new Error('LOCALAPPDATA is required for build output.');
  const target = environment.CARGO_TARGET_DIR || join(cache, 'STPEnvironmentDesk', 'build');
  if (!isAbsolute(target)) throw new Error('CARGO_TARGET_DIR must be absolute.');
  const env = {
    ...environment, CARGO_TARGET_DIR: target, DESK_UPDATE_PUBLIC_KEY: publicKey,
    TAURI_SIGNING_PRIVATE_KEY_PATH: key,
  };
  // Use only the selected key file, not a potentially stale inline key in the parent environment.
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  const channel = join(destination, platform);
  await mkdir(channel, { recursive: true });
  const lock = join(destination, '.publish-lock');
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another publisher or interrupted release holds ${lock}. Confirm no publisher is running before removing that lock directory.`);
    throw error;
  }
  let staging;
  try {
    staging = await mkdtemp(join(tmpdir(), 'stp-release-check-'));
    // Fail on a missing password or unusable private key before modifying source versions.
    const probe = join(staging, 'signing-check.txt');
    await writeFile(probe, 'STP release signing preflight\n');
    const options = { cwd: root, env };
    const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    await run(process.execPath, [cli, 'signer', 'sign', probe], options);
    const configPath = join(root, 'src-tauri', 'tauri.conf.json');
    const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
    const lockPath = join(root, 'src-tauri', 'Cargo.lock');
    const configText = await readFile(configPath, 'utf8');
    const config = JSON.parse(configText);
    const cargo = await readFile(cargoPath, 'utf8');
    const cargoLock = await readFile(lockPath, 'utf8');
    const packageSection = /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/;
    if (cargo.match(packageSection)?.[2] !== config.version) throw new Error('Cargo and Tauri source versions must match before release.');
    let published = config.version;
    try {
      const metadata = join(channel, 'latest.json');
      if ((await stat(metadata)).size > 65_536) throw new Error('Existing channel metadata exceeds 64 KiB.');
      published = JSON.parse(await readFile(metadata, 'utf8')).version;
      versionParts(published);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const version = environment.DESK_RELEASE_VERSION || nextVersion(config.version, published);
    versionParts(version);
    if (environment.DESK_RELEASE_VERSION && (nextVersion(version, config.version) !== nextVersion(version)
      || (published !== config.version && nextVersion(version, published) !== nextVersion(version)))) {
      throw new Error('The explicit release version cannot be older than source or channel versions.');
    }
    const lockSection = /(\[\[package\]\]\r?\nname = "(?:stp-environment-desk|aws-environment-desk)"\r?\nversion = ")([^"]+)(")/;
    if (cargoLock.match(lockSection)?.[2] !== config.version) throw new Error('Cargo.lock source version must match Tauri.');
    const updatedConfig = configText.replace(/("version"\s*:\s*")[^"]+(")/, (_, prefix, suffix) => `${prefix}${version}${suffix}`);
    await writeFile(configPath, updatedConfig);
    await writeFile(cargoPath, cargo.replace(packageSection, (_, prefix, old, suffix) => `${prefix}${version}${suffix}`));
    await writeFile(lockPath, cargoLock.replace(lockSection, (_, prefix, old, suffix) => `${prefix}${version}${suffix}`));
    console.log(`Building ${platform} ${version}. Source version changes remain if the release fails.`);
    const wrapper = join(root, 'desktop', 'tauri.js');
    const targetArgs = windows ? [] : ['--target', 'universal-apple-darwin'];
    await run(process.execPath, [wrapper, 'build', '--no-bundle', ...targetArgs], options);
    await run(process.execPath, [wrapper, 'bundle', '--bundles', windows ? 'nsis' : 'dmg', ...targetArgs], options);
    const bundle = join(target, ...(windows ? [] : ['universal-apple-darwin']), 'release', 'bundle', windows ? 'nsis' : 'dmg');
    const extension = windows ? '.exe' : '.dmg';
    const candidates = (await readdir(bundle)).filter(name => (name.startsWith(`AWS Environment Desk_${version}_`) || name.startsWith(`STP Environment Desk_${version}_`)) && name.endsWith(extension));
    if (candidates.length !== 1) throw new Error(`Expected exactly one ${version} installer in ${bundle}; found ${candidates.length}.`);
    const installer = join(bundle, candidates[0]);
    const artifacts = windows ? ['windows-x86_64', installer] : ['darwin-aarch64', installer, 'darwin-x86_64', installer];
    await run(process.execPath, [join(root, 'desktop', 'publish-tauri.js'), version, channel, ...artifacts], options);
    console.log(`Release assets ready in ${channel}. In-app updates use the GitHub Actions release.`);
    return { version, channel, installer };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  release(process.argv[2]).catch(error => { console.error(`Release failed: ${error.message}`); process.exitCode = 1; });
}
