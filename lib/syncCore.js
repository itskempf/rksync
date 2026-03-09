'use strict';

const crypto = require('crypto');
const path = require('path');

const DEFAULT_PORT = 34872;
const DEFAULT_SYNC_ROOT = 'roblox-sync';
const STATE_DIR_NAME = '.rksync';
const LEGACY_STATE_DIR_NAME = '.morg-sync';
const STATE_FILE_NAME = 'state.json';
const WORKSPACE_CONFIG_FILE_NAME = '.rksync.json';
const SYNC_ATTRIBUTE_NAME = 'RKsyncId';
const LEGACY_SYNC_ATTRIBUTE_NAME = 'MorgSyncId';
const SAFE_BYTE_PATTERN = /^[A-Za-z0-9_-]$/;
const RESERVED_SEGMENTS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
]);

const CLASS_SUFFIXES = {
  Script: '.server.luau',
  LocalScript: '.client.luau',
  ModuleScript: '.module.luau'
};

const SUFFIX_RULES = [
  { suffix: '.server.luau', className: 'Script' },
  { suffix: '.server.lua', className: 'Script' },
  { suffix: '.client.luau', className: 'LocalScript' },
  { suffix: '.client.lua', className: 'LocalScript' },
  { suffix: '.module.luau', className: 'ModuleScript' },
  { suffix: '.module.lua', className: 'ModuleScript' },
  { suffix: '.luau', className: 'ModuleScript' },
  { suffix: '.lua', className: 'ModuleScript' }
];

function percentEncodeBuffer(buffer) {
  let encoded = '';
  for (const byte of buffer) {
    const char = String.fromCharCode(byte);
    if (SAFE_BYTE_PATTERN.test(char)) {
      encoded += char;
      continue;
    }
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

function encodeNameSegment(name) {
  const value = `${name ?? ''}`;
  const buffer = Buffer.from(value, 'utf8');
  let encoded = percentEncodeBuffer(buffer);
  if (!encoded || encoded === '.' || encoded === '..' || RESERVED_SEGMENTS.has(encoded.toUpperCase())) {
    encoded = buffer.length === 0 ? '%00' : Array.from(buffer, (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }
  return encoded;
}

function decodeNameSegment(segment) {
  if (segment === '%00') {
    return '';
  }
  const bytes = [];
  for (let index = 0; index < segment.length; index += 1) {
    const current = segment[index];
    if (current === '%' && index + 2 < segment.length) {
      const hex = segment.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(current.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function normalizeRelativePath(relativePath) {
  const value = toPosixPath(path.posix.normalize(relativePath)).replace(/^\/+/, '');
  if (!value || value.startsWith('../') || value === '..') {
    throw new Error(`Invalid sync path: ${relativePath}`);
  }
  return value;
}

function parseConfiguredPort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalizedValue = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(normalizedValue) || normalizedValue < 1024 || normalizedValue > 65535) {
    throw new Error('`port` must be an integer between 1024 and 65535.');
  }

  return normalizedValue;
}

function parseConfiguredSyncRoot(value, fallback = DEFAULT_SYNC_ROOT) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('`syncRoot` must be a non-empty string.');
  }

  const trimmed = value.trim();
  const posixValue = toPosixPath(trimmed);
  if (path.posix.isAbsolute(posixValue) || /^[A-Za-z]:\//u.test(posixValue)) {
    throw new Error('`syncRoot` must stay inside the workspace and cannot be absolute.');
  }

  const normalized = normalizeRelativePath(posixValue);
  if (
    normalized === STATE_DIR_NAME ||
    normalized.startsWith(`${STATE_DIR_NAME}/`) ||
    normalized === LEGACY_STATE_DIR_NAME ||
    normalized.startsWith(`${LEGACY_STATE_DIR_NAME}/`)
  ) {
    throw new Error('`syncRoot` cannot point at RKsync state folders.');
  }

  return normalized;
}

function buildScriptFileName(scriptName, className) {
  const suffix = CLASS_SUFFIXES[className] || CLASS_SUFFIXES.ModuleScript;
  return `${encodeNameSegment(scriptName)}${suffix}`;
}

function parseScriptFileName(fileName) {
  for (const rule of SUFFIX_RULES) {
    if (!fileName.toLowerCase().endsWith(rule.suffix)) {
      continue;
    }
    const baseName = fileName.slice(0, fileName.length - rule.suffix.length);
    if (!baseName) {
      return null;
    }
    return {
      fileName,
      className: rule.className,
      scriptName: decodeNameSegment(baseName),
      suffix: rule.suffix
    };
  }
  return null;
}

function isSupportedScriptFile(fileName) {
  return parseScriptFileName(fileName) !== null;
}

function parseRelativeScriptPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const segments = normalized.split('/');
  const fileName = segments.pop();
  const scriptInfo = parseScriptFileName(fileName);
  if (!scriptInfo) {
    throw new Error(`Unsupported script filename: ${fileName}`);
  }
  const instanceSegments = segments.map(decodeNameSegment);
  return {
    relativePath: normalized,
    fileName,
    className: scriptInfo.className,
    scriptName: scriptInfo.scriptName,
    parentSegments: instanceSegments,
    instanceSegments: [...instanceSegments, scriptInfo.scriptName]
  };
}

function canonicalizeRelativePath(relativePath, className) {
  const parsed = parseRelativeScriptPath(relativePath);
  return buildRelativePathFromSegments(
    parsed.parentSegments,
    parsed.scriptName,
    className || parsed.className
  );
}

function relativePathToInstancePath(relativePath) {
  const parsed = parseRelativeScriptPath(relativePath);
  return `game.${parsed.instanceSegments.join('.')}`;
}

function hashContent(content) {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

function buildRelativePathFromSegments(parentSegments, scriptName, className) {
  const encodedParents = parentSegments.map(encodeNameSegment);
  const fileName = buildScriptFileName(scriptName, className);
  return normalizeRelativePath([...encodedParents, fileName].join('/'));
}

module.exports = {
  CLASS_SUFFIXES,
  DEFAULT_PORT,
  DEFAULT_SYNC_ROOT,
  LEGACY_STATE_DIR_NAME,
  LEGACY_SYNC_ATTRIBUTE_NAME,
  WORKSPACE_CONFIG_FILE_NAME,
  parseConfiguredPort,
  parseConfiguredSyncRoot,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
  SYNC_ATTRIBUTE_NAME,
  buildRelativePathFromSegments,
  buildScriptFileName,
  canonicalizeRelativePath,
  decodeNameSegment,
  encodeNameSegment,
  hashContent,
  isSupportedScriptFile,
  normalizeRelativePath,
  parseRelativeScriptPath,
  parseScriptFileName,
  relativePathToInstancePath,
  toPosixPath
};
