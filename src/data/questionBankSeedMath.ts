/**
 * A Level 数学示例题（2026-11-11 第三轮）—— 为「按真题结构组模拟卷」补足题量。
 *
 * 为什么单独一个文件：真题库里数学是最大的科目（Edexcel 19 个单元、AQA 8 个单元），
 * 而第二轮补齐学科时每个学科只放了 1 道「占位题」—— 结果就是「模拟考试」功能跑通了，
 * 却只能组出 2 题的卷子。这里按 A Level 数学的 12 个考纲考点补齐，让
 * 「纯数 1 / 纯数 2 / 力学 1 / 决策 1」这些真题单元能组出十几题的卷子。
 *
 * 题目全部自编，**不抄任何真题**；题干不用 LaTeX（仓库没有数学渲染器，$...$ 会原样显示），
 * 一律用 Unicode 数学符号。
 */
import type { Board, ExamSystem, LangCode, Level, Question } from '@/types/questionBank';
import { stemHash } from '@/utils/questionBank';

const STAMP = '2026-11-11T00:00:00.000Z';

const BOARD: Record<ExamSystem, Board> = {
  gaokao: 'china_moe', zhongkao: 'china_moe', igcse: 'cie', alevel: 'cie',
  ap: 'collegeboard', ib: 'ibo', other: 'other'
};

/** 一行一道题：ans 是 0 起的正确选项下标 */
const R = (
  id: string, sys: ExamSystem, subject: string, level: Level, tag: string,
  stem: string, opts: [string, string, string, string], ans: number,
  explanation: string, lang: LangCode = 'en', difficulty = 2
): Question => ({
  id: `seed-${id}`,
  stemHash: stemHash(stem),
  stem,
  options: opts.map((text, i) => ({ key: 'ABCD'[i], text })),
  type: 'single',
  answerKey: 'ABCD'[ans],
  explanation,
  examSystem: sys,
  board: BOARD[sys],
  subject,
  level,
  knowledgeTags: [tag],
  difficulty,
  source: 'manual',
  langCode: lang,
  createdAt: STAMP,
  updatedAt: STAMP
});

export const MATH_QUESTIONS: Question[] = [
  /* ── algebra and functions ── */
  R('al-math-alg-1', 'alevel', 'mathematics', 'a2', 'algebra and functions',
    'Solve 3x − 7 = 14.',
    ['3', '5', '7', '21'],
    2, '3x = 21，所以 x = 7。', 'en', 1),
  R('al-math-alg-2', 'alevel', 'mathematics', 'a2', 'algebra and functions',
    'The quadratic x² − 5x + 6 = 0 has roots p and q. What is p + q?',
    ['1', '5', '6', '11'],
    1, '由韦达定理，二次项系数为 1 的一次项系数 −5 给出 p + q = 5。', 'en', 2),
  R('al-math-alg-3', 'alevel', 'mathematics', 'a2', 'algebra and functions',
    'Which inequality is satisfied by x = −2?',
    ['2x − 1 > 0', 'x² − 3 < 0', '3x + 7 > 0', 'x + 5 < 0'],
    2, '代入 x = −2：2x−1 = −5（不 > 0）、x²−3 = 1（不 < 0）、3x+7 = 1（> 0 ✓）、x+5 = 3（不 < 0），只有 3x + 7 > 0 成立。', 'en', 2),

  /* ── coordinate geometry ── */
  R('al-math-cg-1', 'alevel', 'mathematics', 'a2', 'coordinate geometry',
    'What is the gradient of the line joining (2, 3) and (6, 11)?',
    ['1', '2', '3', '4'],
    1, 'Δy = 11 − 3 = 8，Δx = 6 − 2 = 4，梯度 = 8/4 = 2。', 'en', 1),
  R('al-math-cg-2', 'alevel', 'mathematics', 'a2', 'coordinate geometry',
    'A circle has centre (3, −1) and radius 5. Which equation is its equation?',
    ['(x − 3)² + (y + 1)² = 25', 'x² + y² = 25', '(x + 3)² + (y − 1)² = 25', 'x² + y² = 5'],
    0, '圆心 (a, b)、半径 r 的圆方程是 (x − a)² + (y − b)² = r²；此处 a = 3、b = −1、r = 5，得 (x − 3)² + (y + 1)² = 25。', 'en', 2),

  /* ── sequences and series ── */
  R('al-math-seq-1', 'alevel', 'mathematics', 'a2', 'sequences and series',
    'An arithmetic sequence has first term 5 and common difference 4. What is its 12th term?',
    ['45', '47', '49', '53'],
    2, '第 n 项 = 5 + 4(n − 1)，第 12 项 = 5 + 44 = 49。', 'en', 1),
  R('al-math-seq-2', 'alevel', 'mathematics', 'a2', 'sequences and series',
    'A geometric sequence has first term 2 and common ratio 3. What is its 5th term?',
    ['48', '54', '162', '486'],
    2, '第 n 项 = 2 × 3ⁿ⁻¹，第 5 项 = 2 × 81 = 162。', 'en', 2),
  R('al-math-seq-3', 'alevel', 'mathematics', 'a2', 'sequences and series',
    'What is the sum of the first 20 terms of the series 1 + 2 + 4 + 8 + ...?',
    ['2²⁰', '2²⁰ − 1', '2²¹ − 1', '20 × 2¹⁹'],
    1, '等比数列首项 1、公比 2，前 n 项和 = (2ⁿ − 1)/(2 − 1) = 2²⁰ − 1。', 'en', 2),

  /* ── differentiation ── */
  R('al-math-diff-1', 'alevel', 'mathematics', 'a2', 'differentiation',
    'If y = x³ − 5x, what is dy/dx at x = 2?',
    ['2', '7', '12', '14'],
    1, 'y′ = 3x² − 5，代入 x = 2 得 12 − 5 = 7。', 'en', 1),
  R('al-math-diff-2', 'alevel', 'mathematics', 'a2', 'differentiation',
    'The curve y = x² has a tangent at the point (3, 9). What is the gradient of that tangent?',
    ['3', '6', '9', '27'],
    1, 'y′ = 2x，在 x = 3 处斜率为 6；切线与曲线的斜率相同。', 'en', 2),
  R('al-math-diff-3', 'alevel', 'mathematics', 'a2', 'differentiation',
    'For f(x) = x³ − 6x, which x-value gives a stationary point?',
    ['x = 0', 'x = ±√2', 'x = ±2', 'x = 3'],
    1, 'f′(x) = 3x² − 6 = 0 ⇒ x² = 2 ⇒ x = ±√2。', 'en', 2),

  /* ── integration ── */
  R('al-math-int-1', 'alevel', 'mathematics', 'a2', 'integration',
    'What is ∫ 5x⁴ dx?',
    ['x⁵ + C', '5x⁵ + C', 'x⁴ + C', '5x⁴ + C'],
    0, '∫ 5x⁴ dx = 5·x⁵/5 + C = x⁵ + C。', 'en', 1),
  R('al-math-int-2', 'alevel', 'mathematics', 'a2', 'integration',
    'What is the value of ∫₀¹ 3x² dx?',
    ['0', '1', '2', '3'],
    1, '∫ 3x² dx = x³，代入上下限得 1³ − 0³ = 1。', 'en', 2),
  R('al-math-int-3', 'alevel', 'mathematics', 'a2', 'integration',
    'The region bounded by y = x and the x-axis between x = 0 and x = 2 has area',
    ['2', '3', '4', '8/3'],
    0, '面积 = ∫₀² x dx = x²/2 |₀² = 2。', 'en', 2),

  /* ── trigonometry ── */
  R('al-math-trig-1', 'alevel', 'mathematics', 'a2', 'trigonometry',
    'What is the exact value of sin 30°?',
    ['1/2', '√2/2', '√3/2', '1'],
    0, 'sin 30° = 1/2（30-60-90 三角形）。', 'en', 1),
  R('al-math-trig-2', 'alevel', 'mathematics', 'a2', 'trigonometry',
    'Which identity is true for all angles?',
    ['sin²θ + cos²θ = 1', 'sin²θ − cos²θ = 1', 'sin θ cos θ = 1', 'tan θ = sin θ'],
    0, '基本恒等式：sin²θ + cos²θ = 1。', 'en', 1),
  R('al-math-trig-3', 'alevel', 'mathematics', 'a2', 'trigonometry',
    'In radians, what is 180°?',
    ['π', 'π/2', '2π', '3π'],
    0, '180° = π 弧度。', 'en', 1),

  /* ── exponentials and logarithms ── */
  R('al-math-exp-1', 'alevel', 'mathematics', 'a2', 'exponentials and logarithms',
    'What is the value of e⁰?',
    ['0', '1', 'e', '∞'],
    1, '任何非零数的 0 次幂为 1，故 e⁰ = 1。', 'en', 1),
  R('al-math-exp-2', 'alevel', 'mathematics', 'a2', 'exponentials and logarithms',
    'Solve 2ˣ = 32.',
    ['4', '5', '6', '16'],
    1, '2⁵ = 32，所以 x = 5。', 'en', 1),
  R('al-math-exp-3', 'alevel', 'mathematics', 'a2', 'exponentials and logarithms',
    'If log₁₀ x = 3, what is x?',
    ['3', '10', '30', '1000'],
    3, 'log₁₀ x = 3 ⇒ x = 10³ = 1000。', 'en', 1),

  /* ── vectors ── */
  R('al-math-vec-1', 'alevel', 'mathematics', 'a2', 'vectors',
    'What is the dot product of vectors (3, 4) and (2, −1)?',
    ['2', '5', '10', '−2'],
    0, '点积 = 3×2 + 4×(−1) = 6 − 4 = 2。', 'en', 2),
  R('al-math-vec-2', 'alevel', 'mathematics', 'a2', 'vectors',
    'The vector AB where A = (1, 2) and B = (4, 6) has magnitude',
    ['3', '5', '7', '25'],
    1, 'AB = (3, 4)，模 = √(3² + 4²) = 5。', 'en', 2),

  /* ── proof ── */
  R('al-math-prf-1', 'alevel', 'mathematics', 'a2', 'proof',
    'Which method proves a statement holds for every positive integer n?',
    ['mathematical induction', 'trial and error', 'working backwards', 'a diagram'],
    0, '数学归纳法：对基例成立并证明「n 成立 ⇒ n+1 成立」，即可得对所有正整数成立。', 'en', 2),
  R('al-math-prf-2', 'alevel', 'mathematics', 'a2', 'proof',
    'Two lines with gradients m₁ and m₂ are perpendicular. What must be true?',
    ['m₁ = m₂', 'm₁m₂ = −1', 'm₁ + m₂ = 0', 'm₁m₂ = 1'],
    1, '垂直⇒斜率乘积为 −1（水平线与垂直线的情形另作讨论）。', 'en', 2),

  /* ── kinematics ── */
  R('al-math-kin-1', 'alevel', 'mathematics', 'a2', 'kinematics',
    'A particle moves with constant acceleration 2 m/s² from rest. What is its speed after 3 s?',
    ['3 m/s', '6 m/s', '9 m/s', '18 m/s'],
    1, 'v = u + at = 0 + 2 × 3 = 6 m/s。', 'en', 1),
  R('al-math-kin-2', 'alevel', 'mathematics', 'a2', 'kinematics',
    'A car travels 120 m in 10 s. What is its average speed?',
    ['10 m/s', '12 m/s', '20 m/s', '1200 m/s'],
    1, '平均速率 = 距离 / 时间 = 120/10 = 12 m/s。', 'en', 1),
  R('al-math-kin-3', 'alevel', 'mathematics', 'a2', 'kinematics',
    'A ball is thrown vertically upwards with initial speed 20 m/s. Taking g = 10 m/s², how long until it returns to its starting height?',
    ['1 s', '2 s', '4 s', '20 s'],
    2, '上升与下降各用 20/10 = 2 s，总共 4 s。', 'en', 2),

  /* ── forces and equilibrium ── */
  R('al-math-force-1', 'alevel', 'mathematics', 'a2', 'forces and equilibrium',
    'A 4 N upward force and a 1 N downward force act on a body. What is the resultant force?',
    ['3 N upward', '4 N upward', '5 N upward', '3 N downward'],
    0, '合力 = 4 − 1 = 3 N，方向向上。', 'en', 1),
  R('al-math-force-2', 'alevel', 'mathematics', 'a2', 'forces and equilibrium',
    'What is the frictional force on a stationary block on a horizontal surface with no other horizontal force?',
    ['0 N', 'equal to the weight', 'greater than the weight', 'equal to the normal reaction'],
    0, '水平方向无其他力，静止时摩擦力为 0 N（静摩擦只在有趋势时才提供）。', 'en', 2),

  /* ── probability and distributions ── */
  R('al-math-prob-1', 'alevel', 'mathematics', 'a2', 'probability and distributions',
    'A fair coin is tossed twice. What is the probability of two heads?',
    ['1/4', '1/2', '3/4', '1'],
    0, '四次等可能结果中只有 HH 一种，故概率 = 1/4。', 'en', 1),
  R('al-math-prob-2', 'alevel', 'mathematics', 'a2', 'probability and distributions',
    'Events A and B are independent with P(A) = 0.4 and P(B) = 0.5. What is P(A and B)?',
    ['0.09', '0.2', '0.45', '0.9'],
    1, '独立事件相乘：0.4 × 0.5 = 0.2。', 'en', 2),
  R('al-math-prob-3', 'alevel', 'mathematics', 'a2', 'probability and distributions',
    'A discrete random variable takes values 1, 2, 3 with probabilities 0.2, 0.5, 0.3. What is its expected value?',
    ['1.9', '2.0', '2.1', '2.3'],
    2, 'E(X) = 1×0.2 + 2×0.5 + 3×0.3 = 0.2 + 1.0 + 0.9 = 2.1。', 'en', 3)
];
