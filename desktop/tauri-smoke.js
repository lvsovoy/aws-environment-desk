import { invoke } from '@tauri-apps/api/core';
import { badgeLetters } from '../public/app-metadata.js';

/** Observe actual dashboard readiness with a deadline, not a busy polling loop. */
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Native dashboard smoke readiness exceeded 10 seconds.'));
    }, 10_000);
    /** Stop observation as soon as the requested UI state is present. */
    function check() {
      if (!predicate()) return;
      clearTimeout(deadline);
      observer.disconnect();
      resolve();
    }
    observer.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    check();
  });
}

/** Test the real system webview and native bridge without opening browsers or changing a VPN. */
export async function verifyNativeDashboard() {
  try {
    const config = await invoke('get_configuration');
    await waitFor(() => document.querySelectorAll('.app-card').length === config.resources.length
      && document.querySelector('.brand-mark').complete && document.querySelector('.brand-mark').naturalWidth > 0);
    for (const resource of config.resources) {
      const card = document.querySelector(`.app-card[data-resource="${resource.id}"]`);
      const image = card.querySelector('.app-icon-img');
      if (!resource.icon || resource.icon === 'badge') {
        if (image || card.querySelector('.app-icon span')?.textContent !== badgeLetters(resource.displayName || resource.name)) {
          throw new Error('Badge artwork must render generated initials.');
        }
      } else {
        if (!image || !/^\/app-icons\/[a-f0-9]{64}\.png$/.test(image.getAttribute('src'))) {
          throw new Error('Image artwork must use a bundled cached PNG, not a remote URL.');
        }
        await image.decode();
        if (!image.naturalWidth || image.naturalWidth > 128 || image.naturalHeight > 128) {
          throw new Error('Cached artwork failed to load within its pixel limit.');
        }
      }
    }
    const pill = document.querySelector('#vpn-action');
    const tabs = document.querySelector('.env-tabbar');
    if (!pill || pill.parentElement !== tabs.parentElement || pill.querySelector('img, svg')) {
      throw new Error('VPN action must be a text-only pill beside the environment selector.');
    }
    const tabBounds = tabs.getBoundingClientRect();
    const pillBounds = pill.getBoundingClientRect();
    if (pillBounds.left < tabBounds.right || Math.abs(pillBounds.top - tabBounds.top) > tabBounds.height) {
      throw new Error('VPN pill is not positioned to the right of the selector.');
    }
    if (Math.abs(pillBounds.height - tabBounds.height) > 1
      || Math.abs(pillBounds.top - tabBounds.top) > 1
      || pillBounds.left - tabBounds.right > 9) {
      throw new Error('VPN action must align with the unchanged environment picker.');
    }
    const colors = { connect: 'rgb(170, 255, 137)', disconnect: 'rgb(255, 154, 60)', switch: 'rgb(112, 200, 255)' };
    for (const [action, profiles] of [['connect', []], ['disconnect', ['DEV']], ['switch', ['PROD']]]) {
      window.dispatchEvent(new CustomEvent('stp:vpn-state', { detail: { selectedProfile: 'DEV', connectedProfiles: profiles, known: true } }));
      if (pill.dataset.action !== action || pill.disabled || getComputedStyle(pill).backgroundColor !== colors[action]) {
        throw new Error(`Incorrect VPN pill state: ${action}`);
      }
    }
    window.dispatchEvent(new CustomEvent('stp:vpn-state', { detail: { busy: true } }));
    if (!pill.disabled) throw new Error('VPN pill is enabled during an operation.');
    const refresh = document.querySelector('#refresh-vpn');
    if (!refresh || refresh.parentElement !== document.querySelector('#updated').parentElement
      || document.querySelector('.masthead-actions').textContent.includes('Stop VPN wait')) {
      throw new Error('VPN refresh must appear only beside the footer timestamp.');
    }
    refresh.click();
    if (!refresh.disabled) throw new Error('VPN refresh must prevent overlapping requests.');
    await waitFor(() => !refresh.disabled && !refresh.hasAttribute('aria-busy'));
    document.querySelector('#tab-stage').click();
    await waitFor(() => document.querySelector('#tab-stage').getAttribute('aria-selected') === 'true');
    document.querySelector('#tab-stage').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => document.querySelector('#tab-prod').getAttribute('aria-selected') === 'true');
    document.querySelector('#settings-btn').click();
    await waitFor(() => document.querySelector('#settings-dialog').open);
    const result = {
      cards: document.querySelectorAll('.app-card').length,
      tabs: document.querySelectorAll('.env-tab').length,
      settingsOpen: document.querySelector('#settings-dialog').open,
      nativePreferences: Boolean(document.querySelector('#native-update-startup')),
      nodeAccess: typeof window.require,
      vpnPillStates: true,
      footerRefresh: true,
      cachedIcons: true,
      error: '',
    };
    const unsafe = await invoke('save_profiles', { profiles: { dev: 'incomplete mapping' } }).then(() => false, () => true);
    if (!unsafe) throw new Error('Backend accepted an incomplete profile mapping.');
    // Exercise the UI's native save return shapes using only the isolated smoke configuration.
    if (document.querySelector('#native-stage') || document.querySelector('#native-install')
      || !document.querySelector('#native-update-startup')) {
      throw new Error('Updates must expose one combined action and a startup-check preference.');
    }
    document.querySelector('#native-update-startup').checked = !config.preferences.checkUpdatesAtStartup;
    document.querySelector('#save-settings-btn').click();
    await waitFor(() => document.querySelector('#settings-status').classList.contains('success'));
    const saved = await window.stpDesktop.getConfiguration();
    if (JSON.stringify(saved.profiles) !== JSON.stringify(config.profiles)
      || JSON.stringify(saved.resources) !== JSON.stringify(config.resources)
      || JSON.stringify(saved.preferences) !== JSON.stringify({
        ...config.preferences, checkUpdatesAtStartup: !config.preferences.checkUpdatesAtStartup,
      })
      || document.querySelector('#native-save')) {
      throw new Error('Native settings round-trip changed the configured profiles or resources.');
    }
    await window.stpDesktop.saveNativePreferences(config.preferences);
    result.startupUpdatePreference = true;
    result.settingsSaved = true;
    await waitFor(() => !document.querySelector('#settings-dialog').open);
    if (document.querySelector('#settings-dialog #resources-editor-list')
      || document.querySelector('#settings-dialog #add-resource-btn')) {
      throw new Error('Application editing must not appear in Settings.');
    }
    const appDialog = document.querySelector('#applications-dialog');
    /** Exercise real input handlers rather than only modifying DOM values. */
    function enter(selector, value) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    /** Open only the selected app's draft from its edit-mode card. */
    async function openEditor(id = '0') {
      document.querySelector(`.app-card[data-resource="${id}"]`).click();
      await waitFor(() => appDialog.open);
    }
    try {
      document.querySelector('#edit-applications-btn').click();
      if (appDialog.open || document.querySelector('#edit-applications-btn').getAttribute('aria-pressed') !== 'true'
        || document.querySelector('.app-card[data-resource="0"]').tagName !== 'BUTTON') {
        throw new Error('The pencil must enable per-card editing without opening a bulk modal.');
      }
      await openEditor();
      if (document.querySelectorAll('#app-name').length !== 1 || document.querySelector('#resources-editor-list')) {
        throw new Error('The editor must contain exactly one application.');
      }
      enter('#app-name', 'Discard this edit');
      document.querySelector('#cancel-applications-btn').click();
      await openEditor();
      if (document.querySelector('#app-name').value !== (config.resources[0].displayName || config.resources[0].name)) {
        throw new Error('Application Cancel failed to discard the draft.');
      }
      enter('#app-name', 'Smoke edited application');
      enter('#app-icon', 'https://example.com/icon.png');
      document.querySelector('#save-applications-btn').click();
      await waitFor(() => document.querySelector('#applications-status').classList.contains('error'));
      if (!appDialog.open) throw new Error('Invalid icon URL closed the editor.');
      enter('#app-icon', config.resources[1].icon);
      document.querySelector('#save-applications-btn').click();
      await waitFor(() => !appDialog.open);
      if (!document.querySelector('.app-card[data-resource="0"] .app-icon-img')) {
        throw new Error('A changed icon did not render immediately.');
      }
      await openEditor();
      if (document.querySelector('#app-icon').value !== config.resources[1].icon) throw new Error('Edited icon was not persisted.');
      enter('#app-icon', '');
      document.querySelector('#save-applications-btn').click();
      await waitFor(() => !appDialog.open);
      if (document.querySelector('.app-card[data-resource="0"] .app-icon span').textContent !== 'SEA') {
        throw new Error('Removing an icon must restore generated badge initials.');
      }
      document.querySelector('#add-resource-btn').click();
      await waitFor(() => appDialog.open);
      if (document.activeElement?.id !== 'app-name' || !document.querySelector('#delete-application-btn').hidden) {
        throw new Error('Add App must focus its new name and hide Remove.');
      }
      enter('#app-name', 'Smoke local app');
      enter('#app-url-dev', 'http://example.com/');
      document.querySelector('#save-applications-btn').click();
      await waitFor(() => document.querySelector('#applications-status').classList.contains('error'));
      enter('#app-url-dev', 'https://example.com/');
      enter('#app-url-prod', 'http://example.com/');
      document.querySelector('#save-applications-btn').click();
      await waitFor(() => document.querySelector('#applications-status').textContent.includes('(PROD)'));
      enter('#app-url-prod', '');
      enter('#app-icon', 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/png/github.png');
      document.querySelector('#save-applications-btn').click();
      await waitFor(() => !appDialog.open);
      const index = config.resources.length;
      const localImage = document.querySelector(`.app-card[data-resource="${index}"] .app-icon-img`);
      if (!localImage?.src.startsWith('data:image/png;base64,')) {
        throw new Error('A newly entered, nonbundled icon must render from the native cache immediately.');
      }
      await localImage.decode();
      const edited = await window.stpDesktop.getConfiguration();
      if (edited.resources.length !== config.resources.length + 1
        || edited.resources[0].name !== 'Smoke edited application'
        || edited.resources[index].links.dev !== 'https://example.com/'
        || edited.resources[index].links.prod !== null
        || edited.resources[index].icon !== 'https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/png/github.png'
        || edited.resources[1].icon !== config.resources[1].icon
        || edited.resources[1].catalogueKey !== config.resources[1].catalogueKey
        || JSON.stringify(edited.profiles) !== JSON.stringify(config.profiles)
        || JSON.stringify(edited.preferences) !== JSON.stringify(config.preferences)) {
        throw new Error('Application-only save lost metadata or modified unrelated settings.');
      }
      await openEditor(String(index));
      document.querySelector('#delete-application-btn').click();
      await waitFor(() => !appDialog.open);
      if ((await window.stpDesktop.getConfiguration()).resources.length !== config.resources.length) {
        throw new Error('Individual app removal failed.');
      }
      document.querySelector('#edit-applications-btn').click();
      if (document.querySelector('#add-resource-btn')
        || document.querySelector('.app-card[data-resource="0"]').tagName !== 'A') {
        throw new Error('Leaving edit mode must restore launch links.');
      }
      const deniedIcon = await window.stpDesktop.getAppIcon('https://example.com/icon.png').then(() => false, () => true);
      if (!deniedIcon) throw new Error('Native icon cache accepted an arbitrary remote host.');
      const nativeIcon = await window.stpDesktop.getAppIcon(config.resources.find(resource => resource.icon)?.icon);
      if (!nativeIcon.startsWith('data:image/png;base64,')) {
        throw new Error('Native icon cache must return sanitized PNG data.');
      }
      const decoded = new Image();
      decoded.src = nativeIcon;
      await decoded.decode();
      if (decoded.naturalWidth > 128 || decoded.naturalHeight > 128) {
        throw new Error('Native icon cache exceeded the display dimension limit.');
      }
      result.nativeIconCache = true;
      result.applicationEditor = true;
    } finally {
      await window.stpDesktop.saveResources(config.resources);
    }
    await invoke('complete_smoke', { result });
  } catch (error) {
    await invoke('complete_smoke', { result: { error: String(error) } });
  }
}
