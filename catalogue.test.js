import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCatalogue, dashboardIcon } from './desktop/catalogue.js';
import { validateConfig, loadConfig, importConfig, resolveSvg } from './desktop/config.js';
import { badgeLetters } from './public/app-metadata.js';

/** Preserve the default apps and environment links while allowing additions. */
test('JSON config preserves apps and links while allowing additions', async () => {
  const config = await loadConfig();
  assert.ok(config.schemaVersion === 1);
  assert.ok(Array.isArray(config.apps));
  assert.ok(config.name.length > 0);
  assert.ok(config.vpn.defaultProfiles.dev);
});

/** Verify importConfig validates and writes the imported configuration. */
test('importConfig validates schema and persists target file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stp-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'custom.json');
  const target = join(directory, 'config.json');
  const custom = {
    schemaVersion: 1,
    name: 'Custom Desk',
    productName: 'Custom Desk',
    description: 'Custom description',
    identifier: 'com.custom.desk',
    brand: { name: 'Custom', markAlt: 'Custom', backgroundColor: '#112233', svg: '<svg></svg>' },
    vpn: { clientName: 'Custom VPN', defaultProfiles: { dev: 'D', int: 'I', stage: 'S', prod: 'P' } },
    environments: [
      { key: 'dev', title: 'D', sub: 'D-VPN' },
      { key: 'int', title: 'I', sub: 'I-VPN' },
      { key: 'stage', title: 'S', sub: 'S-VPN' },
      { key: 'prod', title: 'P', sub: 'P-VPN' },
    ],
    apps: [
      {
        key: 'example',
        name: 'Example',
        description: 'Example app',
        icon: 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/png/aws.png',
        links: { dev: 'https://example.com/', int: null, stage: null, prod: null },
      },
    ],
  };
  await writeFile(source, JSON.stringify(custom));
  const imported = await importConfig(source, target);
  assert.equal(imported.name, 'Custom Desk');
  const loaded = await loadConfig(target);
  assert.deepEqual(loaded, imported);
  const svg = await resolveSvg(loaded);
  assert.equal(svg.toString(), '<svg></svg>');
});

/** Only repository raster URLs are allowed; query strings, traversal and remote hosts are rejected. */
test('Dashboard Icons accepts main and pinned raster URLs only', () => {
  const base = 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/';
  for (const path of ['main/png/aws.png', `${'a'.repeat(40)}/webp/gitlab.webp`]) {
    assert.ok(dashboardIcon(base + path));
  }
  for (const path of ['main/svg/aws.svg', 'main/png/../png/aws.png', 'main/png/aws.png?x=1',
    'main/png/aws.png#hash', 'main/png/.png', 'latest/png/aws.png']) {
    assert.equal(dashboardIcon(base + path), false, path);
  }
  assert.equal(dashboardIcon(base.replace('https:', 'http:') + 'main/png/aws.png'), false);
  assert.equal(dashboardIcon('aws'), false);
});

/** Reject unsafe or ambiguous release entries before publication and permit unavailable links. */
test('JSON catalogue validates stable keys, approved icons and HTTPS destinations', () => {
  const app = { key: 'example', name: 'Example', description: 'Example app',
    links: { dev: 'https://example.com/', int: null, stage: null, prod: null } };
  const catalogue = { schemaVersion: 1, apps: [app] };
  assert.equal(validateCatalogue(catalogue), catalogue);
  assert.equal(validateCatalogue({ ...catalogue, apps: [{ ...app, icon: '' }] }).apps[0].icon, '');
  assert.throws(() => validateCatalogue({ ...catalogue, apps: [{ ...app, badge: 'EX' }] }), /Unknown/);
  assert.throws(() => validateCatalogue({ ...catalogue, apps: [app, app] }), /unique/);
  assert.throws(() => validateCatalogue({ ...catalogue, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => validateCatalogue({ ...catalogue, apps: [{ ...app, icon: 'https://example.com/image' }] }), /Icons/);
  assert.throws(() => validateCatalogue({ ...catalogue, apps: [{ ...app, legacyName: 'old' }] }), /Unknown/);
  for (const dev of ['http://example.com', 'https://user:password@example.com', 'javascript:alert(1)']) {
    assert.throws(() => validateCatalogue({ ...catalogue, apps: [{ ...app, links: { ...app.links, dev } }] }), /HTTPS/);
  }
});

/** Shared configs may declare their own environments; app links and profiles must follow them. */
test('validateConfig supports custom environments', () => {
  const app = { key: 'tool', name: 'Tool', description: '', links: { dev: 'https://example.com/', qa: null } };
  const config = validateConfig({
    schemaVersion: 1,
    vpn: { defaultProfiles: { dev: 'Dev VPN' } },
    environments: [{ key: 'dev', title: 'DEV' }, { key: 'qa', title: 'QA' }],
    apps: [app],
  });
  assert.deepEqual(config.vpn.defaultProfiles, { dev: 'Dev VPN', qa: 'QA' });
  assert.throws(() => validateConfig({ ...config, apps: [{ ...app, links: { dev: null } }] }), /link field/);
  assert.throws(() => validateConfig({ ...config, environments: [{ key: 'dev', title: 'A' }, { key: 'dev', title: 'B' }] }), /unique/);
  assert.throws(() => validateConfig({ ...config, environments: [] }), /between 1 and 12/);
});

/** Initials track renames automatically, preserve short acronyms and support non-ASCII names. */
test('badge initials are derived without separately stored letters', () => {
  for (const [name, expected] of [['Ops Console', 'OC'], ['AWS', 'AWS'], ['AVS', 'AVS'],
    ['GitLab', 'GIT'], ['Engineering Console', 'EC'], ['One Two Three Four', 'OTT'],
    ['  extra---spaces  ', 'ES'], ['équipe outil', 'ÉO'], ['', '?'], ['!!!', '?']]) {
    assert.equal(badgeLetters(name), expected);
  }
});
