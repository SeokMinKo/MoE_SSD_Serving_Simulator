# MoE SSD Serving Simulator Agent System PRD

## Goal
Provision a durable Hermes team that preserves the simulator's relative-sensitivity trust boundary while separating specification, implementation, independent model validation, real-browser/reproducibility review, and release authority.

## Risk classification

| Dimension | Level | Evidence | Consequence |
|---|---|---|---|
| Domain | High | SSD/DRAM/PCIe/compute timing, memory and causality claims | Independent model oracle is mandatory for model changes. |
| Runtime | High | Browser Workers, replay, async import/sweep, event scheduler | Actual-browser and concurrency probes are mandatory. |
| Release | High | Commit-derived static bundle and GitHub release provenance | Release is a separate human-gated workflow. |
| Evidence | High | Same-model replay is not external calibration | Internal PASS cannot become predictive validity. |
| Durability | High | Multi-stage work and independent approvals | Project board and persistent profiles are justified. |

## Acceptance criteria

- The manifest passes the bundled strict validator and references only contained real paths.
- All five role SOULs contain the required headings, distinct judgment, over-action controls, handoff ownership, and exactly-one-verdict contract.
- Routing avoids over-invoking model/release roles for typo or browser-only fixes.
- Model changes route to a builder plus independent model and browser reviewers; release waits for both.
- Worker messaging is disabled and messaging credentials are absent without exposing values.
- Bootstrap applies idempotently; source and installed state match; the second run is a no-op.
- A harmless live worker task terminates via Kanban without changing project files.
- Behavioral probes distinguish all roles.
- A fresh independent final review scores every role and the system at least 95/100 with zero blockers.

## Non-goals

- Profiles are not filesystem sandboxes.
- No profile receives authority to publish, enter credentials, accept calibration, or claim absolute prediction.
- No always-on lead profile is created; the existing ingress selects the smallest primitive or workflow.
