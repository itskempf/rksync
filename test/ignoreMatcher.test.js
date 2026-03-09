'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IgnoreMatcher } = require('../lib/ignoreMatcher');

test('IgnoreMatcher supports file, directory, and root-anchored patterns', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rksync-ignore-'));
  const syncRoot = path.join(tempRoot, 'roblox-sync');
  fs.mkdirSync(syncRoot, { recursive: true });
  fs.writeFileSync(
    path.join(syncRoot, '.rksyncignore'),
    ['*.tmp', 'build/', '/StarterPlayer/Secrets.client.luau'].join('\n'),
    'utf8'
  );

  const matcher = new IgnoreMatcher(syncRoot);

  assert.equal(matcher.isIgnored('ServerScriptService/test.tmp'), true);
  assert.equal(matcher.isIgnored('Workspace/build/output.server.luau'), true);
  assert.equal(matcher.isIgnored('StarterPlayer/Secrets.client.luau'), true);
  assert.equal(matcher.isIgnored('ReplicatedStorage/Keep.module.luau'), false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
