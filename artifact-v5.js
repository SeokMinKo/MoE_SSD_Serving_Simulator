'use strict';

const ARTIFACT_V5_SCHEMA = 'moe-ssd-sim/v5';
const ARTIFACT_V4_SCHEMA = 'moe-ssd-sim/v4';
const ARTIFACT_V5_CONTRACTS = Object.freeze({
  artifact: 'scenario-artifact/v5',
  deviceCompute: 'device-compute/v2',
  deviceServing: 'device-serving/v1',
  deviceExperience: 'device-experience/v1'
});
const ARTIFACT_V5_TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion', 'runId', 'provenance', 'modelVersion', 'packageVersion', 'commit', 'buildVersion',
  'requests', 'config', 'result', 'insight', 'sweep', 'engineContracts', 'executionIdentity', 'migration'
]);
const ARTIFACT_V5_RESULT_KEYS = Object.freeze([
  'completedTokens', 'ttftMs', 'tpotMs', 'throughputTPS', 'peakMemoryGB', 'peakSwapGB',
  'storagePerTokenGB', 'oom', 'modelStatus'
]);

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

function artifactV5AssertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Artifact V5 ${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Artifact V5 ${label} contains unknown fields: ${unknown.join(', ')}.`);
}

function artifactV5ValidateDeviceConfig(config) {
  if (config.compute !== undefined) {
    artifactV5AssertExactKeys(config.compute, ['mode', 'attentionDevice', 'expertDevice', 'cpu', 'gpu', 'hybrid'], 'config.compute');
    for (const device of ['cpu', 'gpu']) {
      if (config.compute[device] !== undefined) {
        artifactV5AssertExactKeys(
          config.compute[device],
          ['speedScale', 'attentionMs', 'expertMs', 'parallelExperts', 'prefillSpeedup'],
          `config.compute.${device}`
        );
      }
    }
    if (config.compute.hybrid !== undefined) {
      artifactV5AssertExactKeys(
        config.compute.hybrid,
        ['cpuExpertFraction', 'execution', 'overlapEfficiency'],
        'config.compute.hybrid'
      );
    }
  }
  if (config.quantization !== undefined) {
    artifactV5AssertExactKeys(
      config.quantization,
      ['payloadMode', 'format', 'weightBits', 'packing', 'manualExpertMB', 'expertParamsM', 'cpuKernelMultiplier', 'gpuKernelMultiplier', 'dequantMode', 'cpuDequantBW', 'gpuDequantBW'],
      'config.quantization'
    );
  }
}

function artifactV5ExecutionIdentity(artifact, result = null) {
  const schedulerSchema = result?.serving?.schedulerSchema ||
    (artifact.result?.modelStatus === 'Estimated · event-driven CPU/GPU shared-resource model' ? 'device-serving/v1' : 'serving/v1');
  const batchWindowMs = result?.serving?.schedulerOptions?.batchWindowMs ?? 2;
  return {
    schedulerSchema,
    batchWindowMs,
    engineContracts: artifactV5Contracts()
  };
}

function artifactV5ValidateEnvelope(artifact) {
  artifactV5AssertExactKeys(artifact, ARTIFACT_V5_TOP_LEVEL_KEYS, 'envelope');
  artifactV5AssertExactKeys(artifact.provenance, ['schemaVersion', 'modelVersion', 'packageVersion', 'commit', 'buildVersion'], 'provenance');
  artifactV5AssertExactKeys(artifact.result, ARTIFACT_V5_RESULT_KEYS, 'result');
  artifactV5AssertExactKeys(artifact.migration, ['accepts', 'exportedAs', 'requiresExactProvenance'], 'migration');
  artifactV5AssertExactKeys(artifact.executionIdentity, ['schedulerSchema', 'batchWindowMs', 'engineContracts'], 'executionIdentity');
  artifactV5ValidateContracts(artifact.engineContracts);
  artifactV5ValidateContracts(artifact.executionIdentity.engineContracts);
  if (!Array.isArray(artifact.migration.accepts) || artifact.migration.accepts.length !== 2 ||
      artifact.migration.accepts[0] !== ARTIFACT_V4_SCHEMA || artifact.migration.accepts[1] !== ARTIFACT_V5_SCHEMA) {
    throw new Error('Artifact V5 migration.accepts must be [moe-ssd-sim/v4, moe-ssd-sim/v5].');
  }
  if (artifact.migration.exportedAs !== ARTIFACT_V5_SCHEMA) throw new Error('Artifact V5 migration.exportedAs must be moe-ssd-sim/v5.');
  if (artifact.migration.requiresExactProvenance !== true) throw new Error('Artifact V5 migration requires exact build provenance.');
  if (artifact.provenance.schemaVersion !== ARTIFACT_V5_SCHEMA) throw new Error('Artifact V5 provenance schemaVersion must be moe-ssd-sim/v5.');
  if (!['device-serving/v1', 'serving/v1'].includes(artifact.executionIdentity.schedulerSchema)) {
    throw new Error('Artifact V5 executionIdentity schedulerSchema is unsupported.');
  }
  const expectedSchedulerSchema = artifact.config?.mode === 'colibri' && artifact.config.compute?.mode === 'calibrated'
    ? 'device-serving/v1'
    : 'serving/v1';
  if (artifact.executionIdentity.schedulerSchema !== expectedSchedulerSchema) {
    throw new Error('Artifact V5 scheduler identity does not match its execution mode.');
  }
  if (!Number.isFinite(artifact.executionIdentity.batchWindowMs) || artifact.executionIdentity.batchWindowMs < 0 || artifact.executionIdentity.batchWindowMs > 1000) {
    throw new Error('Artifact V5 executionIdentity batchWindowMs is invalid.');
  }
  artifactV5ValidateDeviceConfig(artifact.config);
  const canonicalRunId = servingRunId(artifact.config, artifact.requests, artifact.provenance, artifact.executionIdentity);
  if (canonicalRunId !== artifact.runId) throw new Error('Artifact V5 has a noncanonical run ID.');
}

function artifactV5ToLegacyEnvelope(artifact) {
  artifactV5ValidateEnvelope(artifact);
  const provenance = { ...artifact.provenance, schemaVersion: ARTIFACT_V4_SCHEMA };
  const legacy = { ...artifact, schemaVersion: ARTIFACT_V4_SCHEMA, provenance };
  delete legacy.engineContracts;
  delete legacy.executionIdentity;
  delete legacy.migration;
  legacy.runId = servingRunId(legacy.config, legacy.requests, legacy.provenance);
  return legacy;
}

function installArtifactV5() {
  if (globalThis.__ARTIFACT_V5_INSTALLED__) return false;
  if (typeof createScenarioArtifact !== 'function' || typeof parseScenarioArtifactReplay !== 'function' || typeof servingRunId !== 'function') return false;

  const createV4 = createScenarioArtifact;
  createScenarioArtifact = function createScenarioArtifactV5(config, result, sweepExecution = null) {
    const artifact = createV4(config, result, sweepExecution);
    const provenance = { ...artifact.provenance, schemaVersion: ARTIFACT_V5_SCHEMA };
    const envelope = {
      ...artifact,
      schemaVersion: ARTIFACT_V5_SCHEMA,
      provenance,
      engineContracts: artifactV5Contracts(),
      executionIdentity: null,
      migration: {
        accepts: [ARTIFACT_V4_SCHEMA, ARTIFACT_V5_SCHEMA],
        exportedAs: ARTIFACT_V5_SCHEMA,
        requiresExactProvenance: true
      }
    };
    envelope.executionIdentity = artifactV5ExecutionIdentity(envelope, result);
    envelope.runId = servingRunId(envelope.config, envelope.requests, envelope.provenance, envelope.executionIdentity);
    return envelope;
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
          migration: {
            migratedFrom: ARTIFACT_V4_SCHEMA,
            runtimeSchema: ARTIFACT_V4_SCHEMA,
            requiresExactProvenance: true
          }
        }
      };
    }
    if (artifact?.schemaVersion !== ARTIFACT_V5_SCHEMA) return parseV4(text);
    const legacy = artifactV5ToLegacyEnvelope(artifact);
    const parsed = parseV4(JSON.stringify(legacy), { batchWindowMs: artifact.executionIdentity.batchWindowMs });
    const replaySchedulerSchema = parsed.replayResult?.serving?.schedulerSchema;
    const replayBatchWindowMs = parsed.replayResult?.serving?.schedulerOptions?.batchWindowMs;
    if (replaySchedulerSchema !== artifact.executionIdentity.schedulerSchema ||
        replayBatchWindowMs !== artifact.executionIdentity.batchWindowMs) {
      throw new Error('Artifact V5 replay scheduler identity does not match the declared execution identity.');
    }
    return {
      ...parsed,
      replayResult: { ...parsed.replayResult, runId: artifact.runId },
      artifact
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
