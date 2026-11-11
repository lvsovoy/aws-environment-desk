import cachedIcons from 'stp:icons';
import appConfig from 'stp:config';
import { badgeLetters, dashboardIcon } from './app-metadata.js';
import { createSetupWizard } from './setup-wizard.js';
import {
  createIcons,
  ArrowUpRight,
  Monitor,
  ShieldCheck,
  RotateCcw,
  Settings,
  Sun,
  Moon,
  Laptop,
  Plus,
  Pencil,
  X,
  Check,
} from 'lucide';

const icons = {
  ArrowUpRight,
  Monitor,
  ShieldCheck,
  RotateCcw,
  Settings,
  Sun,
  Moon,
  Laptop,
  Plus,
  Pencil,
  X,
  Check,
};

// Environment keys from the runtime configuration; tabs, links and profiles follow this order.
let environments = [];
const knownDotClasses = new Set(['dev', 'int', 'stage', 'prod']);
let openSetupWizard;

let configuration;
let activeEnvironment = 'dev';
let pending = false;
let switchingTargetEnv = null;
let serverBusy = false;
let timer;
let refreshing = false;
let refreshAgain = false;
let editingApplications = false;
let editingResourceId = null;
let applicationSaving = false;
let applicationOpening = false;
const loadedIcons = new Map(Object.entries(cachedIcons));
const loadingIcons = new Set();
const failedIcons = new Set();
let vpnConnectedProfiles = [];
let vpnStatusKnown = false;

/** Create an accessible decorative icon from the locally bundled Lucide collection. */
function icon(name) {
  const element = document.createElement('i');
  element.dataset.lucide = name;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/** Display errors as text, never as trusted markup. */
function showError(message = '') {
  const panel = document.querySelector('#error');
  panel.textContent = message;
  panel.hidden = !message;
}

/** Configured environment definition for a key. */
function environmentDefinition(key) {
  return configuration?.environments?.find(env => env.key === key);
}

/** Human-readable environment title, falling back to the uppercase key. */
function environmentTitle(key) {
  return environmentDefinition(key)?.title || key.toUpperCase();
}

/** Render one tab per configured environment with roving tabindex keyboard navigation. */
function renderTabs() {
  const bar = document.querySelector('.env-tabbar');
  bar.replaceChildren();
  environments.forEach((key, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.className = 'env-tab';
    tab.id = `tab-${key}`;
    tab.dataset.env = key;
    tab.setAttribute('aria-controls', 'app-grid');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    const dot = document.createElement('span');
    dot.className = `env-dot env-dot-${knownDotClasses.has(key) ? key : `c${index % 6}`}`;
    const color = environmentDefinition(key)?.color;
    if (color) dot.style.backgroundColor = color;
    dot.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'env-tab-title';
    title.textContent = environmentTitle(key);
    const sub = document.createElement('span');
    sub.className = 'env-tab-sub';
    sub.textContent = environmentDefinition(key)?.sub || `${environmentTitle(key)} VPN`;
    tab.append(dot, title, sub);
    tab.addEventListener('click', () => { selectEnvironment(key); });
    tab.addEventListener('keydown', event => {
      const tabs = [...bar.querySelectorAll('.env-tab')];
      let nextIndex = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        tabs[nextIndex].focus();
        selectEnvironment(tabs[nextIndex].dataset.env);
      }
    });
    bar.append(tab);
  });
}

// Loaded logo and background used to redraw the tray icon when the connection dot changes.
let trayArt = null;
let trayState;

/** Load an image source fully before it is drawn to a canvas. */
async function loadImage(source) {
  const image = new Image();
  image.src = source;
  await image.decode();
  return image;
}

/** Draw the logo contained within a box on a canvas context. */
function drawLogo(context, image, x, y, boxWidth, boxHeight) {
  const naturalWidth = image.naturalWidth || boxWidth;
  const naturalHeight = image.naturalHeight || boxHeight;
  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  context.drawImage(image, x + (boxWidth - width) / 2, y + (boxHeight - height) / 2, width, height);
}

/** Square app icon matching the build-time layout: logo fits 640x800 inside 1024x1024. */
function renderAppIcon(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.fillStyle = trayArt.background;
  context.fillRect(0, 0, size, size);
  drawLogo(context, trayArt.image, size * 0.1875, size * 0.109375, size * 0.625, size * 0.78125);
  return canvas;
}

/**
 * Tray icon with an optional bottom-right dot in the connected environment's colour.
 * The template variant is the plain black alpha mask used for macOS menu bars while disconnected.
 */
function renderTrayIcon(dotColor, template) {
  const size = 64;
  if (!template && !dotColor) return renderAppIcon(size).toDataURL('image/png');
  const canvas = template ? document.createElement('canvas') : renderAppIcon(size);
  const context = canvas.getContext('2d');
  if (template) {
    canvas.width = size;
    canvas.height = size;
    drawLogo(context, trayArt.image, 0, 0, size, size);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = '#000000';
    context.fillRect(0, 0, size, size);
    return canvas.toDataURL('image/png');
  }
  // Large enough to stay visible when the OS scales the tray icon down to 16 px.
  const radius = 15;
  const centre = size - radius - 3;
  context.beginPath();
  context.arc(centre, centre, radius + 3, 0, Math.PI * 2);
  context.fillStyle = '#111613';
  context.fill();
  context.beginPath();
  context.arc(centre, centre, radius, 0, Math.PI * 2);
  context.fillStyle = dotColor;
  context.fill();
  return canvas.toDataURL('image/png');
}

/** Connected environment, preferring the selected tab when several share a profile; null when disconnected. */
function connectedEnvironment() {
  const connected = new Set(vpnConnectedProfiles);
  if (!connected.size) return null;
  const matches = environments.filter(env => connected.has(configuration?.profiles?.[env]));
  const key = matches.includes(activeEnvironment) ? activeEnvironment : matches[0];
  if (!key) return { label: 'VPN', color: '#22c55e' };
  return { label: environmentTitle(key), color: environmentDefinition(key)?.color || '#22c55e' };
}

/** Redraw the tray icon only when the connected environment or its colour changes. */
async function updateTrayBadge(force = false) {
  if (!trayArt) return;
  const connected = connectedEnvironment();
  const state = connected ? `${connected.label}|${connected.color}` : '';
  if (!force && state === trayState) return;
  trayState = state;
  try {
    await window.stpDesktop.setTrayIcon(
      renderTrayIcon(connected?.color, false), renderTrayIcon(null, true), connected?.label ?? null);
  } catch (error) {
    trayState = undefined;
    showError(`Cannot update tray icon: ${error.message}`);
  }
}

/** Apply the configured name, window and tray icons (config.json `name` and `brand.svg`). */
async function applyBranding() {
  try {
    const branding = await window.stpDesktop.getBranding();
    document.title = branding.name;
    document.querySelector('.brand')?.setAttribute('aria-label', branding.name);
    const mark = document.querySelector('.brand-mark');
    mark?.setAttribute('alt', branding.name);
    const source = branding.iconSvg
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(branding.iconSvg)}`
      : '/logo.svg';
    if (branding.iconSvg) {
      if (mark) mark.src = source;
      document.querySelector('link[rel="icon"]')?.setAttribute('href', source);
    }
    trayArt = { image: await loadImage(source), background: branding.backgroundColor };
    if (branding.iconSvg) await window.stpDesktop.setWindowIcon(renderAppIcon(256).toDataURL('image/png'));
    await updateTrayBadge(true);
  } catch (error) {
    showError(`Cannot apply configured branding: ${error.message}`);
  }
}

/** Adopt a configuration from the backend and refresh every environment-dependent view. */
function applyConfiguration(config) {
  configuration = config;
  void applyBranding();
  environments = (config.environments || []).map(env => env.key);
  renderTabs();
  document.querySelector('#setup-cta').hidden = Boolean(config.setupComplete);
  selectEnvironment(environments.includes(activeEnvironment) ? activeEnvironment : environments[0]);
  updateTabVpnIndicators(vpnConnectedProfiles, false);
}

/** Keep all resource actions locked while a machine-wide VPN switch is underway. */
function updateCardStates() {
  for (const card of document.querySelectorAll('.app-card')) {
    const isConfigured = card.dataset.configured === 'true';
    card.setAttribute('aria-disabled', String(!editingApplications && (pending || serverBusy || !isConfigured)));
  }
  window.dispatchEvent(new CustomEvent('stp:vpn-state', { detail: {
    selectedProfile: configuration?.profiles[activeEnvironment],
    connectedProfiles: vpnConnectedProfiles,
    known: vpnStatusKnown,
    busy: pending || serverBusy,
  } }));
  void updateTrayBadge();
}

/** Initialize and handle Light / Dark / System theme switching. */
function initTheme() {
  const savedTheme = localStorage.getItem('stp_theme') || 'system';
  applyTheme(savedTheme);

  const themeInputs = document.querySelectorAll('input[name="stp-theme"]');
  themeInputs.forEach(input => {
    input.checked = input.value === savedTheme;
    input.addEventListener('change', () => {
      const selected = input.value;
      localStorage.setItem('stp_theme', selected);
      applyTheme(selected);
    });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const current = localStorage.getItem('stp_theme') || 'system';
    if (current === 'system') {
      applyTheme('system');
    }
  });
}

/** Apply selected theme to document. */
function applyTheme(theme) {
  if (theme === 'system') {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = systemDark ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

/** Ask the native backend to open a configured resource only after confirmed VPN success. */
async function openResource(event, environment, resource) {
  event.preventDefault();
  if (pending || serverBusy) return;
  showError();
  pending = true;
  updateCardStates();
  try {
    const operation = window.stpDesktop.openResource(environment, resource.id);
    void refresh();
    await operation;
  } catch (error) {
    showError(error.message);
  } finally {
    pending = false;
    updateCardStates();
    void refresh();
  }
}

/** Explicitly connect/switch or disconnect the selected profile; native tabs only browse. */
async function triggerVpnSwitch(environment, disconnect = false) {
  if (pending || serverBusy) return;
  showError();
  const desktop = window.stpDesktop;
  pending = true;
  switchingTargetEnv = environment;
  updateCardStates();
  updateTabVpnIndicators([], true);
  try {
    const operation = disconnect ? desktop.disconnectVpn(environment) : desktop.switchVpn(environment);
    void refresh();
    await operation;
  } catch (error) {
    showError(error.message);
  } finally {
    pending = false;
    switchingTargetEnv = null;
    updateCardStates();
    void refresh();
  }
}

/** Change the active environment tab and re-render the application grid. */
function selectEnvironment(environment) {
  if (!environments.includes(environment)) return;
  activeEnvironment = environment;
  sessionStorage.setItem('stp_active_env', environment);

  for (const env of environments) {
    const tab = document.querySelector(`#tab-${env}`);
    if (!tab) continue;
    const selected = env === environment;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }

  renderAppGrid();
  updateCardStates();

}

/** Render the application cards for the currently selected environment. */
function renderAppGrid() {
  const grid = document.querySelector('#app-grid');
  const focusedCard = grid.contains(document.activeElement) ? document.activeElement.closest('.app-card') : null;
  const focusId = focusedCard?.dataset.resource;
  const focusAdd = focusedCard?.id === 'add-resource-btn';
  grid.replaceChildren();

  if (!configuration || !configuration.resources) return;

  for (const resource of configuration.resources) {
    const imageUrl = resource.icon && resource.icon !== 'badge' ? resource.icon : '';
    const meta = {
      label: resource.displayName || resource.name,
      type: loadedIcons.has(imageUrl) ? 'img' : 'badge',
      src: loadedIcons.get(imageUrl),
      badgeClass: resource.catalogueKey === 'avs' ? 'badge-avs' : 'badge-ops',
      letter: badgeLetters(resource.displayName || resource.name),
      desc: resource.description || resource.name,
    };

    const url = resource.links[activeEnvironment];
    const isConfigured = Boolean(url);

    const card = document.createElement(editingApplications ? 'button' : 'a');
    card.className = 'app-card';
    card.dataset.resource = resource.id;
    card.dataset.configured = String(isConfigured);
    card.setAttribute('aria-disabled', String(!editingApplications && (!isConfigured || pending || serverBusy)));

    if (editingApplications) {
      card.type = 'button';
      card.setAttribute('aria-label', `Edit ${meta.label}`);
      card.addEventListener('click', () => { void openApplicationEditor(resource.id); });
    } else if (isConfigured) {
      card.href = url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.setAttribute('aria-label', `Launch ${meta.label} in ${environmentTitle(activeEnvironment)}`);
      card.addEventListener('click', event => { void openResource(event, activeEnvironment, resource); });
      card.addEventListener('auxclick', event => { event.preventDefault(); });
    } else {
      card.removeAttribute('href');
      card.tabIndex = -1;
      card.setAttribute('aria-label', `${meta.label} is not configured in ${environmentTitle(activeEnvironment)}`);
    }

    const cardTop = document.createElement('div');
    cardTop.className = 'app-card-top';

    if (meta.type === 'img') {
      const img = document.createElement('img');
      img.className = 'app-icon app-icon-img';
      img.src = meta.src;
      img.addEventListener('error', () => {
        loadedIcons.delete(imageUrl);
        failedIcons.add(imageUrl);
        showError(`Icon for ${meta.label} could not be loaded. Showing automatic initials.`);
        renderAppGrid();
      }, { once: true });
      img.alt = meta.label;
      cardTop.append(img);
    } else {
      const badge = document.createElement('div');
      badge.className = `app-icon ${meta.badgeClass}`;
      badge.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = meta.letter;
      badge.append(text);
      cardTop.append(badge);
    }

    const metaBox = document.createElement('div');
    metaBox.className = 'app-meta';
    const title = document.createElement('h3');
    title.className = 'app-title';
    title.textContent = meta.label;
    const desc = document.createElement('div');
    desc.className = 'app-desc';
    desc.textContent = isConfigured ? new URL(url).hostname : meta.desc;
    metaBox.append(title, desc);
    cardTop.append(metaBox);

    const cardFooter = document.createElement('div');
    cardFooter.className = 'app-footer';

    if (editingApplications || isConfigured) {
      const action = document.createElement('span');
      action.className = 'app-action';
      const actionText = document.createElement('span');
      actionText.textContent = editingApplications ? 'Edit app' : 'Launch';
      action.append(actionText, icon(editingApplications ? 'pencil' : 'arrow-up-right'));
      cardFooter.append(action);
    } else {
      const unavailable = document.createElement('span');
      unavailable.className = 'app-action-unavailable';
      unavailable.textContent = `Unavailable in ${environmentTitle(activeEnvironment)}`;
      cardFooter.append(unavailable);
    }

    card.append(cardTop, cardFooter);
    grid.append(card);
    if (imageUrl && !loadedIcons.has(imageUrl) && !loadingIcons.has(imageUrl) && !failedIcons.has(imageUrl)) {
      void loadApplicationIcon(imageUrl, meta.label);
    }
  }

  if (editingApplications) {
    const add = document.createElement('button');
    add.type = 'button';
    add.id = 'add-resource-btn';
    add.className = 'app-card add-app-card';
    add.append(icon('plus'), document.createTextNode('Add App'));
    add.addEventListener('click', () => { void openApplicationEditor(); });
    grid.append(add);
  }
  createIcons({ icons });
  if (focusId !== undefined) document.querySelector(`.app-card[data-resource="${focusId}"]`)?.focus();
  else if (focusAdd) document.querySelector('#add-resource-btn')?.focus();
}

/** Resolve uncatalogued artwork through the bounded native cache without delaying dashboard readiness. */
async function loadApplicationIcon(url, name) {
  loadingIcons.add(url);
  try {
    loadedIcons.set(url, await window.stpDesktop.getAppIcon(url));
  } catch (error) {
    failedIcons.add(url);
    showError(`Icon for ${name}: ${error.message}. Showing automatic initials.`);
  } finally {
    loadingIcons.delete(url);
    renderAppGrid();
  }
}

/** Update VPN connection badges and status indicators on the top tab bar. */
function updateTabVpnIndicators(connectedProfiles, isSwitching) {
  if (!configuration || !configuration.profiles) return;
  for (const env of environments) {
    const tab = document.querySelector(`#tab-${env}`);
    if (!tab) continue;
    const sub = tab.querySelector('.env-tab-sub');
    const baseLabel = environmentDefinition(env)?.sub || `${environmentTitle(env)} VPN`;
    const profile = configuration.profiles[env];
    const isConnected = connectedProfiles.includes(profile);
    const isTargetSwitch = isSwitching && (switchingTargetEnv === env || (pending && activeEnvironment === env));

    if (isTargetSwitch) {
      tab.dataset.vpnState = 'switching';
      if (sub) sub.textContent = 'Switching...';
    } else if (isConnected) {
      tab.dataset.vpnState = 'connected';
      if (sub) sub.textContent = `${baseLabel} · Connected`;
    } else {
      tab.dataset.vpnState = 'disconnected';
      if (sub) sub.textContent = baseLabel;
    }
  }
}

/** Poll gently while visible, faster during switches, and never overlap status requests. */
async function refresh() {
  clearTimeout(timer);
  if (!pollingVisible()) return;
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const state = await window.stpDesktop.getStatus();
    serverBusy = state.busy;
    const connected = state.connections.filter(connection => connection.status === 'Connected');
    const connectedProfiles = connected.map(connection => connection.profile);
    vpnConnectedProfiles = connectedProfiles;
    vpnStatusKnown = !state.error && !state.connections.some(connection => connection.status !== 'Connected' && connection.status !== 'NotConnected');
    const switching = state.busy || pending || state.connections.some(connection => connection.status !== 'Connected');

    const footerStatus = document.querySelector('#footer-status');
    if (footerStatus) {
      if (switching) {
          footerStatus.textContent = state.message || 'Switching VPN...';
        } else if (connectedProfiles.length > 0) {
          footerStatus.textContent = `Connected: ${connectedProfiles.join(', ')}`;
      } else {
        footerStatus.innerHTML = '<span class="footer-dot"></span> AWS VPN Client · Disconnected';
      }
    }

    document.querySelector('#updated').textContent = `Checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (state.error) showError(state.error);

    // Sync tab indicators with current VPN connection state
    updateTabVpnIndicators(connectedProfiles, switching);

    updateCardStates();
  } catch (error) {
    vpnStatusKnown = false;
    updateCardStates();
    const footerStatus = document.querySelector('#footer-status');
    if (footerStatus) footerStatus.innerHTML = '<span class="footer-dot"></span> VPN status unavailable';
    showError(error.message);
  } finally {
    refreshing = false;
    if (pollingVisible()) timer = setTimeout(refresh, refreshAgain ? 0 : pending || serverBusy ? 1500 : 15_000);
    refreshAgain = false;
  }
}

/** Cancel active observation, wait for native locks to release, then request fresh status. */
async function refreshVpnStatuses() {
  const button = document.querySelector('#refresh-vpn');
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  showError();
  try {
    await window.stpDesktop.refreshVpn();
    await refresh();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/** Honor native visibility as well as browser visibility; WebView2 does not reliably propagate hiding. */
function pollingVisible() {
  return !document.hidden && window.stpDesktop.isVisible;
}

/** Open Settings modal dialog and load current settings. */
async function openSettings() {
  const dialog = document.querySelector('#settings-dialog');
  const statusEl = document.querySelector('#settings-status');
  statusEl.textContent = '';
  statusEl.className = 'dialog-status';

  try {
    configuration = await window.stpDesktop.getConfiguration();
  } catch (error) {
    statusEl.textContent = error.message || 'Could not load VPN settings.';
    statusEl.className = 'dialog-status error';
  }

  // One profile input per configured environment.
  const profiles = configuration?.profiles || {};
  const defaults = appConfig?.vpn?.defaultProfiles || {};
  const grid = document.querySelector('#vpn-profiles-grid');
  grid.replaceChildren();
  for (const env of environments) {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.htmlFor = `vpn-profile-${env}`;
    label.textContent = `${environmentTitle(env)} Profile`;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = label.htmlFor;
    input.className = 'form-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.maxLength = 256;
    input.value = profiles[env] || defaults[env] || environmentTitle(env);
    group.append(label, input);
    grid.append(group);
  }
  document.querySelector('#config-file-status').textContent = '';

  createIcons({ icons });
  dialog.showModal();
}

/** Save Settings changes and update application state. */
async function saveSettings() {
  const saveButton = document.querySelector('#save-settings-btn');
  if (saveButton.disabled) return;
  const statusEl = document.querySelector('#settings-status');
  statusEl.textContent = 'Saving...';
  statusEl.className = 'dialog-status';

  // Validate and collect VPN profile inputs
  const newProfiles = Object.fromEntries(environments.map(env => [env, document.querySelector(`#vpn-profile-${env}`)?.value.trim() || '']));

  if (Object.values(newProfiles).some(profile => !profile)) {
    statusEl.textContent = 'Please fill in all VPN profile names.';
    statusEl.className = 'dialog-status error';
    return;
  }

  try {
    saveButton.disabled = true;
    await window.stpDesktop.saveNativePreferences({
      startAtLogin: document.querySelector('#native-autostart').checked,
      shortcutEnabled: document.querySelector('#native-shortcut').checked,
      shortcut: document.querySelector('#native-shortcut-value').value.trim(),
      checkUpdatesAtStartup: document.querySelector('#native-update-startup').checked,
    });
    configuration.profiles = await window.stpDesktop.saveVpnProfiles(newProfiles);

    renderAppGrid();
    void refresh();

    statusEl.textContent = 'Settings saved successfully!';
    statusEl.className = 'dialog-status success';

    setTimeout(() => {
      const dialog = document.querySelector('#settings-dialog');
      if (dialog.open) dialog.close();
    }, 500);
  } catch (error) {
    statusEl.textContent = error.message || 'Could not save settings.';
    statusEl.className = 'dialog-status error';
  } finally {
    saveButton.disabled = false;
  }
}

/** Set up settings dialog events. */
function setupSettings() {
  const settingsBtn = document.querySelector('#settings-btn');
  const closeBtn = document.querySelector('#close-settings-btn');
  const cancelBtn = document.querySelector('#cancel-settings-btn');
  const saveBtn = document.querySelector('#save-settings-btn');
  const dialog = document.querySelector('#settings-dialog');

  settingsBtn.addEventListener('click', () => { void openSettings(); });
  closeBtn.addEventListener('click', () => dialog.close());
  cancelBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });

  saveBtn.addEventListener('click', () => { void saveSettings(); });
  setupApplicationsEditor();
  setupConfigurationActions();
}

/** Wire the setup wizard CTA and the Settings actions for re-running setup and editing config.json. */
function setupConfigurationActions() {
  openSetupWizard = createSetupWizard({
    onComplete(config) {
      applyConfiguration(config);
      showError();
      void refresh();
    },
  });
  const settings = document.querySelector('#settings-dialog');
  const fileStatus = document.querySelector('#config-file-status');
  document.querySelector('#setup-cta-btn').addEventListener('click', () => { void openSetupWizard(configuration); });
  document.querySelector('#run-setup-btn').addEventListener('click', () => {
    settings.close();
    void openSetupWizard(configuration);
  });
  document.querySelector('#open-config-btn').addEventListener('click', async () => {
    fileStatus.className = 'dialog-status';
    try {
      fileStatus.textContent = `Opened ${await window.stpDesktop.openConfigFile()}`;
    } catch (error) {
      fileStatus.textContent = error.message;
      fileStatus.className = 'dialog-status error';
    }
  });
  document.querySelector('#reload-config-btn').addEventListener('click', async () => {
    fileStatus.className = 'dialog-status';
    try {
      applyConfiguration(await window.stpDesktop.reloadConfiguration());
      settings.close();
      void refresh();
    } catch (error) {
      fileStatus.textContent = error.message;
      fileStatus.className = 'dialog-status error';
    }
  });
}

/** Load a fresh editing draft independently of VPN and device settings; Cancel discards it. */
async function openApplicationEditor(id = null) {
  if (applicationOpening || applicationSaving || document.querySelector('#applications-dialog').open) return;
  applicationOpening = true;
  try {
    configuration = await window.stpDesktop.getConfiguration();
    const resource = id === null ? null : configuration.resources.find(item => item.id === id);
    if (id !== null && !resource) throw new Error('This application no longer exists. Reopen edit mode.');
    editingResourceId = id;
    const status = document.querySelector('#applications-status');
    status.textContent = '';
    status.className = 'dialog-status';
    document.querySelector('#applications-title').textContent = resource ? 'Edit application' : 'Add application';
    document.querySelector('#app-name').value = resource?.displayName || resource?.name || '';
    document.querySelector('#app-icon').value = resource?.icon === 'badge' ? '' : resource?.icon || '';
    document.querySelector('#delete-application-btn').hidden = !resource;
    const fields = document.querySelector('#app-url-fields');
    fields.replaceChildren();
    for (const env of environments) {
      const group = document.createElement('div');
      group.className = 'form-group';
      const label = document.createElement('label');
      label.htmlFor = `app-url-${env}`;
      label.textContent = `${environmentTitle(env)} URL`;
      const input = document.createElement('input');
      input.id = label.htmlFor;
      input.type = 'url';
      input.className = 'form-input';
      input.value = resource?.links[env] || '';
      input.placeholder = 'https://...';
      input.spellcheck = false;
      group.append(label, input);
      fields.append(group);
    }
    updateBadgePreview();
    document.querySelector('#applications-dialog').showModal();
    document.querySelector('#app-name').focus();
  } catch (error) {
    showError(error.message || 'Could not load application.');
  } finally {
    applicationOpening = false;
  }
}

/** Preview the same deterministic initials used on cards; badge text is never persisted. */
function updateBadgePreview() {
  document.querySelector('#app-badge-preview').textContent =
    `Automatic badge: ${badgeLetters(document.querySelector('#app-name').value)}`;
}

/** Save one app against fresh configuration, retaining every other app and all catalogue metadata. */
async function saveApplication(remove = false) {
  const button = document.querySelector('#save-applications-btn');
  if (applicationSaving) return;
  const status = document.querySelector('#applications-status');
  status.className = 'dialog-status';
  status.textContent = '';
  const name = document.querySelector('#app-name').value.trim();
  const image = document.querySelector('#app-icon').value.trim();
  const links = Object.fromEntries(environments.map(env => [env, document.querySelector(`#app-url-${env}`).value.trim() || null]));
  if (!remove) {
    if (!name) {
      status.textContent = 'Application requires a name.';
      status.className = 'dialog-status error';
      return;
    }
    if (image && !dashboardIcon(image)) {
      status.textContent = 'Provide a Dashboard Icons PNG/WebP URL, or leave Icon URL empty for initials.';
      status.className = 'dialog-status error';
      return;
    }
    for (const [env, value] of Object.entries(links)) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid destination');
      } catch {
        status.textContent = `Invalid HTTPS URL for ${name} (${environmentTitle(env)}).`;
        status.className = 'dialog-status error';
        return;
      }
    }
  }
  applicationSaving = true;
  button.disabled = true;
  const dialog = document.querySelector('#applications-dialog');
  const controls = [...dialog.querySelectorAll('input, button')].filter(control => control !== button);
  for (const control of controls) control.disabled = true;
  status.textContent = 'Saving...';
  try {
    const latest = await window.stpDesktop.getConfiguration();
    const index = editingResourceId === null ? -1 : latest.resources.findIndex(resource => resource.id === editingResourceId);
    if (editingResourceId !== null && index < 0) throw new Error('This application no longer exists.');
    const resources = latest.resources.map(resource => ({ ...resource, links: { ...resource.links } }));
    if (remove) {
      if (index < 0) throw new Error('Select an existing application to remove.');
      resources.splice(index, 1);
    } else {
      if (index < 0 && resources.length >= 100) throw new Error('A maximum of 100 applications is supported.');
      if (image && !loadedIcons.has(image)) {
        loadedIcons.set(image, await window.stpDesktop.getAppIcon(image));
        failedIcons.delete(image);
      }
      const current = index < 0 ? { id: String(resources.length), description: '' } : resources[index];
      const updated = { ...current, name, displayName: null, icon: image, links };
      if (index < 0) resources.push(updated);
      else resources[index] = updated;
    }
    latest.resources = await window.stpDesktop.saveResources(resources);
    configuration = latest;
    renderAppGrid();
    dialog.close();
  } catch (error) {
    status.textContent = error.message || 'Could not save applications.';
    status.className = 'dialog-status error';
  } finally {
    applicationSaving = false;
    button.disabled = false;
    for (const control of controls) control.disabled = false;
  }
}

/** Wire a keyboard-accessible app editor with an isolated draft and explicit save action. */
function setupApplicationsEditor() {
  const dialog = document.querySelector('#applications-dialog');
  const toggle = document.querySelector('#edit-applications-btn');
  toggle.addEventListener('click', () => {
    editingApplications = !editingApplications;
    toggle.setAttribute('aria-pressed', String(editingApplications));
    toggle.title = editingApplications ? 'Finish editing applications' : 'Edit applications';
    document.querySelector('#applications-edit-hint').hidden = !editingApplications;
    renderAppGrid();
    updateCardStates();
  });
  document.querySelector('#app-name').addEventListener('input', updateBadgePreview);
  for (const id of ['close-applications-btn', 'cancel-applications-btn']) {
    document.getElementById(id).addEventListener('click', () => dialog.close());
  }
  dialog.addEventListener('cancel', event => {
    if (applicationSaving) event.preventDefault();
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog && !applicationSaving) dialog.close();
  });
  dialog.addEventListener('close', () => {
    const card = editingResourceId === null ? null : document.querySelector(`.app-card[data-resource="${editingResourceId}"]`);
    (card || document.querySelector('#add-resource-btn') || toggle).focus();
  });
  document.querySelector('#save-applications-btn').addEventListener('click', () => { void saveApplication(); });
  document.querySelector('#delete-application-btn').addEventListener('click', () => { void saveApplication(true); });
}

/** Load only the local allowlisted resources and begin live connection monitoring. */
async function initialize() {
  if (appConfig) {
    if (appConfig.name) document.title = appConfig.name;
    const brand = document.querySelector('.brand');
    if (brand && (appConfig.brand?.name || appConfig.name)) {
      brand.setAttribute('aria-label', appConfig.brand?.name || appConfig.name);
    }
    const brandMark = document.querySelector('.brand-mark');
    if (brandMark && (appConfig.brand?.markAlt || appConfig.name)) {
      brandMark.setAttribute('alt', appConfig.brand?.markAlt || appConfig.name);
    }
    const footerStatus = document.querySelector('#footer-status');
    if (footerStatus && appConfig.vpn?.clientName) {
      footerStatus.innerHTML = `<span class="footer-dot"></span> ${appConfig.vpn.clientName}`;
    }
  }
  initTheme();
  createIcons({ icons });
  setupSettings();
  document.querySelector('#refresh-vpn').addEventListener('click', () => { void refreshVpnStatuses(); });
  try {
    activeEnvironment = sessionStorage.getItem('stp_active_env') || activeEnvironment;
    applyConfiguration(await window.stpDesktop.getConfiguration());
    await refresh();
  } catch (error) {
    document.querySelector('#app-grid').replaceChildren();
    const footerStatus = document.querySelector('#footer-status');
    if (footerStatus) footerStatus.innerHTML = '<span class="footer-dot"></span> App unavailable';
    // Setup can replace an unreadable configuration.
    document.querySelector('#setup-cta').hidden = false;
    showError(error.message);
  }
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(timer);
  if (pollingVisible() && configuration) void refresh();
});
window.addEventListener('stp:visibility', () => {
  clearTimeout(timer);
  if (pollingVisible() && configuration) void refresh();
});
window.addEventListener('pagehide', () => { clearTimeout(timer); });
window.addEventListener('stp:connect', () => { void triggerVpnSwitch(activeEnvironment); });
window.addEventListener('stp:disconnect', () => { void triggerVpnSwitch(activeEnvironment, true); });
void initialize();
