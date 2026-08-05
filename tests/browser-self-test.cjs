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
const tokenIOSource = fs.readFileSync(path.join(root, 'token-io.js'), 'utf8');
const shadcnSource = fs.readFileSync(path.join(root, 'ui-shadcn.css'), 'utf8');
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
  assert.match(kimi.summary, /Open weights\/config/);
  assert.match(kimi.summary, /routing topology.*automatically applied/i);
  assert.match(kimi.summary, /runtime calibration still requires measured or explicitly assumed inputs/i);
  assert.doesNotMatch(kimi.summary, /class="bad"/);
  for (const id of protectedIds) assert.equal(elements.get(id).value, before[id], id);
  for (const id of ['layers', 'experts', 'active']) elements.get(id).value = before[id];
});

test('P1: hardware presets use named product targets and only overwrite sourced fields', () => {
  const inventory = vm.runInContext(`Object.fromEntries(Object.entries(GUIDED_HW_PRESETS).map(([id, preset]) => [id, {
    label: preset.label,
    sourceUrls: preset.sourceUrls || [preset.sourceUrl],
    values: preset.values,
    manual: preset.manual
  }]))`, sandbox);
  assert.deepEqual(Object.keys(inventory), [
    'nvidia-dgx-spark-128',
    'apple-macbook-pro-m5-max-128',
    'apple-mac-studio-m3-ultra-512',
    'nvidia-rtx-5090-32',
    'amd-radeon-pro-w7900-48'
  ]);
  assert.ok(Object.values(inventory).every(preset => !/synthetic/i.test(preset.label)));
  assert.ok(Object.values(inventory).every(preset => preset.sourceUrls.every(url => /^https:\/\//.test(url))));
  assert.deepEqual(JSON.parse(JSON.stringify(inventory['apple-mac-studio-m3-ultra-512'].sourceUrls)), [
    'https://www.apple.com/newsroom/2025/03/apple-reveals-m3-ultra-taking-apple-silicon-to-a-new-extreme/',
    'https://support.apple.com/en-us/122211'
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(inventory['nvidia-dgx-spark-128'].values)), { arch: 'unified', host: 128, dramBW: 273 });
  assert.deepEqual(JSON.parse(JSON.stringify(inventory['apple-macbook-pro-m5-max-128'].values)), { arch: 'unified', host: 128, dramBW: 614 });
  assert.deepEqual(JSON.parse(JSON.stringify(inventory['apple-mac-studio-m3-ultra-512'].values)), { arch: 'unified', host: 512, dramBW: 819 });
  assert.deepEqual(JSON.parse(JSON.stringify(inventory['nvidia-rtx-5090-32'].values)), { arch: 'discrete', vram: 32 });
  assert.deepEqual(JSON.parse(JSON.stringify(inventory['amd-radeon-pro-w7900-48'].values)), { arch: 'discrete', vram: 48 });

  const state = vm.runInContext(`(() => {
    $('host').value = '192'; $('dramBW').value = '333'; $('pcieBW').value = '21'; $('ssdBW').value = '7.7'; $('lat').value = '88'; $('qd').value = '11';
    const applied = applyGuidedHardwarePreset('nvidia-rtx-5090-32');
    return { applied, arch: $('arch').value, host: $('host').value, vram: $('vram').value, dramBW: $('dramBW').value, pcieBW: $('pcieBW').value, ssdBW: $('ssdBW').value, lat: $('lat').value, qd: $('qd').value, summary: $('hardwarePresetSummary').innerHTML };
  })()`, sandbox);
  assert.equal(state.applied, true);
  assert.deepEqual([state.arch, state.vram], ['discrete', '32']);
  assert.deepEqual([state.host, state.dramBW, state.pcieBW, state.ssdBW, state.lat, state.qd], ['192', '333', '21', '7.7', '88', '11']);
  assert.match(state.summary, /NVIDIA GeForce RTX 5090/);
  assert.match(state.summary, /32 GB VRAM/);
  assert.match(state.summary, /현재 입력을 유지합니다/);
  const mac = vm.runInContext(`(() => ({ applied: applyGuidedHardwarePreset('apple-mac-studio-m3-ultra-512'), summary: $('hardwarePresetSummary').innerHTML }))()`, sandbox);
  assert.equal(mac.applied, true);
  assert.match(mac.summary, /512 GB memory source/);
  assert.match(mac.summary, /819 GB\/s bandwidth source/);
  assert.match(mac.summary, /apple\.com\/newsroom/);
  assert.match(mac.summary, /support\.apple\.com/);
  assert.equal(vm.runInContext("applyGuidedHardwarePreset('__proto__')", sandbox), false);
  const malicious = vm.runInContext(`(() => {
    renderGuidedHardwarePresetSummary({ label: '<img src=x onerror=1>', sourced: '<script>1<\\/script>', manual: '<svg onload=1>', sourceUrls: ['javascript:alert(1)'] });
    return $('hardwarePresetSummary').innerHTML;
  })()`, sandbox);
  assert.doesNotMatch(malicious, /<img|<script|<svg|href=/i);
  assert.match(malicious, /출처를 사용할 수 없음/);
  const custom = vm.runInContext(`(() => ({ applied: applyGuidedHardwarePreset('custom'), summary: $('hardwarePresetSummary').innerHTML }))()`, sandbox);
  assert.equal(custom.applied, true);
  assert.match(custom.summary, /사용자 지정 하드웨어 입력/);
});

test('P1: hardware preset picker exposes named targets rather than synthetic templates', () => {
  assert.match(html, /NVIDIA DGX Spark · 128 GB/);
  assert.match(html, /MacBook Pro · M5 Max · 128 GB/);
  assert.match(html, /Mac Studio · M3 Ultra · 512 GB/);
  assert.match(html, /NVIDIA GeForce RTX 5090 · 32 GB/);
  assert.match(html, /AMD Radeon PRO W7900 · 48 GB/);
  assert.doesNotMatch(html, /<option[^>]*>Synthetic ·/);
  assert.match(html, /id="hardwarePresetSummary"[^>]*role="status"/);
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
  assert.match(state.summary, /사용자 지정 \/ 수동 토폴로지/);
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
  assert.match(state.summary, /사용자 지정 \/ 수동 토폴로지/);
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
  vm.runInContext("render({ error: 'Invalid configuration: prompt: prompt must be between 0 and 1000000.', validationErrors: [] })", sandbox);
  for (const id of ['ttft', 'tpot', 'tps', 'ssdpt', 'hit', 'mem']) assert.equal(elements.get(id).textContent, '—');
  for (const id of ['summary', 'pressureSummary', 'memory', 'modelStatus']) assert.equal(elements.get(id).innerHTML, '');
  assert.equal(elements.get('warn').textContent, '구성 오류: prompt 값은 0~1000000 범위여야 합니다.');
});

test('P1: Storage I/O copy distinguishes per-token average from cumulative populations', () => {
  const result = vm.runInContext(`(() => {
    const simulation = simulateColibri(readColibri());
    renderColibri(simulation);
    return {
      label: $('storageLabel').textContent,
      summary: $('summary').innerHTML,
      outputTokens: simulation.tokens.length,
      perToken: simulation.ssdPt,
      decodeTotal: simulation.decodeStorageGB,
      startupTotal: simulation.startupStorageGB,
      tokenTotal: simulation.tokens.reduce((sum, token) => sum + token.ssdGB + token.swapInGB + token.swapOutGB, 0)
    };
  })()`, sandbox);

  assert.equal(result.label, '디코드 토큰당 평균 Storage I/O');
  assert.equal(result.outputTokens, 64);
  assert.match(moduleSource, /\$\('ssdpt'\)\.textContent = [^;]*fmt\(r\.ssdPt, 2\)[^;]*GB/);
  assert.ok(Math.abs(result.decodeTotal - result.perToken * result.outputTokens) < 1e-9);
  assert.ok(Math.abs(result.tokenTotal - result.decodeTotal) < 1e-9);
  assert.match(result.summary, /디코드 누적 Storage I\/O/);
  assert.match(result.summary, /시작·프리필 Storage I\/O/);
  assert.match(result.summary, /실행 전체 누적 Storage I\/O/);
  assert.match(result.summary, new RegExp(`${(result.startupTotal + result.decodeTotal).toFixed(2)} GB`));
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
  assert.equal(state.status, '유효하지 않은 결과');
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

test('P1: normalized V5 export is schema-fenced while replay preserves its deterministic Run ID', () => {
  const snapshot = new Map([...elements].map(([id, element]) => [id, { value: element.value, checked: element.checked }]));
  const placement = elements.get('placement');
  placement.value = 'auto';
  elements.get('conc').value = '2';
  const ids = vm.runInContext(`(() => {
    const first = simulate();
    const artifact = createScenarioArtifact(first.c, first);
    const replay = parseScenarioArtifactReplay(JSON.stringify(artifact));
    applyScenarioConfig(artifact.config);
    const second = simulate();
    return [first.runId, artifact.runId, replay.replayResult.runId, second.runId, bottleneckInsightsMatch(artifact.insight, createBottleneckInsight(second))];
  })()`, sandbox);
  for (const [id, state] of snapshot) {
    const element = elements.get(id);
    element.value = state.value;
    element.checked = state.checked;
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.equal(ids[0], ids[3]);
  assert.equal(ids[4], true);
});

test('P1: sticky action toolbar and Storage I/O workspace expose the approved controls', () => {
  const toolbarIndex = html.indexOf('id="actionToolbar"');
  const gridIndex = html.indexOf('<div class="grid">');
  assert.ok(toolbarIndex >= 0 && toolbarIndex < gridIndex, `${toolbarIndex}/${gridIndex}`);
  assert.match(html, /class="[^"]*actionToolbar[^"]*"/);
  for (const id of ['run', 'pause', 'openSweep', 'test', 'exportScenario', 'importScenario', 'setBaseline']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, />앱 무결성 테스트</);
  for (const id of ['graphViewMode', 'storageXAxis', 'storageYAxis', 'storageChart', 'storageTraceSummary']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<option value="tabs"/);
  assert.match(html, /<option value="stacked"/);
  assert.match(html, /<option value="overlay"/);
  assert.match(html, /<script src="storage-io\.js"><\/script>[\s\S]*<script src="render\.js"><\/script>/);
});

test('P1: every canvas graph exposes labeled Cartesian axes and a value at every major tick', () => {
  assert.equal(vm.runInContext("typeof drawCartesianAxes === 'function' && typeof chartAxisSpec === 'function' && typeof chartSeriesPosition === 'function' && typeof chartUsesAxes === 'function' && typeof drawChartPoint === 'function'", sandbox), true);
  const labels = vm.runInContext(`(() => {
    const drawn = [];
    const context = {
      fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {}, translate() {}, rotate() {},
      fillText(value) { drawn.push(String(value)); }
    };
    drawCartesianAxes(context, {
      left: 56, top: 24, width: 600, height: 160,
      xTicks: [{ position: 0, label: '0' }, { position: 0.5, label: '5' }, { position: 1, label: '10' }],
      yTicks: [{ position: 0, label: '100' }, { position: 0.5, label: '50' }, { position: 1, label: '0' }],
      xLabel: 'Token index', yLabel: 'TPOT (ms)'
    });
    return drawn;
  })()`, sandbox);
  for (const label of ['0', '5', '10', '100', '50', 'Token index', 'TPOT (ms)']) assert.ok(labels.includes(label), label);
  const marker = vm.runInContext(`(() => {
    const calls = [];
    drawChartPoint({ beginPath() { calls.push('begin'); }, arc(...args) { calls.push(['arc', ...args]); }, fill() { calls.push('fill'); }, fillStyle: '' }, 12, 34, '#123456');
    return calls;
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(marker)), ['begin', ['arc', 12, 34, 3, 0, Math.PI * 2], 'fill']);

  const specs = vm.runInContext(`({
    performance: chartAxisSpec('performance'),
    memory: chartAxisSpec('memory'),
    storageTime: chartAxisSpec('storage', { xMode: 'completion-time', yMode: 'service-ms' }),
    storageIO: chartAxisSpec('storage', { xMode: 'cumulative-io', yMode: 'gbps' }),
    sweepTTFT: chartAxisSpec('sweep-ttft'),
    sweepTPS: chartAxisSpec('sweep-tps'),
    overlay: chartAxisSpec('overlay')
  })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(specs)), {
    performance: { xLabel: '토큰 인덱스', yLabel: 'TPOT (ms)' },
    memory: { xLabel: '토큰 인덱스', yLabel: '메모리 (GB)' },
    storageTime: { xLabel: '완료 시간 (ms)', yLabel: '스토리지 서비스 시간 (ms)' },
    storageIO: { xLabel: '누적 I/O (GB)', yLabel: '유효 대역폭 (GB/s)' },
    sweepTTFT: { xLabel: '스윕 실행 (0 = 기준)', yLabel: 'TTFT (ms)' },
    sweepTPS: { xLabel: '스윕 실행 (0 = 기준)', yLabel: '처리량 (토큰/s)' },
    overlay: { xLabel: '실행 인덱스 (0 = 프리필)', yLabel: '정규화 값 (%)' }
  });
  const edgeCases = vm.runInContext(`({
    onePoint: chartSeriesPosition(0, 1),
    firstOfTwo: chartSeriesPosition(0, 2),
    lastOfTwo: chartSeriesPosition(1, 2),
    tinyLabels: chartLinearTicks(0, EPS, 5, true).map(tick => tick.label),
    overlayAxes: ['performance', 'storage', 'memory'].map(kind => chartUsesAxes(kind, 'overlay'))
  })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(edgeCases)), {
    onePoint: 0.5,
    firstOfTwo: 0,
    lastOfTwo: 1,
    tinyLabels: ['1.0e-12', '7.5e-13', '5.0e-13', '2.5e-13', '0'],
    overlayAxes: [true, false, false]
  });
  const renderSource = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  assert.match(renderSource, /storageIOXPositions\(buckets, plotLeft, plotWidth\)/);
  assert.doesNotMatch(renderSource, /storageIOXPositions\(buckets, plotLeft \+ barWidth \/ 2/);
  assert.match(renderSource, /if \(!overlay\) x\.fillText\('IFP'/);
  assert.match(html, /\.graphPanels\.overlay #storageTraceBoundary[^}]*display:none/);
  for (const functionName of ['drawPerformance', 'renderStorageIO', 'drawMemory', 'drawSweepMetricChart']) {
    const source = functionName === 'drawSweepMetricChart' ? fs.readFileSync(path.join(root, 'sweep-ui.js'), 'utf8') : fs.readFileSync(path.join(root, 'render.js'), 'utf8');
    const start = source.indexOf(`function ${functionName}`);
    const next = source.indexOf('\nfunction ', start + 10);
    const block = source.slice(start, next < 0 ? undefined : next);
    assert.match(block, /drawCartesianAxes\(/, functionName);
    if (functionName !== 'renderStorageIO') {
      assert.match(block, /chartSeriesPosition\(/, functionName);
      assert.match(block, /drawChartPoint\(/, functionName);
    }
  }
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
  assert.match(output, /Expert \/ 윈도 읽기/);
  assert.match(output, /프리페치 읽기/);
  assert.match(output, /스왑 인 읽기/);
  assert.match(output, /스왑 아웃 쓰기/);
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

test('P1: help icons keep a centered visual circle inside responsive hit targets', () => {
  const hitTarget = html.match(/\.helpTip\{([^}]*)\}/)?.[1] || '';
  const glyph = html.match(/\.helpTip::before\{([^}]*)\}/)?.[1] || '';
  assert.match(hitTarget, /position:relative/);
  assert.match(hitTarget, /display:inline-(?:flex|grid)/);
  assert.match(hitTarget, /width:28px/);
  assert.match(hitTarget, /height:28px/);
  assert.match(hitTarget, /padding:0/);
  assert.match(hitTarget, /border:0/);
  assert.match(hitTarget, /background:transparent/);
  assert.match(hitTarget, /font-size:11px/);
  assert.match(hitTarget, /line-height:1/);
  assert.match(glyph, /content:""/);
  assert.match(glyph, /position:absolute/);
  assert.match(glyph, /transform:translate\(-50%,-50%\)/);
  assert.match(glyph, /width:20px/);
  assert.match(glyph, /height:20px/);
  assert.match(glyph, /background:transparent/);
  assert.match(html, /@media\(max-width:720px\)[\s\S]*\.helpTip\{width:44px;height:44px/);
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
    clearRect() {}, fillRect() {}, beginPath() {}, save() {}, restore() {}, translate() {}, rotate() {}, moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); }, arc() {}, stroke() {}, fill() {}, fillText() {},
    set fillStyle(value) {}, set strokeStyle(value) {}, set lineWidth(value) {}, set font(value) {}, set textAlign(value) {}, set textBaseline(value) {}
  };
  elements.set('gapChart', { width: 200, height: 100, getContext: () => context });
  elements.set('sweepResults', { innerHTML: '' });
  const table = vm.runInContext(`(() => {
    const rows = [
      { index: 0, changes: { host: 1 }, metrics: { status: 'completed', oom: false, reason: '', ttftMeanMs: 10, ttftP50Ms: 10, ttftP95Ms: 10, singleTPS: 1, aggregateTPS: 1 } },
      { index: 1, changes: { host: 0.5 }, metrics: { status: 'oom', oom: true, reason: 'OOM', ttftMeanMs: 20, ttftP50Ms: 20, ttftP95Ms: 20, singleTPS: 2, aggregateTPS: 2 } },
      { index: 2, changes: { host: 2 }, metrics: { status: 'completed', oom: false, reason: '', ttftMeanMs: 30, ttftP50Ms: 30, ttftP95Ms: 30, singleTPS: 3, aggregateTPS: 3 } }
    ];
    drawSweepMetricChart('gapChart', rows, ['ttftMeanMs'], ['#fff'], 'gap', 'sweep-ttft');
    renderSweepTable({ baselineMetrics: rows[0].metrics, results: rows.slice(1) });
    return $('sweepResults').innerHTML;
  })()`, sandbox);
  assert.equal(calls.filter(call => call[0] === 'lineTo').length, 10, JSON.stringify(calls));
  assert.match(table, /<td>메모리 부족\(OOM\)<\/td><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
});

test('P1: Sweep Lab exposes parameter selection, OAT/Grid execution controls, charts, table, and CSV', () => {
  for (const id of ['sweepLab', 'sweepMode', 'parameterSearch', 'parameterCategory', 'parameterChecklist', 'selectAllSweep', 'clearSweep', 'sweepSelectedCount', 'sweepProjectedCount', 'sweepParameters', 'runSweep', 'pauseSweep', 'resumeSweep', 'cancelSweep', 'exportSweepCsv', 'sweepProgress', 'sweepTruncation', 'sweepTTFTChart', 'sweepTPSChart', 'sweepResults']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /한 번에 하나\(OAT\)/);
  assert.match(html, /격자 조합/);
  assert.match(html, /TTFT 평균 \/ p50 \/ p95/);
  assert.match(html, /단일 시퀀스 TPS \/ 전체 TPS/);
  assert.match(html, /추정 민감도 시뮬레이터 \/ 미검증 알파/);
  assert.ok(html.indexOf('<div class="sweepActions">') < html.indexOf('<div class="sweepSetup">'), 'mobile execution controls must precede the long setup form');
  assert.match(html, /\.sweepActions\{position:sticky;top:0/);
  assert.match(html, /<script src="sweep\.js"><\/script>/);
  assert.equal(vm.runInContext("typeof initializeSweepLab === 'function' && typeof renderSweepResults === 'function' && typeof exportSweepCsv === 'function'", sandbox), true);
});

test('P1: Sweep parameters expose human labels, units, meaning, and coupling guidance', () => {
  assert.equal(vm.runInContext("typeof sweepParameterGuide === 'function'", sandbox), true);
  const guides = vm.runInContext(`[...sweepCatalogForConfig({ ...readColibri(), arch: 'discrete', placement: 'manual' }), ...sweepCatalogForConfig(readAFM())].map(item => sweepParameterGuide(item))`, sandbox);
  for (const guide of guides) {
    assert.ok(guide.label && guide.unit && guide.description && guide.relationship && guide.behavior, JSON.stringify(guide));
  }
  const important = vm.runInContext(`(() => { const config = { ...readColibri(), arch: 'discrete' }; const catalog = sweepCatalogForConfig(config); return { host: sweepParameterGuide(catalog.find(item => item.path === 'host'), config), dram: sweepParameterGuide(catalog.find(item => item.path === 'dramBW'), config), pcie: sweepParameterGuide(catalog.find(item => item.path === 'pcieBW'), config), ssd: sweepParameterGuide(catalog.find(item => item.path === 'ssdBW'), config) }; })()`, sandbox);
  assert.match(important.host.label, /Host \/ 통합 메모리 용량/);
  assert.equal(important.host.unit, 'GB');
  assert.match(important.pcie.description, /host.*GPU/i);
  assert.match(important.ssd.description, /스토리지|SSD/i);
  assert.match(important.dram.behavior, /병목|임계/);
});

test('P1: Sweep explains the canonical baseline and no-effect DRAM results', () => {
  for (const id of ['sweepBaselineSummary', 'sweepInterpretation']) assert.match(html, new RegExp(`id="${id}"`));
  assert.equal(vm.runInContext("typeof sweepBaselineSummaryHtml === 'function' && typeof sweepSensitivityInsight === 'function'", sandbox), true);
  const result = vm.runInContext(`(() => {
    const config = readColibri();
    const values = [config.dramBW * 0.5, config.dramBW, config.dramBW * 2];
    const baselineSimulation = runSimulationConfig(config);
    const execution = {
      baselineConfig: config,
      baselineMetrics: summarizeSweepResult(baselineSimulation),
      selections: [{ path: 'dramBW', values }],
      results: values.filter(value => value !== config.dramBW).map((value, index) => ({ index, changes: { dramBW: value }, metrics: summarizeSweepResult(runSimulationConfig({ ...config, dramBW: value })) }))
    };
    return { baseline: sweepBaselineSummaryHtml(config, 'Current form → canonical Worker baseline'), insight: sweepSensitivityInsight(execution) };
  })()`, sandbox);
  assert.match(result.baseline, /Current form/);
  for (const value of ['Host 메모리', 'DRAM 대역폭', 'SSD 대역폭', 'PCIe 대역폭']) assert.match(result.baseline, new RegExp(value));
  assert.match(result.insight, /DRAM 대역폭/);
  assert.match(result.insight, /측정 가능한 차이가 없습니다/);
  assert.match(result.insight, /병목이 아닙니다/);
});

test('P1: successful render exposes an equivalent token trace table for non-canvas access', () => {
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__traceResult = result;
  vm.runInContext('renderTraceTable(__traceResult)', sandbox);
  delete sandbox.__traceResult;
  const trace = elements.get('traceSummary').innerHTML;
  assert.match(trace, /토큰 1/);
  assert.match(trace, /TPOT/);
  assert.match(trace, /NORMAL|RECLAIM|COMPRESS|SWAP|THRASH|OOM/);
  assert.doesNotMatch(trace, /undefined/);
});

test('P1: model status labels results as uncalibrated sensitivity estimates', () => {
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__statusResult = result;
  vm.runInContext('renderColibri(__statusResult)', sandbox);
  assert.match(elements.get('modelStatus').innerHTML, /아직 보정되지 않은 민감도 추정값/);
});

test('P1: Bottleneck Advisor exposes Korean-first phase scorecards', () => {
  const kpiIndex = html.indexOf('<div class="kpis">');
  const advisorIndex = html.indexOf('<section id="advisor"');
  const tokenIndex = html.indexOf('<div id="token"');
  assert.ok(kpiIndex >= 0 && advisorIndex >= 0 && tokenIndex >= 0, `${kpiIndex}/${advisorIndex}/${tokenIndex}`);
  assert.match(html, /추정 민감도 · 미검증 알파/);
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__advisorResult = result;
  vm.runInContext('renderBottleneckAdvisor(createBottleneckInsight(__advisorResult))', sandbox);
  delete sandbox.__advisorResult;
  const output = elements.get('advisor').innerHTML;
  for (const label of ['프리필 (Prefill)', '첫 토큰 (First token)', '디코드 (Decode)', '메모리 압력 (Memory pressure)']) assert.match(output, new RegExp(label.replace(/[()]/g, '\\$&')));
  for (const label of ['스토리지 (Storage)', '데이터 이동 (Data movement)', '연산 (Compute)', '용량 / 정책 (Capacity / policy)']) assert.match(output, new RegExp(label.replace(/[()]/g, '\\$&')));
  assert.match(output, /상대 압력/);
  assert.match(output, /class="resourceScore score score(?:High|Medium)?" style="--score:\d+(?:\.\d+)?"/);
  assert.match(output, /<details class="advisorDetails" open><summary>단계별 병목 상세<\/summary>/);
  assert.match(output, /적용 조건:/);
  assert.match(output, /부작용:/);
  assert.match(output, /실측 하드웨어 진단이 아닙니다/);
  assert.doesNotMatch(output, /Storage service demand or modeled queue delay|Higher queue depth can add contention/);
});

test('P1: invalid render replaces stale advisor scores with an unavailable reason', () => {
  elements.get('advisor').innerHTML = '<b>stale score 100</b>';
  vm.runInContext("render({ error: 'Invalid configuration: prompt is required' })", sandbox);
  const output = elements.get('advisor').innerHTML;
  assert.doesNotMatch(output, /stale score/);
  assert.match(output, /사용할 수 없습니다/);
  assert.match(output, /구성 검증 실패/);
});

test('P1: pre-decode OOM render provides capacity recovery without fabricated timing scores', () => {
  vm.runInContext("render({ error: 'Unified memory OOM before decode: 140 / 128 GB', mode: 'afm3', c: { host: 128, vram: 0 } })", sandbox);
  const output = elements.get('advisor').innerHTML;
  assert.match(output, /디코드 전 OOM/);
  assert.match(output, /용량 \/ 정책/);
  assert.match(output, /host|context|concurrency/i);
  assert.doesNotMatch(output, /<h3>프리필|<h3>디코드/);
});

test('P1: swap UI distinguishes allocated or in-flight bytes from completed residency', () => {
  const result = vm.runInContext('simulateColibri(readColibri())', sandbox);
  sandbox.__swapResult = result;
  vm.runInContext('renderColibri(__swapResult); renderTraceTable(__swapResult)', sandbox);
  delete sandbox.__swapResult;
  assert.match(elements.get('memory').innerHTML, /스왑 할당 \/ 처리 중/);
  assert.match(elements.get('traceSummary').innerHTML, /스왑 할당 \/ 처리 중/);
  assert.doesNotMatch(elements.get('memory').innerHTML, /스왑 상주/);
});

test('P1: mobile controls meet 44px targets, avoid sticky overlap, and respect reduced motion', () => {
  assert.match(html, /\.f input,\.f select\{min-height:44px\}/);
  assert.match(html, /\.guidedHardware select\{min-height:44px\}/);
  assert.match(html, /\.helpTip\{width:44px;height:44px/);
  assert.match(html, /details>summary\{min-height:44px/);
  assert.match(shadcnSource, /\.toolbarOverflow > summary\s*\{[^}]*min-height:\s*44px/);
  assert.match(shadcnSource, /\.tokenIOCheck input\s*\{\s*width:\s*44px;\s*height:\s*44px/);
  assert.match(html, /\.parameterChoice input\{width:44px;height:44px/);
  assert.match(html, /\.f:has\(#mode\)\{grid-template-columns:1fr\}/);
  assert.match(html, /\.f:has\(#mode\) #mode\{grid-column:1\/-1\}/);
  assert.ok(html.indexOf('.f:has(#mode){grid-template-columns:1fr}') < html.indexOf('@media(max-width:720px)'), 'engine selector must use the full field width on desktop too');
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /\.cursor\s*\{[^}]*animation:\s*none/);
  assert.match(html, /\.buttons:has\(#run\)\{position:static/);
});

test('P1: design polish prioritizes mobile results and progressively discloses dense controls', () => {
  assert.match(html, /<section id="resultVisuals" class="panel resultVisuals" hidden><div id="resultInsight" class="resultInsight" role="status" aria-live="polite"><\/div><details id="graphFilterDisclosure" class="graphFilterDisclosure" open><summary>그래프 보기 설정<\/summary><div class="graphControls">/);
  assert.match(html, /<details id="parameterCatalog" class="parameterCatalog" open>/);
  assert.match(html, /<summary>매개변수 목록 <span class="note">검색·범주로 좁혀보세요<\/span><\/summary>/);
  assert.match(moduleSource, /catalog\.open = !\(typeof matchMedia === 'function' && matchMedia\('\(max-width: 720px\)'\)\.matches\)/);
  assert.match(moduleSource, /if \(\$\('parameterSearch'\)\.value\.trim\(\)\) \$\('parameterCatalog'\)\.open = true/);
  assert.match(shadcnSource, /\.guideStep small \{ display: none; \}/);
  assert.match(shadcnSource, /\.resultHero \{ display: contents; \}/);
  assert.match(uiSource, /function initializeResponsiveGraphFilters\(/);
  assert.match(testsInitFull, /initializeResponsiveGraphFilters\(\)/);
  assert.match(shadcnSource, /\.graphPanel \.copyToolbar \{[^}]*order: 4;/);
  assert.match(shadcnSource, /\.copyToolbar \.copyAction \{ color: #f8fafc; \}/);
  assert.match(shadcnSource, /\.actionToolbar \{\s*position: static;/);
  assert.match(shadcnSource, /\.sweepParameters \{ order: 0; \}/);
  assert.match(shadcnSource, /\.parameterPicker \{ order: 1; \}/);
  assert.match(shadcnSource, /\.graphPanel > h3 \{ margin: 4px 0 10px; \}/);
  assert.match(shadcnSource, /\.appHeader h1 small \{[^}]*white-space: nowrap/);
  assert.match(moduleSource, /class="sweepEmptyGuide"/);
  assert.match(shadcnSource, /\.advisorGrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(shadcnSource, /\.toolbarGroup:first-child \.primaryAction \{ grid-column: 1 \/ -1; \}/);
  assert.match(shadcnSource, /\.parameterRelation \{ display: none; \}/);
  assert.match(shadcnSource, /:root\[data-theme="light"\] \.kpi:nth-child\(3\)[^}]*box-shadow:/);
  assert.match(html, /<button id="runSweep" disabled>스윕 실행<\/button>/);
  assert.match(html, /<div id="sweepOutput" class="sweepOutput" hidden>/);
  assert.match(moduleSource, /\$\('runSweep'\)\.disabled = !sweepSelectedPaths\.size/);
  assert.match(moduleSource, /\$\('sweepOutput'\)\.hidden = false/);
  assert.match(shadcnSource, /\.kpi b \{[^}]*white-space: nowrap/);
  assert.match(fs.readFileSync(path.join(root, 'render.js'), 'utf8'), /context\.font = '11px sans-serif'/);
});

test('P0: shared SSD queue wait is labeled as the accumulated job-wait population', () => {
  const renderSource = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  assert.equal((renderSource.match(/공유 SSD 누적 큐 대기 \(작업 합계\)/g) || []).length, 2);
  assert.equal((renderSource.match(/\['공유 SSD 큐 대기'/g) || []).length, 0);
});

test('P1: result sections follow KPI, simulation, Storage I/O, insight, graph, advisor, validation, summary order', () => {
  assert.match(tokenIOSource, /const orderedSections = \[panel, resultVisuals, advisor\]\.filter\(Boolean\)/);
  assert.match(tokenIOSource, /const currentTail = Array\.from\(resultHero\.children\)\.slice\(-orderedSections\.length\)/);
  assert.match(tokenIOSource, /if \(orderedSections\.every\(\(section, index\) => currentTail\[index\] === section\)\) return/);
  assert.match(shadcnSource, /\.resultHero \{ display: contents; \}/);
});

test('P1: desktop web design makes the next action and decisive insight visually explicit', () => {
  const renderSource = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  assert.match(html, /<div class="sweepWorkflowBar">/);
  assert.match(html, /id="sweepActionHint"/);
  assert.match(moduleSource, /\$\('sweepActionHint'\)\.textContent = sweepSelectedPaths\.size/);
  assert.match(html, /<section id="resultVisuals" class="panel resultVisuals" hidden>/);
  assert.match(html, /id="resultInsight" class="resultInsight"/);
  assert.match(renderSource, /\$\('resultVisuals'\)\.hidden = false/);
  assert.match(renderSource, /document\.body\?\.classList\.add\('hasResults'\)/);
  assert.match(renderSource, /document\.body\?\.classList\.remove\('hasResults'\)/);
  assert.match(renderSource, /class="advisorScoreLegend"/);
  assert.match(shadcnSource, /@media \(min-width: 721px\)[\s\S]*\.hasResults \.resultHero \{ display: contents; \}/);
  assert.match(shadcnSource, /\.sweepSetup \{ align-items: start; \}/);
  assert.match(shadcnSource, /\.sweepEmptyGuide \{[\s\S]*min-height: 150px;/);
  assert.match(shadcnSource, /\.advisorScoreLegend/);
  assert.match(shadcnSource, /\.resultInsight/);
  assert.match(shadcnSource, /\.copyToolbar \.copyAction \{[\s\S]*background: hsl\(var\(--secondary\)\)/);
  assert.match(shadcnSource, /\.note \{ font-size: 12px; line-height: 1\.6; \}/);
});

test('P2: final desktop polish keeps the disabled Sweep CTA visible and annotates chart evidence', () => {
  const renderSource = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  assert.match(shadcnSource, /\.sweepActions button:not\(#runSweep\):disabled \{ display: none; \}/);
  assert.match(shadcnSource, /\.sweepActions #runSweep \{[^}]*display: inline-flex;[^}]*min-width: 160px;/);
  assert.match(shadcnSource, /@media \(min-width: 1001px\)[\s\S]*\.parameterChecklist \{ max-height: none; overflow: visible; \}/);
  assert.match(shadcnSource, /\.sweepBaselineSummary dt \{ font-size: 10px;/);
  assert.match(shadcnSource, /\.sweepBaselineSummary dd \{[^}]*font-size: 12px;/);
  assert.match(renderSource, /function advisorScoreBand\(score\)/);
  assert.match(renderSource, /scoreBand\.glyph/);
  assert.match(renderSource, /scoreBand\.label/);
  assert.match(renderSource, /const peakTpotEntry =/);
  assert.match(renderSource, /class="trendFacts"/);
  assert.match(renderSource, /스왑 시작 없음/);
  assert.match(shadcnSource, /\.trendFacts/);
});

test('P1: Light and Dark theme toggle applies, persists, and exposes its next action', () => {
  assert.match(html, /id="themeToggle"[^>]*aria-pressed="false"/);
  assert.equal(vm.runInContext("typeof applyTheme === 'function' && typeof initializeTheme === 'function'", sandbox), true);
  const state = vm.runInContext(`(() => {
    const attrs = {};
    const root = { setAttribute(name, value) { attrs[name] = String(value); } };
    const button = { textContent: '', onclick: null, setAttribute(name, value) { attrs['button:' + name] = String(value); } };
    const values = new Map([['moe-ssd-theme', 'light']]);
    const storage = { getItem(key) { return values.get(key) || null; }, setItem(key, value) { values.set(key, value); } };
    const initial = initializeTheme({ root, button, storage, media: { matches: false }, redraw: false });
    const beforeToggle = { theme: attrs['data-theme'], text: button.textContent, label: attrs['button:aria-label'], pressed: attrs['button:aria-pressed'], stored: values.get('moe-ssd-theme') };
    button.onclick();
    const afterToggle = { theme: attrs['data-theme'], text: button.textContent, label: attrs['button:aria-label'], pressed: attrs['button:aria-pressed'], stored: values.get('moe-ssd-theme') };
    return { initial, beforeToggle, afterToggle };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    initial: 'light',
    beforeToggle: { theme: 'light', text: '어둡게', label: '어두운 테마로 전환', pressed: 'true', stored: 'light' },
    afterToggle: { theme: 'dark', text: '밝게', label: '밝은 테마로 전환', pressed: 'false', stored: 'dark' }
  });
  const storageFailures = vm.runInContext(`(() => {
    const root = { setAttribute() {} };
    const button = { setAttribute() {}, textContent: '', onclick: null };
    const read = initializeTheme({ root, button, storage: { getItem() { throw new Error('read denied'); } }, media: { matches: false }, redraw: false });
    const write = applyTheme('light', { root, button, storage: { setItem() { throw new Error('write denied'); } }, redraw: false });
    return { read, write };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(storageFailures)), { read: 'dark', write: 'light' });
  assert.match(html, /:root\[data-theme="light"\]/);
  assert.match(testsInitFull, /initializeTheme\(\)/);
  assert.match(html, /:root\[data-theme="light"\][^}]*\.resourceInsight summary/);
  assert.match(html, /:root\[data-theme="light"\][^}]*\.guidedBottleneck p/);
  const lightTheme = html.match(/:root\[data-theme="light"\]\{([^}]*)\}/)?.[1] || '';
  const cssColor = name => lightTheme.match(new RegExp(`${name}:(#[0-9a-fA-F]{6})`))?.[1];
  const luminance = color => {
    const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = color => (1.05) / (luminance(color) + 0.05);
  for (const series of ['--chart-cyan', '--chart-green', '--chart-violet', '--chart-red', '--chart-yellow']) assert.ok(contrast(cssColor(series)) >= 3, series);
  for (const series of ['cyan', 'green', 'violet', 'red']) assert.match(html, new RegExp(`background:var\\(--chart-${series}\\)`));
  const renderThemeSource = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  for (const series of ['cyan', 'green', 'violet', 'red']) assert.match(renderThemeSource, new RegExp(`palette\\.${series}`));
  for (const variable of ['--b', '--p', '--p2', '--l', '--t', '--m', '--chart-bg', '--chart-grid', '--chart-text', '--chart-cyan', '--chart-green', '--chart-violet', '--chart-red', '--chart-yellow']) assert.match(html, new RegExp(variable.replace('--', '--')));
});

test('P1: initial guided state does not render results before the first explicit run', () => {
  assert.match(testsInitFull, /function syncMode\(applyPreset = false, renderResult = true\)/);
  assert.match(testsInitFull, /if \(renderResult\) \{ const r = simulate\(\); render\(r\); \}/);
  assert.match(testsInitFull, /syncMode\(false, false\)/);
  for (const id of ['ttft', 'tpot', 'tps', 'ssdpt', 'hit', 'mem']) assert.match(html, new RegExp(`id="${id}">—<`));
  assert.match(html, /id="status" class="status">대기 중</);
});

test('P1: guided workflow exposes three Korean steps, HW preset, Expert mode, and measured analysis landmarks', () => {
  for (const id of ['guidedWorkflow', 'expertModeToggle', 'hardwarePreset', 'guidedAnalysis', 'runGuidedSweep']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const step of ['시나리오 설정', '결과와 병목', '개선 검증']) assert.match(html, new RegExp(step));
  assert.match(html, /id="runGuidedSweep"[^>]*>상위 병목 검증 실행<\/button>/);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /하드웨어 대상 프리셋/);
  assert.match(uiSource, /공식 사양/);
  assert.match(html, /전문가 모드/);
  assert.match(testsInitFull, /chart\.setAttribute\('aria-label', '토큰 성능 추적'\)/);
  assert.match(testsInitFull, /memoryChart\.setAttribute\('aria-label', '메모리와 스왑 추적'\)/);
});

test('P1: production guided UI contains no console info debug statements', () => {
  assert.doesNotMatch(uiSource, /console\.info\s*\(/);
});

test('P1: guided bottleneck sweep spans quarter to four times baseline in at most five points', () => {
  assert.equal(vm.runInContext("typeof guidedSweepValues === 'function'", sandbox), true);
  const values = vm.runInContext(`guidedSweepValues({ path: 'pcieBW', type: 'number', min: 0.001, max: 1e12, integer: false }, 24)`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(values)), [6, 12, 24, 48, 96]);
  assert.match(html, /각 5점 OAT/);
});

test('P1: OAT charts separate each swept parameter instead of connecting unrelated rows', () => {
  assert.equal(vm.runInContext("typeof sweepChartGroups === 'function'", sandbox), true);
  const groups = JSON.parse(JSON.stringify(vm.runInContext(`sweepChartGroups({
    definition: { mode: 'oat' },
    baselineMetrics: { status: 'completed', aggregateTPS: 1 },
    selections: [{ path: 'pcieBW', values: [12, 24, 48] }, { path: 'ssdBW', values: [4.6, 9.2, 18.4] }],
    results: [
      { changes: { pcieBW: 12 }, metrics: { status: 'completed', aggregateTPS: 0.8 } },
      { changes: { pcieBW: 48 }, metrics: { status: 'completed', aggregateTPS: 1.2 } },
      { changes: { ssdBW: 4.6 }, metrics: { status: 'completed', aggregateTPS: 0.7 } },
      { changes: { ssdBW: 18.4 }, metrics: { status: 'completed', aggregateTPS: 1.3 } }
    ]
  })`, sandbox)));
  assert.deepEqual(groups.map(group => group.path), ['pcieBW', 'ssdBW']);
  assert.deepEqual(groups.map(group => group.rows.length), [3, 3]);
  for (const group of groups) {
    assert.equal(group.rows[0].index, -1);
    assert.ok(group.rows.slice(1).every(row => Object.hasOwn(row.changes, group.path)));
  }
});

test('P1: main charts size their backing stores from the visible CSS box', () => {
  assert.equal(vm.runInContext("typeof sizeMainCanvas === 'function'", sandbox), true);
  const sizing = vm.runInContext(`(() => {
    const transforms = [];
    const context = { setTransform(...values) { transforms.push(values); } };
    const canvas = { clientWidth: 255, clientHeight: 220, width: 930, height: 250, getContext() { return context; } };
    const result = sizeMainCanvas(canvas, 2);
    return { width: canvas.width, height: canvas.height, cssWidth: result.width, cssHeight: result.height, transforms };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sizing)), { width: 510, height: 440, cssWidth: 255, cssHeight: 220, transforms: [[2, 0, 0, 2, 0, 0]] });
  const renderSource = fs.readFileSync(path.join(root, 'render.js'), 'utf8');
  assert.ok((renderSource.match(/sizeMainCanvas\(/g) || []).length >= 4, 'helper must be defined and wired into all three main charts');
  assert.match(uiSource, /function initializeResponsiveChartRedraw\(/);
  assert.match(testsInitFull, /initializeResponsiveChartRedraw\(\)/);
  assert.match(html, /\.graphPanel canvas\{height:220px\}/);
});

test('P1: narrow Sweep Lab keeps controls inside the shell and preserves readable canvas text', () => {
  assert.match(html, /@media\(max-width:600px\)[^{]*\{[^}]*\.sweepParameterCard\{grid-template-columns:1fr/);
  assert.match(html, /\.sweepHead button\{min-width:44px/);
  assert.equal(vm.runInContext("typeof sizeSweepCanvas === 'function'", sandbox), true);
  const sizing = vm.runInContext(`(() => {
    const transforms = [];
    const context = { setTransform(...values) { transforms.push(values); } };
    const canvas = { clientWidth: 255, clientHeight: 250, width: 680, height: 250, getContext() { return context; } };
    const result = sizeSweepCanvas(canvas, 2);
    return { width: canvas.width, height: canvas.height, cssWidth: result.width, cssHeight: result.height, transforms };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sizing)), { width: 510, height: 500, cssWidth: 255, cssHeight: 250, transforms: [[2, 0, 0, 2, 0, 0]] });
});

test('P1: parameter chart axis uses physical values and units in ascending order', () => {
  assert.equal(vm.runInContext("typeof sweepParameterChartData === 'function'", sandbox), true);
  const data = vm.runInContext(`sweepParameterChartData({ path: 'pcieBW', rows: [
    { index: -1, changes: { Baseline: true }, metrics: { status: 'completed' } },
    { index: 0, changes: { pcieBW: 6 }, metrics: { status: 'completed' } },
    { index: 1, changes: { pcieBW: 96 }, metrics: { status: 'completed' } }
  ] }, { ...readColibri(), arch: 'discrete', pcieBW: 24 })`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify({ values: data.xValues, label: data.xLabel })), { values: [6, 24, 96], label: 'PCIe Host ↔ GPU 대역폭 (GB/s)' });
});

test('P1: multi-parameter OAT renders one chart pair per parameter', () => {
  assert.match(html, /id="sweepCharts"/);
  assert.equal(vm.runInContext("typeof renderSweepCharts === 'function'", sandbox), true);
  const output = vm.runInContext(`(() => {
    renderSweepCharts({
      definition: { mode: 'oat' },
      baselineConfig: { ...readColibri(), arch: 'discrete' },
      baselineMetrics: { status: 'completed', ttftMeanMs: 10, ttftP50Ms: 10, ttftP95Ms: 10, singleTPS: 1, aggregateTPS: 1 },
      selections: [{ path: 'pcieBW', values: [12, 24, 48] }, { path: 'ssdBW', values: [4.6, 9.2, 18.4] }],
      results: []
    });
    return $('sweepCharts').innerHTML;
  })()`, sandbox);
  assert.match(output, /data-sweep-chart-path="pcieBW"/);
  assert.match(output, /data-sweep-chart-path="ssdBW"/);
  assert.equal((output.match(/TTFT 스윕 그래프/g) || []).length, 2);
  assert.equal((output.match(/TPS 스윕 그래프/g) || []).length, 2);
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
  assert.ok(result.ranked.every(item => /[가-힣]/.test(item.phaseLabel)), JSON.stringify(result.ranked));
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
  const cancelledAssertion = assert.rejects(cancelled, /스윕 시뮬레이션이 취소되었습니다/);
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

test('P1: component GPU target changes only sourced fields and preserves workload, model, host, and storage inputs', () => {
  assert.equal(vm.runInContext("typeof applyGuidedHardwarePreset === 'function'", sandbox), true);
  const result = vm.runInContext(`(() => {
    const protectedIds = ['prompt', 'output', 'context', 'conc', 'layers', 'experts', 'active', 'attn', 'host', 'dramBW', 'pcieBW', 'ssdBW', 'lat', 'qd'];
    $('arch').value = 'unified'; $('vram').value = '8'; $('host').value = '192'; $('dramBW').value = '333'; $('pcieBW').value = '21'; $('ssdBW').value = '7.7'; $('lat').value = '88'; $('qd').value = '11';
    const before = Object.fromEntries(protectedIds.map(id => [id, $(id).value]));
    const applied = applyGuidedHardwarePreset('nvidia-rtx-5090-32');
    const preserved = protectedIds.every(id => $(id).value === before[id]);
    return { applied, arch: $('arch').value, vram: $('vram').value, preserved };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { applied: true, arch: 'discrete', vram: '32', preserved: true });
});

test('P1: unified product target preserves unsourced storage and dormant discrete controls', () => {
  const result = vm.runInContext(`(() => {
    $('host').value = '192'; $('dramBW').value = '333'; $('ssdBW').value = '7.7'; $('lat').value = '88';
    $('vram').value = '24'; $('pcieBW').value = '32'; $('qd').value = '16';
    const applied = applyGuidedHardwarePreset('nvidia-dgx-spark-128');
    return { applied, arch: $('arch').value, host: $('host').value, dramBW: $('dramBW').value, ssdBW: $('ssdBW').value, lat: $('lat').value, vram: $('vram').value, pcieBW: $('pcieBW').value, qd: $('qd').value };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { applied: true, arch: 'unified', host: '128', dramBW: '273', ssdBW: '7.7', lat: '88', vram: '24', pcieBW: '32', qd: '16' });
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
