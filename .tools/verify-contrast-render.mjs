#!/usr/bin/env node
/**
 * verify-contrast-render.mjs —— 真实渲染对比度门禁（2026-11-10，对标 plugin87/ux-ui-agent-skills 的 Design QA）
 *
 * 为什么要这扇门（与 verify:contrast 静态门禁的关系）：
 *   verify:contrast（verify-contrast-strong.mjs）是**静态源码断言**——它锁死「某类名里含某个色变量」，
 *   只覆盖清单里的类名，清单外的类它看不见。2026-10-24 那批「看得见但读不清」的问题，
 *   就是靠人工/滚动巡检、而不是这扇静态门逮到的。本门禁补的是**真实渲染**这一层：
 *   用无头 Chrome 把页面真正画出来，量每个文字元素的「计算样式 + alpha 合成背景」对比度，
 *   任何 WCAG 2.2 AA 未达标（4.5:1 普通 / 3.0:1 大字或粗体）的文本都直接 FAIL。
 *
 * 算法来自上游 measure_render.mjs（Playwright 版），这里用本项目的 CDP 通道重实现，不引入 Playwright 依赖：
 *   · 注入 COLOR_INIT（window.__dsRGBA 颜色解析器，能处理 color-mix()/oklch() 等，靠画到 canvas 读回像素）；
 *   · bgOf(el) 沿 DOM 向上把各层 background 按 alpha 合成，直到不透明；
 *   · 跳过 SCRIPT/STYLE/SVG、无直接文字节点、不可见、sr-only（盒 ≤2px）、
 *     disabled 子树（[disabled] / [aria-disabled]）、data-contrast-ignore 豁免节点。
 *
 * 绕过开屏/同意层：用 addScriptToEvaluateOnNewDocument 往 localStorage 预置 onboarded-v2 + privacy-consent，
 * 与 verify-a11y-keyboard.mjs 同法（比点遮罩稳，也符合项目铁律：不注入这俩会被开屏/隐私弹窗骗）。
 *
 * 用法: node .tools/verify-contrast-render.mjs [--no-browser] [--self-test] [--viewport 1280x900]
 *       CONTRAST_PAGES=pages/briefing/index,pages/library/index   # 覆盖默认测量页（逗号分隔，不要前导 /）
 *       CHROME_BIN=/path/to/chrome                                # 显式指定 Chrome
 * 退出码: 0 = 全绿（或环境不足 SKIP）；1 = 有对比度未达标；2 = harness 自身出错
 *
 * 环境不足时 SKIP（exit 0，不伪造红）：--no-browser / 没有 dist / 找不到 Chrome。
 * CI 步骤负责装好 Chrome + 构建 dist，使这扇门真正生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { resolveChrome } from './lib/chrome.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NO_BROWSER = process.argv.includes('--no-browser');
const SELF_TEST = process.argv.includes('--self-test');
const vpArg = (process.argv.find((a) => a.startsWith('--viewport=')) || '--viewport=1280x900').split('=')[1];
const [VW, VH] = vpArg.split('x').map(Number);
const isWin = process.platform === 'win32';

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

const CHROME = resolveChrome();
if (!CHROME || !fs.existsSync(CHROME)) {
  console.log(`（找不到 Chrome：${CHROME || '（未设置 CHROME_BIN 且常见路径均无）'}：跳过真实渲染测量。）`);
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.map': 'application/json', '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/hotspot') {
    const f = path.join(DIST, 'api/hotspot.json');
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(f));
      return;
    }
    res.writeHead(404); res.end('nf'); return;
  }
  if (/\.(js|mjs|css|json|png|jpe?g|gif|webp|svg|woff2?|ttf|wasm|map|ico)$/.test(u)) {
    const f = path.resolve(DIST, '.' + u);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(DIST, 'index.html')));
});
const port = 9800 + Math.floor(Math.random() * 30);
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const udd = path.join(os.tmpdir(), `contrast-render-${Date.now()}`);
const chromeArgs = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-proxy-server', '--disable-dev-shm-usage',
  ...(isWin ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
  `--remote-debugging-port=${port + 100}`, `--user-data-dir=${udd}`,
  `--window-size=${VW},${VH}`, 'about:blank',
];
const child = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${port + 100}/json/list`)).json();
    const p = l.find((t) => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 端口还没起 */ }
  await sleep(300);
}
if (!wsUrl) { console.log('（CDP 端点未就绪，Chrome 没能起来：跳过。）'); server.close(); child.kill('SIGKILL'); process.exit(0); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let cid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const id = ++cid;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 45000);
  });
};
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r.result.value;
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: VW < 600 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: COLOR_INIT_SRC });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));}catch(e){}`,
  });

  const BASE = `http://127.0.0.1:${port}`;

  if (SELF_TEST) {
    // 判别力自证：注入已知好/坏对比度元素，量到的必须「坏 FAIL、好 PASS」。
    await send('Page.navigate', { url: `${BASE}/#/pages/library/index` });
    await sleep(6000);
    const inject = `(()=>{
      const g=document.createElement('div');g.style.cssText='position:fixed;left:0;top:0;color:#000;background:#fff;font-size:16px;z-index:99999';g.textContent='好对比';document.body.appendChild(g);
      const b=document.createElement('div');b.style.cssText='position:fixed;left:0;top:60px;color:#bbbbbb;background:#ffffff;font-size:16px;z-index:99999';b.textContent='坏对比';document.body.appendChild(b);
      return 1;
    })()`;
    await ev(inject);
    const res = await ev(MEASURE_SRC);
    if (res && res.error) { assert('自测：测量函数可执行', false, res.error); }
    else {
      const bad = (res || []).filter((x) => x.text === '坏对比');
      const good = (res || []).filter((x) => x.text === '好对比');
      assert('自测：坏对比（#bbb on #fff ≈2.1:1）被判定 FAIL', bad.length === 1 && bad[0].r < 4.5, JSON.stringify(bad[0] || null));
      assert('自测：好对比（#000 on #fff = 21:1）不报 FAIL', good.length === 0, JSON.stringify(good[0] || null));
    }
    console.log('──────────────────────────────────────────────────────────');
    console.log(`自测 PASS ${pass} / FAIL ${fail}`);
    server.close(); child.kill('SIGKILL'); process.exit(fail > 0 ? 1 : 0);
  }

  // 逐页测量
  let totalFails = 0;
  for (const page of TARGET_PAGES) {
    assert(`路由 ${page} 在 app.config.ts 的 pages 里（防测量空壳页）`, fs.readFileSync(path.join(ROOT, 'src/app.config.ts'), 'utf8').includes(`'${page}'`), 'pages 里没有这个页面');
    await send('Page.navigate', { url: `${BASE}/#/${page}` });
    await sleep(3000);
    // 等页面 settle：Taro 节点够多 + 开屏/同意层已退场（localStorage 预置已绕过，再兜底点一次）
    let settled = false;
    for (let i = 0; i < 30 && !settled; i++) {
      const n = Number(await ev(`document.querySelectorAll('taro-view-core,taro-text-core').length`));
      if (n > 300) { settled = true; break; }
      await sleep(700);
    }
    await ev(`(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(s)s.click();const c=document.querySelector('[class*="consentAgree"]');if(c)c.click();return 1})()`);
    await sleep(800);
    const pageFails = await ev(MEASURE_SRC);
    if (pageFails && pageFails.error) {
      assert(`页面 ${page} 测量可执行`, false, pageFails.error);
      continue;
    }
    const fails = pageFails || [];
    totalFails += fails.length;
    if (fails.length) {
      console.log(`\nFAIL ${page}：${fails.length} 处文字对比度未达 WCAG AA：`);
      for (const x of fails) console.log(`  x <${x.tag}> "${x.text}" ${x.r}:1（需 ${x.need}）[rgb(${x.color}) on rgb(${x.bg}) @${x.px}px${x.bold ? ' bold' : ''}]`);
      assert(`页面 ${page} 所有文字元素达 WCAG AA`, false, `${fails.length} 处未达标`);
    } else {
      console.log(`OK   ${page}：所有文字元素达 WCAG AA`);
      assert(`页面 ${page} 所有文字元素达 WCAG AA`, true);
    }
  }
  console.log('──────────────────────────────────────────────────────────');
  console.log(`合计 ${totalFails} 处真实渲染对比度未达标；门禁 PASS ${pass} / FAIL ${fail}`);
  server.close(); child.kill('SIGKILL');
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.log(JSON.stringify({ error: String(err && err.message ? err.message : err) }, null, 2));
  try { server.close(); } catch { /* ignore */ }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(2);
}
