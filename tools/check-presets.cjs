'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const csvPath = path.join(root, 'data', 'moe_model_trend_with_layers_2026-07-21.csv');
const presetPath = path.join(root, 'presets.js');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV ends inside a quoted field.');
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift();
  assert.ok(headers?.length, 'CSV header is required.');
  return rows.filter(candidate => candidate.some(value => value !== '')).map((values, rowIndex) => {
    assert.equal(values.length, headers.length, `CSV row ${rowIndex + 2} has the wrong column count.`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function readPresets() {
  const context = {};
  const source = fs.readFileSync(presetPath, 'utf8') + '\nglobalThis.__presets = MOE_MODEL_PRESETS;';
  vm.runInNewContext(source, context, { filename: presetPath });
  return JSON.parse(JSON.stringify(context.__presets));
}

function numeric(value) {
  if (value === '') return null;
  const parsed = Number(value);
  assert.equal(Number.isFinite(parsed), true, `Expected a finite number, received ${value}.`);
  return parsed;
}

const csvBytes = fs.readFileSync(csvPath);
assert.equal(
  crypto.createHash('sha256').update(csvBytes).digest('hex'),
  '5c391ed51b6226fc1806d876fbd4d7cb3d569475d83472af71cb7d22c00d47cb',
  'Repository CSV differs from the supplied source artifact.'
);
const rows = parseCsv(csvBytes.toString('utf8'));
const eligible = rows.filter(row => ['moe_layers', 'routed_experts_per_moe_layer', 'topk_routed_per_moe_layer']
  .every(key => row[key] !== ''));
const presets = readPresets();
const fields = {
  releaseDate: 'release_date',
  family: 'family',
  model: 'model',
  totalParamsB: 'total_params_B',
  activeParamsB: 'active_params_B',
  transformerLayers: 'transformer_layers',
  layers: 'moe_layers',
  denseLayers: 'dense_ffn_layers',
  experts: 'routed_experts_per_moe_layer',
  active: 'topk_routed_per_moe_layer',
  sharedExperts: 'shared_experts',
  layerScheduleNotes: 'layer_schedule_notes',
  disclosureStatus: 'disclosure_status'
};
const numericFields = new Set([
  'totalParamsB', 'activeParamsB', 'transformerLayers', 'layers', 'denseLayers', 'experts', 'active', 'sharedExperts'
]);

assert.equal(rows.length, 31, 'The repository CSV must retain all 31 supplied rows.');
assert.equal(eligible.length, 28, 'Exactly 28 rows must have complete routed topology.');
assert.equal(presets.length, eligible.length, 'Preset count must match eligible CSV rows.');

for (let index = 0; index < eligible.length; index++) {
  const row = eligible[index];
  const preset = presets[index];
  for (const [presetField, csvField] of Object.entries(fields)) {
    const expected = numericFields.has(presetField) ? numeric(row[csvField]) : row[csvField];
    assert.deepEqual(preset[presetField], expected, `${row.model}: ${presetField} differs from CSV.`);
  }
  const sourceUrl = row.layer_source_url || row.source_config || row.source_model_card;
  assert.equal(preset.sourceUrl, sourceUrl, `${row.model}: sourceUrl differs from CSV.`);
}

const excluded = rows.filter(row => !eligible.includes(row)).map(row => row.model);
assert.deepEqual(excluded, ['Qwen3.7-Max', 'Kimi K3', 'Qwen3.8-Max-Preview']);
console.log(`Preset provenance checked: ${rows.length} CSV rows, ${presets.length} eligible presets, 0 mismatches.`);
