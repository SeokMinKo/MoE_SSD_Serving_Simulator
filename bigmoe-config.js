'use strict';

const BIGMOE_EDGE_ROOT_FIELDS = new Set([
  'mode', 'prompt', 'output', 'context', 'conc', 'seed',
  'host', 'dramBW', 'ssdBW', 'lat', 'mem', 'model', 'runtime', 'calibration'
]);
const BIGMOE_EDGE_NESTED_FIELDS = Object.freeze({
  mem: new Set([
    'policy', 'backgroundGB', 'osReservedGB', 'minHeadroomGB',
    'soft', 'compress', 'swap', 'hard', 'compressionEnabled', 'compressionRatio',
    'compressionBW', 'swapEnabled', 'swapCapacityGB', 'swapWriteRatio', 'kvTouchFraction'
  ]),
  model: new Set([
    'arch', 'layers', 'experts', 'active', 'expertProjectionMiB', 'denseResidentGB',
    'kvKB', 'quantization', 'sharedExpertGB'
  ]),
  runtime: new Set([
    'threads', 'referenceThreads', 'threadScalingExponent', 'ioThreads', 'odirect', 'execution', 'cacheMode', 'cacheMiB',
    'denseWeights', 'attentionMs', 'expertMs', 'prefillTPS', 'managementMs', 'loopOverheadMs'
  ]),
  calibration: new Set(['source', 'engineVersion', 'sourceCommit', 'deviceLabel', 'measured'])
});

function bigMoeConfigError(code, path, message) {
  return { code, path, message };
}

function bigMoeEdgePreset() {
  return {
    mode: 'bigmoe-edge', prompt: 128, output: 64, context: 4096, conc: 1, seed: 260730,
    host: 11.3, dramBW: 60, ssdBW: 4.5, lat: 120,
    mem: {
      policy: 'strict', backgroundGB: 0.5, osReservedGB: 1, minHeadroomGB: 0.5,
      soft: 0.8, compress: 0.85, swap: 0.9, hard: 0.97,
      compressionEnabled: false, compressionRatio: 1, compressionBW: 0,
      swapEnabled: false, swapCapacityGB: 0, swapWriteRatio: 0, kvTouchFraction: 1
    },
    model: {
      arch: 'qwen3moe', layers: 48, experts: 128, active: 8,
      expertProjectionMiB: [1.575, 1.575, 1.575], denseResidentGB: 2.2,
      kvKB: 182, quantization: 'Q4_K_M', sharedExpertGB: 0
    },
    runtime: {
      threads: 4, referenceThreads: 4, threadScalingExponent: 0.8,
      ioThreads: 4, odirect: true, execution: 'serial',
      cacheMode: 'fixed', cacheMiB: 4000, denseWeights: 'anon',
      attentionMs: 40, expertMs: 0.15, prefillTPS: 12,
      managementMs: 0.5, loopOverheadMs: 0.2
    },
    calibration: {
      source: 'manual', engineVersion: 'unvalidated-alpha',
      sourceCommit: '8c8c8f1840a45a2728ff8e4f81cf4cf7f5d628b6',
      deviceLabel: 'Qwen3-30B-A3B analytic reference', measured: false
    }
  };
}

function validateBigMoeEdgeConfig(config) {
  const errors = [];
  for (const key of Object.keys(config || {})) {
    if (!BIGMOE_EDGE_ROOT_FIELDS.has(key)) {
      errors.push(bigMoeConfigError('UNKNOWN_FIELD', key, `Unknown BigMoEEdge field: ${key}`));
    }
  }
  for (const [section, allowed] of Object.entries(BIGMOE_EDGE_NESTED_FIELDS)) {
    for (const key of Object.keys(config?.[section] || {})) {
      if (!allowed.has(key)) {
        const path = `${section}.${key}`;
        errors.push(bigMoeConfigError('UNKNOWN_FIELD', path, `Unknown BigMoEEdge field: ${path}`));
      }
    }
  }
  const valueAt = path => path.split('.').reduce((value, key) => value?.[key], config);
  const invalid = (path, message) => errors.push(bigMoeConfigError('INVALID_VALUE', path, message));
  const number = (path, options = {}) => {
    const value = valueAt(path);
    const minimum = options.min ?? -Infinity;
    const maximum = options.max ?? Infinity;
    if (!Number.isFinite(value) || value < minimum || value > maximum || (options.integer && !Number.isSafeInteger(value))) {
      invalid(path, `${path} must be ${options.integer ? 'an integer' : 'a finite number'} between ${minimum} and ${maximum}.`);
    }
  };
  const oneOf = (path, values) => {
    if (!values.includes(valueAt(path))) invalid(path, `${path} must be one of: ${values.join(', ')}.`);
  };
  const nonemptyString = path => {
    const value = valueAt(path);
    if (typeof value !== 'string' || value.trim() === '') invalid(path, `${path} must be a non-empty string.`);
  };

  oneOf('mode', ['bigmoe-edge']);
  number('prompt', { min: 0, max: 1_000_000, integer: true });
  number('output', { min: 1, max: 100_000, integer: true });
  number('context', { min: 1, max: 10_000_000, integer: true });
  number('seed', { min: 0, integer: true });
  number('host', { min: Number.MIN_VALUE, max: 1_000_000 });
  number('dramBW', { min: 0.001, max: 1_000_000_000_000 });
  number('ssdBW', { min: 0.001, max: 1_000_000_000_000 });
  number('lat', { min: 0, max: 1_000_000_000 });
  number('mem.backgroundGB', { min: 0, max: 1_000_000 });
  number('mem.osReservedGB', { min: 0, max: 1_000_000 });
  number('mem.minHeadroomGB', { min: 0, max: 1_000_000 });
  number('mem.soft', { min: 0, max: 1 });
  number('mem.compress', { min: 0, max: 1 });
  number('mem.swap', { min: 0, max: 1 });
  number('mem.hard', { min: 0, max: 1 });
  if (typeof valueAt('mem.compressionEnabled') !== 'boolean') invalid('mem.compressionEnabled', 'mem.compressionEnabled must be boolean.');
  number('mem.compressionRatio', { min: 1, max: 100 });
  number('mem.compressionBW', { min: 0, max: 1_000_000 });
  if (typeof valueAt('mem.swapEnabled') !== 'boolean') invalid('mem.swapEnabled', 'mem.swapEnabled must be boolean.');
  number('mem.swapCapacityGB', { min: 0, max: 1_000_000 });
  number('mem.swapWriteRatio', { min: 0, max: 1 });
  number('mem.kvTouchFraction', { min: 0, max: 1 });
  const thresholds = ['soft', 'compress', 'swap', 'hard'].map(key => valueAt(`mem.${key}`));
  if (thresholds.every(Number.isFinite) && thresholds.some((value, index) => index > 0 && value <= thresholds[index - 1])) {
    errors.push(bigMoeConfigError('INVALID_RELATION', 'mem.thresholds', 'Memory thresholds must satisfy soft < compress < swap < hard.'));
  }
  oneOf('model.arch', ['qwen3moe']);
  oneOf('model.quantization', ['Q4_K_M']);
  number('model.layers', { min: 1, max: 1_000_000, integer: true });
  number('model.experts', { min: 1, max: 1_000_000, integer: true });
  number('model.active', { min: 1, max: 1_000_000, integer: true });
  number('model.denseResidentGB', { min: 0, max: 1_000_000 });
  number('model.kvKB', { min: 0, max: 1_000_000 });
  number('model.sharedExpertGB', { min: 0, max: 1_000_000 });
  const projections = valueAt('model.expertProjectionMiB');
  if (!Array.isArray(projections) || projections.length !== 3 || projections.some(value => !Number.isFinite(value) || value <= 0 || value > 1_000_000)) {
    invalid('model.expertProjectionMiB', 'model.expertProjectionMiB must contain exactly three positive finite MiB slice sizes.');
  }
  number('runtime.threads', { min: 1, max: 256, integer: true });
  number('runtime.referenceThreads', { min: 1, max: 256, integer: true });
  number('runtime.threadScalingExponent', { min: 0, max: 1 });
  number('runtime.ioThreads', { min: 1, max: 8, integer: true });
  number('runtime.cacheMiB', { min: 0, max: 1_000_000_000 });
  number('runtime.attentionMs', { min: 0, max: 1_000_000_000 });
  number('runtime.expertMs', { min: 0, max: 1_000_000_000 });
  number('runtime.prefillTPS', { min: 0.001, max: 1_000_000_000 });
  number('runtime.managementMs', { min: 0, max: 1_000_000_000 });
  number('runtime.loopOverheadMs', { min: 0, max: 1_000_000_000 });
  oneOf('runtime.cacheMode', ['off', 'fixed']);
  oneOf('runtime.denseWeights', ['anon', 'mmap', 'warm']);
  if (typeof valueAt('runtime.odirect') !== 'boolean') invalid('runtime.odirect', 'runtime.odirect must be boolean.');
  oneOf('calibration.source', ['manual']);
  nonemptyString('calibration.engineVersion');
  nonemptyString('calibration.sourceCommit');
  nonemptyString('calibration.deviceLabel');
  if (typeof valueAt('calibration.measured') !== 'boolean') invalid('calibration.measured', 'calibration.measured must be boolean.');
  const unsupported = (path, active, message) => {
    if (active) errors.push(bigMoeConfigError('UNSUPPORTED_SEMANTICS', path, message));
  };
  unsupported('mem.policy', valueAt('mem.policy') !== 'strict', 'BigMoEEdge serial v1 supports strict host-DRAM admission only.');
  unsupported('mem.compressionEnabled', valueAt('mem.compressionEnabled') === true, 'BigMoEEdge serial v1 does not model compression.');
  unsupported('mem.swapEnabled', valueAt('mem.swapEnabled') === true, 'BigMoEEdge serial v1 does not model swap.');
  unsupported('runtime.denseWeights', valueAt('runtime.denseWeights') !== 'anon', 'BigMoEEdge serial v1 does not model mmap/page-cache dense weights.');
  if (config && config.conc !== 1) {
    errors.push(bigMoeConfigError(
      'UNSUPPORTED_CONCURRENCY',
      'conc',
      'BigMoEEdge v1 supports exactly one request.'
    ));
  }
  if (config && config.runtime && config.runtime.execution !== 'serial') {
    errors.push(bigMoeConfigError(
      'UNSUPPORTED_EXECUTION',
      'runtime.execution',
      'BigMoEEdge v1 models the stock llama.cpp serial path only.'
    ));
  }
  if (config && config.model && config.model.active > config.model.experts) {
    errors.push(bigMoeConfigError(
      'INVALID_RELATION',
      'model.active',
      'Active Experts cannot exceed the architecture Expert count.'
    ));
  }
  const cacheMode = valueAt('runtime.cacheMode');
  const cacheMiB = valueAt('runtime.cacheMiB');
  if ((cacheMode === 'off' && cacheMiB !== 0) || (cacheMode === 'fixed' && !(cacheMiB > 0))) {
    errors.push(bigMoeConfigError('INVALID_RELATION', 'runtime.cacheMiB', 'Cache-off requires 0 MiB and fixed cache requires a positive MiB capacity.'));
  }
  const decodeWork = valueAt('output') * valueAt('model.layers') * valueAt('model.active');
  if (Number.isFinite(decodeWork) && decodeWork > 1_000_000) {
    errors.push(bigMoeConfigError('WORK_BUDGET_EXCEEDED', 'runtime.work', 'BigMoEEdge decode work exceeds the browser serial execution budget.'));
  }
  return { valid: errors.length === 0, errors };
}
