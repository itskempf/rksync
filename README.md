# RKsync

[![CI](https://github.com/itskempf/rksync/actions/workflows/ci.yml/badge.svg)](https://github.com/itskempf/rksync/actions/workflows/ci.yml)
[![Release](https://github.com/itskempf/rksync/actions/workflows/release.yml/badge.svg)](https://github.com/itskempf/rksync/actions/workflows/release.yml)

RKsync is a lightweight, local-first live sync workflow for Roblox scripting.

- The VS Code extension hosts a localhost sync server for the current workspace.
- The Roblox Studio plugin connects to that server and mirrors script changes both ways.
- Sync state lives in `.rksync/`.
- Mirrored scripts live in `roblox-sync/` by default.

RKsync is meant for fast iteration on scripts without bringing in a heavier build pipeline.

## Features

- Live sync for `Script`, `LocalScript`, and `ModuleScript`
- Offline-friendly reconnect behavior for local edits
- Delete tombstones so removed files stay removed after reopen
- Conflict copies saved under `.rksync/conflicts/` instead of silently overwriting local changes
- `.rksyncignore` support for local scratch files and generated artifacts
- VS Code sidebar views for status, live files, and recent activity
- Roblox Studio dock widget with connection state, counters, manual pull, snapshot push, and connection testing
- Legacy `.morg-sync` state and `MorgSyncId` attribute migration support

## Install

### VS Code extension

Build the extension from the repo root:

```powershell
npm install
npm test
npm run package
```

That creates a `.vsix` package such as `rksync-<version>.vsix`. Install it in VS Code with:

```powershell
code --install-extension .\rksync-<version>.vsix --force
```

You can also use the VS Code Extensions UI and choose `Install from VSIX`.

RKsync also exposes a built-in VS Code command for the Roblox Studio plugin:

```text
RKsync: Install Roblox Studio Plugin
```

You can run it from the Command Palette or from the RKsync status view for a one-click install.

### Roblox Studio plugin

The easiest path is the built-in VS Code command:

```text
RKsync: Install Roblox Studio Plugin
```

If you prefer a script, the included installer targets the standard Windows Roblox Studio plugin folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

The installer resolves the current user's Roblox plugin folder automatically using `%LOCALAPPDATA%\Roblox\Plugins`, creates it if needed, removes a legacy `MorgSync.lua` file if present, and copies `roblox-plugin\RKsync.lua`.

### Manual plugin install fallback

If you do not want to run the script, copy this file manually:

```text
roblox-plugin\RKsync.lua
```

Into:

```text
%LOCALAPPDATA%\Roblox\Plugins
```

## First-Time Setup

1. Open the project folder in VS Code.
2. Make sure the RKsync extension is installed and active in that workspace.
3. Run `RKsync: Install Roblox Studio Plugin` from VS Code if you have not installed the Studio plugin yet.
4. In Roblox Studio, open `File > Game Settings > Security`.
5. Enable `Allow HTTP Requests`.
6. Open the `RKsync` plugin panel.
7. Leave the default URL as `http://127.0.0.1:34872` unless you changed the port.
8. Click `Test Connection`.
9. If that succeeds, click `Start Sync`.

RKsync expects Roblox Studio and VS Code to be running on the same machine. Keep the URL on `localhost` or `127.0.0.1`.

## Configuration

RKsync supports three configuration sources, in this order:

1. Workspace file `.rksync.json`
2. VS Code settings `rksync.port` and `rksync.syncRoot`
3. Built-in defaults

Example `.rksync.json`:

```json
{
  "port": 34872,
  "syncRoot": "roblox-sync"
}
```

Supported fields:

- `port`
- `syncRoot`

Rules:

- `syncRoot` must stay inside the workspace
- malformed `.rksync.json` does not stop RKsync from activating
- malformed config falls back safely and logs a warning in the RKsync output

VS Code settings are still supported:

- `rksync.port`
- `rksync.syncRoot`

Reload the VS Code window after changing `.rksync.json` or the VS Code settings so the localhost server restarts with the new values.

## Synced File Mapping

Default sync root:

```text
<workspace>\roblox-sync\
```

Example:

```text
roblox-sync/
  ServerScriptService/
    Main.server.luau
  ReplicatedStorage/
    Shared/
      Math.module.luau
  StarterPlayer/
    StarterPlayerScripts/
      Hud.client.luau
```

Suffix rules:

- `.server.lua` / `.server.luau` => `Script`
- `.client.lua` / `.client.luau` => `LocalScript`
- `.module.lua` / `.module.luau` => `ModuleScript`
- plain `.lua` / `.luau` => `ModuleScript`

Missing intermediate ancestors from local-only paths are created in Studio as `Folder` instances.

## Ignore Rules

Create `roblox-sync/.rksyncignore` to keep specific local files or folders out of Studio sync.

Example:

```text
*.tmp
build/
/StarterPlayer/Secrets.client.luau
```

## Troubleshooting

### Studio cannot connect

- Make sure the RKsync VS Code extension is active in the same workspace you want to sync
- Keep the plugin URL on `http://127.0.0.1:<port>` or `http://localhost:<port>`
- Use `Test Connection` before `Start Sync`

### HTTP requests disabled

Enable `Allow HTTP Requests` in `File > Game Settings > Security`, then retry from the plugin.

### Wrong port

If you change the port in `.rksync.json` or VS Code settings, update the Studio plugin URL to match and reload VS Code so the extension restarts on that port.

### Plugin and extension mismatch

If RKsync reports a protocol mismatch, reinstall both the VS Code extension and the Roblox Studio plugin from the same build. The VS Code command `RKsync: Install Roblox Studio Plugin` is the fastest way to refresh the Studio side.

### Malformed `.rksync.json`

RKsync falls back to VS Code settings or defaults, logs a warning to the RKsync output channel, and keeps running.

### Extension not running

Open the project folder in VS Code and check the RKsync sidebar or output channel. If the localhost server could not start, RKsync shows the error there.

### Multi-root workspaces

RKsync currently uses the first open workspace folder only. If you use a multi-root workspace, make sure the folder you want to sync is the first one.

### Localhost expectation

RKsync is local-only. It is not designed for LAN or remote machine sync. Roblox Studio and VS Code should both run on the same machine.

## Development

```powershell
npm install
npm test
node --check .\extension.js
npm run package
```

Useful helper:

```powershell
npm run install:plugin
```

## Notes

- RKsync syncs Roblox script objects, not arbitrary assets.
- Runtime-only roots such as `CoreGui`, `CorePackages`, and live `Players` descendants are ignored.
- `roblox-sync/` is intentionally ignored in git because it is the live mirror, not the source repo itself.
