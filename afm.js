function simulateAFM(c = readAFM()) {
  const validation = validateSimulationConfig(c);
  if (!validation.valid) {
    return { error: `Invalid configuration: ${formatConfigErrors(validation)}`, validationErrors: validation.errors, c, mode: 'afm3' };
  }
  const d = afmDerived(c);
  const R = rng(c.seed);
  const storage = new StorageResource(c);
  const tokens = [], switches = [];
  const kvPerTokenGB = c.kvKB * 1000 * c.conc / 1e9;
  const initialKvGB = (c.context + c.prompt) * kvPerTokenGB;
  const state = createMemoryState(c, 'afm3', initialKvGB, 0);
  const steadyBase = c.attn + c.ffn + c.runtime;
  const chunkCompute = c.ffn / c.chunks;
  const initialReadGB = d.routedGB;
  const initialReadJob = storage.reserveGB(initialReadGB, c.initSel, 'afm-window-read', c.chunks, 1);
  const initialPatch = initialReadGB > EPS ? c.patchBase + initialReadGB / c.patchBW * 1000 : 0;
  const prefill = c.prompt / c.prefillTPS * 1000;
  let now = initialReadJob.end + initialPatch + prefill;
  let periodicGB = 0, boundaryTotal = 0, changedTotal = 0;

  const initialDyn = afmDynamic(c, d, state);
  state.peakAllocationDemandGB = Math.max(state.peakAllocationDemandGB, initialDyn.physicalGB);
  const initialPressure = applyPressureAFM(c, d, state, 0);
  now += initialPressure.compressionCpuMs;
  const initialSwap = scheduleSwapOut(c, state, initialPressure, storage, now, () => afmDynamic(c, d, state));
  now = Math.max(now, initialSwap.blockedUntil);
  completePendingSwapOuts(state, now);
  if (initialPressure.oom) return { error: `Unified memory OOM before decode: ${fmt(initialPressure.dyn.physicalGB, 1)} / ${fmt(c.host, 1)} GB`, c, d, mode: 'afm3', state, oom: true };
  const admittedInitialDyn = afmDynamic(c, d, state);
  state.peakPhysicalGB = Math.max(state.peakPhysicalGB, admittedInitialDyn.physicalGB);
  const predecodeReadyMs = now;
  const prefillStorageEvents = summarizeStorageEvents(storage.events);
  const startupStorageGB = storage.gb;
  storage.events.length = 0;


  for (let i = 0; i < c.output; i++) {
    const ts = now;
    const storageEventStart = storage.events.length;
    let boundary = false, changed = 0, readGB = 0, selectMs = 0, readMs = 0, patchMs = 0, exposed = 0;
    let storageServiceMs = 0, storageQueueMs = 0, swapServiceMs = 0, swapQueueMs = 0;
    const window = Math.floor(i / c.freq);

    completePendingSwapOuts(state, now);
    const tokenTransaction = {
      now,
      memory: snapshotMemoryState(state),
      storage: snapshotStorageResource(storage),
      periodicGB,
      boundaryTotal,
      changedTotal,
      switchesLength: switches.length
    };
    const touch = touchMemoryAtTokenStart(c, state, storage, now);
    storageServiceMs += touch.storageServiceMs;
    storageQueueMs += touch.storageQueueMs;
    swapServiceMs += touch.storageServiceMs;
    swapQueueMs += touch.storageQueueMs;
    now = Math.max(now, touch.readyAt) + touch.compressionCpuMs;
    completePendingSwapOuts(state, now);

    if (i > 0 && i % c.freq === 0) {
      boundary = true;
      changed = stochasticRound(c.routed * (1 - c.overlap), R);
      readGB = changed * d.expertGB;
      selectMs = c.periodicSel;
      now += selectMs;
      const job = storage.reserveGB(readGB, now, 'afm-window-read', c.chunks, 1);
      storageServiceMs += job.service;
      storageQueueMs += job.wait;
      readMs = job.service + job.wait;
      patchMs = changed ? c.patchBase + readGB / c.patchBW * 1000 : 0;
      const loadPath = readMs + patchMs;
      const canPipeline = c.chunkMode === 'pipelined' && c.doubleBuffer;
      exposed = canPipeline ? Math.max(0, loadPath - chunkCompute) : loadPath;
      now += exposed;
      periodicGB += readGB;
      boundaryTotal += selectMs + exposed;
      changedTotal += changed;
      switches.push({ token: i + 1, window, changed, retained: c.routed - changed, readGB, selectMs, readMs, patchMs, exposed: selectMs + exposed });
    }

    now += steadyBase;
    completePendingSwapOuts(state, now);
    growKV(c, state, kvPerTokenGB);
    const prePressureDyn = afmDynamic(c, d, state);
    state.peakAllocationDemandGB = Math.max(state.peakAllocationDemandGB, prePressureDyn.physicalGB);
    const pressure = applyPressureAFM(c, d, state, i + 1);
    const swapSchedule = scheduleSwapOut(c, state, pressure, storage, now, () => afmDynamic(c, d, state));
    if (swapSchedule.job) {
      storageServiceMs += swapSchedule.job.service;
      storageQueueMs += swapSchedule.job.wait;
      swapServiceMs += swapSchedule.job.service;
      swapQueueMs += swapSchedule.job.wait;
    }
    now = Math.max(now, swapSchedule.blockedUntil);

    if (pressure.oom) {
      const allocationDemandGB = state.peakAllocationDemandGB;
      restoreMemoryState(state, tokenTransaction.memory);
      state.peakAllocationDemandGB = Math.max(state.peakAllocationDemandGB, allocationDemandGB);
      state.oom = true;
      state.lastState = 'OOM';
      restoreStorageResource(storage, tokenTransaction.storage);
      periodicGB = tokenTransaction.periodicGB;
      boundaryTotal = tokenTransaction.boundaryTotal;
      changedTotal = tokenTransaction.changedTotal;
      switches.length = tokenTransaction.switchesLength;
      now = tokenTransaction.now;
      break;
    }

    const kvTouchGB = (state.kvUncompressedGB + state.kvCompressedOriginalGB) * c.mem.kvTouchFraction;
    const ssdLandingWriteGB = readGB;
    const swapTrafficGB = touch.swapInGB + pressure.swapOutGB;
    const dramTrafficGB = d.activeGB + c.commonGB + kvTouchGB + ssdLandingWriteGB + swapTrafficGB + touch.compressionTrafficGB + pressure.compressionTrafficGB;
    const baseElapsed = now - ts + pressure.compressionCpuMs;
    const dramFloorMs = dramTrafficGB / c.dramBW * 1000;
    const finalElapsed = Math.max(baseElapsed, dramFloorMs);
    const dramStallMs = Math.max(0, finalElapsed - baseElapsed);
    now = ts + finalElapsed;
    completePendingSwapOuts(state, now);
    const snapshotDyn = afmDynamic(c, d, state);

    const dramGBs = dramTrafficGB / Math.max(EPS, finalElapsed / 1000);
    state.peakDramGBs = Math.max(state.peakDramGBs, dramGBs);
    state.totalDramTrafficGB += dramTrafficGB;
    state.totalDramStallMs += dramStallMs;

    const snap = memorySnapshot(c, state, snapshotDyn, pressure, i + 1, {
      swapInGB: touch.swapInGB,
      compressionTrafficGB: touch.compressionTrafficGB,
      dramTrafficGB,
      dramGBs,
      dramUtilization: dramGBs / c.dramBW,
      dramStallMs
    });
    tokens.push({
      tpot: finalElapsed,
      ssdGB: readGB,
      pcieGB: 0,
      computeMs: steadyBase + selectMs + patchMs + touch.compressionCpuMs + pressure.compressionCpuMs,
      computeOnlyMs: steadyBase + selectMs + touch.compressionCpuMs + pressure.compressionCpuMs,
      memoryCpuMs: touch.compressionCpuMs + pressure.compressionCpuMs,
      storageServiceMs,
      storageQueueMs,
      swapServiceMs,
      swapQueueMs,
      swapInGB: touch.swapInGB,
      swapOutGB: pressure.swapOutGB,
      storageRequests: changed ? c.chunks : 0,
      storageEvents: summarizeStorageEvents(storage.events.slice(storageEventStart)),
      hit: c.overlap,
      boundary,
      changed,
      retained: c.routed - changed,
      window,
      readGB,
      selectMs,
      readMs,
      patchMs,
      exposed: selectMs + exposed,
      memory: snap
    });
    storage.events.length = storageEventStart;
  }

  if (!tokens.length) return {
    error: state.oom ? 'Memory pressure OOM before any decode token completed.' : 'No token completed.',
    c, d, mode: 'afm3', state, tokens, oom: state.oom
  };
  const intervals = tokens.length > 1 ? tokens.slice(1) : tokens;
  const avg = intervals.reduce((a, x) => a + x.tpot, 0) / intervals.length;
  const tps = 1000 / avg;
  const steadyKvTouchGB = (state.kvUncompressedGB + state.kvCompressedOriginalGB) * c.mem.kvTouchFraction;
  const steadyCompressionTrafficGB = state.kvCompressedOriginalGB * c.mem.kvTouchFraction * (1 + 1 / c.mem.compressionRatio);
  const steadyDramTraffic = d.activeGB + c.commonGB + steadyKvTouchGB + steadyCompressionTrafficGB;
  const steady = Math.max(steadyBase, steadyDramTraffic / c.dramBW * 1000);
  const steadyTPS = 1000 / steady;
  const decodeStorageGB = Math.max(0, storage.gb - startupStorageGB);
  const ssdPt = decodeStorageGB / tokens.length;
  const actualOverlap = switches.length && c.routed ? 1 - changedTotal / (switches.length * c.routed) : c.overlap;
  const hit = actualOverlap;
  const ssdBound = ssdPt ? c.ssdBW / ssdPt : Infinity;
  const dramPt = state.totalDramTrafficGB / tokens.length;
  const dramBound = dramPt ? c.dramBW / dramPt : Infinity;
  const agg = Math.min(c.conc * tps, ssdBound, dramBound);
  const decodeMs = tokens.reduce((a, x) => a + x.tpot, 0);
  const decodeStorageElapsedMs = Math.max(decodeMs, storage.free - predecodeReadyMs);
  const observed = decodeStorageGB / Math.max(EPS, decodeStorageElapsedMs / 1000);
  const boundaryTokens = tokens.filter(x => x.boundary);
  const boundaryTPOT = boundaryTokens.length ? boundaryTokens.reduce((a, x) => a + x.tpot, 0) / boundaryTokens.length : steady;
  const sorted = [...tokens].sort((a, b) => a.tpot - b.tpot);
  const p95 = sorted[Math.min(tokens.length - 1, Math.ceil(tokens.length * 0.95) - 1)].tpot;
  const ttft = predecodeReadyMs + tokens[0].tpot;
  return {
    mode: 'afm3', c, d, tokens, switches, state, prefillStorageEvents,
    tot: { periodicGB, initialReadGB, changedTotal, boundaryTotal },
    avg, tps, steady, steadyTPS, boundaryTPOT, p95, ssdPt, startupStorageGB, decodeStorageGB, hit, prefill, ttft, agg,
    ssdBound, pcieBound: Infinity, dramBound, observed, ssdBusy: storage.busy,
    ssdQueue: storage.queue, storageByKind: storage.byKind,
    dramAccounting: {
      scope: 'active-weights+KV-touch+SSD-landing+swap+compression',
      excluded: ['patch-materialization-read-write'],
      patchMaterializationTrafficGB: null
    },
    initialCompressionCpuMs: initialPressure.compressionCpuMs,
    initialSwapServiceMs: initialSwap.job?.service || 0,
    initialSwapQueueMs: initialSwap.job?.wait || 0,
    ev: 0, oom: state.oom
  };
}
