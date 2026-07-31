'use strict';

const GUIDED_HW_PRESETS = Object.freeze({
  'synthetic-discrete': Object.freeze({
    label: 'Synthetic discrete baseline',
    values: Object.freeze({ arch: 'discrete', host: 128, vram: 8, dramBW: 273, pcieBW: 24, ssdBW: 9.2, lat: 120, qd: 8 })
  }),
  'synthetic-discrete-large': Object.freeze({
    label: 'Synthetic discrete high-capacity',
    values: Object.freeze({ arch: 'discrete', host: 256, vram: 24, dramBW: 350, pcieBW: 32, ssdBW: 14, lat: 90, qd: 16 })
  }),
  'synthetic-unified': Object.freeze({
    label: 'Synthetic unified baseline',
    values: Object.freeze({ arch: 'unified', host: 128, dramBW: 273, ssdBW: 9.2, lat: 120 })
  })
});

const GUIDED_RESOURCE_LABELS = Object.freeze({
  storage: 'Storage',
  'data-movement': 'Data movement',
  compute: 'Compute',
  'capacity-policy': 'Capacity / policy'
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

function guidedSweepSelections(insight, config) {
  const catalog = sweepCatalogForConfig(config);
  const descriptors = new Map(catalog.map(item => [item.path, item]));
  const selections = [];
  for (const item of guidedRankBottlenecks(insight, config)) {
    const descriptor = descriptors.get(item.parameterPath);
    if (!descriptor) continue;
    const baseline = sweepValueAtPath(config, descriptor.path);
    const values = autoSweepValues(descriptor, baseline).slice(0, 5);
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

function applyGuidedHardwarePreset(id) {
  const preset = GUIDED_HW_PRESETS[id];
  if (!preset) return false;
  for (const [controlId, value] of Object.entries(preset.values)) {
    const control = typeof $ === 'function' ? $(controlId) : null;
    if (control) control.value = String(value);
  }
  if (typeof syncModeControls === 'function') syncModeControls(false);
  return true;
}

function markGuidedHardwareCustom() {
  const preset = typeof $ === 'function' ? $('hardwarePreset') : null;
  if (preset) preset.value = 'custom';
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
  target.innerHTML = `<div class="guidedBottleneckGrid">${ranked.map((item, index) => `<article class="guidedBottleneck"><span class="rank">0${index + 1}</span><div><b>${advisorEscape(item.resourceLabel)}</b><small>${advisorEscape(item.phaseLabel)} · 상대 압력 ${item.score}/100</small><p>${advisorEscape(item.direction)}</p><p class="tradeoff"><b>Trade-off</b> ${advisorEscape(item.tradeoff)}</p></div></article>`).join('')}</div><div class="guidedSweepPlan"><b>검증 계획</b><span>${selections.map(selection => `${advisorEscape(selection.path)} · OAT ${selection.values.length}점`).join(' + ') || '현재 config에서 자동 sweep 가능한 parameter가 없습니다.'}</span></div>`;
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
  target.innerHTML = `<div><span>Baseline aggregate TPS</span><b>${fmt(summary.baselineAggregateTPS, 2)}</b></div><div><span>최고 measured 개선</span><b class="${summary.bestImprovementPct >= 0 ? 'good' : 'bad'}">${sign(summary.bestImprovementPct)}</b></div><div><span>Measured 범위</span><b>${sign(summary.worstImprovementPct)} → ${sign(summary.bestImprovementPct)}</b></div><div><span>최적 변경</span><b>${advisorEscape(Object.entries(summary.bestChanges).map(([key, value]) => `${key}=${value}`).join(', '))}</b></div>`;
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
    if (event.target.value !== 'custom' && applyGuidedHardwarePreset(event.target.value)) render(simulate());
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
