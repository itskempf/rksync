# RKsync

[![CI](https://github.com/itskempf/rksync/actions/workflows/ci.yml/badge.svg)](https://github.com/itskempf/rksync/actions/workflows/ci.yml)
[![Release](https://github.com/itskempf/rksync/actions/workflows/release.yml/badge.svg)](https://github.com/itskempf/rksync/actions/workflows/release.yml)

RKsync is a local-first Roblox scripting workflow:

- a VS Code extension hosts a localhost sync server for your workspace
- a Roblox Studio plugin mirrors script changes between Studio and disk

It is built for fast live-editing without setting up Rojo or a larger build pipeline.

## Features

- Live sync for `Script`, `LocalScript`, and `ModuleScript`
- Roblox hierarchy mirrored into a local `roblox-sync/` folder
- Stable reconnect behavior for offline edits
- `.rksyncignore` support for local scratch files and generated artifacts
- Delete tombstones so removed files stay removed after reopen
- VS Code sidebar with `Status`, `Live Files`, and `Recent Activity`
- Roblox Studio dock widget with connection state and sync counters

## Repo Layout

```text
extension.js                 VS Code extension entrypoint
lib/syncCore.js              Shared path and sync helpers
roblox-plugin/RKsync.lua     Roblox Studio plugin source
scripts/install-plugin.ps1   Local plugin installer
test/syncCore.test.js        Node tests
```

`roblox-sync/` is intentionally ignored in git. That folder is the local mirrored workspace, not source-of-truth repo content.

## Install

### VS Code extension

Build a `.vsix` locally:

```powershell
npm install
npm test
npm run package
```

Then install the generated `.vsix` in VS Code.

### Roblox Studio plugin

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

That copies `roblox-plugin/RKsync.lua` into:

```text
<localappdata>\Roblox\Plugins
```

If the automatic script fails, you can manually copy `roblox-plugin/RKsync.lua` into your current user's Roblox `Plugins` folder.

## Studio Setup

1. Open `File > Game Settings > Security`
2. Enable `Allow HTTP Requests`
3. Open the `RKsync` plugin panel
4. Leave the default URL as `http://127.0.0.1:34872` unless you changed the port
5. Click `Start Sync`

## Synced File Mapping

Default sync root:

```text
<workspace>/roblox-sync/
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

## Config

RKsync reads configuration from an optional workspace-root `.rksync.json` file. If not found, it falls back to VS Code settings.

Example `.rksync.json`:

```json
{
  "port": 34872,
  "syncRoot": "roblox-sync"
}
```

Precedence:

1. `.rksync.json`
2. VS Code workspace settings (`rksync.port`, `rksync.syncRoot`)
3. Default values

## Optional Ignore File

Create `roblox-sync/.rksyncignore` to skip local files or folders that should not sync back into Studio.

Example:

```text
*.tmp
build/
/StarterPlayer/Secrets.client.luau
```

## Development

```powershell
npm test
node --check .\extension.js
npm run package
```

## Troubleshooting

- **Studio cannot connect**: Ensure the extension is running and the correct port is specified.
- **HTTP requests disabled**: Enable "Allow HTTP Requests" in Studio under Game Settings > Security.
- **Wrong port**: Ensure Studio and `.rksync.json` (or settings) ports match.
- **Malformed config**: Check RKsync output channel in VS Code for `.rksync.json` parsing errors.
- **Extension not running**: Open a valid workspace directory containing your scripts.
- **Multiple workspace folders**: If you use a multi-root workspace, RKsync currently only uses the first folder.
- **Same-machine expectation**: RKsync is designed to run the VS Code extension and Roblox Studio on the same local machine.

## Notes

- RKsync syncs code objects, not arbitrary Roblox assets.
- Missing intermediate ancestors from local-only paths are created as Roblox `Folder` instances.
- Legacy `.morg-sync` state is migrated into `.rksync`.
- Runtime-only roots such as `CoreGui`, `CorePackages`, and live `Players` descendants are ignored.
- Divergent Studio edits are saved under `.rksync/conflicts/` instead of silently overwriting local unsynced work.
