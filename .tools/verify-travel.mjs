#!/usr/bin/env node
/**
 * verify-travel.mjs —— 旅行推荐 / 攻略的行为门禁（2026-11-20）
 *
 * 守三件事：
 * 1. 推荐是**确定性**的：同一输入两次结果一致，不随机；
 * 2. 行程结构完整：天数对、首末日形状对、没有 undefined 文案；
 * 3. 诚实边界：预算按天乘、文案里带「自行核对」，不写票价。
 *
 * 纯逻辑用 esbuild 打包后真执行；接线用源码断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond === true) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
};

const bundled = await esbuild.build({
  stdin: {
    contents: `
      export * from '@/data/travelDestinations';
      export * from '@/utils/travelPlan';
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  alias: { '@': path.join(ROOT, 'src') }
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(mod, mod.exports, () => ({}));
const { TRAVEL_DESTINATIONS, recommendDestinations, buildItinerary, estimateBudget, itineraryToText } = mod.exports;

console.log('\n── 推荐 ──');
const a = recommendDestinations(TRAVEL_DESTINATIONS, 4, ['nature', 'food'], 3);
const b = recommendDestinations(TRAVEL_DESTINATIONS, 4, ['nature', 'food'], 3);
ok('返回 3 条', a.length === 3);
ok('同一输入两次结果一致（不随机）', JSON.stringify(a) === JSON.stringify(b));
ok('全部带推荐理由', a.every((r) => r.reasonZh && r.reasonEn));
ok('4 月的首位在最佳月份内', a[0].dest.bestMonths.includes(4));
ok('分数按降序', a.every((r, i) => i === 0 || a[i - 1].score >= r.score));

console.log('\n── 行程 ──');
const dest = a[0].dest;
const days = 3;
const plans = buildItinerary(dest, days);
ok('天数与输入一致', plans.length === days);
ok('首日 3 段（含抵达）', plans[0].items.length === 3 && plans[0].titleZh.includes('抵达'));
ok('末日 2 段（含返程）', plans[days - 1].items.length === 2 && plans[days - 1].titleZh.includes('返程'));
ok('每段都有中英文案且无 undefined', plans.every((p) => p.items.every((i) => i.textZh && i.textEn && !/undefined/.test(i.textZh + i.textEn))));
ok('天数上限 7', buildItinerary(dest, 99).length === 7);

console.log('\n── 预算与导出 ──');
const budget = estimateBudget(dest, 3);
ok('预算 = 日预算 × 天数', budget.total === dest.budgetPerDay * 3 && budget.days === 3);
const text = itineraryToText(dest, plans, 'zh');
ok('导出文本含 3 天与预算', text.includes('抵达与安顿') && text.includes('收尾与返程') && text.includes('预算参考'));
ok('导出文本带「自行核对」边界', text.includes('自行核对'));

console.log('\n── 接线 ──');
const appCfg = read('src/app.config.ts');
ok('路由已注册 pages/travel/index', appCfg.includes("'pages/travel/index'"));
const page = read('src/pages/travel/index.tsx');
ok('页面走真实天气服务', page.includes('fetchTravelWeather') && read('src/services/travelWeather.ts').includes('api.open-meteo.com'));
ok('页面有「加入日程」与「复制行程」', page.includes('travel.addToCalendar') && page.includes('travel.copy'));
ok('页面写明行程是规则生成', page.includes("t('travel.disclaimer')"));
ok('页面按当前语言渲染行程与复制文本', page.includes('zh ? day.titleZh : day.titleEn') && page.includes('itineraryToText(selected, plans, lang)'));
const zh = read('src/store/language.ts');
const en = read('src/store/language.en.ts');
const keys = ['travel.title', 'travel.subtitle', 'travel.recommend', 'travel.budget', 'travel.disclaimer', 'travel.addToCalendar'];
ok('关键文案中英齐全', keys.every((k) => zh.includes(`'${k}':`) && en.includes(`'${k}':`)));
const brief = read('src/pages/briefing/index.tsx');
ok('晨报页有旅行入口', brief.includes("'/pages/travel/index'"));

console.log(`\nPASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail === 0 ? 0 : 1);
