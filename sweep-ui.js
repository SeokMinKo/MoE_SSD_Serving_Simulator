let activeSweepExecution = null;
let sweepTimer = null;
let sweepSelectedPaths = new Set();
let currentSweepCatalog = [];
let sweepOpener = null;
const sweepParameterDrafts = new Map();
let activeSweepWorker = null;
let sweepPreparing = false;
let sweepGeneration = 0;
let sweepScenarioInFlight = false;

function simulateSweepInWorker(config) {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('매개변수 스윕에는 Web Worker 지원이 필요합니다.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker('simulation-worker.js');
    const task = { worker, cancel: null };
    let settled = false;
    let timeout = null;
    activeSweepWorker = task;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.onmessage = null;
      worker.onerror = null;
      if (activeSweepWorker === task) activeSweepWorker = null;
      worker.terminate();
      callback(value);
    };
    task.cancel = () => finish(reject, new Error('스윕 시뮬레이션이 취소되었습니다.'));
    timeout = setTimeout(() => finish(reject, new Error('스윕 시나리오가 30초 작업 제한을 초과했습니다.')), 30000);
    worker.onmessage = event => event.data?.error
      ? finish(reject, new Error(event.data.error))
      : finish(resolve, event.data);
    worker.onerror = event => finish(reject, new Error(event.message || '스윕 시뮬레이션 Worker 실행에 실패했습니다.'));
    try {
      worker.postMessage({ config: sweepClone(config) });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function cancelSweepWorker() {
  activeSweepWorker?.cancel();
}

function captureSweepParameterDrafts() {
  if (typeof document?.querySelectorAll !== 'function') return;
  document.querySelectorAll('[data-sweep-card]').forEach(card => {
    const path = card.dataset.sweepCard;
    const strategy = card.querySelector('[data-sweep-strategy]');
    if (strategy) {
      sweepParameterDrafts.set(path, {
        strategy: strategy.value,
        min: card.querySelector('[data-sweep-min]').value,
        max: card.querySelector('[data-sweep-max]').value,
        step: card.querySelector('[data-sweep-step]').value,
        custom: card.querySelector('[data-sweep-custom]').value
      });
      return;
    }
    sweepParameterDrafts.set(path, {
      selectedValues: [...card.querySelectorAll('[data-category-value]:checked')].map(input => input.dataset.categoryValue)
    });
  });
}

function readCurrentSweepConfig() {
  const mode = $('mode').value;
  if (mode === 'bigmoe-edge') return readBigMoeEdge();
  return mode === 'afm3' ? readAFM() : readColibri();
}

function sweepDataPathHtml(config) {
  return config?.mode === 'bigmoe-edge'
    ? 'SSD/NAND <strong>ssdBW</strong> → Host DRAM <strong>dramBW</strong> → serial CPU Expert execution <strong>runtime.threads</strong>'
    : 'SSD/NAND <strong>ssdBW</strong> → Host DRAM <strong>dramBW</strong> → 개별 GPU 링크 <strong>pcieBW</strong>';
}

function sweepBaselineSummaryHtml(config, source = '현재 입력값 스냅샷') {
  if (!config) return '<b>기준값을 사용할 수 없습니다.</b>';
  const fields = config.mode === 'bigmoe-edge'
    ? [
        ['엔진', config.mode], ['실행', `CPU-only ${config.runtime.execution}`], ['Host 메모리', `${config.host} GB`],
        ['DRAM 대역폭', `${config.dramBW} GB/s`], ['SSD 대역폭', `${config.ssdBW} GB/s`],
        ['I/O 실행 lane', `${config.runtime.ioThreads}개`], ['Expert cache', `${config.runtime.cacheMiB} MiB`],
        ['프롬프트 / 출력', `${config.prompt} / ${config.output} 토큰`], ['동시 시퀀스', `${config.conc}개`]
      ]
    : [
        ['엔진', config.mode], ['메모리 구조', config.arch], ['Host 메모리', `${config.host} GB`], ['DRAM 대역폭', `${config.dramBW} GB/s`],
        ['SSD 대역폭', `${config.ssdBW} GB/s`], ['PCIe 대역폭', config.arch === 'unified' ? '통합 메모리에서는 사용 안 함' : `${config.pcieBW} GB/s`],
        ['프롬프트 / 출력', `${config.prompt} / ${config.output} 토큰`], ['동시 시퀀스', `${config.conc}개`]
      ];
  return `<div class="baselineTitle"><b>스윕 기준값</b><span>${advisorEscape(source)}</span></div><p>스윕 시작 시점의 스냅샷입니다. 실행 후 입력 폼을 바꿔도 이미 생성된 시나리오는 변경되지 않습니다.</p><dl>${fields.map(([label, value]) => `<div><dt>${advisorEscape(label)}</dt><dd>${advisorEscape(String(value))}</dd></div>`).join('')}</dl>`;
}

function sweepSensitivityInsight(execution) {
  if (!execution?.baselineMetrics || !execution?.results?.length) return '';
  const baseline = execution.baselineMetrics;
  const completed = execution.results.filter(row => row.metrics?.status === 'completed');
  if (!completed.length) return '<b>완료된 비교 시나리오가 없어 해석할 수 없습니다.</b>';
  const metricKeys = ['ttftMeanMs', 'singleTPS', 'aggregateTPS'];
  const relativeChanges = completed.flatMap(row => metricKeys.map(key => {
    const before = Number(baseline[key]), after = Number(row.metrics[key]);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
    return Math.abs(after - before) / Math.max(1e-12, Math.abs(before));
  })).filter(Number.isFinite);
  const flat = relativeChanges.length && Math.max(...relativeChanges) < 1e-6;
  const paths = [...new Set(completed.flatMap(row => Object.keys(row.changes || {})))];
  if (flat && paths.length === 1 && paths[0] === 'dramBW') {
    return '<b>DRAM 대역폭 변화로 측정 가능한 차이가 없습니다.</b> 시험 범위에서 기준 시나리오는 DRAM 대역폭 병목이 아닙니다. SSD 서비스, PCIe 전송 또는 연산이 임계 경로로 남을 수 있으므로 DRAM만 빨라져도 TTFT가 줄거나 TPS가 늘지 않을 수 있습니다. 이는 정상적인 포화 결과이며, 그 자체로 시뮬레이터 오류를 의미하지 않습니다.';
  }
  if (flat) return '<b>TTFT/TPS에서 측정 가능한 변화가 없습니다.</b> 선택한 입력이 시험 범위의 활성 임계 경로에 없거나 다른 자원이 계속 병목으로 남았습니다.';
  return `<b>측정 가능한 민감도가 확인되었습니다.</b> 유지된 시나리오의 최대 상대 TTFT/TPS 변화는 ${fmt(Math.max(...relativeChanges) * 100, 3)}%입니다. 이 값은 현재 기준 시나리오의 비교 결과이며 모든 하드웨어에 일반화할 수 없습니다.`;
}

function sweepCategoryLabel(category) {
  return ({
    Workload: '워크로드',
    Memory: '메모리',
    Model: '모델',
    Compute: '연산',
    Prefetch: '프리페치',
    'System / Storage': '시스템 / 스토리지'
  })[category] || category;
}

function sweepStatusLabel(status) {
  return ({
    ready: '준비됨',
    running: '실행 중',
    paused: '일시정지',
    completed: '완료',
    cancelled: '취소됨',
    failed: '실패',
    oom: '메모리 부족(OOM)',
    invalid: '잘못된 설정'
  })[status] || status || '알 수 없음';
}

function localizeSweepMessage(message) {
  return String(message || '')
    .replace(/^Invalid configuration:/, '잘못된 설정:')
    .replace(/^Simulation failed\.$/, '시뮬레이션에 실패했습니다.')
    .replace(/^Simulation reached OOM or hard pressure\.$/, '시뮬레이션이 OOM 또는 하드 메모리 압력에 도달했습니다.')
    .replace(/custom values must all be valid numbers\./, '사용자 지정 값은 모두 유효한 숫자여야 합니다.')
    .replace(/custom values must be integers\./, '사용자 지정 값은 모두 정수여야 합니다.')
    .replace(/custom values are outside the valid range\./, '사용자 지정 값이 유효 범위를 벗어났습니다.')
    .replace(/sweep bounds are outside the valid range\./, '스윕 범위가 유효 범위를 벗어났습니다.')
    .replace(/sweep bounds must be integers\./, '스윕 범위는 정수여야 합니다.');
}

function renderSweepBaselineSummary(config = readCurrentSweepConfig(), source) {
  const dataPath = $('sweepDataPath');
  if (dataPath) dataPath.innerHTML = sweepDataPathHtml(config);
  const target = $('sweepBaselineSummary');
  if (target) target.innerHTML = sweepBaselineSummaryHtml(config, source);
}

function renderSweepParameterPicker() {
  if (typeof document?.createElement !== 'function') return;
  const baseline = readCurrentSweepConfig();
  currentSweepCatalog = sweepCatalogForConfig(baseline);
  const categories = [...new Set(currentSweepCatalog.map(item => item.category))];
  const category = $('parameterCategory');
  const previousCategory = category.value || 'all';
  category.innerHTML = `<option value="all">전체 범주</option>${categories.map(value => `<option value="${advisorEscape(value)}">${advisorEscape(sweepCategoryLabel(value))}</option>`).join('')}`;
  category.value = categories.includes(previousCategory) ? previousCategory : 'all';
  const query = ($('parameterSearch').value || '').trim().toLowerCase();
  const visible = currentSweepCatalog.filter(item => {
    const guide = sweepParameterGuide(item, baseline);
    return (category.value === 'all' || item.category === category.value) && (!query || `${item.path} ${guide.label} ${guide.unit} ${guide.description} ${item.category}`.toLowerCase().includes(query));
  });
  $('parameterChecklist').innerHTML = visible.map(item => {
    const guide = sweepParameterGuide(item, baseline);
    return `<label class="parameterChoice"><input type="checkbox" data-sweep-path="${advisorEscape(item.path)}" ${sweepSelectedPaths.has(item.path) ? 'checked' : ''}><span><b>${advisorEscape(guide.label)}</b> <code>${advisorEscape(item.path)}</code><br><small>${advisorEscape(guide.unit)} · ${advisorEscape(guide.description)}</small><br><small class="parameterRelation">${advisorEscape(guide.relationship)}</small></span></label>`;
  }).join('') || '<p class="note">일치하는 매개변수가 없습니다.</p>';
  renderSweepBaselineSummary(baseline, '현재 입력값 · 실행 시 Worker에서 정규화');
  $('sweepSelectedCount').textContent = `${sweepSelectedPaths.size}개 선택`;
  document.querySelectorAll('[data-sweep-path]').forEach(input => input.onchange = () => {
    if (input.checked) sweepSelectedPaths.add(input.dataset.sweepPath); else sweepSelectedPaths.delete(input.dataset.sweepPath);
    renderSweepParameterCards(baseline);
    updateSweepProjection();
  });
  renderSweepParameterCards(baseline);
  updateSweepProjection();
}

function renderSweepParameterCards(baseline = readCurrentSweepConfig()) {
  captureSweepParameterDrafts();
  const selected = currentSweepCatalog.filter(item => sweepSelectedPaths.has(item.path));
  $('sweepParameters').innerHTML = selected.length ? selected.map(item => {
    const baselineValue = sweepValueAtPath(baseline, item.path);
    const guide = sweepParameterGuide(item, baseline);
    const baselineDisplay = `${baselineValue} ${guide.unit}`;
    const guideHeader = `<div class="parameterGuide"><b>${advisorEscape(guide.label)}</b> <code>${advisorEscape(item.path)}</code><br><small>기준값: ${advisorEscape(baselineDisplay)}</small><p>${advisorEscape(guide.description)}</p><p><b>관계:</b> ${advisorEscape(guide.relationship)}</p><p><b>결과 해석:</b> ${advisorEscape(guide.behavior)}</p></div>`;
    const draft = sweepParameterDrafts.get(item.path);
    if (item.type !== 'number') return `<div class="sweepParameterCard" data-sweep-card="${advisorEscape(item.path)}">${guideHeader}${item.values.map(value => `<label><input type="checkbox" data-category-value="${advisorEscape(String(value))}" ${(draft?.selectedValues || [String(baselineValue)]).includes(String(value)) ? 'checked' : ''}>${advisorEscape(String(value))}</label>`).join('')}</div>`;
    const auto = autoSweepValues(item, baselineValue);
    const step = item.integer ? Math.max(1, Math.round(Math.max(1, baselineValue) / 4)) : Number(Math.max(Math.abs(baselineValue) / 4, 0.001).toPrecision(6));
    const chosen = draft || { strategy: 'auto', min: auto[0], max: auto[auto.length - 1], step, custom: auto.join(', ') };
    const option = value => `<option value="${value}" ${chosen.strategy === value ? 'selected' : ''}>${({ auto: '자동', linear: '선형', log: '로그', custom: '사용자 목록' })[value]}</option>`;
    return `<div class="sweepParameterCard" data-sweep-card="${advisorEscape(item.path)}">${guideHeader}<label>생성 방식<select data-sweep-strategy>${['auto', 'linear', 'log', 'custom'].map(option).join('')}</select></label><label>최솟값 (${advisorEscape(guide.unit)})<input data-sweep-min type="number" value="${advisorEscape(String(chosen.min))}" min="${item.min}" max="${item.max}"></label><label>최댓값 (${advisorEscape(guide.unit)})<input data-sweep-max type="number" value="${advisorEscape(String(chosen.max))}" min="${item.min}" max="${item.max}"></label><label>간격 / 지점 수<input data-sweep-step type="number" value="${advisorEscape(String(chosen.step))}" min="${item.integer ? 1 : Number.EPSILON}"><input data-sweep-custom type="text" value="${advisorEscape(String(chosen.custom))}" aria-label="${advisorEscape(guide.label)} 사용자 지정 값(${advisorEscape(guide.unit)})"></label></div>`;
  }).join('') : '<div class="sweepEmptyGuide"><strong>비교할 매개변수를 선택하세요</strong><span><b>1</b> 매개변수 목록에서 변수 선택</span><span><b>2</b> 값 범위와 예상 시나리오 확인</span><span><b>3</b> 스윕 실행 후 TPS·TTFT 비교</span></div>';
}

function parseSweepCardSelection(descriptor, card, baseline) {
  if (descriptor.type !== 'number') {
    const values = [...card.querySelectorAll('[data-category-value]:checked')].map(input => descriptor.type === 'boolean' ? input.dataset.categoryValue === 'true' : input.dataset.categoryValue);
    if (!values.length) throw new Error(`${descriptor.path}: 하나 이상의 값을 선택하세요.`);
    return { path: descriptor.path, values };
  }
  const strategy = card.querySelector('[data-sweep-strategy]').value;
  if (strategy === 'auto') return { path: descriptor.path, values: autoSweepValues(descriptor, baseline) };
  if (strategy === 'custom') return { path: descriptor.path, values: parseCustomSweepValues(descriptor, card.querySelector('[data-sweep-custom]').value) };
  const minInput = card.querySelector('[data-sweep-min]').value.trim();
  const maxInput = card.querySelector('[data-sweep-max]').value.trim();
  const stepInput = card.querySelector('[data-sweep-step]').value.trim();
  if (!minInput || !maxInput || !stepInput) throw new Error(`${descriptor.path}: 최솟값, 최댓값, 간격/지점 수가 필요합니다.`);
  const min = Number(minInput), max = Number(maxInput), step = Number(stepInput);
  if (strategy === 'log') return { path: descriptor.path, values: linearSweepValues(descriptor, min, max, step, 'log') };
  if (![min, max, step].every(Number.isFinite) || step <= 0 || min > max || min < descriptor.min || max > descriptor.max) throw new Error(`${descriptor.path}: 선형 최솟값/최댓값/간격이 잘못되었습니다.`);
  if (descriptor.integer && (![min, max, step].every(Number.isInteger))) throw new Error(`${descriptor.path}: 선형 최솟값/최댓값/간격은 정수여야 합니다.`);
  const values = [];
  for (let value = min; value <= max + EPS && values.length <= SWEEP_LIMIT; value += step) values.push(Number(value.toPrecision(12)));
  if (!values.length || values.length > SWEEP_LIMIT) throw new Error(`${descriptor.path}: 선형 범위는 1–${SWEEP_LIMIT}개의 유효한 값을 만들어야 합니다.`);
  return { path: descriptor.path, values: [...new Set(values)] };
}

function collectSweepSelections(baseline) {
  if (typeof document?.querySelector !== 'function') throw new Error('스윕 UI를 사용할 수 없습니다.');
  return currentSweepCatalog.filter(item => sweepSelectedPaths.has(item.path)).map(item => {
    const card = document.querySelector(`[data-sweep-card="${CSS.escape(item.path)}"]`);
    return parseSweepCardSelection(item, card, sweepValueAtPath(baseline, item.path));
  });
}

function updateSweepProjection() {
  $('sweepSelectedCount').textContent = `${sweepSelectedPaths.size}개 선택`;
  $('sweepActionHint').textContent = sweepSelectedPaths.size ? '값 범위를 확인하고 스윕을 실행하세요.' : '매개변수를 선택하면 실행할 수 있습니다.';
  $('runSweep').disabled = !sweepSelectedPaths.size || sweepPreparing || ['ready', 'running', 'paused'].includes(activeSweepExecution?.status);
  if (!sweepSelectedPaths.size) {
    $('sweepProjectedCount').textContent = '예상 시나리오 0개';
    return;
  }
  try {
    const baseline = readCurrentSweepConfig();
    const plan = buildSweepScenarios(baseline, $('sweepMode').value, collectSweepSelections(baseline), SWEEP_LIMIT);
    $('sweepProjectedCount').textContent = `예상 시나리오 ${plan.total}개${plan.omitted ? ` · 앞의 ${plan.scenarios.length}개 실행, ${plan.omitted}개 제외` : ''}`;
  } catch (error) {
    $('sweepProjectedCount').textContent = `예상 시나리오를 계산할 수 없습니다: ${localizeSweepMessage(error.message)}`;
  }
}

function sweepResultRows(execution) {
  if (!execution) return [];
  return [{ index: -1, changes: { 기준값: true }, metrics: execution.baselineMetrics || null }, ...execution.results];
}

function sweepChartGroups(execution) {
  const baselineRow = { index: -1, changes: { 기준값: true }, metrics: execution?.baselineMetrics || null };
  const selections = Array.isArray(execution?.selections) ? execution.selections : [];
  if (execution?.definition?.mode !== 'oat' || selections.length < 2) return [{ path: selections[0]?.path || null, rows: sweepResultRows(execution) }];
  return selections.map(selection => ({
    path: selection.path,
    rows: [baselineRow, ...(execution.results || []).filter(row => Object.hasOwn(row?.changes || {}, selection.path))]
  }));
}

function sweepParameterChartData(group, config) {
  if (!group?.path) return { rows: group?.rows || [], xValues: null, xLabel: null };
  const descriptor = sweepCatalogForConfig(config).find(item => item.path === group.path);
  const guide = descriptor ? sweepParameterGuide(descriptor) : { label: group.path, unit: '' };
  const rows = (group.rows || []).map(row => ({ row, x: row.index < 0 ? sweepValueAtPath(config, group.path) : row.changes?.[group.path] })).filter(item => Number.isFinite(item.x)).sort((a, b) => a.x - b.x);
  return {
    rows: rows.map(item => item.row),
    xValues: rows.map(item => item.x),
    xLabel: `${guide.label}${guide.unit ? ` (${guide.unit})` : ''}`
  };
}

function renderSweepTable(execution) {
  const rows = sweepResultRows(execution);
  if (!rows.length || !rows[0].metrics) { $('sweepResults').innerHTML = '<caption>스윕 결과가 없습니다.</caption>'; return; }
  const body = rows.map(row => {
    const metrics = row.metrics;
    const values = metrics.status === 'completed' ? [metrics.ttftMeanMs, metrics.ttftP50Ms, metrics.ttftP95Ms, metrics.singleTPS, metrics.aggregateTPS].map(value => fmt(value, 4)) : ['—', '—', '—', '—', '—'];
    return `<tr><th scope="row">${row.index < 0 ? '기준값' : row.index + 1}</th><td>${advisorEscape(Object.entries(row.changes).map(([key, value]) => `${key}=${value}`).join(', '))}</td><td>${advisorEscape(sweepStatusLabel(metrics.status))}</td>${values.map(value => `<td>${value}</td>`).join('')}<td>${advisorEscape(localizeSweepMessage(metrics.reason))}</td></tr>`;
  }).join('');
  $('sweepResults').innerHTML = `<caption>원시 매개변수 스윕 결과</caption><thead><tr><th>실행</th><th>변경값</th><th>상태</th><th>TTFT 평균(ms)</th><th>TTFT p50(ms)</th><th>TTFT p95(ms)</th><th>단일 시퀀스 TPS</th><th>전체 TPS</th><th>사유</th></tr></thead><tbody>${body}</tbody>`;
}

function sizeSweepCanvas(canvas, requestedRatio = null) {
  const ratio = Number.isFinite(requestedRatio) && requestedRatio > 0 ? requestedRatio : Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  const width = Math.max(220, Math.round(canvas.clientWidth || canvas.width || 680));
  const height = Math.max(220, Math.round(canvas.clientHeight || 250));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  if (typeof context?.setTransform === 'function') context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawSweepMetricChart(canvasId, rows, keys, colors, title, axisKind, xAxis = null) {
  const canvas = $(canvasId);
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const sized = sizeSweepCanvas(canvas);
  const context = sized.context, width = sized.width, height = sized.height;
  const palette = chartPalette();
  context.clearRect(0, 0, width, height); context.fillStyle = palette.background; context.fillRect(0, 0, width, height);
  const max = Math.max(EPS, ...rows.flatMap(row => keys.map(key => row.metrics?.status === 'completed' && Number.isFinite(row.metrics?.[key]) ? row.metrics[key] : 0)));
  const left = 68, top = 26, plotWidth = width - 88, plotHeight = height - 82;
  const xValues = Array.isArray(xAxis?.values) && xAxis.values.length === rows.length ? xAxis.values : null;
  const xMin = xValues ? Math.min(...xValues) : 0;
  const xMax = xValues ? Math.max(...xValues) : Math.max(0, rows.length - 1);
  const xPosition = index => xValues && xMax > xMin ? (xValues[index] - xMin) / (xMax - xMin) : chartSeriesPosition(index, rows.length);
  const xTicks = xValues
    ? [...new Set(xValues)].map(value => ({ position: xMax > xMin ? (value - xMin) / (xMax - xMin) : 0.5, label: chartTickLabel(value) }))
    : chartLinearTicks(0, Math.max(0, rows.length - 1));
  drawCartesianAxes(context, {
    left, top, width: plotWidth, height: plotHeight,
    xTicks,
    yTicks: chartLinearTicks(0, max, 5, true),
    ...chartAxisSpec(axisKind),
    ...(xAxis?.label ? { xLabel: xAxis.label } : {})
  });
  keys.forEach((key, seriesIndex) => {
    context.strokeStyle = colors[seriesIndex]; context.lineWidth = 2;
    let drawing = false, segmentPoints = 0, lastPoint = null;
    const finishSegment = () => {
      if (!drawing) return;
      context.stroke();
      if (segmentPoints === 1) drawChartPoint(context, lastPoint.x, lastPoint.y, colors[seriesIndex]);
      drawing = false; segmentPoints = 0; lastPoint = null;
    };
    rows.forEach((row, index) => {
      const value = row.metrics?.[key];
      if (!Number.isFinite(value) || row.metrics.status !== 'completed') { finishSegment(); return; }
      const x = left + plotWidth * xPosition(index), y = top + plotHeight * (1 - value / max);
      if (!drawing) { context.beginPath(); context.moveTo(x, y); drawing = true; } else context.lineTo(x, y);
      segmentPoints++; lastPoint = { x, y };
    });
    finishSegment();
  });
  context.fillStyle = palette.text; context.font = '11px sans-serif'; context.textAlign = 'left'; context.textBaseline = 'alphabetic'; context.fillText(title, 8, 15);
}

function renderSweepCharts(execution) {
  const target = $('sweepCharts');
  if (!target) return;
  const groups = sweepChartGroups(execution);
  const config = execution?.baselineConfig || readCurrentSweepConfig();
  const catalog = new Map(sweepCatalogForConfig(config).map(item => [item.path, item]));
  target.innerHTML = groups.map((group, index) => {
    const descriptor = catalog.get(group.path);
    const guide = descriptor ? sweepParameterGuide(descriptor) : { label: group.path || '스윕', unit: '' };
    const selection = (execution?.selections || []).find(item => item.path === group.path);
    const formatValue = value => `${value}${guide.unit ? ` ${guide.unit}` : ''}`;
    const range = selection?.values?.length ? `${formatValue(selection.values[0])} → ${formatValue(selection.values[selection.values.length - 1])}` : '';
    const suffix = groups.length === 1 ? '' : `-${index}`;
    return `<section class="sweepChartGroup" data-sweep-chart-path="${advisorEscape(group.path || 'combined')}"><header><h3>${advisorEscape(guide.label)}</h3><span><code>${advisorEscape(group.path || '통합')}</code>${range ? ` · ${advisorEscape(range)}` : ''} · 독립 OAT</span></header><div class="sweepChartPair"><section><h4>TTFT 평균 / p50 / p95</h4><canvas id="sweepTTFTChart${suffix}" width="680" height="250" role="img" aria-label="${advisorEscape(guide.label)} TTFT 스윕 그래프"></canvas></section><section><h4>단일 시퀀스 TPS / 전체 TPS</h4><canvas id="sweepTPSChart${suffix}" width="680" height="250" role="img" aria-label="${advisorEscape(guide.label)} TPS 스윕 그래프"></canvas></section></div></section>`;
  }).join('');
  const palette = chartPalette();
  groups.forEach((group, index) => {
    const suffix = groups.length === 1 ? '' : `-${index}`;
    const chartData = sweepParameterChartData(group, config);
    const xAxis = chartData.xValues ? { values: chartData.xValues, label: chartData.xLabel } : null;
    drawSweepMetricChart(`sweepTTFTChart${suffix}`, chartData.rows, ['ttftMeanMs', 'ttftP50Ms', 'ttftP95Ms'], ['#1687b8', palette.green, palette.violet], 'TTFT 평균 / p50 / p95', 'sweep-ttft', xAxis);
    drawSweepMetricChart(`sweepTPSChart${suffix}`, chartData.rows, ['singleTPS', 'aggregateTPS'], [palette.yellow, palette.red], '단일 시퀀스 / 전체 TPS', 'sweep-tps', xAxis);
  });
}

function renderSweepResults(execution = activeSweepExecution) {
  if (execution) $('sweepOutput').hidden = false;
  renderSweepTable(execution);
  const interpretation = $('sweepInterpretation');
  if (interpretation) {
    interpretation.innerHTML = execution ? sweepSensitivityInsight(execution) : '스윕을 실행하면 선택한 입력이 활성 임계 경로에 있는지 확인할 수 있습니다.';
    interpretation.hidden = false;
  }
  if (execution?.baselineConfig) renderSweepBaselineSummary(execution.baselineConfig, '이 스윕에서 유지한 정규화 Worker 기준값');
  if (typeof renderGuidedSweepSummary === 'function') renderGuidedSweepSummary(execution);
  renderSweepCharts(execution);
  if (!execution) return;
  const completed = execution.results.length, total = execution.scenarios.length;
  $('sweepProgress').style.width = `${total ? completed / total * 100 : 0}%`;
  const progress = $('sweepProgressTrack');
  if (progress) {
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(completed));
  }
  $('sweepProgressText').textContent = `${sweepStatusLabel(execution.status)}: 시나리오 ${completed}/${total}개 유지${execution.definition.omitted ? ` · 결정적 50회 제한으로 ${execution.definition.omitted}개 제외` : ''}`;
  $('exportSweepCsv').disabled = !execution.results.length;
  $('runSweep').disabled = ['ready', 'running', 'paused'].includes(execution.status);
  $('pauseSweep').disabled = !['ready', 'running'].includes(execution.status);
  $('resumeSweep').disabled = execution.status !== 'paused';
  $('cancelSweep').disabled = !['ready', 'running', 'paused'].includes(execution.status);
}

function resetSweepResults() {
  activeSweepExecution = null;
  renderSweepResults(null);
  $('sweepProgress').style.width = '0%';
  $('sweepProgressTrack').setAttribute('aria-valuemax', '0');
  $('sweepProgressTrack').setAttribute('aria-valuenow', '0');
  $('sweepProgressText').textContent = '스윕이 시작되지 않았습니다.';
  for (const id of ['pauseSweep', 'resumeSweep', 'cancelSweep', 'exportSweepCsv']) $(id).disabled = true;
}

function scheduleSweepTick() {
  if (!activeSweepExecution || sweepScenarioInFlight || !['ready', 'running'].includes(activeSweepExecution.status)) return;
  const execution = activeSweepExecution;
  const generation = sweepGeneration;
  sweepTimer = setTimeout(async () => {
    if (execution !== activeSweepExecution || generation !== sweepGeneration || !['ready', 'running'].includes(execution.status)) return;
    execution.status = 'running';
    const scenario = execution.scenarios[execution.nextIndex];
    if (!scenario) {
      execution.status = 'completed';
      renderSweepResults(execution);
      return;
    }
    let outcome;
    sweepScenarioInFlight = true;
    try {
      outcome = await simulateSweepInWorker(scenario.config);
    } catch (error) {
      if (execution !== activeSweepExecution || generation !== sweepGeneration || execution.status === 'cancelled') return;
      console.error('스윕 시나리오 실행 실패', { index: scenario.index, message: error.message });
      execution.status = 'failed';
      renderSweepResults(execution);
      $('sweepProgressText').textContent = `시나리오 ${scenario.index + 1}에서 실패: ${localizeSweepMessage(error.message)}`;
      return;
    } finally {
      sweepScenarioInFlight = false;
    }
    if (execution !== activeSweepExecution || generation !== sweepGeneration || execution.status === 'cancelled') return;
    execution.results.push({ index: scenario.index, changes: sweepClone(scenario.changes), config: sweepClone(scenario.config), runId: outcome.runId, metrics: sweepClone(outcome.metrics) });
    execution.nextIndex += 1;
    if (execution.nextIndex >= execution.scenarios.length) execution.status = 'completed';
    renderSweepResults(execution);
    if (execution.status === 'running') scheduleSweepTick();
  }, 0);
}

function sweepModeForExecution(guidedContract, requestedMode) {
  return guidedContract ? 'oat' : requestedMode;
}

async function runSweepFromUI(options = {}) {
  const guidedContract = options?.guidedContract || null;
  if (typeof scenarioImportInProgress !== 'undefined' && scenarioImportInProgress) {
    $('sweepProgressText').textContent = '시나리오 가져오기를 검증하는 동안에는 스윕을 실행할 수 없습니다.';
    return;
  }
  if (sweepPreparing || ['ready', 'running', 'paused'].includes(activeSweepExecution?.status)) return;
  const generation = ++sweepGeneration;
  try {
    const requestedBaseline = readCurrentSweepConfig();
    const validation = requestedBaseline.mode === 'bigmoe-edge'
      ? validateBigMoeEdgeConfig(requestedBaseline)
      : validateSimulationConfig(requestedBaseline);
    if (!validation.valid) throw new Error(`기준 설정이 잘못되었습니다: ${formatConfigErrors(validation)}`);
    resetSweepResults();
    $('sweepOutput').hidden = false;
    sweepPreparing = true;
    $('runSweep').disabled = true;
    $('cancelSweep').disabled = false;
    $('sweepProgressText').textContent = '시뮬레이션 Worker에서 정규화 기준값을 준비하는 중…';
    const baselineRun = await simulateSweepInWorker(requestedBaseline);
    if (generation !== sweepGeneration) return;
    if (guidedContract && baselineRun.metrics?.status !== 'completed') {
      throw new Error(`비교 분석 전에 가이드 기준 실행이 완료되어야 합니다(${sweepStatusLabel(baselineRun.metrics?.status)}).`);
    }
    const baselineConfig = baselineRun.config;
    const selections = guidedContract ? sweepClone(guidedContract.selections) : collectSweepSelections(baselineConfig);
    const plan = buildSweepScenarios(baselineConfig, sweepModeForExecution(guidedContract, $('sweepMode').value), selections, SWEEP_LIMIT);
    activeSweepExecution = createSweepExecution(baselineConfig, plan);
    activeSweepExecution.selections = sweepClone(selections);
    activeSweepExecution.baselineMetrics = sweepClone(baselineRun.metrics);
    if (guidedContract) activeSweepExecution.guidedContract = sweepClone(guidedContract);
    $('sweepTruncation').hidden = plan.omitted === 0;
    $('sweepTruncation').textContent = plan.omitted ? `요청 조합 ${plan.total}개 중 결정적 행 우선 순서의 앞 ${plan.scenarios.length}개를 실행하며, ${plan.omitted}개는 제외합니다.` : '';
    renderSweepResults(activeSweepExecution);
    scheduleSweepTick();
  } catch (error) {
    if (generation !== sweepGeneration) return;
    console.error('스윕 설정 실패', { message: error.message });
    $('sweepProgressText').textContent = `스윕을 실행할 수 없습니다: ${localizeSweepMessage(error.message)}`;
  } finally {
    if (generation === sweepGeneration) {
      sweepPreparing = false;
      $('runSweep').disabled = ['ready', 'running', 'paused'].includes(activeSweepExecution?.status);
    }
  }
}

function exportSweepCsv() {
  if (!activeSweepExecution?.results.length) return;
  const header = ['engine', 'mode', 'omitted', 'product_boundary', 'run', 'changes', 'status', 'ttft_mean_ms', 'ttft_p50_ms', 'ttft_p95_ms', 'single_tps', 'aggregate_tps', 'reason'];
  const metadata = [activeSweepExecution.baselineConfig.mode, activeSweepExecution.definition.mode, activeSweepExecution.definition.omitted, 'Estimated sensitivity simulator / Unvalidated Alpha'];
  const lines = [header, ...sweepResultRows(activeSweepExecution).map(row => [...metadata, row.index < 0 ? 'baseline' : row.index + 1, Object.entries(row.changes).map(([key, value]) => `${key}=${value}`).join(';'), row.metrics.status, row.metrics.ttftMeanMs, row.metrics.ttftP50Ms, row.metrics.ttftP95Ms, row.metrics.singleTPS, row.metrics.aggregateTPS, row.metrics.reason || ''])].map(row => row.map(sweepCsvCell).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = 'moe-ssd-sweep.csv';
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 0);
}

function initializeSweepLab() {
  const dialog = $('sweepLab');
  const isActive = () => sweepPreparing || ['ready', 'running', 'paused'].includes(activeSweepExecution?.status);
  const requestClose = () => {
    if (isActive()) {
      $('sweepProgressText').textContent = '일시정지는 스윕을 끝내지 않습니다. 실험실을 닫기 전에 스윕을 취소하세요.';
      $('cancelSweep').focus();
      return;
    }
    dialog.close();
  };
  $('openSweep').onclick = () => {
    sweepOpener = document.activeElement;
    renderSweepParameterPicker();
    const catalog = $('parameterCatalog');
    catalog.open = !(typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches);
    dialog.showModal();
    $('parameterSearch').focus();
  };
  $('closeSweep').onclick = requestClose;
  dialog.addEventListener('cancel', event => {
    if (!isActive()) return;
    event.preventDefault();
    $('sweepProgressText').textContent = '실험실을 닫기 전에 실행 중인 스윕을 취소하세요.';
    $('cancelSweep').focus();
  });
  dialog.addEventListener('close', () => sweepOpener?.focus());
  $('parameterSearch').oninput = () => {
    if ($('parameterSearch').value.trim()) $('parameterCatalog').open = true;
    renderSweepParameterPicker();
  };
  $('parameterCategory').onchange = () => {
    $('parameterCatalog').open = true;
    renderSweepParameterPicker();
  };
  $('selectAllSweep').onclick = () => {
    sweepSelectedPaths = new Set(currentSweepCatalog.map(descriptor => descriptor.path));
    renderSweepParameterPicker();
  };
  $('clearSweep').onclick = () => {
    sweepSelectedPaths.clear();
    sweepParameterDrafts.clear();
    renderSweepParameterPicker();
  };
  $('sweepMode').onchange = updateSweepProjection;
  $('sweepParameters').oninput = updateSweepProjection;
  $('sweepParameters').onchange = updateSweepProjection;
  $('runSweep').onclick = runSweepFromUI;
  $('pauseSweep').onclick = () => { pauseSweepExecution(activeSweepExecution); renderSweepResults(); };
  $('resumeSweep').onclick = () => { resumeSweepExecution(activeSweepExecution); renderSweepResults(); scheduleSweepTick(); };
  $('cancelSweep').onclick = () => {
    const cancelledPreparation = sweepPreparing;
    sweepGeneration += 1;
    sweepPreparing = false;
    sweepScenarioInFlight = false;
    if (sweepTimer) clearTimeout(sweepTimer);
    cancelSweepWorker();
    if (activeSweepExecution && ['ready', 'running', 'paused'].includes(activeSweepExecution.status)) cancelSweepExecution(activeSweepExecution);
    renderSweepResults();
    if (cancelledPreparation) $('sweepProgressText').textContent = '취소됨: 시나리오를 유지하기 전에 기준값 준비를 중단했습니다.';
    $('runSweep').disabled = false;
  };
  $('exportSweepCsv').onclick = exportSweepCsv;
}
