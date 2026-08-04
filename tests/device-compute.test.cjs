'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadSimulator(includeRepro = false) {
  const files = ['core.js', 'compute.js', 'config.js', 'compute-placement.js', 'memory.js', 'colibri.js', 'afm.js'];
  if (includeRepro) files.push('serving.js', 'serving-device.js', 'device-experience.js', 'advisor.js', 'sweep.js', 'repro.js', 'artifact-v5.js');
  const source = fs.readFileSync(path.join(root, 'build-info.js'), 'utf8') + '\n' +
    files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') +
    `\nif (typeof installDeviceArtifactModel === 'function') installDeviceArtifactModel();\n` +
    `if (typeof installDeviceServingScheduler === 'function') installDeviceServingScheduler();\n` +
    `if (typeof installDeviceExperienceModel === 'function') installDeviceExperienceModel();\n` +
    `if (typeof installArtifactV5 === 'function') installArtifactV5();\n` +
    `globalThis.__simulator = {
      simulateColibri,
      validateSimulationConfig,
      applyColibriPlacement,
      deriveQuantizedExpertPayload,
      deriveColibriDeviceProfile,
      colibriExpertDevice,
      colibriRouteDeviceSplit,
      simulatorProvenance: typeof simulatorProvenance === 'function' ? simulatorProvenance : null,
      runSimulationConfig: typeof runSimulationConfig === 'function' ? runSimulationConfig : null,
      createScenarioArtifact: typeof createScenarioArtifact === 'function' ? createScenarioArtifact : null,
      parseScenarioArtifact: typeof parseScenarioArtifact === 'function' ? parseScenarioArtifact : null,
      parseScenarioArtifactReplay: typeof parseScenarioArtifactReplay === 'function' ? parseScenarioArtifactReplay : null,
      servingRunId: typeof servingRunId === 'function' ? servingRunId : null
    };`;
  const sandbox = {
    console,
    structuredClone,
    TextEncoder,
    document: { getElementById: () => null, addEventListener: () => {}, readyState: 'complete' }
  };
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
    mode: 'colibri', prompt: 8, output: 4, context: 128, conc: 1,
    arch: 'discrete', host: 512, vram: 16, dramBW: 100,
    pcieBW: 16, ssdBW: 8, lat: 100, seed: 260730,
    mem: memoryPolicy(), cold: true, placement: 'manual', layers: 2,
    experts: 16, active: 4, esize: 20, resident: 2, kvKB: 256,
    vcache: 0.16, dcache: 0.32, minDCache: 0, expertBacking: 'file',
    pinned: 0, page: 0, odirect: true, corr: 0.25, qd: 8,
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
    manualExpertMB: 20, expertParamsM: 35, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1,
    dequantMode: 'fused', cpuDequantBW: 25, gpuDequantBW: 600,
    ...overrides
  };
}

function metrics(result) {
  return {
    error: result.error || null,
    avg: result.avg,
    tps: result.tps,
    ttft: result.ttft,
    agg: result.agg,
    pcieGB: result.tot?.pcieGB,
    demandGB: result.tot?.demandGB,
    esize: result.c?.esize,
    vcache: result.c?.vcache,
    deviceKVGB: result.state?.deviceKVGB
  };
}

test('PR1: explicit legacy mode preserves the legacy Colibri result', () => {
  const simulator = loadSimulator();
  const base = colibriConfig();
  const legacy = simulator.simulateColibri(base);
  const explicit = simulator.simulateColibri({
    ...base,
    compute: { mode: 'legacy' },
    quantization: manualQuantization({ manualExpertMB: base.esize })
  });
  assert.deepEqual(metrics(explicit), metrics(legacy));
});

test('PR1: derived quantization changes payload and I/O without inferring kernel speed', () => {
  const simulator = loadSimulator();
  const common = { prompt: 0, context: 1, vcache: 0, dcache: 0, output: 1, compute: calibratedCompute() };
  const eightBit = simulator.simulateColibri(colibriConfig({
    ...common,
    quantization: { payloadMode: 'derived', format: 'int8', weightBits: 8, packing: 1, expertParamsM: 16, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1 }
  }));
  const fourBit = simulator.simulateColibri(colibriConfig({
    ...common,
    quantization: { payloadMode: 'derived', format: 'int4', weightBits: 4, packing: 1, expertParamsM: 16, cpuKernelMultiplier: 1, gpuKernelMultiplier: 1 }
  }));
  assert.equal(eightBit.c.esize, 16);
  assert.equal(fourBit.c.esize, 8);
  assert.ok(Math.abs(fourBit.tot.demandGB / eightBit.tot.demandGB - 0.5) < 1e-12);
  assert.equal(fourBit.computeProfile.gpu.effectiveExpertMs, eightBit.computeProfile.gpu.effectiveExpertMs);
});

test('PR2: CPU Attention keeps KV on Host and charges resident and KV DRAM traffic', () => {
  const simulator = loadSimulator();
  const quantization = manualQuantization();
  const cpu = simulator.simulateColibri(colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'cpu' }),
    quantization
  }));
  const gpu = simulator.simulateColibri(colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'gpu', expertDevice: 'cpu' }),
    quantization
  }));
  assert.equal(cpu.error, undefined);
  assert.equal(cpu.state.deviceKVGB, 0);
  assert.ok(gpu.state.deviceKVGB > 0);
  assert.ok(cpu.tokens[0].memory.dramTrafficGB > gpu.tokens[0].memory.dramTrafficGB);
  assert.equal(cpu.tot.pcieGB, 0);
});

test('PR2: CPU-only Expert execution creates no PCIe Expert traffic', () => {
  const simulator = loadSimulator();
  const result = simulator.simulateColibri(colibriConfig({
    prompt: 0,
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'cpu' }),
    quantization: manualQuantization()
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.tot.pcieGB, 0);
  assert.ok(result.tokens.every(token => token.pcieGB === 0));
  assert.ok(result.tokens.every(token => token.computeBreakdown.cpuActiveExperts === result.c.layers * result.c.active));
});

test('PR2: GPU speed scale improves a compute-bound scenario but not payload size', () => {
  const simulator = loadSimulator();
  const base = colibriConfig({
    prompt: 0, context: 1, kvKB: 0, resident: 0, pinned: 10, dramBW: 1_000_000, pcieBW: 1_000_000,
    compute: calibratedCompute(), quantization: manualQuantization()
  });
  const normal = simulator.simulateColibri(base);
  const fast = simulator.simulateColibri({ ...base, compute: { ...base.compute, gpu: { ...base.compute.gpu, speedScale: 2 } } });
  assert.ok(fast.tps > normal.tps * 1.5);
  assert.equal(fast.c.esize, normal.c.esize);
});

test('PR2: Hybrid assignment is persistent and VRAM contains GPU-assigned Experts only', () => {
  const simulator = loadSimulator();
  const config = colibriConfig({
    prompt: 0, output: 8, cold: false,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 } }),
    quantization: manualQuantization()
  });
  const profile = simulator.deriveColibriDeviceProfile(config);
  for (let layer = 0; layer < config.layers; layer++) {
    for (let expert = 0; expert < config.experts; expert++) {
      assert.equal(
        simulator.colibriExpertDevice(profile, layer, expert, config.seed),
        simulator.colibriExpertDevice(profile, layer, expert, config.seed)
      );
    }
  }
  const result = simulator.simulateColibri(config);
  for (let layer = 0; layer < result.cacheState.v.length; layer++) {
    for (const expert of result.cacheState.v[layer]) {
      assert.equal(simulator.colibriExpertDevice(profile, layer, expert, config.seed), 'gpu');
    }
  }
});

test('PR2: Hybrid preserves the physical VRAM cache budget and bounds PCIe between endpoints', () => {
  const simulator = loadSimulator();
  const quantization = manualQuantization();
  const base = colibriConfig({ prompt: 0, output: 12, cold: true, vcache: 0.2, dcache: 0.4, quantization });
  const gpu = simulator.simulateColibri({ ...base, compute: calibratedCompute({ expertDevice: 'gpu' }) });
  const cpu = simulator.simulateColibri({ ...base, compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'cpu' }) });
  const hybrid = simulator.simulateColibri({
    ...base,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 } })
  });
  assert.equal(hybrid.c.vcache, base.vcache);
  assert.ok(hybrid.tot.pcieGB >= cpu.tot.pcieGB - 1e-12);
  assert.ok(hybrid.tot.pcieGB <= gpu.tot.pcieGB + 1e-12);
});

test('PR2: CPU Attention prefill uses CPU prefill calibration independently of GPU Experts', () => {
  const simulator = loadSimulator();
  const baseCompute = calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'gpu' });
  const slow = simulator.simulateColibri(colibriConfig({
    prompt: 64, pinned: 10, kvKB: 0, resident: 0, dramBW: 1_000_000, pcieBW: 1_000_000,
    compute: baseCompute, quantization: manualQuantization()
  }));
  const fast = simulator.simulateColibri(colibriConfig({
    prompt: 64, pinned: 10, kvKB: 0, resident: 0, dramBW: 1_000_000, pcieBW: 1_000_000,
    compute: { ...baseCompute, cpu: { ...baseCompute.cpu, prefillSpeedup: 4 } },
    quantization: manualQuantization()
  }));
  assert.ok(fast.prefillBreakdown.computeMs < slow.prefillBreakdown.computeMs);
  assert.ok(fast.ttft < slow.ttft);
});

test('PR2: CPU Expert DRAM pressure is applied inside the token timeline', () => {
  const simulator = loadSimulator();
  const config = colibriConfig({
    prompt: 0, context: 1, kvKB: 0, resident: 0, pinned: 10, output: 8,
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'cpu' }),
    quantization: manualQuantization()
  });
  const fast = simulator.simulateColibri({ ...config, dramBW: 1000 });
  const slow = simulator.simulateColibri({ ...config, dramBW: 1 });
  assert.ok(slow.tps < fast.tps);
  assert.ok(slow.tokens.every(token => token.memory.dramStallMs > 0));
  assert.ok(slow.observed <= slow.c.ssdBW + 1e-9);
});

test('PR2: parallel Hybrid is no slower than sequential Hybrid for the same placement', () => {
  const simulator = loadSimulator();
  const quantization = manualQuantization();
  const common = { prompt: 0, context: 1, kvKB: 0, resident: 0, pinned: 10, dramBW: 1_000_000, pcieBW: 1_000_000, quantization };
  const parallel = simulator.simulateColibri(colibriConfig({
    ...common,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'parallel', overlapEfficiency: 1 } })
  }));
  const sequential = simulator.simulateColibri(colibriConfig({
    ...common,
    compute: calibratedCompute({ expertDevice: 'hybrid', hybrid: { cpuExpertFraction: 0.5, execution: 'sequential', overlapEfficiency: 1 } })
  }));
  assert.ok(parallel.tps >= sequential.tps);
});

test('PR2: calibrated artifact exports imports and replays with only external config fields', () => {
  const simulator = loadSimulator(true);
  const config = colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'hybrid' }),
    quantization: manualQuantization()
  });
  const result = simulator.runSimulationConfig(config);
  assert.equal(result.error, undefined);
  const artifact = simulator.createScenarioArtifact(result.c, result);
  assert.equal(artifact.config.compute.mode, 'calibrated');
  assert.equal(artifact.config.quantization.payloadMode, 'manual');
  assert.equal(Object.keys(artifact.config).some(key => key.startsWith('__')), false);
  const parsed = simulator.parseScenarioArtifactReplay(JSON.stringify(artifact));
  assert.equal(parsed.artifact.runId, artifact.runId);
  assert.equal(parsed.replayResult.runId, artifact.runId);
});

test('PR4: Artifact V5 replay executes and verifies its declared scheduler identity', () => {
  const simulator = loadSimulator(true);
  const config = colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'hybrid' }),
    quantization: manualQuantization()
  });
  const result = simulator.runSimulationConfig(config);
  const artifact = simulator.createScenarioArtifact(result.c, result);

  const wrongSchema = structuredClone(artifact);
  wrongSchema.executionIdentity.schedulerSchema = 'serving/v1';
  wrongSchema.runId = simulator.servingRunId(
    wrongSchema.config,
    wrongSchema.requests,
    wrongSchema.provenance,
    wrongSchema.executionIdentity
  );
  assert.throws(
    () => simulator.parseScenarioArtifactReplay(JSON.stringify(wrongSchema)),
    /scheduler identity/
  );

  const wrongWindow = structuredClone(artifact);
  wrongWindow.executionIdentity.batchWindowMs = 777;
  wrongWindow.runId = simulator.servingRunId(
    wrongWindow.config,
    wrongWindow.requests,
    wrongWindow.provenance,
    wrongWindow.executionIdentity
  );
  assert.throws(
    () => simulator.parseScenarioArtifactReplay(JSON.stringify(wrongWindow)),
    /replay result verification/
  );
});

test('PR4: Artifact V5 rejects noncanonical requests and incomplete calibrated config', () => {
  const simulator = loadSimulator(true);
  const config = colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'hybrid' }),
    quantization: manualQuantization()
  });
  const result = simulator.runSimulationConfig(config);
  const artifact = simulator.createScenarioArtifact(result.c, result);

  const unknownRequest = structuredClone(artifact);
  unknownRequest.requests[0].priority = 'urgent';
  unknownRequest.runId = simulator.servingRunId(
    unknownRequest.config,
    unknownRequest.requests,
    unknownRequest.provenance,
    unknownRequest.executionIdentity
  );
  assert.throws(
    () => simulator.parseScenarioArtifactReplay(JSON.stringify(unknownRequest)),
    /request.*unknown fields/i
  );

  const customRequest = structuredClone(artifact);
  customRequest.requests[0].id = 'release-worker-custom';
  customRequest.runId = simulator.servingRunId(
    customRequest.config,
    customRequest.requests,
    customRequest.provenance,
    customRequest.executionIdentity
  );
  const customReplay = simulator.parseScenarioArtifactReplay(JSON.stringify(customRequest));
  assert.equal(customReplay.replayResult.serving.requests[0].id, 'release-worker-custom');

  const incomplete = structuredClone(config);
  delete incomplete.compute.cpu.speedScale;
  const incompleteResult = simulator.runSimulationConfig(incomplete);
  assert.equal(incompleteResult.error, undefined);
  assert.throws(
    () => simulator.createScenarioArtifact(incompleteResult.c, incompleteResult),
    /config\.compute\.cpu.*required fields/
  );
});

test('PR4: Artifact V5 Run ID is fenced from an equivalent V4 contract', () => {
  const simulator = loadSimulator(true);
  const config = colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'hybrid' }),
    quantization: manualQuantization()
  });
  const result = simulator.runSimulationConfig(config);
  const artifact = simulator.createScenarioArtifact(result.c, result);
  const downgraded = structuredClone(artifact);
  downgraded.schemaVersion = 'moe-ssd-sim/v4';
  downgraded.provenance.schemaVersion = 'moe-ssd-sim/v4';
  delete downgraded.engineContracts;
  delete downgraded.executionIdentity;
  delete downgraded.migration;

  assert.equal(artifact.provenance.schemaVersion, 'moe-ssd-sim/v5');
  assert.throws(
    () => simulator.parseScenarioArtifactReplay(JSON.stringify(downgraded)),
    /run ID/
  );
});

test('PR4: Replay Worker preserves calibrated Artifact V5 schema and Run ID', () => {
  const simulator = loadSimulator(true);
  const config = colibriConfig({
    compute: calibratedCompute({ attentionDevice: 'cpu', expertDevice: 'hybrid' }),
    quantization: manualQuantization()
  });
  const result = simulator.runSimulationConfig(config);
  const artifact = simulator.createScenarioArtifact(result.c, result);
  let posted = null;
  const workerSandbox = {
    console,
    structuredClone,
    TextEncoder,
    setTimeout,
    clearTimeout,
    self: { postMessage: value => { posted = value; } }
  };
  const workerContext = vm.createContext(workerSandbox);
  workerSandbox.importScripts = (...names) => {
    for (const name of names) {
      vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), workerContext, { filename: name });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'replay-worker.js'), 'utf8'), workerContext, { filename: 'replay-worker.js' });

  workerSandbox.self.onmessage({ data: JSON.stringify(artifact) });

  assert.equal(posted.error, undefined);
  assert.equal(posted.artifact.schemaVersion, 'moe-ssd-sim/v5');
  assert.equal(posted.replayResult.runId, artifact.runId);

  const customRequest = structuredClone(artifact);
  customRequest.requests[0].id = 'release-worker-custom';
  customRequest.runId = simulator.servingRunId(
    customRequest.config,
    customRequest.requests,
    customRequest.provenance,
    customRequest.executionIdentity
  );
  posted = null;
  workerSandbox.self.onmessage({ data: JSON.stringify(customRequest) });
  assert.equal(posted.error, undefined);
  assert.equal(posted.replayResult.serving.requests[0].id, 'release-worker-custom');

  const tampered = structuredClone(artifact);
  tampered.executionIdentity.schedulerSchema = 'serving/v1';
  tampered.runId = simulator.servingRunId(
    tampered.config,
    tampered.requests,
    tampered.provenance,
    tampered.executionIdentity
  );
  posted = null;
  workerSandbox.self.onmessage({ data: JSON.stringify(tampered) });
  assert.match(posted.error, /scheduler identity/);

  const unknownRequest = structuredClone(artifact);
  unknownRequest.requests[0].priority = 'urgent';
  unknownRequest.runId = simulator.servingRunId(
    unknownRequest.config,
    unknownRequest.requests,
    unknownRequest.provenance,
    unknownRequest.executionIdentity
  );
  posted = null;
  workerSandbox.self.onmessage({ data: JSON.stringify(unknownRequest) });
  assert.match(posted.error, /request.*unknown fields/i);
});

test('PR4: Simulation Worker fails closed on the same malformed calibrated config', () => {
  const workerSandbox = {
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    posted: null,
    self: null,
    importScripts: null
  };
  workerSandbox.self = workerSandbox;
  const workerContext = vm.createContext(workerSandbox);
  workerSandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), workerContext, { filename: file });
    }
  };
  workerSandbox.postMessage = message => { workerSandbox.posted = structuredClone(message); };
  vm.runInContext(fs.readFileSync(path.join(root, 'simulation-worker.js'), 'utf8'), workerContext, { filename: 'simulation-worker.js' });

  const invalid = colibriConfig({ compute: calibratedCompute({ mode: '' }) });
  workerSandbox.onmessage({ data: { config: invalid } });

  assert.match(workerSandbox.posted.error, /compute\.mode/);

  const unknown = colibriConfig({ compute: { ...calibratedCompute(), extra: true } });
  workerSandbox.onmessage({ data: { config: unknown } });
  assert.match(workerSandbox.posted.error, /compute\.extra/);
});

test('PR1: invalid calibrated settings fail closed', () => {
  const simulator = loadSimulator();
  const invalid = colibriConfig({
    compute: calibratedCompute({ gpu: { speedScale: 0, attentionMs: 20, expertMs: 10, parallelExperts: 4, prefillSpeedup: 4 } }),
    quantization: manualQuantization()
  });
  const result = simulator.simulateColibri(invalid);
  assert.match(result.error, /Invalid configuration/);
  assert.ok(result.validationErrors.some(error => error.path === 'compute.gpu.speedScale'));
});

test('PR2: device-compute schema distinguishes the calibrated model contract', () => {
  const simulator = loadSimulator(true);
  const profile = simulator.deriveColibriDeviceProfile(colibriConfig({
    compute: calibratedCompute(),
    quantization: manualQuantization()
  }));
  assert.equal(profile.schema, 'device-compute/v2');
  assert.equal(simulator.simulatorProvenance().modelVersion, '1.6.2');
});
