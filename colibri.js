function cpl(gb, c) { return Math.max(0, Math.floor(gb * 1024 / c.esize / c.layers)); }
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

function simulateColibri(c = readColibri()) {
  const R = rng(c.seed);
  const unitGB = c.esize * 1.03 / 1024;
  const rawUnitGB = c.esize / 1024;
  const storage = new StorageResource(c);
  const link = new LinkResource(c);
  const V = Array.from({ length: c.layers }, () => new LRU(cpl(c.vcache, c)));
  const D = Array.from({ length: c.layers }, () => new LRU(cpl(c.dcache, c)));
  const P = Array.from({ length: c.layers }, () => new LRU(c.odirect ? 0 : cpl(c.page, c)));
  const pin = cpl(c.pinned, c);
  const last = Array.from({ length: c.layers }, () => []);
  const pending = new Map();
  const ready = new Set();
  const tokens = [];
  const kvPerTokenGB = c.kvKB * 1024 * c.conc / 1e9;
  const initialKvGB = (c.context + c.prompt) * kvPerTokenGB;
  const deviceKvCap = c.arch === 'discrete' ? Math.max(0, c.vram - c.vcache - 0.8) : 0;
  const state = createMemoryState(c, 'colibri', initialKvGB, deviceKvCap);
  const tot = { act: 0, v: 0, d: 0, p: 0, pin: 0, demandGB: 0, pfGB: 0, pfIssued: 0, pfUseful: 0, pfLate: 0, pcieGB: 0, stall: 0, swapExpertInGB: 0 };
  let now = 0;

  if (!c.cold) {
    for (let l = 0; l < c.layers; l++) {
      for (let e = 0; e < Math.max(cpl(c.dcache, c), cpl(c.vcache, c)); e++) {
        D[l].put(e);
        if (e < cpl(c.vcache, c)) V[l].put(e);
      }
    }
  }

  const initialPressure = applyPressureColibri(c, state, V, D, P, unitGB, 0);
  if (initialPressure.swapOutGB > EPS) storage.reserveGB(initialPressure.swapOutGB, now, 'swap-out-write', 1, c.mem.swapWriteRatio);
  if (initialPressure.oom) return { error: `Memory pressure OOM before decode: ${fmt(initialPressure.dyn.physicalGB, 1)} / ${fmt(c.host, 1)} GB`, c, mode: 'colibri' };

  const key = (l, e) => `${l}:${e}`;
  const flush = t => {
    for (const [k, x] of [...pending]) {
      if (x.end <= t) {
        D[x.l].put(x.e);
        if (!c.odirect) P[x.l].put(x.e);
        ready.add(k);
        pending.delete(k);
      }
    }
  };

  for (let ti = 0; ti < c.output; ti++) {
    const ts = now;
    let tokenSSDGB = 0, tokenPcieGB = 0, hits = 0, tokenSwapInGB = 0;
    let tokenCompressionTrafficGB = 0, tokenCompressionCpuMs = 0;

    const touch = touchMemoryAtTokenStart(c, state, storage, now);
    now = Math.max(now, touch.readyAt) + touch.compressionCpuMs;
    tokenSwapInGB += touch.swapInGB;
    tokenCompressionTrafficGB += touch.compressionTrafficGB;

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
      let hostN = 0, readyAt = start;
      for (const e of routes[l]) {
        tot.act++;
        const k = key(l, e);
        if (e < pin) {
          tot.pin++; hits++; hostN++;
        } else if (V[l].get(e)) {
          tot.v++; hits++;
          if (ready.delete(k)) tot.pfUseful++;
        } else if (D[l].get(e)) {
          tot.d++; hits++; hostN++;
          if (ready.delete(k)) tot.pfUseful++;
        } else if (!c.odirect && P[l].get(e)) {
          tot.p++; hits++; hostN++;
          D[l].put(e);
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
          hostN++;
          D[l].put(e);
        } else if (pending.has(k)) {
          const x = pending.get(k);
          pending.delete(k);
          tot.pfUseful++;
          if (x.end > start) tot.pfLate++;
          readyAt = Math.max(readyAt, x.end);
          hostN++;
          D[l].put(e);
        } else {
          misses.push(e);
          hostN++;
        }
      }

      const demandGB = misses.length * unitGB;
      const dj = storage.reserveGB(demandGB, start, 'expert-demand-read', Math.max(1, Math.ceil(misses.length / c.qd)), 1);
      readyAt = Math.max(readyAt, dj.end);
      tot.demandGB += dj.gb;
      tokenSSDGB += dj.gb;

      const hostGB = hostN * unitGB;
      const lj = link.reserveGB(hostGB, readyAt);
      tokenPcieGB += lj.gb;
      tot.pcieGB += lj.gb;

      const fixed = c.attn / c.layers + 0.39;
      const waves = Math.ceil(c.active / c.par);
      const compute = waves * c.ems;
      const overlap = (fixed + compute * 0.55) * 0.58;
      const exposed = Math.max(0, lj.end - start - overlap);
      now = start + fixed + compute + exposed;
      tot.stall += exposed;

      for (const e of misses) {
        D[l].put(e);
        if (!c.odirect) P[l].put(e);
        if (c.arch === 'discrete' && lj.end <= now) V[l].put(e);
      }

      if (c.pf && l + 1 < c.layers) {
        const actual = routes[l + 1], cand = [];
        for (const e of actual) if (R() < c.recall) cand.push(e);
        const max = Math.floor(c.budget / c.esize);
        const target = Math.min(max, Math.ceil(cand.length / c.precision));
        while (cand.length < target) {
          const e = Math.floor(R() * c.experts);
          if (!cand.includes(e)) cand.push(e);
        }
        const filtered = cand.filter(e => !V[l + 1].has(e) && !D[l + 1].has(e) && !pending.has(key(l + 1, e)) && !state.swappedExperts.has(key(l + 1, e))).slice(0, max);
        const pfGB = filtered.length * unitGB;
        const pj = storage.reserveGB(pfGB, start, 'expert-prefetch-read', Math.max(1, Math.ceil(filtered.length / c.qd)), 1);
        for (const e of filtered) pending.set(key(l + 1, e), { l: l + 1, e, end: pj.end });
        tot.pfIssued += filtered.length;
        tot.pfGB += pj.gb;
        tokenSSDGB += pj.gb;
      }
    }

    growKV(c, state, kvPerTokenGB);
    const pressure = applyPressureColibri(c, state, V, D, P, unitGB, ti + 1);
    if (pressure.swapOutGB > EPS) storage.reserveGB(pressure.swapOutGB, now, 'swap-out-write', 1, c.mem.swapWriteRatio);
    tokenCompressionTrafficGB += pressure.compressionTrafficGB;
    tokenCompressionCpuMs += pressure.compressionCpuMs;

    const dyn = pressure.dyn;
    const kvTouchGB = (state.kvUncompressedGB + state.kvCompressedOriginalGB) * c.mem.kvTouchFraction;
    const loadWriteGB = tokenSSDGB + tokenSwapInGB;
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
  const prefillUnique = Math.min(c.experts, c.active * (1 + Math.log2(Math.max(1, c.prompt)) * 1.6));
  const coverage = c.cold ? c.pinned / (c.layers * c.experts * c.esize / 1024) : (c.pinned + (c.dcache + c.vcache + c.page) * 0.1) / (c.layers * c.experts * c.esize / 1024);
  const prefillGB = prefillUnique * c.layers * c.esize / 1024 * (1 - clamp(coverage, 0, 1));
  const prefill = Math.max(c.prompt / 28 * 1000, prefillGB / c.ssdBW * 1000);
  const ttft = prefill + tokens[0].tpot;
  const pciePt = tot.pcieGB / tokens.length;
  const ssdBound = ssdPt ? c.ssdBW / ssdPt : Infinity;
  const pcieBound = c.arch === 'discrete' && pciePt ? Math.min(c.pcieBW, c.dramBW) / pciePt : Infinity;
  const dramPt = state.totalDramTrafficGB / tokens.length;
  const dramBound = dramPt ? c.dramBW / dramPt : Infinity;
  const agg = Math.min(c.conc * tps, ssdBound, pcieBound, dramBound);
  const elapsed = Math.max(tokens.reduce((a, x) => a + x.tpot, 0), storage.free);
  const observed = storage.gb / Math.max(EPS, elapsed / 1000);
  const ev = V.reduce((a, x) => a + x.ev, 0) + D.reduce((a, x) => a + x.ev, 0) + P.reduce((a, x) => a + x.ev, 0);
  return {
    mode: 'colibri', c, tokens, tot, state, avg, tps, ssdPt, hit, prefill, ttft, agg,
    ssdBound, pcieBound, dramBound, observed, ssdBusy: storage.busy, ssdQueue: storage.queue,
    storageByKind: storage.byKind, ev, oom: state.oom
  };
}
