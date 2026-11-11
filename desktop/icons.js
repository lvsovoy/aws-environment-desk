import sharp from 'sharp';
import png2icons from 'png2icons';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig, resolveSvg } from './config.js';

/** Derive all native icons from the configured SVG, retaining the original source unchanged. */
export async function buildIcons(customConfig) {
  const config = customConfig || await loadConfig();
  const svg = await resolveSvg(config);
  const directory = new URL('../dist/icons/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const background = config.brand?.backgroundColor || '#202522';
  const logo = await sharp(svg).resize(640, 800, { fit: 'inside' }).png().toBuffer();
  const icon = await sharp({ create: { width: 1024, height: 1024, channels: 4, background } })
    .composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
  await writeFile(new URL('icon.png', directory), icon);
  const ico = png2icons.createICO(icon, png2icons.BILINEAR, 0, true, true);
  const icns = png2icons.createICNS(icon, png2icons.BILINEAR, 0);
  if (!ico || !icns) throw new Error('Could not generate native app icons from the SVG.');
  await writeFile(new URL('icon.ico', directory), ico);
  await writeFile(new URL('icon.icns', directory), icns);
  png2icons.clearCache();
  for (const size of [16, 32]) {
    const suffix = size === 16 ? '' : '@2x';
    await writeFile(new URL(`tray${suffix}.png`, directory), await sharp(icon).resize(size, size).png().toBuffer());
    const template = await sharp(svg).resize(size, size, { fit: 'contain', background: '#00000000' })
      .tint('#000000').png().toBuffer();
    await writeFile(new URL(`trayTemplate${suffix}.png`, directory), template);
  }
}