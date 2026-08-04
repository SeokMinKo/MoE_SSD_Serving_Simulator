'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = ['core.js','compute.js','config.js','compute-placement.js','memory.js','colibri.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') + '\nglobalThis.__sim={simulateColibri};';
const sandbox={console,structuredClone,document:{getElementById:()=>null,addEventListener:()=>{},readyState:'complete'}};
vm.createContext(sandbox); vm.runInContext(source,sandbox);
const sim=sandbox.__sim;
const mem={policy:'strict',backgroundGB:0,osReservedGB:0,minHeadroomGB:0,soft:.8,compress:.85,swap:.9,hard:1,compressionEnabled:false,compressionRatio:1.6,compressionBW:25,swapEnabled:false,swapCapacityGB:0,swapWriteRatio:.7,kvTouchFraction:1};
const calibrated=(overrides={})=>({mode:'calibrated',attentionDevice:'gpu',expertDevice:'gpu',cpu:{speedScale:1,attentionMs:40,expertMs:20,parallelExperts:4,prefillSpeedup:2},gpu:{speedScale:1,attentionMs:20,expertMs:10,parallelExperts:4,prefillSpeedup:4},hybrid:{cpuExpertFraction:.5,execution:'parallel',overlapEfficiency:1},...overrides});
const quant={payloadMode:'manual',format:'custom',weightBits:4,packing:1,manualExpertMB:20,cpuKernelMultiplier:1,gpuKernelMultiplier:1};
const base={mode:'colibri',prompt:0,output:12,context:128,conc:1,arch:'discrete',host:512,vram:16,dramBW:100,pcieBW:16,ssdBW:8,lat:100,seed:260730,mem,cold:true,placement:'manual',layers:2,experts:16,active:4,esize:20,resident:2,kvKB:256,vcache:.2,dcache:.4,minDCache:0,expertBacking:'file',pinned:0,page:0,odirect:true,corr:.25,qd:8,attn:20,ems:10,par:4,prefillSpeedup:4,pf:false,prefetchPolicy:'none',recall:0,precision:1,budget:0,quantization:quant};
test('diagnose Hybrid PCIe endpoints',()=>{
 const gpu=sim.simulateColibri({...base,compute:calibrated({expertDevice:'gpu'})});
 const cpu=sim.simulateColibri({...base,compute:calibrated({attentionDevice:'cpu',expertDevice:'cpu'})});
 const hybrid=sim.simulateColibri({...base,compute:calibrated({expertDevice:'hybrid',hybrid:{cpuExpertFraction:.5,execution:'parallel',overlapEfficiency:1}})});
 console.log('DEVICE_PCIE_DIAGNOSTIC',JSON.stringify({cpu:cpu.tot.pcieGB,hybrid:hybrid.tot.pcieGB,gpu:gpu.tot.pcieGB,cpuAct:hybrid.tot.cpuAct,gpuAct:hybrid.tot.gpuAct,unitGB:hybrid.c.esize*1.03/1000}));
});
