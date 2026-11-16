/**
 * AI 出题（2026-11-16）—— 按考点生成一套可判分的单选题。
 *
 * 为什么做这件事：模拟考只会从本地题库选题，用户没导入题就考不了；
 * 而题库里的题要靠手动导入 JSON/CSV。AI 出题把「想练一套」这件事的成本降到一次点击。
 *
 * 为什么只出单选：
 *   · 自动判分需要唯一确定答案；填空/简答的判分规则太脆（等价写法、单位、精度）。
 *   · 真题里的图表/流程图题不做 —— 纯文本表达不了，强行出题会写出残缺题干
 *     （2026-11-16 从 PDF 提取真题时实测：流程图变成「START STOP INPUT A 10 A Let B 1 () 2」）。
 *
 * 诚实性：题目由模型生成，**可能有错**。调用方必须在 UI 上标明来源，
 * 生成结果里同时写入 source='ai' 与一句提示，方便用户在题库里辨认。
 */
import { questionId, stemHash } from '@/utils/questionBank';
import type { Board, ExamSystem, Level, Question } from '@/types/questionBank';
import { cloudLlmChat } from './cloudLlm';

export interface GenQuestionDraft {
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: string;
  explanation?: string;
}

export type GenResult =
  | { ok: true; questions: Question[] }
  | { ok: false; reason: string };

const KEYS = ['A', 'B', 'C', 'D'];

/** 从模型输出里抠出 JSON 数组：模型常把结果包在 ```json ... ``` 里，或前后带解释文字。 */
function extractJsonArray(raw: string): unknown {
  const text = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no-json-array');
  return JSON.parse(body.slice(start, end + 1));
}

/** 校验一道题是否合法：4 个 ABCD 选项、答案在选项内、题干够长、无重复选项。 */
function validateDraft(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'not-object';
  const o = d as Record<string, unknown>;
  const stem = typeof o.stem === 'string' ? o.stem.trim() : '';
  if (stem.length < 8) return 'stem-too-short';
  if (!Array.isArray(o.options) || o.options.length !== 4) return 'options-neq-4';
  const texts = new Set<string>();
  for (const opt of o.options as Array<Record<string, unknown>>) {
    const k = String(opt?.key || '').toUpperCase();
    const t = typeof opt?.text === 'string' ? opt.text.trim() : '';
    if (!KEYS.includes(k)) return 'bad-option-key';
    if (!t) return 'empty-option';
    if (texts.has(t)) return 'duplicate-option'; // 重复选项 = 等于少一个选项
    texts.add(t);
  }
  const keys = (o.options as Array<Record<string, unknown>>).map((x) => String(x?.key || '').toUpperCase());
  const ans = String(o.answer || '').toUpperCase();
  if (!keys.includes(ans)) return 'answer-not-in-options';
  return null;
}

/**
 * 按考点生成一套单选题。
 *
 * @param opts.topic    人类可读的卷面范围，例如「Edexcel Decision Mathematics D1」
 * @param opts.tags     考点标签（来自真题库的 binding），可为空
 * @param opts.count    要几道（限制在 3–10，太少没意义，太多模型容易凑数）
 */
export async function generateQuestions(opts: {
  topic: string;
  tags: string[];
  count?: number;
  deep?: boolean;
  /** 必须与题库闭集一致：alevel 的数学是 'mathematics'，不是 'maths'。
   *  传错过一次，repo.add() 会因为 knowledgeTags/subject 校验直接拒收。 */
  examSystem?: ExamSystem;
  board?: Board;
  subject?: string;
  level?: Level;
}): Promise<GenResult> {
  const count = Math.min(10, Math.max(3, opts.count || 6));
  const tagLine = opts.tags.length ? `考点范围：${opts.tags.join('、')}` : '考点范围：该单元的核心考点';

  const prompt = [
    `你是一位严谨的国际课程命题老师。请围绕「${opts.topic}」出 ${count} 道单项选择题。`,
    tagLine,
    '',
    '硬性要求：',
    '1. 每道题的条件与数字必须全部写在题干里，**能纯文本表达**：不要图表、不要流程图、不要依赖配图。',
    '2. 每题恰好 4 个选项，key 依次为 A/B/C/D，只有一个正确答案。',
    '3. 四个选项互不相同，干扰项要合理（常见错误思路），不要凑数。',
    '4. 严格输出 JSON 数组，不要 markdown 代码块，不要任何解释文字。',
    '5. 字段：{"stem":"题干","options":[{"key":"A","text":"..."}],"answer":"A","explanation":"解析"}',
    '6. 数学公式用纯文本写法（如 3/4、x^2、sqrt(5)），不要 LaTeX 反斜杠命令。'
  ].join('\n');

  /* 用底层 cloudLlmChat 而不是 chatViaCloudLlm：
   * 后者是「AI 助手对话」的封装，会把回复**强制解析成 {reply:"..."} 协议**，
   * 没有 reply 字段就返回 null（2026-11-16 实测：这里一直报「AI 暂不可用」，
   * 其实模型已经正常返回了 JSON 数组）。
   * cloudLlmChat 要求 system 非空（硬契约），所以这里的 system 是命题指令本身。 */
  const raw = await cloudLlmChat({
    system: '你是严格的国际课程命题老师。只输出 JSON 数组，不要 markdown 代码块，不要任何解释文字。',
    userContent: prompt
  });
  if (!raw) return { ok: false, reason: 'ai-unavailable' };

  let arr: unknown;
  try {
    arr = extractJsonArray(raw);
  } catch {
    return { ok: false, reason: 'ai-bad-json' };
  }
  if (!Array.isArray(arr) || !arr.length) return { ok: false, reason: 'ai-empty' };

  const now = new Date().toISOString();
  const questions: Question[] = [];
  for (const d of arr.slice(0, count)) {
    if (validateDraft(d)) continue; // 单题不合格就跳过，不因为一道题废掉整卷
    const o = d as { stem: string; options: Array<{ key: string; text: string }>; answer: string; explanation?: string };
    const stem = o.stem.trim();
    questions.push({
      id: questionId(),
      stemHash: stemHash(stem),
      stem,
      options: o.options.map((x) => ({ key: String(x.key).toUpperCase(), text: x.text.trim() })),
      type: 'single',
      answerKey: String(o.answer).toUpperCase(),
      explanation: o.explanation ? String(o.explanation) : '',
      examSystem: opts.examSystem || 'alevel',
      board: opts.board || 'edexcel',
      subject: opts.subject || 'mathematics',
      level: opts.level || 'a2',
      knowledgeTags: opts.tags.length ? opts.tags.slice(0, 6) : ['AI 生成'],
      difficulty: 3,
      // 来源单列一档：用户要能分辨「模型出的题」和「自己出的题」
      source: 'ai',
      langCode: 'zh',
      createdAt: now,
      updatedAt: now,
      // 再用 syllabusCode 留一个肉眼可辨的标记（题库列表里显示）
      syllabusCode: 'AI-GEN'
    });
  }

  if (!questions.length) return { ok: false, reason: 'ai-all-invalid' };
  return { ok: true, questions };
}
