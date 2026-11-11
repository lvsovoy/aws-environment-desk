import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseManifest } from './desktop/publish-tauri.js';
import { collectFiles, publishGitHub } from './desktop/github-release.js';

/** Create two isolated platform channels; files never contain executable installers or actual keys. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stp-github-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const channel of ['windows', 'macos']) {
    const folder = join(directory, channel);
    await mkdir(folder);
    const platforms = channel === 'windows' ? ['windows-x86_64'] : ['darwin-aarch64', 'darwin-x86_64'];
    const source = join(folder, channel === 'windows' ? 'test.exe' : 'test.dmg');
    await writeFile(source, 'Fixture only, not executable');
    const manifest = await releaseManifest('1.2.3', platforms.map(platform => [platform, source]));
    await writeFile(join(folder, Object.values(manifest.platforms)[0].file), await readFile(source));
    await writeFile(join(folder, 'latest.json'), JSON.stringify(manifest));
    await writeFile(join(folder, 'latest.json.sig'), 'Fixture signature; actual cryptographic signing is covered in release-tauri.test.js');
  }
  const environment = {
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_REPOSITORY: 'test-owner/test-repo',
    GITHUB_TOKEN: 'test-token',
    GITHUB_API_URL: 'https://api.github.com',
  };
  return { directory, environment };
}

/** Both channels must match the tag and contain exact manifest-bound bytes before any uploads occur. */
test('GitHub collection verifies both channels and deduplicates universal macOS installer', async t => {
  const data = await fixture(t);
  const files = await collectFiles(data.directory, '1.2.3');
  assert.equal(files.length, 6);
  assert.equal(files.filter(file => file.filename.endsWith('.dmg')).length, 1);
  await assert.rejects(collectFiles(data.directory, '1.2.4'), /version/);
  await writeFile(files.find(file => file.filename.endsWith('.exe')).path, 'tampered');
  await assert.rejects(collectFiles(data.directory, '1.2.3'), /differ/);
});

/** Release creation attaches release assets; tokens stay in authorization headers. */
test('GitHub publisher creates release and uploads assets', async t => {
  const data = await fixture(t);
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(options.headers?.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    if (!options.method || options.method === 'GET') {
      return new Response('', { status: 404 });
    }
    if (options.method === 'POST') {
      if (url.includes('/releases/123/assets')) {
        return new Response(JSON.stringify({ browser_download_url: url }), { status: 201 });
      }
      return new Response(JSON.stringify({
        id: 123,
        upload_url: 'https://uploads.github.com/repos/test-owner/test-repo/releases/123/assets{?name,label}',
      }), { status: 201 });
    }
    return new Response('{}', { status: 200 });
  };
  const assets = await publishGitHub({ ...data, request });
  assert.equal(assets.length, 6);
  assert.ok(calls.some(c => c.options.method === 'POST' && c.url.endsWith('/releases')));
});

/** A failed asset upload fails explicitly. */
test('GitHub upload failures prevent successful release', async t => {
  const data = await fixture(t);
  await assert.rejects(publishGitHub({
    ...data,
    request: async (url, options = {}) => {
      if (url.includes('/releases/tags/')) return new Response('', { status: 404 });
      if (url.endsWith('/releases')) {
        return new Response(JSON.stringify({
          id: 123,
          upload_url: 'https://uploads.github.com/repos/test-owner/test-repo/releases/123/assets{?name,label}',
        }), { status: 201 });
      }
      return new Response('', { status: 500 });
    },
  }), /upload.*500/i);
});

/** Existing release tags are rejected. */
test('GitHub publisher rejects existing releases and invalid tags', async t => {
  const data = await fixture(t);
  await assert.rejects(publishGitHub({
    ...data,
    request: async () => new Response('{"id": 1}', { status: 200 }),
  }), /already exists/);

  await assert.rejects(publishGitHub({
    ...data,
    environment: { ...data.environment, GITHUB_REF_NAME: 'v1.2.3-beta' },
    request: async () => { throw new Error('Must not make request'); },
  }), /tag/);

  await assert.rejects(publishGitHub({
    ...data,
    environment: { ...data.environment, GITHUB_REPOSITORY: undefined },
    request: async () => { throw new Error('Must not make request'); },
  }), /repository/i);
});
