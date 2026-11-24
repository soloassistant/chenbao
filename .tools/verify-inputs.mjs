#!/usr/bin/env node
/**
 * verify-inputs.mjs —— 打字框对齐巡检（2026-11-24）
 *
 * 只回答一个问题：所有 input / textarea 的**左边缘**是否与同组标签对齐、
 * 文字是否在框内垂直居中、框高是否够点。
 *
 * 判据（任一命中即 FAIL）：
 *   I1 左侧未对齐：同容器内最近的前置文本标签，左边缘差 > 2px
 *   I2 文字偏心：上下内边距差 > 4px（文字被顶到一边）
 *   I3 框太矮：渲染高度 < 36px
 *   I4 溢出容器：右边缘超出父容器内容区 > 2px
 *
 * 用法: node .tools/verify-inputs.mjs [--dist=...] [--only=login,mine] [--viewport=390]
 * 退出码: 0 全绿 / 1 有失败 / 2 harness 出错
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const DIST = arg('dist') || path.join(ROOT, 'dist');
const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const ONLY = (arg('only') || '').split(',').filter(Boolean);
const ONLY_VP = arg('viewport');
/** 反向变异开关：注入左偏移，验证判据不是永远绿 */
const MUTATE = process.env.INPUT_MUTATION === '1';

const ROUTES = ['login', 'search', 'mine', 'prefs', 'membership', 'inbox', 'assistant', 'ledger', 'sport', 'shopping', 'calendar', 'learnCommunity', 'questionBank', 'questionBankImport'];
const VIEWPORTS = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];

function routes() {
  const pages = fs.readFileSync(path.join(ROOT, 'src/app.config.ts'), 'utf8');
  return ROUTES.filter((r) => !ONLY.length || ONLY.includes(r)).filter((r) => pages.includes(`pages/${r}/index`));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.resolve(DIST, '.' + (url === '/' ? '/index.html' : url));
      if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const WATCHDOG = setTimeout(() => { console.error('✗ verify-inputs 超时'); process.exit(2); }, 12 * 60 * 1000);

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('未跑（无 dist）'); process.exit(0); }
  if (!fs.existsSync(CHROME)) { console.error(`✗ 找不到 Chrome: ${CHROME}`); process.exit(2); }

  const list = routes();
  const { server, port } = await startServer();
  const udd = path.join(os.tmpdir(), `in-${Date.now()}`);
  const dbg = 9300 + Math.floor(Math.random() * 60);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--no-proxy-server', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${udd}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

  let launchError = null;
  child.on('error', (e) => { launchError = e; });
  let wsUrl;
  for (let i = 0; i < 100 && !launchError; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${dbg}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      const p = l.find((t) => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch { /* 等端口 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!wsUrl) { console.error(`✗ Chrome DevTools 未就绪${launchError ? `：${launchError.message}` : ''}`); try { child.kill(); server.close(); } catch {} process.exit(2); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('ws 超时')), 10000); ws.onopen = () => { clearTimeout(t); res(); }; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); reject(new Error(`CDP ${method} 超时`)); }, 10000);
    pending.set(i, (r) => { clearTimeout(timer); resolve(r); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return null;
    return r.result?.result?.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));localStorage.setItem('theme-mode', JSON.stringify({data:'light'}));}catch(e){}`
  });

  const rows = [];
  for (const vp of VIEWPORTS) {
    if (ONLY_VP && String(vp.w) !== ONLY_VP) continue;
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 600 });
    for (const route of list) {
      await send('Page.navigate', { url: 'about:blank' });
      await new Promise((r) => setTimeout(r, 120));
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/?in=${vp.w}-${route}#/pages/${route}/index` });
      await new Promise((r) => setTimeout(r, 3500));
      const found = await ev(`(() => {
        const out = [];
        const inputs = [...document.querySelectorAll('input, textarea')].filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          // 只测当前前台页：Taro 会把访问过的 tab 页留在 DOM 里（taro_page_show 才是前台）
          if (!el.closest('.taro_page_show')) return false;
          const shown = el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true;
          const inView = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
          return shown && inView && r.width > 8 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
        });
        if (${MUTATE}) inputs.forEach(function (x) { x.style.transform = 'translateX(9px)'; });
        for (const el of inputs) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const padT = parseFloat(cs.paddingTop) || 0;
          const padB = parseFloat(cs.paddingBottom) || 0;
          // 同容器内最近的前置文本元素
          let labelLeft = null;
          let labelBottom = null;
          let sib = el.previousElementSibling;
          while (sib && labelLeft === null) {
            if ((sib.textContent || '').trim().length > 0 && !sib.querySelector('input,textarea')) {
              const lr = sib.getBoundingClientRect();
              labelLeft = lr.left; labelBottom = lr.bottom;
            }
            sib = sib.previousElementSibling;
          }
          // Taro 常把标签和输入框各包一层，直接兄弟找不到就再看父级的前一个兄弟
          if (labelLeft === null && el.parentElement) {
            let up = el.parentElement.previousElementSibling;
            if (up && (up.textContent || '').trim().length > 0 && !up.querySelector('input,textarea')) {
              const ur = up.getBoundingClientRect();
              labelLeft = ur.left; labelBottom = ur.bottom;
            }
          }
          const parent = el.parentElement;
          const pr = parent ? parent.getBoundingClientRect() : r;
          const pcs = parent ? getComputedStyle(parent) : null;
          const padL = pcs ? parseFloat(pcs.paddingLeft) || 0 : 0;
          const padR = pcs ? parseFloat(pcs.paddingRight) || 0 : 0;
          out.push({
            ph: el.getAttribute('placeholder') || '',
            ctx: (el.closest('.taro_page_show') || {}).className || '',
            left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), h: Math.round(r.height),
            labelLeft: labelLeft === null ? null : Math.round(labelLeft),
            labelBottom: labelBottom === null ? null : Math.round(labelBottom),
            parentRight: Math.round(pr.right - padR),
            parentLeft: Math.round(pr.left + padL),
            padT, padB
          });
        }
        return out;
      })()`);
      if (!Array.isArray(found)) { rows.push({ vp: vp.w, route, bad: ['巡检脚本执行失败'] }); continue; }
      for (const f of found) {
        const bad = [];
        // 只把「在输入框上方」的标签算作对齐基准；同一行左侧的前缀（+86 之类）不算
        const above = f.labelLeft !== null && f.labelBottom !== null && f.labelBottom <= f.top + 2;
        if (above && Math.abs(f.left - f.labelLeft) > 2) bad.push(`左边缘偏 ${f.left - f.labelLeft}px`);
        // 没有前置标签时，至少要和容器内容区左边缘对齐（否则就是被 margin/缩进挤歪）
        if (!above && Math.abs(f.left - f.parentLeft) > 2) bad.push(`距容器左边缘 ${f.left - f.parentLeft}px`);
        if (Math.abs(f.padT - f.padB) > 4) bad.push(`上下内边距 ${f.padT}/${f.padB}`);
        if (f.h < 36) bad.push(`高度 ${f.h}px<36`);
        if (f.right - f.parentRight > 2) bad.push(`右侧溢出 ${f.right - f.parentRight}px`);
        rows.push({ vp: vp.w, route, ph: f.ph, ctx: (f.ctx || '').slice(0, 40), labelLeft: f.labelLeft, bad });
      }
    }
  }

  ws.close(); try { child.kill(); } catch {} server.close();
  clearTimeout(WATCHDOG);

  const fails = rows.filter((r) => r.bad.length);
  const inputs = rows.length;
  const withLabel = rows.filter((r) => r.labelLeft !== null).length;
  console.log(`\n打字框对齐巡检：${inputs} 个输入框，其中 ${withLabel} 个有可比对的前置标签`);
  if (!fails.length) { console.log(`PASS ${inputs}/${inputs}`); process.exit(0); }
  console.log(`FAIL ${fails.length}/${inputs}`);
  for (const f of fails.slice(0, 30)) console.log(`  · [${f.vp}px] ${f.route} · ${f.ph || '(无占位)'} [${f.ctx}]: ${f.bad.join(' / ')}`);
  process.exit(1);
}

main().catch((e) => { clearTimeout(WATCHDOG); console.error('harness 出错:', e); process.exit(2); });
