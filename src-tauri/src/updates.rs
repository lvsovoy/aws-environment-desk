
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use reqwest::blocking::{Client, Response};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

const MAX_MANIFEST: u64 = 65_536;
const MAX_ARTIFACT: u64 = 268_435_456;
pub const PUBLIC_KEY: &str = match option_env!("DESK_UPDATE_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};
pub const REPOSITORY: &str = match option_env!("DESK_UPDATE_REPOSITORY") {
    Some(repository) => repository,
    None => "",
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub platforms: BTreeMap<String, Artifact>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub message: String,
    pub available_version: Option<String>,
    pub staged: bool,
    pub verification_configured: bool,
}

/// Build the release root only for a valid owner/repository pair.
fn github_release_root(repository: &str) -> Result<url::Url, String> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    let valid_part = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    if parts.next().is_some() || !valid_part(owner) || !valid_part(name) {
        return Err("This build has no valid GitHub release repository configured.".into());
    }
    url::Url::parse(&format!("https://github.com/{owner}/{name}/releases/"))
        .map_err(|error| error.to_string())
}

/// Resolve one GitHub release asset without accepting a host or path from release metadata.
fn asset_url(root: &url::Url, version: Option<&str>, filename: &str) -> Result<url::Url, String> {
    let release_path = match version {
        Some(version) => format!("download/v{version}/"),
        None => "latest/download/".into(),
    };
    root.join(&release_path)
        .and_then(|url| url.join(filename))
        .map_err(|error| format!("Invalid GitHub release asset URL: {error}"))
}

/// Use bounded network time and an explicit user agent for public GitHub release assets.
fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("AWS-Environment-Desk-Updater")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() >= 10
                || (url.scheme() != "https" && url.host_str() != Some("127.0.0.1"))
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("Cannot initialize update downloads: {error}"))
}

/// Fetch an HTTPS release asset and reject error or oversized responses before reading content.
fn open_asset(client: &Client, url: &url::Url, maximum: u64) -> Result<Response, String> {
    let response = client
        .get(url.clone())
        .send()
        .map_err(|error| format!("Cannot reach the GitHub release: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub release asset unavailable (HTTP {}).",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > maximum)
    {
        return Err("GitHub release asset exceeds its allowed size.".into());
    }
    Ok(response)
}

/// Read a small manifest/signature with a hard bound, even without a content length.
fn read_small(client: &Client, url: &url::Url) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    open_asset(client, url, MAX_MANIFEST)?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("GitHub release metadata exceeds 64 KiB.".into());
    }
    Ok(bytes)
}

/// Accept raw Minisign text or the base64-encoded text produced by Tauri's signer.
fn signature_text(value: &str) -> Result<String, String> {
    if value.starts_with("untrusted comment:") {
        return Ok(value.to_string());
    }
    String::from_utf8(
        STANDARD
            .decode(value.trim())
            .map_err(|e| format!("Invalid signature encoding: {e}"))?,
    )
    .map_err(|e| e.to_string())
}

/// Authenticate metadata before trusting its version, filenames, sizes, or hashes.
pub fn verify_manifest(bytes: &[u8], signature: &str, key: &str) -> Result<Manifest, String> {
    if key.is_empty() {
        return Err("Updates are disabled: build with the release verification public key.".into());
    }
    let public_key = if key.starts_with("untrusted comment:") {
        PublicKey::decode(key)
    } else if key.starts_with("RW") {
        PublicKey::from_base64(key.trim())
    } else {
        PublicKey::decode(&signature_text(key)?)
    }
    .map_err(|e| format!("Invalid embedded release key: {e}"))?;
    let signature = Signature::decode(&signature_text(signature)?).map_err(|e| e.to_string())?;
    public_key
        .verify(bytes, &signature, false)
        .map_err(|_| "Update manifest signature verification failed.".to_string())?;
    serde_json::from_slice(bytes).map_err(|e| format!("Invalid release manifest: {e}"))
}

/// Match native packages, not renderer-supplied platform identifiers.
pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "darwin-aarch64"
    } else {
        "darwin-x86_64"
    }
}

/// Reject traversal, unsupported installers, unreasonable sizes, and malformed digests.
fn validate_artifact(artifact: &Artifact, platform: &str) -> Result<(), String> {
    let path = Path::new(&artifact.file);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
        || artifact.file.contains(['/', '\\', ':'])
        || artifact.size == 0
        || artifact.size > MAX_ARTIFACT
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || (platform.starts_with("windows")
            && path.extension().and_then(|v| v.to_str()) != Some("exe"))
        || (platform.starts_with("darwin")
            && path.extension().and_then(|v| v.to_str()) != Some("dmg"))
    {
        return Err("Release artifact must be a plain platform-specific installer filename with a valid size and SHA-256.".into());
    }
    Ok(())
}

/// Resolve an authenticated, strictly newer platform release from a GitHub release root.
fn check_at(
    root: &url::Url,
    current: &str,
    key: &str,
    client: &Client,
) -> Result<Option<(String, Artifact)>, String> {
    let manifest_name = if platform().starts_with("windows") {
        "windows-latest.json"
    } else {
        "macos-latest.json"
    };
    let signature_name = format!("{manifest_name}.sig");
    let bytes = read_small(client, &asset_url(root, None, manifest_name)?)?;
    let signature = String::from_utf8(read_small(
        client,
        &asset_url(root, None, &signature_name)?,
    )?)
    .map_err(|e| e.to_string())?;
    let manifest = verify_manifest(&bytes, &signature, key)?;
    let version = Version::parse(&manifest.version).map_err(|e| e.to_string())?;
    if version <= Version::parse(current).map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let artifact = manifest
        .platforms
        .get(platform())
        .ok_or("No update is published for this platform.")?
        .clone();
    validate_artifact(&artifact, platform())?;
    Ok(Some((version.to_string(), artifact)))
}

/// Download a verified release asset into local app data and hash bytes before promotion.
pub fn stage(
    repository: &str,
    local: &Path,
    current: &str,
    key: &str,
) -> Result<Option<PathBuf>, String> {
    let root = github_release_root(repository)?;
    let client = http_client()?;
    let Some((version, artifact)) = check_at(&root, current, key, &client)? else {
        return Ok(None);
    };
    stage_artifact(&root, &client, local, &version, &artifact).map(Some)
}


/// Authenticate once, then stage the same release snapshot so the prompt cannot describe a different version.
pub fn prepare(
    repository: &str,
    local: &Path,
    current: &str,
    key: &str,
) -> Result<(UpdateStatus, Option<PathBuf>), String> {
    let root = github_release_root(repository)?;
    let client = http_client()?;
    prepare_at(&root, &client, local, current, key)
}

/// Verify and stage one repository release using an injected root for deterministic tests.
fn prepare_at(
    root: &url::Url,
    client: &Client,
    local: &Path,
    current: &str,
    key: &str,
) -> Result<(UpdateStatus, Option<PathBuf>), String> {
    let Some((version, artifact)) = check_at(root, current, key, client)? else {
        return Ok((
            UpdateStatus {
                verification_configured: true,
                message: "You are up to date.".into(),
                ..Default::default()
            },
            None,
        ));
    };
    let path = stage_artifact(root, client, local, &version, &artifact)?;
    Ok((
        UpdateStatus {
            available_version: Some(version),
            staged: true,
            verification_configured: true,
            message: "Update verified and staged. Confirm the update prompt to start installation."
                .into(),
        },
        Some(path),
    ))
}


/// Download only the authenticated release artifact, verifying bytes before making it installable.
fn stage_artifact(
    root: &url::Url,
    client: &Client,
    local: &Path,
    version: &str,
    artifact: &Artifact,
) -> Result<PathBuf, String> {
    let url = asset_url(root, Some(version), &artifact.file)?;
    let destination = local
        .join("updates")
        .join(format!("{version}-{}", &artifact.sha256[..12]));
    fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let temporary = destination.join("installer.pending");
    let result = (|| {
        let mut input = open_asset(client, &url, MAX_ARTIFACT)?.take(artifact.size + 1);
        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut buffer = [0u8; 65_536];
        let mut digest = Sha256::new();
        let mut length = 0;
        loop {
            let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            length += count as u64;
            if length > artifact.size {
                return Err("Installer size differs from the signed manifest.".into());
            }
            digest.update(&buffer[..count]);
            output
                .write_all(&buffer[..count])
                .map_err(|e| e.to_string())?;
        }
        if length != artifact.size
            || format!("{:x}", digest.finalize()) != artifact.sha256.to_lowercase()
        {
            return Err("Downloaded installer failed size or SHA-256 verification.".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        let target = destination.join(&artifact.file);
        fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
        Ok(target)
    })();
    if result.is_err() && temporary.exists() {
        fs::remove_file(&temporary)
            .map_err(|e| format!("Update failed and staging cleanup failed: {e}"))?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        process::Command,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);

    impl Drop for Fixture {
        /// Remove only this test's uniquely created fixture, including its disposable signing key.
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.0) {
                eprintln!("Cannot clean signed-update fixture: {error}");
            }
        }
    }

    /// Run the repository's existing signer without printing its key material into test output.
    fn signer(arguments: &[&str]) {
        let cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("node_modules")
            .join("@tauri-apps")
            .join("cli")
            .join("tauri.js");
        let result = Command::new("node")
            .arg(cli)
            .args(["signer"])
            .args(arguments)
            .env("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY")
            .env_remove("TAURI_SIGNING_PRIVATE_KEY_PATH")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "Test signer failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    /// Serve a fixed set of release assets over a loopback-only HTTP fixture.
    fn serve_release(files: BTreeMap<String, Vec<u8>>, requests: usize) -> url::Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let asset = request
                    .split_whitespace()
                    .nth(1)
                    .and_then(|path| path.rsplit('/').next())
                    .unwrap_or_default();
                let response = files.get(asset);
                let (status, body) = response
                    .map(|body| ("200 OK", body.as_slice()))
                    .unwrap_or(("404 Not Found", &[]));
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });
        url::Url::parse(&format!("http://{address}/releases/")).unwrap()
    }

    /// Constrain both platforms to signed manifest entries that cannot escape their release directory.
    #[test]
    fn unsafe_artifacts_are_rejected() {
        for file in [
            "../setup.exe",
            "..\\setup.exe",
            "C:\\setup.exe",
            "setup.exe:stream",
            "setup.cmd",
        ] {
            assert!(validate_artifact(
                &Artifact {
                    file: file.into(),
                    sha256: "a".repeat(64),
                    size: 12
                },
                "windows-x86_64"
            )
            .is_err());
        }
        assert!(validate_artifact(
            &Artifact {
                file: "setup.exe".into(),
                sha256: "a".repeat(64),
                size: 12
            },
            "windows-x86_64"
        )
        .is_ok());
        assert!(validate_artifact(
            &Artifact {
                file: "release.dmg".into(),
                sha256: "a".repeat(64),
                size: 12
            },
            "darwin-aarch64"
        )
        .is_ok());
    }

    /// Derive only HTTPS URLs under the requested repository and reject malformed repositories.
    #[test]
    fn release_urls_are_repository_scoped() {
        let root = github_release_root("someone/fork").unwrap();
        assert_eq!(root.as_str(), "https://github.com/someone/fork/releases/");
        assert_eq!(
            asset_url(&root, None, "windows-latest.json")
                .unwrap()
                .as_str(),
            "https://github.com/someone/fork/releases/latest/download/windows-latest.json"
        );
        assert_eq!(
            asset_url(&root, Some("9.9.9"), "installer.exe")
                .unwrap()
                .as_str(),
            "https://github.com/someone/fork/releases/download/v9.9.9/installer.exe"
        );
        for repository in ["", "owner", "owner/repo/extra", "../repo", "owner/.."] {
            assert!(github_release_root(repository).is_err(), "{repository}");
        }
    }

    /// Missing release keys and unauthenticated metadata must never enable installation.
    #[test]
    fn unsigned_updates_are_disabled() {
        assert!(verify_manifest(b"{}", "", "")
            .unwrap_err()
            .contains("disabled"));
        assert!(verify_manifest(b"{}", "invalid", "invalid").is_err());
    }

    /// Verify the upstream known signature and reject modified bytes.
    #[test]
    fn known_signature_verifies() {
        let key = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let sig = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";
        let public_key = PublicKey::from_base64(key).unwrap();
        let signature = Signature::decode(sig).unwrap();
        assert!(public_key.verify(b"test", &signature, false).is_ok());
        assert!(public_key.verify(b"tampered", &signature, false).is_err());
    }

    /// Exercise signed GitHub assets, staging, tamper detection and version gating.
    #[test]
    fn signed_release_lifecycle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "stp-signed-update-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let _fixture = Fixture(directory.clone());
        let key = directory.join("disposable.key");
        signer(&["generate", "--ci", "-w", key.to_str().unwrap(), "-p", ""]);
        let public_key = fs::read_to_string(directory.join("disposable.key.pub")).unwrap();
        let local = directory.join("local");
        let filename = if cfg!(target_os = "windows") {
            "test.exe"
        } else {
            "test.dmg"
        };
        let bytes = b"Simulated installer bytes; this test never executes an installer.";
        let artifact = Artifact {
            file: filename.into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            size: bytes.len() as u64,
        };
        let manifest = Manifest {
            version: "9.9.9".into(),
            platforms: BTreeMap::from([(platform().into(), artifact)]),
        };
        let original = serde_json::to_vec(&manifest).unwrap();
        let metadata = directory.join("latest.json");
        fs::write(&metadata, &original).unwrap();
        signer(&[
            "sign",
            "-f",
            key.to_str().unwrap(),
            metadata.to_str().unwrap(),
        ]);
        let signature = fs::read(metadata.with_extension("json.sig")).unwrap();
        let files = BTreeMap::from([
            (
                if platform().starts_with("windows") {
                    "windows-latest.json"
                } else {
                    "macos-latest.json"
                }
                .into(),
                original.clone(),
            ),
            (
                if platform().starts_with("windows") {
                    "windows-latest.json.sig"
                } else {
                    "macos-latest.json.sig"
                }
                .into(),
                signature.clone(),
            ),
            (filename.into(), bytes.to_vec()),
        ]);
        let root = serve_release(files.clone(), 3);
        let (ready, path) =
            prepare_at(&root, &http_client().unwrap(), &local, "1.1.0", &public_key).unwrap();
        assert!(ready.staged);
        assert_eq!(ready.available_version.as_deref(), Some("9.9.9"));
        assert_eq!(fs::read(path.unwrap()).unwrap(), bytes);

        let mut tampered_files = files.clone();
        tampered_files.insert(filename.into(), b"partial download".to_vec());
        let root = serve_release(tampered_files, 3);
        assert!(prepare_at(&root, &http_client().unwrap(), &local, "1.1.0", &public_key).is_err());

        let root = serve_release(files.clone(), 2);
        let (current, path) =
            prepare_at(&root, &http_client().unwrap(), &local, "9.9.9", &public_key).unwrap();
        assert!(!current.staged);
        assert!(current.available_version.is_none() && path.is_none());
        let mut tampered = original;
        tampered.push(b' ');
        let tampered_files = BTreeMap::from([
            (
                if platform().starts_with("windows") {
                    "windows-latest.json"
                } else {
                    "macos-latest.json"
                }
                .into(),
                tampered,
            ),
            (
                if platform().starts_with("windows") {
                    "windows-latest.json.sig"
                } else {
                    "macos-latest.json.sig"
                }
                .into(),
                signature,
            ),
        ]);
        let root = serve_release(tampered_files, 2);
        assert!(
            check_at(&root, "1.1.0", &public_key, &http_client().unwrap())
                .unwrap_err()
                .contains("signature")
        );
    }
}
