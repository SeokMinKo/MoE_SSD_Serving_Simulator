# Device-calibrated Compute and Quantization — PR1/PR2 Contract

## Scope

This implementation adds the first two stages of the CPU/GPU and quantization plan for the Colibri engine.

- **PR1 core:** calibrated CPU/GPU profiles, manual or derived Expert payload size, fail-closed validation, and Legacy compatibility.
- **PR2 Colibri integration:** CPU-only, GPU-only, and Hybrid Expert execution; CPU/GPU compute-time composition; CPU-aware DRAM traffic; GPU-only PCIe traffic; and effective VRAM cache allocation.

The existing UI and Sweep catalog are intentionally unchanged. Those controls belong to the later UI/Sweep phase. Device-calibrated configurations can currently be supplied through programmatic simulation or reproducible scenario configuration.

## Compatibility contract

A configuration without `compute` and `quantization` uses the existing V1.6.2 path without transformed timing, payload, PCIe, DRAM, or cache values.

```js
{
  mode: 'colibri',
  // existing V1.6.2 fields
}
```

The device model is enabled only with `compute.mode = 'calibrated'`. Quantization payload derivation can be used independently by supplying `quantization`.

## Configuration

```js
{
  compute: {
    mode: 'calibrated',
    attentionDevice: 'gpu',       // cpu | gpu
    expertDevice: 'hybrid',       // cpu | gpu | hybrid
    cpu: {
      speedScale: 1,
      attentionMs: 60,
      expertMs: 2,
      parallelExperts: 8,
      prefillSpeedup: 2
    },
    gpu: {
      speedScale: 1,
      attentionMs: 28,
      expertMs: 0.7,
      parallelExperts: 4,
      prefillSpeedup: 4.5
    },
    hybrid: {
      cpuExpertFraction: 0.25,
      execution: 'parallel',      // parallel | sequential
      overlapEfficiency: 1        // 0 = exposed sum, 1 = full overlap
    }
  },
  quantization: {
    payloadMode: 'derived',       // manual | derived
    format: 'int4',
    weightBits: 4,
    packing: 1.08,
    expertParamsM: 35,
    manualExpertMB: 19,
    cpuKernelMultiplier: 1,
    gpuKernelMultiplier: 1
  }
}
```

## Payload calculation

Manual mode preserves an explicitly calibrated Expert payload.

```text
Expert MB = manualExpertMB
```

Derived mode calculates decimal megabytes from one Expert's parameter count.

```text
Expert MB = expertParamsM × weightBits / 8 × packing
```

The existing Colibri 1.03 cache-packing overhead remains applied after this payload calculation. Quantization bit width does **not** automatically infer a faster CPU or GPU kernel. Kernel behavior is supplied independently through `cpuKernelMultiplier` and `gpuKernelMultiplier`.

## Compute calculation

For each device:

```text
effective attention time = calibrated attentionMs × kernel multiplier / speedScale
effective Expert time    = calibrated expertMs × kernel multiplier / speedScale
Expert phase             = ceil(active Experts / parallelExperts) × effective Expert time
```

Hybrid active Experts are split deterministically by rounding `active × cpuExpertFraction`.

Sequential Hybrid execution exposes the sum of CPU and GPU Expert phases.

```text
Hybrid Expert phase = CPU phase + GPU phase
```

Parallel Hybrid execution interpolates between the slower phase and the full sum.

```text
Hybrid Expert phase = max(CPU, GPU) + (1 - overlapEfficiency) × min(CPU, GPU)
```

The resulting phase is mapped into the existing Colibri analytic timeline, preserving the existing fixed per-layer calibration and prefill structure.

## Data-path behavior

### Discrete GPU

- GPU-routed Expert bytes contribute to PCIe traffic.
- CPU-routed Expert bytes do not contribute to PCIe traffic.
- CPU-routed active weights contribute to Host DRAM traffic.
- Effective VRAM Expert cache is scaled by the GPU-routed Expert fraction.
- The requested physical VRAM cache and effective modeled cache are both retained in `placementInfo`.

### Unified memory

- PCIe traffic remains zero.
- CPU and GPU routes share the existing unified DRAM roofline.

## Result provenance

Calibrated results expose:

- `result.computeProfile`
- `result.quantizationProfile`
- `token.computeBreakdown`
- `result.c.__deviceCompute`
- `result.c.placementInfo.requestedVcacheGB`
- `result.c.placementInfo.effectiveVcacheGB`

The profile is deterministically regenerated when relevant configuration values change. Internal normalized timing values are not treated as a cache of the user's previous settings.

## Validation

The model rejects invalid enums, non-finite values, zero or negative speed scales, invalid parallelism, invalid bit width and packing, missing derived parameter counts, and Hybrid fractions outside `[0, 1]`.

Regression coverage includes:

- unchanged Legacy Colibri summaries;
- linear 8-bit to 4-bit payload and SSD-I/O scaling;
- zero Expert PCIe traffic for CPU-only execution;
- compute-bound sensitivity to GPU speed scale;
- Hybrid endpoint equivalence with CPU-only and GPU-only modes;
- parallel versus sequential Hybrid ordering;
- idempotent auto-placement;
- fail-closed invalid input handling.

## Current limitations

- CPU and GPU use an aggregate per-token phase, not separate scheduler resources. Independent CPU/GPU serving contention is deferred to PR3.
- Hybrid routing uses an active-Expert fraction rather than a persistent per-Expert device-placement map.
- The scaled VRAM cache is an aggregate sensitivity approximation, not a page-level or Expert-identity placement simulator.
- Kernel multipliers and speed scales require measured or explicitly assumed calibration.
- Dequantization is represented through kernel multipliers; a separate dequantization resource is deferred.
- UI fields, Sweep descriptors, Advisor rendering, and V5 artifact migration are deferred to the later UI/artifact phase.
