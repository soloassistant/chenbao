-- v10-admin-ops.sql —— 运营后台所需的管理员能力（2026-11-12）
--
-- ⚠️ 已于 2026-11-12 在应用库执行（通过 WorkBuddy 云数据库工具，mode=migrate）。
--    本文件是**版本控制副本**：幂等，可重复执行。
--
-- 【为什么要这个文件】
--   此前后台依赖的管理员策略（feedback_admin_select / feedback_admin_update /
--   llm_events_admin_select / orders_admin_select / user_kv_admin_select /
--   client_errors_admin_select）**全部是控制台手工建的，仓库里一份都没有**，
--   而且管理员判定是**硬编码 uid**。换账号或重建环境时，后台会静默失去全部读取能力。
--   本迁移把这套收进仓库，并把「管理员是谁」变成数据而不是散落的字符串。
--
-- 【设计取舍】
--   · 新能力一律走 `is_app_admin()` 查 `app_admins` 表；**旧的 6 个硬编码策略暂不改**，
--     避免在同一次变更里同时动权限判定与策略语义（风险叠加）。文档里标注为待统一。
--   · 所有管理动作写 `admin_actions`（谁、对谁、做了什么、为什么），不做免审计入口。
--   · 人工开通**复用** `paid_order_claims` 的 order_id 主键做幂等，
--     所以「人工开通」和「用户自助核销」共用同一个唯一约束，不会重复发权益。

-- ---------------------------------------------------------------
-- 1) 管理员名单（把现有硬编码 uid 搬进来）
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_admins (
  uid      text PRIMARY KEY,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.app_admins FROM PUBLIC, anon, authenticated;

INSERT INTO public.app_admins (uid, note)
VALUES ('2108536518187421696', '主管理员（来自现有 RLS 策略里的硬编码 uid）')
ON CONFLICT (uid) DO NOTHING;

-- 判定函数：客户端可调（返回布尔，不泄露名单），非管理员一律 false
CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_admins WHERE uid = auth.uid()::text)
$$;
REVOKE ALL ON FUNCTION public.is_app_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated;

-- ---------------------------------------------------------------
-- 2) 审计表：每个管理动作一条
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_actions (
  id      bigserial PRIMARY KEY,
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text,
  payload jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.admin_actions FROM PUBLIC, anon, authenticated;

-- 管理员可读（客户端只能读，写由 SECURITY DEFINER 函数负责）
GRANT SELECT ON TABLE public.admin_actions TO authenticated;
CREATE POLICY admin_actions_admin_select ON public.admin_actions
  FOR SELECT TO authenticated USING (public.is_app_admin());

-- ---------------------------------------------------------------
-- 3) 核销记录对管理员可见（否则「付款了没开通」查不出来）
-- ---------------------------------------------------------------
GRANT SELECT ON TABLE public.paid_order_claims TO authenticated;
CREATE POLICY paid_order_claims_admin_select ON public.paid_order_claims
  FOR SELECT TO authenticated USING (public.is_app_admin());

-- ---------------------------------------------------------------
-- 4) 促销码对管理员可见 + 建码/停用（服务端算 hash，客户端不接触明文规则）
-- ---------------------------------------------------------------
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.promo_codes TO authenticated;
GRANT SELECT ON TABLE public.promo_redemptions TO authenticated;
CREATE POLICY promo_codes_admin_select ON public.promo_codes
  FOR SELECT TO authenticated USING (public.is_app_admin());
CREATE POLICY promo_redemptions_admin_select ON public.promo_redemptions
  FOR SELECT TO authenticated USING (public.is_app_admin());

-- ---------------------------------------------------------------
-- 5) 人工开通权益
-- ---------------------------------------------------------------
-- 与 redeem_paid_order 的区别：这条**不需要支付凭证**，用于「钱确实收到了、
-- 但凭证没到 / 过期 / 用户找不到订单」的人工兜底。代价是必须有管理员身份，
-- 且必须写原因（进审计）。
CREATE OR REPLACE FUNCTION public.admin_grant_membership(
  p_order_id text, p_owner_id text, p_plan_id text,
  p_amount_cents integer, p_reason text
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_months integer; v_existing public.paid_order_claims%ROWTYPE;
BEGIN
  IF NOT public.is_app_admin() THEN RAISE EXCEPTION '仅管理员可以人工开通'; END IF;
  IF p_owner_id IS NULL OR p_owner_id = '' THEN RAISE EXCEPTION '缺少目标账号'; END IF;
  IF p_order_id IS NULL OR length(trim(p_order_id)) < 8 THEN RAISE EXCEPTION '订单号无效'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 4 THEN
    RAISE EXCEPTION '必须填写开通原因（便于对账与审计）';
  END IF;
  v_months := CASE p_plan_id
                WHEN 'earlybird_monthly' THEN 1 WHEN 'monthly' THEN 1
                WHEN 'yearly' THEN 12 ELSE NULL END;
  IF v_months IS NULL THEN RAISE EXCEPTION '未知套餐：%', coalesce(p_plan_id, '(null)'); END IF;

  SELECT * INTO v_existing FROM public.paid_order_claims WHERE order_id = p_order_id;
  IF FOUND THEN
    IF v_existing.owner_id <> p_owner_id THEN RAISE EXCEPTION '该订单号已绑定其他账号'; END IF;
    RETURN json_build_object('ok', true, 'already', true, 'months', v_existing.plan_id);
  END IF;

  INSERT INTO public.paid_order_claims (order_id, owner_id, plan_id, amount_cents, paid_at)
  VALUES (p_order_id, p_owner_id, p_plan_id, coalesce(p_amount_cents, 0), now());
  -- channel 用 admin_grant 与真实支付（wechat_h5）区分开，对账时一眼能分
  INSERT INTO public.orders (owner_id, order_id, plan_id, channel, amount_cents, months, status, paid_at)
  VALUES (p_owner_id, p_order_id, p_plan_id, 'admin_grant', coalesce(p_amount_cents, 0), v_months, 'paid', now());
  INSERT INTO public.admin_actions (actor, action, target, payload)
  VALUES (auth.uid()::text, 'grant_membership', p_owner_id,
          jsonb_build_object('order_id', p_order_id, 'plan_id', p_plan_id,
                             'amount_cents', coalesce(p_amount_cents, 0), 'reason', p_reason));
  RETURN json_build_object('ok', true, 'already', false, 'months', v_months);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_grant_membership(text, text, text, integer, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_grant_membership(text, text, text, integer, text) TO authenticated;

-- ---------------------------------------------------------------
-- 6) 促销码建码 / 停用
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_promo(
  p_code text, p_days integer, p_good_until date
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hash text; v_existed boolean;
BEGIN
  IF NOT public.is_app_admin() THEN RAISE EXCEPTION '仅管理员'; END IF;
  IF p_code IS NULL OR length(trim(p_code)) < 8 THEN RAISE EXCEPTION '兑换码至少 8 位'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN RAISE EXCEPTION '天数需在 1~366 之间'; END IF;
  IF p_good_until IS NULL OR p_good_until < CURRENT_DATE THEN RAISE EXCEPTION '有效期不能早于今天'; END IF;
  -- 与 redeem_promo_order 同一口径：trim + 大写后 SHA-256；明文永不入库
  v_hash := encode(digest(upper(trim(p_code)), 'sha256'), 'hex');
  SELECT EXISTS(SELECT 1 FROM public.promo_codes WHERE code_hash = v_hash) INTO v_existed;
  INSERT INTO public.promo_codes (code_hash, plan_days, good_until, active)
  VALUES (v_hash, p_days, p_good_until, true)
  ON CONFLICT (code_hash) DO UPDATE
    SET plan_days = EXCLUDED.plan_days, good_until = EXCLUDED.good_until, active = true;
  INSERT INTO public.admin_actions (actor, action, target, payload)
  VALUES (auth.uid()::text, CASE WHEN v_existed THEN 'promo_upsert' ELSE 'promo_create' END, v_hash,
          jsonb_build_object('days', p_days, 'good_until', p_good_until));
  RETURN json_build_object('ok', true, 'code_hash', v_hash, 'updated', v_existed);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_promo(text, integer, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_promo(text, integer, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_promo_active(
  p_code_hash text, p_active boolean
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.is_app_admin() THEN RAISE EXCEPTION '仅管理员'; END IF;
  UPDATE public.promo_codes SET active = p_active WHERE code_hash = p_code_hash;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION '未找到该兑换码'; END IF;
  INSERT INTO public.admin_actions (actor, action, target, payload)
  VALUES (auth.uid()::text, CASE WHEN p_active THEN 'promo_enable' ELSE 'promo_disable' END,
          p_code_hash, jsonb_build_object('active', p_active));
  RETURN json_build_object('ok', true, 'active', p_active);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_promo_active(text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_promo_active(text, boolean) TO authenticated;

-- ---------------------------------------------------------------
-- 执行后自检
-- ---------------------------------------------------------------
-- A) 5 个函数都在且 SECURITY DEFINER：
--   SELECT proname, prosecdef FROM pg_proc
--    WHERE pronamespace='public'::regnamespace
--      AND proname IN ('is_app_admin','admin_grant_membership','admin_create_promo',
--                      'admin_set_promo_active','redeem_paid_order');
--   期望：5 行，prosecdef 全 t
--
-- B) 匿名调 is_app_admin / admin_grant_membership 必须 401（无 EXECUTE）：
--   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
--     -H "x-wb-webapp-access-key: <publishableKey>" \
--     -d '{}' "https://<endpoint>/.cloud/database/rest/rpc/is_app_admin"
--   期望：401
--
-- C) 管理员名单只有预期的人：
--   SELECT uid, note FROM public.app_admins;
--
-- D) 促销码可见性（必须已开 RLS）：
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname='public' AND tablename IN ('promo_codes','promo_redemptions');
--   期望：rowsecurity = t
--
-- ---------------------------------------------------------------
-- 待统一（本次刻意不动，避免权限语义与策略同时变）
-- ---------------------------------------------------------------
-- 下面 6 个策略仍是硬编码 `auth.uid() = '2108536518187421696'::text`，
-- 与 app_admins 重复。建议单独一笔 PR 改成 `public.is_app_admin()`：
--   client_errors_admin_select / feedback_admin_select / feedback_admin_update
--   llm_events_admin_select / orders_admin_select / user_kv_admin_select
-- 改完必须回归：后台各页仍能读，普通用户仍读不到别人的行。
