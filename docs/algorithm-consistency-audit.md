# Algorithm Consistency Audit

## Overall assessment

**Current status: Alpha / conceptual simulator**

The initial simulator is useful for architecture explanation and limited sensitivity analysis, but it should not yet be used for absolute TTFT, TPOT, TPS, concurrent throughput, or hardware-product comparisons.

## Critical findings

1. The original `Event Simulation` path was a layer-wise stochastic analytic model rather than a true discrete-event simulator.
2. Demand and prefetch reads did not share a conserved global SSD resource timeline.
3. In-flight prefetches could be treated as cache hits before I/O completion.
4. Host DRAM, device VRAM, and OS page-cache budgets were not independently validated.
5. Aggregate throughput could be approximated as single-request TPS multiplied by concurrency without resource contention.
6. Several UI parameters were metadata-only and did not affect calculations.
7. Prefetch policy names did not correspond to distinct candidate-generation algorithms.
8. Cold prefill could receive hit-rate benefits from initially empty caches.
9. MTP speedup omitted draft, verify, rejection, and extra expert-union costs.
10. Expert top-p was approximated by reducing top-k rather than integrating router-score mass.

## Required V2 architecture

```text
Configuration validation
        ↓
Request / token / layer state
        ↓
Router and prefetch policy
        ↓
Expert residency directory
        ↓
Shared SSD queue
        ↓
Host cache admission
        ↓
PCIe or unified-memory transfer
        ↓
CPU worker / GPU stream queue
        ↓
Layer completion
        ↓
Token completion and metrics
```

## P0 invariants

- Completed SSD bytes must not exceed configured effective bandwidth over elapsed busy time.
- An expert must not be counted as a ready hit before its I/O and required transfer complete.
- Every cache tier must remain within capacity.
- `activeExperts` must never exceed `expertsPerLayer`.
- O_DIRECT mode must disable OS page-cache hits and capacity.
- Host and device memory budgets must be checked separately on discrete-GPU systems.

## Recommended calibration data

- 19MB read service curve by queue depth and worker count
- P50/P95 SSD read latency
- Resident expert execution time
- Attention decode time
- Prefill throughput
- Cold/warm SSD bytes per token
- Cache-tier hit traces
- Useful, late, and wasted prefetch counts
- End-to-end Colibri TPOT under matching settings

## Trust boundary

Until V2 resource queues and trace-based calibration are completed, simulator results should be labeled **Estimated** or **Conceptual**, not **Measured**.
