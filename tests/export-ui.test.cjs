const test = require('node:test');
const assert = require('node:assert/strict');
const { tableToMarkdown, safeFilename, copyCanvasImage } = require('../export-ui.js');

function cell(text, rowSpan = 1, colSpan = 1) {
  return { innerText: text, textContent: text, rowSpan, colSpan };
}

test('REQ-002: table exports GitHub-compatible Markdown and escapes pipes', () => {
  const table = { rows: [
    { cells: [cell('항목'), cell('값')] },
    { cells: [cell('SSD | NAND'), cell('9.2 GB/s')] },
    { cells: [cell('두 줄\n설명'), cell('정상')] }
  ] };
  assert.equal(tableToMarkdown(table), [
    '| 항목 | 값 |',
    '| --- | --- |',
    '| SSD \\| NAND | 9.2 GB/s |',
    '| 두 줄<br>설명 | 정상 |'
  ].join('\n'));
});

test('REQ-002: merged cells keep a rectangular Markdown grid', () => {
  const table = { rows: [
    { cells: [cell('구분', 2), cell('성능', 1, 2)] },
    { cells: [cell('TTFT'), cell('TPS')] },
    { cells: [cell('기본'), cell('10 ms'), cell('20')] }
  ] };
  assert.equal(tableToMarkdown(table), [
    '| 구분 | 성능 |  |',
    '| --- | --- | --- |',
    '|  | TTFT | TPS |',
    '| 기본 | 10 ms | 20 |'
  ].join('\n'));
});

test('REQ-002: graph filename is safe and clipboard fallback is actionable', async () => {
  assert.equal(safeFilename('Memory / Swap trace'), 'Memory-Swap-trace.png');
  await assert.rejects(() => copyCanvasImage({}, {}, undefined), /PNG 저장/);
});
