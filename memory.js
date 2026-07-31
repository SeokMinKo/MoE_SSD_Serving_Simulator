function createMemoryState(c, mode, initialKvGB, deviceKvCap = 0) {
  const deviceKVGB = mode === 'colibri' && c.arch === 'discrete' ? Math.min(initialKvGB, deviceKvCap) : 0;
  return {
    mode,
    kvUncompressedGB: Math.max(0, initialKvGB - deviceKVGB),
    kvCompressedOriginalGB: 0,
    kvSwapRawOriginalGB: 0,
    kvSwapCompressedOriginalGB: 0,
    deviceKVGB,
    deviceKvCap,
    swappedExperts: new Set(),
    swapExpertGB: 0,
    swapStoredGB: 0,
    swapStartToken: null,
    totalSwapInGB: 0,
    totalSwapOutGB: 0,
    totalCompressionTrafficGB: 0,
    totalPageReclaimedGB: 0,
    totalExpertReclaimedGB: 0,
    peakPhysicalGB: 0,
    minFreeGB: Infinity,
    peakSwapGB: 0,
    peakDramGBs: 0,
    peakDeviceGB: 0,
    pendingSwapOutGB: 0,
    pendingSwapOutJobs: [],
    totalDramTrafficGB: 0,
    totalDramStallMs: 0,
    oom: false,
    lastState: 'NORMAL'
  };
}

function kvPhysicalGB(state, c) {
  return state.kvUncompressedGB + state.kvCompressedOriginalGB / c.mem.compressionRatio;
}
function swapResidentGB(state, c) {
  return state.swapExpertGB + state.kvSwapRawOriginalGB + state.kvSwapCompressedOriginalGB / c.mem.compressionRatio;
}
function totalEntries(caches) { return caches.reduce((a, x) => a + x.size, 0); }
function unionEntries(a, b) {
  const s = new Set();
  for (let l = 0; l < a.length; l++) {
    for (const k of a[l].m.keys()) s.add(`${l}:${k}`);
    for (const k of b[l].m.keys()) s.add(`${l}:${k}`);
  }
  return s.size;
}
function evictEntries(caches, count, onEvict) {
  let removed = 0;
  while (removed < count) {
    let progressed = false;
    for (let l = 0; l < caches.length && removed < count; l++) {
      const e = caches[l].deleteOldest();
      if (e !== null) {
        progressed = true;
        removed++;
        if (onEvict) onEvict(l, e);
      }
    }
    if (!progressed) break;
  }
  return removed;
}

function colibriDynamic(c, state, V, D, P, unitGB) {
  const expertEntries = c.arch === 'unified' ? unionEntries(V, D) : totalEntries(D);
  const expertGB = expertEntries * unitGB;
  const pageGB = totalEntries(P) * unitGB;
  const fixedGB = c.resident + c.pinned + c.mem.osReservedGB + c.mem.backgroundGB + 3 + (c.arch === 'unified' ? 0.8 : 0);
  const physicalGB = fixedGB + expertGB + pageGB + kvPhysicalGB(state, c) + state.pendingSwapOutGB;
  const deviceGB = c.arch === 'discrete' ? totalEntries(V) * unitGB + state.deviceKVGB + 0.8 : 0;
  return { fixedGB, expertGB, pageGB, kvGB: kvPhysicalGB(state, c), physicalGB, deviceGB };
}

function afmDynamic(c, d, state) {
  const fixedGB = c.commonGB + d.sharedGB + d.routedGB + (c.doubleBuffer ? d.routedGB : 0) + c.mem.osReservedGB + c.mem.backgroundGB + 3 + 0.8;
  const physicalGB = fixedGB + kvPhysicalGB(state, c) + state.pendingSwapOutGB;
  return { fixedGB, expertGB: d.sharedGB + d.routedGB, pageGB: 0, kvGB: kvPhysicalGB(state, c), physicalGB, deviceGB: 0 };
}

function growKV(c, state, tokenGB) {
  if (state.deviceKVGB < state.deviceKvCap) {
    const toDevice = Math.min(tokenGB, state.deviceKvCap - state.deviceKVGB);
    state.deviceKVGB += toDevice;
    state.kvUncompressedGB += tokenGB - toDevice;
  } else {
    state.kvUncompressedGB += tokenGB;
  }
}

function completePendingSwapOuts(state, now) {
  const remaining = [];
  let completedGB = 0;
  for (const job of state.pendingSwapOutJobs) {
    if (job.end <= now + EPS) completedGB += job.gb;
    else remaining.push(job);
  }
  state.pendingSwapOutJobs = remaining;
  state.pendingSwapOutGB = Math.max(0, state.pendingSwapOutGB - completedGB);
  return completedGB;
}

function scheduleSwapOut(c, state, pressure, storage, now, dynamic) {
  if (pressure.swapOutGB <= EPS) return { blockedUntil: now, job: null };
  const job = storage.reserveGB(pressure.swapOutGB, now, 'swap-out-write', 1, c.mem.swapWriteRatio);
  state.pendingSwapOutJobs.push({ end: job.end, gb: pressure.swapOutGB });
  state.pendingSwapOutGB += pressure.swapOutGB;
  pressure.dyn = dynamic();

  let blockedUntil = now;
  const hard = thresholdGB(c, c.mem.hard);
  if (pressure.dyn.physicalGB > hard + EPS) {
    blockedUntil = job.end;
    completePendingSwapOuts(state, blockedUntil);
    pressure.dyn = dynamic();
    if (pressure.dyn.physicalGB > hard + EPS) {
      pressure.state = 'OOM';
      pressure.oom = true;
      state.oom = true;
    }
  }
  return { blockedUntil, job };
}

function touchMemoryAtTokenStart(c, state, storage, now) {
  let swapInGB = 0;
  let compressionTrafficGB = 0;
  let compressionCpuMs = 0;
  let storageServiceMs = 0;
  let storageQueueMs = 0;
  let readyAt = now;
  const f = c.mem.kvTouchFraction;

  const rawOriginal = state.kvSwapRawOriginalGB * f;
  if (rawOriginal > EPS) {
    const job = storage.reserveGB(rawOriginal, now, 'swap-in-read', 1, 1);
    storageServiceMs += job.service;
    storageQueueMs += job.wait;
    readyAt = Math.max(readyAt, job.end);
    state.kvSwapRawOriginalGB -= rawOriginal;
    state.kvUncompressedGB += rawOriginal;
    state.swapStoredGB = Math.max(0, state.swapStoredGB - rawOriginal);
    swapInGB += rawOriginal;
  }

  const compressedOriginal = state.kvSwapCompressedOriginalGB * f;
  if (compressedOriginal > EPS) {
    const storedGB = compressedOriginal / c.mem.compressionRatio;
    const job = storage.reserveGB(storedGB, now, 'swap-in-read', 1, 1);
    storageServiceMs += job.service;
    storageQueueMs += job.wait;
    readyAt = Math.max(readyAt, job.end);
    state.kvSwapCompressedOriginalGB -= compressedOriginal;
    state.kvCompressedOriginalGB += compressedOriginal;
    state.swapStoredGB = Math.max(0, state.swapStoredGB - storedGB);
    swapInGB += storedGB;
  }

  const compressedTouch = state.kvCompressedOriginalGB * f;
  if (compressedTouch > EPS) {
    compressionTrafficGB = compressedTouch * (1 + 1 / c.mem.compressionRatio);
    compressionCpuMs = compressedTouch / c.mem.compressionBW * 1000;
  }

  state.totalSwapInGB += swapInGB;
  state.totalCompressionTrafficGB += compressionTrafficGB;
  return { readyAt, swapInGB, compressionTrafficGB, compressionCpuMs, storageServiceMs, storageQueueMs };
}

function applyPressureColibri(c, state, V, D, P, unitGB, token) {
  const out = { pageReclaimGB: 0, expertReclaimGB: 0, swapOutGB: 0, compressionTrafficGB: 0, compressionCpuMs: 0, state: 'NORMAL', oom: false };
  const soft = thresholdGB(c, c.mem.soft);
  const compress = thresholdGB(c, c.mem.compress);
  const swap = thresholdGB(c, c.mem.swap);
  const hard = thresholdGB(c, c.mem.hard);
  let dyn = colibriDynamic(c, state, V, D, P, unitGB);

  if (c.mem.policy === 'strict') {
    if (dyn.physicalGB > hard + EPS) {
      out.state = 'OOM';
      out.oom = true;
      state.oom = true;
    }
    return { ...out, dyn };
  }

  if (dyn.physicalGB > soft + EPS) {
    const needEntries = Math.ceil((dyn.physicalGB - soft) / unitGB);
    const removed = evictEntries(P, needEntries);
    out.pageReclaimGB += removed * unitGB;
    state.totalPageReclaimedGB += removed * unitGB;
    dyn = colibriDynamic(c, state, V, D, P, unitGB);
    if (removed) out.state = 'RECLAIM';
  }

  if (dyn.physicalGB > soft + EPS && c.expertBacking === 'file') {
    const currentD = totalEntries(D);
    const minEntries = Math.floor(c.minDCache / unitGB);
    const removable = Math.max(0, currentD - minEntries);
    const needed = Math.min(removable, Math.ceil((dyn.physicalGB - soft) / unitGB));
    if (needed > 0) {
      const removed = evictEntries(D, needed);
      out.expertReclaimGB += removed * unitGB;
      state.totalExpertReclaimedGB += removed * unitGB;
      dyn = colibriDynamic(c, state, V, D, P, unitGB);
      if (removed) out.state = 'RECLAIM';
    }
  }

  if (c.mem.policy === 'swap' && c.mem.compressionEnabled && dyn.physicalGB > compress + EPS && c.mem.compressionRatio > 1) {
    const excess = dyn.physicalGB - compress;
    const savingPerOriginal = 1 - 1 / c.mem.compressionRatio;
    const originalToCompress = Math.min(state.kvUncompressedGB, excess / Math.max(EPS, savingPerOriginal));
    if (originalToCompress > EPS) {
      state.kvUncompressedGB -= originalToCompress;
      state.kvCompressedOriginalGB += originalToCompress;
      out.compressionTrafficGB += originalToCompress * (1 + 1 / c.mem.compressionRatio);
      out.compressionCpuMs += originalToCompress / c.mem.compressionBW * 1000;
      state.totalCompressionTrafficGB += out.compressionTrafficGB;
      dyn = colibriDynamic(c, state, V, D, P, unitGB);
      out.state = 'COMPRESS';
    }
  }

  if (c.mem.policy === 'swap' && c.mem.swapEnabled && dyn.physicalGB > swap + EPS) {
    let excess = dyn.physicalGB - swap;
    let remainingCapacity = Math.max(0, c.mem.swapCapacityGB - state.swapStoredGB);

    if (c.expertBacking === 'anonymous' && excess > EPS && remainingCapacity > EPS) {
      const currentD = totalEntries(D);
      const minEntries = Math.floor(c.minDCache / unitGB);
      const removable = Math.max(0, currentD - minEntries);
      const needed = Math.min(removable, Math.ceil(excess / unitGB), Math.floor(remainingCapacity / unitGB));
      if (needed > 0) {
        const removed = evictEntries(D, needed, (l, e) => {
          const k = `${l}:${e}`;
          if (!state.swappedExperts.has(k)) {
            state.swappedExperts.add(k);
            state.swapExpertGB += unitGB;
            state.swapStoredGB += unitGB;
          }
        });
        const gb = removed * unitGB;
        out.expertReclaimGB += gb;
        state.totalExpertReclaimedGB += gb;
        out.swapOutGB += gb;
        excess = Math.max(0, excess - gb);
        remainingCapacity = Math.max(0, remainingCapacity - gb);
      }
    }

    const raw = Math.min(excess, state.kvUncompressedGB, remainingCapacity);
    if (raw > EPS) {
      state.kvUncompressedGB -= raw;
      state.kvSwapRawOriginalGB += raw;
      state.swapStoredGB += raw;
      out.swapOutGB += raw;
      excess -= raw;
      remainingCapacity -= raw;
    }

    if (excess > EPS && state.kvCompressedOriginalGB > EPS && remainingCapacity > EPS) {
      const original = Math.min(state.kvCompressedOriginalGB, excess * c.mem.compressionRatio, remainingCapacity * c.mem.compressionRatio);
      const stored = original / c.mem.compressionRatio;
      state.kvCompressedOriginalGB -= original;
      state.kvSwapCompressedOriginalGB += original;
      state.swapStoredGB += stored;
      out.swapOutGB += stored;
    }
    dyn = colibriDynamic(c, state, V, D, P, unitGB);
    if (out.swapOutGB > EPS) out.state = 'SWAP';
  }

  if (out.swapOutGB > EPS && state.swapStartToken === null) state.swapStartToken = token;
  state.totalSwapOutGB += out.swapOutGB;

  if (dyn.physicalGB > hard + EPS) {
    out.state = 'OOM';
    out.oom = true;
    state.oom = true;
  } else if (state.totalSwapOutGB > EPS && state.totalSwapInGB / state.totalSwapOutGB > 0.5 && out.swapOutGB > EPS) {
    out.state = 'THRASH';
  }
  return { ...out, dyn };
}

function applyPressureAFM(c, d, state, token) {
  const out = { pageReclaimGB: 0, expertReclaimGB: 0, swapOutGB: 0, compressionTrafficGB: 0, compressionCpuMs: 0, state: 'NORMAL', oom: false };
  const compress = thresholdGB(c, c.mem.compress);
  const swap = thresholdGB(c, c.mem.swap);
  const hard = thresholdGB(c, c.mem.hard);
  let dyn = afmDynamic(c, d, state);

  if (c.mem.policy === 'strict') {
    if (dyn.physicalGB > hard + EPS) {
      out.state = 'OOM';
      out.oom = true;
      state.oom = true;
    }
    return { ...out, dyn };
  }

  if (c.mem.policy === 'swap' && c.mem.compressionEnabled && dyn.physicalGB > compress + EPS && c.mem.compressionRatio > 1) {
    const excess = dyn.physicalGB - compress;
    const savingPerOriginal = 1 - 1 / c.mem.compressionRatio;
    const original = Math.min(state.kvUncompressedGB, excess / Math.max(EPS, savingPerOriginal));
    if (original > EPS) {
      state.kvUncompressedGB -= original;
      state.kvCompressedOriginalGB += original;
      out.compressionTrafficGB += original * (1 + 1 / c.mem.compressionRatio);
      out.compressionCpuMs += original / c.mem.compressionBW * 1000;
      state.totalCompressionTrafficGB += out.compressionTrafficGB;
      dyn = afmDynamic(c, d, state);
      out.state = 'COMPRESS';
    }
  }

  if (c.mem.policy === 'swap' && c.mem.swapEnabled && dyn.physicalGB > swap + EPS) {
    let excess = dyn.physicalGB - swap;
    let remainingCapacity = Math.max(0, c.mem.swapCapacityGB - state.swapStoredGB);
    const raw = Math.min(excess, state.kvUncompressedGB, remainingCapacity);
    if (raw > EPS) {
      state.kvUncompressedGB -= raw;
      state.kvSwapRawOriginalGB += raw;
      state.swapStoredGB += raw;
      out.swapOutGB += raw;
      excess -= raw;
      remainingCapacity -= raw;
    }
    if (excess > EPS && state.kvCompressedOriginalGB > EPS && remainingCapacity > EPS) {
      const original = Math.min(state.kvCompressedOriginalGB, excess * c.mem.compressionRatio, remainingCapacity * c.mem.compressionRatio);
      const stored = original / c.mem.compressionRatio;
      state.kvCompressedOriginalGB -= original;
      state.kvSwapCompressedOriginalGB += original;
      state.swapStoredGB += stored;
      out.swapOutGB += stored;
    }
    dyn = afmDynamic(c, d, state);
    if (out.swapOutGB > EPS) out.state = 'SWAP';
  }

  if (out.swapOutGB > EPS && state.swapStartToken === null) state.swapStartToken = token;
  state.totalSwapOutGB += out.swapOutGB;
  if (dyn.physicalGB > hard + EPS) {
    out.state = 'OOM';
    out.oom = true;
    state.oom = true;
  } else if (state.totalSwapOutGB > EPS && state.totalSwapInGB / state.totalSwapOutGB > 0.5 && out.swapOutGB > EPS) {
    out.state = 'THRASH';
  }
  return { ...out, dyn };
}

function memorySnapshot(c, state, dyn, pressure, token, extra = {}) {
  const swapGB = swapResidentGB(state, c);
  const freeGB = Math.max(0, c.host - dyn.physicalGB);
  state.peakPhysicalGB = Math.max(state.peakPhysicalGB, dyn.physicalGB);
  state.minFreeGB = Math.min(state.minFreeGB, freeGB);
  state.peakSwapGB = Math.max(state.peakSwapGB, swapGB);
  state.peakDeviceGB = Math.max(state.peakDeviceGB, dyn.deviceGB);
  state.lastState = pressure.state;
  return {
    token,
    physicalUsedGB: dyn.physicalGB,
    deviceUsedGB: dyn.deviceGB,
    expertCacheGB: dyn.expertGB,
    pageCacheGB: dyn.pageGB,
    kvResidentGB: dyn.kvGB,
    compressedOriginalGB: state.kvCompressedOriginalGB,
    swapGB,
    freeGB,
    pressureState: pressure.state,
    swapInGB: extra.swapInGB || 0,
    swapOutGB: pressure.swapOutGB || 0,
    pendingSwapOutGB: state.pendingSwapOutGB,
    pageReclaimGB: pressure.pageReclaimGB || 0,
    expertReclaimGB: pressure.expertReclaimGB || 0,
    compressionTrafficGB: (extra.compressionTrafficGB || 0) + (pressure.compressionTrafficGB || 0),
    ...extra
  };
}
