# MoE SSD Serving Simulator

브라우저에서 실행되는 Colibri 및 AFM 3 Core Advanced용 SSD/NAND offloading 시뮬레이터입니다. 절대 성능 예측보다 **Storage·DRAM·Memory Capacity·Swap 정책 변화에 따른 병목과 상대 트렌드 분석**을 목표로 합니다.

> Current version: **V1.4 Alpha — hardware-sensitivity corrections**

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
  - VRAM/DRAM/Page Cache 계층
  - Demand 및 Prefetch 공유 Storage timeline
  - file-backed 또는 anonymous DRAM Expert Cache
- **AFM 3 Core Advanced IFP**
  - Shared 23 + Routed 23 Expert
  - 2-bit weight
  - 32-token selection window
  - Delta Routed Expert loading
  - Shared/Current Routed weight pinned

## V1.4 주요 변경

- Pinned Expert의 잘못된 Prefetch I/O 제거
- Prefetch 후보 수를 layer의 전체 Expert 수로 제한
- SSD queue depth 이중 적용 제거
- Host/DRAM에서 전송된 Expert의 VRAM LRU 승격
- Prefill의 Expert working-set 및 cache warming 모델 추가
- TTFT를 `max(compute, storage, PCIe, DRAM) + first-token TPOT`로 계산
- Prompt 반복 접근은 동일 Zipf 분포와 cache coverage를 사용해 재로딩 근사
- RAM/VRAM 용량에서 Expert cache를 산출하는 Auto Placement 추가
- Manual cache가 실제 VRAM 용량을 넘으면 Device OOM 보고
- Swap-in DRAM traffic 이중 계상 제거
- Aggregate TPS를 scheduler 예측이 아닌 capacity upper bound로 명시

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
- Swap onset token, Swap resident, Thrash ratio
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
- `Aggregate capacity upper bound`는 resource ceiling이며 continuous batching 또는 scheduler 처리량이 아닙니다.
- GPU를 바꿀 때는 `Attention`, `Expert compute`, `Parallel experts`, `Prefill compute speedup`을 해당 GPU의 실측값으로 보정해야 합니다.

## 검증

UI의 `Self-test`는 **20개** 브라우저 회귀 시나리오를 실행합니다. Node 검증은 다음과 같습니다.

```bash
node --test tests/simulator.test.cjs tests/browser-self-test.cjs
```

- V1.4 요구사항: [`docs/V1.4_HW_SENSITIVITY_SPEC.md`](docs/V1.4_HW_SENSITIVITY_SPEC.md)
- V1.4 검증 결과: [`docs/v1.4-validation.md`](docs/v1.4-validation.md)
- 상세 계획 및 검토: [`docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md`](docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md)
- AFM 3 모델: [`docs/afm3-model.md`](docs/afm3-model.md)

## 한계

- 실제 OS page-level VM simulator가 아닙니다.
- Prefill routing union과 cache hit는 synthetic Zipf aggregate estimate입니다.
- GPU VRAM bandwidth, GPU page migration, kernel launch/graph 최적화는 모델링하지 않습니다.
- Discrete GPU의 고정 runtime/device weight 사용량은 0.8GB workspace calibration으로 단순화합니다.
- Continuous batching, request arrival, scheduler fairness 및 tail latency를 모델링하지 않습니다.
- CPU/GPU 제품명이나 FLOPS에서 kernel 시간을 자동 산출하지 않습니다.
- 모델/런타임 trace와 SSD service curve로 calibration하기 전에는 절대 TPS/TTFT 오차 범위를 보장할 수 없습니다.
- 절대 TPS보다 동일 설정에서 변수 하나를 변경한 상대 비교에 사용하십시오.
