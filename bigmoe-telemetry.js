'use strict';

const BIGMOE_METRICS_REQUIRED_COLUMNS = Object.freeze([
  'step', 'steps', 'wall_ms', 'io_ms', 'compute_ms', 'read_bytes', 'cache_hit_pct'
]);
const BIGMOE_METRICS_MAX_BYTES = 16 * 1024 * 1024;
const BIGMOE_METRICS_MAX_STEPS = 100_000;

function bigMoeTelemetryScalar(value) {
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  return value;
}

function bigMoeTelemetryKeyValuePairs(line) {
  return Array.from(String(line).matchAll(/([^\s=]+)=([^\s]+)/g), match => [match[1], bigMoeTelemetryScalar(match[2])]);
}

function bigMoeTelemetryUtf8Bytes(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
             text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > BIGMOE_METRICS_MAX_BYTES) return bytes;
  }
  return bytes;
}

function bigMoeTelemetryError(code, message, details = {}) {
  return { error: message, errorCode: code, ...details };
}

function createBigMoeTelemetryEvidence(imported) {
  if (!imported || imported.error) {
    return {
      eligible: false,
      measured: false,
      computeIsResidual: true,
      directExpertMs: null,
      allowedTargets: [],
      observed: null,
      reason: imported?.error || 'Telemetry import is required.'
    };
  }
  const tokens = imported.tokens || [];
  const mean = selector => tokens.length ? tokens.reduce((sum, token) => sum + selector(token), 0) / tokens.length : 0;
  const overlap = Number(imported.preamble?.overlap || 0) === 1;
  const eligible = imported.comparable === true && !overlap && tokens.length > 0;
  return {
    schemaVersion: 'bmoe-metrics-evidence/v1',
    eligible,
    measured: tokens.length > 0,
    computeIsResidual: true,
    directExpertMs: null,
    allowedTargets: eligible ? ['endToEnd', 'storage', 'cache', 'memory'] : [],
    prohibitedTargets: ['runtime.expertMs'],
    reason: eligible ? null : overlap ? 'V1 calibration accepts serial telemetry only.' : 'Telemetry is not benchmark-comparable.',
    source: {
      schemaVersion: imported.schemaVersion,
      engineVersion: imported.preamble?.engine || 'unknown',
      model: imported.preamble?.model || 'unknown',
      architecture: imported.preamble?.arch || 'unknown'
    },
    observed: {
      tokenCount: tokens.length,
      meanWallMs: mean(token => token.wallMs),
      meanCriticalFlashMs: mean(token => token.criticalFlashMs),
      meanManagementMs: mean(token => token.managementMs),
      meanLoopOverheadMs: mean(token => token.loopOverheadMs),
      readMiBPerToken: mean(token => token.readMiB),
      cacheHitPct: mean(token => token.cacheHitPct),
      majorFaultsPerToken: mean(token => token.majorFaults),
      meanCpuOccupancyPct: (() => {
        const measured = tokens.map(token => token.cpuOccupancyPct).filter(Number.isFinite);
        return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
      })()
    }
  };
}

function parseBigMoeMetricsCsv(text) {
  if (typeof text !== 'string') return bigMoeTelemetryError('INVALID_TELEMETRY', 'BigMoE telemetry must be text.');
  if (text.length > BIGMOE_METRICS_MAX_BYTES ||
      (/[^\x00-\x7f]/.test(text) && bigMoeTelemetryUtf8Bytes(text) > BIGMOE_METRICS_MAX_BYTES)) {
    return bigMoeTelemetryError('TELEMETRY_TOO_LARGE', 'BigMoE telemetry exceeds the 16 MiB import limit.');
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '# bmoe_metrics v2') {
    return bigMoeTelemetryError('UNSUPPORTED_TELEMETRY_VERSION', 'Expected # bmoe_metrics v2 preamble.');
  }

  const preamble = {};
  const summary = {};
  let header = null;
  const rowLines = [];
  const preambleKeys = new Set();
  const summaryKeys = new Set();
  let metadataError = null;
  const mergeMetadata = (target, seen, line, scope) => {
    for (const [key, value] of bigMoeTelemetryKeyValuePairs(line)) {
      if (seen.has(key)) {
        metadataError = bigMoeTelemetryError('DUPLICATE_METADATA', `BigMoE telemetry contains duplicate ${scope} metadata: ${key}.`);
        return;
      }
      seen.add(key);
      target[key] = value;
    }
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('# summary ')) {
      mergeMetadata(summary, summaryKeys, line.slice('# summary '.length), 'summary');
    } else if (line.startsWith('# ')) {
      mergeMetadata(preamble, preambleKeys, line.slice(2), 'preamble');
    } else if (!header) {
      header = line.split(',').map(value => value.trim());
    } else {
      rowLines.push(line);
    }
    if (metadataError) return metadataError;
  }
  if (!header) return bigMoeTelemetryError('MISSING_HEADER', 'BigMoE telemetry CSV header is required.');
  if (new Set(header).size !== header.length) {
    return bigMoeTelemetryError('DUPLICATE_COLUMN', 'BigMoE telemetry CSV header contains duplicate columns.');
  }
  const missing = BIGMOE_METRICS_REQUIRED_COLUMNS.filter(column => !header.includes(column));
  if (missing.length) {
    return bigMoeTelemetryError('MISSING_COLUMNS', `Missing BigMoE telemetry columns: ${missing.join(', ')}`, { missingColumns: missing });
  }
  if (['engine', 'model'].some(key => typeof preamble[key] !== 'string' || preamble[key].trim() === '') || preamble.arch !== 'qwen3moe') {
    return bigMoeTelemetryError('MISSING_IDENTITY', 'BigMoE telemetry requires nonempty engine/model metadata and canonical qwen3moe architecture.');
  }
  const semanticError = (() => {
    if (!Number.isSafeInteger(preamble.threads) || preamble.threads < 1) return 'threads';
    if (![0, 1].includes(preamble.overlap)) return 'overlap';
    if (!Number.isSafeInteger(preamble.compute_trace_layers) || preamble.compute_trace_layers < 0) return 'compute_trace_layers';
    if (![0, 1].includes(preamble.predict_log)) return 'predict_log';
    if (![0, 1].includes(preamble.prefetch_sync)) return 'prefetch_sync';
    if (!Number.isFinite(preamble.temp) || preamble.temp < 0) return 'temp';
    if (typeof preamble.spec !== 'string' || preamble.spec.trim() === '') return 'spec';
    return null;
  })();
  if (semanticError) {
    return bigMoeTelemetryError('INVALID_PREAMBLE', `BigMoE telemetry has missing or invalid ${semanticError} metadata.`);
  }

  const tokens = [];
  let expectedSteps = null;
  for (let rowIndex = 0; rowIndex < rowLines.length; rowIndex++) {
    const cells = rowLines[rowIndex].split(',').map(value => value.trim());
    if (cells.length !== header.length) {
      return bigMoeTelemetryError('INVALID_ROW', `Telemetry row ${rowIndex + 1} has ${cells.length} cells; expected ${header.length}.`, { row: rowIndex + 1 });
    }
    const row = Object.fromEntries(header.map((column, index) => [column, bigMoeTelemetryScalar(cells[index])]));
    for (const column of BIGMOE_METRICS_REQUIRED_COLUMNS) {
      if (!Number.isFinite(row[column])) {
        return bigMoeTelemetryError('INVALID_ROW_VALUE', `Telemetry row ${rowIndex + 1} has invalid ${column}.`, { row: rowIndex + 1, column });
      }
    }
    const optionalNumericColumns = ['stall_ms', 'mgmt_ms', 'majflt', 'cpu_ms', 'dense_resident_frac', 'turn', 'loop_overhead_ms'];
    for (const column of optionalNumericColumns) {
      if (header.includes(column) && !Number.isFinite(row[column])) {
        return bigMoeTelemetryError('INVALID_ROW_VALUE', `Telemetry row ${rowIndex + 1} has invalid ${column}.`, { row: rowIndex + 1, column });
      }
    }
    if (Number.isSafeInteger(row.steps) && row.steps > BIGMOE_METRICS_MAX_STEPS) {
      return bigMoeTelemetryError('TELEMETRY_TOO_LARGE', 'BigMoE telemetry exceeds the row budget.', { row: rowIndex + 1 });
    }
    if (!Number.isSafeInteger(row.step) || !Number.isSafeInteger(row.steps) || row.step !== rowIndex + 1 || row.steps < 1 || row.step > row.steps) {
      return bigMoeTelemetryError('INVALID_STEP_SEQUENCE', `Telemetry row ${rowIndex + 1} has an invalid step sequence.`, { row: rowIndex + 1 });
    }
    if (expectedSteps === null) expectedSteps = row.steps;
    if (row.steps !== expectedSteps) {
      return bigMoeTelemetryError('INVALID_STEP_SEQUENCE', `Telemetry row ${rowIndex + 1} changes the declared step count.`, { row: rowIndex + 1 });
    }
    if (row.wall_ms <= 0 || row.io_ms < 0 || row.compute_ms < 0 || !Number.isSafeInteger(row.read_bytes) || row.read_bytes < 0 ||
        row.cache_hit_pct < 0 || row.cache_hit_pct > 100) {
      return bigMoeTelemetryError('INVALID_ROW_RANGE', `Telemetry row ${rowIndex + 1} contains an out-of-range measurement.`, { row: rowIndex + 1 });
    }
    for (const column of ['stall_ms', 'mgmt_ms', 'cpu_ms', 'loop_overhead_ms']) {
      if (header.includes(column) && row[column] < 0) {
        return bigMoeTelemetryError('INVALID_ROW_RANGE', `Telemetry row ${rowIndex + 1} contains negative ${column}.`, { row: rowIndex + 1, column });
      }
    }
    if (header.includes('majflt') && (!Number.isSafeInteger(row.majflt) || row.majflt < 0)) {
      return bigMoeTelemetryError('INVALID_ROW_RANGE', `Telemetry row ${rowIndex + 1} has invalid majflt.`, { row: rowIndex + 1, column: 'majflt' });
    }
    if (header.includes('dense_resident_frac') && (row.dense_resident_frac < 0 || row.dense_resident_frac > 1)) {
      return bigMoeTelemetryError('INVALID_ROW_RANGE', `Telemetry row ${rowIndex + 1} has invalid dense_resident_frac.`, { row: rowIndex + 1, column: 'dense_resident_frac' });
    }
    if (header.includes('turn') && (!Number.isSafeInteger(row.turn) || row.turn < 0)) {
      return bigMoeTelemetryError('INVALID_ROW_RANGE', `Telemetry row ${rowIndex + 1} has invalid turn.`, { row: rowIndex + 1, column: 'turn' });
    }
    const wallMs = row.wall_ms;
    const threads = Number(preamble.threads);
    const cpuMs = Number(row.cpu_ms || 0);
    if (header.includes('cpu_ms') && (!(threads > 0) || cpuMs > wallMs * threads)) {
      return bigMoeTelemetryError('INVALID_ROW_RANGE', `Telemetry row ${rowIndex + 1} has CPU occupancy outside 0-100%.`, { row: rowIndex + 1, column: 'cpu_ms' });
    }
    const overlap = Number(preamble.overlap || 0) === 1;
    tokens.push({
      step: row.step,
      steps: row.steps,
      wallMs,
      ioMs: row.io_ms,
      criticalFlashMs: overlap ? Number(row.stall_ms || 0) : row.io_ms,
      computeResidualMs: row.compute_ms,
      computeMeasured: false,
      managementMs: Number(row.mgmt_ms || 0),
      readBytes: row.read_bytes,
      readMiB: row.read_bytes / 1048576,
      cacheHitPct: row.cache_hit_pct,
      stallMs: Number(row.stall_ms || 0),
      majorFaults: Number(row.majflt || 0),
      cpuMs,
      cpuOccupancyPct: cpuMs > 0 && wallMs > 0 && threads > 0 ? cpuMs / (wallMs * threads) * 100 : null,
      denseResidentFraction: Number.isFinite(Number(row.dense_resident_frac)) && Number(row.dense_resident_frac) >= 0
        ? Number(row.dense_resident_frac)
        : null,
      turn: Number(row.turn || 0),
      loopOverheadMs: Number(row.loop_overhead_ms || 0),
      raw: row
    });
  }
  if (expectedSteps === null || tokens.length !== expectedSteps) {
    return bigMoeTelemetryError('INCOMPLETE_TELEMETRY', 'BigMoE telemetry row count must equal the declared steps.');
  }

  const instrumented = Number(preamble.compute_trace_layers || 0) > 0 || Number(preamble.predict_log || 0) === 1 || Number(preamble.prefetch_sync || 0) === 1;
  const stochastic = Number(preamble.temp || 0) > 0;
  const speculative = String(preamble.spec || 'off') !== 'off';
  const warnings = [];
  if (instrumented) warnings.push('Instrumented run: not benchmark-comparable.');
  if (stochastic) warnings.push('Stochastic run: not token-for-token reproducible.');
  if (speculative) warnings.push('Speculative run: do not pool with spec=off.');

  return {
    schemaVersion: 'bmoe_metrics/v2',
    preamble,
    summary,
    tokens,
    comparable: !instrumented && !stochastic && !speculative,
    warnings
  };
}
