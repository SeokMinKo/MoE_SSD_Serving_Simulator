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
  updateTokenIOPlayback(r, 0);
  schedule(begin, r.ttft);
}
function begin() { $('token').innerHTML = '<span id="out"></span><span class="cursor"></span>'; emit(); }
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
  updateTokenIOPlayback(anim.result, anim.index);
  if (anim.index < anim.parts.length && !force) {
    const next = anim.result.tokens[anim.index];
    $('status').textContent = nextWaitStatus(next, anim.index);
    schedule(() => emit(), next.tpot);
  } else if (anim.index >= anim.parts.length) {
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
  } else {
    anim.paused = false;
    $('pause').textContent = 'Ⅱ 일시정지';
    if (anim.action) schedule(anim.action, anim.remainingSim);
  }
}

function rows(items) { return items.map(x => `<tr><td>${x[0]}</td><td>${x[1]}</td></tr>`).join(''); }
function pressureClass(s) {
  if (s === 'NORMAL') return 'pressureNormal';
  if (s === 'RECLAIM' || s === 'COMPRESS') return 'pressureReclaim';
  return 'pressureSwap';
}

const TOKEN_IO_COLORS = Object.freeze({
  demand: '#2563eb',
  prefetch: '#10b981',
  swapIn: '#8b5cf6',
  swapOut: '#f43f5e',
  pending: 'rgba(148,163,184,.18)',
  grid: 'rgba(148,163,184,.16)',
  text: '#94a3b8'
});

function tokenIOBreakdown(token) {
  const demand = Math.max(0, Number(token?.demandGB ?? token?.ssdGB ?? token?.readGB ?? 0));
  const prefetch = Math.max(0, Number(token?.prefetchGB || 0));
  const swapIn = Math.max(0, Number(token?.memory?.swapInGB || 0));
  const swapOut = Math.max(0, Number(token?.memory?.swapOutGB || 0));
  return { demand, prefetch, swapIn, swapOut, total: demand + prefetch + swapIn + swapOut };
}

function tokenIOUnit(maxGB) {
  if (maxGB < 0.001) return { divisor: 0.000001, suffix: 'KB' };
  if (maxGB < 1) return { divisor: 0.001, suffix: 'MB' };
  return { divisor: 1, suffix: 'GB' };
}

function ensureTokenIOPanel() {
  if (typeof document !== 'object') return null;
  let panel = document.getElementById('tokenIOPlaybackPanel');
  if (panel) return panel;
  const resultHero = document.querySelector('.resultHero');
  if (!resultHero) return null;
  panel = document.createElement('section');
  panel.id = 'tokenIOPlaybackPanel';
  panel.className = 'tokenIOPlayback';
  panel.innerHTML = `
    <div class="tokenIOHeader">
      <div>
        <div class="tokenIOEyebrow">LIVE STORAGE TRACE</div>
        <h3>토큰별 Storage I/O</h3>
        <p>생성 완료된 토큰까지만 막대를 표시합니다. 한 막대는 해당 토큰이 유발한 Expert/NAND 읽기, 프리페치, 스왑 I/O의 합입니다.</p>
      </div>
      <div class="tokenIOCurrent" aria-live="polite">
        <span id="tokenIOCurrentLabel">대기 중</span>
        <strong id="tokenIOCurrentValue">—</strong>
      </div>
    </div>
    <div class="tokenIOLegend" aria-label="스토리지 I/O 범례">
      <span><i style="background:${TOKEN_IO_COLORS.demand}"></i>요청 읽기</span>
      <span><i style="background:${TOKEN_IO_COLORS.prefetch}"></i>프리페치</span>
      <span><i style="background:${TOKEN_IO_COLORS.swapIn}"></i>스왑 인</span>
      <span><i style="background:${TOKEN_IO_COLORS.swapOut}"></i>스왑 아웃</span>
    </div>
    <canvas id="tokenIOPlaybackChart" width="1200" height="260" role="img" aria-label="토큰별 스토리지 I/O 실시간 막대그래프"></canvas>
    <div class="tokenIOFooter"><span id="tokenIOProgressLabel">0 / 0 tokens</span><span>막대 위에 포인터를 올리면 토큰별 상세 I/O를 확인할 수 있습니다.</span></div>`;
  const token = resultHero.querySelector('#token');
  const progress = resultHero.querySelector('.bar');
  resultHero.insertBefore(panel, progress || token?.nextSibling || null);
  panel.querySelector('canvas').addEventListener('pointermove', showTokenIOTooltip);
  panel.querySelector('canvas').addEventListener('pointerleave', hideTokenIOTooltip);
  return panel;
}

function injectShadcnBaseUI() {
  if (document.getElementById('shadcnBaseUIStyles')) return;
  const style = document.createElement('style');
  style.id = 'shadcnBaseUIStyles';
  style.textContent = `
    :root{
      --background:222.2 84% 4.9%;--foreground:210 40% 98%;--card:222.2 84% 4.9%;--card-foreground:210 40% 98%;
      --popover:222.2 84% 4.9%;--popover-foreground:210 40% 98%;--primary:217.2 91.2% 59.8%;--primary-foreground:222.2 47.4% 11.2%;
      --secondary:217.2 32.6% 17.5%;--secondary-foreground:210 40% 98%;--muted:217.2 32.6% 17.5%;--muted-foreground:215 20.2% 65.1%;
      --accent:217.2 32.6% 17.5%;--accent-foreground:210 40% 98%;--destructive:0 62.8% 30.6%;--destructive-foreground:210 40% 98%;
      --border:217.2 32.6% 17.5%;--input:217.2 32.6% 17.5%;--ring:224.3 76.3% 48%;--radius:.65rem;
    }
    :root[data-theme="light"]{--background:0 0% 100%;--foreground:222.2 84% 4.9%;--card:0 0% 100%;--card-foreground:222.2 84% 4.9%;--primary:221.2 83.2% 53.3%;--primary-foreground:210 40% 98%;--secondary:210 40% 96.1%;--secondary-foreground:222.2 47.4% 11.2%;--muted:210 40% 96.1%;--muted-foreground:215.4 16.3% 46.9%;--accent:210 40% 96.1%;--accent-foreground:222.2 47.4% 11.2%;--border:214.3 31.8% 91.4%;--input:214.3 31.8% 91.4%;--ring:221.2 83.2% 53.3%}
    body{background:hsl(var(--background));color:hsl(var(--foreground));letter-spacing:-.012em}
    .wrap{max-width:1600px}.panel,.advisor,.guidedBottleneck,.parameterPicker,.sweepParameters,.sweepResultsPanel{background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));border-radius:var(--radius);box-shadow:0 1px 2px rgba(0,0,0,.08)}
    input,select,textarea{background:hsl(var(--background))!important;border-color:hsl(var(--input))!important;border-radius:calc(var(--radius) - 2px)!important}
    button{border-radius:calc(var(--radius) - 2px)!important;border-color:hsl(var(--border))!important;background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));transition:background-color .15s ease,border-color .15s ease,transform .15s ease}
    button:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}button:active{transform:translateY(1px)}
    .primaryAction,#runGuidedSweep,#runSweep{background:hsl(var(--primary))!important;color:hsl(var(--primary-foreground))!important;border-color:hsl(var(--primary))!important}
    .kpis{gap:10px;background:transparent;padding:0;overflow:visible}.kpi{border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--card));padding:16px}.kpi:nth-child(3){background:hsl(var(--primary));color:hsl(var(--primary-foreground))}.kpi:nth-child(3) span,.kpi:nth-child(3) b{color:inherit}
    .actionToolbar{background:color-mix(in srgb,hsl(var(--background)) 88%,transparent);border-color:hsl(var(--border));border-radius:var(--radius);box-shadow:0 4px 12px rgba(0,0,0,.12)}
    .token{border-radius:var(--radius);background:hsl(var(--muted)/.35);border-color:hsl(var(--border))}
    .tokenIOPlayback{margin:14px 0 12px;padding:16px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--card));box-shadow:0 1px 2px rgba(0,0,0,.08)}
    .tokenIOHeader{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.tokenIOHeader h3{margin:2px 0 5px;font-size:16px}.tokenIOHeader p{max-width:760px;margin:0;color:hsl(var(--muted-foreground));font-size:11px;line-height:1.5}.tokenIOEyebrow{font:600 10px ui-monospace,monospace;letter-spacing:.12em;color:hsl(var(--primary))}.tokenIOCurrent{min-width:126px;padding:10px 12px;border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);background:hsl(var(--muted)/.35);text-align:right}.tokenIOCurrent span{display:block;color:hsl(var(--muted-foreground));font-size:10px}.tokenIOCurrent strong{display:block;margin-top:3px;font-size:20px;letter-spacing:-.04em}
    .tokenIOLegend{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 8px;color:hsl(var(--muted-foreground));font-size:10px}.tokenIOLegend i{display:inline-block;width:9px;height:9px;margin-right:5px;border-radius:2px}.tokenIOPlayback canvas{display:block;width:100%;height:220px;border:0;border-radius:calc(var(--radius) - 3px);background:hsl(var(--muted)/.2)}.tokenIOFooter{display:flex;justify-content:space-between;gap:12px;margin-top:8px;color:hsl(var(--muted-foreground));font-size:10px}
    .tokenIOTooltip{position:fixed;z-index:120;pointer-events:none;min-width:180px;padding:9px 10px;border:1px solid hsl(var(--border));border-radius:calc(var(--radius) - 2px);background:hsl(var(--popover));color:hsl(var(--popover-foreground));box-shadow:0 10px 28px rgba(0,0,0,.25);font-size:11px;line-height:1.55}
    @media(max-width:720px){.tokenIOHeader{display:block}.tokenIOCurrent{margin-top:10px;text-align:left}.tokenIOPlayback canvas{height:190px}.tokenIOFooter{display:grid}.kpis{gap:6px}}
  `;
  document.head.appendChild(style);
}

function formatTokenIO(valueGB, unit) {
  const value = valueGB / unit.divisor;
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit.suffix}`;
}

function drawTokenIOPlayback(result, completedCount) {
  const panel = ensureTokenIOPanel();
  const canvas = panel?.querySelector('#tokenIOPlaybackChart');
  if (!canvas || !result?.tokens?.length) return;
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cssWidth = Math.max(320, canvas.clientWidth || 900);
  const cssHeight = Math.max(160, canvas.clientHeight || 220);
  canvas.width = Math.round(cssWidth * ratio); canvas.height = Math.round(cssHeight * ratio);
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, cssWidth, cssHeight);
  const values = result.tokens.map(tokenIOBreakdown);
  const maxGB = Math.max(0.000001, ...values.map(item => item.total));
  const unit = tokenIOUnit(maxGB);
  const left = 46, right = 12, top = 14, bottom = 28, width = cssWidth - left - right, height = cssHeight - top - bottom;
  ctx.font = '10px system-ui'; ctx.fillStyle = TOKEN_IO_COLORS.text; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = top + height * i / 4; const value = maxGB * (1 - i / 4);
    ctx.strokeStyle = TOKEN_IO_COLORS.grid; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cssWidth - right, y); ctx.stroke();
    ctx.fillText(formatTokenIO(value, unit).replace(` ${unit.suffix}`, ''), left - 7, y + 3);
  }
  ctx.save(); ctx.translate(11, top + height / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(unit.suffix, 0, 0); ctx.restore();
  const slot = width / values.length; const barWidth = Math.max(2, Math.min(20, slot * .72));
  values.forEach((value, index) => {
    const x = left + slot * index + (slot - barWidth) / 2;
    if (index >= completedCount) {
      ctx.fillStyle = TOKEN_IO_COLORS.pending; ctx.fillRect(x, top + height - 2, barWidth, 2); return;
    }
    let y = top + height;
    for (const [key, color] of [['demand', TOKEN_IO_COLORS.demand], ['prefetch', TOKEN_IO_COLORS.prefetch], ['swapIn', TOKEN_IO_COLORS.swapIn], ['swapOut', TOKEN_IO_COLORS.swapOut]]) {
      const segmentHeight = value[key] / maxGB * height;
      y -= segmentHeight; ctx.fillStyle = color; ctx.fillRect(x, y, barWidth, segmentHeight);
    }
    if (index === completedCount - 1) { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(x - 1, Math.max(top, y - 1), barWidth + 2, top + height - y + 2); }
  });
  ctx.fillStyle = TOKEN_IO_COLORS.text; ctx.textAlign = 'center';
  const tickEvery = Math.max(1, Math.ceil(values.length / Math.max(5, Math.floor(width / 70))));
  values.forEach((_, index) => { if (index % tickEvery === 0 || index === values.length - 1) ctx.fillText(String(index + 1), left + slot * index + slot / 2, cssHeight - 9); });
  canvas.__tokenIOGeometry = { left, top, width, height, slot, values, unit, completedCount };
  panel.querySelector('#tokenIOProgressLabel').textContent = `${completedCount} / ${values.length} tokens`;
  const current = completedCount > 0 ? values[completedCount - 1] : null;
  panel.querySelector('#tokenIOCurrentLabel').textContent = current ? `Token ${completedCount}` : '대기 중';
  panel.querySelector('#tokenIOCurrentValue').textContent = current ? formatTokenIO(current.total, unit) : '—';
}

function updateTokenIOPlayback(result, completedCount) {
  if (!result || result.error) return;
  requestAnimationFrame(() => drawTokenIOPlayback(result, Math.max(0, Math.min(result.tokens.length, completedCount))));
}

function tokenIOTooltip() {
  let tooltip = document.getElementById('tokenIOTooltip');
  if (!tooltip) { tooltip = document.createElement('div'); tooltip.id = 'tokenIOTooltip'; tooltip.className = 'tokenIOTooltip'; tooltip.hidden = true; document.body.appendChild(tooltip); }
  return tooltip;
}

function showTokenIOTooltip(event) {
  const canvas = event.currentTarget; const geometry = canvas.__tokenIOGeometry; if (!geometry) return;
  const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const index = Math.floor((x - geometry.left) / geometry.slot);
  const tooltip = tokenIOTooltip();
  if (index < 0 || index >= geometry.values.length || index >= geometry.completedCount) { tooltip.hidden = true; return; }
  const value = geometry.values[index], unit = geometry.unit;
  tooltip.innerHTML = `<b>Token ${index + 1}</b><br>전체 ${formatTokenIO(value.total, unit)}<br>요청 읽기 ${formatTokenIO(value.demand, unit)}<br>프리페치 ${formatTokenIO(value.prefetch, unit)}<br>스왑 인 ${formatTokenIO(value.swapIn, unit)}<br>스왑 아웃 ${formatTokenIO(value.swapOut, unit)}`;
  tooltip.style.left = `${Math.min(window.innerWidth - 210, event.clientX + 14)}px`; tooltip.style.top = `${Math.min(window.innerHeight - 150, event.clientY + 14)}px`; tooltip.hidden = false;
}
function hideTokenIOTooltip() { const tooltip = document.getElementById('tokenIOTooltip'); if (tooltip) tooltip.hidden = true; }

function initializeShadcnBaseUI() {
  injectShadcnBaseUI(); ensureTokenIOPanel();
  window.addEventListener('resize', () => { if (lastResult && !lastResult.error) drawTokenIOPlayback(lastResult, anim?.result === lastResult ? anim.index : lastResult.tokens.length); });
}

if (typeof document === 'object') queueMicrotask(initializeShadcnBaseUI);
