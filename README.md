<div align="center">

# DeepSeek Harness Mobile Remote Control (dsh-mobile-remote) 📱

**English** · [简体中文](./README.zh.md)

[GitHub](https://github.com/feiyang-dev/dsh-mobile-remote) · [npm](https://www.npmjs.com/package/@feiyang666/dsh-mobile-remote) · MIT License

**A community plugin for DeepSeek Harness** — adds a built-in "Remote Control" page to the Web settings: connection QR code, one-click toggle, and live connected-device count. Access and control your desktop DeepSeek Harness from your phone over LAN, with mobile-first UI polish.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)
![Platform](https://img.shields.io/badge/platform-web%20%26%20desktop-4d9fff)

</div>

---

## Overview

`dsh-mobile-remote` is a DeepSeek Harness ecosystem **mobile remote-control plugin** (DSH plugin, Host + Client in one package). After installation, a management panel appears under **Settings → Remote Control** in the Web UI:

- **Connection QR code**: auto-generates a QR for `http://<lan-ip>:<port>` — scan it with your phone's camera / browser to connect.
- **On / Off toggle**: switches the webserver listen address (`0.0.0.0` ↔ `127.0.0.1`) with one click. Applied via dsh's official HMR hot-reload — **no service restart needed**.
- **Connected device count**: mobile heartbeats report online devices in real time.
- LAN address list, phone access URLs, and config location at a glance.

**Key selling point: pure CLI users don't need the desktop app.** The official CLI deliberately rejects `--host 0.0.0.0` for safety, but this plugin writes `webserver.host: 0.0.0.0` through the profile's `cordis.patch.yml` (or a `--patch <overlay>`) — exactly how the desktop app's "Mobile Remote Control" switch works. The phone and the computer share the same dsh backend process and the same `~/.dsh` data, so **sessions, history, workspace and settings are naturally two-way synced — no data copying involved**.

---

## Screenshots

### Settings → Remote Control
![Remote Control](./docs/assets/remote-control.png)

## Recommended Installation

> Either method works and is equivalent. **We recommend the desktop app** — fully graphical, no command line needed.

### Option 1 (recommended): One-click via the desktop app

Install [DeepSeek Harness Desktop](https://github.com/feiyang-dev/DeepSeek-Harness-Desktop), open it, then go to **"Install Plugins" → Recommended → Mobile Remote Control → Install** and click **"Restart Service Now"** to activate.

### Option 2: Command line

```bash
# Prerequisite: install dsh (npm install -g @deepseek-ai/dsh)
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

Restart the dsh web service to activate.

---

## Usage

1. Start dsh (any way: desktop app / `npx @deepseek-ai/dsh web` / from source).
2. Open `http://127.0.0.1:3080` in a desktop browser → **Settings → Remote Control**.
3. Toggle the switch **ON** (hot-reloaded, no restart).
4. Put your phone and computer on the **same Wi-Fi**, **scan the QR** or open the LAN URL.
5. The phone now shows all desktop data — sessions, history, workspace, settings — and can send messages to control the desktop.

### Pure CLI startup (no desktop app)

```bash
# Way 1: use the settings-page toggle (recommended)
dsh --profile web
# then open http://127.0.0.1:3080 → Settings → Remote Control → ON

# Way 2: manual overlay
dsh --profile web --patch remote-control.patch.yml
```

`remote-control.patch.yml`:

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
```

> **Security note**: enabling remote control exposes the service to your LAN. Use it only on trusted home / office networks — **do not expose it to the public internet**.

---

## What This Package Is

One npm package = **host half** (Node-side Cordis plugin: `/__dsh_remote/*` API, patch-file management, heartbeat device counting, index.html injection — see `lib/index.js`) + **client half** (browser settings panel — see `lib/client.js`, talking to the host via `/__dsh_remote/status` etc.).

It plugs into DSH through two declarations:

| Declaration | Purpose |
| --- | --- |
| `dsh.bundle.patch` (`cordis.patch.yml`) | Lets DSH treat it as a **standard bundle plugin package**: `dsh plugin --profile <name> add <pkg>` installs and wires it in one command |
| `dsh.client` + `exports["./client"]` | Lets the web client auto-load the settings panel at `/plugins/<pkg>/client.js` |

So for users, **installing is one command** — no YAML editing, no manual file copying.

---

## How It Works

| Layer | File | Responsibility |
| --- | --- | --- |
| host | `lib/index.js` | `/__dsh_remote/status` / `toggle` / `heartbeat` / `qr` API; patch-file read/write; heartbeat device counting; index.html injection |
| client | `lib/client.js` | Registers the `settings.section` "Remote Control" panel (toggle / QR / device count) |
| qrcode | `lib/qrcode.js` | Inlined MIT QR generator (`qrcode-generator`), zero runtime deps |

- **Toggle**: `POST /__dsh_remote/toggle` → writes/removes a `webserver` override block in the profile's `cordis.patch.yml` → dsh's `watchUserPatches` (Cordis HMR) hot-reloads the webserver entry to re-listen.
- **Device count**: mobile-injected JS heartbeats every 30s; the host keeps an active-device map (90s TTL).
- **QR code**: `GET /__dsh_remote/qr?url=...` returns SVG.
- **Mobile polish**: `tapIndex` injects mobile CSS/JS — composer toolbar wraps on narrow screens, selects get width-capped, iOS inputs get 16px to prevent focus zoom; **DSH's native rail + hamburger drawer interactions are untouched**.

---

## Installation (for users)

### 0. Prerequisites

- DeepSeek Harness installed (`npm install -g @deepseek-ai/dsh` globally, or via the desktop app / `npx @deepseek-ai/dsh web`).
- `dsh` on your PATH (use the desktop app's own terminal if it manages its environment).

### 1. One-command install

```bash
dsh plugin --profile web add @feiyang666/dsh-mobile-remote
```

This command does three things automatically:

1. Installs the package into `~/.dsh/profiles/web` via pnpm (initializes the profile on first use);
2. Detects the `dsh.bundle` declaration and registers the package in the profile's `dsh.profile.bundles`;
3. After restart, DSH reads the package's `cordis.patch.yml` and mounts the plugin entry into the app tree — **no manual config editing**.

The same works for other profiles — replace `web` with your profile name.

> Local tarball testing: `dsh plugin --profile web add C:\path\to\feiyang666-dsh-mobile-remote-1.1.0.tgz`

### 2. Restart and verify

Restart the dsh web app (CLI: stop the old process and run `dsh web` again; desktop: fully quit and reopen). Then:

- Refresh http://127.0.0.1:3080 → Settings → the **"Remote Control"** panel should appear.

---

## Uninstall

```bash
dsh plugin --profile web remove @feiyang666/dsh-mobile-remote
```

Then restart the app.

---

## FAQ

| Symptom | Cause / Fix |
| --- | --- |
| No "Remote Control" panel in Settings | Plugin not activated. Check the `cordis.patch.yml` row exists with the right `name`; restart and hard-refresh |
| Phone still can't connect after toggling ON | Same Wi-Fi? Firewall allowing port 3080? Accessing the LAN IP (not `127.0.0.1`)? |
| Phone connects but shows 403 | dsh's trust fence: make sure the plugin is installed and dsh is started the supported way (`--patch` / profile patch overriding `webserver.host`) |
| Device count stays 0 | The phone page must be opened once to start heartbeat; wait a few seconds and refresh |
| QR won't scan | Confirm Remote Control is ON; use a camera app that supports QR |

---

## Related Projects

| Project | Description | Installation |
| --- | --- | --- |
| [DeepSeek Harness Desktop](https://github.com/feiyang-dev/DeepSeek-Harness-Desktop) | Windows desktop console: install/start/stop/restart the dsh web service with one click, built-in plugin management — **install this plugin from its Recommended section** | Download the desktop app and click a few buttons |
| [Usage & Cost Tracker (dsh-usage-plugin)](https://github.com/feiyang-dev/dsh-usage-plugin) | Per-call token/cache-hit stats, peak/off-peak billing, balance query, CSV/JSON/PNG export | One-click from the desktop app, or `dsh plugin add @feiyang666/dsh-usage-plugin` |
| [Data Vault (dsh-vault)](https://github.com/feiyang-dev/dsh-vault) | Auto-backup, wipe detection, one-click restore for chat history and workspace data | One-click from the desktop app, or `dsh plugin add @feiyang666/dsh-vault` |
| [DeepSeek-Harness](https://github.com/deepseek-ai/DeepSeek-Harness) | Official CLI / Web service | Quick start below |

### Running DeepSeek Harness

**Quick start (via npm)**

Install Node.js, then run:

```bash
npx @deepseek-ai/dsh web
```

This starts the Web UI at http://127.0.0.1:3080 by default. See the [Web UI Guide](https://github.com/deepseek-ai/DeepSeek-Harness).

**Run from source**

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## License

MIT © dsh-mobile-remote
