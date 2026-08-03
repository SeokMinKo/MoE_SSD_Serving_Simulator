const HELP_KEY_OVERRIDES = Object.freeze({
  kv: 'kvKB', memPolicy: 'mem.policy', backgroundGB: 'mem.backgroundGB', osReservedGB: 'mem.osReservedGB', minHeadroomGB: 'mem.minHeadroomGB', softPct: 'mem.soft', compressPct: 'mem.compress', swapPct: 'mem.swap', hardPct: 'mem.hard', compressionEnabled: 'mem.compressionEnabled', compressionRatio: 'mem.compressionRatio', compressionBW: 'mem.compressionBW', swapEnabled: 'mem.swapEnabled', swapCapacityGB: 'mem.swapCapacityGB', swapWriteRatio: 'mem.swapWriteRatio', kvTouchFraction: 'mem.kvTouchFraction', afmTotalB: 'totalB', afmLayers: 'layers', afmHidden: 'hidden', afmActive: 'active', afmShared: 'shared', afmExpertWidth: 'expertWidth', afmActiveDim: 'activeDim', afmProjections: 'projections', afmChunks: 'chunks', afmBits: 'bits', afmPacking: 'packing', afmCommonGB: 'commonGB', afmFreq: 'freq', afmOverlap: 'overlap', afmInitSel: 'initSel', afmPeriodicSel: 'periodicSel', afmPatchBase: 'patchBase', afmPatchBW: 'patchBW', afmAttn: 'attn', afmFFN: 'ffn', afmRuntime: 'runtime', afmPrefillTPS: 'prefillTPS', afmChunkMode: 'chunkMode', afmDoubleBuffer: 'doubleBuffer'
});

const COLIBRI_HELP_IDS = new Set(['cold', 'modelPreset', 'layers', 'experts', 'active', 'esize', 'resident', 'kv', 'vram', 'placement', 'pcieBW', 'qd', 'vcache', 'dcache', 'expertBacking', 'minDCache', 'pinned', 'page', 'odirect', 'corr', 'attn', 'ems', 'par', 'prefillSpeedup', 'pf', 'prefetchPolicy', 'recall', 'precision', 'budget']);
const AFM_HELP_IDS = new Set(['afmTotalB', 'afmLayers', 'afmHidden', 'afmActive', 'afmShared', 'afmExpertWidth', 'afmActiveDim', 'afmProjections', 'afmChunks', 'afmBits', 'afmPacking', 'afmCommonGB', 'afmFreq', 'afmProfile', 'afmOverlap', 'afmInitSel', 'afmPeriodicSel', 'afmPatchBase', 'afmPatchBW', 'afmAttn', 'afmFFN', 'afmRuntime', 'afmPrefillTPS', 'afmChunkMode', 'afmDoubleBuffer']);

function helpUnit(id, label) {
  const explicit = ({ prompt: '토큰', output: '토큰', context: '토큰', conc: '시퀀스', lat: 'µs', qd: '워커', ssdBW: 'GB/s', dramBW: 'GB/s', pcieBW: 'GB/s', afmPatchBW: 'GB/s', compressionBW: 'GB/s', softPct: '%', compressPct: '%', swapPct: '%', hardPct: '%', kv: 'KB/토큰' })[id];
  return explicit || label.match(/\(([^)]+)\)/)?.[1] || '단위 없음 / 범주';
}

function helpDirection(id) {
  if (id === 'afmTotalB') return 'NAND 저장 용량 산정용 메타데이터이며 TTFT·TPOT·TPS·상주 메모리에는 영향을 주지 않습니다.';
  if (/BW$|PrefillTPS$|host$|vram$|cache$|dcache$|vcache$|pinned$|page$|par$|prefillSpeedup$|compressionRatio$/i.test(id)) return '증가하면 이 합성 시뮬레이터에서 관련 처리량 또는 상주 용량이 커질 수 있지만 다른 병목이나 메모리 비용이 생길 수 있습니다.';
  if (/lat$|Sel$|Base$|attn$|ems$|FFN$|Runtime$|prompt$|output$|context$|conc$/i.test(id)) return '증가하면 이 합성 시뮬레이터에서 작업량·지연·메모리 압력이 커질 수 있습니다.';
  return '변경 효과는 현재 합성 추적과 적용 조건에 따라 달라지며 실제 하드웨어 개선을 보장하지 않습니다.';
}

function parameterHelpForControl(id, labelText = '') {
  const key = HELP_KEY_OVERRIDES[id] || id;
  const engine = COLIBRI_HELP_IDS.has(id) ? 'Colibri 전용' : AFM_HELP_IDS.has(id) ? 'AFM 전용' : '모든 엔진 (Colibri 및 AFM)';
  const label = labelText || ({ ssdBW: '유효 SSD / NAND 대역폭' })[id] || id;
  return `${label}: 이 입력은 시뮬레이터 설정 \`${key}\`를 지정합니다. 단위: ${helpUnit(id, label)}. 적용 대상: ${engine}. ${helpDirection(id)} 추정 민감도 시뮬레이터 · 미검증 알파 경계의 상대 민감도 입력입니다.`;
}

function parameterHelpClickShouldShow(openedByFocus, hidden) {
  return openedByFocus || hidden;
}

function initializeParameterHelp() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  document.querySelectorAll('.f').forEach(row => {
    const label = row.querySelector('label');
    const control = row.querySelector('input, select, textarea');
    if (!label || !control?.id || row.querySelector('.helpTip')) return;
    const bubble = document.createElement('span');
    bubble.id = `help-${control.id}`;
    bubble.className = 'helpBubble';
    bubble.role = 'tooltip';
    bubble.hidden = true;
    bubble.textContent = parameterHelpForControl(control.id, label.textContent.trim());
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'helpTip';
    trigger.tabIndex = 0;
    trigger.setAttribute('aria-label', `${label.textContent.trim()} 도움말`);
    trigger.setAttribute('aria-describedby', bubble.id);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.textContent = '?';
    const show = () => {
      const rect = trigger.getBoundingClientRect();
      bubble.style.left = `${Math.min(window.innerWidth - 380, Math.max(8, rect.left))}px`;
      bubble.style.top = `${Math.min(window.innerHeight - 160, rect.bottom + 6)}px`;
      bubble.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    const hide = () => { bubble.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
    let openedByFocus = false;
    trigger.addEventListener('mouseenter', show);
    trigger.addEventListener('mouseleave', hide);
    trigger.addEventListener('focus', () => { openedByFocus = true; show(); });
    trigger.addEventListener('blur', () => { openedByFocus = false; hide(); });
    trigger.addEventListener('click', event => {
      event.preventDefault();
      const shouldShow = parameterHelpClickShouldShow(openedByFocus, bubble.hidden);
      openedByFocus = false;
      if (shouldShow) show(); else hide();
    });
    trigger.addEventListener('keydown', event => { if (event.key === 'Escape') { hide(); trigger.blur(); } });
    const wrapper = document.createElement('div');
    wrapper.className = 'fieldLabel';
    label.before(wrapper);
    wrapper.append(label, trigger);
    row.appendChild(bubble);
    const describedBy = [control.getAttribute('aria-describedby'), bubble.id].filter(Boolean).join(' ');
    control.setAttribute('aria-describedby', describedBy);
  });
}
