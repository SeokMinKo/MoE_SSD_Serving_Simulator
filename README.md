# Colibri SSD-Offloaded MoE Token Simulator

브라우저에서 실행되는 단일 HTML 기반 **SSD-offloaded Mixture-of-Experts 추론 시뮬레이터**입니다. Colibri 스타일의 Expert streaming 환경에서 TTFT, TPOT, TPS, SSD 읽기량, Cache hit, Prefetch 효과와 메모리 사용량을 비교하도록 설계했습니다.

> **상태:** Alpha / conceptual simulator. 현재 절대 성능 예측용이 아니라 구조 이해와 제한적인 민감도 분석용입니다.

## 실행

1. 저장소의 `index.html`을 Chrome 또는 Edge에서 엽니다.
2. 별도 서버, 빌드, 외부 라이브러리가 필요하지 않습니다.
3. GitHub Pages를 활성화하면 정적 웹앱으로 바로 배포할 수 있습니다.

## 주요 기능

- TTFT, TPOT, TPS 및 토큰 출력 애니메이션
- Prefill과 Decode 분리
- VRAM, DRAM, OS Page Cache, SSD 계층 구성
- Expert routing locality와 계층별 cache hit 모델
- SSD effective bandwidth, latency, queue depth, worker 설정
- Prefetch recall, precision, lead time, wasted read 모델
- Unified Memory와 discrete GPU 프리셋
- M5 Max, M3 Ultra, DGX Spark, RTX 5060 및 Samsung SSD 프리셋
- Cold/Warm cache, O_DIRECT, dual SSD, Expert top-p, MTP 옵션
- Scenario 비교, JSON import/export, calibration 입력

## 현재 정합성 한계

현재 `Event Simulation` 경로는 완전한 discrete-event engine이 아니라 토큰·레이어 단위 확률형 analytic model에 가깝습니다. 다음 항목은 향후 수정이 필요합니다.

- Demand와 Prefetch가 공유하는 global SSD resource queue
- SSD/PCIe/CPU/GPU의 대역폭 및 점유 시간 보존
- Expert residency의 `Absent / In-flight / Resident` 상태 구분
- Host DRAM, GPU VRAM, Page Cache의 독립적인 메모리 예산
- 실제 Prefetch policy별 candidate 생성 및 late-prefetch 처리
- Prefill cold-cache materialization
- 동시 요청과 continuous batching의 resource contention
- Router score 기반 Expert top-p
- Acceptance 및 verification 비용을 포함한 MTP 모델

상세 내용은 [`docs/algorithm-consistency-audit-v1.0.docx`](docs/algorithm-consistency-audit-v1.0.docx)를 참고하십시오.

## 개선 우선순위

### P0 — 물리적 정합성

1. 입력 검증 및 무한 루프 방지
2. Host/Device/Page Cache 메모리 예산 분리
3. Global SSD queue 도입
4. Expert in-flight 상태 및 request coalescing
5. SSD bandwidth conservation invariant test

### P1 — 모델 정확도

1. PCIe와 CPU/GPU resource queue
2. Prefill을 event engine에 통합
3. 실제 Prefetch policy 구현
4. Concurrency와 continuous batching
5. Top-p 및 MTP 모델 재구성

### P2 — 실측 보정

1. 19MB Expert read의 QD별 service curve
2. Resident Expert compute time
3. Cold/Warm bytes per token 및 cache hit trace
4. Colibri 실측 TPOT와 component별 calibration

## 파일 구조

```text
.
├── index.html
├── README.md
├── ROADMAP.md
├── .nojekyll
└── docs
    ├── algorithm-consistency-audit-v1.0.docx
    └── preview.png
```

## 주의

- 표시되는 토큰은 선택한 모델이 실제로 생성한 결과가 아닙니다.
- 제품 프리셋의 명목 사양과 실제 Expert random-read 성능은 다를 수 있습니다.
- 실제 장비 비교에는 동일 read size, queue depth, worker 수로 측정한 calibration 값이 필요합니다.
- 라이선스는 아직 지정하지 않았습니다.
