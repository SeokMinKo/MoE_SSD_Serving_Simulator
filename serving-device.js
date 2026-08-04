'use strict';

const DEVICE_SERVING_SCHEMA = 'device-serving/v1';

function deviceServingIsCalibratedColibri(config) {
  return config?.mode === 'colibri' && config?.compute?.mode === 'calibrated';
}

function deviceServingProfile(config) {
  return typeof deriveColibriDeviceProfile === 'function'
    ? deriveColibriDeviceProfile(config)
    : null;
}

function deviceServingTokenWork(token, profile) {
  const swapInGB = Math.max(0, token.memory?.swapInGB || 0);
  const swapOutGB = Math.max(0, token.memory?.swapOutGB || 0);
  const prefetchGB = Math.max(0, token.prefetchGB || 0);
  const demandGB = Math.max(0, token.demandGB ?? token.ssdGB ?? 0);
  const memoryCpuMs = Math.max(0, token.memoryCpuMs || 0);
  const breakdown = token.computeBreakdown || {};
  const attentionMs = Math.max(0, breakdown.attentionMs || 0);
  const cpuExpertMs = Math.max(0, breakdown.cpuExpertMs || 0);
  const gpuExpertMs = Math.max(0, breakdown.gpuExpertMs || 0);
  const exposedComputeMs = Math.max(0, breakdown.exposedComputeMs ?? token.computeOnlyMs ?? token.computeMs ?? token.tpot ?? 0);
  const exposedExpertMs = profile && typeof combineColibriDevicePhases === 'function'
    ? combineColibriDevicePhases(cpuExpertMs, gpuExpertMs, profile.execution, profile.overlapEfficiency)
    : cpuExpertMs + gpuExpertMs;
  const runtimeMs = Math.max(0, exposedComputeMs - attentionMs - exposedExpertMs);
  const attentionDevice = breakdown.attentionDevice || profile?.attentionDevice || 'gpu';
  const cpuComputeMs = cpuExpertMs + (attentionDevice === 'cpu' ? attentionMs + runtimeMs : 0);
  const gpuComputeMs = gpuExpertMs + (attentionDevice === 'gpu' ? attentionMs + runtimeMs : 0);
  return {
    demandGB,
    prefetchGB,
    swapInGB,
    swapOutGB,
    demandRequests: Math.max(0, token.demandRequests ?? (demandGB > EPS ? token.storageRequests || 1 : 0)),
    prefetchRequests: Math.max(0, token.prefetchRequests ?? (prefetchGB > EPS ? token.storageRequests || 1 : 0)),
    pcieGB: Math.max(0, token.pcieGB || 0),
    criticalDramGB: Math.max(0, (token.memory?.dramTrafficGB || 0) - prefetchGB - swapOutGB),
    memoryCpuMs,
    cpuComputeMs,
    gpuComputeMs,
    computeMs: exposedComputeMs,
    patchMs: Math.max(0, token.patchMs || 0)
  };
}

function deviceServingPrefillWork(trace, config, profile) {
  const breakdown = trace.prefillBreakdown || {};
  const layer = breakdown.computeBreakdown?.layer;
  if (!layer || !(config.prompt > 0)) {
    const computeMs = Math.max(0, breakdown.computeMs || 0);
    return {
      cpuComputeMs: profile?.attentionDevice === 'cpu' ? computeMs : 0,
      gpuComputeMs: profile?.attentionDevice === 'gpu' ? computeMs : 0
    };
  }
  const promptLayers = config.prompt * config.layers;
  const cpuPerLayer = Math.max(0, layer.cpuExpertMs || 0) +
    (profile.attentionDevice === 'cpu' ? Math.max(0, layer.attentionMs || 0) + Math.max(0, layer.runtimeMs || 0) : 0);
  const gpuPerLayer = Math.max(0, layer.gpuExpertMs || 0) +
    (profile.attentionDevice === 'gpu' ? Math.max(0, layer.attentionMs || 0) + Math.max(0, layer.runtimeMs || 0) : 0);
  return { cpuComputeMs: promptLayers * cpuPerLayer, gpuComputeMs: promptLayers * gpuPerLayer };
}

function deviceServingReserveCompute(resources, work, arrivalMs, phase, profile) {
  const cpuMs = Math.max(0, work.cpuComputeMs || 0);
  const gpuMs = Math.max(0, work.gpuComputeMs || 0);
  if (profile?.execution !== 'sequential' || !(cpuMs > EPS && gpuMs > EPS)) {
    const cpu = resources.cpuCompute.reserveMs(cpuMs, arrivalMs, phase);
    const gpu = resources.gpuCompute.reserveMs(gpuMs, arrivalMs, phase);
    return { cpu, gpu, end: Math.max(cpu.end, gpu.end), wait: Math.max(cpu.wait, gpu.wait) };
  }
  if (profile.attentionDevice === 'cpu') {
    const cpu = resources.cpuCompute.reserveMs(cpuMs, arrivalMs, phase);
    const gpu = resources.gpuCompute.reserveMs(gpuMs, cpu.end, phase);
    return { cpu, gpu, end: gpu.end, wait: cpu.wait + gpu.wait };
  }
  const gpu = resources.gpuCompute.reserveMs(gpuMs, arrivalMs, phase);
  const cpu = resources.cpuCompute.reserveMs(cpuMs, gpu.end, phase);
  return { cpu, gpu, end: cpu.end, wait: gpu.wait + cpu.wait };
}

function simulateDeviceServing(config, requestSpecs, options = {}) {
  const validation = validateSimulationConfig(config);
  if (!validation.valid) return { error: `Invalid configuration: ${formatConfigErrors(validation)}`, validationErrors: validation.errors };
  const requestError = validateServingRequests(config, requestSpecs, options);
  if (requestError) return { error: requestError };
  const profile = deviceServingProfile(config);
  const requests = requestSpecs.map((spec, index) => ({
    id: String(spec.id ?? index), arrivalMs: spec.arrivalMs ?? 0, output: spec.output ?? config.output,
    trace: null, traceIndex: index, nextToken: 0, completed: [], firstTokenAt: null, completionMs: null
  }));
  const isSingleRequest = requests.length === 1;
  const resources = {
    ssd: new SharedServingResource('ssd', config.ssdBW, config.lat / 1000, config.qd || 1),
    pcie: new SharedServingResource('pcie', Math.min(config.pcieBW || Infinity, config.dramBW), 0, 1),
    dram: new SharedServingResource('dram', config.dramBW, 0, 1),
    patch: new SharedServingResource('patch'),
    cpuCompute: new SharedServingResource('cpuCompute'),
    gpuCompute: new SharedServingResource('gpuCompute')
  };
  const queue = new EventQueue();
  const batchWindowMs = options.batchWindowMs ?? 2;
  const readyBatch = [];
  let dispatchScheduled = false;
  let sharedColibriCacheState = null;
  for (const request of requests) queue.push({ time: request.arrivalMs, type: 'arrival', request });

  while (queue.size) {
    const event = queue.pop();
    const request = event.request;
    if (event.type === 'arrival') {
      request.trace = traceForRequest(config, request, request.traceIndex, sharedColibriCacheState);
      if (request.trace.error) return { error: `Request ${request.id}: ${request.trace.error}` };
      const breakdown = request.trace.prefillBreakdown || {};
      const storage = resources.ssd.reserveGB(breakdown.storageGB || 0, event.time, breakdown.storageRequests || 1, 'prefill');
      const dram = resources.dram.reserveGB(breakdown.dramTrafficGB || 0, event.time, 1, 'prefill');
      const pcie = resources.pcie.reserveGB(breakdown.transferGB || 0, event.time, 1, 'prefill');
      const prefillWork = deviceServingPrefillWork(request.trace, config, profile);
      const compute = deviceServingReserveCompute(resources, prefillWork, event.time, 'prefill', profile);
      const prefillResourceReady = Math.max(storage.end, dram.end, pcie.end, compute.end);
      const compression = resources.cpuCompute.reserveMs(request.trace.initialCompressionCpuMs || 0, prefillResourceReady, 'prefill');
      const analyticPrefillMs = Math.max(0, request.trace.ttft - (request.trace.tokens[0]?.tpot || 0));
      const contentionWait = isSingleRequest ? 0 : Math.max(storage.wait, dram.wait, pcie.wait, compute.wait);
      const readyAt = Math.max(event.time + analyticPrefillMs + contentionWait, compression.end);
      resources.ssd.reserveGB(initialSwapOutGB(request.trace), readyAt, 1, 'prefill');
      queue.push({ time: readyAt, type: 'token-ready', request });
    } else if (event.type === 'token-ready') {
      const token = request.trace.tokens[request.nextToken];
      if (!token) continue;
      const phase = request.nextToken === 0 ? 'first-token' : 'decode';
      const work = deviceServingTokenWork(token, profile);
      const swapIn = resources.ssd.reserveGB(work.swapInGB, event.time, work.swapInGB > EPS ? 1 : 0, phase);
      const storage = resources.ssd.reserveGB(work.demandGB, swapIn.end, Math.max(1, work.demandRequests), phase);
      const dram = resources.dram.reserveGB(work.criticalDramGB, event.time, 1, phase);
      const pcie = resources.pcie.reserveGB(work.pcieGB, event.time, 1, phase);
      const contentionWait = isSingleRequest ? 0 : Math.max(swapIn.wait + storage.wait, dram.wait, pcie.wait);
      queue.push({
        time: event.time + contentionWait, type: 'data-ready', request, token, work, phase,
        baselineCompleteAt: event.time + token.tpot + contentionWait
      });
    } else if (event.type === 'data-ready') {
      readyBatch.push(event);
      if (!dispatchScheduled) {
        dispatchScheduled = true;
        queue.push({ time: event.time + batchWindowMs, type: 'batch-dispatch' });
      }
    } else if (event.type === 'batch-dispatch') {
      dispatchScheduled = false;
      const batch = readyBatch.splice(0, readyBatch.length);
      if (!batch.length) continue;
      const batchReady = Math.max(event.time, ...batch.map(item => item.time));
      let memoryCpuReady = batchReady;
      for (const item of batch) {
        const memoryCpu = resources.cpuCompute.reserveMs(item.work.memoryCpuMs, item.time, item.phase);
        memoryCpuReady = Math.max(memoryCpuReady, memoryCpu.end);
      }
      for (const item of batch) {
        const prefetch = resources.ssd.reserveGB(item.work.prefetchGB, item.time, Math.max(1, item.work.prefetchRequests), item.phase);
        resources.dram.reserveGB(item.work.prefetchGB, prefetch.end, 1, item.phase);
        const swapSource = resources.dram.reserveGB(item.work.swapOutGB, item.time, 1, item.phase);
        resources.ssd.reserveGB(item.work.swapOutGB, swapSource.end, 1, item.phase);
      }
      const batchFactor = 1 + 0.08 * Math.max(0, batch.length - 1);
      const maxPatch = Math.max(...batch.map(item => item.work.patchMs));
      const maxCpu = Math.max(...batch.map(item => item.work.cpuComputeMs));
      const maxGpu = Math.max(...batch.map(item => item.work.gpuComputeMs));
      const phases = new Set(batch.map(item => item.phase));
      const phase = phases.size === 1 ? batch[0].phase : 'mixed';
      const patch = resources.patch.reserveMs(maxPatch * batchFactor, memoryCpuReady, phase);
      const compute = deviceServingReserveCompute(resources, {
        cpuComputeMs: maxCpu * batchFactor,
        gpuComputeMs: maxGpu * batchFactor
      }, patch.end, phase, profile);
      const analyticService = Math.max(...batch.map(item => item.work.computeMs + item.work.patchMs));
      const scheduledService = maxPatch * batchFactor +
        (profile.execution === 'sequential' ? (maxCpu + maxGpu) * batchFactor : Math.max(maxCpu, maxGpu) * batchFactor);
      const batchOverhead = Math.max(0, scheduledService - analyticService);
      for (const item of batch) {
        const admissionDelay = batchReady - item.time;
        const memoryCpuContention = Math.max(0, memoryCpuReady - item.time - item.work.memoryCpuMs);
        const resourceWait = isSingleRequest ? 0 : memoryCpuContention + patch.wait + compute.wait;
        const completeAt = Math.max(
          item.baselineCompleteAt + admissionDelay + resourceWait + batchOverhead,
          memoryCpuReady, patch.end, compute.end
        );
        queue.push({ time: completeAt, type: 'complete', request: item.request, token: item.token, batchSize: batch.length });
      }
    } else if (event.type === 'complete') {
      request.completed.push({
        token: request.nextToken + 1,
        completedAt: event.time,
        tpotMs: event.time - (request.completionMs ?? request.arrivalMs),
        batchSize: event.batchSize
      });
      request.nextToken++;
      if (request.firstTokenAt === null) request.firstTokenAt = event.time;
      request.completionMs = event.time;
      if (request.nextToken < request.trace.tokens.length) queue.push({ time: event.time, type: 'token-ready', request });
      else sharedColibriCacheState = mergeColibriCacheState(sharedColibriCacheState, request.trace.cacheState, config);
    }
  }

  const completedTokens = requests.reduce((sum, request) => sum + request.completed.length, 0);
  const firstArrival = Math.min(...requests.map(request => request.arrivalMs));
  const finalCompletion = Math.max(...requests.map(request => request.completionMs ?? request.arrivalMs));
  const makespanMs = Math.max(0, finalCompletion - firstArrival);
  const decodeTokenLatencies = requests.flatMap(request => request.completed.slice(1).map(token => token.tpotMs));
  const requestResults = requests.map(request => ({
    id: request.id, arrivalMs: request.arrivalMs, output: request.output,
    completedTokens: request.completed.length,
    ttftMs: request.firstTokenAt === null ? null : request.firstTokenAt - request.arrivalMs,
    completionMs: request.completionMs,
    latencyMs: request.completionMs === null ? null : request.completionMs - request.arrivalMs,
    tokens: request.completed
  }));
  const ttftLatencies = requestResults.map(request => request.ttftMs).filter(Number.isFinite);
  const normalizedSpecs = requests.map(request => ({ id: request.id, arrivalMs: request.arrivalMs, output: request.output }));
  const resourceSnapshots = Object.fromEntries(Object.entries(resources).map(([name, resource]) => {
    const snapshot = resource.snapshot();
    return [name, { ...snapshot, utilization: makespanMs > EPS ? Math.min(1, snapshot.busyMs / makespanMs) : 0 }];
  }));
  return {
    modelStatus: 'Estimated · event-driven CPU/GPU shared-resource model',
    schedulerSchema: DEVICE_SERVING_SCHEMA,
    runId: servingRunId(config, normalizedSpecs), completedTokens, makespanMs,
    throughputTPS: makespanMs > EPS ? completedTokens / (makespanMs / 1000) : 0,
    p50TokenMs: percentile(decodeTokenLatencies, 0.5),
    p95TokenMs: percentile(decodeTokenLatencies, 0.95),
    p50TtftMs: percentile(ttftLatencies, 0.5),
    p95TtftMs: percentile(ttftLatencies, 0.95),
    requests: requestResults,
    resources: resourceSnapshots
  };
}

function installDeviceServingScheduler() {
  if (globalThis.__DEVICE_SERVING_INSTALLED__) return false;
  if (typeof simulateServing !== 'function') return false;
  const legacySimulateServing = simulateServing;
  simulateServing = function deviceAwareServing(config, requestSpecs, options = {}) {
    return deviceServingIsCalibratedColibri(config)
      ? simulateDeviceServing(config, requestSpecs, options)
      : legacySimulateServing(config, requestSpecs, options);
  };
  globalThis.__DEVICE_SERVING_INSTALLED__ = Object.freeze({ schema: DEVICE_SERVING_SCHEMA });
  return true;
}

function scheduleDeviceServingInstall() {
  if (typeof document !== 'object' || typeof document.addEventListener !== 'function') return false;
  const install = () => installDeviceServingScheduler();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else Promise.resolve().then(install);
  return true;
}

scheduleDeviceServingInstall();
