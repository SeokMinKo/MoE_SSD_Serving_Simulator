'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const files = ['core.js', 'compute.js', 'config.js', 'compute-placement.js', 'memory.js', 'colibri.js', 'afm.js', 'serving.js', 'serving-device.js'];
const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') +
  '\ninstallDevicePlacementModel(); installDeviceServingScheduler(); globalThis.__sim={simulateColibri,simulateServing};';
const sandbox = { console, structuredClone, document: { getElementById: () => null, addEventListener: () => {}, readyState: 'complete' } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'device-serving-bundle.js' });
const sim = sandbox.__sim;

function mem() {
  return {
    policy: 'strict', backgroundGB: 0, osReservedGB: 0, minHeadroomGB: 0,
    soft: 0.8, compress: 0.85, swap: 0.9, hard: 1,
    compressionEnabled: false, compressionRatio: 2, compressionBW: 25,
    swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 1, kvTouchFraction: 0
  };
}

function compute(overrides = {}) {
  return {
    mode: 'calibrated', attentionDevice: 'gpu', expertDevice: 'gpu',
    cpu: { speedScale: 1, attentionMs: 40, expertMs: 20, parallelExperts: 2, prefillSpeedup: 2 },
    gpu: { speedScale: 1, attentionMs: 20, expertMs: 10, parallelExperts: 2, prefillSpeedup: 4 },
    hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 },
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    mode: 'colibri', prompt: 0, output: 6, context: 1, conc: 1,
    arch: 'discrete', host: 128, vram: 16, dramBW: 1_000_000,
    pcieBW: 1_000_000, ssdBW: 1_000_000, lat: 0, seed: 260730,
    mem: mem(), cold: false, placement: 'manual', layers: 2,
    experts: 8, active: 4, esize: 0.001, resident: 0, kvKB: 0,
    vcache: 1, dcache: 1, minDCache: 0, expertBacking: 'file',
    pinned: 1, page: 0, odirect: true, corr: 0, qd: 8,
    attn: 20, ems: 10, par: 2, prefillSpeedup: 4,
    pf: false, prefetchPolicy: 'none', recall: 0, precision: 1, budget: 0,
    compute: compute(),
    quantization: { payloadMode: 'manual', format: 'custom', weightBits: 4, packing: 1, manualExpertMB: 0.001, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1 },
    ...overrides
  };
}

function requests(count, output = 6, spacingMs = 0) {
  return Array.from({ length: count }, (_, index) => ({ id: `r${index}`, arrivalMs: index * spacingMs, output }));
}

test('PR3: calibrated concurrency one preserves analytic TTFT', () => {
  const c = config();
  const analytic = sim.simulateColibri(c);
  const serving = sim.simulateServing(c, requests(1), { batchWindowMs: 0 });
  assert.equal(serving.schedulerSchema, 'device-serving/v1');
  assert.ok(Math.abs(serving.requests[0].ttftMs - analytic.ttft) < 1e-9);
});

test('PR3: CPU-only execution uses no GPU compute service', () => {
  const c = config({ conc: 4, compute: compute({ attentionDevice: 'cpu', expertDevice: 'cpu' }) });
  const serving = sim.simulateServing(c, requests(4, 6, 1), { batchWindowMs: 0 });
  assert.equal(serving.resources.gpuCompute.jobs, 0);
  assert.ok(serving.resources.cpuCompute.busyMs > 0);
  assert.ok(serving.resources.cpuCompute.queueMs > 0);
});

test('PR3: GPU-only execution uses no CPU compute service without memory CPU work', () => {
  const c = config({ conc: 4 });
  const serving = sim.simulateServing(c, requests(4, 6, 1), { batchWindowMs: 0 });
  assert.equal(serving.resources.cpuCompute.jobs, 0);
  assert.ok(serving.resources.gpuCompute.busyMs > 0);
  assert.ok(serving.resources.gpuCompute.queueMs > 0);
});

test('PR3: Hybrid parallel uses both resources and is faster than sequential', () => {
  const parallelConfig = config({
    conc: 4,
    compute: compute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 } })
  });
  const sequentialConfig = {
    ...parallelConfig,
    compute: compute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'sequential', overlapEfficiency: 1 } })
  };
  const parallel = sim.simulateServing(parallelConfig, requests(4));
  const sequential = sim.simulateServing(sequentialConfig, requests(4));
  assert.ok(parallel.resources.cpuCompute.busyMs > 0);
  assert.ok(parallel.resources.gpuCompute.busyMs > 0);
  assert.ok(parallel.makespanMs <= sequential.makespanMs + 1e-9);
});

test('PR3: slower CPU increases queueing and reduces throughput in CPU-bound serving', () => {
  const fastConfig = config({ conc: 6, compute: compute({ attentionDevice: 'cpu', expertDevice: 'cpu' }) });
  const slowConfig = {
    ...fastConfig,
    compute: compute({
      attentionDevice: 'cpu', expertDevice: 'cpu',
      cpu: { speedScale: 0.5, attentionMs: 40, expertMs: 20, parallelExperts: 2, prefillSpeedup: 2 }
    })
  };
  const staggered = requests(6, 6, 1);
  const fast = sim.simulateServing(fastConfig, staggered, { batchWindowMs: 0 });
  const slow = sim.simulateServing(slowConfig, staggered, { batchWindowMs: 0 });
  assert.ok(slow.resources.cpuCompute.queueMs > fast.resources.cpuCompute.queueMs);
  assert.ok(slow.throughputTPS < fast.throughputTPS);
  assert.ok(slow.resources.cpuCompute.utilization >= 0 && slow.resources.cpuCompute.utilization <= 1);
});
