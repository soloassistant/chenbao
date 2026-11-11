/**
 * 变异用例：云函数日志脱敏门禁（verify-openid-redaction）
 *
 * 为什么必须有：2026-11-11 合入 PR #57 时，脚本进了仓库却没人跑（PR 作者自己在
 * 描述里写了「该测试脚本未接入 verify:all」）。一条从没变红过的断言等于没写 ——
 * 本文件把「maskId 存在但没真正用上」「maskId 本身被改坏」这两类退化钉成红灯。
 *
 * 每条都必须让门禁变红，否则说明断言没有判别力。
 */
export default [
  {
    label: 'auth-douyin 的 maskId 被改成恒等函数（脱敏形同虚设）',
    file: 'cloudfunctions/auth-douyin/maskId.js',
    from: "  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);",
    to: '  return s;',
    cmd: 'node .tools/verify-openid-redaction.mjs'
  },
  {
    label: 'getBriefing 的 maskId 被改成恒等函数',
    file: 'cloudfunctions/getBriefing/maskId.js',
    from: "  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);",
    to: '  return s;',
    cmd: 'node .tools/verify-openid-redaction.mjs'
  },
  {
    label: 'queryOrder 的 maskId 被改成恒等函数',
    file: 'cloudfunctions/queryOrder/maskId.js',
    from: "  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);",
    to: '  return s;',
    cmd: 'node .tools/verify-openid-redaction.mjs'
  },
  {
    label: 'pay-callback 的 maskId 被改成恒等函数',
    file: 'cloudfunctions/pay-callback/maskId.js',
    from: "  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);",
    to: '  return s;',
    cmd: 'node .tools/verify-openid-redaction.mjs'
  },
  {
    label: 'getBriefing 的日志绕过 maskId 直接打 openid（接线被拆掉）',
    file: 'cloudfunctions/getBriefing/index.js',
    from:
      "      console.error('[getBriefing.scheduled] user failed:', maskId(user.openid), err && (err.errMsg || err.message));",
    to:
      "      console.error('[getBriefing.scheduled] user failed:', user.openid, err && (err.errMsg || err.message));",
    cmd: 'node .tools/verify-openid-redaction.mjs'
  }
];
