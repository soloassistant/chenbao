// 变异用例：H5 支付网关（harness: .tools/verify-h5pay.mjs）
// 每个 from 都必须在目标文件里**正好出现一次**。
export default [
  {
    label: '未配置时也放行下单（会返回假支付地址 / 伪造成功）',
    file: 'server/pay-gateway/index.mjs',
    from: `    if (!isConfigured()) {
      return send(res, 503, { error: 'unconfigured', message: '支付通道未配置（缺 XUNHUPAY_APPID / XUNHUPAY_APPSECRET）' });
    }`,
    to: `    if (false && !isConfigured()) {
      return send(res, 503, { error: 'unconfigured', message: '支付通道未配置（缺 XUNHUPAY_APPID / XUNHUPAY_APPSECRET）' });
    }`,
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '签名不排序（与聚合支付口径不一致 ⇒ 线上必然验签失败）',
    file: 'server/pay-gateway/index.mjs',
    from: '    .sort();',
    to: '    .reverse();',
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '信任前端传来的金额（1 分钱买年付）',
    file: 'server/pay-gateway/index.mjs',
    from: '      priceFen: plan.priceFen,',
    to: '      priceFen: Number(body.price) || plan.priceFen,',
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '查单失败谎报 closed（用户已付款却被说成没付）',
    file: 'src/services/h5Pay.ts',
    from: "    return { state: 'gateway-error', status: 'unknown', detail: String((err as Error)?.message || err) };",
    to: "    return { state: 'gateway-error', status: 'closed', detail: String((err as Error)?.message || err) };",
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    // 权益闭环的四条反向证明：任一条被删，权益就可能被伪造或重复发放
    label: '验签密钥缺失时也放行（没配密钥 = 谁都开得了会员）',
    file: '.tools/sql/v9-h5-paid-orders.sql',
    from: "  IF v_secret IS NULL OR length(v_secret) < 32 THEN\n    RAISE EXCEPTION '服务端未配置支付验签密钥';\n  END IF;",
    to: "  IF false THEN\n    RAISE EXCEPTION '服务端未配置支付验签密钥';\n  END IF;",
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '去掉归属校验（拿到别人订单号就能用自己账号核销）',
    file: '.tools/sql/v9-h5-paid-orders.sql',
    from: "  IF p_owner_id IS NULL OR p_owner_id <> v_uid THEN\n    RAISE EXCEPTION '该支付凭证不属于当前账号';\n  END IF;",
    to: "  IF false THEN\n    RAISE EXCEPTION '该支付凭证不属于当前账号';\n  END IF;",
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '金额不再与套餐比对（1 分钱买年付）',
    file: '.tools/sql/v9-h5-paid-orders.sql',
    from: "  IF p_amount_cents IS DISTINCT FROM v_expect_cents THEN",
    to: "  IF false THEN",
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '核销表不再幂等（同订单可重复发权益）',
    file: '.tools/sql/v9-h5-paid-orders.sql',
    from: "  ON CONFLICT (order_id) DO NOTHING;",
    to: "  ON CONFLICT (order_id) DO UPDATE SET claimed_at = now();",
    cmd: 'node .tools/verify-h5pay.mjs'
  },
  {
    label: '网关对未付订单也签凭证（没付钱也能开会员）',
    file: 'server/pay-gateway/index.mjs',
    from: "    if (order.status !== 'paid') {\n      return send(res, 409, { error: 'not-paid', status: order.status });\n    }",
    to: "    if (false) {\n      return send(res, 409, { error: 'not-paid', status: order.status });\n    }",
    cmd: 'node .tools/verify-h5pay.mjs'
  }
];
