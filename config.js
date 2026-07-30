function readMemoryPolicy() {
  const soft = clamp(val('softPct', 80) / 100, 0.01, 1);
  const compress = clamp(Math.max(soft, val('compressPct', 85) / 100), soft, 1);
  const swap = clamp(Math.max(compress, val('swapPct', 90) / 100), compress, 1);
  const hard = clamp(Math.max(swap, val('hardPct', 97) / 100), swap, 1);
  return {
    policy: $('memPolicy').value,
    backgroundGB: Math.max(0, val('backgroundGB', 8)),
    osReservedGB: Math.max(0, val('osReservedGB', 8)),
    minHeadroomGB: Math.max(0, val('minHeadroomGB', 8)),
    soft,
    compress,
    swap,
    hard,
    compressionEnabled: $('compressionEnabled').checked,
    compressionRatio: Math.max(1, val('compressionRatio', 1.6)),
    compressionBW: Math.max(0.1, val('compressionBW', 25)),
    swapEnabled: $('swapEnabled').checked,
    swapCapacityGB: Math.max(0, val('swapCapacityGB', 32)),
    swapWriteRatio: Math.max(0.05, val('swapWriteRatio', 0.7)),
    kvTouchFraction: clamp(val('kvTouchFraction', 1), 0, 1)
  };
}

function readCommon() {
  return {
    mode: $('mode').value,
    prompt: Math.max(1, val('prompt', 128) | 0),
    output: clamp(val('output', 64) | 0, 1, 512),
    context: Math.max(1, val('context', 4096) | 0),
    conc: Math.max(1, val('conc', 1) | 0),
    arch: $('arch').value,
    host: Math.max(1, val('host', 128)),
    vram: Math.max(0, val('vram', 8)),
    dramBW: Math.max(0.1, val('dramBW', 273)),
    pcieBW: Math.max(0.1, val('pcieBW', 24)),
    ssdBW: Math.max(0.05, val('ssdBW', 9.2)),
    lat: Math.max(0, val('lat', 120)),
    seed: 260730,
    mem: readMemoryPolicy()
  };
}

function colibriCapacity(c) {
  const expertPoolGB = Math.max(0, c.layers * c.experts * c.esize * 1.03 / 1024);
  const pinnedExpertsPerLayer = Math.min(
    c.experts,
    Math.max(0, Math.floor(c.pinned * 1024 / c.esize / c.layers))
  );
  const hostExpertPoolGB = Math.max(
    0,
    c.layers * (c.experts - pinnedExpertsPerLayer) * c.esize * 1.03 / 1024
  );
  const anticipatedKvGB = Math.max(0, (c.context + c.prompt + c.output) * c.kvKB * 1024 * c.conc / 1e9);
  return { expertPoolGB, hostExpertPoolGB, pinnedExpertsPerLayer, anticipatedKvGB };
}

function applyColibriPlacement(input) {
  const c = { ...input };
  const { expertPoolGB, hostExpertPoolGB, pinnedExpertsPerLayer, anticipatedKvGB } = colibriCapacity(c);
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

  const deviceReserveGB = c.arch === 'discrete' ? 0.8 : 0;
  const deviceBudgetGB = Math.max(0, c.vram - deviceReserveGB);
  const deviceKvGB = c.arch === 'discrete' ? Math.min(anticipatedKvGB, deviceBudgetGB) : 0;
  const hostKvGB = anticipatedKvGB - deviceKvGB;
  const vcacheGB = c.arch === 'discrete'
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
    layers: val('layers', 75) | 0,
    experts: val('experts', 256) | 0,
    active: val('active', 8) | 0,
    esize: Math.max(0.01, val('esize', 19)),
    resident: Math.max(0, val('resident', 9.9)),
    kvKB: Math.max(0, val('kv', 182)),
    vcache: Math.max(0, val('vcache', 4)),
    dcache: Math.max(0, val('dcache', 30)),
    minDCache: Math.max(0, val('minDCache', 4)),
    expertBacking: $('expertBacking').value,
    pinned: Math.max(0, val('pinned', 6)),
    page: Math.max(0, val('page', 5)),
    odirect: $('odirect').checked,
    corr: clamp(val('corr', 0.52), 0, 1),
    qd: Math.max(1, val('qd', 8) | 0),
    attn: Math.max(0, val('attn', 28)),
    ems: Math.max(0, val('ems', 0.7)),
    par: Math.max(1, val('par', 4) | 0),
    prefillSpeedup: Math.max(0.1, val('prefillSpeedup', 4.5)),
    pf: $('pf').checked,
    recall: clamp(val('recall', 0.716), 0, 1),
    precision: clamp(val('precision', 0.78), 0.01, 1),
    budget: Math.max(0, val('budget', 160))
  };
  c.layers = clamp(c.layers, 1, 500);
  c.experts = clamp(c.experts, 1, 4096);
  c.active = clamp(c.active, 1, c.experts);
  c.minDCache = Math.min(c.minDCache, c.dcache);
  if (c.odirect) c.page = 0;
  return c;
}

function readAFM() {
  const b = readCommon();
  const active = Math.max(1, val('afmActive', 46) | 0);
  const shared = clamp(val('afmShared', 23) | 0, 0, active);
  const expertWidth = Math.max(1, val('afmExpertWidth', 256) | 0);
  const layers = Math.max(1, val('afmLayers', 44) | 0);
  const hidden = Math.max(1, val('afmHidden', 1536) | 0);
  const projections = Math.max(1, val('afmProjections', 3) | 0);
  const chunks = Math.max(1, val('afmChunks', 2) | 0);
  const bits = clamp(val('afmBits', 2), 1, 16);
  const packing = Math.max(1, val('afmPacking', 1.08));
  const overlap = clamp(val('afmOverlap', 0.65), 0, 1);
  return {
    ...b,
    arch: 'unified',
    qd: 1,
    totalB: Math.max(1, val('afmTotalB', 20)),
    layers,
    hidden,
    active,
    shared,
    routed: active - shared,
    expertWidth,
    activeDim: Math.max(1, val('afmActiveDim', 11776) | 0),
    projections,
    chunks,
    bits,
    packing,
    commonGB: Math.max(0, val('afmCommonGB', 1.4)),
    freq: Math.max(1, val('afmFreq', 32) | 0),
    overlap,
    initSel: Math.max(0, val('afmInitSel', 10)),
    periodicSel: Math.max(0, val('afmPeriodicSel', 3)),
    patchBase: Math.max(0, val('afmPatchBase', 2)),
    patchBW: Math.max(0.1, val('afmPatchBW', 60)),
    attn: Math.max(0, val('afmAttn', 18)),
    ffn: Math.max(0, val('afmFFN', 22)),
    runtime: Math.max(0, val('afmRuntime', 2)),
    prefillTPS: Math.max(0.1, val('afmPrefillTPS', 80)),
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

function thresholdGB(c, ratio) {
  return Math.max(0, Math.min(c.host * ratio, c.host - c.mem.minHeadroomGB));
}
