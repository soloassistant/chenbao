#!/usr/bin/env node
/**
 * verify-touch-target.mjs —— 有效命中区门禁（2026-11-26）
 *
 * 口径（项目既有定义，variables.scss:154）：有效命中区 = 元素矩形 + ::before 四边外扩。
 * 第 11 轮审查只量 border-box，把 hit-expand 修过的控件也判成缺陷，高估 51 处。
 * 这里把口径固化成脚本：按 320/375/390 三档真渲染，量 role=button / button /
 * [data-pressable] 的有效宽高，<44 记违规。
 *
 * 基线：`.tools/touch-target-baseline.json`。门禁只拦「比基线更差」——
 * 既有 30 个去重缺陷已登记，修完一个就把基线调低，不许反弹。
 *
 * 用法: node .tools/verify-touch-target.mjs [--update-baseline]
 * 退出码: 0 通过 / 1 有新增违规 / 2 harness 失败
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const PORT = 8142;
const BASELINE_FILE = path.join(ROOT, '.tools', 'touch-target-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

const PAGES = (process.env.TOUCH_PAGES ||
  'pages/briefing/index,pages/inbox/index,pages/library/index,pages/calendar/index,pages/mine/index,pages/assistant/index,pages/ledger/index,pages/membership/index,pages/prefs/index'
).split(',').filter(Boolean);
const WIDTHS = [320, 375, 390];

const EXPR = `(()=>{
  const parse = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const eff = (el) => {
    const r = el.getBoundingClientRect();
    let l = r.left, t = r.top, rr = r.right, b = r.bottom;
    const before = getComputedStyle(el, '::before');
    if (before && before.content && before.content !== 'none' && before.position === 'absolute') {
      const top = parse(before.top), right = parse(before.right), bottom = parse(before.bottom), left = parse(before.left);
      // 负值才是外扩；百分比/auto 解析成 0，不影响结论
      if (top < 0) t += top;
      if (left < 0) l += left;
      if (right < 0) rr -= right;
      if (bottom < 0) b -= bottom;
    }
    return { w: Math.round((rr - l) * 10) / 10, h: Math.round((b - t) * 10) / 10 };
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0 || cs.display === 'none') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (!el.offsetParent && cs.position !== 'fixed') return false;
    return true;
  };
  const isInteractive = (el) =>
    /^(BUTTON|TARO-BUTTON-CORE)$/.test(el.tagName) ||
    el.getAttribute('role') === 'button' ||
    el.hasAttribute('data-pressable') ||
    el.hasAttribute('tabindex') && el.getAttribute('tabindex') === '0';
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (!isInteractive(el) || !visible(el)) continue;
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    const e = eff(el);
    if (e.w >= 44 && e.h >= 44) continue;
    const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
    out.push({ cls: cls.slice(0, 50), text: (el.textContent || '').trim().slice(0, 16), w: e.w, h: e.h });
  }
  return JSON.stringify(out);
})()`;

const INIT = path.join(os.tmpdir(), `touch-init-${process.pid}.js`);
fs.writeFileSync(INIT, `${fs.readFileSync(path.join(ROOT, '.tools', 'cdp-probe-session.js'), 'utf8')}
try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));}catch(e){}`);

function waitServer(tries = 40) {
  return new Promise((resolve) => {
    const tick = (n) => {
      const req = http.get(`http://127.0.0.1:${PORT}/index.html`, (res) => { res.resume(); resolve(true); });
      req.on('error', () => (n <= 0 ? resolve(false) : setTimeout(() => tick(n - 1), 250)));
    };
    tick(tries);
  });
}

const server = spawn(process.execPath, [path.join(ROOT, '.tools', 'static-server.js')], {
  cwd: ROOT,
  env: { ...process.env, STATIC_PORT: String(PORT) },
  stdio: 'ignore'
});
if (!(await waitServer())) { console.log('SKIP：静态服务没起来'); server.kill(); process.exit(2); }

const probe = (page, width) => new Promise((resolve) => {
  const child = spawn(process.execPath, [
    PROBE, `http://127.0.0.1:${PORT}/#/${page}`, String(width), '844',
    '--init-script', INIT, '--dismiss-splash', '--expr', EXPR, '--wait', '5000'
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => (buf += d));
  child.on('close', () => {
    try {
      const parsed = JSON.parse(buf);
      if (parsed.error) return resolve({ error: parsed.error });
      const v = parsed.value;
      resolve(typeof v === 'string' ? JSON.parse(v) : v);
    } catch { resolve({ error: buf.slice(0, 160) }); }
  });
});

const baseline = fs.existsSync(BASELINE_FILE)
  ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  : { counts: {}, total: 0 };
const next = { counts: {}, total: 0 };
let regressions = 0;

for (const page of PAGES) {
  for (const w of WIDTHS) {
    const key = `${page}@${w}`;
    const out = await probe(page, w);
    if (!Array.isArray(out)) { console.log(`FAIL ${key}：探针失败 ${out && out.error}`); regressions++; continue; }
    next.counts[key] = out.length;
    next.total += out.length;
    const base = baseline.counts[key] ?? out.length; // 新页面默认以当前为基线
    if (out.length > base) {
      regressions++;
      console.log(`FAIL ${key}：${out.length} 处 <44（基线 ${base}）`);
      for (const x of out.slice(0, 5)) console.log(`  "${x.text}" ${x.w}×${x.h} .${x.cls}`);
    }
  }
}

try { fs.rmSync(INIT, { force: true }); } catch { /* ignore */ }
server.kill();

if (UPDATE) {
  next.total = Object.values(next.counts).reduce((a, b) => a + b, 0);
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`基线已更新：${next.total} 处（${PAGES.length} 页 × ${WIDTHS.length} 档）`);
  process.exit(0);
}

console.log(`\n有效命中区 <44：本次 ${next.total} / 基线 ${baseline.total}；新增超标 ${regressions} 组`);
console.log(regressions === 0 ? 'PASS（无新增）' : `FAIL ${regressions} 组`);
process.exit(regressions === 0 ? 0 : 1);
