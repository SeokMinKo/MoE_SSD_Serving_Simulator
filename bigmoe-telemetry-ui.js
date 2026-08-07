'use strict';

let bigMoeImportedTelemetry = null;
let bigMoeImportedEvidence = null;

function bigMoeTelemetryStatus(message, isError = false) {
  const status = $('bigMoeTelemetryStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function importBigMoeTelemetryFile(file) {
  if (!file) return;
  if (file.size > 16 * 1024 * 1024) {
    bigMoeTelemetryStatus('Telemetry CSV가 16 MiB 제한을 초과했습니다.', true);
    return;
  }
  try {
    const imported = parseBigMoeMetricsCsv(await file.text());
    if (imported.error) {
      bigMoeImportedTelemetry = null;
      bigMoeImportedEvidence = null;
      bigMoeTelemetryStatus(`${imported.errorCode}: ${imported.error}`, true);
      return;
    }
    const evidence = createBigMoeTelemetryEvidence(imported);
    bigMoeImportedTelemetry = imported;
    bigMoeImportedEvidence = evidence;
    const observed = evidence.observed;
    const boundary = evidence.eligible
      ? 'serial E2E/storage/cache/memory 보정 evidence로 사용 가능'
      : `보정 제외: ${evidence.reason}`;
    bigMoeTelemetryStatus(
      `${observed.tokenCount} tokens · ${fmt(observed.meanWallMs, 2)} ms/token · ` +
      `${fmt(observed.readMiBPerToken, 3)} MiB/token · ${fmt(observed.cacheHitPct, 2)}% hit · ${boundary}. ` +
      'compute_ms는 residual이며 Expert kernel 직접 시간으로 적용되지 않았습니다.'
    );
  } catch (error) {
    bigMoeImportedTelemetry = null;
    bigMoeImportedEvidence = null;
    bigMoeTelemetryStatus(`Telemetry import 실패: ${error?.message || error}`, true);
  }
}

function getBigMoeImportedEvidence() {
  return bigMoeImportedEvidence ? JSON.parse(JSON.stringify(bigMoeImportedEvidence)) : null;
}

function setupBigMoeTelemetryImporter() {
  const button = $('importBigMoeTelemetry');
  const input = $('importBigMoeTelemetryFile');
  if (!button || !input) return;
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    await importBigMoeTelemetryFile(input.files?.[0]);
    input.value = '';
  });
}

document.addEventListener('DOMContentLoaded', setupBigMoeTelemetryImporter);
