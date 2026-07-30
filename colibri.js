function cpl(gb, c) { return Math.max(0, Math.floor(gb * 1024 / (c.esize * 1.03) / c.layers)); }
function zipfPick(r, n, a = 1.05) {
  const u = r();
  let sum = 0, total = 0;
  for (let i = 1; i <= n; i++) total += 1 / Math.pow(i, a);
  for (let i = 1; i <= n; i++) {
    sum += 1 / Math.pow(i, a) / total;
    if (u <= sum) return i - 1;
  }
  return n - 1;
}

function zipfTopMass(n, top, a = 1.05) {
  if (top <= 0 || n <= 0) return 0;
  if (top >= n) return 1;
  let selected = 0;
  let total = 0;
  for (let i = 1; i <= n; i++) {
    const weight = 1 / Math.pow(i, a);
    total += weight;
    if (i <= top) selected += weight;
  }
  return selected / total;
}

function causalPrefetchCandidates(c, previousRoute, R) {
  const max = Math.min(c.experts, Math.floor(c.budget / c.esize));
  if (!c.pf || max <= 0 || c.prefetchPolicy === 'none') return [];
  const policy = c.prefetchPolicy || 'previous-token';
  const source = policy === 'popularity'
    ? Array.from({ length: Math.min(c.active, c.experts) }, (_, index) => index)
    : previousRoute;
  if (!source || !source.length) return [];

  const candidates = [];
  for (const expert of source) {
    if (policy === 'popularity' || R() < c.recall) candidates.push(expert);
  }
  const target = Math.min(max, c.experts, Math.ceil(candidates.length / c.precision));
  while (candidates.length < target) {
    const expert = Math.floor(R() * c.experts);
    if (!candidates.includes(expert)) candidates.push(expert);
  }
  return candidates.slice(0, max);
}

function simulateColibriPrefill(c, V, D, P, pin, unitGB, rawUnitGB) {
  const prompt = Math.max(0, c.prompt | 0);
  const empty = {
    ms: 0,
    computeMs: 0,
    storageMs: 0,
    transferMs: 0,
    dramMs: 0,
    storageGB: 0,
    transferGB: 0,
    dramTrafficGB: 0,
    uniquePerLayer: 0,
    activatedEntries: 0,
    storageRequests: 0,
    transferEntries: 0,
    warmedDramEntries: 0,
    warmedVramEntries: 0
  };
  if (!prompt) return empty;

  const sequenceUnion = 1 + Math.log2(Math.max(1, c.conc)) * 0.35;
  const totalActivationsPerLayer = prompt * c.active * c.conc;
  const uniquePerLayer = Math.min(
    c.experts,
    totalActivationsPerLayer,
    Math.ceil(c.active * (1 + Math.log2(prompt) * 1.6) * sequenceUnion)
  );
  const repeatedActivationsPerLayer = Math.max(0, totalActivationsPerLayer - uniquePerLayer);
  let storageRequests = 0;
  let transferEntries = 0;
  for (let l = 0; l < c.layers; l++) {
    let compulsoryStorage = 0;
    let compulsoryTransfer = 0;
    for (let e = 0; e < uniquePerLayer; e++) {
      if (V[l].has(e)) continue;
      if (c.arch === 'discrete') compulsoryTransfer++;
      const resident = e < pin || D[l].has(e) || (!c.odirect && P[l].has(e));
      if (!resident) compulsoryStorage++;
    }
    const storageHotEntries = Math.min(
      uniquePerLayer,
      Math.max(pin + D[l].cap, pin + P[l].cap, V[l].cap)
    );
    storageRequests += compulsoryStorage + Math.ceil(
      repeatedActivationsPerLayer * (1 - zipfTopMass(uniquePerLayer, storageHotEntries))
    );
    if (c.arch === 'discrete') {
      const vramHotEntries = Math.min(uniquePerLayer, V[l].cap);
      transferEntries += compulsoryTransfer + Math.ceil(
        repeatedActivationsPerLayer * (1 - zipfTopMass(uniquePerLayer, vramHotEntries))
      );
    }
  }

  const storageGB = storageRequests * unitGB;
  const prefillStorage = new StorageResource(c);
  const storageJob = prefillStorage.reserveGB(storageGB, 0, 'prefill-expert-read', Math.max(1, storageRequests), 1);
  const transferGB = transferEntries * unitGB;
  const transferMs = c.arch === 'discrete'
    ? transferGB / Math.max(0.01, Math.min(c.pcieBW, c.dramBW)) * 1000
    : 0;
  const perTokenComputeMs = c.attn + c.layers * (0.39 + Math.ceil(c.active / c.par) * c.ems);
  const computeMs = prompt * perTokenComputeMs / Math.max(0.1, c.prefillSpeedup || 4.5);

  const kvPerTokenGB = c.kvKB * 1024 * c.conc / 1e9;
  const initialKvGB = (c.context + prompt) * kvPerTokenGB;
  const deviceKvCap = c.arch === 'discrete' ? Math.max(0, c.vram - c.vcache - 0.8) : 0;
  const hostKvFraction = initialKvGB > EPS ? Math.max(0, initialKvGB - deviceKvCap) / initialKvGB : 0;
  const kvAttentionGB = prompt * (c.context + prompt / 2) * kvPerTokenGB * c.mem.kvTouchFraction;
  const activeWeightGB = prompt * (c.resident + c.layers * c.active * rawUnitGB);
  const dramTrafficGB = storageGB +
    (c.arch === 'unified' ? activeWeightGB + kvAttentionGB : transferGB + kvAttentionGB * hostKvFraction);
  const dramMs = dramTrafficGB / Math.max(0.1, c.dramBW) * 1000;

  let warmedDramEntries = 0;
  let warmedVramEntries = 0;
  for (let l = 0; l < c.layers; l++) {
    for (let e = uniquePerLayer - 1; e >= 0; e--) {
      if (e >= pin) {
        const wasInDram = D[l].has(e);
        D[l].put(e);
        if (!wasInDram && D[l].has(e)) warmedDramEntries++;
        if (!c.odirect) P[l].put(e);
      }
      if (c.arch === 'discrete') {
        const wasInVram = V[l].has(e);
        V[l].put(e);
        if (!wasInVram && V[l].has(e)) warmedVramEntries++;
      }
    }
  }

  return {
    ms: Math.max(computeMs, storageJob.service, transferMs, dramMs),
    computeMs,
    storageMs: storageJob.service,
    transferMs,
    dramMs,
    storageGB,
    transferGB,
    dramTrafficGB,
    uniquePerLayer,
    activatedEntries: uniquePerLayer * c.layers,
    storageRequests,
    transferEntries,
    warmedDramEntries,
    warmedVramEntries
  };
}

function simulateColibri(c = readColibri()) {
  const validation = validateSimulationConfig(c);
  if (!validation.valid) {
    return {
      error: `Invalid configuration: ${formatConfigErrors(validation)}`,
      validationErrors: validation.errors,
      c,
      mode: 'colibri'
    };
  }
  c = applyColibriPlacement(c);
  const R = rng(c.seed);
  const unitGB = c.esize * 1.03 / 1024;
  const rawUnitGB = c.esize / 1024;
  const storage = new StorageResource(c);
  const link = new LinkResource(c);
  const V = Array.from({ length: c.layers }, () => new LRU(cpl(c.vcache, c)));
  const D = Array.from({ length: c.layers }, () => new LRU(cpl(c.dcache, c)));
  const P = Array.from({ length: c.layers }, () => new LRU(c.odirect ? 0 : cpl(c.page, c)));
  const pin = Math.min(c.experts, cpl(c.pinned, c));
  const last = Array.from({ length: c.layers }, () => []);
  const pending = new Map();
  const ready = new Set();
  const tokens = [];
  const kvPerTokenGB = c.kvKB * 1024 * c.conc / 1e9;
  const initialKvGB = (c.context + c.prompt) * kvPerTokenGB;
  const deviceKvCap = c.arch === 'discrete' ? Math.max(0, c.vram - c.vcache - 0.8) : 0;
  const state = createMemoryState(c, 'colibri', initialKvGB, deviceKvCap);
  const tot = { act: 0, v: 0, d: 0, p: 0, pin: 0, vPromotions: 0, demandGB: 0, pfGB: 0, pfIssued: 0, pfUseful: 0, pfEvicted: 0, pfLate: 0, pcieGB: 0, stall: 0, swapExpertInGB: 0 };

  if (!c.cold) {
    for (let l = 0; l < c.layers; l++) {
      for (let e = 0; e < Math.min(c.experts, cpl(c.vcache, c)); e++) V[l].put(e);
      for (let e = pin; e < Math.min(c.experts, pin + cpl(c.dcache, c)); e++) D[l].put(e);
    }
  }

  const prefillBreakdown = simulateColibriPrefill(c, V, D, P, pin, unitGB, rawUnitGB);
  let now = prefillBreakdown.ms;
  const initialPressure = applyPressureColibri(c, state, V, D, P, unitGB, 0);
  const initialSwap = scheduleSwapOut(c, state, initialPressure, storage, now, () => colibriDynamic(c, state, V, D, P, unitGB));
  now = Math.max(now, initialSwap.blockedUntil);
  if (initialPressure.oom) return { error: `Memory pressure OOM before decode: ${fmt(initialPressure.dyn.physicalGB, 1)} / ${fmt(c.host, 1)} GB`, c, mode: 'colibri' };
  if (c.arch === 'discrete' && initialPressure.dyn.deviceGB > c.vram + EPS) {
    return { error: `Device memory OOM before decode: ${fmt(initialPressure.dyn.deviceGB, 1)} / ${fmt(c.vram, 1)} GB`, c, mode: 'colibri' };
  }

  const key = (l, e) => `${l}:${e}`;
  const pruneReady = (l, e) => {
    if (e === null) return;
    const k = key(l, e);
    if (ready.has(k) && !D[l].has(e) && (c.odirect || !P[l].has(e))) {
      ready.delete(k);
      tot.pfEvicted++;
    }
  };
  const flush = t => {
    for (const [k, x] of [...pending]) {
      if (x.end <= t) {
        const dEvicted = D[x.l].put(x.e);
        const pEvicted = c.odirect ? null : P[x.l].put(x.e);
        pruneReady(x.l, dEvicted);
        pruneReady(x.l, pEvicted);
        if (D[x.l].has(x.e) || (!c.odirect && P[x.l].has(x.e))) ready.add(k);
        pending.delete(k);
      }
    }
  };

  for (let ti = 0; ti < c.output; ti++) {
    const ts = now;
    let tokenSSDGB = 0, tokenDemandGB = 0, tokenPrefetchGB = 0, tokenPcieGB = 0, tokenComputeMs = 0, tokenStorageRequests = 0, hits = 0, tokenSwapInGB = 0;
    let tokenCompressionTrafficGB = 0, tokenCompressionCpuMs = 0;

    completePendingSwapOuts(state, now);
    const touch = touchMemoryAtTokenStart(c, state, storage, now);
    now = Math.max(now, touch.readyAt) + touch.compressionCpuMs;
    completePendingSwapOuts(state, now);
    tokenSwapInGB += touch.swapInGB;
    tokenCompressionTrafficGB += touch.compressionTrafficGB;

    const previousRoutes = last.map(route => route.slice());
    const routes = [];
    for (let l = 0; l < c.layers; l++) {
      const a = [], prev = last[l];
      for (const e of prev) if (a.length < c.active && R() < c.corr) a.push(e);
      let guard = 0;
      while (a.length < c.active && guard++ < c.experts * 20) {
        const e = zipfPick(R, c.experts);
        if (!a.includes(e)) a.push(e);
      }
      routes.push(a);
      last[l] = a.slice();
    }

    for (let l = 0; l < c.layers; l++) {
      const start = now;
      flush(start);
      const misses = [];
      const hostSources = [];
      let hostN = 0, readyAt = start;
      for (const e of routes[l]) {
        tot.act++;
        const k = key(l, e);
        if (V[l].get(e)) {
          tot.v++; hits++;
          ready.delete(k);
        } else if (e < pin) {
          tot.pin++; hits++; hostN++; hostSources.push(e);
        } else if (D[l].get(e)) {
          tot.d++; hits++; hostN++; hostSources.push(e);
          if (ready.delete(k)) tot.pfUseful++;
        } else if (!c.odirect && P[l].get(e)) {
          tot.p++; hits++; hostN++; hostSources.push(e);
          const evicted = D[l].put(e);
          pruneReady(l, evicted);
          if (ready.delete(k)) tot.pfUseful++;
        } else if (state.swappedExperts.has(k)) {
          const sj = storage.reserveGB(unitGB, start, 'swap-in-read', 1, 1);
          readyAt = Math.max(readyAt, sj.end);
          state.swappedExperts.delete(k);
          state.swapExpertGB = Math.max(0, state.swapExpertGB - unitGB);
          state.swapStoredGB = Math.max(0, state.swapStoredGB - unitGB);
          state.totalSwapInGB += unitGB;
          tokenSwapInGB += unitGB;
          tot.swapExpertInGB += unitGB;
          hostN++; hostSources.push(e);
          const evicted = D[l].put(e);
          pruneReady(l, evicted);
        } else if (pending.has(k)) {
          const x = pending.get(k);
          pending.delete(k);
          tot.pfUseful++;
          if (x.end > start) tot.pfLate++;
          readyAt = Math.max(readyAt, x.end);
          hostN++; hostSources.push(e);
          const evicted = D[l].put(e);
          pruneReady(l, evicted);
        } else {
          misses.push(e);
          hostN++; hostSources.push(e);
        }
      }

      const demandGB = misses.length * unitGB;
      const dj = storage.reserveGB(demandGB, start, 'expert-demand-read', Math.max(1, misses.length), 1);
      tokenStorageRequests += misses.length;
      readyAt = Math.max(readyAt, dj.end);
      tot.demandGB += dj.gb;
      tokenSSDGB += dj.gb;
      tokenDemandGB += dj.gb;

      const hostGB = hostN * unitGB;
      const lj = link.reserveGB(hostGB, readyAt);
      tokenPcieGB += lj.gb;
      tot.pcieGB += lj.gb;

      const fixed = c.attn / c.layers + 0.39;
      const waves = Math.ceil(c.active / c.par);
      const compute = waves * c.ems;
      tokenComputeMs += fixed + compute;
      const overlap = (fixed + compute * 0.55) * 0.58;
      const exposed = Math.max(0, lj.end - start - overlap);
      now = start + fixed + compute + exposed;
      tot.stall += exposed;

      for (const e of misses) {
        const dEvicted = D[l].put(e);
        const pEvicted = c.odirect ? null : P[l].put(e);
        pruneReady(l, dEvicted);
        pruneReady(l, pEvicted);
      }
      if (c.arch === 'discrete' && lj.end <= now) {
        for (const e of hostSources) {
          const wasInVram = V[l].has(e);
          V[l].put(e);
          if (!wasInVram && V[l].has(e)) tot.vPromotions++;
        }
      }

      if (c.pf && l + 1 < c.layers) {
        const candidates = causalPrefetchCandidates(c, previousRoutes[l + 1], R);
        const filtered = candidates.filter(e =>
          e >= pin &&
          !V[l + 1].has(e) &&
          !D[l + 1].has(e) &&
          !pending.has(key(l + 1, e)) &&
          !state.swappedExperts.has(key(l + 1, e))
        );
        const pfGB = filtered.length * unitGB;
        const pj = storage.reserveGB(pfGB, start, 'expert-prefetch-read', Math.max(1, filtered.length), 1);
        tokenStorageRequests += filtered.length;
        for (const e of filtered) pending.set(key(l + 1, e), { l: l + 1, e, end: pj.end });
        tot.pfIssued += filtered.length;
        tot.pfGB += pj.gb;
        tokenSSDGB += pj.gb;
        tokenPrefetchGB += pj.gb;
      }
    }

    completePendingSwapOuts(state, now);
    growKV(c, state, kvPerTokenGB);
    const pressure = applyPressureColibri(c, state, V, D, P, unitGB, ti + 1);
    for (const readyKey of [...ready]) {
      const [layer, expert] = readyKey.split(':').map(Number);
      pruneReady(layer, expert);
    }
    const swapSchedule = scheduleSwapOut(c, state, pressure, storage, now, () => colibriDynamic(c, state, V, D, P, unitGB));
    now = Math.max(now, swapSchedule.blockedUntil);
    tokenCompressionTrafficGB += pressure.compressionTrafficGB;
    tokenCompressionCpuMs += pressure.compressionCpuMs;

    const dyn = pressure.dyn;
    if (c.arch === 'discrete' && dyn.deviceGB > c.vram + EPS) {
      pressure.state = 'OOM';
      pressure.oom = true;
      state.oom = true;
    }
    const kvTouchGB = (state.kvUncompressedGB + state.kvCompressedOriginalGB) * c.mem.kvTouchFraction;
    const loadWriteGB = tokenSSDGB;
    const swapTrafficGB = tokenSwapInGB + pressure.swapOutGB;
    const activeWeightGB = c.arch === 'unified' ? c.layers * c.active * rawUnitGB + c.resident : tokenPcieGB;
    const dramTrafficGB = activeWeightGB + kvTouchGB + loadWriteGB + swapTrafficGB + tokenCompressionTrafficGB;
    const baseElapsed = now - ts + tokenCompressionCpuMs;
    const dramFloorMs = dramTrafficGB / c.dramBW * 1000;
    const finalElapsed = Math.max(baseElapsed, dramFloorMs);
    const dramStallMs = Math.max(0, finalElapsed - baseElapsed);
    now = ts + finalElapsed;

    const dramGBs = dramTrafficGB / Math.max(EPS, finalElapsed / 1000);
    state.peakDramGBs = Math.max(state.peakDramGBs, dramGBs);
    state.totalDramTrafficGB += dramTrafficGB;
    state.totalDramStallMs += dramStallMs;

    const snap = memorySnapshot(c, state, dyn, pressure, ti + 1, {
      swapInGB: tokenSwapInGB,
      compressionTrafficGB: tokenCompressionTrafficGB,
      dramTrafficGB,
      dramGBs,
      dramUtilization: dramGBs / c.dramBW,
      dramStallMs
    });

    tokens.push({
      tpot: finalElapsed,
      ssdGB: tokenSSDGB,
      demandGB: tokenDemandGB,
      prefetchGB: tokenPrefetchGB,
      pcieGB: tokenPcieGB,
      computeMs: tokenComputeMs + tokenCompressionCpuMs,
      storageRequests: tokenStorageRequests,
      hit: hits / (c.layers * c.active),
      boundary: false,
      memory: snap
    });

    if (pressure.oom) break;
  }

  if (!tokens.length) return { error: 'No token completed.', c, mode: 'colibri' };
  tot.pfWasted = Math.max(0, tot.pfIssued - tot.pfUseful);
  const intervals = tokens.length > 1 ? tokens.slice(1) : tokens;
  const avg = intervals.reduce((a, x) => a + x.tpot, 0) / intervals.length;
  const tps = 1000 / avg;
  const totalStorageGB = storage.gb;
  const ssdPt = totalStorageGB / tokens.length;
  const hit = (tot.v + tot.d + tot.p + tot.pin) / Math.max(1, tot.act);
  const prefill = prefillBreakdown.ms;
  const ttft = prefill + tokens[0].tpot;
  const pciePt = tot.pcieGB / tokens.length;
  const ssdBound = ssdPt ? c.ssdBW / ssdPt : Infinity;
  const pcieBound = c.arch === 'discrete' && pciePt ? Math.min(c.pcieBW, c.dramBW) / pciePt : Infinity;
  const dramPt = state.totalDramTrafficGB / tokens.length;
  const dramBound = dramPt ? c.dramBW / dramPt : Infinity;
  const agg = Math.min(c.conc * tps, ssdBound, pcieBound, dramBound);
  const elapsed = Math.max(tokens.reduce((a, x) => a + x.tpot, 0), storage.free - prefill);
  const observed = storage.gb / Math.max(EPS, elapsed / 1000);
  const ev = V.reduce((a, x) => a + x.ev, 0) + D.reduce((a, x) => a + x.ev, 0) + P.reduce((a, x) => a + x.ev, 0);
  return {
    mode: 'colibri', c, tokens, tot, state, avg, tps, ssdPt, hit, prefill, prefillBreakdown, ttft, agg,
    ssdBound, pcieBound, dramBound, observed, ssdBusy: storage.busy, ssdQueue: storage.queue,
    storageByKind: storage.byKind, ev, oom: state.oom
  };
}
