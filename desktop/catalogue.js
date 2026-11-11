import { dashboardIcon } from '../public/app-metadata.js';
export { dashboardIcon } from '../public/app-metadata.js';
export const DEFAULT_ENVIRONMENT_KEYS = ['dev', 'int', 'stage', 'prod'];
/** Validate release-authored app metadata before building; native loading independently validates it. */
export function validateCatalogue(catalogue, environmentKeys = DEFAULT_ENVIRONMENT_KEYS) {
  const expectedLinks = [...environmentKeys].sort().join(',');
  if (!catalogue || catalogue.schemaVersion !== 1 || !Array.isArray(catalogue.apps)
    || !catalogue.apps.length || catalogue.apps.length > 100) {
    throw new Error('App catalogue requires schemaVersion 1 and between 1 and 100 apps.');
  }
  const keys = new Set();
  if (Object.keys(catalogue).some(key => !['schemaVersion', 'apps'].includes(key))) {
    throw new Error('Unknown field in app catalogue.');
  }
  for (const app of catalogue.apps) {
    if (!app || typeof app.key !== 'string' || !/^[a-z0-9-]{1,64}$/.test(app.key) || keys.has(app.key)) {
      throw new Error('App catalogue keys must be unique lowercase identifiers of at most 64 bytes.');
    }
    keys.add(app.key);
    if (Object.keys(app).some(key => !['key', 'name', 'description', 'icon', 'links'].includes(key))) {
      throw new Error(`Unknown or invalid field for ${app.key}.`);
    }
    for (const [field, maximum] of [['name', 128], ['description', 512]]) {
      if (typeof app[field] !== 'string' || Buffer.byteLength(app[field]) > maximum || (field === 'name' && !app[field].trim())) {
        throw new Error(`Invalid catalogue ${field} for ${app.key}.`);
      }
    }
    if (app.icon !== undefined && app.icon !== '' && !dashboardIcon(app.icon)) throw new Error(`Use an empty icon or a Dashboard Icons image URL for ${app.key}.`);
    if (!app.links || Object.keys(app.links).sort().join(',') !== expectedLinks) {
      throw new Error(`Supply one link field per environment (${environmentKeys.join(', ')}) for ${app.key}.`);
    }

    for (const destination of Object.values(app.links)) {
      if (destination === null) continue;
      if (typeof destination !== 'string' || destination.length > 8192) throw new Error(`Invalid URL for ${app.key}.`);
      const url = new URL(destination);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
        throw new Error(`Only HTTPS URLs without embedded credentials are allowed for ${app.key}.`);
      }
    }
  }
  return catalogue;
}
