# AWS Environment Desk

A Windows and macOS Tauri tray utility for managing AWS resource links and switching AWS VPN Client 6.x profiles across environments.

## Features & Basic Functionality

- **Tray Utility**: System tray integration with quick access to dashboard links, environment switching, and application settings.
- **VPN Profile Management**: Seamlessly connects, switches, and disconnects configured AWS VPN Client profiles per environment (DEV, INT, STAGE, PROD).
- **Resource Catalogue**: Quick launcher for environment-specific application URLs.
- **Universal Configuration**: Fully configurable branding, environments, apps, shortcuts, and VPN client settings via an importable JSON configuration.

## Configuration

The active configuration resides at `config/config.json` (excluded from git).

- Import an initial configuration:
  ```bash
  npm run config:import config/config.example.json
  ```
- Or import any custom JSON configuration:
  ```bash
  npm run config:import <path-to-config.json>
  ```

### Configuration Schema

- `name` / `productName` / `description` / `identifier`: Application metadata.
- `brand`: `{ name, markAlt, backgroundColor, svg }` (supports inline SVG or path to SVG file).
- `vpn`: `{ clientName, defaultProfiles: { dev, int, stage, prod } }`.
- `environments`: Array of `{ key, title, sub, color }` defining environment tabs and tray status colors.
- `apps`: List of catalogue applications with `key`, `name`, `description`, optional `icon` URL, and per-environment `links`.
- `preferences.shortcut`: Global focus shortcut (default: `CommandOrControl+Shift+Space`).

## Local Development

### Prerequisites

- **Node.js**: `22.12.0+`
- **Rust**: `1.90.0+`
- **Platform Dependencies**:
  - Windows: Microsoft C++ Build Tools with Windows SDK, WebView2 runtime.
  - macOS: Xcode Command Line Tools.
  - AWS VPN Client 6.x (for live VPN switching).

### Installation & Running

1. Install dependencies:
   ```bash
   npm ci
   ```

2. Start development mode (with frontend watch and hot reload):
   ```bash
   npm start
   ```
   *(or `npm run tauri:dev`)*

3. Run tests:
   ```bash
   npm test
   ```
   To run native Tauri test suites and smoke tests:
   ```bash
   npm run test:tauri
   npm run test:tauri:desktop
   ```

## Release Operations

### Generating Signing Keys

Tauri uses Minisign key pairs to sign update manifests and verify in-app updates.

1. Generate a new signing key pair using the Tauri CLI:
   ```bash
   npx @tauri-apps/cli signer generate -w keys/release.key
   ```
   *(Prompts for a password to protect the private key; use `--ci` or `--password ""` for empty passwords in automated environments).*

2. This creates two files:
   - **Private key** (`keys/release.key`): Used to sign release artifacts. Keep this file private and never commit it to version control.
   - **Public key** (`keys/release.key.pub`): Embedded into the application to verify release signatures.

3. Provisioning keys:
   - **GitHub Actions**: Add repository secrets:
     - `TAURI_SIGNING_PRIVATE_KEY`: Content of the private key (`keys/release.key`).
     - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: Password set during generation (leave empty if none).
     - `TAURI_PUBLIC_KEY`: Content of the public key (`keys/release.key.pub`).
   - **Local Builds / Publishing**: Set `TAURI_SIGNING_PRIVATE_KEY_PATH` to the absolute path of `keys/release.key` and export `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in your environment.

### GitHub Actions CI/CD Releases

Automated releases are handled by GitHub Actions (`.github/workflows/release.yml`). Tagging a commit with `vX.Y.Z` triggers the workflow to build, sign, and publish installers to GitHub Releases.

#### Required GitHub Secrets

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Minisign private key content for signing release manifests |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key (if encrypted) |
| `TAURI_PUBLIC_KEY` | Matching public key embedded in the app for update verification |

### Local Builds

To build signed standalone installers locally:

- **Windows** (NSIS installer):
  ```bash
  npm run tauri:build -- --bundles nsis
  ```

- **macOS** (Universal DMG):
  ```bash
  npm run tauri:build -- --bundles dmg
  ```

For local release publishing scripts, ensure signing keys are provisioned in a secure directory and invoke:
```bash
npm run publish:tauri -- <version> <target-directory> <platform> <installer-path>
```
