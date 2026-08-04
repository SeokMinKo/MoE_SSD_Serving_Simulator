'use strict';

const DEVICE_PLACEMENT_SCHEMA = 'device-placement/v1';

function installDevicePlacementModel() {
  if (globalThis.__DEVICE_PLACEMENT_INSTALLED__) return false;
  if (typeof applyColibriPlacement !== 'function' || typeof deriveColibriDeviceProfile !== 'function') return false;
  const legacyApplyColibriPlacement = applyColibriPlacement;
  applyColibriPlacement = function deviceAwareColibriPlacement(input) {
    const placed = legacyApplyColibriPlacement(input);
    if (!input || input.mode !== 'colibri' || input.placement !== 'auto' || placed.arch !== 'discrete') return placed;
    const profile = deriveColibriDeviceProfile(input);
    if (profile.mode !== 'calibrated' || !profile.usesGpu) return placed;
    const gpuPoolFraction = typeof colibriGpuExpertPoolFraction === 'function'
      ? colibriGpuExpertPoolFraction(profile)
      : profile.targetGpuExpertFraction;
    const gpuExpertPoolGB = Math.max(0, (placed.placementInfo?.expertPoolGB || 0) * gpuPoolFraction);
    placed.vcache = Math.min(placed.vcache, gpuExpertPoolGB);
    if (placed.placementInfo) placed.placementInfo.vcacheGB = placed.vcache;
    return placed;
  };
  globalThis.__DEVICE_PLACEMENT_INSTALLED__ = Object.freeze({ schema: DEVICE_PLACEMENT_SCHEMA });
  return true;
}

function scheduleDevicePlacementInstall() {
  if (installDevicePlacementModel()) return true;
  if (typeof document !== 'object' || typeof document.addEventListener !== 'function') return false;
  const install = () => installDevicePlacementModel();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else Promise.resolve().then(install);
  return true;
}

scheduleDevicePlacementInstall();
