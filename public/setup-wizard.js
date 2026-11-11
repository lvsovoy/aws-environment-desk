const STEP_TITLES = {
  apps: 'Terminal & browser',
  vpn: 'AWS VPN Client',
  cli: 'AWS CLI',
  source: 'Configuration',
  environments: 'Environments',
  profiles: 'VPN profiles',
  review: 'Finish',
};
const DEFAULT_COLORS = { dev: '#10b981', int: '#06b6d4', stage: '#f59e0b', prod: '#ef4444' };
const EXTRA_COLORS = ['#a78bfa', '#f472b6', '#84cc16', '#38bdf8', '#fb923c', '#e5e7eb'];
const DEFAULT_ENVIRONMENTS = ['dev', 'int', 'stage', 'prod'].map(key => ({ key, title: key.toUpperCase(), color: DEFAULT_COLORS[key] }));

/** Default dot colour, matching the backend's choice for environments without one. */
function defaultColor(key, index) {
  return DEFAULT_COLORS[key] || EXTRA_COLORS[index % EXTRA_COLORS.length];
}
const MAX_ENVIRONMENTS = 12;

/** Create an element with optional class and text content; text is never parsed as markup. */
function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Create a styled button that runs an action on click. */
function button(label, onClick, variant = 'btn-secondary') {
  const node = element('button', `btn ${variant}`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** Wrap a control with a visible, programmatically associated label. */
function field(id, labelText, control) {
  const group = element('div', 'form-group');
  const label = element('label', '', labelText);
  label.htmlFor = id;
  control.id = id;
  group.append(label, control);
  return group;
}

/** Build a native select from {value, label} options. */
function select(options, value) {
  const node = element('select', 'form-input');
  for (const option of options) {
    const item = element('option', '', option.label);
    item.value = option.value;
    item.disabled = Boolean(option.disabled);
    node.append(item);
  }
  node.value = options.some(option => option.value === value && !option.disabled) ? value : options[0]?.value ?? '';
  return node;
}

/** Derive a stable lowercase environment key from its title, unique among existing keys. */
function environmentKey(title, used) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'env';
  let key = slug;
  for (let counter = 2; used.has(key); counter += 1) key = `${slug}-${counter}`;
  return key;
}

/**
 * Wire the step-by-step setup dialog and return a function that opens it.
 * Security: file paths are chosen in native dialogs; the renderer only passes names and validated choices.
 */
export function createSetupWizard({ onComplete }) {
  const desktop = window.stpDesktop;
  const dialog = document.querySelector('#setup-dialog');
  const body = document.querySelector('#setup-body');
  const stepsList = document.querySelector('#setup-steps');
  const statusEl = document.querySelector('#setup-status');
  const back = document.querySelector('#setup-back-btn');
  const skip = document.querySelector('#setup-skip-btn');
  const next = document.querySelector('#setup-next-btn');
  let state = null;
  let busy = false;

  /** Show progress or errors in the footer live region. */
  function status(message = '', kind = '') {
    statusEl.textContent = message;
    statusEl.className = `dialog-status${kind ? ` ${kind}` : ''}`;
  }

  /** Environment list for the active configuration source. */
  function environments() {
    return state.source === 'import' && state.imported ? state.imported.environments : state.environments;
  }

  /** Steps depend on whether environments are imported or configured manually. */
  function steps() {
    return ['apps', 'vpn', 'cli', 'source', ...(state.source === 'manual' ? ['environments'] : []), 'profiles', 'review'];
  }

  /** Run one async action at a time with navigation locked and errors surfaced. */
  async function run(message, action) {
    if (busy) return;
    busy = true;
    updateNavigation();
    status(message);
    try {
      await action();
      status();
    } catch (error) {
      status(error.message || String(error), 'error');
    } finally {
      busy = false;
      render(false);
    }
  }

  /** Re-check installed prerequisites and programs. */
  async function detect() {
    state.detected = await desktop.detectSetup();
  }

  /** Load AWS VPN Client profile names for the profile step. */
  async function loadProfiles() {
    state.profilesError = '';
    try {
      state.vpnProfiles = await desktop.listVpnProfiles();
    } catch (error) {
      state.vpnProfiles = [];
      state.profilesError = error.message || String(error);
    }
  }

  /** Validate manual environment rows and assign keys to new rows; returns an error message or ''. */
  function finalizeEnvironments() {
    const rows = state.environments;
    if (!rows.length || rows.length > MAX_ENVIRONMENTS) return `Configure between 1 and ${MAX_ENVIRONMENTS} environments.`;
    const titles = new Set();
    for (const row of rows) {
      const title = row.title.trim();
      if (!title || title.length > 32) return 'Each environment needs a name of at most 32 characters.';
      if (titles.has(title.toLowerCase())) return `Environment names must be unique (${title}).`;
      titles.add(title.toLowerCase());
    }
    const used = new Set(rows.filter(row => row.key).map(row => row.key));
    for (const row of rows) {
      row.title = row.title.trim();
      if (!row.key) {
        row.key = environmentKey(row.title, used);
        used.add(row.key);
      }
    }
    return '';
  }

  /** Whether the current step allows moving forward, with a reason when it does not. */
  function blocker() {
    switch (steps()[state.index]) {
      case 'vpn':
        return state.detected.vpnClient ? '' : 'AWS VPN Client is required to continue.';
      case 'cli':
        return state.detected.awsCli ? '' : 'Install the AWS CLI and check again, or skip this step.';
      case 'source':
        return state.source === 'import' && !state.imported ? 'Choose a configuration file to import.' : '';
      case 'profiles': {
        if (state.vpnProfiles === null) return 'Loading VPN profiles...';
        const missing = environments().filter(env => !state.vpnProfiles.includes(state.profiles[env.key]));
        return missing.length ? `Choose or import a VPN profile for ${missing.map(env => env.title).join(', ')}.` : '';
      }
      default:
        return '';
    }
  }

  /** Synchronize footer buttons with the current step and busy state. */
  function updateNavigation() {
    const step = steps()[state.index];
    back.disabled = busy || state.index === 0;
    skip.hidden = !(step === 'cli' && !state.detected.awsCli);
    skip.disabled = busy;
    next.textContent = step === 'review' ? 'Finish setup' : 'Next';
    next.disabled = busy;
  }

  /** Render the progress list with the current step exposed to assistive technology. */
  function renderProgress() {
    stepsList.replaceChildren();
    steps().forEach((step, index) => {
      const item = element('li', index < state.index ? 'done' : '', STEP_TITLES[step]);
      if (index === state.index) item.setAttribute('aria-current', 'step');
      stepsList.append(item);
    });
  }

  /** Render a prerequisite check with its state and actions. */
  function check(installed, okText, missingText, detail, actions, optional = false) {
    const box = element('div', 'setup-check');
    box.dataset.state = installed ? 'ok' : optional ? 'optional' : 'missing';
    const text = element('div');
    text.append(element('strong', '', installed ? okText : missingText));
    if (!installed) text.append(element('p', '', detail));
    box.append(text);
    const container = element('div', 'native-actions');
    if (!installed) container.append(...actions);
    return [box, container];
  }

  const renderers = {
    apps() {
      const terminals = state.detected.terminals;
      const terminalOptions = terminals.length
        ? terminals.map(program => ({ value: program.id, label: program.name }))
        : [{ value: '', label: 'No supported terminal found' }];
      const terminal = select(terminalOptions, state.terminal);
      terminal.addEventListener('change', () => { state.terminal = terminal.value; });
      state.terminal = terminal.value;
      const browser = select([{ value: '', label: 'System default browser' },
        ...state.detected.browsers.map(program => ({ value: program.id, label: program.name }))], state.browser);
      browser.addEventListener('change', () => { state.browser = browser.value; });
      state.browser = browser.value;
      return [
        element('p', 'section-desc', 'Applications open in the selected browser. Only programs detected on this computer are listed.'),
        field('setup-terminal', 'Default terminal', terminal),
        field('setup-browser', 'Default browser', browser),
      ];
    },
    vpn() {
      return check(state.detected.vpnClient, 'AWS VPN Client is installed.', 'AWS VPN Client was not found.',
        'Install AWS VPN Client 6.x from the official AWS download page, then choose Check again. This step cannot be skipped.', [
          button('Open AWS download page', () => run('Opening download page...', () => desktop.openInstallPage('vpn')), 'btn-primary'),
          button('Check again', () => run('Checking...', detect)),
        ]);
    },
    cli() {
      return check(state.detected.awsCli, 'AWS CLI is installed.', 'AWS CLI was not found.',
        'The AWS CLI is recommended for working with AWS from your terminal. Install it from the official AWS guide, or skip this step.', [
          button('Open AWS CLI install guide', () => run('Opening install guide...', () => desktop.openInstallPage('cli')), 'btn-primary'),
          button('Check again', () => run('Checking...', detect)),
        ], true);
    },
    source() {
      const fieldset = element('fieldset', 'setup-list');
      fieldset.append(element('legend', 'section-desc', 'How do you want to configure environments and apps?'));
      for (const [value, title, detail] of [
        ['import', 'Import a configuration file', 'Use a config.json shared by your team. Its environments, VPN profile names and apps are imported.'],
        ['manual', 'Configure manually', state.hasApps ? 'Set up environments yourself. Your current apps are kept.' : 'Set up environments yourself and add apps later.'],
      ]) {
        const label = element('label', 'setup-choice');
        const input = element('input');
        input.type = 'radio';
        input.name = 'setup-source';
        input.value = value;
        input.checked = state.source === value;
        input.addEventListener('change', () => {
          state.source = value;
          state.vpnProfiles = null;
          render();
        });
        const text = element('span');
        text.append(element('strong', '', title), element('small', '', detail));
        label.append(input, text);
        fieldset.append(label);
      }
      const nodes = [fieldset];
      if (state.source === 'import') {
        const actions = element('div', 'native-actions');
        actions.append(button(state.imported ? 'Choose a different file' : 'Choose configuration file', () => run('Waiting for file selection...', async () => {
          const draft = await desktop.readSetupConfig();
          if (!draft) return;
          state.imported = draft;
          state.profiles = { ...draft.profiles };
          state.vpnProfiles = null;
        }), 'btn-primary'));
        nodes.push(actions);
        if (state.imported) {
          const { environments: envs, resources } = state.imported;
          nodes.push(element('p', 'dialog-status success', `Loaded ${envs.length} environment(s) (${envs.map(env => env.title).join(', ')}) and ${resources.length} app(s).`));
        }
      }
      return nodes;
    },
    environments() {
      const list = element('ul', 'setup-list');
      state.environments.forEach((env, index) => {
        const row = element('li', 'setup-row');
        const input = element('input', 'form-input');
        input.type = 'text';
        input.maxLength = 32;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = env.title;
        input.addEventListener('input', () => {
          env.title = input.value;
          delete env.sub;
        });
        const remove = button('Remove', () => {
          state.environments.splice(index, 1);
          render();
          body.querySelector('input')?.focus();
        });
        remove.disabled = state.environments.length <= 1;
        remove.setAttribute('aria-label', `Remove environment ${env.title || index + 1}`);
        const color = element('input', 'form-input setup-color');
        color.type = 'color';
        color.value = env.color || defaultColor(env.key, index);
        color.addEventListener('input', () => { env.color = color.value; });
        env.color = color.value;
        row.className = 'setup-row setup-env-row';
        row.append(field(`setup-env-${index}`, `Environment ${index + 1} name`, input),
          field(`setup-env-color-${index}`, 'Dot colour', color), remove);
        list.append(row);
      });
      const add = button('Add environment', () => {
        state.environments.push({ key: '', title: '', color: defaultColor('', state.environments.length) });
        render();
        body.querySelector(`#setup-env-${state.environments.length - 1}`)?.focus();
      });
      add.disabled = state.environments.length >= MAX_ENVIRONMENTS;
      const actions = element('div', 'native-actions');
      actions.append(add);
      return [element('p', 'section-desc', 'Defaults are DEV, INT, STAGE and PROD. Rename, add or remove environments as needed.'), list, actions];
    },
    profiles() {
      if (state.vpnProfiles === null) {
        void run('Loading AWS VPN Client profiles...', loadProfiles);
        return [element('p', 'section-desc', 'Loading AWS VPN Client profiles...')];
      }
      const nodes = [element('p', 'section-desc', 'Choose an existing AWS VPN Client profile for each environment, or import an .ovpn file provided by your administrator.')];
      if (state.profilesError) nodes.push(element('p', 'dialog-status error', `Cannot list profiles: ${state.profilesError}`));
      const refresh = element('div', 'native-actions');
      refresh.append(button('Refresh profile list', () => run('Loading AWS VPN Client profiles...', loadProfiles)));
      nodes.push(refresh);
      const list = element('ul', 'setup-list');
      environments().forEach((env, index) => {
        const row = element('li', 'setup-row');
        row.append(element('h4', '', env.title));
        const wanted = state.profiles[env.key] || '';
        const known = state.vpnProfiles.includes(wanted);
        const options = [{ value: '', label: state.vpnProfiles.length ? 'Choose a profile...' : 'No profiles imported yet' },
          ...state.vpnProfiles.map(name => ({ value: name, label: name }))];
        const choice = select(options, wanted);
        choice.addEventListener('change', () => {
          state.profiles[env.key] = choice.value;
          updateNavigation();
        });
        const name = element('input', 'form-input');
        name.type = 'text';
        name.maxLength = 256;
        name.autocomplete = 'off';
        name.spellcheck = false;
        name.value = known ? '' : wanted || `${env.title} VPN`;
        const importButton = button('Import .ovpn file...', () => run(`Importing ${name.value.trim()}...`, async () => {
          const profileName = name.value.trim();
          if (!profileName) throw new Error('Enter a name for the new profile.');
          const profiles = await desktop.importVpnProfile(profileName);
          if (!profiles) return;
          state.vpnProfiles = profiles;
          state.profiles[env.key] = profileName;
        }));
        const grid = element('div', 'setup-profile');
        grid.append(field(`setup-profile-${index}`, 'Existing profile', choice),
          field(`setup-profile-name-${index}`, 'Or import as new profile', name), importButton);
        row.append(grid);
        if (wanted && !known) {
          row.append(element('p', 'section-desc', `Profile "${wanted}" from the configuration is not in AWS VPN Client yet. Import it or choose another profile.`));
        }
        list.append(row);
      });
      nodes.push(list);
      return nodes;
    },
    review() {
      const terminal = state.detected.terminals.find(program => program.id === state.terminal)?.name || 'Not set';
      const browser = state.detected.browsers.find(program => program.id === state.browser)?.name || 'System default browser';
      const list = element('ul', 'setup-list');
      const lines = [
        `Terminal: ${terminal}`,
        `Browser: ${browser}`,
        'AWS VPN Client: installed',
        `AWS CLI: ${state.detected.awsCli ? 'installed' : 'skipped'}`,
        ...environments().map(env => `${env.title}: ${state.profiles[env.key]}`),
        state.source === 'import' ? `Apps: ${state.imported.resources.length} imported (replaces current apps)` : 'Apps: current apps are kept',
      ];
      for (const line of lines) list.append(element('li', 'setup-row', line));
      return [element('p', 'section-desc', 'Settings are saved to config.json. You can re-run this wizard from Settings at any time.'), list];
    },
  };

  /** Render the current step; focus its heading only when the step changed. */
  function render(moveFocus = true) {
    const step = steps()[state.index];
    renderProgress();
    const heading = element('h3', '', STEP_TITLES[step]);
    heading.tabIndex = -1;
    body.replaceChildren(heading, ...renderers[step]());
    updateNavigation();
    if (moveFocus) heading.focus();
  }

  /** Commit all wizard choices in one native save. */
  async function finish() {
    const envs = environments().map(({ key, title, sub, color }) => ({
      key, title, ...(sub ? { sub } : {}), ...(color ? { color } : {}),
    }));
    const config = await desktop.completeSetup({
      environments: envs,
      profiles: Object.fromEntries(envs.map(env => [env.key, state.profiles[env.key]])),
      resources: state.source === 'import' ? state.imported.resources : null,
      terminal: state.terminal,
      browser: state.browser,
    });
    dialog.close();
    onComplete(config);
  }

  next.addEventListener('click', () => {
    if (busy || !state) return;
    const step = steps()[state.index];
    if (step === 'environments') {
      const error = finalizeEnvironments();
      if (error) { status(error, 'error'); return; }
    }
    const reason = blocker();
    if (reason) { status(reason, 'error'); return; }
    if (step === 'review') { void run('Saving configuration...', finish); return; }
    state.index += 1;
    status();
    render();
  });
  back.addEventListener('click', () => {
    if (busy || !state || state.index === 0) return;
    state.index -= 1;
    status();
    render();
  });
  skip.addEventListener('click', () => {
    if (busy || !state) return;
    state.index += 1;
    status();
    render();
  });
  document.querySelector('#close-setup-btn').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });

  /** Open the wizard prefilled from the current configuration so it can be re-run. */
  return async function open(configuration) {
    if (dialog.open) return;
    const current = configuration?.environments?.length ? configuration.environments : DEFAULT_ENVIRONMENTS;
    state = {
      index: 0,
      detected: { vpnClient: false, awsCli: false, browsers: [], terminals: [] },
      terminal: configuration?.preferences?.terminal || '',
      browser: configuration?.preferences?.browser || '',
      source: 'manual',
      imported: null,
      environments: current.map(env => ({ ...env })),
      profiles: { ...(configuration?.profiles || {}) },
      vpnProfiles: null,
      profilesError: '',
      hasApps: Boolean(configuration?.resources?.length),
    };
    status();
    body.replaceChildren(element('p', 'section-desc', 'Checking this computer...'));
    dialog.showModal();
    busy = true;
    try {
      await detect();
    } catch (error) {
      status(error.message || String(error), 'error');
    } finally {
      busy = false;
    }
    render();
  };
}
