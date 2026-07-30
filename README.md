# MoE SSD Serving Simulator

브라우저에서 실행되는 Colibri 및 AFM 3 Core Advanced용 SSD/NAND offloading 시뮬레이터입니다. 절대 성능 예측보다 **Storage·DRAM·Memory Capacity·Swap 정책 변화에 따른 병목과 상대 트렌드 분석**을 목표로 합니다.

> Current version: **V1.5 — Estimated sensitivity + event/resource scheduling (Unvalidated Alpha)**

## 실행

`index.html`을 Chrome 또는 Edge에서 열면 됩니다. 외부 라이브러리와 서버가 필요하지 않습니다.

Node.js가 있다면 동일한 모델로 기본 HW sweep을 실행할 수 있습니다.

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

결과 화면의 `Prefill critical path`를 먼저 확인하십시오. 현재 critical path가 아닌 부품만 증설하면 수치 변화가 작거나 없을 수 있습니다.

## Execution engines

- **Colibri Token-Routed MoE**
  - Token/Layer routing
  - 28개 공개 모델의 topology-only 프리셋
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

[`data/moe_model_trend_with_layers_2026-07-21.csv`](data/moe_model_trend_with_layers_2026-07-21.csv)에서 MoE layer 수, routed Expert 수, top-k가 모두 공개된 28개 모델을 선택할 수 있습니다. `npm run check`는 저장소 CSV와 프리셋의 전체 retained metadata를 결정적으로 대조합니다. 프리셋은 다음 세 입력만 변경합니다.

- `MoE layers`
- `Experts / layer`
- `Active experts / token`

총/활성 parameter, dense/shared Expert 구성과 원본 Hugging Face config 링크는 설명용 metadata로만 표시됩니다. CSV만으로 확정할 수 없는 Expert size, resident weights, KV bytes, compute latency, precision, hardware 및 workload는 변경하지 않습니다. 따라서 모델명을 선택해도 해당 모델의 성능이 calibration되었다는 뜻이 아닙니다. 상세 계약은 [`docs/model-presets.md`](docs/model-presets.md)를 참조하십시오.

## V1.5 주요 변경

- 계산에 사용하는 모든 필수 numeric/enum/boolean 및 관계 조건을 실행 전에 fail-closed 검증
- 잘못된 입력을 clamp·정렬·32-bit wrapping하지 않으며 오류 시 이전 KPI·playback·canvas를 폐기
- Expert cache의 1.03× packing overhead를 byte capacity에 포함
- Swap-out write 완료 전 원본 residency를 유지하고, swap-in 대기 완료 시 pending 상태를 갱신
- Previous-token route와 static popularity 기반 causal prefetch 및 cache-eviction provenance
- Stable min-heap event queue, 공유 SSD/DRAM/PCIe/compute timeline, request arrival과 admission-window batching
- 단일 요청에서는 analytic token timeline을 보존하고, 다중 요청에서는 그 baseline에 공유 자원의 queue contention을 추가
- Swap read/write를 shared SSD contention에 포함하고 AFM selector/initial patch/prefill을 TTFT event chain에 포함
- `moe-ssd-sim/v1` JSON export/import, deterministic Run ID, baseline diff, replay 결과 검증
- 공개 구조가 완전한 28개 MoE 모델의 topology-only 프리셋과 원본 config provenance
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

UI의 `Self-test`는 **20개** 브라우저 회귀 시나리오를 실행합니다. Node 검증은 다음과 같습니다.

```bash
npm ci --ignore-scripts
npm run check
npm test
```

- V1.4 요구사항: [`docs/V1.4_HW_SENSITIVITY_SPEC.md`](docs/V1.4_HW_SENSITIVITY_SPEC.md)
- V1.4 검증 결과: [`docs/v1.4-validation.md`](docs/v1.4-validation.md)
- V1.5 검증 결과와 신뢰 경계: [`docs/v1.5-validation.md`](docs/v1.5-validation.md)
- 모델 프리셋 매핑과 제외 범위: [`docs/model-presets.md`](docs/model-presets.md)
- 상세 계획 및 검토: [`docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md`](docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md)
- AFM 3 모델: [`docs/afm3-model.md`](docs/afm3-model.md)

## 한계

- 실제 OS page-level VM simulator가 아닙니다.
- Prefill routing union과 cache hit는 synthetic Zipf aggregate estimate입니다.
- GPU VRAM bandwidth, GPU page migration, kernel launch/graph 최적화는 모델링하지 않습니다.
- Discrete GPU의 고정 runtime/device weight 사용량은 0.8GB workspace calibration으로 단순화합니다.
- V1.5 scheduler는 analytic trace를 no-contention baseline으로 사용하는 resource-level approximation입니다. Aggregate roofline work는 streaming overlap으로 취급하고 공유 자원의 queue delay를 추가합니다. GPU kernel-level batching, scheduler fairness, request 간 Expert-cache 공유, in-flight read coalescing은 모델링하지 않습니다.
- SSD QD는 command-latency wave와 aggregate bandwidth cap으로 근사하며 실제 outstanding-slot service curve가 아닙니다.
- Scenario import의 동일 결과/Run ID 검증은 같은 V1.5 JavaScript 모델의 deterministic replay이며 외부 독립 oracle이 아닙니다.
- CPU/GPU 제품명이나 FLOPS에서 kernel 시간을 자동 산출하지 않습니다.
- 모델/런타임 trace와 SSD service curve로 calibration하기 전에는 절대 TPS/TTFT 오차 범위를 보장할 수 없습니다.
- 절대 TPS보다 동일 설정에서 변수 하나를 변경한 상대 비교에 사용하십시오.
