const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tableToMarkdown, safeFilename, copyCanvasImage, observeCopyTargets } = require('../export-ui.js');

const root = path.resolve(__dirname, '..');

function cell(text, rowSpan = 1, colSpan = 1) {
  return { innerText: text, textContent: text, rowSpan, colSpan };
}

test('REQ-003: table exports GitHub-compatible Markdown and escapes pipes', () => {
  const table = { rows: [
    { cells: [cell('항목'), cell('값')] },
    { cells: [cell('SSD | NAND'), cell('9.2 GB/s')] },
    { cells: [cell('두 줄\n설명'), cell('정상')] }
  ] };
  assert.equal(tableToMarkdown(table), [
    '| 항목 | 값 |',
    '| --- | --- |',
    '| SSD \\| NAND | 9.2 GB/s |',
    '| 두 줄<br>설명 | 정상 |'
  ].join('\n'));
});

test('REQ-003: merged cells keep a rectangular Markdown grid', () => {
  const table = { rows: [
    { cells: [cell('구분', 2), cell('성능', 1, 2)] },
    { cells: [cell('TTFT'), cell('TPS')] },
    { cells: [cell('기본'), cell('10 ms'), cell('20')] }
  ] };
  assert.equal(tableToMarkdown(table), [
    '| 구분 | 성능 |  |',
    '| --- | --- | --- |',
    '|  | TTFT | TPS |',
    '| 기본 | 10 ms | 20 |'
  ].join('\n'));
});

test('REQ-002: graph filename is safe and clipboard fallback is actionable', async () => {
  assert.equal(safeFilename('Memory / Swap trace'), 'Memory-Swap-trace.png');
  await assert.rejects(() => copyCanvasImage({}, {}, undefined), /PNG 저장/);
});

test('REQ-001: Sweep Lab user-facing status, errors, tables, and charts are Korean-first', () => {
  const source = fs.readFileSync(path.join(root, 'sweep-ui.js'), 'utf8');
  for (const english of [
    'Parameter sweeps require Web Worker support.',
    'No completed counterfactual rows to interpret.',
    'No matching parameters.',
    'Projection unavailable:',
    'Raw parameter sweep results',
    'No sweep started.',
    'Sweep unavailable while a scenario import is being verified.',
    'Pause does not end a sweep.'
  ]) {
    assert.equal(source.includes(english), false, english);
  }
  assert.match(source, /매개변수 스윕에는 Web Worker 지원이 필요합니다/);
  assert.match(source, /완료된 비교 시나리오가 없어 해석할 수 없습니다/);
  assert.match(source, /원시 매개변수 스윕 결과/);
  assert.match(source, /스윕이 시작되지 않았습니다/);
});

test('REQ-001: sweep parameter guidance explains resources and relationships in Korean', () => {
  const source = fs.readFileSync(path.join(root, 'sweep.js'), 'utf8');
  assert.equal(source.includes('Physical host RAM, or the shared memory pool'), false);
  assert.equal(source.includes('OAT changes only this configured value'), false);
  assert.match(source, /Host \/ 통합 메모리 용량/);
  assert.match(source, /물리 Host RAM 또는 통합 메모리 시스템의 공유 메모리 풀/);
  assert.match(source, /현재 활성 임계 경로에서 사용될 때만 지표가 변합니다/);
});

test('REQ-002: dynamically rendered charts are decorated and export tools ship in releases', () => {
  let callback;
  let observed = false;
  let scans = 0;
  class FakeMutationObserver {
    constructor(handler) { callback = handler; }
    observe(target, options) {
      observed = Boolean(target && options.childList && options.subtree);
    }
  }
  const previousDocument = global.document;
  global.document = {
    documentElement: {},
    querySelectorAll() { scans += 1; return []; }
  };
  try {
    assert.equal(observeCopyTargets(FakeMutationObserver), true);
    assert.equal(observed, true);
    callback([{ addedNodes: [{ nodeType: 1 }] }]);
    assert.equal(scans, 2);
  } finally {
    global.document = previousDocument;
  }

  const releaseBuilder = fs.readFileSync(path.join(root, 'tools/build-release.cjs'), 'utf8');
  assert.match(releaseBuilder, /'export-ui\.js'/);
});

test('REQ-001: main workspace labels and dynamic summaries are Korean-first', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  for (const english of [
    'Total model parameters (B)',
    'No product target is selected; all hardware and storage values are manual.',
    'Storage X-axis',
    'Normalized overlay:',
    'Storage I/O by execution bucket',
    'Read stacks + Write',
    'GB peak'
  ]) {
    assert.equal((html + ui + render).includes(english), false, english);
  }
  assert.match(html, /전체 모델 매개변수 \(B\)/);
  assert.match(html, /스토리지 X축/);
  assert.match(ui, /하드웨어 제품 대상을 선택하지 않았습니다/);
  assert.match(render, /실행 구간별 스토리지 I\/O/);
});

test('NFR-001: desktop layout keeps a bounded two-column workspace without duplicate controls', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /\.grid\{grid-template-columns:350px minmax\(0,1fr\);gap:16px\}/);
  assert.match(html, /@media\(max-width:1150px\)\{\.grid\{grid-template-columns:1fr\}/);
  assert.match(html, /\.panel,main\{min-width:0\}/);
  assert.match(html, /\.actionToolbar\{[^}]*display:flex;flex-wrap:wrap/);
  assert.match(html, /\.copyToolbar\{[^}]*flex-wrap:wrap/);

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  for (const match of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    assert.equal(fs.existsSync(path.join(root, match[1])), true, match[1]);
  }
});

test('NFR-001: translated copy does not rename browser APIs, runtime functions, or CSS hooks', () => {
  const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  assert.equal(ui.includes('local스토리지'), false);
  assert.equal(ui.includes('render스토리지IO'), false);
  assert.equal(render.includes('buildStorageIO구간s'), false);
  assert.equal(render.includes('advisor사용할 수 없음'), false);
  assert.match(ui, /localStorage/);
  assert.match(ui, /renderStorageIO/);
  assert.match(render, /buildStorageIOBuckets/);
  assert.match(render, /advisorUnavailable/);
});

test('REQ-001: playback and parameter help use Korean-first explanatory copy', () => {
  const help = fs.readFileSync(path.join(root, 'help.js'), 'utf8');
  const playback = fs.readFileSync(path.join(root, 'playback.js'), 'utf8');
  assert.equal(playback.includes('Initial IFP selection / materialization / prefill'), false);
  assert.equal(playback.includes('Waiting Token'), false);
  assert.equal(help.includes('Estimated sensitivity simulator / Unvalidated Alpha boundary'), false);
  assert.match(playback, /초기 IFP 선택 · 구체화 · 프리필/);
  assert.match(playback, /토큰 .*대기/);
  assert.match(help, /추정 민감도 시뮬레이터 · 미검증 알파 경계/);
});
