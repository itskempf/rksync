'use strict';

const fs = require('fs');
const path = require('path');
const { toPosixPath } = require('./syncCore');

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern, rootAnchored, directoryOnly) {
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    const next = pattern[index + 1];

    if (current === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (current === '*') {
      source += '[^/]*';
      continue;
    }

    if (current === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegex(current);
  }

  const prefix = rootAnchored ? '^' : '(^|.*/)';
  const suffix = directoryOnly ? '(/.*)?$' : '$';
  return new RegExp(`${prefix}${source}${suffix}`);
}

class IgnoreMatcher {
  constructor(syncRootPath) {
    this.syncRootPath = syncRootPath;
    this.patterns = [];
    this.loadPatterns();
  }

  loadPatterns() {
    this.patterns = [];
    const ignorePath = path.join(this.syncRootPath, '.rksyncignore');
    if (!fs.existsSync(ignorePath)) {
      return;
    }

    const content = fs.readFileSync(ignorePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }

      const rootAnchored = line.startsWith('/');
      const directoryOnly = line.endsWith('/');
      const normalized = line.replace(/^\/+/u, '').replace(/\/+$/u, '');
      if (!normalized) {
        continue;
      }

      this.patterns.push(globToRegex(normalized, rootAnchored, directoryOnly));
    }
  }

  isIgnored(relativePath) {
    if (this.patterns.length === 0) {
      return false;
    }

    const normalizedPath = toPosixPath(relativePath).replace(/^\/+/u, '');
    return this.patterns.some((pattern) => pattern.test(normalizedPath));
  }
}

module.exports = {
  IgnoreMatcher
};
