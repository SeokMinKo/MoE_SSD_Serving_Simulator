# Project Agent System

Repository-owned source for the MoE SSD Serving Simulator Hermes team.

## Files

- `team.json`: profiles, stages, workflow graphs, tool/skill policy, security and human gates
- `profiles/`: source SOUL contracts
- `evals/`: routing and behavioral dilemmas
- `PRD.md`, `ARCHITECTURE.md`: intent, risk, topology and rollback policy

## Validate and provision

```bash
SKILL="$HOME/.hermes/skills/autonomous-ai-agents/project-agent-team-builder"
python3 scripts/test-project-agent-system.py
python3 "$SKILL/scripts/validate_manifest.py" agent-system/team.json
python3 "$SKILL/scripts/validate_evals.py" routing agent-system/evals/routing-cases.json
python3 "$SKILL/scripts/validate_evals.py" behavioral agent-system/evals/behavioral-cases.json
python3 "$SKILL/scripts/teamctl.py" agent-system/team.json bootstrap
python3 "$SKILL/scripts/teamctl.py" agent-system/team.json bootstrap --apply
python3 "$SKILL/scripts/teamctl.py" agent-system/team.json status
```

The first bootstrap command is read-only. The controller applies only with `--apply`, snapshots mutable installed state, disables worker messaging, and reports parity after read-back.

## Workflow examples

```bash
python3 "$SKILL/scripts/teamctl.py" agent-system/team.json workflow model-change --title "Correct SSD queue causality"
python3 "$SKILL/scripts/teamctl.py" agent-system/team.json workflow software-fix --title "Fix mobile import focus"
# After every logical parent has completed with the full required PASS metadata packet:
python3 "$SKILL/scripts/teamctl.py" agent-system/team.json advance software-fix --title "Fix mobile import focus" --apply
```

Non-root tasks retain durable Kanban dependency links but are created **without an assignee**. Parent completion may change their status, but the dispatcher cannot run them. Every packet declares `expectedReceiver`: the exact successor profile, a sorted unique profile list for manifest fan-out, or the current stage's remediation owner for a terminal node. `teamctl advance` requires the full latest-run packet, `humanActionRequired=[]`, and `receiver == expectedReceiver`; it only then assigns an eligible successor. Pending human action or a mismatched receiver fails closed. This prevents ordinary dependency promotion from bypassing controller evidence checks.

Production release, credentials, external calibration acceptance, and absolute-prediction claims always require explicit human approval.
