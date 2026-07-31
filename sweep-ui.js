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
  if (typeof Worker === 'undefined') return Promise.reject(new Error('Parameter sweeps require Web Worker support.'));
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
    task.cancel = () => finish(reject, new Error('Sweep simulation cancelled.'));
    timeout = setTimeout(() => finish(reject, new Error('Sweep scenario exceeded the 30-second work budget.')), 30000);
    worker.onmessage = event => event.data?.error
      ? finish(reject, new Error(event.data.error))
      : finish(resolve, event.data);
    worker.onerror = event => finish(reject, new Error(event.message || 'Sweep simulation worker failed.'));
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
  return $('mode').value === 'afm3' ? readAFM() : readColibri();
}

function renderSweepParameterPicker() {
  if (typeof document?.createElement !== 'function') return;
  const baseline = readCurrentSweepConfig();
  currentSweepCatalog = sweepCatalogForConfig(baseline);
  const categories = [...new Set(currentSweepCatalog.map(item => item.category))];
  const category = $('parameterCategory');
  const previousCategory = category.value || 'all';
  category.innerHTML = `<option value="all">All categories</option>${categories.map(value => `<option value="${advisorEscape(value)}">${advisorEscape(value)}</option>`).join('')}`;
  category.value = categories.includes(previousCategory) ? previousCategory : 'all';
  const query = ($('parameterSearch').value || '').trim().toLowerCase();
  const visible = currentSweepCatalog.filter(item => (category.value === 'all' || item.category === category.value) && (!query || `${item.path} ${item.category}`.toLowerCase().includes(query)));
  $('parameterChecklist').innerHTML = visible.map(item => `<label class="parameterChoice"><input type="checkbox" data-sweep-path="${advisorEscape(item.path)}" ${sweepSelectedPaths.has(item.path) ? 'checked' : ''}><span><b>${advisorEscape(item.path)}</b><br><small>${advisorEscape(item.category)} · ${advisorEscape(item.type)}</small></span></label>`).join('') || '<p class="note">No matching parameters.</p>';
  $('sweepSelectedCount').textContent = `${sweepSelectedPaths.size} selected`;
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
    const draft = sweepParameterDrafts.get(item.path);
    if (item.type !== 'number') return `<div class="sweepParameterCard" data-sweep-card="${advisorEscape(item.path)}"><div><b>${advisorEscape(item.path)}</b><br><small>Baseline: ${advisorEscape(String(baselineValue))}</small></div>${item.values.map(value => `<label><input type="checkbox" data-category-value="${advisorEscape(String(value))}" ${(draft?.selectedValues || [String(baselineValue)]).includes(String(value)) ? 'checked' : ''}>${advisorEscape(String(value))}</label>`).join('')}</div>`;
    const auto = autoSweepValues(item, baselineValue);
    const step = item.integer ? Math.max(1, Math.round(Math.max(1, baselineValue) / 4)) : Number(Math.max(Math.abs(baselineValue) / 4, 0.001).toPrecision(6));
    const chosen = draft || { strategy: 'auto', min: auto[0], max: auto[auto.length - 1], step, custom: auto.join(', ') };
    const option = value => `<option value="${value}" ${chosen.strategy === value ? 'selected' : ''}>${value === 'custom' ? 'Custom list' : value[0].toUpperCase() + value.slice(1)}</option>`;
    return `<div class="sweepParameterCard" data-sweep-card="${advisorEscape(item.path)}"><div><b>${advisorEscape(item.path)}</b><br><small>Baseline: ${advisorEscape(String(baselineValue))}<br>Valid: ${item.min}…${item.max}</small></div><label>Strategy<select data-sweep-strategy>${['auto', 'linear', 'log', 'custom'].map(option).join('')}</select></label><label>Min<input data-sweep-min type="number" value="${advisorEscape(String(chosen.min))}" min="${item.min}" max="${item.max}"></label><label>Max<input data-sweep-max type="number" value="${advisorEscape(String(chosen.max))}" min="${item.min}" max="${item.max}"></label><label>Step / points<input data-sweep-step type="number" value="${advisorEscape(String(chosen.step))}" min="${item.integer ? 1 : Number.EPSILON}"><input data-sweep-custom type="text" value="${advisorEscape(String(chosen.custom))}" aria-label="Custom values for ${advisorEscape(item.path)}"></label></div>`;
  }).join('') : 'Choose one or more parameters.';
}

function parseSweepCardSelection(descriptor, card, baseline) {
  if (descriptor.type !== 'number') {
    const values = [...card.querySelectorAll('[data-category-value]:checked')].map(input => descriptor.type === 'boolean' ? input.dataset.categoryValue === 'true' : input.dataset.categoryValue);
    if (!values.length) throw new Error(`${descriptor.path}: select at least one value.`);
    return { path: descriptor.path, values };
  }
  const strategy = card.querySelector('[data-sweep-strategy]').value;
  if (strategy === 'auto') return { path: descriptor.path, values: autoSweepValues(descriptor, baseline) };
  if (strategy === 'custom') return { path: descriptor.path, values: parseCustomSweepValues(descriptor, card.querySelector('[data-sweep-custom]').value) };
  const minInput = card.querySelector('[data-sweep-min]').value.trim();
  const maxInput = card.querySelector('[data-sweep-max]').value.trim();
  const stepInput = card.querySelector('[data-sweep-step]').value.trim();
  if (!minInput || !maxInput || !stepInput) throw new Error(`${descriptor.path}: min, max, and step/points are required.`);
  const min = Number(minInput), max = Number(maxInput), step = Number(stepInput);
  if (strategy === 'log') return { path: descriptor.path, values: linearSweepValues(descriptor, min, max, step, 'log') };
  if (![min, max, step].every(Number.isFinite) || step <= 0 || min > max || min < descriptor.min || max > descriptor.max) throw new Error(`${descriptor.path}: linear min/max/step is invalid.`);
  if (descriptor.integer && (![min, max, step].every(Number.isInteger))) throw new Error(`${descriptor.path}: linear min/max/step must be integers.`);
  const values = [];
  for (let value = min; value <= max + EPS && values.length <= SWEEP_LIMIT; value += step) values.push(Number(value.toPrecision(12)));
  if (!values.length || values.length > SWEEP_LIMIT) throw new Error(`${descriptor.path}: linear range must produce 1–${SWEEP_LIMIT} valid values.`);
  return { path: descriptor.path, values: [...new Set(values)] };
}

function collectSweepSelections(baseline) {
  if (typeof document?.querySelector !== 'function') throw new Error('Sweep UI is unavailable.');
  return currentSweepCatalog.filter(item => sweepSelectedPaths.has(item.path)).map(item => {
    const card = document.querySelector(`[data-sweep-card="${CSS.escape(item.path)}"]`);
    return parseSweepCardSelection(item, card, sweepValueAtPath(baseline, item.path));
  });
}

function updateSweepProjection() {
  $('sweepSelectedCount').textContent = `${sweepSelectedPaths.size} selected`;
  if (!sweepSelectedPaths.size) {
    $('sweepProjectedCount').textContent = '0 projected scenarios';
    return;
  }
  try {
    const baseline = readCurrentSweepConfig();
    const plan = buildSweepScenarios(baseline, $('sweepMode').value, collectSweepSelections(baseline), SWEEP_LIMIT);
    $('sweepProjectedCount').textContent = `${plan.total} projected scenarios${plan.omitted ? ` · first ${plan.scenarios.length}, ${plan.omitted} omitted` : ''}`;
  } catch (error) {
    $('sweepProjectedCount').textContent = `Projection unavailable: ${error.message}`;
  }
}

function sweepResultRows(execution) {
  if (!execution) return [];
  return [{ index: -1, changes: { Baseline: true }, metrics: execution.baselineMetrics || null }, ...execution.results];
}

function renderSweepTable(execution) {
  const rows = sweepResultRows(execution);
  if (!rows.length || !rows[0].metrics) { $('sweepResults').innerHTML = '<caption>No sweep results.</caption>'; return; }
  const body = rows.map(row => {
    const metrics = row.metrics;
    const values = metrics.status === 'completed' ? [metrics.ttftMeanMs, metrics.ttftP50Ms, metrics.ttftP95Ms, metrics.singleTPS, metrics.aggregateTPS].map(value => fmt(value, 4)) : ['—', '—', '—', '—', '—'];
    return `<tr><th scope="row">${row.index < 0 ? 'Baseline' : row.index + 1}</th><td>${advisorEscape(Object.entries(row.changes).map(([key, value]) => `${key}=${value}`).join(', '))}</td><td>${advisorEscape(metrics.status)}</td>${values.map(value => `<td>${value}</td>`).join('')}<td>${advisorEscape(metrics.reason || '')}</td></tr>`;
  }).join('');
  $('sweepResults').innerHTML = `<caption>Raw parameter sweep results</caption><thead><tr><th>Run</th><th>Changes</th><th>Status</th><th>TTFT mean ms</th><th>TTFT p50 ms</th><th>TTFT p95 ms</th><th>Single TPS</th><th>Aggregate TPS</th><th>Reason</th></tr></thead><tbody>${body}</tbody>`;
}

function drawSweepMetricChart(canvasId, rows, keys, colors, title) {
  const canvas = $(canvasId);
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const context = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
  context.clearRect(0, 0, width, height); context.fillStyle = '#071525'; context.fillRect(0, 0, width, height);
  const max = Math.max(EPS, ...rows.flatMap(row => keys.map(key => row.metrics?.status === 'completed' && Number.isFinite(row.metrics?.[key]) ? row.metrics[key] : 0)));
  const left = 44, top = 28, plotWidth = width - 62, plotHeight = height - 54;
  context.strokeStyle = '#29445f'; for (let line = 0; line < 5; line++) { const y = top + line * plotHeight / 4; context.beginPath(); context.moveTo(left, y); context.lineTo(left + plotWidth, y); context.stroke(); }
  keys.forEach((key, seriesIndex) => {
    context.strokeStyle = colors[seriesIndex]; context.lineWidth = 2; context.beginPath(); let drawing = false;
    rows.forEach((row, index) => {
      const value = row.metrics?.[key];
      if (!Number.isFinite(value) || row.metrics.status !== 'completed') { drawing = false; return; }
      const x = left + plotWidth * index / Math.max(1, rows.length - 1), y = top + plotHeight * (1 - value / max);
      if (!drawing) context.moveTo(x, y); else context.lineTo(x, y); drawing = true;
    }); context.stroke();
  });
  context.fillStyle = '#9db0c8'; context.font = '11px sans-serif'; context.fillText(title, 8, 15);
}

function renderSweepResults(execution = activeSweepExecution) {
  renderSweepTable(execution);
  if (typeof renderGuidedSweepSummary === 'function') renderGuidedSweepSummary(execution);
  const rows = sweepResultRows(execution);
  drawSweepMetricChart('sweepTTFTChart', rows, ['ttftMeanMs', 'ttftP50Ms', 'ttftP95Ms'], ['#67d9ff', '#72e3a6', '#a78bfa'], 'TTFT mean / p50 / p95 (ms)');
  drawSweepMetricChart('sweepTPSChart', rows, ['singleTPS', 'aggregateTPS'], ['#ffd36b', '#ff8696'], 'Single / aggregate TPS');
  if (!execution) return;
  const completed = execution.results.length, total = execution.scenarios.length;
  $('sweepProgress').style.width = `${total ? completed / total * 100 : 0}%`;
  const progress = $('sweepProgressTrack');
  if (progress) {
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(completed));
  }
  $('sweepProgressText').textContent = `${execution.status}: ${completed}/${total} retained scenarios${execution.definition.omitted ? ` · ${execution.definition.omitted} omitted by deterministic 50-run cap` : ''}`;
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
  $('sweepProgressText').textContent = 'No sweep started.';
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
      console.error('Sweep scenario failed', { index: scenario.index, message: error.message });
      execution.status = 'failed';
      renderSweepResults(execution);
      $('sweepProgressText').textContent = `failed at scenario ${scenario.index + 1}: ${error.message}`;
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
    $('sweepProgressText').textContent = 'Sweep unavailable while a scenario import is being verified.';
    return;
  }
  if (sweepPreparing || ['ready', 'running', 'paused'].includes(activeSweepExecution?.status)) return;
  const generation = ++sweepGeneration;
  try {
    const requestedBaseline = readCurrentSweepConfig();
    const validation = validateSimulationConfig(requestedBaseline);
    if (!validation.valid) throw new Error(`Baseline configuration invalid: ${formatConfigErrors(validation)}`);
    resetSweepResults();
    sweepPreparing = true;
    $('runSweep').disabled = true;
    $('cancelSweep').disabled = false;
    $('sweepProgressText').textContent = 'Preparing canonical baseline in simulation worker…';
    const baselineRun = await simulateSweepInWorker(requestedBaseline);
    if (generation !== sweepGeneration) return;
    if (guidedContract && baselineRun.metrics?.status !== 'completed') {
      throw new Error(`Guided baseline must complete before counterfactual analysis (${baselineRun.metrics?.status || 'unknown'}).`);
    }
    const baselineConfig = baselineRun.config;
    const selections = guidedContract ? sweepClone(guidedContract.selections) : collectSweepSelections(baselineConfig);
    const plan = buildSweepScenarios(baselineConfig, sweepModeForExecution(guidedContract, $('sweepMode').value), selections, SWEEP_LIMIT);
    activeSweepExecution = createSweepExecution(baselineConfig, plan);
    activeSweepExecution.selections = sweepClone(selections);
    activeSweepExecution.baselineMetrics = sweepClone(baselineRun.metrics);
    if (guidedContract) activeSweepExecution.guidedContract = sweepClone(guidedContract);
    $('sweepTruncation').hidden = plan.omitted === 0;
    $('sweepTruncation').textContent = plan.omitted ? `Requested ${plan.total} combinations. Running deterministic row-major prefix of ${plan.scenarios.length}; ${plan.omitted} omitted.` : '';
    renderSweepResults(activeSweepExecution);
    scheduleSweepTick();
  } catch (error) {
    if (generation !== sweepGeneration) return;
    console.error('Sweep setup failed', { message: error.message });
    $('sweepProgressText').textContent = `Sweep unavailable: ${error.message}`;
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
      $('sweepProgressText').textContent = 'Pause does not end a sweep. Cancel the sweep before closing the lab.';
      $('cancelSweep').focus();
      return;
    }
    dialog.close();
  };
  $('openSweep').onclick = () => {
    sweepOpener = document.activeElement;
    renderSweepParameterPicker();
    dialog.showModal();
    $('parameterSearch').focus();
  };
  $('closeSweep').onclick = requestClose;
  dialog.addEventListener('cancel', event => {
    if (!isActive()) return;
    event.preventDefault();
    $('sweepProgressText').textContent = 'Cancel the active sweep before closing the lab.';
    $('cancelSweep').focus();
  });
  dialog.addEventListener('close', () => sweepOpener?.focus());
  $('parameterSearch').oninput = renderSweepParameterPicker;
  $('parameterCategory').onchange = renderSweepParameterPicker;
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
    if (cancelledPreparation) $('sweepProgressText').textContent = 'cancelled: baseline preparation stopped before any scenario was retained';
    $('runSweep').disabled = false;
  };
  $('exportSweepCsv').onclick = exportSweepCsv;
}
