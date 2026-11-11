
use serde::Serialize;
use serde_json::Value;
use std::{
    future::Future,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex as AsyncMutex, Notify},
    time::{sleep, timeout},
};

const READ_TIMEOUT: Duration = Duration::from_secs(5);
const SWITCH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT: u64 = 1_048_576;
static CLI_COMMANDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Count this process's CLI execution attempts for permission-free idle verification.
pub fn command_count() -> usize {
    CLI_COMMANDS.load(Ordering::SeqCst)
}

#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    pub connections: Vec<Connection>,
    pub busy: bool,
    pub message: String,
    pub error: String,
}

#[derive(Clone, Serialize)]
pub struct Connection {
    pub profile: String,
    pub status: String,
}

#[derive(Default)]
pub struct Controller {
    gate: AsyncMutex<()>,
    snapshot: Mutex<Snapshot>,
    probe_cancel: Notify,
    switch_cancel: Notify,
    cancel_requested: AtomicBool,
}

struct Operation<'a>(&'a Mutex<Snapshot>);

impl Drop for Operation<'_> {
    /// Release the UI operation lock on success, error, timeout, or task cancellation.
    fn drop(&mut self) {
        let mut state = self.0.lock().expect("VPN state poisoned");
        state.busy = false;
        state.message.clear();
    }
}

/// Resolve only an installed client or an explicitly configured absolute executable.
fn cli_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DESK_VPN_CLI") {
        let path = PathBuf::from(path);
        if !path.is_absolute() || !path.is_file() {
            return Err("DESK_VPN_CLI must point to an existing absolute executable path.".into());
        }
        return Ok(path);
    }
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &[r"C:\Program Files\Amazon\AWS VPN Client\aws-vpn-client.exe"]
    } else {
        &[
            "/Applications/AWS VPN Client/AWS VPN Client.app/Contents/MacOS/aws-vpn-client",
            "/Applications/AWS VPN Client.app/Contents/MacOS/aws-vpn-client",
        ]
    };
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "AWS VPN Client CLI not found. Install Client 6.x or configure DESK_VPN_CLI.".into()
        })
}

/// Execute fixed CLI arguments without a shell; cancellation kills only the spawned CLI.
async fn run_cli(args: Vec<String>) -> Result<Value, String> {
    CLI_COMMANDS.fetch_add(1, Ordering::SeqCst);
    let reading = matches!(
        args[0].as_str(),
        "list-connections" | "get-connection-status" | "list-profiles"
    );
    let mut command = Command::new(cli_path()?);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start AWS VPN CLI: {e}"))?;
    let stdout = child.stdout.take().ok_or("Cannot capture VPN output.")?;
    let output = async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err("AWS VPN CLI returned excessive output.".into());
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            // The CLI reports failures as {"status":"Error","message":...} on stdout.
            let detail = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|value| {
                    value["message"].as_str().map(|message| {
                        message
                            .chars()
                            .filter(|c| !c.is_control())
                            .take(300)
                            .collect::<String>()
                    })
                });
            return Err(match detail {
                Some(message) => format!("AWS VPN CLI failed: {message}"),
                None => "AWS VPN CLI failed. Check the client and your SSO/MFA session.".into(),
            });
        }
        if reading {
            serde_json::from_slice(&bytes).map_err(|e| format!("Unrecognized VPN response: {e}"))
        } else {
            Ok(Value::Null)
        }
    };
    timeout(
        if reading {
            READ_TIMEOUT
        } else {
            Duration::from_secs(45)
        },
        output,
    )
    .await
    .map_err(|_| "AWS VPN CLI timed out. Check the client and any SSO/MFA prompt.".to_string())?
}

/// Parse profile names without returning client identity or configuration to the renderer.
fn connection_names(value: Value) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in value
        .as_array()
        .ok_or("Unrecognized VPN connection list.")?
    {
        let name = entry["profile-name"]
            .as_str()
            .ok_or("Unrecognized VPN profile name.")?;
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// Require an explicit status string before making any navigation decision.
fn status_name(value: Value) -> Result<String, String> {
    value["connection-status"]
        .as_str()
        .map(str::to_string)
        .ok_or("Unrecognized VPN status.".into())
}

/// Build arguments from a fixed command and locally configured profile, never a shell expression.
fn arguments(command: &str, profile: &str) -> Vec<String> {
    vec![command.into(), "--profile-name".into(), profile.into()]
}


/// Report whether the AWS VPN Client CLI is installed, without executing it.
pub fn client_installed() -> bool {
    cli_path().is_ok()
}


/// List profile names imported into AWS VPN Client.
pub async fn list_profiles() -> Result<Vec<String>, String> {
    connection_names(run_cli(vec!["list-profiles".into()]).await?)
}


/// Import a user-selected .ovpn file as a per-user AWS VPN Client profile.
pub async fn import_profile(profile: &str, config_path: &std::path::Path) -> Result<(), String> {
    let mut args = arguments("import-profile", profile);
    args.extend([
        "--config-path".into(),
        config_path.to_string_lossy().into_owned(),
    ]);
    run_cli(args).await.map(|_| ())
}

impl Controller {
    /// Return a nonblocking cached display state, never used to authorize opening a resource.
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().expect("VPN state poisoned").clone()
    }

    /// Store progress independently from the renderer so native tray actions report the same operation.
    fn message(&self, message: String) {
        self.snapshot.lock().expect("VPN state poisoned").message = message;
    }

    /// Coalesce status reads; a switch or another poll returns the current display snapshot.
    pub async fn refresh(&self) -> Result<Snapshot, String> {
        let Ok(_guard) = self.gate.try_lock() else {
            return Ok(self.snapshot());
        };
        let result = async {
            let names = connection_names(run_cli(vec!["list-connections".into()]).await?)?;
            let mut connections = Vec::new();
            for profile in names {
                let status =
                    status_name(run_cli(arguments("get-connection-status", &profile)).await?)?;
                connections.push(Connection { profile, status });
            }
            Ok::<_, String>(connections)
        };
        let result = tokio::select! {
            biased;
            _ = self.probe_cancel.notified() => return Ok(self.snapshot()),
            result = timeout(Duration::from_secs(10), result) => result,
        };
        match result {
            Ok(Ok(connections)) => {
                let mut state = self.snapshot.lock().expect("VPN state poisoned");
                state.connections = connections;
                state.error.clear();
                Ok(state.clone())
            }
            result => {
                let error = match result {
                    Ok(Err(error)) => error,
                    _ => "VPN status check exceeded 10 seconds.".into(),
                };
                self.snapshot.lock().expect("VPN state poisoned").error = error.clone();
                Err(error)
            }
        }
    }

    /// Confirm actual connectivity with a hard wall-clock limit, preserving machine-wide exclusivity.
    pub async fn ensure(&self, profile: &str) -> Result<(), String> {
        self.ensure_with(profile, SWITCH_TIMEOUT, run_cli).await
    }

    /// Stop waiting and kill only the CLI subprocess, never claim the VPN service was disconnected.
    pub fn cancel_wait(&self) {
        self.cancel_requested.store(true, Ordering::SeqCst);
        self.switch_cancel.notify_one();
    }

    /// Inject CLI execution and deadline for deterministic tests without changing a real VPN.
    async fn ensure_with<R, F>(
        &self,
        profile: &str,
        deadline: Duration,
        run: R,
    ) -> Result<(), String>
    where
        R: Fn(Vec<String>) -> F,
        F: Future<Output = Result<Value, String>>,
    {
        self.operate_with(profile, deadline, run, false).await
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// Disconnect only the configured selected profile and confirm completion within the shared deadline.
    pub async fn disconnect(&self, profile: &str) -> Result<(), String> {
        self.operate_with(profile, SWITCH_TIMEOUT, run_cli, true)
            .await
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// Share serialization, cancellation and time limits across explicit VPN mutations.
    async fn operate_with<R, F>(
        &self,
        profile: &str,
        deadline: Duration,
        run: R,
        disconnect: bool,
    ) -> Result<(), String>
    where
        R: Fn(Vec<String>) -> F,
        F: Future<Output = Result<Value, String>>,
    {
        if self.snapshot().busy {
            return Err("A VPN switch is already in progress.".into());
        }
        self.probe_cancel.notify_waiters();
        let _guard = self.gate.lock().await;
        self.cancel_requested.store(false, Ordering::SeqCst);
        {
            let mut state = self.snapshot.lock().expect("VPN state poisoned");
            state.busy = true;
            state.error.clear();
        }
        let _operation = Operation(&self.snapshot);
        let switch = async {
            self.message(format!("Checking {profile}"));
            if disconnect {
                if status_name(run(arguments("get-connection-status", profile)).await?)?
                    != "NotConnected"
                {
                    self.message(format!("Disconnecting {profile}"));
                    run(arguments("disconnect", profile)).await?;
                    loop {
                        if status_name(run(arguments("get-connection-status", profile)).await?)?
                            == "NotConnected"
                        {
                            break;
                        }
                        sleep(Duration::from_secs(2)).await;
                    }
                }
                self.snapshot
                    .lock()
                    .expect("VPN state poisoned")
                    .connections
                    .retain(|connection| connection.profile != profile);
                return Ok(());
            }
            if status_name(run(arguments("get-connection-status", profile)).await?)? == "Connected"
            {
                return Ok(());
            }
            for active in connection_names(run(vec!["list-connections".into()]).await?)? {
                self.message(format!("Disconnecting {active}"));
                run(arguments("disconnect", &active)).await?;
                loop {
                    if status_name(run(arguments("get-connection-status", &active)).await?)?
                        == "NotConnected"
                    {
                        break;
                    }
                    sleep(Duration::from_secs(2)).await;
                }
            }
            self.message(format!(
                "Connecting {profile}. Complete SSO/MFA if prompted."
            ));
            run(arguments("connect", profile)).await?;
            loop {
                if status_name(run(arguments("get-connection-status", profile)).await?)?
                    == "Connected"
                {
                    break;
                }
                sleep(Duration::from_secs(2)).await;
            }
            Ok::<(), String>(())
        };
        let cancelled = async {
            loop {
                if self.cancel_requested.load(Ordering::SeqCst) {
                    break;
                }
                self.switch_cancel.notified().await;
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancelled => Err("Stopped waiting. No resource was opened. The underlying VPN operation may still complete; check AWS VPN Client before retrying.".into()),
            result = timeout(deadline, switch) => result.unwrap_or_else(|_| Err(
                "VPN operation exceeded its deadline. No resource was opened. Check AWS VPN Client before retrying; the underlying operation may still complete.".into()
            )),
        };
        if let Err(error) = &result {
            self.snapshot.lock().expect("VPN state poisoned").error = error.clone();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Generated by GitHub Copilot - Nov-02-2026
    /// Disconnect exactly the requested profile, without connecting or mutating unrelated VPNs.
    #[test]
    fn disconnect_selected_profile() {
        tauri::async_runtime::block_on(async {
            let controller = Controller::default();
            let calls = Mutex::new(Vec::new());
            controller.operate_with("DEV", Duration::from_secs(1), |args| {
                let mut history = calls.lock().unwrap();
                history.push(args.clone());
                let value = if args[0] == "disconnect" { Value::Null } else {
                    serde_json::json!({"connection-status": if history.len() == 1 { "Connected" } else { "NotConnected" }})
                };
                std::future::ready(Ok(value))
            }, true).await.unwrap();
            assert_eq!(
                *calls.lock().unwrap(),
                vec![
                    arguments("get-connection-status", "DEV"),
                    arguments("disconnect", "DEV"),
                    arguments("get-connection-status", "DEV")
                ]
            );
            assert!(!controller.snapshot().busy);
        });
    }

    // Generated by GitHub Copilot - Nov-02-2026
    /// A hung disconnect releases the same operation lock as a hung connection.
    #[test]
    fn disconnect_deadline_releases_lock() {
        tauri::async_runtime::block_on(async {
            let controller = Controller::default();
            let result = controller
                .operate_with(
                    "DEV",
                    Duration::from_millis(20),
                    |_| std::future::pending::<Result<Value, String>>(),
                    true,
                )
                .await;
            assert!(result.unwrap_err().contains("deadline"));
            assert!(!controller.snapshot().busy);
            assert!(controller.gate.try_lock().is_ok());
        });
    }

    /// Verify a connected target requires exactly one fresh read and no mutation.
    #[test]
    fn connected_target_is_reused() {
        tauri::async_runtime::block_on(async {
            let calls = AtomicUsize::new(0);
            let controller = Controller::default();
            controller
                .ensure_with("DEV", Duration::from_secs(1), |args| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(args[0], "get-connection-status");
                    std::future::ready(Ok(serde_json::json!({"connection-status": "Connected"})))
                })
                .await
                .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert!(!controller.snapshot().busy);
        });
    }

    /// A stalled command must release the operation gate within the overall deadline.
    #[test]
    fn deadline_releases_busy_state() {
        tauri::async_runtime::block_on(async {
            let controller = Controller::default();
            let result = controller
                .ensure_with("DEV", Duration::from_millis(20), |_| {
                    std::future::pending::<Result<Value, String>>()
                })
                .await;
            assert!(result.unwrap_err().contains("deadline"));
            assert!(!controller.snapshot().busy);
            assert!(controller.gate.try_lock().is_ok());
        });
    }

    /// Malformed CLI responses must fail closed instead of authorizing a destination.
    #[test]
    fn malformed_responses_are_rejected() {
        assert!(connection_names(serde_json::json!([{"identity": "private"}])).is_err());
        assert!(status_name(Value::Null).is_err());
    }

    /// User cancellation must promptly release locks and report that service-side effects may continue.
    #[test]
    fn cancellation_stops_only_observation() {
        tauri::async_runtime::block_on(async {
            let controller = Controller::default();
            let operation = controller.ensure_with("DEV", Duration::from_secs(30), |_| {
                std::future::pending::<Result<Value, String>>()
            });
            let cancellation = async {
                sleep(Duration::from_millis(10)).await;
                assert!(controller.snapshot().busy);
                assert!(controller.refresh().await.unwrap().busy);
                controller.cancel_wait();
            };
            let (result, ()) = tokio::join!(operation, cancellation);
            assert!(result.unwrap_err().contains("may still complete"));
            assert!(!controller.snapshot().busy);
            assert!(controller.gate.try_lock().is_ok());
        });
    }

    /// Disconnect each existing profile before connecting the target, with no external CLI execution.
    #[test]
    fn exclusive_switch_order() {
        tauri::async_runtime::block_on(async {
            let calls = Mutex::new(Vec::new());
            let states = Mutex::new(std::collections::BTreeMap::from([
                ("STAGE".to_string(), "Connected".to_string()),
                ("OTHER".to_string(), "Connected".to_string()),
            ]));
            let controller = Controller::default();
            controller.ensure_with("PROD", Duration::from_secs(1), |args| {
                calls.lock().unwrap().push(args.clone());
                let mut states = states.lock().unwrap();
                let profile = args.get(2).cloned().unwrap_or_default();
                let value = match args[0].as_str() {
                    "get-connection-status" => serde_json::json!({"connection-status": states.get(&profile).map(String::as_str).unwrap_or("NotConnected")}),
                    "list-connections" => serde_json::json!([{"profile-name": "STAGE"}, {"profile-name": "OTHER"}]),
                    "disconnect" => { states.insert(profile, "NotConnected".into()); Value::Null },
                    "connect" => { states.insert(profile, "Connected".into()); Value::Null },
                    _ => panic!("Unexpected simulated CLI command"),
                };
                std::future::ready(Ok(value))
            }).await.unwrap();
            let mutations: Vec<Vec<String>> = calls
                .into_inner()
                .unwrap()
                .into_iter()
                .filter(|args| args[0] == "connect" || args[0] == "disconnect")
                .collect();
            assert_eq!(
                mutations,
                vec![
                    arguments("disconnect", "STAGE"),
                    arguments("disconnect", "OTHER"),
                    arguments("connect", "PROD")
                ]
            );
        });
    }
}
