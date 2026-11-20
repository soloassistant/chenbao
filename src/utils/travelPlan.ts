/**
 * 旅行推荐与行程生成（纯逻辑，无 Taro / React 依赖，门禁可直接跑）。
 *
 * ★ 诚实边界（改之前先读）：
 *   1. 推荐依据只有三件事：**当月是否最佳季节、兴趣标签是否匹配、预算区间**。
 *      不假装读过点评、不假装知道实时人流。
 *   2. 行程是**规则生成**：景点按顺序轮转、每天两到三个点，不声称是「AI 定制」。
 *   3. 不含票价、营业时间、预约状态——这些每天都变，页面只提醒「需预约」。
 */

import type { TravelDestination, TravelInterest } from '../data/travelDestinations';

export interface TravelRecommendation {
  dest: TravelDestination;
  score: number;
  /** 为什么推荐它：页面直接显示，不让用户猜 */
  reasonZh: string;
  reasonEn: string;
}

export interface DayPlanItem {
  slotZh: string;
  slotEn: string;
  textZh: string;
  textEn: string;
}

export interface DayPlan {
  day: number;
  titleZh: string;
  titleEn: string;
  items: DayPlanItem[];
}

export interface TravelBudget {
  perDay: number;
  days: number;
  total: number;
}

/** 按月份 + 兴趣排序推荐。分数规则显式写死，便于门禁复算。 */
export function recommendDestinations(
  destinations: TravelDestination[],
  month: number,
  interests: TravelInterest[],
  limit = 3
): TravelRecommendation[] {
  const picked = new Set(interests);
  const scored = destinations.map((dest) => {
    const inSeason = dest.bestMonths.includes(month);
    const matched = dest.interests.filter((i) => picked.has(i)).length;
    // 季节不符不是一票否决：淡季也能去，只是不排在最前
    const score = (inSeason ? 3 : 0) + matched * 2;
    const seasonZh = inSeason ? `${month} 月正是当地好时节` : `${month} 月不是最旺季，人少一些`;
    const matchZh = matched > 0 ? `，符合你选的 ${matched} 个偏好` : '，作为不同方向的选择';
    const seasonEn = inSeason ? `Month ${month} is a good season there` : `Month ${month} is off-peak, with fewer crowds`;
    const matchEn = matched > 0 ? `, matching ${matched} of your interests` : ', offered as a different direction';
    return {
      dest,
      score,
      reasonZh: `${seasonZh}${matchZh}`,
      reasonEn: `${seasonEn}${matchEn}`
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同分按名字固定排序，保证同一输入每次结果一致（不做随机，否则「每次刷新都不一样」）
    return a.dest.id.localeCompare(b.dest.id);
  });
  return scored.slice(0, Math.max(1, limit));
}

/** 生成逐日行程：首日抵达 + 一个点，中间每天两个点，末日收尾 + 返程。 */
export function buildItinerary(dest: TravelDestination, days: number): DayPlan[] {
  const total = Math.min(7, Math.max(1, Math.floor(days) || 1));
  const spots = dest.highlights;
  const foods = dest.foods;
  const plans: DayPlan[] = [];
  let cursor = 0;
  const nextSpot = () => spots[cursor++ % spots.length];
  const nextFood = () => foods[cursor % foods.length];

  for (let day = 1; day <= total; day += 1) {
    const isFirst = day === 1;
    const isLast = day === total && total > 1;
    const items: DayPlanItem[] = [];

    if (isFirst) {
      items.push({
        slotZh: '上午',
        slotEn: 'Morning',
        textZh: '抵达、入住，先把行李放下',
        textEn: 'Arrive and check in—drop the bags first'
      });
      items.push({
        slotZh: '下午',
        slotEn: 'Afternoon',
        textZh: `${nextSpot()}，不赶行程，按体力走`,
        textEn: `${nextSpotEn(dest, cursor - 1)} at an easy pace`
      });
      items.push({
        slotZh: '晚上',
        slotEn: 'Evening',
        textZh: `附近吃${nextFood()}，早点休息`,
        textEn: `Try ${nextFoodEn(dest, cursor)} nearby, then rest early`
      });
    } else if (isLast) {
      items.push({
        slotZh: '上午',
        slotEn: 'Morning',
        textZh: `${nextSpot()}，留出拍照和闲逛的时间`,
        textEn: `${nextSpotEn(dest, cursor - 1)}—leave time for photos and wandering`
      });
      items.push({
        slotZh: '下午',
        slotEn: 'Afternoon',
        textZh: '回酒店取行李，按车次/航班时间返程',
        textEn: 'Pick up luggage and head back according to your train or flight'
      });
    } else {
      items.push({
        slotZh: '上午',
        slotEn: 'Morning',
        textZh: `${nextSpot()}（开门后一小时人最少）`,
        textEn: `${nextSpotEn(dest, cursor - 1)} (quietest in the first hour)`
      });
      items.push({
        slotZh: '下午',
        slotEn: 'Afternoon',
        textZh: `${nextSpot()}，中间找个茶馆或咖啡歇脚`,
        textEn: `${nextSpotEn(dest, cursor - 1)}, with a tea or coffee break`
      });
      items.push({
        slotZh: '晚上',
        slotEn: 'Evening',
        textZh: `晚饭吃${nextFood()}`,
        textEn: `Dinner: ${nextFoodEn(dest, cursor)}`
      });
    }

    plans.push({
      day,
      titleZh: isFirst ? '抵达与安顿' : isLast ? '收尾与返程' : `第 ${day} 天`,
      titleEn: isFirst ? 'Arrive and settle in' : isLast ? 'Wrap up and head home' : `Day ${day}`,
      items
    });
  }
  return plans;
}

function nextSpotEn(dest: TravelDestination, index: number): string {
  const i = ((index % dest.highlightsEn.length) + dest.highlightsEn.length) % dest.highlightsEn.length;
  return dest.highlightsEn[i];
}

function nextFoodEn(dest: TravelDestination, index: number): string {
  const i = ((index % dest.foodsEn.length) + dest.foodsEn.length) % dest.foodsEn.length;
  return dest.foodsEn[i];
}

export function estimateBudget(dest: TravelDestination, days: number): TravelBudget {
  const d = Math.min(7, Math.max(1, Math.floor(days) || 1));
  return { perDay: dest.budgetPerDay, days: d, total: dest.budgetPerDay * d };
}

/** 行程转成可复制的纯文本（分享用，不依赖页面组件）。 */
export function itineraryToText(dest: TravelDestination, plans: DayPlan[], lang: 'zh' | 'en'): string {
  const head = lang === 'en' ? `${dest.nameEn} · ${plans.length}-day plan` : `${dest.name} · ${plans.length} 天行程`;
  const lines = [head, ''];
  for (const plan of plans) {
    lines.push(lang === 'en' ? plan.titleEn : plan.titleZh);
    for (const item of plan.items) {
      const slot = lang === 'en' ? item.slotEn : item.slotZh;
      const text = lang === 'en' ? item.textEn : item.textZh;
      lines.push(`  ${slot}：${text}`);
    }
    lines.push('');
  }
  lines.push(lang === 'en' ? `Budget reference: about ¥${dest.budgetPerDay}/day per person` : `预算参考：人均约 ¥${dest.budgetPerDay}/天`);
  lines.push(lang === 'en' ? 'Generated from a fixed seasonal template—check opening hours and bookings yourself.' : '按季节模板生成，营业时间与预约请自行核对。');
  return lines.join('\n');
}
