'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const playbackPath = path.join(__dirname, '..', 'playback.js');
const source = fs.readFileSync(playbackPath, 'utf8');

test('playback source remains valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'playback.js' }));
});

test('token playback updates the live storage chart after every emitted token', () => {
  assert.match(source, /function\s+updateTokenIOPlayback\s*\(/);
  assert.match(source, /anim\.index\+\+;[\s\S]*updateTokenIOPlayback\(anim\.result, anim\.index\)/);
});

test('token I/O total includes demand, prefetch, swap-in and swap-out traffic', () => {
  assert.match(source, /total:\s*demand\s*\+\s*prefetch\s*\+\s*swapIn\s*\+\s*swapOut/);
  assert.match(source, /token\?\.memory\?\.swapInGB/);
  assert.match(source, /token\?\.memory\?\.swapOutGB/);
});

test('ShadCN-compatible semantic tokens and accessible chart are installed', () => {
  assert.match(source, /--background:/);
  assert.match(source, /--primary:/);
  assert.match(source, /--border:/);
  assert.match(source, /id="tokenIOPlaybackChart"/);
  assert.match(source, /role="img"/);
  assert.match(source, /aria-live="polite"/);
});
