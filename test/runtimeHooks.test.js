'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('package manifest exposes the reload configuration command', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  assert.equal(
    manifest.activationEvents.includes('onCommand:rksync.reloadConfiguration'),
    true
  );
  assert.equal(
    manifest.contributes.commands.some((command) => command.command === 'rksync.reloadConfiguration'),
    true
  );
});

test('extension source listens for workspace and configuration reload triggers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

  assert.match(source, /onDidChangeWorkspaceFolders\(/);
  assert.match(source, /onDidChangeConfiguration\(/);
  assert.match(source, /new vscode\.RelativePattern\(this\.workspaceFolder, WORKSPACE_CONFIG_FILE_NAME\)/);
  assert.match(source, /scheduleRuntimeReload\('/);
});

test('plugin source keeps the safer upsert fallback path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'roblox-plugin', 'RKsync.lua'), 'utf8');

  assert.match(source, /local success = pcall\(function\(\)/);
  assert.match(source, /ScriptEditorService:UpdateSourceAsync/);
  assert.doesNotMatch(source, /snapshotLoop/);
});
