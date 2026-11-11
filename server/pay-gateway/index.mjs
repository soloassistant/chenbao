/**
 * 聚合支付网关（H5 专用）
 *
 * 【为什么需要这个服务】
 *   H5 端没有能持有商户密钥的地方：WorkBuddy 云库只有 DB/Auth/LLM，不能签支付请求；
 *   `cloudfunctions/` 那套因缺 AppID/密钥无法部署。而聚合支付（虎皮椒 / Xunhupay 一类）
 *   的 `appsecret` **必须留在服务端** —— 放前端等于把收款权限公开。所以这里是一个
 *   独立可部署的最小 HTTP 服务，只干三件事：签名下单、查单、回调验签。
 *
 * 【契约（前端 src/services/h5Pay.ts 对齐这份）】
 *   POST /order/create   { planId }            → { orderId, payUrl }
 *   GET  /order/query    ?orderId=…            → { status: pending|paid|closed }
 *   POST /notify         （聚合支付异步回调，form-urlencoded）
 *   GET  /health                               → { ok, configured, provider }
 *
 * 【诚实性】
 *   未配置 `XUNHUPAY_APPID` / `XUNHUPAY_APPSECRET` 时，`/order/create` 返回
 *   **503 + `{ error: 'unconfigured' }`**，绝不返回一个假的 payUrl、绝不把订单标成已付。
 *   前端据此显示「支付通道未开通」，并保留促销码兑换这条路。
 *
 * 【金额】
 *   价格表在服务端（不信前端传的金额）。前端只传 planId。
 */

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/* ---------------- 配置 ---------------- */

const PORT = Number(process.env.PORT || 8080);
const PROVIDER = process.env.PAY_GATEWAY_PROVIDER || 'xunhupay';
const APPID = process.env.XUNHUPAY_APPID || '';
const APPSECRET = process.env.XUNHUPAY_APPSECRET || '';
/** 聚合支付的下单/查单地址（不同服务商不同，用环境变量覆盖） */
const API_CREATE =
  process.env.PAY_API_CREATE || 'https://api.xunhupay.com/payment/do.html';
const API_QUERY = process.env.PAY_API_QUERY || 'https://api.xunhupay.com/payment/query.html';
/** 异步回调地址（服务商 POST 到这里）与本服务对外地址 */
const NOTIFY_URL = process.env.PAY_NOTIFY_URL || '';
const PUBLIC_BASE = (process.env.PAY_PUBLIC_BASE || '').replace(/\/+$/, '');
/** 付完回跳的前端地址（H5 页面会带 ?h5pay_order=…） */
const RETURN_URL = process.env.PAY_RETURN_URL || '';

/** 价格表：单位**分**。与 src/utils/subscription.ts 的价目表必须一致（门禁 verify:h5pay 会比对） */
const PLANS = {
  earlybird_monthly: { priceFen: 690, months: 1, title: '晨报会员 · 早鸟月付' },
  monthly: { priceFen: 990, months: 1, title: '晨报会员 · 月付' },
  yearly: { priceFen: 8800, months: 12, title: '晨报会员 · 年付' }
};

/* ---------------- 订单账本（内存 + 可选 JSONL 审计） ---------------- */

/**
 * 订单态在内存里维护：本服务的职责是「签名 + 查单」，
 * 真正的权益发放仍由服务端（orders 表）决定 —— 这里不越权发权益。
 * 进程重启后内存丢失是可接受的：查单会回落到向服务商查询（见 queryRemote）。
 */
const orders = new Map();

function newOrderId() {
  return `h5p_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

/* ---------------- 签名（聚合支付通用口径：按 key 排序拼串后加 secret 做 md5） ---------------- */

/**
 * 签名：剔除 `hash` 与空值 → 按 key 字典序拼 `k=v&…` → 末尾接 appsecret → md5。
 * 这是虎皮椒/Xunhupay 一类网关的通用算法；换服务商时只需改 signOf。
 */
export function signOf(params, secret) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'hash' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort();
  const raw = keys.map((k) => `${k}=${params[k]}`).join('&');
  return createHash('md5').update(raw + secret, 'utf8').digest('hex');
}

/** 定长比较，避免签名校验被时序侧信道猜 */
export function hashEquals(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function isConfigured() {
  return APPID.length > 0 && APPSECRET.length > 0;
}

/* ---------------- 与聚合支付通信 ---------------- */

async function postForm(url, params, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 服务商偶尔回 HTML 错误页，交给调用方按 errcode 缺失处理 */
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下单：返回服务商给的收银台 URL。
 * 注意 `total_fee` 用**元**（虎皮椒口径），内部价格表是分 → 这里除以 100。
 */
async function createRemoteOrder(order) {
  const nonce = randomBytes(8).toString('hex');
  const params = {
    version: '1.1',
    appid: APPID,
    trade_order_id: order.orderId,
    total_fee: (order.priceFen / 100).toFixed(2),
    title: order.title,
    time: Math.floor(Date.now() / 1000),
    notify_url: NOTIFY_URL || `${PUBLIC_BASE}/notify`,
    return_url: RETURN_URL || `${PUBLIC_BASE}/return`,
    callback_url: RETURN_URL || `${PUBLIC_BASE}/return`,
    nonce_str: nonce,
    type: 'WAP',
    wap_url: RETURN_URL || `${PUBLIC_BASE}/return`,
    wap_name: order.title
  };
  params.hash = signOf(params, APPSECRET);
  const r = await postForm(API_CREATE, params);
  if (!r.json) return { ok: false, reason: `上游返回非 JSON（HTTP ${r.status}）` };
  if (Number(r.json.errcode) !== 0) {
    return { ok: false, reason: `上游 errcode=${r.json.errcode} ${r.json.errmsg || ''}`.trim() };
  }
  const payUrl = r.json.url || r.json.pay_url || r.json.data?.url;
  if (!payUrl) return { ok: false, reason: '上游未返回支付地址' };
  return { ok: true, payUrl };
}

/** 查单：向服务商问真实状态（回调可能丢，查单是兜底） */
async function queryRemote(orderId) {
  const params = {
    appid: APPID,
    out_trade_order: orderId,
    trade_order_id: orderId,
    time: Math.floor(Date.now() / 1000),
    nonce_str: randomBytes(8).toString('hex')
  };
  params.hash = signOf(params, APPSECRET);
  const r = await postForm(API_QUERY, params);
  if (!r.json) return { status: 'unknown', reason: `上游返回非 JSON（HTTP ${r.status}）` };
  const data = r.json.data || r.json;
  // 服务商口径不一致：有的给 status='OD'（已支付）/ 'WP'（待付），有的给 return_code
  const raw = String(data.status || data.trade_status || data.return_code || '').toUpperCase();
  if (raw === 'OD' || raw === 'SUCCESS' || raw === 'PAID') return { status: 'paid' };
  if (raw === 'CD' || raw === 'CLOSED' || raw === 'FAIL') return { status: 'closed' };
  if (raw) return { status: 'pending' };
  return { status: 'unknown', reason: '上游未给出可识别状态' };
}

/* ---------------- HTTP ---------------- */

function send(res, code, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 前端是不同源（站点域名 vs 网关域名）
    'Access-Control-Allow-Origin': process.env.PAY_CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extraHeaders
  });
  res.end(payload);
}

async function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, configured: isConfigured(), provider: PROVIDER });
  }

  if (url.pathname === '/order/create' && req.method === 'POST') {
    // 未配置：如实 503，**不**返回假地址
    if (!isConfigured()) {
      return send(res, 503, { error: 'unconfigured', message: '支付通道未配置（缺 XUNHUPAY_APPID / XUNHUPAY_APPSECRET）' });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'bad-json' });
    }
    const plan = PLANS[body.planId];
    // 金额只认服务端价格表：前端传 price 一律忽略（否则 1 分钱买年付）
    if (!plan) return send(res, 400, { error: 'invalid-plan' });

    const order = {
      orderId: newOrderId(),
      planId: body.planId,
      priceFen: plan.priceFen,
      months: plan.months,
      title: plan.title,
      status: 'pending',
      createdAt: Date.now()
    };
    orders.set(order.orderId, order);

    let remote;
    try {
      remote = await createRemoteOrder(order);
    } catch (err) {
      orders.delete(order.orderId);
      return send(res, 502, { error: 'gateway-error', message: String(err?.message || err) });
    }
    if (!remote.ok) {
      orders.delete(order.orderId);
      return send(res, 502, { error: 'gateway-error', message: remote.reason });
    }
    order.payUrl = remote.payUrl;
    return send(res, 200, { orderId: order.orderId, payUrl: remote.payUrl });
  }

  if (url.pathname === '/order/query' && req.method === 'GET') {
    if (!isConfigured()) return send(res, 503, { error: 'unconfigured' });
    const orderId = url.searchParams.get('orderId') || '';
    if (!orderId) return send(res, 400, { error: 'missing-orderId' });
    const local = orders.get(orderId);
    // 本地已确认「已付」就直接回，不再打扰上游
    if (local && local.status === 'paid') return send(res, 200, { status: 'paid' });

    try {
      const remote = await queryRemote(orderId);
      if (remote.status === 'paid' && local) local.status = 'paid';
      return send(res, 200, { status: remote.status });
    } catch (err) {
      // 上游不通时**不能**说 closed/failed：用户可能已经付了款
      return send(res, 200, { status: 'unknown', message: String(err?.message || err) });
    }
  }

  if (url.pathname === '/notify' && (req.method === 'POST')) {
    const raw = await readBody(req);
    // 回调是 form-urlencoded；也容忍 JSON（自测用）
    let params = {};
    try {
      params = JSON.parse(raw);
    } catch {
      params = Object.fromEntries(new URLSearchParams(raw));
    }
    // 未配置时无法验签 ⇒ 一律拒绝（fail-closed），绝不因为「看起来像成功」而标记已付
    if (!isConfigured()) return send(res, 503, 'unconfigured');
    const got = params.hash || params.sign;
    if (!got || !hashEquals(got, signOf(params, APPSECRET))) {
      return send(res, 400, 'invalid-hash');
    }
    const orderId = params.trade_order_id || params.out_trade_order || '';
    const order = orders.get(orderId);
    if (order) {
      const paid = String(params.status || params.return_code || '').toUpperCase();
      order.status = paid === 'OD' || paid === 'SUCCESS' ? 'paid' : order.status;
    }
    // 聚合支付一般要求回纯文本 success，否则会重试
    return send(res, 200, 'success');
  }

  return send(res, 404, { error: 'not-found' });
});

const isMain = process.argv[1] && process.argv[1].endsWith('index.mjs');
if (isMain) {
  server.listen(PORT, () => {
    console.log(`[pay-gateway] listening on ${PORT} provider=${PROVIDER} configured=${isConfigured()}`);
    if (!isConfigured()) {
      console.log('[pay-gateway] 未配置商户参数：/order/create 会返回 503 unconfigured（这是刻意的，不伪造成功）');
    }
  });
}

export { server, PLANS, orders };
