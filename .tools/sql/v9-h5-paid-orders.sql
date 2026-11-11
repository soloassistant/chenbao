-- v9-h5-paid-orders.sql —— H5 支付成功后的**唯一**可信入账通道（2026-11-11）
--
-- ⚠️ 本文件需在 WorkBuddy 应用数据库控制台（service role）执行一次。可重复执行（幂等）。
--
-- 【为什么必须新增这个函数，不能复用 redeem_promo_order】
--   H5 支付走聚合支付网关，钱是真收到了，但「钱到账」这件事只有网关知道。
--   而 orders 表写入被三重收紧过：
--     ① REVOKE ALL ON orders FROM PUBLIC, anon, authenticated（v6）→ 客户端不能 INSERT；
--     ② 触发器 orders_block_client_paid → 客户端角色写 status='paid' 直接抛错；
--     ③ 唯一写入函数 redeem_promo_order 只认「预置在 promo_codes 里的营销码」，
--        支付订单没有码，塞不进去。
--   ⇒ 必须给「已付款的 H5 订单」开一扇**验签之后**才放行的门。
--
-- 【安全模型（和促销码同一套思路：客户端不传任何它自己能编的东西）】
--   客户端只转交网关签发的凭证：order_id / plan_id / amount_cents / paid_at / sig。
--   其中 sig = HMAC-SHA256(order_id|plan_id|amount_cents|paid_at|owner_id, secret) 的 hex。
--   secret 只存在本库 app_secrets 表里（REVOKE 到只有本函数的属主能读），
--   **不进仓库、不进前端、不进网关代码**。
--   ⇒ 客户端拿不到 secret，就永远造不出一条能过验签的凭证；
--     即使把别人订单号抄过来，也会因为 owner 已绑定而失败（见步骤 4）。
--
-- 【金额与时长不信客户端】
--   plan_id 必须命中白名单，且 amount_cents 必须与之**成对**匹配。
--   时长由本函数按 plan 决定（月付 1 个月 / 年付 12 个月），客户端说多少都不算。
--
-- 【幂等】
--   paid_order_claims 以 order_id 为主键，重复核销返回 already=true，绝不重复发权益。
--   崩溃后重试、用户连点、客户端重放，都只会成功一次。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- 1) 验签密钥表：只放一个随机串，REVOKE 到只有函数属主可读
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_secrets (
  name  text PRIMARY KEY,
  value text NOT NULL
);
REVOKE ALL ON TABLE public.app_secrets FROM PUBLIC, anon, authenticated;

-- ⚠️ 执行者必须手工插入一次密钥（**随机生成，不要用示例值**）：
--   INSERT INTO public.app_secrets (name, value)
--   VALUES ('pay_gateway_hmac', encode(gen_random_bytes(32), 'hex'))
--   ON CONFLICT (name) DO NOTHING;
--   然后把同一个串配到网关的环境变量 PAY_GATEWAY_HMAC_SECRET。
--   取值：SELECT value FROM public.app_secrets WHERE name='pay_gateway_hmac';

-- ---------------------------------------------------------------
-- 2) 核销记录：同一订单只发一次权益
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paid_order_claims (
  order_id     text        PRIMARY KEY,
  owner_id     text        NOT NULL,
  plan_id      text        NOT NULL,
  amount_cents integer     NOT NULL,
  paid_at      timestamptz NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.paid_order_claims FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------
-- 3) 唯一入账函数
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_paid_order(
  p_order_id     text,
  p_plan_id      text,
  p_amount_cents integer,
  p_paid_at      bigint,   -- Unix 秒（避免时区/格式歧义，签名字节稳定）
  p_owner_id     text,     -- 下单时绑定的账号；必须等于 auth.uid()
  p_sig          text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       text := auth.uid()::text;
  v_secret    text;
  v_months    integer;
  v_expect_cents integer;
  v_payload   text;
  v_expect    text;
  v_inserted  integer;
  v_row       public.paid_order_claims%ROWTYPE;
BEGIN
  -- 0. 登录
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录：不能登记订单';
  END IF;
  IF p_order_id IS NULL OR length(trim(p_order_id)) < 8 THEN
    RAISE EXCEPTION '订单号无效';
  END IF;

  -- 1. 套餐白名单（时长与金额都由服务端定，客户端传只用于比对）
  v_months := CASE p_plan_id
                WHEN 'earlybird_monthly' THEN 1
                WHEN 'monthly'           THEN 1
                WHEN 'yearly'            THEN 12
                ELSE NULL
              END;
  v_expect_cents := CASE p_plan_id
                      WHEN 'earlybird_monthly' THEN 690
                      WHEN 'monthly'           THEN 990
                      WHEN 'yearly'            THEN 8800
                      ELSE NULL
                    END;
  IF v_months IS NULL THEN
    RAISE EXCEPTION '未知套餐：%', coalesce(p_plan_id, '(null)');
  END IF;
  IF p_amount_cents IS DISTINCT FROM v_expect_cents THEN
    RAISE EXCEPTION '金额与套餐不符：% 应为 % 分', coalesce(p_amount_cents::text, '(null)'), v_expect_cents;
  END IF;

  -- 2. 验签（缺密钥就拒绝，不允许「没配密钥所以放行」）
  SELECT value INTO v_secret FROM public.app_secrets WHERE name = 'pay_gateway_hmac';
  IF v_secret IS NULL OR length(v_secret) < 32 THEN
    RAISE EXCEPTION '服务端未配置支付验签密钥';
  END IF;
  -- 归属校验（关键）：凭证里的 owner 必须是**当前登录用户**。
  --   否则任何人拿到别人已付订单号，就能用自己账号核销、白拿权益。
  --   网关只按「下单时记录的 owner」签发，不接受调用方指定 owner。
  IF p_owner_id IS NULL OR p_owner_id <> v_uid THEN
    RAISE EXCEPTION '该支付凭证不属于当前账号';
  END IF;
  v_payload := p_order_id || '|' || p_plan_id || '|' || p_amount_cents::text || '|' || p_paid_at::text || '|' || p_owner_id;
  v_expect  := encode(hmac(v_payload, v_secret, 'sha256'), 'hex');
  -- 用 SQL 侧的定长比较，避免在 plpgsql 里写成逐字符提前返回
  IF v_expect IS DISTINCT FROM lower(coalesce(p_sig, '')) THEN
    RAISE EXCEPTION '支付凭证验签失败';
  END IF;

  -- 3. 时间窗：凭证 7 天内有效
  --    为什么不是 24 小时：用户当天付完没回跳、隔天再打开很常见，卡 24h 会变成
  --    「钱收了、权益开不了」的人工工单。而这道窗并不是主防线 ——
  --    真正防重复发权益的是步骤 4 的主键（同一订单只发一次），
  --    防跨人冒用是 owner 绑定。窗口的作用只是让「很久以前漏出去的凭证」自动失效。
  IF abs(extract(epoch FROM now())::bigint - p_paid_at) > 604800 THEN
    RAISE EXCEPTION '支付凭证已过期（超过 7 天），请联系客服凭订单号人工开通';
  END IF;

  -- 4. 幂等 + 归属绑定（并发下靠主键原子占坑）
  INSERT INTO public.paid_order_claims (order_id, owner_id, plan_id, amount_cents, paid_at)
  VALUES (p_order_id, v_uid, p_plan_id, p_amount_cents, to_timestamp(p_paid_at))
  ON CONFLICT (order_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT * INTO v_row FROM public.paid_order_claims WHERE order_id = p_order_id;
    IF v_row.owner_id <> v_uid THEN
      RAISE EXCEPTION '该订单已绑定其他账号';
    END IF;
    -- 同一用户重复核销：成功但不再发权益（页面按 already 显示「已开通」）
    RETURN json_build_object('ok', true, 'already', true, 'months', v_row.plan_id);
  END IF;

  -- 5. 落订单（订单列表 / 权益回放都读这张表；channel 用 wechat_h5 便于对账区分）
  INSERT INTO public.orders (owner_id, order_id, plan_id, channel, amount_cents, months, status, paid_at)
  VALUES (v_uid, p_order_id, p_plan_id, 'wechat_h5', p_amount_cents, v_months, 'paid', to_timestamp(p_paid_at));

  RETURN json_build_object('ok', true, 'already', false, 'months', v_months);
END;
$$;

-- 6. 权限收口：只有登录用户可以调；anon / PUBLIC 一律拒绝
REVOKE ALL ON FUNCTION public.redeem_paid_order(text, text, integer, bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_paid_order(text, text, integer, bigint, text, text) TO authenticated;

-- ---------------------------------------------------------------
-- 执行后自检（把结果贴进发布记录）
-- ---------------------------------------------------------------
-- A) 函数存在且是 SECURITY DEFINER：
--   SELECT proname, pronargs, prosecdef FROM pg_proc WHERE proname = 'redeem_paid_order';
--   期望：1 行，prosecdef = t
--
-- B) 权限：只有 authenticated 有 EXECUTE：
--   SELECT grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_name = 'redeem_paid_order';
--   期望：authenticated / EXECUTE（没有 PUBLIC、anon）
--
-- C) 两张新表客户端一律无权限：
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name IN ('app_secrets','paid_order_claims') AND grantee IN ('PUBLIC','anon','authenticated');
--   期望：0 行
--
-- D) 密钥已配置（只看长度，别把值贴出来）：
--   SELECT name, length(value) FROM public.app_secrets;
--   期望：pay_gateway_hmac / 64
--
-- E) 负路径（用登录态在控制台之外测）：拿一个乱造的 sig 调它，必须报
--   「支付凭证验签失败」，**不得**留下 orders 行、也不得留下 claims 行：
--   SELECT count(*) FROM public.orders WHERE channel = 'wechat_h5';         -- 期望 0（负路径后）
--   SELECT count(*) FROM public.paid_order_claims;                          -- 期望 0（负路径后）
--
-- ---------------------------------------------------------------
-- 回滚（谨慎：只回滚代码，不要删已发放的订单）
-- ---------------------------------------------------------------
--   DROP FUNCTION IF EXISTS public.redeem_paid_order(text, text, integer, bigint, text, text);
--   -- 订单与核销记录**保留**（那是对账凭据，删掉等于抹账）
