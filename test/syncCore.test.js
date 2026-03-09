'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRelativePathFromSegments,
  canonicalizeRelativePath,
  decodeNameSegment,
  encodeNameSegment,
  parseConfiguredPort,
  parseConfiguredSyncRoot,
  parseRelativeScriptPath,
  parseScriptFileName,
  relativePathToInstancePath
} = require('../lib/syncCore');

test('name segments round-trip through encoding', () => {
  const samples = [
    '',
    'ServerScriptService',
    'My Script',
    'こんにちは',
    'A/B:C*D',
    'CON'
  ];

  for (const sample of samples) {
    assert.equal(decodeNameSegment(encodeNameSegment(sample)), sample);
  }

  assert.equal(encodeNameSegment(''), '%00');
});

test('script filenames preserve class markers', () => {
  assert.deepEqual(parseScriptFileName('Main.server.luau'), {
    fileName: 'Main.server.luau',
    className: 'Script',
    scriptName: 'Main',
    suffix: '.server.luau'
  });

  assert.deepEqual(parseScriptFileName('Client.client.lua'), {
    fileName: 'Client.client.lua',
    className: 'LocalScript',
    scriptName: 'Client',
    suffix: '.client.lua'
  });

  assert.deepEqual(parseScriptFileName('Util.module.luau'), {
    fileName: 'Util.module.luau',
    className: 'ModuleScript',
    scriptName: 'Util',
    suffix: '.module.luau'
  });
});

test('relative paths decode back to Roblox instance paths', () => {
  const relativePath = buildRelativePathFromSegments(
    ['ServerScriptService', 'Gameplay'],
    'RoundManager',
    'Script'
  );

  const parsed = parseRelativeScriptPath(relativePath);
  assert.equal(parsed.className, 'Script');
  assert.deepEqual(parsed.instanceSegments, ['ServerScriptService', 'Gameplay', 'RoundManager']);
  assert.equal(relativePathToInstancePath(relativePath), 'game.ServerScriptService.Gameplay.RoundManager');
});

test('canonicalizeRelativePath fixes mismatched suffixes', () => {
  assert.equal(
    canonicalizeRelativePath('StarterPlayer/StarterPlayerScripts/KempyGui.server.luau', 'LocalScript'),
    'StarterPlayer/StarterPlayerScripts/KempyGui.client.luau'
  );
});

test('parseConfiguredPort accepts valid values and rejects unsafe ones', () => {
  assert.equal(parseConfiguredPort(34872), 34872);
  assert.equal(parseConfiguredPort('34873'), 34873);
  assert.throws(() => parseConfiguredPort(80), /between 1024 and 65535/);
  assert.throws(() => parseConfiguredPort('abc'), /between 1024 and 65535/);
});

test('parseConfiguredSyncRoot keeps sync roots relative to the workspace', () => {
  assert.equal(parseConfiguredSyncRoot('roblox-sync'), 'roblox-sync');
  assert.equal(parseConfiguredSyncRoot('./nested/sync'), 'nested/sync');
  assert.throws(() => parseConfiguredSyncRoot('.rksync'), /cannot point at RKsync state folders/);
  assert.throws(() => parseConfiguredSyncRoot('C:/temp/sync'), /cannot be absolute/);
  assert.throws(() => parseConfiguredSyncRoot('../escape'), /Invalid sync path/);
});
