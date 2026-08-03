const SWEEP_LIMIT = 50;

const SWEEP_GUIDE = Object.freeze({
  host: { label: 'Host / unified memory capacity', unit: 'GB', description: 'Physical host RAM, or the shared memory pool on a unified-memory system.', relationship: 'Conditional: changes memory-pressure thresholds and, with auto placement, the derived DRAM Expert cache budget.' },
  dramBW: { label: 'DRAM bandwidth', unit: 'GB/s', description: 'Bandwidth of the host or unified DRAM path after data is resident in memory.', relationship: 'Independent resource limit, but it matters only for traffic modeled on the DRAM path.' },
  ssdBW: { label: 'Effective SSD / NAND bandwidth', unit: 'GB/s', description: 'Rate at which storage can service Expert, window, prefetch, and swap reads/writes.', relationship: 'Independent storage-stage limit; queue depth, latency, workload, and PCIe can still dominate end-to-end time.' },
  pcieBW: { label: 'PCIe host ↔ GPU bandwidth', unit: 'GB/s', description: 'Transfer-link bandwidth between host memory and a discrete GPU; it is not the SSD media read rate.', relationship: 'Conditional: used for discrete GPU transfers and hidden for unified-memory architecture.' },
  vram: { label: 'GPU VRAM capacity', unit: 'GB', description: 'Physical memory capacity on a discrete GPU.', relationship: 'Conditional: with auto placement it changes the derived VRAM Expert cache after KV/workspace reservation.' },
  arch: { label: 'Memory architecture', unit: 'category', description: 'Selects discrete GPU versus unified memory data paths.', relationship: 'Coupled switch: determines whether PCIe and VRAM parameters participate.' },
  placement: { label: 'Expert cache placement', unit: 'category', description: 'Selects automatic capacity-derived caches or explicit manual cache budgets.', relationship: 'Coupled switch: auto derives dcache/vcache; manual uses their configured values.' },
  experts: { label: 'Experts per layer', unit: 'experts', description: 'Total routed Expert count in each MoE layer.', relationship: 'Coupled constraint: active experts cannot exceed total experts.' },
  active: { label: 'Active experts per token', unit: 'experts/token', description: 'Experts selected for each token or AFM active-set size.', relationship: 'Coupled: must fit total experts; AFM also normalizes shared/routed/active dimension.' },
  shared: { label: 'Shared active experts', unit: 'experts/token', description: 'AFM active experts shared across selections.', relationship: 'Coupled: cannot exceed active; changing it updates routed experts.' },
  expertWidth: { label: 'Expert channel width', unit: 'channels', description: 'AFM width contributed by each active Expert.', relationship: 'Coupled: changing it normally updates active FFN dimension.' },
  activeDim: { label: 'Active FFN dimension', unit: 'channels', description: 'Explicit aggregate active feed-forward dimension.', relationship: 'Derived by default from active × expert width unless swept explicitly.' },
  'mem.soft': { label: 'Soft pressure trigger', unit: 'ratio (0–1)', description: 'Physical-memory utilization where reclaim pressure starts.', relationship: 'Ordered threshold: soft ≤ compression ≤ swap ≤ hard.' },
  'mem.compress': { label: 'Compression trigger', unit: 'ratio (0–1)', description: 'Utilization where memory compression starts.', relationship: 'Ordered threshold: soft ≤ compression ≤ swap ≤ hard; compression must be enabled.' },
  'mem.swap': { label: 'Swap trigger', unit: 'ratio (0–1)', description: 'Utilization where swap admission starts.', relationship: 'Ordered threshold: soft ≤ compression ≤ swap ≤ hard; swap policy and swap must be enabled.' },
  'mem.hard': { label: 'Hard pressure limit', unit: 'ratio (0–1)', description: 'Maximum admitted physical-memory utilization before allocations block or fail.', relationship: 'Ordered threshold: soft ≤ compression ≤ swap ≤ hard.' },
  'mem.compressionEnabled': { label: 'Memory compression enabled', unit: 'boolean', description: 'Enables the modeled memory-compression path.', relationship: 'Controls whether compression ratio and bandwidth can affect results.' },
  'mem.swapEnabled': { label: 'Swap enabled', unit: 'boolean', description: 'Enables modeled swap capacity and I/O.', relationship: 'Requires a compatible memory policy; controls swap capacity/write ratio/touch fraction relevance.' },
  pf: { label: 'Prefetch enabled', unit: 'boolean', description: 'Enables Expert prefetch before demand.', relationship: 'Controls whether policy, recall, precision, and budget affect the run.' },
  prefetchPolicy: { label: 'Prefetch policy', unit: 'category', description: 'Selects how candidate Experts are predicted.', relationship: 'Conditional on prefetch enabled; none disables prediction effects.' },
  qd: { label: 'Storage queue depth / workers', unit: 'requests', description: 'Maximum modeled parallel storage service slots.', relationship: 'Interacts with SSD bandwidth and base latency; more workers do not raise the configured SSD bandwidth cap.' }
});

const SWEEP_UNITS = Object.freeze({
  prompt: 'tokens', output: 'tokens', context: 'tokens', conc: 'sequences', seed: 'integer', lat: 'µs', layers: 'layers', esize: 'MB/expert', resident: 'GB', kvKB: 'KB/token', dcache: 'GB', minDCache: 'GB', vcache: 'GB', pinned: 'GB', page: 'GB', corr: 'ratio (0–1)', attn: 'ms/token', ems: 'ms/expert', par: 'experts', prefillSpeedup: '×', recall: 'ratio (0–1)', precision: 'ratio (0–1)', budget: 'MB/layer', totalB: 'billion parameters', hidden: 'channels', projections: 'projections', chunks: 'chunks', bits: 'bits/weight', packing: '×', commonGB: 'GB', freq: 'tokens', overlap: 'ratio (0–1)', initSel: 'ms', periodicSel: 'ms', patchBase: 'ms', patchBW: 'GB/s', ffn: 'ms/token', runtime: 'ms/token', prefillTPS: 'tokens/s', 'mem.backgroundGB': 'GB', 'mem.osReservedGB': 'GB', 'mem.minHeadroomGB': 'GB', 'mem.compressionRatio': '×', 'mem.compressionBW': 'GB/s', 'mem.swapCapacityGB': 'GB', 'mem.swapWriteRatio': 'ratio', 'mem.kvTouchFraction': 'ratio (0–1)'
});

function sweepHumanLabel(path) {
  return path.replace(/^mem\./, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('.', ' / ').replace(/^./, value => value.toUpperCase());
}

function sweepParameterGuide(descriptor, config = {}) {
  const explicit = SWEEP_GUIDE[descriptor.path] || {};
  const typeUnit = descriptor.type === 'boolean' ? 'boolean' : descriptor.type === 'enum' ? 'category' : 'unitless';
  const categoryMeaning = {
    Workload: 'Defines the synthetic request population; it changes demand rather than hardware capacity.',
    Memory: 'Controls memory capacity, residency, pressure, compression, or swap behavior.',
    Model: 'Controls model topology or calibrated model footprint.',
    Compute: 'Controls a calibrated compute or runtime stage.',
    Prefetch: 'Controls speculative Expert loading and its accuracy or budget.',
    'System / Storage': 'Controls a hardware capacity, transfer stage, or storage service limit.'
  }[descriptor.category] || 'Controls one simulator input.';
  return {
    path: descriptor.path,
    label: explicit.label || sweepHumanLabel(descriptor.path),
    unit: explicit.unit || SWEEP_UNITS[descriptor.path] || typeUnit,
    description: explicit.description || categoryMeaning,
    relationship: explicit.relationship || 'OAT changes only this configured value; validity and downstream bottlenecks can still depend on other inputs.',
    behavior: explicit.behavior || 'Metrics change only when this resource or behavior is exercised on the active critical path; a flat sweep can be a valid saturation result.'
  };
}

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
