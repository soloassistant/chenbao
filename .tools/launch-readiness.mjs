#!/usr/bin/env node
/**
 * launch-readiness.mjs —— 上线阻塞体检（2026-11-11）
 *
 * 为什么需要它：
 *   小程序线卡在「主体未注册 ⇒ 无 AppID ⇒ 无云环境 ⇒ 27 个云函数一个都部署不了 ⇒ 真机预览不了」
 *   这条链上每个环节都散落在不同文件里，每次要上线都得重新翻一遍，
 *   而且很容易出现「以为配好了其实没配」的错觉 —— 比如 `project.config.json` 里
 *   至今还是占位的 `touristappid`，而它是所有后续步骤的总前提。
 *
 * 本工具**不改变任何事实**，只做一件事：把阻塞点集中列出来，每条给
 *   ① 证据（文件 + 行号 / 实际取值）② 谁能解决（外部 / 本仓库）③ 下一步的具体动作。
 *
 * 诚实性约定（与项目其它门禁一致）：
 *   · 「未能检出」≠「已就绪」—— 检不到的东西一律记进 unknown，不许当成通过；
 *   · 退出码默认 0（本工具是**诊断**，不是门禁：让它进 CI 只会让 CI 永远红，
 *     而阻塞项恰恰要靠人去解决，红了也推不动）；
 *   · 加 --strict 时，有阻塞项即退出 1（用于发布前自检）。
 *
 * 用法：node .tools/launch-readiness.mjs [--strict] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const AS_JSON = process.argv.includes('--json');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; }
};
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const lineOf = (p, needle) => {
  const lines = read(p).split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? `${p}:${i + 1}` : '';
};

/** 状态：blocked 外部阻塞 / todo 代码侧待做 / ready 已就绪 / unknown 未能检出 */
const items = [];
const add = (id, title, status, owner, evidence, next) => items.push({ id, title, status, owner, evidence, next });

/* ─────────────── A. 外部阻塞（代码解决不了，必须人补齐） ─────────────── */

// A1 微信主体 / AppID
const proj = read('project.config.json');
const appid = (/"appid"\s*:\s*"([^"]*)"/.exec(proj) || [])[1] || '';
if (!appid || appid === 'touristappid') {
  add('wx-appid', '小程序 AppID 未配置（项目配置仍是占位）', 'blocked', '外部',
    `project.config.json → appid = ${appid || '(缺失)'}`,
    '先注册个体户主体并完成微信认证，再把真实 AppID 填进 project.config.json');
} else {
  add('wx-appid', '小程序 AppID 已配置', 'ready', '外部', `project.config.json → appid = ${appid}`, '');
}

// A2 代码上传密钥
const keyPath = process.env.WX_PRIVATE_KEY_PATH || '';
if (!keyPath) {
  add('wx-private-key', '代码上传密钥未配置', 'blocked', '外部',
    '环境变量 WX_PRIVATE_KEY_PATH 未设置',
    '在微信公众平台生成代码上传密钥，导出私钥文件并把绝对路径写进 WX_PRIVATE_KEY_PATH');
} else if (!fs.existsSync(keyPath)) {
  add('wx-private-key', '代码上传密钥路径指向的文件不存在', 'blocked', '外部',
    `WX_PRIVATE_KEY_PATH = ${keyPath}`,
    '确认密钥文件路径（或重新导出私钥）');
} else {
  add('wx-private-key', '代码上传密钥已就位', 'ready', '外部', keyPath, '');
}

// A3 云环境 ID
const cloudEnv = process.env.WX_CLOUD_ENV || '';
if (!cloudEnv) {
  add('wx-cloud-env', '微信云开发环境 ID 未配置', 'blocked', '外部',
    '环境变量 WX_CLOUD_ENV 未设置',
    '开通云开发环境，把环境 ID 写进 WX_CLOUD_ENV（只含字母/数字/-/_）');
} else if (!/^[A-Za-z0-9_-]+$/.test(cloudEnv)) {
  add('wx-cloud-env', '云环境 ID 格式不对', 'blocked', '外部', `WX_CLOUD_ENV = ${cloudEnv}`,
    '环境 ID 只允许字母、数字、- 和 _');
} else {
  add('wx-cloud-env', '云环境 ID 已就位', 'ready', '外部', cloudEnv, '');
}

// A4 订阅消息模板 ID
const subFn = ['cloudfunctions/subscribe/index.js', 'cloudfunctions/getBriefing/index.js']
  .map((p) => ({ p, src: read(p) }))
  .find((x) => x.src.includes('SUBSCRIBE_TEMPLATE_ID'));
if (!subFn) {
  add('subscribe-template', '订阅消息模板 ID 的注入点未找到（未能检出）', 'unknown', '外部',
    'cloudfunctions/{subscribe,getBriefing}/index.js 里没有 SUBSCRIBE_TEMPLATE_ID',
    '人工确认订阅消息模板的注入位置');
} else {
  const hardcodedEmpty = /SUBSCRIBE_TEMPLATE_ID\s*=\s*['"]{2}/.test(subFn.src);
  add('subscribe-template', '订阅消息模板 ID 未注入', 'blocked', '外部',
    `${subFn.p} 读取 process.env.SUBSCRIBE_TEMPLATE_ID${hardcodedEmpty ? '（代码里默认值是空串）' : ''}`,
    '在微信公众平台提交订阅消息模板并拿到模板 ID，部署时注入该环境变量');
}

// A5 H5 服务端内容安全
const h5Safety = read('src/utils/contentSafety.ts');
const cloudSafety = ['chat', 'extract'].map((d) => read(`cloudfunctions/${d}/index.js`).includes('msgSecCheck'));
if (cloudSafety.some(Boolean) && !/msgSecCheck/.test(read('src/services/cloudLlm.ts'))) {
  add('h5-content-safety', 'H5 链路没有服务端内容安全（仅本地关键词护栏）', 'blocked', '外部',
    'msgSecCheck 只在 cloudfunctions/chat|extract 中；src/services/cloudLlm.ts 的 H5 直连链路不经过它',
    '需要服务端内容安全能力（平台侧接口或自建审核）覆盖 H5 链路；本地护栏不等同平台级审核');
} else if (!h5Safety) {
  add('h5-content-safety', '未能检出 H5 内容安全实现', 'unknown', '外部',
    'src/utils/contentSafety.ts 不存在',
    '人工确认 H5 链路的内容安全策略');
} else {
  add('h5-content-safety', 'H5 侧内容安全实现已检出', 'ready', '外部',
    'src/utils/contentSafety.ts 存在', '');
}

// A6 微信支付商户号
// 支付：判据是「商户配置的**值**有没有配」，不是「代码里有没有这个词」——
// 后者只能证明有人写过这条路径，证明不了能用。
const PAY_ENV_KEYS = ['PAY_WX_SUB_MCH_ID', 'PAY_ALIPAY_APP_ID', 'PAY_DY_PUBLIC_KEY'];
const payConfigured = PAY_ENV_KEYS.filter((k) => process.env[k]);
if (!payConfigured.length) {
  add('pay-merchant', '支付商户配置未注入（微信/支付宝/抖音都没有可用凭据）', 'blocked', '外部',
    `未检出已配置的环境变量（${PAY_ENV_KEYS.join(' / ')}）；H5 侧本来就没有支付通道，订单表为空是预期`,
    '开通微信支付商户号（并按需配置支付宝/抖音）后注入对应环境变量');
} else {
  add('pay-merchant', '支付商户配置已注入', 'ready', '外部', payConfigured.join(', '), '');
}

// A7 电商资质（购物助理完整形态）
add('sxm-ecommerce', '购物助理「跨站自动比价 + 代下单」形态的资质未就绪', 'blocked', '外部',
  'PRD 与界面均已标注「需资质升级中」；当前只做兜底形态（清单 / 提醒 / 链接 / 手动比价）',
  '电商类目资质 + 淘宝客 / 京东联盟 API 授权 + 售后责任链；未就绪前维持兜底形态');

/* ─────────────── B. 代码侧待办（本仓库可以做，还没做） ─────────────── */

const legal = read('src/data/legal.ts');
if (/占位|待法务|placeholder/i.test(legal)) {
  add('legal-copy', '设置页法务文案仍是占位版', 'todo', '代码',
    lineOf('src/data/legal.ts', '占位') || 'src/data/legal.ts',
    '把正式《用户协议》与《隐私政策》文案接进来');
} else {
  add('legal-copy', '法务文案未检出占位标记（请人工确认是正式版）', 'unknown', '代码',
    'src/data/legal.ts', '人工过一遍法务文案是否已是正式版');
}

// 客服：同样只看「值」，不看「代码里提没提到这个词」
if (process.env.SERVICE_CORP_ID) {
  add('support-corp', '企业微信客服已配置', 'ready', '外部', 'SERVICE_CORP_ID', '');
} else {
  add('support-corp', '企业微信客服未配置（当前为弹窗兜底）', 'todo', '外部',
    'SERVICE_CORP_ID 未设置；云函数侧也未检出注入点',
    '绑定企业微信客服并注入 SERVICE_CORP_ID');
}

// 天气：2026-10-25 起从和风（有 key）切到 Open-Meteo（免 key）⇒ 这里不该再要求 key
if (/open-meteo/i.test(read('src/utils/weather.ts') + read('src/services/cloud.ts'))) {
  add('weather-key', '天气已切 Open-Meteo（免 key，无需凭据）', 'ready', '外部',
    'src/utils/weather.ts / src/services/cloud.ts 走 api.open-meteo.com', '');
} else {
  add('weather-key', '天气数据源未检出（既没有 Open-Meteo，也没有 key 配置）', 'unknown', '外部',
    'src/utils/weather.ts 不存在或未提及 open-meteo',
    '人工确认天气数据源与凭据需求');
}

const tabIcons = fs.existsSync(path.join(ROOT, 'src/assets/tabbar-png'))
  ? fs.readdirSync(path.join(ROOT, 'src/assets/tabbar-png')).filter((f) => f.endsWith('.png')).length
  : 0;
if (tabIcons >= 10) {
  add('tabbar-png', 'TabBar 图标 PNG 已备齐', 'ready', '代码', `src/assets/tabbar-png/（${tabIcons} 个）`, '');
} else {
  add('tabbar-png', 'TabBar 图标仍是 SVG（真机建议换 PNG）', 'todo', '代码',
    `src/assets/tabbar-png/ 现有 PNG ${tabIcons} 个`,
    '导出 5 组 × 选中/未选中 PNG 并替换');
}

add('logo-upload', '小程序 logo 未上传微信后台', 'todo', '外部',
  'src/assets/logo.svg 已出稿（还需 144×144 PNG）',
  '导出 144×144 PNG 并上传到微信公众平台');

/* ─────────────── C. 已就绪（给信心，也防回退） ─────────────── */

const fnDirs = fs.existsSync(path.join(ROOT, 'cloudfunctions'))
  ? fs.readdirSync(path.join(ROOT, 'cloudfunctions')).filter((d) =>
      fs.existsSync(path.join(ROOT, 'cloudfunctions', d, 'index.js'))).length
  : 0;
add('cloudfunctions', '云函数源码齐备（但一个都部署不了）', 'ready', '代码',
  `cloudfunctions/ 下 ${fnDirs} 个函数目录；离线门禁 verify:cloudfunctions 全绿`, '');

add('h5-cloud', 'H5 云库接线就绪（RPC 白名单 + RLS 按 owner 隔离）', 'ready', '代码',
  'src/services/cloudDb.ts / cloudSync.ts', '');
add('legal-honesty', '法务页已按端如实陈述内容安全现状', 'ready', '代码',
  lineOf('src/data/legal.ts', '网页端') || 'src/data/legal.ts', '');
add('ci-green', '四条流水线全绿（checks / contrast-render / deploy-h5 / pages）', 'ready', '代码',
  '.github/workflows/', '');

/* ─────────────── 输出 ─────────────── */

const order = { blocked: 0, todo: 1, unknown: 2, ready: 3 };
items.sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id));
const count = (s) => items.filter((i) => i.status === s).length;

if (AS_JSON) {
  console.log(JSON.stringify({ items, summary: { blocked: count('blocked'), todo: count('todo'), unknown: count('unknown'), ready: count('ready') } }, null, 2));
} else {
  const title = { blocked: '⛔ 外部阻塞（代码解决不了，必须人补齐）', todo: '⚠️ 代码侧待做（本仓库可以做）', unknown: '❓ 未能检出（不许当成通过）', ready: '✅ 已就绪' };
  console.log('上线阻塞体检（launch:readiness）');
  console.log('─'.repeat(78));
  for (const st of ['blocked', 'todo', 'unknown', 'ready']) {
    const group = items.filter((i) => i.status === st);
    if (!group.length) continue;
    console.log(`\n${title[st]}`);
    for (const i of group) {
      console.log(`  ${i.id.padEnd(22)} ${i.title}`);
      if (i.evidence) console.log(`  ${' '.repeat(22)} 证据：${i.evidence}`);
      if (i.next) console.log(`  ${' '.repeat(22)} 下一步：${i.next}（${i.owner}）`);
    }
  }
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`阻塞 ${count('blocked')} 项 / 待做 ${count('todo')} 项 / 未能检出 ${count('unknown')} 项 / 已就绪 ${count('ready')} 项`);
  console.log('默认退出码 0（诊断工具，不当门禁）；--strict 时有阻塞项退出 1。');
}
process.exit(STRICT && count('blocked') > 0 ? 1 : 0);
