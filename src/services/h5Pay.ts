/**
 * H5 支付通道（微信 H5 / 支付宝 WAP 由网关决定）
 *
 * 【为什么 H5 要单独一条链】
 *   小程序三通道走 `wx.requestPayment` / `my.tradePay` / `tt.requestPayment`，
 *   支付参数由云函数 `createOrder → pay-*` 现签；H5 没有这些原生 API，也没有能
 *   持有商户密钥的服务端（H5 后端是 WorkBuddy 云库：只有 DB + Auth + LLM，
 *   不能签名微信支付请求、也无法回调验签）。所以 H5 走**支付网关**：
 *
 *     POST {gateway}/order/create  → { orderId, payUrl }
 *     浏览器跳转 payUrl（微信 H5 支付的 h5_url 本身就是跳转链接）
 *     用户付完回跳本页，URL 带 h5pay_order=<orderId>
 *     GET  {gateway}/order/query?orderId=… → { status: pending|paid|closed }
 *
 * 【诚实性铁律（这条最重要）】
 *   网关没配置时**绝不假装成功**、绝不扣额度、绝不在本地写凭证：
 *   返回 `unconfigured`，页面照实说「H5 支付通道未开通」，并保留促销码兑换这条路。
 *   H5 的订阅态真值在服务端 orders 表，本地写什么都改不了云函数额度 ——
 *   伪造一个「已开通」只会让用户付了钱却用不了。
 */

const GATEWAY = ((): string => {
  // 编译期注入（config/index.ts 的 defineConstants）：构建时若没设环境变量就是空串
  const v = process.env.H5_PAY_GATEWAY || '';
  return v.replace(/\/+$/, '');
})();

/** 回跳参数名：网关把 orderId 带回来，页面据此查单 */
export const H5_PAY_RETURN_PARAM = 'h5pay_order';

export type H5PayState =
  | 'ok'
  | 'unconfigured' // 网关未配置（没有商户号/网关地址）—— 如实降级，不是错误
  | 'no-session' // 未登录，拿不到下单凭据
  | 'timeout' // 网关超时
  | 'gateway-error'; // 网关返回非 2xx 或结构不对

export interface H5PayOrder {
  state: H5PayState;
  orderId?: string;
  payUrl?: string;
  /** 失败时给用户看的原因（已本地化前的技术原因，页面按 state 出文案） */
  detail?: string;
}

export type H5PayStatus = 'pending' | 'paid' | 'closed' | 'unknown';

export interface H5PayQuery {
  state: H5PayState;
  status: H5PayStatus;
  detail?: string;
}

/** 网关是否可用：唯一判据是编译期注入的地址非空 */
export function isH5PayConfigured(): boolean {
  return GATEWAY.length > 0;
}

/** 从当前 URL 取回跳带回的订单号（没有则 null） */
export function readReturnedOrderId(href?: string): string | null {
  const url = href || (typeof window !== 'undefined' ? window.location.href : '');
  if (!url) return null;
  const m = new RegExp(`[?&]${H5_PAY_RETURN_PARAM}=([^&#]+)`).exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 网关不校验 Bearer：凭证的可信性来自 HMAC 签名 + 下单时绑定的 ownerId，
 * 权益归属由数据库函数用 auth.uid() 校验（见 .tools/sql/v9-h5-paid-orders.sql）。
 * 这里刻意不自己解析会话 —— 会话键是 `workbuddy-cloud.session.<publishableKey>`，
 * 早期版本写死成 `wb-session` 取不到 token，会让下单永远走 no-session。 */

/**
 * 下单。**永不抛**（与 cloudStorage / cloudOrders 同口径）：调用方只看 state。
 */
export async function createH5Order(planId: string, ownerId: string): Promise<H5PayOrder> {
  if (!isH5PayConfigured()) return { state: 'unconfigured' };
  // ownerId 必须来自会话（不是用户输入）：它决定这笔订单的权益归谁
  if (!ownerId) return { state: 'no-session' };

  try {
    const res = await withTimeout(
      fetch(`${GATEWAY}/order/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, ownerId })
      }),
      10000
    );
    if (res === 'timeout') return { state: 'timeout' };
    if (!res.ok) return { state: 'gateway-error', detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { orderId?: string; payUrl?: string };
    if (!body || !body.orderId || !body.payUrl) {
      return { state: 'gateway-error', detail: 'missing orderId/payUrl' };
    }
    return { state: 'ok', orderId: body.orderId, payUrl: body.payUrl };
  } catch (err) {
    return { state: 'gateway-error', detail: String((err as Error)?.message || err) };
  }
}

/**
 * 查单。**永不抛**。网关异常一律 `unknown` —— 页面必须按「待确认」展示，
 * 不能因为一次查询失败就宣称「支付失败」（用户可能已经付了）。
 */
export async function queryH5Order(orderId: string): Promise<H5PayQuery> {
  if (!isH5PayConfigured()) return { state: 'unconfigured', status: 'unknown' };
  if (!orderId) return { state: 'gateway-error', status: 'unknown', detail: 'missing orderId' };

  try {
    const res = await withTimeout(
      fetch(`${GATEWAY}/order/query?orderId=${encodeURIComponent(orderId)}`),
      8000
    );
    if (res === 'timeout') return { state: 'timeout', status: 'unknown' };
    if (!res.ok) return { state: 'gateway-error', status: 'unknown', detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: string };
    const s = body?.status;
    const status: H5PayStatus = s === 'paid' || s === 'closed' || s === 'pending' ? s : 'unknown';
    return { state: 'ok', status };
  } catch (err) {
    return { state: 'gateway-error', status: 'unknown', detail: String((err as Error)?.message || err) };
  }
}

/** 跳转到网关收银台（微信 H5 支付：h5_url 必须在外部浏览器打开） */
export function redirectToPayUrl(payUrl: string): boolean {
  if (typeof window === 'undefined' || !payUrl) return false;
  // 只允许 https，避免被塞 javascript: / data: 之类的伪协议（网关被劫持时的最后一道闸）
  if (!/^https:\/\//i.test(payUrl)) return false;
  window.location.href = payUrl;
  return true;
}

/* ---------------- 已付款凭证（权益闭环的交接点） ---------------- */

export interface H5PayClaim {
  orderId: string;
  planId: string;
  amountCents: number;
  /** Unix 秒；必须与数据库函数验签的 payload 同源 */
  paidAt: number;
  /** 下单时绑定的账号；数据库函数要求它等于 auth.uid() */
  ownerId: string;
  sig: string;
}

export type H5ClaimResult =
  | { state: 'ok'; claim: H5PayClaim }
  | { state: 'not-paid' } // 上游还没确认收款：页面显示「待确认」，不催不谎报
  | { state: 'unconfigured' }
  | { state: 'no-session' }
  | { state: 'timeout' }
  | { state: 'gateway-error'; detail?: string };

/**
 * 取「已付款凭证」。网关只对**确认已付**的订单签发；未付返 409 not-paid。
 * 永不抛。凭证本身不带任何权限 —— 能否开通由服务端 `redeem_paid_order` 验签决定。
 */
export async function claimH5Order(orderId: string): Promise<H5ClaimResult> {
  if (!isH5PayConfigured()) return { state: 'unconfigured' };
  if (!orderId) return { state: 'gateway-error', detail: 'missing orderId' };
  try {
    const res = await withTimeout(
      fetch(`${GATEWAY}/order/claim?orderId=${encodeURIComponent(orderId)}`),
      8000
    );
    if (res === 'timeout') return { state: 'timeout' };
    if (res.status === 409) return { state: 'not-paid' };
    if (res.status === 503) return { state: 'unconfigured' };
    if (!res.ok) return { state: 'gateway-error', detail: `HTTP ${res.status}` };
    const body = (await res.json()) as Partial<H5PayClaim>;
    if (
      !body?.orderId ||
      !body.planId ||
      typeof body.amountCents !== 'number' ||
      !body.paidAt ||
      !body.ownerId ||
      !body.sig
    ) {
      return { state: 'gateway-error', detail: 'claim 字段不全' };
    }
    return {
      state: 'ok',
      claim: {
        orderId: body.orderId,
        planId: body.planId,
        amountCents: body.amountCents,
        paidAt: Number(body.paidAt),
        ownerId: String(body.ownerId),
        sig: String(body.sig)
      }
    };
  } catch (err) {
    return { state: 'gateway-error', detail: String((err as Error)?.message || err) };
  }
}
