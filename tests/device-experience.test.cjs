'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const files = ['core.js', 'compute.js', 'config.js', 'compute-placement.js', 'memory.js', 'colibri.js', 'afm.js', 'serving.js', 'serving-device.js', 'advisor.js', 'sweep.js', 'device-experience.js'];
const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') +
  '\ninstallDevicePlacementModel(); installDeviceServingScheduler(); installDeviceExperienceModel(); globalThis.__sim={colibriLayerCompute,deriveColibriDeviceProfile,sweepCatalogForConfig,validateDeviceComputeConfig,simulateServing,simulateColibri,advisorPhaseResource,advisorQueueFraction,advisorTimedResources};';
const sandbox = { console, structuredClone };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'device-experience-bundle.js' });
const sim = sandbox.__sim;

function mem() {
  return { policy: 'strict', backgroundGB: 0, osReservedGB: 0, minHeadroomGB: 0, soft: 0.8, compress: 0.85, swap: 0.9, hard: 1, compressionEnabled: false, compressionRatio: 2, compressionBW: 25, swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 1, kvTouchFraction: 0 };
}

function config(overrides = {}) {
  return {
    mode: 'colibri', prompt: 0, output: 4, context: 1, conc: 1,
    arch: 'discrete', host: 128, vram: 16, dramBW: 1e6, pcieBW: 1e6, ssdBW: 1e6, lat: 0, seed: 260730,
    mem: mem(), cold: false, placement: 'manual', layers: 2, experts: 8, active: 4, esize: 20, resident: 0, kvKB: 0,
    vcache: 1, dcache: 1, minDCache: 0, expertBacking: 'file', pinned: 1, page: 0, odirect: true, corr: 0, qd: 8,
    attn: 20, ems: 10, par: 2, prefillSpeedup: 4, pf: false, prefetchPolicy: 'none', recall: 0, precision: 1, budget: 0,
    compute: {
      mode: 'calibrated', attentionDevice: 'gpu', expertDevice: 'hybrid',
      cpu: { speedScale: 1, attentionMs: 40, expertMs: 20, parallelExperts: 2, prefillSpeedup: 2 },
      gpu: { speedScale: 1, attentionMs: 20, expertMs: 10, parallelExperts: 2, prefillSpeedup: 4 },
      hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 }
    },
    quantization: {
      payloadMode: 'manual', format: 'int4', weightBits: 4, packing: 1, manualExpertMB: 20,
      cpuKernelMultiplier: 1, gpuKernelMultiplier: 1, dequantMode: 'fused', cpuDequantBW: 20, gpuDequantBW: 200
    },
    ...overrides
  };
}

test('device Sweep catalog exposes compute, quantization, and dequantization paths', () => {
  const paths = new Set(sim.sweepCatalogForConfig(config()).map(item => item.path));
  for (const path of ['compute.cpu.speedScale', 'compute.gpu.expertMs', 'compute.hybrid.cpuExpertFraction', 'quantization.weightBits', 'quantization.dequantMode', 'quantization.gpuDequantBW']) {
    assert.ok(paths.has(path), path);
  }
});

test('separate dequantization adds calibrated device time with correct MB/GBps units', () => {
  const fusedConfig = config();
  const separateConfig = config({ quantization: { ...fusedConfig.quantization, dequantMode: 'separate' } });
  const fusedProfile = sim.deriveColibriDeviceProfile(fusedConfig);
  const separateProfile = sim.deriveColibriDeviceProfile(separateConfig);
  const fused = sim.colibriLayerCompute(fusedConfig, fusedProfile, 2, 2, false);
  const separate = sim.colibriLayerCompute(separateConfig, separateProfile, 2, 2, false);
  assert.equal(separate.cpuDequantMs, 2);
  assert.equal(separate.gpuDequantMs, 0.2);
  assert.ok(separate.totalMs > fused.totalMs);
});

test('fused dequantization preserves the PR2 compute equation', () => {
  const c = config();
  const profile = sim.deriveColibriDeviceProfile(c);
  const result = sim.colibriLayerCompute(c, profile, 2, 2, false);
  assert.equal(result.dequantMs, undefined);
});

test('invalid separate dequantization bandwidth fails closed', () => {
  const c = config({ quantization: { ...config().quantization, dequantMode: 'separate', cpuDequantBW: 0 } });
  const validation = sim.validateDeviceComputeConfig(c);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.path === 'quantization.cpuDequantBW'));
});

test('explicit empty dequantization mode fails closed', () => {
  const c = config({ quantization: { ...config().quantization, dequantMode: '' } });

  const validation = sim.validateDeviceComputeConfig(c);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.path === 'quantization.dequantMode'));
  const nullMode = config({ quantization: { ...config().quantization, dequantMode: null } });
  assert.equal(sim.validateDeviceComputeConfig(nullMode).valid, false);
});

test('separate CPU dequantization contributes to CPU serving work', () => {
  const fused = config({ conc: 2 });
  const separate = config({ conc: 2, quantization: { ...fused.quantization, dequantMode: 'separate', cpuDequantBW: 2 } });
  const requests = [{ id: 'a', arrivalMs: 0, output: 4 }, { id: 'b', arrivalMs: 1, output: 4 }];
  const fusedServing = sim.simulateServing(fused, requests, { batchWindowMs: 0 });
  const separateServing = sim.simulateServing(separate, requests, { batchWindowMs: 0 });
  assert.ok(separateServing.resources.cpuCompute.busyMs > fusedServing.resources.cpuCompute.busyMs);
  assert.ok(separateServing.throughputTPS < fusedServing.throughputTPS);
});

test('device Advisor aggregates CPU and GPU compute resource-time consistently', () => {
  const serving = {
    resources: {
      cpuCompute: { phases: { decode: { jobs: 2, busyMs: 30, queueMs: 10 } } },
      gpuCompute: { phases: { decode: { jobs: 3, busyMs: 20, queueMs: 5 } } }
    }
  };

  const aggregate = sim.advisorPhaseResource(serving, 'compute', 'decode');

  assert.equal(aggregate.jobs, 5);
  assert.equal(aggregate.busyMs, 50);
  assert.equal(aggregate.queueMs, 15);
  assert.equal(sim.advisorQueueFraction(serving, 'compute', 'decode'), 15 / 65);
});

test('device Advisor scores compute pressure from the same aggregate evidence', () => {
  const serving = {
    resources: {
      cpuCompute: { phases: { decode: { jobs: 1, busyMs: 1, queueMs: 1 } } },
      gpuCompute: { phases: { decode: { jobs: 1, busyMs: 98, queueMs: 0 } } }
    }
  };

  const resources = sim.advisorTimedResources([], config(), 1000, 'colibri', {}, '', 'decode', serving);
  const compute = resources.find(resource => resource.id === 'compute');

  assert.equal(compute.score, 1);
  assert.equal(compute.recommendation.priority, 'Monitor');
  assert.equal(compute.evidence.find(item => item.label === 'Shared compute busy').value, 99);
  assert.equal(compute.evidence.find(item => item.label === 'Shared compute queue fraction').value, 1);
});
