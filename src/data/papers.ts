/**
 * A Level 历年真题索引。
 *
 * 数据来源：alevelclouds.com（第三方转存站），只收录 **链接**，不存任何试卷文件。
 * 版权归 Pearson Edexcel / AQA / Cambridge 各自所有，站内只做「原站跳转」，
 * 不复制、不镜像、不解析成题 —— 这是刻意选择，别为了"体验完整"改成自建副本。
 *
 * 重新抓取：`.tools/` 下的抓取脚本会重新生成 `papers.json`（结构见下方接口）。
 */
import raw from './papers.json';

export interface PaperSession {
  /** 年份，如 2026 */
  y: number;
  /** 月份，1 / 5 / 6 / 10 */
  m: number;
  /** 试卷（Question Paper / 试题）直链，缺失为空串 */
  qp: string;
  /** 评分标准（Mark Scheme / 答案）直链，缺失为空串 */
  ms: string;
  /** 同年同单元内的区分标记，如高考「数学」的文/理、综合的文/理 */
  tag?: string | null;
}

export interface PaperUnit {
  /** 原始单元号，如 P1 / P1A（A 卷）/ P1R（备用卷） */
  code: string;
  /** 去掉变体后缀的单元号，如 P1 */
  base: string;
  /** 单元中文名，如「纯数 1」 */
  label: string;
  sessions: PaperSession[];
}

export interface PaperSubject {
  id: string;
  name: string;
  units: PaperUnit[];
  /** 该科目试卷总数（不含评分标准） */
  qpCount: number;
}

export interface PaperBoard {
  id: string;
  name: string;
  nameCn: string;
  subjects: PaperSubject[];
}

interface PapersRaw {
  source: string;
  boards: PaperBoard[];
}

const DATA = raw as unknown as PapersRaw;

export const PAPERS_SOURCE = DATA.source;
export const PAPER_BOARDS: PaperBoard[] = DATA.boards;

/** 一场考季 + 它来自哪个变体卷（A 卷 / R 卷 / 基准卷） */
export interface SessionRow extends PaperSession {
  code: string;
  /** 是否变体卷：code !== base 时为 true，界面上要标出来 */
  variant: boolean;
}

/** 同一单元号下的所有变体卷合并成一组，界面上一个 chip 对应一组 */
export interface UnitGroup {
  base: string;
  label: string;
  codes: string[];
  rows: SessionRow[];
}

export function groupUnits(subject: PaperSubject): UnitGroup[] {
  const order: string[] = [];
  const bucket = new Map<string, UnitGroup>();
  for (const unit of subject.units) {
    const key = unit.base;
    if (!bucket.has(key)) {
      bucket.set(key, { base: key, label: unit.label, codes: [], rows: [] });
      order.push(key);
    }
    const group = bucket.get(key)!;
    group.codes.push(unit.code);
    for (const s of unit.sessions) {
      group.rows.push({ ...s, code: unit.code, variant: unit.code !== key });
    }
  }
  for (const key of order) {
    const group = bucket.get(key)!;
    // 同一年同一考季里，基准卷排在变体卷前面
    group.rows.sort((a, b) => b.y - a.y || b.m - a.m || Number(a.variant) - Number(b.variant));
  }
  return order.map((key) => bucket.get(key)!);
}

/** 全站试卷总数（各科目相加，仅试卷不含评分标准） */
export function totalPapers(): number {
  return PAPER_BOARDS.reduce(
    (sum, b) => sum + b.subjects.reduce((s2, s) => s2 + s.qpCount, 0),
    0
  );
}
