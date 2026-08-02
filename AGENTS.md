# AGENTS.md — MoE SSD Serving Simulator

## Product boundary

This repository is a dependency-free browser simulator for controlled **relative sensitivity analysis**. It is an **Unvalidated Alpha**, not a calibrated predictor of absolute TTFT, TPOT, TPS, capacity, hardware purchasing value, or production SLA. Preserve this boundary unless external calibration and hold-out evidence are explicitly accepted by a human owner.

## Read first

1. `README.md`
2. `ROADMAP.md`
3. `docs/v1.6.1-correctness-contract.md`
4. The task-specific spec and latest relevant validation report

## Change discipline

- Record `git status --short` before and after work; preserve all pre-existing changes.
- Define the claim, units, metric population, invariants, non-goals, and acceptance criteria before code.
- Follow strict RED → GREEN → REFACTOR. No production change without an observed failing reproduction or contract test first.
- Make surgical changes. Do not reset, checkout, broadly format, silently clamp invalid input, or alter unrelated files.
- Log errors, asynchronous state changes, Worker boundaries, and API/state transitions with enough context to reproduce failures; never log secrets or imported private data.

## Scientific hard gates

- Decimal SI fields labeled GB/MB/KB remain decimal; binary units require explicit GiB/MiB/KiB labels.
- Capacity, bytes, busy time, request population, event causality, cache admission, pending I/O, OOM rollback, and metric populations must remain conserved and finite.
- Same-model replay and App integrity tests prove regression consistency, not external validity.
- A model change requires an independent hand oracle, adversarial boundaries, metamorphic sensitivity checks, and explicit external-calibration limitations.
- Estimated and Measured claims must remain distinguishable.

## Verification

Run at minimum:

```bash
npm ci --ignore-scripts
npm run check
npm test
git diff --check
npm audit --audit-level=high
```

Browser, Worker, replay, accessibility, responsive-layout, or UI changes also require fresh actual-browser verification at desktop and 375px, console/error inspection, and behavior-specific evidence. Release claims additionally require a clean commit-derived `npm run build:release`, immutable provenance parity, rollback, fresh independent model and browser approvals, explicit human release approval, push, and successful remote CI.

## Role handoff

Use `agent-system/team.json` as the durable topology. Workflow completion metadata uses exactly these keys: `verdict`, `facts`, `assumptions`, `decision`, `evidence`, `counterevidence`, `limitations`, `remainingRisks`, `humanActionRequired`, `changedFiles`, and `receiver`. A PASS packet requires `humanActionRequired=[]`; pending approval or other human action must block instead. Facts, decision, evidence, counterevidence, limitations, and receiver remain non-empty; optional lists may be empty but not omitted. Every task packet declares `expectedReceiver`: the exact successor profile, a sorted unique profile list for manifest fan-out, or the current stage's remediation owner for a terminal node. `receiver` must match it. Reviewer findings return to the original change owner. Non-root workflow tasks remain unassigned until `teamctl advance` validates the complete latest-run packet; only then may the controller assign the exact manifest profile.
