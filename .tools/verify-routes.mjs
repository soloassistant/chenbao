#!/usr/bin/env node
/**
 * verify-routes.mjs —— 全路由渲染巡检（2026-10-30）
 *
 * 为什么需要它：
 *   原有的浏览器门禁只覆盖 8 个页面（assistant/briefing/calendar/inbox/library/
 *   membership/mine/prefs），而 app.config.ts 里注册了 19 个路由。sport / trade /
 *   ledger / search / learn* / shopping / sxm / notify / login 从来没被自动化加载过 ——
 *   一个页面白屏、抛异常、横向溢出、慢到十秒，现有门禁全都看不见。
 *   更糟的是浏览器门禁都在 `--with-browser` 组，默认那次 `verify:all` 一个页面都没渲染。
 *
 * 路由**从 app.config.ts 自动发现**，不写死列表：写死的列表在加页面那天就腐烂了。
 *
 * 三档视口：390（手机）/ 640（600–747 的窄桌面，导航 64PX 的那一档）/ 1440（桌面）。
 * 640 是历史上最容易出错的一档（导航宽度三处要同步改），单独盯住。
 *
 * 断言（只判「这个路由能不能正常加载并排版」，不判内容多少）：
 *   R1 挂载并渲染：可见 taro 节点 ≥ 5 且正文 > 0（空壳/白屏会红）
 *   R2 无未捕获异常、无 console.error、无资源加载失败
 *   R3 无横向溢出（超宽元素 ≤ 1px 容差）
 * 正文体量只作为信息列打印（< 40 字标 ⚠）。**不按体量判红绿**：
 *   设置页 56 节点、搜索页 28 节点、详情页无参数时 20 节点都是正常空态；
 *   而 `innerText` 会把隐藏面板的文字算进来，量到每页恒定 6300+ 字——那是口径问题。
 *
 * 踩过的三个坑（都在代码里标了，别再犯）：
 *   ① 只改 hash 导航 = 同文档跳转，tab 页不卸载 → 量到累积 DOM（曾得出「4962 节点/30 字」）
 *   ② `#app.innerText` 含隐藏面板与开屏/引导层 → 每页恒定 6300+ 字
 *   ③ 用节点数或字数当门槛 → 误杀大块文本的设置页与空态页
 *
 * 用法: node .tools/verify-routes.mjs [--dist=D:/Agent/dist] [--only=briefing,mine] [--viewport=390]
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
/** 2026-11-23：--theme=dark 时预置主题并断言页面底色确实是深色 */
const THEME = arg('theme') || 'light';

/** 路由从配置里读，避免硬编码列表腐烂 */
function routesFromConfig() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app.config.ts'), 'utf8');
  const list = [...src.matchAll(/'pages\/([A-Za-z]+)\/index'/g)].map((m) => m[1]);
  return [...new Set(list)];
}

const VIEWPORTS = [
  { w: 390, h: 844, label: '手机 390' },
  { w: 640, h: 900, label: '窄桌面 640' },
  { w: 1440, h: 900, label: '桌面 1440' }
].filter((v) => !ONLY_VP || String(v.w) === ONLY_VP);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/api/hotspot') {
      const p = path.join(DIST, 'api/hotspot.json');
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(fs.readFileSync(p));
        return;
      }
    }
    if (/\.(js|css|json|png|jpg|svg|woff2)$/.test(u)) {
      const f = path.resolve(DIST, '.' + u);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(DIST, 'index.html')));
  });
  return new Promise((resolve) => {
    const port = 9300 + Math.floor(Math.random() * 60);
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

// 全局看门狗：CDP 偶发不回包时，脚本不能无限挂住（实测曾卡 30 分钟拖死 verify:all）
const WATCHDOG = setTimeout(() => {
  console.error('✗ verify-routes 超过 15 分钟未结束，强制退出');
  process.exit(2);
}, 15 * 60 * 1000);

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    // 与 verify:deploy-fresh 同一口径：依赖新鲜产物、而产物不存在时**未跑**，不是失败。
    // 直接 exit 2 会让所有人在没构建的机器上看到一个指向「并行会话新门禁」的假红，
    // 那样真实故障就会被这条噪声掩盖。
    console.log(`未跑（需 dist 产物：${DIST} 里没有 index.html，先 npm run build:h5）`);
    process.exit(0);
  }
  if (!fs.existsSync(CHROME)) {
    console.error('✗ 找不到 Chrome：设置 CHROME_BIN 或安装 Chrome');
    process.exit(2);
  }

  const routes = routesFromConfig().filter((r) => !ONLY.length || ONLY.includes(r));
  const { server, port } = await startServer();

  const udd = path.join(os.tmpdir(), `rt-${Date.now()}`);
  const dbg = 9200 + Math.floor(Math.random() * 60);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--no-proxy-server', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--remote-debugging-port=${dbg}`,
    `--user-data-dir=${udd}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

  // 2026-11-23：Chrome 起不来时这里原来会无限等 —— fetch 没超时、循环 120 次也不够，
  // 实测 verify-routes 卡死 30 分钟拖住整个 verify:all。改为：启动失败立即退出，
  // 探测带 1s 超时，最多等 30s；拿不到 ws 端点明确报错，不再 new WebSocket(undefined)。
  let launchError = null;
  child.on('error', (err) => { launchError = err; });
  let wsUrl;
  for (let i = 0; i < 100; i++) {
    if (launchError) break;
    try {
      const l = await (await fetch(`http://127.0.0.1:${dbg}/json/list`, {
        signal: AbortSignal.timeout(1000)
      })).json();
      const p = l.find((t) => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch { /* 等端口 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!wsUrl) {
    console.error(`✗ Chrome DevTools 未就绪（端口 ${dbg}）${launchError ? `：${launchError.message}` : ''}`);
    try { child.kill(); } catch { /* 已退出 */ }
    try { server.close(); } catch { /* 已关闭 */ }
    process.exit(2);
  }
  const ws = new globalThis.WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
  });

  let id = 0;
  const pending = new Map();
  let bag = { errors: [], failed: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      bag.errors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 160));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      bag.errors.push((m.params.args || []).map((a) => String(a.value || a.description || '')).join(' ').slice(0, 160));
    }
    if (m.method === 'Network.loadingFailed') {
      // 图片失败不算页面故障：资讯缩略图来自第三方，被 ORB/防盗链拦是常态，
      // 页面照样能用。只关心会真正让路由打不开的东西（脚本/样式/文档）。
      if (m.params.type === 'Image') return;
      bag.failed.push(`${m.params.type}:${m.params.errorText}`);
    }
  };
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    // 页面崩掉时 CDP 不会回包；没有超时就是整条门禁挂死
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`CDP ${method} 超时`));
      }, 10000);
      pending.set(i, (r) => { clearTimeout(timer); resolve(r); });
    });
  };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.resolve(ROOT, '.tools/cdp-probe-session.js'), 'utf8') });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('onboarded-v2:probe-user-0001', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));localStorage.setItem('theme-mode', JSON.stringify({data:'${THEME}'}));}catch(e){}`
  });

  /** 暗色底色测量：截图 → 页面内 canvas 解码 → 网格中位数。 */
  async function measureDark() {
    await ev(`(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(s)s.click();const c=document.querySelector('[class*="consentAgree"]');if(c)c.click();return 1})()`);
    await new Promise((r) => setTimeout(r, 600));
    const darkClass = await ev(`document.documentElement.classList.contains('theme-dark')`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const b64 = shot && shot.data;
    if (b64 && process.env.DARK_SHOT_DIR) {
      try {
        fs.mkdirSync(process.env.DARK_SHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.DARK_SHOT_DIR, `${THEME}-${CURRENT_VP}-${CURRENT_ROUTE}.png`), Buffer.from(b64, 'base64'));
      } catch { /* 调试产物失败不影响门禁 */ }
    }
    if (!b64) return { darkClass, error: `截图失败：${JSON.stringify(shot).slice(0, 160)}` };
    const px = JSON.parse(String(await ev(`(async () => {
      var img = new Image();
      img.src = 'data:image/png;base64,${b64}';
      await img.decode();
      var c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      var pts = [];
      var rows = [0.10, 0.35, 0.60, 0.85];
      var cols = [0.10, 0.30, 0.50, 0.70, 0.90];
      for (var r=0;r<rows.length;r++) for (var c2=0;c2<cols.length;c2++) pts.push([cols[c2], rows[r], r === 0 ? 'top' : 'body']);
      var out = [];
      for (var i=0;i<pts.length;i++) {
        var x = Math.min(img.width-1, Math.max(0, Math.round(pts[i][0]*img.width)));
        var y = Math.min(img.height-1, Math.max(0, Math.round(pts[i][1]*img.height)));
        var d = g.getImageData(x, y, 1, 1).data;
        out.push({ at: pts[i][0] + ',' + pts[i][1], zone: pts[i][2], rgb: [d[0],d[1],d[2]] });
      }
      return JSON.stringify(out);
    })()`)));
    const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const median = (arr) => {
      const v = arr.map((p) => lum(p.rgb)).sort((a, b) => a - b);
      return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    };
    return { darkClass, pageLum: median(px), topLum: median(px.filter((p) => p.zone === 'top')) };
  }

  // U-11（2026-11-25）：自测像素分支真的会红 —— 挂上 theme-dark 再铺一层全屏白，
  // 门禁必须判「浅色」。不做这一步，像素判据只有「平时全绿」这一半证据。
  if (process.argv.includes('--selftest-dark')) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/#/pages/login/index` });
    await new Promise((r) => setTimeout(r, 4000));
    await ev(`document.documentElement.classList.add('theme-dark')`);
    await new Promise((r) => setTimeout(r, 500));
    const before = await measureDark();
    if (!before.darkClass) { console.log('SKIP 自测：页面没挂上 theme-dark'); process.exit(2); }
    if (before.pageLum > 0.6) { console.log(`SKIP 自测：基线本身就是浅色（${before.pageLum.toFixed(2)}），无法隔离注入`); process.exit(2); }
    await ev(`(()=>{var d=document.createElement('div');d.id='__dark_selftest__';d.style.cssText='position:fixed;inset:0;background:#fff;z-index:2147483647';document.body.appendChild(d);return 1})()`);
    await new Promise((r) => setTimeout(r, 300));
    const after = await measureDark();
    const caught = after.pageLum > 0.6;
    console.log(`自测：白屏注入前 ${before.pageLum.toFixed(2)} / 注入后 ${after.pageLum.toFixed(2)} → ${caught ? 'PASS（判红）' : 'FAIL（未判红）'}`);
    ws.close(); try { child.kill(); } catch {} server.close();
    process.exit(caught ? 0 : 1);
  }

  const rows = [];
  const BUDGET_MS = 12000;

  let CURRENT_VP = 0;
  let CURRENT_ROUTE = '';
  for (const vp of VIEWPORTS) {
    CURRENT_VP = vp.w;
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 600 });
    for (const route of routes) {
      CURRENT_ROUTE = route;
      // 每个路由最多试 2 次：上一页的跳转（含应用自身的 redirect）还在飞的时候
      // 发新导航，Chrome 会把 Document 请求标成 ERR_ABORTED、节点读到 0。
      // 那是**工具的竞态**，不是页面没渲染 —— 不重试的话这条会随机红。
      let attempt = null;
      for (let tryIdx = 0; tryIdx < 2 && !attempt; tryIdx++) {
        bag = { errors: [], failed: [] };
        const t0 = Date.now();
        // 卡住时要知道停在哪个路由/视口，否则只能看到最终超时
        if (process.env.VERIFY_ROUTES_VERBOSE) console.log(`[route] ${vp.label} ${route} try=${tryIdx + 1}`);
        // ⚠️ 必须整页加载，不能只改 hash：同文档跳转时 Taro 的 tab 页**不卸载**（设计如此），
        //    量到的是累积 DOM —— 第一版就是这么干的，得到「4962 节点 / 正文 30 字」这种鬼数字，
        //    而且后面的页永远比前面的「节点多」，判定完全失真。
        await send('Page.navigate', { url: 'about:blank' });
        await new Promise((r) => setTimeout(r, 150));
        await send('Page.navigate', { url: `http://127.0.0.1:${port}/?rt=${vp.w}-${route}#/pages/${route}/index` });

        let nodes = 0;
        let textLen = 0;
        let bg = '';
        let done = false;
        while (Date.now() - t0 < BUDGET_MS) {
          await new Promise((r) => setTimeout(r, 700));
          const s = JSON.parse(String(await ev(`(() => {
            // ⚠️ 不能用 #app.innerText 判「有没有内容」：它会把隐藏面板（快捷键面板、
            //    未打开的抽屉）的文字一起算进来，实测每页都恒定 6300+ 字，判据等于没有。
            //    只统计**可见**的 taro 文本节点（rect 非 0 且不是 display:none 链上的）。
            var els = document.querySelectorAll('taro-view-core,taro-text-core');
            var vis = 0;
            var chars = 0;
            for (var i = 0; i < els.length; i++) {
              var el = els[i];
              // rect > 0 挡不住「挪到屏幕外的面板」（left:-9999px 的盒子尺寸照样是正的），
              // 那种元素仍会被算成可见 —— 这就是每页都恒定 6300+ 字的原因。
              // 原生 checkVisibility 会一并看 display/visibility/content-visibility/opacity。
              var shown = el.checkVisibility
                ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })
                : el.getBoundingClientRect().width > 0;
              if (!shown) continue;
              vis++;
              if (el.tagName === 'TARO-TEXT-CORE') chars += (el.innerText || '').trim().length;
            }
            return JSON.stringify({ n: vis, t: chars });
          })()`)));
          nodes = s.n; textLen = s.t;
          // 只要「应用挂载了并且该页有可见 taro 节点」就算渲染成功。
          // 不按字数卡：设置页 56 节点、搜索页 28 节点、详情页无参数时 20 节点，
          // 都是**正常**的空态；用字数当门槛会把这些page误判成白屏。
          if (nodes >= 5 && textLen > 0) { done = true; break; }
        }
        // 达标后不要立刻记数：达标那一刻可能还盖着开屏/引导层（它们也是可见文字），
        // 实测 inbox 稳定态最长文本只有 67 字，可门禁在过渡态取到了 6398 字。
        // 等 2.5s 让过渡层退场，再用**稳定态**的数字判定与报告。
        if (done) {
          await new Promise((r) => setTimeout(r, 2500));
          const settled = JSON.parse(String(await ev(`(() => {
            var els = document.querySelectorAll('taro-view-core,taro-text-core');
            var vis = 0;
            var chars = 0;
            for (var i = 0; i < els.length; i++) {
              var el = els[i];
              var shown = el.checkVisibility
                ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })
                : el.getBoundingClientRect().width > 0;
              if (!shown) continue;
              vis++;
              if (el.tagName === 'TARO-TEXT-CORE') chars += (el.innerText || '').trim().length;
            }
            return JSON.stringify({ n: vis, t: chars, bg: getComputedStyle(document.body).backgroundColor });
          })()`)));
          nodes = settled.n;
          textLen = settled.t;
          bg = settled.bg || '';
        }
        const ms = Date.now() - t0;
        const aborted = bag.failed.some((f) => f.indexOf('ERR_ABORTED') >= 0);
        if (!done && aborted && tryIdx === 0) {
          await new Promise((r) => setTimeout(r, 1200));
          continue; // 重试一次
        }
        attempt = { done, ms, nodes, textLen, bg, errors: bag.errors.slice(0, 3), failed: bag.failed.slice(0, 3) };
      }
      const { done, ms, nodes, textLen, bg } = attempt;

      // 暗色断言：看 body 计算后的底色亮度。页面自己白底会把 body 遮住，
      // 所以同时看 #app 根节点（取第一个可见 taro-view-core）。
      if (THEME === 'dark' && route === 'login') {
        // 登录页是品牌入口页（浅色渐变是设计的一部分），不参与内容页暗色判定；
        // 但要在汇总里明说，不能悄悄跳过。
        attempt.darkWarn = '登录页（品牌入口）不纳入暗色底色判定';
      } else if (THEME === 'dark') {
        const d = await measureDark();
        if (!d.darkClass) attempt.darkBad = 'html 未挂 theme-dark';
        else if (d.error) attempt.darkBad = d.error;
        else if (d.pageLum > 0.6) attempt.darkBad = `整页主色仍为浅色（中位亮度 ${d.pageLum.toFixed(2)}）`;
        else if (d.topLum > 0.85) attempt.darkBad = `顶部横带仍为浅色（中位亮度 ${d.topLum.toFixed(2)}）`;
      }

      // 关掉开屏/隐私层后再量溢出（否则量的是遮罩）
      await ev(`(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(s)s.click();const c=document.querySelector('[class*="consentAgree"]');if(c)c.click();return 1})()`);
      await new Promise((r) => setTimeout(r, 600));

      const overflow = await ev(`(() => {
        const de = document.documentElement;
        const w = window.innerWidth;
        const root = document.querySelector('#container') || document.body;
        // 找出真正超宽的元素（排除装饰性绝对定位）
        let worst = 0;
        let worstTag = '';
        document.querySelectorAll('taro-view-core,taro-text-core').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0) return;
          const over = Math.round(r.right - w);
          if (over > worst) { worst = over; worstTag = el.tagName + '.' + String(el.className).slice(0, 24); }
        });
        return JSON.stringify({
          scrollW: Math.max(de.scrollWidth, root.scrollWidth || 0),
          innerW: w,
          worstOver: worst,
          worstTag
        });
      })()`);
      const ov = JSON.parse(String(overflow));

      rows.push({
        vp: vp.label,
        route,
        ok: done,
        ms,
        nodes,
        textLen,
        errors: attempt.errors,
        failed: attempt.failed,
        overflow: Math.max(0, ov.scrollW - ov.innerW),
        worstOver: ov.worstOver,
        worstTag: ov.worstTag,
        darkBad: attempt.darkBad || '',
        darkWarn: attempt.darkWarn || ''
      });
    }
  }

  ws.close();
  child.kill();
  server.close();

  const fails = [];
  const t = (s, n) => String(s).padEnd(n);
  console.log(`\n全路由渲染巡检（主题：${THEME}）`);
  console.log(`${t('视口', 12)}${t('路由', 16)}${t('耗时', 8)}${t('节点', 7)}${t('正文', 8)}${t('溢出', 7)}错误`);
  for (const r of rows) {
    const bad = [];
    // 判据只管「这个路由能不能正常加载并排版」，**不按正文体量判红绿**：
    // 设置页只有 56 个节点、搜索页只有 28 个，都是正常的；而 innerText 会把
    // 隐藏面板的文字算进来，量到每页恒定 6300+ 字（那是口径问题，不是页面问题）。
    // 体量只作为信息列打印，人肉看出「某页 0 字」时再查。
    if (!r.ok) bad.push(`未渲染(节点${r.nodes}/正文${r.textLen})`);
    if (r.darkBad) bad.push(r.darkBad);
    if (r.errors.length) bad.push(`异常:${r.errors[0]}`);
    if (r.failed.length) bad.push(`请求失败:${r.failed[0]}`);
    if (r.overflow > 1) bad.push(`横向溢出${r.overflow}px(${r.worstTag})`);
    const thin = r.textLen < 40 ? ' ⚠正文稀薄' : '';
    console.log(
      `${t(r.vp, 12)}${t(r.route, 16)}${t(r.ms + 'ms', 8)}${t(r.nodes, 7)}${t(r.textLen + thin, 8)}${t(r.overflow, 7)}${bad.join(' | ') || '—'}`
    );
    if (bad.length) fails.push({ ...r, bad });
  }

  const warns = rows.filter((r) => r.darkWarn);
  if (warns.length) console.log(`\n亮度未确认：${warns.length} 条（暗色类名已挂，但取样点未命中不透明底色）`);
  const total = rows.length;
  console.log(`\n${fails.length === 0
    ? `PASS ${total}/${total}（${routes.length} 个路由 × ${VIEWPORTS.length} 档视口，全部渲染且无溢出/无异常）`
    : `FAIL ${fails.length}/${total}`}`);

  if (fails.length) {
    console.log('\n失败明细：');
    for (const f of fails) console.log(`  · [${f.vp}] ${f.route}: ${f.bad.join(' / ')}`);
  }
  clearTimeout(WATCHDOG);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  clearTimeout(WATCHDOG);
  console.error('harness 出错:', e);
  process.exit(2);
});
