class EventQueue {
  constructor() {
    this.heap = [];
    this.sequence = 0;
  }
  get size() { return this.heap.length; }
  compare(a, b) { return a.time - b.time || a.sequence - b.sequence; }
  push(event) {
    const entry = { ...event, sequence: this.sequence++ };
    this.heap.push(entry);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[parent], entry) <= 0) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = entry;
    return entry;
  }
  peek() { return this.heap[0] || null; }
  pop() {
    if (!this.heap.length) return null;
    const first = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.heap.length) break;
        let child = left;
        if (right < this.heap.length && this.compare(this.heap[right], this.heap[left]) < 0) child = right;
        if (this.compare(last, this.heap[child]) <= 0) break;
        this.heap[index] = this.heap[child];
        index = child;
      }
      this.heap[index] = last;
    }
    return first;
  }
}

class SharedServingResource {
  constructor(name, bandwidthGBs = Infinity, latencyMs = 0, parallelism = 1) {
    this.name = name;
    this.bandwidthGBs = bandwidthGBs;
    this.latencyMs = latencyMs;
    this.parallelism = Math.max(1, parallelism | 0);
    this.freeAt = 0;
    this.busyMs = 0;
    this.queueMs = 0;
    this.workGB = 0;
    this.jobs = 0;
    this.phases = {};
  }
  recordPhase(phase, service, wait, gb = 0) {
    if (!phase) return;
    const stats = this.phases[phase] || { jobs: 0, workGB: 0, busyMs: 0, queueMs: 0 };
    stats.jobs++;
    stats.workGB += gb;
    stats.busyMs += service;
    stats.queueMs += wait;
    this.phases[phase] = stats;
  }
  reserveGB(gb, arrivalMs, requests = 1, phase = null) {
    if (!(gb > EPS)) return { start: arrivalMs, end: arrivalMs, wait: 0, service: 0, gb: 0 };
    const start = Math.max(arrivalMs, this.freeAt);
    const wait = start - arrivalMs;
    const transfer = gb / Math.max(EPS, this.bandwidthGBs) * 1000;
    const waves = Math.ceil(Math.max(1, requests) / this.parallelism);
    const service = transfer + waves * this.latencyMs;
    const end = start + service;
    this.freeAt = end;
    this.busyMs += service;
    this.queueMs += wait;
    this.workGB += gb;
    this.jobs++;
    this.recordPhase(phase, service, wait, gb);
    return { start, end, wait, service, gb };
  }
  reserveMs(durationMs, arrivalMs, phase = null) {
    if (!(durationMs > EPS)) return { start: arrivalMs, end: arrivalMs, wait: 0, service: 0 };
    const start = Math.max(arrivalMs, this.freeAt);
    const wait = start - arrivalMs;
    const end = start + durationMs;
    this.freeAt = end;
    this.busyMs += durationMs;
    this.queueMs += wait;
    this.jobs++;
    this.recordPhase(phase, durationMs, wait);
    return { start, end, wait, service: durationMs };
  }
  snapshot() {
    return { jobs: this.jobs, workGB: this.workGB, busyMs: this.busyMs, queueMs: this.queueMs, freeAt: this.freeAt, phases: this.phases };
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function servingRunId(config, requests) {
  const text = stableValue({ config, requests });
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sim-${hash.toString(16).padStart(8, '0')}`;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function traceForRequest(config, request, index) {
  const requestConfig = {
    ...config,
    conc: 1,
    output: request.output ?? config.output,
    seed: (config.seed || 0) + index * 104729,
    ...(config.mode === 'colibri' && config.placement === 'auto' ? { placement: 'manual' } : {})
  };
  return config.mode === 'afm3' ? simulateAFM(requestConfig) : simulateColibri(requestConfig);
}

function tokenWork(token) {
  const swapInGB = Math.max(0, token.memory?.swapInGB || 0);
  const swapOutGB = Math.max(0, token.memory?.swapOutGB || 0);
  const prefetchGB = Math.max(0, token.prefetchGB || 0);
  const demandGB = Math.max(0, token.demandGB ?? token.ssdGB ?? 0);
  return {
    demandGB,
    prefetchGB,
    swapInGB,
    swapOutGB,
    ssdRequests: Math.max(1, token.storageRequests || 1),
    pcieGB: Math.max(0, token.pcieGB || 0),
    criticalDramGB: Math.max(0, (token.memory?.dramTrafficGB || 0) - prefetchGB - swapOutGB),
    computeMs: Math.max(0, token.computeMs ?? token.tpot ?? 0),
    computeOnlyMs: Math.max(0, token.computeOnlyMs ?? token.computeMs ?? token.tpot ?? 0),
    patchMs: Math.max(0, token.patchMs || 0)
  };
}

function initialSwapOutGB(trace) {
  const tokenSwapOut = trace.tokens.reduce((sum, token) => sum + (token.memory?.swapOutGB || 0), 0);
  return Math.max(0, (trace.storageByKind?.['swap-out-write'] || 0) - tokenSwapOut);
}

function validateServingRequests(config, requestSpecs, options) {
  if (!Array.isArray(requestSpecs) || requestSpecs.length === 0) return 'At least one request is required.';
  if (requestSpecs.length > 64) return 'At most 64 requests are allowed.';
  if (!options || typeof options !== 'object') return 'Scheduler options must be an object.';
  const batchWindowMs = options.batchWindowMs ?? 2;
  if (!Number.isFinite(batchWindowMs) || batchWindowMs < 0 || batchWindowMs > 1000) return 'batchWindowMs must be finite and between 0 and 1000.';
  const ids = new Set();
  let totalOutput = 0;
  for (let index = 0; index < requestSpecs.length; index++) {
    const spec = requestSpecs[index];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return `Request ${index} must be an object.`;
    const id = String(spec.id ?? index);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return `Request ${index} id is invalid.`;
    if (ids.has(id)) return `Request id ${id} is duplicated.`;
    ids.add(id);
    const arrivalMs = spec.arrivalMs ?? 0;
    if (!Number.isFinite(arrivalMs) || arrivalMs < 0 || arrivalMs > 1_000_000_000) return `Request ${id} arrivalMs must be finite and nonnegative.`;
    const output = spec.output ?? config.output;
    if (!Number.isSafeInteger(output) || output < 1 || output > 1024) return `Request ${id} output must be a safe integer between 1 and 1024.`;
    totalOutput += output;
  }
  if (totalOutput > 65_536) return 'Total requested output exceeds the serving work budget.';
  return null;
}

function simulateServing(config, requestSpecs, options = {}) {
  const validation = validateSimulationConfig(config);
  if (!validation.valid) {
    return { error: `Invalid configuration: ${formatConfigErrors(validation)}`, validationErrors: validation.errors };
  }
  const requestError = validateServingRequests(config, requestSpecs, options);
  if (requestError) return { error: requestError };

  const requests = requestSpecs.map((spec, index) => {
    const trace = traceForRequest(config, spec, index);
    return {
      id: String(spec.id ?? index),
      arrivalMs: spec.arrivalMs ?? 0,
      output: spec.output ?? config.output,
      trace,
      nextToken: 0,
      completed: [],
      firstTokenAt: null,
      completionMs: null,
      error: trace.error || null
    };
  });
  const traceError = requests.find(request => request.error);
  if (traceError) return { error: `Request ${traceError.id}: ${traceError.error}` };
  const isSingleRequest = requests.length === 1;

  const resources = {
    ssd: new SharedServingResource('ssd', config.ssdBW, config.lat / 1000, config.qd || 1),
    pcie: new SharedServingResource('pcie', Math.min(config.pcieBW || Infinity, config.dramBW), 0, 1),
    dram: new SharedServingResource('dram', config.dramBW, 0, 1),
    patch: new SharedServingResource('patch'),
    compute: new SharedServingResource('compute')
  };
  const queue = new EventQueue();
  const batchWindowMs = options.batchWindowMs ?? 2;
  const readyBatch = [];
  let dispatchScheduled = false;
  for (const request of requests) queue.push({ time: request.arrivalMs, type: 'arrival', request });

  while (queue.size) {
    const event = queue.pop();
    const request = event.request;
    if (event.type === 'arrival') {
      let readyAt;
      if (config.mode === 'afm3') {
        const selector = resources.compute.reserveMs(config.initSel, event.time, 'prefill');
        const storage = resources.ssd.reserveGB(request.trace.tot.initialReadGB, selector.end, config.chunks, 'prefill');
        const initialPatchMs = config.patchBase + request.trace.tot.initialReadGB / config.patchBW * 1000;
        const patch = resources.patch.reserveMs(initialPatchMs, storage.end, 'prefill');
        const prefill = resources.compute.reserveMs(config.prompt / config.prefillTPS * 1000, patch.end, 'prefill');
        readyAt = prefill.end;
      } else {
        const breakdown = request.trace.prefillBreakdown || {};
        const storage = resources.ssd.reserveGB(breakdown.storageGB || 0, event.time, breakdown.storageRequests || 1, 'prefill');
        const dram = resources.dram.reserveGB(breakdown.dramTrafficGB || 0, event.time, 1, 'prefill');
        const pcie = resources.pcie.reserveGB(breakdown.transferGB || 0, event.time, 1, 'prefill');
        const compute = resources.compute.reserveMs(breakdown.computeMs || 0, event.time, 'prefill');
        const prefillMs = Math.max(0, request.trace.ttft - (request.trace.tokens[0]?.tpot || 0));
        const contentionWait = isSingleRequest ? 0 : Math.max(storage.wait, dram.wait, pcie.wait, compute.wait);
        readyAt = Math.max(event.time + prefillMs + contentionWait, storage.end, dram.end, pcie.end, compute.end);
      }
      resources.ssd.reserveGB(initialSwapOutGB(request.trace), readyAt, 1, 'prefill');
      queue.push({ time: readyAt, type: 'token-ready', request });
    } else if (event.type === 'token-ready') {
      const token = request.trace.tokens[request.nextToken];
      if (!token) continue;
      const phase = request.nextToken === 0 ? 'first-token' : 'decode';
      const work = tokenWork(token);
      const storage = resources.ssd.reserveGB(work.demandGB + work.swapInGB, event.time, work.ssdRequests, phase);
      const dram = resources.dram.reserveGB(work.criticalDramGB, event.time, 1, phase);
      const pcie = resources.pcie.reserveGB(work.pcieGB, event.time, 1, phase);
      const contentionWait = isSingleRequest ? 0 : Math.max(storage.wait, dram.wait, pcie.wait);
      queue.push({
        time: event.time + contentionWait,
        type: 'data-ready',
        request,
        token,
        work,
        phase,
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
      const batchReady = Math.max(...batch.map(item => item.time));
      for (const item of batch) {
        const prefetch = resources.ssd.reserveGB(item.work.prefetchGB, item.time, item.work.ssdRequests, item.phase);
        resources.dram.reserveGB(item.work.prefetchGB, prefetch.end, 1, item.phase);
        const swapSource = resources.dram.reserveGB(item.work.swapOutGB, item.time, 1, item.phase);
        resources.ssd.reserveGB(item.work.swapOutGB, swapSource.end, 1, item.phase);
      }
      const maxItem = batch.reduce((current, item) => item.work.computeMs > current.work.computeMs ? item : current, batch[0]);
      const maxCompute = maxItem.work.computeMs;
      const batchService = maxCompute * (1 + 0.08 * Math.max(0, batch.length - 1));
      const batchPhases = new Set(batch.map(item => item.phase));
      const computePhase = batchPhases.size === 1 ? batch[0].phase : 'mixed';
      const patchRatio = maxCompute > EPS ? Math.min(1, maxItem.work.patchMs / maxCompute) : 0;
      const patchService = batchService * patchRatio;
      const computeService = batchService - patchService;
      const patch = resources.patch.reserveMs(patchService, batchReady, computePhase);
      const compute = resources.compute.reserveMs(computeService, patch.end, computePhase);
      const batchOverhead = Math.max(0, batchService - maxCompute);
      for (const item of batch) {
        const admissionDelay = batchReady - item.time;
        const resourceWait = isSingleRequest ? 0 : patch.wait + compute.wait;
        const completeAt = item.baselineCompleteAt + admissionDelay + resourceWait + batchOverhead;
        queue.push({ time: completeAt, type: 'complete', request: item.request, token: item.token, batchSize: batch.length });
      }
    } else if (event.type === 'complete') {
      request.completed.push({ token: request.nextToken + 1, completedAt: event.time, tpotMs: event.time - (request.completionMs ?? request.arrivalMs), batchSize: event.batchSize });
      request.nextToken++;
      if (request.firstTokenAt === null) request.firstTokenAt = event.time;
      request.completionMs = event.time;
      if (request.nextToken < request.trace.tokens.length) queue.push({ time: event.time, type: 'token-ready', request });
    }
  }

  const completedTokens = requests.reduce((sum, request) => sum + request.completed.length, 0);
  const firstArrival = Math.min(...requests.map(request => request.arrivalMs));
  const finalCompletion = Math.max(...requests.map(request => request.completionMs ?? request.arrivalMs));
  const makespanMs = Math.max(0, finalCompletion - firstArrival);
  const tokenLatencies = requests.flatMap(request => request.completed.map(token => token.tpotMs));
  const requestResults = requests.map(request => ({
    id: request.id,
    arrivalMs: request.arrivalMs,
    output: request.output,
    completedTokens: request.completed.length,
    ttftMs: request.firstTokenAt === null ? null : request.firstTokenAt - request.arrivalMs,
    completionMs: request.completionMs,
    latencyMs: request.completionMs === null ? null : request.completionMs - request.arrivalMs,
    tokens: request.completed
  }));
  const normalizedSpecs = requests.map(request => ({ id: request.id, arrivalMs: request.arrivalMs, output: request.output }));
  return {
    modelStatus: 'Estimated · event-driven shared-resource model',
    runId: servingRunId(config, normalizedSpecs),
    completedTokens,
    makespanMs,
    throughputTPS: makespanMs > EPS ? completedTokens / (makespanMs / 1000) : 0,
    p50TokenMs: percentile(tokenLatencies, 0.5),
    p95TokenMs: percentile(tokenLatencies, 0.95),
    requests: requestResults,
    resources: Object.fromEntries(Object.entries(resources).map(([name, resource]) => [name, resource.snapshot()]))
  };
}
