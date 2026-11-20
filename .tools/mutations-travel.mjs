/**
 * mutations-travel.mjs —— 旅行推荐门禁的变异用例（2026-11-20）
 * 每条对应一种「页面看起来还在、但承诺已经消失」的退化。
 */
export default [
  {
    label: '删掉「规则生成、自行核对」声明（变成冒充实时攻略）',
    file: 'src/pages/travel/index.tsx',
    from: "<Text className={styles.disclaimer}>{t('travel.disclaimer')}</Text>",
    to: '',
    cmd: 'node .tools/verify-travel.mjs'
  },
  {
    label: '删掉路由注册（页面存在但进不去）',
    file: 'src/app.config.ts',
    from: "    'pages/travel/index', // 2026-11-20：旅行推荐 + 攻略\n",
    to: '',
    cmd: 'node .tools/verify-travel.mjs'
  }
];
