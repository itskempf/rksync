# RKsync

[![CI](https://github.com/itskempf/rksync/actions/workflows/ci.yml/badge.svg)](https://github.com/itskempf/rksync/actions/workflows/ci.yml)
[![Release](https://github.com/itskempf/rksync/actions/workflows/release.yml/badge.svg)](https://github.com/itskempf/rksync/actions/workflows/release.yml)

RKsync is a lightweight local-first live sync workflow between VS Code and Roblox Studio. It is built for fast live-editing and avoids the overhead of setting up heavier build pipelines like Rojo.

RKsync operates by running a localhost server via the VS Code extension, and the Roblox Studio plugin connects to it to seamlessly mirror script changes between Studio and disk.

## Features

- Live bidirectional sync for `Script`, `LocalScript`, and `ModuleScript`
- Advanced `.rksyncignore` support for skipping directories like `node_modules` and build artifacts
- CRDT-like conflict detection ensures your local changes aren't silently destroyed by remote edits
- Roblox hierarchy mirrored natively into a local `roblox-sync/` folder
- Stable reconnect behavior for offline edits
- Tombstones ensure removed files stay removed after reopening Studio or changing folder names
- VS Code sidebar with `Status`, `Live Files`, and `Recent Activity` panels
- Roblox Studio dock widget displaying precise queue counts and tethered workspace directories

## Install

### VS Code Extension

You can package and install the extension locally:

```powershell
npm install
npm run package
```

Then install the generated `.vsix` file in VS Code through the Extensions panel.

### Roblox Studio Plugin

The easiest way to install the plugin on Windows is to run the setup script:

```powershell
npm run install-plugin
```

This dynamically resolves your `LOCALAPPDATA` directory and copies `roblox-plugin/RKsync.lua` directly into your Roblox plugins folder (`%LOCALAPPDATA%\Roblox\Plugins`).

#### Manual Fallback Install

If you're not on Windows or the script fails, you can manually copy `roblox-plugin/RKsync.lua` into your Roblox Plugins directory.
* **Windows:** `%LOCALAPPDATA%\Roblox\Plugins`
* **Mac:** `~/Documents/Roblox/Plugins`

## First-time Setup

1. Open your workspace folder in VS Code.
2. In Roblox Studio, go to `File > Game Settings > Security` and enable **Allow HTTP Requests**.
3. Open the `RKsync` plugin panel in Studio.
4. Leave the default URL as `http://127.0.0.1:34872` (unless you've specifically altered the port configuration).
5. Click **Test Connection** to verify it can see your active VS Code workspace.
6. Click **Start Sync**.

*Note: RKsync currently only supports syncing the primary (first) folder if you have a multi-root workspace open.*

## Configuration

RKsync supports an optional `.rksync.json` configuration file placed in the root of your workspace.

Example `.rksync.json`:
```json
{
  "port": 34872,
  "syncRoot": "src/roblox-scripts"
}
```

Precedence order for settings:
1. `.rksync.json`
2. VS Code `settings.json` (`rksync.port`, `rksync.syncRoot`)
3. Built-in defaults

## Synced File Mapping

By default, scripts are dumped into the workspace `roblox-sync/` root folder.

Suffix mapping rules:
- `.server.lua` / `.server.luau` => `Script`
- `.client.lua` / `.client.luau` => `LocalScript`
- `.module.lua` / `.module.luau` => `ModuleScript`
- plain `.lua` / `.luau` => `ModuleScript`

## Troubleshooting

- **Studio cannot connect:** Verify the VS Code extension is active and tracking your project. Ensure the URL matches exactly.
- **HTTP requests disabled:** Make sure `File > Game Settings > Security > Allow HTTP Requests` is checked.
- **Sync paused during play test:** RKsync gracefully pauses network communication while you are play testing to avoid modifying active running instances. Sync automatically resumes when the test finishes.
- **Malformed config:** If `.rksync.json` is malformed, VS Code will display a warning toast and fall back to VS Code settings.
- **Same-machine assumption:** RKsync uses `127.0.0.1` and assumes VS Code and Roblox Studio are running on the exact same physical machine.

## Development

```powershell
npm test        # Runs Node.js extension tests
npm run test:lua # Runs Lua pathing tests
node --check .\extension.js
npm run package
```
