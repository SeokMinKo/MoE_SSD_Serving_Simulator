'use strict';

const ARTIFACT_V5_SCHEMA = 'moe-ssd-sim/v5';
const ARTIFACT_V4_SCHEMA = 'moe-ssd-sim/v4';
const ARTIFACT_V5_CONTRACTS = Object.freeze({
  artifact: 'scenario-artifact/v5',
  deviceCompute: 'device-compute/v2',
  deviceServing: 'device-serving/v1',
  deviceExperience: 'device-experience/v1'
});

function artifactV5Contracts() {
  return { ...ARTIFACT_V5_CONTRACTS };
}

function artifactV5ValidateContracts(contracts) {
  if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts)) throw new Error('Artifact V5 engineContracts are required.');
  const expected = ARTIFACT_V5_CONTRACTS;
  const keys = Object.keys(expected);
  if (Object.keys(contracts).length !== keys.length || keys.some(key => contracts[key] !== expected[key])) {
    throw new Error('Artifact V5 engineContracts do not match this simulator build.');
  }
}

function artifactV5ToLegacyEnvelope(artifact) {
  artifactV5ValidateContracts(artifact.engineContracts);
  const legacy = { ...artifact, schemaVersion: ARTIFACT_V4_SCHEMA };
  delete legacy.engineContracts;
  delete legacy.migration;
  return legacy;
}

function installArtifactV5() {
  if (globalThis.__ARTIFACT_V5_INSTALLED__) return false;
  if (typeof createScenarioArtifact !== 'function' || typeof parseScenarioArtifactReplay !== 'function') return false;

  const createV4 = createScenarioArtifact;
  createScenarioArtifact = function createScenarioArtifactV5(config, result, sweepExecution = null) {
    const artifact = createV4(config, result, sweepExecution);
    return {
      ...artifact,
      schemaVersion: ARTIFACT_V5_SCHEMA,
      engineContracts: artifactV5Contracts(),
      migration: { accepts: [ARTIFACT_V4_SCHEMA, ARTIFACT_V5_SCHEMA], exportedAs: ARTIFACT_V5_SCHEMA }
    };
  };

  const parseV4 = parseScenarioArtifactReplay;
  parseScenarioArtifactReplay = function parseScenarioArtifactV5(text) {
    if (typeof text !== 'string' || text.length > 1_000_000) return parseV4(text);
    let artifact;
    try {
      artifact = JSON.parse(text);
    } catch (_) {
      return parseV4(text);
    }
    if (artifact?.schemaVersion === ARTIFACT_V4_SCHEMA) {
      const parsed = parseV4(text);
      return {
        ...parsed,
        artifact: {
          ...parsed.artifact,
          migration: { migratedFrom: ARTIFACT_V4_SCHEMA, runtimeSchema: ARTIFACT_V4_SCHEMA }
        }
      };
    }
    if (artifact?.schemaVersion !== ARTIFACT_V5_SCHEMA) return parseV4(text);
    const legacy = artifactV5ToLegacyEnvelope(artifact);
    const parsed = parseV4(JSON.stringify(legacy));
    return {
      ...parsed,
      artifact: {
        ...artifact,
        migration: { ...(artifact.migration || {}), replayedThrough: ARTIFACT_V4_SCHEMA }
      }
    };
  };

  globalThis.__ARTIFACT_V5_INSTALLED__ = Object.freeze({ schema: ARTIFACT_V5_SCHEMA, contracts: artifactV5Contracts() });
  return true;
}

if (typeof document === 'object' && typeof document.addEventListener === 'function') {
  const install = () => installArtifactV5();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else Promise.resolve().then(install);
}
