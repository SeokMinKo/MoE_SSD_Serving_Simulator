# V1.6 UI/UX 개선 명세 — 5분 병목 분석 워크플로

## 목표

시스템 엔지니어가 5분 안에 (1) 모델·HW·workload를 구성하고, (2) 구조별 결과와 병목을 확인하고, (3) 상위 병목을 완화했을 때의 **실제 counterfactual simulation 기반** aggregate TPS 개선 범위와 trade-off를 확인한다.

## 제품 원칙

- 1차 사용자는 시스템 엔지니어다.
- 목적함수는 aggregate TPS 최대화다.
- 모델 구조 간 순위 비교보다 동일 구조에서 HW·정책 비교를 우선한다.
- Advisor 압력 점수를 개선률로 표현하지 않는다. 개선량은 실제 sweep 결과만 사용한다.
- V3 artifact, Run ID, simulator config 의미론, import/export, baseline, App integrity test, full Sweep Lab 기능을 유지한다.
- UI 기본 언어는 한국어이고 기술 용어와 단위는 영어를 유지한다.
- 제품 경계는 `Estimated sensitivity simulator / Unvalidated Alpha`로 계속 명시한다.

## 기본 정보 구조

### 1단계 — 시나리오 설정

- 실행 엔진, topology preset, HW preset, architecture, 핵심 workload를 우선 노출한다.
- HW preset은 synthetic template임을 명시하며 실측 calibration으로 오인시키지 않는다.
- JSON import를 같은 단계에서 제공한다.
- 나머지 calibration·memory·cache·compute·prefetch 입력은 `Expert mode`에서만 노출한다.

### 2단계 — 결과와 병목

- aggregate TPS를 가장 높은 우선순위의 KPI로 표시한다.
- TTFT, TPOT, Storage/token, cache hit, memory를 보조 KPI로 표시한다.
- phase/resource pressure는 상대 압력임을 유지한다.
- 상위 병목 2개를 중복 resource 없이 선정하고 근거·trade-off를 보여준다.

### 3단계 — 개선 검증

- 상위 병목 2개에 대응하는 parameter를 선택한다.
- 각 parameter는 baseline 포함 최대 5개 auto OAT 값으로 실행한다.
- 결과는 실제 completed scenario의 aggregate TPS만 사용해 baseline 대비 개선률과 범위를 계산한다.
- OOM/invalid point는 개선값으로 취급하지 않는다.
- 전체 Sweep Lab은 계속 접근 가능해야 한다.

## HW preset 계약

- `custom`: 현재 입력을 보존한다.
- synthetic discrete baseline: architecture/RAM/VRAM/DRAM/PCIe/SSD/latency/QD만 변경한다.
- synthetic unified baseline: architecture/RAM/DRAM/SSD/latency를 변경하고 엔진 config 규칙을 보존한다.
- preset은 모델 topology, workload, memory policy, compute calibration을 변경하지 않는다.
- import 또는 수동 HW 편집 후 preset attribution은 `custom`으로 돌아간다.

## 시각 디자인 rubric (100)

- 정보 구조와 3단계 진행성 25
- 병목→검증 action 연결 20
- KPI 및 결과 hierarchy 15
- 입력 밀도와 progressive disclosure 15
- 한국어 일관성·기술 용어 정확성 10
- 접근성(44px, focus, non-color state, reduced motion) 10
- desktop/narrow viewport 무가로 overflow 5

각 영역 80% 이상, 전체 85점 이상을 목표로 한다. 점수는 실제 브라우저 evidence와 동일 rubric의 fresh review 없이는 완료로 선언하지 않는다.

## RED 계약

1. `guidedWorkflow`, `expertModeToggle`, `hardwarePreset`, `guidedAnalysis`, `runGuidedSweep` landmark가 존재한다.
2. 3단계 navigation은 현재 단계를 non-color state와 `aria-current="step"`으로 표현한다.
3. 기본 상태에서 advanced controls는 숨고 Expert mode로 복원된다.
4. 상위 병목 선정은 resource를 dedupe하고 최대 2개만 반환한다.
5. 병목→parameter mapping은 현재 engine/architecture에서 sweep 가능한 parameter만 반환한다.
6. 자동 OAT는 각 parameter당 최대 5개 값이며 baseline과 다른 scenario가 존재한다.
7. 개선률은 completed baseline과 completed sweep metrics에서만 계산하며 pressure score를 사용하지 않는다.
8. Guided 결과는 `guided-oat/v1` provenance가 현재 상위 2개 병목·parameter·value contract와 일치할 때만 표시한다. Full Sweep Lab의 임의 OAT/Grid 결과는 Guided 결과로 승격하지 않는다.
9. Unified HW preset은 dormant discrete controls(VRAM/PCIe/QD)를 보존한다.
10. Guided navigation은 `prefers-reduced-motion`에서 smooth scroll을 사용하지 않는다.
11. 기존 script IDs와 V3 behavior는 유지된다.
