const BOTTLENECK_ADVISOR_VERSION = 'bottleneck-advisor/v1';
const BOTTLENECK_PHASES = Object.freeze([
  ['prefill', 'Prefill'],
  ['first-token', 'First token'],
  ['decode', 'Decode'],
  ['memory-pressure', 'Memory pressure']
]);
const BOTTLENECK_RESOURCES = Object.freeze([
  ['storage', 'Storage'],
  ['data-movement', 'Data movement'],
  ['compute', 'Compute'],
  ['capacity-policy', 'Capacity / policy']
]);

function advisorFinite(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function advisorRound(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(advisorFinite(value) * scale) / scale;
}

function advisorScore(numerator, denominator) {
  if (!(denominator > 0)) return 0;
  return Math.round(Math.max(0, Math.min(1, advisorFinite(numerator) / denominator)) * 100);
}

function advisorEvidence(label, value, unit, note = '') {
  return { label, value: advisorRound(value), unit, note };
}

function advisorPressureSeverity(state) {
  const levels = { NORMAL: 0, RECLAIM: 0.4, COMPRESS: 0.65, SWAP: 0.85, THRASH: 0.95, OOM: 1 };
  return levels[String(state || 'NORMAL').toUpperCase()] || 0;
}

function advisorCapacityScore(snapshot, c, forcedOom = false) {
  if (forcedOom) return 100;
  const utilization = advisorFinite(snapshot?.physicalUsedGB) / Math.max(1e-9, advisorFinite(c?.host, 1));
  return Math.round(Math.max(0, Math.min(1, Math.max(utilization, advisorPressureSeverity(snapshot?.pressureState)))) * 100);
}

function advisorStorageServiceMs(token, c) {
  if (Number.isFinite(token?.storageServiceMs)) return Math.max(0, token.storageServiceMs);
  const gb = advisorFinite(token?.ssdGB);
  const requests = Math.max(0, Math.trunc(advisorFinite(token?.storageRequests)));
  if (!(gb > 0) && !requests) return 0;
  const qd = Math.max(1, Math.trunc(advisorFinite(c?.qd, 1)));
  return gb / Math.max(0.01, advisorFinite(c?.ssdBW, 0.01)) * 1000 + Math.ceil(Math.max(1, requests) / qd) * advisorFinite(c?.lat) / 1000;
}

function advisorPcieServiceMs(token, c) {
  if (c?.arch !== 'discrete') return 0;
  return advisorFinite(token?.pcieGB) / Math.max(0.01, Math.min(advisorFinite(c?.pcieBW, 0.01), advisorFinite(c?.dramBW, 0.01))) * 1000;
}

function advisorAverage(tokens, read) {
  if (!tokens.length) return 0;
  return tokens.reduce((sum, token) => sum + advisorFinite(read(token)), 0) / tokens.length;
}

function advisorPhaseResource(serving, resourceName, phase) {
  return serving?.resources?.[resourceName]?.phases?.[phase] || null;
}

function advisorQueueFraction(serving, resourceName, phase) {
  const resource = advisorPhaseResource(serving, resourceName, phase);
  const queueMs = advisorFinite(resource?.queueMs);
  const busyMs = advisorFinite(resource?.busyMs);
  return queueMs / Math.max(1e-9, queueMs + busyMs);
}

function advisorRecommendation(resourceId, score, mode, urgent = false) {
  const priority = urgent ? 'Urgent' : score >= 35 ? 'Consider' : 'Monitor';
  const afm = mode === 'afm3';
  const recommendations = {
    storage: {
      controls: afm ? 'ssdBW, lat, afmOverlap, afmFreq' : 'ssdBW, lat, qd, dcache, page, pinned, prefetch controls',
      direction: afm ? 'ssdBW ↑; lat ↓; overlap/frequency를 조정해 window read ↓' : 'ssdBW/qd/cache 용량 ↑; lat/Expert miss/낭비된 prefetch ↓',
      condition: '스토리지 서비스 요구량 또는 모델링된 큐 지연이 이 단계에서 유의미한 비중을 차지합니다.',
      tradeoff: '높은 queue depth는 경합과 tail latency를 늘릴 수 있고, 큰 cache는 메모리를 사용합니다. 유효 SSD 대역폭에는 장치 보정이 필요합니다.'
    },
    'data-movement': {
      controls: afm ? 'dramBW, afmPatchBW, afmDoubleBuffer, afmChunkMode' : 'pcieBW, dramBW, vcache, pinned, placement',
      direction: afm ? 'dramBW/patchBW ↑; 검증된 pipelining과 double buffer 고려' : 'pcieBW/dramBW/VRAM 상주량 ↑; Host→Device 전송 ↓',
      condition: 'PCIe 전송 요구량 또는 노출된 DRAM 지연이 이 단계에서 유의미합니다.',
      tradeoff: '상주량 증가는 VRAM/RAM을 사용하고 pipelining에는 buffer 용량이 필요합니다. 설정 대역폭은 실측 service curve가 아닙니다.'
    },
    compute: {
      controls: afm ? 'afmAttn, afmFFN, afmRuntime, afmPrefillTPS' : 'attn, ems, par, prefillSpeedup',
      direction: afm ? '모델링된 연산 비용 ↓ 또는 보정된 prefillTPS ↑' : '모델링된 Attention/Expert 비용 ↓; 가능한 병렬성/prefill 가속 ↑',
      condition: '모델링된 연산 요구량이 단계 경과시간에서 유의미한 비중을 차지합니다.',
      tradeoff: 'Kernel 실행 가능성, 수치 품질, batch 효과, 실제 accelerator 점유율은 이 시뮬레이터의 범위 밖입니다.'
    },
    'capacity-policy': {
      controls: afm ? 'host, context, conc, memPolicy, compression/swap controls, afmDoubleBuffer' : 'host, vram, context, conc, placement/cache budgets, compression/swap controls',
      direction: '사용 가능 용량/상주량 ↑ 또는 context/concurrency/cache 압력 ↓; reclaim/compression/swap 정책 검토',
      condition: urgent ? '합성 실행이 OOM에 도달했으므로 완료된 토큰의 근거만 유효합니다.' : '메모리 사용률 또는 모델링된 압력 상태의 심각도가 높습니다.',
      tradeoff: '용량 증가는 비용을 바꾸고, compression은 연산을 사용하며, swap은 SSD 쓰기와 지연을 늘립니다. workload 축소는 시나리오 자체를 바꿉니다.'
    }
  };
  return { priority, ...recommendations[resourceId] };
}

function advisorResource(id, score, formula, evidence, mode, urgent = false) {
  const label = BOTTLENECK_RESOURCES.find(entry => entry[0] === id)?.[1] || id;
  return { id, label, score, formula, evidence, recommendation: advisorRecommendation(id, score, mode, urgent) };
}

function advisorTimedResources(tokens, c, phaseElapsedMs, mode, capacitySnapshot, note, phase, serving = null) {
  const elapsed = Math.max(1e-9, advisorFinite(phaseElapsedMs));
  const storageMs = advisorAverage(tokens, token => advisorStorageServiceMs(token, c));
  const exactStorageQueueMs = advisorAverage(tokens, token => token?.storageQueueMs);
  const swapServiceMs = advisorAverage(tokens, token => token?.swapServiceMs);
  const swapGB = advisorAverage(tokens, token => advisorFinite(token?.swapInGB) + advisorFinite(token?.swapOutGB));
  const pcieMs = advisorAverage(tokens, token => advisorPcieServiceMs(token, c));
  const patchMs = advisorAverage(tokens, token => token?.patchMs);
  const dramStallMs = advisorAverage(tokens, token => token?.memory?.dramStallMs);
  const computeMs = advisorAverage(tokens, token => token?.computeOnlyMs ?? token?.computeMs);
  const storageQueue = advisorQueueFraction(serving, 'ssd', phase);
  const movementQueue = Math.max(advisorQueueFraction(serving, 'pcie', phase), advisorQueueFraction(serving, 'dram', phase), advisorQueueFraction(serving, 'patch', phase));
  const computeQueue = advisorQueueFraction(serving, 'compute', phase);
  const storagePhase = advisorPhaseResource(serving, 'ssd', phase);
  const computePhase = advisorPhaseResource(serving, 'compute', phase);
  const demandGB = advisorAverage(tokens, token => token?.demandGB ?? token?.ssdGB);
  const prefetchGB = advisorAverage(tokens, token => token?.prefetchGB);
  const hitRate = advisorAverage(tokens, token => token?.hit);
  const cacheHitEvidence = tokens.some(token => Number.isFinite(token?.hit))
    ? advisorEvidence('Average cache hit', hitRate * 100, '%')
    : advisorEvidence('Cache-hit metric available', 0, 'boolean', 'Unavailable for this execution engine; no hit rate is invented.');
  const capacity = advisorCapacityScore(capacitySnapshot, c);
  return [
    advisorResource('storage', Math.max(advisorScore(storageMs, elapsed), advisorScore(exactStorageQueueMs, elapsed), Math.round(storageQueue * 100)), 'round(clamp(max(avg exact StorageResource service, avg exact StorageResource queue) ÷ phase elapsed, shared phase queue fraction) × 100))', [advisorEvidence('Average Expert/window storage reads', demandGB, 'GB'), advisorEvidence('Average prefetch reads', prefetchGB, 'GB'), advisorEvidence('Average swap read/write', swapGB, 'GB'), cacheHitEvidence, advisorEvidence('Average exact storage service', storageMs, 'ms'), advisorEvidence('Average exact storage queue', exactStorageQueueMs, 'ms'), advisorEvidence('Average swap read/write service', swapServiceMs, 'ms'), advisorEvidence('Shared SSD queue', storagePhase?.queueMs, 'ms', serving ? `${phase} event-scheduler contention only.` : 'No concurrent serving queue.'), advisorEvidence('Phase elapsed', elapsed, 'ms', note)], mode),
    advisorResource('data-movement', Math.max(advisorScore(Math.max(pcieMs, dramStallMs, patchMs), elapsed), Math.round(movementQueue * 100)), 'round(clamp(max(PCIe service, AFM patch materialization, exposed DRAM stall, shared phase queue fraction) × 100))', [advisorEvidence('Average PCIe service demand', pcieMs, 'ms'), advisorEvidence('Average AFM patch materialization', patchMs, 'ms'), advisorEvidence('Average exposed DRAM stall', dramStallMs, 'ms'), advisorEvidence('Shared PCIe/DRAM/patch queue fraction', movementQueue * 100, '%'), advisorEvidence('Phase elapsed', elapsed, 'ms')], mode),
    advisorResource('compute', Math.max(advisorScore(computeMs, elapsed), Math.round(computeQueue * 100)), 'round(clamp(max(avg modeled compute demand ÷ phase elapsed, shared phase compute queue ÷ (queue + busy)) × 100))', [advisorEvidence('Average compute demand', computeMs, 'ms'), advisorEvidence('Shared compute queue', computePhase?.queueMs, 'ms', serving ? `${phase} event-scheduler contention only.` : 'No concurrent serving queue.'), advisorEvidence('Phase elapsed', elapsed, 'ms')], mode),
    advisorResource('capacity-policy', capacity, 'round(clamp(max(memory utilization, modeled pressure-state severity) × 100))', [advisorEvidence('Physical memory used', capacitySnapshot?.physicalUsedGB, 'GB'), advisorEvidence('Host / unified capacity', c?.host, 'GB'), advisorEvidence('Pressure-state severity', advisorPressureSeverity(capacitySnapshot?.pressureState) * 100, '%', note)], mode)
  ];
}

function advisorPrefillResources(r) {
  const c = r.c || {};
  const firstMemory = r.tokens?.[0]?.memory || {};
  const storageQueue = advisorQueueFraction(r.serving, 'ssd', 'prefill');
  const movementQueue = Math.max(advisorQueueFraction(r.serving, 'pcie', 'prefill'), advisorQueueFraction(r.serving, 'dram', 'prefill'), advisorQueueFraction(r.serving, 'patch', 'prefill'));
  const computeQueue = advisorQueueFraction(r.serving, 'compute', 'prefill');
  const storagePhase = advisorPhaseResource(r.serving, 'ssd', 'prefill');
  if (r.mode === 'afm3') {
    const initialReadGB = advisorFinite(r.d?.routedGB);
    const storageMs = initialReadGB > 0 ? initialReadGB / Math.max(0.01, advisorFinite(c.ssdBW, 0.01)) * 1000 + Math.ceil(Math.max(1, advisorFinite(c.chunks, 1)) / Math.max(1, advisorFinite(c.qd, 1))) * advisorFinite(c.lat) / 1000 : 0;
    const patchMs = initialReadGB > 0 ? advisorFinite(c.patchBase) + initialReadGB / Math.max(0.01, advisorFinite(c.patchBW, 0.01)) * 1000 : 0;
    const computeMs = advisorFinite(r.prefill) + advisorFinite(c.initSel) + advisorFinite(r.initialCompressionCpuMs);
    const elapsed = Math.max(1e-9, storageMs + patchMs + computeMs);
    const capacity = advisorCapacityScore(firstMemory, c);
    return [
      advisorResource('storage', Math.max(advisorScore(storageMs, elapsed), Math.round(storageQueue * 100)), 'round(clamp(max(initial window-read service ÷ modeled prefill path, shared prefill queue fraction) × 100))', [advisorEvidence('Initial window read', storageMs, 'ms'), advisorEvidence('Shared SSD queue', storagePhase?.queueMs, 'ms', 'Prefill event-scheduler contention only.'), advisorEvidence('Modeled prefill path', elapsed, 'ms')], r.mode),
      advisorResource('data-movement', Math.max(advisorScore(patchMs, elapsed), Math.round(movementQueue * 100)), 'round(clamp(max(initial patch-transfer ÷ modeled prefill path, shared prefill data-movement queue fraction) × 100))', [advisorEvidence('Initial patch transfer', patchMs, 'ms'), advisorEvidence('Shared PCIe/DRAM/patch queue fraction', movementQueue * 100, '%'), advisorEvidence('Modeled prefill path', elapsed, 'ms')], r.mode),
      advisorResource('compute', Math.max(advisorScore(computeMs, elapsed), Math.round(computeQueue * 100)), 'round(clamp(max(selector + prompt compute ÷ modeled prefill path, shared prefill compute queue fraction) × 100))', [advisorEvidence('Selector + prompt compute', computeMs, 'ms'), advisorEvidence('Shared compute queue fraction', computeQueue * 100, '%'), advisorEvidence('Modeled prefill path', elapsed, 'ms')], r.mode),
      advisorResource('capacity-policy', capacity, 'round(clamp(max(first-token memory utilization, modeled pressure-state severity) × 100))', [advisorEvidence('First-token physical memory proxy', firstMemory.physicalUsedGB, 'GB', 'No separate prefill memory trace is exposed.'), advisorEvidence('Host / unified capacity', c.host, 'GB')], r.mode)
    ];
  }
  const b = r.prefillBreakdown || {};
  const elapsed = Math.max(1e-9, advisorFinite(r.prefill));
  const movementMs = Math.max(advisorFinite(b.transferMs), advisorFinite(b.dramMs));
  const capacity = advisorCapacityScore(firstMemory, c);
  return [
    advisorResource('storage', Math.max(advisorScore(b.storageMs, elapsed), Math.round(storageQueue * 100)), 'round(clamp(max(prefill storage ms ÷ prefill elapsed ms, shared prefill queue fraction) × 100))', [advisorEvidence('Prefill storage', b.storageMs, 'ms'), advisorEvidence('Shared SSD queue', storagePhase?.queueMs, 'ms', 'Prefill event-scheduler contention only.'), advisorEvidence('Prefill elapsed', elapsed, 'ms')], r.mode),
    advisorResource('data-movement', Math.max(advisorScore(movementMs, elapsed), Math.round(movementQueue * 100)), 'round(clamp(max(prefill PCIe/DRAM ms ÷ prefill elapsed ms, shared prefill data-movement queue fraction) × 100))', [advisorEvidence('Prefill PCIe transfer', b.transferMs, 'ms'), advisorEvidence('Prefill DRAM', b.dramMs, 'ms'), advisorEvidence('Shared PCIe/DRAM queue fraction', movementQueue * 100, '%'), advisorEvidence('Prefill elapsed', elapsed, 'ms')], r.mode),
    advisorResource('compute', Math.max(advisorScore(b.computeMs, elapsed), Math.round(computeQueue * 100)), 'round(clamp(max(prefill compute ms ÷ prefill elapsed ms, shared prefill compute queue fraction) × 100))', [advisorEvidence('Prefill compute', b.computeMs, 'ms'), advisorEvidence('Shared compute queue fraction', computeQueue * 100, '%'), advisorEvidence('Prefill elapsed', elapsed, 'ms')], r.mode),
    advisorResource('capacity-policy', capacity, 'round(clamp(max(first-token memory utilization, modeled pressure-state severity) × 100))', [advisorEvidence('First-token physical memory proxy', firstMemory.physicalUsedGB, 'GB', 'No separate prefill memory trace is exposed.'), advisorEvidence('Host / unified capacity', c.host, 'GB')], r.mode)
  ];
}

function advisorMemoryResources(r) {
  const c = r.c || {};
  const state = r.state || {};
  const tokens = r.tokens || [];
  const runElapsed = Math.max(1e-9, advisorFinite(r.ttft) + tokens.slice(1).reduce((sum, token) => sum + advisorFinite(token.tpot), 0));
  const initialSwapServiceMs = advisorFinite(r.initialSwapServiceMs);
  const tokenSwapServiceMs = tokens.reduce((sum, token) => sum + advisorFinite(token.swapServiceMs), 0);
  const storageMs = initialSwapServiceMs + tokenSwapServiceMs;
  const compressionCpuMs = advisorFinite(r.initialCompressionCpuMs) + tokens.reduce((sum, token) => sum + advisorFinite(token.memoryCpuMs), 0);
  const dramUtilization = advisorFinite(state.peakDramGBs) / Math.max(0.01, advisorFinite(c.dramBW, 0.01));
  const thrashRatio = advisorFinite(state.totalSwapOutGB) > 0 ? Math.min(1, advisorFinite(state.totalSwapInGB) / state.totalSwapOutGB) : 0;
  const forcedOom = Boolean(r.oom || state.oom);
  const peakUtilization = advisorFinite(state.peakPhysicalGB) / Math.max(1e-9, advisorFinite(c.host, 1));
  const capacityScore = forcedOom ? 100 : Math.round(Math.min(1, Math.max(peakUtilization, advisorPressureSeverity(state.lastState), thrashRatio)) * 100);
  return [
    advisorResource('storage', advisorScore(storageMs, runElapsed), 'round(clamp((exact initial pre-decode + token-phase swap service) ÷ total completed run elapsed × 100))', [advisorEvidence('Initial pre-decode swap service', initialSwapServiceMs, 'ms'), advisorEvidence('Token-phase swap service', tokenSwapServiceMs, 'ms'), advisorEvidence('Total completed run elapsed', runElapsed, 'ms')], r.mode),
    advisorResource('data-movement', Math.round(Math.min(1, dramUtilization) * 100), 'round(clamp(peak modeled DRAM GB/s ÷ configured DRAM GB/s × 100))', [advisorEvidence('Peak modeled DRAM', state.peakDramGBs, 'GB/s'), advisorEvidence('Configured DRAM', c.dramBW, 'GB/s')], r.mode),
    advisorResource('compute', advisorScore(compressionCpuMs, runElapsed), 'round(clamp(exposed compression/decompression CPU ÷ completed run elapsed × 100))', [advisorEvidence('Exposed compression/decompression CPU', compressionCpuMs, 'ms')], r.mode),
    advisorResource('capacity-policy', capacityScore, 'round(clamp(max(peak memory utilization, pressure-state severity, swap thrash ratio) × 100))', [advisorEvidence('Peak memory utilization', peakUtilization * 100, '%'), advisorEvidence('Pressure-state severity', advisorPressureSeverity(state.lastState) * 100, '%'), advisorEvidence('Swap thrash ratio', thrashRatio * 100, '%')], r.mode, forcedOom)
  ];
}

function advisorUnavailableResources(mode, reason) {
  return BOTTLENECK_RESOURCES.map(([id]) => advisorResource(
    id,
    0,
    '0 because this phase has no completed token evidence',
    [advisorEvidence('Completed tokens in phase', 0, 'count', reason)],
    mode
  ));
}

function createBottleneckInsight(r) {
  const baseDisclaimer = 'Estimated sensitivity simulator / Unvalidated Alpha. Relative pressure from this simulator trace; not a measured hardware diagnosis or absolute TTFT/TPS prediction.';
  if (!r || r.error) {
    if (/OOM/i.test(String(r?.error || ''))) {
      return {
        version: BOTTLENECK_ADVISOR_VERSION,
        status: 'oom-before-decode',
        disclaimer: `${baseDisclaimer} OOM occurred before decode, so no timing score is available.`,
        reason: 'OOM before decode',
        phases: [{
          id: 'memory-pressure',
          label: 'Memory pressure',
          note: 'No token completed; only capacity recovery guidance is available.',
          resources: [advisorResource('capacity-policy', 100, '100 because the simulator reported OOM before any decode token completed', [advisorEvidence('Configured host / unified capacity', r?.c?.host, 'GB')], r?.mode || r?.c?.mode, true)]
        }]
      };
    }
    return {
      version: BOTTLENECK_ADVISOR_VERSION,
      status: 'unavailable',
      disclaimer: baseDisclaimer,
      reason: 'Unavailable: configuration validation failed.',
      phases: []
    };
  }
  const tokens = Array.isArray(r.tokens) ? r.tokens : [];
  if (!tokens.length) return createBottleneckInsight({ error: 'No token completed.' });
  const first = tokens[0];
  const decodeTokens = tokens.slice(1);
  const decodeNote = decodeTokens.length ? 'Tokens after the first.' : 'Unavailable: no tokens completed after the first token.';
  const forcedOom = Boolean(r.oom || r.state?.oom);
  return {
    version: BOTTLENECK_ADVISOR_VERSION,
    status: forcedOom ? 'oom' : 'complete',
    disclaimer: forcedOom ? `${baseDisclaimer} OOM occurred; only completed token evidence is valid.` : baseDisclaimer,
    phases: [
      { id: 'prefill', label: 'Prefill', note: 'Prompt path before decode.', resources: advisorPrefillResources(r) },
      { id: 'first-token', label: 'First token', note: 'First decode token after prefill.', resources: advisorTimedResources([first], r.c, first.tpot, r.mode, first.memory, 'First completed token.', 'first-token', r.serving) },
      { id: 'decode', label: 'Decode', note: decodeNote, resources: decodeTokens.length ? advisorTimedResources(decodeTokens, r.c, advisorAverage(decodeTokens, token => token.tpot), r.mode, decodeTokens[decodeTokens.length - 1].memory, decodeNote, 'decode', r.serving) : advisorUnavailableResources(r.mode, decodeNote) },
      { id: 'memory-pressure', label: 'Memory pressure', note: forcedOom ? 'OOM: metrics stop at the last completed token.' : 'Peak and cumulative pressure across completed tokens.', resources: advisorMemoryResources(r) }
    ]
  };
}

function validateBottleneckInsight(insight) {
  if (!insight || typeof insight !== 'object') return 'Insight snapshot is required.';
  if (insight.version !== BOTTLENECK_ADVISOR_VERSION) return 'Unsupported insight version.';
  if (!['complete', 'oom'].includes(insight.status)) return 'Persisted insight status must be complete or oom.';
  if (typeof insight.disclaimer !== 'string' || !insight.disclaimer) return 'Insight disclaimer is required.';
  if (!Array.isArray(insight.phases) || insight.phases.length !== BOTTLENECK_PHASES.length) return 'Insight must contain four phases.';
  for (let phaseIndex = 0; phaseIndex < BOTTLENECK_PHASES.length; phaseIndex++) {
    const phase = insight.phases[phaseIndex];
    if (phase?.id !== BOTTLENECK_PHASES[phaseIndex][0] || phase?.label !== BOTTLENECK_PHASES[phaseIndex][1]) return `Invalid insight phase at index ${phaseIndex}.`;
    if (typeof phase.note !== 'string' || !Array.isArray(phase.resources) || phase.resources.length !== BOTTLENECK_RESOURCES.length) return `Invalid insight phase structure: ${phase.id}.`;
    for (let resourceIndex = 0; resourceIndex < BOTTLENECK_RESOURCES.length; resourceIndex++) {
      const resource = phase.resources[resourceIndex];
      if (resource?.id !== BOTTLENECK_RESOURCES[resourceIndex][0] || resource?.label !== BOTTLENECK_RESOURCES[resourceIndex][1]) return `Invalid insight resource at ${phase.id}/${resourceIndex}.`;
      if (!Number.isInteger(resource.score) || resource.score < 0 || resource.score > 100) return `Invalid insight score: ${phase.id}/${resource.id}.`;
      if (typeof resource.formula !== 'string' || !resource.formula) return `Invalid insight formula: ${phase.id}/${resource.id}.`;
      if (!Array.isArray(resource.evidence) || !resource.evidence.length) return `Invalid insight evidence: ${phase.id}/${resource.id}.`;
      for (const item of resource.evidence) {
        if (!item || typeof item.label !== 'string' || !Number.isFinite(item.value) || item.value < 0 || typeof item.unit !== 'string' || typeof item.note !== 'string') return `Invalid insight evidence item: ${phase.id}/${resource.id}.`;
      }
      const recommendation = resource.recommendation;
      if (!recommendation || !['Monitor', 'Consider', 'Urgent'].includes(recommendation.priority)) return `Invalid insight recommendation priority: ${phase.id}/${resource.id}.`;
      for (const field of ['controls', 'direction', 'condition', 'tradeoff']) if (typeof recommendation[field] !== 'string' || !recommendation[field]) return `Invalid insight recommendation: ${phase.id}/${resource.id}/${field}.`;
    }
  }
  return null;
}

function bottleneckInsightsMatch(expected, actual) {
  return validateBottleneckInsight(expected) === null && validateBottleneckInsight(actual) === null && JSON.stringify(expected) === JSON.stringify(actual);
}
