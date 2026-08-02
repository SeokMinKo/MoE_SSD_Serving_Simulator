function cpl(gb, c) { return Math.max(0, Math.floor(gb * 1000 / (c.esize * 1.03) / c.layers)); }
function buildZipfCDF(n, a = 1.05) {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 1; i <= n; i++) total += 1 / Math.pow(i, a);
  let cumulative = 0;
  for (let i = 1; i <= n; i++) {
    cumulative += 1 / Math.pow(i, a) / total;
    cdf[i - 1] = cumulative;
  }
  return cdf;
}

function buildZipfWeights(n, a = 1.05) {
  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) weights[i] = 1 / Math.pow(i + 1, a);
  return weights;
}

function fillZipfWithoutReplacement(route, selected, random, weights, target) {
  const n = weights.length;
  const tree = new Float64Array(n + 1);
  const remainingWeights = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (selected.has(i)) continue;
    const weight = weights[i];
    remainingWeights[i] = weight;
    tree[i + 1] = weight;
    total += weight;
  }
  for (let i = 1; i <= n; i++) {
    const parent = i + (i & -i);
    if (parent <= n) tree[parent] += tree[i];
  }
  const linearEdgePick = fraction => {
    let exactTotal = 0;
    for (const weight of remainingWeights) exactTotal += weight;
    let targetWeight = Math.max(0, Math.min(1 - Number.EPSILON, fraction)) * exactTotal;
    let fallback = -1;
    for (let i = 0; i < n; i++) {
      const weight = remainingWeights[i];
      if (!(weight > 0)) continue;
      fallback = i;
      if (targetWeight < weight) return i;
      targetWeight -= weight;
    }
    return fallback;
  };
  while (route.length < target && total > 0) {
    const fraction = random();
    let needle = fraction * total;
    let index = 0;
    let bit = 1;
    while ((bit << 1) <= n) bit <<= 1;
    for (; bit; bit >>= 1) {
      const next = index + bit;
      if (next <= n && tree[next] <= needle) {
        index = next;
        needle -= tree[next];
      }
    }
    let expert = Math.min(index, n - 1);
    if (!(remainingWeights[expert] > 0) || selected.has(expert)) expert = linearEdgePick(fraction);
    if (expert < 0 || !(remainingWeights[expert] > 0) || selected.has(expert)) throw new Error('Zipf route sampler failed to select a unique expert.');
    const weight = remainingWeights[expert];
    remainingWeights[expert] = 0;
    selected.add(expert);
    route.push(expert);
    total -= weight;
    for (let cursor = expert + 1; cursor <= n; cursor += cursor & -cursor) tree[cursor] -= weight;
  }
  if (route.length !== target) throw new Error('Zipf route sampler could not fill the configured active expert count.');
}

function zipfPick(r, cdf) {
  const u = r();
  let low = 0, high = cdf.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (u <= cdf[mid]) high = mid;
    else low = mid + 1;
  }
  return low;
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
  const max = Math.min(c.experts, Math.floor(c.budget / (c.esize * 1.03)));
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
    storageEvents: [],
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
    ? transferGB / Math.max(EPS, Math.min(c.pcieBW, c.dramBW)) * 1000
    : 0;
  const perTokenComputeMs = c.attn + c.layers * (0.39 + Math.ceil(c.active / c.par) * c.ems);
  const computeMs = prompt * perTokenComputeMs / Math.max(EPS, c.prefillSpeedup || 4.5);

  const kvPerTokenGB = c.kvKB * 1000 * c.conc / 1e9;
  const initialKvGB = (c.context + prompt) * kvPerTokenGB;
  const deviceKvCap = c.arch === 'discrete' ? Math.max(0, c.vram - c.vcache - 0.8) : 0;
  const hostKvFraction = initialKvGB > EPS ? Math.max(0, initialKvGB - deviceKvCap) / initialKvGB : 0;
  const kvAttentionGB = prompt * (c.context + prompt / 2) * kvPerTokenGB * c.mem.kvTouchFraction;
  const activeWeightGB = prompt * (c.resident + c.layers * c.active * rawUnitGB);
  const dramTrafficGB = storageGB +
    (c.arch === 'unified' ? activeWeightGB + kvAttentionGB : transferGB + kvAttentionGB * hostKvFraction);
  const dramMs = dramTrafficGB / Math.max(EPS, c.dramBW) * 1000;

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
    storageEvents: summarizeStorageEvents(prefillStorage.events),
    transferEntries,
    warmedDramEntries,
    warmedVramEntries
  };
}

function snapshotColibriCaches(groups) {
  return groups.map(group => group.map(cache => ({
    entries: [...cache.m.entries()],
    ev: cache.ev
  })));
}

function restoreColibriCaches(groups, snapshot) {
  groups.forEach((group, groupIndex) => group.forEach((cache, layerIndex) => {
    cache.m = new Map(snapshot[groupIndex][layerIndex].entries);
    cache.ev = snapshot[groupIndex][layerIndex].ev;
  }));
}

function simulateColibri(c = readColibri(), options = {}) {
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
  const unitGB = c.esize * 1.03 / 1000;
  const rawUnitGB = c.esize / 1000;
  const storage = new StorageResource(c);
  const link = new LinkResource(c);
  const V = Array.from({ length: c.layers }, () => new LRU(cpl(c.vcache, c)));
  const D = Array.from({ length: c.layers }, () => new LRU(cpl(c.dcache, c)));
  const P = Array.from({ length: c.layers }, () => new LRU(c.odirect ? 0 : cpl(c.page, c)));
  for (const [caches, snapshots] of [[V, options.cacheState?.v], [D, options.cacheState?.d], [P, options.cacheState?.p]]) {
    if (!Array.isArray(snapshots)) continue;
    for (let layer = 0; layer < Math.min(caches.length, snapshots.length); layer++) {
      if (!Array.isArray(snapshots[layer])) continue;
      for (const expert of snapshots[layer]) if (Number.isSafeInteger(expert) && expert >= 0 && expert < c.experts) caches[layer].put(expert);
    }
  }
  const pin = Math.min(c.experts, cpl(c.pinned, c));
  const last = Array.from({ length: c.layers }, () => []);
  const routeZipfCDF = buildZipfCDF(c.experts);
  const routeZipfWeights = buildZipfWeights(c.experts);
  const pending = new Map();
  const ready = new Set();
  const tokens = [];
  const kvPerTokenGB = c.kvKB * 1000 * c.conc / 1e9;
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
  const initialDyn = colibriDynamic(c, state, V, D, P, unitGB);
  state.peakAllocationDemandGB = Math.max(state.peakAllocationDemandGB, initialDyn.physicalGB);
  const initialPressure = applyPressureColibri(c, state, V, D, P, unitGB, 0);
  now += initialPressure.compressionCpuMs;
  const initialSwap = scheduleSwapOut(c, state, initialPressure, storage, now, () => colibriDynamic(c, state, V, D, P, unitGB));
  now = Math.max(now, initialSwap.blockedUntil);
  completePendingSwapOuts(state, now);
  if (initialPressure.oom) return { error: `Memory pressure OOM before decode: ${fmt(initialPressure.dyn.physicalGB, 1)} / ${fmt(c.host, 1)} GB`, c, mode: 'colibri', state, oom: true };
  const admittedInitialDyn = colibriDynamic(c, state, V, D, P, unitGB);
  state.peakPhysicalGB = Math.max(state.peakPhysicalGB, admittedInitialDyn.physicalGB);
  const predecodeReadyMs = now;
  const prefillStorageEvents = summarizeStorageEvents([...prefillBreakdown.storageEvents, ...storage.events]);
  const startupStorageGB = prefillStorageEvents.reduce((sum, event) => sum + event.gb, 0);
  const predecodeStorageGB = storage.gb;
  storage.events.length = 0;

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
    const storageEventStart = storage.events.length;
    let tokenSSDGB = 0, tokenDemandGB = 0, tokenPrefetchGB = 0, tokenPcieGB = 0, tokenComputeMs = 0, tokenStorageRequests = 0, tokenDemandRequests = 0, tokenPrefetchRequests = 0, hits = 0, tokenSwapInGB = 0;
    let tokenCompressionTrafficGB = 0, tokenCompressionCpuMs = 0;
    let tokenStorageServiceMs = 0, tokenStorageQueueMs = 0, tokenSwapServiceMs = 0, tokenSwapQueueMs = 0;

    completePendingSwapOuts(state, now);
    const tokenTransaction = {
      now,
      memory: snapshotMemoryState(state),
      caches: snapshotColibriCaches([V, D, P]),
      storage: snapshotStorageResource(storage),
      link: { free: link.free, gb: link.gb },
      pending: [...pending.entries()].map(([entryKey, value]) => [entryKey, { ...value }]),
      ready: [...ready],
      last: last.map(route => route.slice()),
      totals: { ...tot }
    };
    const touch = touchMemoryAtTokenStart(c, state, storage, now);
    now = Math.max(now, touch.readyAt) + touch.compressionCpuMs;
    completePendingSwapOuts(state, now);
    tokenSwapInGB += touch.swapInGB;
    tokenStorageServiceMs += touch.storageServiceMs;
    tokenStorageQueueMs += touch.storageQueueMs;
    tokenSwapServiceMs += touch.storageServiceMs;
    tokenSwapQueueMs += touch.storageQueueMs;
    tokenCompressionTrafficGB += touch.compressionTrafficGB;

    const previousRoutes = last.map(route => route.slice());
    const routes = [];
    for (let l = 0; l < c.layers; l++) {
      const a = [], prev = last[l];
      for (const e of prev) if (a.length < c.active && R() < c.corr) a.push(e);
      const selected = new Set(a);
      const denseRoute = c.active - a.length > c.experts / 4;
      let guard = 0;
      const sparseDrawLimit = Math.max(32, c.active * 8);
      while (!denseRoute && a.length < c.active && guard++ < sparseDrawLimit) {
        const e = zipfPick(R, routeZipfCDF);
        if (!selected.has(e)) {
          selected.add(e);
          a.push(e);
        }
      }
      if (a.length < c.active) fillZipfWithoutReplacement(a, selected, R, routeZipfWeights, c.active);
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
          tokenStorageServiceMs += sj.service;
          tokenStorageQueueMs += sj.wait;
          tokenSwapServiceMs += sj.service;
          tokenSwapQueueMs += sj.wait;
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
          tot.pfUseful++;
          if (x.end > start) tot.pfLate++;
          readyAt = Math.max(readyAt, x.end);
          flush(readyAt);
          ready.delete(k);
          hostN++; hostSources.push(e);
        } else {
          misses.push(e);
          hostN++; hostSources.push(e);
        }
      }

      const demandGB = misses.length * unitGB;
      const dj = storage.reserveGB(demandGB, start, 'expert-demand-read', Math.max(1, misses.length), 1);
      tokenStorageServiceMs += dj.service;
      tokenStorageQueueMs += dj.wait;
      tokenStorageRequests += misses.length;
      tokenDemandRequests += misses.length;
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
          (c.odirect || !P[l + 1].has(e)) &&
          !pending.has(key(l + 1, e)) &&
          !state.swappedExperts.has(key(l + 1, e))
        );
        const pfGB = filtered.length * unitGB;
        const pj = storage.reserveGB(pfGB, start, 'expert-prefetch-read', Math.max(1, filtered.length), 1);
        tokenStorageServiceMs += pj.service;
        tokenStorageQueueMs += pj.wait;
        tokenStorageRequests += filtered.length;
        tokenPrefetchRequests += filtered.length;
        for (const e of filtered) pending.set(key(l + 1, e), { l: l + 1, e, end: pj.end });
        tot.pfIssued += filtered.length;
        tot.pfGB += pj.gb;
        tokenSSDGB += pj.gb;
        tokenPrefetchGB += pj.gb;
      }
    }

    completePendingSwapOuts(state, now);
    growKV(c, state, kvPerTokenGB);
    const prePressureDyn = colibriDynamic(c, state, V, D, P, unitGB);
    state.peakAllocationDemandGB = Math.max(state.peakAllocationDemandGB, prePressureDyn.physicalGB);
    const pressure = applyPressureColibri(c, state, V, D, P, unitGB, ti + 1);
    for (const readyKey of [...ready]) {
      const [layer, expert] = readyKey.split(':').map(Number);
      pruneReady(layer, expert);
    }
    const swapSchedule = scheduleSwapOut(c, state, pressure, storage, now, () => colibriDynamic(c, state, V, D, P, unitGB));
    if (swapSchedule.job) {
      tokenStorageServiceMs += swapSchedule.job.service;
      tokenStorageQueueMs += swapSchedule.job.wait;
      tokenSwapServiceMs += swapSchedule.job.service;
      tokenSwapQueueMs += swapSchedule.job.wait;
    }
    now = Math.max(now, swapSchedule.blockedUntil);
    tokenCompressionTrafficGB += pressure.compressionTrafficGB;
    tokenCompressionCpuMs += pressure.compressionCpuMs;

    const dyn = pressure.dyn;
    if (c.arch === 'discrete' && dyn.deviceGB > c.vram + EPS) {
      pressure.state = 'OOM';
      pressure.oom = true;
      state.oom = true;
    }
    if (pressure.oom) {
      const allocationDemandGB = state.peakAllocationDemandGB;
      restoreMemoryState(state, tokenTransaction.memory);
      state.peakAllocationDemandGB = Math.max(state.peakAllocationDemandGB, allocationDemandGB);
      state.oom = true;
      state.lastState = 'OOM';
      restoreColibriCaches([V, D, P], tokenTransaction.caches);
      restoreStorageResource(storage, tokenTransaction.storage);
      link.free = tokenTransaction.link.free;
      link.gb = tokenTransaction.link.gb;
      pending.clear();
      for (const [entryKey, value] of tokenTransaction.pending) pending.set(entryKey, value);
      ready.clear();
      for (const entryKey of tokenTransaction.ready) ready.add(entryKey);
      for (let layer = 0; layer < last.length; layer++) last[layer] = tokenTransaction.last[layer].slice();
      Object.assign(tot, tokenTransaction.totals);
      now = tokenTransaction.now;
      break;
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
    completePendingSwapOuts(state, now);
    const snapshotDyn = colibriDynamic(c, state, V, D, P, unitGB);

    const dramGBs = dramTrafficGB / Math.max(EPS, finalElapsed / 1000);
    state.peakDramGBs = Math.max(state.peakDramGBs, dramGBs);
    state.totalDramTrafficGB += dramTrafficGB;
    state.totalDramStallMs += dramStallMs;

    const snap = memorySnapshot(c, state, snapshotDyn, pressure, ti + 1, {
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
      memoryCpuMs: tokenCompressionCpuMs,
      storageServiceMs: tokenStorageServiceMs,
      storageQueueMs: tokenStorageQueueMs,
      swapServiceMs: tokenSwapServiceMs,
      swapQueueMs: tokenSwapQueueMs,
      swapInGB: tokenSwapInGB,
      swapOutGB: pressure.swapOutGB,
      storageRequests: tokenStorageRequests,
      demandRequests: tokenDemandRequests,
      prefetchRequests: tokenPrefetchRequests,
      storageEvents: summarizeStorageEvents(storage.events.slice(storageEventStart)),
      hit: hits / (c.layers * c.active),
      boundary: false,
      memory: snap
    });
    storage.events.length = storageEventStart;

  }

  if (!tokens.length) return { error: state.oom ? 'Memory pressure OOM before any decode token completed.' : 'No token completed.', c, mode: 'colibri', state, tokens, oom: state.oom };
  tot.pfWasted = Math.max(0, tot.pfIssued - tot.pfUseful);
  const intervals = tokens.length > 1 ? tokens.slice(1) : tokens;
  const avg = intervals.reduce((a, x) => a + x.tpot, 0) / intervals.length;
  const tps = 1000 / avg;
  const decodeStorageGB = Math.max(0, storage.gb - predecodeStorageGB);
  const ssdPt = decodeStorageGB / tokens.length;
  const hit = (tot.v + tot.d + tot.p + tot.pin) / Math.max(1, tot.act);
  const prefill = prefillBreakdown.ms;
  const ttft = predecodeReadyMs + tokens[0].tpot;
  const pciePt = tot.pcieGB / tokens.length;
  const ssdBound = ssdPt ? c.ssdBW / ssdPt : Infinity;
  const pcieBound = c.arch === 'discrete' && pciePt ? Math.min(c.pcieBW, c.dramBW) / pciePt : Infinity;
  const dramPt = state.totalDramTrafficGB / tokens.length;
  const dramBound = dramPt ? c.dramBW / dramPt : Infinity;
  const agg = Math.min(c.conc * tps, ssdBound, pcieBound, dramBound);
  const decodeMs = tokens.reduce((sum, token) => sum + token.tpot, 0);
  const decodeStorageElapsedMs = Math.max(decodeMs, storage.free - predecodeReadyMs);
  const observed = decodeStorageGB / Math.max(EPS, decodeStorageElapsedMs / 1000);
  const ev = V.reduce((a, x) => a + x.ev, 0) + D.reduce((a, x) => a + x.ev, 0) + P.reduce((a, x) => a + x.ev, 0);
  return {
    mode: 'colibri', c, tokens, tot, state, avg, tps, ssdPt, startupStorageGB, decodeStorageGB, hit, prefill, prefillBreakdown, prefillStorageEvents, ttft, agg,
    ssdBound, pcieBound, dramBound, observed, ssdBusy: storage.busy, ssdQueue: storage.queue,
    storageByKind: storage.byKind,
    initialCompressionCpuMs: initialPressure.compressionCpuMs,
    initialSwapServiceMs: initialSwap.job?.service || 0,
    initialSwapQueueMs: initialSwap.job?.wait || 0,
    cacheState: {
      v: V.map(cache => [...cache.m.keys()]),
      d: D.map(cache => [...cache.m.keys()]),
      p: P.map(cache => [...cache.m.keys()])
    },
    ev, oom: state.oom
  };
}
