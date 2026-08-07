'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function load() {
  const sandbox = { console, Map, Set };
  vm.createContext(sandbox);
  for (const file of ['bigmoe-config.js', 'bigmoe-cache.js', 'bigmoe-edge.js', 'advisor.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

test('BigMoEEdge Advisor separates CPU kernel from exposed DRAM stall and recommends only CPU backend controls', () => {
  const sandbox = load();
  const config = vm.runInContext('bigMoeEdgePreset()', sandbox);
  config.prompt = 0;
  config.output = 2;
  config.model.layers = 2;
  config.model.experts = 4;
  config.model.active = 2;
  config.model.expertProjectionMiB = [1, 2, 3];
  config.runtime.cacheMode = 'off';
  config.runtime.cacheMiB = 0;
  config.runtime.attentionMs = 0;
  config.runtime.expertMs = 2;
  config.runtime.managementMs = 0;
  config.runtime.loopOverheadMs = 0;
  config.runtime.threadScalingExponent = 1;
  config.dramBW = 1;
  config.ssdBW = 1e9;
  config.lat = 0;
  sandbox.__config = config;
  const result = vm.runInContext('simulateBigMoeEdge(__config)', sandbox);
  sandbox.__result = result;
  const insight = vm.runInContext('createBottleneckInsight(__result)', sandbox);
  const first = JSON.parse(JSON.stringify(insight.phases.find(phase => phase.id === 'first-token')));
  const byId = Object.fromEntries(first.resources.map(resource => [resource.id, resource]));
  const evidence = resource => Object.fromEntries(resource.evidence.map(item => [item.label, item.value]));

  assert.equal(evidence(byId.compute)['Average compute demand'], 8);
  assert.equal(evidence(byId['data-movement'])['Average exposed DRAM stall'], 17.165824);
  assert.match(byId.storage.recommendation.controls, /runtime\.ioThreads/);
  assert.match(byId.storage.recommendation.controls, /runtime\.cacheMiB/);
  assert.match(byId['data-movement'].recommendation.controls, /dramBW/);
  assert.match(byId.compute.recommendation.controls, /runtime\.threads/);
  assert.doesNotMatch(byId.storage.recommendation.controls, /\bqd\b|pcieBW|vram/i);
});
