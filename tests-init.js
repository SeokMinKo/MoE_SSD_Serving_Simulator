function tests() {
  const log = [], t = (n, f) => { try { log.push((f() ? 'PASS ' : 'FAIL ') + n); } catch (e) { log.push(`ERROR ${n} ${e.message}`); } };
  const c = { ...readColibri(), placement: 'manual', layers: 75, experts: 256, active: 8 };
  t('Deterministic Colibri result', () => simulateColibri(c).avg === simulateColibri(c).avg);
  t('SSD BW increase does not reduce TPS', () => simulateColibri({ ...c, ssdBW: c.ssdBW * 2 }).tps >= simulateColibri(c).tps);
  t('DRAM BW decrease does not increase TPS', () => simulateColibri({ ...c, dramBW: c.dramBW / 2 }).tps <= simulateColibri(c).tps + EPS);
  t('No swap below trigger', () => {
    const x = { ...c, host: 512, mem: { ...c.mem, backgroundGB: 0 } };
    return simulateColibri(x).state.totalSwapOutGB === 0;
  });
  t('Lower swap trigger starts no later', () => {
    const base = { ...c, host: 72, context: 20000, output: 16, dcache: 30, minDCache: 30, expertBacking: 'anonymous', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, soft: 0.6, compress: 0.65, swap: 0.9, hard: 0.99, swapCapacityGB: 128 } };
    const a = simulateColibri(base), b = simulateColibri({ ...base, mem: { ...base.mem, swap: 0.7 } });
    const ta = a.state.swapStartToken ?? Infinity, tb = b.state.swapStartToken ?? Infinity;
    return tb <= ta;
  });
  t('File-backed reclaim avoids expert swap writes', () => {
    const x = { ...c, host: 64, context: 20000, output: 16, dcache: 30, minDCache: 0, expertBacking: 'file', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, soft: 0.65, compress: 0.7, swap: 0.8, hard: 0.99 } };
    const r = simulateColibri(x);
    return !r.error && r.state.totalExpertReclaimedGB > 0 && r.state.swapExpertGB === 0;
  });
  t('Anonymous pressure can create swap traffic', () => {
    const x = { ...c, host: 72, context: 20000, output: 16, dcache: 30, minDCache: 30, expertBacking: 'anonymous', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, soft: 0.65, compress: 0.7, swap: 0.75, hard: 0.99, swapCapacityGB: 128 } };
    const r = simulateColibri(x);
    if (!(r.state.totalSwapOutGB > 0)) throw new Error(`swap=${r.state.totalSwapOutGB} peak=${r.state.peakPhysicalGB} policy=${r.c.mem.policy}`);
    return true;
  });
  t('Observed DRAM BW respects configured', () => {
    const r = simulateColibri({ ...c, dramBW: 20 });
    return r.state.peakDramGBs <= 20.001;
  });
  t('More memory delays or removes swap', () => {
    const x = { ...c, host: 72, context: 20000, output: 16, dcache: 30, minDCache: 30, expertBacking: 'anonymous', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, soft: 0.65, compress: 0.7, swap: 0.75, hard: 0.99, swapCapacityGB: 128 } };
    const a = simulateColibri(x), b = simulateColibri({ ...x, host: 128 });
    return (b.state.swapStartToken ?? Infinity) >= (a.state.swapStartToken ?? Infinity);
  });
  t('Pinned Experts create no Expert storage reads', () => {
    const x = { ...c, prompt: 1, output: 2, host: 512, pinned: 400, dcache: 0, minDCache: 0, vcache: 0, page: 0, odirect: true };
    const r = simulateColibri(x);
    return !r.error && !(r.storageByKind['expert-demand-read'] || 0) && !(r.storageByKind['expert-prefetch-read'] || 0);
  });
  t('Queue depth is applied exactly once', () => {
    const x = { ...c, prompt: 0, output: 1, layers: 1, experts: 256, active: 8, pinned: 0, dcache: 0, minDCache: 0, vcache: 0, pf: false, qd: 2, ssdBW: 1000000, lat: 10000, resident: 0, kvKB: 0, attn: 0, ems: 0, par: 8, dramBW: 1000000 };
    const r = simulateColibri(x);
    return r.ssdBusy >= 39.9 && r.ssdBusy <= 40.1;
  });
  t('Prefill warms the first decode Expert', () => {
    const x = { ...c, prompt: 16, output: 1, layers: 1, experts: 1, active: 1, pinned: 0, dcache: 0.02, minDCache: 0, vcache: 0, pf: false, attn: 0, ems: 0, dramBW: 1000000 };
    const r = simulateColibri(x);
    return !r.error && !(r.storageByKind['expert-demand-read'] || 0) && r.tot.d === 1 && r.prefillBreakdown.storageGB > 0;
  });
  t('Prefill compute changes TTFT', () => {
    const x = { ...c, prompt: 128, output: 1, arch: 'unified', host: 512, pinned: 357, dcache: 0, minDCache: 0, vcache: 0, pf: false, attn: 5, dramBW: 1000000 };
    const fast = simulateColibri(x), slow = simulateColibri({ ...x, attn: 20 });
    return !fast.error && !slow.error && slow.ttft - fast.ttft > 300;
  });
  t('Auto placement grows with RAM and VRAM', () => {
    const x = { ...c, placement: 'auto', prompt: 0, output: 1, context: 1024, arch: 'discrete', host: 64, vram: 8, pinned: 0, dcache: 0, vcache: 0, pf: false };
    const small = simulateColibri(x).c, large = simulateColibri({ ...x, host: 128, vram: 24 }).c;
    return large.dcache > small.dcache && large.vcache > small.vcache;
  });
  t('Manual placement preserves cache budgets', () => {
    const r = simulateColibri({ ...c, placement: 'manual', dcache: 12.5, vcache: 3.25 });
    return r.c.dcache === 12.5 && r.c.vcache === 3.25;
  });
  const a = readAFM(), d = afmDerived(a);
  t('AFM 2-bit expert raw size ≈12.976MB', () => Math.abs(d.rawExpertGB * 1000 - 12.976128) < 0.001);
  t('AFM 33rd token is first boundary', () => { const r = simulateAFM({ ...a, output: 33 }); return r.switches.length === 1 && r.tokens[32].boundary; });
  t('AFM active Expert weights remain pinned', () => { const r = simulateAFM({ ...a, host: 32, mem: { ...a.mem, backgroundGB: 0 } }); return !r.error && r.tokens.every(tk => tk.memory.expertCacheGB === d.activeGB); });
  t('KV thrash can produce swap-in and swap-out', () => {
    const x = { ...a, host: 32, context: 50000, output: 8, mem: { ...a.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, soft: 0.65, compress: 0.7, swap: 0.75, hard: 0.99, swapCapacityGB: 128, kvTouchFraction: 1 } };
    const r = simulateAFM(x);
    if (r.error || !(r.state.totalSwapOutGB > 0 && r.state.totalSwapInGB > 0)) throw new Error(`error=${r.error || 'none'} in=${r.state?.totalSwapInGB} out=${r.state?.totalSwapOutGB} peak=${r.state?.peakPhysicalGB}`);
    return true;
  });
  t('1.5 TPS at 1× = 666.7ms', () => Math.abs(delay(1000 / 1.5, 1) - 666.6667) < 0.01);
  $('tests').textContent = log.join(String.fromCharCode(10)) + String.fromCharCode(10, 10) + `${log.filter(x => x.startsWith('PASS')).length}/${log.length} passed`;
}

function syncMode(applyPreset = false) {
  const afm = $('mode').value === 'afm3';
  document.querySelectorAll('.afmOnly').forEach(e => e.classList.toggle('hidden', !afm));
  document.querySelectorAll('.colibriOnly').forEach(e => e.classList.toggle('hidden', afm));
  $('modeBadge').textContent = afm ? 'AFM 3 IFP' : 'Colibri';
  if (afm && applyPreset) {
    $('arch').value = 'unified'; $('host').value = '128'; $('dramBW').value = '273'; $('ssdBW').value = '9.2';
  }
  syncPlacement();
  const r = simulate(); render(r);
}

function syncPlacement() {
  const auto = $('placement').value === 'auto';
  $('dcache').disabled = auto;
  $('vcache').disabled = auto;
}

function initializeAccessibility() {
  document.querySelectorAll('.f').forEach(row => {
    const label = row.querySelector('label');
    const control = row.querySelector('input, select, textarea');
    if (label && control?.id) label.htmlFor = control.id;
  });
  const chart = $('chart');
  const memoryChart = $('memoryChart');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', 'Token performance trace');
  memoryChart.setAttribute('role', 'img');
  memoryChart.setAttribute('aria-label', 'Memory and swap trace');
  $('warn').setAttribute('role', 'alert');
  $('status').setAttribute('aria-live', 'polite');
  $('tests').setAttribute('aria-live', 'polite');
}

$('mode').onchange = () => syncMode(true);
$('modelPreset').onchange = () => { applySelectedModelPreset(); const r = simulate(); render(r); };
for (const id of ['layers', 'experts', 'active']) $(id).oninput = markModelPresetCustom;
$('placement').onchange = () => { syncPlacement(); const r = simulate(); render(r); };
$('afmProfile').onchange = () => { if ($('afmProfile').value !== 'custom') $('afmOverlap').value = $('afmProfile').value; };
$('afmOverlap').oninput = () => { $('afmProfile').value = 'custom'; };
$('run').onclick = () => { const r = simulate(); render(r); if (!r.error) startAnim(r); };
$('pause').onclick = pause;
$('test').onclick = tests;
$('speed').onchange = () => { if (anim.timer && !anim.paused) { const sim = Math.max(0, anim.due - performance.now()) * anim.oldSpeed; schedule(anim.action, sim); } };
initializeModelPresets();
syncMode(false);
initializeReproControls();
initializeAccessibility();
