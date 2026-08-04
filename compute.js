'use strict';

const DEVICE_COMPUTE_SCHEMA = 'device-compute/v1';
const DEVICE_COMPUTE_EPSILON = 1e-12;

function deviceComputeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function deviceComputeInteger(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function deviceComputeDeviceProfile(input, legacy, kernelMultiplier) {
  const source = input && typeof input === 'object' ? input : {};
  const speedScale = deviceComputeNumber(source.speedScale, 1);
  const attentionMs = deviceComputeNumber(source.attentionMs, legacy.attentionMs);
  const expertMs = deviceComputeNumber(source.expertMs, legacy.expertMs);
  const parallelExperts = deviceComputeInteger(source.parallelExperts, legacy.parallelExperts);
  const prefillSpeedup = deviceComputeNumber(source.prefillSpeedup, legacy.prefillSpeedup);
  const multiplier = deviceComputeNumber(kernelMultiplier, 1);
  return {
    speedScale,
    attentionMs,
    expertMs,
    parallelExperts,
    prefillSpeedup,
    kernelMultiplier: multiplier,
    effectiveAttentionMs: attentionMs * multiplier / Math.max(DEVICE_COMPUTE_EPSILON, speedScale),
    effectiveExpertMs: expertMs * multiplier / Math.max(DEVICE_COMPUTE_EPSILON, speedScale)
  };
}

function deriveQuantizedExpertPayload(config, legacyExpertMB = config?.esize) {
  const source = config?.quantization && typeof config.quantization === 'object' ? config.quantization : {};
  const payloadMode = source.payloadMode === 'derived' ? 'derived' : 'manual';
  const weightBits = deviceComputeNumber(source.weightBits, 4);
  const packing = deviceComputeNumber(source.packing, 1);
  const manualExpertMB = deviceComputeNumber(source.manualExpertMB, legacyExpertMB);
  const expertParamsM = Number.isFinite(source.expertParamsM) ? source.expertParamsM : null;
  const effectiveExpertMB = payloadMode === 'derived'
    ? expertParamsM * weightBits / 8 * packing
    : manualExpertMB;
  return {
    payloadMode,
    format: typeof source.format === 'string' ? source.format : 'custom',
    weightBits,
    packing,
    manualExpertMB,
    expertParamsM,
    cpuKernelMultiplier: deviceComputeNumber(source.cpuKernelMultiplier, 1),
    gpuKernelMultiplier: deviceComputeNumber(source.gpuKernelMultiplier, 1),
    effectiveExpertMB
  };
}

function splitColibriActiveExperts(active, expertDevice, cpuExpertFraction) {
  if (expertDevice === 'cpu') return { cpuActive: active, gpuActive: 0 };
  if (expertDevice === 'hybrid') {
    const cpuActive = Math.max(0, Math.min(active, Math.round(active * cpuExpertFraction)));
    return { cpuActive, gpuActive: active - cpuActive };
  }
  return { cpuActive: 0, gpuActive: active };
}

function deriveColibriDeviceProfile(config) {
  const compute = config?.compute && typeof config.compute === 'object' ? config.compute : null;
  const mode = compute?.mode === 'calibrated' ? 'calibrated' : 'legacy';
  const previousLegacy = config?.__deviceCompute?.legacy && typeof config.__deviceCompute.legacy === 'object'
    ? config.__deviceCompute.legacy
    : null;
  const legacyValues = {
    attn: deviceComputeNumber(previousLegacy?.attn, config.attn),
    ems: deviceComputeNumber(previousLegacy?.ems, config.ems),
    par: deviceComputeInteger(previousLegacy?.par, config.par),
    prefillSpeedup: deviceComputeNumber(previousLegacy?.prefillSpeedup, config.prefillSpeedup),
    esize: deviceComputeNumber(previousLegacy?.esize, config.esize),
    vcache: deviceComputeNumber(previousLegacy?.vcache, config.vcache)
  };
  const quantization = deriveQuantizedExpertPayload(config, legacyValues.esize);
  if (mode === 'legacy') {
    return {
      schema: DEVICE_COMPUTE_SCHEMA,
      mode,
      quantization,
      attentionDevice: 'gpu',
      expertDevice: 'gpu',
      cpuActive: 0,
      gpuActive: config.active,
      cpuExpertFraction: 0,
      gpuExpertFraction: 1,
      effectiveAttentionMs: legacyValues.attn,
      effectiveExpertPhaseMs: Math.ceil(config.active / legacyValues.par) * legacyValues.ems,
      effectivePrefillSpeedup: legacyValues.prefillSpeedup,
      legacy: legacyValues
    };
  }

  const attentionDevice = compute.attentionDevice === 'cpu' ? 'cpu' : 'gpu';
  const expertDevice = ['cpu', 'hybrid'].includes(compute.expertDevice) ? compute.expertDevice : 'gpu';
  const hybrid = compute.hybrid && typeof compute.hybrid === 'object' ? compute.hybrid : {};
  const cpuExpertFraction = expertDevice === 'cpu'
    ? 1
    : expertDevice === 'gpu'
      ? 0
      : deviceComputeNumber(hybrid.cpuExpertFraction, 0.5);
  const execution = hybrid.execution === 'sequential' ? 'sequential' : 'parallel';
  const overlapEfficiency = deviceComputeNumber(hybrid.overlapEfficiency, 1);
  const legacy = {
    attentionMs: legacyValues.attn,
    expertMs: legacyValues.ems,
    parallelExperts: legacyValues.par,
    prefillSpeedup: legacyValues.prefillSpeedup
  };
  const cpu = deviceComputeDeviceProfile(compute.cpu, legacy, quantization.cpuKernelMultiplier);
  const gpu = deviceComputeDeviceProfile(compute.gpu, legacy, quantization.gpuKernelMultiplier);
  const { cpuActive, gpuActive } = splitColibriActiveExperts(config.active, expertDevice, cpuExpertFraction);
  const cpuWaves = cpuActive ? Math.ceil(cpuActive / cpu.parallelExperts) : 0;
  const gpuWaves = gpuActive ? Math.ceil(gpuActive / gpu.parallelExperts) : 0;
  const cpuExpertPhaseMs = cpuWaves * cpu.effectiveExpertMs;
  const gpuExpertPhaseMs = gpuWaves * gpu.effectiveExpertMs;
  const effectiveExpertPhaseMs = execution === 'sequential'
    ? cpuExpertPhaseMs + gpuExpertPhaseMs
    : Math.max(cpuExpertPhaseMs, gpuExpertPhaseMs) +
      (1 - overlapEfficiency) * Math.min(cpuExpertPhaseMs, gpuExpertPhaseMs);
  const activeTotal = Math.max(1, cpuActive + gpuActive);
  const effectivePrefillSpeedup = (
    cpuActive * cpu.prefillSpeedup + gpuActive * gpu.prefillSpeedup
  ) / activeTotal;
  const effectiveAttentionMs = attentionDevice === 'cpu' ? cpu.effectiveAttentionMs : gpu.effectiveAttentionMs;

  return {
    schema: DEVICE_COMPUTE_SCHEMA,
    mode,
    quantization,
    attentionDevice,
    expertDevice,
    execution,
    overlapEfficiency,
    cpu,
    gpu,
    cpuActive,
    gpuActive,
    cpuExpertFraction: cpuActive / activeTotal,
    gpuExpertFraction: gpuActive / activeTotal,
    cpuExpertPhaseMs,
    gpuExpertPhaseMs,
    effectiveAttentionMs,
    effectiveExpertPhaseMs,
    effectivePrefillSpeedup,
    legacy: legacyValues
  };
}

function normalizeColibriDeviceConfig(input) {
  if (!input || input.mode !== 'colibri') return { config: input, profile: null };
  const profile = deriveColibriDeviceProfile(input);
  if (profile.mode === 'legacy' && !input.quantization) return { config: input, profile };
  const effectiveExpertMB = profile.quantization.effectiveExpertMB;
  const normalized = {
    ...input,
    esize: effectiveExpertMB,
    __deviceCompute: profile
  };
  if (profile.mode === 'calibrated') {
    normalized.attn = profile.effectiveAttentionMs;
    normalized.ems = profile.effectiveExpertPhaseMs;
    normalized.par = Math.max(1, input.active);
    normalized.prefillSpeedup = profile.effectivePrefillSpeedup;
  }
  return { config: normalized, profile };
}

function validateDeviceComputeConfig(config) {
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message });
  const finite = (path, value, min, max = Infinity) => {
    if (!Number.isFinite(value) || value < min || value > max) add(path, 'OUT_OF_RANGE', `${path} must be between ${min} and ${max}.`);
  };
  const integer = (path, value, min, max) => {
    finite(path, value, min, max);
    if (Number.isFinite(value) && !Number.isSafeInteger(value)) add(path, 'NOT_SAFE_INTEGER', `${path} must be a safe integer.`);
  };
  const enumValue = (path, value, allowed) => {
    if (!allowed.includes(value)) add(path, 'INVALID_ENUM', `${path} must be one of ${allowed.join(', ')}.`);
  };

  if (!config || config.mode !== 'colibri') return { valid: true, errors };
  const quantization = config.quantization;
  if (quantization !== undefined) {
    if (!quantization || typeof quantization !== 'object' || Array.isArray(quantization)) {
      add('quantization', 'INVALID_OBJECT', 'quantization must be an object.');
    } else {
      enumValue('quantization.payloadMode', quantization.payloadMode || 'manual', ['manual', 'derived']);
      finite('quantization.weightBits', quantization.weightBits ?? 4, 1, 16);
      finite('quantization.packing', quantization.packing ?? 1, 1, 10);
      finite('quantization.cpuKernelMultiplier', quantization.cpuKernelMultiplier ?? 1, 0.001, 1000);
      finite('quantization.gpuKernelMultiplier', quantization.gpuKernelMultiplier ?? 1, 0.001, 1000);
      if ((quantization.payloadMode || 'manual') === 'derived') {
        finite('quantization.expertParamsM', quantization.expertParamsM, 0.001, 1_000_000);
      } else {
        finite('quantization.manualExpertMB', quantization.manualExpertMB ?? config.esize, 0.001, 1_000_000);
      }
    }
  }

  const compute = config.compute;
  if (compute === undefined) return { valid: errors.length === 0, errors };
  if (!compute || typeof compute !== 'object' || Array.isArray(compute)) {
    add('compute', 'INVALID_OBJECT', 'compute must be an object.');
    return { valid: false, errors };
  }
  enumValue('compute.mode', compute.mode || 'legacy', ['legacy', 'calibrated']);
  if ((compute.mode || 'legacy') !== 'calibrated') return { valid: errors.length === 0, errors };
  enumValue('compute.attentionDevice', compute.attentionDevice || 'gpu', ['cpu', 'gpu']);
  enumValue('compute.expertDevice', compute.expertDevice || 'gpu', ['cpu', 'gpu', 'hybrid']);
  for (const deviceName of ['cpu', 'gpu']) {
    const device = compute[deviceName];
    if (!device || typeof device !== 'object' || Array.isArray(device)) {
      add(`compute.${deviceName}`, 'INVALID_OBJECT', `${deviceName} compute profile is required.`);
      continue;
    }
    finite(`compute.${deviceName}.speedScale`, device.speedScale ?? 1, 0.001, 1000);
    finite(`compute.${deviceName}.attentionMs`, device.attentionMs ?? config.attn, 0, 1_000_000);
    finite(`compute.${deviceName}.expertMs`, device.expertMs ?? config.ems, 0, 1_000_000);
    integer(`compute.${deviceName}.parallelExperts`, device.parallelExperts ?? config.par, 1, 4096);
    finite(`compute.${deviceName}.prefillSpeedup`, device.prefillSpeedup ?? config.prefillSpeedup, 0.001, 1_000_000);
  }
  const hybrid = compute.hybrid && typeof compute.hybrid === 'object' ? compute.hybrid : {};
  enumValue('compute.hybrid.execution', hybrid.execution || 'parallel', ['parallel', 'sequential']);
  finite('compute.hybrid.cpuExpertFraction', hybrid.cpuExpertFraction ?? 0.5, 0, 1);
  finite('compute.hybrid.overlapEfficiency', hybrid.overlapEfficiency ?? 1, 0, 1);
  return { valid: errors.length === 0, errors };
}

function deviceComputeFormatErrors(validation) {
  return validation.errors.map(error => `${error.path}: ${error.message}`).join(' ');
}

function finalizeColibriDeviceResult(result) {
  const profile = result?.c?.__deviceCompute;
  if (!result || result.error || profile?.mode !== 'calibrated') return result;
  const c = result.c;
  const rawUnitGB = c.esize / 1000;
  const oldFirstTpot = result.tokens[0]?.tpot || 0;
  let addedDramTrafficGB = 0;
  let addedDramStallMs = 0;
  let peakDramGBs = result.state?.peakDramGBs || 0;

  for (const token of result.tokens || []) {
    const cpuActiveWeightGB = c.arch === 'discrete'
      ? c.layers * profile.cpuActive * rawUnitGB
      : 0;
    const oldTrafficGB = Math.max(0, token.memory?.dramTrafficGB || 0);
    const newTrafficGB = oldTrafficGB + cpuActiveWeightGB;
    const oldElapsed = token.tpot;
    const dramFloorMs = newTrafficGB / Math.max(DEVICE_COMPUTE_EPSILON, c.dramBW) * 1000;
    const newElapsed = Math.max(oldElapsed, dramFloorMs);
    const deltaMs = newElapsed - oldElapsed;
    token.tpot = newElapsed;
    token.computeBreakdown = {
      schema: DEVICE_COMPUTE_SCHEMA,
      attentionDevice: profile.attentionDevice,
      expertDevice: profile.expertDevice,
      cpuActiveExperts: profile.cpuActive,
      gpuActiveExperts: profile.gpuActive,
      cpuExpertMs: c.layers * profile.cpuExpertPhaseMs,
      gpuExpertMs: c.layers * profile.gpuExpertPhaseMs,
      exposedExpertMs: c.layers * profile.effectiveExpertPhaseMs,
      attentionMs: profile.effectiveAttentionMs
    };
    if (token.memory) {
      token.memory.dramTrafficGB = newTrafficGB;
      token.memory.dramStallMs = Math.max(0, (token.memory.dramStallMs || 0) + deltaMs);
      token.memory.dramGBs = newTrafficGB / Math.max(DEVICE_COMPUTE_EPSILON, newElapsed / 1000);
      token.memory.dramUtilization = token.memory.dramGBs / c.dramBW;
      peakDramGBs = Math.max(peakDramGBs, token.memory.dramGBs);
    }
    addedDramTrafficGB += cpuActiveWeightGB;
    addedDramStallMs += deltaMs;
  }

  if (result.state) {
    result.state.totalDramTrafficGB += addedDramTrafficGB;
    result.state.totalDramStallMs += addedDramStallMs;
    result.state.peakDramGBs = peakDramGBs;
  }

  if (result.prefillBreakdown) {
    const prefill = result.prefillBreakdown;
    const oldPrefillMs = prefill.ms;
    const oldTransferGB = prefill.transferGB;
    const newTransferGB = c.arch === 'discrete' ? oldTransferGB * profile.gpuExpertFraction : 0;
    const newTransferMs = c.arch === 'discrete'
      ? newTransferGB / Math.max(DEVICE_COMPUTE_EPSILON, Math.min(c.pcieBW, c.dramBW)) * 1000
      : 0;
    const cpuExpertGB = c.arch === 'discrete'
      ? c.prompt * c.layers * profile.cpuActive * rawUnitGB
      : 0;
    const cpuResidentGB = c.arch === 'discrete' && profile.attentionDevice === 'cpu'
      ? c.prompt * c.resident
      : 0;
    const newDramTrafficGB = Math.max(0, prefill.dramTrafficGB - oldTransferGB) + newTransferGB + cpuExpertGB + cpuResidentGB;
    const newDramMs = newDramTrafficGB / Math.max(DEVICE_COMPUTE_EPSILON, c.dramBW) * 1000;
    const newPrefillMs = Math.max(prefill.computeMs, prefill.storageMs, newTransferMs, newDramMs);
    prefill.transferGB = newTransferGB;
    prefill.transferMs = newTransferMs;
    prefill.transferEntries *= profile.gpuExpertFraction;
    prefill.dramTrafficGB = newDramTrafficGB;
    prefill.dramMs = newDramMs;
    prefill.ms = newPrefillMs;
    result.prefill = newPrefillMs;
    result.ttft += newPrefillMs - oldPrefillMs;
  }

  const newFirstTpot = result.tokens[0]?.tpot || 0;
  result.ttft += newFirstTpot - oldFirstTpot;
  const intervals = result.tokens.length > 1 ? result.tokens.slice(1) : result.tokens;
  result.avg = intervals.reduce((sum, token) => sum + token.tpot, 0) / intervals.length;
  result.tps = 1000 / result.avg;
  const pciePt = result.tot.pcieGB / result.tokens.length;
  result.pcieBound = c.arch === 'discrete' && pciePt
    ? Math.min(c.pcieBW, c.dramBW) / pciePt
    : Infinity;
  const dramPt = result.state.totalDramTrafficGB / result.tokens.length;
  result.dramBound = dramPt ? c.dramBW / dramPt : Infinity;
  result.agg = Math.min(c.conc * result.tps, result.ssdBound, result.pcieBound, result.dramBound);
  result.computeProfile = profile;
  result.quantizationProfile = profile.quantization;
  return result;
}

function installDeviceComputeModel() {
  if (globalThis.__DEVICE_COMPUTE_INSTALLED__) return false;
  if (typeof simulateColibri !== 'function' || typeof validateSimulationConfig !== 'function' || typeof applyColibriPlacement !== 'function' || typeof LinkResource !== 'function') {
    throw new Error('Device compute model must be installed after the Colibri engine and core resources are loaded.');
  }
  const legacySimulateColibri = simulateColibri;
  const legacyValidateSimulationConfig = validateSimulationConfig;
  const legacyApplyColibriPlacement = applyColibriPlacement;
  const LegacyLinkResource = LinkResource;

  LinkResource = class DeviceAwareLinkResource extends LegacyLinkResource {
    reserveGB(gb, now) {
      const profile = this.c?.__deviceCompute;
      const scaledGB = profile?.mode === 'calibrated' ? gb * profile.gpuExpertFraction : gb;
      return super.reserveGB(scaledGB, now);
    }
  };

  applyColibriPlacement = function deviceAwareColibriPlacement(input) {
    const { config, profile } = normalizeColibriDeviceConfig(input);
    const requestedVcacheGB = config?.__devicePlacementApplied === DEVICE_COMPUTE_SCHEMA
      ? deviceComputeNumber(config.placementInfo?.requestedVcacheGB, profile?.legacy?.vcache)
      : config?.vcache;
    const placementInput = config?.__devicePlacementApplied === DEVICE_COMPUTE_SCHEMA
      ? { ...config, vcache: requestedVcacheGB, __devicePlacementApplied: undefined }
      : config;
    const placed = legacyApplyColibriPlacement(placementInput);
    if (profile?.mode !== 'calibrated' || placed.arch !== 'discrete') return placed;
    const physicalVcacheGB = placed.vcache;
    placed.vcache = physicalVcacheGB * profile.gpuExpertFraction;
    placed.__deviceCompute = profile;
    placed.__devicePlacementApplied = DEVICE_COMPUTE_SCHEMA;
    placed.placementInfo = {
      ...(placed.placementInfo || {}),
      requestedVcacheGB: physicalVcacheGB,
      effectiveVcacheGB: placed.vcache,
      gpuExpertFraction: profile.gpuExpertFraction,
      cpuExpertFraction: profile.cpuExpertFraction
    };
    return placed;
  };

  validateSimulationConfig = function deviceAwareValidation(input) {
    const deviceValidation = validateDeviceComputeConfig(input);
    let normalized = input;
    try {
      normalized = normalizeColibriDeviceConfig(input).config;
    } catch (error) {
      return {
        valid: false,
        errors: [...deviceValidation.errors, { path: 'compute', code: 'NORMALIZATION_ERROR', message: String(error?.message || error) }]
      };
    }
    const legacyValidation = legacyValidateSimulationConfig(normalized);
    return {
      valid: deviceValidation.valid && legacyValidation.valid,
      errors: [...deviceValidation.errors, ...legacyValidation.errors]
    };
  };

  simulateColibri = function deviceAwareSimulateColibri(input = readColibri(), options = {}) {
    const validation = validateDeviceComputeConfig(input);
    if (!validation.valid) {
      return {
        error: `Invalid configuration: ${deviceComputeFormatErrors(validation)}`,
        validationErrors: validation.errors,
        c: input,
        mode: 'colibri'
      };
    }
    const { config } = normalizeColibriDeviceConfig(input);
    const result = legacySimulateColibri(config, options);
    return finalizeColibriDeviceResult(result);
  };

  globalThis.__DEVICE_COMPUTE_INSTALLED__ = Object.freeze({ schema: DEVICE_COMPUTE_SCHEMA });
  return true;
}

function scheduleDeviceComputeInstall() {
  if (typeof document !== 'object' || typeof document.addEventListener !== 'function') return false;
  const install = () => {
    if (!globalThis.__DEVICE_COMPUTE_INSTALLED__) installDeviceComputeModel();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else Promise.resolve().then(install);
  return true;
}

scheduleDeviceComputeInstall();
