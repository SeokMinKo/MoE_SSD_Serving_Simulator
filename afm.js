function simulateAFM(c = readAFM()) {
  const validation = validateSimulationConfig(c);
  if (!validation.valid) {
    return { error: `Invalid configuration: ${formatConfigErrors(validation)}`, validationErrors: validation.errors, c, mode: 'afm3' };
  }
  const d = afmDerived(c);
  const R = rng(c.seed);
  const storage = new StorageResource(c);
  const tokens = [], switches = [];
  const kvPerTokenGB = c.kvKB * 1024 * c.conc / 1e9;
  const initialKvGB = (c.context + c.prompt) * kvPerTokenGB;
  const state = createMemoryState(c, 'afm3', initialKvGB, 0);
  const steadyBase = c.attn + c.ffn + c.runtime;
  const chunkCompute = c.ffn / c.chunks;
  const initialReadGB = d.routedGB;
  const initialReadJob = storage.reserveGB(initialReadGB, c.initSel, 'afm-window-read', c.chunks, 1);
  const initialPatch = c.patchBase + initialReadGB / c.patchBW * 1000;
  const prefill = c.prompt / c.prefillTPS * 1000;
  let now = initialReadJob.end + initialPatch + prefill;
  let periodicGB = 0, boundaryTotal = 0, changedTotal = 0;

  const initialPressure = applyPressureAFM(c, d, state, 0);
  const initialSwap = scheduleSwapOut(c, state, initialPressure, storage, now, () => afmDynamic(c, d, state));
  now = Math.max(now, initialSwap.blockedUntil);
  if (initialPressure.oom) return { error: `Unified memory OOM before decode: ${fmt(initialPressure.dyn.physicalGB, 1)} / ${fmt(c.host, 1)} GB`, c, d, mode: 'afm3' };

  for (let i = 0; i < c.output; i++) {
    const ts = now;
    let boundary = false, changed = 0, readGB = 0, selectMs = 0, readMs = 0, patchMs = 0, exposed = 0;
    let storageServiceMs = 0, storageQueueMs = 0, swapServiceMs = 0, swapQueueMs = 0;
    const window = Math.floor(i / c.freq);

    completePendingSwapOuts(state, now);
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
    const pressure = applyPressureAFM(c, d, state, i + 1);
    const swapSchedule = scheduleSwapOut(c, state, pressure, storage, now, () => afmDynamic(c, d, state));
    if (swapSchedule.job) {
      storageServiceMs += swapSchedule.job.service;
      storageQueueMs += swapSchedule.job.wait;
      swapServiceMs += swapSchedule.job.service;
      swapQueueMs += swapSchedule.job.wait;
    }
    now = Math.max(now, swapSchedule.blockedUntil);

    const kvTouchGB = (state.kvUncompressedGB + state.kvCompressedOriginalGB) * c.mem.kvTouchFraction;
    const windowWriteGB = readGB;
    const swapTrafficGB = touch.swapInGB + pressure.swapOutGB;
    const dramTrafficGB = d.activeGB + c.commonGB + kvTouchGB + windowWriteGB + swapTrafficGB + touch.compressionTrafficGB + pressure.compressionTrafficGB;
    const baseElapsed = now - ts + pressure.compressionCpuMs;
    const dramFloorMs = dramTrafficGB / c.dramBW * 1000;
    const finalElapsed = Math.max(baseElapsed, dramFloorMs);
    const dramStallMs = Math.max(0, finalElapsed - baseElapsed);
    now = ts + finalElapsed;

    const dramGBs = dramTrafficGB / Math.max(EPS, finalElapsed / 1000);
    state.peakDramGBs = Math.max(state.peakDramGBs, dramGBs);
    state.totalDramTrafficGB += dramTrafficGB;
    state.totalDramStallMs += dramStallMs;

    const snap = memorySnapshot(c, state, pressure.dyn, pressure, i + 1, {
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
      computeMs: steadyBase + selectMs + patchMs + pressure.compressionCpuMs,
      computeOnlyMs: steadyBase + selectMs + pressure.compressionCpuMs,
      storageServiceMs,
      storageQueueMs,
      swapServiceMs,
      swapQueueMs,
      swapInGB: touch.swapInGB,
      swapOutGB: pressure.swapOutGB,
      storageRequests: changed ? c.chunks : 0,
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
    if (pressure.oom) break;
  }

  if (!tokens.length) return { error: 'No token completed.', c, d, mode: 'afm3' };
  const intervals = tokens.length > 1 ? tokens.slice(1) : tokens;
  const avg = intervals.reduce((a, x) => a + x.tpot, 0) / intervals.length;
  const tps = 1000 / avg;
  const steadyDramTraffic = d.activeGB + c.commonGB + initialKvGB;
  const steady = Math.max(steadyBase, steadyDramTraffic / c.dramBW * 1000);
  const steadyTPS = 1000 / steady;
  const ssdPt = storage.gb / tokens.length;
  const actualOverlap = switches.length && c.routed ? 1 - changedTotal / (switches.length * c.routed) : c.overlap;
  const hit = actualOverlap;
  const ssdBound = ssdPt ? c.ssdBW / ssdPt : Infinity;
  const dramPt = state.totalDramTrafficGB / tokens.length;
  const dramBound = dramPt ? c.dramBW / dramPt : Infinity;
  const agg = Math.min(c.conc * tps, ssdBound, dramBound);
  const decodeMs = tokens.reduce((a, x) => a + x.tpot, 0);
  const observed = storage.gb / Math.max(EPS, Math.max(decodeMs, storage.free) / 1000);
  const boundaryTokens = tokens.filter(x => x.boundary);
  const boundaryTPOT = boundaryTokens.length ? boundaryTokens.reduce((a, x) => a + x.tpot, 0) / boundaryTokens.length : steady;
  const sorted = [...tokens].sort((a, b) => a.tpot - b.tpot);
  const p95 = sorted[Math.min(tokens.length - 1, Math.floor(tokens.length * 0.95))].tpot;
  const ttft = now > 0 ? c.initSel + initialReadJob.service + initialReadJob.wait + initialPatch + prefill + tokens[0].tpot : 0;
  return {
    mode: 'afm3', c, d, tokens, switches, state,
    tot: { periodicGB, initialReadGB, changedTotal, boundaryTotal },
    avg, tps, steady, steadyTPS, boundaryTPOT, p95, ssdPt, hit, prefill, ttft, agg,
    ssdBound, pcieBound: Infinity, dramBound, observed, ssdBusy: storage.busy,
    ssdQueue: storage.queue, storageByKind: storage.byKind,
    initialSwapServiceMs: initialSwap.job?.service || 0,
    initialSwapQueueMs: initialSwap.job?.wait || 0,
    ev: 0, oom: state.oom
  };
}
