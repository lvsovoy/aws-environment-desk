import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { vpnAction } from './vpn-action.js';

/** Mount tray and GitHub release preferences alongside explicit native VPN controls. */
export function setupNativePreferences() {
  const section = document.createElement('section');
  section.className = 'settings-section native-preferences';
  section.setAttribute('aria-labelledby', 'native-heading');
  section.innerHTML = `
    <div class="section-header">
      <h3 id="native-heading">Tray &amp; Updates</h3>
      <p class="section-desc" id="native-release-source"></p>
    </div>
    <label class="native-toggle"><input type="checkbox" id="native-autostart"> Start at sign-in</label>
    <label class="native-toggle"><input type="checkbox" id="native-shortcut"> Enable keyboard shortcut to focus app</label>
    <div class="form-group">
      <label for="native-shortcut-value">Focus shortcut</label>
      <input id="native-shortcut-value" class="form-input" type="text" spellcheck="false" autocomplete="off" maxlength="64">
    </div>
    <label class="native-toggle"><input type="checkbox" id="native-update-startup"> Check for updates at startup</label>
    <div class="native-actions">
      <button type="button" class="btn btn-secondary" id="native-check">Check for updates</button>
    </div>
    <p id="native-status" class="dialog-status" role="status" aria-live="polite"></p>`;
  document.querySelector('.dialog-body').append(section);
  const status = section.querySelector('#native-status');
  let busy = false;

  /** Refresh saved values only on first load, leaving unsaved user edits untouched afterward. */
  async function load(populate = false) {
    const data = await invoke('get_native_preferences');
    if (populate) {
      section.querySelector('#native-autostart').checked = data.preferences.startAtLogin;
      section.querySelector('#native-shortcut').checked = data.preferences.shortcutEnabled;
      section.querySelector('#native-shortcut-value').value = data.preferences.shortcut;
      section.querySelector('#native-update-startup').checked = data.preferences.checkUpdatesAtStartup;
    }
    section.querySelector('#native-release-source').textContent = data.updateRepository
      ? `Release source: github.com/${data.updateRepository}`
      : 'Updates are unavailable in this build because no GitHub repository was configured.';
    status.textContent = `Version ${data.version}. ${data.update.message}`;
  }

  /** Keep native actions responsive and show rejected commands as explicit status text. */
  async function action(command, args) {
    if (busy) return;
    busy = true;
    section.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status.textContent = 'Working in the background...';
    try {
      await invoke(command, args);
      await load();
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      section.querySelector('#native-check').disabled = false;
    }
  }

  section.querySelector('#native-check').addEventListener('click', () => { void action('check_updates'); });
  listen('stp-update', event => {
    status.textContent = event.payload.message;
  }).catch(error => { status.textContent = `Cannot subscribe to update status: ${String(error)}`; });
  document.querySelector('#settings-btn').addEventListener('click', () => {
    void load(true).catch(error => { status.textContent = String(error); });
  });
  void load(true).catch(error => { status.textContent = String(error); });

  const connect = document.createElement('button');
  connect.type = 'button';
  connect.id = 'vpn-action';
  connect.className = 'vpn-action';
  const label = document.createElement('span');
  connect.append(label);
  /** Keep action text, color, and accessible naming synchronized with confirmed status. */
  function renderAction(state) {
    const action = vpnAction(state);
    connect.dataset.action = action.action;
    connect.disabled = action.disabled;
    label.textContent = action.label;
    connect.setAttribute('aria-label', `${action.label} VPN${state.selectedProfile ? `: ${state.selectedProfile}` : ''}`);
    connect.title = 'Tabs browse only. This action changes the selected VPN profile.';
  }
  renderAction({});
  window.addEventListener('stp:vpn-state', event => { renderAction(event.detail); });
  connect.addEventListener('click', () => {
    window.dispatchEvent(new Event(connect.dataset.action === 'disconnect' ? 'stp:disconnect' : 'stp:connect'));
  });
  document.querySelector('.env-switcher').append(connect);
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'q') {
      event.preventDefault();
      invoke('quit_app').catch(error => {
        const panel = document.querySelector('#error');
        panel.textContent = String(error);
        panel.hidden = false;
      });
    }
  });
}
