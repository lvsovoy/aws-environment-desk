
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub const ENVIRONMENTS: [&str; 4] = ["dev", "int", "stage", "prod"];
/// Shareable file in the same format as importable configuration files.
pub const CONFIG_FILE: &str = "config.json";
const LEGACY_FILE: &str = "configuration.json";
const MAX_ENVIRONMENTS: usize = 12;
const MAX_CONFIG_BYTES: u64 = 1_048_576;
pub type Profiles = BTreeMap<String, String>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    /// `#rrggbb` dot colour shared by the environment tab and the tray connection indicator.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

const ENVIRONMENT_COLORS: [(&str, &str); 4] = [
    ("dev", "#10b981"),
    ("int", "#06b6d4"),
    ("stage", "#f59e0b"),
    ("prod", "#ef4444"),
];
const EXTRA_COLORS: [&str; 6] = [
    "#a78bfa", "#f472b6", "#84cc16", "#38bdf8", "#fb923c", "#e5e7eb",
];


/// Accept `#rrggbb` colours only.
fn valid_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|c| c.is_ascii_hexdigit())
}


/// Give environments without a colour their default so it is written to config.json; returns whether any changed.
pub fn fill_environment_colors(environments: &mut [Environment]) -> bool {
    let mut changed = false;
    for (index, env) in environments.iter_mut().enumerate() {
        if env.color.is_none() {
            let color = ENVIRONMENT_COLORS
                .iter()
                .find(|(key, _)| *key == env.key)
                .map_or(EXTRA_COLORS[index % EXTRA_COLORS.len()], |(_, color)| color);
            env.color = Some(color.into());
            changed = true;
        }
    }
    changed
}


/// Built-in environment set used when a configuration does not declare its own.
pub fn default_environments() -> Vec<Environment> {
    ENVIRONMENTS
        .into_iter()
        .map(|key| Environment {
            key: key.into(),
            title: key.to_uppercase(),
            sub: None,
            color: None,
        })
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
    pub id: String,
    pub name: String,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    pub links: BTreeMap<String, Option<String>>,
    #[serde(default, rename = "catalogueKey")]
    pub catalogue_key: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default, rename = "badge", skip_serializing)]
    pub _badge: String,
}


/// Accept only raster image URLs from the official Dashboard Icons repository.
pub(crate) fn dashboard_icon(value: &str) -> bool {
    let Some(path) = value.strip_prefix("https://raw.githubusercontent.com/") else {
        return false;
    };
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 5
        && parts[0] == "homarr-labs"
        && parts[1] == "dashboard-icons"
        && (parts[2] == "main"
            || (parts[2].len() == 40
                && parts[2]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))))
        && matches!(parts[3], "png" | "webp")
        && parts[4]
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && (parts[4].ends_with(".png") || parts[4].ends_with(".webp"))
        && parts[4].bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}


/// Importable/shareable configuration format; unknown top-level fields such as branding are preserved.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub vpn: VpnConfig,
    #[serde(default)]
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub apps: Vec<CatalogueApp>,
    /// Device-local choices; ignored when another user's file is imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Preferences>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub setup_complete: bool,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub seen_catalogue_keys: BTreeSet<String>,
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnConfig {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
    /// Environment key to AWS VPN Client profile name.
    #[serde(default)]
    pub default_profiles: Profiles,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogueApp {
    pub key: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub icon: String,
    pub links: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub start_at_login: bool,
    pub shortcut_enabled: bool,
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    pub check_updates_at_startup: bool,
    #[serde(default, rename = "updateDirectory", skip_serializing)]
    pub(crate) _legacy_update_directory: String,
    /// Detected terminal identifier; empty means not chosen.
    pub terminal: String,
    /// Detected browser identifier; empty means the system default browser.
    pub browser: String,
}

/// Return the existing platform-aware focus shortcut for configs that omit it.
fn default_shortcut() -> String {
    "CommandOrControl+Shift+Space".into()
}

impl Default for Preferences {
    /// Keep newly created and older configurations on the established shortcut.
    fn default() -> Self {
        Self {
            start_at_login: false,
            shortcut_enabled: false,
            shortcut: default_shortcut(),
            check_updates_at_startup: false,
            _legacy_update_directory: String::new(),
            terminal: String::new(),
            browser: String::new(),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    #[serde(default = "default_environments")]
    pub environments: Vec<Environment>,
    pub resources: Vec<Resource>,
    pub profiles: Profiles,
    pub preferences: Preferences,
    #[serde(default)]
    pub seen_catalogue_keys: BTreeSet<String>,
    #[serde(default)]
    pub setup_complete: bool,
    /// Preserved shareable-file fields the app does not edit (branding, names).
    #[serde(skip)]
    pub extra: Map<String, Value>,
    #[serde(skip)]
    pub vpn_extra: Map<String, Value>,
}


/// Map each environment to its configured profile, falling back to the environment title.
fn profiles_for(environments: &[Environment], defaults: &Profiles) -> Profiles {
    environments
        .iter()
        .map(|env| {
            let profile = defaults
                .get(&env.key)
                .cloned()
                .unwrap_or_else(|| env.title.clone());
            (env.key.clone(), profile)
        })
        .collect()
}

impl Configuration {
    // Generated by GitHub Copilot - Nov-11-2026
    /// Convert the shareable file format to the runtime model used by the renderer and commands.
    pub fn from_file(file: AppConfig) -> Result<Self, String> {
        validate_app_keys(&file.apps)?;
        let environments = if file.environments.is_empty() {
            default_environments()
        } else {
            file.environments
        };
        Ok(Configuration {
            profiles: profiles_for(&environments, &file.vpn.default_profiles),
            resources: file
                .apps
                .iter()
                .enumerate()
                .map(|(index, app)| catalogue_resource(app, index, &environments))
                .collect(),
            environments,
            preferences: file.preferences.unwrap_or_default(),
            seen_catalogue_keys: file.seen_catalogue_keys,
            setup_complete: file.setup_complete,
            extra: file.extra,
            vpn_extra: file.vpn.extra,
        })
    }

    // Generated by GitHub Copilot - Nov-11-2026
    /// Serialize to the importable format so the saved file can be shared with other users.
    pub fn to_file(&self) -> AppConfig {
        let mut used = BTreeSet::new();
        let apps = self
            .resources
            .iter()
            .map(|resource| {
                let name = resource
                    .display_name
                    .clone()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| resource.name.clone());
                let key = resource
                    .catalogue_key
                    .clone()
                    .filter(|key| valid_key(key, 64) && !used.contains(key))
                    .unwrap_or_else(|| unique_key(&name, &used));
                used.insert(key.clone());
                CatalogueApp {
                    key,
                    name,
                    description: resource.description.clone(),
                    icon: resource.icon.clone(),
                    links: resource.links.clone(),
                }
            })
            .collect();
        AppConfig {
            extra: self.extra.clone(),
            schema_version: 1,
            vpn: VpnConfig {
                extra: self.vpn_extra.clone(),
                default_profiles: self.profiles.clone(),
            },
            environments: self.environments.clone(),
            apps,
            preferences: Some(self.preferences.clone()),
            setup_complete: self.setup_complete,
            seen_catalogue_keys: self.seen_catalogue_keys.clone(),
        }
    }
}


/// Accept stable lowercase identifiers only.
fn valid_key(key: &str, maximum: usize) -> bool {
    !key.is_empty()
        && key.len() <= maximum
        && key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}


/// Derive a unique app key from its display name for locally added apps.
fn unique_key(name: &str, used: &BTreeSet<String>) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    slug.truncate(56);
    let slug = match slug.trim_end_matches('-') {
        "" => "app".to_string(),
        value => value.to_string(),
    };
    let mut candidate = slug.clone();
    let mut counter = 2;
    while used.contains(&candidate) {
        candidate = format!("{slug}-{counter}");
        counter += 1;
    }
    candidate
}


/// Reject duplicate or malformed app keys before they become resource identities.
fn validate_app_keys(apps: &[CatalogueApp]) -> Result<(), String> {
    let mut keys = BTreeSet::new();
    for app in apps {
        if !valid_key(&app.key, 64) || !keys.insert(&app.key) {
            return Err(
                "Catalogue keys must be unique lowercase identifiers of at most 64 bytes.".into(),
            );
        }
    }
    Ok(())
}


/// Refuse oversized files before parsing them.
fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    if fs::metadata(path)?.len() > MAX_CONFIG_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "configuration file exceeds 1 MiB",
        ));
    }
    fs::read(path)
}


/// Parse the release catalogue embedded at build time.
fn bundled() -> Result<AppConfig, String> {
    let bundled: AppConfig = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/bundled_config.json"
    )))
    .map_err(|e| format!("Invalid bundled app catalogue: {e}"))?;
    validate_catalogue(&bundled)?;
    Ok(bundled)
}

const DEFAULT_NAME: &str = "AWS Environment Desk";
const DEFAULT_BACKGROUND: &str = "#202522";
const MAX_ICON_SVG_BYTES: usize = 262_144;


/// Display name and main window icon resolved from config.json, then the bundled config.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branding {
    pub name: String,
    /// Inline `brand.svg` from the local config.json only; the bundled logo is compiled into the app.
    pub icon_svg: Option<String>,
    pub background_color: String,
}


/// Read a nested string field from preserved top-level config fields.
fn text<'a>(extra: &'a Map<String, Value>, path: &[&str]) -> Option<&'a str> {
    let (first, rest) = path.split_first()?;
    rest.iter()
        .try_fold(extra.get(*first)?, |value, key| value.get(key))?
        .as_str()
}


/// Resolve branding without failing: invalid or missing values fall back to bundled/default ones.
pub fn branding(config: Option<&Configuration>) -> Branding {
    let bundled = bundled().map(|file| file.extra).unwrap_or_default();
    let local = config.map(|config| &config.extra);
    let name = |extra: &Map<String, Value>| {
        ["name", "productName"].iter().find_map(|key| {
            text(extra, &[key])
                .map(str::trim)
                .filter(|name| {
                    !name.is_empty() && name.len() <= 64 && !name.chars().any(char::is_control)
                })
                .map(String::from)
        })
    };
    let color = |extra: &Map<String, Value>| {
        text(extra, &["brand", "backgroundColor"])
            .filter(|color| valid_hex_color(color))
            .map(String::from)
    };
    Branding {
        name: local
            .and_then(name)
            .or_else(|| name(&bundled))
            .unwrap_or_else(|| DEFAULT_NAME.into()),
        icon_svg: local
            .and_then(|extra| text(extra, &["brand", "svg"]))
            .map(str::trim)
            .filter(|svg| svg.starts_with("<svg") && svg.len() <= MAX_ICON_SVG_BYTES)
            .map(String::from),
        background_color: local
            .and_then(color)
            .or_else(|| color(&bundled))
            .unwrap_or_else(|| DEFAULT_BACKGROUND.into()),
    }
}


/// First-run configuration: bundled environments and profile defaults, no apps yet, setup pending.
fn first_run(bundled: &AppConfig) -> Result<Configuration, String> {
    Configuration::from_file(AppConfig {
        extra: Map::new(),
        schema_version: 1,
        vpn: VpnConfig {
            extra: Map::new(),
            default_profiles: bundled.vpn.default_profiles.clone(),
        },
        environments: bundled.environments.clone(),
        apps: Vec::new(),
        preferences: None,
        setup_complete: false,
        seen_catalogue_keys: BTreeSet::new(),
    })
}


/// Build a fresh first-run configuration including bundled apps, used when a saved file is unusable.
pub fn fresh() -> Result<Configuration, String> {
    let bundled = bundled()?;
    let mut config = first_run(&bundled)?;
    merge_catalogue(&mut config, &bundled.apps)?;
    Ok(config)
}


/// Read a user-selected shareable file; only environments, profiles and apps are used by the caller.
pub fn read_import(path: &Path) -> Result<Configuration, String> {
    let bytes = read_bounded(path).map_err(|e| format!("Cannot read configuration file: {e}"))?;
    let file: AppConfig =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid configuration file: {e}"))?;
    if file.schema_version != 1 {
        return Err("Unsupported configuration schemaVersion.".into());
    }
    let mut config = Configuration::from_file(file)?;
    config.preferences = Preferences::default();
    fill_environment_colors(&mut config.environments);
    validate(&config)?;
    Ok(config)
}


/// Renumber resources, align their link fields with the configured environments and fill missing colours.
pub fn align_resources(config: &mut Configuration) {
    fill_environment_colors(&mut config.environments);
    let environments = config.environments.clone();
    for (index, resource) in config.resources.iter_mut().enumerate() {
        resource.id = index.to_string();
        resource.links = environments
            .iter()
            .map(|env| {
                let link = resource.links.get(&env.key).cloned().flatten();
                (env.key.clone(), link)
            })
            .collect();
    }
}

/// Merge newly released catalogue entries without replacing local edits or restoring removed entries.
pub fn load(directory: &Path) -> Result<Configuration, String> {
    let bundled = bundled()?;
    let mut changed = false;
    let mut config = match read_bounded(&directory.join(CONFIG_FILE)) {
        Ok(bytes) => {
            let file: AppConfig = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid {CONFIG_FILE}: {e}"))?;
            Configuration::from_file(file)?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            changed = true;
            match fs::read(directory.join(LEGACY_FILE)) {
                // Existing installations were already configured; migrate without forcing the wizard.
                Ok(bytes) => {
                    let mut legacy: Configuration = serde_json::from_slice(&bytes)
                        .map_err(|e| format!("Invalid saved configuration: {e}"))?;
                    legacy.setup_complete = true;
                    legacy
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => first_run(&bundled)?,
                Err(e) => return Err(format!("Cannot read local configuration: {e}")),
            }
        }
        Err(e) => return Err(format!("Cannot read local configuration: {e}")),
    };
    changed |= fill_environment_colors(&mut config.environments);
    // Upgrade old symbolic artwork only; explicit local icon choices survive restarts.
    for resource in &mut config.resources {
        if resource.icon == "badge" {
            resource.icon.clear();
            changed = true;
        } else if matches!(resource.icon.as_str(), "aws" | "gitlab") {
            resource.icon = bundled
                .apps
                .iter()
                .find(|app| Some(&app.key) == resource.catalogue_key.as_ref())
                .map(|app| app.icon.clone())
                .unwrap_or_default();
            changed = true;
        }
    }
    validate(&config)?;
    if merge_catalogue(&mut config, &bundled.apps)? || changed {
        save(directory, &config)?;
    }
    Ok(config)
}


/// Require stable unique keys and validate catalogue resources with the runtime's destination rules.
fn validate_catalogue(catalogue: &AppConfig) -> Result<(), String> {
    if catalogue.schema_version != 1 {
        return Err("Unsupported app catalogue schemaVersion.".into());
    }
    let mut config = Configuration::from_file(catalogue.clone())?;
    config.preferences = Preferences::default();
    validate(&config)
}


/// Convert an authored catalogue entry to the sequential runtime resource format for the given environments.
fn catalogue_resource(app: &CatalogueApp, index: usize, environments: &[Environment]) -> Resource {
    Resource {
        id: index.to_string(),
        name: app.name.clone(),
        display_name: None,
        links: environments
            .iter()
            .map(|env| (env.key.clone(), app.links.get(&env.key).cloned().flatten()))
            .collect(),
        catalogue_key: Some(app.key.clone()),
        description: app.description.clone(),
        icon: app.icon.clone(),
        _badge: String::new(),
    }
}


/// Append only unseen stable keys; local edits and removals remain unchanged.
fn merge_catalogue(config: &mut Configuration, apps: &[CatalogueApp]) -> Result<bool, String> {
    let before = serde_json::to_vec(config).map_err(|e| e.to_string())?;
    for app in apps {
        if !config.seen_catalogue_keys.insert(app.key.clone()) {
            continue;
        }
        if !config
            .resources
            .iter()
            .any(|resource| resource.catalogue_key.as_ref() == Some(&app.key))
        {
            let resource = catalogue_resource(app, config.resources.len(), &config.environments);
            config.resources.push(resource);
        }
    }
    validate(config)?;
    Ok(before != serde_json::to_vec(config).map_err(|e| e.to_string())?)
}


/// Profile names reach the VPN CLI as arguments; reject blanks, control characters and option-like names.
pub fn valid_profile_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 256
        && !name.starts_with('-')
        && !name.chars().any(char::is_control)
}


/// Require 1-12 uniquely keyed, titled environments.
fn validate_environments(environments: &[Environment]) -> Result<(), String> {
    if environments.is_empty() || environments.len() > MAX_ENVIRONMENTS {
        return Err(format!(
            "Configure between 1 and {MAX_ENVIRONMENTS} environments."
        ));
    }
    let mut keys = BTreeSet::new();
    for env in environments {
        if !valid_key(&env.key, 32) || !keys.insert(&env.key) {
            return Err(
                "Environment keys must be unique lowercase identifiers of at most 32 characters."
                    .into(),
            );
        }
        if env.title.trim().is_empty()
            || env.title.len() > 32
            || env.title.chars().any(char::is_control)
            || env
                .sub
                .as_ref()
                .is_some_and(|sub| sub.len() > 64 || sub.chars().any(char::is_control))
        {
            return Err(
                "Environment titles must be 1-32 characters without control characters.".into(),
            );
        }
        if env
            .color
            .as_deref()
            .is_some_and(|color| !valid_hex_color(color))
        {
            return Err(format!(
                "Environment {} colour must be a #rrggbb value.",
                env.key
            ));
        }
    }
    Ok(())
}

/// Validate persisted and renderer-supplied values before privileged use.
pub fn validate(config: &Configuration) -> Result<(), String> {
    validate_environments(&config.environments)?;
    if config.profiles.len() != config.environments.len()
        || config.environments.iter().any(|env| {
            config
                .profiles
                .get(&env.key)
                .is_none_or(|name| !valid_profile_name(name))
        })
    {
        return Err(
            "Supply one VPN profile name per environment, without control characters or a leading dash.".into(),
        );
    }
    if config.resources.len() > 100 {
        return Err("Configure at most 100 resources.".into());
    }
    for (index, resource) in config.resources.iter().enumerate() {
        if resource
            .display_name
            .as_ref()
            .is_some_and(|name| name.len() > 128)
            || resource.description.len() > 512
            || !(resource.icon.is_empty()
                || resource.icon == "badge"
                || dashboard_icon(&resource.icon))
        {
            return Err("Use an empty icon or a Dashboard Icons PNG/WebP URL and a description up to 512 bytes.".into());
        }
        if resource.id != index.to_string()
            || resource.name.trim().is_empty()
            || resource.name.len() > 128
        {
            return Err("Resource IDs must be sequential and each resource needs a name of at most 128 bytes.".into());
        }
        if resource.links.len() != config.environments.len()
            || config
                .environments
                .iter()
                .any(|env| !resource.links.contains_key(&env.key))
        {
            return Err("Every resource must contain one link field per environment.".into());
        }
        for value in resource.links.values().flatten() {
            let url = url::Url::parse(value).map_err(|e| format!("Invalid resource URL: {e}"))?;
            if value.len() > 8192
                || url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(
                    "Resource destinations must be HTTPS URLs without embedded credentials.".into(),
                );
            }
        }
    }
    let preferences = &config.preferences;
    preferences
        .shortcut
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|_| "Configure a valid keyboard shortcut.".to_string())?;
    if !(preferences.terminal.is_empty() || crate::setup::known_terminal(&preferences.terminal))
        || !(preferences.browser.is_empty() || crate::setup::known_browser(&preferences.browser))
    {
        return Err("Choose a supported terminal and browser.".into());
    }
    Ok(())
}


/// Location of the shareable configuration file.
pub fn config_path(directory: &Path) -> PathBuf {
    directory.join(CONFIG_FILE)
}

/// Commit a complete configuration using a same-directory replacement.
pub fn save(directory: &Path, config: &Configuration) -> Result<(), String> {
    validate(config)?;
    fs::create_dir_all(directory)
        .map_err(|e| format!("Cannot create configuration directory: {e}"))?;
    let temporary = directory.join("config.pending.json");
    let target = config_path(directory);
    let mut bytes = serde_json::to_vec_pretty(&config.to_file()).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    // Rust's rename replaces an existing file on both supported platforms.
    fs::rename(&temporary, &target).map_err(|e| format!("Cannot commit configuration: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated by GitHub Copilot - Nov-02-2026
    /// Load test catalogues through the same deserializer and validator as installed releases.
    fn catalogue() -> AppConfig {
        let value: AppConfig = serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/bundled_config.json"
        )))
        .or_else(|_| serde_json::from_str(include_str!("../../config/config.example.json")))
        .unwrap();
        validate_catalogue(&value).unwrap();
        value
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// Create a new unseen app entry without using private endpoints or touching user settings.
    fn extra_app() -> CatalogueApp {
        CatalogueApp {
            key: "new-console".into(),
            name: "New Console".into(),
            description: "New release app".into(),
            icon: String::new(),
            links: ENVIRONMENTS
                .into_iter()
                .map(|env| (env.into(), Some("https://example.com/".into())))
                .collect(),
        }
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// New versions add apps once without replacing local URLs, renamed apps, profile mappings or removals.
    #[test]
    fn catalogue_merge_preserves_user_edits_and_removals() {
        let mut catalogue = catalogue();
        let original_count = catalogue.apps.len();
        let mut config = Configuration {
            environments: default_environments(),
            resources: catalogue
                .apps
                .iter()
                .enumerate()
                .map(|(index, app)| catalogue_resource(app, index, &default_environments()))
                .collect(),
            profiles: ENVIRONMENTS
                .into_iter()
                .map(|env| (env.into(), "Local Profile".into()))
                .collect(),
            seen_catalogue_keys: catalogue.apps.iter().map(|app| app.key.clone()).collect(),
            ..Default::default()
        };
        config.resources[0].name = "My Console".into();
        config.resources[0]
            .links
            .insert("dev".into(), Some("https://edited.example.com/".into()));
        config.resources.pop();
        catalogue.apps.push(extra_app());
        assert!(merge_catalogue(&mut config, &catalogue.apps).unwrap());
        assert_eq!(config.resources.len(), original_count);
        assert_eq!(config.resources[0].name, "My Console");
        assert_eq!(
            config.resources[0].links["dev"].as_deref(),
            Some("https://edited.example.com/")
        );
        assert_eq!(config.profiles["dev"], "Local Profile");
        assert_eq!(
            config.resources[original_count - 1]
                .catalogue_key
                .as_deref(),
            Some("new-console")
        );
        assert!(!merge_catalogue(&mut config, &catalogue.apps).unwrap());
        config.resources.pop();
        assert!(!merge_catalogue(&mut config, &catalogue.apps).unwrap());
        assert_eq!(config.resources.len(), original_count - 1);
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// Do not infer identity from display names; stable keys exclusively determine catalogue membership.
    #[test]
    fn catalogue_identity_uses_keys_only() {
        let mut catalogue = catalogue();
        let original_count = catalogue.apps.len();
        let resource = Resource {
            id: "0".into(),
            name: "ops console".into(),
            display_name: None,
            links: ENVIRONMENTS
                .into_iter()
                .map(|env| (env.into(), Some("https://custom.example.com/".into())))
                .collect(),
            catalogue_key: None,
            description: String::new(),
            icon: String::new(),
            _badge: String::new(),
        };
        let mut config = Configuration {
            environments: default_environments(),
            resources: vec![resource],
            profiles: ENVIRONMENTS
                .into_iter()
                .map(|env| (env.into(), env.into()))
                .collect(),
            ..Default::default()
        };
        catalogue.apps.push(extra_app());
        assert!(merge_catalogue(&mut config, &catalogue.apps).unwrap());
        assert_eq!(config.resources.len(), original_count + 2);
        assert_eq!(config.resources[0].name, "ops console");
        assert!(config.resources[0].display_name.is_none());
        assert_eq!(
            config.resources[0].links["dev"].as_deref(),
            Some("https://custom.example.com/")
        );
        assert_eq!(config.seen_catalogue_keys.len(), original_count + 1);
        assert!(!merge_catalogue(&mut config, &catalogue.apps).unwrap());
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// Malformed release catalogues must fail rather than silently dropping apps or permitting remote icons.
    #[test]
    fn invalid_catalogues_are_rejected() {
        let mut value = catalogue();
        value.apps.push(extra_app());
        value.apps.push(extra_app());
        assert!(validate_catalogue(&value).is_err());
        value.apps.pop();
        value.apps[0].icon = "https://example.com/icon.svg".into();
        assert!(validate_catalogue(&value).is_err());
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// Keep native icon validation identical to the build allowlist, without URL normalization.
    #[test]
    fn dashboard_icons_allow_only_exact_repository_raster_paths() {
        let base = "https://raw.githubusercontent.com/homarr-labs/dashboard-icons/";
        assert!(dashboard_icon(&format!("{base}main/png/aws.png")));
        assert!(dashboard_icon(&format!(
            "{base}{}/webp/gitlab.webp",
            "a".repeat(40)
        )));
        for path in [
            "main/svg/aws.svg",
            "main/png/../png/aws.png",
            "main/png/aws.png?x=1",
            "main/png/aws.png#hash",
            "main/png/.png",
            "latest/png/aws.png",
        ] {
            assert!(!dashboard_icon(&format!("{base}{path}")), "{path}");
        }
        assert!(!dashboard_icon("aws"));
        assert!(!dashboard_icon(
            "https://raw.githubusercontent.com:443/homarr-labs/dashboard-icons/main/png/aws.png"
        ));
    }

    /// Accept prior OneDrive settings for migration but never write the obsolete path again.
    #[test]
    fn legacy_update_directory_is_not_reserialized() {
        let preferences: Preferences = serde_json::from_value(serde_json::json!({
            "updateDirectory": "C:\\old-release-folder"
        }))
        .unwrap();
        assert_eq!(preferences.shortcut, "CommandOrControl+Shift+Space");
        let saved = serde_json::to_value(preferences).unwrap();
        assert!(saved.get("updateDirectory").is_none());
    }

    /// Exercise local persistence and fail-closed destination validation without touching user data.
    #[test]
    fn configuration_round_trip() {
        let directory =
            std::env::temp_dir().join(format!("stp-config-test-{}", std::process::id()));
        let mut config = load(&directory).unwrap();
        assert!(!config.preferences.check_updates_at_startup);
        config.preferences.check_updates_at_startup = true;
        config.profiles.insert("dev".into(), "Edited DEV".into());
        save(&directory, &config).unwrap();
        assert_eq!(load(&directory).unwrap().profiles["dev"], "Edited DEV");
        assert!(
            load(&directory)
                .unwrap()
                .preferences
                .check_updates_at_startup
        );
        // Upgrade symbolic artwork once without replacing explicit local choices on later loads.
        config.resources[1].icon = "aws".into();
        fs::write(
            config_path(&directory),
            serde_json::to_vec(&config.to_file()).unwrap(),
        )
        .unwrap();
        let updated = load(&directory).unwrap();
        assert_eq!(updated.resources[1].icon, catalogue().apps[1].icon);
        let persisted: AppConfig =
            serde_json::from_slice(&fs::read(config_path(&directory)).unwrap()).unwrap();
        assert_eq!(persisted.apps[1].icon, updated.resources[1].icon);
        config.resources[1].icon = String::new();
        config.resources[1]._badge = "OLD".into();
        save(&directory, &config).unwrap();
        assert!(load(&directory).unwrap().resources[1].icon.is_empty());
        assert!(!fs::read_to_string(config_path(&directory))
            .unwrap()
            .contains("\"badge\""));
        config.resources[0]
            .links
            .insert("dev".into(), Some("file:///private".into()));
        assert!(validate(&config).is_err());
        config.resources[0]
            .links
            .insert("dev".into(), Some("https://user:pass@example.com".into()));
        assert!(validate(&config).is_err());
        fs::remove_file(config_path(&directory)).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    // Generated by GitHub Copilot - Nov-11-2026
    /// The saved file is importable: custom environments, profiles, apps and branding survive a round trip.
    #[test]
    fn shareable_file_round_trips_custom_environments() {
        let directory =
            std::env::temp_dir().join(format!("stp-shared-test-{}", std::process::id()));
        let environments = vec![
            Environment {
                key: "dev".into(),
                title: "DEV".into(),
                sub: None,
                color: Some("#123456".into()),
            },
            Environment {
                key: "qa".into(),
                title: "QA".into(),
                sub: Some("QA VPN".into()),
                color: Some("#abcdef".into()),
            },
        ];
        let resource = Resource {
            id: "0".into(),
            name: "Local Tool".into(),
            display_name: None,
            links: BTreeMap::from([
                ("dev".into(), Some("https://dev.example.com/".into())),
                ("qa".into(), None),
            ]),
            catalogue_key: None,
            description: String::new(),
            icon: String::new(),
            _badge: String::new(),
        };
        let mut config = Configuration {
            profiles: BTreeMap::from([
                ("dev".into(), "Dev Profile".into()),
                ("qa".into(), "QA Profile".into()),
            ]),
            environments,
            resources: vec![resource],
            seen_catalogue_keys: catalogue().apps.iter().map(|app| app.key.clone()).collect(),
            setup_complete: true,
            ..Default::default()
        };
        config.extra.insert("name".into(), "Team Desk".into());
        config.preferences.browser = "edge".into();
        save(&directory, &config).unwrap();
        let raw: Value =
            serde_json::from_slice(&fs::read(config_path(&directory)).unwrap()).unwrap();
        assert_eq!(raw["name"], "Team Desk");
        assert_eq!(raw["vpn"]["defaultProfiles"]["qa"], "QA Profile");
        assert_eq!(raw["apps"][0]["key"], "local-tool");
        assert_eq!(raw["environments"][1]["key"], "qa");
        let loaded = load(&directory).unwrap();
        assert_eq!(loaded.environments, config.environments);
        assert_eq!(loaded.profiles, config.profiles);
        assert!(loaded.setup_complete);
        assert_eq!(loaded.preferences.browser, "edge");
        let imported = read_import(&config_path(&directory)).unwrap();
        assert_eq!(
            imported.resources[0].links["dev"].as_deref(),
            Some("https://dev.example.com/")
        );
        assert!(imported.preferences.browser.is_empty());
        fs::remove_file(config_path(&directory)).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    // Generated by GitHub Copilot - Nov-11-2026
    /// Existing installations migrate to config.json and are not asked to run setup again.
    #[test]
    fn legacy_configuration_migrates_without_setup_prompt() {
        let directory =
            std::env::temp_dir().join(format!("stp-legacy-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let links: BTreeMap<_, _> = ENVIRONMENTS
            .into_iter()
            .map(|env| (env.to_string(), Some("https://example.com/".to_string())))
            .collect();
        let legacy = serde_json::json!({
            "resources": [{ "id": "0", "name": "Legacy", "links": links }],
            "profiles": { "dev": "D", "int": "I", "stage": "S", "prod": "P" },
            "preferences": {},
        });
        fs::write(directory.join(LEGACY_FILE), legacy.to_string()).unwrap();
        let config = load(&directory).unwrap();
        assert!(config.setup_complete);
        let colors: Vec<_> = config
            .environments
            .iter()
            .map(|env| env.color.as_deref().unwrap())
            .collect();
        assert_eq!(colors, ["#10b981", "#06b6d4", "#f59e0b", "#ef4444"]);
        assert!(fs::read_to_string(config_path(&directory))
            .unwrap()
            .contains("\"color\": \"#10b981\""));
        assert_eq!(config.resources[0].name, "Legacy");
        assert!(config_path(&directory).is_file());
        fs::remove_file(config_path(&directory)).unwrap();
        fs::remove_file(directory.join(LEGACY_FILE)).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    // Generated by GitHub Copilot - Nov-11-2026
    /// Local config.json overrides the bundled name and icon; invalid values fall back safely.
    #[test]
    fn branding_prefers_local_configuration() {
        let mut config = Configuration::default();
        assert!(branding(Some(&config)).icon_svg.is_none());
        assert!(!branding(None).name.is_empty());
        config.extra.insert("name".into(), "Team Desk".into());
        config.extra.insert(
            "brand".into(),
            serde_json::json!({ "svg": "<svg></svg>", "backgroundColor": "#123abc" }),
        );
        let local = branding(Some(&config));
        assert_eq!(local.name, "Team Desk");
        assert_eq!(local.icon_svg.as_deref(), Some("<svg></svg>"));
        assert_eq!(local.background_color, "#123abc");
        config.extra.insert("name".into(), "Bad\nName".into());
        config.extra.insert(
            "brand".into(),
            serde_json::json!({ "svg": "<script/>", "backgroundColor": "red" }),
        );
        let fallback = branding(Some(&config));
        assert_eq!(fallback.name, branding(None).name);
        assert!(fallback.icon_svg.is_none());
        assert_eq!(fallback.background_color, branding(None).background_color);
    }

    // Generated by GitHub Copilot - Nov-11-2026
    /// Environment edits must keep keys unique and links/profiles aligned.
    #[test]
    fn environment_changes_are_validated_and_aligned() {
        let mut config = Configuration::from_file(catalogue()).unwrap();
        config.environments.push(Environment {
            key: "qa".into(),
            title: "QA".into(),
            sub: None,
            color: None,
        });
        assert!(validate(&config).is_err());
        config.profiles.insert("qa".into(), "QA".into());
        assert!(validate(&config).is_err());
        align_resources(&mut config);
        validate(&config).unwrap();
        assert_eq!(config.environments[4].color.as_deref(), Some("#fb923c"));
        config.environments[4].color = Some("green".into());
        assert!(validate(&config).is_err());
        config.environments[4].color = Some("#00ff00".into());
        assert!(config
            .resources
            .iter()
            .all(|resource| resource.links["qa"].is_none()));
        config.environments.retain(|env| env.key != "int");
        config.profiles.remove("int");
        align_resources(&mut config);
        validate(&config).unwrap();
        config.profiles.insert("dev".into(), "--global".into());
        assert!(validate(&config).is_err());
        config.profiles.insert("dev".into(), "D".into());
        config.environments[1].key = "dev".into();
        assert!(validate(&config).is_err());
    }
}
