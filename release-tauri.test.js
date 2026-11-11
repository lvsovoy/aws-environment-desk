import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextVersion, release } from './desktop/release-tauri.js';

/** Create isolated release inputs without reading real signing keys or publishing to OneDrive. */
async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'stp-release-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'landing');
  await mkdir(join(root, 'src-tauri'), { recursive: true });
  await writeFile(join(root, 'src-tauri', 'tauri.conf.json'), '{"version":"1.1.0"}\n');
  await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "aws-environment-desk"\nversion = "1.1.0"\n');
  await writeFile(join(root, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "aws-environment-desk"\nversion = "1.1.0"\n');
  const key = join(directory, 'test.key');
  await writeFile(key, 'test fixture, not a signing key');
  await writeFile(`${key}.pub`, 'test-public-key\n');
  const environment = {
    DESK_RELEASE_DIRECTORY: join(directory, 'distribution'),
    CARGO_TARGET_DIR: join(directory, 'build'),
    TAURI_SIGNING_PRIVATE_KEY_PATH: key,
    TAURI_SIGNING_PRIVATE_KEY: 'must-not-be-used',
  };
  return { root, environment };
}

/** Validate patch increments including a channel ahead of the checkout and invalid metadata. */
test('release versions advance beyond source and channel versions', () => {
  assert.equal(nextVersion('1.1.0'), '1.1.1');
  assert.equal(nextVersion('1.1.0', '2.0.9'), '2.0.10');
  assert.equal(nextVersion('3.0.0', '2.99.99'), '3.0.1');
  for (const invalid of ['01.1.0', '1.2.3-beta', undefined, '1.2.9007199254740991']) {
    assert.throws(() => nextVersion(invalid), /version/i);
  }
});

/** Tag-driven CI builds use the exact version, while local releases continue to increment automatically. */
test('CI release version overrides automatic increment without accepting an older version', async context => {
  const data = await fixture(context);
  const environment = { ...data.environment, DESK_RELEASE_VERSION: '1.4.0' };
  const result = await release('windows', {
    ...data, host: 'win32', environment,
    run: async (command, args) => {
      if (args[1] === 'bundle') {
        const bundle = join(environment.CARGO_TARGET_DIR, 'release', 'bundle', 'nsis');
        await mkdir(bundle, { recursive: true });
        await writeFile(join(bundle, 'AWS Environment Desk_1.4.0_x64-setup.exe'), 'Fixture only');
      }
    },
  });
  assert.equal(result.version, '1.4.0');
  await assert.rejects(release('windows', {
    ...data, host: 'win32', environment: { ...environment, DESK_RELEASE_VERSION: '1.3.9' },
    run: () => {},
  }), /cannot be older/);
  assert.equal(JSON.parse(await readFile(join(data.root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '1.4.0');
});

for (const platform of ['windows', 'macos']) {
  /** Exercise exact build/publish arguments and synchronized source versions for each platform. */
  test(`${platform} release embeds a public key and publishes only its channel`, async context => {
    const fixtureData = await fixture(context);
    const { root, environment } = fixtureData;
    const channel = join(environment.DESK_RELEASE_DIRECTORY, platform);
    await mkdir(channel, { recursive: true });
    await writeFile(join(channel, 'latest.json'), '{"version":"1.2.8"}');
    const calls = [];
    const windows = platform === 'windows';
    const result = await release(platform, {
      ...fixtureData, host: windows ? 'win32' : 'darwin',
      /** Simulate native tooling, but create real output files for installer discovery. */
      run: async (command, args, options) => {
        calls.push(args);
        assert.equal(options.env.DESK_UPDATE_PUBLIC_KEY, 'test-public-key');
        assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY, undefined);
        if (args[1] === 'bundle') {
          const bundle = join(environment.CARGO_TARGET_DIR, ...(windows ? [] : ['universal-apple-darwin']), 'release', 'bundle', windows ? 'nsis' : 'dmg');
          await mkdir(bundle, { recursive: true });
          await writeFile(join(bundle, `AWS Environment Desk_1.2.9_${windows ? 'x64-setup.exe' : 'universal.dmg'}`), 'test installer');
        }
      },
    });
    assert.equal(result.version, '1.2.9');
    assert.equal(result.channel, channel);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[1].slice(1), windows ? ['build', '--no-bundle'] : ['build', '--no-bundle', '--target', 'universal-apple-darwin']);
    assert.equal(calls[3][1], '1.2.9');
    assert.equal(calls[3][2], channel);
    assert.equal(calls[3][3], windows ? 'windows-x86_64' : 'darwin-aarch64');
    if (!windows) {
      assert.equal(calls[3][5], 'darwin-x86_64');
      assert.equal(calls[3][4], calls[3][6]);
    }
    assert.equal(JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '1.2.9');
    assert.match(await readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8'), /version = "1.2.9"/);
    assert.match(await readFile(join(root, 'src-tauri', 'Cargo.lock'), 'utf8'), /version = "1.2.9"/);
    await assert.rejects(stat(join(environment.DESK_RELEASE_DIRECTORY, '.publish-lock')), { code: 'ENOENT' });
  });
}

/** Signing failures must not bump versions; build failures must never publish and must release the lock. */
test('release failures stop before publication and free the lock', async context => {
  const data = await fixture(context);
  await assert.rejects(release('windows', {
    ...data, host: 'win32',
    /** Simulate an encrypted key with a missing or incorrect password. */
    run: () => { throw new Error('signing failed'); },
  }), /signing failed/);
  assert.equal(JSON.parse(await readFile(join(data.root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '1.1.0');
  const calls = [];
  await assert.rejects(release('windows', {
    ...data, host: 'win32',
    /** Stop on the first build invocation after a successful signing preflight. */
    run: (command, args) => {
      calls.push(args);
      if (args[1] === 'build') throw new Error('build failed');
    },
  }), /build failed/);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(await readFile(join(data.root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '1.1.1');
  await assert.rejects(stat(join(data.environment.DESK_RELEASE_DIRECTORY, '.publish-lock')), { code: 'ENOENT' });
});

/** Refuse incompatible hosts and prevent publishing a directory containing private keys. */
test('release validates host and key separation before invoking tooling', async context => {
  const data = await fixture(context);
  await assert.rejects(release('macos', { ...data, host: 'win32' }), /must run on macOS/);
  await assert.rejects(release('windows', {
    ...data, host: 'win32',
    environment: { ...data.environment, DESK_RELEASE_DIRECTORY: data.root.replace(/landing$/, '') },
  }), /outside the shared/);
  await mkdir(data.environment.DESK_RELEASE_DIRECTORY);
  await mkdir(join(data.environment.DESK_RELEASE_DIRECTORY, '.publish-lock'));
  await assert.rejects(release('windows', { ...data, host: 'win32' }), /Another publisher/);
});

/** Invalid existing channel metadata must not silently reset version history. */
test('release rejects channel metadata without a version', async context => {
  const data = await fixture(context);
  const channel = join(data.environment.DESK_RELEASE_DIRECTORY, 'windows');
  await mkdir(channel, { recursive: true });
  await writeFile(join(channel, 'latest.json'), '{}');
  await assert.rejects(release('windows', {
    ...data, host: 'win32',
    /** Simulate successful signing only; metadata validation must prevent a build. */
    run: (command, args) => { assert.equal(args[1], 'signer'); },
  }), /Invalid stable release version/);
  assert.equal(JSON.parse(await readFile(join(data.root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '1.1.0');
});

/** Exercise real local key generation, signing, and publication using disposable keys outside OneDrive. */
test('release pipeline publishes real signed metadata with isolated fixture installers', async context => {
  const data = await fixture(context);
  const cli = fileURLToPath(new URL('./node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
  const publisher = fileURLToPath(new URL('./desktop/publish-tauri.js', import.meta.url));
  const environment = { ...process.env, ...data.environment, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
  await rm(environment.TAURI_SIGNING_PRIVATE_KEY_PATH);
  await rm(`${environment.TAURI_SIGNING_PRIVATE_KEY_PATH}.pub`);
  /** Run only the installed signer/publisher and surface subprocess failures without secret output. */
  const invoke = (args, env = environment) => {
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
  };
  invoke([cli, 'signer', 'generate', '--ci', '--password', '', '-w', environment.TAURI_SIGNING_PRIVATE_KEY_PATH]);
  const result = await release('windows', {
    root: data.root, host: 'win32', environment,
    /** Use real cryptographic tools, substituting only native compilation and bundling. */
    run: async (command, args, options) => {
      if (args[1] === 'signer') invoke([cli, ...args.slice(1)], options.env);
      if (args[1] === 'bundle') {
        const bundle = join(environment.CARGO_TARGET_DIR, 'release', 'bundle', 'nsis');
        await mkdir(bundle, { recursive: true });
        await writeFile(join(bundle, 'AWS Environment Desk_1.1.1_x64-setup.exe'), 'NOT EXECUTABLE: release integration fixture');
      }
      if (args[0].endsWith('publish-tauri.js')) invoke([publisher, ...args.slice(1)], options.env);
    },
  });
  const metadata = JSON.parse(await readFile(join(result.channel, 'latest.json'), 'utf8'));
  assert.equal(metadata.version, '1.1.1');
  assert.deepEqual(Object.keys(metadata.platforms), ['windows-x86_64']);
  const artifact = metadata.platforms['windows-x86_64'];
  assert.equal((await stat(join(result.channel, artifact.file))).size, artifact.size);
  assert.ok((await stat(join(result.channel, 'latest.json.sig'))).size > 0);
});
