'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const elements = new Map();

for (const match of html.matchAll(/<input\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const attrs = match[1];
  const value = attrs.match(/\bvalue="([^"]*)"/)?.[1] || '';
  elements.set(match[2], {
    value,
    checked: /\bchecked\b/.test(attrs),
    textContent: '',
    disabled: false
  });
}
for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const options = [...match[2].matchAll(/<option\b([^>]*)>/g)]
    .map(option => [option[1], option[1].match(/\bvalue="([^"]*)"/)?.[1] || '']);
  const selected = options.find(option => /\bselected\b/.test(option[0])) || options[0];
  elements.set(match[1], { value: selected?.[1] || '', textContent: '', disabled: false });
}
elements.set('tests', { value: '', textContent: '', disabled: false });

const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', checked: false, disabled: false, style: {} });
    return elements.get(id);
  }
};

const moduleSource = ['core.js', 'config.js', 'memory.js', 'colibri.js', 'afm.js', 'serving.js', 'repro.js', 'playback.js', 'render.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const selfTestSource = fs.readFileSync(path.join(root, 'tests-init.js'), 'utf8')
  .split('function syncMode')[0];
const sandbox = {
  console,
  document,
  performance: { now: () => 0 },
  setTimeout: () => 0,
  clearTimeout: () => {}
};
vm.createContext(sandbox);
vm.runInContext(`${moduleSource}\n${selfTestSource}`, sandbox, { filename: 'browser-self-test-bundle.js' });

test('P0: browser input rejects unsafe integers instead of wrapping them', () => {
  const prompt = elements.get('prompt');
  const original = prompt.value;
  prompt.value = '2147483648';
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  prompt.value = original;
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'prompt'));
});

test('P0: browser input rejects negative bandwidth instead of silently clamping it', () => {
  const ssd = elements.get('ssdBW');
  const original = ssd.value;
  ssd.value = '-1';
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  ssd.value = original;
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'ssdBW'));
});

test('P0: browser input rejects an empty required numeric field instead of coercing it to zero', () => {
  const prompt = elements.get('prompt');
  const original = prompt.value;
  prompt.value = '';
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  prompt.value = original;
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'prompt'));
});

test('P0: browser input preserves invalid threshold order for fail-closed validation', () => {
  const ids = ['softPct', 'compressPct', 'swapPct', 'hardPct'];
  const original = Object.fromEntries(ids.map(id => [id, elements.get(id).value]));
  elements.get('softPct').value = '95';
  elements.get('compressPct').value = '70';
  elements.get('swapPct').value = '60';
  elements.get('hardPct').value = '50';
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  for (const id of ids) elements.get(id).value = original[id];
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'mem.thresholds'));
});

test('P0: rendering an error invalidates every stale KPI and result table', () => {
  for (const id of ['ttft', 'tpot', 'tps', 'ssdpt', 'hit', 'mem']) document.getElementById(id).textContent = 'stale';
  for (const id of ['summary', 'pressureSummary', 'memory', 'modelStatus']) document.getElementById(id).innerHTML = 'stale';
  vm.runInContext("render({ error: 'Invalid configuration', validationErrors: [] })", sandbox);
  for (const id of ['ttft', 'tpot', 'tps', 'ssdpt', 'hit', 'mem']) assert.equal(elements.get(id).textContent, '—');
  for (const id of ['summary', 'pressureSummary', 'memory', 'modelStatus']) assert.equal(elements.get(id).innerHTML, '');
  assert.equal(elements.get('warn').textContent, 'Invalid configuration');
});

test('P0: rendering an error clears both stale charts', () => {
  const cleared = { chart: 0, memoryChart: 0 };
  for (const id of Object.keys(cleared)) elements.set(id, {
    width: 800,
    height: 280,
    getContext: () => ({ clearRect: () => { cleared[id]++; } })
  });
  vm.runInContext("render({ error: 'Invalid configuration' })", sandbox);
  assert.deepEqual(cleared, { chart: 1, memoryChart: 1 });
});

test('P0: rendering an error stops stale playback and clears token and progress state', () => {
  const state = vm.runInContext(`(() => {
    const result = simulateColibri(readColibri());
    startAnim(result);
    render({ error: 'Invalid configuration' });
    return { hasResult: Boolean(anim.result), token: $('token').innerHTML, progress: $('progress').style.width, status: $('status').textContent };
  })()`, sandbox);
  assert.equal(state.hasResult, false);
  assert.equal(state.token, '');
  assert.equal(state.progress, '0');
  assert.equal(state.status, 'Invalid result');
});

test('P0: concurrent auto placement reserves KV capacity for the full request count', () => {
  const snapshot = new Map([...elements].map(([id, element]) => [id, { value: element.value, checked: element.checked }]));
  elements.get('placement').value = 'auto';
  elements.get('conc').value = '2';
  const placement = vm.runInContext(`(() => {
    const expected = applyColibriPlacement(readColibri());
    const actual = simulate();
    return { expectedVcache: expected.vcache, expectedDcache: expected.dcache, actualVcache: actual.c.vcache, actualDcache: actual.c.dcache };
  })()`, sandbox);
  for (const [id, state] of snapshot) {
    const element = elements.get(id);
    element.value = state.value;
    element.checked = state.checked;
  }
  assert.equal(placement.actualVcache, placement.expectedVcache);
  assert.equal(placement.actualDcache, placement.expectedDcache);
});

test('P1: normalized export and replay produce the same deterministic run ID', () => {
  const snapshot = new Map([...elements].map(([id, element]) => [id, { value: element.value, checked: element.checked }]));
  const placement = elements.get('placement');
  placement.value = 'auto';
  const ids = vm.runInContext(`(() => {
    const first = simulate();
    const artifact = createScenarioArtifact(first.c, first);
    applyScenarioConfig(artifact.config);
    const second = simulate();
    return [first.runId, artifact.runId, second.runId];
  })()`, sandbox);
  for (const [id, state] of snapshot) {
    const element = elements.get(id);
    element.value = state.value;
    element.checked = state.checked;
  }
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
});

test('P1: successful render exposes an equivalent token trace table for non-canvas access', () => {
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__traceResult = result;
  vm.runInContext('renderTraceTable(__traceResult)', sandbox);
  delete sandbox.__traceResult;
  const trace = elements.get('traceSummary').innerHTML;
  assert.match(trace, /Token 1/);
  assert.match(trace, /TPOT/);
  assert.match(trace, /NORMAL|RECLAIM|COMPRESS|SWAP|THRASH|OOM/);
  assert.doesNotMatch(trace, /undefined/);
});

test('P1: model status labels results as uncalibrated sensitivity estimates', () => {
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__statusResult = result;
  vm.runInContext('renderColibri(__statusResult)', sandbox);
  assert.match(elements.get('modelStatus').innerHTML, /uncalibrated sensitivity estimates/);
});

test('P1: swap UI distinguishes allocated or in-flight bytes from completed residency', () => {
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__swapResult = result;
  vm.runInContext('renderColibri(__swapResult); renderTraceTable(__swapResult)', sandbox);
  delete sandbox.__swapResult;
  assert.match(elements.get('memory').innerHTML, /Swap allocated \/ in-flight/);
  assert.match(elements.get('traceSummary').innerHTML, /Swap allocated \/ in-flight/);
  assert.doesNotMatch(elements.get('memory').innerHTML, /Swap resident/);
});

test('P1: mobile controls meet 44px targets and reduced motion disables the cursor animation', () => {
  assert.match(html, /min-height:\s*44px/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /\.cursor\s*\{[^}]*animation:\s*none/);
});

test('browser Self-test reports every scenario passing', () => {
  vm.runInContext('tests()', sandbox);
  const output = elements.get('tests').textContent;
  assert.equal(output.includes('FAIL'), false, output);
  assert.equal(output.includes('ERROR'), false, output);
  assert.match(output, /20\/20 passed$/);
});
