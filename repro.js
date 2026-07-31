const SCENARIO_SCHEMA_VERSION = 'moe-ssd-sim/v3';
const SCENARIO_REPLAY_WORK_MAX = 100_000_000;
let scenarioImportGeneration = 0;
let scenarioImportController = null;
let scenarioImportInProgress = false;

function scenarioImportAbortError() {
  const error = new Error('Scenario import was superseded by a newer import.');
  error.name = 'AbortError';
  return error;
}

function summarizeSimulationResult(result) {
  return {
    completedTokens: result.tokens?.length || result.completedTokens || 0,
    ttftMs: Number(result.ttft ?? result.requests?.[0]?.ttftMs ?? 0),
    tpotMs: Number(result.avg ?? result.p50TokenMs ?? 0),
    throughputTPS: Number(result.serving?.throughputTPS ?? result.throughputTPS ?? result.agg ?? result.tps ?? 0),
    peakMemoryGB: Number(result.state?.peakPhysicalGB ?? 0),
    peakSwapGB: Number(result.state?.peakSwapGB ?? 0),
    storagePerTokenGB: Number(result.ssdPt ?? 0),
    oom: Boolean(result.oom || result.state?.oom),
    modelStatus: result.serving?.modelStatus || 'Estimated · single-request trend model'
  };
}

function compactReplayResultForUI(result) {
  if (!result || typeof result !== 'object') return result;
  const compactState = result.state
    ? Object.fromEntries(Object.entries(result.state).filter(([, value]) => !(value instanceof Map) && !(value instanceof Set) && !Array.isArray(value)))
    : result.state;
  return {
    ...result,
    state: compactState,
    ...(result.serving?.requests ? {
      serving: {
        ...result.serving,
        requests: result.serving.requests.map(({ tokens, ...request }) => request)
      }
    } : {})
  };
}

function serializeSweepExecution(execution) {
  if (!execution || execution.status !== 'completed') return null;
  return {
    schema: 'parameter-sweep/v1',
    status: execution.status,
    baselineConfig: sweepClone(execution.baselineConfig),
    baselineMetrics: sweepClone(execution.baselineMetrics),
    definition: sweepClone(execution.definition),
    selections: sweepClone(execution.selections || []),
    results: sweepClone(execution.results || [])
  };
}

function scenarioReplayWork(config) {
  if (config?.mode === 'colibri') return colibriSimulationWork(config).replayWork;
  if (config?.mode === 'afm3') return config.layers * config.output * (config.conc > 1 ? config.conc + 1 : 1);
  return Infinity;
}

function assertScenarioReplayBudget(config, sweep) {
  const configs = [config];
  if (sweep) configs.push(sweep.baselineConfig, ...sweep.results.map(result => result.config));
  const totalWork = configs.reduce((sum, candidate) => sum + scenarioReplayWork(candidate), 0);
  if (!Number.isFinite(totalWork) || totalWork > SCENARIO_REPLAY_WORK_MAX) {
    throw new Error('Scenario artifact exceeds the 30-second replay work budget.');
  }
}

function createScenarioArtifact(config, result, sweepExecution = null) {
  const canonicalConfig = sweepClone(result?.c || config);
  const validation = validateSimulationConfig(canonicalConfig);
  if (!validation.valid) throw new Error(`Invalid configuration: ${formatConfigErrors(validation)}`);
  const requestShape = result.serving
    ? result.serving.requests.map(request => ({ id: request.id, arrivalMs: request.arrivalMs, output: request.output }))
    : [{ id: 'single', arrivalMs: 0, output: canonicalConfig.output }];
  const sweep = serializeSweepExecution(sweepExecution);
  if (sweep && stableValue(sweep.baselineConfig) !== stableValue(canonicalConfig)) throw new Error('Completed sweep baseline must match the top-level scenario config.');
  assertScenarioReplayBudget(canonicalConfig, sweep);
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    runId: servingRunId(canonicalConfig, requestShape),
    modelVersion: '1.5.0',
    requests: requestShape,
    config: canonicalConfig,
    result: summarizeSimulationResult(result),
    insight: createBottleneckInsight(result),
    sweep
  };
}

function sweepMetricsMatch(expected, actual) {
  if (!expected || !actual || expected.status !== actual.status || expected.oom !== actual.oom || String(expected.reason || '') !== String(actual.reason || '')) return false;
  return ['ttftMeanMs', 'ttftP50Ms', 'ttftP95Ms', 'singleTPS', 'aggregateTPS'].every(key => {
    if (expected[key] === null || actual[key] === null) return expected[key] === null && actual[key] === null;
    return Number.isFinite(expected[key]) && Number.isFinite(actual[key]) && Math.abs(expected[key] - actual[key]) <= 1e-9 * Math.max(1, Math.abs(expected[key]), Math.abs(actual[key]));
  });
}

function validateSweepMetrics(metrics, label) {
  if (!metrics || !['completed', 'invalid', 'oom'].includes(metrics.status) || typeof metrics.oom !== 'boolean' || metrics.oom !== (metrics.status === 'oom') || typeof metrics.reason !== 'string' || metrics.reason.length > 2_000) throw new Error(`Invalid imported sweep metrics: ${label}.`);
  const values = ['ttftMeanMs', 'ttftP50Ms', 'ttftP95Ms', 'singleTPS', 'aggregateTPS'].map(key => metrics[key]);
  if (values.some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw new Error(`Invalid imported sweep metrics: ${label}.`);
  if (metrics.status === 'completed' && values.some(value => !Number.isFinite(value))) throw new Error(`Invalid imported sweep metrics: ${label}.`);
  if (metrics.status === 'invalid' && values.some(value => value !== null)) throw new Error(`Invalid imported sweep metrics: ${label}.`);
  if (metrics.status === 'oom' && !(values.every(value => value === null) || values.every(Number.isFinite))) throw new Error(`Invalid imported sweep metrics: ${label}.`);
}

function validateAndReplaySweep(sweep) {
  if (sweep === null) return;
  if (!sweep || sweep.schema !== 'parameter-sweep/v1') throw new Error('Invalid imported sweep schema.');
  if (sweep.status !== 'completed') throw new Error('Only completed sweep snapshots can be imported.');
  const baselineValidation = validateSimulationConfig(sweep.baselineConfig);
  if (!baselineValidation.valid) throw new Error(`Invalid imported sweep baseline: ${formatConfigErrors(baselineValidation)}`);
  if (!sweep.definition || !['oat', 'grid'].includes(sweep.definition.mode) || !Number.isSafeInteger(sweep.definition.total) || sweep.definition.total < 1 || !Number.isSafeInteger(sweep.definition.omitted) || sweep.definition.omitted < 0) throw new Error('Invalid imported sweep definition.');
  if (!Array.isArray(sweep.selections) || !Array.isArray(sweep.results) || sweep.results.length > SWEEP_LIMIT) throw new Error('Invalid imported sweep result collection.');
  const catalog = new Map(sweepCatalogForConfig(sweep.baselineConfig).map(descriptor => [descriptor.path, descriptor]));
  const seenPaths = new Set();
  for (const selection of sweep.selections) {
    if (!selection || typeof selection.path !== 'string' || seenPaths.has(selection.path) || !catalog.has(selection.path) || !Array.isArray(selection.values) || !selection.values.length || selection.values.length > SWEEP_LIMIT || new Set(selection.values).size !== selection.values.length) throw new Error('Invalid imported sweep selection.');
    const descriptor = catalog.get(selection.path);
    const valuesValid = selection.values.every(value => descriptor.type === 'number'
      ? typeof value === 'number' && Number.isFinite(value) && value >= descriptor.min && value <= descriptor.max && (!descriptor.integer || Number.isInteger(value))
      : descriptor.values.includes(value));
    if (!valuesValid) throw new Error(`Invalid imported sweep selection values: ${selection.path}.`);
    seenPaths.add(selection.path);
  }
  const plan = buildSweepScenarios(sweep.baselineConfig, sweep.definition.mode, sweep.selections, SWEEP_LIMIT);
  if (plan.total !== sweep.definition.total || plan.omitted !== sweep.definition.omitted) throw new Error('Imported sweep definition integrity verification failed.');
  if (sweep.status === 'completed' && sweep.results.length !== plan.scenarios.length) throw new Error('Imported completed sweep result count is incomplete.');
  validateSweepMetrics(sweep.baselineMetrics, 'baseline');
  const baselineReplay = summarizeSweepResult(simulateSweepConfig(sweep.baselineConfig));
  if (!sweepMetricsMatch(sweep.baselineMetrics, baselineReplay)) throw new Error('Imported sweep baseline metrics failed replay verification.');
  for (const [index, row] of sweep.results.entries()) {
    if (!row || !Number.isSafeInteger(row.index) || !row.config || !row.changes || typeof row.changes !== 'object') throw new Error(`Invalid imported sweep result ${index}.`);
    validateSweepMetrics(row.metrics, `row ${index}`);
    const scenario = plan.scenarios[index];
    if (!scenario || row.index !== scenario.index || stableValue(row.changes) !== stableValue(scenario.changes) || stableValue(row.config) !== stableValue(scenario.config)) throw new Error(`Imported sweep scenario integrity verification failed at ${index}.`);
    const replay = simulateSweepConfig(row.config);
    const replayMetrics = summarizeSweepResult(replay);
    if (!sweepMetricsMatch(row.metrics, replayMetrics)) throw new Error(`Imported sweep metric ${index} failed replay verification.`);
    if ((row.runId || null) !== (replay.runId || null)) throw new Error(`Imported sweep run ID ${index} failed replay verification.`);
  }
}

function validateArtifactConfigShape(config) {
  const common = [
    'mode', 'prompt', 'output', 'context', 'conc', 'arch', 'host', 'vram',
    'dramBW', 'pcieBW', 'ssdBW', 'lat', 'seed', 'mem'
  ];
  const modeFields = config?.mode === 'colibri'
    ? [
      'cold', 'placement', 'layers', 'experts', 'active', 'esize', 'resident', 'kvKB',
      'vcache', 'dcache', 'minDCache', 'expertBacking', 'pinned', 'page', 'odirect',
      'corr', 'qd', 'attn', 'ems', 'par', 'prefillSpeedup', 'pf', 'prefetchPolicy',
      'recall', 'precision', 'budget', 'placementInfo'
    ]
    : config?.mode === 'afm3'
      ? [
        'qd', 'totalB', 'layers', 'hidden', 'active', 'shared', 'routed', 'expertWidth',
        'activeDim', 'projections', 'chunks', 'bits', 'packing', 'commonGB', 'freq',
        'overlap', 'initSel', 'periodicSel', 'patchBase', 'patchBW', 'attn', 'ffn',
        'runtime', 'prefillTPS', 'chunkMode', 'doubleBuffer', 'kvKB'
      ]
      : [];
  const allowedTopLevel = new Set([...common, ...modeFields]);
  const unknownTopLevel = Object.keys(config || {}).find(key => !allowedTopLevel.has(key));
  if (unknownTopLevel) throw new Error(`Unsupported config field: ${unknownTopLevel}.`);
  const allowedMemory = new Set([
    'policy', 'backgroundGB', 'osReservedGB', 'minHeadroomGB', 'soft', 'compress',
    'swap', 'hard', 'compressionEnabled', 'compressionRatio', 'compressionBW',
    'swapEnabled', 'swapCapacityGB', 'swapWriteRatio', 'kvTouchFraction'
  ]);
  const unknownMemory = Object.keys(config?.mem || {}).find(key => !allowedMemory.has(key));
  if (unknownMemory) throw new Error(`Unsupported config field: mem.${unknownMemory}.`);
  if (config?.placementInfo !== undefined) {
    if (config.mode !== 'colibri' || !config.placementInfo || typeof config.placementInfo !== 'object' || Array.isArray(config.placementInfo)) throw new Error('Unsupported config field: placementInfo.');
    const manualFields = ['policy', 'expertPoolGB', 'hostExpertPoolGB', 'pinnedExpertsPerLayer', 'anticipatedKvGB', 'dcacheGB', 'vcacheGB'];
    const autoFields = [...manualFields, 'placementTargetRatio', 'hostBudgetGB', 'hostFixedGB', 'hostKvGB', 'deviceKvGB', 'deviceReserveGB'];
    const allowedPlacement = new Set(config.placementInfo.policy === 'manual' ? manualFields : config.placementInfo.policy === 'auto' ? autoFields : []);
    if (config.placementInfo.policy !== config.placement) throw new Error('Invalid config field: placementInfo.policy.');
    const placementKeys = Object.keys(config.placementInfo);
    const unknownPlacement = placementKeys.find(key => !allowedPlacement.has(key));
    if (!allowedPlacement.size || unknownPlacement || placementKeys.length !== allowedPlacement.size) throw new Error(`Unsupported config field: placementInfo${unknownPlacement ? `.${unknownPlacement}` : '.shape'}.`);
    for (const [key, value] of Object.entries(config.placementInfo)) {
      if (key !== 'policy' && (!Number.isFinite(value) || value < 0 || (key === 'placementTargetRatio' && value > 1))) throw new Error(`Invalid config field: placementInfo.${key}.`);
    }
    if (!Number.isSafeInteger(config.placementInfo.pinnedExpertsPerLayer)) throw new Error('Invalid config field: placementInfo.pinnedExpertsPerLayer.');
  }
}

function parseScenarioArtifactReplay(text) {
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Scenario artifact is too large; maximum size is 1MB.');
  let artifact;
  try {
    artifact = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid scenario JSON: ${error.message}`);
  }
  if (!artifact || artifact.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    throw new Error(`Unsupported scenario schema: ${artifact?.schemaVersion || 'missing'}`);
  }
  if (!/^sim-[0-9a-f]{8}$/.test(artifact.runId || '')) {
    throw new Error('Invalid run ID in imported scenario.');
  }
  validateArtifactConfigShape(artifact.config);
  const validation = validateSimulationConfig(artifact.config);
  if (!validation.valid) throw new Error(`Invalid imported configuration: ${formatConfigErrors(validation)}`);
  if (artifact.modelVersion !== '1.5.0') throw new Error(`Unsupported model version: ${artifact.modelVersion || 'missing'}`);
  const requestError = validateServingRequests(artifact.config, artifact.requests, {});
  if (requestError) throw new Error(`Invalid imported requests: ${requestError}`);
  if (artifact.requests.length !== artifact.config.conc) throw new Error('Imported request count must match config.conc.');
  const expectedRunId = servingRunId(artifact.config, artifact.requests);
  if (artifact.runId !== expectedRunId) throw new Error('Imported run ID does not match its config and requests.');
  if (!artifact.result || typeof artifact.result !== 'object') throw new Error('Imported result summary is required.');
  for (const metric of ['completedTokens', 'ttftMs', 'tpotMs', 'throughputTPS', 'peakMemoryGB', 'peakSwapGB', 'storagePerTokenGB']) {
    if (!Number.isFinite(artifact.result[metric]) || artifact.result[metric] < 0) throw new Error(`Invalid imported result metric: ${metric}.`);
  }
  if (!Number.isSafeInteger(artifact.result.completedTokens)) throw new Error('Invalid imported result metric: completedTokens must be an integer.');
  if (typeof artifact.result.oom !== 'boolean') throw new Error('Invalid imported result status: oom.');
  if (!['Estimated · single-request trend model', 'Estimated · event-driven shared-resource model'].includes(artifact.result.modelStatus)) {
    throw new Error('Invalid imported result status: modelStatus.');
  }
  const insightError = validateBottleneckInsight(artifact.insight);
  if (insightError) throw new Error(`Invalid imported insight: ${insightError}`);
  if (!Object.prototype.hasOwnProperty.call(artifact, 'sweep')) throw new Error('Imported scenario sweep field is required.');
  if (artifact.sweep && stableValue(artifact.sweep.baselineConfig) !== stableValue(artifact.config)) throw new Error('Imported sweep baseline does not match the top-level scenario config.');
  assertScenarioReplayBudget(artifact.config, artifact.sweep);
  validateAndReplaySweep(artifact.sweep);
  const replayResult = runSimulationConfig(sweepClone(artifact.config));
  if (replayResult.error) throw new Error(`Imported scenario replay failed: ${replayResult.error}`);
  if (replayResult.runId !== artifact.runId) throw new Error('Imported scenario replay produced a noncanonical run ID.');
  if (stableValue(replayResult.c) !== stableValue(artifact.config)) throw new Error('Imported scenario configuration is not canonical.');
  const replaySummary = summarizeSimulationResult(replayResult);
  if (!resultSummariesMatch(artifact.result, replaySummary)) throw new Error('Imported scenario replay result verification failed.');
  const replayInsight = createBottleneckInsight(replayResult);
  if (!bottleneckInsightsMatch(artifact.insight, replayInsight)) throw new Error('Imported scenario replay insight verification failed.');
  return { artifact, replayResult };
}

function parseScenarioArtifact(text) {
  return parseScenarioArtifactReplay(text).artifact;
}

function verifyScenarioArtifactAsync(text, signal = null) {
  if (typeof text !== 'string' || text.length > 1_000_000) return Promise.reject(new Error('Scenario artifact is too large; maximum size is 1MB.'));
  if (typeof Worker === 'undefined') return Promise.reject(new Error('Scenario import requires Web Worker support.'));
  if (signal?.aborted) return Promise.reject(scenarioImportAbortError());
  return new Promise((resolve, reject) => {
    const worker = new Worker('replay-worker.js');
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      callback(value);
    };
    const abort = () => finish(reject, scenarioImportAbortError());
    const timeout = setTimeout(() => finish(reject, new Error('Scenario replay exceeded the 30-second work budget.')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => event.data?.error
      ? finish(reject, new Error(event.data.error))
      : finish(resolve, event.data);
    worker.onerror = event => finish(reject, new Error(event.message || 'Scenario replay worker failed.'));
    worker.postMessage(text);
  });
}

function parseScenarioArtifactAsync(text) {
  return verifyScenarioArtifactAsync(text).then(result => result.artifact);
}

function compareResultSummaries(baseline, candidate) {
  const metrics = ['ttftMs', 'tpotMs', 'throughputTPS', 'peakMemoryGB'];
  return Object.fromEntries(metrics.map(metric => [metric, Number(candidate[metric] || 0) - Number(baseline[metric] || 0)]));
}

function resultSummariesMatch(expected, actual) {
  const metrics = ['completedTokens', 'ttftMs', 'tpotMs', 'throughputTPS', 'peakMemoryGB', 'peakSwapGB', 'storagePerTokenGB'];
  const numericMatch = metrics.every(metric => {
    const a = expected?.[metric], b = actual?.[metric];
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  });
  return numericMatch && expected?.oom === actual?.oom && expected?.modelStatus === actual?.modelStatus;
}

const CONFIG_CONTROL_MAP = {
  mode: 'mode', prompt: 'prompt', output: 'output', context: 'context', conc: 'conc', seed: 'seed', arch: 'arch', host: 'host', vram: 'vram',
  dramBW: 'dramBW', pcieBW: 'pcieBW', ssdBW: 'ssdBW', lat: 'lat', cold: 'cold', placement: 'placement', layers: 'layers', experts: 'experts',
  active: 'active', esize: 'esize', resident: 'resident', kvKB: 'kv', vcache: 'vcache', dcache: 'dcache', minDCache: 'minDCache', expertBacking: 'expertBacking',
  pinned: 'pinned', page: 'page', odirect: 'odirect', corr: 'corr', qd: 'qd', attn: 'attn', ems: 'ems', par: 'par', prefillSpeedup: 'prefillSpeedup',
  pf: 'pf', prefetchPolicy: 'prefetchPolicy', recall: 'recall', precision: 'precision', budget: 'budget', totalB: 'afmTotalB', hidden: 'afmHidden',
  shared: 'afmShared', expertWidth: 'afmExpertWidth', activeDim: 'afmActiveDim', projections: 'afmProjections', chunks: 'afmChunks', bits: 'afmBits',
  packing: 'afmPacking', commonGB: 'afmCommonGB', freq: 'afmFreq', overlap: 'afmOverlap', initSel: 'afmInitSel', periodicSel: 'afmPeriodicSel',
  patchBase: 'afmPatchBase', patchBW: 'afmPatchBW', ffn: 'afmFFN', runtime: 'afmRuntime', prefillTPS: 'afmPrefillTPS', chunkMode: 'afmChunkMode', doubleBuffer: 'afmDoubleBuffer'
};

const MEMORY_CONTROL_MAP = {
  policy: 'memPolicy', backgroundGB: 'backgroundGB', osReservedGB: 'osReservedGB', minHeadroomGB: 'minHeadroomGB',
  compressionEnabled: 'compressionEnabled', compressionRatio: 'compressionRatio', compressionBW: 'compressionBW', swapEnabled: 'swapEnabled',
  swapCapacityGB: 'swapCapacityGB', swapWriteRatio: 'swapWriteRatio', kvTouchFraction: 'kvTouchFraction'
};

function setControlValue(id, value) {
  const control = typeof $ === 'function' ? $(id) : null;
  if (!control || value === undefined) return;
  if (control.type === 'checkbox') control.checked = Boolean(value);
  else control.value = String(value);
}

function applyScenarioConfig(config) {
  for (const [key, id] of Object.entries(CONFIG_CONTROL_MAP)) setControlValue(id, config[key]);
  for (const [key, id] of Object.entries(MEMORY_CONTROL_MAP)) setControlValue(id, config.mem?.[key]);
  if (typeof markModelPresetCustom === 'function') markModelPresetCustom();
  setControlValue('softPct', config.mem?.soft * 100);
  setControlValue('compressPct', config.mem?.compress * 100);
  setControlValue('swapPct', config.mem?.swap * 100);
  setControlValue('hardPct', config.mem?.hard * 100);
  if (config.mode === 'afm3') {
    setControlValue('afmLayers', config.layers);
    setControlValue('afmActive', config.active);
    setControlValue('afmAttn', config.attn);
  }
}

let baselineScenario = null;

function updateComparison(candidate) {
  const target = typeof $ === 'function' ? $('comparisonSummary') : null;
  if (!target) return;
  if (!baselineScenario) {
    target.innerHTML = '<tr><td colspan="2">No baseline selected.</td></tr>';
    return;
  }
  const delta = compareResultSummaries(baselineScenario.result, candidate.result);
  const signed = (value, unit) => `${value >= 0 ? '+' : ''}${fmt(value, 2)} ${unit}`;
  target.innerHTML = rows([
    ['Baseline → candidate', `${baselineScenario.runId} → ${candidate.runId}`],
    ['Δ TTFT', signed(delta.ttftMs, 'ms')],
    ['Δ TPOT', signed(delta.tpotMs, 'ms')],
    ['Δ throughput', signed(delta.throughputTPS, 'tok/s')],
    ['Δ peak memory', signed(delta.peakMemoryGB, 'GB')]
  ]);
}

function downloadScenario() {
  if (!lastResult || lastResult.error) return;
  const config = lastResult.c || ($('mode').value === 'afm3' ? readAFM() : readColibri());
  const artifact = createScenarioArtifact(config, lastResult, typeof activeSweepExecution !== 'undefined' ? activeSweepExecution : null);
  const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${artifact.runId}.json`;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 0);
}

function selectBaseline() {
  if (!lastResult || lastResult.error) return;
  baselineScenario = createScenarioArtifact(lastResult.c, lastResult);
  updateComparison(baselineScenario);
}

function snapshotScenarioUIState() {
  return {
    controls: [...document.querySelectorAll('input:not([type="file"]), select, textarea')].map(control => ({ control, value: control.value, checked: control.checked })),
    sweep: typeof activeSweepExecution === 'undefined' ? null : activeSweepExecution,
    result: lastResult
  };
}

function restoreScenarioUIState(state) {
  for (const entry of state.controls) {
    entry.control.value = entry.value;
    if ('checked' in entry.control) entry.control.checked = entry.checked;
  }
  syncModeControls(false);
  lastResult = state.result;
  if (lastResult) render(lastResult);
  activeSweepExecution = state.sweep;
  if (activeSweepExecution) renderSweepResults(activeSweepExecution); else resetSweepResults();
}

async function importScenarioFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size > 1_000_000) throw new Error('Scenario artifact is too large; maximum size is 1MB.');
  const sweepBusy = (typeof sweepPreparing !== 'undefined' && sweepPreparing)
    || (typeof sweepScenarioInFlight !== 'undefined' && sweepScenarioInFlight)
    || ['ready', 'running', 'paused'].includes(activeSweepExecution?.status);
  if (sweepBusy) throw new Error('Cancel the active sweep before importing a scenario.');
  const generation = ++scenarioImportGeneration;
  scenarioImportController?.abort();
  const controller = new AbortController();
  scenarioImportController = controller;
  scenarioImportInProgress = true;
  try {
    const text = await file.text();
    if (generation !== scenarioImportGeneration) throw scenarioImportAbortError();
    const verified = await verifyScenarioArtifactAsync(text, controller.signal);
    if (generation !== scenarioImportGeneration) throw scenarioImportAbortError();
    const artifact = verified.artifact;
    const previous = snapshotScenarioUIState();
    try {
      applyScenarioConfig(artifact.config);
      syncModeControls(false);
      const result = verified.replayResult;
      lastResult = result;
      render(result);
      const replay = createScenarioArtifact(result.c, result, null);
      if (replay.runId !== artifact.runId) throw new Error('Imported scenario replay produced a different run ID.');
      if (!resultSummariesMatch(artifact.result, replay.result)) throw new Error('Imported scenario replay did not reproduce the stored result summary.');
      if (!bottleneckInsightsMatch(artifact.insight, replay.insight)) throw new Error('Imported scenario replay did not reproduce the stored bottleneck insight.');
      if (artifact.sweep) {
        activeSweepExecution = {
          schema: artifact.sweep.schema,
          status: artifact.sweep.status,
          baselineConfig: sweepClone(artifact.sweep.baselineConfig),
          baselineMetrics: sweepClone(artifact.sweep.baselineMetrics),
          definition: sweepClone(artifact.sweep.definition),
          selections: sweepClone(artifact.sweep.selections),
          scenarios: artifact.sweep.results.map(row => ({ index: row.index, changes: sweepClone(row.changes), config: sweepClone(row.config) })),
          nextIndex: artifact.sweep.results.length,
          results: sweepClone(artifact.sweep.results)
        };
        renderSweepResults(activeSweepExecution);
      } else resetSweepResults();
      startAnim(result);
      updateComparison(replay);
    } catch (error) {
      restoreScenarioUIState(previous);
      throw error;
    }
  } catch (error) {
    if (generation !== scenarioImportGeneration) throw scenarioImportAbortError();
    throw error;
  } finally {
    if (generation === scenarioImportGeneration) {
      scenarioImportController = null;
      scenarioImportInProgress = false;
    }
  }
}

function initializeReproControls() {
  if (typeof document === 'undefined' || typeof $ !== 'function') return;
  const exportButton = $('exportScenario');
  const baselineButton = $('setBaseline');
  const importButton = $('importScenario');
  const importFile = $('importScenarioFile');
  if (exportButton) exportButton.onclick = downloadScenario;
  if (baselineButton) baselineButton.onclick = selectBaseline;
  if (importButton && importFile) importButton.onclick = () => importFile.click();
  if (importFile) importFile.onchange = async () => {
    try {
      if (importFile.files?.[0]) await importScenarioFile(importFile.files[0]);
    } catch (error) {
      if (error.name !== 'AbortError') render({ error: error.message });
    } finally {
      importFile.value = '';
    }
  };
}
