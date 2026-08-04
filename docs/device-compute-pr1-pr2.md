# Device-calibrated Compute and Quantization — PR1/PR2 Contract

## Scope

This change adds calibrated CPU/GPU compute and quantized Expert payload modeling to the Colibri engine while preserving the existing V1.6.2 Legacy path.

- **PR1:** CPU/GPU calibration profiles, manual or derived Expert payload size, fail-closed validation, and Legacy compatibility.
- **PR2:** CPU Attention, GPU Attention, CPU-only/GPU-only/Hybrid Expert execution, persistent Expert placement, device-aware KV placement, and CPU/GPU data paths integrated into the Prefill and Decode timelines.

The browser form and Sweep catalog remain unchanged in this PR. Calibrated configurations are currently supplied through programmatic or scenario configuration.

## Compatibility

A Colibri configuration without `compute` and `quantization` follows the existing V1.6.2 equations and trace behavior.

```js
{
  mode: 'colibri'
  // existing V1.6.2 fields
}
```

The calibrated path is enabled only with:

```js
compute: { mode: 'calibrated', ... }
```

The device-specific contract is identified by `device-compute/v2`. The repository keeps the existing `moe-ssd-sim/v4` artifact envelope and V1.6.2 package/model identity during this incremental PR; build commit, Run ID, explicit `compute`/`quantization` configuration, and the device-compute schema preserve reproducibility.

## Configuration

```js
{
  compute: {
    mode: 'calibrated',
    attentionDevice: 'cpu',       // cpu | gpu
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
      overlapEfficiency: 1        // 0 = exposed sum, 1 = full compute overlap
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

## Quantized payload

Manual mode uses an explicitly calibrated Expert payload:

```text
Expert MB = manualExpertMB
```

Derived mode uses decimal SI units:

```text
Expert MB = expertParamsM × weightBits / 8 × packing
```

The existing Colibri 1.03 cache-packing overhead is applied after the payload calculation. Bit width does not infer kernel speed. CPU and GPU Expert-kernel behavior remains an explicit calibration through the corresponding multiplier. Expert multipliers do not modify Attention timing.

## Popularity-aware persistent Hybrid placement

Hybrid mode no longer scales all bytes by an aggregate fraction. Expert IDs already follow the simulator's Zipf popularity order, so the configured GPU share is assigned to the lowest, hottest Expert IDs and the remaining colder IDs are assigned to CPU.

Consequences:

- The same Expert keeps the same device assignment across layers, tokens, serving replay, and artifact replay.
- Hot Experts are preferentially GPU-resident; cold Experts are CPU-resident.
- Only GPU-assigned Experts can enter the VRAM Expert cache.
- Only GPU-assigned Host sources produce PCIe Expert traffic.
- CPU-assigned active Experts produce Host DRAM traffic.
- Manual `vcache` remains the explicit physical VRAM budget.
- Auto Placement caps `vcache` at the total GPU-assigned Expert pool, avoiding unused reservation that would unnecessarily reduce GPU KV capacity.

The requested CPU fraction is an Expert-count placement target. The observed activation fraction can differ because routing popularity is non-uniform; the result reports both target and actual fractions.

## Compute equations

For each device:

```text
effective Attention time = attentionMs / speedScale
effective Expert time    = expertMs × Expert kernel multiplier / speedScale
Expert phase             = ceil(active Experts on device / parallelExperts)
                           × effective Expert time
```

Sequential Hybrid:

```text
Hybrid Expert phase = CPU phase + GPU phase
```

Parallel Hybrid:

```text
Hybrid Expert phase = max(CPU, GPU)
                    + (1 - overlapEfficiency) × min(CPU, GPU)
```

Attention and Expert Prefill speedups are applied independently to their owning devices. CPU Attention no longer inherits GPU Expert Prefill speedup, and vice versa.

## Data paths

### Discrete GPU — GPU Attention

```text
KV: VRAM first, Host overflow
GPU Expert: SSD/Host cache → PCIe → VRAM → GPU compute
CPU Expert: SSD/Host cache → Host DRAM → CPU compute
```

### Discrete GPU — CPU Attention

```text
KV: Host DRAM
Dense/resident Attention weights: Host DRAM
GPU Expert: SSD/Host cache → PCIe → VRAM → GPU compute
CPU Expert: SSD/Host cache → Host DRAM → CPU compute
```

A discrete CPU-only configuration reserves no GPU workspace and can use `vram = 0`. Profiles that use GPU compute retain the simulator's existing simplified 0.8 GB runtime reserve.

### Unified memory

CPU and GPU phases share the existing unified DRAM roofline and have no PCIe stage.

## Timeline integration

The calibrated path performs device accounting inside the Colibri timeline instead of modifying TPOT after simulation:

```text
Layer start
→ demand/prefetch storage readiness
→ GPU-only PCIe transfer
→ CPU/GPU compute composition
→ per-layer DRAM roofline
→ layer completion
→ next layer
```

This means additional CPU DRAM time advances subsequent layers and tokens and therefore affects prefetch timeliness, queue timing, swap completion, and observed bandwidth consistently. KV compression/decompression CPU time is charged once at the point where it occurs; reporting totals do not add that elapsed time a second time.

Prefill independently calculates:

- device-specific Attention compute;
- CPU/GPU Expert compute;
- GPU Expert PCIe bytes;
- CPU Expert active-weight DRAM bytes;
- CPU Attention resident and KV DRAM bytes.

## Artifact and replay

Artifacts persist only external configuration fields. No internal normalized profile or placement cache is exported.

Allowed calibrated fields:

- `compute`
- `quantization`

The parser validates these fields, recalculates placement and timing, and verifies Run ID, result summary, Advisor insight, and replay result against the same build.

## Validation coverage

The dedicated tests use non-zero Prompt, KV, resident weights, DRAM traffic, PCIe traffic, and storage service. They cover:

- Legacy equivalence;
- linear 8-bit/4-bit payload and I/O scaling without inferred kernel speed;
- Expert multiplier isolation from Attention timing;
- CPU Attention KV placement and Host DRAM traffic;
- CPU-only Expert PCIe traffic equal to zero and zero-VRAM execution;
- compute-bound sensitivity to GPU speed scale;
- deterministic popularity-aware Hybrid assignment;
- VRAM cache containing GPU-assigned Experts only;
- warm VRAM cache filling every GPU Expert that fits;
- Auto Placement VRAM cache capped by the GPU Expert pool;
- full physical Manual VRAM cache budget and Hybrid PCIe bounded by CPU/GPU endpoints;
- independent CPU Attention Prefill calibration;
- CPU Expert DRAM pressure inside the token timeline;
- compression CPU cost charged once;
- parallel/sequential Hybrid ordering;
- calibrated artifact Export → Import → Replay;
- fail-closed invalid input handling.

## Remaining limitations

- CPU and GPU are composed inside each analytic layer phase but do not yet use independent multi-request scheduler resources. Cross-request CPU/GPU contention is deferred to PR3.
- Popularity-aware placement is static and is not dynamically retrained from measured traces.
- GPU-resident dense Attention weights and explicit dense-weight PCIe loading remain part of the existing `resident` calibration rather than a separate cache.
- Dequantization is represented through calibrated Expert-kernel multipliers; a separate dequant resource is deferred.
- UI controls, Sweep descriptors, Advisor CPU/GPU sub-scores, and a future V5 artifact redesign remain later phases.
