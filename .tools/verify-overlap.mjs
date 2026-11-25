#!/usr/bin/env node
/**
 * verify-overlap.mjs —— 文字元素两两重叠门禁（2026-11-25）
 *
 * 为什么需要：对比度门禁只能发现「颜色看不见」，发现不了「文字被另一个元素盖住」。
 * 2026-11-25 实测：papers 每行变体标签被右侧 CTA 100% 覆盖、library 分类 chip 被
 * 「来源 ⚙」覆盖 75%，两处都是**浅色深色都存在**的既有缺陷，前三轮都没发现。
 *
 * 只看**两个都带文字**的可见元素；祖先/后代关系跳过；覆盖率 > 50% 记为重叠。
 * 用法: node .tools/verify-overlap.mjs
 * 退出码: 0 无重叠 / 1 有重叠 / 2 harness 起不来
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const PORT = 8139;
const PAGES = (process.env.OVERLAP_PAGES || 'pages/papers/index,pages/library/index').split(',').filter(Boolean);

const INIT = path.join(os.tmpdir(), `overlap-init-${process.pid}.js`);
// 未登录会被门禁挡到登录页，内页永远测不到：与 verify-routes 用同一份伪造会话桩
const SESSION = fs.readFileSync(path.join(ROOT, '.tools', 'cdp-probe-session.js'), 'utf8');
fs.writeFileSync(INIT, `${SESSION}
try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));}catch(e){}`);

const EXPR = `(()=>{
  const isEmoji=(s)=>/^[\\p{Extended_Pictographic}\\uFE0F\\u200D\\s]+$/u.test(s);
  // 可见矩形：被 overflow 容器裁掉的部分不算「看得见」，否则滚动列表里屏外的 chip
  // 会被判成与右侧按钮重叠（2026-11-25 实测的假阳性）。
  const visibleRect=(e)=>{
    const b=e.getBoundingClientRect();
    let r={l:b.left,t:b.top,r:b.right,b:b.bottom};
    let p=e.parentElement;
    while(p){
      const cs=getComputedStyle(p);
      const ox=cs.overflowX, oy=cs.overflowY;
      if(/hidden|auto|scroll|overlay/.test(ox)||/hidden|auto|scroll|overlay/.test(oy)){
        const pb=p.getBoundingClientRect();
        r={l:Math.max(r.l,pb.left),t:Math.max(r.t,pb.top),r:Math.min(r.r,pb.right),b:Math.min(r.b,pb.bottom)};
      }
      p=p.parentElement;
    }
    r.l=Math.max(r.l,0); r.t=Math.max(r.t,0);
    r.r=Math.min(r.r,innerWidth); r.b=Math.min(r.b,innerHeight);
    return { l:r.l, t:r.t, r:r.r, b:r.b, w:Math.max(0,r.r-r.l), h:Math.max(0,r.b-r.t) };
  };
  const els=[...document.querySelectorAll('*')].filter((e)=>{
    const hasText=[...e.childNodes].some((n)=>n.nodeType===3&&n.textContent.trim());
    if(!hasText) return false;
    const cs=getComputedStyle(e);
    if(cs.visibility==='hidden'||+cs.opacity===0) return false;
    const v=visibleRect(e);
    if(v.w<=4||v.h<=4) return false;
    if(!e.offsetParent&&cs.position!=='fixed') return false;
    return !isEmoji((e.textContent||'').trim());
  });
  const out=[];
  for(let i=0;i<els.length;i++) for(let j=i+1;j<els.length;j++){
    const a=els[i], b=els[j];
    if(a.contains(b)||b.contains(a)) continue;
    const ra=visibleRect(a), rb=visibleRect(b);
    const w=Math.min(ra.r,rb.r)-Math.max(ra.l,rb.l);
    const h=Math.min(ra.b,rb.b)-Math.max(ra.t,rb.t);
    if(w<=0||h<=0) continue;
    const ratio=(w*h)/Math.min(ra.w*ra.h, rb.w*rb.h);
    if(ratio>0.5) out.push({ a:(a.textContent||'').trim().slice(0,18), b:(b.textContent||'').trim().slice(0,18), ratio:+ratio.toFixed(2) });
  }
  return JSON.stringify(out.slice(0,20));
})()`;

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

if (!(await waitServer())) {
  console.log('SKIP：静态服务没起来（端口被占用？）');
  server.kill();
  process.exit(2);
}

let pass = 0;
let fail = 0;
for (const page of PAGES) {
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      PROBE, `http://127.0.0.1:${PORT}/#/${page}`, '1280', '900',
      '--init-script', INIT, '--block-url', '*cdn.jsdelivr.net*',
      '--dismiss-splash', '--expr', EXPR, '--wait', '6000'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(buf);
        if (parsed.error) return resolve({ error: parsed.error });
        const v = parsed.value;
        resolve(typeof v === 'string' ? JSON.parse(v) : v);
      } catch {
        resolve({ error: buf.slice(0, 200) });
      }
    });
  });

  if (out && out.error) {
    console.log(`FAIL ${page}：探针失败 ${out.error}`);
    fail++;
    continue;
  }
  if (!Array.isArray(out)) {
    console.log(`FAIL ${page}：结果不是数组`);
    fail++;
    continue;
  }
  if (out.length === 0) {
    pass++;
    console.log(`PASS ${page}：无文字重叠`);
  } else {
    fail++;
    console.log(`FAIL ${page}：${out.length} 对文字重叠`);
    for (const x of out) console.log(`  "${x.a}" × "${x.b}" 覆盖率 ${x.ratio}`);
  }
}

try { fs.rmSync(INIT, { force: true }); } catch { /* ignore */ }
server.kill();
console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${PAGES.length} 页）`);
process.exit(fail ? 1 : 0);
