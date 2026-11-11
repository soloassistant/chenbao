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
  }
];
