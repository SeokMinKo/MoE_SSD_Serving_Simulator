# Storage I/O and Parameter Sweep Lab Specification

## Status

Approved for implementation on 2026-07-31.

## Product boundary

The feature remains part of **Estimated sensitivity simulator / Unvalidated Alpha**. Sweep deltas are deterministic comparisons inside the same synthetic model. They are not calibrated improvement forecasts, measured hardware diagnoses, SLA evidence, capacity-planning evidence, or purchase recommendations.

## 1. Sticky action toolbar

- Move every action out of the long parameter sidebar into a viewport-top sticky toolbar.
- Left group: `Run simulation`, `Pause playback`, `Open sweep lab`.
- Right group: `App integrity test`, `Export`, `Import`, `Set comparison baseline`.
- Rename `Self-test` to `App integrity test` and explain that it runs canonical built-in regression/integrity checks, not the user's current performance scenario.
- Sweep controls are separate: `Run sweep`, `Pause sweep`, `Resume sweep`, and `Cancel sweep`.

## 2. Parameter help

Every simulation-affecting input exposes an accessible Korean tooltip with:

- Korean meaning;
- config key and unit;
- engine applicability;
- expected synthetic-model direction and trade-off where meaningful.

Technical terms and config keys remain in English. Tooltips must be keyboard reachable and must not claim real-world causality.

## 3. Storage I/O trace

Both Colibri and AFM expose exact `StorageResource` jobs by execution bucket.

### Categories

Read stacks:

- Expert demand/window reads;
- Expert prefetch reads;
- Swap-in reads.

Write stack:

- Swap-out writes.

Initial prefill reads/writes appear in a separate Prefill bucket. Each job preserves finite deterministic bytes, service time, queue time, start time, end time, and kind. Advisor and chart derive from simulator trace; the renderer does not reconstruct hidden storage jobs.

### Selectors

X-axis:

- Token index;
- Token completion time;
- Cumulative Storage I/O.

Y-axis:

- GB;
- Effective GB/s (`bucket bytes / bucket elapsed`);
- Exact service ms;
- Exact queue ms.

Read and Write remain visually distinct; Read subcategories are stackable. Canvas output has an equivalent accessible table.

### View modes

- Tabs;
- Stacked sections;
- Overlay.

Overlay may use separate axes when units differ. The selected view mode is UI state, not simulator configuration.

## 4. Sweep Lab

The lab is an accessible dialog. It fixes a validated baseline config when execution starts and fixes the selected engine for the whole sweep.

### Parameter catalog

- Include every simulation-affecting validated config field applicable to the selected engine.
- Exclude display-only state such as playback speed, graph mode, and published-preset identity.
- Include the topology values to which a preset maps.
- Provide search, category filters, selected count, projected combination count, Select all, and Clear.
- Categories: Workload, Model, System / Storage, Memory, Compute, Prefetch.

### Modes

- OAT: each selected parameter varies independently from the same baseline.
- Grid: deterministic Cartesian product in selected-parameter order and user-value order.

Numeric value input supports:

- min/max/steps;
- linear/log spacing;
- explicit comma-separated values;
- automatic baseline-relative values `0.5×, 0.75×, 1×, 1.5×, 2×`, clamped/deduplicated for the field type and validated range.

Categorical and boolean inputs use explicit checkboxes.

### Execution

- At most the first 50 deterministic scenarios execute.
- If the Cartesian product exceeds 50, display total, executed count, and omitted count before and after execution.
- Do not random-sample or silently imply full-grid coverage.
- Run one scenario per event-loop turn.
- Pause takes effect between scenarios; Resume continues from the same index; Cancel preserves completed rows and marks the run cancelled.
- Progress reports completed / scheduled and current parameter combination.
- Invalid and OOM runs remain rows with reasons; graphs use gaps/failure markers rather than zero.

### Metrics

Every successful row stores:

- TTFT average, p50, p95;
- Single TPS;
- Aggregate TPS;
- status and OOM state.

The result area offers:

- Separate TTFT/TPS charts;
- accessible raw result table;
- CSV download.

## 5. Scenario artifact V3

- Schema: `moe-ssd-sim/v3`.
- V2 compatibility break is intentional and documented.
- Persist the current scenario plus an optional completed sweep snapshot. Paused or cancelled work remains visible in the current lab session but is not serialized as a reproducibility claim.
- A completed sweep snapshot contains baseline config, engine, mode, ordered parameter definitions, total combinations, executed/omitted counts, lifecycle status, and at most 50 scenario configs and metric summaries.
- Import validates every field, maximum count, finite metric, enum, status, and config.
- Import reruns the current scenario and every stored sweep scenario, then compares deterministic summaries. Stored derived results are never trusted.
- Tampered, malformed, non-finite, oversized, or plausible-looking mismatched artifacts fail closed.

## 6. Success criteria

- RED tests fail for every new contract before production implementation.
- Existing behavior remains unchanged outside the requested UI relocation, trace extension, and V3 compatibility break.
- Node suite, syntax/provenance check, hardware sweep, audit, and diff checks pass.
- Real desktop browser verifies toolbar, tooltips, dialog keyboard behavior, storage selectors/view modes, OAT/Grid, 50-prefix warning, pause/resume/cancel, chart/table/CSV, V3 replay, invalid/OOM rendering, and no horizontal overflow.
- Browser App integrity test remains independent of current topology and passes all canonical checks.
- Fresh independent review reports P0=0 and P1=0 before release.
