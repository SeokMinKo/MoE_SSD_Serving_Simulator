# MoE SSD Serving Simulator

브라우저에서 실행되는 Colibri 및 AFM 3 Core Advanced용 SSD/NAND offloading 시뮬레이터입니다. 절대 성능 예측보다 **Storage·DRAM·Memory Capacity·Swap 정책 변화에 따른 병목과 상대 트렌드 분석**을 목표로 합니다.

> Current version: **V1.3 Alpha — DRAM pressure, reclaim, compression and swap**

## 실행

`index.html`을 Chrome 또는 Edge에서 열면 됩니다. 외부 라이브러리와 서버가 필요하지 않습니다.

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

## V1.3 DRAM·Swap 기능

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

## 주요 해석

- Expert가 file-backed라면 pressure 시 Swap write 없이 폐기하고 원본 파일에서 다시 읽을 수 있습니다.
- Expert가 anonymous라면 pressure eviction이 Swap write를 만들 수 있습니다.
- DRAM bandwidth는 기존 compute 시간에 더하지 않고 roofline floor로 적용해 이중 계상을 줄였습니다.
- Memory 용량 증가 자체가 성능을 높이는 것이 아니라, Swap 제거·Cache 확대·Double Buffer 허용으로 연결될 때 성능이 개선됩니다.

## 검증

UI의 `Self-test`는 14개 회귀 검증을 실행합니다. 현재 빌드는 **14/14 통과**했습니다.

- 상세 계획 및 검토: [`docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md`](docs/DRAM_SWAP_IMPLEMENTATION_PLAN.md)
- 검증 결과: [`docs/v1.3-validation.md`](docs/v1.3-validation.md)
- AFM 3 모델: [`docs/afm3-model.md`](docs/afm3-model.md)

## 한계

- 실제 OS page-level VM simulator가 아닙니다.
- GPU VRAM bandwidth 및 GPU page migration은 아직 모델링하지 않습니다.
- Prefill은 일부 analytic estimate를 사용합니다.
- CPU/GPU 제품 사양에서 kernel 시간을 자동 산출하는 roofline calibration은 후속 항목입니다.
- 절대 TPS보다 동일 설정에서 변수 하나를 변경한 상대 비교에 사용하십시오.
