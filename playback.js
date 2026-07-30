function simulate() {
  const config = $('mode').value === 'afm3' ? readAFM() : readColibri();
  const engine = config.mode === 'afm3' ? simulateAFM : simulateColibri;
  if (config.conc <= 1) {
    const result = engine(config);
    result.runId = servingRunId(result.c || config, [{ id: 'single', arrivalMs: 0, output: config.output }]);
    return result;
  }

  const placedConfig = config.mode === 'colibri' ? applyColibriPlacement(config) : config;
  const singleRequestConfig = {
    ...placedConfig,
    conc: 1,
    ...(placedConfig.mode === 'colibri' && placedConfig.placement === 'auto' ? { placement: 'manual' } : {})
  };
  const result = engine(singleRequestConfig);
  if (result.error) return result;
  const requests = Array.from({ length: config.conc }, (_, index) => ({
    id: `request-${index + 1}`,
    arrivalMs: 0,
    output: config.output
  }));
  const serving = simulateServing(placedConfig, requests);
  if (serving.error) return { ...result, error: serving.error };
  result.serving = serving;
  result.agg = serving.throughputTPS;
  result.c = placedConfig;
  result.runId = servingRunId(result.c, requests);
  serving.runId = result.runId;
  return result;
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
    ? 'AFM 3 Core Advanced는 선택된 expert 집합을 window 동안 유지하고 memory pressure가 발생하면 KV compression과 swap traffic이 NAND 및 DRAM bandwidth를 사용합니다. '
    : 'Colibri는 필요한 MoE expert를 SSD에서 DRAM으로 가져오며 cache와 swap traffic이 storage 및 DRAM bandwidth를 함께 사용합니다. ';
}
function startAnim(r) {
  stop();
  anim = { timer: null, paused: false, index: 0, parts: sampleText(r.mode).match(/\S+\s*/g), result: r, due: 0, remainingSim: 0, oldSpeed: speed(), action: null };
  while (anim.parts.length < r.c.output) anim.parts = anim.parts.concat(anim.parts);
  anim.parts = anim.parts.slice(0, r.c.output);
  $('token').innerHTML = (r.mode === 'afm3' ? 'Initial IFP selection / materialization / prefill…' : 'TTFT / Prefill…') + ' <span class="cursor"></span>';
  $('progress').style.width = '0';
  $('status').textContent = `TTFT ${ms(r.ttft)} · ${speed() === 1 ? '실시간' : speed() + '×'}`;
  schedule(begin, r.ttft);
}
function begin() { $('token').innerHTML = '<span id="out"></span><span class="cursor"></span>'; emit(); }
function nextWaitStatus(tr, index) {
  if (tr.memory && ['SWAP', 'THRASH', 'OOM'].includes(tr.memory.pressureState)) {
    return `Memory ${tr.memory.pressureState} before Token ${index + 1} · swap ${fmt(tr.memory.swapGB, 2)}GB · TPOT ${ms(tr.tpot)}`;
  }
  if (anim.result.mode === 'afm3' && tr.boundary) {
    return `IFP reselection before Token ${index + 1} · ${tr.changed} new / ${tr.retained} retained · ${mb(tr.readGB)} · wait ${ms(tr.exposed)}`;
  }
  return `Waiting Token ${index + 1} · TPOT ${ms(tr.tpot)} · ${speed() === 1 ? '실시간' : speed() + '×'}`;
}
function emit(force = false) {
  if ((anim.paused && !force) || anim.index >= anim.parts.length) return;
  const tr = anim.result.tokens[anim.index], out = $('out');
  if (anim.result.mode === 'afm3' && tr.boundary) out.textContent += `\n[IFP Window ${tr.window} · ${tr.changed} experts changed]\n`;
  if (tr.memory && ['SWAP', 'THRASH'].includes(tr.memory.pressureState)) out.textContent += `\n[Memory ${tr.memory.pressureState} · swap ${fmt(tr.memory.swapGB, 2)}GB]\n`;
  out.textContent += anim.parts[anim.index];
  anim.index++;
  $('progress').style.width = `${anim.index / anim.parts.length * 100}%`;
  $('status').textContent = `Token ${anim.index}/${anim.parts.length} · TPOT ${ms(tr.tpot)} · ${tr.memory ? tr.memory.pressureState : 'NORMAL'}`;
  if (anim.index < anim.parts.length && !force) {
    const next = anim.result.tokens[anim.index];
    $('status').textContent = nextWaitStatus(next, anim.index);
    schedule(() => emit(), next.tpot);
  } else if (anim.index >= anim.parts.length) {
    $('status').textContent = `Done · effective ${fmt(anim.result.tps, 2)} tok/s`;
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
    $('pause').textContent = '▶ Resume';
  } else {
    anim.paused = false;
    $('pause').textContent = 'Ⅱ Pause';
    if (anim.action) schedule(anim.action, anim.remainingSim);
  }
}

function rows(items) { return items.map(x => `<tr><td>${x[0]}</td><td>${x[1]}</td></tr>`).join(''); }
function pressureClass(s) {
  if (s === 'NORMAL') return 'pressureNormal';
  if (s === 'RECLAIM' || s === 'COMPRESS') return 'pressureReclaim';
  return 'pressureSwap';
}
