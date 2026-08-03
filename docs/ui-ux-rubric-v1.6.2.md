# UI/UX Rubric — ShadCN Base UI + Token Storage I/O

## 평가 범위

이 문서는 `feat/shadcn-base-token-io` 브랜치의 코드 기반 UI/UX release gate입니다. 점수는 구현 계약, 정적 구조, 자동화 테스트와 계산 경계를 기준으로 합니다. 실제 사용자 연구, 스크린리더 기기별 검증, 브라우저별 시각 회귀는 별도 검증 항목이며 이 문서만으로 완료되었다고 주장하지 않습니다.

## 결과

**코드 기반 Rubric: 95.7 / 100**

| 영역 | 가중치 | 점수 | 근거 |
| --- | ---: | ---: | --- |
| 시각적 일관성과 디자인 시스템 | 12% | 9.6 | ShadCN semantic token을 `ui-shadcn.css`에 정적으로 분리하고 light/dark theme, focus ring, card/button/input 상태를 통합 |
| 정보 구조와 화면 계층 | 12% | 9.4 | 실행·재생·스윕을 primary 작업으로 유지하고 테스트·JSON·기준값 기능을 `관리 및 내보내기` overflow로 분리 |
| 핵심 작업 효율성 | 12% | 9.5 | 토큰 생성과 I/O 동기화, 최근 토큰 자동 추적, 이전/다음/range/canvas 탐색, latest-follow 복귀 제공 |
| 데이터 시각화 품질 | 15% | 9.7 | stacked I/O, TPOT overlay, P95/linear scale, clipped outlier 표시, 최근 64개 및 최대 128 bucket 전체 집계 |
| 시스템 상태와 피드백 | 10% | 9.6 | TTFT 준비·실행·일시정지·완료·오류 badge와 진행량, 선택 토큰 상세 제공 |
| 접근성 | 12% | 9.6 | skip link, canvas keyboard 탐색, visible inspector, accessible table, throttled live region, pattern encoding, forced-colors 지원 |
| 반응형 대응 | 10% | 9.5 | 모바일 최근 24개 제한, 44px controls, inspector/detail 재배치, overflow menu의 inline 전환 |
| 오류 예방과 결과 신뢰성 | 7% | 9.8 | Colibri `demandGB`/`ssdGB`와 AFM `readGB`를 mode별로 분리해 fallback 중복 합산 방지, prefill 제외 경계 명시 |
| 성능과 확장성 | 5% | 9.4 | trace 값 1회 계산, requestAnimationFrame coalescing, ResizeObserver, 최대 128 visible groups, table lazy rendering |
| 유지보수성과 UI 아키텍처 | 5% | 9.6 | playback orchestration, pure I/O model/chart module, static CSS, release allowlist, unit contracts 분리 |

가중 합계:

```text
11.52 + 11.28 + 11.40 + 14.55 + 9.60
+ 11.52 + 9.50 + 6.86 + 4.70 + 4.80
= 95.73
```

## 해결된 P0 항목

- Canvas 데이터와 동일한 접근 가능한 토큰별 표 제공
- 1,024 토큰을 최근 64개 또는 최대 128개 평균 bucket으로 제한
- 단일 outlier가 일반 토큰을 평탄화하지 않도록 P95 scale 제공
- `demandGB`, `ssdGB`, `readGB`를 동시에 합산하지 않는 mode-specific 계약
- pointer-only tooltip에서 keyboard/range/button 탐색으로 확장
- 색상 외 Swap-in/Swap-out hatch pattern 제공
- 매 토큰 전체 trace 재계산 제거
- inline runtime CSS 문자열 제거
- 신규 JS/CSS를 release allowlist에 포함

## 자동 검증

`tests/ui-token-io.test.cjs`는 다음을 검증합니다.

1. `playback.js`와 `token-io.js` JavaScript 구문
2. 토큰 emit과 chart lifecycle 상태 연결
3. Colibri/AFM별 demand field 우선순위와 중복 방지
4. 1,024 token recent/all aggregation 상한
5. P95 outlier scale
6. keyboard, accessible table, live-region throttling, hatch, forced-colors, skip link
7. static semantic CSS와 release bundle 포함 여부

## 최종 승인 조건

다음 조건을 모두 만족해야 이 점수를 최종 UI/UX 점수로 확정합니다.

- GitHub Actions `validate` 성공
- 일반 데스크톱 1366×768과 1920×1080에서 horizontal overflow 없음
- 모바일 390×844에서 primary 실행 및 token inspector touch target 확인
- Dark/Light theme chart 재렌더 확인
- 키보드만으로 실행 → chart focus → 토큰 이동 → accessible table 열기 가능
- Chrome 또는 Edge에서 1,024 token, 100× playback 시 주 UI가 응답 가능

자동화되지 않은 조건이 실패하면 해당 Rubric 영역을 다시 감점하고 수정합니다.
