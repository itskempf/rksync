const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { IgnoreMatcher } = require('../lib/ignoreMatcher');

test('IgnoreMatcher correctly matches patterns', () => {
    fs.writeFileSync('.rksyncignore', '*.txt\nbuild/\n/src/temp.js\n');

    const matcher = new IgnoreMatcher('.');

    assert.equal(matcher.isIgnored('hello.txt'), true);
    assert.equal(matcher.isIgnored('folder/hello.txt'), true);
    assert.equal(matcher.isIgnored('build/output.js'), true);
    assert.equal(matcher.isIgnored('src/temp.js'), true);

    assert.equal(matcher.isIgnored('hello.js'), false);
    assert.equal(matcher.isIgnored('src/other.js'), false);

    fs.unlinkSync('.rksyncignore');
});
