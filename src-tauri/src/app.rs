use crate::{
    config::{self, Configuration, Environment, Preferences, Profiles, Resource},
    updates::{self, UpdateStatus},
    vpn::Controller,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    time::{sleep, timeout},
};

struct Desk {
    configuration: Mutex<Option<Result<Configuration, String>>>,
    ready: Notify,
    directory: PathBuf,
    controller: Controller,
    actions: AsyncMutex<()>,
    update_running: Arc<AtomicBool>,
    update_status: Arc<Mutex<UpdateStatus>>,
    staged_installer: Arc<Mutex<Option<PathBuf>>>,
    want_show: AtomicBool,
    started: Instant,
    smoke: bool,
    idle_check: bool,
    switch_requests: std::sync::atomic::AtomicUsize,
    /// Connected environment named in the tray tooltip; `None` when no VPN is connected.
    tray_label: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePreferences {
    preferences: Preferences,
    update: UpdateStatus,
    version: &'static str,
    update_repository: &'static str,
}

struct UpdateGuard(Arc<AtomicBool>);

impl Drop for UpdateGuard {
    /// Keep a timed-out file operation marked in-flight until its blocking worker actually finishes.
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Authorize the main window from bundled assets or the debug-only UI development server.
fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Untrusted application window.".into());
    }
    let url = window.url().map_err(|e| e.to_string())?;
    if !application_origin(&url) {
        return Err("Untrusted application origin.".into());
    }
    Ok(())
}

/// Match only Tauri's bundled-content origins, not arbitrary services on localhost.
fn bundled_origin(url: &url::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// Permit the fixed loopback UI server only in debug builds; release builds accept bundled assets only.
fn application_origin(url: &url::Url) -> bool {
    bundled_origin(url)
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1430)
            && url.username().is_empty()
            && url.password().is_none())
}

/// Wait for local configuration only; never couple initialization to VPN or update discovery.
async fn configuration(desk: &Desk) -> Result<Configuration, String> {
    loop {
        let notified = desk.ready.notified();
        if let Some(result) = desk
            .configuration
            .lock()
            .expect("Configuration poisoned")
            .as_ref()
        {
            return result.clone();
        }
        notified.await;
    }
}

/// Display name from the loaded config.json, falling back to the bundled config.
fn app_name(desk: &Desk) -> String {
    let loaded = desk.configuration.lock().expect("Configuration poisoned");
    config::branding(loaded.as_ref().and_then(|result| result.as_ref().ok())).name
}

/// Apply the configured name to the main window title and idle tray tooltip.
fn apply_branding(app: &AppHandle) {
    let desk = app.state::<Desk>();
    let name = app_name(&desk);
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.set_title(&name) {
            log::warn!("Cannot set window title: {error}");
        }
    }
    let tooltip = match desk
        .tray_label
        .lock()
        .expect("Tray state poisoned")
        .as_deref()
    {
        Some(label) => format!("{name} - {label} VPN connected"),
        None => name,
    };
    if let Some(tray) = app.tray_by_id("desk") {
        if let Err(error) = tray.set_tooltip(Some(&tooltip)) {
            log::warn!("Cannot set tray tooltip: {error}");
        }
    }
}

/// Report native/tray failures without blocking the main event loop with a modal dialog.
fn report(app: &AppHandle, error: impl AsRef<str>) {
    let error = error.as_ref();
    log::error!("{error}");
    if let Err(event_error) = app.emit("stp-error", error) {
        log::error!("Cannot deliver dashboard error: {event_error}");
    }
    let desk = app.state::<Desk>();
    desk.update_status
        .lock()
        .expect("Update state poisoned")
        .message = error.to_string();
    if let Some(tray) = app.tray_by_id("desk") {
        if let Err(e) = tray.set_tooltip(Some(format!("{} - {error}", app_name(&desk)))) {
            log::error!("Tray error: {e}");
        }
    }
    show(app);
}

/// Restore the existing warm window without waiting for any external operation.
fn show(app: &AppHandle) {
    app.state::<Desk>().want_show.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
        {
            log::error!("Cannot restore dashboard: {e}");
        }
        if let Err(error) = window.emit("stp-visibility", true) {
            log::error!("Cannot publish window visibility: {error}");
        }
    }
}

/// Apply opt-in login startup and shortcut registration, surfacing OS failures to the caller.
fn apply_preferences(
    app: &AppHandle,
    preferences: &Preferences,
    previous_shortcut: Option<&str>,
) -> Result<(), String> {
    let shortcut = preferences
        .shortcut
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|_| "Configure a valid keyboard shortcut.".to_string())?;
    let autostart = app.autolaunch();
    if preferences.start_at_login {
        autostart
            .enable()
            .map_err(|e| format!("Cannot enable login startup: {e}"))?;
    } else {
        autostart
            .disable()
            .map_err(|e| format!("Cannot disable login startup: {e}"))?;
    }
    let shortcuts = app.global_shortcut();
    if let Some(previous) = previous_shortcut.filter(|previous| *previous != preferences.shortcut) {
        let previous = previous
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|_| "The previously configured shortcut is invalid.".to_string())?;
        if shortcuts.is_registered(previous.clone()) {
            shortcuts
                .unregister(previous)
                .map_err(|error| error.to_string())?;
        }
    }
    if preferences.shortcut_enabled && !shortcuts.is_registered(shortcut.clone()) {
        shortcuts
            .on_shortcut(shortcut, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    show(app);
                }
            })
            .map_err(|e| format!("Shortcut unavailable: {e}"))?;
    } else if !preferences.shortcut_enabled && shortcuts.is_registered(shortcut.clone()) {
        shortcuts.unregister(shortcut).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Persist a validated local configuration before publishing its new in-memory snapshot.
fn commit(desk: &Desk, config: Configuration) -> Result<(), String> {
    config::save(&desk.directory, &config)?;
    *desk.configuration.lock().expect("Configuration poisoned") = Some(Ok(config));
    Ok(())
}

/// Quit without trapping the user behind a stalled switch or pretending to undo its service-side effects.
fn request_quit(app: &AppHandle) {
    let desk = app.state::<Desk>();
    if desk.controller.snapshot().busy {
        desk.controller.cancel_wait();
        log::warn!("Quitting stops CLI observation, not the underlying VPN connection.");
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let desk = handle.state::<Desk>();
            let _guard = desk.actions.lock().await;
            handle.exit(0);
        });
    } else {
        app.exit(0);
    }
}

#[tauri::command]
/// Stop active observation and release its action lock before the renderer requests fresh status.
async fn refresh_vpn(window: WebviewWindow, desk: State<'_, Desk>) -> Result<(), String> {
    trusted(&window)?;
    if desk.controller.snapshot().busy {
        desk.controller.cancel_wait();
    }
    let _guard = tokio::time::timeout(Duration::from_secs(10), desk.actions.lock())
        .await
        .map_err(|_| {
            "Cannot refresh yet: another application operation is still finishing.".to_string()
        })?;
    Ok(())
}

#[tauri::command]
/// Route the dashboard's quit shortcut through the same cancellation-aware native exit.
fn quit_app(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    trusted(&window)?;
    request_quit(&app);
    Ok(())
}

#[tauri::command]
/// Return local links and mappings immediately after seeding, without CLI discovery.
async fn get_configuration(
    window: WebviewWindow,
    desk: State<'_, Desk>,
) -> Result<Configuration, String> {
    trusted(&window)?;
    configuration(&desk).await
}

#[tauri::command]
/// Return a bounded, coalesced display-only VPN status.
async fn get_status(
    window: WebviewWindow,
    desk: State<'_, Desk>,
) -> Result<crate::vpn::Snapshot, String> {
    trusted(&window)?;
    if !window.is_visible().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        return Ok(desk.controller.snapshot());
    }
    if desk.smoke {
        return Ok(crate::vpn::Snapshot::default());
    }
    desk.controller.refresh().await
}

#[tauri::command]
/// Read native visibility because a hidden WebView2 can still report document.hidden as false.
fn get_visibility(window: WebviewWindow) -> Result<bool, String> {
    trusted(&window)?;
    Ok(window.is_visible().map_err(|e| e.to_string())?
        && !window.is_minimized().map_err(|e| e.to_string())?)
}

/// Resolve a locally configured destination and require fresh VPN confirmation before native opening.
async fn open(app: &AppHandle, environment: &str, resource_id: &str) -> Result<(), String> {
    let desk = app.state::<Desk>();
    if desk.smoke || desk.idle_check {
        return Err("Resource opening is disabled during verification.".into());
    }
    let _guard = desk.actions.try_lock().map_err(|_| {
        "Another resource, settings, or installer operation is in progress.".to_string()
    })?;
    let config = configuration(&desk).await?;
    let profile = config
        .profiles
        .get(environment)
        .ok_or("Unknown environment.")?;
    let destination = config
        .resources
        .iter()
        .find(|r| r.id == resource_id)
        .and_then(|r| r.links.get(environment))
        .and_then(Option::as_ref)
        .ok_or("Resource is unavailable in this environment.")?;
    if let Some(tray) = app.tray_by_id("desk") {
        tray.set_tooltip(Some(format!(
            "{} - Checking VPN for {}",
            config::branding(Some(&config)).name,
            environment.to_uppercase()
        )))
        .map_err(|e| e.to_string())?;
    }
    let result = async {
        desk.controller.ensure(profile).await?;
        launch_browser(app, destination, &config.preferences.browser)
    }
    .await;
    apply_branding(app);
    result
}

#[tauri::command]
/// Open only a configured resource ID, never a renderer-provided URL.
async fn open_resource(
    window: WebviewWindow,
    app: AppHandle,
    environment: String,
    resource_id: String,
) -> Result<(), String> {
    trusted(&window)?;
    open(&app, &environment, &resource_id).await
}

#[tauri::command]
/// Explicitly connect a configured environment without changing the displayed tab.
async fn switch_vpn(
    window: WebviewWindow,
    environment: String,
    desk: State<'_, Desk>,
) -> Result<(), String> {
    trusted(&window)?;
    desk.switch_requests.fetch_add(1, Ordering::SeqCst);
    if desk.smoke || desk.idle_check {
        return Err("VPN mutations are disabled during verification.".into());
    }
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Another operation is in progress.".to_string())?;
    let config = configuration(&desk).await?;
    desk.controller
        .ensure(
            config
                .profiles
                .get(&environment)
                .ok_or("Unknown environment.")?,
        )
        .await
}

#[tauri::command]
/// Disconnect only the selected configured profile; never accept arbitrary profile names from the renderer.
async fn disconnect_vpn(
    window: WebviewWindow,
    environment: String,
    desk: State<'_, Desk>,
) -> Result<(), String> {
    trusted(&window)?;
    desk.switch_requests.fetch_add(1, Ordering::SeqCst);
    if desk.smoke || desk.idle_check {
        return Err("VPN mutations are disabled during verification.".into());
    }
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Another operation is in progress.".to_string())?;
    let config = configuration(&desk).await?;
    desk.controller
        .disconnect(
            config
                .profiles
                .get(&environment)
                .ok_or("Unknown environment.")?,
        )
        .await
}

#[tauri::command]
/// Verify native window lifecycle after renderer checks, using isolated data and simulated VPN status.
async fn complete_smoke(
    window: WebviewWindow,
    app: AppHandle,
    mut result: serde_json::Value,
) -> Result<(), String> {
    trusted(&window)?;
    let desk = app.state::<Desk>();
    if !desk.smoke {
        return Err("Smoke completion is disabled in normal operation.".into());
    }
    let verification = async {
        if result["error"].as_str() != Some("") {
            return Err(format!("Renderer smoke failed: {}", result["error"]));
        }
        let config = configuration(&desk).await?;
        if result["cards"].as_u64() != Some(config.resources.len() as u64)
            || result["tabs"].as_u64() != Some(config.environments.len() as u64)
            || result["settingsOpen"] != true
            || result["nativePreferences"] != true
            || result["nodeAccess"] != "undefined"
            || desk.switch_requests.load(Ordering::SeqCst) != 0
            || app.tray_by_id("desk").is_none()
        {
            return Err("Native dashboard assertions failed.".into());
        }
        window.hide().map_err(|e| e.to_string())?;
        if window.is_visible().map_err(|e| e.to_string())? {
            return Err("Window did not hide.".into());
        }
        let restore_started = Instant::now();
        show(&app);
        result["nativeRestoreMs"] = (restore_started.elapsed().as_millis() as u64).into();
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("Window did not restore.".into());
        }
        window.close().map_err(|e| e.to_string())?;
        sleep(Duration::from_millis(100)).await;
        if window.is_visible().map_err(|e| e.to_string())? {
            return Err("Close did not hide to tray.".into());
        }
        show(&app);
        if !window.is_visible().map_err(|e| e.to_string())? {
            return Err("Close-to-tray window did not restore.".into());
        }
        result["passed"] = true.into();
        result["tray"] = true.into();
        result["closeToTray"] = true.into();
        result["restored"] = true.into();
        result["noImplicitVpnSwitch"] = true.into();
        result["elapsedMs"] = (desk.started.elapsed().as_millis() as u64).into();
        let report = std::env::var_os("DESK_SMOKE_REPORT")
            .ok_or("DESK_SMOKE_REPORT is required in smoke mode.")?;
        std::fs::write(
            report,
            serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    match verification {
        Ok(()) => {
            eprintln!("Native desktop smoke passed: {result}");
            app.exit(0);
        }
        Err(error) => {
            eprintln!("Native desktop smoke failed: {error}");
            app.exit(1);
        }
    }
    Ok(())
}

#[tauri::command]
/// Validate and persist all four profile mappings across restarts.
async fn save_profiles(
    window: WebviewWindow,
    profiles: Profiles,
    desk: State<'_, Desk>,
) -> Result<Profiles, String> {
    trusted(&window)?;
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the active operation before editing settings.".to_string())?;
    let mut config = configuration(&desk).await?;
    config.profiles = profiles.clone();
    commit(&desk, config)?;
    Ok(profiles)
}

#[tauri::command]
/// Resolve public allowlisted artwork without expanding renderer network or filesystem permissions.
async fn get_app_icon(
    window: WebviewWindow,
    desk: State<'_, Desk>,
    url: String,
) -> Result<String, String> {
    trusted(&window)?;
    timeout(
        Duration::from_secs(20),
        crate::icons::get(url, desk.directory.join("app-icons")),
    )
    .await
    .map_err(|_| "Icon request exceeded 20 seconds.".to_string())?
}

#[tauri::command]
/// Validate and persist resource edits in the privileged backend.
async fn save_resources(
    window: WebviewWindow,
    app: AppHandle,
    mut resources: Vec<Resource>,
) -> Result<Vec<Resource>, String> {
    trusted(&window)?;
    let desk = app.state::<Desk>();
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the active operation before editing settings.".to_string())?;
    for (index, resource) in resources.iter_mut().enumerate() {
        resource.id = index.to_string();
    }
    let mut config = configuration(&desk).await?;
    config.resources = resources.clone();
    commit(&desk, config)?;
    Ok(resources)
}

#[tauri::command]
/// Expose update health and native preferences without starting a network request.
async fn get_native_preferences(
    window: WebviewWindow,
    desk: State<'_, Desk>,
) -> Result<NativePreferences, String> {
    trusted(&window)?;
    Ok(NativePreferences {
        preferences: configuration(&desk).await?.preferences,
        update: desk
            .update_status
            .lock()
            .expect("Update state poisoned")
            .clone(),
        version: env!("CARGO_PKG_VERSION"),
        update_repository: updates::REPOSITORY,
    })
}

#[tauri::command]
/// Persist preferences only after OS registration succeeds; restore the previous registration on error.
async fn save_native_preferences(
    window: WebviewWindow,
    app: AppHandle,
    preferences: Preferences,
) -> Result<(), String> {
    trusted(&window)?;
    let desk = app.state::<Desk>();
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the active operation before editing preferences.".to_string())?;
    let mut config = configuration(&desk).await?;
    let previous = config.preferences.clone();
    // Terminal and browser are owned by the setup wizard; keep them when Settings saves.
    config.preferences = Preferences {
        terminal: previous.terminal.clone(),
        browser: previous.browser.clone(),
        ..preferences.clone()
    };
    config::validate(&config)?;
    // Smoke settings are isolated; never change the user's OS startup or shortcut registration.
    if desk.smoke {
        return commit(&desk, config);
    }
    let result = apply_preferences(&app, &preferences, Some(&previous.shortcut))
        .and_then(|_| commit(&desk, config));
    if let Err(error) = result {
        return match apply_preferences(&app, &previous, Some(&preferences.shortcut)) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}; restoring previous OS settings also failed: {rollback}"
            )),
        };
    }
    Ok(())
}

/// Open a validated HTTPS destination in the chosen browser, or the system default when none is set.
fn launch_browser(app: &AppHandle, url: &str, browser: &str) -> Result<(), String> {
    let path = (!browser.is_empty())
        .then(|| crate::setup::browser_path(browser))
        .flatten();
    let Some(path) = path else {
        if !browser.is_empty() {
            log::warn!("Browser '{browser}' not found; using the system default.");
        }
        return app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("Cannot open the system browser: {e}"));
    };
    // Direct process start with the URL as one argument; no shell interprets it.
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg("-a").arg(&path).arg(url);
        command
    } else {
        let mut command = std::process::Command::new(&path);
        command.arg(url);
        command
    };
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Cannot start the selected browser: {e}"))?;
    if cfg!(not(target_os = "windows")) {
        // Reap the short-lived launcher so it does not linger as a zombie process.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    vpn_client: bool,
    aws_cli: bool,
    browsers: Vec<crate::setup::Program>,
    terminals: Vec<crate::setup::Program>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupDraft {
    environments: Vec<Environment>,
    profiles: Profiles,
    resources: Vec<Resource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupInput {
    environments: Vec<Environment>,
    profiles: Profiles,
    /// Imported apps; `None` keeps the current apps.
    #[serde(default)]
    resources: Option<Vec<Resource>>,
    terminal: String,
    browser: String,
}

#[tauri::command]
/// Report installed prerequisites and programs using filesystem checks only.
async fn detect_setup(window: WebviewWindow) -> Result<SetupStatus, String> {
    trusted(&window)?;
    tauri::async_runtime::spawn_blocking(|| SetupStatus {
        vpn_client: crate::vpn::client_installed(),
        aws_cli: crate::setup::aws_cli_installed(),
        browsers: crate::setup::browsers(),
        terminals: crate::setup::terminals(),
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
/// List AWS VPN Client profiles so each environment can map to an existing one.
async fn list_vpn_profiles(
    window: WebviewWindow,
    desk: State<'_, Desk>,
) -> Result<Vec<String>, String> {
    trusted(&window)?;
    if desk.smoke || desk.idle_check {
        return Ok(Vec::new());
    }
    crate::vpn::list_profiles().await
}

#[tauri::command]
/// Let the user pick an .ovpn file natively and import it; the renderer never supplies a path.
async fn import_vpn_profile(
    window: WebviewWindow,
    desk: State<'_, Desk>,
    profile_name: String,
) -> Result<Option<Vec<String>>, String> {
    trusted(&window)?;
    if desk.smoke || desk.idle_check {
        return Err("VPN mutations are disabled during verification.".into());
    }
    let profile_name = profile_name.trim().to_string();
    if !config::valid_profile_name(&profile_name) {
        return Err(
            "Enter a profile name of up to 256 characters that does not start with '-'.".into(),
        );
    }
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the active operation before importing a profile.".to_string())?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Select AWS Client VPN configuration file")
        .add_filter("OpenVPN configuration", &["ovpn"])
        .set_parent(&window)
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ovpn"))
    {
        return Err("Select an .ovpn configuration file.".into());
    }
    crate::vpn::import_profile(&profile_name, &path).await?;
    crate::vpn::list_profiles().await.map(Some)
}

#[tauri::command]
/// Read a user-selected shareable configuration as a wizard draft without committing it.
async fn read_setup_config(window: WebviewWindow) -> Result<Option<SetupDraft>, String> {
    trusted(&window)?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Import AWS Environment Desk configuration")
        .add_filter("JSON configuration", &["json"])
        .set_parent(&window)
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    let config = tauri::async_runtime::spawn_blocking(move || config::read_import(&path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(SetupDraft {
        environments: config.environments,
        profiles: config.profiles,
        resources: config.resources,
    }))
}

#[tauri::command]
/// Commit wizard choices; a broken saved file is replaced by a fresh configuration.
async fn complete_setup(
    window: WebviewWindow,
    desk: State<'_, Desk>,
    setup: SetupInput,
) -> Result<Configuration, String> {
    trusted(&window)?;
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the active operation before completing setup.".to_string())?;
    let mut config = match configuration(&desk).await {
        Ok(config) => config,
        Err(_) => tauri::async_runtime::spawn_blocking(config::fresh)
            .await
            .map_err(|e| e.to_string())??,
    };
    config.environments = setup.environments;
    config.profiles = setup.profiles;
    if let Some(resources) = setup.resources {
        config.resources = resources;
    }
    config::align_resources(&mut config);
    config.preferences.terminal = setup.terminal;
    config.preferences.browser = setup.browser;
    config.setup_complete = true;
    commit(&desk, config.clone())?;
    Ok(config)
}

#[tauri::command]
/// Open fixed official AWS installation pages only.
fn open_install_page(window: WebviewWindow, app: AppHandle, target: String) -> Result<(), String> {
    trusted(&window)?;
    let url = match target.as_str() {
        "vpn" => crate::setup::VPN_DOWNLOAD_URL,
        "cli" => crate::setup::CLI_INSTALL_URL,
        _ => return Err("Unknown installation page.".into()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Cannot open the system browser: {e}"))
}

#[tauri::command]
/// Open the shareable config.json with its default editor, or reveal it when no editor is associated.
async fn open_config_file(window: WebviewWindow, app: AppHandle) -> Result<String, String> {
    trusted(&window)?;
    let desk = app.state::<Desk>();
    if desk.smoke {
        return Err("Opening files is disabled during verification.".into());
    }
    let path = config::config_path(&desk.directory);
    if !path.is_file() {
        config::save(&desk.directory, &configuration(&desk).await?)?;
    }
    let display = path.to_string_lossy().into_owned();
    if let Err(error) = app.opener().open_path(display.clone(), None::<&str>) {
        log::warn!("Cannot open {display}: {error}");
        app.opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| format!("Cannot open {display}: {e}"))?;
    }
    Ok(display)
}

#[tauri::command]

/// Re-read config.json after external edits; the previous state stays active if the file is invalid.
async fn reload_configuration(
    window: WebviewWindow,
    app: AppHandle,
    desk: State<'_, Desk>,
) -> Result<Configuration, String> {
    trusted(&window)?;
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the active operation before reloading.".to_string())?;
    let directory = desk.directory.clone();
    let config = tauri::async_runtime::spawn_blocking(move || config::load(&directory))
        .await
        .map_err(|e| e.to_string())??;
    *desk.configuration.lock().expect("Configuration poisoned") = Some(Ok(config.clone()));
    desk.ready.notify_waiters();
    apply_branding(&app);
    Ok(config)
}

#[tauri::command]

/// Return the configured display name and main window icon for the renderer.
fn get_branding(window: WebviewWindow, desk: State<'_, Desk>) -> Result<config::Branding, String> {
    trusted(&window)?;
    let loaded = desk.configuration.lock().expect("Configuration poisoned");
    Ok(config::branding(
        loaded.as_ref().and_then(|result| result.as_ref().ok()),
    ))
}

#[tauri::command]

/// Set the main window icon from a renderer-rasterized PNG.
fn set_window_icon(window: WebviewWindow, png: String) -> Result<(), String> {
    trusted(&window)?;
    window
        .set_icon(decode_png_icon(&png)?)
        .map_err(|e| format!("Cannot set window icon: {e}"))
}

#[tauri::command]

/// Set the tray icon, including any connection dot, and name the connected environment in the tooltip.
fn set_tray_icon(
    window: WebviewWindow,
    app: AppHandle,
    color_png: String,
    template_png: String,
    label: Option<String>,
) -> Result<(), String> {
    trusted(&window)?;
    let label = label
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty());
    if label
        .as_ref()
        .is_some_and(|label| label.len() > 32 || label.chars().any(char::is_control))
    {
        return Err("Tray environment label must be at most 32 characters.".into());
    }
    // macOS menu bar icons are monochrome templates, which cannot show a coloured dot; use the colour icon while connected.
    let template = cfg!(target_os = "macos") && label.is_none();
    let icon = decode_png_icon(if template { &template_png } else { &color_png })?;
    if let Some(tray) = app.tray_by_id("desk") {
        tray.set_icon(Some(icon))
            .and_then(|_| tray.set_icon_as_template(template))
            .map_err(|e| format!("Cannot set tray icon: {e}"))?;
    }
    *app.state::<Desk>()
        .tray_label
        .lock()
        .expect("Tray state poisoned") = label;
    apply_branding(&app);
    Ok(())
}


/// Decode a PNG data URL of at most 2 MiB and 1024x1024 pixels into an owned RGBA image.
fn decode_png_icon(png: &str) -> Result<tauri::image::Image<'static>, String> {
    use base64::Engine;
    let encoded = png
        .strip_prefix("data:image/png;base64,")
        .filter(|data| data.len() <= 2_800_000)
        .ok_or("Icon must be a PNG data URL of at most 2 MiB.")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid icon: {e}"))?;
    let mut reader =
        image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1024);
    limits.max_image_height = Some(1024);
    reader.limits(limits);
    let rgba = reader
        .decode()
        .map_err(|e| format!("Invalid icon: {e}"))?
        .to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(tauri::image::Image::new_owned(
        rgba.into_raw(),
        width,
        height,
    ))
}

/// Authenticate and stage in a blocking worker so network access cannot freeze the tray.
async fn update(app: &AppHandle) -> Result<UpdateStatus, String> {
    let desk = app.state::<Desk>();
    if updates::REPOSITORY.is_empty() {
        return Err("This build has no GitHub release repository configured.".into());
    }
    if updates::PUBLIC_KEY.is_empty() {
        return Err(
            "This build has no embedded release public key; update installation is disabled."
                .into(),
        );
    }
    desk.update_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A GitHub update check is already in progress.".to_string())?;
    let running = UpdateGuard(desk.update_running.clone());
    let status = desk.update_status.clone();
    let repository = updates::REPOSITORY.to_owned();
    let local = desk.directory.clone();
    let staged_installer = desk.staged_installer.clone();
    status.lock().expect("Update state poisoned").message =
        "Checking and verifying the GitHub release...".into();
    let handle = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        *staged_installer.lock().expect("Installer state poisoned") = None;
        *status.lock().expect("Update state poisoned") = UpdateStatus {
            message: "Checking and verifying the GitHub release...".into(),
            verification_configured: true,
            ..Default::default()
        };
        let result = updates::prepare(
            &repository,
            &local,
            env!("CARGO_PKG_VERSION"),
            updates::PUBLIC_KEY,
        )
        .map(|(next, path)| {
            *staged_installer.lock().expect("Installer state poisoned") = path;
            next
        });
        match &result {
            Ok(next) => *status.lock().expect("Update state poisoned") = next.clone(),
            Err(error) => status.lock().expect("Update state poisoned").message = error.clone(),
        }
        let current = status.lock().expect("Update state poisoned").clone();
        if let Err(error) = handle.emit("stp-update", &current) {
            log::warn!("Cannot publish update status: {error}");
        }
        if let Ok(next) = &result {
            if let (Some(version), Some(path)) = (
                next.available_version.clone(),
                staged_installer
                    .lock()
                    .expect("Installer state poisoned")
                    .clone(),
            ) {
                let prompt_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _running = running;
                    if let Err(error) = prompt_update(&prompt_handle, &version, path).await {
                        report(&prompt_handle, error);
                    }
                });
            }
        }
        result
    });
    timeout(Duration::from_secs(30), task).await
        .map_err(|_| "GitHub has not responded within 30 seconds. The background check remains in progress; the app is still usable.".to_string())?
        .map_err(|e| e.to_string())?
}

#[tauri::command]
/// Manually check the configured update directory without blocking native interaction.
async fn check_updates(window: WebviewWindow, app: AppHandle) -> Result<UpdateStatus, String> {
    trusted(&window)?;
    update(&app).await
}


/// Prompt only after authenticated staging, even if a cloud read outlived the UI timeout.
async fn prompt_update(
    app: &AppHandle,
    version: &str,
    expected_path: PathBuf,
) -> Result<(), String> {
    let accepted = rfd::AsyncMessageDialog::new()
        .set_title(format!("{} update", app_name(&app.state::<Desk>())))
        .set_description(format!("Version {version} has been verified and staged locally.\n\nStart the update now? Environment Desk will close and the installer will open."))
        .set_buttons(rfd::MessageButtons::OkCancelCustom("Update now".into(), "Later".into()))
        .show().await;
    if accepted == rfd::MessageDialogResult::Custom("Update now".into()) {
        open_update_installer(app, expected_path).await?;
    } else {
        let desk = app.state::<Desk>();
        let next = {
            let mut status = desk.update_status.lock().expect("Update state poisoned");
            status.message =
                "Update staged. Choose Check for updates when you are ready to install.".into();
            status.clone()
        };
        app.emit("stp-update", &next)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Revalidate and open a local installer only on explicit user action, with no VPN switch in progress.
async fn open_update_installer(app: &AppHandle, expected_path: PathBuf) -> Result<(), String> {
    let desk = app.state::<Desk>();
    let _guard = desk
        .actions
        .try_lock()
        .map_err(|_| "Finish the VPN operation before opening an installer.".to_string())?;
    // Re-stage immediately before opening; no renderer-provided executable path is accepted.
    let repository = updates::REPOSITORY.to_owned();
    let local = desk.directory.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        updates::stage(
            &repository,
            &local,
            env!("CARGO_PKG_VERSION"),
            updates::PUBLIC_KEY,
        )
    })
    .await
    .map_err(|error| error.to_string())??
    .ok_or("No newer installer is available.")?;
    if path != expected_path {
        return Err("The release changed after confirmation. Check for updates again to review the new release.".into());
    }
    if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new(path);
        command
            .spawn()
            .map_err(|e| format!("Cannot start the verified installer: {e}"))?;
        app.exit(0);
    } else {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())?;
        app.exit(0);
    }
    Ok(())
}

/// Create the native tray before configuration reads, webview initialization, or external work.
pub fn run() {
    let started = Instant::now();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(1_048_576)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--start-hidden"])
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_configuration,
            get_status,
            get_visibility,
            open_resource,
            switch_vpn,
            disconnect_vpn,
            save_profiles,
            save_resources,
            get_app_icon,
            get_native_preferences,
            save_native_preferences,
            check_updates,
            refresh_vpn,
            quit_app,
            detect_setup,
            list_vpn_profiles,
            import_vpn_profile,
            read_setup_config,
            complete_setup,
            open_install_page,
            open_config_file,
            reload_configuration,
            get_branding,
            set_window_icon,
            set_tray_icon,
            complete_smoke
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let idle_check = std::env::args().any(|arg| arg == "--idle-check");
            let hidden = idle_check || std::env::args().any(|arg| arg == "--start-hidden");
            let smoke = std::env::args().any(|arg| arg == "--smoke-test");
            let directory = if smoke {
                app.path().app_config_dir()?.join("smoke")
            } else {
                app.path().app_config_dir()?
            };
            app.manage(Desk {
                configuration: Mutex::new(None),
                ready: Notify::new(),
                directory,
                controller: Controller::default(),
                actions: AsyncMutex::new(()),
                update_running: Arc::new(AtomicBool::new(false)),
                staged_installer: Arc::new(Mutex::new(None)),
                update_status: Arc::new(Mutex::new(UpdateStatus {
                    verification_configured: !updates::PUBLIC_KEY.is_empty(),
                    message: "No update check has run.".into(),
                    ..Default::default()
                })),
                want_show: AtomicBool::new(!hidden),
                started,
                smoke,
                idle_check,
                switch_requests: std::sync::atomic::AtomicUsize::new(0),
                tray_label: Mutex::new(None),
            });
            let loading = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "show", "Open", true, None::<&str>)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                ],
            )?;
            let icon = if cfg!(target_os = "macos") {
                tauri::include_image!("../dist/icons/trayTemplate.png")
            } else {
                tauri::include_image!("../dist/icons/tray.png")
            };
            TrayIconBuilder::with_id("desk")
                .icon(icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip(format!("{} - Starting...", config::branding(None).name))
                .menu(&loading)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => show(app),
                        "quit" => request_quit(app),
                        _ => {}
                    }
                })
                .build(app)?;
            log::info!(
                "Startup: tray created at {} ms",
                started.elapsed().as_millis()
            );
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let directory = handle.state::<Desk>().directory.clone();
                let loaded = tauri::async_runtime::spawn_blocking(move || config::load(&directory))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|result| result);
                {
                    let desk = handle.state::<Desk>();
                    *desk.configuration.lock().expect("Configuration poisoned") =
                        Some(loaded.clone());
                    desk.ready.notify_waiters();
                }
                match loaded {
                    Ok(config) => {
                        let registration = if smoke {
                            Ok(())
                        } else {
                            apply_preferences(&handle, &config.preferences, None)
                        };
                        if let Err(e) = registration {
                            report(&handle, e);
                        } else {
                            apply_branding(&handle);
                        }
                    }
                    Err(error) => report(&handle, error),
                }
                sleep(Duration::from_secs(15)).await;
                if !smoke && !idle_check {
                    let prefs = configuration(&handle.state::<Desk>()).await;
                    if prefs.is_ok_and(|config| {
                        config.preferences.check_updates_at_startup
                            && !updates::REPOSITORY.is_empty()
                            && !updates::PUBLIC_KEY.is_empty()
                    }) {
                        if let Err(e) = update(&handle).await {
                            log::warn!("Update check: {e}");
                            handle
                                .state::<Desk>()
                                .update_status
                                .lock()
                                .expect("Update state poisoned")
                                .message = e;
                        }
                    }
                }
            });
            if smoke {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    sleep(Duration::from_secs(30)).await;
                    eprintln!("Native smoke watchdog expired.");
                    handle.exit(1);
                });
            }
            if idle_check {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    sleep(Duration::from_secs(20)).await;
                    let commands = crate::vpn::command_count();
                    let result = serde_json::json!({
                        "passed": commands == 0,
                        "observationSeconds": 20,
                        "cliCommandAttempts": commands,
                    });
                    log::info!("Idle verification: {result}");
                    let target = handle.state::<Desk>().directory.join("idle-check.json");
                    if let Err(error) = std::fs::write(target, result.to_string()) {
                        log::error!("Cannot save idle verification: {error}");
                        handle.exit(1);
                        return;
                    }
                    handle.exit(if commands == 0 { 0 } else { 1 });
                });
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(config::branding(None).name)
                .inner_size(1080.0, 740.0)
                .min_inner_size(680.0, 540.0)
                .visible(false)
                .initialization_script(if smoke {
                    "window.__DESK_SMOKE__ = true;"
                } else {
                    ""
                })
                .on_navigation(application_origin)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_page_load(|window, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        let desk = window.state::<Desk>();
                        log::info!(
                            "Startup: webview loaded at {} ms",
                            desk.started.elapsed().as_millis()
                        );
                        // The configuration may have loaded before this window existed.
                        apply_branding(window.app_handle());
                        if desk.want_show.load(Ordering::SeqCst) {
                            show(window.app_handle());
                        }
                    }
                })
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(e) = window.hide() {
                    eprintln!("Cannot hide dashboard: {e}");
                }
                if let Err(e) = window.emit("stp-visibility", false) {
                    log::error!("Cannot publish window visibility: {e}");
                }
            }
            if matches!(event, WindowEvent::Resized(_)) {
                match window.is_minimized() {
                    Ok(true) => {
                        if let Err(e) = window.hide() {
                            eprintln!("Cannot hide minimized dashboard: {e}");
                        }
                        if let Err(e) = window.emit("stp-visibility", false) {
                            log::error!("Cannot publish window visibility: {e}");
                        }
                    }
                    Ok(false) => {}
                    Err(error) => eprintln!("Cannot inspect window state: {error}"),
                }
            }
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        log::error!("Startup failed: {error}");
        rfd::MessageDialog::new()
            .set_title(config::branding(None).name)
            .set_description(format!("Cannot start the tray utility:\n{error}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated by GitHub Copilot - Nov-02-2026
    /// Limit debug exceptions to the pinned loopback server without broad localhost trust.
    #[test]
    fn development_origin_is_debug_only_and_exact() {
        assert_eq!(
            application_origin(&url::Url::parse("http://127.0.0.1:1430/index.html").unwrap()),
            cfg!(debug_assertions)
        );
        for value in [
            "http://127.0.0.1:1431/",
            "http://localhost:1430/",
            "http://user@127.0.0.1:1430/",
            "https://127.0.0.1:1430/",
            "http://example.com:1430/",
        ] {
            assert!(!application_origin(&url::Url::parse(value).unwrap()));
        }
    }

    /// Renderer commands may originate only from bundled content, never a loopback web service.
    #[test]
    fn bundled_origins_are_exact() {
        for value in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(bundled_origin(&url::Url::parse(value).unwrap()));
        }
        for value in [
            "http://localhost/",
            "https://localhost/",
            "http://127.0.0.1:4173/",
            "http://tauri.localhost:1234/",
            "https://example.com/",
            "tauri://user@localhost/",
        ] {
            assert!(!bundled_origin(&url::Url::parse(value).unwrap()));
        }
    }
}
