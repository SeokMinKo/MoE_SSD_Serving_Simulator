'use strict';

const DEVICE_COMPUTE_SCHEMA = 'device-compute/v2';
const DEVICE_COMPUTE_EPSILON = 1e-12;

function deviceComputeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function deviceComputeInteger(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function deviceComputeDeviceProfile(input, legacy, expertKernelMultiplier) {
  const source = input && typeof input === 'object' ? input : {};
  const speedScale = deviceComputeNumber(source.speedScale, 1);
  const attentionMs = deviceComputeNumber(source.attentionMs, legacy.attentionMs);
  const expertMs = deviceComputeNumber(source.expertMs, legacy.expertMs);
  const parallelExperts = deviceComputeInteger(source.parallelExperts, legacy.parallelExperts);
  const prefillSpeedup = deviceComputeNumber(source.prefillSpeedup, legacy.prefillSpeedup);
  const multiplier = deviceComputeNumber(expertKernelMultiplier, 1);
  return {
    speedScale,
    attentionMs,
    expertMs,
    parallelExperts,
    prefillSpeedup,
    kernelMultiplier: multiplier,
    effectiveAttentionMs: attentionMs / Math.max(DEVICE_COMPUTE_EPSILON, speedScale),
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

function deriveColibriDeviceProfile(config) {
  const compute = config?.compute && typeof config.compute === 'object' ? config.compute : null;
  const mode = compute?.mode === 'calibrated' ? 'calibrated' : 'legacy';
  const legacyValues = {
    attn: config.attn,
    ems: config.ems,
    par: config.par,
    prefillSpeedup: config.prefillSpeedup,
    esize: config.esize,
    vcache: config.vcache
  };
  const quantization = deriveQuantizedExpertPayload(config, legacyValues.esize);
  if (mode === 'legacy') {
    return {
      schema: DEVICE_COMPUTE_SCHEMA,
      mode,
      quantization,
      attentionDevice: 'gpu',
      expertDevice: 'gpu',
      targetCpuExpertFraction: 0,
      targetGpuExpertFraction: 1,
      execution: 'sequential',
      overlapEfficiency: 0,
      effectiveAttentionMs: legacyValues.attn,
      effectivePrefillSpeedup: legacyValues.prefillSpeedup,
      usesCpu: false,
      usesGpu: true,
      legacy: legacyValues
    };
  }

  const attentionDevice = compute.attentionDevice === 'cpu' ? 'cpu' : 'gpu';
  const expertDevice = ['cpu', 'hybrid'].includes(compute.expertDevice) ? compute.expertDevice : 'gpu';
  const hybrid = compute.hybrid && typeof compute.hybrid === 'object' ? compute.hybrid : {};
  const targetCpuExpertFraction = expertDevice === 'cpu'
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
  const effectiveAttentionMs = attentionDevice === 'cpu' ? cpu.effectiveAttentionMs : gpu.effectiveAttentionMs;
  const usesCpu = attentionDevice === 'cpu' || targetCpuExpertFraction > DEVICE_COMPUTE_EPSILON;
  const usesGpu = attentionDevice === 'gpu' || targetCpuExpertFraction < 1 - DEVICE_COMPUTE_EPSILON;
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
    targetCpuExpertFraction,
    targetGpuExpertFraction: 1 - targetCpuExpertFraction,
    effectiveAttentionMs,
    effectivePrefillSpeedup: attentionDevice === 'cpu' ? cpu.prefillSpeedup : gpu.prefillSpeedup,
    usesCpu,
    usesGpu,
    legacy: legacyValues
  };
}

function deviceComputeHashUnit(seed, layer, expert) {
  const mask = (1n << 64n) - 1n;
  let value = (BigInt(seed || 0) ^ (BigInt(layer + 1) * 0x9E3779B97F4A7C15n) ^ (BigInt(expert + 1) * 0xBF58476D1CE4E5B9n)) & mask;
  value = ((value ^ (value >> 30n)) * 0xBF58476D1CE4E5B9n) & mask;
  value = ((value ^ (value >> 27n)) * 0x94D049BB133111EBn) & mask;
  value ^= value >> 31n;
  return Number(value >> 11n) / 9007199254740992;
}

function colibriExpertDevice(profile, layer, expert, seed) {
  if (!profile || profile.mode === 'legacy' || profile.expertDevice === 'gpu') return 'gpu';
  if (profile.expertDevice === 'cpu') return 'cpu';
  if (profile.targetCpuExpertFraction <= DEVICE_COMPUTE_EPSILON) return 'gpu';
  if (profile.targetCpuExpertFraction >= 1 - DEVICE_COMPUTE_EPSILON) return 'cpu';
  return deviceComputeHashUnit(seed, layer, expert) < profile.targetCpuExpertFraction ? 'cpu' : 'gpu';
}

function colibriRouteDeviceSplit(route, layer, profile, seed) {
  const cpuExperts = [];
  const gpuExperts = [];
  for (const expert of route || []) {
    (colibriExpertDevice(profile, layer, expert, seed) === 'cpu' ? cpuExperts : gpuExperts).push(expert);
  }
  return { cpuExperts, gpuExperts, cpuActive: cpuExperts.length, gpuActive: gpuExperts.length };
}

function combineColibriDevicePhases(cpuMs, gpuMs, execution, overlapEfficiency) {
  if (execution === 'sequential') return cpuMs + gpuMs;
  return Math.max(cpuMs, gpuMs) + (1 - overlapEfficiency) * Math.min(cpuMs, gpuMs);
}

function colibriLayerCompute(c, profile, cpuActive, gpuActive, prefill = false) {
  if (!profile || profile.mode === 'legacy') {
    const expertMs = Math.ceil(c.active / c.par) * c.ems;
    return {
      attentionMs: c.attn / c.layers,
      runtimeMs: 0.39,
      cpuExpertMs: 0,
      gpuExpertMs: expertMs,
      exposedExpertMs: expertMs,
      totalMs: c.attn / c.layers + 0.39 + expertMs
    };
  }
  const cpuWaves = cpuActive > 0 ? Math.ceil(cpuActive / profile.cpu.parallelExperts) : 0;
  const gpuWaves = gpuActive > 0 ? Math.ceil(gpuActive / profile.gpu.parallelExperts) : 0;
  const cpuExpertMs = cpuWaves * profile.cpu.effectiveExpertMs / (prefill ? profile.cpu.prefillSpeedup : 1);
  const gpuExpertMs = gpuWaves * profile.gpu.effectiveExpertMs / (prefill ? profile.gpu.prefillSpeedup : 1);
  const exposedExpertMs = combineColibriDevicePhases(cpuExpertMs, gpuExpertMs, profile.execution, profile.overlapEfficiency);
  const attentionProfile = profile.attentionDevice === 'cpu' ? profile.cpu : profile.gpu;
  const attentionMs = profile.effectiveAttentionMs / c.layers / (prefill ? attentionProfile.prefillSpeedup : 1);
  const runtimeMs = 0.39 / (prefill ? attentionProfile.prefillSpeedup : 1);
  return {
    attentionMs,
    runtimeMs,
    cpuExpertMs,
    gpuExpertMs,
    exposedExpertMs,
    totalMs: attentionMs + runtimeMs + exposedExpertMs
  };
}

function colibriExpectedDeviceCounts(c, profile) {
  if (!profile || profile.mode === 'legacy' || profile.expertDevice === 'gpu') return { cpuActive: 0, gpuActive: c.active };
  if (profile.expertDevice === 'cpu') return { cpuActive: c.active, gpuActive: 0 };
  let cpuMass = 0;
  let totalMass = 0;
  for (let layer = 0; layer < c.layers; layer++) {
    for (let expert = 0; expert < c.experts; expert++) {
      const weight = 1 / Math.pow(expert + 1, 1.05);
      totalMass += weight;
      if (colibriExpertDevice(profile, layer, expert, c.seed) === 'cpu') cpuMass += weight;
    }
  }
  const cpuActive = Math.max(0, Math.min(c.active, Math.round(c.active * cpuMass / Math.max(DEVICE_COMPUTE_EPSILON, totalMass))));
  return { cpuActive, gpuActive: c.active - cpuActive };
}

function colibriPrefillCompute(c, profile) {
  if (!c.prompt) return { computeMs: 0, perTokenMs: 0, cpuActive: 0, gpuActive: 0, layer: null };
  if (!profile || profile.mode === 'legacy') {
    const perTokenMs = c.attn + c.layers * (0.39 + Math.ceil(c.active / c.par) * c.ems);
    return {
      computeMs: c.prompt * perTokenMs / Math.max(DEVICE_COMPUTE_EPSILON, c.prefillSpeedup || 4.5),
      perTokenMs,
      cpuActive: 0,
      gpuActive: c.active,
      layer: null
    };
  }
  const counts = colibriExpectedDeviceCounts(c, profile);
  const layer = colibriLayerCompute(c, profile, counts.cpuActive, counts.gpuActive, true);
  const perTokenMs = c.layers * layer.totalMs;
  return { computeMs: c.prompt * perTokenMs, perTokenMs, ...counts, layer };
}

function colibriDeviceReserveGB(c, profile = deriveColibriDeviceProfile(c)) {
  return c?.arch === 'discrete' && profile?.usesGpu ? 0.8 : 0;
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

function installDeviceArtifactModel() {
  if (globalThis.__DEVICE_ARTIFACT_INSTALLED__) return false;
  if (typeof validateArtifactConfigShape !== 'function') return false;
  const legacyValidateArtifactConfigShape = validateArtifactConfigShape;
  validateArtifactConfigShape = function deviceAwareArtifactConfigShape(config) {
    const sanitized = { ...config };
    delete sanitized.compute;
    delete sanitized.quantization;
    legacyValidateArtifactConfigShape(sanitized);
    const validation = validateDeviceComputeConfig(config);
    if (!validation.valid) throw new Error(`Invalid device compute artifact config: ${deviceComputeFormatErrors(validation)}`);
  };
  globalThis.__DEVICE_ARTIFACT_INSTALLED__ = Object.freeze({ schema: DEVICE_COMPUTE_SCHEMA });
  return true;
}

function scheduleDeviceArtifactInstall() {
  if (typeof document !== 'object' || typeof document.addEventListener !== 'function') return false;
  const install = () => installDeviceArtifactModel();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else Promise.resolve().then(install);
  return true;
}

scheduleDeviceArtifactInstall();
