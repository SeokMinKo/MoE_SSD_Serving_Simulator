'use strict';

/*
 * Mobile AP roofline + measured calibration model.
 *
 * Trust boundary:
 * - Vendor-published relative performance/precision facts are metadata only.
 * - Third-party peak TOPS/FLOPS are never converted directly into TPS.
 * - Absolute TPS requires a measured anchor or explicit workload geometry + efficiency.
 */

const MOBILE_AP_SCHEMA = 'mobile-ap-roofline/v1';
const EPS = 1e-12;

const MOBILE_AP_HARDWARE = Object.freeze({
  sm8750_galaxy: Object.freeze({
    id: 'sm8750_galaxy',
    soc: 'Qualcomm SM8750-AC',
    product: 'Snapdragon 8 Elite for Galaxy',
    deviceFamily: 'Galaxy S25',
    cpu: Object.freeze({
      name: 'Qualcomm Oryon',
      peakOps: null,
      peakClockGHz: 4.47,
      evidence: 'official-clock',
      note: 'CPU TOPS is intentionally not synthesized; use measured kernels/LLM anchors.'
    }),
    gpu: Object.freeze({
      name: 'Adreno 830',
      peak: Object.freeze({ fp32TFLOPS: 3.6864, fp16TFLOPS: null, int8TOPS: null, int4TOPS: null }),
      evidence: 'third-party-derived',
      note: 'FP32 peak is architecture/clock derived for the Galaxy high-clock variant, not a Qualcomm serving claim.'
    }),
    npu: Object.freeze({
      name: 'Hexagon NPU',
      peak: Object.freeze({ int8TOPS: 65.25, int4TOPS: null, fp16TFLOPS: null }),
      precisions: Object.freeze(['int4', 'int8', 'int16', 'fp16']),
      evidence: 'third-party',
      note: 'Qualcomm publishes precision support and generational uplift, but not this absolute TOPS value in the product brief.'
    }),
    memory: Object.freeze({
      theoreticalGBs: 84.8,
      evidence: 'third-party-derived',
      note: 'LPDDR theoretical bandwidth is not effective LLM bandwidth; efficiency must be calibrated.'
    }),
    officialRelative: Object.freeze({ cpuPerformanceUpliftPct: 45, gpuPerformanceUpliftPct: 40, npuPerformanceUpliftPct: 45 })
  }),

  sm8850_galaxy: Object.freeze({
    id: 'sm8850_galaxy',
    soc: 'Qualcomm SM8850',
    product: 'Snapdragon 8 Elite Gen 5 for Galaxy',
    deviceFamily: 'Galaxy S26',
    cpu: Object.freeze({
      name: '3rd Gen Qualcomm Oryon',
      peakOps: null,
      peakClockGHz: 4.74,
      evidence: 'official',
      note: 'CPU TOPS is intentionally not synthesized; use measured kernels/LLM anchors.'
    }),
    gpu: Object.freeze({
      name: 'Adreno 840',
      peak: Object.freeze({ fp32TFLOPS: 3.6864, fp16TFLOPS: null, int8TOPS: null, int4TOPS: null }),
      evidence: 'third-party-derived',
      note: 'FP32 peak is a third-party architecture/clock calculation, not a Qualcomm serving claim.'
    }),
    npu: Object.freeze({
      name: 'Hexagon NPU',
      peak: Object.freeze({ int8TOPS: 89.4, int4TOPS: null, fp8TFLOPS: null, fp16TFLOPS: null }),
      precisions: Object.freeze(['int2', 'int4', 'int8', 'int16', 'fp8', 'fp16']),
      evidence: 'third-party',
      note: 'Qualcomm officially publishes +37% NPU performance and precision support, not 89.4 TOPS.'
    }),
    memory: Object.freeze({
      theoreticalGBs: null,
      evidence: 'unknown',
      note: 'Do not guess LPDDR effective bandwidth. Enter measured or independently sourced bandwidth before roofline use.'
    }),
    officialRelative: Object.freeze({ cpuPerformanceUpliftPct: 20, gpuPerformanceUpliftPct: 23, npuPerformanceUpliftPct: 37 })
  })
});

const MOBILE_AP_MEASUREMENTS = Object.freeze([
  Object.freeze({
    id: 's26-sm8850-gemma4-26b-a4b-cpu-offload', hardwareId: 'sm8850_galaxy', modelId: 'gemma4-26b-a4b', backend: 'cpu',
    offloading: 'moe', tps: 5.69, computeMs: 104, exposedFlashWaitMs: 56, cacheHit: 0.69, expertCacheMB: 2000,
    source: 'user-measured', flashWaitDefinition: 'post-compute exposed wait after compute/flash overlap'
  }),
  Object.freeze({
    id: 's26-sm8850-qwen3.6-35b-a3b-cpu-offload', hardwareId: 'sm8850_galaxy', modelId: 'qwen3.6-35b-a3b', backend: 'cpu',
    offloading: 'moe', tps: 8.39, computeMs: 85, exposedFlashWaitMs: 38, cacheHit: 0.67, expertCacheMB: null,
    source: 'user-measured', flashWaitDefinition: 'post-compute exposed wait after compute/flash overlap'
  }),
  Object.freeze({
    id: 's26-sm8850-gemma4-e4b-gpu-resident', hardwareId: 'sm8850_galaxy', modelId: 'gemma4-e4b', backend: 'gpu',
    offloading: 'none', tps: 21.83, computeMs: null, exposedFlashWaitMs: 0, cacheHit: null, expertCacheMB: null,
    source: 'user-measured'
  }),
  Object.freeze({
    id: 's26-sm8850-gemma4-e4b-cpu-resident', hardwareId: 'sm8850_galaxy', modelId: 'gemma4-e4b', backend: 'cpu',
    offloading: 'none', tps: 15.72, computeMs: null, exposedFlashWaitMs: 0, cacheHit: null, expertCacheMB: null,
    source: 'user-measured'
  }),
  Object.freeze({
    id: 's25-sm8750-gemma4-26b-a4b-cpu-offload', hardwareId: 'sm8750_galaxy', modelId: 'gemma4-26b-a4b', backend: 'cpu',
    offloading: 'moe', tps: 5.26, computeMs: 103, exposedFlashWaitMs: 69, cacheHit: 0.69, expertCacheMB: 2000,
    source: 'user-measured', flashWaitDefinition: 'post-compute exposed wait after compute/flash overlap'
  })
]);

function finite(value, name, min = 0) {
  if (!Number.isFinite(value) || value < min) throw new TypeError(`${name} must be a finite number >= ${min}`);
  return value;
}

function measurementById(id) {
  return MOBILE_AP_MEASUREMENTS.find(row => row.id === id) || null;
}

function decomposeMeasurement(measurement) {
  if (!measurement || typeof measurement !== 'object') throw new TypeError('measurement is required');
  const tps = finite(measurement.tps, 'measurement.tps', EPS);
  const tpotMs = 1000 / tps;
  const computeMs = Number.isFinite(measurement.computeMs) ? measurement.computeMs : null;
  const exposedFlashWaitMs = Number.isFinite(measurement.exposedFlashWaitMs) ? measurement.exposedFlashWaitMs : 0;
  const residualMs = computeMs === null ? null : tpotMs - computeMs - exposedFlashWaitMs;
  return {
    tpotMs,
    computeMs,
    exposedFlashWaitMs,
    residualMs,
    accountedMs: computeMs === null ? null : computeMs + exposedFlashWaitMs,
    accountedFraction: computeMs === null ? null : (computeMs + exposedFlashWaitMs) / tpotMs
  };
}

function measuredDenseBackendRatio(hardwareId, modelId, fasterBackend = 'gpu', slowerBackend = 'cpu') {
  const faster = MOBILE_AP_MEASUREMENTS.find(x => x.hardwareId === hardwareId && x.modelId === modelId && x.backend === fasterBackend && x.offloading === 'none');
  const slower = MOBILE_AP_MEASUREMENTS.find(x => x.hardwareId === hardwareId && x.modelId === modelId && x.backend === slowerBackend && x.offloading === 'none');
  if (!faster || !slower) return null;
  return {
    hardwareId,
    modelId,
    fasterBackend,
    slowerBackend,
    tpsRatio: faster.tps / slower.tps,
    latencyRatio: slower.tps / faster.tps,
    evidence: 'same-device-same-model-measured'
  };
}

function rooflineLatencyMs({ operations, bytes, peakOpsPerSec, memoryBandwidthGBs, computeEfficiency = 1, memoryEfficiency = 1, overheadMs = 0 }) {
  finite(operations, 'operations');
  finite(bytes, 'bytes');
  finite(peakOpsPerSec, 'peakOpsPerSec', EPS);
  finite(memoryBandwidthGBs, 'memoryBandwidthGBs', EPS);
  finite(computeEfficiency, 'computeEfficiency', EPS);
  finite(memoryEfficiency, 'memoryEfficiency', EPS);
  finite(overheadMs, 'overheadMs');
  if (computeEfficiency > 1 || memoryEfficiency > 1) throw new RangeError('efficiency must be <= 1');
  const computeMs = operations / (peakOpsPerSec * computeEfficiency) * 1000;
  const memoryMs = bytes / (memoryBandwidthGBs * 1e9 * memoryEfficiency) * 1000;
  const dominant = computeMs >= memoryMs ? 'compute' : 'memory';
  return { totalMs: Math.max(computeMs, memoryMs) + overheadMs, computeMs, memoryMs, overheadMs, dominant };
}

function exposedFlashWaitMs({ flashReadyMs, computeEndMs, overlapEfficiency = 1 }) {
  finite(flashReadyMs, 'flashReadyMs');
  finite(computeEndMs, 'computeEndMs');
  finite(overlapEfficiency, 'overlapEfficiency');
  if (overlapEfficiency > 1) throw new RangeError('overlapEfficiency must be <= 1');
  const hiddenByComputeMs = Math.min(flashReadyMs, computeEndMs * overlapEfficiency);
  return Math.max(0, flashReadyMs - hiddenByComputeMs);
}

function predictTokenFromMeasuredComponents({ computeMs, exposedFlashWaitMs: flashWaitMs, residualMs = 0 }) {
  finite(computeMs, 'computeMs');
  finite(flashWaitMs, 'exposedFlashWaitMs');
  finite(residualMs, 'residualMs');
  const tpotMs = computeMs + flashWaitMs + residualMs;
  return { tpotMs, tps: tpotMs > EPS ? 1000 / tpotMs : Infinity, computeMs, exposedFlashWaitMs: flashWaitMs, residualMs };
}

function predictBackendFromAnchor({ anchorId, targetBackend, computeScale = null, preserveExposedFlashWait = true, residualScale = 1 }) {
  const anchor = measurementById(anchorId);
  if (!anchor) throw new Error(`Unknown measurement anchor: ${anchorId}`);
  const parts = decomposeMeasurement(anchor);
  if (parts.computeMs === null) throw new Error('Anchor lacks measured computeMs; use an offload measurement with compute decomposition.');
  let scale = computeScale;
  let scaleEvidence = 'explicit';
  if (scale === null && anchor.backend === 'cpu' && targetBackend === 'gpu') {
    const ratio = measuredDenseBackendRatio(anchor.hardwareId, 'gemma4-e4b', 'gpu', 'cpu');
    if (!ratio) throw new Error('No same-device CPU/GPU calibration pair available.');
    scale = ratio.latencyRatio;
    scaleEvidence = ratio.evidence;
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('A positive computeScale is required. NPU is intentionally not inferred from TOPS alone.');
  }
  const computeMs = parts.computeMs * scale;
  const flashWaitMs = preserveExposedFlashWait ? parts.exposedFlashWaitMs : 0;
  const residualMs = Math.max(0, parts.residualMs || 0) * residualScale;
  return {
    schema: MOBILE_AP_SCHEMA,
    anchorId,
    targetBackend,
    prediction: predictTokenFromMeasuredComponents({ computeMs, exposedFlashWaitMs: flashWaitMs, residualMs }),
    calibration: { computeScale: scale, evidence: scaleEvidence, flashPolicy: preserveExposedFlashWait ? 'preserve-exposed-wait' : 'caller-recompute-required' },
    confidence: targetBackend === 'gpu' && scaleEvidence === 'same-device-same-model-measured' ? 'medium' : 'low',
    warning: preserveExposedFlashWait ? 'Compute acceleration can reduce overlap and increase exposed Flash wait; recompute from a raw Flash timeline when available.' : null
  };
}

function calibrationReport() {
  const rows = MOBILE_AP_MEASUREMENTS.map(measurement => ({ id: measurement.id, ...decomposeMeasurement(measurement) }));
  const denseGpuCpu = measuredDenseBackendRatio('sm8850_galaxy', 'gemma4-e4b');
  return {
    schema: MOBILE_AP_SCHEMA,
    rows,
    denseGpuCpu,
    validationAnchors: {
      sm8850GemmaResidualMs: rows.find(x => x.id === 's26-sm8850-gemma4-26b-a4b-cpu-offload')?.residualMs ?? null,
      sm8750GemmaResidualMs: rows.find(x => x.id === 's25-sm8750-gemma4-26b-a4b-cpu-offload')?.residualMs ?? null
    }
  };
}

const api = {
  MOBILE_AP_SCHEMA,
  MOBILE_AP_HARDWARE,
  MOBILE_AP_MEASUREMENTS,
  measurementById,
  decomposeMeasurement,
  measuredDenseBackendRatio,
  rooflineLatencyMs,
  exposedFlashWaitMs,
  predictTokenFromMeasuredComponents,
  predictBackendFromAnchor,
  calibrationReport
};

if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis === 'object') globalThis.MobileAPRoofline = Object.freeze(api);
