'use strict';

const ARTIFACT_V6_SCHEMA = 'moe-ssd-sim/v6';
const ARTIFACT_V6_BACKEND = Object.freeze({
  id: 'bigmoe-llamacpp-cpu/v1',
  execution: 'serial',
  concurrency: 1,
  gpuWork: false,
  pcieWork: false,
  vramWork: false,
  projectionUnit: 'MiB',
  bandwidthUnit: 'GB/s',
  validation: 'unvalidated-alpha'
});
const ARTIFACT_V6_ENGINE_CONTRACTS = Object.freeze({
  artifact: 'scenario-artifact/v6',
  deviceCompute: 'device-compute/v2',
  deviceServing: 'device-serving/v1',
  deviceExperience: 'device-experience/v1'
});
const ARTIFACT_V6_TOP_LEVEL_KEYS = Object.freeze([
  ...ARTIFACT_V5_TOP_LEVEL_KEYS, 'backendContract', 'telemetryEvidence'
]);
const ARTIFACT_V6_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'eligible', 'measured', 'computeIsResidual', 'directExpertMs',
  'allowedTargets', 'prohibitedTargets', 'reason', 'source', 'observed'
]);
const ARTIFACT_V6_EVIDENCE_SOURCE_KEYS = Object.freeze([
  'schemaVersion', 'engineVersion', 'model', 'architecture'
]);
const ARTIFACT_V6_EVIDENCE_OBSERVED_KEYS = Object.freeze([
  'tokenCount', 'meanWallMs', 'meanCriticalFlashMs', 'meanManagementMs',
  'meanLoopOverheadMs', 'readMiBPerToken', 'cacheHitPct',
  'majorFaultsPerToken', 'meanCpuOccupancyPct'
]);

function artifactV6ExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Artifact V6 ${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = allowed.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length) throw new Error(`Artifact V6 ${label} contains unknown fields: ${unknown.join(', ')}.`);
  if (missing.length) throw new Error(`Artifact V6 ${label} is missing required fields: ${missing.join(', ')}.`);
}

function artifactV6BackendContract() {
  return { ...ARTIFACT_V6_BACKEND };
}

function artifactV6ValidateBackend(contract) {
  artifactV6ExactKeys(contract, Object.keys(ARTIFACT_V6_BACKEND), 'backendContract');
  for (const [key, value] of Object.entries(ARTIFACT_V6_BACKEND)) {
    if (contract[key] !== value) throw new Error(`Artifact V6 backendContract.${key} does not match this build.`);
  }
}

function artifactV6EngineContracts() {
  return { ...ARTIFACT_V6_ENGINE_CONTRACTS };
}

function artifactV6ValidateEngineContracts(contracts) {
  artifactV6ExactKeys(contracts, Object.keys(ARTIFACT_V6_ENGINE_CONTRACTS), 'engineContracts');
  for (const [key, value] of Object.entries(ARTIFACT_V6_ENGINE_CONTRACTS)) {
    if (contracts[key] !== value) throw new Error(`Artifact V6 engineContracts.${key} does not match this build.`);
  }
}

function artifactV6ValidateEvidence(evidence) {
  if (evidence === null) return;
  artifactV6ExactKeys(evidence, ARTIFACT_V6_EVIDENCE_KEYS, 'telemetryEvidence');
  if (evidence.schemaVersion !== 'bmoe-metrics-evidence/v1') throw new Error('Artifact V6 telemetry evidence schema is unsupported.');
  if (typeof evidence.eligible !== 'boolean' || typeof evidence.measured !== 'boolean' || evidence.measured !== true ||
      evidence.computeIsResidual !== true || evidence.directExpertMs !== null) {
    throw new Error('Artifact V6 telemetry evidence must preserve measured residual semantics.');
  }
  const expectedAllowedTargets = evidence.eligible ? ['endToEnd', 'storage', 'cache', 'memory'] : [];
  if (stableValue(evidence.allowedTargets) !== stableValue(expectedAllowedTargets) ||
      stableValue(evidence.prohibitedTargets) !== stableValue(['runtime.expertMs'])) {
    throw new Error('Artifact V6 telemetry evidence calibration targets are invalid.');
  }
  if ((evidence.eligible && evidence.reason !== null) ||
      (!evidence.eligible && (typeof evidence.reason !== 'string' || evidence.reason.trim() === ''))) {
    throw new Error('Artifact V6 telemetry evidence reason is invalid.');
  }
  artifactV6ExactKeys(evidence.source, ARTIFACT_V6_EVIDENCE_SOURCE_KEYS, 'telemetryEvidence.source');
  if (evidence.source.schemaVersion !== 'bmoe_metrics/v2' ||
      ['engineVersion', 'model', 'architecture'].some(key => typeof evidence.source[key] !== 'string' || evidence.source[key].trim() === '')) {
    throw new Error('Artifact V6 telemetry evidence source is invalid.');
  }
  artifactV6ExactKeys(evidence.observed, ARTIFACT_V6_EVIDENCE_OBSERVED_KEYS, 'telemetryEvidence.observed');
  if (!Number.isSafeInteger(evidence.observed.tokenCount) || evidence.observed.tokenCount < 1) {
    throw new Error('Artifact V6 telemetry evidence tokenCount is invalid.');
  }
  for (const [key, value] of Object.entries(evidence.observed)) {
    if (key !== 'meanCpuOccupancyPct' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Artifact V6 telemetry evidence ${key} is invalid.`);
    }
    if (key === 'meanCpuOccupancyPct' && value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
      throw new Error('Artifact V6 telemetry evidence meanCpuOccupancyPct is invalid.');
    }
  }
  if (evidence.observed.cacheHitPct > 100) {
    throw new Error('Artifact V6 telemetry evidence cacheHitPct is invalid.');
  }
}

function artifactV6ValidateEnvelope(artifact) {
  artifactV6ExactKeys(artifact, ARTIFACT_V6_TOP_LEVEL_KEYS, 'envelope');
  artifactV5AssertExactKeys(artifact.provenance, ['schemaVersion', 'modelVersion', 'packageVersion', 'commit', 'buildVersion'], 'provenance');
  artifactV5AssertExactKeys(artifact.result, ARTIFACT_V5_RESULT_KEYS, 'result');
  artifactV5AssertExactKeys(artifact.migration, ['accepts', 'exportedAs', 'requiresExactProvenance'], 'migration');
  artifactV5AssertExactKeys(artifact.executionIdentity, ['schedulerSchema', 'batchWindowMs', 'engineContracts'], 'executionIdentity');
  artifactV6ValidateEngineContracts(artifact.engineContracts);
  artifactV6ValidateEngineContracts(artifact.executionIdentity.engineContracts);
  if (artifact.executionIdentity.schedulerSchema !== 'bigmoe-serial/v1' || artifact.executionIdentity.batchWindowMs !== 0) {
    throw new Error('Artifact V6 execution identity must declare the BigMoE serial scheduler contract.');
  }
  artifactV6ValidateBackend(artifact.backendContract);
  artifactV6ValidateEvidence(artifact.telemetryEvidence);
  if (artifact.schemaVersion !== ARTIFACT_V6_SCHEMA || artifact.provenance.schemaVersion !== ARTIFACT_V6_SCHEMA) {
    throw new Error('Artifact V6 schema/provenance version mismatch.');
  }
  if (!artifact.migration || artifact.migration.exportedAs !== ARTIFACT_V6_SCHEMA ||
      stableValue(artifact.migration.accepts) !== stableValue([ARTIFACT_V4_SCHEMA, ARTIFACT_V5_SCHEMA, ARTIFACT_V6_SCHEMA]) ||
      artifact.migration.requiresExactProvenance !== true) {
    throw new Error('Artifact V6 migration contract is invalid.');
  }
  if (artifact.config?.mode !== 'bigmoe-edge') throw new Error('Artifact V6 is reserved for BigMoEEdge.');
  const validation = validateBigMoeEdgeConfig(artifact.config);
  if (!validation.valid) throw new Error(`Invalid imported BigMoEEdge configuration: ${formatConfigErrors(validation)}`);
  if (artifact.telemetryEvidence && artifact.telemetryEvidence.source.architecture !== artifact.config.model.arch) {
    throw new Error('Artifact V6 telemetry evidence architecture does not match config.model.arch.');
  }
  const resultNumericKeys = ARTIFACT_V5_RESULT_KEYS.filter(key => !['oom', 'modelStatus'].includes(key));
  if (resultNumericKeys.some(key => !Number.isFinite(artifact.result[key]) || artifact.result[key] < 0) ||
      !Number.isSafeInteger(artifact.result.completedTokens) || typeof artifact.result.oom !== 'boolean' ||
      typeof artifact.result.modelStatus !== 'string' || artifact.result.modelStatus.trim() === '') {
    throw new Error('Artifact V6 result contains invalid or non-finite metrics.');
  }
  if (!Array.isArray(artifact.requests) || artifact.requests.length !== 1) throw new Error('Artifact V6 requires exactly one request.');
  for (const request of artifact.requests) artifactV5AssertExactKeys(request, ['id', 'arrivalMs', 'output'], 'request');
  const request = artifact.requests[0];
  if (request.id !== 'request-1' || request.arrivalMs !== 0 || request.output !== artifact.config.output) {
    throw new Error("Artifact V6 request must be canonical: id 'request-1', arrivalMs 0, and output equal to config.output.");
  }
  const expectedProvenance = { ...simulatorProvenance(), schemaVersion: ARTIFACT_V6_SCHEMA };
  if (stableValue(artifact.provenance) !== stableValue(expectedProvenance)) throw new Error('Artifact V6 provenance does not match this build.');
  for (const key of ['modelVersion', 'packageVersion', 'commit', 'buildVersion']) {
    if (artifact[key] !== artifact.provenance[key]) {
      throw new Error(`Artifact V6 ${key} provenance mirror does not match provenance.${key}.`);
    }
  }
  const identity = { ...artifact.executionIdentity, backendContract: artifact.backendContract, telemetryEvidence: artifact.telemetryEvidence };
  const expectedRunId = servingRunId(artifact.config, artifact.requests, artifact.provenance, identity);
  if (artifact.runId !== expectedRunId) throw new Error('Artifact V6 has a noncanonical run ID.');
  const insightError = validateBottleneckInsight(artifact.insight);
  if (insightError) throw new Error(`Invalid imported insight: ${insightError}`);
  if (!Object.prototype.hasOwnProperty.call(artifact, 'sweep')) throw new Error('Artifact V6 sweep field is required.');
}

function installArtifactV6() {
  if (globalThis.__ARTIFACT_V6_INSTALLED__) return false;
  if (typeof installArtifactV5 !== 'function') return false;
  installArtifactV5();
  const createV5 = createScenarioArtifact;
  const parseV5 = parseScenarioArtifactReplay;

  createScenarioArtifact = function createScenarioArtifactV6(config, result, sweepExecution = null, telemetryEvidence = null) {
    if (config?.mode !== 'bigmoe-edge' && result?.c?.mode !== 'bigmoe-edge') {
      return createV5(config, result, sweepExecution);
    }
    artifactV6ValidateEvidence(telemetryEvidence);
    const base = createV5(config, result, sweepExecution);
    const provenance = { ...base.provenance, schemaVersion: ARTIFACT_V6_SCHEMA };
    const backendContract = artifactV6BackendContract();
    const engineContracts = artifactV6EngineContracts();
    const envelope = {
      ...base,
      schemaVersion: ARTIFACT_V6_SCHEMA,
      provenance,
      backendContract,
      engineContracts,
      executionIdentity: {
        schedulerSchema: 'bigmoe-serial/v1',
        batchWindowMs: 0,
        engineContracts: artifactV6EngineContracts()
      },
      telemetryEvidence,
      migration: {
        accepts: [ARTIFACT_V4_SCHEMA, ARTIFACT_V5_SCHEMA, ARTIFACT_V6_SCHEMA],
        exportedAs: ARTIFACT_V6_SCHEMA,
        requiresExactProvenance: true
      }
    };
    const identity = { ...envelope.executionIdentity, backendContract, telemetryEvidence };
    envelope.runId = servingRunId(envelope.config, envelope.requests, provenance, identity);
    artifactV6ValidateEnvelope(envelope);
    return envelope;
  };

  parseScenarioArtifactReplay = function parseScenarioArtifactV6(text, replayOptions = {}) {
    if (typeof text !== 'string' || text.length > 1_000_000) return parseV5(text, replayOptions);
    let artifact;
    try { artifact = JSON.parse(text); } catch (_) { return parseV5(text, replayOptions); }
    if (artifact?.schemaVersion !== ARTIFACT_V6_SCHEMA) return parseV5(text, replayOptions);
    artifactV6ValidateEnvelope(artifact);
    assertScenarioReplayBudget(artifact.config, artifact.sweep);
    validateAndReplaySweep(artifact.sweep);
    const requestError = validateServingRequests(artifact.config, artifact.requests, replayOptions);
    if (requestError) throw new Error(`Invalid imported requests: ${requestError}`);
    const replayResult = runSimulationConfig(sweepClone(artifact.config), replayOptions, sweepClone(artifact.requests));
    if (replayResult.error) throw new Error(`Imported BigMoEEdge replay failed: ${replayResult.error}`);
    if (replayResult.tokens.some(token => token.gpuMs !== 0 || token.pcieGB !== 0) || replayResult.state?.deviceUsedGB !== 0) {
      throw new Error('Artifact V6 replay violated the CPU-only backend contract.');
    }
    const replaySummary = summarizeSimulationResult(replayResult);
    if (!resultSummariesMatch(artifact.result, replaySummary)) throw new Error('Artifact V6 replay result verification failed.');
    const replayInsight = createBottleneckInsight(replayResult);
    if (!bottleneckInsightsMatch(artifact.insight, replayInsight)) throw new Error('Artifact V6 replay insight verification failed.');
    if (replayResult.mode !== 'bigmoe-edge' || replayResult.c?.runtime?.execution !== 'serial' || replayResult.c?.conc !== 1) {
      throw new Error('Artifact V6 replay observed a noncanonical execution identity.');
    }
    const observedExecutionIdentity = {
      schedulerSchema: 'bigmoe-serial/v1',
      batchWindowMs: 0,
      engineContracts: artifactV6EngineContracts()
    };
    if (stableValue(observedExecutionIdentity) !== stableValue(artifact.executionIdentity)) {
      throw new Error('Artifact V6 replay execution identity does not match the declared identity.');
    }
    replayResult.executionIdentity = observedExecutionIdentity;
    replayResult.backendContract = artifactV6BackendContract();
    replayResult.runId = artifact.runId;
    return { artifact, replayResult };
  };

  globalThis.__ARTIFACT_V6_INSTALLED__ = Object.freeze({ schema: ARTIFACT_V6_SCHEMA, backend: artifactV6BackendContract() });
  return true;
}

if (typeof document === 'object' && typeof document.addEventListener === 'function') {
  const install = () => installArtifactV6();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else Promise.resolve().then(install);
}
