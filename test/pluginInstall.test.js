'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getRobloxPluginInstallInfo,
  installRobloxPluginFiles,
  resolveRobloxPluginInstallPaths
} = require('../lib/pluginInstall');

test('resolveRobloxPluginInstallPaths requires LOCALAPPDATA', () => {
  assert.throws(
    () => resolveRobloxPluginInstallPaths('C:\\extension', {}),
    /LOCALAPPDATA is not set/
  );
});

test('resolveRobloxPluginInstallPaths builds expected Windows paths', () => {
  const paths = resolveRobloxPluginInstallPaths('C:\\extension', {
    LOCALAPPDATA: 'C:\\Users\\aaron\\AppData\\Local'
  });

  assert.equal(paths.pluginRoot, path.join('C:\\Users\\aaron\\AppData\\Local', 'Roblox', 'Plugins'));
  assert.equal(paths.source, path.join('C:\\extension', 'roblox-plugin', 'RKsync.lua'));
  assert.equal(paths.destination, path.join(paths.pluginRoot, 'RKsync.lua'));
  assert.equal(paths.legacyDestination, path.join(paths.pluginRoot, 'MorgSync.lua'));
});

test('installRobloxPluginFiles copies the plugin and removes the legacy file', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rksync-plugin-install-'));
  const extensionPath = path.join(tempRoot, 'extension');
  const env = {
    LOCALAPPDATA: path.join(tempRoot, 'local-appdata')
  };

  fs.mkdirSync(path.join(extensionPath, 'roblox-plugin'), { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'roblox-plugin', 'RKsync.lua'), '-- plugin', 'utf8');

  const legacyPath = path.join(env.LOCALAPPDATA, 'Roblox', 'Plugins', 'MorgSync.lua');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, '-- legacy', 'utf8');

  const installed = await installRobloxPluginFiles(extensionPath, env);
  const info = getRobloxPluginInstallInfo(extensionPath, env);

  assert.equal(installed.destination, path.join(env.LOCALAPPDATA, 'Roblox', 'Plugins', 'RKsync.lua'));
  assert.equal(fs.existsSync(installed.destination), true);
  assert.equal(fs.readFileSync(installed.destination, 'utf8'), '-- plugin');
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(info.installed, true);
  assert.equal(info.legacyInstalled, false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
