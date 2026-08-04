'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = ['core.js', 'compute.js', 'config.js', 'compute-placement.js', 'memory.js', 'colibri.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n') + `\nglobalThis.__simulator = { simulateColibri, deriveColibriDeviceProfile, applyColibriPlacement, colibriAssignedGpuExperts };`;
const sandbox = { console, structuredClone, document: { getElementById: () => null, addEventListener: () => {}, readyState: 'complete' } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'device-compute-edge-bundle.js' });
const simulator = sandbox.__simulator;

function mem(overrides = {}) {
  return {
    policy: 'strict', backgroundGB: 0, osReservedGB: 0, minHeadroomGB: 0,
    soft: 0.8, compress: 0.85, swap: 0.9, hard: 1,
    compressionEnabled: false, compressionRatio: 2, compressionBW: 1,
    swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 1, kvTouchFraction: 1,
    ...overrides
  };
}

function compute(overrides = {}) {
  return {
    mode: 'calibrated', attentionDevice: 'gpu', expertDevice: 'gpu',
    cpu: { speedScale: 1, attentionMs: 40, expertMs: 20, parallelExperts: 4, prefillSpeedup: 2 },
    gpu: { speedScale: 1, attentionMs: 20, expertMs: 10, parallelExperts: 4, prefillSpeedup: 4 },
    hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 },
    ...overrides
  };
}

function quant(overrides = {}) {
  return {
    payloadMode: 'manual', format: 'int4', weightBits: 4, packing: 1,
    manualExpertMB: 0.001, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1,
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    mode: 'colibri', prompt: 0, output: 1, context: 1, conc: 1,
    arch: 'discrete', host: 64, vram: 8, dramBW: 1_000_000,
    pcieBW: 1_000_000, ssdBW: 1_000_000, lat: 0, seed: 260730,
    mem: mem(), cold: true, placement: 'manual', layers: 1,
    experts: 1, active: 1, esize: 0.001, resident: 0, kvKB: 0,
    vcache: 0, dcache: 0, minDCache: 0, expertBacking: 'file',
    pinned: 0.01, page: 0, odirect: true, corr: 0, qd: 1,
    attn: 20, ems: 10, par: 1, prefillSpeedup: 4,
    pf: false, prefetchPolicy: 'none', recall: 0, precision: 1, budget: 0,
    compute: compute(), quantization: quant(),
    ...overrides
  };
}

test('CPU-only discrete execution requires no GPU VRAM reserve', () => {
  const result = simulator.simulateColibri(config({
    vram: 0,
    compute: compute({ attentionDevice: 'cpu', expertDevice: 'cpu' })
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.state.deviceKVGB, 0);
  assert.equal(result.state.peakDeviceGB, 0);
});

test('Expert quantization multiplier does not modify Attention calibration', () => {
  const base = config();
  const one = simulator.deriveColibriDeviceProfile(base);
  const two = simulator.deriveColibriDeviceProfile({
    ...base,
    quantization: quant({ gpuKernelMultiplier: 2 })
  });
  assert.equal(two.gpu.effectiveAttentionMs, one.gpu.effectiveAttentionMs);
  assert.equal(two.gpu.effectiveExpertMs, one.gpu.effectiveExpertMs * 2);
});

test('compressed KV touch CPU time is charged once in Colibri TPOT', () => {
  const result = simulator.simulateColibri(config({
    host: 5,
    context: 1000,
    kvKB: 1000,
    compute: compute({ attentionDevice: 'cpu', expertDevice: 'cpu', cpu: { speedScale: 1, attentionMs: 0, expertMs: 0, parallelExperts: 1, prefillSpeedup: 1 } }),
    mem: mem({
      policy: 'swap', soft: 0.6, compress: 0.7, swap: 0.95, hard: 1,
      compressionEnabled: true, compressionRatio: 2, compressionBW: 1,
      swapEnabled: false
    })
  }));
  assert.equal(result.error, undefined);
  assert.ok(result.tokens[0].memoryCpuMs > 900 && result.tokens[0].memoryCpuMs < 1100);
  assert.ok(result.tokens[0].tpot > 900 && result.tokens[0].tpot < 1500,
    `touch decompression appears duplicated: ${result.tokens[0].tpot}ms`);
});

test('Hybrid auto placement caps VRAM cache at the GPU-assigned Expert pool', () => {
  const input = config({
    placement: 'auto',
    layers: 2,
    experts: 10,
    active: 2,
    pinned: 0,
    vcache: 0,
    dcache: 0,
    compute: compute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.6, execution: 'parallel', overlapEfficiency: 1 } })
  });
  const profile = simulator.deriveColibriDeviceProfile(input);
  const placed = simulator.applyColibriPlacement(input);
  const expertPoolGB = input.layers * input.experts * input.esize * 1.03 / 1000;
  const expectedGpuPoolGB = expertPoolGB * simulator.colibriAssignedGpuExperts(profile) / input.experts;
  assert.ok(Math.abs(placed.vcache - expectedGpuPoolGB) < 1e-12);
  assert.equal(placed.placementInfo.vcacheGB, placed.vcache);
});

test('Hybrid warm VRAM cache fills every GPU-assigned Expert that fits', () => {
  const input = config({
    cold: false,
    layers: 1,
    experts: 10,
    active: 2,
    pinned: 0,
    dcache: 0.01,
    compute: compute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.6, execution: 'parallel', overlapEfficiency: 1 } })
  });
  const profile = simulator.deriveColibriDeviceProfile(input);
  const gpuExperts = simulator.colibriAssignedGpuExperts(profile);
  input.vcache = gpuExperts * input.esize * 1.03 / 1000;
  const result = simulator.simulateColibri(input);
  assert.equal(result.error, undefined);
  assert.equal(result.cacheState.v[0].length, gpuExperts);
  assert.deepEqual(result.cacheState.v[0], Array.from({ length: gpuExperts }, (_, expert) => expert));
});
