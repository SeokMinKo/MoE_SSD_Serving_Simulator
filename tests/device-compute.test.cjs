'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadSimulator(install = true) {
  const source = ['core.js', 'config.js', 'memory.js', 'colibri.js', 'compute.js']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n') + `\n${install ? 'installDeviceComputeModel();' : ''}\n` +
    `globalThis.__simulator = { simulateColibri, validateSimulationConfig, applyColibriPlacement, deriveQuantizedExpertPayload, deriveColibriDeviceProfile, normalizeColibriDeviceConfig };`;
  const sandbox = { console, structuredClone, document: { getElementById: () => null } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'device-compute-bundle.js' });
  return sandbox.__simulator;
}

function memoryPolicy(overrides = {}) {
  return {
    policy: 'strict', backgroundGB: 0, osReservedGB: 0, minHeadroomGB: 0,
    soft: 0.8, compress: 0.85, swap: 0.9, hard: 1,
    compressionEnabled: false, compressionRatio: 1.6, compressionBW: 25,
    swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 0.7, kvTouchFraction: 1,
    ...overrides
  };
}

function colibriConfig(overrides = {}) {
  return {
    mode: 'colibri', prompt: 0, output: 4, context: 1, conc: 1,
    arch: 'discrete', host: 512, vram: 16, dramBW: 1_000_000,
    pcieBW: 1_000_000, ssdBW: 1_000_000, lat: 0, seed: 260730,
    mem: memoryPolicy(), cold: true, placement: 'manual', layers: 1,
    experts: 8, active: 4, esize: 20, resident: 0, kvKB: 0,
    vcache: 0, dcache: 0, minDCache: 0, expertBacking: 'file',
    pinned: 0, page: 0, odirect: true, corr: 0, qd: 8,
    attn: 20, ems: 10, par: 4, prefillSpeedup: 4,
    pf: false, prefetchPolicy: 'none', recall: 0, precision: 1, budget: 0,
    ...overrides
  };
}

function calibratedCompute(overrides = {}) {
  return {
    mode: 'calibrated', attentionDevice: 'gpu', expertDevice: 'gpu',
    cpu: { speedScale: 1, attentionMs: 40, expertMs: 20, parallelExperts: 4, prefillSpeedup: 2 },
    gpu: { speedScale: 1, attentionMs: 20, expertMs: 10, parallelExperts: 4, prefillSpeedup: 4 },
    hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 },
    ...overrides
  };
}

function manualQuantization(overrides = {}) {
  return {
    payloadMode: 'manual', format: 'custom', weightBits: 4, packing: 1,
    manualExpertMB: 20, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1,
    ...overrides
  };
}

function summary(result) {
  return {
    error: result.error || null,
    avg: result.avg,
    tps: result.tps,
    ttft: result.ttft,
    agg: result.agg,
    pcieGB: result.tot?.pcieGB,
    demandGB: result.tot?.demandGB,
    esize: result.c?.esize,
    vcache: result.c?.vcache
  };
}

test('PR1: legacy Colibri results remain unchanged when the device model is installed', () => {
  const config = colibriConfig();
  assert.deepEqual(summary(loadSimulator(false).simulateColibri(config)), summary(loadSimulator(true).simulateColibri(config)));
});

test('PR1: derived quantization changes Expert payload without inferring kernel speed', () => {
  const simulator = loadSimulator(true);
  const eightBit = simulator.simulateColibri(colibriConfig({
    quantization: { payloadMode: 'derived', format: 'int8', weightBits: 8, packing: 1, expertParamsM: 16, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1 }
  }));
  const fourBit = simulator.simulateColibri(colibriConfig({
    quantization: { payloadMode: 'derived', format: 'int4', weightBits: 4, packing: 1, expertParamsM: 16, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1 }
  }));
  assert.equal(eightBit.c.esize, 16);
  assert.equal(fourBit.c.esize, 8);
  assert.ok(Math.abs(fourBit.tot.demandGB / eightBit.tot.demandGB - 0.5) < 1e-12);
});

test('PR2: CPU-only Expert execution creates no PCIe Expert traffic on a discrete system', () => {
  const simulator = loadSimulator(true);
  const result = simulator.simulateColibri(colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'cpu' }),
    quantization: manualQuantization()
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.tot.pcieGB, 0);
  assert.ok(result.tokens.every(token => token.pcieGB === 0));
  assert.equal(result.computeProfile.cpuActive, 4);
  assert.equal(result.computeProfile.gpuActive, 0);
});

test('PR2: GPU speed scale improves a compute-bound Colibri scenario', () => {
  const simulator = loadSimulator(true);
  const base = colibriConfig({ pinned: 10, compute: calibratedCompute(), quantization: manualQuantization() });
  const normal = simulator.simulateColibri(base);
  const fast = simulator.simulateColibri({
    ...base,
    compute: { ...base.compute, gpu: { ...base.compute.gpu, speedScale: 2 } }
  });
  assert.ok(fast.tps > normal.tps * 1.7);
});

test('PR2: Hybrid endpoint fractions match GPU-only and CPU-only execution', () => {
  const simulator = loadSimulator(true);
  const quantization = manualQuantization();
  const gpuOnly = simulator.simulateColibri(colibriConfig({ compute: calibratedCompute({ expertDevice: 'gpu' }), quantization }));
  const hybridGpu = simulator.simulateColibri(colibriConfig({
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0, execution: 'parallel', overlapEfficiency: 1 } }), quantization
  }));
  const cpuOnly = simulator.simulateColibri(colibriConfig({ compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'cpu' }), quantization }));
  const hybridCpu = simulator.simulateColibri(colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 1, execution: 'parallel', overlapEfficiency: 1 } }), quantization
  }));
  assert.deepEqual(summary(hybridGpu), summary(gpuOnly));
  assert.deepEqual(summary(hybridCpu), summary(cpuOnly));
});

test('PR2: Parallel Hybrid execution is no slower than sequential execution', () => {
  const simulator = loadSimulator(true);
  const quantization = manualQuantization();
  const parallel = simulator.simulateColibri(colibriConfig({
    pinned: 10,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 } }),
    quantization
  }));
  const sequential = simulator.simulateColibri(colibriConfig({
    pinned: 10,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'sequential', overlapEfficiency: 1 } }),
    quantization
  }));
  assert.ok(parallel.tps >= sequential.tps);
  assert.ok(parallel.computeProfile.effectiveExpertPhaseMs < sequential.computeProfile.effectiveExpertPhaseMs);
});

test('PR2: calibrated auto placement is idempotent and records requested versus effective VRAM cache', () => {
  const simulator = loadSimulator(true);
  const config = colibriConfig({
    placement: 'auto', vcache: 0, dcache: 0,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 } }),
    quantization: manualQuantization()
  });
  const once = simulator.applyColibriPlacement(config);
  const twice = simulator.applyColibriPlacement(once);
  assert.equal(twice.vcache, once.vcache);
  assert.equal(once.placementInfo.effectiveVcacheGB, once.vcache);
  assert.ok(once.placementInfo.requestedVcacheGB >= once.placementInfo.effectiveVcacheGB);
});

test('PR1: invalid calibrated compute settings fail closed', () => {
  const simulator = loadSimulator(true);
  const invalid = colibriConfig({
    compute: calibratedCompute({ gpu: { speedScale: 0, attentionMs: 20, expertMs: 10, parallelExperts: 4, prefillSpeedup: 4 } }),
    quantization: manualQuantization()
  });
  const result = simulator.simulateColibri(invalid);
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'compute.gpu.speedScale'));
});
