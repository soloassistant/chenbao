/**
 * H5 支付门禁
 *
 * 守四件事（每一条都能变红）：
 *   A. 签名算法与「篡改必拒」—— 金额/订单号改一个字符，hash 必须不匹配
 *   B. 未配置商户参数时 `/order/create` 必须 503 unconfigured，**绝不返回假 payUrl**
 *   C. 金额只认服务端价格表，且与服务端 PLANS、前端价目表三方一致（1 分钱买年付是红线）
 *   D. 前端不得出现商户密钥；失败路径不得把「查不到」说成「已失败/已成功」
 *
 * 用法：node .tools/verify-h5pay.mjs
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
};

/* ---------------- A. 签名与篡改检测 ---------------- */

// 从网关源码里取真实实现（不复制一份来测，否则改了实现门禁还绿）
const gw = read('server/pay-gateway/index.mjs');
const signSrc = /export function signOf\(params, secret\) \{[\s\S]*?\n\}/.exec(gw);
ok('A1 网关导出 signOf 实现（门禁有真实靶子）', !!signSrc);

// 用独立实现算一遍基准值：按 key 排序拼 k=v&… 再拼 secret 做 md5
const SECRET = 'test-secret-do-not-use';
const params = { appid: 'app-001', trade_order_id: 'h5p_1', total_fee: '6.90', title: '测试', nonce_str: 'abc', time: '1700000000' };
const expected = createHash('md5')
  .update(
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&') + SECRET,
    'utf8'
  )
  .digest('hex');

// 用签名函数本身算（直接 import 会启动服务器，改用 vm 抽取函数体求值）
const { runInNewContext } = await import('node:vm');
function loadSign(gatewaySrc) {
  const m = /export function signOf\(params, secret\) \{([\s\S]*?)\n\}/.exec(gatewaySrc);
  if (!m) return null;
  const body = m[1];
  return (p, s) => {
    const ctx = { createHash };
    return runInNewContext(`(function(params, secret){${body}})`, ctx)(p, s);
  };
}
const sign = loadSign(gw);
ok('A2 签名函数可独立求值', typeof sign === 'function');
if (sign) {
  ok('A3 签名口径正确（与独立实现逐字符相同）', sign({ ...params }, SECRET) === expected, `${sign({ ...params }, SECRET)} vs ${expected}`);
  // 篡改金额
  ok('A4 改金额后签名不匹配（套利者改 total_fee 必被拒）', sign({ ...params, total_fee: '0.01' }, SECRET) !== expected);
  // 篡改订单号
  ok('A5 改订单号后签名不匹配（重放别的订单必被拒）', sign({ ...params, trade_order_id: 'h5p_2' }, SECRET) !== expected);
  // 密钥不对
  ok('A6 换密钥后签名不匹配', sign({ ...params }, 'other-secret') !== expected);
  // 空值不参与签名（否则服务商与本地算法会因 `k=` 分歧）
  ok('A7 空值/null 不参与签名（避免与服务商口径分歧）', sign({ ...params, extra: '' }, SECRET) === expected);
  // hash 字段自身不参与
  ok('A8 hash 字段自身不参与签名（否则无法自洽）', sign({ ...params, hash: 'deadbeef' }, SECRET) === expected);
}

/* ---------------- B. 未配置必须如实拒绝 ---------------- */

ok(
  'B1 未配置时 /order/create 返回 503 + unconfigured（不伪造 payUrl）',
  /if \(!isConfigured\(\)\) \{\s*\n\s*return send\(res, 503, \{ error: 'unconfigured'/.test(gw)
);
ok(
  'B2 未配置时回调一律拒绝（fail-closed，不因"像成功"就标记已付）',
  /if \(!isConfigured\(\)\) return send\(res, 503, 'unconfigured'\)/.test(gw)
);
ok(
  'B3 未配置时查单也拒绝（不返回一个编出来的状态）',
  /if \(!isConfigured\(\)\) return send\(res, 503, \{ error: 'unconfigured' \}\)/.test(gw)
);
ok(
  'B4 上游下单失败会删除本地订单（不留"幽灵订单"）',
  /if \(!remote\.ok\) \{\s*\n\s*orders\.delete\(order\.orderId\);/.test(gw)
);

/* ---------------- C. 金额只认服务端 ---------------- */

ok(
  'C1 前端传的金额一律忽略（只按 planId 查服务端价格表）',
  /const plan = PLANS\[body\.planId\];/.test(gw) && !/body\.price/.test(gw)
);
ok(
  'C2 非法 planId 直接 400（不给"默认套餐"兜底）',
  /if \(!plan\) return send\(res, 400, \{ error: 'invalid-plan' \}\)/.test(gw)
);

// 三方价格一致：服务端 PLANS ↔ 前端 EARLYBIRD_PRICE（单位换算 元 ↔ 分）
const sub = read('src/utils/subscription.ts');
const frontPrice = {};
for (const m of sub.matchAll(/^\s{2}(earlybird_monthly|monthly|yearly):\s*([\d.]+)/gm)) {
  frontPrice[m[1]] = Number(m[2]);
}
const serverPrice = {};
for (const m of gw.matchAll(/^\s{2}(earlybird_monthly|monthly|yearly):\s*\{ priceFen: (\d+)/gm)) {
  serverPrice[m[1]] = Number(m[2]) / 100;
}
const mismatch = Object.keys(frontPrice).filter((k) => Math.abs((serverPrice[k] ?? -1) - frontPrice[k]) > 1e-9);
ok(
  `C3 三方价格一致（服务端 PLANS = 前端价目表，共 ${Object.keys(frontPrice).length} 档）`,
  Object.keys(frontPrice).length > 0 && mismatch.length === 0 && Object.keys(serverPrice).length === Object.keys(frontPrice).length,
  `前端 ${JSON.stringify(frontPrice)} / 服务端 ${JSON.stringify(serverPrice)}`
);

/* ---------------- D. 前端诚实性 ---------------- */

const h5pay = read('src/services/h5Pay.ts');
ok(
  'D1 前端不含商户密钥（appsecret 只能在服务端）',
  !/APPSECRET|appsecret|XUNHUPAY_APPSECRET/i.test(h5pay)
);
ok(
  'D2 未配置时前端返回 unconfigured 而非抛错/伪造成功',
  /if \(!isH5PayConfigured\(\)\) return \{ state: 'unconfigured' \}/.test(h5pay)
);
ok(
  'D3 查单失败回落 unknown（不能把"查不到"说成已失败或已成功）',
  /catch \(err\) \{\s*\n\s*return \{ state: 'gateway-error', status: 'unknown'/.test(h5pay)
);
ok(
  'D4 跳转只允许 https（防伪协议劫持）',
  // 源码里是正则字面量 `/^https:\/\//i.test(payUrl)`，用字符串包含判断即可
  h5pay.includes('/^https:\\/\\//i.test(payUrl)')
);
ok(
  'D5 前端不自己算金额/不传金额给网关（价格只认服务端）',
  !/total_fee|totalFee/.test(h5pay)
);

/* ---------------- E. 权益闭环（支付 → 权益）---------------- */

const sql = read('.tools/sql/v9-h5-paid-orders.sql');
const subSrc = read('src/services/subscription.ts');

ok('E1 v9 迁移存在且声明可重复执行', sql.length > 2000 && /幂等/.test(sql));
ok(
  'E2 入账函数是 SECURITY DEFINER（否则写不进 orders）',
  /CREATE OR REPLACE FUNCTION public\.redeem_paid_order[\s\S]{0,400}SECURITY DEFINER/.test(sql)
);
ok(
  'E3 函数只用 auth.uid() 定归属，不接受客户端传 owner',
  /v_uid\s+text\s*:=\s*auth\.uid\(\)::text/.test(sql) && /p_owner_id\s*<>\s*v_uid/.test(sql)
);
ok(
  'E4 天数与金额由服务端白名单决定，客户端传入只用于比对',
  /v_months := CASE p_plan_id/.test(sql) && /v_expect_cents := CASE p_plan_id/.test(sql) && /金额与套餐不符/.test(sql)
);
ok(
  'E5 验签失败必须抛错（不许「没配密钥就放行」）',
  /v_secret IS NULL OR length\(v_secret\) < 32[\s\S]{0,80}RAISE EXCEPTION/.test(sql) &&
    /支付凭证验签失败/.test(sql)
);
ok(
  'E6 一单一发：核销表以 order_id 为主键且 ON CONFLICT 幂等',
  /CREATE TABLE IF NOT EXISTS public\.paid_order_claims[\s\S]{0,200}order_id\s+text\s+PRIMARY KEY/.test(sql) &&
    /ON CONFLICT \(order_id\) DO NOTHING/.test(sql)
);
ok(
  'E7 权限收口：PUBLIC/anon 不得有 EXECUTE，两张新表不得给客户端授权',
  /REVOKE ALL ON FUNCTION public\.redeem_paid_order[\s\S]{0,120}FROM PUBLIC, anon, authenticated/.test(sql) &&
    /GRANT EXECUTE ON FUNCTION public\.redeem_paid_order[\s\S]{0,80}TO authenticated/.test(sql) &&
    /REVOKE ALL ON TABLE public\.app_secrets[\s\S]{0,80}FROM PUBLIC, anon, authenticated/.test(sql) &&
    /REVOKE ALL ON TABLE public\.paid_order_claims[\s\S]{0,80}FROM PUBLIC, anon, authenticated/.test(sql)
);
// 只看**真实调用参数块**：`p_days` 在文件里出现过（那是讲历史后门的注释），
// 全文件 grep 会误报 —— 这是「判据打错靶」，不是放宽。
const redeemCall = /db\.rpc\('redeem_paid_order',\s*\{([\s\S]*?)\}\)/.exec(subSrc);
ok(
  'E8 客户端核销只转交凭证（不传 months / 不自己判天数）',
  !!redeemCall &&
    !/p_months|p_days|plan_days|months:/.test(redeemCall[1]) &&
    /p_order_id/.test(redeemCall[1]) &&
    /p_sig/.test(redeemCall[1])
);
ok(
  'E9 核销结果区分「函数未部署」与「服务端拒绝」（不能都算失败也不能都算成功）',
  /'unsigned'/.test(subSrc) && /'rejected'/.test(subSrc) && /PGRST202/.test(subSrc)
);
ok(
  'E10 客户端拿不到 secret（权益不能靠前端自证）',
  !/PAY_GATEWAY_HMAC_SECRET/.test(read('src/services/h5Pay.ts')) &&
    !/PAY_GATEWAY_HMAC_SECRET/.test(subSrc)
);

// 网关侧：凭证口径必须与 SQL 逐字符一致（错一个分隔符就全部验签失败）
ok(
  'E11 网关签发口径与 SQL 拼串一致（order|plan|amount|paid_at|owner）',
  /`\$\{order\.orderId\}\|\$\{order\.planId\}\|\$\{order\.priceFen\}\|\$\{paidAt\}\|\$\{order\.ownerId\}`/.test(gw) &&
    /p_order_id \|\| '\|' \|\| p_plan_id \|\| '\|' \|\| p_amount_cents::text \|\| '\|' \|\| p_paid_at::text \|\| '\|' \|\| p_owner_id/.test(sql)
);
ok(
  'E12 网关只对已付订单签凭证（未付 409，不签「预支」凭证）',
  /if \(order\.status !== 'paid'\)[\s\S]{0,160}not-paid/.test(gw)
);
ok(
  'E13 缺 HMAC 密钥时不签发（不是「没配就放行」）',
  /unconfigured-claim/.test(gw)
);
ok(
  'E14 下单必须带 ownerId（凭证要能证明归属）',
  /missing-owner/.test(gw) && /ownerId,/.test(gw)
);

console.log(`\n[h5pay] PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail > 0 ? 1 : 0);
