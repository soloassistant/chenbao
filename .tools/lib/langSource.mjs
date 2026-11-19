/**
 * 词典源码读取（2026-11-19 英文词典拆到 src/store/language.en.ts 之后）。
 * 计数型断言读两份合并文本；英文专属断言单独读 en 文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => s.replace(/\r\n/g, '\n');

export function readLangFile(ROOT, which = 'zh') {
  const name = which === 'en' ? 'language.en.ts' : 'language.ts';
  return norm(fs.readFileSync(path.join(ROOT, 'src', 'store', name), 'utf8'));
}

export function readLangBoth(ROOT) {
  return `${readLangFile(ROOT, 'zh')}\n${readLangFile(ROOT, 'en')}`;
}
