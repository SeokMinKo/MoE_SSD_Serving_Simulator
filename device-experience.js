'use strict';

const DEVICE_EXPERIENCE_SCHEMA = 'device-experience/v1';

function deviceNumber(id, fallback) {
  const element = typeof document === 'object' ? document.getElementById(id) : null;
  if (!element) return fallback;
  const value = Number(element.value);
  return Number.isFinite(value) ? value : fallback;
}

function deviceInteger(id, fallback) {
  const value = deviceNumber(id, fallback);
  return Number.isSafeInteger(value) ? value : fallback;
}

function deviceValue(id, fallback) {
  const element = typeof document === 'object' ? document.getElementById(id) : null;
  return element ? element.value : fallback;
}

function deviceReadComputeConfig(base) {
  return {
    mode: 'calibrated',
    attentionDevice: deviceValue('deviceAttentionDevice', 'gpu'),
    expertDevice: deviceValue('deviceExpertDevice', 'gpu'),
    cpu: {
      speedScale: deviceNumber('deviceCpuSpeedScale', 1),
      attentionMs: deviceNumber('deviceCpuAttentionMs', base.attn),
      expertMs: deviceNumber('deviceCpuExpertMs', base.ems),
      parallelExperts: deviceInteger('deviceCpuParallelExperts', base.par),
      prefillSpeedup: deviceNumber('deviceCpuPrefillSpeedup', base.prefillSpeedup)
    },
    gpu: {
      speedScale: deviceNumber('deviceGpuSpeedScale', 1),
      attentionMs: deviceNumber('deviceGpuAttentionMs', base.attn),
      expertMs: deviceNumber('deviceGpuExpertMs', base.ems),
      parallelExperts: deviceInteger('deviceGpuParallelExperts', base.par),
      prefillSpeedup: deviceNumber('deviceGpuPrefillSpeedup', base.prefillSpeedup)
    },
    hybrid: {
      cpuExpertFraction: deviceNumber('deviceCpuExpertFraction', 0.25),
      execution: deviceValue('deviceHybridExecution', 'parallel'),
      overlapEfficiency: deviceNumber('deviceOverlapEfficiency', 1)
    }
  };
}

function deviceReadQuantizationConfig(base) {
  return {
    payloadMode: deviceValue('devicePayloadMode', 'manual'),
    format: deviceValue('deviceQuantFormat', 'int4'),
    weightBits: deviceNumber('deviceWeightBits', 4),
    packing: deviceNumber('devicePacking', 1.08),
    expertParamsM: deviceNumber('deviceExpertParamsM', 35),
    manualExpertMB: deviceNumber('deviceManualExpertMB', base.esize),
    cpuKernelMultiplier: deviceNumber('deviceCpuKernelMultiplier', 1),
    gpuKernelMultiplier: deviceNumber('deviceGpuKernelMultiplier', 1),
    dequantMode: deviceValue('deviceDequantMode', 'fused'),
    cpuDequantBW: deviceNumber('deviceCpuDequantBW', 25),
    gpuDequantBW: deviceNumber('deviceGpuDequantBW', 600)
  };
}

function deviceDequantCostMs(activeExperts, expertMB, bandwidthGBs) {
  if (!(activeExperts > 0) || !(expertMB > 0) || !(bandwidthGBs > 0)) return 0;
  return activeExperts * expertMB / bandwidthGBs;
}

function deviceInstallModelExtensions() {
  if (globalThis.__DEVICE_EXPERIENCE_MODEL_INSTALLED__) return false;

  if (typeof readColibri === 'function') {
    const originalReadColibri = readColibri;
    readColibri = function readDeviceAwareColibri() {
      const config = originalReadColibri();
      if (deviceValue('deviceComputeMode', 'legacy') !== 'calibrated') return config;
      return {
        ...config,
        compute: deviceReadComputeConfig(config),
        quantization: deviceReadQuantizationConfig(config)
      };
    };
  }

  if (typeof colibriLayerCompute === 'function') {
    const originalLayerCompute = colibriLayerCompute;
    colibriLayerCompute = function deviceDequantLayerCompute(c, profile, cpuActive, gpuActive, prefill = false) {
      const result = originalLayerCompute(c, profile, cpuActive, gpuActive, prefill);
      const quantization = c?.quantization || {};
      if (profile?.mode !== 'calibrated' || quantization.dequantMode !== 'separate') return result;
      const expertMB = profile?.quantization?.effectiveExpertMB || c.esize || 0;
      const cpuDequantMs = deviceDequantCostMs(cpuActive, expertMB, quantization.cpuDequantBW);
      const gpuDequantMs = deviceDequantCostMs(gpuActive, expertMB, quantization.gpuDequantBW);
      const cpuExpertMs = result.cpuExpertMs + cpuDequantMs;
      const gpuExpertMs = result.gpuExpertMs + gpuDequantMs;
      const exposedExpertMs = typeof combineColibriDevicePhases === 'function'
        ? combineColibriDevicePhases(cpuExpertMs, gpuExpertMs, profile.execution, profile.overlapEfficiency)
        : cpuExpertMs + gpuExpertMs;
      return {
        ...result,
        cpuExpertMs,
        gpuExpertMs,
        exposedExpertMs,
        totalMs: result.attentionMs + result.runtimeMs + exposedExpertMs,
        dequantMs: cpuDequantMs + gpuDequantMs,
        cpuDequantMs,
        gpuDequantMs
      };
    };
  }

  if (typeof validateDeviceComputeConfig === 'function') {
    const originalValidate = validateDeviceComputeConfig;
    validateDeviceComputeConfig = function validateDeviceExperienceConfig(config) {
      const result = originalValidate(config);
      const q = config?.quantization;
      if (!q || config?.compute?.mode !== 'calibrated') return result;
      const errors = [...result.errors];
      const add = (path, message) => errors.push({ path, code: 'OUT_OF_RANGE', message });
      const dequantMode = q.dequantMode === undefined ? 'fused' : q.dequantMode;
      if (!['fused', 'separate'].includes(dequantMode)) add('quantization.dequantMode', 'quantization.dequantMode must be fused or separate.');
      if (dequantMode === 'separate') {
        if (!Number.isFinite(q.cpuDequantBW) || q.cpuDequantBW <= 0) add('quantization.cpuDequantBW', 'quantization.cpuDequantBW must be positive.');
        if (!Number.isFinite(q.gpuDequantBW) || q.gpuDequantBW <= 0) add('quantization.gpuDequantBW', 'quantization.gpuDequantBW must be positive.');
      }
      return { valid: errors.length === 0, errors };
    };
  }

  if (typeof sweepCatalogForConfig === 'function' && typeof sweepDescriptor === 'function') {
    const originalCatalog = sweepCatalogForConfig;
    sweepCatalogForConfig = function deviceSweepCatalog(config) {
      const catalog = originalCatalog(config);
      if (config?.mode !== 'colibri' || config?.compute?.mode !== 'calibrated') return catalog;
      const extra = [
        sweepDescriptor('compute.attentionDevice', 'Compute', 0, 0, { type: 'enum', values: ['cpu', 'gpu'] }),
        sweepDescriptor('compute.expertDevice', 'Compute', 0, 0, { type: 'enum', values: ['cpu', 'gpu', 'hybrid'] }),
        sweepDescriptor('compute.cpu.speedScale', 'Compute', 0.001, 1000),
        sweepDescriptor('compute.cpu.attentionMs', 'Compute', 0, 1e6),
        sweepDescriptor('compute.cpu.expertMs', 'Compute', 0, 1e6),
        sweepDescriptor('compute.cpu.parallelExperts', 'Compute', 1, 4096, { integer: true }),
        sweepDescriptor('compute.cpu.prefillSpeedup', 'Compute', 0.001, 1e6),
        sweepDescriptor('compute.gpu.speedScale', 'Compute', 0.001, 1000),
        sweepDescriptor('compute.gpu.attentionMs', 'Compute', 0, 1e6),
        sweepDescriptor('compute.gpu.expertMs', 'Compute', 0, 1e6),
        sweepDescriptor('compute.gpu.parallelExperts', 'Compute', 1, 4096, { integer: true }),
        sweepDescriptor('compute.gpu.prefillSpeedup', 'Compute', 0.001, 1e6),
        sweepDescriptor('compute.hybrid.cpuExpertFraction', 'Compute', 0, 1),
        sweepDescriptor('compute.hybrid.execution', 'Compute', 0, 0, { type: 'enum', values: ['parallel', 'sequential'] }),
        sweepDescriptor('compute.hybrid.overlapEfficiency', 'Compute', 0, 1),
        sweepDescriptor('quantization.payloadMode', 'Model', 0, 0, { type: 'enum', values: ['manual', 'derived'] }),
        sweepDescriptor('quantization.weightBits', 'Model', 1, 16),
        sweepDescriptor('quantization.packing', 'Model', 1, 10),
        sweepDescriptor('quantization.expertParamsM', 'Model', 0.001, 1e6),
        sweepDescriptor('quantization.manualExpertMB', 'Model', 0.001, 1e6),
        sweepDescriptor('quantization.cpuKernelMultiplier', 'Compute', 0.001, 1000),
        sweepDescriptor('quantization.gpuKernelMultiplier', 'Compute', 0.001, 1000),
        sweepDescriptor('quantization.dequantMode', 'Compute', 0, 0, { type: 'enum', values: ['fused', 'separate'] }),
        sweepDescriptor('quantization.cpuDequantBW', 'Compute', 0.001, 1e6),
        sweepDescriptor('quantization.gpuDequantBW', 'Compute', 0.001, 1e6)
      ];
      const paths = new Set(catalog.map(item => item.path));
      return [...catalog, ...extra.filter(item => !paths.has(item.path))];
    };
  }

  if (typeof advisorQueueFraction === 'function') {
    const originalQueueFraction = advisorQueueFraction;
    advisorQueueFraction = function deviceAdvisorQueueFraction(serving, resourceName, phase) {
      if (resourceName !== 'compute' || serving?.resources?.compute) return originalQueueFraction(serving, resourceName, phase);
      return Math.max(
        originalQueueFraction(serving, 'cpuCompute', phase),
        originalQueueFraction(serving, 'gpuCompute', phase)
      );
    };
  }

  if (typeof advisorPhaseResource === 'function') {
    const originalPhaseResource = advisorPhaseResource;
    advisorPhaseResource = function deviceAdvisorPhaseResource(serving, resourceName, phase) {
      if (resourceName !== 'compute' || serving?.resources?.compute) return originalPhaseResource(serving, resourceName, phase);
      const cpu = originalPhaseResource(serving, 'cpuCompute', phase);
      const gpu = originalPhaseResource(serving, 'gpuCompute', phase);
      if (!cpu && !gpu) return null;
      return {
        jobs: (cpu?.jobs || 0) + (gpu?.jobs || 0),
        workGB: 0,
        busyMs: (cpu?.busyMs || 0) + (gpu?.busyMs || 0),
        queueMs: (cpu?.queueMs || 0) + (gpu?.queueMs || 0)
      };
    };
  }

  globalThis.__DEVICE_EXPERIENCE_MODEL_INSTALLED__ = Object.freeze({ schema: DEVICE_EXPERIENCE_SCHEMA });
  return true;
}

function deviceField(label, id, type, value, attributes = '') {
  return `<div class="f deviceControl"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${value}" ${attributes}></div>`;
}

function deviceSelect(label, id, options) {
  return `<div class="f deviceControl"><label for="${id}">${label}</label><select id="${id}">${options.map(([value, text, selected]) => `<option value="${value}"${selected ? ' selected' : ''}>${text}</option>`).join('')}</select></div>`;
}

function deviceInjectControls() {
  if (typeof document !== 'object' || document.getElementById('deviceComputeMode')) return false;
  const anchor = document.getElementById('attn')?.closest('.colibriOnly');
  if (!anchor) return false;
  const section = document.createElement('section');
  section.id = 'deviceComputeControls';
  section.innerHTML = `
    <div class="section">CPU / GPU 연산 모델</div>
    ${deviceSelect('연산 모델', 'deviceComputeMode', [['legacy', '기존 Legacy 보정', true], ['calibrated', 'CPU/GPU Calibrated', false]])}
    <div class="deviceCalibratedOnly">
      ${deviceSelect('Attention 실행 장치', 'deviceAttentionDevice', [['gpu', 'GPU', true], ['cpu', 'CPU', false]])}
      ${deviceSelect('Expert 실행 장치', 'deviceExpertDevice', [['gpu', 'GPU', true], ['cpu', 'CPU', false], ['hybrid', 'CPU + GPU Hybrid', false]])}
      ${deviceField('CPU 속도 배율', 'deviceCpuSpeedScale', 'number', '1', 'min="0.001" step="0.1"')}
      ${deviceField('CPU Attention (ms/토큰)', 'deviceCpuAttentionMs', 'number', '60', 'min="0" step="0.1"')}
      ${deviceField('CPU Expert (ms/Expert)', 'deviceCpuExpertMs', 'number', '2', 'min="0" step="0.1"')}
      ${deviceField('CPU 병렬 Expert 수', 'deviceCpuParallelExperts', 'number', '8', 'min="1" step="1"')}
      ${deviceField('CPU Prefill 가속', 'deviceCpuPrefillSpeedup', 'number', '2', 'min="0.001" step="0.1"')}
      ${deviceField('GPU 속도 배율', 'deviceGpuSpeedScale', 'number', '1', 'min="0.001" step="0.1"')}
      ${deviceField('GPU Attention (ms/토큰)', 'deviceGpuAttentionMs', 'number', '28', 'min="0" step="0.1"')}
      ${deviceField('GPU Expert (ms/Expert)', 'deviceGpuExpertMs', 'number', '0.7', 'min="0" step="0.1"')}
      ${deviceField('GPU 병렬 Expert 수', 'deviceGpuParallelExperts', 'number', '4', 'min="1" step="1"')}
      ${deviceField('GPU Prefill 가속', 'deviceGpuPrefillSpeedup', 'number', '4.5', 'min="0.001" step="0.1"')}
      ${deviceField('Hybrid CPU Expert 비율', 'deviceCpuExpertFraction', 'number', '0.25', 'min="0" max="1" step="0.05"')}
      ${deviceSelect('Hybrid 실행 방식', 'deviceHybridExecution', [['parallel', '병렬', true], ['sequential', '순차', false]])}
      ${deviceField('CPU/GPU 중첩 효율', 'deviceOverlapEfficiency', 'number', '1', 'min="0" max="1" step="0.05"')}
      <div class="section">양자화 / Dequantization</div>
      ${deviceSelect('Expert 크기 입력', 'devicePayloadMode', [['manual', '직접 MB 입력', true], ['derived', '파라미터·bit에서 계산', false]])}
      ${deviceSelect('양자화 형식', 'deviceQuantFormat', [['fp16', 'FP16', false], ['bf16', 'BF16', false], ['int8', 'INT8', false], ['int4', 'INT4', true], ['int2', 'INT2', false], ['custom', 'Custom', false]])}
      ${deviceField('Weight bit', 'deviceWeightBits', 'number', '4', 'min="1" max="16" step="1"')}
      ${deviceField('Packing 배율', 'devicePacking', 'number', '1.08', 'min="1" step="0.01"')}
      ${deviceField('Expert 파라미터 (M)', 'deviceExpertParamsM', 'number', '35', 'min="0.001" step="0.1"')}
      ${deviceField('Expert 직접 크기 (MB)', 'deviceManualExpertMB', 'number', '19', 'min="0.001" step="0.1"')}
      ${deviceField('CPU Expert kernel 배율', 'deviceCpuKernelMultiplier', 'number', '1', 'min="0.001" step="0.05"')}
      ${deviceField('GPU Expert kernel 배율', 'deviceGpuKernelMultiplier', 'number', '1', 'min="0.001" step="0.05"')}
      ${deviceSelect('Dequantization', 'deviceDequantMode', [['fused', 'Kernel에 포함', true], ['separate', '별도 대역폭 비용', false]])}
      ${deviceField('CPU Dequant 대역폭 (GB/s)', 'deviceCpuDequantBW', 'number', '25', 'min="0.001" step="1"')}
      ${deviceField('GPU Dequant 대역폭 (GB/s)', 'deviceGpuDequantBW', 'number', '600', 'min="0.001" step="10"')}
      <div class="note" id="deviceDerivedSummary"></div>
    </div>`;
  anchor.appendChild(section);

  const refresh = () => {
    const calibrated = deviceValue('deviceComputeMode', 'legacy') === 'calibrated';
    section.querySelector('.deviceCalibratedOnly').hidden = !calibrated;
    const payloadMode = deviceValue('devicePayloadMode', 'manual');
    const expertMB = payloadMode === 'derived'
      ? deviceNumber('deviceExpertParamsM', 35) * deviceNumber('deviceWeightBits', 4) / 8 * deviceNumber('devicePacking', 1.08)
      : deviceNumber('deviceManualExpertMB', 19);
    const summary = document.getElementById('deviceDerivedSummary');
    if (summary) summary.textContent = `유효 Expert 크기: ${expertMB.toFixed(3)} MB · 낮은 bit는 kernel 속도를 자동으로 높이지 않습니다.`;
  };
  section.addEventListener('input', refresh);
  section.addEventListener('change', refresh);
  refresh();
  return true;
}

function deviceInstallRenderExtensions() {
  if (globalThis.__DEVICE_EXPERIENCE_RENDER_INSTALLED__) return false;
  if (typeof renderColibri === 'function') {
    const originalRenderColibri = renderColibri;
    renderColibri = function renderDeviceColibri(result) {
      originalRenderColibri(result);
      const serving = result?.serving;
      if (!serving?.resources?.cpuCompute && !serving?.resources?.gpuCompute) return;
      const summary = document.getElementById('summary');
      if (!summary) return;
      const cpu = serving.resources.cpuCompute || {};
      const gpu = serving.resources.gpuCompute || {};
      summary.insertAdjacentHTML('beforeend', `<tr><td>CPU 연산 사용률 / 큐</td><td>${((cpu.utilization || 0) * 100).toFixed(1)}% / ${(cpu.queueMs || 0).toFixed(2)} ms</td></tr><tr><td>GPU 연산 사용률 / 큐</td><td>${((gpu.utilization || 0) * 100).toFixed(1)}% / ${(gpu.queueMs || 0).toFixed(2)} ms</td></tr>`);
    };
  }
  if (typeof renderBottleneckAdvisor === 'function') {
    const originalRenderAdvisor = renderBottleneckAdvisor;
    renderBottleneckAdvisor = function renderDeviceAdvisor(insight) {
      originalRenderAdvisor(insight);
      const result = globalThis.lastResult;
      const serving = result?.serving;
      if (!serving?.resources?.cpuCompute && !serving?.resources?.gpuCompute) return;
      const cpu = serving.resources.cpuCompute || {};
      const gpu = serving.resources.gpuCompute || {};
      const target = document.getElementById('advisor');
      target?.insertAdjacentHTML('beforeend', `<div class="note"><b>장치별 연산 경합:</b> CPU ${((cpu.utilization || 0) * 100).toFixed(1)}% · queue ${(cpu.queueMs || 0).toFixed(2)} ms / GPU ${((gpu.utilization || 0) * 100).toFixed(1)}% · queue ${(gpu.queueMs || 0).toFixed(2)} ms</div>`);
    };
  }
  globalThis.__DEVICE_EXPERIENCE_RENDER_INSTALLED__ = true;
  return true;
}

function installDeviceExperience() {
  deviceInstallModelExtensions();
  deviceInjectControls();
  deviceInstallRenderExtensions();
}

function installDeviceExperienceModel() {
  return deviceInstallModelExtensions();
}

if (typeof document === 'object' && typeof document.addEventListener === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installDeviceExperience, { once: true });
  else Promise.resolve().then(installDeviceExperience);
}
