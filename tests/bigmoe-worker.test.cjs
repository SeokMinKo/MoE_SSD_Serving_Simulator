'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadWorker(file) {
  let posted = null;
  const sandbox = {
    console,
    TextEncoder,
    Map,
    Set,
    WeakSet,
    Uint8Array,
    structuredClone: global.structuredClone,
    postMessage(value) { posted = value; }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const sourceFile of files) {
      const source = fs.readFileSync(path.join(root, sourceFile), 'utf8');
      vm.runInContext(source, sandbox, { filename: sourceFile });
    }
  };
  const workerSource = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInContext(workerSource, sandbox, { filename: file });
  return {
    sandbox,
    dispatch(data) {
      posted = null;
      sandbox.self.onmessage({ data });
      return posted;
    }
  };
}

test('BigMoEEdge simulation Worker returns the same canonical sweep summary as its loaded main engine', () => {
  const worker = loadWorker('simulation-worker.js');
  const config = vm.runInContext('bigMoeEdgePreset()', worker.sandbox);
  config.output = 3;
  const expected = vm.runInContext('summarizeSweepResult(runSimulationConfig(globalThis.__config))', Object.assign(worker.sandbox, { __config: config }));

  const actual = worker.dispatch({ config });

  assert.equal(actual.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(actual.metrics)), JSON.parse(JSON.stringify(expected)));
  assert.equal(actual.config.mode, 'bigmoe-edge');
  assert.equal(actual.config.runtime.execution, 'serial');
  assert.equal(actual.config.runtime.cacheMiB, 4000);
  assert.equal(typeof actual.runId, 'string');
});

test('BigMoEEdge sweep catalog exposes modeled CPU/storage/cache knobs and runs without GPU fallback', () => {
  const worker = loadWorker('simulation-worker.js');
  const config = vm.runInContext('bigMoeEdgePreset()', worker.sandbox);
  config.output = 2;
  worker.sandbox.__config = config;
  const paths = vm.runInContext('sweepCatalogForConfig(__config).map(item => item.path)', worker.sandbox);

  for (const path of ['runtime.threads', 'runtime.ioThreads', 'runtime.cacheMiB', 'runtime.odirect', 'ssdBW', 'dramBW']) {
    assert.equal(paths.includes(path), true, `missing ${path}`);
  }
  for (const path of ['conc', 'pcieBW', 'vram', 'qd', 'pf']) {
    assert.equal(paths.includes(path), false, `forbidden ${path}`);
  }
  const guides = vm.runInContext(`Object.fromEntries(
    sweepCatalogForConfig(__config).map(item => [item.path, sweepParameterGuide(item, __config)])
  )`, worker.sandbox);
  assert.equal(guides['runtime.threads'].unit, 'threads');
  assert.equal(guides['runtime.ioThreads'].unit, 'lanes');
  assert.equal(guides['runtime.cacheMiB'].unit, 'MiB');
  assert.equal(guides['runtime.threadScalingExponent'].unit, '지수(0–1)');
  assert.match(guides['runtime.ioThreads'].relationship, /queue depth/i);
  assert.match(guides['runtime.threads'].relationship, /reference/i);

  const execution = vm.runInContext(`(() => {
    const plan = buildSweepScenarios(__config, 'oat', [{ path: 'runtime.threads', values: [2] }]);
    const run = createSweepExecution(__config, plan);
    return advanceSweepExecution(run);
  })()`, worker.sandbox);
  const result = JSON.parse(JSON.stringify(execution));
  assert.equal(result.status, 'completed');
  assert.equal(result.results[0].metrics.status, 'completed');
  assert.equal(result.results[0].config.mode, 'bigmoe-edge');
  assert.equal(result.results[0].config.runtime.threads, 2);
});

test('BigMoEEdge V6 artifact round-trips through replay Worker and rejects execution tampering before replay', () => {
  const worker = loadWorker('replay-worker.js');
  const config = vm.runInContext('bigMoeEdgePreset()', worker.sandbox);
  config.prompt = 2;
  config.output = 2;
  worker.sandbox.__config = config;
  const artifact = vm.runInContext(`(() => {
    const result = runSimulationConfig(__config);
    return createScenarioArtifact(__config, result);
  })()`, worker.sandbox);
  const exported = JSON.parse(JSON.stringify(artifact));

  assert.equal(exported.schemaVersion, 'moe-ssd-sim/v6');
  assert.equal(exported.backendContract.id, 'bigmoe-llamacpp-cpu/v1');
  assert.equal(exported.backendContract.execution, 'serial');
  assert.equal(exported.backendContract.gpuWork, false);
  assert.equal(exported.telemetryEvidence, null);
  assert.equal(exported.executionIdentity.schedulerSchema, 'bigmoe-serial/v1');
  assert.equal(exported.executionIdentity.batchWindowMs, 0);
  assert.equal(exported.engineContracts.artifact, 'scenario-artifact/v6');
  assert.deepEqual(exported.executionIdentity.engineContracts, exported.engineContracts);

  const replayed = worker.dispatch(JSON.stringify(exported));
  assert.equal(replayed.error, undefined);
  assert.equal(replayed.artifact.runId, exported.runId);
  assert.equal(replayed.replayResult.mode, 'bigmoe-edge');
  assert.equal(replayed.replayResult.tokens.every(token => token.gpuMs === 0 && token.pcieGB === 0), true);

  const evidence = {
    schemaVersion: 'bmoe-metrics-evidence/v1', eligible: true, measured: true,
    computeIsResidual: true, directExpertMs: null,
    allowedTargets: ['endToEnd', 'storage', 'cache', 'memory'],
    prohibitedTargets: ['runtime.expertMs'],
    source: {
      schemaVersion: 'bmoe_metrics/v2',
      engineVersion: 'test-engine',
      model: 'tiny.gguf',
      architecture: 'qwen3moe'
    },
    observed: {
      tokenCount: 2, meanWallMs: 100, meanCriticalFlashMs: 40,
      meanManagementMs: 2, meanLoopOverheadMs: 1,
      readMiBPerToken: 12, cacheHitPct: 50, meanCpuOccupancyPct: null,
      majorFaultsPerToken: 0
    },
    reason: null
  };
  worker.sandbox.__evidence = evidence;
  const withEvidence = vm.runInContext(`(() => {
    const result = runSimulationConfig(__config);
    return createScenarioArtifact(__config, result, null, __evidence);
  })()`, worker.sandbox);
  const evidenceReplay = worker.dispatch(JSON.stringify(withEvidence));
  assert.equal(evidenceReplay.error, undefined);
  assert.equal(evidenceReplay.artifact.telemetryEvidence.computeIsResidual, true);
  assert.equal(evidenceReplay.artifact.telemetryEvidence.directExpertMs, null);
  assert.deepEqual(evidenceReplay.replayResult.executionIdentity, withEvidence.executionIdentity);

  const identityMutations = [
    ['top-level contract', artifact => { artifact.engineContracts.artifact = 'attacker/v999'; }, false],
    ['nested contract', artifact => { artifact.executionIdentity.engineContracts.deviceCompute = 'attacker/v999'; }, true],
    ['batch window', artifact => { artifact.executionIdentity.batchWindowMs = 777; }, true],
    ['scheduler schema', artifact => { artifact.executionIdentity.schedulerSchema = 'device-serving/v1'; }, true],
    ['migration unknown field', artifact => { artifact.migration.attacker = true; }, false]
  ];
  for (const [label, mutate, resign] of identityMutations) {
    const artifact = JSON.parse(JSON.stringify(withEvidence));
    mutate(artifact);
    if (resign) {
      worker.sandbox.__identityTamper = artifact;
      vm.runInContext(`(() => {
        const identity = {
          ...__identityTamper.executionIdentity,
          backendContract: __identityTamper.backendContract,
          telemetryEvidence: __identityTamper.telemetryEvidence
        };
        __identityTamper.runId = servingRunId(
          __identityTamper.config,
          __identityTamper.requests,
          __identityTamper.provenance,
          identity
        );
      })()`, worker.sandbox);
    }
    const rejectedIdentity = worker.dispatch(JSON.stringify(artifact));
    assert.equal(typeof rejectedIdentity.error, 'string', label);
  }

  const mirroredCommitTamper = JSON.parse(JSON.stringify(withEvidence));
  mirroredCommitTamper.commit = '0'.repeat(40);
  const mirrorRejected = worker.dispatch(JSON.stringify(mirroredCommitTamper));
  assert.match(mirrorRejected.error, /commit|provenance mirror/i);

  const tamperedRequest = JSON.parse(JSON.stringify(withEvidence));
  tamperedRequest.requests[0].output = tamperedRequest.config.output + 1;
  worker.sandbox.__tamperedRequest = tamperedRequest;
  vm.runInContext(`(() => {
    const identity = {
      ...__tamperedRequest.executionIdentity,
      backendContract: __tamperedRequest.backendContract,
      telemetryEvidence: __tamperedRequest.telemetryEvidence
    };
    __tamperedRequest.runId = servingRunId(
      __tamperedRequest.config,
      __tamperedRequest.requests,
      __tamperedRequest.provenance,
      identity
    );
  })()`, worker.sandbox);
  const requestRejected = worker.dispatch(JSON.stringify(tamperedRequest));
  assert.match(requestRejected.error, /request.*output|canonical request/i);

  const evidenceMutations = [
    ['GPU target', artifact => artifact.telemetryEvidence.allowedTargets.push('gpu')],
    ['extra prohibited target', artifact => artifact.telemetryEvidence.prohibitedTargets.push('gpu')],
    ['duplicate target', artifact => artifact.telemetryEvidence.allowedTargets.push('endToEnd')],
    ['CPU occupancy above 100', artifact => { artifact.telemetryEvidence.observed.meanCpuOccupancyPct = 100.01; }],
    ['architecture mismatch', artifact => { artifact.telemetryEvidence.source.architecture = 'fabricated-arch'; }],
    ['ineligible evidence with enabled targets', artifact => { artifact.telemetryEvidence.eligible = false; artifact.telemetryEvidence.reason = 'overlap'; }]
  ];
  for (const [label, mutate] of evidenceMutations) {
    const artifact = JSON.parse(JSON.stringify(withEvidence));
    mutate(artifact);
    worker.sandbox.__evidenceTamper = artifact;
    vm.runInContext(`(() => {
      const identity = {
        ...__evidenceTamper.executionIdentity,
        backendContract: __evidenceTamper.backendContract,
        telemetryEvidence: __evidenceTamper.telemetryEvidence
      };
      __evidenceTamper.runId = servingRunId(
        __evidenceTamper.config,
        __evidenceTamper.requests,
        __evidenceTamper.provenance,
        identity
      );
    })()`, worker.sandbox);
    const rejectedEvidence = worker.dispatch(JSON.stringify(artifact));
    assert.equal(typeof rejectedEvidence.error, 'string', label);
  }

  const tamperedEvidence = JSON.parse(JSON.stringify(withEvidence));
  tamperedEvidence.telemetryEvidence.directExpertMs = 1;
  const evidenceRejected = worker.dispatch(JSON.stringify(tamperedEvidence));
  assert.match(evidenceRejected.error, /residual semantics|directExpertMs/i);

  const nonFiniteResult = JSON.parse(JSON.stringify(withEvidence));
  nonFiniteResult.result.tpotMs = Infinity;
  const nonFiniteRejected = worker.dispatch(JSON.stringify(nonFiniteResult));
  assert.match(nonFiniteRejected.error, /result.*non-finite|result.*invalid/i);

  exported.config.runtime.execution = 'overlap';
  const rejected = worker.dispatch(JSON.stringify(exported));
  assert.match(rejected.error, /runtime\.execution|UNSUPPORTED_EXECUTION|serial/i);
});
