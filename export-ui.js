(function (root) {
  'use strict';

  const COPYABLE_TABLE_IDS = new Set([
    'summary', 'pressureSummary', 'memory', 'comparisonSummary',
    'traceSummary', 'storageTraceSummary', 'sweepResults'
  ]);
  let copyObserver = null;

  function escapeMarkdownCell(value) {
    return String(value ?? '')
      .replace(/\r?\n+/g, '<br>')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .trim();
  }

  function tableGrid(table) {
    const grid = [];
    Array.from(table?.rows || []).forEach((row, rowIndex) => {
      grid[rowIndex] ||= [];
      let columnIndex = 0;
      Array.from(row.cells || []).forEach(cell => {
        while (grid[rowIndex][columnIndex] !== undefined) columnIndex += 1;
        const value = escapeMarkdownCell(cell.innerText || cell.textContent || '');
        const rowSpan = Math.max(1, Number(cell.rowSpan) || 1);
        const columnSpan = Math.max(1, Number(cell.colSpan) || 1);
        for (let y = 0; y < rowSpan; y += 1) {
          grid[rowIndex + y] ||= [];
          for (let x = 0; x < columnSpan; x += 1) {
            grid[rowIndex + y][columnIndex + x] = y === 0 && x === 0 ? value : '';
          }
        }
        columnIndex += columnSpan;
      });
    });
    const width = Math.max(0, ...grid.map(row => row.length));
    return grid.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
  }

  function tableToMarkdown(table) {
    const grid = tableGrid(table);
    if (!grid.length || !grid[0].length) throw new Error('복사할 표 데이터가 없습니다.');
    const header = grid[0];
    const body = grid.slice(1);
    const line = row => `| ${row.join(' | ')} |`;
    return [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n');
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('이 브라우저에서는 그래프 이미지 변환을 지원하지 않습니다.'));
        return;
      }
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('그래프 이미지 생성에 실패했습니다.')), 'image/png');
    });
  }

  function safeFilename(value) {
    const normalized = String(value || 'graph')
      .normalize('NFKC')
      .replace(/[^0-9A-Za-z가-힣._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${normalized || 'graph'}.png`;
  }

  async function copyText(text, navigatorObject = root.navigator) {
    if (!navigatorObject?.clipboard?.writeText) throw new Error('클립보드 텍스트 복사를 지원하지 않는 브라우저입니다.');
    await navigatorObject.clipboard.writeText(text);
  }

  async function copyCanvasImage(canvas, navigatorObject = root.navigator, ClipboardItemClass = root.ClipboardItem) {
    if (!navigatorObject?.clipboard?.write || typeof ClipboardItemClass !== 'function') {
      throw new Error('이미지 클립보드 복사를 지원하지 않습니다. PNG 저장을 이용해 주세요.');
    }
    const blob = await canvasToBlob(canvas);
    await navigatorObject.clipboard.write([new ClipboardItemClass({ 'image/png': blob })]);
  }

  async function downloadCanvasImage(canvas, filename, documentObject = root.document) {
    const blob = await canvasToBlob(canvas);
    const url = root.URL.createObjectURL(blob);
    const link = documentObject.createElement('a');
    link.href = url;
    link.download = safeFilename(filename);
    link.click();
    root.URL.revokeObjectURL(url);
  }

  function announce(message, isError = false) {
    const status = root.document?.getElementById('copyStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('copyError', isError);
  }

  function actionButton(label, action) {
    const button = root.document.createElement('button');
    button.type = 'button';
    button.className = 'copyAction';
    button.textContent = label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action(); } catch (error) { announce(error?.message || '복사 작업에 실패했습니다.', true); }
      finally { button.disabled = false; }
    });
    return button;
  }

  function labelForElement(element, fallback) {
    const section = element.closest('section');
    return section?.querySelector('h2,h3')?.textContent?.trim() || element.getAttribute('aria-label') || fallback;
  }

  function decorateCanvas(canvas) {
    if (canvas.dataset.copyReady === 'true') return;
    canvas.dataset.copyReady = 'true';
    const title = labelForElement(canvas, canvas.id || 'graph');
    const toolbar = root.document.createElement('div');
    toolbar.className = 'copyToolbar';
    toolbar.setAttribute('aria-label', `${title} 내보내기`);
    toolbar.append(
      actionButton('그래프 이미지 복사', async () => {
        await copyCanvasImage(canvas);
        announce(`${title} 그래프를 이미지로 복사했습니다.`);
      }),
      actionButton('PNG 저장', async () => {
        await downloadCanvasImage(canvas, title);
        announce(`${title} 그래프를 PNG로 저장했습니다.`);
      })
    );
    canvas.before(toolbar);
  }

  function decorateTable(table) {
    if (table.dataset.copyReady === 'true') return;
    table.dataset.copyReady = 'true';
    const title = labelForElement(table, table.id || 'table');
    const toolbar = root.document.createElement('div');
    toolbar.className = 'copyToolbar tableCopyToolbar';
    toolbar.setAttribute('aria-label', `${title} 내보내기`);
    toolbar.append(actionButton('Markdown 표 복사', async () => {
      await copyText(tableToMarkdown(table));
      announce(`${title} 표를 Markdown으로 복사했습니다.`);
    }));
    table.before(toolbar);
  }

  function initializeCopyTools() {
    if (!root.document?.querySelectorAll) return;
    root.document.querySelectorAll('canvas').forEach(decorateCanvas);
    root.document.querySelectorAll('table').forEach(table => {
      if (COPYABLE_TABLE_IDS.has(table.id)) decorateTable(table);
    });
  }

  function observeCopyTargets(MutationObserverClass = root.MutationObserver) {
    if (copyObserver || !root.document?.documentElement || typeof MutationObserverClass !== 'function') return false;
    copyObserver = new MutationObserverClass(records => {
      const hasNewElement = records.some(record => Array.from(record.addedNodes || []).some(node => node?.nodeType === 1));
      if (hasNewElement) initializeCopyTools();
    });
    copyObserver.observe(root.document.documentElement, { childList: true, subtree: true });
    return true;
  }

  function startCopyTools() {
    initializeCopyTools();
    observeCopyTargets();
  }

  const api = { escapeMarkdownCell, tableGrid, tableToMarkdown, canvasToBlob, safeFilename, copyText, copyCanvasImage, initializeCopyTools, observeCopyTargets };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MoeExportUI = api;
  if (root.document?.addEventListener) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', startCopyTools, { once: true });
    else startCopyTools();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
