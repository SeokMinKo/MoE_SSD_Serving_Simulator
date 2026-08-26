# Mobile AP Roofline + Calibration

## 목적

이 모듈은 Galaxy S25/S26 계열의 Qualcomm AP에서 CPU/GPU/NPU로 LLM decode를 수행할 때, peak compute와 memory roofline을 실제 측정값으로 보정하기 위한 1차 계산 계층이다.

현재 구현은 기존 Colibri token/storage engine을 대체하지 않는다. 먼저 AP compute calibration과 측정 계약을 독립 모듈로 고정하고, 이후 Colibri device placement에 연결한다.

## 핵심 원칙

1. CPU/GPU/NPU의 peak 숫자를 동일한 의미의 TOPS로 취급하지 않는다.
2. CPU TOPS는 임의 생성하지 않는다.
3. Qualcomm 공식 product brief에 없는 절대 NPU TOPS는 `third-party`로 표시한다.
4. peak TOPS/FLOPS를 TPS로 직접 환산하지 않는다.
5. 절대 TPS에는 measured anchor 또는 workload geometry + efficiency가 필요하다.
6. NPU 실측 anchor가 없으면 TOPS만으로 NPU TPS를 자동 생성하지 않고 fail-closed한다.

## Hardware DB

### SM8750-AC / Snapdragon 8 Elite for Galaxy

- CPU: Qualcomm Oryon, Galaxy variant peak clock 4.47 GHz.
- GPU: Adreno 830. DB의 FP32 3.6864 TFLOPS는 high-clock variant의 third-party architecture/clock-derived 값이다.
- NPU: Hexagon, INT4/INT8/INT16/FP16 지원은 Qualcomm 공식 정보다.
- NPU 65.25 TOPS는 Qualcomm 공식 제품 자료의 절대 TOPS가 아니며 third-party 값으로만 보존한다.
- LPDDR theoretical 84.8 GB/s도 third-party-derived이며 effective LLM bandwidth로 사용하면 안 된다.

Official: https://www.qualcomm.com/smartphones/products/8-series/snapdragon-8-elite-mobile-platform

### SM8850 / Snapdragon 8 Elite Gen 5 for Galaxy

- CPU: 3rd Gen Qualcomm Oryon, 최대 4.74 GHz.
- Qualcomm 공식 relative uplift: CPU +20%, GPU +23%, NPU +37% vs previous generation.
- NPU precision: INT2/INT4/INT8/INT16/FP8/FP16.
- GPU: Adreno 840.
- DB의 GPU FP32 3.6864 TFLOPS와 NPU INT8 89.4 TOPS는 Qualcomm 공식 절대 peak가 아니므로 third-party로 표시한다.

Official: https://www.qualcomm.com/smartphones/products/8-series/snapdragon-8-elite-gen-5

Galaxy S26 platform confirmation: https://www.qualcomm.com/news/releases/2026/02/qualcomm-unveils-the-snapdragon-8-elite-gen-5-for-galaxy--drivin

## Calibration measurements v1

| Device/AP | Model | Backend | Offload | TPS | Compute | Exposed Flash Wait | Cache Hit | Expert Cache |
|---|---|---|---|---:|---:|---:|---:|---:|
| S26 / SM8850 | Gemma4 26B-A4B | CPU | MoE | 5.69 | 104 ms | 56 ms | 69% | 2000 MB |
| S26 / SM8850 | Qwen3.6 35B-A3B | CPU | MoE | 8.39 | 85 ms | 38 ms | 67% | unknown |
| S26 / SM8850 | Gemma4 E4B | GPU | none | 21.83 | unknown | 0 | n/a | n/a |
| S26 / SM8850 | Gemma4 E4B | CPU | none | 15.72 | unknown | 0 | n/a | n/a |
| S25 / SM8750 | Gemma4 26B-A4B | CPU | MoE | 5.26 | 103 ms | 69 ms | 69% | 2000 MB |

`Exposed Flash Wait`의 정의는 **Compute와 Flash model loading이 overlap된 뒤 Compute가 끝난 시점부터 Flash I/O 완료까지 남아 있는 순수 대기시간**이다.

따라서 측정 decomposition은 다음과 같다.

```text
TPOT = 1000 / TPS
Residual = TPOT - Compute - ExposedFlashWait
```

S26 Gemma4 26B-A4B:

```text
TPOT ~= 175.75 ms
Compute = 104 ms
Exposed Flash Wait = 56 ms
Residual ~= 15.75 ms
```

S25 Gemma4 26B-A4B:

```text
TPOT ~= 190.11 ms
Compute = 103 ms
Exposed Flash Wait = 69 ms
Residual ~= 18.11 ms
```

동일 모델/동일 AP의 Gemma4 E4B resident decode에서 SM8850 GPU/CPU measured TPS ratio는 약 1.389x이다. 이 값은 GPU prediction의 첫 measured calibration anchor이며 GPU peak FLOPS에서 유도한 값이 아니다.

## Roofline

```text
T_compute_roof = operations / (peak_ops * compute_efficiency)
T_memory_roof  = bytes / (memory_bw * memory_efficiency)
T_device       = max(T_compute_roof, T_memory_roof) + overhead
```

`compute_efficiency`와 `memory_efficiency`는 0~1 범위의 explicit calibration 값이어야 한다.

## Flash overlap

raw Flash timeline이 확보된 경우:

```text
hidden_by_compute = min(flash_ready_ms, compute_end_ms * overlap_efficiency)
exposed_flash_wait = max(0, flash_ready_ms - hidden_by_compute)
```

주의: 현재 사용자 측정의 `Flash Wait`는 이미 exposed wait이다. 이를 raw NAND/service latency로 재해석하면 안 된다.

Compute backend가 빨라지면 overlap window가 짧아져 exposed Flash wait가 늘어날 수 있으므로 CPU measured Flash Wait를 GPU/NPU에 그대로 보존하는 것은 sensitivity approximation일 뿐이다.

## CLI

```bash
npm run calibrate:mobile
```

Hardware evidence, 5개 calibration sample, TPOT decomposition, SM8850 Gemma4 E4B measured GPU/CPU ratio를 JSON으로 출력한다.

## 다음 연결 단계

- Colibri `compute` device enum을 CPU/GPU/NPU로 확장
- model workload geometry(ops/token, bytes/token, expert geometry) 입력 계약 추가
- raw Flash ready timeline을 token trace에 보존
- NPU measured sample 추가 후 NPU efficiency calibration
- CPU/GPU/NPU backend comparison UI 추가

이 단계 전까지 `mobile-ap-roofline.js`는 절대 NPU TPS를 자동 생성하지 않는다.
