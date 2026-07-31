const SCENARIO_SCHEMA_VERSION = 'moe-ssd-sim/v2';

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

function createScenarioArtifact(config, result) {
  const validation = validateSimulationConfig(config);
  if (!validation.valid) throw new Error(`Invalid configuration: ${formatConfigErrors(validation)}`);
  const requestShape = result.serving
    ? result.serving.requests.map(request => ({ id: request.id, arrivalMs: request.arrivalMs, output: request.output }))
    : [{ id: 'single', arrivalMs: 0, output: config.output }];
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    runId: servingRunId(config, requestShape),
    modelVersion: '1.5.0',
    requests: requestShape,
    config: JSON.parse(JSON.stringify(config)),
    result: summarizeSimulationResult(result),
    insight: createBottleneckInsight(result)
  };
}

function parseScenarioArtifact(text) {
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
  if (typeof artifact.result.oom !== 'boolean') throw new Error('Invalid imported result status: oom.');
  if (!['Estimated · single-request trend model', 'Estimated · event-driven shared-resource model'].includes(artifact.result.modelStatus)) {
    throw new Error('Invalid imported result status: modelStatus.');
  }
  const insightError = validateBottleneckInsight(artifact.insight);
  if (insightError) throw new Error(`Invalid imported insight: ${insightError}`);
  return artifact;
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
  mode: 'mode', prompt: 'prompt', output: 'output', context: 'context', conc: 'conc', arch: 'arch', host: 'host', vram: 'vram',
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
  const artifact = createScenarioArtifact(config, lastResult);
  const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${artifact.runId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function selectBaseline() {
  if (!lastResult || lastResult.error) return;
  baselineScenario = createScenarioArtifact(lastResult.c, lastResult);
  updateComparison(baselineScenario);
}

async function importScenarioFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size > 1_000_000) throw new Error('Scenario artifact is too large; maximum size is 1MB.');
  const artifact = parseScenarioArtifact(await file.text());
  applyScenarioConfig(artifact.config);
  syncMode(false);
  const result = lastResult;
  if (!result?.error) {
    const replay = createScenarioArtifact(result.c, result);
    if (replay.runId !== artifact.runId) throw new Error('Imported scenario replay produced a different run ID.');
    if (!resultSummariesMatch(artifact.result, replay.result)) throw new Error('Imported scenario replay did not reproduce the stored result summary.');
    if (!bottleneckInsightsMatch(artifact.insight, replay.insight)) throw new Error('Imported scenario replay did not reproduce the stored bottleneck insight.');
    startAnim(result);
    updateComparison(replay);
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
      render({ error: error.message });
    } finally {
      importFile.value = '';
    }
  };
}
