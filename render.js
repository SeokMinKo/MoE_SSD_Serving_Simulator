function advisorEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function advisorScoreClass(score) {
  return score >= 70 ? 'score scoreHigh' : score >= 35 ? 'score scoreMedium' : 'score';
}

function renderBottleneckAdvisor(insight) {
  const target = $('advisor');
  if (!target) return;
  const heading = '<div class="advisorHead"><h2 id="advisorTitle">Bottleneck Advisor</h2><span class="note">Relative pressure · simulator trace only</span></div>';
  if (!insight || insight.status === 'unavailable') {
    target.innerHTML = `${heading}<div class="advisorUnavailable"><b>${advisorEscape(insight?.reason || 'Unavailable')}</b><br><span class="note">${advisorEscape(insight?.disclaimer || '')}</span></div>`;
    return;
  }
  const cards = insight.phases.map(phase => {
    const resources = phase.resources.map(resource => {
      const evidence = resource.evidence.map(item => `<li><b>${advisorEscape(item.label)}:</b> ${advisorEscape(item.value)} ${advisorEscape(item.unit)}${item.note ? ` · ${advisorEscape(item.note)}` : ''}</li>`).join('');
      const recommendation = resource.recommendation;
      return `<details class="resourceInsight"><summary><span>${advisorEscape(resource.label)}</span><span class="${advisorScoreClass(resource.score)}">${resource.score}/100</span></summary><ul class="advisorEvidence"><li><b>Calculation:</b> ${advisorEscape(resource.formula)}</li>${evidence}</ul><div class="advisorRecommendation"><b>${advisorEscape(recommendation.priority)}:</b> ${advisorEscape(recommendation.controls)} · ${advisorEscape(recommendation.direction)}<br><b>When:</b> ${advisorEscape(recommendation.condition)}<br><b>Trade-off:</b> ${advisorEscape(recommendation.tradeoff)}</div></details>`;
    }).join('');
    return `<article class="phaseCard"><h3>${advisorEscape(phase.label)}</h3><div class="phaseNote">${advisorEscape(phase.note)}</div>${resources}</article>`;
  }).join('');
  const statusNote = insight.reason ? `<div class="advisorUnavailable"><b>${advisorEscape(insight.reason)}</b></div>` : '';
  target.innerHTML = `${heading}${statusNote}<div class="note">${advisorEscape(insight.disclaimer)}</div><div class="advisorGrid">${cards}</div>`;
}

function renderPressure(r) {
  const s = r.state;
  const thrash = s.totalSwapOutGB > EPS ? Math.min(1, s.totalSwapInGB / s.totalSwapOutGB) : 0;
  $('pressureSummary').innerHTML = rows([
    ['Pressure state', `<span class="${pressureClass(s.lastState)}">${s.lastState}</span>`],
    ['Swap start token', s.swapStartToken === null ? 'None' : s.swapStartToken],
    ['Peak physical memory', `${fmt(s.peakPhysicalGB, 2)} / ${fmt(r.c.host, 1)} GB`],
    ['Minimum free memory', `${fmt(s.minFreeGB, 2)} GB`],
    ['Peak swap allocated / in-flight', `${fmt(s.peakSwapGB, 2)} GB`],
    ['Total swap-in / out', `${fmt(s.totalSwapInGB, 2)} / ${fmt(s.totalSwapOutGB, 2)} GB`],
    ['Page / Expert reclaimed', `${fmt(s.totalPageReclaimedGB, 2)} / ${fmt(s.totalExpertReclaimedGB, 2)} GB`],
    ['Thrash ratio', pct(thrash)],
    ['Peak DRAM BW', `${fmt(s.peakDramGBs, 1)} / ${fmt(r.c.dramBW, 1)} GB/s`],
    ['DRAM-induced stall', ms(s.totalDramStallMs / Math.max(1, r.tokens.length)) + ' / token']
  ]);
}
function renderColibri(r) {
  $('tpotLabel').textContent = 'Average TPOT';
  $('tpsLabel').textContent = 'Aggregate TPS';
  $('storageLabel').textContent = 'Storage / token';
  $('hitLabel').textContent = 'Cache hit';
  const prefillPaths = {
    Compute: r.prefillBreakdown.computeMs,
    Storage: r.prefillBreakdown.storageMs,
    PCIe: r.prefillBreakdown.transferMs,
    DRAM: r.prefillBreakdown.dramMs
  };
  const criticalPath = Object.entries(prefillPaths).sort((a, b) => b[1] - a[1])[0][0];
  $('summary').innerHTML = rows([
    ...(r.serving ? [
      ['Event scheduler throughput', `${fmt(r.serving.throughputTPS, 2)} tok/s`],
      ['Requests / completed tokens', `${r.serving.requests.length} / ${r.serving.completedTokens}`],
      ['Serving P50 / P95 token', `${ms(r.serving.p50TokenMs)} / ${ms(r.serving.p95TokenMs)}`],
      ['Shared SSD queue', ms(r.serving.resources.ssd.queueMs)]
    ] : []),
    ['Aggregate capacity upper bound', `${fmt(r.agg, 2)} tok/s`],
    ['Placement / DRAM / VRAM cache', `${r.c.placementInfo.policy} / ${fmt(r.c.dcache, 2)} / ${fmt(r.c.vcache, 2)} GB`],
    ['Prefill critical path', `${criticalPath} · ${ms(r.prefill)}`],
    ['Prefill compute/storage/PCIe/DRAM', `${ms(prefillPaths.Compute)} / ${ms(prefillPaths.Storage)} / ${ms(prefillPaths.PCIe)} / ${ms(prefillPaths.DRAM)}`],
    ['Prefill Expert storage/transfer', `${fmt(r.prefillBreakdown.storageGB, 2)} / ${fmt(r.prefillBreakdown.transferGB, 2)} GB`],
    ['SSD / PCIe / DRAM bound', `${fmt(r.ssdBound, 2)} / ${Number.isFinite(r.pcieBound) ? fmt(r.pcieBound, 2) : 'N/A'} / ${fmt(r.dramBound, 2)}`],
    ['Storage observed/configured', `${fmt(r.observed, 2)} / ${fmt(r.c.ssdBW, 2)} GB/s`],
    ['Storage busy / queue', `${ms(r.ssdBusy)} / ${ms(r.ssdQueue)}`],
    ['Expert demand / prefetch', `${fmt(r.storageByKind['expert-demand-read'] || 0, 2)} / ${fmt(r.storageByKind['expert-prefetch-read'] || 0, 2)} GB`],
    ['Swap read / write', `${fmt(r.storageByKind['swap-in-read'] || 0, 2)} / ${fmt(r.storageByKind['swap-out-write'] || 0, 2)} GB`],
    ['Prefetch useful/wasted/late', `${r.tot.pfUseful} / ${r.tot.pfWasted} / ${r.tot.pfLate}`],
    ['VRAM promotions', r.tot.vPromotions],
    ['Cache evictions', r.ev]
  ]);
  const last = r.tokens[r.tokens.length - 1].memory;
  $('memory').innerHTML = rows([
    ['Physical Host / Unified', `${fmt(last.physicalUsedGB, 2)} / ${fmt(r.c.host, 1)} GB`],
    ['Expert Cache', `${fmt(last.expertCacheGB, 2)} GB`],
    ['Page Cache', `${fmt(last.pageCacheGB, 2)} GB`],
    ['KV resident', `${fmt(last.kvResidentGB, 3)} GB`],
    ['Compressed original', `${fmt(last.compressedOriginalGB, 3)} GB`],
    ['Swap allocated / in-flight', `${fmt(last.swapGB, 3)} GB`],
    ['Device KV', `${fmt(r.state.deviceKVGB, 3)} GB`],
    ['Device cache / KV / reserve', `${fmt(last.deviceUsedGB, 3)} / ${fmt(r.c.vram, 1)} GB`],
    ['O_DIRECT', r.c.odirect ? 'Enabled' : 'Disabled']
  ]);
  $('modelStatus').innerHTML = `<b>Estimated · Colibri V1.5 event/resource model</b><br>Run ID: <code>${r.runId || 'single-request'}</code><br>Prefill warms the Expert tiers. Demand, causal Prefetch, Swap-in and Swap-out share storage. Concurrency &gt; 1 uses an event queue with shared SSD, PCIe, DRAM and batched compute resources.<br><br><b>Interpretation:</b> Results remain uncalibrated sensitivity estimates, not measured hardware predictions. Completed requests commit shared Expert-cache residency; overlapping misses remain conservatively independent. GPU VRAM bandwidth and OS page-level behavior remain outside this model.`;
}
function renderAFM(r) {
  $('tpotLabel').textContent = 'Effective TPOT';
  $('tpsLabel').textContent = 'Aggregate TPS';
  $('storageLabel').textContent = 'NAND / token';
  $('hitLabel').textContent = 'Set overlap';
  const avgChanged = r.switches.length ? r.tot.changedTotal / r.switches.length : 0;
  const avgSwitch = r.switches.length ? r.tot.periodicGB / r.switches.length : 0;
  $('summary').innerHTML = rows([
    ...(r.serving ? [
      ['Event scheduler throughput', `${fmt(r.serving.throughputTPS, 2)} tok/s`],
      ['Requests / completed tokens', `${r.serving.requests.length} / ${r.serving.completedTokens}`],
      ['Serving P50 / P95 token', `${ms(r.serving.p50TokenMs)} / ${ms(r.serving.p95TokenMs)}`],
      ['Shared SSD queue', ms(r.serving.resources.ssd.queueMs)]
    ] : []),
    ['Steady TPS / TPOT', `${fmt(r.steadyTPS, 2)} / ${ms(r.steady)}`],
    ['Boundary TPOT', ms(r.boundaryTPOT)],
    ['P95 TPOT', ms(r.p95)],
    ['Selection frequency', `${r.c.freq} tokens`],
    ['Periodic reselections', r.switches.length],
    ['Average changed experts', `${fmt(avgChanged, 2)} / ${r.c.routed}`],
    ['Initial routed NAND read', mb(r.tot.initialReadGB)],
    ['Average read / switch', mb(avgSwitch)],
    ['Swap read / write', `${fmt(r.storageByKind['swap-in-read'] || 0, 2)} / ${fmt(r.storageByKind['swap-out-write'] || 0, 2)} GB`],
    ['NAND observed/configured', `${fmt(r.observed, 3)} / ${fmt(r.c.ssdBW, 2)} GB/s`],
    ['Aggregate capacity upper bound', `${fmt(r.agg, 2)} tok/s`]
  ]);
  const last = r.tokens[r.tokens.length - 1].memory;
  $('memory').innerHTML = rows([
    ['Physical Unified Memory', `${fmt(last.physicalUsedGB, 3)} / ${fmt(r.c.host, 1)} GB`],
    ['Common resident weights', `${fmt(r.c.commonGB, 3)} GB`],
    ['Shared Expert weights', `${fmt(r.d.sharedGB, 3)} GB`],
    ['Current Routed weights', `${fmt(r.d.routedGB, 3)} GB`],
    ['Double buffer', `${fmt(r.c.doubleBuffer ? r.d.routedGB : 0, 3)} GB`],
    ['KV resident', `${fmt(last.kvResidentGB, 3)} GB`],
    ['Swap allocated / in-flight', `${fmt(last.swapGB, 3)} GB`],
    ['Estimated full 20B NAND', `${fmt(r.d.totalNandGB, 3)} GB`]
  ]);
  $('modelStatus').innerHTML = `<b>Estimated · AFM 3 V1.5 event/resource model</b><br>Run ID: <code>${r.runId || 'single-request'}</code><br>Shared and current Routed Expert sets remain pinned. Concurrency &gt; 1 uses shared event-driven resources and batched compute.<br><br><span class="afmMark">Constant Table 없음:</span> actual Expert IDs and layer masks are not reconstructed; overlap-driven delta loading is used.`;
}
function clearRenderedResult() {
  if (typeof stop === 'function') stop();
  if (typeof anim === 'object' && anim) {
    anim.result = null;
    anim.parts = [];
    anim.index = 0;
    anim.action = null;
    anim.paused = false;
  }
  for (const id of ['ttft', 'tpot', 'tps', 'ssdpt', 'hit', 'mem']) $(id).textContent = '—';
  for (const id of ['summary', 'pressureSummary', 'memory', 'modelStatus', 'comparisonSummary', 'traceSummary', 'storageTraceSummary']) $(id).innerHTML = '';
  $('token').innerHTML = '';
  $('status').textContent = 'Invalid result';
  $('progress').style.width = '0';
  $('pause').textContent = 'Ⅱ Pause';
  for (const id of ['chart', 'storageChart', 'memoryChart']) {
    const canvas = $(id);
    if (canvas && typeof canvas.getContext === 'function') canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
}

function render(r) {
  lastResult = r;
  if (r.error) {
    clearRenderedResult();
    const insight = createBottleneckInsight(r);
    renderBottleneckAdvisor(insight);
    if (typeof renderGuidedAnalysis === 'function') renderGuidedAnalysis(insight, r);
    $('warn').hidden = false;
    $('warn').textContent = r.error;
    return;
  }
  $('warn').hidden = !r.oom;
  if (r.oom) $('warn').textContent = 'Simulation reached OOM/Hard pressure. Results after the last completed token are not available.';
  $('ttft').textContent = ms(r.ttft);
  $('tpot').textContent = ms(r.avg);
  $('tpsLabel').textContent = 'Aggregate TPS';
  $('tps').textContent = fmt(r.serving?.throughputTPS ?? r.agg ?? r.tps, 2);
  $('ssdpt').textContent = r.mode === 'afm3' ? mb(r.ssdPt) : `${fmt(r.ssdPt, 2)} GB`;
  $('hit').textContent = pct(r.hit);
  $('mem').textContent = `${fmt(r.state.peakPhysicalGB, 1)} GB peak`;
  const insight = createBottleneckInsight(r);
  renderBottleneckAdvisor(insight);
  if (typeof renderGuidedAnalysis === 'function') renderGuidedAnalysis(insight, r);
  r.mode === 'afm3' ? renderAFM(r) : renderColibri(r);
  renderPressure(r);
  renderTraceTable(r);
  drawPerformance(r);
  renderStorageIO(r);
  drawMemory(r);
}

function renderTraceTable(r) {
  const rows = r.tokens.map((token, index) => `<tr><th scope="row">Token ${index + 1}</th><td>${fmt(token.tpot, 3)} ms</td><td>${fmt(token.ssdGB || 0, 6)} GB</td><td>${fmt(token.memory.physicalUsedGB, 3)} GB</td><td>${fmt(token.memory.swapGB, 3)} GB</td><td>${token.memory.pressureState}</td></tr>`).join('');
  $('traceSummary').innerHTML = `<caption>Token performance and memory trace</caption><thead><tr><th scope="col">Token</th><th scope="col">TPOT</th><th scope="col">SSD</th><th scope="col">Physical memory</th><th scope="col">Swap allocated / in-flight</th><th scope="col">Pressure</th></tr></thead><tbody>${rows}</tbody>`;
}

function storageIOUnit(yMode) {
  return ({ gb: 'GB', gbps: 'GB/s', 'service-ms': 'ms service', 'queue-ms': 'ms queue' })[yMode] || 'GB';
}

function chartAxisSpec(kind, options = {}) {
  if (kind === 'overlay') return { xLabel: 'Execution index (0 = prefill)', yLabel: 'Normalized value (%)' };
  if (kind === 'performance') return { xLabel: 'Token index', yLabel: 'TPOT (ms)' };
  if (kind === 'memory') return { xLabel: 'Token index', yLabel: 'Memory (GB)' };
  if (kind === 'sweep-ttft') return { xLabel: 'Sweep run (0 = baseline)', yLabel: 'TTFT (ms)' };
  if (kind === 'sweep-tps') return { xLabel: 'Sweep run (0 = baseline)', yLabel: 'Throughput (tokens/s)' };
  if (kind === 'storage') {
    const xLabel = ({
      'token-index': 'Execution bucket (0 = prefill)',
      'completion-time': 'Completion time (ms)',
      'cumulative-io': 'Cumulative I/O (GB)'
    })[options.xMode] || 'Execution bucket (0 = prefill)';
    const yLabel = ({
      gb: 'Storage I/O (GB)',
      gbps: 'Effective bandwidth (GB/s)',
      'service-ms': 'Storage service time (ms)',
      'queue-ms': 'Storage queue time (ms)'
    })[options.yMode] || 'Storage I/O (GB)';
    return { xLabel, yLabel };
  }
  return { xLabel: 'X', yLabel: 'Y' };
}

function chartTickLabel(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude > 0 && magnitude < 0.01) return value.toExponential(1);
  if (magnitude >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function chartSeriesPosition(index, length) {
  return length <= 1 ? 0.5 : index / (length - 1);
}

function chartDomainPosition(value, min, max) {
  return max <= min ? 0.5 : (value - min) / (max - min);
}

function chartUsesAxes(kind, mode) {
  return mode !== 'overlay' || kind === 'performance';
}

function drawChartPoint(context, x, y, color) {
  context.fillStyle = color;
  context.beginPath();
  context.arc(x, y, 3, 0, Math.PI * 2);
  context.fill();
}

function chartLinearTicks(min, max, count = 5, descending = false) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [{ position: 0.5, label: chartTickLabel(min) }];
  return Array.from({ length: count }, (_, index) => {
    const position = index / Math.max(1, count - 1);
    const value = descending ? max - (max - min) * position : min + (max - min) * position;
    return { position, label: chartTickLabel(value) };
  });
}

function chartPalette() {
  const read = (name, fallback) => {
    if (typeof getComputedStyle !== 'function' || !document?.documentElement) return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  };
  return {
    background: read('--chart-bg', '#071525'),
    grid: read('--chart-grid', '#29445f'),
    text: read('--chart-text', '#9db0c8'),
    cyan: read('--chart-cyan', '#67d9ff'),
    green: read('--chart-green', '#34b77a'),
    violet: read('--chart-violet', '#8b6fe8'),
    red: read('--chart-red', '#e4526f'),
    yellow: read('--chart-yellow', '#c78a00')
  };
}

function drawCartesianAxes(context, options) {
  const palette = chartPalette();
  const { left, top, width, height, xTicks = [], yTicks = [], xLabel, yLabel } = options;
  context.save();
  context.font = '10px sans-serif';
  context.lineWidth = 1;
  context.strokeStyle = palette.grid;
  context.fillStyle = palette.text;
  for (const tick of yTicks) {
    const y = top + height * tick.position;
    context.beginPath(); context.moveTo(left, y); context.lineTo(left + width, y); context.stroke();
    context.textAlign = 'right'; context.textBaseline = 'middle'; context.fillText(tick.label, left - 8, y);
  }
  for (const tick of xTicks) {
    const x = left + width * tick.position;
    context.beginPath(); context.moveTo(x, top); context.lineTo(x, top + height); context.stroke();
    context.textAlign = 'center'; context.textBaseline = 'top'; context.fillText(tick.label, x, top + height + 7);
  }
  context.textAlign = 'center'; context.textBaseline = 'top';
  context.fillText(xLabel, left + width / 2, top + height + 27);
  context.save();
  context.translate(12, top + height / 2);
  context.rotate(-Math.PI / 2);
  context.textBaseline = 'top';
  context.fillText(yLabel, 0, 0);
  context.restore();
  context.restore();
}

function renderStorageIO(r) {
  const xMode = $('storageXAxis')?.value || 'token-index';
  const yMode = $('storageYAxis')?.value || 'gb';
  const buckets = buildStorageIOBuckets(r, { xMode, yMode });
  const table = $('storageTraceSummary');
  if (table) {
    const body = buckets.map(bucket => `<tr><th scope="row">${advisorEscape(bucket.label)}</th><td>${fmt(bucket.x, 4)}</td><td>${fmt(bucket.series.expertRead, 6)}</td><td>${fmt(bucket.series.prefetchRead, 6)}</td><td>${fmt(bucket.series.swapInRead, 6)}</td><td>${fmt(bucket.series.swapOutWrite, 6)}</td></tr>`).join('');
    table.innerHTML = `<caption>Storage I/O by execution bucket · ${advisorEscape(storageIOUnit(yMode))}</caption><thead><tr><th scope="col">Bucket</th><th scope="col">X</th><th scope="col">Expert / window read</th><th scope="col">Prefetch read</th><th scope="col">Swap-in read</th><th scope="col">Swap-out write</th></tr></thead><tbody>${body}</tbody>`;
  }
  const canvas = $('storageChart');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const context = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
  const palette = chartPalette();
  const viewMode = $('graphViewMode')?.value || 'tabs';
  context.clearRect(0, 0, width, height);
  if (viewMode !== 'overlay') { context.fillStyle = palette.background; context.fillRect(0, 0, width, height); }
  const maxValue = Math.max(EPS, ...buckets.map(bucket => Object.values(bucket.series).reduce((sum, value) => sum + value, 0)));
  const colors = { expertRead: palette.cyan, prefetchRead: palette.green, swapInRead: palette.violet, swapOutWrite: palette.red };
  const plotLeft = 68, plotTop = 26, plotWidth = width - 88, plotHeight = height - 82;
  const xValues = buckets.map(bucket => Number(bucket.x)).filter(Number.isFinite);
  const xMin = xValues.length ? Math.min(...xValues) : 0;
  const xMax = xValues.length ? Math.max(...xValues) : 1;
  if (chartUsesAxes('storage', viewMode)) {
    drawCartesianAxes(context, {
      left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight,
      xTicks: chartLinearTicks(xMin, xMax),
      yTicks: chartLinearTicks(0, maxValue, 5, true),
      ...chartAxisSpec('storage', { xMode, yMode })
    });
  }
  const barWidth = Math.max(2, plotWidth / Math.max(1, buckets.length) * 0.65);
  const xPositions = storageIOXPositions(buckets, plotLeft, plotWidth);
  buckets.forEach((bucket, index) => {
    const x = xPositions[index];
    const barLeft = Math.max(plotLeft, x - barWidth / 2);
    const barRight = Math.min(plotLeft + plotWidth, x + barWidth / 2);
    let bottom = plotTop + plotHeight;
    for (const [series] of STORAGE_IO_SERIES) {
      const barHeight = plotHeight * bucket.series[series] / maxValue;
      context.fillStyle = colors[series];
      context.fillRect(barLeft, bottom - barHeight, barRight - barLeft, barHeight);
      bottom -= barHeight;
    }
  });
  context.fillStyle = palette.text; context.font = '11px sans-serif';
  context.textAlign = 'left'; context.textBaseline = 'alphabetic';
  if (viewMode !== 'overlay') context.fillText(`Read stacks + Write · ${storageIOUnit(yMode)}`, 8, 14);
}

function syncGraphView() {
  const panels = $('graphPanels');
  if (!panels || typeof document.querySelectorAll !== 'function') return;
  const mode = $('graphViewMode')?.value || 'tabs';
  const active = $('graphTab')?.value || 'performance';
  panels.className = `graphPanels ${mode}`;
  document.querySelectorAll('.graphPanel').forEach(panel => { panel.hidden = mode === 'tabs' && panel.dataset.graph !== active; });
  const tab = $('graphTab');
  if (tab) tab.disabled = mode !== 'tabs';
  const disclosure = $('overlayDisclosure');
  if (disclosure) disclosure.hidden = mode !== 'overlay';
  if (lastResult && !lastResult.error) { drawPerformance(lastResult); renderStorageIO(lastResult); drawMemory(lastResult); }
}

function drawPerformance(r) {
  const cv = $('chart'), x = cv.getContext('2d'), W = cv.width, H = cv.height;
  const d = r.tokens.map(t => t.tpot), mx = Math.max(...d) * 1.15 || 1;
  const palette = chartPalette();
  const viewMode = $('graphViewMode')?.value || 'tabs';
  const overlay = viewMode === 'overlay';
  const plotLeft = 68, plotTop = 26, plotWidth = W - 88, plotHeight = H - 82;
  x.clearRect(0, 0, W, H);
  x.fillStyle = palette.background; x.fillRect(0, 0, W, H);
  drawCartesianAxes(x, {
    left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight,
    xTicks: overlay ? chartLinearTicks(0, Math.max(1, d.length)) : chartLinearTicks(1, Math.max(1, d.length)),
    yTicks: overlay ? chartLinearTicks(0, 100, 5, true) : chartLinearTicks(0, mx, 5, true),
    ...chartAxisSpec(overlay ? 'overlay' : 'performance')
  });
  if (r.mode === 'afm3') {
    x.strokeStyle = palette.violet; x.lineWidth = 1;
    for (let i = 0; i < r.tokens.length; i++) if (r.tokens[i].boundary) {
      const xx = plotLeft + plotWidth * (overlay ? chartDomainPosition(i + 1, 0, d.length) : chartSeriesPosition(i, d.length));
      x.beginPath(); x.moveTo(xx, plotTop); x.lineTo(xx, plotTop + plotHeight); x.stroke(); x.fillStyle = '#7657cf'; if (!overlay) x.fillText('IFP', xx + 3, plotTop + 11);
    }
  }
  x.strokeStyle = '#1687b8'; x.lineWidth = 2; x.beginPath();
  d.forEach((v, i) => { const xx = plotLeft + plotWidth * (overlay ? chartDomainPosition(i + 1, 0, d.length) : chartSeriesPosition(i, d.length)), yy = plotTop + plotHeight * (1 - v / mx); i ? x.lineTo(xx, yy) : x.moveTo(xx, yy); });
  x.stroke();
  if (d.length === 1) drawChartPoint(x, plotLeft + plotWidth * (overlay ? chartDomainPosition(1, 0, 1) : chartSeriesPosition(0, 1)), plotTop + plotHeight * (1 - d[0] / mx), '#1687b8');
  x.fillStyle = palette.text; x.font = '11px sans-serif'; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; if (!overlay) x.fillText(r.mode === 'afm3' ? 'TPOT · violet = IFP boundary' : 'TPOT per token', 8, 14);
}
function drawMemory(r) {
  const cv = $('memoryChart'), x = cv.getContext('2d'), W = cv.width, H = cv.height;
  const used = r.tokens.map(t => t.memory.physicalUsedGB);
  const sw = r.tokens.map(t => t.memory.swapGB);
  const maxY = Math.max(r.c.host, ...used) * 1.05 || 1;
  const palette = chartPalette();
  const viewMode = $('graphViewMode')?.value || 'tabs';
  const plotLeft = 68, plotTop = 26, plotWidth = W - 88, plotHeight = H - 82;
  x.clearRect(0, 0, W, H);
  if (viewMode !== 'overlay') { x.fillStyle = palette.background; x.fillRect(0, 0, W, H); }
  if (chartUsesAxes('memory', viewMode)) {
    drawCartesianAxes(x, {
      left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight,
      xTicks: chartLinearTicks(1, Math.max(1, used.length)),
      yTicks: chartLinearTicks(0, maxY, 5, true),
      ...chartAxisSpec('memory')
    });
  }
  const yOf = v => plotTop + plotHeight * (1 - v / maxY);
  const line = (arr, color) => { x.strokeStyle = color; x.lineWidth = 2; x.beginPath(); arr.forEach((v, i) => { const xx = plotLeft + plotWidth * (viewMode === 'overlay' ? chartDomainPosition(i + 1, 0, arr.length) : chartSeriesPosition(i, arr.length)), yy = yOf(v); i ? x.lineTo(xx, yy) : x.moveTo(xx, yy); }); x.stroke(); if (arr.length === 1) drawChartPoint(x, plotLeft + plotWidth * (viewMode === 'overlay' ? chartDomainPosition(1, 0, 1) : chartSeriesPosition(0, 1)), yOf(arr[0]), color); };
  const trigger = thresholdGB(r.c, r.c.mem.swap);
  const hard = thresholdGB(r.c, r.c.mem.hard);
  x.setLineDash([5, 4]); x.strokeStyle = palette.yellow; x.beginPath(); x.moveTo(plotLeft, yOf(trigger)); x.lineTo(plotLeft + plotWidth, yOf(trigger)); x.stroke();
  x.strokeStyle = palette.red; x.beginPath(); x.moveTo(plotLeft, yOf(hard)); x.lineTo(plotLeft + plotWidth, yOf(hard)); x.stroke(); x.setLineDash([]);
  line(used, '#1687b8'); line(sw, palette.violet);
  x.fillStyle = palette.text; x.font = '11px sans-serif'; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; if (viewMode !== 'overlay') x.fillText('blue: physical memory · violet: swap · dashed: swap/hard trigger', 8, 14);
}
