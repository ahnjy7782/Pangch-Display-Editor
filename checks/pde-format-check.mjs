// pde-format 버전 1~4 마이그레이션 회귀 테스트.
// 실행: node checks/pde-format-check.mjs
// AGENTS.md 룰: 테스트 파일은 checks/ 에만 존재한다 (.gitignore 대상).
// validatePdeProject은 three/webgpu(MathUtils) 의존이라 번들러 없이 node에서
// import 불가하므로, 마이그레이션 계약을 fixture 데이터로 선언적 검증한다.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturesPath = path.join(root, 'checks', 'fixtures', 'pde-format-versions.json');
const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));

let failures = 0;
const check = (name, condition, detail) => {
    if (condition) { console.log(`  ok  ${name}`); return; }
    failures++;
    console.error(`FAIL  ${name}: ${detail}`);
};

const displayTypeCount = (node) => [node.isCollection, node.isBlockDisplay, node.isItemDisplay, node.isTextDisplay].filter(Boolean).length;

// v4: 인라인 editorState 편집값(label/pivot/uvFlip 등)이 노드별로 존재 → 정규화 버전 1로 수렴.
{
    const project = structuredClone(fixtures.v4);
    const visit = (nodes, depth = 0) => {
        for (const node of nodes) {
            check('v4 display type exclusive', displayTypeCount(node) === 1, `${node.name}: ${displayTypeCount(node)}`);
            if (node.editorState !== undefined && node.isCollection) {
                check('v4 group editorState has defaults', Array.isArray(node.editorState.position), 'position 누락');
            }
            if (node.children) visit(node.children, depth + 1);
        }
    };
    visit(project.children);
    check('v4 editorState version', project.editorState.version === 4, 'version 4 필요');
    check('v4 object editorState carries label',
        project.children[0].children[0].editorState.label === 'test-block', 'label 누락');
    check('v4 text options preserved',
        project.children[0].children[1].options.pages[0] === 'hello', 'text pages 누락');
}

// v3: transforms/nbt/brightness 누락 허용 — compact 포맷, 기본값 채움.
{
    const project = structuredClone(fixtures.v3);
    for (const node of project.children) {
        check('v3 node has display type', displayTypeCount(node) === 1, `${node.name}`);
    }
    check('v3 editorState version', project.editorState.version === 3, 'version 3 필요');
    check('v3 group has transform fields',
        Array.isArray(project.editorState.groups[0]?.position) && project.editorState.groups[0].position.length === 3,
        '그룹 position 누락');
}

// v2: uuid 없는 노드 → 노드 preorder 인덱스로 editorState 참조 해석.
{
    const project = structuredClone(fixtures.v2);
    check('v2 editorState version', project.editorState.version === 2, 'version 2 필요');
    check('v2 node display type', displayTypeCount(project.children[0]) === 1, 'item_display 필요');
    check('v2 indexed reference present',
        project.editorState.objects[0]?.id === 0, 'id 0 참조 누락');
}

// v1: uuid 기반 직접 참조.
{
    const project = structuredClone(fixtures.v1);
    check('v1 node uuid', project.children[0].uuid === 'obj-1', 'uuid 불일치');
    check('v1 editorState version', project.editorState.version === 1, 'version 1 필요');
    check('v1 object reference matches uuid',
        project.editorState.objects[0]?.uuid === project.children[0].uuid, 'uuid 참조 불일치');
}

if (failures) {
    console.error(`\n${failures}개 검증 실패`);
    process.exit(1);
}
console.log('\npde-format fixture 검증 통과');
