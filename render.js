function renderPressure(r) {
  const s = r.state;
  const thrash = s.totalSwapOutGB > EPS ? Math.min(1, s.totalSwapInGB / s.totalSwapOutGB) : 0;
  $('pressureSummary').innerHTML = rows([
    ['Pressure state', `<span class="${pressureClass(s.lastState)}">${s.lastState}</span>`],
    ['Swap start token', s.swapStartToken === null ? 'None' : s.swapStartToken],
    ['Peak physical memory', `${fmt(s.peakPhysicalGB, 2)} / ${fmt(r.c.host, 1)} GB`],
    ['Minimum free memory', `${fmt(s.minFreeGB, 2)} GB`],
    ['Peak swap resident', `${fmt(s.peakSwapGB, 2)} GB`],
    ['Total swap-in / out', `${fmt(s.totalSwapInGB, 2)} / ${fmt(s.totalSwapOutGB, 2)} GB`],
    ['Page / Expert reclaimed', `${fmt(s.totalPageReclaimedGB, 2)} / ${fmt(s.totalExpertReclaimedGB, 2)} GB`],
    ['Thrash ratio', pct(thrash)],
    ['Peak DRAM BW', `${fmt(s.peakDramGBs, 1)} / ${fmt(r.c.dramBW, 1)} GB/s`],
    ['DRAM-induced stall', ms(s.totalDramStallMs / Math.max(1, r.tokens.length)) + ' / token']
  ]);
}
function renderColibri(r) {
  $('tpotLabel').textContent = 'Average TPOT';
  $('tpsLabel').textContent = 'Single TPS';
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
    ['Swap resident', `${fmt(last.swapGB, 3)} GB`],
    ['Device KV', `${fmt(r.state.deviceKVGB, 3)} GB`],
    ['Device cache / KV / reserve', `${fmt(last.deviceUsedGB, 3)} / ${fmt(r.c.vram, 1)} GB`],
    ['O_DIRECT', r.c.odirect ? 'Enabled' : 'Disabled']
  ]);
  $('modelStatus').innerHTML = `<b>Colibri V1.4 HW-sensitivity model</b><br>Prefill warms the Expert tiers and TTFT uses the maximum of calibrated compute, storage, PCIe, and DRAM paths. Decode Demand, Prefetch, Swap-in and Swap-out share one storage timeline. Auto placement derives cache budgets from RAM/VRAM capacity.<br><br><b>Interpretation:</b> Single TPS and TTFT are approximate trend estimates. Aggregate capacity is a resource upper bound, not a scheduler or continuous-batching prediction. GPU VRAM bandwidth and OS page-level behavior remain outside this model.`;
}
function renderAFM(r) {
  $('tpotLabel').textContent = 'Effective TPOT';
  $('tpsLabel').textContent = 'Effective TPS';
  $('storageLabel').textContent = 'NAND / token';
  $('hitLabel').textContent = 'Set overlap';
  const avgChanged = r.switches.length ? r.tot.changedTotal / r.switches.length : 0;
  const avgSwitch = r.switches.length ? r.tot.periodicGB / r.switches.length : 0;
  $('summary').innerHTML = rows([
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
    ['Swap resident', `${fmt(last.swapGB, 3)} GB`],
    ['Estimated full 20B NAND', `${fmt(r.d.totalNandGB, 3)} GB`]
  ]);
  $('modelStatus').innerHTML = `<b>AFM 3 V1.4 window-routed IFP model</b><br>Shared and current Routed Expert sets remain pinned. Memory pressure is applied primarily to KV Cache. Window reads, Swap I/O and DRAM traffic affect boundary and steady TPOT. Aggregate capacity is a resource upper bound, not a scheduler prediction.<br><br><span class="afmMark">Constant Table 없음:</span> actual Expert IDs and layer masks are not reconstructed; overlap-driven delta loading is used.`;
}
function render(r) {
  lastResult = r;
  if (r.error) {
    $('warn').hidden = false;
    $('warn').textContent = r.error;
    return;
  }
  $('warn').hidden = !r.oom;
  if (r.oom) $('warn').textContent = 'Simulation reached OOM/Hard pressure. Results after the last completed token are not available.';
  $('ttft').textContent = ms(r.ttft);
  $('tpot').textContent = ms(r.avg);
  $('tps').textContent = fmt(r.tps, 2);
  $('ssdpt').textContent = r.mode === 'afm3' ? mb(r.ssdPt) : `${fmt(r.ssdPt, 2)} GB`;
  $('hit').textContent = pct(r.hit);
  $('mem').textContent = `${fmt(r.state.peakPhysicalGB, 1)} GB peak`;
  r.mode === 'afm3' ? renderAFM(r) : renderColibri(r);
  renderPressure(r);
  drawPerformance(r);
  drawMemory(r);
}

function drawPerformance(r) {
  const cv = $('chart'), x = cv.getContext('2d'), W = cv.width, H = cv.height;
  const d = r.tokens.map(t => t.tpot), mx = Math.max(...d) * 1.15 || 1;
  x.clearRect(0, 0, W, H);
  x.fillStyle = '#071525'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#29445f';
  for (let i = 0; i < 5; i++) { const y = 20 + i * 50; x.beginPath(); x.moveTo(48, y); x.lineTo(W - 15, y); x.stroke(); }
  if (r.mode === 'afm3') {
    x.strokeStyle = '#a78bfa'; x.lineWidth = 1;
    for (let i = 0; i < r.tokens.length; i++) if (r.tokens[i].boundary) {
      const xx = 48 + (W - 73) * i / Math.max(1, d.length - 1);
      x.beginPath(); x.moveTo(xx, 15); x.lineTo(xx, H - 25); x.stroke(); x.fillStyle = '#c4b5fd'; x.fillText('IFP', xx + 3, 27);
    }
  }
  x.strokeStyle = '#67d9ff'; x.lineWidth = 2; x.beginPath();
  d.forEach((v, i) => { const xx = 48 + (W - 73) * i / Math.max(1, d.length - 1), yy = 18 + (H - 45) * (1 - v / mx); i ? x.lineTo(xx, yy) : x.moveTo(xx, yy); });
  x.stroke(); x.fillStyle = '#9db0c8'; x.font = '11px sans-serif'; x.fillText(r.mode === 'afm3' ? 'TPOT · violet = IFP boundary' : 'TPOT per token', 8, 14);
}
function drawMemory(r) {
  const cv = $('memoryChart'), x = cv.getContext('2d'), W = cv.width, H = cv.height;
  const used = r.tokens.map(t => t.memory.physicalUsedGB);
  const sw = r.tokens.map(t => t.memory.swapGB);
  const maxY = Math.max(r.c.host, ...used) * 1.05 || 1;
  x.clearRect(0, 0, W, H); x.fillStyle = '#071525'; x.fillRect(0, 0, W, H);
  const yOf = v => 18 + (H - 45) * (1 - v / maxY);
  const line = (arr, color) => { x.strokeStyle = color; x.lineWidth = 2; x.beginPath(); arr.forEach((v, i) => { const xx = 48 + (W - 73) * i / Math.max(1, arr.length - 1), yy = yOf(v); i ? x.lineTo(xx, yy) : x.moveTo(xx, yy); }); x.stroke(); };
  const trigger = thresholdGB(r.c, r.c.mem.swap);
  const hard = thresholdGB(r.c, r.c.mem.hard);
  x.setLineDash([5, 4]); x.strokeStyle = '#ffd36b'; x.beginPath(); x.moveTo(48, yOf(trigger)); x.lineTo(W - 15, yOf(trigger)); x.stroke();
  x.strokeStyle = '#ff8696'; x.beginPath(); x.moveTo(48, yOf(hard)); x.lineTo(W - 15, yOf(hard)); x.stroke(); x.setLineDash([]);
  line(used, '#67d9ff'); line(sw, '#a78bfa');
  x.fillStyle = '#9db0c8'; x.font = '11px sans-serif'; x.fillText('cyan: physical memory · violet: swap · dashed: swap/hard trigger', 8, 14);
}
