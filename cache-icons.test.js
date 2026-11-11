import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { cacheIcons } from './desktop/cache-icons.js';

const icon = 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/png/gitlab.png';

/** Isolate cached/build assets without touching the real application cache. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stp-icons-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return [join(root, 'cache'), join(root, 'output')];
}

/** Verify URL deduplication, bounded PNG output, badge exclusion and completely offline cache reuse. */
test('icons are sanitized, bundled once per URL and reused offline', async t => {
  const [cache, output] = await fixture(t);
  const bytes = await sharp({ create: { width: 256, height: 128, channels: 4, background: '#aaff89' } }).png().toBuffer();
  let requests = 0;
  const apps = [{ icon }, { icon }, {}, { icon: '' }];
  const map = await cacheIcons(apps, cache, output, async (url, options) => {
    requests++;
    assert.equal(url, icon);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(bytes);
  });
  assert.equal(requests, 1);
  assert.match(map[icon], /^\/app-icons\/[a-f0-9]{64}\.png$/);
  const bundled = await readFile(join(output, basename(map[icon])));
  const metadata = await sharp(bundled).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 64);
  assert.deepEqual(await cacheIcons(apps, cache, output, () => { throw new Error('Offline'); }), map);
  await writeFile(join(cache, basename(map[icon])), 'corrupt');
  await assert.rejects(cacheIcons(apps, cache, output, () => { throw new Error('Unexpected request'); }), /unsupported image format/i);
});

/** Downloads and malformed content fail explicitly, without leaving cached or pending files behind. */
test('icon downloads reject unsafe URLs, server errors, oversized and invalid images', async t => {
  const [cache, output] = await fixture(t);
  await assert.rejects(cacheIcons([{ icon: 'https://example.com/image.png' }], cache, output), /Unsupported/);
  for (const [response, message] of [
    [new Response('', { status: 404 }), /404/],
    [new Response(new Uint8Array(2_097_153)), /2 MiB/],
    [new Response('invalid image'), /unsupported image format/i],
    [new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), /Expected PNG or WebP/],
  ]) {
    await assert.rejects(cacheIcons([{ icon }], cache, output, async () => response), message);
    assert.deepEqual(await readdir(cache), []);
  }
  await assert.rejects(cacheIcons([{ icon }], cache, output, async () => { throw new Error('Network failed'); }), /Network failed/);
});
