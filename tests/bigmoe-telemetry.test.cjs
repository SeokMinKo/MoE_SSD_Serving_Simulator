'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadTelemetry() {
  const source = fs.readFileSync(path.join(root, 'bigmoe-telemetry.js'), 'utf8') +
    '\nglobalThis.__telemetry = { parseBigMoeMetricsCsv, createBigMoeTelemetryEvidence };';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'bigmoe-telemetry.js' });
  return sandbox.__telemetry;
}

const csv = `# bmoe_metrics v2
# engine=bigmoe-test
# model=qwen.gguf arch=qwen3moe n_layer=48 n_expert=128 n_expert_used=8 threads=4 n_ctx=4096 n_ubatch=512 chatml=1
# moe_stream=1 cache_mb=4000 cache_auto=0 cache_floor_mb=0 cache_ceil_mb=4000 force_cache=1 load_all=0 io_threads=4 o_direct=1 overlap=0 io_two_wave=0 prefetch=0 route_ahead=0 predict_prefetch=0 predict_log=0 predict_spec_max=0 prefetch_sync=0 dense_weights=anon drop_cold_frac=0 drop_renorm=0 drop_prefill=0
# temp=0 top_k=1 top_p=1 seed=7 compute_trace_layers=0 spec=off spec_draft_max=0 mtp_p_min=0 ngram_min_match=0
step,steps,wall_ms,io_ms,compute_ms,read_bytes,cache_hit_pct,stall_ms,mgmt_ms,majflt,cpu_ms,dense_resident_frac,turn,loop_overhead_ms
1,2,300,100,180,1048576,50,0,20,3,800,0.9,0,5
2,2,250,50,190,524288,75,0,10,0,700,0.85,0,4
# summary tok/s=3.636 read_MiB=1.5 cache_hit_pct=62.5
`;

test('BigMoE telemetry importer maps v2 rows by name without treating residual compute as kernel timing', () => {
  const { parseBigMoeMetricsCsv } = loadTelemetry();
  const imported = parseBigMoeMetricsCsv(csv);

  assert.equal(imported.error, undefined);
  assert.equal(imported.schemaVersion, 'bmoe_metrics/v2');
  assert.equal(imported.preamble.engine, 'bigmoe-test');
  assert.equal(imported.preamble.io_threads, 4);
  assert.equal(imported.preamble.overlap, 0);
  assert.equal(imported.tokens.length, 2);
  assert.equal(imported.tokens[0].readMiB, 1);
  assert.equal(imported.tokens[0].criticalFlashMs, 100);
  assert.equal(imported.tokens[0].computeResidualMs, 180);
  assert.equal(imported.tokens[0].computeMeasured, false);
  assert.equal(imported.tokens[0].cpuOccupancyPct, 800 / (300 * 4) * 100);
  assert.equal(imported.tokens[0].majorFaults, 3);
  assert.equal(imported.tokens[0].loopOverheadMs, 5);
  assert.equal(imported.summary['tok/s'], 3.636);
});

test('BigMoE telemetry evidence calibrates observable E2E terms but never direct Expert kernel time', () => {
  const { parseBigMoeMetricsCsv, createBigMoeTelemetryEvidence } = loadTelemetry();
  const evidence = createBigMoeTelemetryEvidence(parseBigMoeMetricsCsv(csv));

  assert.equal(evidence.eligible, true);
  assert.equal(evidence.measured, true);
  assert.equal(evidence.computeIsResidual, true);
  assert.equal(evidence.directExpertMs, null);
  assert.deepEqual(Array.from(evidence.allowedTargets), ['endToEnd', 'storage', 'cache', 'memory']);
  assert.equal(evidence.observed.tokenCount, 2);
  assert.equal(evidence.observed.meanWallMs, 275);
  assert.equal(evidence.observed.meanCriticalFlashMs, 75);
  assert.equal(evidence.observed.readMiBPerToken, 0.75);
  assert.equal(evidence.observed.cacheHitPct, 62.5);
  assert.equal(evidence.observed.majorFaultsPerToken, 1.5);
});

test('BigMoE telemetry parser rejects missing identity, duplicate headers, impossible ranges, and discontinuous rows', () => {
  const { parseBigMoeMetricsCsv } = loadTelemetry();
  const schema = '# bmoe_metrics v2';
  const identity = `${schema}\n# engine=test-engine\n# model=tiny.gguf arch=tiny-moe threads=4 overlap=0 compute_trace_layers=0 predict_log=0 prefetch_sync=0 temp=0 spec=off`;
  const header = 'step,steps,wall_ms,io_ms,compute_ms,read_bytes,cache_hit_pct,mgmt_ms';
  const cases = [
    ['missing identity', `${schema}\n${header}\n1,1,10,2,8,1024,50,1`],
    ['duplicate header', `${identity}\nstep,step,steps,wall_ms,io_ms,compute_ms,read_bytes,cache_hit_pct\n1,1,1,10,2,8,1024,50`],
    ['discontinuous step', `${identity}\n${header}\n2,1,10,2,8,1024,50,1`],
    ['missing row', `${identity}\n${header}\n1,2,10,2,8,1024,50,1`],
    ['cache above 100', `${identity}\n${header}\n1,1,10,2,8,1024,101,1`],
    ['negative wall', `${identity}\n${header}\n1,1,-1,2,8,1024,50,1`],
    ['negative bytes', `${identity}\n${header}\n1,1,10,2,8,-1,50,1`],
    ['malformed optional numeric', `${identity}\n${header}\n1,1,10,2,8,1024,50,bad`],
    ['CPU occupancy above 100', `${identity}\n${header},cpu_ms\n1,1,10,2,8,1024,50,1,41`]
  ];
  for (const [label, csv] of cases) {
    const result = parseBigMoeMetricsCsv(csv);
    assert.equal(typeof result.error, 'string', label);
    assert.equal(typeof result.errorCode, 'string', label);
  }
});

test('BigMoE telemetry parser rejects duplicate and malformed comparability metadata', () => {
  const { parseBigMoeMetricsCsv, createBigMoeTelemetryEvidence } = loadTelemetry();
  const header = 'step,steps,wall_ms,io_ms,compute_ms,read_bytes,cache_hit_pct';
  const row = '1,1,10,2,8,1024,50';
  const base = '# bmoe_metrics v2\n# engine=e model=m arch=qwen3moe threads=4 overlap=0 compute_trace_layers=0 predict_log=0 prefetch_sync=0 temp=0 spec=off';
  const cases = [
    ['duplicate engine', `${base}\n# engine=second\n${header}\n${row}`],
    ['duplicate overlap', `${base} overlap=1\n${header}\n${row}`],
    ['malformed overlap', `${base.replace('overlap=0', 'overlap=banana')}\n${header}\n${row}`],
    ['malformed instrumentation', `${base.replace('compute_trace_layers=0', 'compute_trace_layers=banana')}\n${header}\n${row}`],
    ['unsupported architecture', `${base.replace('arch=qwen3moe', 'arch=fabricated-arch')}\n${header}\n${row}`]
  ];
  for (const [label, text] of cases) {
    const parsed = parseBigMoeMetricsCsv(text);
    assert.equal(typeof parsed.error, 'string', label);
    assert.equal(createBigMoeTelemetryEvidence(parsed).eligible, false, label);
  }
});

test('BigMoE telemetry parser applies direct-call byte and row budgets', () => {
  const { parseBigMoeMetricsCsv } = loadTelemetry();
  const oversized = parseBigMoeMetricsCsv('# bmoe_metrics v2\n' + 'x'.repeat(16 * 1024 * 1024));
  assert.equal(oversized.errorCode, 'TELEMETRY_TOO_LARGE');
  const tooManyRows = parseBigMoeMetricsCsv('# bmoe_metrics v2\n# engine=e\n# model=m arch=qwen3moe threads=4 overlap=0 compute_trace_layers=0 predict_log=0 prefetch_sync=0 temp=0 spec=off\nstep,steps,wall_ms,io_ms,compute_ms,read_bytes,cache_hit_pct\n1,100001,1,0,1,0,0');
  assert.equal(tooManyRows.errorCode, 'TELEMETRY_TOO_LARGE');
  const utf8Oversized = parseBigMoeMetricsCsv('# bmoe_metrics v2\n' + '가'.repeat(6 * 1024 * 1024));
  assert.equal(utf8Oversized.errorCode, 'TELEMETRY_TOO_LARGE');
});

test('BigMoE browser entry exposes a telemetry file importer without automatic config mutation', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'bigmoe-telemetry-ui.js'), 'utf8');

  assert.match(html, /id="importBigMoeTelemetry"/);
  assert.match(html, /id="importBigMoeTelemetryFile"[^>]*accept="\.csv,text\/csv"/);
  assert.match(html, /id="bigMoeTelemetryStatus"[^>]*aria-live="polite"/);
  assert.match(html, /<script src="bigmoe-telemetry\.js"><\/script>[\s\S]*<script src="bigmoe-telemetry-ui\.js"><\/script>/);
  assert.match(ui, /parseBigMoeMetricsCsv/);
  assert.match(ui, /createBigMoeTelemetryEvidence/);
  assert.match(ui, /function getBigMoeImportedEvidence/);
  assert.doesNotMatch(ui, /readBigMoeEdge\(\)[\s\S]*=/);
  const repro = fs.readFileSync(path.join(root, 'repro.js'), 'utf8');
  assert.match(repro, /getBigMoeImportedEvidence/);
  assert.match(repro, /createScenarioArtifact\(result\.c, result, null, artifact\.telemetryEvidence\)/);
});
