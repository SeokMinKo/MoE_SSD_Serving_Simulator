# MoE SSD Serving Simulator

브라우저에서 실행되는 Colibri 및 AFM 3 Core Advanced용 SSD/NAND offloading 시뮬레이터입니다. 절대 성능 예측보다 **Storage·DRAM·Memory Capacity·Swap 정책 변화에 따른 병목과 상대 트렌드 분석**을 목표로 합니다.

> Current version: **V1.6.2 — Estimated sensitivity simulator / Unvalidated Alpha**

## 실행

Web Worker를 사용하는 Sweep/Replay까지 실행하려면 `file://`로 직접 열지 말고 로컬 HTTP origin에서 실행하십시오.

```bash
python3 -m http.server 8877 --bind 127.0.0.1
```

그다음 Chrome 또는 Edge에서 `http://127.0.0.1:8877/`을 엽니다. Node.js가 있다면 동일한 모델로 기본 HW sweep도 실행할 수 있습니다.

```bash
node tools/hardware-sweep.cjs
```

## 이 모델로 판단할 수 있는 것

- SSD BW/latency/QD 변화가 cold prefill과 decode Expert miss에 주는 방향성
- Discrete GPU에서 PCIe BW와 VRAM Expert Cache가 TTFT/TPOT에 주는 방향성
- Unified Memory 또는 DRAM-bound 조건에서 DRAM BW가 TPS/TTFT에 주는 방향성
- RAM/VRAM 용량 증가가 Auto Placement의 cache 크기와 Expert 재로딩에 주는 영향
- Attention/Expert compute calibration 값을 변경했을 때 compute-bound TPS/TTFT 변화
- Memory pressure, reclaim, compression, swap이 storage/DRAM 병목으로 전환되는 지점

결과 KPI 아래의 `Bottleneck Advisor`는 Prefill, first token, decode, memory-pressure별 Storage·Data movement·Compute·Capacity 상대 압력 점수와 계산 근거를 표시합니다. 이 점수는 simulator 내부 trace 설명이며 실측 진단이나 개선량 예측이 아닙니다.

## Execution engines

- **Colibri Token-Routed MoE**
  - Token/Layer routing
  - 29개 공개 모델의 topology-only 프리셋
  - VRAM/DRAM/Page Cache 계층
  - Demand 및 Prefetch 공유 Storage timeline
  - file-backed 또는 anonymous DRAM Expert Cache
- **AFM 3 Core Advanced IFP**
  - Shared 23 + Routed 23 Expert
  - 2-bit weight
  - 32-token selection window
  - Delta Routed Expert loading
  - Shared/Current Routed weight pinned

## Published topology presets

[`data/moe_model_trend_with_layers_2026-07-21.csv`](data/moe_model_trend_with_layers_2026-07-21.csv)에서 MoE layer 수, routed Expert 수, top-k가 모두 공개된 29개 모델을 선택할 수 있습니다. `npm run check`는 저장소 CSV와 프리셋의 전체 retained metadata를 결정적으로 대조합니다. 프리셋은 다음 세 입력만 변경합니다.

- `MoE layers`
- `Experts / layer`
- `Active experts / token`

총/활성 parameter, dense/shared Expert 구성과 원본 Hugging Face config 링크는 설명용 metadata로 표시됩니다. Kimi K3처럼 open weights/config가 공개된 경우에도 현재 preset은 공개 routing topology가 적용됐음을 명확히 표시하고, 실행 결과에 직접 영향을 주지만 checkpoint만으로 유일하게 정해지지 않는 quantized Expert payload, resident non-routed weights, KV bytes/token, kernel timing, hardware 값은 measured 또는 명시적 assumed calibration으로 구분합니다. 상세 계약은 [`docs/model-presets.md`](docs/model-presets.md)를 참조하십시오.

## Hardware target presets

HW selector는 Synthetic 이름 대신 NVIDIA DGX Spark, Apple MacBook Pro/Studio, NVIDIA GeForce RTX 5090, AMD Radeon PRO W7900 제품 target을 제공합니다. 각 preset은 공식 사양에서 simulator 필드로 직접 대응되는 값만 적용합니다. GPU 단품 preset의 host/SSD/effective PCIe 값이나 제품 FLOPS에서 추정한 kernel timing은 임의로 채우지 않습니다. 매핑과 공식 출처는 [`docs/hardware-presets.md`](docs/hardware-presets.md)에 기록합니다.

## V1.6.2 주요 변경

- 압축 KV partial-touch에서 이번에 swap-in한 원본에 재접근 비율을 두 번 적용하던 해제 비용 과소계산 수정
- AFM `totalB`를 성능 Sweep에서 제외하고 NAND 저장 용량 산정용 메타데이터로 명시
- `prompt`, `output`, `swapWriteRatio`의 검증·Sweep·브라우저 허용 범위를 단일 계약으로 통합

- 계산에 사용하는 모든 필수 numeric/enum/boolean 및 관계 조건을 실행 전에 fail-closed 검증
- 잘못된 입력을 clamp·정렬·32-bit wrapping하지 않으며 오류 시 이전 KPI·playback·canvas를 폐기
- Expert cache의 1.03× packing overhead를 byte capacity에 포함
- Swap-out write 완료 전 원본 residency를 유지하고, swap-in 대기 완료 시 pending 상태를 갱신
- Previous-token route와 static popularity 기반 causal prefetch 및 cache-eviction provenance
- Stable min-heap event queue, 공유 SSD/DRAM/PCIe/compute timeline, request arrival과 admission-window batching
- 단일 요청에서는 analytic token timeline을 보존하고, 다중 요청에서는 그 baseline에 공유 자원의 queue contention을 추가
- Swap read/write를 shared SSD contention에 포함하고 AFM selector/initial patch/prefill을 TTFT event chain에 포함
- `moe-ssd-sim/v5` JSON export/import, deterministic Run ID, baseline diff, result·Advisor insight·completed parameter sweep replay 검증. V5는 request를 `id`·`arrivalMs`·`output`의 exact shape로 제한하고 calibrated device config의 canonical 필드를 모두 요구합니다. Replay는 저장된 request population 자체를 실행하며, Run ID는 이 실제 실행 입력과 envelope schema, engine contracts, scheduler schema, batch window에 결속되어 관측 replay identity와 대조됩니다. V4는 동일 build provenance일 때만 replay할 수 있으며 V3 이하는 호환하지 않습니다.
- Prefill/first-token/decode/memory-pressure별 0–100 상대 병목 압력, 근거, 조건부 설정 방향 및 부작용
- 공개 구조가 완전한 29개 MoE 모델의 topology-only 프리셋과 원본 config provenance
- Node 22 syntax/test CI, mobile 44px touch targets, reduced-motion, canvas와 동등한 token trace 표

## DRAM·Swap 기능

- Token별 Physical DRAM 사용량
- Expert Cache, Page Cache, KV Cache 변화
- Soft/Compression/Swap/Hard pressure threshold
- Minimum free headroom
- Page Cache reclaim
- file-backed Expert discard
- anonymous Expert Swap-out / Swap-in
- KV compression 및 Swap thrashing
- Expert I/O와 Swap I/O의 동일 SSD/NAND queue 경쟁
- Swap traffic을 포함한 DRAM bandwidth roofline
- Swap onset token, Swap allocated/in-flight, Thrash ratio
- Memory/Swap trace 그래프
- 실제 synthetic storage job에서 파생한 Expert/window·prefetch·swap-in read 및 swap-out write 분리 그래프

## Parameter Sweep Lab

상단 `Open sweep lab`은 현재 엔진에 적용되는 simulator 입력을 One-at-a-time 또는 Grid 방식으로 명시적으로 재실행합니다. Numeric 입력은 Auto, linear min/max/step, logarithmic min/max/points, custom list를 지원하고 categorical 입력은 유효한 값을 직접 선택합니다.

- Grid의 조합이 50개를 넘으면 row-major deterministic ordering의 앞 50개만 실행하고 제외 수를 표시합니다.
- 각 scenario 사이에서 pause/resume/cancel할 수 있으며 이미 완료된 결과는 보존합니다.
- 결과는 baseline과 함께 TTFT mean/p50/p95, single-sequence TPS, aggregate TPS를 별도 그래프와 raw table로 표시합니다.
- invalid/OOM point는 raw status와 reason을 보존하고 그래프에서 정상점으로 연결하지 않습니다.
- CSV export와 scenario V5 JSON export를 지원합니다. JSON import는 exact schema와 동일 build provenance를 검증하고, 저장된 sweep 결과를 신뢰하지 않은 채 최대 50개 scenario를 deterministic replay합니다.

이 기능은 사용자 실행형 synthetic counterfactual 분석이며 Advisor가 자동으로 개선율을 예측하는 기능이 아닙니다.

## Memory policy 설정

- Strict budget
- Reclaim only
- Compression + Swap

임계점 기본값은 Simulator calibration 값이며 특정 OS의 공식 기본값이 아닙니다.

## 결과 해석

- Expert가 file-backed라면 pressure 시 Swap write 없이 폐기하고 원본 파일에서 다시 읽을 수 있습니다.
- Expert가 anonymous라면 pressure eviction이 Swap write를 만들 수 있습니다.
- DRAM bandwidth는 기존 compute 시간에 더하지 않고 roofline floor로 적용해 이중 계상을 줄였습니다.
- Memory 용량 증가 자체가 성능을 높이는 것이 아니라, Swap 제거·Cache 확대·Double Buffer 허용으로 연결될 때 성능이 개선됩니다.
- `Single TPS`는 deterministic synthetic route의 decode 근사치입니다.
- `TTFT`는 aggregate prefill critical path와 첫 token TPOT의 합입니다.
- 동시 요청 결과는 request completion event와 공유 resource timeline에서 계산합니다. Batch window 안에 data-ready가 된 요청만 함께 compute합니다. 단일 요청의 no-contention timeline은 analytic engine과 일치하도록 보존합니다.
- GPU를 바꿀 때는 `Attention`, `Expert compute`, `Parallel experts`, `Prefill compute speedup`을 해당 GPU의 실측값으로 보정해야 합니다.

## 검증

UI의 `App integrity test`는 **22개** 고정 canonical 브라우저 회귀 시나리오를 실행합니다. 현재 입력이나 실제 하드웨어를 평가하지 않습니다. Node 검증은 다음과 같습니다.

```bash
npm ci --ignore-scripts
npm run check
npm test
```

- V1.4 요구사항: [`docs/V1.4_HW_SENSITIVITY_SPEC.md`](docs/V1.4_HW_SENSITIVITY_SPEC.md)
- V1.4 검증 결과: [`docs/v1.4-validation.md`](docs/v1.4-validation.md)
- V1.5 검증 결과와 신뢰 경계: [`docs/v1.5-validation.md`](docs/v1.5-validation.md)
- V1.6.2 계산·입력·메타데이터 계약: [`docs/v1.6.2-correctness-contract.md`](docs/v1.6.2-correctness-contract.md)
- 모델 프리셋 매핑과 제외 범위: [`docs/model-presets.md`](docs/model-presets.md)
- Bottleneck Advisor 점수와 artifact 계약: [`docs/bottleneck-advisor.md`](docs/bottleneck-advisor.md)
- 상세 계획 및 검토: [`docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md`](docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md)
- AFM 3 모델: [`docs/afm3-model.md`](docs/afm3-model.md)

## 한계

- 실제 OS page-level VM simulator가 아닙니다.
- Prefill routing union과 cache hit는 synthetic Zipf aggregate estimate입니다.
- GPU VRAM bandwidth, GPU page migration, kernel launch/graph 최적화는 모델링하지 않습니다.
- Discrete GPU의 고정 runtime/device weight 사용량은 0.8GB workspace calibration으로 단순화합니다.
- V1.6.2 scheduler는 analytic trace를 no-contention baseline으로 사용하는 resource-level approximation입니다. Aggregate roofline work는 streaming overlap으로 취급하고 공유 자원의 queue delay를 추가합니다. GPU kernel-level batching, scheduler fairness, request 간 Expert-cache 공유, in-flight read coalescing은 모델링하지 않습니다.
- SSD QD는 command-latency wave와 aggregate bandwidth cap으로 근사하며 실제 outstanding-slot service curve가 아닙니다.
- Scenario import의 동일 결과/Run ID/Advisor insight/sweep 검증은 같은 V1.6.2 JavaScript 모델의 deterministic replay이며 외부 독립 oracle이 아닙니다.
- CPU/GPU 제품명이나 FLOPS에서 kernel 시간을 자동 산출하지 않습니다.
- 모델/런타임 trace와 SSD service curve로 calibration하기 전에는 절대 TPS/TTFT 오차 범위를 보장할 수 없습니다.
- 절대 TPS보다 동일 설정에서 변수 하나를 변경한 상대 비교에 사용하십시오.
