import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { release, versionParts } from './release-tauri.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Run validation without a shell, and propagate failures before producing release artifacts. */
function run(args, environment) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CI release step failed (${result.status}).`);
}

/** Build the tag version using action secrets, never machine-specific OneDrive paths. */
async function main() {
  const tag = process.env.GITHUB_REF_NAME
    || (process.env.GITHUB_REF?.startsWith('refs/tags/') ? process.env.GITHUB_REF.slice(10) : '')
    || process.env.CI_COMMIT_TAG
    || '';
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Releases require a valid vX.Y.Z tag; got "${tag}".`);
  }
  const repository = process.env.DESK_UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('GitHub releases require DESK_UPDATE_REPOSITORY or GITHUB_REPOSITORY in owner/repo format.');
  }
  const version = tag.slice(1);
  versionParts(version);

  let tempKeyDir = null;
  let keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || process.env.DESK_CI_SIGNING_KEY;
  let pubPath = process.env.DESK_UPDATE_PUBLIC_KEY_PATH || process.env.DESK_CI_PUBLIC_KEY || process.env.TAURI_PUBLIC_KEY_PATH;

  if (!keyPath && process.env.TAURI_SIGNING_PRIVATE_KEY) {
    tempKeyDir = await mkdtemp(join(tmpdir(), 'ci-key-'));
    keyPath = join(tempKeyDir, 'release.key');
    await writeFile(keyPath, process.env.TAURI_SIGNING_PRIVATE_KEY.trim() + '\n', 'utf8');
    if (process.env.TAURI_PUBLIC_KEY) {
      pubPath = join(tempKeyDir, 'release.key.pub');
      await writeFile(pubPath, process.env.TAURI_PUBLIC_KEY.trim() + '\n', 'utf8');
    }
  }

  if (!keyPath) {
    throw new Error('Configure signing key via TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH secret.');
  }

  const environment = {
    ...process.env,
    DESK_RELEASE_VERSION: version,
    DESK_RELEASE_DIRECTORY: join(root, 'ci-release'),
    DESK_UPDATE_REPOSITORY: repository,
    TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
    ...(pubPath ? { DESK_UPDATE_PUBLIC_KEY_PATH: pubPath } : {}),
  };

  try {
    run(['--test'], process.env);
    run([join(root, 'desktop', 'tauri.js'), 'test', '--locked'], environment);
    await release(process.argv[2], { environment });
  } finally {
    if (tempKeyDir) {
      await rm(tempKeyDir, { recursive: true, force: true });
    }
  }
}

main().catch(error => { console.error(`CI release failed: ${error.message}`); process.exitCode = 1; });
