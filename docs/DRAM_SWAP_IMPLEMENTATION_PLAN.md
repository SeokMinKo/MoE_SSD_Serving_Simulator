# V1.3 DRAM·Memory Pressure·Swap 구현 계획

## 1. 목표

V1.2의 정적 메모리 예산 검사를 확장하여 다음 현상을 토큰 단위로 재현한다.

1. Expert Cache와 KV Cache가 증가하면서 Physical DRAM 여유가 감소한다.
2. 설정한 Soft Pressure, Compression, Swap, Hard Pressure 임계점에 따라 회수 정책이 단계적으로 실행된다.
3. Page Cache와 file-backed Expert는 우선 폐기하고, anonymous Expert/KV만 Swap 대상으로 취급한다.
4. Swap-in/out이 Expert demand/prefetch와 동일 SSD/NAND queue를 공유한다.
5. Swap 및 Expert load가 DRAM bandwidth를 사용하여 Decode TPOT를 증가시킨다.
6. Token별 DRAM 사용량, Swap traffic, DRAM traffic, pressure state를 출력한다.

이 버전의 목적은 OS의 페이지 교체를 정확히 복제하는 것이 아니라, 메모리 용량·Cache 배분·Swap 임계점·DRAM 대역폭 변화에 따른 **방향성과 병목 전환**을 분석하는 것이다.

---

## 2. V1.2 현황과 결손

V1.2는 다음 기능을 이미 제공한다.

- Host/Unified Memory와 VRAM의 정적 용량 검사
- Colibri Demand/Prefetch 공유 SSD timeline
- AFM 3의 32-token window와 delta loading
- DRAM bandwidth를 일부 PCIe 전송 상한에 사용

그러나 다음은 없다.

- Token별 memory footprint
- Page Cache reclaim
- Expert Cache 동적 shrink
- Compression
- Swap-out / Swap-in
- Swap과 Expert I/O의 queue contention
- Swap traffic과 Decode traffic의 DRAM bandwidth contention
- Swap onset token과 Thrashing 지표

---

## 3. 메모리 분류

### 3.1 고정·회수 불가

- OS Reserved
- Runtime Workspace
- Pinned Hot Experts
- AFM Shared Experts
- AFM Current Routed Set
- GPU Workspace

### 3.2 회수 가능 file-backed

- OS Page Cache
- Colibri DRAM Expert Cache가 `file-backed`인 경우

회수 시 Swap write 없이 제거하고, 다음 접근 때 원본 Expert 파일에서 다시 읽는다.

### 3.3 anonymous / swappable

- KV Cache
- Colibri DRAM Expert Cache가 `anonymous`인 경우
- Unpacked/materialized temporary buffers

압축 또는 Swap 대상이다.

---

## 4. Memory Pressure 상태

사용률과 최소 여유 메모리를 동시에 적용한다.

```text
Effective threshold GB = min(
  Physical Memory × threshold ratio,
  Physical Memory − Minimum Free Headroom
)
```

상태:

1. `NORMAL`: Soft threshold 미만
2. `RECLAIM`: Page Cache 및 file-backed Expert Cache 회수
3. `COMPRESS`: anonymous memory 일부 압축
4. `SWAP`: anonymous memory를 SSD/NAND로 page-out
5. `THRASH`: Hard threshold 초과 또는 동일 working set의 반복 page-in/out
6. `OOM`: 회수·압축·Swap으로도 hard limit을 만족하지 못함

기본 임계점은 Simulator calibration 값이며 OS 기본값으로 주장하지 않는다.

- Soft: 80%
- Compression: 85%
- Swap: 90%
- Hard: 97%
- Minimum Free Headroom: 8GB

---

## 5. 회수 순서

### 5.1 Colibri

1. Page Cache LRU 제거
2. DRAM Expert Cache가 file-backed이면 최소 cache 크기까지 LRU 제거
3. Compression 활성화 시 KV/anonymous Expert 일부 압축
4. anonymous Expert LRU를 Swap-out
5. KV Cache를 Swap-out
6. Hard limit 초과 시 OOM 또는 Thrash 상태

### 5.2 AFM 3

1. 일반 Page Cache가 있으면 제거
2. Optional next-window double buffer 해제 가능 여부 확인
3. KV Cache 압축
4. KV Cache Swap-out
5. Shared/Current Routed Expert는 pinned로 유지

---

## 6. Storage Resource 통합

기존 SSD resource를 read/write 공용 queue로 확장한다.

Request 종류:

- `expert-demand-read`
- `expert-prefetch-read`
- `afm-window-read`
- `swap-in-read`
- `swap-out-write`

모든 요청은 같은 `availableAt` timeline을 공유한다. Swap write는 기본적으로 Expert read와 동일 장치를 사용하며, write bandwidth multiplier를 설정할 수 있다.

```text
Service Time = command latency + bytes / effective operation bandwidth
```

Background Swap-out은 현재 Token 완료를 직접 기다리지 않을 수 있지만, SSD timeline을 점유하여 이후 Token의 Demand read를 지연시킨다.

---

## 7. DRAM Resource 모델

Token마다 DRAM traffic을 계산한다.

### 7.1 Colibri Unified Memory

- Active Expert weight reads
- Resident common weight reads
- KV read/write
- SSD Expert load writes
- Swap-in writes
- Swap-out reads
- Compression read/write

### 7.2 Colibri Discrete GPU

- Host Expert → GPU DMA reads
- SSD Expert load writes
- KV가 Host에 있는 경우 KV traffic
- Swap traffic

GPU VRAM bandwidth는 V1.3 범위 밖이며 별도 후속 항목이다.

### 7.3 AFM 3 Unified Memory

- Active Shared + Routed weight reads
- Common resident weight reads
- KV traffic
- Window load writes 및 patch traffic
- Swap traffic

Token critical path에 다음 floor를 적용한다.

```text
DRAM Floor Time = DRAM Traffic GB / Effective DRAM BW × 1000
Final TPOT = max(Storage/Compute Critical Path, DRAM Floor Time)
```

이 방식은 DRAM traffic을 compute 시간에 단순 가산하지 않아 기존 calibration 시간을 이중 계상하지 않는다.

---

## 8. Swap Working Set 모델

### 8.1 Expert

anonymous Expert가 Swap-out되면 Expert key를 `swappedExpertSet`에 저장한다.

- 다음 routing에서 해당 Expert가 선택되면 Swap-in read
- Swap-in 완료 후 DRAM Expert Cache에 재삽입
- 원본 Expert demand read와 구분하여 집계

### 8.2 KV

Decode는 이전 KV를 반복 접근하므로, swapped KV는 매 Token 시작 시 설정된 `KV touch fraction`만큼 Swap-in된다.

- 기본 touch fraction: 100%
- Memory pressure가 계속되면 Token 종료 시 다시 Swap-out될 수 있다.
- 반복 page-in/out은 Thrash traffic으로 집계한다.

---

## 9. UI 입력

### Memory Pressure Policy

- Policy: Strict / Reclaim / Compression + Swap
- Background application usage GB
- OS Reserved GB
- Minimum free headroom GB
- Soft pressure trigger %
- Compression trigger %
- Swap trigger %
- Hard pressure trigger %
- Swap capacity GB
- Swap enabled
- Compression enabled
- Compression ratio
- Compression bandwidth GB/s
- Swap write bandwidth ratio
- KV touch fraction

### Colibri-specific

- DRAM Expert backing: file-backed / anonymous
- Minimum DRAM Expert Cache GB

### AFM-specific

- Current Expert sets pinned: fixed ON in V1.3
- Double buffer remains existing option

---

## 10. 출력

### KPI/표

- Peak Physical Memory
- Minimum Free Headroom
- Swap Start Token
- Total Swap-in / Swap-out
- Peak Swap Resident
- Page Cache Reclaimed
- Expert Cache Reclaimed
- Compression Saved
- Average / Peak DRAM BW
- DRAM Stall per Token
- Thrash Ratio
- Pressure State

### Token trace

각 Token에 다음 snapshot을 저장한다.

- physicalUsedGB
- expertCacheGB
- pageCacheGB
- kvResidentGB
- compressedGB
- swappedGB
- freeGB
- pressureState
- swapInGB
- swapOutGB
- dramTrafficGB
- dramUtilization
- dramStallMs

### 시각화

기존 TPOT 그래프와 별도로 `Memory / Swap trace`를 추가한다.

- Physical Memory Used
- Swap Resident
- Swap trigger line
- Hard trigger line

---

## 11. 검증 계획

1. 임계점 이하에서 Swap 0
2. Page Cache가 Swap보다 먼저 회수됨
3. file-backed Expert reclaim은 Swap write를 만들지 않음
4. anonymous Expert reclaim은 Swap write를 만듦
5. Swap traffic은 Expert SSD traffic과 같은 queue를 점유함
6. 낮은 DRAM BW는 동일 조건에서 TPS를 높이지 않음
7. DRAM slowdown 적용 후 effective DRAM throughput이 설정 BW를 넘지 않음
8. Swap trigger를 낮추면 Swap start token이 같거나 빨라짐
9. Memory 용량 증가 시 Swap start token이 같거나 늦어짐
10. AFM Shared/Routed weight는 Swap 대상이 아님
11. KV thrashing scenario에서 Swap-in/out이 모두 발생
12. 동일 seed와 설정에서 결과 재현
13. 1.5 TPS playback 666.7ms 유지

---

# 계획 검토

## A. 정합성 검토

### 발견 1: Expert Cache 전체를 Swap 대상으로 보면 과대평가

Expert가 file-backed clean page인 경우 OS는 Swap write 없이 폐기할 수 있다.

**정비:** `Expert backing`을 file-backed와 anonymous로 분리하고, 기본값은 file-backed로 둔다.

### 발견 2: Swap-out을 Token critical path에 모두 더하면 과대평가

OS page-out은 background로 실행될 수 있다.

**정비:** Swap-out은 Storage queue를 점유하지만 현재 Token 완료를 반드시 기다리지는 않는다. 다음 Token I/O에 contention으로 반영한다. Hard pressure에서만 synchronous penalty를 허용한다.

### 발견 3: 기존 compute ms에 DRAM service time을 더하면 이중 계상

사용자 입력 compute time은 이미 일부 memory stall을 포함할 수 있다.

**정비:** DRAM traffic 시간은 가산이 아니라 `max(base critical path, DRAM floor)`로 적용한다.

### 발견 4: KV 전체를 매번 Swap-in하면 극단적 thrash

실제로는 page 단위 working set이 다를 수 있다.

**정비:** `KV touch fraction`을 입력으로 두고 기본 100%, sensitivity 분석 가능하게 한다.

### 발견 5: Capacity trigger와 free-headroom trigger가 충돌 가능

**정비:** 둘 중 더 보수적인 threshold를 사용한다.

## B. 구현 복잡도 검토

### 초기 안의 문제

완전한 page-level OS simulator는 현재 단일 HTML 구조에서 과도하다.

### 정비된 범위

- Expert는 entry 단위
- KV/Compression은 aggregate GB 단위
- Storage는 aggregate resource timeline
- DRAM은 token-level roofline floor
- 회수 정책은 deterministic priority

이 범위는 트렌드 분석 목적에 맞고 계산량도 제한적이다.

## C. 최종 구현 순서

1. V1.2 코드를 `index.html + app.js` 기준으로 로컬 재구성
2. UI에 Memory Pressure 설정 추가
3. `StorageResource` read/write 통합
4. LRU dynamic shrink 및 swapped Expert directory 추가
5. `MemoryPressureManager` 구현
6. Colibri token loop에 Swap-in/out 및 memory snapshot 통합
7. AFM token loop에 KV pressure와 DRAM floor 통합
8. Memory/Swap chart와 결과표 추가
9. Self-test 확대
10. 정적 JS syntax 검사 및 headless runtime 검증
11. GitHub main 업데이트
12. GitHub 재조회로 반영 확인

---

## 12. 제한사항

- Linux, macOS, Windows의 실제 VM 정책을 그대로 재현하지 않는다.
- Swap compression algorithm, page size, readahead, zswap/zram/APFS compression 차이는 calibration parameter로 추상화한다.
- GPU VRAM oversubscription과 GPU page migration은 별도 모델이다.
- DRAM traffic 추정은 weight/KV traffic 기반 집계형 모델이다.
- 결과는 절대값보다 병목 전환과 상대 변화 분석에 사용한다.
