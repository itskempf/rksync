'use strict';

const PROTOCOL_VERSION = 1;
const PROTOCOL_VERSION_HEADER = 'x-rksync-protocol-version';

function parseProtocolVersion(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const normalized = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(`${normalized}`.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function getProtocolVersionFromHeaders(headers = {}) {
  return parseProtocolVersion(headers[PROTOCOL_VERSION_HEADER]);
}

function isProtocolVersionCompatible(version) {
  return version === PROTOCOL_VERSION;
}

function describeProtocolMismatch(version) {
  if (version === null) {
    return `RKsync protocol mismatch. Reinstall the Roblox Studio plugin so it uses protocol v${PROTOCOL_VERSION}.`;
  }
  return `RKsync protocol mismatch. Expected v${PROTOCOL_VERSION}, received v${version}. Update the VS Code extension and Roblox Studio plugin to the same build.`;
}

module.exports = {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  describeProtocolMismatch,
  getProtocolVersionFromHeaders,
  isProtocolVersionCompatible,
  parseProtocolVersion
};
