# features.md — 개선·최적화 기회 목록

> PDE(Pangch Display Editor) 코드베이스 분석 기반. 우선순위는 예상 임팩트/비용 관점의 제안일 뿐, 실제 우선순위는 별도 판단.

---

## 1. 성능 — 프론트엔드 렌더 루프

### 1.1 GPU 피킹으로 선택 레이캐스트 대체 (높은 임팩트)
- 현황: `controls/selection/instance-raycast.ts`가 인스턴스당 BVH(leaf 12)를 CPU에서 매 rebuild(매트릭스 버전 변경 시)하고, `MeshBasicMaterial` 기반 CPU 레이캐스트를 수행. 수천 인스턴스 씬에서 드래그/클릭 시 메인 스레드 블록.
- 아이디어: 인스턴스 id를 `uv`/attribute로 인코딩한 오프스크린 패스 → `renderer.readRenderTargetPixelsAsync`(또는 storage buffer)로 1픽셀 읽기. 기존에 이미 `head-painter-gpu-preview.ts`에서 WebGPU compute/storage 패턴(atomicStore, storage 버퍼)을 쓰고 있으므로 인프라 재사용 가능.
- 주의: WebGPU readback은 비동기. 기즈모 hover 등 즉각 피드백 경로는 기존 BVH 유지 + 하이브리드.

### 1.2 프레임 루프 idle 스킵
- 현황: `renderer.ts`의 `animate()`가 매 프레임 `requestAnimationFrame` → 씬 변경 없어도 렌더. 뷰포트 정지 상태에서도 GPU 점유.
- 아이디어: 무변경 프레임 카운터. 씬/카메라/컨트롤 dirty 플래그가 N프레임(예: 3) 연속 false면 렌더 스킵. OrbitControls 업데이트·애니메이션 중이면 항상 렌더. 노트북 배터리 직결 이슈.
- 트레이스 기능(`pde:wait-render-settled`)은 skip 도입 시 카운트 로직이 이미 존재하니 연동 용이.

### 1.3 head-painter UI 모듈 분리 (2869줄 — 최대 파일)
- `ui/head-painter.ts` 2869줄, 153KB. 초기 로드 시 구문 분석/번들 비용 큼. 내부에 model-generator 섹션, brush 에디터, 파일 import 등 독립 lifecycle 존재.
- 아이디어: `head-painter-model-generator.ts` 등으로 분리 + dynamic `import()` 지연 로딩 (head painter 패널을 열 때). `renderer.ts`의 `initHeadPainter`가 이미 명시적 호출 지점이라 적용 쉬움.

### 1.4 scene-parser / gizmo 분리
- `scene-parser.ts` 2518줄, `gizmo.ts` 2228줄. `controls/gizmo/`는 이미 디렉터리 분할돼 있으나 `gizmo.ts` 자체가 너무 큼. `gizmo-commands`/`gizmo-setup`/`smart-scale`/`blockbench-scale`로 2차 분리 검토.

---

## 2. 성능 — 에셋/텍스처 파이프라인

### 2.1 아이콘 아틀라스 생성: 메인 스레드 제거
- 현황: `ui/item-icon-atlas.ts`의 `buildAtlases`가 `renderer.setSize`로 **메인 뷰포트 렌더러를 임시 리사이즈**해 아이콘을 굽고, `drawImage(renderer.domElement)`로 캡처. 로딩 중 메인 캔버스가 튀고, 아틀라스 rebuild 전체가 블로킹.
- 아이디어: 아이콘 굽기 전용 오프스크린 WebGPURenderer(별도 canvas/dispose). 또는 아이콘 아틀라스를 **Electron main 프로세스에서 생성** 후 IPC로 결과 PNG만 전달 — 렌더러는 로딩 중 다른 초기화 가능.

### 2.2 텍스처 아틀라스 로더 동시성 + 캐시 지속성
- 현황: `loadTexturesWithLimit`은 `MAX_ATLAS_TEXTURE_LOAD_CONCURRENCY` 제한의 프라미스 풀. 아틀라스 캐시 키 = 경로 조인 문자열이라 **대형 프로젝트에서 키 문자열 자체가 수천 자**.
- 아이디어: 경로 해시(fnv 등 32bit)로 캐시 키 단축. `iconAssetPromises` 맵은 이미 잘 돼 있음.

### 2.3 `text-display` 유니코드 폰트 아틀라스 지연 생성
- `text-display.ts`가 사용된 문자만 캔버스에 구움(잘 된 설계). 단 폰트 소스(`unifont-17.0.01.hex`) 파싱이 매 로드 시 진행. 폰트 원문을 파싱 → **바이너리/JSON 인덱스로 사전 컴파일**해 `hardcoded/`에 넣으면 초기 로딩 단축.

---

## 3. 코드 품질/유지보수

### 3.1 IPC 브리지 타입 자동 생성
- 현황: `preload.ts`(노출) ↔ `global.d.ts`(타입) 수동 동기화. 채널 추가 시 2~3곳 수정 누락 위험.
- 아이디어: preload의 채널 정의 객체를 단일 소스로 두고 타입 추론(`as const satisfies`)으로 d.ts 자동 파생. 또는 코드젠 스크립트.

### 3.2 pde-format.ts 마이그레이션 테스트
- 버전 1~4 마이그레이션이 `validatePdeProject` 한 함수에 인라인. 회귀 테스트가 없어서 포맷 변경 시 이전 파일 호환성 검증 불가.
- 아이디어: 버전별 스냅샷 fixture(`checks/` 하위, AGENTS.md 룰상 테스트는 checks/ 전용) + 라운드트립 검증.

### 3.3 `entityVisiblePosition` 1e10 hide trick 문서화
- `float(1).sub(visible).mul(1e10)` 오프셋 방식은 `renderer.ts` 주석에 "숨김"이 명시돼 있으나 팀 내 온보딩 문서 부재. TSL 관용구로 AGENTS.md 또는 아키텍처 문서에 패턴 수록.

### 3.4 `save/` main-의존 구조 정리
- `ProjectFileStore`/`AutoSaveFileStore` 등이 main에서 구동되는데 `renderer/save/` 하위에 위치. 디렉터리 의미와 실행 환경이 어긋남(기술적 이유 — preload/공유 코드 — 가 있다면 주석 명시, 없으면 `shared/` 승격 검토).

---

## 4. UX / 기능 개선 기회

### 4.1 선택 캐시 무효화 지점 명시화
- `select.ts`의 `_getSelectionCacheKey`가 호출마다 전체 선택 Set을 문자열로 변환(대형 다중 선택 시 문자열 비용). `invalidateSelectionCaches()` 호출 지점을 전수 감사 → 변경 지점에서만 invalidate + key 없이 버전 카운터 방식 검토.

### 4.2 설정 씬 상태 1초 폴링 제거
- `ui/setting.ts:485`의 `setInterval(1000)` — 씬 상태(오브젝트 수/메모리) 표시 갱신용. `pde:scene-updated` 이벤트 + 가시성 체크로 대체 가능하면 상시 폴링 제거.

### 4.3 로딩 메시지 국제화 기반 마련
- "팽치가 모장에서 뛰어오는중" 등이 main.ts/renderer.ts/setting.ts에 하드코딩. i18n 레이어(최소 메시지 맵) 도입 시 번들 크기 영향 미미하면서 유지보수성 향상.

### 4.4 `npm run build` 가드
- AGENTS.md에 "금지"로 돼 있으나 package.json에는 `build` 스크립트가 그대로 존재(타입체크 없음). `prebuild` 훅에 `tsc --noEmit`을 걸거나, build 스크립트를 `tsc && vite build`로 교체하면 실수 원천 차단. (기존 워크플로우를 깨뜨리지 않는 범위에서.)

---

## 5. 인프라

### 5.1 node_modules 미설치 상태
- 현재 워크스페이스에 `node_modules` 없음 → 어떤 검증 스크립트도 실제 실행 불가. CI 또는 최초 셋업 시 `npm ci` 필수 확인.

### 5.2 CI 워크플로우 부재
- 타입체크(`npx tsc --noEmit`)만으로도 회귀를 잡을 수 있음. GitHub Actions 워크플로우 추가 시 PR마다 타입 안전성 확보.

### 5.3 번들 사이즈 모니터링
- `570b526 THREE 제거` 커밋처럼 번들 크기가 민감 영역. `vite build` 후 `renderer-dist` 크기 리포트(예: 100KB 증가 시 경고) 정도의 린트 추가 검토.
