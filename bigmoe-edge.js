'use strict';

function bigMoeMiBToGB(value) {
  return value * 1048576 / 1e9;
}

function bigMoeProjectionMiB(config) {
  return config.model.expertProjectionMiB.reduce((sum, value) => sum + value, 0);
}

function bigMoeAlignedProjectionMiB(config) {
  if (!config.runtime.odirect) return bigMoeProjectionMiB(config);
  return config.model.expertProjectionMiB.reduce(
    (sum, value) => sum + Math.ceil(value * 256) / 256,
    0
  );
}

function bigMoeRoutedExperts(config, layer) {
  const routed = [];
  for (let slot = 0; slot < config.model.active; slot++) {
    routed.push(((config.seed % config.model.experts) + (layer % config.model.experts) + slot) % config.model.experts);
  }
  return routed;
}

function bigMoeSerialToken(config, index, cache) {
  const projectionMiB = bigMoeProjectionMiB(config);
  const alignedProjectionMiB = bigMoeAlignedProjectionMiB(config);
  let requestedReadMiB = 0;
  let alignedReadMiB = 0;
  let projectionJobs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (let layer = 0; layer < config.model.layers; layer++) {
    for (const expert of bigMoeRoutedExperts(config, layer)) {
      const hit = cache ? cache.access(`${layer}:${expert}`, projectionMiB) : false;
      if (hit) {
        cacheHits++;
      } else {
        cacheMisses++;
        requestedReadMiB += projectionMiB;
        alignedReadMiB += alignedProjectionMiB;
        projectionJobs += config.model.expertProjectionMiB.length;
      }
    }
  }
  const expertVisits = config.model.layers * config.model.active;
  const storageBandwidthMs = bigMoeMiBToGB(alignedReadMiB) / config.ssdBW * 1000;
  const storageCommandMs = Math.ceil(projectionJobs / config.runtime.ioThreads) * config.lat / 1000;
  const threadScale = Math.pow(
    config.runtime.referenceThreads / config.runtime.threads,
    config.runtime.threadScalingExponent
  );
  const attentionMs = config.runtime.attentionMs * threadScale;
  const expertKernelMs = expertVisits * config.runtime.expertMs * threadScale;
  const expertDramMiB = expertVisits * projectionMiB;
  const expertDramMs = bigMoeMiBToGB(expertDramMiB) / config.dramBW * 1000;
  const expertPhaseMs = Math.max(expertKernelMs, expertDramMs);
  const managementMs = config.model.layers * config.runtime.managementMs;
  const loopOverheadMs = config.runtime.loopOverheadMs;
  const wallMs = storageBandwidthMs + storageCommandMs + attentionMs +
    expertPhaseMs + managementMs + loopOverheadMs;

  return {
    index,
    requestedReadMiB,
    alignedReadMiB,
    cacheHits,
    cacheMisses,
    timing: {
      storageBandwidthMs,
      storageCommandMs,
      threadScale,
      attentionMs,
      expertMs: expertPhaseMs,
      expertKernelMs,
      expertDramMiB,
      expertDramMs,
      expertPhaseMs,
      managementMs,
      loopOverheadMs,
      wallMs
    }
  };
}

function bigMoeContainsNonFiniteNumber(value) {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(bigMoeContainsNonFiniteNumber);
  return Object.values(value).some(bigMoeContainsNonFiniteNumber);
}

function simulateBigMoeEdge(config) {
  const validation = validateBigMoeEdgeConfig(config);
  if (!validation.valid) {
    return {
      error: validation.errors.map(error => `${error.path}: ${error.message}`).join('; '),
      errorCode: validation.errors[0].code,
      validationErrors: validation.errors
    };
  }

  const cacheGB = config.runtime.cacheMode === 'fixed' ? bigMoeMiBToGB(config.runtime.cacheMiB) : 0;
  const kvTokens = Math.max(config.context, config.prompt + config.output);
  const kvGB = config.model.kvKB * kvTokens / 1e6;
  const requiredGB = config.model.denseResidentGB + config.model.sharedExpertGB + cacheGB + kvGB +
    config.mem.backgroundGB + config.mem.osReservedGB + config.mem.minHeadroomGB;
  if (!Number.isFinite(requiredGB)) {
    return { error: 'BigMoEEdge memory arithmetic produced a non-finite value.', errorCode: 'NUMERIC_OVERFLOW', mode: 'bigmoe-edge', tokens: [] };
  }
  const memorySnapshot = {
    physicalUsedGB: requiredGB,
    expertCacheGB: cacheGB,
    pageCacheGB: 0,
    kvResidentGB: kvGB,
    compressedOriginalGB: 0,
    swapGB: 0,
    deviceUsedGB: 0,
    pressureState: 'Normal',
    dramStallMs: 0
  };
  if (requiredGB > config.host) {
    return {
      error: `Host OOM: ${requiredGB.toFixed(3)} GB required, ${config.host.toFixed(3)} GB available.`,
      errorCode: 'HOST_OOM',
      mode: 'bigmoe-edge',
      c: config,
      tokens: [],
      requiredHostGB: requiredGB,
      oom: { requiredGB, availableGB: config.host }
    };
  }

  const cache = config.runtime.cacheMode === 'fixed'
    ? new BigMoeByteLRU(config.runtime.cacheMiB)
    : null;
  const tokens = [];
  for (let index = 0; index < config.output; index++) {
    const token = bigMoeSerialToken(config, index, cache);
    const tokenAccesses = token.cacheHits + token.cacheMisses;
    token.tpot = token.timing.wallMs;
    token.ssdGB = bigMoeMiBToGB(token.alignedReadMiB);
    token.demandGB = token.ssdGB;
    token.prefetchGB = 0;
    token.hit = tokenAccesses > 0 ? token.cacheHits / tokenAccesses : 0;
    token.computeOnlyMs = token.timing.attentionMs + token.timing.expertKernelMs + token.timing.managementMs + token.timing.loopOverheadMs;
    token.storageQueueMs = 0;
    token.swapServiceMs = 0;
    token.swapInGB = 0;
    token.swapOutGB = 0;
    token.pcieGB = 0;
    token.gpuMs = 0;
    token.memory = {
      ...memorySnapshot,
      dramStallMs: Math.max(0, token.timing.expertDramMs - token.timing.expertKernelMs)
    };
    token.storageEvents = token.ssdGB > 0 ? [{
      kind: 'expert-demand-read',
      gb: token.ssdGB,
      service: token.timing.storageBandwidthMs + token.timing.storageCommandMs,
      wait: 0
    }] : [];
    tokens.push(token);
  }
  const totalDecodeMs = tokens.reduce((sum, token) => sum + token.timing.wallMs, 0);
  const totalHits = tokens.reduce((sum, token) => sum + token.cacheHits, 0);
  const totalMisses = tokens.reduce((sum, token) => sum + token.cacheMisses, 0);
  const avg = tokens.length ? totalDecodeMs / tokens.length : 0;
  const prefillMs = config.prompt > 0 ? config.prompt / config.runtime.prefillTPS * 1000 : 0;
  const decodeStorageGB = tokens.reduce((sum, token) => sum + token.ssdGB, 0);
  const averageStorageGB = tokens.length ? decodeStorageGB / tokens.length : 0;
  const storageServiceMs = tokens.reduce(
    (sum, token) => sum + token.timing.storageBandwidthMs + token.timing.storageCommandMs,
    0
  );
  const dramTrafficGB = tokens.reduce(
    (sum, token) => sum + bigMoeMiBToGB(token.timing.expertDramMiB),
    0
  );
  const totalDramStallMs = tokens.reduce((sum, token) => sum + token.memory.dramStallMs, 0);
  const peakDramGBs = tokens.reduce((peak, token) => {
    const seconds = token.timing.expertPhaseMs / 1000;
    const observed = seconds > 0 ? bigMoeMiBToGB(token.timing.expertDramMiB) / seconds : 0;
    return Math.max(peak, observed);
  }, 0);
  const hit = totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0;

  const result = {
    engine: 'BigMoEEdge',
    mode: 'bigmoe-edge',
    tokens,
    avg,
    tps: avg > 0 ? 1000 / avg : 0,
    agg: avg > 0 ? 1000 / avg : 0,
    ttft: prefillMs + (tokens[0] ? tokens[0].timing.wallMs : 0),
    prefill: prefillMs,
    prefillBreakdown: { computeMs: prefillMs, storageMs: 0, transferMs: 0, dramMs: 0, storageGB: 0, transferGB: 0 },
    prefillStorageEvents: [],
    cacheHitPct: hit * 100,
    hit,
    cacheEvictions: cache ? cache.evictions : 0,
    ev: cache ? cache.evictions : 0,
    requiredHostGB: requiredGB,
    ssdPt: averageStorageGB,
    decodeStorageGB,
    dramTrafficGB,
    startupStorageGB: 0,
    storageByKind: { 'expert-demand-read': decodeStorageGB },
    ssdBusy: storageServiceMs,
    ssdQueue: 0,
    observed: storageServiceMs > 0 ? decodeStorageGB / (storageServiceMs / 1000) : 0,
    state: {
      peakPhysicalGB: requiredGB,
      minFreeGB: config.host - requiredGB,
      peakSwapGB: 0,
      totalSwapInGB: 0,
      totalSwapOutGB: 0,
      totalPageReclaimedGB: 0,
      totalExpertReclaimedGB: 0,
      peakDramGBs,
      totalDramStallMs,
      lastState: 'Normal',
      swapStartToken: null,
      deviceKVGB: 0,
      deviceUsedGB: 0,
      oom: false
    },
    readMiBPerToken: tokens.length
      ? tokens.reduce((sum, token) => sum + token.requestedReadMiB, 0) / tokens.length
      : 0,
    resources: { cpuOnly: true, gpuMs: 0, pcieGB: 0, vramGB: 0 }
  };
  if (bigMoeContainsNonFiniteNumber(result)) {
    return { error: 'BigMoEEdge simulation produced non-finite numeric output.', errorCode: 'NUMERIC_OVERFLOW', mode: 'bigmoe-edge', tokens: [] };
  }
  return result;
}
