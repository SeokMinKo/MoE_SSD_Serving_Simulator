'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadBigMoeConfig() {
  const source = fs.readFileSync(path.join(root, 'bigmoe-config.js'), 'utf8') +
    '\nglobalThis.__bigmoe = { validateBigMoeEdgeConfig, bigMoeEdgePreset };';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'bigmoe-config.js' });
  return sandbox.__bigmoe;
}

function canonicalConfig() {
  return {
    mode: 'bigmoe-edge', prompt: 128, output: 64, context: 4096, conc: 1, seed: 260730,
    host: 11.3, dramBW: 60, ssdBW: 1.3, lat: 120,
    mem: {
      policy: 'strict', backgroundGB: 2, osReservedGB: 2, minHeadroomGB: 1.5,
      soft: 0.8, compress: 0.85, swap: 0.9, hard: 0.97,
      compressionEnabled: false, compressionRatio: 1, compressionBW: 0,
      swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 0, kvTouchFraction: 1
    },
    model: {
      arch: 'qwen3moe', layers: 48, experts: 128, active: 8,
      expertProjectionMiB: [0.88, 0.88, 0.88], denseResidentGB: 2.2,
      kvKB: 182, quantization: 'Q4_K_M', sharedExpertGB: 0
    },
    runtime: {
      threads: 4, referenceThreads: 4, threadScalingExponent: 0.8,
      ioThreads: 4, odirect: true, execution: 'serial',
      cacheMode: 'fixed', cacheMiB: 4000, denseWeights: 'anon',
      attentionMs: 40, expertMs: 2.5, prefillTPS: 12,
      managementMs: 0.5, loopOverheadMs: 0.2
    },
    calibration: {
      source: 'manual', engineVersion: 'unknown', sourceCommit: 'manual',
      deviceLabel: 'manual profile', measured: false
    }
  };
}

test('BigMoEEdge accepts the canonical CPU-only serial configuration', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const result = validateBigMoeEdgeConfig(canonicalConfig());

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('BigMoEEdge rejects unknown root fields instead of silently ignoring them', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const result = validateBigMoeEdgeConfig({ ...canonicalConfig(), gpu: true });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_FIELD');
  assert.equal(result.errors[0].path, 'gpu');
});

test('BigMoEEdge rejects request concurrency above one', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const result = validateBigMoeEdgeConfig({ ...canonicalConfig(), conc: 2 });

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'UNSUPPORTED_CONCURRENCY');
  assert.equal(result.errors[0].path, 'conc');
});

test('BigMoEEdge v1 rejects fork-only overlap execution', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const config = canonicalConfig();
  config.runtime.execution = 'overlap';
  const result = validateBigMoeEdgeConfig(config);

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'UNSUPPORTED_EXECUTION');
  assert.equal(result.errors[0].path, 'runtime.execution');
});

test('BigMoEEdge rejects active Experts above the architecture Expert count', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const config = canonicalConfig();
  config.model.active = 129;
  const result = validateBigMoeEdgeConfig(config);

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'INVALID_RELATION');
  assert.equal(result.errors[0].path, 'model.active');
});

test('BigMoEEdge Qwen3 preset is a valid explicit unmeasured profile', () => {
  const { validateBigMoeEdgeConfig, bigMoeEdgePreset } = loadBigMoeConfig();
  const preset = bigMoeEdgePreset();
  const result = validateBigMoeEdgeConfig(preset);

  assert.equal(result.valid, true);
  assert.equal(preset.mode, 'bigmoe-edge');
  assert.equal(preset.model.arch, 'qwen3moe');
  assert.equal(preset.calibration.measured, false);
});

test('BigMoEEdge binary projection and cache fields use explicit MiB names', () => {
  const { validateBigMoeEdgeConfig, bigMoeEdgePreset } = loadBigMoeConfig();
  const preset = bigMoeEdgePreset();

  assert.deepEqual(Array.from(preset.model.expertProjectionMiB), [1.575, 1.575, 1.575]);
  assert.equal(preset.model.expertProjectionMB, undefined);
  assert.equal(preset.runtime.cacheMiB, 4000);
  assert.equal(preset.runtime.cacheMB, undefined);

  const legacy = bigMoeEdgePreset();
  legacy.model.expertProjectionMB = [1, 1, 1];
  legacy.runtime.cacheMB = 1000;
  const result = validateBigMoeEdgeConfig(legacy);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(error => error.path === 'model.expertProjectionMB'), true);
  assert.equal(result.errors.some(error => error.path === 'runtime.cacheMB'), true);
});

test('BigMoEEdge CPU thread sensitivity names its reference and bounded scaling assumption', () => {
  const { validateBigMoeEdgeConfig, bigMoeEdgePreset } = loadBigMoeConfig();
  const preset = bigMoeEdgePreset();
  assert.equal(preset.runtime.referenceThreads, 4);
  assert.equal(preset.runtime.threadScalingExponent, 0.8);

  preset.runtime.referenceThreads = 0;
  preset.runtime.threadScalingExponent = 1.1;
  const result = validateBigMoeEdgeConfig(preset);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some(error => error.path === 'runtime.referenceThreads'), true);
  assert.equal(result.errors.some(error => error.path === 'runtime.threadScalingExponent'), true);
});

test('BigMoEEdge exact schema rejects unknown fields in every nested contract', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  for (const section of ['mem', 'model', 'runtime', 'calibration']) {
    const config = canonicalConfig();
    config[section].unexpected = true;
    const result = validateBigMoeEdgeConfig(config);
    assert.equal(result.valid, false, section);
    assert.equal(result.errors.some(error => error.code === 'UNKNOWN_FIELD' && error.path === `${section}.unexpected`), true, section);
  }
});

test('BigMoEEdge rejects malformed scalar, enum, and range inputs fail-closed', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const cases = [
    ['mode', config => { config.mode = 'colibri'; }],
    ['prompt', config => { config.prompt = -1; }],
    ['output', config => { config.output = 0; }],
    ['context', config => { config.context = 0; }],
    ['seed', config => { config.seed = 1.5; }],
    ['host', config => { config.host = 0; }],
    ['dramBW', config => { config.dramBW = Number.NaN; }],
    ['ssdBW', config => { config.ssdBW = 0; }],
    ['lat', config => { config.lat = -1; }],
    ['model.layers', config => { config.model.layers = 0; }],
    ['model.experts', config => { config.model.experts = 0; }],
    ['model.active', config => { config.model.active = 0; }],
    ['model.expertProjectionMiB', config => { config.model.expertProjectionMiB = [1, -1, 1]; }],
    ['runtime.threads', config => { config.runtime.threads = 0; }],
    ['runtime.ioThreads', config => { config.runtime.ioThreads = 9; }],
    ['runtime.cacheMode', config => { config.runtime.cacheMode = 'probability'; }],
    ['runtime.denseWeights', config => { config.runtime.denseWeights = 'gpu'; }],
    ['runtime.prefillTPS', config => { config.runtime.prefillTPS = 0; }],
    ['calibration.measured', config => { config.calibration.measured = 'yes'; }]
  ];
  for (const [path, mutate] of cases) {
    const config = canonicalConfig();
    mutate(config);
    const result = validateBigMoeEdgeConfig(config);
    assert.equal(result.valid, false, path);
    assert.equal(result.errors.some(error => error.path === path), true, path);
  }
});

test('BigMoEEdge requires semantic identity provenance and ordered memory thresholds', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const cases = [
    ['model.arch', config => { delete config.model.arch; }],
    ['model.quantization', config => { config.model.quantization = ''; }],
    ['calibration.source', config => { config.calibration.source = 7; }],
    ['calibration.engineVersion', config => { config.calibration.engineVersion = ''; }],
    ['calibration.sourceCommit', config => { delete config.calibration.sourceCommit; }],
    ['calibration.deviceLabel', config => { config.calibration.deviceLabel = ''; }],
    ['mem.thresholds', config => { config.mem.compress = config.mem.soft - 0.1; }]
  ];
  for (const [path, mutate] of cases) {
    const config = canonicalConfig();
    mutate(config);
    const result = validateBigMoeEdgeConfig(config);
    assert.equal(result.valid, false, `${path} must fail closed`);
    assert.equal(result.errors.some(error => path === 'mem.thresholds'
      ? error.code === 'INVALID_RELATION' && error.path === path
      : error.path === path), true, `${path} must identify the rejected contract`);
  }
});

test('BigMoEEdge serial v1 rejects unmodeled reclaim swap compression and file-backed dense semantics', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const cases = [
    ['mem.policy', config => { config.mem.policy = 'reclaim'; }],
    ['mem.compressionEnabled', config => { config.mem.compressionEnabled = true; }],
    ['mem.swapEnabled', config => { config.mem.swapEnabled = true; }],
    ['runtime.denseWeights', config => { config.runtime.denseWeights = 'mmap'; }]
  ];
  for (const [path, mutate] of cases) {
    const config = canonicalConfig();
    mutate(config);
    const result = validateBigMoeEdgeConfig(config);
    assert.equal(result.valid, false, path);
    assert.ok(result.errors.some(error => error.path === path && error.code === 'UNSUPPORTED_SEMANTICS'), path);
  }
});

test('BigMoEEdge rejects unsupported identity enums, incoherent cache capacity, and excessive decode work', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const cases = [
    ['model.quantization', config => { config.model.quantization = 'fabricated'; }],
    ['calibration.source', config => { config.calibration.source = 'fabricated'; }],
    ['runtime.cacheMiB', config => { config.runtime.cacheMode = 'off'; config.runtime.cacheMiB = 1; }],
    ['runtime.cacheMiB', config => { config.runtime.cacheMode = 'fixed'; config.runtime.cacheMiB = 0; }],
    ['runtime.work', config => { config.output = 1024; config.model.layers = 1024; config.model.active = 128; config.model.experts = 128; }]
  ];
  for (const [path, mutate] of cases) {
    const config = canonicalConfig();
    mutate(config);
    const result = validateBigMoeEdgeConfig(config);
    assert.equal(result.valid, false, path);
    assert.equal(result.errors.some(error => error.path === path), true, path);
  }
});

test('BigMoEEdge rejects unsupported architecture and finite values that can overflow runtime arithmetic', () => {
  const { validateBigMoeEdgeConfig } = loadBigMoeConfig();
  const cases = [
    ['model.arch', config => { config.model.arch = 'fabricated-arch'; }],
    ['model.expertProjectionMiB', config => { config.model.expertProjectionMiB = [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]; }],
    ['lat', config => { config.lat = Number.MAX_VALUE; }],
    ['ssdBW', config => { config.ssdBW = Number.MIN_VALUE; }],
    ['dramBW', config => { config.dramBW = Number.MIN_VALUE; }],
    ['runtime.prefillTPS', config => { config.runtime.prefillTPS = Number.MIN_VALUE; }]
  ];
  for (const [path, mutate] of cases) {
    const config = canonicalConfig();
    mutate(config);
    const result = validateBigMoeEdgeConfig(config);
    assert.equal(result.valid, false, path);
    assert.ok(result.errors.some(error => error.path === path), path);
  }
});
