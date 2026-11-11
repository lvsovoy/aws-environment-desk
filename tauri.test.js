import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { releaseManifest } from './desktop/publish-tauri.js';

/** Verify platform-specific metadata matches the actual bytes and rejects ambiguous or unsafe inputs. */
test('local release manifest describes exact platform installer bytes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'stp-manifest-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'setup.exe');
  const bytes = Buffer.from('simulated installer, never executable');
  await writeFile(source, bytes);
  const result = await releaseManifest('1.2.3', [['windows-x86_64', source]]);
  assert.deepEqual(result, {
    version: '1.2.3',
    platforms: {
      'windows-x86_64': {
        file: 'AWS-Environment-Desk-1.2.3-windows-x86_64.exe',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
    },
  });
  await assert.rejects(releaseManifest('../bad', [['windows-x86_64', source]]), /version/);
  await assert.rejects(releaseManifest('1.2.3', []), /at least one/);
  await assert.rejects(releaseManifest('1.2.3', [['darwin-aarch64', source]]), /Unsupported/);
  await assert.rejects(releaseManifest('1.2.3', [['windows-x86_64', source], ['windows-x86_64', source]]), /Duplicate/);
  await writeFile(source, '');
  await assert.rejects(releaseManifest('1.2.3', [['windows-x86_64', source]]), /nonempty/);
});

/** Reuse one universal DMG in both Mac entries instead of syncing duplicate installer bytes. */
test('universal macOS manifests share one installer filename', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'stp-universal-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'universal.dmg');
  await writeFile(source, 'simulated universal DMG');
  const result = await releaseManifest('1.2.3', [['darwin-aarch64', source], ['darwin-x86_64', source]]);
  assert.equal(result.platforms['darwin-aarch64'].file, 'AWS-Environment-Desk-1.2.3-darwin-universal.dmg');
  assert.deepEqual(result.platforms['darwin-aarch64'], result.platforms['darwin-x86_64']);
});
