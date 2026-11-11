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

/* ─── Chrome 路径：CHROME_BIN 优先；否则按平台猜常见位置 ─── */
function resolveChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (isWin) return 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
  for (const p of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    `${os.homedir()}/.cache/ms-playwright/chromium-*/chrome-linux/chrome`,
  ]) {
    // 支持末尾通配（playwright 版本号未知）
    if (p.includes('*')) {
      const dir = path.dirname(p);
      const base = path.basename(p).replace('*', '');
      try {
        const hit = fs.readdirSync(dir).find((f) => f.startsWith(base.replace(/\*$/, '')) || f.includes('chromium'));
        if (hit) {
          const full = path.join(dir, hit, 'chrome-linux', 'chrome');
          if (fs.existsSync(full)) return full;
        }
      } catch { /* ignore */ }
      continue;
    }
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ─── 颜色解析器（来自上游 _color.mjs 的 COLOR_INIT，注入页面后提供 window.__dsRGBA） ─── */
function COLOR_INIT() {
  let cx = null;
  const memo = new Map();
  window.__dsRGBA = (s) => {
    if (!s) return null;
    if (s === 'transparent') return [0, 0, 0, 0];
    const rgb = /^rgba?\(([^)]*)\)$/.exec(s);
    if (rgb) {
      const p = rgb[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3 && p.every((n) => !Number.isNaN(n))) return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]];
    }
    if (memo.has(s)) return memo.get(s);
    let out = null;
    const m = /^([a-z-]+)\((.*)\)$/i.exec(s.trim());
    if (m) {
      const [body, alpha] = m[2].split('/');
      let a = 1;
      if (alpha !== undefined) a = alpha.trim().endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
      if (!cx) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; cx = cv.getContext('2d', { willReadFrequently: true }); }
      const sentinel = '#010203';
      cx.fillStyle = sentinel;
      cx.fillStyle = `${m[1]}(${body.trim()})`;
      if (cx.fillStyle !== sentinel && !Number.isNaN(a)) {
        cx.clearRect(0, 0, 1, 1);
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        out = [d[0], d[1], d[2], a];
      }
    }
    memo.set(s, out);
    return out;
  };
}
const COLOR_INIT_SRC = `(${COLOR_INIT.toString()})();`;

/* ─── 页面内测量函数（返回未达标的文字元素列表） ─── */
function measurePage() {
  const toRGBA = (s) => window.__dsRGBA(s);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const l1 = L(a), l2 = L(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  // 沿 DOM 向上合成背景；遇渐变（background-image）则按「最差档」估算——
  // 文字可能压在渐变任一位置，故取与文字对比度最低的那一档 stop，避免漏报真问题。
  // ⚠️ 只读 backgroundColor 会漏掉渐变按钮（文字实际压在 background-image 上），
  // 上游 measure_render.mjs 也有此局限；这里补上渐变解析。
  /** 把「上→下」的一串背景层叠成最终底色。
   *  ⚠️ 2026-11-11 修一个**合成顺序** bug：原来每层都用「当前层压已有 base」叠，
   *  而遍历是从元素自身**往上**走 ⇒ 祖先那层不透明底色把子层的半透明底直接盖掉了。
   *  实测后果：视频时长标签 `rgba(0,0,0,.62)` 的深色底被祖先的 #faf6f0 覆盖，
   *  门禁报 1.08:1 —— 而真实渲染里白字压在深底上是 6.4:1，完全可读 ⇒ **假红**。
   *  现在改成：先把链上的层收集起来（元素自身在最上），再**从最底层往上叠**。
   */
  const compose = (stack) => {
    let base = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i];
      base = [c[0] * c[3] + base[0] * (1 - c[3]), c[1] * c[3] + base[1] * (1 - c[3]), c[2] * c[3] + base[2] * (1 - c[3])];
    }
    return base;
  };
  function bgContrast(textCol, el) {
    const stack = [];
    let n = el;
    while (n) {
      const cs = getComputedStyle(n);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none' && /gradient/.test(bi)) {
        const stops = (bi.match(/rgba?\([^)]*\)/g) || []).map(toRGBA).filter(Boolean)
          .concat((bi.match(/#[0-9a-f]{3,8}/gi) || []).map(toRGBA).filter(Boolean));
        if (stops.length) {
          const base = compose(stack);
          let worst = Infinity;
          let worstBase = base;
          for (const s of stops) {
            const comp = [s[0] * s[3] + base[0] * (1 - s[3]), s[1] * s[3] + base[1] * (1 - s[3]), s[2] * s[3] + base[2] * (1 - s[3])];
            const r = ratio(textCol, comp);
            if (r < worst) { worst = r; worstBase = comp; }
          }
          return { ratio: worst, base: worstBase }; // 渐变不透明，向上不再看
        }
      }
      const c = toRGBA(cs.backgroundColor);
      if (c && c[3] > 0) {
        stack.push(c);
        if (c[3] >= 1) break;
      }
      n = n.parentElement;
    }
    const base = compose(stack);
    return { ratio: ratio(textCol, base), base };
  }
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName;
    if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'USE'].includes(tag)) continue;
    if (el.closest('[disabled], [aria-disabled="true"], [data-contrast-ignore]')) continue;
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length);
    if (!direct) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 2 && box.height <= 2) continue; // sr-only
    if (!el.offsetParent && cs.position !== 'fixed') continue; // 不可见
    const col = toRGBA(cs.color);
    if (!col) continue;
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3.0 : 4.5;
    const bgInfo = bgContrast(col, el);
    const r = bgInfo.ratio;
    if (r < need) {
      const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      out.push({
        tag: (tag + (cls ? '.' + cls : '')).slice(0, 44),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        r: +r.toFixed(2),
        need,
        color: col.slice(0, 3).map(Math.round),
        bg: bgInfo.base.map(Math.round),
        px: +px.toFixed(1),
        bold,
      });
    }
  }
  return out;
}
const MEASURE_SRC = `(${measurePage.toString()})()`;

/* ─── 默认测量页：tabBar 5 个公开页（免登录墙），全局 DesktopNav 对比度在这几页都暴露 ─── */
const DEFAULT_PAGES = [
  'pages/briefing/index',
  'pages/inbox/index',
  'pages/library/index',
  'pages/calendar/index',
  'pages/mine/index',
];
const TARGET_PAGES = (process.env.CONTRAST_PAGES || DEFAULT_PAGES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

console.log('真实渲染对比度门禁 (verify:contrast-render)');
console.log('──────────────────────────────────────────────────────────');

if (NO_BROWSER) {
  console.log('（--no-browser：跳过真实渲染测量）');
  process.exit(0);
}
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('（没有 dist/index.html：跳过，先构建。本门禁需要构建产物才能渲染。）');
  process.exit(0);
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
