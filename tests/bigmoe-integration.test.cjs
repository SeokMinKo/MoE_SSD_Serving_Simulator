'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadIntegration() {
  const files = [
    'build-info.js', 'core.js', 'compute.js', 'config.js', 'compute-placement.js',
    'memory.js', 'colibri.js', 'afm.js', 'bigmoe-config.js', 'bigmoe-cache.js',
    'bigmoe-edge.js', 'serving.js'
  ];
  const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n') +
    '\nglobalThis.__integration = { runSimulationConfig, bigMoeEdgePreset };';
  const sandbox = { console, structuredClone, TextEncoder };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'bigmoe-integration-bundle.js' });
  return sandbox.__integration;
}

test('runSimulationConfig dispatches BigMoEEdge without Colibri placement or serving fallback', () => {
  const { runSimulationConfig, bigMoeEdgePreset } = loadIntegration();
  const config = bigMoeEdgePreset();
  config.output = 2;
  const result = runSimulationConfig(config);

  assert.equal(result.error, undefined);
  assert.equal(result.engine, 'BigMoEEdge');
  assert.equal(result.mode, 'bigmoe-edge');
  assert.equal(result.c.mode, 'bigmoe-edge');
  assert.equal(result.agg, result.tps);
  assert.equal(result.resources.pcieGB, 0);
  assert.equal(result.resources.vramGB, 0);
});

test('BigMoEEdge public dispatch rejects request populations it does not execute', () => {
  const { runSimulationConfig, bigMoeEdgePreset } = loadIntegration();
  const config = bigMoeEdgePreset();
  config.output = 2;
  for (const requests of [
    [],
    [{ id: 'request-1', arrivalMs: 0, output: 3 }],
    [{ id: 'request-1', arrivalMs: 5, output: 2 }],
    [{ id: 'custom', arrivalMs: 0, output: 2 }],
    [
      { id: 'request-1', arrivalMs: 0, output: 2 },
      { id: 'request-2', arrivalMs: 0, output: 2 }
    ]
  ]) {
    const result = runSimulationConfig(config, {}, requests);
    assert.equal(result.errorCode, 'INVALID_REQUESTS', JSON.stringify(requests));
    assert.equal(typeof result.error, 'string', JSON.stringify(requests));
    assert.ok(result.error.length > 0, JSON.stringify(requests));
  }
  const optionResult = runSimulationConfig(config, { batchWindowMs: 5 });
  assert.match(optionResult.error, /does not support scheduler options/);
});

test('simulation and replay Workers load BigMoEEdge before serving consumers', () => {
  for (const file of ['simulation-worker.js', 'replay-worker.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const configIndex = source.indexOf("'bigmoe-config.js'");
    const cacheIndex = source.indexOf("'bigmoe-cache.js'");
    const edgeIndex = source.indexOf("'bigmoe-edge.js'");
    const servingIndex = source.indexOf("'serving.js'");

    assert.ok(configIndex >= 0, `${file} must import bigmoe-config.js`);
    assert.ok(cacheIndex > configIndex, `${file} cache order`);
    assert.ok(edgeIndex > cacheIndex, `${file} edge order`);
    assert.ok(servingIndex > edgeIndex, `${file} serving order`);
  }
});

test('runSimulationConfig rejects unknown engines instead of falling back to Colibri', () => {
  const { runSimulationConfig } = loadIntegration();
  const result = runSimulationConfig({ mode: 'mystery-engine' });

  assert.equal(result.errorCode, 'UNSUPPORTED_MODE');
  assert.match(result.error, /Unsupported simulation mode/);
});

test('release manifest ships every BigMoE runtime and preserves production load order', () => {
  const build = fs.readFileSync(path.join(root, 'tools', 'build-release.cjs'), 'utf8');
  for (const file of [
    'bigmoe-config.js', 'bigmoe-cache.js', 'bigmoe-edge.js', 'bigmoe-telemetry.js',
    'bigmoe-telemetry-ui.js', 'artifact-v6.js'
  ]) {
    assert.ok(build.includes(`'${file}'`), `release missing ${file}`);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /bigmoe-config\.js[\s\S]*bigmoe-cache\.js[\s\S]*bigmoe-edge\.js[\s\S]*bigmoe-telemetry\.js[\s\S]*serving\.js/);
  assert.match(html, /repro\.js[\s\S]*artifact-v6\.js[\s\S]*playback\.js/);
});
