-- ============================================================================
-- run-20261108-purge-and-privileges.sql
--
-- 手工执行的一次性脚本（**不进任何自动门禁、不参与 verify:* 断言**）。
-- 用途：把 v3-h5-purge.sql 与 v8-privilege-tighten.sql 包成**一个事务**，一次跑完，
--       任何一步失败整体回滚，不留下「函数收紧了但表权限没收」的半吊子状态。
--
-- 与两份版本文件的关系：**同一批变更的事务化包装**，不是替代品。
--   · 函数定义与执行权收口 —— 逐字取自 .tools/sql/v3-h5-purge.sql（main 当前版本）
--   · 三张表的 TRUNCATE/REFERENCES/TRIGGER 收回 —— 逐字取自 .tools/sql/v8-privilege-tighten.sql §A
--   ⚠️ 改 v3 或 v8 的任何一行，都必须同步改本文件；反之亦然。
--
-- 为什么这次必须显式收回函数权限：线上 public.purge_my_h5_data **当前不存在**
--   （GET /rpc/purge_my_h5_data → PGRST202），本次 CREATE OR REPLACE 实际是**新建**；
--   新建函数默认带 PUBLIC EXECUTE，不显式 REVOKE 就是匿名可调删数据通道。
--
-- 执行日期：________（执行时手填，YYYY-MM-DD HH:MM）
-- 执行人：________（service role，WorkBuddy「应用数据库」控制台）
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 第 0 段：执行前自检（事务内、任何 DDL 之前）
--   ① 三张表必须都在 public schema，缺一张就 RAISE EXCEPTION 中止
--      （**故意不用 IF NOT EXISTS 静默跳过**：表名写错时不能假装成功）
--   ② 三张表 count(*)，写入临时快照表，供 COMMIT 之后对比
--   ③ 打印 pg_proc.proacl（函数存在时）与三张表的 pg_class.relacl 原文
-- ──────────────────────────────────────────────────────────────────────────
BEGIN;

DROP TABLE IF EXISTS _purge_pre_counts;
CREATE TEMP TABLE _purge_pre_counts (tbl text PRIMARY KEY, n bigint);

DO $$
DECLARE
  missing_tables text;
  n_kv  bigint;
  n_fb  bigint;
  n_le  bigint;
  acl   text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO missing_tables
  FROM (VALUES ('user_kv'), ('feedback'), ('llm_events')) AS v(t)
  WHERE to_regclass('public.' || t) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION '执行前自检失败：public schema 缺少表 [%] —— 表名写错或 schema 不对，整笔中止', missing_tables;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.user_kv'    INTO n_kv;
  EXECUTE 'SELECT count(*) FROM public.feedback'   INTO n_fb;
  EXECUTE 'SELECT count(*) FROM public.llm_events' INTO n_le;

  INSERT INTO _purge_pre_counts (tbl, n) VALUES
    ('user_kv', n_kv), ('feedback', n_fb), ('llm_events', n_le);

  RAISE NOTICE '执行前 行数：user_kv=% / feedback=% / llm_events=%', n_kv, n_fb, n_le;

  IF to_regprocedure('public.purge_my_h5_data()') IS NULL THEN
    RAISE NOTICE '执行前 pg_proc：函数不存在（本次为新建，默认 ACL 会带 PUBLIC EXECUTE）';
  ELSE
    SELECT p.proacl::text INTO acl FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.purge_my_h5_data()');
    RAISE NOTICE '执行前 pg_proc.proacl = %', coalesce(acl, '(NULL：等同默认授权，PUBLIC 可执行)');
  END IF;

  SELECT c.relacl::text INTO acl FROM pg_class c WHERE c.oid = 'public.user_kv'::regclass;
  RAISE NOTICE '执行前 user_kv.relacl    = %', coalesce(acl, '(NULL：默认 ACL)');
  SELECT c.relacl::text INTO acl FROM pg_class c WHERE c.oid = 'public.feedback'::regclass;
  RAISE NOTICE '执行前 feedback.relacl   = %', coalesce(acl, '(NULL：默认 ACL)');
  SELECT c.relacl::text INTO acl FROM pg_class c WHERE c.oid = 'public.llm_events'::regclass;
  RAISE NOTICE '执行前 llm_events.relacl = %', coalesce(acl, '(NULL：默认 ACL)');
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 第 1 段：函数（逐字取自 v3-h5-purge.sql）
--   SECURITY DEFINER + 显式 search_path + 只删 auth.uid() 自己的行 + 返回三表计数
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_my_h5_data()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed_events    bigint := 0;
  removed_feedback  bigint := 0;
  removed_errors    bigint := 0;
BEGIN
  DELETE FROM llm_events    WHERE owner_id = auth.uid();
  GET DIAGNOSTICS removed_events = ROW_COUNT;

  DELETE FROM feedback      WHERE owner_id = auth.uid();
  GET DIAGNOSTICS removed_feedback = ROW_COUNT;

  DELETE FROM client_errors WHERE owner_id = auth.uid();
  GET DIAGNOSTICS removed_errors = ROW_COUNT;

  RETURN json_build_object(
    'purged', true,
    'llm_events', removed_events,
    'feedback', removed_feedback,
    'client_errors', removed_errors
  );
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 第 2 段：函数执行权收口（逐字取自 v3-h5-purge.sql；顺序不能反：先 REVOKE 再 GRANT）
--   三个主体一起收回：PUBLIC（默认授权来源）、anon（匿名角色）、authenticated（旧 ACL 里
--   可能存在的更宽授权），再按最小权限只授回 authenticated。
-- ──────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_my_h5_data() TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 第 3 段：三张表的非功能权限收回（逐字取自 v8-privilege-tighten.sql §A）
--   TRUNCATE 绕过 RLS、REFERENCES 可用外键试探行内容、TRIGGER 可挂越权副作用；
--   客户端只做行级读写，这三项都不 GRANT 回来。两个主体都要收回（顺序无关）。
-- ──────────────────────────────────────────────────────────────────────────
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.user_kv    FROM PUBLIC, authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.feedback   FROM PUBLIC, authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.llm_events FROM PUBLIC, authenticated;

COMMIT;

-- ──────────────────────────────────────────────────────────────────────────
-- 第 4 段：执行后自检（COMMIT 之后，只读；不改任何权限、不删任何行）
--   ① 再打一遍 pg_proc.proacl 与三张表 relacl 原文
--   ② 函数 ACL：authenticated 有 EXECUTE；anon 与 PUBLIC 都没有（PUBLIC 用 aclexplode 判，
--      因为 PUBLIC 在 aclitem 里是 grantee = 0，不是可传给 has_*_privilege 的角色名）
--   ③ 三张表：authenticated 不再持有 TRUNCATE / REFERENCES / TRIGGER
--   ④ 三张表行数与执行前快照**必须相等**
-- ⚠️ 本段抛出的 EXCEPTION **不会回滚已 COMMIT 的变更**，只会让自检失败可见；
--    看到红就停手，按 docs/执行说明 里的处置办法人工处理，不要重跑。
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  acl_text   text;
  fn_exists  boolean;
  can_exec   boolean;
  anon_exec  boolean;
  pub_exec   boolean;
  pre_n      bigint;
  now_n      bigint;
  bad        text := '';
BEGIN
  fn_exists := to_regprocedure('public.purge_my_h5_data()') IS NOT NULL;

  IF fn_exists THEN
    SELECT p.proacl::text INTO acl_text FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.purge_my_h5_data()');
    RAISE NOTICE '执行后 pg_proc.proacl = %', coalesce(acl_text, '(NULL)');

    SELECT EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = to_regprocedure('public.purge_my_h5_data()')
         AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) INTO pub_exec;
    SELECT has_function_privilege('authenticated', 'public.purge_my_h5_data()', 'EXECUTE') INTO can_exec;
    -- 角色 anon 在 PostgREST 安装里必然存在；万一平台没有该角色，也不能让自检因
    -- 「role does not exist」而误报——不存在的角色当然不可能持有 EXECUTE。
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      SELECT has_function_privilege('anon', 'public.purge_my_h5_data()', 'EXECUTE') INTO anon_exec;
    ELSE
      anon_exec := false;
      RAISE NOTICE '注意：本库没有 anon 角色，跳过 anon 的 EXECUTE 检查';
    END IF;

    IF NOT can_exec  THEN bad := bad || 'authenticated 没有 EXECUTE；'; END IF;
    IF anon_exec     THEN bad := bad || 'anon 仍可 EXECUTE；'; END IF;
    IF pub_exec      THEN bad := bad || 'PUBLIC 仍可 EXECUTE（aclitem grantee=0）；'; END IF;
  ELSE
    bad := bad || '函数不存在（第 1 段没生效？）；';
  END IF;

  SELECT c.relacl::text INTO acl_text FROM pg_class c WHERE c.oid = 'public.user_kv'::regclass;
  RAISE NOTICE '执行后 user_kv.relacl    = %', coalesce(acl_text, '(NULL)');
  SELECT c.relacl::text INTO acl_text FROM pg_class c WHERE c.oid = 'public.feedback'::regclass;
  RAISE NOTICE '执行后 feedback.relacl   = %', coalesce(acl_text, '(NULL)');
  SELECT c.relacl::text INTO acl_text FROM pg_class c WHERE c.oid = 'public.llm_events'::regclass;
  RAISE NOTICE '执行后 llm_events.relacl = %', coalesce(acl_text, '(NULL)');

  IF has_table_privilege('authenticated', 'public.user_kv', 'TRUNCATE') THEN
    bad := bad || 'user_kv 仍可 TRUNCATE；'; END IF;
  IF has_table_privilege('authenticated', 'public.user_kv', 'REFERENCES') THEN
    bad := bad || 'user_kv 仍可 REFERENCES；'; END IF;
  IF has_table_privilege('authenticated', 'public.user_kv', 'TRIGGER') THEN
    bad := bad || 'user_kv 仍可 TRIGGER；'; END IF;
  IF has_table_privilege('authenticated', 'public.feedback', 'TRUNCATE') THEN
    bad := bad || 'feedback 仍可 TRUNCATE；'; END IF;
  IF has_table_privilege('authenticated', 'public.feedback', 'REFERENCES') THEN
    bad := bad || 'feedback 仍可 REFERENCES；'; END IF;
  IF has_table_privilege('authenticated', 'public.feedback', 'TRIGGER') THEN
    bad := bad || 'feedback 仍可 TRIGGER；'; END IF;
  IF has_table_privilege('authenticated', 'public.llm_events', 'TRUNCATE') THEN
    bad := bad || 'llm_events 仍可 TRUNCATE；'; END IF;
  IF has_table_privilege('authenticated', 'public.llm_events', 'REFERENCES') THEN
    bad := bad || 'llm_events 仍可 REFERENCES；'; END IF;
  IF has_table_privilege('authenticated', 'public.llm_events', 'TRIGGER') THEN
    bad := bad || 'llm_events 仍可 TRIGGER；'; END IF;

  SELECT n INTO pre_n FROM _purge_pre_counts WHERE tbl = 'user_kv';
  EXECUTE 'SELECT count(*) FROM public.user_kv' INTO now_n;
  RAISE NOTICE '行数对比 user_kv    ：前=% 后=%', pre_n, now_n;
  IF now_n <> pre_n THEN bad := bad || format('user_kv 行数变化 %s → %s（数据出事了）；', pre_n, now_n); END IF;

  SELECT n INTO pre_n FROM _purge_pre_counts WHERE tbl = 'feedback';
  EXECUTE 'SELECT count(*) FROM public.feedback' INTO now_n;
  RAISE NOTICE '行数对比 feedback   ：前=% 后=%', pre_n, now_n;
  IF now_n <> pre_n THEN bad := bad || format('feedback 行数变化 %s → %s（数据出事了）；', pre_n, now_n); END IF;

  SELECT n INTO pre_n FROM _purge_pre_counts WHERE tbl = 'llm_events';
  EXECUTE 'SELECT count(*) FROM public.llm_events' INTO now_n;
  RAISE NOTICE '行数对比 llm_events ：前=% 后=%', pre_n, now_n;
  IF now_n <> pre_n THEN bad := bad || format('llm_events 行数变化 %s → %s（数据出事了）；', pre_n, now_n); END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION '执行后自检失败：% （变更已 COMMIT，本异常不会回滚；请按执行说明人工处理）', bad;
  END IF;

  RAISE NOTICE '执行后自检通过：函数权限已收紧、三表三项已收回、行数未变。';
END
$$;

DROP TABLE IF EXISTS _purge_pre_counts;

-- ──────────────────────────────────────────────────────────────────────────
-- 第 5 段：匿名验证（**在数据库控制台之外**执行，用 REST 直连；不要把 token 贴进日志）
--   curl -sS -i -X POST 'https://<你的应用数据库 REST 基址>/rpc/purge_my_h5_data' \
--     -H 'apikey: <publishable key>' \
--     -H 'Content-Type: application/json' \
--     --data '{}'
--
--   期望：HTTP 401（或 403），响应体 code = 42501（insufficient_privilege）。
--   ⚠️ 如果返回 200 / 有 purged 字段 —— **收紧没生效**，匿名仍能调删数据函数，
--      立刻停下并回到第 4 段看 proacl（不要继续发布）。
--   ⚠️ 如果返回 404 PGRST202 —— 函数没建成功，第 1 段被回滚了，重看第 0/1 段输出。
-- ──────────────────────────────────────────────────────────────────────────
