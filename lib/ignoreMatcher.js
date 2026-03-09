const fs = require('fs');
const path = require('path');
const { toPosixPath } = require('./syncCore');

class IgnoreMatcher {
  constructor(syncRootPath) {
    this.syncRootPath = syncRootPath;
    this.patterns = [];
    this.loadPatterns();
  }

  loadPatterns() {
    this.patterns = [];
    const ignorePath = path.join(this.syncRootPath, '.rksyncignore');
    if (fs.existsSync(ignorePath)) {
      const content = fs.readFileSync(ignorePath, 'utf8');
      const lines = content.split('\n');
      for (let line of lines) {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          this.patterns.push(this.compilePattern(line));
        }
      }
    }
  }

  compilePattern(pattern) {
    let source = pattern;
    let isRoot = false;
    let isDir = false;

    if (source.startsWith('/')) {
        isRoot = true;
        source = source.substring(1);
    }
    if (source.endsWith('/')) {
        isDir = true;
        source = source.substring(0, source.length - 1);
    }

    source = source
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex chars
      .replace(/\*/g, '.*')                 // Convert * to .*
      .replace(/\?/g, '.');                 // Convert ? to .

    if (isRoot) {
        source = '^' + source;
    } else {
        source = '(?:^|\\/)' + source;
    }

    if (isDir) {
        source = source + '(?:\\/|$)';
    } else {
        source = source + '(?:\\/|$)';
    }

    return new RegExp(source);
  }

  isIgnored(relativePath) {
    if (this.patterns.length === 0) {
      return false;
    }
    const normalizedPath = toPosixPath(relativePath);
    for (const pattern of this.patterns) {
      if (pattern.test(normalizedPath)) {
        return true;
      }
    }
    return false;
  }
}

module.exports = { IgnoreMatcher };
