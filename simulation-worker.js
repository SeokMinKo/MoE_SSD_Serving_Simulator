'use strict';

importScripts(
  'build-info.js',
  'core.js',
  'presets.js',
  'config.js',
  'memory.js',
  'colibri.js',
  'afm.js',
  'serving.js',
  'advisor.js',
  'sweep.js'
);

self.onmessage = event => {
  try {
    const result = runSimulationConfig(sweepClone(event.data.config));
    self.postMessage({
      config: sweepClone(result.c || event.data.config),
      metrics: summarizeSweepResult(result),
      runId: result.runId || null
    });
  } catch (error) {
    self.postMessage({ error: String(error?.message || error) });
  }
};
