
//! Detect prerequisites and launchable programs for the setup wizard without executing them.
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const VPN_DOWNLOAD_URL: &str = "https://aws.amazon.com/vpn/client-vpn-download/";
pub const CLI_INSTALL_URL: &str =
    "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

#[derive(Clone, Serialize)]
pub struct Program {
    pub id: &'static str,
    pub name: &'static str,
}

/// Known program and its install locations; `%VAR%` prefixes expand from the environment.
struct Candidate {
    id: &'static str,
    name: &'static str,
    paths: &'static [&'static str],
}

#[cfg(target_os = "windows")]
const BROWSERS: &[Candidate] = &[
    Candidate {
        id: "edge",
        name: "Microsoft Edge",
        paths: &[
            r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
            r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
        ],
    },
    Candidate {
        id: "chrome",
        name: "Google Chrome",
        paths: &[
            r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
            r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
            r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
        ],
    },
    Candidate {
        id: "firefox",
        name: "Mozilla Firefox",
        paths: &[
            r"%ProgramFiles%\Mozilla Firefox\firefox.exe",
            r"%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe",
        ],
    },
    Candidate {
        id: "brave",
        name: "Brave",
        paths: &[
            r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe",
            r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe",
        ],
    },
];

#[cfg(not(target_os = "windows"))]
const BROWSERS: &[Candidate] = &[
    Candidate {
        id: "safari",
        name: "Safari",
        paths: &["/Applications/Safari.app"],
    },
    Candidate {
        id: "chrome",
        name: "Google Chrome",
        paths: &["/Applications/Google Chrome.app"],
    },
    Candidate {
        id: "edge",
        name: "Microsoft Edge",
        paths: &["/Applications/Microsoft Edge.app"],
    },
    Candidate {
        id: "firefox",
        name: "Mozilla Firefox",
        paths: &["/Applications/Firefox.app"],
    },
    Candidate {
        id: "brave",
        name: "Brave",
        paths: &["/Applications/Brave Browser.app"],
    },
];

#[cfg(target_os = "windows")]
const TERMINALS: &[Candidate] = &[
    Candidate {
        id: "windows-terminal",
        name: "Windows Terminal",
        paths: &[r"%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe"],
    },
    Candidate {
        id: "pwsh",
        name: "PowerShell 7",
        paths: &[r"%ProgramFiles%\PowerShell\7\pwsh.exe"],
    },
    Candidate {
        id: "powershell",
        name: "Windows PowerShell",
        paths: &[r"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"],
    },
    Candidate {
        id: "cmd",
        name: "Command Prompt",
        paths: &[r"%SystemRoot%\System32\cmd.exe"],
    },
    Candidate {
        id: "git-bash",
        name: "Git Bash",
        paths: &[r"%ProgramFiles%\Git\git-bash.exe"],
    },
];

#[cfg(not(target_os = "windows"))]
const TERMINALS: &[Candidate] = &[
    Candidate {
        id: "terminal",
        name: "Terminal",
        paths: &[
            "/System/Applications/Utilities/Terminal.app",
            "/Applications/Utilities/Terminal.app",
        ],
    },
    Candidate {
        id: "iterm",
        name: "iTerm2",
        paths: &["/Applications/iTerm.app"],
    },
    Candidate {
        id: "warp",
        name: "Warp",
        paths: &["/Applications/Warp.app"],
    },
];

#[cfg(target_os = "windows")]
const AWS_CLI: &[&str] = &[
    r"%ProgramFiles%\Amazon\AWSCLIV2\aws.exe",
    r"%ProgramFiles(x86)%\Amazon\AWSCLIV2\aws.exe",
];

#[cfg(not(target_os = "windows"))]
const AWS_CLI: &[&str] = &[
    "/usr/local/bin/aws",
    "/opt/homebrew/bin/aws",
    "/usr/local/aws-cli/aws",
];

/// Expand a leading `%VAR%`; unresolved variables yield no candidate.
fn expand(path: &str) -> Option<PathBuf> {
    let Some(rest) = path.strip_prefix('%') else {
        return Some(PathBuf::from(path));
    };
    let (name, tail) = rest.split_once('%')?;
    let base = std::env::var_os(name)?;
    Some(PathBuf::from(base).join(tail.trim_start_matches(['\\', '/'])))
}

/// App execution aliases (wt.exe) are reparse points that `is_file` cannot follow, so test the link itself.
fn present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn locate(candidate: &Candidate) -> Option<PathBuf> {
    candidate
        .paths
        .iter()
        .filter_map(|path| expand(path))
        .find(|path| present(path))
}

fn installed(candidates: &[Candidate]) -> Vec<Program> {
    candidates
        .iter()
        .filter(|candidate| locate(candidate).is_some())
        .map(|candidate| Program {
            id: candidate.id,
            name: candidate.name,
        })
        .collect()
}

pub fn browsers() -> Vec<Program> {
    installed(BROWSERS)
}

pub fn terminals() -> Vec<Program> {
    installed(TERMINALS)
}

pub fn known_browser(id: &str) -> bool {
    BROWSERS.iter().any(|candidate| candidate.id == id)
}

pub fn known_terminal(id: &str) -> bool {
    TERMINALS.iter().any(|candidate| candidate.id == id)
}

/// Resolve a saved browser identifier to its installed location; never accepts a renderer path.
pub fn browser_path(id: &str) -> Option<PathBuf> {
    BROWSERS
        .iter()
        .find(|candidate| candidate.id == id)
        .and_then(locate)
}

/// Look for the AWS CLI in standard install locations and on PATH without running it.
pub fn aws_cli_installed() -> bool {
    let executable = if cfg!(target_os = "windows") {
        "aws.exe"
    } else {
        "aws"
    };
    AWS_CLI
        .iter()
        .filter_map(|path| expand(path))
        .chain(
            std::env::var_os("PATH")
                .map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .filter(|dir| dir.is_absolute())
                .map(|dir| dir.join(executable)),
        )
        .any(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Identifiers are unique so saved preferences resolve deterministically.
    #[test]
    fn program_ids_are_unique() {
        for list in [BROWSERS, TERMINALS] {
            let mut ids: Vec<_> = list.iter().map(|candidate| candidate.id).collect();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), list.len());
        }
        assert!(!known_browser("../evil"));
        assert!(expand("%DESK_UNSET_VARIABLE_FOR_TEST%\\x.exe").is_none());
    }
}
