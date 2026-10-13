# AGENTS.md

## Project Context

### Overview
- **PDE (Pangch Display Editor)** — Electron 데스크톱 앱. Minecraft `display` 엔티티(block_display / item_display / text_display / player_head) 기반 3D 모델링·애니메이션 에디터.
- 레포: `pangch-display-editor`. 산출물 패키지명 `pde-001` (NSIS exe / dmg).

### Tech Stack
- **Electron 44** — main/preload(NodeNext ESM) + Vite renderer(ESM) 2-프로세스 구조.
- **Vite 8** — root `./renderer`, outDir `../renderer-dist`, base `./` (프로덕션은 file:// 로딩).
- **TypeScript 7** — `tsconfig.json`(renderer, moduleResolution Bundler) + `tsconfig.electron.json`(main/preload, NodeNext, outDir `electron-dist`).
- **Three.js 0.186.1** — WebGPU만 사용.
- 의존성: `fflate`(zstd/gzip 아카이브), `yauzl`(jar), `axios`, `p-limit`.

### Core Technical Principles (Absolute Rules)
- **WebGPURenderer only** — `WebGLRenderer` 금지. 렌더러 생성은 `renderer/renderer.ts` 한 곳.
- **TSL only** — GLSL 금지. 머티리얼은 `MeshBasicNodeMaterial` + `three/tsl` 노드 조합 (`renderer/entity-material.ts`가 표준).
- **Three.js import 경로** — `three/webgpu`, `three/tsl`, `three/examples/jsm/...` 외 금지. core `three` import 금지 (번들 크기 회귀).
- **GLSL/GLSLMaterial, `ShaderMaterial` 금지** — GPU 디버깅 불가.

### Architecture

#### Main process (`main.ts`, `preload.ts`, `memory-cleanup.ts`, `minecraft-*.ts`)
- 창 생성 시 COOP/COEP 헤더 강제 (SharedArrayBuffer/fflate 워커용).
- **에셋 캐시 파이프라인** (`download-assets` IPC): Mojang client.jar → `userData/pde-asset-cache-v1/assets`; server.jar → **Java 바이트코드 직접 파싱** (`extractRegistryNames` / `extractCreativeItems`) → `item-block-list.json`(registry id + 크리에이티브 탭 순서). 하드코딩 모델은 `hardcoded/` 에서 보강.
- IPC handler들은 `event.sender !== win.webContents` 검증 필수. 경로 인자는 반드시 sanitize 후 `CACHE_DIR`/`HARDCODED_DIR` 내 resolve 확인.
- 저장: `renderer/save/*` 스토어 클래스들이 main에서 동작 (`ProjectFileStore`, `AutoSaveFileStore`, `McfunctionFileStore`, `ProjectClipboard`). .pde 저장은 zstd 압축 후 PRJ2 아카이브.
- 렌더러-메인 통신은 `preload.ts`의 `window.ipcApi` 브리지로만. `global.d.ts`에 타입 추가 필수 (양쪽 동기화).

#### Renderer
- 진입점: `renderer/index.html` → `renderer/renderer.ts` (`startApp()` → 에셋 준비 → `initScene()` → `animate()`).
- **씬/렌더**: `renderer.ts`가 scene·camera·renderer·controls 소유. `entityVisiblePositionNode`으로 1e10 오프셋 인스턴스 숨김(hide trick). 카메라 원근/직교 토글 상태는 localStorage(`pdeCameraType` 등).
- **퍼포먼스 트레이스 API**: `pde:precompile-scene` / `pde:wait-render-settled` CustomEvent → resolve 콜백으로 ms 트레이스 반환. `renderer.compileAsync` + `queue.onSubmittedWorkDone` 사용.
- **모듈 간 통신 = window CustomEvent `pde:*` 버스** (IPC 아님). 상태 변화는 이벤트로, 데이터는 모듈 직접 import. 이벤트명은 kebab-case 유지.
- **SoC 구조** (`renderer/`):
  - `controls/` — gizmo(TransformControls 래핑), vertex 변환(T/R/S), knife, mirroring, pivot(custom/shear-remove), selection(raycast/drag/overlay), grouping, undo-redo, input(shortcut/key/clipboard/camera).
  - `load-project/` — `pbde/`(프로젝트 파일 로드), `mcfunction/`(SNBT summon 명령 임포트), `scene/`(아이템 모델 파싱·아틀라스), `display/`(mesh-builder, instancing, text-display), `batching/`(geometry/instance 배칭).
  - `save/` — pde-format(인코더/디코더/검증), project-file-store, auto-save 컨트롤러, pending-edits, clipboard.
  - `export/` — summon-command, snbt 파서/스트링거, display-transformation.
  - `ui/` — index.html의 정적 DOM + 각 패널 모듈이 부트스트랩. 좌/우 도크(`panel-layout`), scene-tree(`scene-panel/`), object-properties, head-painter/head-atlas, summon-command, setting, color-picker, item-icon-atlas.
  - `player-head-service/` — 메인에서 헤드 텍스처 비동기 큐 서비스.
- **DOM 규칙**: UI 모듈은 `index.html`의 id 기반 정적 구조를 전제로 작성. 새 요소는 동적 생성 허용. CSS는 `ui/css/*` (main.css가 @import 집결).
- `asset-manager.ts`가 에셋 접근 단일 창구 (`getAssetBytes` → Blob URL).

### TSL 관용구 (표준 패턴)
- **인스턴스 숨김**: `entityVisiblePositionNode` — 가시성 어트리뷰트가 0이면 `float(1).sub(visible).mul(1e10)` 오프셋으로 메시를 화면 밖으로 날려 숨김(`renderer/entity-material.ts`). `geometry.dispose` 없이 인스턴스 숨김/표시를 토글하는 이유: 버텍스 데이터 재업로드 회피. 새로 숨김 기능 만들 때 이 패턴 사용.
- **드래그 프리뷰**: `dragPreviewPosition` — `dragDeltaMatrix` uniform으로 월드 변환을 어트리뷰트 기반 선택 인스턴스에만 블렌드.
- **인스턴스 매트릭스 바인딩 안정화**: `stabilizeInstancedMatrixBindingNames` — WebGPU backend의 `createNodeBuilder`를 래핑해 instanceMatrix 버퍼의 셰이더 바인딩 이름을 `pdeInstanceMatrix`로 고정(셰이더 캐시 히트). 커스텀 WebGPU 셰이더 기능 추가 시 이 래퍼 이후에 적용해야 파이프라인 캐시가 깨지지 않음.

### File Format (pbde / .pde)
- 확장자 `.pde` = zstd 압축된 `PRJ2` 아카이브 (`scene.json` payload).
- `PdeProject`: `pdeFormatVersion: 1`, `children: PdeNode[]`, `editorState: PdeEditorState`(버전 1~4 하위호환 마이그레이션 내장 — `pde-format.ts`의 validate/encode/omitDefaults가 단일 진실공급원).
- 노드 4종 중 정확히 1개: `isCollection | isBlockDisplay | isItemDisplay | isTextDisplay`. UUID는 편집 전용, 저장 시 preorder 인덱스로 치환.

### Conventions
- **pbde**: PDE 프로젝트 파일/형식 전체를 지칭하는 약어. 새 이름 지을 때도 이 약어 사용.
- 변수/함수: **camelCase**. 파일명: **kebab-case**. 타입/클래스: PascalCase. 상수: UPPER_SNAKE 허용.
- 신규 파일은 `.ts`. 기존 `.js` (`vite.config.js`, `renderer/ui/ui-open-close.js`)만 유지 — 수정 시에도 `.ts` 변환 금지(기존 파일 그대로).
- 들여쓰기: 2 space(renderer)/4 space 혼재 존재 — **수정 파일의 기존 스타일을 따를 것**.
- tsconfig **path alias 없음**. 상대경로 import만.
- 커밋 메시지: 한글 자유 형식 허용 (기존 로그 참고).

### Response & Style Guide
- 작업 코드 우선, 설명 최소화. 변경 부분만 제시.
- 프로젝트의 기존 주석/메시지 언어(한글) 유지. 에러 메시지도 한글.
- `strict: false` + `noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns` 활성 — 미사용 변수는 타입체크 실패.

---

## Rules
- `npm run build`은 **타입체크를 포함한다** (`tsc --noEmit && vite build`). 타입체크 없이 번들만 돌리는 건 금지 — 검증은 `npx tsc --noEmit` / `npm run compile:electron` / `npm run dist`.
- 테스트/프로브 파일은 `checks/` 에만 (해당 디렉터리는 .gitignore 대상).
- 렌더러 새 모듈은 반드시 SoC 디렉터리(`controls/`·`load-project/`·`save/`·`export/`·`ui/`·`player-head-service/`) 하위에 배치.
- main↔renderer IPC 추가 시: `preload.ts` 브리지 → `renderer/global.d.ts` 타입 → 사용처, 3곳 동시 수정.
- `renderer.ts`의 전역 상태(scene/camera/renderer) 직접 import 금지 — 필요한 정보는 `pde:*` 이벤트 또는 파라미터 주입으로.
- WebGPU 미지원 환경 fallback 금지 (앱 자체가 WebGPU 전제).
