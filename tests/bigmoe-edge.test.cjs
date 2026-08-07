'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadBigMoeEdge() {
  const source = ['bigmoe-config.js', 'bigmoe-cache.js', 'bigmoe-edge.js']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') +
    '\nglobalThis.__bigmoe = { simulateBigMoeEdge };';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'bigmoe-edge-bundle.js' });
  return sandbox.__bigmoe;
}

function tinyConfig(overrides = {}) {
  const config = {
    mode: 'bigmoe-edge', prompt: 0, output: 1, context: 128, conc: 1, seed: 7,
    host: 16, dramBW: 60, ssdBW: 1, lat: 0,
    mem: {
      policy: 'strict', backgroundGB: 0, osReservedGB: 0, minHeadroomGB: 0,
      soft: 0.8, compress: 0.85, swap: 0.9, hard: 1,
      compressionEnabled: false, compressionRatio: 1.6, compressionBW: 25,
      swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 0.7, kvTouchFraction: 1
    },
    model: {
      arch: 'qwen3moe', layers: 2, experts: 4, active: 2,
      expertProjectionMiB: [1, 2, 3], denseResidentGB: 1,
      kvKB: 1, quantization: 'Q4_K_M', sharedExpertGB: 0
    },
    runtime: {
      threads: 4, referenceThreads: 4, threadScalingExponent: 1,
      ioThreads: 2, odirect: false, execution: 'serial',
      cacheMode: 'off', cacheMiB: 0, denseWeights: 'anon',
      attentionMs: 0, expertMs: 0, prefillTPS: 10,
      managementMs: 0, loopOverheadMs: 0
    },
    calibration: {
      source: 'manual', engineVersion: 'test', sourceCommit: 'test',
      deviceLabel: 'test', measured: false
    }
  };
  return { ...config, ...overrides };
}

test('BigMoEEdge cache-off reads every routed GGUF projection slice exactly once', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const result = simulateBigMoeEdge(tinyConfig());

  assert.equal(result.error, undefined);
  assert.equal(result.tokens[0].requestedReadMiB, 24);
  assert.equal(result.tokens[0].alignedReadMiB, 24);
  assert.equal(result.readMiBPerToken, 24);
});

test('BigMoEEdge O_DIRECT rounds each projection read to a 4 KiB boundary', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig();
  config.model.expertProjectionMiB = [0.001, 0.001, 0.001];
  config.runtime.odirect = true;
  const result = simulateBigMoeEdge(config);

  assert.equal(result.tokens[0].requestedReadMiB, 0.012);
  assert.equal(result.tokens[0].alignedReadMiB, 0.046875);
});

test('BigMoEEdge converts explicit MiB traffic to exact bytes before applying decimal GB/s', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const result = simulateBigMoeEdge(tinyConfig());

  assert.equal(result.tokens[0].alignedReadMiB, 24);
  assert.equal(result.tokens[0].timing.storageBandwidthMs, 25.165824);
  assert.equal(result.decodeStorageGB, 0.025165824);
});

test('BigMoEEdge applies a DRAM roofline to routed Expert payload without adding it twice', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig();
  config.dramBW = 1;
  config.runtime.expertMs = 2;
  const result = simulateBigMoeEdge(config);
  const timing = result.tokens[0].timing;

  assert.equal(timing.expertDramMiB, 24);
  assert.equal(timing.expertDramMs, 25.165824);
  assert.equal(timing.expertKernelMs, 8);
  assert.equal(timing.expertPhaseMs, 25.165824);
  assert.equal(timing.wallMs, 50.331648);
  assert.equal(result.dramTrafficGB, 0.025165824);
  assert.equal(result.state.peakDramGBs, 1);
  assert.equal(result.state.totalDramStallMs, 17.165824);
  assert.equal(result.tokens[0].memory.dramStallMs, 17.165824);
});

test('BigMoEEdge thread sensitivity scales calibrated CPU phases without changing byte populations', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const baseline = tinyConfig();
  baseline.dramBW = 1e9;
  baseline.runtime.attentionMs = 4;
  baseline.runtime.expertMs = 2;
  const baselineResult = simulateBigMoeEdge(baseline);

  const reduced = tinyConfig();
  reduced.dramBW = 1e9;
  reduced.runtime.attentionMs = 4;
  reduced.runtime.expertMs = 2;
  reduced.runtime.threads = 2;
  const reducedResult = simulateBigMoeEdge(reduced);

  assert.equal(baselineResult.tokens[0].timing.threadScale, 1);
  assert.equal(reducedResult.tokens[0].timing.threadScale, 2);
  assert.equal(reducedResult.tokens[0].timing.attentionMs, 8);
  assert.equal(reducedResult.tokens[0].timing.expertKernelMs, 16);
  assert.equal(reducedResult.tokens[0].alignedReadMiB, baselineResult.tokens[0].alignedReadMiB);
  assert.equal(reducedResult.tokens[0].timing.expertDramMiB, baselineResult.tokens[0].timing.expertDramMiB);
});

test('BigMoEEdge serial decode charges storage lanes and CPU phases exactly once', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig({ prompt: 10, output: 2, lat: 1000 });
  config.runtime = {
    ...config.runtime,
    attentionMs: 5, expertMs: 2, prefillTPS: 5,
    managementMs: 1, loopOverheadMs: 0.5
  };
  const result = simulateBigMoeEdge(config);

  assert.ok(result.tokens[0].timing, 'serial timing breakdown must be present');
  assert.deepEqual(JSON.parse(JSON.stringify(result.tokens[0].timing)), {
    storageBandwidthMs: 25.165824,
    storageCommandMs: 6,
    threadScale: 1,
    attentionMs: 5,
    expertMs: 8,
    expertKernelMs: 8,
    expertDramMiB: 24,
    expertDramMs: 0.41943040000000004,
    expertPhaseMs: 8,
    managementMs: 2,
    loopOverheadMs: 0.5,
    wallMs: 46.665824
  });
  assert.equal(result.ttft, 2046.665824);
  assert.equal(result.avg, 46.665824);
});

test('BigMoEEdge fixed cache keeps a complete token working set warm', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig({ output: 2 });
  config.runtime.cacheMode = 'fixed';
  config.runtime.cacheMiB = 24;
  const result = simulateBigMoeEdge(config);

  assert.deepEqual(Array.from(result.tokens, token => token.requestedReadMiB), [24, 0]);
  assert.deepEqual(Array.from(result.tokens, token => token.cacheHits), [0, 4]);
  assert.equal(result.cacheHitPct, 50);
  assert.equal(result.cacheEvictions, 0);
});

test('BigMoEEdge cyclic LRU collapses to zero hits below one token working set', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig({ output: 2 });
  config.runtime.cacheMode = 'fixed';
  config.runtime.cacheMiB = 18;
  const result = simulateBigMoeEdge(config);

  assert.deepEqual(Array.from(result.tokens, token => token.requestedReadMiB), [24, 24]);
  assert.deepEqual(Array.from(result.tokens, token => token.cacheHits), [0, 0]);
  assert.equal(result.cacheHitPct, 0);
  assert.equal(result.cacheEvictions, 5);
});

test('BigMoEEdge fails closed before decode when resident demand exceeds host DRAM', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig({ host: 1 });
  config.model.denseResidentGB = 2;
  config.model.kvKB = 0;
  const result = simulateBigMoeEdge(config);

  assert.equal(result.errorCode, 'HOST_OOM');
  assert.equal(result.tokens.length, 0);
  assert.equal(result.requiredHostGB, 2);
});

test('BigMoEEdge emits renderer-compatible CPU/storage/memory traces with no GPU work', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const result = simulateBigMoeEdge(tinyConfig());
  const token = result.tokens[0];

  assert.equal(token.tpot, 25.5852544);
  assert.equal(token.ssdGB, 0.025165824);
  assert.equal(token.gpuMs, 0);
  assert.equal(token.pcieGB, 0);
  assert.equal(token.memory.physicalUsedGB, result.requiredHostGB);
  assert.equal(token.memory.swapGB, 0);
  assert.equal(result.state.peakPhysicalGB, result.requiredHostGB);
  assert.equal(result.state.swapStartToken, null);
  assert.equal(result.ssdPt, 0.025165824);
  assert.equal(result.hit, 0);
});

test('BigMoEEdge preserves unique routes at the maximum safe integer seed', () => {
  const { simulateBigMoeEdge } = loadBigMoeEdge();
  const config = tinyConfig();
  config.seed = Number.MAX_SAFE_INTEGER;
  config.model.layers = 2;
  config.model.experts = 128;
  config.model.active = 8;
  config.runtime.cacheMode = 'fixed';
  config.runtime.cacheMiB = 1024;
  const result = simulateBigMoeEdge(config);
  assert.equal(result.error, undefined);
  assert.equal(result.tokens[0].cacheHits, 0);
  assert.equal(result.tokens[0].cacheMisses, 16);
});
