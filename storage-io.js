const STORAGE_IO_SERIES = Object.freeze([
  ['expertRead', 'Expert / window read'],
  ['prefetchRead', 'Prefetch read'],
  ['swapInRead', 'Swap-in read'],
  ['swapOutWrite', 'Swap-out write']
]);

function storageIOSeriesForKind(kind) {
  if (kind === 'expert-prefetch-read') return 'prefetchRead';
  if (kind === 'swap-in-read') return 'swapInRead';
  if (kind === 'swap-out-write') return 'swapOutWrite';
  if (kind === 'expert-demand-read' || kind === 'prefill-expert-read' || kind === 'afm-window-read') return 'expertRead';
  return String(kind || '').endsWith('-write') ? 'swapOutWrite' : 'expertRead';
}

function emptyStorageIOSeries() {
  return Object.fromEntries(STORAGE_IO_SERIES.map(([id]) => [id, 0]));
}

function storageIOMetric(event, yMode, elapsedMs) {
  if (yMode === 'service-ms') return event.service;
  if (yMode === 'queue-ms') return event.wait;
  if (yMode === 'gbps') return event.gb / Math.max(EPS, elapsedMs / 1000);
  return event.gb;
}

function buildStorageIOBuckets(result, options = {}) {
  if (!result || result.error || !Array.isArray(result.tokens)) return [];
  const xMode = ['token-index', 'completion-time', 'cumulative-io'].includes(options.xMode) ? options.xMode : 'token-index';
  const yMode = ['gb', 'gbps', 'service-ms', 'queue-ms'].includes(options.yMode) ? options.yMode : 'gb';
  const firstTokenMs = result.tokens[0]?.tpot || 0;
  const prefillElapsedMs = Math.max(EPS, (result.ttft || 0) - firstTokenMs);
  const sources = [
    { label: 'Prefill', events: result.prefillStorageEvents || [], elapsedMs: prefillElapsedMs },
    ...result.tokens.map((token, index) => ({ label: `Token ${index + 1}`, events: token.storageEvents || [], elapsedMs: Math.max(EPS, token.tpot || 0) }))
  ];
  let completionMs = prefillElapsedMs;
  let cumulativeGB = 0;
  return sources.map((source, index) => {
    if (index > 0) completionMs = index === 1 ? Number(result.ttft || source.elapsedMs) : completionMs + source.elapsedMs;
    const series = emptyStorageIOSeries();
    let bucketGB = 0;
    for (const event of source.events) {
      if (!event || !Number.isFinite(event.gb) || !Number.isFinite(event.service) || !Number.isFinite(event.wait)) continue;
      series[storageIOSeriesForKind(event.kind)] += storageIOMetric(event, yMode, source.elapsedMs);
      bucketGB += event.gb;
    }
    cumulativeGB += bucketGB;
    const x = xMode === 'completion-time' ? completionMs : xMode === 'cumulative-io' ? cumulativeGB : index;
    return { label: source.label, x, elapsedMs: source.elapsedMs, bucketGB, series };
  });
}

function storageIOXPositions(buckets, left, width) {
  if (!buckets.length) return [];
  const values = buckets.map(bucket => Number(bucket.x));
  const min = Math.min(...values), max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return buckets.map((_, index) => left + width * (index + 0.5) / buckets.length);
  return values.map(value => left + width * (value - min) / (max - min));
}
