'use strict';

const REPLAY_RESULT_MAX_BYTES = 4_000_000;
const replayEncoder = new TextEncoder();

function boundedJsonBytes(value, limit, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean') return value === null ? 4 : (value ? 4 : 5);
  if (typeof value === 'number') return replayEncoder.encode(JSON.stringify(value)).byteLength;
  if (typeof value === 'string') return replayEncoder.encode(JSON.stringify(value)).byteLength;
  if (typeof value !== 'object') return 4;
  if (value instanceof Map || value instanceof Set) throw new Error('Scenario replay envelope contains an unsupported collection.');
  if (seen.has(value)) throw new Error('Scenario replay result contains a cyclic value.');
  seen.add(value);
  let bytes = 2;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  for (let index = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    if (index) bytes += 1;
    if (!Array.isArray(value)) bytes += replayEncoder.encode(JSON.stringify(key)).byteLength + 1;
    bytes += boundedJsonBytes(item, limit - bytes, seen);
    if (bytes > limit) break;
  }
  seen.delete(value);
  return bytes;
}

importScripts(
  'build-info.js',
  'core.js',
  'compute.js',
  'presets.js',
  'config.js',
  'compute-placement.js',
  'memory.js',
  'colibri.js',
  'afm.js',
  'serving.js',
  'advisor.js',
  'sweep.js',
  'repro.js'
);

installDevicePlacementModel();
installDeviceArtifactModel();

self.onmessage = event => {
  try {
    const { artifact, replayResult } = parseScenarioArtifactReplay(event.data);
    const compactResult = compactReplayResultForUI(replayResult);
    const envelope = { artifact, replayResult: compactResult };
    const replayBytes = boundedJsonBytes(envelope, REPLAY_RESULT_MAX_BYTES);
    if (replayBytes > REPLAY_RESULT_MAX_BYTES) throw new Error('Scenario replay envelope exceeds the 4MB UI transfer budget.');
    self.postMessage(envelope);
  } catch (error) {
    self.postMessage({ error: String(error?.message || error) });
  }
};
