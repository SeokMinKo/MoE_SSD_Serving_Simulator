function simulate() {
  const config = $('mode').value === 'afm3' ? readAFM() : readColibri();
  return runSimulationConfig(config);
}

let lastResult = null;
let anim = { timer: null, paused: false, index: 0, parts: [], result: null, due: 0, remainingSim: 0, oldSpeed: 1, action: null };
const speed = () => Math.max(0.01, Number($('speed').value) || 1);
const delay = (sim, s = speed()) => sim / s;
function stop() { if (anim.timer) clearTimeout(anim.timer); anim.timer = null; }
function schedule(fn, sim) {
  stop();
  anim.action = fn;
  anim.remainingSim = sim;
  anim.oldSpeed = speed();
  const d = delay(sim, anim.oldSpeed);
  anim.due = performance.now() + d;
  anim.timer = setTimeout(() => { anim.timer = null; fn(); }, d);
}
function sampleText(mode) {
  return mode === 'afm3'
    ? 'AFM 3 Core Advanced는 선택된 Expert 집합을 윈도 동안 유지하고 메모리 압력이 발생하면 KV 압축과 스왑 트래픽이 NAND 및 DRAM 대역폭을 사용합니다. '
    : 'Colibri는 필요한 MoE Expert를 SSD에서 DRAM으로 가져오며 캐시와 스왑 트래픽이 스토리지 및 DRAM 대역폭을 함께 사용합니다. ';
}
function startAnim(r) {
  stop();
  anim = { timer: null, paused: false, index: 0, parts: sampleText(r.mode).match(/\S+\s*/g), result: r, due: 0, remainingSim: 0, oldSpeed: speed(), action: null };
  while (anim.parts.length < r.c.output) anim.parts = anim.parts.concat(anim.parts);
  anim.parts = anim.parts.slice(0, r.c.output);
  $('token').innerHTML = (r.mode === 'afm3' ? '초기 IFP 선택 · 구체화 · 프리필…' : 'TTFT · 프리필…') + ' <span class="cursor"></span>';
  $('progress').style.width = '0';
  $('status').textContent = `TTFT ${ms(r.ttft)} · ${speed() === 1 ? '실시간' : speed() + '×'}`;
  updateTokenIOPlayback(r, 0, { status: 'prefill' });
  schedule(begin, r.ttft);
}
function begin() { $('token').innerHTML = '<span id="out"></span><span class="cursor"></span>'; setTokenIOPlaybackState('running'); emit(); }
function nextWaitStatus(tr, index) {
  if (tr.memory && ['SWAP', 'THRASH', 'OOM'].includes(tr.memory.pressureState)) {
    return `토큰 ${index + 1} 전 메모리 ${tr.memory.pressureState} · 스왑 ${fmt(tr.memory.swapGB, 2)}GB · TPOT ${ms(tr.tpot)}`;
  }
  if (anim.result.mode === 'afm3' && tr.boundary) {
    return `토큰 ${index + 1} 전 IFP 재선택 · 신규 ${tr.changed}개 / 유지 ${tr.retained}개 · ${mb(tr.readGB)} · 대기 ${ms(tr.exposed)}`;
  }
  return `토큰 ${index + 1} 대기 · TPOT ${ms(tr.tpot)} · ${speed() === 1 ? '실시간' : speed() + '×'}`;
}
function emit(force = false) {
  if ((anim.paused && !force) || anim.index >= anim.parts.length) return;
  const tr = anim.result.tokens[anim.index], out = $('out');
  if (anim.result.mode === 'afm3' && tr.boundary) out.textContent += `\n[IFP 윈도 ${tr.window} · Expert ${tr.changed}개 변경]\n`;
  if (tr.memory && ['SWAP', 'THRASH'].includes(tr.memory.pressureState)) out.textContent += `\n[메모리 ${tr.memory.pressureState} · 스왑 ${fmt(tr.memory.swapGB, 2)}GB]\n`;
  out.textContent += anim.parts[anim.index];
  anim.index++;
  $('progress').style.width = `${anim.index / anim.parts.length * 100}%`;
  $('status').textContent = `토큰 ${anim.index}/${anim.parts.length} · TPOT ${ms(tr.tpot)} · ${tr.memory ? tr.memory.pressureState : 'NORMAL'}`;
  const completed = anim.index >= anim.parts.length;
  updateTokenIOPlayback(anim.result, anim.index, { status: completed ? 'completed' : 'running' });
  if (!completed && !force) {
    const next = anim.result.tokens[anim.index];
    $('status').textContent = nextWaitStatus(next, anim.index);
    schedule(() => emit(), next.tpot);
  } else if (completed) {
    $('status').textContent = `완료 · 유효 처리량 ${fmt(anim.result.tps, 2)} 토큰/s`;
  }
}
function pause() {
  if (!anim.result) return;
  if (!anim.paused) {
    anim.paused = true;
    if (anim.timer) {
      anim.remainingSim = Math.max(0, anim.due - performance.now()) * anim.oldSpeed;
      stop();
    }
    $('pause').textContent = '▶ 계속';
    setTokenIOPlaybackState('paused');
  } else {
    anim.paused = false;
    $('pause').textContent = 'Ⅱ 일시정지';
    setTokenIOPlaybackState('running');
    if (anim.action) schedule(anim.action, anim.remainingSim);
  }
}

function rows(items) { return items.map(x => `<tr><td>${x[0]}</td><td>${x[1]}</td></tr>`).join(''); }
function pressureClass(s) {
  if (s === 'NORMAL') return 'pressureNormal';
  if (s === 'RECLAIM' || s === 'COMPRESS') return 'pressureReclaim';
  return 'pressureSwap';
}

let tokenIOPendingUpdate = null;
let tokenIOPendingState = null;
let tokenIOLoadStarted = false;

function tokenIOApi() {
  return globalThis.TokenIOUI && typeof globalThis.TokenIOUI.update === 'function' ? globalThis.TokenIOUI : null;
}

function flushTokenIOPending() {
  const api = tokenIOApi();
  if (!api) return;
  api.initialize();
  if (tokenIOPendingState) api.setStatus(tokenIOPendingState);
  if (tokenIOPendingUpdate) api.update(tokenIOPendingUpdate.result, tokenIOPendingUpdate.completedCount, tokenIOPendingUpdate.options);
  tokenIOPendingState = null;
  tokenIOPendingUpdate = null;
}

function updateTokenIOPlayback(result, completedCount, options = {}) {
  const api = tokenIOApi();
  if (api) api.update(result, completedCount, options);
  else tokenIOPendingUpdate = { result, completedCount, options };
}

function setTokenIOPlaybackState(status) {
  const api = tokenIOApi();
  if (api) api.setStatus(status);
  else tokenIOPendingState = status;
}

function loadTokenIOEnhancement() {
  if (tokenIOLoadStarted || typeof document !== 'object') return;
  tokenIOLoadStarted = true;
  if (!document.getElementById('shadcnBaseUIStylesheet')) {
    const link = document.createElement('link');
    link.id = 'shadcnBaseUIStylesheet';
    link.rel = 'stylesheet';
    link.href = 'ui-shadcn.css';
    document.head.appendChild(link);
  }
  if (tokenIOApi()) {
    flushTokenIOPending();
    return;
  }
  const script = document.createElement('script');
  script.id = 'tokenIOEnhancementScript';
  script.src = 'token-io.js';
  script.async = false;
  script.onload = flushTokenIOPending;
  script.onerror = () => console.warn('토큰 I/O UI 모듈을 불러오지 못했습니다. 기본 시뮬레이션은 계속 사용할 수 있습니다.');
  document.head.appendChild(script);
}

if (typeof document === 'object') loadTokenIOEnhancement();
