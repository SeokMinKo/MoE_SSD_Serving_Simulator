'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const playbackSource = fs.readFileSync(path.join(root, 'playback.js'), 'utf8');
const tokenIOSource = fs.readFileSync(path.join(root, 'token-io.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'ui-shadcn.css'), 'utf8');
const buildSource = fs.readFileSync(path.join(root, 'tools', 'build-release.cjs'), 'utf8');
const tokenIO = require(path.join(root, 'token-io.js'));

test('playback and token I/O sources remain valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(playbackSource, { filename: 'playback.js' }));
  assert.doesNotThrow(() => new vm.Script(tokenIOSource, { filename: 'token-io.js' }));
});

test('token playback updates after each emitted token and reports lifecycle state', () => {
  assert.match(playbackSource, /anim\.index\+\+;[\s\S]*updateTokenIOPlayback\(anim\.result, anim\.index/);
  assert.match(playbackSource, /setTokenIOPlaybackState\('paused'\)/);
  assert.match(playbackSource, /status:\s*completed\s*\?\s*'completed'\s*:\s*'running'/);
});

test('I/O contract uses mode-specific demand fields without fallback double counting', () => {
  const colibri = tokenIO.tokenIOBreakdown({ demandGB: 2, ssdGB: 99, readGB: 88, prefetchGB: 3, memory: { swapInGB: 4, swapOutGB: 5 } }, 'colibri');
  assert.deepEqual({ demand: colibri.demand, total: colibri.total }, { demand: 2, total: 14 });
  const colibriFallback = tokenIO.tokenIOBreakdown({ ssdGB: 6, readGB: 88 }, 'colibri');
  assert.equal(colibriFallback.demand, 6);
  const afm = tokenIO.tokenIOBreakdown({ demandGB: 99, ssdGB: 88, readGB: 7 }, 'afm3');
  assert.equal(afm.demand, 7);
});

test('large traces are bounded to readable recent and aggregate views', () => {
  const values = Array.from({ length: 1024 }, (_, index) => tokenIO.tokenIOBreakdown({ demandGB: index + 1, tpot: 10 + index / 10 }, 'colibri'));
  const recent = tokenIO.buildTokenIOGroups(values, 1024, 'recent');
  assert.equal(recent.length, 64);
  assert.equal(recent[0].startIndex, 960);
  const all = tokenIO.buildTokenIOGroups(values, 1024, 'all');
  assert.ok(all.length <= 128);
  assert.ok(all.every(group => group.count >= 1));
  assert.equal(all.at(-1).endIndex, 1023);
});

test('P95 scale prevents one extreme token from flattening the full chart', () => {
  const groups = Array.from({ length: 20 }, (_, index) => ({ startIndex: index, total: index === 19 ? 1000 : 10 }));
  assert.equal(tokenIO.tokenIOScaleMax(groups, 20, 'linear'), 1000);
  assert.equal(tokenIO.tokenIOScaleMax(groups, 20, 'p95'), 10);
});

test('token I/O panel uses Korean-first lifecycle copy while retaining technical terms', () => {
  assert.match(tokenIOSource, /실시간 스토리지 추적/);
  assert.match(tokenIOSource, /디코드\(Decode\) 토큰마다/);
  assert.match(tokenIOSource, /0 \/ 0 토큰/);
  assert.doesNotMatch(tokenIOSource, /LIVE STORAGE TRACE|0 \/ 0 tokens/);
});

test('token I/O canvas backing follows the visible CSS box without a mobile width floor', () => {
  assert.match(tokenIOSource, /Math\.max\(1, Math\.round\(canvas\.clientWidth/);
  assert.doesNotMatch(tokenIOSource, /Math\.max\(320, Math\.round\(canvas\.clientWidth/);
});

test('accessible interaction and non-color encodings are present', () => {
  assert.match(tokenIOSource, /tabindex="0"/);
  assert.match(tokenIOSource, /접근 가능한 토큰별 I\/O 표/);
  assert.match(tokenIOSource, /ArrowLeft/);
  assert.match(tokenIOSource, /state\.completedCount\s*%\s*8/);
  assert.match(cssSource, /repeating-linear-gradient/);
  assert.match(cssSource, /forced-colors:\s*active/);
  assert.match(cssSource, /\.skipLink/);
});

test('ShadCN semantic styling is static and release bundles include its assets', () => {
  assert.match(cssSource, /--background:/);
  assert.match(cssSource, /--primary:/);
  assert.match(cssSource, /--border:/);
  assert.doesNotMatch(playbackSource, /style\.textContent/);
  assert.match(buildSource, /'token-io\.js'/);
  assert.match(buildSource, /'ui-shadcn\.css'/);
});
