function advisorEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function advisorScoreClass(score) {
  return score >= 70 ? 'score scoreHigh' : score >= 35 ? 'score scoreMedium' : 'score';
}

function renderBottleneckAdvisor(insight) {
  const target = $('advisor');
  if (!target) return;
  const heading = '<div class="advisorHead"><h2 id="advisorTitle">병목 분석 가이드</h2><span class="note">상대 압력 · 시뮬레이터 추적 전용</span></div>';
  if (!insight || insight.status === 'unavailable') {
    target.innerHTML = `${heading}<div class="advisorUnavailable"><b>${advisorEscape(insight?.reason || '사용할 수 없음')}</b><br><span class="note">${advisorEscape(insight?.disclaimer || '')}</span></div>`;
    return;
  }
  const cards = insight.phases.map(phase => {
    const resources = phase.resources.map(resource => {
      const evidence = resource.evidence.map(item => `<li><b>${advisorEscape(item.label)}:</b> ${advisorEscape(item.value)} ${advisorEscape(item.unit)}${item.note ? ` · ${advisorEscape(item.note)}` : ''}</li>`).join('');
      const recommendation = resource.recommendation;
      return `<details class="resourceInsight"><summary><span>${advisorEscape(resource.label)}</span><span class="${advisorScoreClass(resource.score)}">${resource.score}/100</span></summary><ul class="advisorEvidence"><li><b>계산식:</b> ${advisorEscape(resource.formula)}</li>${evidence}</ul><div class="advisorRecommendation"><b>${advisorEscape(recommendation.priority)}:</b> ${advisorEscape(recommendation.controls)} · ${advisorEscape(recommendation.direction)}<br><b>적용 조건:</b> ${advisorEscape(recommendation.condition)}<br><b>부작용:</b> ${advisorEscape(recommendation.tradeoff)}</div></details>`;
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
    ['압력 상태', `<span class="${pressureClass(s.lastState)}">${s.lastState}</span>`],
    ['스왑 시작 토큰', s.swapStartToken === null ? '없음' : s.swapStartToken],
    ['최대 물리 메모리', `${fmt(s.peakPhysicalGB, 2)} / ${fmt(r.c.host, 1)} GB`],
    ['최소 여유 메모리', `${fmt(s.minFreeGB, 2)} GB`],
    ['최대 스왑 할당 / 처리 중', `${fmt(s.peakSwapGB, 2)} GB`],
    ['전체 스왑 인 / 아웃', `${fmt(s.totalSwapInGB, 2)} / ${fmt(s.totalSwapOutGB, 2)} GB`],
    ['페이지 / Expert 회수량', `${fmt(s.totalPageReclaimedGB, 2)} / ${fmt(s.totalExpertReclaimedGB, 2)} GB`],
    ['스래싱 비율', pct(thrash)],
    ['최대 DRAM 대역폭', `${fmt(s.peakDramGBs, 1)} / ${fmt(r.c.dramBW, 1)} GB/s`],
    ['DRAM 유발 지연', ms(s.totalDramStallMs / Math.max(1, r.tokens.length)) + ' / token']
  ]);
}
function renderColibri(r) {
  $('tpotLabel').textContent = '평균 TPOT';
  $('tpsLabel').textContent = '전체 TPS';
  $('storageLabel').textContent = '토큰당 스토리지';
  $('hitLabel').textContent = '캐시 적중률';
  const prefillPaths = {
    Compute: r.prefillBreakdown.computeMs,
    Storage: r.prefillBreakdown.storageMs,
    PCIe: r.prefillBreakdown.transferMs,
    DRAM: r.prefillBreakdown.dramMs
  };
  const criticalPath = Object.entries(prefillPaths).sort((a, b) => b[1] - a[1])[0][0];
  $('summary').innerHTML = rows([
    ...(r.serving ? [
      ['이벤트 스케줄러 처리량', `${fmt(r.serving.throughputTPS, 2)} tok/s`],
      ['요청 수 / 완료 토큰 수', `${r.serving.requests.length} / ${r.serving.completedTokens}`],
      ['서빙 토큰 P50 / P95', `${ms(r.serving.p50TokenMs)} / ${ms(r.serving.p95TokenMs)}`],
      ['공유 SSD 큐 대기', ms(r.serving.resources.ssd.queueMs)]
    ] : []),
    ['전체 처리량 상한', `${fmt(r.agg, 2)} tok/s`],
    ['배치 정책 / DRAM / VRAM 캐시', `${r.c.placementInfo.policy} / ${fmt(r.c.dcache, 2)} / ${fmt(r.c.vcache, 2)} GB`],
    ['프리필 임계 경로', `${criticalPath} · ${ms(r.prefill)}`],
    ['프리필 연산/스토리지/PCIe/DRAM', `${ms(prefillPaths.Compute)} / ${ms(prefillPaths.Storage)} / ${ms(prefillPaths.PCIe)} / ${ms(prefillPaths.DRAM)}`],
    ['프리필 Expert 스토리지/전송', `${fmt(r.prefillBreakdown.storageGB, 2)} / ${fmt(r.prefillBreakdown.transferGB, 2)} GB`],
    ['SSD / PCIe / DRAM 병목 상한', `${fmt(r.ssdBound, 2)} / ${Number.isFinite(r.pcieBound) ? fmt(r.pcieBound, 2) : 'N/A'} / ${fmt(r.dramBound, 2)}`],
    ['스토리지 관측/설정 대역폭', `${fmt(r.observed, 2)} / ${fmt(r.c.ssdBW, 2)} GB/s`],
    ['스토리지 사용/큐 대기', `${ms(r.ssdBusy)} / ${ms(r.ssdQueue)}`],
    ['Expert 요청 / 프리페치', `${fmt(r.storageByKind['expert-demand-read'] || 0, 2)} / ${fmt(r.storageByKind['expert-prefetch-read'] || 0, 2)} GB`],
    ['스왑 읽기 / 쓰기', `${fmt(r.storageByKind['swap-in-read'] || 0, 2)} / ${fmt(r.storageByKind['swap-out-write'] || 0, 2)} GB`],
    ['프리페치 유효/낭비/지연', `${r.tot.pfUseful} / ${r.tot.pfWasted} / ${r.tot.pfLate}`],
    ['VRAM 승격 횟수', r.tot.vPromotions],
    ['캐시 축출 횟수', r.ev]
  ]);
  const last = r.tokens[r.tokens.length - 1].memory;
  $('memory').innerHTML = rows([
    ['물리 Host / 통합 메모리', `${fmt(last.physicalUsedGB, 2)} / ${fmt(r.c.host, 1)} GB`],
    ['Expert 캐시', `${fmt(last.expertCacheGB, 2)} GB`],
    ['페이지 캐시', `${fmt(last.pageCacheGB, 2)} GB`],
    ['상주 KV', `${fmt(last.kvResidentGB, 3)} GB`],
    ['압축 전 원본 크기', `${fmt(last.compressedOriginalGB, 3)} GB`],
    ['스왑 할당 / 처리 중', `${fmt(last.swapGB, 3)} GB`],
    ['장치 KV', `${fmt(r.state.deviceKVGB, 3)} GB`],
    ['장치 캐시 / KV / 예약 영역', `${fmt(last.deviceUsedGB, 3)} / ${fmt(r.c.vram, 1)} GB`],
    ['O_DIRECT', r.c.odirect ? '사용' : '사용 안 함']
  ]);
  $('modelStatus').innerHTML = `<b>추정 모델 · Colibri V1.6.2 이벤트/자원 모델</b><br>Run ID: <code>${r.runId || 'single-request'}</code><br>프리필 단계에서 Expert 계층을 준비합니다. 요청 읽기, 인과적 프리페치, 스왑 인·아웃은 스토리지를 공유합니다. 동시성 &gt; 1에서는 공유 SSD·PCIe·DRAM과 배치 연산 자원을 이벤트 큐로 모델링합니다.<br><br><b>해석:</b> 결과는 실측 하드웨어 예측값이 아니라 아직 보정되지 않은 민감도 추정값입니다. 완료된 요청은 공유 Expert 캐시 상주 상태에 반영되며, 동시에 발생한 miss는 보수적으로 독립 처리합니다. GPU VRAM 대역폭과 OS 페이지 단위 동작은 모델 범위 밖입니다.`;
}
function renderAFM(r) {
  $('tpotLabel').textContent = '유효 TPOT';
  $('tpsLabel').textContent = '전체 TPS';
  $('storageLabel').textContent = '토큰당 NAND';
  $('hitLabel').textContent = '집합 중복률';
  const avgChanged = r.switches.length ? r.tot.changedTotal / r.switches.length : 0;
  const avgSwitch = r.switches.length ? r.tot.periodicGB / r.switches.length : 0;
  $('summary').innerHTML = rows([
    ...(r.serving ? [
      ['이벤트 스케줄러 처리량', `${fmt(r.serving.throughputTPS, 2)} tok/s`],
      ['요청 수 / 완료 토큰 수', `${r.serving.requests.length} / ${r.serving.completedTokens}`],
      ['서빙 토큰 P50 / P95', `${ms(r.serving.p50TokenMs)} / ${ms(r.serving.p95TokenMs)}`],
      ['공유 SSD 큐 대기', ms(r.serving.resources.ssd.queueMs)]
    ] : []),
    ['정상 상태 TPS / TPOT', `${fmt(r.steadyTPS, 2)} / ${ms(r.steady)}`],
    ['경계 TPOT', ms(r.boundaryTPOT)],
    ['P95 TPOT', ms(r.p95)],
    ['선택 주기', `${r.c.freq} tokens`],
    ['주기적 재선택 횟수', r.switches.length],
    ['평균 변경 Expert 수', `${fmt(avgChanged, 2)} / ${r.c.routed}`],
    ['초기 Routed NAND 읽기', mb(r.tot.initialReadGB)],
    ['전환당 평균 읽기', mb(avgSwitch)],
    ['스왑 읽기 / 쓰기', `${fmt(r.storageByKind['swap-in-read'] || 0, 2)} / ${fmt(r.storageByKind['swap-out-write'] || 0, 2)} GB`],
    ['NAND 관측/설정 대역폭', `${fmt(r.observed, 3)} / ${fmt(r.c.ssdBW, 2)} GB/s`],
    ['전체 처리량 상한', `${fmt(r.agg, 2)} tok/s`]
  ]);
  const last = r.tokens[r.tokens.length - 1].memory;
  $('memory').innerHTML = rows([
    ['물리 통합 메모리', `${fmt(last.physicalUsedGB, 3)} / ${fmt(r.c.host, 1)} GB`],
    ['공통 상주 가중치', `${fmt(r.c.commonGB, 3)} GB`],
    ['공유 Expert 가중치', `${fmt(r.d.sharedGB, 3)} GB`],
    ['현재 Routed 가중치', `${fmt(r.d.routedGB, 3)} GB`],
    ['이중 버퍼', `${fmt(r.c.doubleBuffer ? r.d.routedGB : 0, 3)} GB`],
    ['상주 KV', `${fmt(last.kvResidentGB, 3)} GB`],
    ['스왑 할당 / 처리 중', `${fmt(last.swapGB, 3)} GB`],
    [`추정 전체 ${fmt(r.c.totalB, 3)}B NAND (용량 메타데이터)`, `${fmt(r.d.totalNandGB, 3)} GB`]
  ]);
  $('modelStatus').innerHTML = `<b>추정 모델 · AFM 3 V1.6.2 이벤트/자원 모델</b><br>Run ID: <code>${r.runId || 'single-request'}</code><br>공유 Expert와 현재 Routed Expert 집합은 고정 상주합니다. 동시성 &gt; 1에서는 공유 이벤트 기반 자원과 배치 연산을 사용합니다.<br><br><span class="afmMark">Constant Table 없음:</span> 실제 Expert ID와 레이어 마스크를 복원하지 않고, 중복률 기반 델타 로딩을 사용합니다.`;
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
  $('status').textContent = '유효하지 않은 결과';
  $('progress').style.width = '0';
  $('pause').textContent = 'Ⅱ 일시정지';
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
  if (r.oom) $('warn').textContent = '시뮬레이션이 OOM/하드 압력에 도달했습니다. 마지막 완료 토큰 이후 결과는 제공되지 않습니다.';
  $('ttft').textContent = ms(r.ttft);
  $('tpot').textContent = ms(r.avg);
  $('tpsLabel').textContent = '전체 TPS';
  $('tps').textContent = fmt(r.serving?.throughputTPS ?? r.agg ?? r.tps, 2);
  $('ssdpt').textContent = r.mode === 'afm3' ? mb(r.ssdPt) : `${fmt(r.ssdPt, 2)} GB`;
  $('hit').textContent = pct(r.hit);
  $('mem').textContent = `${fmt(r.state.peakPhysicalGB, 1)} GB 최대`;
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
  const rows = r.tokens.map((token, index) => `<tr><th scope="row">토큰 ${index + 1}</th><td>${fmt(token.tpot, 3)} ms</td><td>${fmt(token.ssdGB || 0, 6)} GB</td><td>${fmt(token.memory.physicalUsedGB, 3)} GB</td><td>${fmt(token.memory.swapGB, 3)} GB</td><td>${token.memory.pressureState}</td></tr>`).join('');
  $('traceSummary').innerHTML = `<caption>토큰 성능 및 메모리 추적</caption><thead><tr><th scope="col">토큰</th><th scope="col">TPOT</th><th scope="col">SSD</th><th scope="col">물리 메모리</th><th scope="col">스왑 할당 / 처리 중</th><th scope="col">압력</th></tr></thead><tbody>${rows}</tbody>`;
}

function storageIOUnit(yMode) {
  return ({ gb: 'GB', gbps: 'GB/s', 'service-ms': '서비스 ms', 'queue-ms': '큐 대기 ms' })[yMode] || 'GB';
}

function chartAxisSpec(kind, options = {}) {
  if (kind === 'overlay') return { xLabel: '실행 인덱스 (0 = 프리필)', yLabel: '정규화 값 (%)' };
  if (kind === 'performance') return { xLabel: '토큰 인덱스', yLabel: 'TPOT (ms)' };
  if (kind === 'memory') return { xLabel: '토큰 인덱스', yLabel: '메모리 (GB)' };
  if (kind === 'sweep-ttft') return { xLabel: '스윕 실행 (0 = 기준)', yLabel: 'TTFT (ms)' };
  if (kind === 'sweep-tps') return { xLabel: '스윕 실행 (0 = 기준)', yLabel: '처리량 (토큰/s)' };
  if (kind === 'storage') {
    const xLabel = ({
      'token-index': '실행 구간 (0 = 프리필)',
      'completion-time': '완료 시간 (ms)',
      'cumulative-io': '누적 I/O (GB)'
    })[options.xMode] || '실행 구간 (0 = 프리필)';
    const yLabel = ({
      gb: '스토리지 I/O (GB)',
      gbps: '유효 대역폭 (GB/s)',
      'service-ms': '스토리지 서비스 시간 (ms)',
      'queue-ms': '스토리지 큐 대기시간 (ms)'
    })[options.yMode] || '스토리지 I/O (GB)';
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
    table.innerHTML = `<caption>실행 구간별 스토리지 I/O · ${advisorEscape(storageIOUnit(yMode))}</caption><thead><tr><th scope="col">구간</th><th scope="col">X</th><th scope="col">Expert / 윈도 읽기</th><th scope="col">프리페치 읽기</th><th scope="col">스왑 인 읽기</th><th scope="col">스왑 아웃 쓰기</th></tr></thead><tbody>${body}</tbody>`;
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
  if (viewMode !== 'overlay') context.fillText(`읽기 계층 + 쓰기 · ${storageIOUnit(yMode)}`, 8, 14);
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
  x.fillStyle = palette.text; x.font = '11px sans-serif'; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; if (!overlay) x.fillText(r.mode === 'afm3' ? 'TPOT · 보라색 = IFP 경계' : '토큰별 TPOT', 8, 14);
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
  x.fillStyle = palette.text; x.font = '11px sans-serif'; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; if (viewMode !== 'overlay') x.fillText('파랑: 물리 메모리 · 보라: 스왑 · 점선: 스왑/하드 압력 시작점', 8, 14);
}
