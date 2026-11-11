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
  const url = href || (typeof location !== 'undefined' ? location.href : '');
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

function authHeaders(): Record<string, string> | null {
  // 只认会话里的 access token；不读、不传用户 id（与 cloudDb 同口径）
  try {
    const raw =
      (typeof window !== 'undefined' && window.localStorage.getItem('wb-session')) || '';
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: { access_token?: string } } | { access_token?: string };
    const token =
      (parsed as { data?: { access_token?: string } }).data?.access_token ||
      (parsed as { access_token?: string }).access_token ||
      '';
    if (!token) return null;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  } catch {
    return null;
  }
}

/**
 * 下单。**永不抛**（与 cloudStorage / cloudOrders 同口径）：调用方只看 state。
 */
export async function createH5Order(planId: string): Promise<H5PayOrder> {
  if (!isH5PayConfigured()) return { state: 'unconfigured' };
  const headers = authHeaders();
  if (!headers) return { state: 'no-session' };

  try {
    const res = await withTimeout(
      fetch(`${GATEWAY}/order/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ planId })
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
  const headers = authHeaders();
  if (!headers) return { state: 'no-session', status: 'unknown' };

  try {
    const res = await withTimeout(
      fetch(`${GATEWAY}/order/query?orderId=${encodeURIComponent(orderId)}`, { headers }),
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
  if (typeof location === 'undefined' || !payUrl) return false;
  // 只允许 https，避免被塞 javascript: / data: 之类的伪协议（网关被劫持时的最后一道闸）
  if (!/^https:\/\//i.test(payUrl)) return false;
  location.href = payUrl;
  return true;
}
