# TODO.md — 적용 가능한 작업 목록

> `features.md` 분석 결과를 실행 가능한 TODO로 정리. 근거는 각 항목의 `path:line`. AGENTS.md 룰 준수(테스트는 `checks/` 전용, `npm run build` 금지, TSL/WebGPU only).

범례: **[P0]** 즉시 / **[P1]** 높음 / **[P2]** 보통 / **[P3]** 낮음 · 예상 공수: S(<1h) M(반나절) L(1일+)

---

## 성능 — 렌더 루프

- [ ] **[P1 | M] GPU 피킹으로 인스턴스 선택 레이캐스트 대체**
  근거: `renderer/controls/selection/instance-raycast.ts:110` — 인스턴스 BVH가 매트릭스 버전 변경마다 rebuild + CPU 레이캐스트.
  작업: 인스턴스 id 인코딩 오프스크린 패스 → `renderer.readRenderTargetPixelsAsync`. 기존 `controls/selection/head-painter-gpu-preview.ts:6-8`의 storage/atomic 패턴 재사용.
  완료기준: 대형 인스턴스 씬에서 클릭 응답이 메인 스레드 블로킹 없이 처리. 기즈모 hover는 BVH 유지(하이브리드).
  주의: WebGPU readback은 비동기 — 즉각 피드백 경로 혼합 금지.

- [ ] **[P1 | S] 프레임 루프 idle 스킵**
  근거: `renderer/renderer.ts:690-723` — 씬/카메라 무변경 시에도 매 프레임 렌더.
  작업: dirty 플래그 + 연속 N프레임(3) 무변경 시 렌더 스킵. 컨트롤 갱신·ViewHelper 애니메이션 중은 항상 렌더.
  완료기준: 정지 상태에서 GPU 점유 0. 기존 `pde:wait-render-settled` 트레이스가 스킵 카운트를 인식.

- [ ] **[P1 | M] head-painter 모듈 분리 + 지연 로딩**
  근거: `renderer/ui/head-painter.ts` 2869줄(최대 파일). 내부에 model-generator 등 독립 lifecycle 섹션 존재.
  작업: `head-painter-model-generator.ts` 분리 → `initHeadPainter`(`renderer/renderer.ts:537`) 호출부를 dynamic `import()`로.
  완료기준: 초기 번들에서 head-painter 코드 제외, 패널 열 때 로드.

- [ ] **[P2 | L] scene-parser / gizmo 2차 분리**
  근거: `renderer/load-project/scene/scene-parser.ts` 2518줄, `renderer/controls/gizmo/gizmo.ts` 2228줄.
  작업: gizmo는 `gizmo-commands`/`gizmo-setup`/`smart-scale`/`blockbench-scale` 외 나머지 분리 검토. scene-parser는 책임 단위 분리.
  완료기준: 단일 파일 1500줄 이하.

---

## 성능 — 에셋 파이프라인

- [ ] **[P1 | M] 아이콘 아틀라스: 메인 렌더러 리사이즈 제거**
  근거: `renderer/ui/item-icon-atlas.ts:470-488` — `renderer.setSize`로 메인 뷰포트를 임시 리사이즈 후 `drawImage(renderer.domElement)` 캡처.
  작업: 아이콘 굽기 전용 WebGPURenderer 오프스크린 생성/dispose, 또는 main 프로세스 생성 후 PNG IPC.
  완료기준: 아틀라스 생성 중 메인 캔버스 크기/내용 불변.

- [ ] **[P2 | S] 텍스처 아틀라스 캐시 키 해시화**
  근거: `renderer/load-project/scene/texture-atlas-builder.ts:119` — 캐시 키 = 텍스처 경로 조인(대형 프로젝트에서 수천 자).
  작업: fnv1a 등 32비트 해시로 키 단축.
  완료기준: 키 길이 상한 고정, 캐시 히트율 동일.

- [ ] **[P2 | M] 유니폰트 폰트 사전 컴파일**
  근거: `renderer/load-project/display/text-display.ts:309-349` — `resources/unifont-17.0.01.hex`를 매 로드 시 파싱 후 캔버스 구움.
  작업: 글리프 인덱스를 JSON/바이너리로 사전 컴파일 → `hardcoded/`에 편입.
  완료기준: 초기 로드에서 hex 파싱 루프 제거.

---

## 코드 품질 / 유지보수

- [ ] **[P1 | M] IPC 브리지 타입 단일 소스화**
  근거: `preload.ts`(노출 객체) ↔ `renderer/global.d.ts`(수동 타입) 동기화 누락 위험.
  작업: preload 채널 정의를 `as const satisfies`로 두고 타입 추론/코드젠으로 d.ts 파생.
  완료기준: 채널 추가 시 preload 한 곳만 수정.

- [ ] **[P1 | M] pde-format 버전 1~4 마이그레이션 회귀 테스트**
  근거: `renderer/save/pde-format.ts:125-247` — 버전 마이그레이션이 한 함수에 인라인, 테스트 부재.
  작업: 버전별 fixture 스냅샷 + 라운드트립(load→save→load) 검증. **테스트 파일은 `checks/` 하위에만**(AGENTS.md 룰).
  완료기준: 4버전 fixture 모두 validate/encode 통과.

- [ ] **[P2 | S] 선택 캐시 key → 버전 카운터**
  근거: `renderer/controls/selection/select.ts:62-78` — `_getSelectionCacheKey`가 호출마다 전체 선택 Set을 문자열 변환.
  작업: `invalidateSelectionCaches()` 호출 지점 전수 감사 후, 변경 지점에서만 invalidate + key 문자열 대신 버전 카운터 비교.
  완료기준: 다중 선택(수백 객체)에서 key 문자열 생성 제거.

- [ ] **[P2 | S] 설정 씬 상태 1초 폴링 제거**
  근거: `renderer/ui/setting.ts:485-487` — `setInterval(1000)`.
  작업: `pde:scene-updated` 리스너(이미 `:481`에 존재) + 패널 가시성 체크로 대체. 필요 시 보조 폴링만 유지.
  완료기준: 상시 폴링 제거, 표시 갱신 누락 없음.

- [ ] **[P2 | S] `entityVisiblePosition` 1e10 hide 관용구 문서화**
  근거: `renderer/entity-material.ts:101-103` — 인스턴스 숨김 오프셋 방식.
  작업: TSL 관용구로 AGENTS.md(또는 신규 아키텍처 문서)에 패턴 + 이유 수록.

- [ ] **[P3 | S] `renderer/save/` main 실행 환경 명시**
  근거: `renderer/save/project-file-store.ts` 등이 main 프로세스에서 구동.
  작업: 디렉터리 책임 주석 명시(기술적 이유 또는 `shared/` 승격 검토).

---

## UX / 기능

- [ ] **[P2 | M] 로딩/에러 메시지 i18n 레이어**
  근거: "팽치가 모장에서 뛰어오는중" 등이 `main.ts:829` 외 다수에 하드코딩.
  작업: 메시지 맵 도입 → 호출부 교체. 번들 영향 미미.
  완료기준: 사용자 대면 문자열이 맵 경유.

- [ ] **[P3 | S] `npm run build`에 타입체크 연결(가드)**
  근거: `package.json:10` — `build`가 `vite build` 단독(타입체크 우회). AGENTS.md는 사용 금지이나 스크립트 자체는 존재.
  작업: `build` 스크립트를 `tsc --noEmit && vite build`로 교체(또는 prebuild 훅).
  주의: 기존 워크플로우 영향 확인 후 적용. 검증 명령은 여전히 `npm run compile:electron`/`npx tsc --noEmit`.

---

## 인프라

- [ ] **[P1 | S] CI 타입체크 워크플로우**
  작업: GitHub Actions에서 `npx tsc --noEmit` + `npm run compile:electron` 실행.
  완료기준: PR마다 타입 안전성 검증.

- [ ] **[P3 | S] 번들 사이즈 모니터링**
  근거: 커밋 `570b526`(THREE 제거)처럼 번들 크기가 민감 영역.
  작업: `renderer-dist` 크기 리포트 + 증가분 경고.

---

## 완료된 항목 / 제외

- ~~node_modules 설치 확인~~ — 환경 셋업 이슈이며 리팩터링 대상 아님. `npm ci`로 해결.
