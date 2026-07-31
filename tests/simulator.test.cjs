'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = ['core.js', 'config.js', 'memory.js', 'colibri.js', 'afm.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n') + ['serving.js', 'advisor.js', 'repro.js']
    .filter(file => fs.existsSync(path.join(root, file)))
    .map(file => `\n${fs.readFileSync(path.join(root, file), 'utf8')}`)
    .join('') + `
globalThis.__simulator = {
  StorageResource,
  SharedServingResource,
  simulateColibri,
  simulateAFM,
  afmDerived,
  validateSimulationConfig: typeof validateSimulationConfig === 'function' ? validateSimulationConfig : null,
  EventQueue: typeof EventQueue === 'function' ? EventQueue : null,
  simulateServing: typeof simulateServing === 'function' ? simulateServing : null,
  createScenarioArtifact: typeof createScenarioArtifact === 'function' ? createScenarioArtifact : null,
  parseScenarioArtifact: typeof parseScenarioArtifact === 'function' ? parseScenarioArtifact : null,
  compareResultSummaries: typeof compareResultSummaries === 'function' ? compareResultSummaries : null,
  resultSummariesMatch: typeof resultSummariesMatch === 'function' ? resultSummariesMatch : null,
  createBottleneckInsight: typeof createBottleneckInsight === 'function' ? createBottleneckInsight : null,
  validateBottleneckInsight: typeof validateBottleneckInsight === 'function' ? validateBottleneckInsight : null,
  bottleneckInsightsMatch: typeof bottleneckInsightsMatch === 'function' ? bottleneckInsightsMatch : null
};`;

const sandbox = {
  console,
  document: { getElementById: () => null }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'simulator-bundle.js' });
const simulator = sandbox.__simulator;

function memoryPolicy(overrides = {}) {
  return {
    policy: 'strict',
    backgroundGB: 0,
    osReservedGB: 4,
    minHeadroomGB: 2,
    soft: 0.8,
    compress: 0.85,
    swap: 0.9,
    hard: 1,
    compressionEnabled: false,
    compressionRatio: 1.6,
    compressionBW: 25,
    swapEnabled: false,
    swapCapacityGB: 0,
    swapWriteRatio: 0.7,
    kvTouchFraction: 1,
    ...overrides
  };
}

function colibriConfig(overrides = {}) {
  return {
    mode: 'colibri',
    prompt: 1,
    output: 8,
    context: 1,
    conc: 1,
    arch: 'unified',
    host: 512,
    vram: 0,
    dramBW: 273,
    pcieBW: 24,
    ssdBW: 9.2,
    lat: 120,
    seed: 260730,
    mem: memoryPolicy(),
    cold: true,
    placement: 'manual',
    layers: 75,
    experts: 256,
    active: 8,
    esize: 19,
    resident: 9.9,
    kvKB: 182,
    vcache: 0,
    dcache: 0,
    minDCache: 0,
    expertBacking: 'file',
    pinned: 357,
    page: 0,
    odirect: true,
    corr: 0.52,
    qd: 8,
    attn: 28,
    ems: 0.7,
    par: 4,
    pf: true,
    recall: 0.716,
    precision: 0.78,
    budget: 160,
    prefillSpeedup: 4.5,
    ...overrides
  };
}

function afmConfig(overrides = {}) {
  return {
    mode: 'afm3',
    prompt: 0,
    output: 2,
    context: 60_000,
    conc: 1,
    arch: 'unified',
    host: 16,
    vram: 0,
    dramBW: 1_000_000,
    pcieBW: 0,
    ssdBW: 1_000_000,
    lat: 0,
    seed: 260730,
    mem: memoryPolicy({
      policy: 'swap',
      minHeadroomGB: 0,
      soft: 0.7,
      compress: 0.72,
      swap: 0.75,
      hard: 0.99,
      swapEnabled: true,
      swapCapacityGB: 128,
      kvTouchFraction: 1
    }),
    totalB: 1,
    layers: 1,
    hidden: 1,
    active: 1,
    shared: 1,
    routed: 0,
    expertWidth: 1,
    activeDim: 1,
    projections: 1,
    chunks: 1,
    bits: 2,
    packing: 1,
    commonGB: 0,
    freq: 32,
    overlap: 1,
    initSel: 0,
    periodicSel: 0,
    patchBase: 0,
    patchBW: 1_000_000,
    attn: 0,
    ffn: 0,
    runtime: 0,
    prefillTPS: 80,
    chunkMode: 'sequential',
    doubleBuffer: false,
    kvKB: 182,
    ...overrides
  };
}

test('P1: CI runs the dependency audit gate', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/validate.yml'), 'utf8');
  assert.match(workflow, /npm audit --audit-level=high/);
});

test('P0: configuration validation rejects out-of-order memory thresholds instead of normalizing them', () => {
  assert.equal(typeof simulator.validateSimulationConfig, 'function');
  const config = colibriConfig({
    mem: memoryPolicy({ soft: 0.9, compress: 0.8, swap: 0.7, hard: 0.6 })
  });
  const validation = simulator.validateSimulationConfig(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.path === 'mem.thresholds'));
});

test('P0: simulators fail closed on invalid configuration', () => {
  const invalid = colibriConfig({
    active: 9,
    experts: 8,
    mem: memoryPolicy({ soft: 0.9, compress: 0.8, swap: 0.7, hard: 0.6 })
  });
  const result = simulator.simulateColibri(invalid);
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'active'));
  assert.ok(result.validationErrors.some(error => error.path === 'mem.thresholds'));
});

test('P0: simulator entry points return structured errors for non-object configs', () => {
  for (const simulate of [simulator.simulateColibri, simulator.simulateAFM]) {
    const result = simulate(null);
    assert.match(result.error, /Invalid configuration/);
    assert.ok(Array.isArray(result.validationErrors));
  }
});

test('P0: validation rejects every missing numeric field that participates in memory accounting', () => {
  for (const field of ['compressionRatio', 'compressionBW', 'swapWriteRatio', 'kvTouchFraction']) {
    const config = colibriConfig();
    delete config.mem[field];
    const validation = simulator.validateSimulationConfig(config);
    assert.equal(validation.valid, false, field);
    assert.ok(validation.errors.some(error => error.path === `mem.${field}`), field);
    assert.match(simulator.simulateColibri(config).error, /Invalid configuration/, field);
  }
});

test('P0: manual discrete placement rejects a VRAM cache budget larger than physical VRAM', () => {
  const config = colibriConfig({ arch: 'discrete', vram: 1, vcache: 100, placement: 'manual' });
  const validation = simulator.validateSimulationConfig(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.path === 'vcache'));
  assert.match(simulator.simulateColibri(config).error, /Invalid configuration/);
});

test('P1: validation rejects simulation dimensions whose work estimate exceeds the browser budget', () => {
  const config = colibriConfig({ output: 4096, conc: 4096, layers: 500, active: 4096, experts: 4096 });
  const validation = simulator.validateSimulationConfig(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.code === 'COMPLEXITY_LIMIT'));
});

test('REQ-001: fully pinned Experts issue no demand or prefetch reads', () => {
  const result = simulator.simulateColibri(colibriConfig({ pinned: 400 }));
  assert.equal(result.storageByKind['expert-demand-read'] || 0, 0);
  assert.equal(result.storageByKind['expert-prefetch-read'] || 0, 0);
});

test('P1: previous-token prefetch is causal and issues nothing before route history exists', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 1,
    layers: 2,
    experts: 64,
    active: 4,
    pinned: 0,
    dcache: 0,
    vcache: 0,
    pf: true,
    prefetchPolicy: 'previous-token',
    budget: 160
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.tot.pfIssued, 0);
});

test('P1: event queue is stable and ordered by simulation time', () => {
  assert.equal(typeof simulator.EventQueue, 'function');
  const queue = new simulator.EventQueue();
  queue.push({ time: 5, id: 'late' });
  queue.push({ time: 1, id: 'first' });
  queue.push({ time: 1, id: 'second' });
  assert.deepEqual([queue.pop().id, queue.pop().id, queue.pop().id], ['first', 'second', 'late']);
});

test('P1: shared serving resources preserve queue accounting by execution phase', () => {
  const resource = new simulator.SharedServingResource('ssd', 1, 0, 1);
  resource.reserveGB(1, 0, 1, 'prefill');
  resource.reserveGB(1, 0, 1, 'first-token');
  resource.reserveGB(1, 0, 1, 'decode');
  const snapshot = resource.snapshot();
  assert.equal(snapshot.phases.prefill.busyMs, 1000);
  assert.equal(snapshot.phases['first-token'].queueMs, 1000);
  assert.equal(snapshot.phases.decode.queueMs, 2000);
  assert.equal(snapshot.queueMs, 3000);
});

test('P1: multi-request scheduler derives throughput from completed events and shared contention', () => {
  assert.equal(typeof simulator.simulateServing, 'function');
  const config = colibriConfig({
    prompt: 0,
    output: 3,
    layers: 1,
    experts: 8,
    active: 1,
    pinned: 0,
    dcache: 0,
    vcache: 0,
    pf: false,
    ssdBW: 0.1,
    lat: 1000,
    qd: 1,
    dramBW: 1_000_000,
    attn: 0,
    ems: 0
  });
  const single = simulator.simulateServing(config, [{ id: 'a', arrivalMs: 0, output: 3 }]);
  const concurrent = simulator.simulateServing(config, [
    { id: 'a', arrivalMs: 0, output: 3 },
    { id: 'b', arrivalMs: 0, output: 3 }
  ]);
  assert.equal(single.completedTokens, 3);
  assert.equal(concurrent.completedTokens, 6);
  assert.ok(concurrent.resources.ssd.queueMs > single.resources.ssd.queueMs);
  assert.ok(concurrent.requests.some(request => request.ttftMs > single.requests[0].ttftMs));
  assert.ok(concurrent.throughputTPS < single.throughputTPS * 2);
});

test('P0: serving scheduler includes swap reads and writes in shared SSD work', () => {
  const config = colibriConfig({
    prompt: 0,
    output: 1,
    context: 26_800,
    host: 16,
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 0.02,
    resident: 0,
    dcache: 0,
    pf: false,
    kvKB: 182,
    attn: 0,
    ems: 0,
    ssdBW: 0.1,
    dramBW: 1_000_000,
    mem: memoryPolicy({
      policy: 'swap', minHeadroomGB: 0, soft: 0.7, compress: 0.72, swap: 0.75, hard: 0.99,
      swapEnabled: true, swapCapacityGB: 128, kvTouchFraction: 1
    })
  });
  const trace = simulator.simulateColibri(config);
  const expectedSwapGB = (trace.storageByKind['swap-in-read'] || 0) + (trace.storageByKind['swap-out-write'] || 0);
  const serving = simulator.simulateServing(config, [{ id: 'swap', arrivalMs: 0, output: 1 }]);
  assert.ok(expectedSwapGB > 1, `expectedSwapGB=${expectedSwapGB}`);
  assert.ok(serving.resources.ssd.workGB >= expectedSwapGB - 1e-9,
    `${serving.resources.ssd.workGB} < ${expectedSwapGB}`);
});

test('P0: Colibri single-request scheduler preserves the analytic trace TTFT', () => {
  const config = colibriConfig({
    prompt: 128,
    output: 2,
    arch: 'discrete',
    vram: 8,
    layers: 4,
    experts: 64,
    active: 4,
    resident: 9.9,
    vcache: 2,
    dcache: 4,
    pf: false,
    prefetchPolicy: 'none'
  });
  const trace = simulator.simulateColibri(config);
  const serving = simulator.simulateServing(config, [{ id: 'only', arrivalMs: 0, output: 2 }], { batchWindowMs: 0 });
  assert.equal(serving.error, undefined);
  assert.ok(Math.abs(serving.requests[0].ttftMs - trace.ttft) < 1e-6,
    `${serving.requests[0].ttftMs} vs ${trace.ttft}`);
  const expectedLatency = trace.ttft + trace.tokens.slice(1).reduce((sum, token) => sum + token.tpot, 0);
  assert.ok(Math.abs(serving.requests[0].latencyMs - expectedLatency) < 1e-6,
    `${serving.requests[0].latencyMs} vs ${expectedLatency}`);
});

test('P0: AFM single-request scheduler preserves selector, initial patch, and prefill TTFT', () => {
  const config = afmConfig({
    output: 1,
    context: 1,
    prompt: 80,
    host: 128,
    active: 2,
    shared: 1,
    routed: 1,
    activeDim: 2,
    initSel: 100,
    patchBase: 200,
    patchBW: 1,
    prefillTPS: 80,
    dramBW: 1_000_000,
    ssdBW: 1,
    mem: memoryPolicy({ policy: 'strict', minHeadroomGB: 0, soft: 0.8, compress: 0.85, swap: 0.9, hard: 1 })
  });
  const trace = simulator.simulateAFM(config);
  const serving = simulator.simulateServing(config, [{ id: 'afm', arrivalMs: 0, output: 1 }], { batchWindowMs: 0 });
  assert.equal(trace.error, undefined);
  assert.equal(serving.error, undefined);
  assert.ok(Math.abs(serving.requests[0].ttftMs - trace.ttft) < 1e-6,
    `${serving.requests[0].ttftMs} != ${trace.ttft}`);
});

test('P0: AFM single-request scheduler preserves the full analytic token timeline', () => {
  const config = afmConfig({ output: 4, prompt: 80, freq: 2, initSel: 10, periodicSel: 3, patchBase: 2 });
  const trace = simulator.simulateAFM(config);
  const serving = simulator.simulateServing(config, [{ id: 'afm-timeline', arrivalMs: 0, output: 4 }], { batchWindowMs: 0 });
  const expectedLatency = trace.ttft + trace.tokens.slice(1).reduce((sum, token) => sum + token.tpot, 0);
  assert.equal(trace.error, undefined);
  assert.equal(serving.error, undefined);
  assert.ok(Math.abs(serving.requests[0].latencyMs - expectedLatency) < 1e-6,
    `${serving.requests[0].latencyMs} != ${expectedLatency}`);
});

test('P1: serving rejects malformed request arrivals instead of returning NaN or Infinity', () => {
  const result = simulator.simulateServing(colibriConfig(), [{ id: 'bad', arrivalMs: 'not-a-time', output: 1 }]);
  assert.match(result.error, /arrivalMs/);
  assert.equal(result.resources, undefined);
});

test('P1: requests becoming ready inside the admission window are continuously batched', () => {
  const config = colibriConfig({
    prompt: 0,
    output: 2,
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 1,
    attn: 10,
    ems: 10,
    ssdBW: 1_000_000,
    dramBW: 1_000_000,
    lat: 0
  });
  const result = simulator.simulateServing(config, [
    { id: 'a', arrivalMs: 0, output: 2 },
    { id: 'b', arrivalMs: 1, output: 2 }
  ], { batchWindowMs: 2 });
  assert.equal(result.error, undefined);
  assert.ok(result.requests.every(request => request.tokens.every(token => token.batchSize === 2)),
    JSON.stringify(result.requests));
});

test('P1: scenario artifacts round-trip validated config, result summary, and run ID', () => {
  assert.equal(typeof simulator.createScenarioArtifact, 'function');
  const config = colibriConfig({ output: 2, seed: 42 });
  const result = simulator.simulateColibri(config);
  const artifact = simulator.createScenarioArtifact(config, result);
  const parsed = simulator.parseScenarioArtifact(JSON.stringify(artifact));
  assert.equal(parsed.schemaVersion, 'moe-ssd-sim/v2');
  assert.equal(JSON.stringify(parsed.config), JSON.stringify(config));
  assert.match(parsed.runId, /^sim-[0-9a-f]{8}$/);
  assert.equal(parsed.result.completedTokens, 2);
  assert.equal(parsed.insight.version, 'bottleneck-advisor/v1');
  assert.equal(parsed.insight.phases.length, 4);
});

test('P1: advisor emits deterministic bounded evidence for every resource in every phase', () => {
  assert.equal(typeof simulator.createBottleneckInsight, 'function');
  const result = simulator.simulateColibri(colibriConfig({ output: 4, prompt: 8 }));
  const first = simulator.createBottleneckInsight(result);
  const second = simulator.createBottleneckInsight(result);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'complete');
  assert.deepEqual(JSON.parse(JSON.stringify(first.phases.map(phase => phase.id))), ['prefill', 'first-token', 'decode', 'memory-pressure']);
  for (const phase of first.phases) {
    assert.deepEqual(JSON.parse(JSON.stringify(phase.resources.map(resource => resource.id))), ['storage', 'data-movement', 'compute', 'capacity-policy']);
    for (const resource of phase.resources) {
      assert.ok(Number.isInteger(resource.score) && resource.score >= 0 && resource.score <= 100, `${phase.id}/${resource.id}=${resource.score}`);
      assert.equal(typeof resource.formula, 'string');
      assert.ok(resource.formula.length > 10);
      assert.ok(Array.isArray(resource.evidence) && resource.evidence.length > 0);
      assert.ok(['Monitor', 'Consider', 'Urgent'].includes(resource.recommendation.priority));
      for (const key of ['controls', 'direction', 'condition', 'tradeoff']) assert.equal(typeof resource.recommendation[key], 'string');
    }
  }
});

test('P1: advisor separates storage and compute pressure from the simulated trace', () => {
  const storageBound = simulator.createBottleneckInsight(simulator.simulateColibri(colibriConfig({
    prompt: 8, output: 3, layers: 1, experts: 16, active: 8, pinned: 0, dcache: 0, page: 0,
    pf: false, ssdBW: 0.1, lat: 0, attn: 0, ems: 0, dramBW: 1_000_000
  })));
  const computeBound = simulator.createBottleneckInsight(simulator.simulateColibri(colibriConfig({
    prompt: 8, output: 3, layers: 1, experts: 1, active: 1, pinned: 1, pf: false,
    ssdBW: 1_000_000, lat: 0, attn: 100, ems: 100, par: 1, dramBW: 1_000_000
  })));
  const score = (insight, phase, resource) => insight.phases.find(item => item.id === phase).resources.find(item => item.id === resource).score;
  assert.ok(score(storageBound, 'decode', 'storage') > score(storageBound, 'decode', 'compute'));
  assert.ok(score(computeBound, 'decode', 'compute') > score(computeBound, 'decode', 'storage'));
});

test('P1: advisor attributes shared-resource queue contention to its actual phase', () => {
  const servingConfig = colibriConfig({
    prompt: 8, output: 3, conc: 2, layers: 1, experts: 1, active: 1, pinned: 0,
    dcache: 1, page: 0, pf: false, cold: true, ssdBW: 0.1, lat: 10_000, attn: 0, ems: 0
  });
  const result = simulator.simulateColibri({ ...servingConfig, conc: 1 });
  result.c = servingConfig;
  result.serving = simulator.simulateServing(servingConfig, [
    { id: 'a', arrivalMs: 0, output: 3 },
    { id: 'b', arrivalMs: 0, output: 3 }
  ]);
  const insight = simulator.createBottleneckInsight(result);
  const storage = phase => insight.phases.find(item => item.id === phase).resources.find(resource => resource.id === 'storage');
  assert.ok(result.serving.resources.ssd.phases.prefill.queueMs > 0);
  assert.equal(result.serving.resources.ssd.phases.decode?.queueMs || 0, 0);
  assert.ok(storage('prefill').score > 0);
  assert.equal(storage('decode').evidence.find(item => item.label === 'Shared SSD queue').value, 0);
  assert.match(storage('decode').formula, /phase queue/i);
});

test('P1: a one-token trace marks decode unavailable instead of duplicating first-token evidence', () => {
  const insight = simulator.createBottleneckInsight(simulator.simulateColibri(colibriConfig({ output: 1 })));
  const first = insight.phases.find(phase => phase.id === 'first-token');
  const decode = insight.phases.find(phase => phase.id === 'decode');
  assert.match(decode.note, /unavailable|no tokens/i);
  assert.ok(decode.resources.every(resource => resource.score === 0));
  assert.notDeepEqual(decode.resources, first.resources);
});

test('P1: advisor treats partial OOM as urgent capacity pressure without claiming completion', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0, output: 512, context: 5000, host: 16, layers: 1, experts: 1, active: 1,
    pinned: 1, dcache: 0, vcache: 0, resident: 0, kvKB: 1_000, pf: false,
    attn: 0, ems: 0, dramBW: 1_000_000,
    mem: memoryPolicy({ hard: 0.97, osReservedGB: 4, minHeadroomGB: 2 })
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.oom, true);
  assert.ok(result.tokens.length > 0 && result.tokens.length < 512, result.tokens.length);
  const insight = simulator.createBottleneckInsight(result);
  const memory = insight.phases.find(phase => phase.id === 'memory-pressure');
  const capacity = memory.resources.find(resource => resource.id === 'capacity-policy');
  assert.equal(insight.status, 'oom');
  assert.equal(capacity.score, 100);
  assert.equal(capacity.recommendation.priority, 'Urgent');
  assert.match(insight.disclaimer, /completed token|완료된 token/i);
});

test('P1: AFM advisor emits the same four phase contracts', () => {
  const result = simulator.simulateAFM(afmConfig({ output: 4, prompt: 8 }));
  const insight = simulator.createBottleneckInsight(result);
  assert.equal(insight.phases.length, 4);
  assert.equal(simulator.validateBottleneckInsight(insight), null);
});

test('P1: AFM periodic patch materialization is data movement rather than compute', () => {
  const result = simulator.simulateAFM(afmConfig({
    host: 512, context: 1, output: 3, routed: 1, shared: 0,
    freq: 1, overlap: 0, patchBase: 100, patchBW: 0.01,
    ssdBW: 1_000_000, attn: 0, ffn: 0, runtime: 0
  }));
  assert.equal(result.error, undefined, result.error);
  const decode = simulator.createBottleneckInsight(result).phases.find(phase => phase.id === 'decode');
  const scores = Object.fromEntries(decode.resources.map(resource => [resource.id, resource.score]));
  assert.ok(scores['data-movement'] > scores.compute, JSON.stringify(scores));
  assert.ok(result.tokens.slice(1).every(token => token.patchMs > 0 && token.computeOnlyMs === 0));
});

test('P1: concurrent AFM patch-only work queues as data movement, never compute', () => {
  const config = afmConfig({
    conc: 4, host: 512, context: 1, prompt: 0, output: 3,
    routed: 1, shared: 0, freq: 1, overlap: 0,
    initSel: 0, periodicSel: 0, patchBase: 1_000, patchBW: 1_000_000,
    ssdBW: 1_000_000, attn: 0, ffn: 0, runtime: 0
  });
  const result = simulator.simulateAFM(config);
  assert.equal(result.error, undefined, result.error);
  result.serving = simulator.simulateServing(config, Array.from({ length: 4 }, (_, index) => ({ id: `r${index}`, arrivalMs: 0, output: config.output })));
  assert.equal(result.serving.error, undefined, result.serving.error);
  const prefillCompute = result.serving.resources.compute.phases.prefill;
  const prefillPatch = result.serving.resources.patch?.phases?.prefill;
  const decodeCompute = result.serving.resources.compute.phases.decode;
  const decodePatch = result.serving.resources.patch?.phases?.decode;
  assert.equal(prefillCompute?.busyMs || 0, 0);
  assert.equal(prefillCompute?.queueMs || 0, 0);
  assert.ok(prefillPatch?.busyMs > 0 && prefillPatch?.queueMs > 0, JSON.stringify(result.serving.resources));
  assert.equal(decodeCompute?.busyMs || 0, 0);
  assert.equal(decodeCompute?.queueMs || 0, 0);
  assert.ok(decodePatch?.busyMs > 0 && decodePatch?.queueMs > 0, JSON.stringify(result.serving.resources));
  const insight = simulator.createBottleneckInsight(result);
  for (const phaseId of ['prefill', 'decode']) {
    const phase = insight.phases.find(entry => entry.id === phaseId);
    const scores = Object.fromEntries(phase.resources.map(resource => [resource.id, resource.score]));
    assert.equal(scores.compute, 0, `${phaseId}: ${JSON.stringify(scores)}`);
    assert.ok(scores['data-movement'] > 0, `${phaseId}: ${JSON.stringify(scores)}`);
  }
});

test('P1: Colibri Advisor uses exact per-job StorageResource service accounting', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0, output: 1, context: 1, layers: 2, experts: 1, active: 1,
    pinned: 0, dcache: 0, vcache: 0, pf: false, ssdBW: 1_000_000,
    lat: 10_000, qd: 8, esize: 0.019, attn: 0, ems: 0
  }));
  assert.equal(result.error, undefined, result.error);
  assert.ok(Math.abs(result.tokens[0].storageServiceMs - 20) < 0.001, result.tokens[0].storageServiceMs);
  const storage = simulator.createBottleneckInsight(result).phases.find(phase => phase.id === 'first-token').resources.find(resource => resource.id === 'storage');
  const service = storage.evidence.find(item => item.label === 'Average exact storage service');
  assert.ok(Math.abs(service.value - result.tokens[0].storageServiceMs) < 0.001, JSON.stringify(storage.evidence));
});

test('P1: token swap service is phase-local and pre-decode swap is separately evidenced', () => {
  const result = simulator.simulateAFM(afmConfig());
  assert.equal(result.error, undefined, result.error);
  assert.ok(result.initialSwapServiceMs > 0, result.initialSwapServiceMs);
  assert.ok(result.tokens.some(token => token.swapServiceMs > 0), JSON.stringify(result.tokens));
  const insight = simulator.createBottleneckInsight(result);
  const firstStorage = insight.phases.find(phase => phase.id === 'first-token').resources.find(resource => resource.id === 'storage');
  assert.ok(firstStorage.evidence.find(item => item.label === 'Average swap read/write service').value > 0);
  const memoryStorage = insight.phases.find(phase => phase.id === 'memory-pressure').resources.find(resource => resource.id === 'storage');
  assert.ok(Math.abs(memoryStorage.evidence.find(item => item.label === 'Initial pre-decode swap service').value - result.initialSwapServiceMs) < 1e-6);
  assert.ok(Math.abs(memoryStorage.evidence.find(item => item.label === 'Token-phase swap service').value - result.tokens.reduce((sum, token) => sum + token.swapServiceMs, 0)) < 1e-6);
});

test('P1: scenario V2 validates and replay-compares derived insight integrity', () => {
  const result = simulator.simulateColibri(colibriConfig({ output: 2 }));
  const artifact = simulator.createScenarioArtifact(result.c, result);
  const tampered = JSON.parse(JSON.stringify(artifact));
  tampered.insight.phases[0].resources[0].score = 101;
  assert.throws(() => simulator.parseScenarioArtifact(JSON.stringify(tampered)), /insight/i);
  const plausibleTamper = JSON.parse(JSON.stringify(artifact.insight));
  plausibleTamper.phases[0].resources[0].score = plausibleTamper.phases[0].resources[0].score === 99 ? 98 : 99;
  assert.equal(simulator.bottleneckInsightsMatch(artifact.insight, plausibleTamper), false);
  assert.equal(simulator.bottleneckInsightsMatch(artifact.insight, simulator.createBottleneckInsight(result)), true);
});

test('P1: scenario parser rejects imported invalid configuration', () => {
  assert.equal(typeof simulator.parseScenarioArtifact, 'function');
  const artifact = {
    schemaVersion: 'moe-ssd-sim/v2',
    runId: 'sim-deadbeef',
    config: colibriConfig({ active: 9, experts: 8 }),
    result: {}
  };
  assert.throws(() => simulator.parseScenarioArtifact(JSON.stringify(artifact)), /Invalid imported configuration/);
});

test('P1: scenario parser rejects malformed persisted status fields', () => {
  const result = simulator.simulateColibri(colibriConfig({ output: 1 }));
  const artifact = simulator.createScenarioArtifact(result.c, result);
  assert.throws(() => simulator.parseScenarioArtifact(JSON.stringify({ ...artifact, result: { ...artifact.result, oom: 'false' } })), /oom/);
  assert.throws(() => simulator.parseScenarioArtifact(JSON.stringify({ ...artifact, result: { ...artifact.result, modelStatus: 1 } })), /modelStatus/);
});

test('P1: scenario parser rejects markup-bearing imported run IDs', () => {
  const artifact = simulator.createScenarioArtifact(colibriConfig({ output: 1 }), simulator.simulateColibri(colibriConfig({ output: 1 })));
  artifact.runId = '<img src=x onerror=alert(1)>';
  assert.throws(() => simulator.parseScenarioArtifact(JSON.stringify(artifact)), /Invalid run ID/);
});

test('P1: scenario parser rejects a valid-looking run ID that does not match its config', () => {
  const config = colibriConfig({ output: 1 });
  const artifact = simulator.createScenarioArtifact(config, simulator.simulateColibri(config));
  artifact.runId = artifact.runId === 'sim-deadbeef' ? 'sim-cafebabe' : 'sim-deadbeef';
  assert.throws(() => simulator.parseScenarioArtifact(JSON.stringify(artifact)), /run ID.*config/i);
});

test('P1: scenario parser rejects oversized artifacts before JSON parsing', () => {
  assert.throws(() => simulator.parseScenarioArtifact(' '.repeat(1_000_001)), /too large/i);
});

test('P1: scenario comparison reports signed metric deltas', () => {
  assert.equal(typeof simulator.compareResultSummaries, 'function');
  const delta = simulator.compareResultSummaries(
    { ttftMs: 100, tpotMs: 20, throughputTPS: 10, peakMemoryGB: 30 },
    { ttftMs: 80, tpotMs: 25, throughputTPS: 12, peakMemoryGB: 28 }
  );
  assert.equal(JSON.stringify(delta), JSON.stringify({ ttftMs: -20, tpotMs: 5, throughputTPS: 2, peakMemoryGB: -2 }));
});

test('P1: replay verification compares every persisted result metric', () => {
  const result = simulator.simulateColibri(colibriConfig({ output: 1 }));
  const summary = simulator.createScenarioArtifact(result.c, result).result;
  assert.equal(simulator.resultSummariesMatch(summary, { ...summary, peakSwapGB: summary.peakSwapGB + 1 }), false);
  assert.equal(simulator.resultSummariesMatch(summary, { ...summary, completedTokens: summary.completedTokens - 1 }), false);
  assert.equal(simulator.resultSummariesMatch(summary, { ...summary, storagePerTokenGB: summary.storagePerTokenGB + 1 }), false);
  assert.equal(simulator.resultSummariesMatch(summary, { ...summary, oom: !summary.oom }), false);
  assert.equal(simulator.resultSummariesMatch(summary, { ...summary, modelStatus: `${summary.modelStatus}-tampered` }), false);
  assert.equal(simulator.resultSummariesMatch(summary, { ...summary }), true);
});

test('P1: evicted prefetched Experts are not later counted as useful', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 6,
    context: 1,
    layers: 2,
    experts: 16,
    active: 4,
    seed: 1,
    pinned: 0,
    resident: 0,
    dcache: 0.04,
    minDCache: 0,
    page: 0,
    odirect: true,
    corr: 1,
    kvKB: 0,
    pf: true,
    prefetchPolicy: 'previous-token',
    recall: 1,
    precision: 1,
    budget: 160,
    ssdBW: 1_000_000,
    dramBW: 1_000_000,
    lat: 0,
    attn: 0,
    ems: 0
  }));
  assert.equal(result.error, undefined);
  assert.ok(result.tot.pfEvicted > 0, `pfEvicted=${result.tot.pfEvicted}`);
  assert.ok(result.tot.pfUseful + result.tot.pfEvicted <= result.tot.pfIssued,
    JSON.stringify(result.tot));
});

test('Prefetch candidate expansion is bounded by Experts per layer', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 1,
    layers: 2,
    experts: 4,
    active: 4,
    pinned: 0,
    dcache: 0,
    vcache: 0,
    recall: 1,
    precision: 0.01,
    budget: 10_000
  }));
  assert.ok(result.tot.pfIssued <= 4, `pfIssued=${result.tot.pfIssued}`);
});

test('REQ-002: decode applies queue depth exactly once', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 1,
    layers: 1,
    pinned: 0,
    experts: 256,
    active: 8,
    dcache: 0,
    vcache: 0,
    pf: false,
    qd: 2,
    ssdBW: 1_000_000,
    lat: 10_000,
    resident: 0,
    kvKB: 0,
    attn: 0,
    ems: 0,
    par: 8,
    dramBW: 1_000_000
  }));
  assert.ok(result.ssdBusy >= 39.9 && result.ssdBusy <= 40.1, `ssdBusy=${result.ssdBusy}`);
});

test('REQ-003: host-sourced Experts are promoted to the discrete GPU cache', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 2,
    arch: 'discrete',
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 0.02,
    vcache: 0.02,
    vram: 1,
    dcache: 0,
    pf: false,
    kvKB: 0,
    corr: 1,
    attn: 0,
    ems: 0,
    par: 1,
    dramBW: 1_000_000,
    pcieBW: 1_000_000
  }));
  assert.equal(result.tot.vPromotions, 1);
  assert.equal(result.tot.v, 1);
});

test('REQ-005: auto placement grows Expert caches with available RAM and VRAM', () => {
  const base = colibriConfig({
    placement: 'auto',
    prompt: 0,
    output: 1,
    context: 1024,
    arch: 'discrete',
    host: 64,
    vram: 8,
    pinned: 0,
    dcache: 0,
    vcache: 0,
    pf: false
  });
  const small = simulator.simulateColibri(base).c;
  const large = simulator.simulateColibri({ ...base, host: 128, vram: 24 }).c;
  assert.ok(large.dcache > small.dcache, `${small.dcache} -> ${large.dcache}`);
  assert.ok(large.vcache > small.vcache, `${small.vcache} -> ${large.vcache}`);
});

test('REQ-005: larger auto-placed RAM cache reduces cold-prompt Expert reloads', () => {
  const base = colibriConfig({
    placement: 'auto',
    prompt: 64,
    output: 1,
    context: 1,
    arch: 'unified',
    host: 6,
    layers: 4,
    experts: 64,
    active: 4,
    pinned: 0,
    resident: 0,
    page: 0,
    kvKB: 0,
    pf: false,
    qd: 64,
    lat: 0,
    ssdBW: 1,
    dramBW: 1_000_000,
    attn: 0,
    ems: 0,
    par: 4,
    prefillSpeedup: 1000,
    mem: memoryPolicy({ osReservedGB: 0, minHeadroomGB: 2 })
  });
  const small = simulator.simulateColibri(base);
  const large = simulator.simulateColibri({ ...base, host: 16 });
  assert.ok(large.prefillBreakdown.storageGB < small.prefillBreakdown.storageGB * 0.7,
    `${small.prefillBreakdown.storageGB} -> ${large.prefillBreakdown.storageGB}`);
});

test('REQ-005: larger auto-placed VRAM cache reduces cold-prompt PCIe reloads', () => {
  const base = colibriConfig({
    placement: 'auto',
    prompt: 64,
    output: 1,
    context: 1,
    arch: 'discrete',
    host: 32,
    vram: 0.8,
    layers: 4,
    experts: 64,
    active: 4,
    pinned: 5,
    resident: 0,
    page: 0,
    kvKB: 0,
    pf: false,
    pcieBW: 1,
    dramBW: 1_000_000,
    attn: 0,
    ems: 0,
    par: 4,
    prefillSpeedup: 1000,
    mem: memoryPolicy({ osReservedGB: 0, minHeadroomGB: 2 })
  });
  const small = simulator.simulateColibri(base);
  const large = simulator.simulateColibri({ ...base, vram: 8 });
  assert.equal(small.prefillBreakdown.storageGB, 0);
  assert.ok(large.prefillBreakdown.transferGB < small.prefillBreakdown.transferGB * 0.7,
    `${small.prefillBreakdown.transferGB} -> ${large.prefillBreakdown.transferGB}`);
});

test('CON-001: manual placement preserves explicit cache budgets', () => {
  const result = simulator.simulateColibri(colibriConfig({
    placement: 'manual',
    dcache: 12.5,
    vcache: 3.25
  }));
  assert.equal(result.c.dcache, 12.5);
  assert.equal(result.c.vcache, 3.25);
});

test('P0: manual placement rejects an impossible VRAM cache before simulation', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 16,
    output: 1,
    arch: 'discrete',
    layers: 1,
    experts: 64,
    active: 8,
    pinned: 0,
    vram: 1,
    vcache: 1,
    dcache: 0,
    kvKB: 0,
    pf: false
  }));
  assert.match(result.error, /Invalid configuration.*vcache/);
});

test('P0: populated Expert caches never exceed their byte budgets including packing overhead', () => {
  const dcacheGB = 1;
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 1,
    cold: false,
    layers: 1,
    experts: 64,
    active: 1,
    pinned: 0,
    dcache: dcacheGB,
    vcache: 0,
    pf: false,
    esize: 19
  }));
  assert.equal(result.error, undefined);
  assert.ok(result.tokens[0].memory.expertCacheGB <= dcacheGB + 1e-12,
    `${result.tokens[0].memory.expertCacheGB}GB > ${dcacheGB}GB`);
});

test('REQ-004: prefill warms the first decode Expert into cache', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 16,
    output: 1,
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 0,
    dcache: 0.02,
    pf: false,
    attn: 0,
    ems: 0,
    dramBW: 1_000_000
  }));
  assert.equal(result.storageByKind['expert-demand-read'] || 0, 0);
  assert.equal(result.tot.d, 1);
  assert.ok(result.prefillBreakdown.storageGB > 0);
});

test('REQ-004: prefill compute parameters materially affect TTFT', () => {
  const base = colibriConfig({
    prompt: 128,
    output: 1,
    pf: false,
    attn: 5,
    ems: 0.7,
    dramBW: 1_000_000
  });
  const fast = simulator.simulateColibri(base);
  const slow = simulator.simulateColibri({ ...base, attn: 20 });
  assert.ok(slow.ttft - fast.ttft > 300, `${fast.ttft} -> ${slow.ttft}`);
  assert.ok(slow.prefillBreakdown.computeMs > fast.prefillBreakdown.computeMs);
});

test('P0: background swap-out remains physically resident until its storage write completes', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 2,
    context: 60_000,
    host: 16,
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 0.02,
    resident: 0,
    dcache: 0,
    pf: false,
    kvKB: 182,
    attn: 0,
    ems: 0,
    ssdBW: 0.1,
    dramBW: 1_000_000,
    mem: memoryPolicy({
      policy: 'swap',
      minHeadroomGB: 0,
      soft: 0.7,
      compress: 0.72,
      swap: 0.75,
      hard: 0.99,
      swapEnabled: true,
      swapCapacityGB: 128,
      kvTouchFraction: 0
    })
  }));
  assert.equal(result.error, undefined);
  const token = result.tokens.find(entry => entry.memory.swapOutGB > 0);
  assert.ok(token, 'expected a token with swap-out traffic');
  assert.ok(token.memory.pendingSwapOutGB >= token.memory.swapOutGB - 1e-12,
    `pending=${token.memory.pendingSwapOutGB} out=${token.memory.swapOutGB}`);
});

test('P0: a swap-in wait reaps completed page-out residency before applying new pressure', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 1,
    context: 26_800,
    host: 16,
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 0.02,
    resident: 0,
    dcache: 0,
    pf: false,
    kvKB: 182,
    attn: 0,
    ems: 0,
    ssdBW: 0.1,
    dramBW: 1_000_000,
    mem: memoryPolicy({
      policy: 'swap',
      minHeadroomGB: 0,
      soft: 0.7,
      compress: 0.72,
      swap: 0.75,
      hard: 0.99,
      swapEnabled: true,
      swapCapacityGB: 128,
      kvTouchFraction: 1
    })
  }));
  assert.equal(result.error, undefined);
  const token = result.tokens[0].memory;
  assert.ok(token.swapInGB > 0.8, `swapIn=${token.swapInGB}`);
  assert.ok(Math.abs(token.swapOutGB - token.swapInGB) < 0.001,
    `swapIn=${token.swapInGB} swapOut=${token.swapOutGB}`);
  assert.ok(Math.abs(token.pendingSwapOutGB - token.swapOutGB) < 1e-9,
    `pending=${token.pendingSwapOutGB} swapOut=${token.swapOutGB}`);
});

test('REQ-006: swap-in bytes contribute once to Colibri DRAM traffic', () => {
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    output: 2,
    context: 60_000,
    host: 16,
    layers: 1,
    experts: 1,
    active: 1,
    pinned: 0.02,
    resident: 0,
    dcache: 0,
    pf: false,
    kvKB: 182,
    attn: 0,
    ems: 0,
    dramBW: 1_000_000,
    mem: memoryPolicy({
      policy: 'swap',
      minHeadroomGB: 0,
      soft: 0.7,
      compress: 0.72,
      swap: 0.75,
      hard: 0.99,
      swapEnabled: true,
      swapCapacityGB: 128,
      kvTouchFraction: 1
    })
  }));
  assert.equal(result.error, undefined);
  const token = result.tokens[0].memory;
  assert.ok(token.swapInGB > 0 && token.swapOutGB > 0);
  const activeWeightGB = 19 / 1024;
  const expected = activeWeightGB + token.kvResidentGB + token.swapInGB + token.swapOutGB;
  assert.ok(Math.abs(token.dramTrafficGB - expected) < 1e-9, `${token.dramTrafficGB} != ${expected}`);
});

test('P0: AFM pipelined overlap requires double buffering', () => {
  const base = afmConfig({
    output: 33,
    context: 1,
    freq: 32,
    layers: 4,
    hidden: 1536,
    active: 2,
    shared: 0,
    routed: 2,
    expertWidth: 10_000,
    activeDim: 20_000,
    projections: 3,
    chunks: 2,
    ffn: 10,
    patchBase: 2,
    patchBW: 0.2,
    chunkMode: 'pipelined',
    overlap: 0,
    doubleBuffer: true,
    host: 512,
    ssdBW: 0.2,
    dramBW: 1_000_000,
    mem: memoryPolicy({ policy: 'strict', hard: 1 })
  });
  const buffered = simulator.simulateAFM(base);
  const unbuffered = simulator.simulateAFM({ ...base, doubleBuffer: false });
  assert.equal(buffered.error, undefined);
  assert.equal(unbuffered.error, undefined);
  assert.ok(unbuffered.boundaryTPOT > buffered.boundaryTPOT,
    `unbuffered=${unbuffered.boundaryTPOT} buffered=${buffered.boundaryTPOT}`);
});

test('REQ-006: swap-in bytes contribute once to AFM DRAM traffic', () => {
  const result = simulator.simulateAFM(afmConfig());
  assert.equal(result.error, undefined);
  const token = result.tokens[0].memory;
  assert.ok(token.swapInGB > 0 && token.swapOutGB > 0);
  const expected = result.d.activeGB + token.kvResidentGB + token.swapInGB + token.swapOutGB;
  assert.ok(Math.abs(token.dramTrafficGB - expected) < 1e-9, `${token.dramTrafficGB} != ${expected}`);
});

test('REQ-004: storage-bound TTFT improves with SSD bandwidth', () => {
  const base = colibriConfig({
    prompt: 32,
    output: 1,
    layers: 4,
    experts: 64,
    active: 4,
    pinned: 0,
    dcache: 0,
    resident: 0,
    kvKB: 0,
    pf: false,
    qd: 64,
    lat: 0,
    ssdBW: 0.5,
    dramBW: 1_000_000,
    attn: 0,
    ems: 0,
    par: 4,
    prefillSpeedup: 1000
  });
  const slow = simulator.simulateColibri(base);
  const fast = simulator.simulateColibri({ ...base, ssdBW: 5 });
  assert.ok(fast.ttft < slow.ttft / 5, `${slow.ttft} -> ${fast.ttft}`);
  assert.ok(fast.prefillBreakdown.storageMs < slow.prefillBreakdown.storageMs);
});

test('REQ-004: transfer-bound TTFT improves with PCIe bandwidth', () => {
  const base = colibriConfig({
    prompt: 32,
    output: 1,
    arch: 'discrete',
    layers: 4,
    experts: 64,
    active: 4,
    pinned: 5,
    vram: 0.8,
    vcache: 0,
    dcache: 0,
    resident: 0,
    kvKB: 0,
    pf: false,
    pcieBW: 1,
    dramBW: 1_000_000,
    attn: 0,
    ems: 0,
    par: 4,
    prefillSpeedup: 1000
  });
  const slow = simulator.simulateColibri(base);
  const fast = simulator.simulateColibri({ ...base, pcieBW: 10 });
  assert.equal(slow.prefillBreakdown.storageGB, 0);
  assert.ok(fast.ttft < slow.ttft / 5, `${slow.ttft} -> ${fast.ttft}`);
  assert.ok(fast.prefillBreakdown.transferMs < slow.prefillBreakdown.transferMs);
});

test('P0: 30-scenario invariant matrix preserves finite metrics and resource bounds', () => {
  for (let index = 0; index < 30; index++) {
    const experts = [8, 32, 64][index % 3];
    const qd = [1, 2, 8][Math.floor(index / 3) % 3];
    const ssdBW = [0.2, 1, 9.2][Math.floor(index / 9) % 3];
    const config = colibriConfig({
      seed: 10_000 + index,
      prompt: index % 2 ? 0 : 8,
      output: 4,
      layers: 2,
      experts,
      active: Math.min(4, experts),
      pinned: 0,
      dcache: index % 4,
      vcache: 0,
      pf: index % 2 === 0,
      prefetchPolicy: 'previous-token',
      qd,
      ssdBW,
      host: 128,
      dramBW: [20, 100, 273][index % 3],
      mem: memoryPolicy({ policy: 'reclaim', hard: 1 })
    });
    const result = simulator.simulateColibri(config);
    assert.equal(result.error, undefined, `scenario ${index}: ${result.error}`);
    assert.equal(result.tokens.length, 4);
    for (const token of result.tokens) {
      for (const value of [token.tpot, token.ssdGB, token.memory.physicalUsedGB, token.memory.dramTrafficGB]) {
        assert.ok(Number.isFinite(value) && value >= 0, `scenario ${index}: ${value}`);
      }
      assert.ok(token.memory.dramUtilization <= 1 + 1e-9, `scenario ${index}: DRAM ${token.memory.dramUtilization}`);
      assert.ok(token.memory.swapGB <= config.mem.swapCapacityGB + 1e-9, `scenario ${index}: swap ${token.memory.swapGB}`);
    }
    assert.ok(result.observed <= config.ssdBW + 1e-6, `scenario ${index}: SSD ${result.observed}/${config.ssdBW}`);
  }
});

test('REQ-004: DRAM-bound TTFT and TPS improve with DRAM bandwidth', () => {
  const base = colibriConfig({
    prompt: 32,
    output: 3,
    layers: 4,
    experts: 64,
    active: 4,
    pinned: 5,
    resident: 0,
    kvKB: 0,
    pf: false,
    dramBW: 1,
    attn: 0,
    ems: 0,
    par: 4,
    prefillSpeedup: 1000
  });
  const slow = simulator.simulateColibri(base);
  const fast = simulator.simulateColibri({ ...base, dramBW: 10 });
  assert.ok(fast.ttft < slow.ttft / 5, `${slow.ttft} -> ${fast.ttft}`);
  assert.ok(fast.tps > slow.tps * 5, `${slow.tps} -> ${fast.tps}`);
});
