# MoE SSD Serving Simulator

브라우저에서 단일 HTML로 실행되는 **SSD/NAND 기반 MoE Serving Simulator**입니다. 현재 두 실행 방식을 지원합니다.

- **Colibri Token-Routed MoE**: Token·Layer마다 Routed Expert를 선택하고 Cache miss를 SSD에서 읽는 구조
- **AFM 3 Core Advanced IFP**: 선택된 Expert 집합을 32-token window 동안 유지하고 경계에서 변경된 Routed Expert만 NAND에서 다시 읽는 구조

> **현재 버전:** V1.2 Alpha — Colibri + AFM 3 window-routed IFP

## 실행

1. `index.html`을 Chrome 또는 Edge에서 엽니다.
2. 별도 서버, 빌드 과정 또는 외부 라이브러리가 필요하지 않습니다.
3. 기본 Playback은 `1× 실시간`입니다. 표시 TPS가 1.5이면 Token 간격은 약 666.7ms입니다.

## V1.2 AFM 3 Core Advanced

AFM 3 모드는 Colibri와 별도의 계산 경로를 사용합니다.

```text
Prompt
→ Initial IFP selection
→ Routed Expert NAND load
→ Active subnetwork materialization
→ Prefill
→ Token 1~32
→ IFP reselection
→ 변경된 Routed Expert만 delta load
→ Token 33~64
```

### 기본 설정

| 항목 | 값 |
|---|---:|
| Total model | 20B |
| Layers | 44 |
| Hidden dimension | 1,536 |
| Active Experts | 46 |
| Shared Experts | 23 |
| Routed Active Experts | 23 |
| Expert channel width | 256 |
| Active FFN dimension | 11,776 |
| FFN projections | Gate / Up / Down, 3개 |
| FFN split chunks | 2 |
| Weight precision | 2-bit |
| Selection frequency | 32 generated tokens |
| Switch timing | Token 32 완료 후, Token 33부터 새 집합 |
| Loading policy | 기존 Expert 재사용 + changed Expert delta loading |

### AFM 3 집계 모델

Constant Table이 없으므로 실제 Expert ID, Layer별 mask 및 Rasterized file offset은 재현하지 않습니다. 대신 Expert-set overlap을 이용해 변경 Expert 수를 결정합니다.

```text
Changed Experts ≈ Routed Active Experts × (1 − Expert Set Overlap)
```

기본 profile:

- Stable task: 80%
- Normal generation: 65%
- Topic transition: 30%
- Full replacement: 0%

Expert 하나의 weight 크기는 다음 가정으로 계산합니다.

```text
44 layers × 3 projections × 1,536 hidden × 256 channels × 2 bits
= 12.976 MB raw / Expert
```

8% packing overhead를 적용하면 Expert당 약 14.0MB입니다. 기본 overlap 65%에서는 첫 32-token 경계에서 약 8개 Expert, 약 112MB를 읽습니다.

### AFM 3 표시 지표

- Initial selection 및 Routed load를 포함한 TTFT
- Steady TPOT / TPS
- 32-token 경계의 Boundary TPOT
- Effective TPOT / TPS
- P95 / P99 TPOT
- 변경/유지 Routed Expert 수
- Initial NAND read
- NAND read per switch 및 amortized MB/token
- Shared/Routed/Double-buffer/Total Unified Memory
- Token trace의 IFP boundary marker

## V1.1 이후 유지된 정합성 개선

- 기본 Token 재생은 1× 실제 TTFT/TPOT 간격
- Demand와 Prefetch가 하나의 SSD timeline 공유
- 완료되지 않은 Prefetch는 Cache hit로 처리하지 않음
- Late Prefetch I/O coalescing
- Host/Unified memory와 GPU VRAM 예산 분리
- Active Experts 입력 상한 검증
- O_DIRECT 사용 시 Page Cache 제외
- Cold Cache 초기 상태 처리
- Aggregate TPS에 SSD/PCIe capacity bound 적용

## 자체 검증

화면의 `Self-test` 버튼으로 총 12개 검증을 실행합니다.

### Colibri

1. 동일 seed 재현성
2. SSD BW 증가 시 TPS 비감소
3. Active Expert 상한
4. 관측 SSD BW 보존

### AFM 3

5. `46 × 256 = 11,776` 검증
6. 2-bit Expert raw size 12.976MB 검증
7. Output 32 token에서 periodic switch 0회
8. Token 33이 첫 boundary인지 검증
9. Boundary TPOT가 Steady TPOT보다 큰지 검증
10. Overlap 100%에서 periodic NAND read 0
11. 2-bit weight가 4-bit의 절반인지 검증
12. 1.5 TPS 실시간 간격 666.7ms 검증

현재 빌드는 **12/12 통과**했습니다.

## 현재 한계

- AFM 3 Constant Table이 없어 실제 Expert Pool과 Layer별 mask를 알 수 없습니다.
- Expert 하나가 44개 Layer 전체에 공통인 256-channel group이라고 가정합니다.
- `ffn_split_chunks=2`는 동일 FFN dimension을 두 번 나눠 계산하는 것으로 모델링합니다.
- `Common resident weights`, selector latency, patch latency, compute time은 calibration 입력입니다.
- Full 20B NAND 크기는 2-bit와 packing overhead만 사용한 추정치입니다.
- Colibri Prefill은 analytic estimate이며 continuous batching은 아직 구현되지 않았습니다.
- 실제 제품 비교에는 대상 장비의 NAND/SSD service curve와 compute 실측값이 필요합니다.

상세 AFM 3 가정은 [`docs/afm3-model.md`](docs/afm3-model.md)를 참고하십시오.
