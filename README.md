# MoE SSD Serving Simulator

브라우저에서 단일 HTML로 실행되는 **SSD-offloaded Mixture-of-Experts 추론 시뮬레이터**입니다. Colibri 스타일의 Expert streaming 환경에서 TTFT, TPOT, TPS, SSD 읽기량, Cache hit, Prefetch 효과와 메모리 예산을 비교합니다.

> **현재 버전:** V1.1 Alpha — resource-conserving timeline model

## 실행

1. `index.html`을 Chrome 또는 Edge에서 엽니다.
2. 별도 서버, 빌드 과정 또는 외부 라이브러리가 필요하지 않습니다.
3. GitHub Pages를 사용하면 정적 웹앱으로 배포할 수 있습니다.

## V1.1에서 수정된 사항

### 실제 TPS와 토큰 표시 속도 일치

- 기본 재생 속도를 `1× 실시간`으로 변경했습니다.
- TTFT 이후 첫 토큰을 표시하고, 이후 각 토큰은 해당 TPOT 간격으로 출력됩니다.
- 기존의 최대 1.5초 지연 제한과 기본 100× 압축 재생을 제거했습니다.
- 재생 중 2×, 10×, 100×로 변경할 수 있으며 남은 시뮬레이션 시간을 새 배율에 맞게 다시 계산합니다.

검증에서는 1.5 TPS, 즉 약 666.7ms TPOT 조건에서 실제 화면 출력 간격이 667ms와 667ms로 측정됐습니다.

### P0 정합성 개선

- Demand read와 Prefetch read가 하나의 SSD timeline을 공유합니다.
- SSD에 예약된 전체 byte와 service time이 입력 대역폭을 초과하지 않도록 제한합니다.
- 완료되지 않은 Prefetch는 즉시 Cache hit로 처리하지 않습니다.
- Late Prefetch는 기존 I/O에 합류하며 SSD read를 중복 발행하지 않습니다.
- Host/Unified memory와 GPU VRAM 예산을 분리해 검증합니다.
- `Active Experts`는 `Experts per Layer` 이하로 제한합니다.
- `O_DIRECT` 사용 시 Page Cache 용량을 계산에서 제외합니다.
- Cold Cache에서는 일반 DRAM/VRAM Cache가 이미 채워진 것으로 가정하지 않습니다.
- Aggregate TPS는 단순히 `Single TPS × concurrency`로 계산하지 않고 SSD와 PCIe capacity bound를 적용합니다.

## 현재 입력 변수

- Workload: prompt/output/context token, concurrent sequence, cold/warm cache
- MoE: layer 수, layer당 Expert 수, 활성 Expert 수, Expert 크기, 상주 가중치, KV 크기
- System: Unified/Discrete 구조, Host memory, VRAM, DRAM/PCIe bandwidth
- Cache: VRAM, DRAM, pinned hot store, OS Page Cache
- SSD: effective Expert bandwidth, latency, queue depth
- Compute: Attention time, Expert compute time, 병렬 Expert 수
- Prefetch: recall, precision, byte budget

## 표시 지표

- TTFT, TPOT, Single-sequence TPS
- Aggregate TPS와 SSD/PCIe capacity bound
- SSD read GB/token
- Cache hit rate
- Host/VRAM memory footprint
- SSD busy time 및 queue delay
- Prefetch useful, wasted, late 수
- Cache eviction 수
- Token별 TPOT trace

## 자체 검증

화면의 `Self-test` 버튼으로 다음 8개 검증을 실행할 수 있습니다.

1. 동일 seed 결과 재현성
2. SSD bandwidth 증가 시 TPS 비감소
3. Active Expert 상한
4. O_DIRECT Page Cache 제거
5. GPU memory budget 초과 차단
6. 관측 SSD bandwidth 보존
7. Aggregate TPS resource bound
8. 1.5 TPS 실시간 재생 간격

현재 빌드는 **8/8 통과**했습니다. 검증 기록은 [`docs/v1.1-validation.md`](docs/v1.1-validation.md)에 있습니다.

## 남은 한계

V1.1은 이전 버전보다 물리적 정합성이 개선됐지만, 완전한 하드웨어 cycle simulator는 아닙니다.

- SSD는 하나의 aggregate effective-bandwidth timeline으로 모델링합니다. 실제 NVMe controller 내부 병렬성은 QD별 실측 service curve로 교체해야 합니다.
- Prefill은 아직 analytic estimate이며 Decode와 동일한 event path로 실행하지 않습니다.
- Concurrency는 resource capacity bound까지만 계산하며 continuous batching scheduling은 구현하지 않았습니다.
- Router score 기반 Expert top-p와 MTP acceptance/verification은 아직 구현하지 않았습니다.
- CPU/GPU kernel과 DRAM bandwidth는 실측 calibration 값이 필요합니다.
- 제품명 프리셋 대신 입력값 기반 모델을 우선 제공합니다.

## 다음 개발 순서

1. QD와 read size별 SSD service curve
2. Prefill event execution 및 batch-union
3. CPU/GPU compute resource queue
4. Continuous batching과 다중 요청 P95/P99
5. 실제 Colibri routing/I/O trace import
6. Top-p와 MTP 모델

상세 계획은 [`ROADMAP.md`](ROADMAP.md)를 참고하십시오.

## 주의

- 표시되는 문장은 실제 언어 모델의 생성 결과가 아닙니다.
- 절대 TPS 예측에는 대상 장비에서 측정한 19MB Expert read 및 resident compute calibration이 필요합니다.
- 라이선스는 아직 지정하지 않았습니다.
