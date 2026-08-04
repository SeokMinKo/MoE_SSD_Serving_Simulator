'use strict';

(function initializeTokenIOFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TokenIOUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function tokenIOFactory() {
  const SERIES = Object.freeze([
    Object.freeze({ key: 'demand', label: '요청 읽기', className: 'demand' }),
    Object.freeze({ key: 'prefetch', label: '프리페치', className: 'prefetch' }),
    Object.freeze({ key: 'swapIn', label: '스왑 인', className: 'swapIn' }),
    Object.freeze({ key: 'swapOut', label: '스왑 아웃', className: 'swapOut' })
  ]);
  const MAX_RECENT_TOKENS = 64;
  const MAX_ALL_BUCKETS = 128;
  const state = {
    result: null,
    values: [],
    completedCount: 0,
    selectedIndex: -1,
    status: 'idle',
    viewMode: 'recent',
    scaleMode: 'p95',
    showTpot: true,
    rafId: null,
    latestAnnouncementCount: -1,
    tableDirty: true,
    followLatest: true,
    observer: null,
    themeObserver: null
  };

  function nonnegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function demandGBForToken(token, mode) {
    if (mode === 'afm3') return nonnegative(token?.readGB);
    if (Number.isFinite(Number(token?.demandGB))) return nonnegative(token.demandGB);
    return nonnegative(token?.ssdGB);
  }

  function tokenIOBreakdown(token, mode = 'colibri') {
    const demand = demandGBForToken(token, mode);
    const prefetch = nonnegative(token?.prefetchGB);
    const swapIn = nonnegative(token?.memory?.swapInGB);
    const swapOut = nonnegative(token?.memory?.swapOutGB);
    return Object.freeze({
      demand,
      prefetch,
      swapIn,
      swapOut,
      total: demand + prefetch + swapIn + swapOut,
      tpotMs: nonnegative(token?.tpot),
      pressureState: String(token?.memory?.pressureState || 'NORMAL')
    });
  }

  function buildTokenIOValues(result) {
    const mode = result?.mode || result?.c?.mode || 'colibri';
    return Array.isArray(result?.tokens) ? result.tokens.map(token => tokenIOBreakdown(token, mode)) : [];
  }

  function percentile(values, ratio) {
    const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finite.length) return 0;
    return finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * ratio) - 1))];
  }

  function groupValues(values, startIndex, endIndex) {
    const slice = values.slice(startIndex, endIndex + 1);
    const count = Math.max(1, slice.length);
    const aggregate = { startIndex, endIndex, count, demand: 0, prefetch: 0, swapIn: 0, swapOut: 0, total: 0, tpotMs: 0, peakIndex: startIndex };
    let peak = -1;
    for (let offset = 0; offset < slice.length; offset++) {
      const value = slice[offset];
      for (const key of ['demand', 'prefetch', 'swapIn', 'swapOut', 'total', 'tpotMs']) aggregate[key] += value[key];
      if (value.total > peak) {
        peak = value.total;
        aggregate.peakIndex = startIndex + offset;
      }
    }
    for (const key of ['demand', 'prefetch', 'swapIn', 'swapOut', 'total', 'tpotMs']) aggregate[key] /= count;
    aggregate.label = startIndex === endIndex ? String(startIndex + 1) : `${startIndex + 1}–${endIndex + 1}`;
    return aggregate;
  }

  function buildTokenIOGroups(values, completedCount, viewMode = 'recent', maxAllBuckets = MAX_ALL_BUCKETS, recentLimit = MAX_RECENT_TOKENS) {
    const total = values.length;
    if (!total) return [];
    if (viewMode === 'recent') {
      const responsiveLimit = Math.max(16, Math.min(recentLimit, total));
      const endExclusive = Math.min(total, Math.max(responsiveLimit, completedCount));
      const start = Math.max(0, endExclusive - responsiveLimit);
      return Array.from({ length: endExclusive - start }, (_, offset) => groupValues(values, start + offset, start + offset));
    }
    if (total <= maxAllBuckets) return values.map((_, index) => groupValues(values, index, index));
    const bucketSize = Math.ceil(total / maxAllBuckets);
    const groups = [];
    for (let start = 0; start < total; start += bucketSize) groups.push(groupValues(values, start, Math.min(total - 1, start + bucketSize - 1)));
    return groups;
  }

  function tokenIOScaleMax(groups, completedCount, scaleMode = 'p95') {
    const completed = groups.filter(group => group.startIndex < completedCount).map(group => group.total).filter(value => value > 0);
    if (!completed.length) return 0.000001;
    const maximum = Math.max(...completed);
    if (scaleMode !== 'p95' || completed.length < 5) return Math.max(0.000001, maximum);
    const p95 = percentile(completed, 0.95);
    return Math.max(0.000001, Math.min(maximum, p95 || maximum));
  }

  function tokenIOUnit(maxGB) {
    if (maxGB < 0.001) return Object.freeze({ divisor: 0.000001, suffix: 'KB' });
    if (maxGB < 1) return Object.freeze({ divisor: 0.001, suffix: 'MB' });
    return Object.freeze({ divisor: 1, suffix: 'GB' });
  }

  function formatTokenIO(valueGB, unit) {
    const value = valueGB / unit.divisor;
    return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit.suffix}`;
  }

  function ensureStylesheet(documentObject) {
    if (!documentObject || documentObject.getElementById('shadcnBaseUIStylesheet')) return;
    const link = documentObject.createElement('link');
    link.id = 'shadcnBaseUIStylesheet';
    link.rel = 'stylesheet';
    link.href = 'ui-shadcn.css';
    documentObject.head.appendChild(link);
  }

  function ensureSkipLink(documentObject) {
    if (!documentObject || documentObject.getElementById('skipToResults')) return;
    const main = documentObject.querySelector('main');
    if (!main) return;
    main.id ||= 'mainResults';
    main.tabIndex = -1;
    const link = documentObject.createElement('a');
    link.id = 'skipToResults';
    link.className = 'skipLink';
    link.href = `#${main.id}`;
    link.textContent = '시뮬레이션 결과로 건너뛰기';
    documentObject.body.prepend(link);
  }

  function enhanceActionToolbar(documentObject) {
    const toolbar = documentObject?.getElementById('actionToolbar');
    if (!toolbar || toolbar.querySelector('.toolbarOverflow')) return;
    const groups = toolbar.querySelectorAll(':scope > .toolbarGroup');
    if (groups.length < 2) return;
    const secondary = groups[1];
    const details = documentObject.createElement('details');
    details.className = 'toolbarOverflow';
    const summary = documentObject.createElement('summary');
    summary.textContent = '관리 및 내보내기';
    summary.setAttribute('aria-label', '관리 및 내보내기 메뉴 열기');
    const menu = documentObject.createElement('div');
    menu.className = 'toolbarOverflowMenu';
    while (secondary.firstChild) menu.appendChild(secondary.firstChild);
    details.append(summary, menu);
    secondary.replaceWith(details);
  }

  function panelMarkup() {
    return `
      <header class="tokenIOHeader">
        <div>
          <div class="tokenIOEyebrow">실시간 스토리지 추적</div>
          <div class="tokenIOTitleRow"><h3 id="tokenIOPlaybackTitle">토큰별 Storage I/O</h3><span id="tokenIOStateBadge" class="tokenIOStateBadge" data-state="idle">대기</span></div>
          <p id="tokenIOPlaybackDescription">디코드(Decode) 토큰마다 발생한 요청 읽기, 프리페치, 스왑 인(Swap-in), 스왑 아웃(Swap-out)을 표시합니다. 프리필과 초기 로딩 I/O는 기존 전체 스토리지 추적에서 별도로 확인합니다.</p>
        </div>
        <div class="tokenIOCurrent">
          <span id="tokenIOCurrentLabel">선택 토큰 없음</span>
          <strong id="tokenIOCurrentValue">—</strong>
        </div>
      </header>
      <div class="tokenIOControls" aria-label="토큰 I/O 그래프 설정">
        <label>표시 범위<select id="tokenIOViewMode"><option value="recent">최근 토큰</option><option value="all">전체 · 자동 집계</option></select></label>
        <label>Y축 스케일<select id="tokenIOScaleMode"><option value="p95">P95 기준 · 이상치 표시</option><option value="linear">전체 최대값</option></select></label>
        <label class="tokenIOCheck"><input id="tokenIOTpotToggle" type="checkbox" checked>TPOT 선 함께 보기</label>
      </div>
      <div class="tokenIOLegend" aria-label="스토리지 I/O 범례">
        <span><i class="tokenIOMarker demand"></i>요청 읽기</span>
        <span><i class="tokenIOMarker prefetch"></i>프리페치</span>
        <span><i class="tokenIOMarker swapIn"></i>스왑 인</span>
        <span><i class="tokenIOMarker swapOut"></i>스왑 아웃</span>
        <span><i class="tokenIOMarker tpot"></i>TPOT</span>
      </div>
      <div class="tokenIOCanvasWrap">
        <canvas id="tokenIOPlaybackChart" width="1200" height="300" tabindex="0" role="img" aria-labelledby="tokenIOPlaybackTitle" aria-describedby="tokenIOPlaybackDescription tokenIOChartHelp"></canvas>
        <p id="tokenIOChartHelp" class="srOnly">좌우 방향키로 완료된 토큰을 탐색합니다. Home은 첫 토큰, End는 최신 완료 토큰을 선택합니다.</p>
      </div>
      <div class="tokenIOInspector" aria-label="토큰 상세 탐색">
        <button id="tokenIOPrevious" type="button" aria-label="이전 완료 토큰">← 이전</button>
        <label for="tokenIOSelector">토큰 선택</label>
        <input id="tokenIOSelector" type="range" min="1" max="1" value="1" disabled aria-describedby="tokenIODetail">
        <button id="tokenIONext" type="button" aria-label="다음 완료 토큰">다음 →</button>
        <button id="tokenIOFollowLatest" type="button" aria-label="최신 완료 토큰 자동 추적">최신 따라가기</button>
      </div>
      <dl id="tokenIODetail" class="tokenIODetail" aria-live="off">
        <div><dt>Token</dt><dd id="tokenIODetailToken">—</dd></div>
        <div><dt>전체 I/O</dt><dd id="tokenIODetailTotal">—</dd></div>
        <div><dt>TPOT</dt><dd id="tokenIODetailTpot">—</dd></div>
        <div><dt>메모리 상태</dt><dd id="tokenIODetailPressure">—</dd></div>
        <div><dt>요청 / 프리페치</dt><dd id="tokenIODetailReads">—</dd></div>
        <div><dt>Swap-in / out</dt><dd id="tokenIODetailSwap">—</dd></div>
      </dl>
      <details id="tokenIOTableDetails" class="tokenIOTableDetails">
        <summary>접근 가능한 토큰별 I/O 표</summary>
        <div class="tokenIOTableScroller"><table class="tbl" id="tokenIOAccessibleTable"><caption>완료된 Decode 토큰의 Storage I/O와 TPOT</caption><thead><tr><th scope="col">Token</th><th scope="col">요청 읽기</th><th scope="col">프리페치</th><th scope="col">Swap-in</th><th scope="col">Swap-out</th><th scope="col">전체</th><th scope="col">TPOT</th><th scope="col">상태</th></tr></thead><tbody></tbody></table></div>
      </details>
      <footer class="tokenIOFooter"><span id="tokenIOProgressLabel">0 / 0 토큰</span><span id="tokenIOAggregationLabel">최근 토큰을 개별 막대로 표시합니다.</span></footer>
      <div id="tokenIOLiveStatus" class="srOnly" role="status" aria-live="polite" aria-atomic="true"></div>`;
  }

  function ensurePanel(documentObject) {
    if (!documentObject) return null;
    let panel = documentObject.getElementById('tokenIOPlaybackPanel');
    if (panel) return panel;
    const resultHero = documentObject.querySelector('.resultHero');
    if (!resultHero) return null;
    panel = documentObject.createElement('section');
    panel.id = 'tokenIOPlaybackPanel';
    panel.className = 'tokenIOPlayback';
    panel.setAttribute('aria-labelledby', 'tokenIOPlaybackTitle');
    panel.innerHTML = panelMarkup();
    const progress = resultHero.querySelector('.bar');
    resultHero.insertBefore(panel, progress || null);
    bindPanelEvents(panel);
    return panel;
  }

  function bindPanelEvents(panel) {
    const canvas = panel.querySelector('#tokenIOPlaybackChart');
    canvas.addEventListener('pointermove', showTooltip);
    canvas.addEventListener('pointerleave', hideTooltip);
    canvas.addEventListener('click', selectFromPointer);
    canvas.addEventListener('keydown', handleCanvasKeydown);
    panel.querySelector('#tokenIOViewMode').addEventListener('change', event => { state.viewMode = event.target.value; scheduleDraw(); });
    panel.querySelector('#tokenIOScaleMode').addEventListener('change', event => { state.scaleMode = event.target.value; scheduleDraw(); });
    panel.querySelector('#tokenIOTpotToggle').addEventListener('change', event => { state.showTpot = event.target.checked; scheduleDraw(); });
    panel.querySelector('#tokenIOSelector').addEventListener('input', event => selectToken(Number(event.target.value) - 1, false, true));
    panel.querySelector('#tokenIOPrevious').addEventListener('click', () => selectToken(state.selectedIndex - 1, false, true));
    panel.querySelector('#tokenIONext').addEventListener('click', () => selectToken(state.selectedIndex + 1, false, true));
    panel.querySelector('#tokenIOFollowLatest').addEventListener('click', () => { state.followLatest = true; selectToken(state.completedCount - 1, false, false); });
    panel.querySelector('#tokenIOTableDetails').addEventListener('toggle', event => { if (event.currentTarget.open) renderAccessibleTable(); });
  }

  function getCssColor(name, fallback) {
    if (typeof document !== 'object' || typeof getComputedStyle !== 'function') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function chartColors() {
    return {
      demand: getCssColor('--token-io-demand', '#2563eb'),
      prefetch: getCssColor('--token-io-prefetch', '#059669'),
      swapIn: getCssColor('--token-io-swap-in', '#7c3aed'),
      swapOut: getCssColor('--token-io-swap-out', '#e11d48'),
      tpot: getCssColor('--token-io-tpot', '#f59e0b'),
      pending: getCssColor('--token-io-pending', 'rgba(148,163,184,.2)'),
      grid: getCssColor('--token-io-grid', 'rgba(148,163,184,.18)'),
      text: getCssColor('--token-io-text', '#94a3b8'),
      selected: getCssColor('--token-io-selected', '#f8fafc'),
      clipped: getCssColor('--token-io-clipped', '#f59e0b')
    };
  }

  function ensureCanvasSize(canvas) {
    const ratio = Math.max(1, Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth || 900));
    const cssHeight = Math.max(190, Math.round(canvas.clientHeight || 240));
    const pixelWidth = Math.round(cssWidth * ratio);
    const pixelHeight = Math.round(cssHeight * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    return { context, cssWidth, cssHeight };
  }

  function applySwapPattern(context, x, y, width, height, direction = 1) {
    if (!(height > 2)) return;
    context.save();
    context.strokeStyle = 'rgba(255,255,255,.42)';
    context.lineWidth = 1;
    context.beginPath();
    for (let offset = -height; offset < width + height; offset += 6) {
      const startX = direction > 0 ? x + offset : x + width - offset;
      context.moveTo(startX, y + height);
      context.lineTo(startX + direction * height, y);
    }
    context.clip(new Path2D(`M${x} ${y}h${width}v${height}h-${width}Z`));
    context.stroke();
    context.restore();
  }

  function drawChart() {
    const panel = typeof document === 'object' ? ensurePanel(document) : null;
    const canvas = panel?.querySelector('#tokenIOPlaybackChart');
    if (!canvas || !state.values.length) return;
    const { context: ctx, cssWidth, cssHeight } = ensureCanvasSize(canvas);
    const colors = chartColors();
    const recentLimit = cssWidth < 600 ? 24 : MAX_RECENT_TOKENS;
    const maxBuckets = Math.max(32, Math.min(MAX_ALL_BUCKETS, Math.floor((cssWidth - 70) / 7)));
    const groups = buildTokenIOGroups(state.values, state.completedCount, state.viewMode, maxBuckets, recentLimit);
    const scaleMax = tokenIOScaleMax(groups, state.completedCount, state.scaleMode);
    const unit = tokenIOUnit(scaleMax);
    const left = 52, right = state.showTpot ? 48 : 14, top = 16, bottom = 34;
    const width = cssWidth - left - right;
    const height = cssHeight - top - bottom;
    ctx.font = '10px system-ui';
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'right';
    for (let tick = 0; tick <= 4; tick++) {
      const y = top + height * tick / 4;
      const value = scaleMax * (1 - tick / 4);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cssWidth - right, y); ctx.stroke();
      ctx.fillText(formatTokenIO(value, unit).replace(` ${unit.suffix}`, ''), left - 7, y + 3);
    }
    ctx.save(); ctx.translate(12, top + height / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(unit.suffix, 0, 0); ctx.restore();
    const slot = width / Math.max(1, groups.length);
    const barWidth = Math.max(3, Math.min(22, slot * 0.72));
    const geometryGroups = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      const x = left + slot * groupIndex + (slot - barWidth) / 2;
      const isCompleted = group.startIndex < state.completedCount;
      if (!isCompleted) {
        ctx.fillStyle = colors.pending;
        ctx.fillRect(x, top + height - 2, barWidth, 2);
        geometryGroups.push({ ...group, x, width: barWidth });
        continue;
      }
      let y = top + height;
      for (const series of SERIES) {
        const rawHeight = group[series.key] / scaleMax * height;
        const segmentHeight = Math.max(0, Math.min(height, rawHeight));
        y -= segmentHeight;
        ctx.fillStyle = colors[series.key];
        ctx.fillRect(x, y, barWidth, segmentHeight);
        if (series.key === 'swapIn') applySwapPattern(ctx, x, y, barWidth, segmentHeight, 1);
        if (series.key === 'swapOut') applySwapPattern(ctx, x, y, barWidth, segmentHeight, -1);
      }
      if (group.total > scaleMax) {
        ctx.fillStyle = colors.clipped;
        ctx.beginPath(); ctx.moveTo(x, top + 1); ctx.lineTo(x + barWidth / 2, top - 5); ctx.lineTo(x + barWidth, top + 1); ctx.fill();
      }
      if (state.selectedIndex >= group.startIndex && state.selectedIndex <= group.endIndex) {
        ctx.strokeStyle = colors.selected;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2, top - 1, barWidth + 4, height + 2);
      }
      geometryGroups.push({ ...group, x, width: barWidth });
    }
    if (state.showTpot) {
      const completedGroups = groups.filter(group => group.startIndex < state.completedCount);
      const tpotMax = Math.max(0.000001, percentile(completedGroups.map(group => group.tpotMs), 0.95) || Math.max(...completedGroups.map(group => group.tpotMs), 0.000001));
      ctx.strokeStyle = colors.tpot;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      completedGroups.forEach((group, index) => {
        const groupIndex = groups.indexOf(group);
        const x = left + slot * groupIndex + slot / 2;
        const y = top + height - Math.min(1, group.tpotMs / tpotMax) * height;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = colors.text; ctx.textAlign = 'left';
      for (let tick = 0; tick <= 2; tick++) {
        const value = tpotMax * (1 - tick / 2);
        ctx.fillText(`${value.toFixed(value >= 10 ? 0 : 1)}ms`, cssWidth - right + 6, top + height * tick / 2 + 3);
      }
    }
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'center';
    const tickEvery = Math.max(1, Math.ceil(groups.length / Math.max(5, Math.floor(width / 78))));
    groups.forEach((group, index) => {
      if (index % tickEvery === 0 || index === groups.length - 1) ctx.fillText(group.label, left + slot * index + slot / 2, cssHeight - 10);
    });
    canvas.__tokenIOGeometry = { left, top, width, height, slot, groups: geometryGroups, unit, scaleMax };
    const aggregation = panel.querySelector('#tokenIOAggregationLabel');
    aggregation.textContent = state.viewMode === 'recent'
      ? `최근 ${groups.length}개 토큰을 개별 막대로 표시합니다.`
      : groups.some(group => group.count > 1) ? `전체 ${state.values.length}개 토큰을 ${groups.length}개 구간의 토큰당 평균으로 집계했습니다.` : '전체 토큰을 개별 막대로 표시합니다.';
  }

  function scheduleDraw() {
    if (state.rafId !== null || typeof requestAnimationFrame !== 'function') {
      if (typeof requestAnimationFrame !== 'function') drawChart();
      return;
    }
    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      drawChart();
    });
  }

  function setStatus(status) {
    const changed = state.status !== status;
    state.status = status;
    if (typeof document !== 'object') return;
    const badge = ensurePanel(document)?.querySelector('#tokenIOStateBadge');
    if (!badge) return;
    const labels = { idle: '대기', prefill: 'TTFT 준비', running: '실행 중', paused: '일시정지', completed: '완료', error: '오류' };
    badge.dataset.state = status;
    badge.textContent = labels[status] || status;
    if (changed) announceStatus(labels[status] || status, true);
  }

  function selectToken(index, focusCanvas = false, manual = false) {
    if (!state.completedCount) {
      state.selectedIndex = -1;
      renderSelectedToken();
      return;
    }
    state.selectedIndex = Math.max(0, Math.min(state.completedCount - 1, Number.isFinite(index) ? index : state.completedCount - 1));
    if (manual) state.followLatest = state.selectedIndex === state.completedCount - 1;
    renderSelectedToken();
    scheduleDraw();
    if (focusCanvas && typeof document === 'object') ensurePanel(document)?.querySelector('#tokenIOPlaybackChart')?.focus({ preventScroll: true });
  }

  function renderSelectedToken() {
    if (typeof document !== 'object') return;
    const panel = ensurePanel(document);
    const selector = panel.querySelector('#tokenIOSelector');
    selector.max = String(Math.max(1, state.completedCount));
    selector.disabled = state.completedCount === 0;
    panel.querySelector('#tokenIOPrevious').disabled = state.selectedIndex <= 0;
    panel.querySelector('#tokenIONext').disabled = state.selectedIndex < 0 || state.selectedIndex >= state.completedCount - 1;
    panel.querySelector('#tokenIOFollowLatest').disabled = state.completedCount === 0 || state.followLatest;
    if (state.selectedIndex < 0 || !state.values[state.selectedIndex]) {
      for (const id of ['tokenIOCurrentValue', 'tokenIODetailToken', 'tokenIODetailTotal', 'tokenIODetailTpot', 'tokenIODetailPressure', 'tokenIODetailReads', 'tokenIODetailSwap']) panel.querySelector(`#${id}`).textContent = '—';
      panel.querySelector('#tokenIOCurrentLabel').textContent = '선택 토큰 없음';
      return;
    }
    selector.value = String(state.selectedIndex + 1);
    const value = state.values[state.selectedIndex];
    const unit = tokenIOUnit(Math.max(value.total, 0.000001));
    panel.querySelector('#tokenIOCurrentLabel').textContent = `Token ${state.selectedIndex + 1}`;
    panel.querySelector('#tokenIOCurrentValue').textContent = formatTokenIO(value.total, unit);
    panel.querySelector('#tokenIODetailToken').textContent = String(state.selectedIndex + 1);
    panel.querySelector('#tokenIODetailTotal').textContent = formatTokenIO(value.total, unit);
    panel.querySelector('#tokenIODetailTpot').textContent = `${value.tpotMs.toFixed(value.tpotMs >= 10 ? 1 : 2)} ms`;
    panel.querySelector('#tokenIODetailPressure').textContent = value.pressureState;
    panel.querySelector('#tokenIODetailReads').textContent = `${formatTokenIO(value.demand, unit)} / ${formatTokenIO(value.prefetch, unit)}`;
    panel.querySelector('#tokenIODetailSwap').textContent = `${formatTokenIO(value.swapIn, unit)} / ${formatTokenIO(value.swapOut, unit)}`;
  }

  function announceStatus(message, force = false) {
    if (typeof document !== 'object') return;
    const live = ensurePanel(document)?.querySelector('#tokenIOLiveStatus');
    if (!live) return;
    if (!force && state.completedCount !== 1 && state.completedCount !== state.values.length && state.completedCount % 8 !== 0) return;
    if (!force && state.latestAnnouncementCount === state.completedCount) return;
    state.latestAnnouncementCount = state.completedCount;
    live.textContent = message;
  }

  function renderAccessibleTable() {
    if (typeof document !== 'object' || !state.tableDirty) return;
    const body = ensurePanel(document)?.querySelector('#tokenIOAccessibleTable tbody');
    if (!body) return;
    body.innerHTML = state.values.slice(0, state.completedCount).map((value, index) => {
      const unit = tokenIOUnit(Math.max(value.total, 0.000001));
      return `<tr><th scope="row">${index + 1}</th><td>${formatTokenIO(value.demand, unit)}</td><td>${formatTokenIO(value.prefetch, unit)}</td><td>${formatTokenIO(value.swapIn, unit)}</td><td>${formatTokenIO(value.swapOut, unit)}</td><td>${formatTokenIO(value.total, unit)}</td><td>${value.tpotMs.toFixed(value.tpotMs >= 10 ? 1 : 2)} ms</td><td>${escapeHtml(value.pressureState)}</td></tr>`;
    }).join('');
    state.tableDirty = false;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function tooltipElement() {
    if (typeof document !== 'object') return null;
    let tooltip = document.getElementById('tokenIOTooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'tokenIOTooltip';
      tooltip.className = 'tokenIOTooltip';
      tooltip.hidden = true;
      tooltip.setAttribute('role', 'tooltip');
      document.body.appendChild(tooltip);
    }
    return tooltip;
  }

  function groupAtPointer(event) {
    const canvas = event.currentTarget;
    const geometry = canvas.__tokenIOGeometry;
    if (!geometry) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.floor((x - geometry.left) / geometry.slot);
    if (index < 0 || index >= geometry.groups.length) return null;
    return geometry.groups[index];
  }

  function showTooltip(event) {
    const group = groupAtPointer(event);
    const tooltip = tooltipElement();
    if (!group || group.startIndex >= state.completedCount) {
      if (tooltip) tooltip.hidden = true;
      return;
    }
    const unit = tokenIOUnit(Math.max(group.total, 0.000001));
    const range = group.startIndex === group.endIndex ? `Token ${group.startIndex + 1}` : `Tokens ${group.startIndex + 1}–${group.endIndex + 1} 평균`;
    tooltip.innerHTML = `<b>${range}</b><br>전체 ${formatTokenIO(group.total, unit)}<br>요청 읽기 ${formatTokenIO(group.demand, unit)}<br>프리페치 ${formatTokenIO(group.prefetch, unit)}<br>Swap-in ${formatTokenIO(group.swapIn, unit)}<br>Swap-out ${formatTokenIO(group.swapOut, unit)}<br>TPOT ${group.tpotMs.toFixed(group.tpotMs >= 10 ? 1 : 2)} ms${group.count > 1 ? `<br>구간 Peak: Token ${group.peakIndex + 1}` : ''}`;
    tooltip.style.left = `${Math.min(innerWidth - 230, event.clientX + 14)}px`;
    tooltip.style.top = `${Math.min(innerHeight - 190, event.clientY + 14)}px`;
    tooltip.hidden = false;
  }

  function hideTooltip() {
    const tooltip = typeof document === 'object' ? document.getElementById('tokenIOTooltip') : null;
    if (tooltip) tooltip.hidden = true;
  }

  function selectFromPointer(event) {
    const group = groupAtPointer(event);
    if (!group || group.startIndex >= state.completedCount) return;
    selectToken(Math.min(state.completedCount - 1, group.peakIndex), false, true);
  }

  function handleCanvasKeydown(event) {
    const actions = {
      ArrowLeft: () => selectToken(state.selectedIndex - 1, false, true),
      ArrowRight: () => selectToken(state.selectedIndex + 1, false, true),
      Home: () => selectToken(0, false, true),
      End: () => selectToken(state.completedCount - 1, false, true)
    };
    if (!actions[event.key]) return;
    event.preventDefault();
    actions[event.key]();
  }

  function update(result, completedCount, options = {}) {
    if (!result || result.error) {
      reset('error');
      return;
    }
    if (state.result !== result) {
      state.result = result;
      state.values = buildTokenIOValues(result);
      state.selectedIndex = -1;
      state.tableDirty = true;
      state.followLatest = true;
      state.latestAnnouncementCount = -1;
    }
    state.completedCount = Math.max(0, Math.min(state.values.length, Number(completedCount) || 0));
    state.tableDirty = true;
    setStatus(options.status || (state.completedCount >= state.values.length ? 'completed' : 'running'));
    if (options.followLatest === false) state.followLatest = false;
    if (state.completedCount > 0 && (state.selectedIndex < 0 || state.followLatest)) state.selectedIndex = state.completedCount - 1;
    if (typeof document === 'object') {
      const panel = ensurePanel(document);
      panel.querySelector('#tokenIOProgressLabel').textContent = `${state.completedCount} / ${state.values.length} 토큰`;
      renderSelectedToken();
      const details = panel.querySelector('#tokenIOTableDetails');
      if (details.open && (state.completedCount === state.values.length || state.completedCount % 8 === 0)) renderAccessibleTable();
    }
    const current = state.completedCount > 0 ? state.values[state.completedCount - 1] : null;
    announceStatus(current
      ? `Token ${state.completedCount} 완료. 전체 I/O ${formatTokenIO(current.total, tokenIOUnit(Math.max(current.total, 0.000001)))}. ${state.completedCount} / ${state.values.length}.`
      : `TTFT 준비 중. 출력 토큰 ${state.values.length}개.`, false);
    scheduleDraw();
  }

  function reset(status = 'idle') {
    state.result = null;
    state.values = [];
    state.completedCount = 0;
    state.selectedIndex = -1;
    state.tableDirty = true;
    state.followLatest = true;
    setStatus(status);
    if (typeof document === 'object') {
      const panel = ensurePanel(document);
      panel.querySelector('#tokenIOProgressLabel').textContent = '0 / 0 토큰';
      panel.querySelector('#tokenIOAccessibleTable tbody').innerHTML = '';
      renderSelectedToken();
      const canvas = panel.querySelector('#tokenIOPlaybackChart');
      const { context, cssWidth, cssHeight } = ensureCanvasSize(canvas);
      context.clearRect(0, 0, cssWidth, cssHeight);
    }
  }

  function initialize(documentObject = typeof document === 'object' ? document : null) {
    if (!documentObject) return false;
    ensureStylesheet(documentObject);
    ensureSkipLink(documentObject);
    enhanceActionToolbar(documentObject);
    const panel = ensurePanel(documentObject);
    if (!panel) return false;
    documentObject.getElementById('run')?.addEventListener('click', () => setStatus('prefill'), true);
    const warn = documentObject.getElementById('warn');
    if (warn && typeof MutationObserver === 'function') {
      new MutationObserver(() => { if (!warn.hidden) reset('error'); }).observe(warn, { attributes: true, attributeFilter: ['hidden'] });
    }
    if (typeof ResizeObserver === 'function') {
      state.observer = new ResizeObserver(() => scheduleDraw());
      state.observer.observe(panel.querySelector('.tokenIOCanvasWrap'));
    } else if (typeof addEventListener === 'function') {
      addEventListener('resize', scheduleDraw, { passive: true });
    }
    if (typeof MutationObserver === 'function') {
      state.themeObserver = new MutationObserver(scheduleDraw);
      state.themeObserver.observe(documentObject.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    return true;
  }

  return Object.freeze({
    initialize,
    update,
    setStatus,
    reset,
    tokenIOBreakdown,
    buildTokenIOValues,
    buildTokenIOGroups,
    tokenIOScaleMax,
    tokenIOUnit,
    formatTokenIO,
    percentile
  });
});
