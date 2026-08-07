const SIMULATION_LIMITS = Object.freeze({
  prompt: Object.freeze({ min: 0, max: 1_000_000, step: 1 }),
  output: Object.freeze({ min: 1, max: 1024, step: 1 }),
  swapWriteRatio: Object.freeze({ min: 0.001, max: 1, step: 0.001 })
});

function applySimulationInputLimits(documentObject = document) {
  const controls = { prompt: 'prompt', output: 'output', swapWriteRatio: 'swapWriteRatio' };
  for (const [key, id] of Object.entries(controls)) {
    const control = documentObject?.getElementById?.(id);
    if (!control) continue;
    const limit = SIMULATION_LIMITS[key];
    control.min = String(limit.min);
    control.max = String(limit.max);
    control.step = String(limit.step);
  }
}

function intVal(id, fallback) {
  const value = val(id, fallback);
  return Number.isSafeInteger(value) ? value : NaN;
}

function readMemoryPolicy() {
  const soft = val('softPct', 80) / 100;
  const compress = val('compressPct', 85) / 100;
  const swap = val('swapPct', 90) / 100;
  const hard = val('hardPct', 97) / 100;
  return {
    policy: $('memPolicy').value,
    backgroundGB: val('backgroundGB', 8),
    osReservedGB: val('osReservedGB', 8),
    minHeadroomGB: val('minHeadroomGB', 8),
    soft,
    compress,
    swap,
    hard,
    compressionEnabled: $('compressionEnabled').checked,
    compressionRatio: val('compressionRatio', 1.6),
    compressionBW: val('compressionBW', 25),
    swapEnabled: $('swapEnabled').checked,
    swapCapacityGB: val('swapCapacityGB', 32),
    swapWriteRatio: val('swapWriteRatio', 0.7),
    kvTouchFraction: val('kvTouchFraction', 1)
  };
}

function readCommon() {
  return {
    mode: $('mode').value,
    prompt: intVal('prompt', 128),
    output: intVal('output', 64),
    context: intVal('context', 4096),
    conc: intVal('conc', 1),
    arch: $('arch').value,
    host: val('host', 128),
    vram: val('vram', 8),
    dramBW: val('dramBW', 273),
    pcieBW: val('pcieBW', 24),
    ssdBW: val('ssdBW', 9.2),
    lat: val('lat', 120),
    seed: intVal('seed', 260730),
    mem: readMemoryPolicy()
  };
}

function colibriDeviceProfileFor(c) {
  if (typeof deriveColibriDeviceProfile === 'function') return deriveColibriDeviceProfile(c);
  return {
    mode: 'legacy', attentionDevice: 'gpu', expertDevice: 'gpu', usesGpu: true,
    quantization: { effectiveExpertMB: c.esize }
  };
}

function colibriEffectiveExpertMB(c) {
  return colibriDeviceProfileFor(c).quantization.effectiveExpertMB;
}

function colibriCapacity(input) {
  const effectiveExpertMB = colibriEffectiveExpertMB(input);
  const c = { ...input, esize: effectiveExpertMB };
  const expertPoolGB = Math.max(0, c.layers * c.experts * c.esize * 1.03 / 1000);
  const pinnedExpertsPerLayer = Math.min(
    c.experts,
    Math.max(0, Math.floor(c.pinned * 1000 / (c.esize * 1.03) / c.layers))
  );
  const hostExpertPoolGB = Math.max(
    0,
    c.layers * (c.experts - pinnedExpertsPerLayer) * c.esize * 1.03 / 1000
  );
  const anticipatedKvGB = Math.max(0, (c.context + c.prompt + c.output) * c.kvKB * 1000 * c.conc / 1e9);
  return { expertPoolGB, hostExpertPoolGB, pinnedExpertsPerLayer, anticipatedKvGB, effectiveExpertMB };
}

function applyColibriPlacement(input) {
  const profile = colibriDeviceProfileFor(input);
  const capacity = colibriCapacity(input);
  const c = { ...input, esize: capacity.effectiveExpertMB };
  const { expertPoolGB, hostExpertPoolGB, pinnedExpertsPerLayer, anticipatedKvGB } = capacity;
  if (c.placement !== 'auto') {
    c.placement = 'manual';
    c.placementInfo = {
      policy: 'manual',
      expertPoolGB,
      hostExpertPoolGB,
      pinnedExpertsPerLayer,
      anticipatedKvGB,
      dcacheGB: c.dcache,
      vcacheGB: c.vcache
    };
    return c;
  }

  const deviceReserveGB = typeof colibriDeviceReserveGB === 'function'
    ? colibriDeviceReserveGB(c, profile)
    : c.arch === 'discrete' ? 0.8 : 0;
  const deviceBudgetGB = Math.max(0, c.vram - deviceReserveGB);
  const deviceKvGB = c.arch === 'discrete' && profile.attentionDevice === 'gpu'
    ? Math.min(anticipatedKvGB, deviceBudgetGB)
    : 0;
  const hostKvGB = anticipatedKvGB - deviceKvGB;
  const vcacheGB = c.arch === 'discrete' && profile.usesGpu
    ? Math.min(expertPoolGB, Math.max(0, deviceBudgetGB - deviceKvGB))
    : 0;
  const placementTargetRatio = c.mem.policy === 'strict' ? c.mem.hard : c.mem.soft;
  const hostBudgetGB = Math.max(0, Math.min(
    c.host * placementTargetRatio,
    c.host - c.mem.minHeadroomGB
  ));
  const hostFixedGB =
    c.resident +
    c.pinned +
    c.page +
    c.mem.osReservedGB +
    c.mem.backgroundGB +
    3 +
    (c.arch === 'unified' ? 0.8 : 0) +
    hostKvGB;
  const dcacheGB = Math.min(hostExpertPoolGB, Math.max(0, hostBudgetGB - hostFixedGB));

  c.vcache = vcacheGB;
  c.dcache = dcacheGB;
  c.minDCache = Math.min(c.minDCache, dcacheGB);
  c.placementInfo = {
    policy: 'auto',
    expertPoolGB,
    hostExpertPoolGB,
    pinnedExpertsPerLayer,
    anticipatedKvGB,
    placementTargetRatio,
    hostBudgetGB,
    hostFixedGB,
    hostKvGB,
    deviceKvGB,
    deviceReserveGB,
    dcacheGB,
    vcacheGB
  };
  return c;
}

function readColibri() {
  const b = readCommon();
  const c = {
    ...b,
    cold: $('cold').checked,
    placement: $('placement').value,
    layers: intVal('layers', 75),
    experts: intVal('experts', 256),
    active: intVal('active', 8),
    esize: val('esize', 19),
    resident: val('resident', 9.9),
    kvKB: val('kv', 182),
    vcache: val('vcache', 4),
    dcache: val('dcache', 30),
    minDCache: val('minDCache', 4),
    expertBacking: $('expertBacking').value,
    pinned: val('pinned', 6),
    page: val('page', 5),
    odirect: $('odirect').checked,
    corr: val('corr', 0.52),
    qd: intVal('qd', 8),
    attn: val('attn', 28),
    ems: val('ems', 0.7),
    par: intVal('par', 4),
    prefillSpeedup: val('prefillSpeedup', 4.5),
    pf: $('pf').checked,
    prefetchPolicy: $('prefetchPolicy').value,
    recall: val('recall', 0.716),
    precision: val('precision', 0.78),
    budget: val('budget', 160)
  };
  if (c.odirect) c.page = 0;
  return c;
}

function readBigMoeEdge() {
  const preset = bigMoeEdgePreset();
  const controlValue = (id, fallback) => {
    const control = $(id);
    return control && control.value !== '' ? control.value : fallback;
  };
  return {
    mode: 'bigmoe-edge',
    prompt: intVal('prompt', preset.prompt),
    output: intVal('output', preset.output),
    context: intVal('context', preset.context),
    conc: intVal('conc', 1),
    seed: intVal('seed', preset.seed),
    host: val('host', preset.host),
    dramBW: val('dramBW', preset.dramBW),
    ssdBW: val('ssdBW', preset.ssdBW),
    lat: val('lat', preset.lat),
    mem: { ...preset.mem },
    model: {
      arch: controlValue('bmoeArch', preset.model.arch),
      layers: intVal('bmoeLayers', preset.model.layers),
      experts: intVal('bmoeExperts', preset.model.experts),
      active: intVal('bmoeActive', preset.model.active),
      expertProjectionMiB: [
        val('bmoeGateMiB', preset.model.expertProjectionMiB[0]),
        val('bmoeUpMiB', preset.model.expertProjectionMiB[1]),
        val('bmoeDownMiB', preset.model.expertProjectionMiB[2])
      ],
      denseResidentGB: val('bmoeDenseGB', preset.model.denseResidentGB),
      kvKB: val('bmoeKvKB', preset.model.kvKB),
      quantization: controlValue('bmoeQuantization', preset.model.quantization),
      sharedExpertGB: val('bmoeSharedGB', preset.model.sharedExpertGB)
    },
    runtime: {
      threads: intVal('bmoeThreads', preset.runtime.threads),
      referenceThreads: intVal('bmoeRefThreads', preset.runtime.referenceThreads),
      threadScalingExponent: val('bmoeThreadExponent', preset.runtime.threadScalingExponent),
      ioThreads: intVal('bmoeIoThreads', preset.runtime.ioThreads),
      odirect: $('bmoeOdirect')?.checked ?? preset.runtime.odirect,
      execution: 'serial',
      cacheMode: controlValue('bmoeCacheMode', preset.runtime.cacheMode),
      cacheMiB: val('bmoeCacheMiB', preset.runtime.cacheMiB),
      denseWeights: controlValue('bmoeDenseWeights', preset.runtime.denseWeights),
      attentionMs: val('bmoeAttentionMs', preset.runtime.attentionMs),
      expertMs: val('bmoeExpertMs', preset.runtime.expertMs),
      prefillTPS: val('bmoePrefillTPS', preset.runtime.prefillTPS),
      managementMs: val('bmoeManagementMs', preset.runtime.managementMs),
      loopOverheadMs: val('bmoeLoopMs', preset.runtime.loopOverheadMs)
    },
    calibration: { ...preset.calibration }
  };
}

function readAFM() {
  const b = readCommon();
  const active = intVal('afmActive', 46);
  const shared = intVal('afmShared', 23);
  const expertWidth = intVal('afmExpertWidth', 256);
  const layers = intVal('afmLayers', 44);
  const hidden = intVal('afmHidden', 1536);
  const projections = intVal('afmProjections', 3);
  const chunks = intVal('afmChunks', 2);
  const bits = val('afmBits', 2);
  const packing = val('afmPacking', 1.08);
  const overlap = val('afmOverlap', 0.65);
  return {
    ...b,
    mode: 'afm3',
    arch: 'unified',
    qd: 1,
    totalB: val('afmTotalB', 20),
    layers,
    hidden,
    active,
    shared,
    routed: active - shared,
    expertWidth,
    activeDim: intVal('afmActiveDim', 11776),
    projections,
    chunks,
    bits,
    packing,
    commonGB: val('afmCommonGB', 1.4),
    freq: intVal('afmFreq', 32),
    overlap,
    initSel: val('afmInitSel', 10),
    periodicSel: val('afmPeriodicSel', 3),
    patchBase: val('afmPatchBase', 2),
    patchBW: val('afmPatchBW', 60),
    attn: val('afmAttn', 18),
    ffn: val('afmFFN', 22),
    runtime: val('afmRuntime', 2),
    prefillTPS: val('afmPrefillTPS', 80),
    chunkMode: $('afmChunkMode').value,
    doubleBuffer: $('afmDoubleBuffer').checked,
    kvKB: 182
  };
}

function afmDerived(c) {
  const expertParams = c.layers * c.projections * c.hidden * c.expertWidth;
  const rawExpertGB = expertParams * c.bits / 8 / 1e9;
  const expertGB = rawExpertGB * c.packing;
  const sharedGB = c.shared * expertGB;
  const routedGB = c.routed * expertGB;
  const activeFFNParams = c.layers * c.projections * c.hidden * c.activeDim;
  const totalNandGB = c.totalB * c.bits / 8 * c.packing;
  return { expertParams, rawExpertGB, expertGB, sharedGB, routedGB, activeGB: sharedGB + routedGB, activeFFNParams, totalNandGB };
}

function colibriSimulationWork(input) {
  if (!input || input.mode !== 'colibri') return { routeWork: 0, cacheWork: 0, routeLimit: 100_000_000, cacheLimit: 20_000_000, replayWork: 0, fraction: 0 };
  const c = { ...input, esize: colibriEffectiveExpertMB(input) };
  const repeatedTraceCount = c.conc > 1 ? c.conc + 1 : 1;
  const routeCount = c.layers * c.output * repeatedTraceCount;
  const routeSearchCost = Math.max(1, Math.ceil(Math.log2(c.experts + 1)));
  const sparseDrawLimit = Math.max(32, c.active * 8);
  const routeCost = c.active > c.experts / 4
    ? c.experts + c.active * routeSearchCost
    : c.active === 1
      ? routeSearchCost
      : sparseDrawLimit * routeSearchCost + c.experts + c.active * routeSearchCost;
  const routeWork = routeCount * routeCost;
  const expectedRouteCost = c.active > c.experts / 4
    ? (c.experts + c.active * routeSearchCost) / 4
    : c.active * routeSearchCost;
  const expectedRouteWork = routeCount * expectedRouteCost;
  const expertUnitGB = c.esize * 1.03 / 1000;
  const cacheEntriesPerLayer = c.cold || !(expertUnitGB > 0) || !(c.layers > 0) ? 0
    : Math.min(c.experts, Math.floor(c.vcache / expertUnitGB / c.layers)) + Math.min(c.experts, Math.floor(c.dcache / expertUnitGB / c.layers));
  const cacheWork = c.layers * cacheEntriesPerLayer * repeatedTraceCount;
  const routeLimit = 100_000_000;
  const cacheLimit = 20_000_000;
  return { routeWork, cacheWork, routeLimit, cacheLimit, replayWork: expectedRouteWork + cacheWork, fraction: Math.max(routeWork / routeLimit, cacheWork / cacheLimit) };
}

function validateSimulationConfig(c) {
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message });
  const finite = (path, value, min, max = Infinity) => {
    if (!Number.isFinite(value) || value < min || value > max) add(path, 'OUT_OF_RANGE', `${path} must be between ${min} and ${max}.`);
  };
  const integer = (path, value, min, max) => {
    finite(path, value, min, max);
    if (Number.isFinite(value) && !Number.isSafeInteger(value)) add(path, 'NOT_SAFE_INTEGER', `${path} must be a safe integer.`);
  };
  const enumValue = (path, value, allowed) => {
    if (!allowed.includes(value)) add(path, 'INVALID_ENUM', `${path} must be one of ${allowed.join(', ')}.`);
  };
  const boolean = (path, value) => {
    if (typeof value !== 'boolean') add(path, 'INVALID_BOOLEAN', `${path} must be boolean.`);
  };

  if (!c || typeof c !== 'object') return { valid: false, errors: [{ path: 'config', code: 'INVALID_CONFIG', message: 'Configuration must be an object.' }] };
  enumValue('mode', c.mode, ['colibri', 'afm3']);
  enumValue('arch', c.arch, ['unified', 'discrete']);
  integer('prompt', c.prompt, SIMULATION_LIMITS.prompt.min, SIMULATION_LIMITS.prompt.max);
  integer('output', c.output, SIMULATION_LIMITS.output.min, SIMULATION_LIMITS.output.max);
  integer('context', c.context, 1, 10_000_000);
  integer('conc', c.conc, 1, 64);
  integer('seed', c.seed, 0, Number.MAX_SAFE_INTEGER);
  finite('host', c.host, 0.001, 4096);
  finite('vram', c.vram, 0, 1024);
  finite('dramBW', c.dramBW, 0.001, 1_000_000_000_000);
  finite('pcieBW', c.pcieBW, c.arch === 'discrete' ? 0.001 : 0, 1_000_000_000_000);
  finite('ssdBW', c.ssdBW, 0.001, 1_000_000_000_000);
  finite('lat', c.lat, 0, 10_000_000);

  if (!c.mem || typeof c.mem !== 'object') {
    add('mem', 'INVALID_OBJECT', 'mem policy is required.');
  } else {
    enumValue('mem.policy', c.mem.policy, ['strict', 'reclaim', 'swap']);
    finite('mem.backgroundGB', c.mem.backgroundGB, 0, 4096);
    finite('mem.osReservedGB', c.mem.osReservedGB, 0, 4096);
    finite('mem.minHeadroomGB', c.mem.minHeadroomGB, 0, 4096);
    for (const key of ['soft', 'compress', 'swap', 'hard']) finite(`mem.${key}`, c.mem[key], 0.01, 1);
    if (!(c.mem.soft <= c.mem.compress && c.mem.compress <= c.mem.swap && c.mem.swap <= c.mem.hard)) {
      add('mem.thresholds', 'INVALID_ORDER', 'Memory thresholds must satisfy soft <= compress <= swap <= hard.');
    }
    boolean('mem.compressionEnabled', c.mem.compressionEnabled);
    finite('mem.compressionRatio', c.mem.compressionRatio, 1, 100);
    finite('mem.compressionBW', c.mem.compressionBW, 0.001, 100_000);
    boolean('mem.swapEnabled', c.mem.swapEnabled);
    finite('mem.swapCapacityGB', c.mem.swapCapacityGB, 0, 16_384);
    finite('mem.swapWriteRatio', c.mem.swapWriteRatio, SIMULATION_LIMITS.swapWriteRatio.min, SIMULATION_LIMITS.swapWriteRatio.max);
    finite('mem.kvTouchFraction', c.mem.kvTouchFraction, 0, 1);
  }

  if (c.mode === 'colibri') {
    boolean('cold', c.cold);
    enumValue('placement', c.placement, ['auto', 'manual']);
    integer('layers', c.layers, 1, 500);
    integer('experts', c.experts, 1, 4096);
    integer('active', c.active, 1, c.experts);
    integer('qd', c.qd, 1, 4096);
    integer('par', c.par, 1, 4096);
    finite('esize', c.esize, 0.001, 1_000_000);
    finite('resident', c.resident, 0, 4096);
    finite('kvKB', c.kvKB, 0, 1_000_000);
    finite('dcache', c.dcache, 0, 4096);
    finite('minDCache', c.minDCache, 0, 4096);
    finite('vcache', c.vcache, 0, 1024);
    finite('pinned', c.pinned, 0, 4096);
    finite('page', c.page, 0, 4096);
    enumValue('expertBacking', c.expertBacking, ['file', 'anonymous']);
    boolean('odirect', c.odirect);
    finite('corr', c.corr, 0, 1);
    finite('attn', c.attn, 0, 1_000_000);
    finite('ems', c.ems, 0, 1_000_000);
    finite('prefillSpeedup', c.prefillSpeedup, 0.001, 1_000_000);
    boolean('pf', c.pf);
    enumValue('prefetchPolicy', c.prefetchPolicy || 'previous-token', ['none', 'previous-token', 'popularity']);
    finite('recall', c.recall, 0, 1);
    finite('precision', c.precision, 0.001, 1);
    finite('budget', c.budget, 0, 1_000_000);
    if (typeof validateDeviceComputeConfig === 'function') {
      const deviceValidation = validateDeviceComputeConfig(c);
      for (const error of deviceValidation.errors) add(error.path, error.code, error.message);
      try {
        finite('quantization.effectiveExpertMB', colibriEffectiveExpertMB(c), 0.001, 1_000_000);
      } catch (error) {
        add('quantization', 'NORMALIZATION_ERROR', String(error?.message || error));
      }
    }
    if (c.placement === 'manual' && Number.isFinite(c.minDCache) && Number.isFinite(c.dcache) && c.minDCache > c.dcache) {
      add('minDCache', 'CAPACITY_EXCEEDED', 'minDCache cannot exceed dcache.');
    }
    const profile = colibriDeviceProfileFor(c);
    const deviceReserveGB = typeof colibriDeviceReserveGB === 'function'
      ? colibriDeviceReserveGB(c, profile)
      : c.arch === 'discrete' ? 0.8 : 0;
    if (c.arch === 'discrete' && c.placement === 'manual' && Number.isFinite(c.vcache) && Number.isFinite(c.vram) && c.vcache + deviceReserveGB > c.vram + EPS) {
      add('vcache', 'CAPACITY_EXCEEDED', 'Manual VRAM Expert cache plus the device runtime reserve cannot exceed physical VRAM.');
    }
    const work = colibriSimulationWork(c);
    if (!Number.isFinite(work.routeWork) || !Number.isFinite(work.cacheWork) || work.routeWork > work.routeLimit || work.cacheWork > work.cacheLimit) {
      add('complexity', 'COMPLEXITY_LIMIT', 'Scenario exceeds the interactive browser work budget.');
    }
  } else if (c.mode === 'afm3') {
    if (c.arch !== 'unified') add('arch', 'INVALID_RELATION', 'AFM 3 requires unified memory.');
    integer('layers', c.layers, 1, 500);
    integer('hidden', c.hidden, 1, 1_000_000);
    integer('active', c.active, 1, 4096);
    integer('shared', c.shared, 0, c.active);
    integer('routed', c.routed, 0, c.active);
    integer('expertWidth', c.expertWidth, 1, 1_000_000);
    integer('activeDim', c.activeDim, 1, 100_000_000);
    integer('projections', c.projections, 1, 16);
    integer('chunks', c.chunks, 1, 128);
    integer('freq', c.freq, 1, 1_000_000);
    finite('totalB', c.totalB, 0.001, 1_000_000);
    finite('bits', c.bits, 1, 16);
    finite('packing', c.packing, 1, 10);
    finite('commonGB', c.commonGB, 0, 4096);
    finite('overlap', c.overlap, 0, 1);
    finite('initSel', c.initSel, 0, 1_000_000);
    finite('periodicSel', c.periodicSel, 0, 1_000_000);
    finite('patchBase', c.patchBase, 0, 1_000_000);
    finite('patchBW', c.patchBW, 0.001, 1_000_000_000_000);
    finite('attn', c.attn, 0, 1_000_000);
    finite('ffn', c.ffn, 0, 1_000_000);
    finite('runtime', c.runtime, 0, 1_000_000);
    finite('prefillTPS', c.prefillTPS, 0.001, 1_000_000);
    finite('kvKB', c.kvKB, 0, 1_000_000);
    enumValue('chunkMode', c.chunkMode, ['sequential', 'pipelined']);
    boolean('doubleBuffer', c.doubleBuffer);
    if (Number.isFinite(c.active) && Number.isFinite(c.shared) && c.routed !== c.active - c.shared) {
      add('routed', 'DIMENSION_MISMATCH', 'routed must equal active - shared.');
    }
    if (Number.isFinite(c.active) && Number.isFinite(c.expertWidth) && c.activeDim !== c.active * c.expertWidth) {
      add('activeDim', 'DIMENSION_MISMATCH', 'activeDim must equal active * expertWidth.');
    }
    const work = c.layers * c.active * c.output * c.conc;
    if (Number.isFinite(work) && work > 20_000_000) add('complexity', 'COMPLEXITY_LIMIT', 'Scenario exceeds the interactive browser work budget.');
  }
  return { valid: errors.length === 0, errors };
}

function formatConfigErrors(validation) {
  return validation.errors.map(error => `${error.path}: ${error.message}`).join(' ');
}

function thresholdGB(c, ratio) {
  return Math.max(0, Math.min(c.host * ratio, c.host - c.mem.minHeadroomGB));
}
