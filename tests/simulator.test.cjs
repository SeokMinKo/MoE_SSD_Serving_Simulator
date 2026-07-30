'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = ['core.js', 'config.js', 'memory.js', 'colibri.js', 'afm.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n') + `
globalThis.__simulator = {
  StorageResource,
  simulateColibri,
  simulateAFM,
  afmDerived
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

test('REQ-001: fully pinned Experts issue no demand or prefetch reads', () => {
  const result = simulator.simulateColibri(colibriConfig());
  assert.equal(result.storageByKind['expert-demand-read'] || 0, 0);
  assert.equal(result.storageByKind['expert-prefetch-read'] || 0, 0);
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

test('Manual placement reports device OOM when the populated cache exceeds VRAM', () => {
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
  assert.match(result.error, /Device memory OOM/);
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
