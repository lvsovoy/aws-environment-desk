import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rename, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { dashboardIcon } from './catalogue.js';

/** Download bounded raster images once, decode/re-encode them, and bundle cached bytes without runtime network access. */
export async function cacheIcons(apps, cacheDirectory, outputDirectory, request = fetch) {
  await mkdir(cacheDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  const result = {};
  for (const url of new Set(apps.map(app => app.icon).filter(Boolean))) {
    if (!dashboardIcon(url)) throw new Error(`Unsupported Dashboard Icons URL: ${url}`);
    const filename = `${createHash('sha256').update(url).digest('hex')}.png`;
    const cached = join(cacheDirectory, filename);
    try {
      if ((await stat(cached)).size > 2_097_152) throw new Error(`Cached icon exceeds 2 MiB; remove ${cached}`);
      const metadata = await sharp(await readFile(cached), { limitInputPixels: 16_384 }).metadata();
      if (metadata.format !== 'png' || metadata.width > 128 || metadata.height > 128) {
        throw new Error(`Invalid cached icon; remove ${cached}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await request(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) throw new Error(`Icon download failed (${response.status}): ${url}`);
      if (!response.body) throw new Error(`Icon response has no body: ${url}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2_097_152) throw new Error(`Icon exceeds 2 MiB: ${url}`);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const metadata = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata();
      if (!['png', 'webp'].includes(metadata.format)) throw new Error(`Expected PNG or WebP icon: ${url}`);
      const png = await sharp(bytes, { limitInputPixels: 16_777_216 })
        .resize(128, 128, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const pending = `${cached}.${process.pid}.pending`;
      try {
        await writeFile(pending, png);
        await rename(pending, cached);
      } finally {
        await rm(pending, { force: true });
      }
    }
    await copyFile(cached, join(outputDirectory, filename));
    result[url] = `/app-icons/${filename}`;
  }
  return result;
}
