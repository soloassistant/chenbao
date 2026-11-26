#!/usr/bin/env node
/**
 * verify-image-url.mjs —— 图片 URL 改写 / 准入规则的确定性门禁（2026-11-25）
 *
 * 为什么需要：imageUrl.ts 是纯函数，但此前只有一次性手测（297KB→12.6KB、npr 三种 Referer
 * 全 403）。后缀写错、hash 被吞、规则被改坏，都不会有门禁变红。
 *
 * 用法: node .tools/verify-image-url.mjs
 * 退出码: 0 全通过 / 1 有断言失败 / 2 构建失败
 */
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.tools', '.cache-image-url.cjs');

let mod;
try {
  await esbuild.build({
    stdin: {
      contents: "export * from './src/utils/imageUrl.ts';",
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'image-url-entry.ts'
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: OUT,
    logLevel: 'silent'
  });
  mod = createRequire(import.meta.url)(OUT);
} catch (e) {
  console.error('构建 imageUrl 失败:', e.message);
  process.exit(2);
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond === true) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}  ${detail}`); }
}

const { thumbUrl, isDroppableImage, THUMB_W, THUMB_H } = mod;

ok('T1 hdslb 原图加缩略后缀',
  thumbUrl('https://i0.hdslb.com/bfs/archive/a.jpg') === `https://i0.hdslb.com/bfs/archive/a.jpg@${THUMB_W}w_${THUMB_H}h_1c.webp`,
  String(thumbUrl('https://i0.hdslb.com/bfs/archive/a.jpg')));

ok('T2 query 原样保留',
  thumbUrl('https://i1.hdslb.com/a.png?x=1&y=2') === `https://i1.hdslb.com/a.png@${THUMB_W}w_${THUMB_H}h_1c.webp?x=1&y=2`,
  String(thumbUrl('https://i1.hdslb.com/a.png?x=1&y=2')));

ok('T3 hash 原样保留（注释承诺过，此前实现会丢）',
  thumbUrl('https://i2.hdslb.com/a.webp#frag') === `https://i2.hdslb.com/a.webp@${THUMB_W}w_${THUMB_H}h_1c.webp#frag`,
  String(thumbUrl('https://i2.hdslb.com/a.webp#frag')));

ok('T4 已有 @ 后缀被覆盖，不叠加',
  thumbUrl('https://i0.hdslb.com/a.jpg@100w_100h_1c.png') === `https://i0.hdslb.com/a.jpg@${THUMB_W}w_${THUMB_H}h_1c.webp`,
  String(thumbUrl('https://i0.hdslb.com/a.jpg@100w_100h_1c.png')));

ok('T5 非 hdslb 一律原样', thumbUrl('https://example.com/a.jpg') === 'https://example.com/a.jpg');
ok('T6 无扩展名接口地址不动', thumbUrl('https://i0.hdslb.com/api/cover?id=1') === 'https://i0.hdslb.com/api/cover?id=1');
ok('T7 空值返回 undefined', thumbUrl('') === undefined && thumbUrl(null) === undefined);

ok('D1 正常 https 图保留', isDroppableImage('https://example.com/a.jpg') === false);
ok('D2 data URL 丢弃', isDroppableImage('data:image/png;base64,xx') === true);
ok('D3 1x1 追踪像素丢弃', isDroppableImage('https://a.com/1x1.gif') === true);
ok('D4 pixel 文件名丢弃', isDroppableImage('https://a.com/pixel.png') === true);
ok('D5 pixel-art.jpg 不误杀', isDroppableImage('https://a.com/pixel-art.jpg') === false);
ok('D6 ?w=1 丢弃', isDroppableImage('https://a.com/a.jpg?w=1') === true);
ok('D7 ?width=100 保留', isDroppableImage('https://a.com/a.jpg?width=100') === false);
ok('D8 已知失效源站丢弃', isDroppableImage('https://npr.brightspotcdn.com/a.jpg') === true);
ok('D9 非字符串丢弃', isDroppableImage(undefined) === true && isDroppableImage(42) === true);

try { fs.rmSync(OUT, { force: true }); } catch { /* ignore */ }
console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail ? 1 : 0);
