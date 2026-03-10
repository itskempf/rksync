'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function resolveRobloxPluginInstallPaths(extensionPath, env = process.env) {
  if (!env.LOCALAPPDATA) {
    throw new Error('LOCALAPPDATA is not set for the current user session.');
  }

  const pluginRoot = path.join(env.LOCALAPPDATA, 'Roblox', 'Plugins');
  return {
    pluginRoot,
    source: path.join(extensionPath, 'roblox-plugin', 'RKsync.lua'),
    destination: path.join(pluginRoot, 'RKsync.lua'),
    legacyDestination: path.join(pluginRoot, 'MorgSync.lua')
  };
}

function getRobloxPluginInstallInfo(extensionPath, env = process.env) {
  const paths = resolveRobloxPluginInstallPaths(extensionPath, env);
  return {
    ...paths,
    installed: fs.existsSync(paths.destination),
    legacyInstalled: fs.existsSync(paths.legacyDestination)
  };
}

async function installRobloxPluginFiles(extensionPath, env = process.env) {
  const paths = resolveRobloxPluginInstallPaths(extensionPath, env);
  if (!fs.existsSync(paths.source)) {
    throw new Error(`Plugin source file was not found: ${paths.source}`);
  }

  await fsp.mkdir(paths.pluginRoot, { recursive: true });
  if (fs.existsSync(paths.legacyDestination)) {
    await fsp.rm(paths.legacyDestination, { force: true });
  }
  await fsp.copyFile(paths.source, paths.destination);
  return paths;
}

module.exports = {
  getRobloxPluginInstallInfo,
  installRobloxPluginFiles,
  resolveRobloxPluginInstallPaths
};
