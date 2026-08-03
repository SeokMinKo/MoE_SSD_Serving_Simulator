'use strict';

const THEME_STORAGE_KEY = 'moe-ssd-theme';

function normalizedTheme(theme) {
  return theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, options = {}) {
  const selected = normalizedTheme(theme);
  const root = options.root || (typeof document === 'object' ? document.documentElement : null);
  const button = options.button || (typeof $ === 'function' ? $('themeToggle') : null);
  const storage = Object.prototype.hasOwnProperty.call(options, 'storage')
    ? options.storage
    : typeof local스토리지 === 'undefined' ? null : local스토리지;
  root?.setAttribute('data-theme', selected);
  if (button) {
    const light = selected === 'light';
    button.textContent = light ? '어둡게' : '밝게';
    button.setAttribute('aria-label', light ? '어두운 테마로 전환' : '밝은 테마로 전환');
    button.setAttribute('aria-pressed', String(light));
  }
  if (options.persist !== false && storage) {
    try {
      storage.setItem(THEME_STORAGE_KEY, selected);
    } catch (error) {
      console.warn('테마 설정 저장 실패', { message: error.message });
    }
  }
  if (options.redraw !== false) {
    if (typeof lastResult === 'object' && lastResult && !lastResult.error) {
      drawPerformance(lastResult); render스토리지IO(lastResult); drawMemory(lastResult);
    }
    if (typeof activeSweepExecution === 'object' && activeSweepExecution && typeof renderSweepResults === 'function') renderSweepResults(activeSweepExecution);
  }
  return selected;
}

function initializeTheme(options = {}) {
  const root = options.root || (typeof document === 'object' ? document.documentElement : null);
  const button = options.button || (typeof $ === 'function' ? $('themeToggle') : null);
  const storage = Object.prototype.hasOwnProperty.call(options, 'storage')
    ? options.storage
    : typeof local스토리지 === 'undefined' ? null : local스토리지;
  const media = options.media || (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null);
  let stored = null;
  if (storage) {
    try {
      stored = storage.getItem(THEME_STORAGE_KEY);
    } catch (error) {
      console.warn('테마 설정 읽기 실패', { message: error.message });
    }
  }
  let current = stored === 'light' || stored === 'dark' ? stored : media?.matches ? 'light' : 'dark';
  current = applyTheme(current, { ...options, root, button, storage, persist: false });
  if (button) button.onclick = () => {
    current = applyTheme(current === 'light' ? 'dark' : 'light', { ...options, root, button, storage, persist: true });
  };
  return current;
}

const GUIDED_HW_PRESETS = Object.freeze({
  'nvidia-dgx-spark-128': Object.freeze({
    label: 'NVIDIA DGX Spark · 128 GB',
    sourceUrl: 'https://www.nvidia.com/en-us/products/workstations/dgx-spark/',
    sourced: '128 GB coherent unified memory · 273 GB/s memory bandwidth',
    manual: 'effective SSD bandwidth, storage latency/QD, and model runtime compute calibration',
    values: Object.freeze({ arch: 'unified', host: 128, dramBW: 273 })
  }),
  'apple-macbook-pro-m5-max-128': Object.freeze({
    label: 'Apple MacBook Pro · M5 Max · 128 GB',
    sourceUrl: 'https://support.apple.com/en-us/126318',
    sourced: '128 GB unified memory · 614 GB/s memory bandwidth',
    manual: 'effective SSD bandwidth, storage latency/QD, and model runtime compute calibration',
    values: Object.freeze({ arch: 'unified', host: 128, dramBW: 614 })
  }),
  'apple-mac-studio-m3-ultra-512': Object.freeze({
    label: 'Apple Mac Studio · M3 Ultra · 512 GB',
    sourceUrls: Object.freeze([
      'https://www.apple.com/newsroom/2025/03/apple-reveals-m3-ultra-taking-apple-silicon-to-a-new-extreme/',
      'https://support.apple.com/en-us/122211'
    ]),
    sourceLabels: Object.freeze(['512 GB memory source', '819 GB/s bandwidth source']),
    sourced: '512 GB unified memory · 819 GB/s memory bandwidth',
    manual: 'effective SSD bandwidth, storage latency/QD, and model runtime compute calibration',
    values: Object.freeze({ arch: 'unified', host: 512, dramBW: 819 })
  }),
  'nvidia-rtx-5090-32': Object.freeze({
    label: 'NVIDIA GeForce RTX 5090 · 32 GB',
    sourceUrl: 'https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/',
    sourced: '32 GB VRAM · discrete GPU architecture',
    manual: 'host RAM, host DRAM bandwidth, effective PCIe bandwidth, SSD service values, and model runtime compute calibration',
    values: Object.freeze({ arch: 'discrete', vram: 32 })
  }),
  'amd-radeon-pro-w7900-48': Object.freeze({
    label: 'AMD Radeon PRO W7900 · 48 GB',
    sourceUrl: 'https://www.amd.com/en/products/graphics/workstations/radeon-pro/w7900.html',
    sourced: '48 GB VRAM · discrete GPU architecture',
    manual: 'host RAM, host DRAM bandwidth, effective PCIe bandwidth, SSD service values, and model runtime compute calibration',
    values: Object.freeze({ arch: 'discrete', vram: 48 })
  })
});

const GUIDED_RESOURCE_LABELS = Object.freeze({
  storage: '스토리지',
  'data-movement': '데이터 이동',
  compute: '연산',
  'capacity-policy': '용량 / 정책'
});

function guidedSweepParameterFor(resourceId, config) {
  if (resourceId === 'storage') return 'ssdBW';
  if (resourceId === 'data-movement') {
    if (config?.mode === 'afm3') return 'patchBW';
    return config?.arch === 'discrete' ? 'pcieBW' : 'dramBW';
  }
  if (resourceId === 'compute') return config?.mode === 'afm3' ? 'ffn' : 'attn';
  if (resourceId === 'capacity-policy') return 'host';
  return null;
}

function guidedRankBottlenecks(insight, config = null) {
  if (!insight || !Array.isArray(insight.phases)) return [];
  const strongest = new Map();
  for (const phase of insight.phases) {
    for (const resource of phase.resources || []) {
      const current = strongest.get(resource.id);
      if (!current || resource.score > current.score) {
        strongest.set(resource.id, {
          resourceId: resource.id,
          resourceLabel: GUIDED_RESOURCE_LABELS[resource.id] || resource.label,
          score: resource.score,
          phaseId: phase.id,
          phaseLabel: phase.label,
          tradeoff: resource.recommendation?.tradeoff || '',
          direction: resource.recommendation?.direction || '',
          parameterPath: config ? guidedSweepParameterFor(resource.id, config) : null
        });
      }
    }
  }
  return [...strongest.values()].sort((a, b) => b.score - a.score || a.resourceId.localeCompare(b.resourceId)).slice(0, 2);
}

function guidedSweepValues(descriptor, baseline) {
  if (descriptor?.type !== 'number' || !Number.isFinite(baseline)) return autoSweepValues(descriptor, baseline);
  const ratios = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];
  const values = ratios.map(ratio => clamp(baseline * ratio, descriptor.min, descriptor.max)).map(value => descriptor.integer ? Math.round(value) : Number(value.toPrecision(12)));
  return [...new Set(values)].sort((a, b) => a - b);
}

function guidedSweepSelections(insight, config) {
  const catalog = sweepCatalogForConfig(config);
  const descriptors = new Map(catalog.map(item => [item.path, item]));
  const selections = [];
  for (const item of guidedRankBottlenecks(insight, config)) {
    const descriptor = descriptors.get(item.parameterPath);
    if (!descriptor) continue;
    const baseline = sweepValueAtPath(config, descriptor.path);
    const values = guidedSweepValues(descriptor, baseline);
    if (values.length < 2 || values.every(value => stableValue(value) === stableValue(baseline))) continue;
    selections.push({ path: descriptor.path, values, resourceId: item.resourceId, score: item.score });
  }
  return selections.slice(0, 2);
}

function guidedThroughputSummary(execution) {
  if (execution?.status !== 'completed' || execution?.baselineMetrics?.status !== 'completed') return { measured: false };
  const baseline = execution?.baselineMetrics?.aggregateTPS;
  if (!(Number.isFinite(baseline) && baseline > 0)) return { measured: false };
  const completed = (execution.results || []).filter(row => row?.metrics?.status === 'completed' && Number.isFinite(row.metrics.aggregateTPS));
  if (!completed.length) return { measured: false };
  const sorted = [...completed].sort((a, b) => a.metrics.aggregateTPS - b.metrics.aggregateTPS);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];
  const percent = value => Math.round((value / baseline - 1) * 10000) / 100;
  return {
    measured: true,
    baselineAggregateTPS: baseline,
    bestAggregateTPS: best.metrics.aggregateTPS,
    worstAggregateTPS: worst.metrics.aggregateTPS,
    bestImprovementPct: percent(best.metrics.aggregateTPS),
    worstImprovementPct: percent(worst.metrics.aggregateTPS),
    bestChanges: sweepClone(best.changes),
    completedScenarios: completed.length
  };
}

function guidedSweepMatchesResult(execution, result) {
  if (!execution?.baselineConfig || !result?.c) return false;
  return stableValue(execution.baselineConfig) === stableValue(result.c);
}

function createGuidedSweepContract(selections) {
  return {
    schema: 'guided-oat/v1',
    objective: 'aggregateTPS',
    selections: (selections || []).slice(0, 2).map(selection => ({ path: selection.path, values: sweepClone(selection.values) }))
  };
}

function guidedSweepMatchesAnalysis(execution, result, insight) {
  if (!guidedSweepMatchesResult(execution, result)) return false;
  if (execution.status !== 'completed' || execution.baselineMetrics?.status !== 'completed') return false;
  if (execution.definition?.mode !== 'oat' || execution.guidedContract?.schema !== 'guided-oat/v1' || execution.guidedContract.objective !== 'aggregateTPS') return false;
  const expected = createGuidedSweepContract(guidedSweepSelections(insight, result.c));
  const actual = createGuidedSweepContract(execution.selections);
  if (expected.selections.length === 0 || stableValue(execution.guidedContract.selections) !== stableValue(expected.selections) || stableValue(actual.selections) !== stableValue(expected.selections)) return false;
  const allowed = new Map(expected.selections.map(selection => [selection.path, new Set(selection.values.map(stableValue))]));
  const rowsMatch = rows => Array.isArray(rows) && rows.length > 0 && rows.every(row => {
    const changes = Object.entries(row?.changes || {});
    return changes.length === 1 && allowed.get(changes[0][0])?.has(stableValue(changes[0][1]));
  });
  return rowsMatch(execution.scenarios) && rowsMatch(execution.results) && execution.scenarios.length === execution.results.length;
}

function guidedScrollBehavior(targetWindow) {
  if (!targetWindow?.matchMedia) return 'auto';
  return targetWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function renderGuidedHardwarePresetSummary(preset) {
  const target = typeof $ === 'function' ? $('hardwarePresetSummary') : null;
  if (!target) return;
  if (!preset) {
    target.innerHTML = '<b>사용자 지정 하드웨어 입력</b> · No product target is selected; all hardware and storage values are manual.';
    return;
  }
  const sourceUrls = Array.isArray(preset.sourceUrls) ? preset.sourceUrls : [preset.sourceUrl];
  const sourceLinks = sourceUrls.flatMap((url, index) => {
    const safeUrl = typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
    if (!safeUrl) return [];
    const label = Array.isArray(preset.sourceLabels) && preset.sourceLabels[index] ? preset.sourceLabels[index] : '공식 사양';
    return [`<a href="${presetHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${presetHtml(label)}</a>`];
  });
  const source = sourceLinks.length ? sourceLinks.join(' · ') : '출처를 사용할 수 없음';
  target.innerHTML = `<b>${presetHtml(preset.label)}</b><br>Applied from source: ${presetHtml(preset.sourced)} · ${source}<br>` +
    `System- and workload-dependent fields remain unchanged: ${presetHtml(preset.manual)}.`;
}

function applyGuidedHardwarePreset(id) {
  if (id === 'custom') {
    renderGuidedHardwarePresetSummary(null);
    return true;
  }
  if (!Object.hasOwn(GUIDED_HW_PRESETS, id)) return false;
  const preset = GUIDED_HW_PRESETS[id];
  for (const [controlId, value] of Object.entries(preset.values)) {
    const control = typeof $ === 'function' ? $(controlId) : null;
    if (control) control.value = String(value);
  }
  renderGuidedHardwarePresetSummary(preset);
  if (typeof syncModeControls === 'function') syncModeControls(false);
  return true;
}

function markGuidedHardwareCustom() {
  const preset = typeof $ === 'function' ? $('hardwarePreset') : null;
  if (preset) preset.value = 'custom';
  renderGuidedHardwarePresetSummary(null);
}

function setGuidedStep(step) {
  if (typeof document?.querySelectorAll !== 'function') return;
  document.querySelectorAll('[data-guide-step]').forEach(button => {
    const current = Number(button.dataset.guideStep) === step;
    if (current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
}

function renderGuidedAnalysis(insight, result = null) {
  const target = typeof $ === 'function' ? $('guidedAnalysisContent') : null;
  if (!target) return;
  const summary = $('guidedSweepSummary');
  const execution = typeof activeSweepExecution === 'undefined' ? null : activeSweepExecution;
  if (summary && !guidedSweepMatchesResult(execution, result)) {
    summary.innerHTML = '<span>현재 scenario에 대한 counterfactual 결과가 없습니다.</span>';
  }
  const config = result?.c || (typeof readCurrentSweepConfig === 'function' ? readCurrentSweepConfig() : null);
  const ranked = guidedRankBottlenecks(insight, config);
  const selections = config ? guidedSweepSelections(insight, config) : [];
  if (!ranked.length || !result || result.error) {
    target.innerHTML = '<div class="guidedEmpty">유효한 simulation을 실행하면 상위 병목 2개와 검증할 parameter를 제안합니다.</div>';
    $('runGuidedSweep').disabled = true;
    return;
  }
  target.innerHTML = `<div class="guidedBottleneckGrid">${ranked.map((item, index) => `<article class="guidedBottleneck"><span class="rank">0${index + 1}</span><div><b>${advisorEscape(item.resourceLabel)}</b><small>${advisorEscape(item.phaseLabel)} · 상대 압력 ${item.score}/100</small><p>${advisorEscape(item.direction)}</p><p class="tradeoff"><b>부작용</b> ${advisorEscape(item.tradeoff)}</p></div></article>`).join('')}</div><div class="guidedSweepPlan"><b>검증 계획</b><span>${selections.map(selection => `${advisorEscape(selection.path)} · OAT ${selection.values.length}점`).join(' + ') || '현재 config에서 자동 sweep 가능한 parameter가 없습니다.'}</span></div>`;
  $('runGuidedSweep').disabled = selections.length === 0;
}

function renderGuidedSweepSummary(execution) {
  const target = typeof $ === 'function' ? $('guidedSweepSummary') : null;
  if (!target) return;
  const result = typeof lastResult === 'undefined' ? null : lastResult;
  const insight = result ? createBottleneckInsight(result) : null;
  if (!guidedSweepMatchesAnalysis(execution, result, insight)) {
    target.innerHTML = '<span>상위 병목 자동 분석으로 완료된 OAT 결과만 여기에 표시됩니다.</span>';
    return;
  }
  const summary = guidedThroughputSummary(execution);
  if (!summary.measured) {
    target.innerHTML = '<span>아직 완료된 counterfactual 결과가 없습니다.</span>';
    return;
  }
  const sign = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  target.innerHTML = `<div><span>기준 전체 TPS</span><b>${fmt(summary.baselineAggregateTPS, 2)}</b></div><div><span>최고 measured 개선</span><b class="${summary.bestImprovementPct >= 0 ? 'good' : 'bad'}">${sign(summary.bestImprovementPct)}</b></div><div><span>실측 범위</span><b>${sign(summary.worstImprovementPct)} → ${sign(summary.bestImprovementPct)}</b></div><div><span>최적 변경</span><b>${advisorEscape(Object.entries(summary.bestChanges).map(([key, value]) => `${key}=${value}`).join(', '))}</b></div>`;
  if (execution?.status === 'completed') setGuidedStep(3);
}

function prepareGuidedSweep() {
  if (!lastResult || lastResult.error) return;
  const insight = createBottleneckInsight(lastResult);
  const selections = guidedSweepSelections(insight, lastResult.c);
  if (!selections.length) return;
  sweepSelectedPaths = new Set(selections.map(selection => selection.path));
  sweepParameterDrafts.clear();
  for (const selection of selections) {
    sweepParameterDrafts.set(selection.path, {
      strategy: 'custom',
      min: selection.values[0],
      max: selection.values[selection.values.length - 1],
      step: 5,
      custom: selection.values.join(', ')
    });
  }
  $('sweepMode').value = 'oat';
  renderSweepParameterPicker();
  sweepOpener = $('runGuidedSweep');
  $('sweepLab').showModal();
  runSweepFromUI({ guidedContract: createGuidedSweepContract(selections) });
}

function initializeGuidedUI() {
  const controls = typeof $ === 'function' ? $('guidedControls') : null;
  if (!controls) return;
  const expert = $('expertModeToggle');
  expert.onclick = () => {
    const enabled = controls.classList.toggle('expert-enabled');
    expert.setAttribute('aria-pressed', String(enabled));
    expert.textContent = enabled ? 'Expert mode 닫기' : 'Expert mode 열기';
  };
  $('hardwarePreset').onchange = event => {
    if (applyGuidedHardwarePreset(event.target.value) && event.target.value !== 'custom') render(simulate());
  };
  for (const id of ['arch', 'host', 'vram', 'dramBW', 'pcieBW', 'ssdBW', 'lat', 'qd']) {
    const control = $(id);
    if (control) control.addEventListener('input', markGuidedHardwareCustom);
  }
  document.querySelectorAll('[data-guide-step]').forEach(button => button.onclick = () => {
    const step = Number(button.dataset.guideStep);
    setGuidedStep(step);
    const destination = step === 1 ? controls : step === 2 ? $('advisor') : $('guidedAnalysis');
    destination?.scrollIntoView({ behavior: guidedScrollBehavior(typeof window === 'undefined' ? null : window), block: 'start' });
  });
  $('runGuidedSweep').onclick = prepareGuidedSweep;
  setGuidedStep(1);
}
