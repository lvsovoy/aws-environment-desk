import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setupNativePreferences } from './tauri-preferences.js';
import { verifyNativeDashboard } from './tauri-smoke.js';

let nativeVisible = false;

/** Reconcile the initial native state even if the first show event preceded bridge registration. */
async function getConfiguration() {
  const config = await nativeCommand('get_configuration');
  nativeVisible = await nativeCommand('get_visibility');
  return config;
}

/** Normalize Rust's rejected error strings for the existing dashboard error presentation. */
async function nativeCommand(command, args) {
  try {
    return await invoke(command, args);
  } catch (error) {
    throw new Error(String(error));
  }
}

window.stpDesktop = Object.freeze({
  get isVisible() { return nativeVisible; },
  getConfiguration,
  getAppIcon: url => nativeCommand('get_app_icon', { url }),
  getStatus: () => nativeCommand('get_status'),
  refreshVpn: () => nativeCommand('refresh_vpn'),
  openResource: (environment, resourceId) => nativeCommand('open_resource', { environment, resourceId }),
  switchVpn: environment => nativeCommand('switch_vpn', { environment }),
  disconnectVpn: environment => nativeCommand('disconnect_vpn', { environment }),
  saveVpnProfiles: profiles => nativeCommand('save_profiles', { profiles }),
  saveNativePreferences: preferences => nativeCommand('save_native_preferences', { preferences }),
  detectSetup: () => nativeCommand('detect_setup'),
  listVpnProfiles: () => nativeCommand('list_vpn_profiles'),
  importVpnProfile: profileName => nativeCommand('import_vpn_profile', { profileName }),
  readSetupConfig: () => nativeCommand('read_setup_config'),
  completeSetup: setup => nativeCommand('complete_setup', { setup }),
  openInstallPage: target => nativeCommand('open_install_page', { target }),
  openConfigFile: () => nativeCommand('open_config_file'),
  reloadConfiguration: () => nativeCommand('reload_configuration'),
  getBranding: () => nativeCommand('get_branding'),
  setWindowIcon: png => nativeCommand('set_window_icon', { png }),
  setTrayIcon: (colorPng, templatePng, label) => nativeCommand('set_tray_icon', { colorPng, templatePng, label }),
  saveResources: resources => nativeCommand('save_resources', {
    resources: resources.map(resource => ({
      ...resource,
      links: Object.fromEntries(Object.entries(resource.links).map(([env, value]) => [env, value?.trim() || null])),
    })),
  }),
});

listen('stp-visibility', event => {
  nativeVisible = event.payload === true;
  window.dispatchEvent(new Event('stp:visibility'));
}).catch(error => {
  const panel = document.querySelector('#error');
  panel.textContent = `Cannot subscribe to native visibility: ${String(error)}`;
  panel.hidden = false;
});

listen('stp-error', event => {
  const panel = document.querySelector('#error');
  panel.textContent = String(event.payload);
  panel.hidden = false;
}).catch(error => {
  const panel = document.querySelector('#error');
  panel.textContent = `Cannot subscribe to native errors: ${String(error)}`;
  panel.hidden = false;
});

setupNativePreferences();
import('../public/app.js').then(() => {
  if (window.__DESK_SMOKE__) void verifyNativeDashboard();
}).catch(error => {
  const panel = document.querySelector('#error');
  panel.textContent = `Cannot initialize the native dashboard: ${String(error)}`;
  panel.hidden = false;
});
