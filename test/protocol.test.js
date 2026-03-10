'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  describeProtocolMismatch,
  getProtocolVersionFromHeaders,
  isProtocolVersionCompatible,
  parseProtocolVersion
} = require('../lib/protocol');

test('protocol helpers parse and validate protocol versions', () => {
  assert.equal(parseProtocolVersion(undefined), null);
  assert.equal(parseProtocolVersion('1'), 1);
  assert.equal(parseProtocolVersion('abc'), null);
  assert.equal(
    getProtocolVersionFromHeaders({
      [PROTOCOL_VERSION_HEADER]: `${PROTOCOL_VERSION}`
    }),
    PROTOCOL_VERSION
  );
  assert.equal(isProtocolVersionCompatible(PROTOCOL_VERSION), true);
  assert.equal(isProtocolVersionCompatible(PROTOCOL_VERSION + 1), false);
});

test('protocol mismatch messages stay actionable', () => {
  assert.match(describeProtocolMismatch(null), /Reinstall the Roblox Studio plugin/);
  assert.match(describeProtocolMismatch(PROTOCOL_VERSION + 1), /Update the VS Code extension and Roblox Studio plugin/);
});

test('Roblox plugin protocol version stays aligned with the extension', () => {
  const pluginSource = fs.readFileSync(
    path.join(__dirname, '..', 'roblox-plugin', 'RKsync.lua'),
    'utf8'
  );

  assert.match(pluginSource, new RegExp(`local PROTOCOL_VERSION = ${PROTOCOL_VERSION}\\b`));
});
