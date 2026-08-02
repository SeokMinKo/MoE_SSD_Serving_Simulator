# MoE SSD Serving Simulator Agent System Architecture

## Topology

```text
Ingress
  ├─ tiny/read-only work → current session or one profile
  ├─ browser/software fix → builder → browser/repro reviewer
  ├─ model change → spec → builder ─┬→ model validator ─┐
  │                                └→ browser reviewer ├→ release gate
  └─ release recheck → model validator + browser reviewer → release gate
```

## Why each profile remains separate

- `moe-spec`: owns falsifiable claim definition but cannot implement it.
- `moe-simulator-builder`: owns production changes and observed RED/GREEN, but cannot certify them.
- `moe-model-validator`: uses independent unit/conservation/causality/metric-population oracles and cannot repair first-pass findings.
- `moe-browser-repro-reviewer`: owns actual-browser, Worker, replay, accessibility, responsiveness, and provenance evidence; these are not established by model probes.
- `moe-release-gate`: owns immutable provenance, rollback, remote CI, and human release authority; a successful build is insufficient.

A separate lead was rejected because the user-facing ingress can classify and create deterministic workflow graphs; another orchestrator would duplicate policy and state.

## State and authority

Repository docs remain the source of truth. Installed profiles are rendered state reconciled from `team.json`. The project Kanban board is the durable task boundary; profile cwd and SOUL are guidance, not OS isolation. Non-root workflow tasks retain their logical Kanban dependency links but are created unassigned. Parent completion may promote task status, but the dispatcher has no profile to run. Each packet declares `expectedReceiver` as the exact successor profile, a sorted unique profile list for manifest fan-out, or the current stage remediation owner for a terminal node. `teamctl advance` requires the complete latest parent-run packet, an empty `humanActionRequired` list, and `receiver == expectedReceiver`; only then does it assign an eligible successor. Pending human action and receiver mismatch fail closed. Review findings return to `moe-simulator-builder`; release synthesis goes to the human owner.

## Security and rollback

All worker messaging platforms and discovered platform credentials are disabled/removed. Profiles retain only declared toolsets. Production release, credentials, 2FA/payment, destructive history/profile deletion, external calibration acceptance, and absolute-prediction claims remain human gates. Bootstrap and updates create owner-only content-addressed snapshots. Rollback verifies snapshot hashes, restores profile/SOUL/board state with messaging still disabled, and never silently deletes newly created profiles.
