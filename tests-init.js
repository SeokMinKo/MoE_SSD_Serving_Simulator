function tests() {
  const log = [], t = (n, f) => { try { log.push((f() ? 'PASS ' : 'FAIL ') + n); } catch (e) { log.push(`ERROR ${n} ${e.message}`); } };
  const c = readColibri();
  t('Deterministic Colibri result', () => simulateColibri(c).avg === simulateColibri(c).avg);
  t('SSD BW increase does not reduce TPS', () => simulateColibri({ ...c, ssdBW: c.ssdBW * 2 }).tps >= simulateColibri(c).tps);
  t('DRAM BW decrease does not increase TPS', () => simulateColibri({ ...c, dramBW: c.dramBW / 2 }).tps <= simulateColibri(c).tps + EPS);
  t('No swap below trigger', () => {
    const x = { ...c, host: 512, mem: { ...c.mem, backgroundGB: 0 } };
    return simulateColibri(x).state.totalSwapOutGB === 0;
  });
  t('Lower swap trigger starts no later', () => {
    const base = { ...c, host: 64, context: 20000, output: 16, dcache: 30, minDCache: 30, expertBacking: 'anonymous', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, swap: 0.9, hard: 0.99, swapCapacityGB: 128 } };
    const a = simulateColibri(base), b = simulateColibri({ ...base, mem: { ...base.mem, swap: 0.7 } });
    const ta = a.state.swapStartToken ?? Infinity, tb = b.state.swapStartToken ?? Infinity;
    return tb <= ta;
  });
  t('File-backed reclaim avoids expert swap writes', () => {
    const x = { ...c, host: 64, context: 20000, output: 16, dcache: 30, minDCache: 0, expertBacking: 'file', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, soft: 0.65, swap: 0.8, hard: 0.99 } };
    const r = simulateColibri(x);
    return r.state.totalExpertReclaimedGB >= 0 && r.state.swapExpertGB === 0;
  });
  t('Anonymous pressure can create swap traffic', () => {
    const x = { ...c, host: 64, context: 20000, output: 16, dcache: 30, minDCache: 30, expertBacking: 'anonymous', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, swap: 0.75, hard: 0.99, swapCapacityGB: 128 } };
    return simulateColibri(x).state.totalSwapOutGB > 0;
  });
  t('Observed DRAM BW respects configured', () => {
    const r = simulateColibri({ ...c, dramBW: 20 });
    return r.state.peakDramGBs <= 20.001;
  });
  t('More memory delays or removes swap', () => {
    const x = { ...c, host: 64, context: 20000, output: 16, dcache: 30, minDCache: 30, expertBacking: 'anonymous', mem: { ...c.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, swap: 0.75, hard: 0.99, swapCapacityGB: 128 } };
    const a = simulateColibri(x), b = simulateColibri({ ...x, host: 128 });
    return (b.state.swapStartToken ?? Infinity) >= (a.state.swapStartToken ?? Infinity);
  });
  const a = readAFM(), d = afmDerived(a);
  t('AFM 2-bit expert raw size ≈12.976MB', () => Math.abs(d.rawExpertGB * 1000 - 12.976128) < 0.001);
  t('AFM 33rd token is first boundary', () => { const r = simulateAFM({ ...a, output: 33 }); return r.switches.length === 1 && r.tokens[32].boundary; });
  t('AFM active Expert weights remain pinned', () => { const r = simulateAFM({ ...a, host: 16, mem: { ...a.mem, backgroundGB: 4 } }); return !r.error ? r.tokens.every(tk => tk.memory.expertCacheGB === d.activeGB) : true; });
  t('KV thrash can produce swap-in and swap-out', () => {
    const x = { ...a, host: 32, context: 50000, output: 8, mem: { ...a.mem, backgroundGB: 4, minHeadroomGB: 0, compressionEnabled: false, swap: 0.75, hard: 0.99, swapCapacityGB: 128, kvTouchFraction: 1 } };
    const r = simulateAFM(x);
    return !r.error && r.state.totalSwapOutGB > 0 && r.state.totalSwapInGB > 0;
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
  const r = simulate(); render(r);
}

$('mode').onchange = () => syncMode(true);
$('afmProfile').onchange = () => { if ($('afmProfile').value !== 'custom') $('afmOverlap').value = $('afmProfile').value; };
$('afmOverlap').oninput = () => { $('afmProfile').value = 'custom'; };
$('run').onclick = () => { const r = simulate(); render(r); if (!r.error) startAnim(r); };
$('pause').onclick = pause;
$('test').onclick = tests;
$('speed').onchange = () => { if (anim.timer && !anim.paused) { const sim = Math.max(0, anim.due - performance.now()) * anim.oldSpeed; schedule(anim.action, sim); } };
syncMode(false);
