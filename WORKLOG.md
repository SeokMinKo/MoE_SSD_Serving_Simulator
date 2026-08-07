# WORKLOG

## 2026-08-06 — GDE-BIGMOEEDGE-001 START
- Goal: add BigMoEEdge as a third first-class engine beside Colibri and AFM, implementing a llama.cpp CPU-only serial streaming baseline with deterministic UI/Worker/replay/artifact behavior.
- Classification: L3 / E2 / R2 because this adds a public engine and artifact contract across model, Worker, UI, replay, and calibration boundaries.
- Governing spec: `.hermes/plans/2026-08-06_200159-afm-colibri-bigmoeedge-three-engine.md`, SHA-256 `854b5d3cbbb0e7fc80311aa55f1089d4d9abd91fea5e5c0904461e2c8c8861be`, CONFIRMED-EXPLICIT by user instruction “응 구현해줘”.
- Base: `main@54b46c07b67f883709c21868a1300dc040570d1c`.
- Scope fence: BigMoEEdge serial lossless CPU baseline first; no GPU/PCIe/VRAM work, no concurrency >1, no speculation/drop/route-ahead. Existing AFM/Colibri behavior and V5 artifacts must remain unchanged.
- PHC-07-08-r1: ACCEPTED. First task: write one failing BigMoE config validation test, observe intended RED, then implement minimum config module.
- Observability: validation/import/runtime failures must return structured code/path/message data or existing fail-closed error surfaces; never log raw prompts or model paths.
- Rollback: remove files owned by this run and revert only exact run-owned hunks; never reset the worktree.

## 2026-08-06 — CP-003 CONFIG AND CENTRAL DISPATCH GREEN
- Branch: `feat/bigmoeedge-cpu-streaming` created without resetting the dirty worktree.
- BigMoE exact nested schema and scalar/enum/range validation: 8/8 PASS.
- Central `runSimulationConfig` rejects unknown modes with `UNSUPPORTED_MODE`; BigMoE/Worker integration: 3/3 PASS.
- Existing AFM/Colibri execution body remains unchanged after the explicit mode gate.
- Next: native telemetry CSV importer and canonical mapping tests.

## 2026-08-06 — CP-002 FIRST VERTICAL SLICE GREEN
- TEST-001 RED: `node --test tests/bigmoe-config.test.cjs` failed with ENOENT for `bigmoe-config.js`; canonical config then GREEN.
- Subsequent assertion REDs: unknown root field, concurrency >1, overlap execution, and active>Experts each failed for the intended missing validation behavior before minimum fixes.
- Physical-model REDs: missing `bigmoe-edge.js`, O_DIRECT aligned bytes `0.012 !== 0.046875`, missing serial timing, and missing `HOST_OOM` were observed before production changes.
- GREEN: `node --test tests/bigmoe-config.test.cjs` => 5/5; `node --test tests/bigmoe-edge.test.cjs` => 6/6.
- Characterization: cyclic-LRU cliff test passed on first run after byte-LRU implementation; classified as existing intended behavior, not fresh RED evidence.
- Decisions: BigMoE V1 lane latency is command waves (`ceil(read jobs/ioThreads) × lat`) plus one aggregate bandwidth charge; fixed cache keys are `(layer, expert)` and sizes are full projection groups.
- Next: add a failing `runSimulationConfig` three-engine dispatch test, then wire scripts/Workers without changing AFM/Colibri paths.

## 2026-08-07 — CP-004 FULL GATES AND CLEAN EXPORT
- Implemented first-class AFM/Colibri/BigMoEEdge browser, main-thread, simulation Worker, replay Worker, sweep, Advisor, telemetry, V6 artifact, and release-manifest paths.
- Preserved BigMoEEdge V1 boundaries: concurrency 1, serial CPU-only, GPU/PCIe/VRAM zero, strict host admission, global `(layer, expert)` byte-LRU, projection-level O_DIRECT alignment, and residual-only telemetry evidence.
- Browser dogfood found two fallback defects after initial green suites: token playback used Colibri copy, then the Compute chart description used Colibri GPU copy. Each received an assertion-level RED before the minimum 3-way fix.
- Independent reviews found and drove assertion-level fixes for artifact/config fail-open classes: semantic/provenance identity and threshold ordering; canonical request/output and public-dispatch population integrity; actual telemetry producer/V6 shape; top-level provenance mirrors; exact telemetry target/range semantics; malformed telemetry identity/header/range/continuity; and post-Worker telemetry-evidence preservation. All have regression coverage.
- Additional audit hardening rejects unsupported quantization/source identities, incoherent cache mode/capacity, excessive decode work, telemetry over 16 MiB or 100,000 rows, and CPU occupancy above 100%. BigMoE import now rehydrates nested controls; guided compute selects `runtime.attentionMs`; unsupported hardware and reclaim/swap controls are hidden; concurrency is locked to one; shared help copy names all three engines.
- Fresh independent audit `deleg_036896ae` returned `FAIL 68/100`, P0 `0`, P1/blocker `4`, P2 `3`. It found V6 engine/scheduler/migration identity fail-open, duplicate or malformed telemetry comparability metadata, UTF-16 rather than UTF-8 import budgeting, unbounded finite arithmetic, unsupported architecture identity, and max-safe seed route aliasing.
- All seven findings received assertion-level RED reproductions and minimal fixes: V6 now requires exact `scenario-artifact/v6` top-level/nested engine contracts, canonical `bigmoe-serial/v1` with batch window `0`, and exact migration keys; telemetry rejects duplicate/malformed semantic preamble fields and budgets UTF-8 bytes; config enforces canonical `qwen3moe` and bounded arithmetic inputs; route arithmetic reduces operands modulo the Expert count before addition.
- Post-fix related suites passed `34/34`; full source gates passed `321/321`; `npm run check` passed 33 JavaScript files and 31 CSV rows / 29 eligible presets / 0 mismatches; `git diff --check` passed.
- Independent re-audit `deleg_4857615f` returned `FAIL 84/100`, P0 `0`, P1/blocker `2`, P2 `1`. It found tiny positive finite bandwidth/prefill values producing `Infinity` that sweep summarized as completed zeroes, telemetry architecture not bound to `qwen3moe` config, and replay results lacking observed execution identity.
- All three findings received assertion-level RED reproductions and layered fixes: bandwidth/prefill enforce a `0.001` lower bound, the engine and sweep fail closed on non-finite output, V6 rejects invalid/non-finite result metrics, telemetry parser and V6 evidence bind canonical `qwen3moe`, and replay records and compares observed `bigmoe-serial/v1` execution identity plus backend contract.
- Full source gates after the second audit fixes passed `322/322`; `npm run check` and `git diff --check` passed. JSON `Infinity → null` artifact serialization is explicitly rejected by regression coverage.
- Independent release-quality audit `deleg_52f46f6c` returned `FAIL 92/100`, P0 `0`, P1/blocker `1`, P2 `0`. It found that Sweep Lab's UI baseline reader still routed `bigmoe-edge` selection to `readColibri()`, despite the Worker and BigMoE sweep catalog being correct.
- The Sweep Lab UI reader finding received an assertion-level VM RED and a 3-way reader fix. BigMoE baseline summaries and data-path primer now expose CPU-only serial execution, DRAM/SSD, I/O lanes, and Expert cache without Colibri GPU/PCIe fields.
- Independent release-quality audit `deleg_27b5540e` returned `FAIL 90/100`, P0 `0`, P1/blocker `1`, P2 `1`. It found that the actual Run button handler still applied the AFM/Colibri-only validator before the Worker, and that the existing regression stopped before this boundary.
- The handler finding received an observed RED with the same `mode must be one of colibri, afm3` failure. `runSweepFromUI()` now dispatches BigMoE to `validateBigMoeEdgeConfig`, and the handler-level VM test verifies validation, Worker baseline completion, and BigMoE scenario planning. Full source gates pass `324/324`; `npm run check` and `git diff --check` pass.
- Earlier exact clean-dist browser evidence: actual `bmoe_metrics v2` parser → canonical evidence → V6 export/import → Replay Worker → browser post-verification preserved the Run ID; nested imported controls were restored; unsupported controls stayed hidden; GPU time, PCIe traffic, and device memory were all zero; console and JavaScript errors were zero. This evidence predates the Sweep Lab UI fix and must be refreshed on a new clean candidate.
- Real Chrome CDP mobile verification at 390×844 in Dark and Light measured `document.scrollWidth === innerWidth === 390`, no visible target below 24 px, 20 successive keyboard stops with visible outlines, and no visible clipping/overlap. The wider accessible token table remained inside its intended scroll container without page-level overflow. Final desktop Dark/Light review also showed no layout or stale GPU/Colibri-control regression.
- Fresh independent re-audit `deleg_7b134359` returned `PASS 96/100`, P0 `0`, P1 `0`, P2 `2`, release blockers `0`; the complete real Run-button path and all prior strict contracts passed.
- Both non-blocking audit debts were resolved before delivery: README now distinguishes AFM/Colibri V5 from BigMoEEdge V6, and clean releases generate canonical `release-manifest.json` plus an exact-byte `release-manifest.sha256` with executable regression coverage.
- Remaining model limitation is intentional and disclosed: native Qwen calibration/holdout has not passed, so the product remains `Unvalidated Alpha` and no absolute hardware-performance prediction is claimed.
- Next: run final gates, build and browser-verify the clean candidate, then commit, open the PR, verify CI, and merge as explicitly requested.
