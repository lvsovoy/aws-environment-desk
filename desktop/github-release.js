import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseManifest } from './publish-tauri.js';
import { versionParts } from './release-tauri.js';

const root = fileURLToPath(new URL('../ci-release/', import.meta.url));

/** Read metadata with a strict size bound before JSON parsing or publication. */
async function small(path) {
  if ((await stat(path)).size > 65_536) throw new Error('Release metadata exceeds 64 KiB.');
  return readFile(path);
}

/** Validate both platform outputs completely before publishing assets. */
export async function collectFiles(directory, version) {
  const files = [];
  for (const [channel, platforms] of [
    ['windows', ['windows-x86_64']],
    ['macos', ['darwin-aarch64', 'darwin-x86_64']],
  ]) {
    const folder = join(directory, channel);
    const manifestPath = join(folder, 'latest.json');
    const signaturePath = join(folder, 'latest.json.sig');
    const manifest = JSON.parse(await small(manifestPath));
    if (manifest.version !== version || !manifest.platforms
      || Object.keys(manifest.platforms).sort().join() !== [...platforms].sort().join()) {
      throw new Error(`Unexpected version or platforms in ${channel} output.`);
    }
    const artifacts = platforms.map(platform => {
      const file = manifest.platforms[platform]?.file;
      const extension = channel === 'windows' ? 'exe' : 'dmg';
      if (typeof file !== 'string' || !new RegExp(`^(?:AWS|STP|Environment)-[A-Za-z0-9_-]*-?${version.replaceAll('.', '\\.')}-[a-z0-9_-]+\\.${extension}$`).test(file)) {
        throw new Error(`Unsafe installer filename in ${channel} output: ${file}`);
      }
      return [platform, join(folder, file)];
    });
    const expected = await releaseManifest(version, artifacts);
    for (const platform of platforms) {
      const actual = manifest.platforms[platform];
      const wanted = expected.platforms[platform];
      if (actual.file !== wanted.file || actual.size !== wanted.size || actual.sha256 !== wanted.sha256) {
        throw new Error(`Installer bytes differ from the signed ${channel} manifest.`);
      }
    }
    if (!(await small(signaturePath)).length) throw new Error(`Missing ${channel} manifest signature.`);
    const names = new Set(platforms.map(platform => manifest.platforms[platform].file));
    for (const filename of [...names, 'latest.json', 'latest.json.sig']) {
      files.push({ channel, filename, path: join(folder, filename) });
    }
  }
  return files;
}

/** Publish release assets to a GitHub Release. */
export async function publishGitHub({
  directory = root, environment = process.env, request = fetch,
} = {}) {
  const tag = environment.GITHUB_REF_NAME
    || (environment.GITHUB_REF?.startsWith('refs/tags/') ? environment.GITHUB_REF.slice(10) : '')
    || environment.CI_COMMIT_TAG
    || '';
  const token = environment.GITHUB_TOKEN || environment.GH_TOKEN;
  const repository = environment.GITHUB_REPOSITORY || '';
  const apiUrl = (environment.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Releases require a valid vX.Y.Z tag; got "${tag}".`);
  }
  const version = tag.slice(1);
  versionParts(version);

  if (!token) throw new Error('Missing GITHUB_TOKEN for GitHub Release publication.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid or missing GITHUB_REPOSITORY; expected owner/repo.');
  }

  const files = await collectFiles(directory, version);
  const repoUrl = `${apiUrl}/repos/${repository}`;

  const call = (url, options = {}) => request(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(600_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });

  const existingResponse = await call(`${repoUrl}/releases/tags/${encodeURIComponent(tag)}`);
  if (existingResponse.status !== 404) {
    if (existingResponse.ok) throw new Error('This GitHub Release already exists; use a new version/tag.');
    throw new Error(`Cannot inspect GitHub Release: HTTP ${existingResponse.status}.`);
  }

  const createResponse = await call(`${repoUrl}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `Release ${tag}`,
      body: `Automated release for ${tag}. Contains signed Windows and macOS installers.`,
      draft: false,
      prerelease: false,
    }),
  });

  if (createResponse.status !== 201) {
    throw new Error(`Cannot create GitHub Release: HTTP ${createResponse.status}.`);
  }

  const releaseData = await createResponse.json();
  const releaseId = releaseData.id;
  const uploadUrlTemplate = releaseData.upload_url || `${repoUrl}/releases/${releaseId}/assets{?name,label}`;
  const uploadBase = uploadUrlTemplate.split('{')[0];

  const uploadedAssets = [];
  for (const file of files) {
    const assetName = file.filename.startsWith('latest.json')
      ? `${file.channel}-${file.filename}`
      : file.filename;
    const blob = await openAsBlob(file.path);
    const uploadUrl = `${uploadBase}?name=${encodeURIComponent(assetName)}`;
    const uploadResponse = await call(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(blob.size),
      },
      body: blob,
    });

    if (uploadResponse.status !== 201) {
      throw new Error(`Cannot upload ${assetName}: HTTP ${uploadResponse.status}.`);
    }

    const assetData = await uploadResponse.json();
    uploadedAssets.push({
      name: assetName,
      channel: file.channel,
      url: assetData.browser_download_url || uploadUrl,
    });
  }

  console.log(`Published GitHub Release ${tag} with ${uploadedAssets.length} assets.`);
  return uploadedAssets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishGitHub().catch(error => {
    console.error(`GitHub publication failed: ${error.message}`);
    process.exitCode = 1;
  });
}
