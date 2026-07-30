# Roadmap

## V1.1 — Safety and model labeling

- [ ] Validate every imported and UI-generated configuration
- [ ] Clamp active experts to experts-per-layer
- [ ] Rename the current event mode to `Layer-wise Stochastic Model`
- [ ] Mark unimplemented inputs as metadata-only
- [ ] Separate host, device and page-cache memory accounting
- [ ] Remove the full-resident shortcut
- [ ] Add physical-invariant tests

## V2.0 — Discrete-event core

- [ ] Min-heap event queue
- [ ] Shared SSD demand/prefetch queue
- [ ] SSD bandwidth conservation
- [ ] Expert residency directory
- [ ] In-flight request coalescing
- [ ] PCIe bandwidth resource
- [ ] CPU worker pool and GPU stream pool
- [ ] Completion-driven cache admission and eviction
- [ ] Resource timeline-based TTFT and TPOT

## V2.1 — Runtime policy fidelity

- [ ] Previous-token, statistical-hot and synthetic PILOT prefetch policies
- [ ] Ready, late and wasted prefetch classification
- [ ] Prefill routing union and cold materialization
- [ ] Multi-request scheduling and continuous batching
- [ ] Router-score-based Expert top-p
- [ ] MTP draft, verify and acceptance model

## V3.0 — Calibration

- [ ] Import Colibri routing and I/O traces
- [ ] Import SSD service curves by read size and queue depth
- [ ] Component-wise calibration factors
- [ ] Confidence intervals and sensitivity analysis
- [ ] Measured versus estimated result labeling
