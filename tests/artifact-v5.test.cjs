'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = `
function stableValue(value) {
  if (Array.isArray(value)) return '[' + value.map(stableValue).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableValue(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function servingRunId(config, requests, provenance, executionIdentity = null) {
  return 'sim-test-' + stableValue({ config, requests, provenance, executionIdentity }).length;
}
function createScenarioArtifact(config) {
  const provenance = { schemaVersion: 'moe-ssd-sim/v4', modelVersion: '1.6.2', packageVersion: '1.6.2', commit: 'test', buildVersion: 'test' };
  const requests = [{ id: 'request-1', arrivalMs: 0, output: 1 }];
  return {
    schemaVersion: 'moe-ssd-sim/v4',
    runId: servingRunId(config, requests, provenance),
    provenance,
    modelVersion: '1.6.2', packageVersion: '1.6.2', commit: 'test', buildVersion: 'test',
    requests, config,
    result: { completedTokens: 1, ttftMs: 1, tpotMs: null, throughputTPS: 1, peakMemoryGB: 1, peakSwapGB: 0, storagePerTokenGB: 0, oom: false, modelStatus: 'Estimated · event-driven shared-resource model' },
    insight: {}, sweep: null
  };
}
function parseScenarioArtifactReplay(text, options = {}) {
  const artifact = JSON.parse(text);
  if (artifact.schemaVersion !== 'moe-ssd-sim/v4') throw new Error('Unsupported scenario schema');
  const schedulerSchema = artifact.config.compute?.mode === 'calibrated' ? 'device-serving/v1' : 'serving/v1';
  return {
    artifact,
    replayResult: {
      ok: true,
      runId: artifact.runId,
      serving: { schedulerSchema, schedulerOptions: { batchWindowMs: options.batchWindowMs ?? 2 } }
    }
  };
}
` + fs.readFileSync(path.resolve(__dirname, '..', 'artifact-v5.js'), 'utf8') +
  `\ninstallArtifactV5(); globalThis.__sim={createScenarioArtifact,parseScenarioArtifactReplay,ARTIFACT_V5_SCHEMA};`;
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const sim = sandbox.__sim;

test('Artifact V5 is the default export envelope', () => {
  const artifact = sim.createScenarioArtifact({ mode: 'colibri' });
  assert.equal(artifact.schemaVersion, 'moe-ssd-sim/v5');
  assert.equal(artifact.engineContracts.deviceCompute, 'device-compute/v2');
  assert.equal(artifact.engineContracts.deviceServing, 'device-serving/v1');
  assert.equal(artifact.engineContracts.deviceExperience, 'device-experience/v1');
  assert.equal(artifact.migration.requiresExactProvenance, true);
});

test('Artifact V5 replays through the validated V4 runtime contract', () => {
  const artifact = sim.createScenarioArtifact({ mode: 'colibri' });
  const parsed = sim.parseScenarioArtifactReplay(JSON.stringify(artifact));
  assert.equal(parsed.artifact.schemaVersion, 'moe-ssd-sim/v5');
  const reparsed = sim.parseScenarioArtifactReplay(JSON.stringify(parsed.artifact));
  assert.equal(reparsed.artifact.runId, artifact.runId);
  assert.equal(parsed.replayResult.ok, true);
});

test('Artifact V4 remains importable with explicit migration metadata', () => {
  const v4 = { schemaVersion: 'moe-ssd-sim/v4', runId: 'sim-1.6.2-0123456789abcdef', provenance: { schemaVersion: 'moe-ssd-sim/v4' }, config: {} };
  const parsed = sim.parseScenarioArtifactReplay(JSON.stringify(v4));
  assert.equal(parsed.artifact.migration.migratedFrom, 'moe-ssd-sim/v4');
});

test('Artifact V5 rejects unknown engine contracts', () => {
  const artifact = sim.createScenarioArtifact({ mode: 'colibri' });
  artifact.engineContracts.deviceServing = 'unknown/v9';
  assert.throws(() => sim.parseScenarioArtifactReplay(JSON.stringify(artifact)), /engineContracts/);
});

test('Artifact V5 rejects unknown envelope result migration and device config fields', () => {
  const topLevel = sim.createScenarioArtifact({ mode: 'colibri' });
  topLevel.__private = true;
  assert.throws(() => sim.parseScenarioArtifactReplay(JSON.stringify(topLevel)), /unknown fields/);

  const result = sim.createScenarioArtifact({ mode: 'colibri' });
  result.result.__private = true;
  assert.throws(() => sim.parseScenarioArtifactReplay(JSON.stringify(result)), /unknown fields/);

  const migration = sim.createScenarioArtifact({ mode: 'colibri' });
  migration.migration.__private = true;
  assert.throws(() => sim.parseScenarioArtifactReplay(JSON.stringify(migration)), /unknown fields/);

  assert.throws(
    () => sim.createScenarioArtifact({ mode: 'colibri', compute: { mode: 'legacy', __internal: true } }),
    /config\.compute contains unknown fields/
  );

  assert.throws(
    () => sim.createScenarioArtifact({ mode: 'colibri', quantization: { payloadMode: 'manual', __internal: true } }),
    /config\.quantization contains unknown fields/
  );

  const migrationContract = sim.createScenarioArtifact({ mode: 'colibri' });
  migrationContract.migration.accepts = ['moe-ssd-sim/v5'];
  assert.throws(() => sim.parseScenarioArtifactReplay(JSON.stringify(migrationContract)), /migration\.accepts/);
});
