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

test('compute chart description follows the active engine without BigMoEEdge falling back to Colibri GPU copy', () => {
  const bigmoe = tokenIO.computeDescriptionForMode('bigmoe-edge');
  assert.match(bigmoe, /BigMoEEdge/);
  assert.match(bigmoe, /CPU-only serial/);
  assert.doesNotMatch(bigmoe, /Colibri|GPU/);
});

test('compute trace uses modeled compute-path elapsed time instead of wall-clock TPOT or storage waits', () => {
  const colibri = tokenIO.tokenIOBreakdown({
    tpot: 900,
    computeMs: 800,
    computeOnlyMs: 700,
    computeBreakdown: { exposedComputeMs: 123 },
    storageServiceMs: 456,
    storageQueueMs: 78
  }, 'colibri');
  assert.equal(colibri.computeMs, 123);
  assert.equal(colibri.tpotMs, 900);

  const colibriFallback = tokenIO.tokenIOBreakdown({ computeOnlyMs: 45, computeMs: 90 }, 'colibri');
  assert.equal(colibriFallback.computeMs, 45);
  const afm = tokenIO.tokenIOBreakdown({ computeOnlyMs: 67, computeMs: 89 }, 'afm3');
  assert.equal(afm.computeMs, 67);
});

test('compute groups share token ranges and average aggregation with Storage I/O', () => {
  const values = [10, 20, 90, 120].map((computeOnlyMs, index) => tokenIO.tokenIOBreakdown({ demandGB: index + 1, computeOnlyMs }, 'colibri'));
  const groups = tokenIO.buildTokenIOGroups(values, 4, 'all', 2);
  assert.deepEqual(groups.map(group => [group.startIndex, group.endIndex, group.computeMs]), [[0, 1, 15], [2, 3, 105]]);
  assert.equal(tokenIO.tokenComputeScaleMax(groups, 4, 'linear'), 105);
});

test('all-range buckets aggregate only the completed prefix during playback', () => {
  const values = Array.from({ length: 10 }, (_, index) => tokenIO.tokenIOBreakdown({
    demandGB: index + 1,
    computeOnlyMs: index + 1,
    tpot: 100 + index
  }, 'colibri'));
  const [partial] = tokenIO.buildTokenIOGroups(values, 1, 'all', 1);
  assert.equal(partial.startIndex, 0);
  assert.equal(partial.endIndex, 9);
  assert.equal(partial.completedEndIndex, 0);
  assert.equal(partial.sampleCount, 1);
  assert.equal(partial.total, 1);
  assert.equal(partial.computeMs, 1);
  assert.equal(partial.tpotMs, 100);
  assert.equal(partial.peakIndex, 0);
  assert.equal(partial.computePeakIndex, 0);
});

test('shared token ticks keep the final mobile bucket label from overlapping its neighbor', () => {
  const values = Array.from({ length: 64 }, (_, index) => tokenIO.tokenIOBreakdown({ demandGB: 1, computeOnlyMs: index + 1 }, 'colibri'));
  const groups = tokenIO.buildTokenIOGroups(values, 64, 'all', 32);
  assert.deepEqual(tokenIO.tokenTickIndices(groups, 309), [0, 10, 21, 31]);
});

test('Storage I/O and compute plots use identical horizontal insets for aligned token positions', () => {
  assert.deepEqual(tokenIO.tokenChartInsets(true), { left: 52, right: 48, top: 16, bottom: 34 });
  assert.deepEqual(tokenIO.tokenChartInsets(false), { left: 52, right: 14, top: 16, bottom: 34 });
  assert.equal((tokenIOSource.match(/tokenChartInsets\(state\.showTpot\)/g) || []).length, 2);
});

test('compute chart follows the Storage I/O chart and provides explicit semantic and accessible equivalents', () => {
  const storageChart = tokenIOSource.indexOf('id="tokenIOPlaybackChart"');
  const computeChart = tokenIOSource.indexOf('id="tokenComputeChart"');
  const inspector = tokenIOSource.indexOf('class="tokenIOInspector"');
  assert.ok(storageChart >= 0 && computeChart > storageChart && inspector > computeChart);
  assert.match(tokenIOSource, /토큰별 Compute 시간/);
  assert.match(tokenIOSource, /Storage I\/O 서비스·큐 대기와 DRAM stall을 포함하지/);
  assert.match(tokenIOSource, /실측 가속기 프로파일링 값이 아닌 모델링된 compute 경로 경과시간/);
  assert.match(tokenIOSource, /id="tokenComputeChart"[^>]+role="img"[^>]+aria-labelledby="tokenComputeTitle"[^>]+aria-describedby="tokenComputeDescription tokenIOChartHelp"/);
  assert.match(tokenIOSource, /<th scope="col">Compute<\/th>/);
  assert.match(tokenIOSource, /<dt>Compute<\/dt><dd id="tokenIODetailCompute">/);
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

test('every chart series meets 3:1 non-text contrast in Light and Dark themes', () => {
  const rootBlock = cssSource.match(/^:root\s*\{([\s\S]*?)\}/)?.[1];
  const lightBlock = cssSource.match(/:root\[data-theme=["']light["']\]\s*\{([\s\S]*?)\}/i)?.[1];
  assert.ok(rootBlock && lightBlock, 'theme variable blocks must be explicit');
  const valueOf = (block, name) => block.match(new RegExp(`--${name}:\\s*([^;]+)`))?.[1].trim();
  const hexRgb = value => value.slice(1).match(/.{2}/g).map(part => Number.parseInt(part, 16));
  const hslRgb = value => {
    const [h, sPercent, lPercent] = value.split(/\s+/).map(Number.parseFloat);
    const s = sPercent / 100;
    const l = lPercent / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const sector = ((h % 360) + 360) % 360 / 60;
    const x = chroma * (1 - Math.abs(sector % 2 - 1));
    const [r, g, b] = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x];
    const offset = l - chroma / 2;
    return [r, g, b].map(channel => (channel + offset) * 255);
  };
  const blend = (foreground, background, alpha) => foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha));
  const luminance = rgb => rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (first, second) => {
    const [bright, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (bright + 0.05) / (dark + 0.05);
  };
  const backgrounds = {
    dark: [blend(hslRgb(valueOf(rootBlock, 'muted')), hslRgb(valueOf(rootBlock, 'card')), 0.15), hslRgb(valueOf(rootBlock, 'muted'))],
    light: [blend(hslRgb(valueOf(lightBlock, 'muted')), hslRgb(valueOf(lightBlock, 'card')), 0.15), hslRgb(valueOf(lightBlock, 'muted'))]
  };
  const series = ['token-io-demand', 'token-io-prefetch', 'token-io-swap-in', 'token-io-swap-out', 'token-compute', 'token-io-tpot'];
  for (const [theme, block] of [['dark', rootBlock], ['light', lightBlock]]) {
    for (const name of series) {
      const color = valueOf(block, name) || valueOf(rootBlock, name);
      assert.match(color || '', /^#[0-9a-f]{6}$/i, `${theme} ${name} color must be explicit`);
      const ratio = Math.min(...backgrounds[theme].map(background => contrast(hexRgb(color), background)));
      assert.ok(ratio >= 3, `${theme} ${name} conservative contrast was ${ratio.toFixed(3)}:1`);
    }
  }
});

test('token I/O panel uses Korean-first lifecycle copy while retaining technical terms', () => {
  assert.match(tokenIOSource, /실시간 스토리지 추적/);
  assert.match(tokenIOSource, /디코드\(Decode\) 토큰별로/);
  assert.match(tokenIOSource, /0 \/ 0 토큰/);
  assert.doesNotMatch(tokenIOSource, /LIVE STORAGE TRACE|0 \/ 0 tokens/);
  assert.match(tokenIOSource, /전체 토큰 범위 · 토큰당 평균 집계/);
  assert.doesNotMatch(tokenIOSource, /전체 · 자동 집계/);
});

test('result section arrangement is interaction-idempotent when DOM order is already correct', () => {
  const start = tokenIOSource.indexOf('function arrangeResultSections');
  const end = tokenIOSource.indexOf('\n\n  function ensurePanel', start);
  const arrangeResultSections = vm.runInNewContext(`(${tokenIOSource.slice(start, end)})`);
  const body = { id: 'body' };
  const focusedControl = { id: 'graphViewMode' };
  const panel = { id: 'tokenIOPlaybackPanel', contains: node => node === focusedControl };
  const resultVisuals = { id: 'resultVisuals', contains: node => node === focusedControl };
  const advisor = { id: 'advisor', contains: () => false };
  const documentObject = {
    activeElement: focusedControl,
    getElementById(id) {
      return { resultVisuals, advisor }[id] || null;
    }
  };
  const resultHero = {
    children: [panel, resultVisuals, advisor],
    appendChild(node) {
      if (node.contains?.(documentObject.activeElement)) documentObject.activeElement = body;
      this.children = this.children.filter(child => child !== node);
      this.children.push(node);
    }
  };

  arrangeResultSections(documentObject, resultHero, panel);

  assert.equal(documentObject.activeElement, focusedControl);
  assert.deepEqual(resultHero.children, [panel, resultVisuals, advisor]);
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
