# RKsync

RKsync is a two-part Roblox coding workflow:

- A VS Code extension in this repo hosts a localhost sync server for the first open workspace folder.
- A Roblox Studio plugin mirrors scripts between Studio and a folder inside that workspace.

This syncs Roblox code files:

- `Script`
- `LocalScript`
- `ModuleScript`

It mirrors their hierarchy into a local folder, so Studio objects become files and folders on disk.

## What it does

- Edit a synced `.lua` or `.luau` file in VS Code and it updates in Studio.
- Edit a script in Studio and it updates on disk.
- Create or delete supported script files locally and Studio follows.
- Create or delete supported scripts in Studio and the local folder follows.
- Shows dedicated `Status`, `Live Files`, and `Recent Activity` views in the `RKsync` Activity Bar container in VS Code.
- Shows a connected/disconnected badge, tracked-file counts, queued changes, and server snapshot confirmation inside the Roblox Studio plugin panel.
- Re-scans the local sync folder before reconnect snapshots so offline VS Code edits are pushed back into Studio when you reopen the project.
- Preserves delete tombstones from both VS Code and Studio so removed scripts stay removed after reconnects and project reopen.

## File layout

By default the extension syncs into:

```text
<your-workspace>/roblox-sync/
```

Examples:

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

- `.server.lua` / `.server.luau` -> `Script`
- `.client.lua` / `.client.luau` -> `LocalScript`
- `.module.lua` / `.module.luau` -> `ModuleScript`
- plain `.lua` / `.luau` -> `ModuleScript`

## Install the VS Code extension

From this folder:

```powershell
npm test
npx @vscode/vsce package
```

Then install the generated `.vsix` in VS Code.

You can also run it directly in an Extension Development Host from VS Code if you prefer.

## Install the Roblox Studio plugin

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-plugin.ps1
```

That copies `roblox-plugin/RKsync.lua` into `C:\Users\aaron\AppData\Local\Roblox\Plugins` and removes the old `MorgSync.lua` plugin file if it exists.

## Roblox Studio setup

In Studio, enable HTTP access before connecting:

1. Open `File > Game Settings`.
2. Open `Security`.
3. Enable `Allow HTTP Requests`.
4. Save.

Then:

1. Open the `RKsync` plugin panel in Studio.
2. Leave the URL as `http://127.0.0.1:34872` unless you changed the VS Code setting.
3. Click `Start Sync`.

## VS Code settings

Available workspace settings:

- `rksync.port` default `34872`
- `rksync.syncRoot` default `roblox-sync`

If you change either setting, reload VS Code so the server restarts with the new values.

## Notes

- The extension uses the first workspace folder only.
- The plugin syncs code objects, not arbitrary Roblox assets like parts, meshes, sounds, or UI instances without scripts.
- Intermediate folders created from local-only paths are created as Roblox `Folder` instances when Studio needs missing ancestors.
- The extension migrates legacy `.morg-sync` state into `.rksync` automatically.
- RKsync pauses background HTTP sync while a Studio play test is running so the dock panel does not throw misleading disconnect errors mid-test.
- RKsync ignores runtime-only roots like `CoreGui`, `CorePackages`, and live `Players` descendants so test sessions do not flood your workspace with Roblox internals.
- Empty local sync folders are cleaned up automatically when Studio deletes or moves scripts.
