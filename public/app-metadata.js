/** Generate up to three initials; preserve short names such as AWS and AVS without stored badge text. */
export function badgeLetters(name) {
  const words = String(name).trim().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return '?';
  return (words.length === 1 ? Array.from(words[0]).slice(0, 3).join('')
    : words.slice(0, 3).map(word => Array.from(word)[0]).join('')).toUpperCase();
}

/** Only permit raster files in the official Dashboard Icons repository, never arbitrary remote hosts. */
export function dashboardIcon(value) {
  return typeof value === 'string'
    && /^https:\/\/raw\.githubusercontent\.com\/homarr-labs\/dashboard-icons\/(?:main|[a-f0-9]{40})\/(?:png|webp)\/[a-z0-9][a-z0-9._-]*\.(?:png|webp)$/.test(value);
}
