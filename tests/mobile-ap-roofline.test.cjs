'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const roofline = require('../mobile-ap-roofline.js');

test('measurement decomposition preserves measured TPOT contract', () => {
  const s26 = roofline.measurementById('s26-sm8850-gemma4-26b-a4b-cpu-offload');
  const parts = roofline.decomposeMeasurement(s26);
  assert.ok(Math.abs(parts.tpotMs - 1000 / 5.69) < 1e-12);
  assert.ok(Math.abs(parts.residualMs - (1000 / 5.69 - 104 - 56)) < 1e-12);
  assert.ok(parts.residualMs > 15 && parts.residualMs < 16);
});

test('S25/S26 Gemma anchors show compute parity and exposed Flash improvement', () => {
  const s25 = roofline.measurementById('s25-sm8750-gemma4-26b-a4b-cpu-offload');
  const s26 = roofline.measurementById('s26-sm8850-gemma4-26b-a4b-cpu-offload');
  assert.equal(s25.cacheHit, s26.cacheHit);
  assert.equal(s25.expertCacheMB, s26.expertCacheMB);
  assert.equal(Math.abs(s25.computeMs - s26.computeMs), 1);
  assert.equal(s25.exposedFlashWaitMs - s26.exposedFlashWaitMs, 13);
  assert.ok(s26.tps > s25.tps);
});

test('same-device Gemma E4B gives measured GPU/CPU decode speed ratio', () => {
  const ratio = roofline.measuredDenseBackendRatio('sm8850_galaxy', 'gemma4-e4b');
  assert.ok(ratio);
  assert.ok(Math.abs(ratio.tpsRatio - 21.83 / 15.72) < 1e-12);
  assert.ok(ratio.tpsRatio > 1.38 && ratio.tpsRatio < 1.40);
});

test('roofline chooses the slower compute or memory roof', () => {
  const result = roofline.rooflineLatencyMs({
    operations: 1e12,
    bytes: 10e9,
    peakOpsPerSec: 10e12,
    memoryBandwidthGBs: 100,
    computeEfficiency: 0.5,
    memoryEfficiency: 0.5,
    overheadMs: 2
  });
  assert.equal(result.computeMs, 200);
  assert.equal(result.memoryMs, 200);
  assert.equal(result.totalMs, 202);
});

test('Flash wait is explicitly exposed after overlap', () => {
  assert.equal(roofline.exposedFlashWaitMs({ flashReadyMs: 160, computeEndMs: 104, overlapEfficiency: 1 }), 56);
  assert.equal(roofline.exposedFlashWaitMs({ flashReadyMs: 80, computeEndMs: 104, overlapEfficiency: 1 }), 0);
  assert.equal(roofline.exposedFlashWaitMs({ flashReadyMs: 160, computeEndMs: 104, overlapEfficiency: 0.5 }), 108);
});

test('GPU anchor prediction uses measured same-device CPU/GPU ratio, not peak FLOPS', () => {
  const result = roofline.predictBackendFromAnchor({
    anchorId: 's26-sm8850-gemma4-26b-a4b-cpu-offload',
    targetBackend: 'gpu'
  });
  assert.equal(result.calibration.evidence, 'same-device-same-model-measured');
  assert.equal(result.confidence, 'medium');
  assert.ok(result.prediction.computeMs < 104);
});

test('NPU prediction fails closed without an explicit calibration scale', () => {
  assert.throws(() => roofline.predictBackendFromAnchor({
    anchorId: 's26-sm8850-gemma4-26b-a4b-cpu-offload',
    targetBackend: 'npu'
  }), /computeScale is required/);
});

test('hardware DB labels non-official absolute peak figures', () => {
  assert.equal(roofline.MOBILE_AP_HARDWARE.sm8850_galaxy.npu.peak.int8TOPS, 89.4);
  assert.notEqual(roofline.MOBILE_AP_HARDWARE.sm8850_galaxy.npu.evidence, 'official');
  assert.equal(roofline.MOBILE_AP_HARDWARE.sm8750_galaxy.npu.peak.int8TOPS, 65.25);
  assert.equal(roofline.MOBILE_AP_HARDWARE.sm8750_galaxy.cpu.peakOps, null);
});
