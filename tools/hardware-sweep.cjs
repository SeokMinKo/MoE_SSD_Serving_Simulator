'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = ['core.js', 'config.js', 'memory.js', 'colibri.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n') + '\nglobalThis.__simulateColibri = simulateColibri;';
const sandbox = { console, document: { getElementById: () => null } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'hardware-sweep-bundle.js' });

const memory = {
  policy: 'swap',
  backgroundGB: 8,
  osReservedGB: 8,
  minHeadroomGB: 8,
  soft: 0.8,
  compress: 0.85,
  swap: 0.9,
  hard: 0.97,
  compressionEnabled: true,
  compressionRatio: 1.6,
  compressionBW: 25,
  swapEnabled: true,
  swapCapacityGB: 32,
  swapWriteRatio: 0.7,
  kvTouchFraction: 1
};
const baseline = {
  mode: 'colibri',
  prompt: 128,
  output: 32,
  context: 4096,
  conc: 1,
  arch: 'discrete',
  host: 128,
  vram: 8,
  dramBW: 273,
  pcieBW: 24,
  ssdBW: 9.2,
  lat: 120,
  seed: 260730,
  mem: memory,
  cold: true,
  placement: 'auto',
  layers: 75,
  experts: 256,
  active: 8,
  esize: 19,
  resident: 9.9,
  kvKB: 182,
  vcache: 4,
  dcache: 30,
  minDCache: 4,
  expertBacking: 'file',
  pinned: 6,
  page: 0,
  odirect: true,
  corr: 0.52,
  qd: 8,
  attn: 28,
  ems: 0.7,
  par: 4,
  prefillSpeedup: 4.5,
  pf: true,
  recall: 0.716,
  precision: 0.78,
  budget: 160
};

const scenarios = [
  ['Baseline', {}],
  ['SSD 0.5x', { ssdBW: 4.6 }],
  ['SSD 2x', { ssdBW: 18.4 }],
  ['PCIe 0.5x', { pcieBW: 12 }],
  ['PCIe 2x', { pcieBW: 48 }],
  ['DRAM 0.5x', { dramBW: 136.5 }],
  ['DRAM 2x', { dramBW: 546 }],
  ['RAM 64GB', { host: 64 }],
  ['RAM 256GB', { host: 256 }],
  ['VRAM 16GB', { vram: 16 }],
  ['Compute 2x', { attn: 14, ems: 0.35 }]
];
const criticalPath = breakdown => Object.entries({
  compute: breakdown.computeMs,
  storage: breakdown.storageMs,
  pcie: breakdown.transferMs,
  dram: breakdown.dramMs
}).sort((a, b) => b[1] - a[1])[0][0];

console.log('Scenario\tTTFT_ms\tTPS\tPrefill_path\tDRAM_cache_GB\tVRAM_cache_GB');
for (const [name, overrides] of scenarios) {
  const result = sandbox.__simulateColibri({ ...baseline, ...overrides });
  if (result.error) {
    console.log(`${name}\tERROR\tERROR\t${result.error}\t-\t-`);
    continue;
  }
  console.log([
    name,
    result.ttft.toFixed(1),
    result.tps.toFixed(3),
    criticalPath(result.prefillBreakdown),
    result.c.dcache.toFixed(2),
    result.c.vcache.toFixed(2)
  ].join('\t'));
}
console.log('\nApproximate trend report only; calibrate compute latencies and effective bandwidths for each target system.');
