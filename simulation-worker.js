'use strict';

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
  'serving-device.js',
  'advisor.js',
  'sweep.js',
  'device-experience.js'
);

installDevicePlacementModel();
installDeviceServingScheduler();
installDeviceExperienceModel();

self.onmessage = event => {
  try {
    const result = runSimulationConfig(sweepClone(event.data.config));
    if (result.error) {
      self.postMessage({ error: String(result.error) });
      return;
    }
    self.postMessage({
      config: sweepClone(result.c || event.data.config),
      metrics: summarizeSweepResult(result),
      runId: result.runId || null
    });
  } catch (error) {
    self.postMessage({ error: String(error?.message || error) });
  }
};
