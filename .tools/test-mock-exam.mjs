/**
 * 模拟考组卷门禁（2026-11-11）
 *
 * 守两件事：
 *   A. **映射表不能腐化** —— 真题单元 → 题库考点的映射表是人工维护的（paperExamMap.ts），
 *      一旦题库的考点闭集变了、映射还指着旧考点，组卷就会静默抽不出题。
 *      这里逐条断言：学科在 SUBJECTS_BY_EXAM 里、考点在 SYLLABUS_TOPICS 闭集里、考点非空。
 *   B. **组卷行为** —— 只抽范围内的题、轮转覆盖多考点、题库不够时如实报缺口、
 *      及格线/时长算对、卷面写明「不是原卷真题」、同 seed 可复现、判分复用题库口径。
 *
 * 用 esbuild 就地编译 src 源码跑（不走 dist —— terser 会改名，断言会失焦）。
 */
import esbuild from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond === true) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}${detail ? ' → ' + detail : ''}`);
  }
};

const HARNESS = `
import { buildMockExam, gradeMockExam } from './data/mockExam';
import { PAPER_EXAM_BINDINGS, GAOKAO_SUBJECT_BINDINGS } from './data/paperExamMap';
import { SUBJECTS_BY_EXAM, SYLLABUS_TOPICS } from './types/questionBank';
globalThis.__t = { buildMockExam, gradeMockExam, PAPER_EXAM_BINDINGS, GAOKAO_SUBJECT_BINDINGS, SUBJECTS_BY_EXAM, SYLLABUS_TOPICS };
`;

const built = await esbuild
  .build({
    stdin: { contents: HARNESS, loader: 'ts', resolveDir: path.join(ROOT, 'src') },
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    write: false,
    minify: false,
    treeShaking: false
  })
  .catch((e) => {
    console.error('[FAIL] esbuild 编译失败：', e && e.message ? e.message : e);
    process.exit(2);
  });

const sandbox = { console, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(built.outputFiles[0].text, sandbox);
} catch (e) {
  console.error('[FAIL] 求值失败：', e && e.message ? e.message : e);
  process.exit(2);
}
const T = sandbox.__t;
if (!T || typeof T.buildMockExam !== 'function') {
  console.error('[FAIL] 未取到 buildMockExam —— harness 没跑到被测逻辑（harness 问题，不是通过）');
  process.exit(2);
}

const mkQ = (id, over = {}) => ({
  id,
  stemHash: `h-${id}`,
  stem: `题干 ${id}`,
  options: [
    { key: 'A', text: '选项 A' },
    { key: 'B', text: '选项 B' },
    { key: 'C', text: '选项 C' },
    { key: 'D', text: '选项 D' }
  ],
  type: 'single',
  answerKey: 'A',
  explanation: '解析',
  examSystem: 'alevel',
  board: 'edexcel',
  subject: 'mathematics',
  level: 'a2',
  knowledgeTags: ['integration'],
  difficulty: 2,
  source: 'manual',
  langCode: 'zh',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...over
});

console.log('\n── A. 映射表自身的合法性（不能腐化） ──');
const allBindings = [
  ...Object.entries(T.PAPER_EXAM_BINDINGS),
  ...Object.entries(T.GAOKAO_SUBJECT_BINDINGS)
];
ok(allBindings.length > 0, `映射表非空（${allBindings.length} 条）`);
let badSubject = [];
let badTag = [];
let emptyTag = [];
for (const [key, b] of allBindings) {
  const subjects = T.SUBJECTS_BY_EXAM[b.examSystem] || [];
  if (!subjects.includes(b.subject)) badSubject.push(`${key} → ${b.examSystem}:${b.subject}`);
  const closed = T.SYLLABUS_TOPICS[`${b.examSystem}:${b.subject}`] || [];
  if (!Array.isArray(b.tags) || b.tags.length === 0) emptyTag.push(key);
  for (const tag of b.tags || []) {
    if (!closed.includes(tag)) badTag.push(`${key} → ${tag}`);
  }
}
ok(badSubject.length === 0, '每条映射的学科都在 SUBJECTS_BY_EXAM 里', badSubject.join(', '));
ok(badTag.length === 0, '每条映射的考点都在 SYLLABUS_TOPICS 闭集里', badTag.join(', '));
ok(emptyTag.length === 0, '每条映射至少有一个考点', emptyTag.join(', '));

console.log('\n── B. 组卷行为 ──');
const allTags = ['integration', 'differentiation', 'kinematics'];
const bank = [
  mkQ('q1', { knowledgeTags: ['integration'] }),
  mkQ('q2', { knowledgeTags: ['differentiation'] }),
  mkQ('q3', { knowledgeTags: ['kinematics'] }),
  mkQ('q4', { knowledgeTags: ['integration', 'differentiation'] }),
  mkQ('other-subject', { subject: 'physics', knowledgeTags: ['integration'] }),
  mkQ('other-system', { examSystem: 'ap', subject: 'calculus', knowledgeTags: ['integration'] })
];

ok(T.buildMockExam([], { title: '空', examSystem: 'alevel', subject: 'mathematics', tags: allTags }) === null,
  '空题库 → 返回 null（组不了卷）');
ok(
  T.buildMockExam(bank, { title: 'x', examSystem: 'igcse', subject: 'mathematics', tags: allTags }) === null,
  '体系对不上 → 返回 null'
);

const plan = T.buildMockExam(bank, {
  title: '测试卷',
  examSystem: 'alevel',
  subject: 'mathematics',
  tags: allTags,
  seed: 42
});
ok(!!plan, '正常组卷成功');
const byId = new Map(bank.map((q) => [q.id, q]));
const picked = plan.questionIds.map((id) => byId.get(id)).filter(Boolean);
ok(picked.length === 4, `只抽范围内的题（抽到 ${picked.length} 题，范围外 2 题被排除）`);
ok(
  picked.every((q) => q.examSystem === 'alevel' && q.subject === 'mathematics' && q.knowledgeTags.some((t) => allTags.includes(t))),
  '每道抽中的题都在考范围内'
);
const covered = plan.coverage.filter((c) => c.count > 0).map((c) => c.tag);
ok(covered.length >= 3, `轮转抽题覆盖多个考点（${covered.join('、')}）`);
ok(plan.totalScore === plan.total * plan.scorePerQuestion, '总分 = 题数 × 每题分值');
ok(plan.passScore === Math.ceil(plan.totalScore * 0.6), '及格线 = 60%');
ok(plan.durationMin >= 10 && plan.durationMin <= 120, `时长在 10–120 分钟（${plan.durationMin}）`);
ok(plan.shortage === 16, `题库不够时如实报缺口（shortage=${plan.shortage}）`);
ok(/不是原卷真题/.test(plan.sourceNote), '卷面写明「不是原卷真题」（诚实性）');

const short = T.buildMockExam(bank, {
  title: '题少的卷',
  examSystem: 'alevel',
  subject: 'mathematics',
  tags: ['kinematics'],
  targetCount: 20
});
ok(short.total === 1, `题库不够时只抽有的（${short.total} 题）`);
ok(short.shortage === 19, `如实报缺口（shortage=${short.shortage}）`);

const planA = T.buildMockExam(bank, { title: 'r', examSystem: 'alevel', subject: 'mathematics', tags: allTags, seed: 7 });
const planB = T.buildMockExam(bank, { title: 'r', examSystem: 'alevel', subject: 'mathematics', tags: allTags, seed: 7 });
ok(JSON.stringify(planA.questionIds) === JSON.stringify(planB.questionIds), '同 seed → 同样的组卷顺序（可复现）');

const multi = T.buildMockExam([mkQ('m1', { type: 'multi', answerKey: ['A', 'B'] })], {
  title: '多选题',
  examSystem: 'alevel',
  subject: 'mathematics',
  tags: ['integration']
});
ok(multi === null, '默认不抽多选/填空（考试界面按客观题设计）');

console.log('\n── C. 判分复用题库口径 ──');
const res = T.gradeMockExam([mkQ('g1'), mkQ('g2')], { g1: 'A', g2: 'B' });
ok(res.correctCount === 1, `判分正确（答对 ${res.correctCount}/2）`);
ok(res.score === 5 && res.totalScore === 10, '得分按每题 5 分');
ok(res.pass === false, '未达 60% → 不通过');
const res2 = T.gradeMockExam([mkQ('g1')], { g1: 'A' });
ok(res2.pass === true, '满分 → 通过');
ok(res2.details[0].correct === true && res2.details[0].question.id === 'g1', '明细里带上题目本身（结果页要显示解析）');

console.log('\n──────────────────────────────────────────────────────────');
console.log(`PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
console.log('──────────────────────────────────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
