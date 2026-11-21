/**
 * AI 讲解错题（2026-11-16）—— 交卷后针对答错的题给「错因 + 正确思路」。
 *
 * 为什么只讲错题：
 *   · 全对时没有可讲的东西，白花一次调用；
 *   · 一次卷子通常只错 1–3 道，prompt 短、结果准，比整卷讲解便宜得多。
 *
 * 为什么用 cloudLlmChat 而不是 chatViaCloudLlm：
 *   后者是 AI 助手对话的封装，会把回复强制解析成 `{reply:"..."}`，没有该字段就返回 null。
 *   这里要的是自定义 JSON 结构，必须用底层接口（2026-11-16 在出题功能上踩过这个坑）。
 *
 * 诚实性：
 *   讲解由模型生成，**可能不准**。调用方必须标注来源；同时这里只做「讲」，不改分数、
 *   不改答案键 —— 分数永远以本地判分为准。
 */
import type { Question } from '@/types/questionBank';
import type { UserResponse } from '@/utils/questionBankGrading';
import { appStorage } from '@/utils/appStorage';
import { cloudLlmChat } from './cloudLlm';
import { finishAiEntry, guardAiEntry } from './aiEntryGuard';

export interface ReviewItem {
  question: Question;
  response: UserResponse;
}

/** 讲解结果按**场次**存：同一张卷再进结果页直接复用，不重复调用模型（2026-11-19）。 */
const REVIEW_KEY_PREFIX = 'mock-ai-review:';

export function loadStoredReview(sessionId: string): ReviewResult | null {
  try {
    const v = appStorage().getStorageSync(REVIEW_KEY_PREFIX + sessionId);
    if (!v || typeof v !== 'object') return null;
    const o = v as ReviewResult;
    if (!o.byId || typeof o.byId !== 'object' || typeof o.count !== 'number') return null;
    return o;
  } catch {
    return null;
  }
}

export function saveStoredReview(sessionId: string, result: ReviewResult): void {
  try {
    appStorage().setStorageSync(REVIEW_KEY_PREFIX + sessionId, result);
  } catch (err) {
    console.error('[mockReview] persist result failed:', err);
  }
}

export interface ReviewResult {
  /** questionId -> 讲解正文 */
  byId: Record<string, string>;
  /** 实际讲了几道 */
  count: number;
}

export type ReviewOutcome =
  | { ok: true; result: ReviewResult }
  | { ok: false; reason: string };

/** 把学生答案整理成人能读的一行（与结果页 myAnswer 口径一致）。 */
function readable(resp: UserResponse): string {
  if (resp === null || resp === undefined) return '未作答';
  if (typeof resp === 'boolean') return resp ? '对' : '错';
  if (Array.isArray(resp)) return resp.join(', ');
  return String(resp);
}

function optionsLine(q: Question): string {
  if (!q.options || !q.options.length) return '';
  return q.options.map((o) => `${o.key}. ${o.text}`).join(' | ');
}

/** 从模型输出里抠 JSON 对象（容忍 ```json 包裹与前后废话）。 */
function extractJsonObject(raw: string): Record<string, unknown> {
  const text = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no-json-object');
  return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * 生成错题讲解。
 *
 * @param items 只传**答错的**题；调用方负责筛选（见 mockExamResult）。
 */
export async function reviewWrongAnswers(items: ReviewItem[]): Promise<ReviewOutcome> {
  const list = items.slice(0, 6); // 上限 6 道：再多一次输出太长，也超出「顺手看看」的耐心
  if (!list.length) return { ok: false, reason: 'nothing-to-review' };

  const blocks = list.map((it, i) => {
    const q = it.question;
    return [
      `第 ${i + 1} 题`,
      `题干：${q.stem}`,
      optionsLine(q) ? `选项：${optionsLine(q)}` : '',
      `正确答案：${String(q.answerKey)}`,
      `学生选择：${readable(it.response)}`
    ]
      .filter(Boolean)
      .join('\n');
  });

  const userContent = [
    '下面是学生刚做完的一套模拟题里**答错的题**。请逐题讲解。',
    '',
    blocks.join('\n\n'),
    '',
    '要求：',
    '1. 每题分两段：先一句指出学生为什么选错（点出常见误区），再给正确思路（3–5 句，纯文本公式）。',
    '2. 不要重复题干，不要复述选项。',
    '3. 严格输出 JSON 对象，键为 "q1"、"q2"… 与上面的题号对应，值为讲解正文。',
    '4. 不要 markdown 代码块，不要任何多余文字。'
  ].join('\n');

  // 讲解与新出题走同一道闸：内容 + 额度检查在调用前，成功后只补本地镜像（2026-11-19）
  const guard = await guardAiEntry(userContent);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const raw = await cloudLlmChat({
    system: '你是严谨的国际课程老师，擅长把学生的错因说透。只输出 JSON 对象，不要解释文字。',
    userContent
  });
  if (!raw) return { ok: false, reason: 'ai-unavailable' };
  const after = finishAiEntry(raw);
  if (!after.ok) return { ok: false, reason: after.reason };

  let obj: Record<string, unknown>;
  try {
    obj = extractJsonObject(raw);
  } catch {
    return { ok: false, reason: 'ai-bad-json' };
  }

  const byId: Record<string, string> = {};
  list.forEach((it, i) => {
    const v = obj[`q${i + 1}`];
    if (typeof v === 'string' && v.trim()) byId[it.question.id] = v.trim();
  });
  if (!Object.keys(byId).length) return { ok: false, reason: 'ai-empty' };

  return { ok: true, result: { byId, count: Object.keys(byId).length } };
}
