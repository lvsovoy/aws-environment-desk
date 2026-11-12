import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const platforms = new Map([
  ['windows-x86_64', '.exe'],
  ['darwin-aarch64', '.dmg'],
  ['darwin-x86_64', '.dmg'],
]);

/** Describe immutable native installers with bounded sizes and SHA-256 digests. */
export async function releaseManifest(version, artifacts) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Use a stable release version in major.minor.patch format.');
  }
  if (!artifacts.length) throw new Error('Supply at least one platform installer.');
  const manifest = { version, platforms: {} };
  for (const [platform, source] of artifacts) {
    if (!platforms.has(platform) || extname(source) !== platforms.get(platform)) {
      throw new Error(`Unsupported platform or installer extension: ${platform}`);
    }
    if (manifest.platforms[platform]) throw new Error(`Duplicate platform: ${platform}`);
    const metadata = await stat(source);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 268_435_456) {
      throw new Error('Installers must be nonempty files of at most 256 MiB.');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    manifest.platforms[platform] = {
      file: `AWS-Environment-Desk-${version}-${platform}${extname(source)}`,
      sha256: hash.digest('hex'),
      size: metadata.size,
    };
  }
  const arm = manifest.platforms['darwin-aarch64'];
  const intel = manifest.platforms['darwin-x86_64'];
  if (arm && intel && arm.sha256 === intel.sha256 && arm.size === intel.size) {
    arm.file = intel.file = `AWS-Environment-Desk-${version}-darwin-universal.dmg`;
  }
  return manifest;
}

/** Publish payloads first and signed metadata last; consumers tolerate asynchronous OneDrive sync order. */
async function publish() {
  const [version, destination, ...inputs] = process.argv.slice(2);
  if (!destination || !isAbsolute(destination) || inputs.length === 0 || inputs.length % 2 !== 0) {
    throw new Error('Usage: npm run publish:tauri -- VERSION ABSOLUTE_UPDATE_DIRECTORY PLATFORM INSTALLER [PLATFORM INSTALLER ...]');
  }
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PATH && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error('Configure TAURI_SIGNING_PRIVATE_KEY_PATH or TAURI_SIGNING_PRIVATE_KEY outside the shared release directory before publishing.');
  }
  const artifacts = [];
  for (let index = 0; index < inputs.length; index += 2) artifacts.push([inputs[index], resolve(inputs[index + 1])]);
  // Hash a local snapshot rather than the mutable build output.
  const staging = await import('node:os').then(async ({ tmpdir }) => {
    const { mkdtemp } = await import('node:fs/promises');
    return mkdtemp(join(tmpdir(), 'stp-release-'));
  });
  try {
    const snapshots = [];
    for (const [index, [platform, source]] of artifacts.entries()) {
      const target = join(staging, `${index}${extname(source)}`);
      await copyFile(source, target);
      snapshots.push([platform, target]);
    }
    const manifest = await releaseManifest(version, snapshots);
    const metadata = join(staging, 'latest.json');
    await writeFile(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
    const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
    const signerArgs = [cli, 'signer', 'sign'];
    const signerEnv = { ...process.env };
    if (process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
      signerArgs.push('-f', process.env.TAURI_SIGNING_PRIVATE_KEY_PATH);
      delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
    } else if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
      const sanitizedKey = process.env.TAURI_SIGNING_PRIVATE_KEY.trim();
      signerArgs.push('-k', sanitizedKey);
      signerEnv.TAURI_SIGNING_PRIVATE_KEY = sanitizedKey;
      delete signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
    }
    signerArgs.push(metadata);
    const signed = spawnSync(process.execPath, signerArgs, { env: signerEnv, stdio: 'inherit' });
    if (signed.error) throw signed.error;
    if (signed.status !== 0) throw new Error(`Release signing failed with exit code ${signed.status}.`);
    await readFile(`${metadata}.sig`);
    await mkdir(destination, { recursive: true });
    for (const [platform, snapshot] of snapshots) {
      const artifact = manifest.platforms[platform];
      const target = join(destination, artifact.file);
      try {
        await stat(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const temporary = `${target}.pending`;
        await copyFile(snapshot, temporary);
        await rename(temporary, target);
        continue;
      }
      const existing = await releaseManifest(version, [[platform, target]]);
      if (existing.platforms[platform].sha256 !== artifact.sha256) {
        throw new Error(`Refusing to overwrite immutable release ${basename(target)}. Increment the version.`);
      }
    }
    for (const [source, target] of [[`${metadata}.sig`, 'latest.json.sig'], [metadata, 'latest.json']]) {
      const pending = join(destination, `${target}.pending`);
      await copyFile(source, pending);
      await rename(pending, join(destination, target));
    }
    console.log(`Published signed release ${version}. OneDrive clients may need time to sync all files.`);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publish().catch(error => { console.error(error.message); process.exitCode = 1; });
}
