# Bottleneck Advisor specification

## Status

Accepted for V1.5 **Estimated sensitivity simulator / Unvalidated Alpha**.

## Goal

Explain where the current synthetic run is pressured without presenting an absolute hardware prediction. The advisor appears directly below the KPI row and provides four independent phase scorecards:

1. Prefill
2. First token
3. Decode
4. Memory pressure

Each scorecard exposes all four resource scores rather than forcing one primary bottleneck:

- Storage
- Data movement
- Compute
- Capacity / policy

## Score contract

Every score is a deterministic integer from 0 to 100 and means **relative pressure inside this simulated trace**. It is not a probability, confidence score, measured utilization guarantee, or forecast of improvement.

For timed phases, resource pressure is:

```text
score = round(clamp(component demand or exposed stall / phase elapsed × 100, 0, 100))
```

For capacity pressure:

```text
score = round(clamp(max(memory utilization, modeled pressure-state severity) × 100, 0, 100))
```

The UI must display the exact numerator, denominator, and formula basis used by every score. Overlapped resources may each score highly, so scores do not need to sum to 100. For concurrent runs, Prefill, first-token, and decode take the maximum of component pressure and their own phase-local `queue / (queue + busy)` pressure. Scheduler reservations retain phase-local queue/busy accounting. AFM patch/materialization work uses a dedicated shared `patch` resource and contributes to Data movement queue pressure, never Compute queue pressure. Mixed-phase compute batches remain labeled `mixed` rather than being silently assigned to one phase.

### Prefill

- Colibri uses existing `prefillBreakdown` compute, storage, PCIe transfer, and DRAM times.
- AFM uses the modeled initial selector/prefill compute, initial window read, and patch/materialization transfer paths. Periodic token `patchMs` is Data movement and is excluded from compute demand.
- Capacity uses the first completed token's memory snapshot because no separate prefill memory trace exists; this limitation is disclosed.

### First token and decode

- Storage uses the exact per-job `StorageResource` service and queue accounting recorded during each token, including Expert demand, prefetch, swap-in/out, and cache-hit evidence. It does not collapse layer jobs into a new latency-wave approximation.
- Data movement uses modeled PCIe transfer demand plus exposed DRAM stall divided by token elapsed time.
- Compute uses token `computeOnlyMs` (or legacy `computeMs` when an isolated field is unavailable) divided by token elapsed time.
- Capacity uses token memory utilization and modeled pressure state.
- Decode uses only tokens after the first. A one-token run retains the Decode card for schema stability but marks it unavailable and reports four zero scores instead of duplicating first-token evidence.

### Memory pressure

- Storage separates initial pre-decode swap service from token-phase swap service, then compares their exact sum with total completed run elapsed time. It does not divide pre-decode work by a decode-only denominator.
- Data movement uses peak DRAM utilization.
- Compute is zero when isolated compression-policy CPU time is not exposed; the evidence explicitly says it is unavailable rather than inventing a value.
- Capacity uses peak physical-memory utilization, pressure-state severity, thrash ratio, and OOM status.

## Recommendations

Recommendations are rule-based. They do not run counterfactual simulations and therefore must not claim a numeric improvement.

For every resource, the advisor provides:

- control names;
- increase/decrease direction;
- the condition under which the recommendation applies;
- likely trade-offs or side effects.

A recommendation with a score below 35 is labeled `Monitor`; otherwise it is labeled `Consider`. OOM capacity recovery is always urgent.

## Invalid and OOM behavior

- Invalid configuration: keep the advisor region visible and show `Unavailable: configuration validation failed`. Do not retain stale scores.
- OOM with a partial trace: show all available phase evidence and force memory-pressure Capacity / policy to 100.
- OOM before any token completes: show an OOM recovery card from the structured error/config context; unavailable timing phases must not fabricate scores.
- OOM recommendations must not imply that the run completed or that TTFT/TPS is valid after the last completed token.

## Scenario artifact V3

- Schema: `moe-ssd-sim/v3`.
- Export includes a deterministic derived `insight` snapshot.
- Export may include the current `parameter-sweep/v1` baseline, definition, retained raw result summaries, and status.
- Import validates the insight structure and score bounds.
- Replay recomputes the insight from canonical config/result and rejects any stored insight mismatch.
- Replay also recomputes every retained sweep point (maximum 50) and rejects config, metric, status, or run-ID mismatch.
- V1 and V2 artifacts are rejected as unsupported; this is an explicit schema break approved for this feature.

## Trust boundary

The advisor analyzes only this simulator's own synthetic trace and modeled queues. It does not establish:

- measured device bottlenecks;
- absolute TTFT, TPOT, TPS, SLA, tail-latency, or capacity accuracy;
- a guaranteed benefit from changing a control;
- hardware purchase suitability;
- model-specific performance calibration from a topology preset.

Real traces, device service curves, calibration, and hold-out validation remain required for those claims.

## Acceptance criteria

- Four phase cards and four scores per available phase.
- Every score is finite, integer, and within 0–100.
- Every score shows formula/evidence and a bounded recommendation with a trade-off.
- Colibri and AFM produce deterministic insight snapshots.
- Invalid input clears stale insight; partial OOM emits recovery guidance.
- `moe-ssd-sim/v3` export/import replay verifies insight and optional sweep integrity.
- Keyboard/screen-reader semantics and 375px layout remain usable without horizontal overflow.
- Existing simulator, scenario, preset, accessibility, and security gates remain green.
