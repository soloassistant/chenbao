/**
 * AI 结构化输出校验（A06，2026-11-22）。
 *
 * 背景：`safeParseReply` 只负责「从模型文本里把 JSON 抠出来」，能 parse 就往下传。
 * 模型漏字段、把 amount 写成字符串、把日期写成「明天下午」时，UI 会静默渲染半截数据。
 * PRD §6 A06 写的是「不合法即失败，不猜」——这里补上那一层。
 *
 * 口径：
 * · 只做**结构与类型**校验，不做业务推理（不替模型补日期、不纠正单位）。
 * · 校验失败抛 `AiSchemaError`，调用方展示明确失败，不得降级成「部分可用」。
 * · 上限用于挡住异常大的返回（模型重复输出），不是业务限制。
 */
import dayjs from 'dayjs';
import type { ExtractResult } from '@/types';

export class AiSchemaError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`ai_schema_invalid:${reason}`);
    this.name = 'AiSchemaError';
    this.reason = reason;
  }
}

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_EVENTS = 30;
const MAX_TODOS = 50;
const MAX_TITLE = 200;

function fail(reason: string): never {
  throw new AiSchemaError(reason);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, field: string, max = MAX_TITLE): string {
  if (typeof v !== 'string') fail(`${field}:not_string`);
  const s = v.trim();
  if (!s) fail(`${field}:empty`);
  if (s.length > max) fail(`${field}:too_long`);
  return s;
}

function optionalStr(v: unknown, field: string, max = 500): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') fail(`${field}:not_string`);
  if (v.length > max) fail(`${field}:too_long`);
  return v;
}

/** 只接受 'YYYY-MM-DD HH:mm' 且是真实时间；不做「明天下午」这类自然语言补全。 */
function dateTime(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE_TIME_RE.test(v)) fail(`${field}:bad_datetime`);
  if (!dayjs(v, 'YYYY-MM-DD HH:mm').isValid()) fail(`${field}:invalid_datetime`);
  return v;
}

function optionalDateTime(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return dateTime(v, field);
}

function optionalDate(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !DATE_RE.test(v)) fail(`${field}:bad_date`);
  if (!dayjs(v, 'YYYY-MM-DD').isValid()) fail(`${field}:invalid_date`);
  return v;
}

function arr(v: unknown, field: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(`${field}:not_array`);
  if (v.length > max) fail(`${field}:too_many`);
  return v;
}

export function validateExtractResult(raw: unknown): ExtractResult {
  if (!isPlainObject(raw)) fail('root:not_object');

  const events = arr(raw.events, 'events', MAX_EVENTS).map((item, i) => {
    if (!isPlainObject(item)) fail(`events[${i}]:not_object`);
    const startTime = dateTime(item.startTime, `events[${i}].startTime`);
    const endTime = optionalDateTime(item.endTime, `events[${i}].endTime`);
    if (endTime && dayjs(endTime).isBefore(dayjs(startTime))) fail(`events[${i}]:end_before_start`);
    return {
      title: str(item.title, `events[${i}].title`),
      startTime,
      endTime,
      location: optionalStr(item.location, `events[${i}].location`),
      note: optionalStr(item.note, `events[${i}].note`, 1000)
    };
  });

  const todos = arr(raw.todos, 'todos', MAX_TODOS).map((item, i) => {
    if (!isPlainObject(item)) fail(`todos[${i}]:not_object`);
    return {
      title: str(item.title, `todos[${i}].title`),
      dueDate: optionalDate(item.dueDate, `todos[${i}].dueDate`),
      source: optionalStr(item.source, `todos[${i}].source`)
    };
  });

  const bills = arr(raw.bills, 'bills', MAX_TODOS).map((item, i) => {
    if (!isPlainObject(item)) fail(`bills[${i}]:not_object`);
    const amount = item.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1e7) {
      fail(`bills[${i}].amount:bad_number`);
    }
    return {
      title: str(item.title, `bills[${i}].title`),
      amount,
      dueDate: optionalDate(item.dueDate, `bills[${i}].dueDate`) ?? null,
      source: optionalStr(item.source, `bills[${i}].source`)
    };
  });

  const shoppingItems = arr(raw.shoppingItems, 'shoppingItems', MAX_TODOS).map((item, i) => {
    if (!isPlainObject(item)) fail(`shoppingItems[${i}]:not_object`);
    return {
      title: str(item.title, `shoppingItems[${i}].title`),
      note: optionalStr(item.note, `shoppingItems[${i}].note`) ?? null,
      source: optionalStr(item.source, `shoppingItems[${i}].source`)
    };
  });

  const vocabularies = arr(raw.vocabularies, 'vocabularies', MAX_TODOS).map((item, i) => {
    if (!isPlainObject(item)) fail(`vocabularies[${i}]:not_object`);
    return {
      word: str(item.word, `vocabularies[${i}].word`, 80),
      meaning: optionalStr(item.meaning, `vocabularies[${i}].meaning`),
      source: optionalStr(item.source, `vocabularies[${i}].source`)
    };
  });

  let collection: ExtractResult['collection'];
  if (raw.collection !== undefined && raw.collection !== null) {
    if (!isPlainObject(raw.collection)) fail('collection:not_object');
    collection = {
      title: str(raw.collection.title, 'collection.title'),
      summary: optionalStr(raw.collection.summary, 'collection.summary', 2000) || '',
      tags: arr(raw.collection.tags, 'collection.tags', 10).map((tag, i) =>
        str(tag, `collection.tags[${i}]`, 40)
      )
    } as ExtractResult['collection'];
  }

  const note = optionalStr(raw.note, 'note', 2000);

  return {
    events: events as ExtractResult['events'],
    todos: todos as ExtractResult['todos'],
    bills,
    shoppingItems,
    vocabularies,
    collection,
    note
  };
}
