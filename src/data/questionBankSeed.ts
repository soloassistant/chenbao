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
import { EXTRA_QUESTIONS } from './questionBankSeedExtra';
import { MATH_QUESTIONS } from './questionBankSeedMath';

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
  }),
  build({
    id: 'gaokao-phy-1',
    stem: '物体从静止开始自由下落 2 s（取 g = 10 m/s²），下落的距离是',
    options: ['10 m', '20 m', '30 m', '40 m'],
    answer: 'B',
    explanation: '自由落体位移 h = ½gt² = ½ × 10 × 2² = 20 m。注意不是 gt²，别漏掉 ½。',
    examSystem: 'gaokao', board: 'china_moe', subject: '物理', level: 'na',
    tags: ['运动学'], difficulty: 2, langCode: 'zh'
  }),
  build({
    id: 'gaokao-phy-2',
    stem: '质量 2 kg 的物体获得 3 m/s² 的加速度，所受合力为',
    options: ['1.5 N', '5 N', '6 N', '9 N'],
    answer: 'C',
    explanation: '由牛顿第二定律 F = ma = 2 × 3 = 6 N。加速度与合力方向一致。',
    examSystem: 'gaokao', board: 'china_moe', subject: '物理', level: 'na',
    tags: ['牛顿运动定律'], difficulty: 1, langCode: 'zh'
  }),
  build({
    id: 'gaokao-phy-3',
    stem: '电阻 3 Ω 两端电压为 6 V，通过它的电流是',
    options: ['0.5 A', '2 A', '3 A', '18 A'],
    answer: 'B',
    explanation: '欧姆定律 I = U/R = 6/3 = 2 A。',
    examSystem: 'gaokao', board: 'china_moe', subject: '物理', level: 'na',
    tags: ['恒定电流'], difficulty: 1, langCode: 'zh'
  }),
  build({
    id: 'gaokao-chem-1',
    stem: '原子序数为 8 的元素是',
    options: ['氮 N', '氧 O', '氟 F', '碳 C'],
    answer: 'B',
    explanation: '原子序数等于质子数：6 是碳、7 是氮、8 是氧、9 是氟。',
    examSystem: 'gaokao', board: 'china_moe', subject: '化学', level: 'na',
    tags: ['物质结构与元素周期律'], difficulty: 1, langCode: 'zh'
  }),
  build({
    id: 'gaokao-chem-2',
    stem: '1 mol 水分子中含有的分子数约为',
    options: ['6.02 × 10²³', '3.01 × 10²³', '1.204 × 10²⁴', '6.02 × 10²²'],
    answer: 'A',
    explanation: '阿伏伽德罗常数约为 6.02 × 10²³ mol⁻¹，1 mol 任何分子都含这么多个分子。',
    examSystem: 'gaokao', board: 'china_moe', subject: '化学', level: 'na',
    tags: ['化学计量'], difficulty: 2, langCode: 'zh'
  }),
  build({
    id: 'gaokao-eng-1',
    stem: 'By the time he arrived, we ___ dinner.',
    options: ['finish', 'finished', 'had finished', 'have finished'],
    answer: 'C',
    explanation: '「他到达」是过去时间点，晚饭在那之前已完成，用过去完成时 had finished。',
    examSystem: 'gaokao', board: 'china_moe', subject: '英语', level: 'na',
    tags: ['时态与语态'], difficulty: 2, langCode: 'zh'
  }),
  build({
    id: 'gaokao-eng-2',
    stem: 'The book ___ I bought yesterday is very interesting.',
    options: ['what', 'who', 'that', 'whom'],
    answer: 'C',
    explanation: '先行词 the book 指物，从句缺宾语，关系代词用 that / which；who、whom 指人，what 不能引导定语从句。',
    examSystem: 'gaokao', board: 'china_moe', subject: '英语', level: 'na',
    tags: ['定语从句'], difficulty: 2, langCode: 'zh'
  }),
  build({
    id: 'alevel-math-1',
    stem: 'Find ∫ 2x dx.',
    options: ['2 + c', 'x² + c', 'x²', '2x² + c'],
    answer: 'B',
    explanation: '幂函数积分：∫ 2x dx = x² + c。别忘了不定积分要加常数 c。',
    examSystem: 'alevel', board: 'cie', subject: 'mathematics', level: 'as',
    tags: ['integration'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'alevel-math-2',
    stem: 'An arithmetic sequence begins 3, 7, 11, 15, ... What is its 10th term?',
    options: ['35', '39', '43', '47'],
    answer: 'B',
    explanation: '公差 d = 4，首项 a = 3，第 10 项 a₁₀ = 3 + 9 × 4 = 39。',
    examSystem: 'alevel', board: 'cie', subject: 'mathematics', level: 'as',
    tags: ['sequences and series'], difficulty: 2, langCode: 'en'
  }),
  build({
    id: 'alevel-phy-1',
    stem: 'A wave has frequency 50 Hz and wavelength 2 m. What is its speed?',
    options: ['25 m/s', '50 m/s', '100 m/s', '200 m/s'],
    answer: 'C',
    explanation: '波速 v = fλ = 50 × 2 = 100 m/s。',
    examSystem: 'alevel', board: 'cie', subject: 'physics', level: 'as',
    tags: ['waves'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'alevel-phy-2',
    stem: 'A 4 kg mass accelerates at 2 m/s². What is the resultant force?',
    options: ['2 N', '6 N', '8 N', '16 N'],
    answer: 'C',
    explanation: 'F = ma = 4 × 2 = 8 N。',
    examSystem: 'alevel', board: 'cie', subject: 'physics', level: 'as',
    tags: ['mechanics'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'igcse-phy-1',
    stem: 'What is the weight of a 10 kg mass on Earth (g ≈ 10 N/kg)?',
    options: ['1 N', '10 N', '100 N', '1000 N'],
    answer: 'C',
    explanation: 'W = mg = 10 × 10 = 100 N。质量与重量别混：质量单位是 kg，重量是 N。',
    examSystem: 'igcse', board: 'cie', subject: 'physics', level: 'higher',
    tags: ['forces and motion'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'igcse-phy-2',
    stem: 'A device uses 12 V and 2 A. What is its power?',
    options: ['6 W', '14 W', '24 W', '144 W'],
    answer: 'C',
    explanation: 'P = VI = 12 × 2 = 24 W。',
    examSystem: 'igcse', board: 'cie', subject: 'physics', level: 'higher',
    tags: ['electricity'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'igcse-chem-1',
    stem: 'In a neutral atom, the number of electrons equals the number of',
    options: ['neutrons', 'protons', 'nuclei', 'isotopes'],
    answer: 'B',
    explanation: '中性原子不带电：质子带正电、电子带负电，数量必须相等；中子不带电，不影响电荷。',
    examSystem: 'igcse', board: 'cie', subject: 'chemistry', level: 'higher',
    tags: ['atomic structure'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'igcse-chem-2',
    stem: 'A solution has pH 3. It is',
    options: ['acidic', 'neutral', 'alkaline', 'impossible to tell'],
    answer: 'A',
    explanation: 'pH < 7 为酸性，pH = 7 中性，pH > 7 碱性；pH 3 明显是酸性。',
    examSystem: 'igcse', board: 'cie', subject: 'chemistry', level: 'higher',
    tags: ['acids and bases'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'ap-stat-1',
    stem: 'What is the mean of 2, 4, 6, 8?',
    options: ['4', '5', '6', '20'],
    answer: 'B',
    explanation: '总和 2 + 4 + 6 + 8 = 20，除以 4 个数，均值 = 5。',
    examSystem: 'ap', board: 'collegeboard', subject: 'statistics', level: 'na',
    tags: ['describing data'], difficulty: 1, langCode: 'en'
  }),
  build({
    id: 'ap-stat-2',
    stem: 'If A and B are independent with P(A) = 0.3 and P(B) = 0.5, then P(A and B) =',
    options: ['0.15', '0.3', '0.5', '0.8'],
    answer: 'A',
    explanation: '独立事件同时发生的概率相乘：0.3 × 0.5 = 0.15；0.8 是互斥时才用的加法结果。',
    examSystem: 'ap', board: 'collegeboard', subject: 'statistics', level: 'na',
    tags: ['probability'], difficulty: 2, langCode: 'en'
  }),
  build({
    id: 'ap-phy-1',
    stem: 'An object starts from rest and accelerates at 2 m/s² for 5 s. Its final speed is',
    options: ['2 m/s', '5 m/s', '10 m/s', '25 m/s'],
    answer: 'C',
    explanation: 'v = u + at = 0 + 2 × 5 = 10 m/s；25 m 是位移（½at²），不是速度。',
    examSystem: 'ap', board: 'collegeboard', subject: 'physics-1', level: 'na',
    tags: ['kinematics'], difficulty: 2, langCode: 'en'
  }),
  build({
    id: 'ap-phy-2',
    stem: 'A 2 kg object moves at 3 m/s. Its kinetic energy is',
    options: ['3 J', '6 J', '9 J', '18 J'],
    answer: 'C',
    explanation: 'KE = ½mv² = ½ × 2 × 3² = 9 J；漏掉 ½ 会得到 18 J。',
    examSystem: 'ap', board: 'collegeboard', subject: 'physics-1', level: 'na',
    tags: ['energy'], difficulty: 2, langCode: 'en'
  }),
  build({
    id: 'ap-chem-1',
    stem: 'How many electrons does a neutral carbon atom (atomic number 6) have?',
    options: ['3', '6', '12', '18'],
    answer: 'B',
    explanation: '原子序数 6 表示 6 个质子；中性原子电子数 = 质子数 = 6。12 是质量数，不是电子数。',
    examSystem: 'ap', board: 'collegeboard', subject: 'chemistry', level: 'na',
    tags: ['atomic structure'], difficulty: 1, langCode: 'en'
  }),
  ...EXTRA_QUESTIONS,
  ...MATH_QUESTIONS
];
