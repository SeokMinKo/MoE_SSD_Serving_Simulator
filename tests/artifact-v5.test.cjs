'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = `
function createScenarioArtifact(config) {
  return { schemaVersion: 'moe-ssd-sim/v4', runId: 'sim-1.6.2-0123456789abcdef', provenance: { schemaVersion: 'moe-ssd-sim/v4' }, config };
}
function parseScenarioArtifactReplay(text) {
  const artifact = JSON.parse(text);
  if (artifact.schemaVersion !== 'moe-ssd-sim/v4') throw new Error('Unsupported scenario schema');
  return { artifact, replayResult: { ok: true } };
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
});

test('Artifact V5 replays through the validated V4 runtime contract', () => {
  const artifact = sim.createScenarioArtifact({ mode: 'colibri' });
  const parsed = sim.parseScenarioArtifactReplay(JSON.stringify(artifact));
  assert.equal(parsed.artifact.schemaVersion, 'moe-ssd-sim/v5');
  assert.equal(parsed.artifact.migration.replayedThrough, 'moe-ssd-sim/v4');
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
