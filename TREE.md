# TREE.md — 프로젝트 구조 지도

> 자주 쓰는 참조용. 파일 위치/역할을 빠르게 찾기 위한 문서. 상세 규칙은 AGENTS.md.

---

## 루트

| 경로 | 개요 |
|---|---|
| `main.ts` | Electron main. 창 생성, IPC 핸들러 전체, Minecraft 에셋 다운로드/캐시, server.jar 바이트코드 파싱으로 registry 추출. 924줄 |
| `preload.ts` | contextBridge → `window.ipcApi`. main↔renderer 유일 통로 (93줄) |
| `memory-cleanup.ts` | main 프로세스 워킹셋 정리 |
| `minecraft-download.ts` | Mojang client/server jar 스트리밍 다운로드 |
| `minecraft-assets.ts` | jar 압축해제 + 에셋 캐시 기록 (`minecraftAssetPrefixes`) |
| `vite.config.js` | Vite 설정. root `./renderer`, outDir `../renderer-dist`, console/drop |
| `tsconfig.json` | renderer 타입설정 (Bundler resolution, noEmit) |
| `tsconfig.electron.json` | main/preload (NodeNext, outDir `electron-dist`) |
| `package.json` | 스크립트/의존성/electron-builder 설정 |
| `renderer/index.html` | 앱 셸. 좌/우 도크, 툴바, 프로젝트 세부정보 정적 DOM |
| `renderer/global.d.ts` | `window.ipcApi` 타입 정의 (preload.ts와 동기화) |
| `AGENTS.md` / `README.md` / `features.md` / `TODO.md` | 문서 |

## renderer/ (Three.js WebGPU 씬)

### 진입/코어
| 경로 | 줄수 | 개요 |
|---|---|---|
| `renderer.ts` | 752 | 앱 시작, scene/camera/renderer 소유, animate 루프, `pde:*` 이벤트 리스너 10+ |
| `entity-material.ts` | 285 | **TSL 표준**. `MeshBasicNodeMaterial` 팩토리, 인스턴스 숨김(1e10 오프셋), 드래그 프리뷰 노드, 인스턴스 매트릭스 바인딩 안정화 |
| `asset-manager.ts` | 69 | 에셋 접근 단일 창구. `initAssets()` → IPC `download-assets` 대기 → `getAssetBytes` |

### controls/ (선택·변형·편집)
| 경로 | 개요 |
|---|---|
| `gizmo/gizmo.ts` (2228) | **최대 파일 중 하나.** gizmo 오버레이, 드래그/스냅, pivot/앵커 상태, 다중선택 |
| `gizmo/gizmo-setup.ts` | TransformControls 래핑, 기즈모 라인/평면 생성 |
| `gizmo/gizmo-commands.ts` | 그룹 생성/해제/삭제/복제 커맨드 (콜백 기반) |
| `gizmo/blockbench-scale.ts` | Blockbench식 스케일 (pivot frame 변환) |
| `gizmo/smart-scale.ts` | 스마트 스케일 세션 |
| `selection/select.ts` (555) | 선택 상태 `currentSelection`, 클릭/shift/ctrl 로직, `getSelectedItems` 캐시 |
| `selection/overlay.ts` (1169) | 선택 오버레이 메시, 버텍스 스프라이트, hover |
| `selection/instance-raycast.ts` (548) | 인스턴스 BVH + CPU 레이캐스트, 헤드 삼각형 교차 |
| `selection/drag.ts`, `instance-ranges.ts`, `head-painter-gpu-preview.ts` | 드래그 선택, 인스턴스 id 범위 병합, GPU 프리뷰(storage/atomic 패턴) |
| `vertex/vertex-translate/rotate/scale/swap/queue.ts` | 버텍스 모드 편집 (T/R/S), 큐 기반 선택 스왑 |
| `pivot/custom-pivot.ts`, `custom-pivot-remove.ts`, `shear-remove.ts` | 커스텀 피벗, shear 제거 |
| `grouping/group.ts`, `create`(`duplicate.ts`), `knife.ts`, `delete.ts` | 그룹 구조/복제/나이프 분할/삭제 |
| `transform/flip.ts`, `mirroring.ts` | 좌우반전, 미러 모델링 |
| `undo-redo/undo-redo.ts`, `scene-history.ts` | 히스토리 record, 씬 상태 캡처/복원 |
| `input/handle-key.ts` (648), `shortcuts.ts`, `camera.ts`, `selection-clipboard.ts` | 키보드 핸들러, 단축키 매핑, 카메라, 복사/붙여넣기 |
| `scene-visibility.ts` | 씬/객체 가시성 |

### load-project/ (불러오기·렌더 준비)
| 경로 | 개요 |
|---|---|
| `pbde/upload-pbde.ts` | .pde 프로젝트 업로드 진입, `loadedObjectGroup` |
| `pbde/pbde-types.ts` | Geometry/Instance 메타 타입 |
| `pbde/pbde-assets.ts`, `pbde-log.ts` | 에셋 프로바이더, 로그 |
| `display/project-renderer.ts` (981) | 프로젝트 렌더 오케스트레이션 |
| `display/display-instancing.ts` (311) | 인스턴싱/시그니처 그룹/밝기 LUT. `MAX_INSTANCES=32768` |
| `display/mesh-builder.ts` | 메시 빌드 (player_head 아틀라스 통합) |
| `display/text-display.ts` (1060) | text_display 폰트/아틀라스/유니코드 처리 |
| `display/player-head-atlas.ts` (1411) | 헤드 텍스처 아틀라스 |
| `display/block-render-resources.ts` | 블록 렌더 리소스 |
| `batching/geometry-batching.ts`, `atlas-instance-batch.ts`, `player-head-batch.ts`, `atlas-part-material.ts`, `instance-model-transform.ts` | 지오메리/인스턴스 배칭 |
| `scene/scene-parser.ts` (2518) | **큰 파일.** 아이템 모델 JSON 파싱, 텍스처 좌표, 캔버스 캐시 |
| `scene/texture-atlas-builder.ts` | 텍스처 아틀라스 패킹 (fnv-1a 캐시 키) |
| `scene/sprite-atlas.ts` | 스프라이트 아틀라스 (paletted_permutations 등) |
| `scene/item-model-definition.ts` | 아이템 모델 정의 해석 |
| `mcfunction/mcfunction-import.ts` | .mcfunction summon 명령 → 프로젝트 임포트 (SNBT 파싱) |

### save/ (저장·형식)
| 경로 | 개요 |
|---|---|
| `pde-format.ts` (327) | **.pde 형식 단일 진실공급원.** 타입 + validate/encode/decode + 버전 1~4 마이그레이션 |
| `project-state.ts` | 씬 상태 → PdeProject 직렬화 |
| `project-file-store.ts` | 저장 경로 기억, revision 카운터 |
| `save-project.ts` | 저장 플로우 |
| `mcfunction-file-store.ts` | .mcfunction 저장 |
| `auto/auto-save-controller.ts`, `auto-save-settings.ts`, `auto-save-file-store.ts`, `auto-save.ts` | 자동저장 |
| `pending-edits.ts` | 비동기 편집 추적/플러시 |
| `project-clipboard.ts` | 클립보드 브리지 |

### export/ (내보내기)
| 경로 | 개요 |
|---|---|
| `summon-command.ts` | 선택 → summon 명령 생성 |
| `snbt.ts` | SNBT 파서/스트링거 |
| `display-transformation.ts` | transformation 행렬 분해 |

### ui/ (패널·인터페이스)
| 경로 | 줄수 | 개요 |
|---|---|---|
| `head-painter.ts` | 2869 | **최대 파일.** 헤드 페인터(브러시/모델제너레이터/파일임포트) |
| `object-properties.ts` | 2031 | 우측 속성 패널 (오브젝트/그룹/다중선택 피벗) |
| `scene-panel/scene-panel-*.ts` | ~6개 | 씬 트리(상태/렌더/선택/드래그/모델/타입) |
| `setting.ts` | 639 | 설정 창 (카메라/그리드/자동저장/단축키/씬상태) |
| `head-atlas-panel.ts` (837), `head-atlas-uv.ts` | 헤드 아틀라스 패널/UV 편집 |
| `item-icon-atlas.ts` | 아이콘 아틀라스 생성/로드 |
| `panel-layout.ts`, `panel-layout-state.ts`, `panel-group-scrollbar.ts` | 도크 레이아웃 |
| `tool-bar.ts` | 상단 툴바 (크기설정/단축 아이콘) |
| `summon-command.ts` | 소환 명령 다이얼로그 |
| `context-menu.ts` | 우클릭 컨텍스트 메뉴 |
| `color-picker.ts` | OKLCH 컬러 피커 |
| `player-generator.ts`, `head-texture-generator.ts` | 플레이어/텍스처 생성 UI |
| `sprite-atlas-picker.ts`, `texture-color-pick.ts` | 스프라이트 아틀라스 선택, 텍스처 색상 추출 |
| `css/*.css` (9개) | `main.css`가 @import 집결 (common/layout/dialogs/panels/scene-tree/overlays/head-painter/color-picker) |
| `ui-open-close.js` | 기존 .js 유지 파일 (애니메이션 오픈/클로즈) |

### player-head-service/ (메인 구동, 렌더러 타입)
`head-texture-service.ts` (메인 구동), `head-texture-queue.ts`, `head-texture-types.ts`, `minecraft-account.ts` — 플레이어 헤드 텍스처 비동기 큐, Mojang 계정.

## hardcoded/ (앱 번들 데이터)
- `models/block/*.json` — 베드/상자/사인/구리 등 ~80개 블록 모델 (registry 보강용)
- `models/item/*.json` — 머리/방패/망원경 등 ~10개
- `blockstates/*.json` — 위 모델의 blockstate 정의

## resources/
`Pangch-Face.ico/icns` (앱 아이콘), `unifont-17.0.01.hex` (유니코드 폰트), `NotoSansKR-ExtraBold.ttf`, `lucide.woff2` (아이콘 폰트), `player_head.svg`

## checks/ (CI 추적, 테스트 전용)
- `pde-format-check.mjs` — pde-format 버전 1~4 fixture 검증 (16 항목)
- `fixtures/pde-format-versions.json` — 버전별 샘플 프로젝트

## .github/workflows/
`ci.yml` — 타입체크(renderer/electron) + fixture 체크 + build + 번들 사이즈 리포트

---

## 빠른 찾기 (자주 쓰는 것)

| 찾는 것 | 위치 |
|---|---|
| 씬/카메라/렌더러 상태 | `renderer/renderer.ts` |
| IPC 채널 추가 | `preload.ts` → `renderer/global.d.ts` → 사용처 |
| .pde 포맷/마이그레이션 | `renderer/save/pde-format.ts` |
| 인스턴스 숨김/TSL 패턴 | `renderer/entity-material.ts` |
| 선택 로직 | `renderer/controls/selection/select.ts` |
| 기즈모/드래그 | `renderer/controls/gizmo/gizmo.ts` |
| 파일 임포트 (.pde) | `renderer/load-project/pbde/upload-pbde.ts` |
| 파일 임포트 (.mcfunction) | `renderer/load-project/mcfunction/mcfunction-import.ts` |
| summon 내보내기 | `renderer/export/summon-command.ts` |
| UI 셸/레이아웃 | `renderer/index.html` + `renderer/ui/main.css` |
| 설정 저장 키 | localStorage `pde*` (`renderer/ui/setting.ts` 검색) |
| 모듈 간 이벤트 | `pde:*` CustomEvent (`window.dispatchEvent` 검색) |
