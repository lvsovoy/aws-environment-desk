import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { validateCatalogue, DEFAULT_ENVIRONMENT_KEYS } from './catalogue.js';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config/config.json', import.meta.url));
export const EXAMPLE_CONFIG_PATH = fileURLToPath(new URL('../config/config.example.json', import.meta.url));
export const LEGACY_CONFIG_PATH = fileURLToPath(new URL('../config/apps.json', import.meta.url));

const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="deskGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>
  <rect x="128" y="128" width="768" height="512" rx="64" fill="url(#deskGrad)"/>
  <rect x="200" y="200" width="624" height="368" rx="32" fill="#1e293b"/>
  <circle cx="512" cy="384" r="96" fill="#38bdf8" fill-opacity="0.2"/>
  <path d="M448 384 L496 432 L576 336" fill="none" stroke="#38bdf8" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M384 768 L640 768 M512 640 L512 768" stroke="#10b981" stroke-width="48" stroke-linecap="round"/>
</svg>`;

/** Validate 1-12 uniquely keyed environments, defaulting to DEV/INT/STAGE/PROD when none are declared. */
export function validateEnvironments(environments) {
  if (environments === undefined) {
    return DEFAULT_ENVIRONMENT_KEYS.map(key => ({ key, title: key.toUpperCase(), sub: `${key.toUpperCase()} VPN` }));
  }
  if (!Array.isArray(environments) || !environments.length || environments.length > 12) {
    throw new Error('Configuration requires between 1 and 12 environments.');
  }
  const keys = new Set();
  for (const env of environments) {
    if (!env || typeof env.key !== 'string' || !/^[a-z0-9-]{1,32}$/.test(env.key) || keys.has(env.key)) {
      throw new Error('Environment keys must be unique lowercase identifiers of at most 32 characters.');
    }
    keys.add(env.key);
    if (typeof env.title !== 'string' || !env.title.trim() || env.title.length > 32
      || (env.sub !== undefined && (typeof env.sub !== 'string' || env.sub.length > 64))) {
      throw new Error(`Invalid title for environment ${env.key}.`);
    }
  }
  return environments;
}

/** Validate and normalize complete application configuration. */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Configuration must be a valid JSON object.');
  }
  if (config.schemaVersion !== 1) {
    throw new Error('Configuration requires schemaVersion 1.');
  }
  const environments = validateEnvironments(config.environments);
  const environmentKeys = environments.map(env => env.key);
  validateCatalogue({ schemaVersion: config.schemaVersion, apps: config.apps || [] }, environmentKeys);

  const normalized = {
    schemaVersion: 1,
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : 'AWS Environment Desk',
    productName: typeof config.productName === 'string' && config.productName.trim() ? config.productName.trim() : (config.name || 'AWS Environment Desk'),
    description: typeof config.description === 'string' ? config.description : 'AWS Environment resources and AWS VPN profile switching',
    identifier: typeof config.identifier === 'string' && config.identifier.trim() ? config.identifier.trim() : 'com.aws.environmentdesk',
    brand: {
      name: config.brand?.name || config.name || 'AWS Environment Desk',
      markAlt: config.brand?.markAlt || config.name || 'AWS Environment Desk',
      backgroundColor: config.brand?.backgroundColor || '#202522',
      svg: config.brand?.svg || DEFAULT_SVG,
    },
    vpn: {
      clientName: config.vpn?.clientName || 'AWS VPN Client 6.2',
      defaultProfiles: Object.fromEntries(environments.map(env => [
        env.key,
        config.vpn?.defaultProfiles?.[env.key] || env.title,
      ])),
    },
    environments,
    apps: config.apps || [],
  };

  return normalized;
}

/** Resolve SVG data for branding and icon generation. */
export async function resolveSvg(config) {
  const source = config?.brand?.svg || DEFAULT_SVG;
  if (typeof source === 'string' && source.trim().startsWith('<svg')) {
    return Buffer.from(source, 'utf8');
  }
  if (typeof source === 'string' && source.trim()) {
    try {
      const root = fileURLToPath(new URL('..', import.meta.url));
      const targetPath = isAbsolute(source) ? source : join(root, source);
      return await readFile(targetPath);
    } catch {
      return Buffer.from(DEFAULT_SVG, 'utf8');
    }
  }
  return Buffer.from(DEFAULT_SVG, 'utf8');
}

/** Find and read the active configuration file, falling back to example/default templates. */
export async function loadConfig(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [
      process.env.APP_CONFIG_PATH,
      DEFAULT_CONFIG_PATH,
      LEGACY_CONFIG_PATH,
      EXAMPLE_CONFIG_PATH,
    ].filter(Boolean);

  for (const path of candidates) {
    try {
      const stats = await stat(path);
      if (stats.isFile()) {
        const text = await readFile(path, 'utf8');
        const parsed = JSON.parse(text);
        return validateConfig(parsed);
      }
    } catch (error) {
      if (explicitPath && error.code !== 'ENOENT') throw error;
    }
  }

  return validateConfig({ schemaVersion: 1, apps: [] });
}

/** Import configuration from a specified JSON file into the local configuration location. */
export async function importConfig(sourcePath, destinationPath = DEFAULT_CONFIG_PATH) {
  if (!sourcePath) throw new Error('A source configuration file path is required.');
  const text = await readFile(sourcePath, 'utf8');
  const parsed = JSON.parse(text);
  const validated = validateConfig(parsed);
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
  return validated;
}
