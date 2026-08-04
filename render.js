function advisorEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function advisorScoreClass(score) {
  return score >= 70 ? 'score scoreHigh' : score >= 35 ? 'score scoreMedium' : 'score';
}

function advisorScoreBand(score) {
  if (score >= 70) return { label: '높음', glyph: '▲' };
  if (score >= 35) return { label: '주의', glyph: '◆' };
  return { label: '낮음', glyph: '○' };
}

const ADVISOR_PHASE_LABELS_KO = Object.freeze({
  prefill: '프리필 (Prefill)',
  'first-token': '첫 토큰 (First token)',
  decode: '디코드 (Decode)',
  'memory-pressure': '메모리 압력 (Memory pressure)'
});
const ADVISOR_RESOURCE_LABELS_KO = Object.freeze({
  storage: '스토리지 (Storage)',
  'data-movement': '데이터 이동 (Data movement)',
  compute: '연산 (Compute)',
  'capacity-policy': '용량 / 정책 (Capacity / policy)'
});
const ADVISOR_PRIORITY_LABELS_KO = Object.freeze({ Monitor: '관찰', Consider: '검토', Urgent: '긴급' });
const ADVISOR_EVIDENCE_LABELS_KO = Object.freeze({
  'Average AFM patch materialization': '평균 AFM 패치 구체화',
  'Average Expert/window storage reads': '평균 Expert/윈도 스토리지 읽기',
  'Average PCIe service demand': '평균 PCIe 서비스 요구량',
  'Average cache hit': '평균 캐시 적중률',
  'Average compute demand': '평균 연산 요구량',
  'Average exact storage queue': '평균 정확 스토리지 큐 대기',
  'Average exact storage service': '평균 정확 스토리지 서비스',
  'Average exposed DRAM stall': '평균 노출 DRAM 지연',
  'Average prefetch reads': '평균 프리페치 읽기',
  'Average swap read/write': '평균 스왑 읽기/쓰기',
  'Average swap read/write service': '평균 스왑 읽기/쓰기 서비스',
  'Cache-hit metric available': '캐시 적중률 지표 사용 가능',
  'Completed tokens in phase': '단계에서 완료된 토큰',
  'Configured DRAM': '설정된 DRAM',
  'Configured host / unified capacity': '설정된 Host/통합 메모리 용량',
  'Exposed compression/decompression CPU': '노출된 압축/해제 CPU 시간',
  'First-token physical memory proxy': '첫 토큰 물리 메모리 대푯값',
  'Host / unified capacity': 'Host/통합 메모리 용량',
  'Initial patch transfer': '초기 패치 전송',
  'Initial pre-decode swap service': '디코드 전 초기 스왑 서비스',
  'Initial window read': '초기 윈도 읽기',
  'Modeled prefill path': '모델링된 프리필 경로',
  'Peak memory utilization': '최대 메모리 사용률',
  'Peak modeled DRAM': '최대 모델링 DRAM',
  'Phase elapsed': '단계 경과시간',
  'Physical memory used': '사용된 물리 메모리',
  'Prefill DRAM': '프리필 DRAM',
  'Prefill PCIe transfer': '프리필 PCIe 전송',
  'Prefill compute': '프리필 연산',
  'Prefill elapsed': '프리필 경과시간',
  'Prefill storage': '프리필 스토리지',
  'Pressure-state severity': '압력 상태 심각도',
  'Selector + prompt compute': '선택기 + 프롬프트 연산',
  'Shared PCIe/DRAM queue fraction': '공유 PCIe/DRAM 큐 비율',
  'Shared PCIe/DRAM/patch queue fraction': '공유 PCIe/DRAM/패치 큐 비율',
  'Shared SSD queue': '공유 SSD 큐',
  'Shared compute queue': '공유 연산 큐',
  'Shared compute queue fraction': '공유 연산 큐 비율',
  'Swap thrash ratio': '스왑 스래싱 비율',
  'Token-phase swap service': '토큰 단계 스왑 서비스',
  'Total completed run elapsed': '완료된 실행의 전체 경과시간'
});

function advisorPhaseNoteKo(phase) {
  if (phase.id === 'prefill') return '디코드 전에 프롬프트를 처리하는 경로입니다.';
  if (phase.id === 'first-token') return '프리필 이후 첫 디코드 토큰입니다.';
  if (phase.id === 'decode') return /Unavailable/.test(phase.note) ? '첫 토큰 이후 완료된 디코드 토큰이 없습니다.' : '첫 토큰 이후의 디코드 토큰입니다.';
  if (phase.id === 'memory-pressure') return /OOM/.test(phase.note) ? 'OOM이 발생해 마지막 완료 토큰까지만 표시합니다.' : '완료된 토큰의 최대·누적 메모리 압력입니다.';
  return phase.note;
}

function advisorEvidenceNoteKo(note) {
  if (!note) return '';
  if (/No concurrent serving queue/.test(note)) return '동시 서빙 큐가 없습니다.';
  if (/event-scheduler contention only/.test(note)) return '이벤트 스케줄러의 해당 단계 경합만 포함합니다.';
  if (/First completed token/.test(note)) return '첫 완료 토큰입니다.';
  if (/Tokens after the first/.test(note)) return '첫 토큰 이후의 토큰입니다.';
  if (/No separate prefill memory trace/.test(note)) return '별도의 프리필 메모리 추적은 제공되지 않습니다.';
  if (/Unavailable for this execution engine/.test(note)) return '이 실행 엔진에서는 사용할 수 없어 적중률을 추정하지 않습니다.';
  return note;
}

function advisorDisclaimerKo(insight) {
  const base = '추정 민감도 시뮬레이터 / 미검증 알파. 이 추적의 상대 압력입니다. 실측 하드웨어 진단이 아닙니다. 절대 TTFT/TPS 예측도 아닙니다.';
  return insight?.status === 'oom' || insight?.status === 'oom-before-decode' ? `${base} OOM 이후에는 완료된 토큰의 근거만 유효합니다.` : base;
}

function advisorStatusReasonKo(insight) {
  if (insight?.status === 'oom-before-decode') return '디코드 전 OOM';
  if (insight?.status === 'oom') return '실행 중 OOM';
  return insight?.reason || '';
}

function advisorFormulaKo(formula) {
  if (/100 because the simulator reported OOM before any decode token completed/.test(formula)) return '디코드 토큰 완료 전에 시뮬레이터가 OOM을 보고했으므로 100';
  return formula;
}

function renderBottleneckAdvisor(insight) {
  const target = $('advisor');
  if (!target) return;
  const heading = '<div class="advisorHead"><h2 id="advisorTitle">병목 분석 가이드</h2><span class="note">상대 압력 · 시뮬레이터 추적 전용</span></div>';
  if (!insight || insight.status === 'unavailable') {
    target.innerHTML = `${heading}<div class="advisorUnavailable"><b>구성 검증 실패로 병목 분석을 사용할 수 없습니다.</b><br><span class="note">${advisorEscape(advisorDisclaimerKo(insight))}</span></div>`;
    return;
  }
  const cards = insight.phases.map(phase => {
    const resources = phase.resources.map(resource => {
      const evidence = resource.evidence.map(item => `<li><b>${advisorEscape(ADVISOR_EVIDENCE_LABELS_KO[item.label] || item.label)}:</b> ${advisorEscape(item.value)} ${advisorEscape(item.unit)}${item.note ? ` · ${advisorEscape(advisorEvidenceNoteKo(item.note))}` : ''}</li>`).join('');
      const recommendation = resource.recommendation;
      const scoreBand = advisorScoreBand(resource.score);
      return `<details class="resourceInsight"><summary><span>${advisorEscape(ADVISOR_RESOURCE_LABELS_KO[resource.id] || resource.label)}</span><span class="resourceScore ${advisorScoreClass(resource.score)}" style="--score:${resource.score}" aria-label="상대 압력 ${scoreBand.label}, ${resource.score}점 중 100점"><span aria-hidden="true">${scoreBand.glyph}</span> ${scoreBand.label} · ${resource.score}/100</span></summary><ul class="advisorEvidence"><li><b>계산식:</b> ${advisorEscape(advisorFormulaKo(resource.formula))}</li>${evidence}</ul><div class="advisorRecommendation"><b>${advisorEscape(ADVISOR_PRIORITY_LABELS_KO[recommendation.priority] || recommendation.priority)}:</b> ${advisorEscape(recommendation.controls)} · ${advisorEscape(recommendation.direction)}<br><b>적용 조건:</b> ${advisorEscape(recommendation.condition)}<br><b>부작용:</b> ${advisorEscape(recommendation.tradeoff)}</div></details>`;
    }).join('');
    return `<article class="phaseCard"><h3>${advisorEscape(ADVISOR_PHASE_LABELS_KO[phase.id] || phase.label)}</h3><div class="phaseNote">${advisorEscape(advisorPhaseNoteKo(phase))}</div>${resources}</article>`;
  }).join('');
  const statusNote = insight.reason ? `<div class="advisorUnavailable"><b>${advisorEscape(advisorStatusReasonKo(insight))}</b></div>` : '';
  const advisorDetailsOpen = !(typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches);
  target.innerHTML = `${heading}${statusNote}<div class="note">${advisorEscape(advisorDisclaimerKo(insight))}</div><div class="advisorScoreLegend" aria-label="병목 압력 점수 범례"><span><i class="legendLow"></i>낮음 0–34</span><span><i class="legendMedium"></i>주의 35–69</span><span><i class="legendHigh"></i>높음 70–100</span><small>점수가 높을수록 해당 단계의 상대 압력이 큽니다.</small></div><details class="advisorDetails"${advisorDetailsOpen ? ' open' : ''}><summary>단계별 병목 상세</summary><div class="advisorGrid">${cards}</div></details>`;
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
  $('resultVisuals').hidden = true;
  $('resultInsight').innerHTML = '';
  document.body?.classList.remove('hasResults');
  $('progress').style.width = '0';
  $('pause').textContent = 'Ⅱ 일시정지';
  for (const id of ['chart', 'storageChart', 'memoryChart']) {
    const canvas = $(id);
    if (canvas && typeof canvas.getContext === 'function') canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }
}

function localizedSimulationError(error) {
  const message = String(error || '').trim();
  const invalidPrefix = 'Invalid configuration:';
  if (!message.startsWith(invalidPrefix)) return `시뮬레이션 오류: ${message}`;
  const detail = message.slice(invalidPrefix.length).trim();
  if (!detail) return '구성 오류';
  const range = detail.match(/^([^:]+):\s*\1 must be between ([^ ]+) and ([^.]+)\.$/);
  if (range) return `구성 오류: ${range[1]} 값은 ${range[2]}~${range[3]} 범위여야 합니다.`;
  const required = detail.match(/^([^:]+):\s*\1 is required\.?$/);
  if (required) return `구성 오류: ${required[1]} 값이 필요합니다.`;
  return `구성 오류: ${detail}`;
}

function render(r) {
  lastResult = r;
  if (r.error) {
    clearRenderedResult();
    const insight = createBottleneckInsight(r);
    renderBottleneckAdvisor(insight);
    if (typeof renderGuidedAnalysis === 'function') renderGuidedAnalysis(insight, r);
    $('warn').hidden = false;
    $('warn').textContent = localizedSimulationError(r.error);
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
  const primaryPressure = insight?.phases?.flatMap(phase => phase.resources || []).sort((a, b) => b.score - a.score)[0];
  const peakTpotEntry = (r.tokens || []).reduce((peak, token, index) => !peak || token.tpot > peak.value ? { index, value: token.tpot } : peak, null);
  const memoryPercent = r.c?.host > 0 ? r.state.peakPhysicalGB / r.c.host : 0;
  const swapFact = r.state.swapStartToken === null ? '스왑 시작 없음' : `토큰 ${r.state.swapStartToken}부터 스왑`;
  const peakTpotFact = peakTpotEntry ? `TPOT 최고 ${ms(peakTpotEntry.value)} (토큰 ${peakTpotEntry.index + 1})` : 'TPOT 추세 없음';
  $('resultInsight').innerHTML = `<div><span class="insightEyebrow">결정 요약</span><strong>${advisorEscape(ADVISOR_RESOURCE_LABELS_KO[primaryPressure?.id] || primaryPressure?.label || '주요 자원')} 압력 ${primaryPressure?.score ?? '—'}/100</strong><span>핵심 추세를 먼저 확인한 뒤 병목 상세 근거를 검토하세요.</span><span class="trendFacts">${peakTpotFact} · 메모리 최대 ${fmt(r.state.peakPhysicalGB, 1)} / ${fmt(r.c?.host, 1)} GB (${pct(memoryPercent)}) · ${swapFact}${r.oom ? ' · OOM 이전 완료 토큰 기준' : ''}</span></div><div class="insightMetrics"><span><b>${ms(r.ttft)}</b> TTFT</span><span><b>${fmt(r.serving?.throughputTPS ?? r.agg ?? r.tps, 2)}</b> 전체 TPS</span></div>`;
  $('resultVisuals').hidden = false;
  document.body?.classList.add('hasResults');
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
  context.font = '11px sans-serif';
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

function sizeMainCanvas(canvas, deviceScale = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) {
  const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 930));
  const height = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 250));
  const ratio = Number.isFinite(deviceScale) && deviceScale > 0 ? deviceScale : 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
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
  const { context, width, height } = sizeMainCanvas(canvas);
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
  const cv = $('chart'), { context: x, width: W, height: H } = sizeMainCanvas(cv);
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
  const cv = $('memoryChart'), { context: x, width: W, height: H } = sizeMainCanvas(cv);
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
