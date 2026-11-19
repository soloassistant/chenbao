/**
 * 新 AI 入口门禁的变异用例（2026-11-19）。
 * 每条都是审计里真实出现过的旧写法，必须被 verify:ai-entry 抓住。
 */
export default [
  {
    label: '出题元数据退回全局 a2（高考题被题库拒收）',
    file: 'src/services/paperGen.ts',
    from: '      level: meta.level,',
    to: "      level: 'a2',",
    cmd: 'node .tools/verify-ai-entry-audit.mjs'
  },
  {
    label: '新出题入口绕过额度闸门（不调用就发模型请求）',
    file: 'src/services/paperGen.ts',
    from: '  const guard = await guardAiEntry(prompt);',
    to: '  const guard = { ok: true };',
    cmd: 'node .tools/verify-ai-entry-audit.mjs'
  },
  {
    label: '真题链接退回直接 window.open',
    file: 'src/pages/mockExam/index.tsx',
    from: '      void openExternalPage(url).then((r) => {',
    to: "      window.open(url, '_blank'); void openExternalPage(url).then((r) => {",
    cmd: 'node .tools/verify-ai-entry-audit.mjs'
  },
  {
    label: '注销日志重新明文打印 OpenID',
    file: 'cloudfunctions/deleteAccount/index.js',
    from: '`[deleteAccount] openid=${maskId(OPENID)}',
    to: '`[deleteAccount] openid=${OPENID}',
    cmd: 'node .tools/verify-ai-entry-audit.mjs'
  }
];
