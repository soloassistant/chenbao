/**
 * 模拟考试组卷引擎。
 *
 * 定位（务必说清，别让用户误解）：
 *   历年真题库只存**考卷结构**（考试局 / 科目 / 单元 / 历年考季），不存试卷内容，
 *   版权在考试局与转存站；本仓库既不复制也不解析真题。
 *   所以这里的「模拟卷」= **按某套真题的考点范围，从本地题库抽题组卷**：
 *   考卷结构来自真题，题目来自本地题库（自编示例题）。
 *   它**不是**原卷真题，也**不含**真题内容 —— 这一点在卷面与结果页都要如实写出来。
 *
 * 组卷规则：
 *   ① 只抽 examSystem / subject 对得上、且考点落在该真题单元范围内的题；
 *   ② 按考点**轮转**抽题（而不是按题库顺序切一段），保证覆盖面而不是运气；
 *   ③ 本地题库不够时**如实报缺口**（shortage），不拿不相干的题凑数；
 *   ④ 判分复用题库的 gradeAnswer —— 不另写一套，避免两边口径分叉。
 */
import type { ExamSystem, Question, QuestionType } from '@/types/questionBank';
import { gradeAnswer, type UserResponse } from '@/utils/questionBankGrading';
import type { QuestionBankStorage } from './questionBankRepo';

export interface MockExamOptions {
  /** 卷名，例如「Edexcel 数学 · 纯数 1」 */
  title: string;
  /** 副标题：考卷来源说明 */
  subtitle?: string;
  /** 题库体系 */
  examSystem: ExamSystem;
  /** 题库里的学科 */
  subject: string;
  /** 该真题单元覆盖的考点（来自 paperExamMap 的显式映射） */
  tags: string[];
  /** 目标题量，默认 20 */
  targetCount?: number;
  /** 每题分值，默认 5 */
  scorePerQuestion?: number;
  /** 随机种子；不传则随机（测试里传固定值以保证可复现） */
  seed?: number;
  /**
   * 参与组卷的题型。默认只取「单选 + 判断」——
   * 模拟考的答题界面按客观题设计（点一下即作答），多选/填空需要额外的确认交互，
   * 放进考试流程里容易让用户误操作，所以默认不抽；需要时可显式放开。
   */
  includeTypes?: QuestionType[];
}

export interface MockExamPlan {
  id: string;
  title: string;
  subtitle: string;
  questionIds: string[];
  total: number;
  scorePerQuestion: number;
  totalScore: number;
  passScore: number;
  durationMin: number;
  /** 各考点的命中题数（卷面「覆盖考点」用） */
  coverage: { tag: string; count: number }[];
  /** 目标题量 */
  targetCount: number;
  /** 题库不足时的缺口（>0 表示本地题不够，卷面要如实说明） */
  shortage: number;
  /** 诚实性说明：卷面与结果页都要显示 */
  sourceNote: string;
}

export const MOCK_EXAM_SOURCE_NOTE =
  '题目来自本地题库（自编练习题），按该真题的考卷结构与考点范围组卷；不是原卷真题，也不含真题内容。';

export const MOCK_EXAM_DEFAULT_COUNT = 20;
export const MOCK_EXAM_DEFAULT_SCORE = 5;

/** Fisher–Yates；给了 seed 就可复现 */
function shuffle<T>(list: T[], seed?: number): T[] {
  const out = list.slice();
  let s = seed;
  const rnd = () => {
    if (s === undefined) return Math.random();
    // xorshift32：够随机且可复现
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * 按真题考点范围组一套卷。
 * 返回 null = 本地题库里没有一道题落在该范围内（= 这套真题组不了卷）。
 */
export function buildMockExam(questions: Question[], opts: MockExamOptions): MockExamPlan | null {
  const target = opts.targetCount ?? MOCK_EXAM_DEFAULT_COUNT;
  const scorePerQuestion = opts.scorePerQuestion ?? MOCK_EXAM_DEFAULT_SCORE;
  // 默认只抽客观题：考试界面是「点一下即作答」，多选/填空需要额外的确认交互，
  // 放进考试流程里容易误操作（显式传 includeTypes 才放开）。
  const types = opts.includeTypes ?? (['single', 'judge'] as QuestionType[]);
  const tagSet = new Set(opts.tags);

  const cands = questions.filter(
    (q) =>
      q.examSystem === opts.examSystem &&
      q.subject === opts.subject &&
      types.includes(q.type) &&
      q.knowledgeTags.some((t) => tagSet.has(t))
  );
  if (!cands.length) return null;

  // 按考点分桶（一个题可落多个桶）
  const buckets = new Map<string, Question[]>();
  for (const tag of opts.tags) buckets.set(tag, []);
  for (const q of cands) {
    for (const t of q.knowledgeTags) {
      const bucket = buckets.get(t);
      if (bucket) bucket.push(q);
    }
  }

  // 轮转抽题：每轮每个考点各出 1 题（已被别的桶选走的跳过），保证覆盖面
  const picked: Question[] = [];
  const pickedIds = new Set<string>();
  for (let round = 0; round < opts.tags.length * 4 && picked.length < target; round++) {
    let progressed = false;
    for (const tag of opts.tags) {
      if (picked.length >= target) break;
      const bucket = buckets.get(tag);
      if (!bucket) continue;
      const idx = bucket.findIndex((x) => !pickedIds.has(x.id));
      if (idx < 0) continue;
      pickedIds.add(bucket[idx].id);
      picked.push(bucket[idx]);
      bucket.splice(idx, 1);
      progressed = true;
    }
    if (!progressed) break;
  }

  const ordered = shuffle(picked, opts.seed);
  const coverage = opts.tags.map((tag) => ({
    tag,
    count: ordered.filter((q) => q.knowledgeTags.includes(tag)).length
  }));
  const totalScore = ordered.length * scorePerQuestion;

  return {
    id: `mock-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    title: opts.title,
    subtitle: opts.subtitle || '',
    questionIds: ordered.map((q) => q.id),
    total: ordered.length,
    scorePerQuestion,
    totalScore,
    passScore: Math.ceil(totalScore * 0.6),
    durationMin: Math.min(120, Math.max(10, Math.ceil(ordered.length * 1.5))),
    coverage,
    targetCount: target,
    shortage: Math.max(0, target - ordered.length),
    sourceNote: MOCK_EXAM_SOURCE_NOTE
  };
}

export interface MockExamDetail {
  question: Question;
  response: UserResponse;
  correct: boolean;
}

export interface MockExamResult {
  score: number;
  totalScore: number;
  pass: boolean;
  correctCount: number;
  total: number;
  /** 逐题明细（按卷面顺序） */
  details: MockExamDetail[];
}

/** 判分：判据复用题库的 gradeAnswer，不另写一套 */
export function gradeMockExam(
  questions: Question[],
  responses: Record<string, UserResponse>,
  scorePerQuestion: number = MOCK_EXAM_DEFAULT_SCORE
): MockExamResult {
  const details: MockExamDetail[] = questions.map((question) => {
    const response = responses[question.id];
    return { question, response, correct: gradeAnswer(question, response) };
  });
  const correctCount = details.filter((d) => d.correct).length;
  const totalScore = questions.length * scorePerQuestion;
  const score = correctCount * scorePerQuestion;
  return {
    score,
    totalScore,
    pass: score >= Math.ceil(totalScore * 0.6),
    correctCount,
    total: questions.length,
    details
  };
}

/* ---------------- 会话存取（考试页 → 结果页之间传卷面） ---------------- */

export interface MockExamSession {
  id: string;
  title: string;
  subtitle: string;
  plan: MockExamPlan;
  /** 题目快照：题库若在考试期间变动，判分要仍按出卷时的内容来 */
  questions: Question[];
  responses: Record<string, UserResponse>;
  startedAt: number;
  finishedAt?: number;
}

const SESSION_KEY = 'mock-exam-session';

export function saveMockExamSession(storage: QuestionBankStorage, session: MockExamSession): void {
  storage.setStorageSync(SESSION_KEY, session);
}

export function loadMockExamSession(storage: QuestionBankStorage): MockExamSession | null {
  const raw = storage.getStorageSync(SESSION_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as MockExamSession;
  if (!s || !s.plan || !Array.isArray(s.questions) || !s.questions.length) return null;
  return s;
}
