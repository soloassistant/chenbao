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
import { resolveChrome } from './lib/chrome.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const DIST = arg('dist') || path.join(ROOT, 'dist');
const CHROME = resolveChrome();
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
  if (!fs.existsSync(CHROME)) { console.error('✗ 找不到 Chrome：设置 CHROME_BIN 或安装 Chrome'); process.exit(2); }

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
      // 等审批层退场后再量，但不固定睡 3.5s：输入框出现即走，最多 8s。
      // 固定等待会让整轮跑得很慢，而空集又会把「没测到」伪装成通过（见下方 inputs===0）。
      const waitStart = Date.now();
      while (Date.now() - waitStart < 8000) {
        const n = await ev(`(() => {
          return [...document.querySelectorAll('input,textarea')].filter(function (el) {
            const r = el.getBoundingClientRect();
            return r.width > 8 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
          }).length;
        })()`);
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, 400));
      const found = await ev(`(() => {
        const out = [];
        const inputs = [...document.querySelectorAll('input, textarea')].filter((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          // 只测**当前前台页**：Taro 会把访问过的 tab 页与登录页都留在 DOM 里，
          // taro_page_show 可能不止一个 —— 取最后一个可见页作为 active。
          var pages = [].slice.call(document.querySelectorAll('.taro_page_show'));
          var active = pages.length ? pages[pages.length - 1] : null;
          if (!active || !active.contains(el)) return false;
          const shown = el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true;
          const inView = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
          return shown && inView && r.width > 8 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
        });
        // 量「可见盒子」而不是内部原生 input：Taro 的 input 包在 taro-input-core 里，
        // 原生元素高度只有行高（实测 21px），会把正常 36px 的框误判成太矮。
        const boxOf = (el) => el.closest('taro-input-core, taro-textarea-core') || el;
        if (${MUTATE}) inputs.forEach(function (x) { boxOf(x).style.transform = 'translateX(9px)'; });
        for (const el of inputs) {
          const box = boxOf(el);
          const r = box.getBoundingClientRect();
          const cs = getComputedStyle(box);
          const padT = parseFloat(cs.paddingTop) || 0;
          const padB = parseFloat(cs.paddingBottom) || 0;
          // 同容器内最近的前置文本元素
          let labelLeft = null;
          let labelBottom = null;
          let sib = box.previousElementSibling;
          while (sib && labelLeft === null) {
            if ((sib.textContent || '').trim().length > 0 && !sib.querySelector('input,textarea')) {
              const lr = sib.getBoundingClientRect();
              labelLeft = lr.left; labelBottom = lr.bottom;
            }
            sib = sib.previousElementSibling;
          }
          // Taro 常把标签和输入框各包一层，直接兄弟找不到就再看父级的前一个兄弟
          if (labelLeft === null && box.parentElement) {
            let up = box.parentElement.previousElementSibling;
            if (up && (up.textContent || '').trim().length > 0 && !up.querySelector('input,textarea')) {
              const ur = up.getBoundingClientRect();
              labelLeft = ur.left; labelBottom = ur.bottom;
            }
          }
          const parent = box.parentElement;
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
            hasPrefix: (() => {
              let prev = el.closest('taro-input-core, taro-textarea-core') || el;
              prev = prev.previousElementSibling;
              if (!prev) return false;
              const pcs = getComputedStyle(prev);
              const text = (prev.textContent || '').trim();
              return pcs.display !== 'none' && prev.getBoundingClientRect().width > 10 && text.length > 0 && text.length <= 6;
            })(),
            padT, padB
          });
        }
        return out;
      })()`);
      // 受保护路由会被门禁重定向到登录页；此时量到的是登录页的框，不能算这个路由的结果。
      const actual = await ev(`location.hash`);
      if (!String(actual || '').includes(`/pages/${route}/index`)) {
        rows.push({ vp: vp.w, route, skipped: true, bad: [] });
        continue;
      }
      if (!Array.isArray(found)) { rows.push({ vp: vp.w, route, bad: ['巡检脚本执行失败'] }); continue; }
      for (const f of found) {
        const bad = [];
        const above = f.labelLeft !== null && f.labelBottom !== null && f.labelBottom <= f.top + 2;
        const contentW = f.parentRight - f.parentLeft;
        // 满宽字段才判左右对齐：搜索框+按钮、金额+单位、带 +86 前缀的输入框，
        // 左边缘本来就不等于容器左边缘，拿它当判据只会制造假阳性。
        const fullWidth = !f.hasPrefix && contentW > 0 && (f.right - f.left) >= contentW * 0.9;
        if (fullWidth && above && Math.abs(f.left - f.labelLeft) > 2) bad.push(`左边缘偏 ${f.left - f.labelLeft}px`);
        if (fullWidth && !above && Math.abs(f.left - f.parentLeft) > 2) bad.push(`距容器左边缘 ${f.left - f.parentLeft}px`);
        if (fullWidth && f.right - f.parentRight > 2) bad.push(`右侧溢出 ${f.right - f.parentRight}px`);
        if (Math.abs(f.padT - f.padB) > 4) bad.push(`上下内边距 ${f.padT}/${f.padB}`);
        if (f.h < 36) bad.push(`高度 ${f.h}px<36`);
        rows.push({ vp: vp.w, route, ph: f.ph, ctx: (f.ctx || '').slice(0, 40), labelLeft: f.labelLeft, bad });
      }
    }
  }

  ws.close(); try { child.kill(); } catch {} server.close();
  clearTimeout(WATCHDOG);

  const fails = rows.filter((r) => r.bad.length);
  const skipped = rows.filter((r) => r.skipped).length;
  const inputs = rows.length - skipped;
  const withLabel = rows.filter((r) => !r.skipped && r.labelLeft !== null).length;
  console.log(`\n打字框对齐巡检：${inputs} 个输入框（另有 ${skipped} 个页面因未登录被重定向，未计入），其中 ${withLabel} 个有可比对的前置标签`);
  // 0 个输入框不是「全绿」：说明页面没挂载/选择器失效/等待过短，是门禁失效而不是合格。
  if (inputs === 0) { console.log('FAIL 0/0：一个输入框都没测到（空集不算通过）'); process.exit(1); }
  if (!fails.length) { console.log(`PASS ${inputs}/${inputs}`); process.exit(0); }
  console.log(`FAIL ${fails.length}/${inputs}`);
  for (const f of fails.slice(0, 30)) console.log(`  · [${f.vp}px] ${f.route} · ${f.ph || '(无占位)'} [${f.ctx}]: ${f.bad.join(' / ')}`);
  process.exit(1);
}

main().catch((e) => { clearTimeout(WATCHDOG); console.error('harness 出错:', e); process.exit(2); });
