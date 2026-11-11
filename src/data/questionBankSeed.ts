/**
 * 内置示例题（10 道，全部自编，含解析）。
 *
 * 边界（与 types/questionBank.ts 一致）：**不复制任何真题**。这里是为「做题 → 判分 → 看解析」
 * 这条链路提供可点开的内容，避免题库空着导致功能看起来是坏的。
 *
 * 用户可自行删除或用「导入题目」覆盖；导入的题与内置题在同一个仓储里，没有特殊待遇。
 * id 固定（seed-<exam>-<n>），重复点「载入示例题」不会长出重复条目。
 */
import type { Question } from '@/types/questionBank';
import { stemHash } from '@/utils/questionBank';

const STAMP = '2026-11-11T00:00:00.000Z';

interface SeedInput {
  id: string;
  stem: string;
  options: [string, string, string, string];
  answer: 'A' | 'B' | 'C' | 'D';
  explanation: string;
  examSystem: Question['examSystem'];
  board: Question['board'];
  subject: string;
  level: Question['level'];
  tags: string[];
  difficulty: number;
  langCode: Question['langCode'];
}

function build(input: SeedInput): Question {
  return {
    id: `seed-${input.id}`,
    stemHash: stemHash(input.stem),
    stem: input.stem,
    options: input.options.map((text, i) => ({ key: 'ABCD'[i], text })),
    type: 'single',
    answerKey: input.answer,
    explanation: input.explanation,
    examSystem: input.examSystem,
    board: input.board,
    subject: input.subject,
    level: input.level,
    knowledgeTags: input.tags,
    difficulty: input.difficulty,
    source: 'manual',
    langCode: input.langCode,
    createdAt: STAMP,
    updatedAt: STAMP
  };
}

export const SEED_QUESTIONS: Question[] = [
  build({
    id: 'gaokao-1',
    stem: '设集合 A = {x | x² − 3x + 2 = 0}，B = {1, 2}，则 A ∩ B =',
    options: ['{1}', '{2}', '{1, 2}', '∅'],
    answer: 'C',
    explanation: '解 x² − 3x + 2 = 0 得 x = 1 或 x = 2，所以 A = {1, 2}，与 B 完全相同，交集就是 {1, 2}。',
    examSystem: 'gaokao',
    board: 'china_moe',
    subject: '数学',
    level: 'na',
    tags: ['集合与常用逻辑'],
    difficulty: 1,
    langCode: 'zh'
  }),
  build({
    id: 'gaokao-2',
    stem: '函数 f(x) = x³ − 3x 在 x = 1 处的切线斜率是',
    options: ['−3', '0', '3', '6'],
    answer: 'B',
    explanation: 'f′(x) = 3x² − 3，代入 x = 1 得 f′(1) = 0，切线水平，斜率为 0。',
    examSystem: 'gaokao',
    board: 'china_moe',
    subject: '数学',
    level: 'na',
    tags: ['函数与导数'],
    difficulty: 2,
    langCode: 'zh'
  }),
  build({
    id: 'gaokao-3',
    stem: '在 △ABC 中，a = 3，b = 4，∠C = 90°，则 c =',
    options: ['5', '6', '7', '√7'],
    answer: 'A',
    explanation: '直角边为 a、b，斜边 c = √(a² + b²) = √(9 + 16) = 5。',
    examSystem: 'gaokao',
    board: 'china_moe',
    subject: '数学',
    level: 'na',
    tags: ['解三角形'],
    difficulty: 1,
    langCode: 'zh'
  }),
  build({
    id: 'gaokao-4',
    stem: '同时抛掷两枚均匀硬币，恰好一枚正面朝上的概率是',
    options: ['1/4', '1/3', '1/2', '3/4'],
    answer: 'C',
    explanation: '样本空间为 (正正)(正反)(反正)(反反) 共 4 种，恰好一枚正面有 2 种，概率 2/4 = 1/2。',
    examSystem: 'gaokao',
    board: 'china_moe',
    subject: '数学',
    level: 'na',
    tags: ['概率与统计'],
    difficulty: 1,
    langCode: 'zh'
  }),
  build({
    id: 'igcse-1',
    stem: 'Write 0.00045 in standard form.',
    options: ['4.5 × 10⁻⁴', '4.5 × 10⁻³', '45 × 10⁻⁵', '4.5 × 10⁴'],
    answer: 'A',
    explanation: '把小数点右移 4 位得到 4.5，因此指数是 −4：0.00045 = 4.5 × 10⁻⁴。',
    examSystem: 'igcse',
    board: 'cie',
    subject: 'mathematics',
    level: 'higher',
    tags: ['number'],
    difficulty: 2,
    langCode: 'en'
  }),
  build({
    id: 'igcse-2',
    stem: 'Solve 3x − 7 = 11.',
    options: ['x = 4', 'x = 6', 'x = 4/3', 'x = 18'],
    answer: 'B',
    explanation: '两边加 7 得 3x = 18，再除以 3 得 x = 6。',
    examSystem: 'igcse',
    board: 'cie',
    subject: 'mathematics',
    level: 'higher',
    tags: ['algebra'],
    difficulty: 1,
    langCode: 'en'
  }),
  build({
    id: 'igcse-3',
    stem: 'A bag contains 3 red and 5 blue balls. One ball is taken at random. What is the probability that it is red?',
    options: ['3/5', '3/8', '5/8', '1/3'],
    answer: 'B',
    explanation: '共有 3 + 5 = 8 个球，其中红球 3 个，概率为 3/8。',
    examSystem: 'igcse',
    board: 'cie',
    subject: 'mathematics',
    level: 'higher',
    tags: ['probability'],
    difficulty: 1,
    langCode: 'en'
  }),
  build({
    id: 'ap-1',
    stem: 'Evaluate lim(x→2) (x² − 4)/(x − 2).',
    options: ['0', '2', '4', 'The limit does not exist'],
    answer: 'C',
    explanation: 'x² − 4 = (x − 2)(x + 2)，约去 x − 2 后极限等于 lim(x→2)(x + 2) = 4。',
    examSystem: 'ap',
    board: 'collegeboard',
    subject: 'calculus',
    level: 'na',
    tags: ['limits and continuity'],
    difficulty: 2,
    langCode: 'en'
  }),
  build({
    id: 'ap-2',
    stem: 'If f(x) = 3x² + 2x, what is f′(1)?',
    options: ['5', '6', '8', '11'],
    answer: 'C',
    explanation: 'f′(x) = 6x + 2，代入 x = 1 得 8。',
    examSystem: 'ap',
    board: 'collegeboard',
    subject: 'calculus',
    level: 'na',
    tags: ['differentiation'],
    difficulty: 2,
    langCode: 'en'
  }),
  build({
    id: 'ap-3',
    stem: 'Evaluate ∫₀¹ (2x + 1) dx.',
    options: ['1', '2', '2.5', '3'],
    answer: 'B',
    explanation: '原函数是 x² + x，代入上下限：(1 + 1) − (0 + 0) = 2。',
    examSystem: 'ap',
    board: 'collegeboard',
    subject: 'calculus',
    level: 'na',
    tags: ['integration'],
    difficulty: 2,
    langCode: 'en'
  })
];
