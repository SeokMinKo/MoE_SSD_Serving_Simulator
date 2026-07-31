'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const uiSource = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
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

const moduleSource = ['core.js', 'help.js', 'presets.js', 'config.js', 'memory.js', 'colibri.js', 'afm.js', 'serving.js', 'advisor.js', 'storage-io.js', 'sweep.js', 'repro.js', 'playback.js', 'render.js', 'sweep-ui.js', 'ui.js']
  .filter(file => fs.existsSync(path.join(root, file)))
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const testsInitFull = fs.readFileSync(path.join(root, 'tests-init.js'), 'utf8');
const selfTestSource = testsInitFull
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

test('P1: topology preset catalog exposes Kimi K3 and all 29 complete CSV models', () => {
  const inventory = vm.runInContext(`typeof MOE_MODEL_PRESETS === 'undefined' ? null : ({
    count: MOE_MODEL_PRESETS.length,
    deepseek: MOE_MODEL_PRESETS.find(p => p.model === 'DeepSeek-V3 / R1'),
    kimiK3: MOE_MODEL_PRESETS.find(p => p.model === 'Kimi K3'),
    mixtral: MOE_MODEL_PRESETS.find(p => p.model === 'Mixtral 8x7B'),
    valid: MOE_MODEL_PRESETS.every(p => Number.isSafeInteger(p.layers) && p.layers > 0 && Number.isSafeInteger(p.experts) && p.experts > 0 && Number.isSafeInteger(p.active) && p.active > 0 && p.active <= p.experts && p.sourceUrl.startsWith('https://')),
    uniqueIds: new Set(MOE_MODEL_PRESETS.map(p => p.id)).size
  })`, sandbox);
  assert.ok(inventory, 'MOE_MODEL_PRESETS must be defined');
  assert.equal(inventory.count, 29);
  assert.equal(inventory.valid, true);
  assert.equal(inventory.uniqueIds, 29);
  assert.deepEqual(JSON.parse(JSON.stringify(inventory.deepseek && [inventory.deepseek.layers, inventory.deepseek.experts, inventory.deepseek.active])), [58, 256, 8]);
  assert.deepEqual(JSON.parse(JSON.stringify(inventory.mixtral && [inventory.mixtral.layers, inventory.mixtral.experts, inventory.mixtral.active])), [32, 8, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(inventory.kimiK3 && [inventory.kimiK3.layers, inventory.kimiK3.experts, inventory.kimiK3.active])), [92, 896, 16]);
  assert.equal(inventory.kimiK3?.disclosureStatus, 'official open weights/config');
});

test('P1: applying a topology preset changes only mapped routing controls', () => {
  const apiAvailable = vm.runInContext("typeof initializeModelPresets === 'function' && typeof applySelectedModelPreset === 'function'", sandbox);
  assert.equal(apiAvailable, true, 'preset UI API must be defined');
  const protectedIds = ['esize', 'resident', 'kv', 'prompt', 'output', 'host', 'vram', 'ssdBW'];
  const before = Object.fromEntries([...protectedIds, 'layers', 'experts', 'active'].map(id => [id, elements.get(id).value]));
  const result = vm.runInContext(`(() => {
    initializeModelPresets();
    $('modelPreset').value = 'deepseek-deepseek-v3-r1';
    const applied = applySelectedModelPreset();
    return { applied, layers: $('layers').value, experts: $('experts').value, active: $('active').value, summary: $('presetSummary').innerHTML };
  })()`, sandbox);
  assert.equal(result.applied, true);
  assert.deepEqual([result.layers, result.experts, result.active], ['58', '256', '8']);
  assert.match(result.summary, /Topology only/);
  assert.match(result.summary, /DeepSeek-V3 \/ R1/);
  assert.match(result.summary, /Disclosure: public/);
  for (const id of protectedIds) assert.equal(elements.get(id).value, before[id], id);
  const kimi = vm.runInContext(`(() => {
    $('modelPreset').value = 'kimi-kimi-k3';
    const applied = applySelectedModelPreset();
    return { applied, layers: $('layers').value, experts: $('experts').value, active: $('active').value, summary: $('presetSummary').innerHTML };
  })()`, sandbox);
  assert.equal(kimi.applied, true);
  assert.deepEqual([kimi.layers, kimi.experts, kimi.active], ['92', '896', '16']);
  assert.match(kimi.summary, /Disclosure: official open weights\/config/);
  for (const id of protectedIds) assert.equal(elements.get(id).value, before[id], id);
  for (const id of ['layers', 'experts', 'active']) elements.get(id).value = before[id];
});

test('P1: editing mapped topology controls returns the preset selector to Custom', () => {
  const apiAvailable = vm.runInContext("typeof markModelPresetCustom === 'function'", sandbox);
  assert.equal(apiAvailable, true, 'manual topology API must be defined');
  const before = Object.fromEntries(['layers', 'experts', 'active'].map(id => [id, elements.get(id).value]));
  const state = vm.runInContext(`(() => {
    initializeModelPresets();
    $('modelPreset').value = 'mistral-mixtral-8x7b';
    applySelectedModelPreset();
    markModelPresetCustom();
    return { selected: $('modelPreset').value, summary: $('presetSummary').innerHTML };
  })()`, sandbox);
  assert.equal(state.selected, 'custom');
  assert.match(state.summary, /Custom \/ manual topology/);
  for (const id of ['layers', 'experts', 'active']) elements.get(id).value = before[id];
});

test('P1: topology preset control is accessible and wired into the browser entry point', () => {
  assert.match(html, /<select id="modelPreset"/);
  assert.match(html, /class="f presetControl"/);
  assert.match(html, /\.f\.presetControl\{grid-template-columns:1fr\}/);
  assert.match(html, /id="presetSummary"[^>]*role="status"/);
  assert.ok(html.indexOf('<script src="core.js"></script>') < html.indexOf('<script src="presets.js"></script>'));
  assert.ok(html.indexOf('<script src="presets.js"></script>') < html.indexOf('<script src="config.js"></script>'));
  assert.match(testsInitFull, /initializeModelPresets\(\)/);
  assert.match(testsInitFull, /\$\('modelPreset'\)\.onchange/);
  assert.match(testsInitFull, /for \(const id of \['layers', 'experts', 'active'\]\) \$\(id\)\.oninput = markModelPresetCustom/);
});

test('P1: topology preset provenance is repository-local and checked by the quality gate', () => {
  assert.equal(fs.existsSync(path.join(root, 'data', 'moe_model_trend_with_layers_2026-07-21.csv')), true);
  assert.equal(fs.existsSync(path.join(root, 'tools', 'check-presets.cjs')), true);
  assert.match(packageJson.scripts.check, /check-presets\.cjs/);
});

test('P1: scenario import clears stale published-model attribution', () => {
  const before = Object.fromEntries(['layers', 'experts', 'active'].map(id => [id, elements.get(id).value]));
  const state = vm.runInContext(`(() => {
    initializeModelPresets();
    $('modelPreset').value = 'deepseek-deepseek-v3-r1';
    applySelectedModelPreset();
    applyScenarioConfig({ ...readColibri(), layers: 32, experts: 8, active: 2 });
    return { selected: $('modelPreset').value, summary: $('presetSummary').innerHTML };
  })()`, sandbox);
  assert.equal(state.selected, 'custom');
  assert.match(state.summary, /Custom \/ manual topology/);
  for (const id of ['layers', 'experts', 'active']) elements.get(id).value = before[id];
});

test('P0: preset summary rejects non-HTTPS source links', () => {
  vm.runInContext("renderModelPresetSummary({ ...MOE_MODEL_PRESETS[0], sourceUrl: 'javascript:alert(1)' })", sandbox);
  assert.doesNotMatch(elements.get('presetSummary').innerHTML, /javascript:/i);
  assert.match(elements.get('presetSummary').innerHTML, /source unavailable/);
});

test('P0: browser input preserves safe integer seeds without Float32 rounding', () => {
  elements.get('seed').value = String(Number.MAX_SAFE_INTEGER);
  const config = vm.runInContext('readColibri()', sandbox);
  assert.equal(config.seed, Number.MAX_SAFE_INTEGER);
  assert.equal(vm.runInContext('validateSimulationConfig(readColibri()).valid', sandbox), true);
  elements.get('seed').value = '260730';
});

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
  elements.get('conc').value = '2';
  const ids = vm.runInContext(`(() => {
    const first = simulate();
    const artifact = createScenarioArtifact(first.c, first);
    applyScenarioConfig(artifact.config);
    const second = simulate();
    return [first.runId, artifact.runId, second.runId, bottleneckInsightsMatch(artifact.insight, createBottleneckInsight(second))];
  })()`, sandbox);
  for (const [id, state] of snapshot) {
    const element = elements.get(id);
    element.value = state.value;
    element.checked = state.checked;
  }
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.equal(ids[3], true);
});

test('P1: sticky action toolbar and Storage I/O workspace expose the approved controls', () => {
  const toolbarIndex = html.indexOf('id="actionToolbar"');
  const gridIndex = html.indexOf('<div class="grid">');
  assert.ok(toolbarIndex >= 0 && toolbarIndex < gridIndex, `${toolbarIndex}/${gridIndex}`);
  assert.match(html, /class="[^"]*actionToolbar[^"]*"/);
  for (const id of ['run', 'pause', 'openSweep', 'test', 'exportScenario', 'importScenario', 'setBaseline']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, />App integrity test</);
  for (const id of ['graphViewMode', 'storageXAxis', 'storageYAxis', 'storageChart', 'storageTraceSummary']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<option value="tabs"/);
  assert.match(html, /<option value="stacked"/);
  assert.match(html, /<option value="overlay"/);
  assert.match(html, /<script src="storage-io\.js"><\/script>[\s\S]*<script src="render\.js"><\/script>/);
});

test('P1: Storage I/O renderer exposes read/write data and graph view switching', () => {
  assert.equal(vm.runInContext("typeof renderStorageIO === 'function' && typeof syncGraphView === 'function'", sandbox), true);
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__storageResult = result;
  const output = vm.runInContext(`(() => {
    $('storageXAxis').value = 'completion-time';
    $('storageYAxis').value = 'gb';
    renderStorageIO(__storageResult);
    return $('storageTraceSummary').innerHTML;
  })()`, sandbox);
  delete sandbox.__storageResult;
  assert.match(output, /Prefill/);
  assert.match(output, /Expert \/ window read/);
  assert.match(output, /Prefetch read/);
  assert.match(output, /Swap-in read/);
  assert.match(output, /Swap-out write/);
  assert.doesNotMatch(output, /undefined|NaN|Infinity/);
});

test('P1: parameter help describes meaning, config key, unit, engine, and synthetic direction', () => {
  assert.equal(vm.runInContext("typeof parameterHelpForControl === 'function' && typeof initializeParameterHelp === 'function'", sandbox), true);
  const help = vm.runInContext("parameterHelpForControl('ssdBW')", sandbox);
  assert.match(help, /SSD/);
  assert.match(help, /ssdBW/);
  assert.match(help, /GB\/s/);
  assert.match(help, /Colibri.*AFM|모든 엔진/);
  assert.match(help, /simulator|시뮬레이터/i);
  const helpSource = fs.readFileSync(path.join(root, 'help.js'), 'utf8');
  assert.match(helpSource, /tabIndex\s*=\s*0|tabindex/i);
  assert.match(helpSource, /aria-describedby|aria-label/);
});

test('P1: browser sweep and successful import never rerun accepted simulations on the main thread', () => {
  const sweepSource = fs.readFileSync(path.join(root, 'sweep-ui.js'), 'utf8');
  const reproSource = fs.readFileSync(path.join(root, 'repro.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(root, 'replay-worker.js'), 'utf8');
  assert.doesNotMatch(sweepSource, /simulateSweepConfig\s*\(/);
  assert.match(sweepSource, /new Worker\(['"]simulation-worker\.js['"]\)/);
  assert.match(sweepSource, /const baselineConfig = baselineRun\.config/);
  assert.match(sweepSource, /sweepScenarioInFlight[\s\S]*scheduleSweepTick/);
  assert.match(sweepSource, /if \(!activeSweepExecution \|\| sweepScenarioInFlight/);
  assert.match(sweepSource, /finally\s*\{\s*sweepScenarioInFlight = false/);
  assert.match(sweepSource, /execution\.status = 'failed'/);
  assert.doesNotMatch(reproSource.match(/async function importScenarioFile[\s\S]*?\n\}/)?.[0] || '', /syncMode\s*\(/);
  assert.match(workerSource, /replayResult/);
  assert.equal(fs.existsSync(path.join(root, 'simulation-worker.js')), true);
});

test('P1: artifact import requires a Worker and serializes import/sweep operations', () => {
  const reproSource = fs.readFileSync(path.join(root, 'repro.js'), 'utf8');
  const sweepSource = fs.readFileSync(path.join(root, 'sweep-ui.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(root, 'replay-worker.js'), 'utf8');
  assert.doesNotMatch(reproSource, /typeof Worker === 'undefined'\) return Promise\.resolve/);
  assert.match(reproSource, /scenarioImportGeneration/);
  assert.match(reproSource, /AbortController/);
  assert.match(reproSource, /sweepPreparing/);
  assert.match(reproSource, /scenarioImportInProgress/);
  assert.match(reproSource, /generation !== scenarioImportGeneration[\s\S]*scenarioImportAbortError/);
  assert.match(reproSource, /compactReplayResultForUI/);
  assert.match(workerSource, /REPLAY_RESULT_MAX_BYTES/);
  assert.match(workerSource, /TextEncoder/);
  const compaction = vm.runInContext(`(() => {
    const original = { tokens: [{ token: 1 }], state: { peakPhysicalGB: 1, swappedExperts: new Set(['1:1']), pending: new Map([['x', 1]]) }, serving: { completedTokens: 1000, requests: [{ id: 'request-1', output: 1000, tokens: Array.from({ length: 1000 }, (_, index) => ({ token: index })) }] } };
    const compact = compactReplayResultForUI(original);
    return { originalTokens: original.serving.requests[0].tokens.length, compactHasTokens: Object.prototype.hasOwnProperty.call(compact.serving.requests[0], 'tokens'), completedTokens: compact.serving.completedTokens, topTokens: compact.tokens.length, stateHasSet: Object.values(compact.state).some(value => value instanceof Set), stateHasMap: Object.values(compact.state).some(value => value instanceof Map) };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(compaction)), { originalTokens: 1000, compactHasTokens: false, completedTokens: 1000, topTokens: 1, stateHasSet: false, stateHasMap: false });
  assert.match(sweepSource, /scenarioImportInProgress/);
});

test('P1: browser artifact replay runs in a bounded worker instead of blocking the UI thread', () => {
  const reproSource = fs.readFileSync(path.join(root, 'repro.js'), 'utf8');
  assert.match(reproSource, /new Worker\(['"]replay-worker\.js['"]\)/);
  assert.match(reproSource, /worker\.terminate\(\)/);
  assert.match(reproSource, /30-second work budget[\s\S]*30000\)/);
  assert.match(reproSource, /await verifyScenarioArtifactAsync/);
  assert.equal(fs.existsSync(path.join(root, 'replay-worker.js')), true);
});

test('P1: scenario import represents deterministic seed and clears a null sweep atomically', () => {
  assert.match(html, /<input[^>]+id="seed"[^>]+type="hidden"|<input[^>]+type="hidden"[^>]+id="seed"/);
  const reproSource = fs.readFileSync(path.join(root, 'repro.js'), 'utf8');
  assert.match(reproSource, /seed:\s*'seed'/);
  assert.match(reproSource, /else\s+resetSweepResults\(\)/);
  assert.match(reproSource, /catch\s*\([^)]*\)\s*\{[\s\S]*restoreScenarioUIState/);
});

test('P1: parameter help first pointer click remains open after focus', () => {
  assert.equal(vm.runInContext('parameterHelpClickShouldShow(true, false)', sandbox), true);
  assert.equal(vm.runInContext('parameterHelpClickShouldShow(false, false)', sandbox), false);
  assert.equal(vm.runInContext('parameterHelpClickShouldShow(false, true)', sandbox), true);
});

test('P1: OOM sweep metrics render as chart gaps and non-numeric table cells', () => {
  const calls = [];
  const context = {
    clearRect() {}, fillRect() {}, beginPath() {}, moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); }, stroke() {}, fillText() {},
    set fillStyle(value) {}, set strokeStyle(value) {}, set lineWidth(value) {}, set font(value) {}
  };
  elements.set('gapChart', { width: 200, height: 100, getContext: () => context });
  elements.set('sweepResults', { innerHTML: '' });
  const table = vm.runInContext(`(() => {
    const rows = [
      { index: 0, changes: { host: 1 }, metrics: { status: 'completed', oom: false, reason: '', ttftMeanMs: 10, ttftP50Ms: 10, ttftP95Ms: 10, singleTPS: 1, aggregateTPS: 1 } },
      { index: 1, changes: { host: 0.5 }, metrics: { status: 'oom', oom: true, reason: 'OOM', ttftMeanMs: 20, ttftP50Ms: 20, ttftP95Ms: 20, singleTPS: 2, aggregateTPS: 2 } },
      { index: 2, changes: { host: 2 }, metrics: { status: 'completed', oom: false, reason: '', ttftMeanMs: 30, ttftP50Ms: 30, ttftP95Ms: 30, singleTPS: 3, aggregateTPS: 3 } }
    ];
    drawSweepMetricChart('gapChart', rows, ['ttftMeanMs'], ['#fff'], 'gap');
    renderSweepTable({ baselineMetrics: rows[0].metrics, results: rows.slice(1) });
    return $('sweepResults').innerHTML;
  })()`, sandbox);
  assert.equal(calls.filter(call => call[0] === 'lineTo').length, 5, JSON.stringify(calls));
  assert.match(table, /<td>oom<\/td><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
});

test('P1: Sweep Lab exposes parameter selection, OAT/Grid execution controls, charts, table, and CSV', () => {
  for (const id of ['sweepLab', 'sweepMode', 'parameterSearch', 'parameterCategory', 'parameterChecklist', 'selectAllSweep', 'clearSweep', 'sweepSelectedCount', 'sweepProjectedCount', 'sweepParameters', 'runSweep', 'pauseSweep', 'resumeSweep', 'cancelSweep', 'exportSweepCsv', 'sweepProgress', 'sweepTruncation', 'sweepTTFTChart', 'sweepTPSChart', 'sweepResults']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /One-at-a-time/);
  assert.match(html, /Grid/);
  assert.match(html, /TTFT mean \/ p50 \/ p95/);
  assert.match(html, /Single-sequence TPS \/ aggregate TPS/);
  assert.match(html, /Estimated sensitivity simulator \/ Unvalidated Alpha/);
  assert.match(html, /<script src="sweep\.js"><\/script>/);
  assert.equal(vm.runInContext("typeof initializeSweepLab === 'function' && typeof renderSweepResults === 'function' && typeof exportSweepCsv === 'function'", sandbox), true);
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

test('P1: Bottleneck Advisor is directly below KPIs and exposes phase scorecards', () => {
  const kpiIndex = html.indexOf('<div class="kpis">');
  const advisorIndex = html.indexOf('<section id="advisor"');
  const tokenIndex = html.indexOf('<div id="token"');
  assert.ok(kpiIndex >= 0 && advisorIndex > kpiIndex && tokenIndex > advisorIndex, `${kpiIndex}/${advisorIndex}/${tokenIndex}`);
  assert.match(html, /Estimated sensitivity simulator \/ Unvalidated Alpha/);
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__advisorResult = result;
  vm.runInContext('renderBottleneckAdvisor(createBottleneckInsight(__advisorResult))', sandbox);
  delete sandbox.__advisorResult;
  const output = elements.get('advisor').innerHTML;
  for (const label of ['Prefill', 'First token', 'Decode', 'Memory pressure']) assert.match(output, new RegExp(label));
  for (const label of ['Storage', 'Data movement', 'Compute', 'Capacity / policy']) assert.match(output, new RegExp(label));
  assert.match(output, /Relative pressure/);
  assert.match(output, /Trade-off/);
  assert.match(output, /not measured|not a measured/i);
});

test('P1: invalid render replaces stale advisor scores with an unavailable reason', () => {
  elements.get('advisor').innerHTML = '<b>stale score 100</b>';
  vm.runInContext("render({ error: 'Invalid configuration: prompt is required' })", sandbox);
  const output = elements.get('advisor').innerHTML;
  assert.doesNotMatch(output, /stale score/);
  assert.match(output, /Unavailable/);
  assert.match(output, /configuration validation failed/i);
});

test('P1: pre-decode OOM render provides capacity recovery without fabricated timing scores', () => {
  vm.runInContext("render({ error: 'Unified memory OOM before decode: 140 / 128 GB', mode: 'afm3', c: { host: 128, vram: 0 } })", sandbox);
  const output = elements.get('advisor').innerHTML;
  assert.match(output, /OOM before decode/);
  assert.match(output, /Capacity \/ policy/);
  assert.match(output, /host|context|concurrency/i);
  assert.doesNotMatch(output, /Prefill[^<]*100|Decode[^<]*100/);
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

test('P1: mobile controls meet 44px targets, avoid sticky overlap, and respect reduced motion', () => {
  assert.match(html, /min-height:\s*44px/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /\.cursor\s*\{[^}]*animation:\s*none/);
  assert.match(html, /\.buttons:has\(#run\)\{position:static/);
});

test('P1: guided workflow exposes three Korean steps, HW preset, Expert mode, and measured analysis landmarks', () => {
  for (const id of ['guidedWorkflow', 'expertModeToggle', 'hardwarePreset', 'guidedAnalysis', 'runGuidedSweep']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const step of ['시나리오 설정', '결과와 병목', '개선 검증']) assert.match(html, new RegExp(step));
  assert.match(html, /aria-current="step"/);
  assert.match(html, /Synthetic template/);
  assert.match(html, /Expert mode/);
});

test('P1: production guided UI contains no console info debug statements', () => {
  assert.doesNotMatch(uiSource, /console\.info\s*\(/);
});

test('P1: guided bottleneck analysis deduplicates resources and chooses at most two sweepable parameters', () => {
  assert.equal(vm.runInContext("typeof guidedRankBottlenecks === 'function' && typeof guidedSweepSelections === 'function'", sandbox), true);
  const result = vm.runInContext(`(() => {
    const simulation = simulateColibri(readColibri());
    const insight = createBottleneckInsight(simulation);
    const ranked = guidedRankBottlenecks(insight);
    const selections = guidedSweepSelections(insight, simulation.c);
    return { ranked, selections, catalog: sweepCatalogForConfig(simulation.c).map(item => item.path) };
  })()`, sandbox);
  assert.ok(result.ranked.length <= 2);
  assert.equal(new Set(result.ranked.map(item => item.resourceId)).size, result.ranked.length);
  assert.equal(result.selections.length, result.ranked.length);
  for (const selection of result.selections) {
    assert.ok(result.catalog.includes(selection.path), selection.path);
    assert.ok(selection.values.length >= 2 && selection.values.length <= 5, JSON.stringify(selection));
    assert.equal(new Set(selection.values).size, selection.values.length);
  }
});

test('P1: guided throughput summary derives improvement only from completed counterfactual metrics', () => {
  assert.equal(vm.runInContext("typeof guidedThroughputSummary === 'function'", sandbox), true);
  const summary = vm.runInContext(`guidedThroughputSummary({
    status: 'completed',
    baselineMetrics: { status: 'completed', aggregateTPS: 100 },
    results: [
      { changes: { ssdBW: 10 }, metrics: { status: 'completed', aggregateTPS: 120 } },
      { changes: { ssdBW: 20 }, metrics: { status: 'oom', aggregateTPS: 9999 } },
      { changes: { ssdBW: 30 }, metrics: { status: 'completed', aggregateTPS: 90 } }
    ]
  })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
    measured: true,
    baselineAggregateTPS: 100,
    bestAggregateTPS: 120,
    worstAggregateTPS: 90,
    bestImprovementPct: 20,
    worstImprovementPct: -10,
    bestChanges: { ssdBW: 10 },
    completedScenarios: 2
  });
  const rejected = vm.runInContext(`({
    oomBaseline: guidedThroughputSummary({ status: 'completed', baselineMetrics: { status: 'oom', aggregateTPS: 100 }, results: [{ metrics: { status: 'completed', aggregateTPS: 120 } }] }),
    invalidBaseline: guidedThroughputSummary({ status: 'completed', baselineMetrics: { status: 'invalid', aggregateTPS: 100 }, results: [{ metrics: { status: 'completed', aggregateTPS: 120 } }] }),
    partialExecution: guidedThroughputSummary({ status: 'running', baselineMetrics: { status: 'completed', aggregateTPS: 100 }, results: [{ metrics: { status: 'completed', aggregateTPS: 120 } }] })
  })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(rejected)), {
    oomBaseline: { measured: false }, invalidBaseline: { measured: false }, partialExecution: { measured: false }
  });
});

test('P1: guided summary requires explicit OAT provenance matching the current top-two analysis', () => {
  assert.equal(vm.runInContext("typeof createGuidedSweepContract === 'function' && typeof guidedSweepMatchesAnalysis === 'function'", sandbox), true);
  const result = vm.runInContext(`(() => {
    const simulation = simulateColibri(sweepClone(APP_INTEGRITY_COLIBRI_FIXTURE));
    const insight = createBottleneckInsight(simulation);
    const selections = guidedSweepSelections(insight, simulation.c);
    const contract = createGuidedSweepContract(selections);
    const plan = buildSweepScenarios(simulation.c, 'oat', selections, SWEEP_LIMIT);
    const base = createSweepExecution(simulation.c, plan);
    base.status = 'completed';
    base.baselineMetrics = { status: 'completed', aggregateTPS: 1 };
    base.selections = sweepClone(selections);
    base.guidedContract = contract;
    base.results = base.scenarios.map(scenario => ({ changes: sweepClone(scenario.changes), metrics: { status: 'completed', aggregateTPS: 1 } }));
    const detached = sweepClone(base);
    detached.selections = [{ path: 'prompt', values: [64, 96, 128, 192, 256] }];
    detached.scenarios = buildSweepScenarios(simulation.c, 'oat', detached.selections, SWEEP_LIMIT).scenarios;
    detached.results = detached.scenarios.map(scenario => ({ changes: sweepClone(scenario.changes), metrics: { status: 'completed', aggregateTPS: 1 } }));
    return {
      valid: guidedSweepMatchesAnalysis(base, simulation, insight),
      manual: guidedSweepMatchesAnalysis({ ...base, guidedContract: null }, simulation, insight),
      grid: guidedSweepMatchesAnalysis({ ...base, definition: { mode: 'grid' } }, simulation, insight),
      wrongPath: guidedSweepMatchesAnalysis({ ...base, guidedContract: { ...contract, selections: [{ path: 'prompt', values: [1, 2] }] } }, simulation, insight),
      detached: guidedSweepMatchesAnalysis(detached, simulation, insight)
    };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { valid: true, manual: false, grid: false, wrongPath: false, detached: false });
});

test('P2: sweep worker settles and terminates exactly once on cancel, late message, and postMessage failure', async () => {
  vm.runInContext(`
    globalThis.__sweepWorkers = [];
    globalThis.__throwSweepPost = false;
    globalThis.Worker = class {
      constructor() { this.terminations = 0; __sweepWorkers.push(this); }
      terminate() { this.terminations += 1; }
      postMessage() { if (__throwSweepPost) throw new Error('post failed'); }
    };
  `, sandbox);
  const cancelled = vm.runInContext('simulateSweepInWorker(sweepClone(APP_INTEGRITY_COLIBRI_FIXTURE))', sandbox);
  const cancelledAssertion = assert.rejects(cancelled, /cancelled/);
  vm.runInContext(`const lateSweepMessage = __sweepWorkers[0].onmessage; activeSweepWorker.cancel(); lateSweepMessage({ data: { metrics: { status: 'completed' } } });`, sandbox);
  await cancelledAssertion;
  const cancelState = vm.runInContext(`({ terminations: __sweepWorkers[0].terminations, active: activeSweepWorker !== null })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(cancelState)), { terminations: 1, active: false });

  vm.runInContext('__throwSweepPost = true', sandbox);
  await assert.rejects(vm.runInContext('simulateSweepInWorker(sweepClone(APP_INTEGRITY_COLIBRI_FIXTURE))', sandbox), /post failed/);
  const throwState = vm.runInContext(`({ terminations: __sweepWorkers[1].terminations, active: activeSweepWorker !== null })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(throwState)), { terminations: 1, active: false });
  vm.runInContext('globalThis.Worker = undefined; activeSweepWorker = null', sandbox);
});

test('P2: guided sweep mode remains OAT when the live Sweep Lab mode mutates during baseline preparation', () => {
  assert.equal(vm.runInContext("typeof sweepModeForExecution === 'function'", sandbox), true);
  const result = vm.runInContext(`({
    guidedGrid: sweepModeForExecution({ schema: 'guided-oat/v1' }, 'grid'),
    guidedOat: sweepModeForExecution({ schema: 'guided-oat/v1' }, 'oat'),
    manualGrid: sweepModeForExecution(null, 'grid')
  })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { guidedGrid: 'oat', guidedOat: 'oat', manualGrid: 'grid' });
});

test('P1: guided sweep summary is invalidated when the active scenario no longer matches its baseline', () => {
  assert.equal(vm.runInContext("typeof guidedSweepMatchesResult === 'function'", sandbox), true);
  const matches = vm.runInContext(`(() => {
    const config = sweepClone(APP_INTEGRITY_COLIBRI_FIXTURE);
    const execution = { baselineConfig: sweepClone(config) };
    const changed = sweepClone(config);
    changed.ssdBW *= 2;
    return {
      same: guidedSweepMatchesResult(execution, { c: sweepClone(config) }),
      changed: guidedSweepMatchesResult(execution, { c: changed }),
      missing: guidedSweepMatchesResult(null, { c: config })
    };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(matches)), { same: true, changed: false, missing: false });
});

test('P1: synthetic HW preset changes only hardware controls and preserves workload and model inputs', () => {
  assert.equal(vm.runInContext("typeof applyGuidedHardwarePreset === 'function'", sandbox), true);
  const result = vm.runInContext(`(() => {
    const protectedIds = ['prompt', 'output', 'context', 'conc', 'layers', 'experts', 'active', 'attn'];
    const before = Object.fromEntries(protectedIds.map(id => [id, $(id).value]));
    const applied = applyGuidedHardwarePreset('synthetic-discrete-large');
    const hardware = Object.fromEntries(['arch', 'host', 'vram', 'dramBW', 'pcieBW', 'ssdBW', 'lat', 'qd'].map(id => [id, $(id).value]));
    const preserved = protectedIds.every(id => $(id).value === before[id]);
    return { applied, hardware, preserved };
  })()`, sandbox);
  assert.equal(result.applied, true);
  assert.equal(result.preserved, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.hardware)), { arch: 'discrete', host: '256', vram: '24', dramBW: '350', pcieBW: '32', ssdBW: '14', lat: '90', qd: '16' });
});

test('P1: unified HW preset preserves dormant discrete controls', () => {
  const result = vm.runInContext(`(() => {
    $('vram').value = '24'; $('pcieBW').value = '32'; $('qd').value = '16';
    const applied = applyGuidedHardwarePreset('synthetic-unified');
    return { applied, arch: $('arch').value, host: $('host').value, dramBW: $('dramBW').value, ssdBW: $('ssdBW').value, lat: $('lat').value, vram: $('vram').value, pcieBW: $('pcieBW').value, qd: $('qd').value };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { applied: true, arch: 'unified', host: '128', dramBW: '273', ssdBW: '9.2', lat: '120', vram: '24', pcieBW: '32', qd: '16' });
});

test('P2: guided navigation respects reduced-motion preference', () => {
  assert.equal(vm.runInContext("typeof guidedScrollBehavior === 'function'", sandbox), true);
  const result = vm.runInContext(`({
    reduced: guidedScrollBehavior({ matchMedia: () => ({ matches: true }) }),
    normal: guidedScrollBehavior({ matchMedia: () => ({ matches: false }) }),
    unavailable: guidedScrollBehavior(null)
  })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { reduced: 'auto', normal: 'smooth', unavailable: 'auto' });
});

test('browser App integrity test reports every scenario passing', () => {
  vm.runInContext('tests()', sandbox);
  const output = elements.get('tests').textContent;
  assert.equal(output.includes('FAIL'), false, output);
  assert.equal(output.includes('ERROR'), false, output);
  assert.match(output, /22\/22 passed$/);
});

test('P1: App integrity test is independent from edited form controls', () => {
  const previousHost = elements.get('host').value;
  elements.get('host').value = '1';
  vm.runInContext('tests()', sandbox);
  const output = elements.get('tests').textContent;
  elements.get('host').value = previousHost;
  assert.equal(output.includes('FAIL'), false, output);
  assert.equal(output.includes('ERROR'), false, output);
  assert.match(output, /22\/22 passed$/);
});

test('P1: browser App integrity test remains independent of the selected Kimi K3 topology', () => {
  const snapshot = new Map([...elements].map(([id, element]) => [id, { value: element.value, checked: element.checked }]));
  const output = vm.runInContext(`(() => {
    $('modelPreset').value = 'kimi-kimi-k3';
    applySelectedModelPreset();
    tests();
    return $('tests').textContent;
  })()`, sandbox);
  for (const [id, state] of snapshot) {
    const element = elements.get(id);
    element.value = state.value;
    element.checked = state.checked;
  }
  assert.equal(output.includes('FAIL'), false, output);
  assert.equal(output.includes('ERROR'), false, output);
  assert.match(output, /22\/22 passed$/);
});
