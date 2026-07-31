const SWEEP_LIMIT = 50;

function sweepDescriptor(path, category, min, max, options = {}) {
  return Object.freeze({ path, category, min, max, type: options.type || 'number', integer: Boolean(options.integer), values: options.values || null, label: options.label || path });
}

const SWEEP_COMMON = Object.freeze([
  sweepDescriptor('prompt', 'Workload', 0, 1_000_000, { integer: true }), sweepDescriptor('output', 'Workload', 1, 1024, { integer: true }), sweepDescriptor('context', 'Workload', 1, 10_000_000, { integer: true }), sweepDescriptor('conc', 'Workload', 1, 64, { integer: true }), sweepDescriptor('seed', 'Workload', 0, Number.MAX_SAFE_INTEGER, { integer: true }),
  sweepDescriptor('host', 'System / Storage', 0.001, 4096), sweepDescriptor('dramBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('ssdBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('lat', 'System / Storage', 0, 10_000_000),
  sweepDescriptor('mem.policy', 'Memory', 0, 0, { type: 'enum', values: ['strict', 'reclaim', 'swap'] }), sweepDescriptor('mem.backgroundGB', 'Memory', 0, 4096), sweepDescriptor('mem.osReservedGB', 'Memory', 0, 4096), sweepDescriptor('mem.minHeadroomGB', 'Memory', 0, 4096),
  sweepDescriptor('mem.soft', 'Memory', 0.01, 1), sweepDescriptor('mem.compress', 'Memory', 0.01, 1), sweepDescriptor('mem.swap', 'Memory', 0.01, 1), sweepDescriptor('mem.hard', 'Memory', 0.01, 1),
  sweepDescriptor('mem.compressionEnabled', 'Memory', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('mem.compressionRatio', 'Memory', 1, 100), sweepDescriptor('mem.compressionBW', 'Memory', 0.001, 100_000), sweepDescriptor('mem.swapEnabled', 'Memory', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('mem.swapCapacityGB', 'Memory', 0, 16_384), sweepDescriptor('mem.swapWriteRatio', 'Memory', 0.001, 1), sweepDescriptor('mem.kvTouchFraction', 'Memory', 0, 1)
]);

const SWEEP_COLIBRI = Object.freeze([
  sweepDescriptor('arch', 'System / Storage', 0, 0, { type: 'enum', values: ['unified', 'discrete'] }), sweepDescriptor('vram', 'System / Storage', 0, 1024), sweepDescriptor('pcieBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('qd', 'System / Storage', 1, 4096, { integer: true }),
  sweepDescriptor('cold', 'Model', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('placement', 'Model', 0, 0, { type: 'enum', values: ['auto', 'manual'] }), sweepDescriptor('layers', 'Model', 1, 500, { integer: true }), sweepDescriptor('experts', 'Model', 1, 4096, { integer: true }), sweepDescriptor('active', 'Model', 1, 4096, { integer: true }), sweepDescriptor('esize', 'Model', 0.001, 1_000_000), sweepDescriptor('resident', 'Model', 0, 4096), sweepDescriptor('kvKB', 'Model', 0, 1_000_000),
  sweepDescriptor('dcache', 'Memory', 0, 4096), sweepDescriptor('minDCache', 'Memory', 0, 4096), sweepDescriptor('vcache', 'Memory', 0, 1024), sweepDescriptor('pinned', 'Memory', 0, 4096), sweepDescriptor('page', 'Memory', 0, 4096), sweepDescriptor('expertBacking', 'Memory', 0, 0, { type: 'enum', values: ['file', 'anonymous'] }), sweepDescriptor('odirect', 'Memory', 0, 0, { type: 'boolean', values: [false, true] }),
  sweepDescriptor('corr', 'Compute', 0, 1), sweepDescriptor('attn', 'Compute', 0, 1_000_000), sweepDescriptor('ems', 'Compute', 0, 1_000_000), sweepDescriptor('par', 'Compute', 1, 4096, { integer: true }), sweepDescriptor('prefillSpeedup', 'Compute', 0.001, 1_000_000),
  sweepDescriptor('pf', 'Prefetch', 0, 0, { type: 'boolean', values: [false, true] }), sweepDescriptor('prefetchPolicy', 'Prefetch', 0, 0, { type: 'enum', values: ['none', 'previous-token', 'popularity'] }), sweepDescriptor('recall', 'Prefetch', 0, 1), sweepDescriptor('precision', 'Prefetch', 0.001, 1), sweepDescriptor('budget', 'Prefetch', 0, 1_000_000)
]);

const SWEEP_AFM = Object.freeze([
  sweepDescriptor('totalB', 'Model', 0.001, 1_000_000), sweepDescriptor('layers', 'Model', 1, 500, { integer: true }), sweepDescriptor('hidden', 'Model', 1, 1_000_000, { integer: true }), sweepDescriptor('active', 'Model', 1, 4096, { integer: true }), sweepDescriptor('shared', 'Model', 0, 4096, { integer: true }), sweepDescriptor('expertWidth', 'Model', 1, 1_000_000, { integer: true }), sweepDescriptor('activeDim', 'Model', 1, 100_000_000, { integer: true }), sweepDescriptor('projections', 'Model', 1, 16, { integer: true }), sweepDescriptor('chunks', 'Model', 1, 128, { integer: true }), sweepDescriptor('bits', 'Model', 1, 16), sweepDescriptor('packing', 'Model', 1, 10), sweepDescriptor('commonGB', 'Model', 0, 4096),
  sweepDescriptor('freq', 'Compute', 1, 1_000_000, { integer: true }), sweepDescriptor('overlap', 'Compute', 0, 1), sweepDescriptor('initSel', 'Compute', 0, 1_000_000), sweepDescriptor('periodicSel', 'Compute', 0, 1_000_000), sweepDescriptor('patchBase', 'Compute', 0, 1_000_000), sweepDescriptor('patchBW', 'System / Storage', 0.001, 1e12), sweepDescriptor('attn', 'Compute', 0, 1_000_000), sweepDescriptor('ffn', 'Compute', 0, 1_000_000), sweepDescriptor('runtime', 'Compute', 0, 1_000_000), sweepDescriptor('prefillTPS', 'Compute', 0.001, 1_000_000), sweepDescriptor('chunkMode', 'Compute', 0, 0, { type: 'enum', values: ['sequential', 'pipelined'] }), sweepDescriptor('doubleBuffer', 'Compute', 0, 0, { type: 'boolean', values: [false, true] })
]);

function sweepCatalogForConfig(config) {
  if (!config || !['colibri', 'afm3'].includes(config.mode)) return [];
  const catalog = [...SWEEP_COMMON, ...(config.mode === 'afm3' ? SWEEP_AFM : SWEEP_COLIBRI)];
  if (config.mode === 'afm3') return catalog;
  return catalog.filter(descriptor => {
    if (config.arch === 'unified' && ['vram', 'pcieBW'].includes(descriptor.path)) return false;
    if (config.placement === 'auto' && ['dcache', 'vcache'].includes(descriptor.path)) return false;
    if (config.placement === 'manual' && descriptor.path === 'minDCache') return false;
    return true;
  });
}

function sweepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sweepValueAtPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setSweepPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
  return object;
}

function normalizeSweepRelations(config, changedPaths) {
  if (config.mode !== 'afm3') return config;
  const paths = new Set(changedPaths);
  const activeOnly = paths.has('active') && !paths.has('shared');
  const sharedOnly = paths.has('shared') && !paths.has('active');
  if (activeOnly && config.shared > config.active) config.shared = config.active;
  if (sharedOnly && config.active < config.shared) config.active = config.shared;
  if (paths.has('active') || paths.has('shared')) config.routed = config.active - config.shared;
  if ((paths.has('active') || paths.has('shared') || paths.has('expertWidth')) && !paths.has('activeDim')) config.activeDim = config.active * config.expertWidth;
  return config;
}

function autoSweepValues(descriptor, baselineValue) {
  if (descriptor.type !== 'number' || !Number.isFinite(baselineValue)) return [...(descriptor.values || [])];
  const values = [0.5, 0.75, 1, 1.5, 2].map(ratio => clamp(baselineValue * ratio, descriptor.min, descriptor.max)).map(value => descriptor.integer ? Math.round(value) : Number(value.toPrecision(12)));
  return [...new Set(values)].sort((a, b) => a - b);
}

function parseCustomSweepValues(descriptor, text) {
  const parts = String(text).split(',').map(value => value.trim());
  const values = parts.map(Number);
  if (!parts.length || parts.some(value => value === '') || values.some(value => !Number.isFinite(value))) throw new Error(`${descriptor.path}: custom values must all be valid numbers.`);
  if (descriptor.integer && values.some(value => !Number.isInteger(value))) throw new Error(`${descriptor.path}: custom values must be integers.`);
  if (values.some(value => value < descriptor.min || value > descriptor.max)) throw new Error(`${descriptor.path}: custom values are outside the valid range.`);
  return [...new Set(values)];
}

function linearSweepValues(descriptor, min, max, steps, scale = 'linear') {
  if (descriptor.type !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isSafeInteger(steps) || steps < 1 || steps > 50 || min > max) throw new Error('Invalid numeric sweep range.');
  if (min < descriptor.min || max > descriptor.max) throw new Error(`${descriptor.path}: sweep bounds are outside the valid range.`);
  if (descriptor.integer && (!Number.isInteger(min) || !Number.isInteger(max))) throw new Error(`${descriptor.path}: sweep bounds must be integers.`);
  if (scale === 'log' && (!(min > 0) || !(max > 0))) throw new Error('Log sweep requires positive bounds.');
  const values = Array.from({ length: steps }, (_, index) => {
    const ratio = steps === 1 ? 0 : index / (steps - 1);
    const value = scale === 'log' ? Math.exp(Math.log(min) + (Math.log(max) - Math.log(min)) * ratio) : min + (max - min) * ratio;
    const bounded = clamp(value, descriptor.min, descriptor.max);
    return descriptor.integer ? Math.round(bounded) : Number(bounded.toPrecision(12));
  });
  return [...new Set(values)];
}

function buildSweepScenarios(baselineConfig, mode, selections, limit = SWEEP_LIMIT) {
  if (!baselineConfig || !['oat', 'grid'].includes(mode) || !Array.isArray(selections) || !selections.length) throw new Error('Sweep mode and at least one parameter selection are required.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SWEEP_LIMIT) throw new Error(`Sweep limit must be between 1 and ${SWEEP_LIMIT}.`);
  for (const selection of selections) {
    if (!selection || typeof selection.path !== 'string' || !Array.isArray(selection.values) || !selection.values.length) throw new Error('Every sweep parameter requires at least one value.');
  }
  const scenarios = [];
  const effectiveSelections = mode === 'oat'
    ? selections.map(selection => ({ ...selection, values: selection.values.filter(value => stableValue(value) !== stableValue(sweepValueAtPath(baselineConfig, selection.path))) }))
    : selections;
  const exactTotal = mode === 'oat'
    ? effectiveSelections.reduce((sum, selection) => sum + selection.values.length, 0)
    : selections.reduce((product, selection) => product > Number.MAX_SAFE_INTEGER / selection.values.length ? Number.MAX_SAFE_INTEGER : product * selection.values.length, 1);
  if (exactTotal < 1) throw new Error('Sweep requires at least one value different from the baseline.');
  const totalExact = mode === 'oat' || selections.reduce((product, selection) => product * BigInt(selection.values.length), 1n) <= BigInt(Number.MAX_SAFE_INTEGER);
  const append = changes => {
    if (scenarios.length >= limit) return;
    const config = sweepClone(baselineConfig);
    for (const [path, value] of Object.entries(changes)) setSweepPath(config, path, value);
    normalizeSweepRelations(config, Object.keys(changes));
    scenarios.push({ index: scenarios.length, changes: sweepClone(changes), config });
  };
  if (mode === 'oat') {
    for (const selection of effectiveSelections) for (const value of selection.values) append({ [selection.path]: value });
  } else {
    const walk = (index, changes) => {
      if (scenarios.length >= limit) return;
      if (index === selections.length) { append(changes); return; }
      const selection = selections[index];
      for (const value of selection.values) {
        walk(index + 1, { ...changes, [selection.path]: value });
        if (scenarios.length >= limit) break;
      }
    };
    walk(0, {});
  }
  return { mode, total: exactTotal, totalExact, omitted: Math.max(0, exactTotal - scenarios.length), scenarios };
}

function sweepPercentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function simulateSweepConfig(config) {
  const validation = validateSimulationConfig(config);
  if (!validation.valid) return { error: `Invalid configuration: ${formatConfigErrors(validation)}`, c: config, mode: config?.mode };
  return runSimulationConfig(sweepClone(config));
}

function summarizeSweepResult(result) {
  if (!result || result.error) {
    const oom = Boolean(result?.oom || result?.state?.oom || /\boom\b/i.test(String(result?.error || '')));
    return { status: oom ? 'oom' : 'invalid', reason: String(result?.error || 'Simulation failed.'), oom, ttftMeanMs: null, ttftP50Ms: null, ttftP95Ms: null, singleTPS: null, aggregateTPS: null };
  }
  const ttfts = result.serving?.requests?.map(request => request.ttftMs).filter(Number.isFinite) || [result.ttft].filter(Number.isFinite);
  const mean = ttfts.length ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : 0;
  return {
    status: result.oom || result.state?.oom ? 'oom' : 'completed',
    reason: result.oom || result.state?.oom ? 'Simulation reached OOM or hard pressure.' : '',
    oom: Boolean(result.oom || result.state?.oom),
    ttftMeanMs: mean,
    ttftP50Ms: sweepPercentile(ttfts, 0.5),
    ttftP95Ms: sweepPercentile(ttfts, 0.95),
    singleTPS: Number(result.tps || 0),
    aggregateTPS: Number(result.serving?.throughputTPS ?? result.agg ?? result.tps ?? 0)
  };
}

function createSweepExecution(baselineConfig, plan) {
  if (!plan || !Array.isArray(plan.scenarios)) throw new Error('A valid sweep plan is required.');
  return {
    schema: 'parameter-sweep/v1',
    baselineConfig: sweepClone(baselineConfig),
    definition: { mode: plan.mode, total: plan.total, omitted: plan.omitted },
    scenarios: plan.scenarios.map(scenario => sweepClone(scenario)),
    status: 'ready',
    nextIndex: 0,
    results: []
  };
}

function advanceSweepExecution(execution) {
  if (!execution || ['paused', 'cancelled', 'completed'].includes(execution.status)) return execution;
  if (execution.nextIndex >= execution.scenarios.length) { execution.status = 'completed'; return execution; }
  execution.status = 'running';
  const scenario = execution.scenarios[execution.nextIndex];
  const simulation = simulateSweepConfig(scenario.config);
  execution.results.push({
    index: scenario.index,
    changes: sweepClone(scenario.changes),
    config: sweepClone(scenario.config),
    runId: simulation.runId || null,
    metrics: summarizeSweepResult(simulation)
  });
  execution.nextIndex++;
  if (execution.nextIndex >= execution.scenarios.length) execution.status = 'completed';
  return execution;
}

function pauseSweepExecution(execution) {
  if (execution && ['ready', 'running'].includes(execution.status)) execution.status = 'paused';
  return execution;
}

function resumeSweepExecution(execution) {
  if (execution?.status === 'paused') execution.status = execution.nextIndex >= execution.scenarios.length ? 'completed' : 'running';
  return execution;
}

function cancelSweepExecution(execution) {
  if (execution && execution.status !== 'completed') execution.status = 'cancelled';
  return execution;
}

function sweepCsvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
