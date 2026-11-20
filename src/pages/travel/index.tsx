import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Button, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useLanguageStore, useT } from '@/store/language';
import { pressableProps } from '@/utils/a11y';
import { TRAVEL_DESTINATIONS, type TravelInterest } from '@/data/travelDestinations';
import { buildItinerary, estimateBudget, itineraryToText, recommendDestinations } from '@/utils/travelPlan';
import { fetchTravelWeather, type TravelWeatherDay } from '@/services/travelWeather';
import { nextId, readPlan, writePlan } from '@/data/dailyPlan';
import styles from './index.module.scss';

const INTERESTS: TravelInterest[] = ['food', 'nature', 'culture', 'family', 'photo'];

/**
 * 旅行推荐 + 攻略（2026-11-20）。
 *
 * 定位：晨报的「周末去哪儿」延伸，不是 OTA。
 * 边界：推荐只按季节与兴趣排序；行程是规则模板；预算给区间中值；
 *      票价、营业时间、预约状态一律不写死，页面明确提示自行核对。
 */
export default function TravelPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const zh = lang === 'zh';
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [days, setDays] = useState(3);
  const [interests, setInterests] = useState<TravelInterest[]>(['nature', 'food']);
  const [selectedId, setSelectedId] = useState<string>('');
  const [weather, setWeather] = useState<TravelWeatherDay[] | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);

  const recs = useMemo(
    () => recommendDestinations(TRAVEL_DESTINATIONS, month, interests, 3),
    [month, interests]
  );
  const selected = recs.find((r) => r.dest.id === selectedId)?.dest || recs[0]?.dest;
  const plans = useMemo(() => (selected ? buildItinerary(selected, days) : []), [selected, days]);
  const budget = selected ? estimateBudget(selected, days) : null;

  useEffect(() => {
    if (!selected) return undefined;
    let alive = true;
    setWeatherLoading(true);
    setWeather(null);
    void fetchTravelWeather(selected.lat, selected.lon).then((data) => {
      if (!alive) return;
      setWeather(data);
      setWeatherLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [selected]);

  const toggleInterest = (i: TravelInterest) => {
    setInterests((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));
  };

  const handleBack = () => {
    const stack = Taro.getCurrentPages();
    if (stack.length > 1) Taro.navigateBack();
    else Taro.reLaunch({ url: '/pages/briefing/index' });
  };

  /** 把逐日行程写成全天日程（09:00 起，标题带目的地与天数）。 */
  const handleAddToCalendar = useCallback(() => {
    if (!selected || plans.length === 0) return;
    const plan = readPlan();
    const start = new Date();
    start.setHours(9, 0, 0, 0);
    for (const day of plans) {
      const d = new Date(start);
      d.setDate(start.getDate() + day.day - 1);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 09:00`;
      plan.events.push({
        id: nextId('evt'),
        title: `${t('travel.calendarPrefix')} ${zh ? selected.name : selected.nameEn} · D${day.day}`,
        startTime: iso,
        status: 'confirmed',
        source: 'travel',
        note: day.items.map((it) => `${zh ? it.slotZh : it.slotEn} ${zh ? it.textZh : it.textEn}`).join('；'),
        createTime: new Date().toISOString()
      });
    }
    writePlan(plan);
    Taro.showToast({ title: t('travel.addedToast', { n: plans.length }), icon: 'success' });
  }, [plans, selected, t]);

  const handleCopy = useCallback(() => {
    if (!selected) return;
    Taro.setClipboardData({ data: itineraryToText(selected, plans, lang) })
      .then(() => Taro.showToast({ title: t('travel.copied'), icon: 'none' }))
      .catch(() => Taro.showToast({ title: t('travel.copyFailed'), icon: 'none' }));
  }, [plans, selected, t]);

  return (
    <View className={styles.page}>
      <View className={styles.topbar}>
        <Text className={styles.back} onClick={handleBack} {...pressableProps(t('travel.back'))}>
          ‹ {t('travel.back')}
        </Text>
        <Text className={styles.title}>{t('travel.title')}</Text>
      </View>
      <Text className={styles.subtitle}>{t('travel.subtitle')}</Text>

      <View className={styles.section}>
        <Text className={styles.label}>{t('travel.month')}</Text>
        <ScrollView scrollX className={styles.chipScroll}>
          <View className={styles.chipRow}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <Text
                key={m}
                className={`${styles.chip} ${m === month ? styles.chipOn : ''}`}
                onClick={() => setMonth(m)}
                {...pressableProps(`${m}${t('travel.monthUnit')}`)}
              >
                {m}
                {t('travel.monthUnit')}
              </Text>
            ))}
          </View>
        </ScrollView>
      </View>

      <View className={styles.section}>
        <Text className={styles.label}>{t('travel.interest')}</Text>
        <View className={styles.chipRow}>
          {INTERESTS.map((i) => (
            <Text
              key={i}
              className={`${styles.chip} ${interests.includes(i) ? styles.chipOn : ''}`}
              onClick={() => toggleInterest(i)}
              {...pressableProps(t(`travel.interest.${i}`))}
            >
              {t(`travel.interest.${i}`)}
            </Text>
          ))}
        </View>
      </View>

      <View className={styles.section}>
        <Text className={styles.label}>{t('travel.days')}</Text>
        <View className={styles.chipRow}>
          {[2, 3, 4, 5].map((d) => (
            <Text
              key={d}
              className={`${styles.chip} ${d === days ? styles.chipOn : ''}`}
              onClick={() => setDays(d)}
              {...pressableProps(`${d}${t('travel.dayUnit')}`)}
            >
              {d}
              {t('travel.dayUnit')}
            </Text>
          ))}
        </View>
      </View>

      <View className={styles.section}>
        <Text className={styles.label}>{t('travel.recommend')}</Text>
        {recs.map((r) => (
          <View
            key={r.dest.id}
            className={`${styles.card} ${selected?.id === r.dest.id ? styles.cardOn : ''}`}
            onClick={() => setSelectedId(r.dest.id)}
            {...pressableProps(r.dest.name)}
          >
            <View className={styles.cardHead}>
              <Text className={styles.cardName}>{zh ? r.dest.name : r.dest.nameEn}</Text>
              <Text className={styles.cardRegion}>{zh ? r.dest.region : r.dest.regionEn}</Text>
              <Text className={styles.cardBudget}>¥{r.dest.budgetPerDay}{t('travel.perDay')}</Text>
            </View>
            <Text className={styles.cardReason}>{zh ? r.reasonZh : r.reasonEn}</Text>
          </View>
        ))}
      </View>

      {selected ? (
        <View className={styles.detail}>
          <View className={styles.detailHead}>
            <Text className={styles.detailTitle}>{zh ? selected.name : selected.nameEn}</Text>
            <Text className={styles.detailMeta}>
              {t('travel.bestMonths')}：{selected.bestMonths.map((m) => `${m}${t('travel.monthUnit')}`).join(' / ')}
            </Text>
          </View>

          <View className={styles.weatherRow}>
            {weatherLoading ? <Text className={styles.weatherText}>{t('travel.weatherLoading')}</Text> : null}
            {!weatherLoading && !weather ? (
              <Text className={styles.weatherText}>{t('travel.weatherUnavailable')}</Text>
            ) : null}
            {(weather || []).slice(0, days).map((w) => (
              <View key={w.date} className={styles.weatherCell}>
                <Text className={styles.weatherDate}>{w.date.slice(5)}</Text>
                <Text className={styles.weatherTemp}>{w.min}° ~ {w.max}°</Text>
              </View>
            ))}
          </View>

          {budget ? (
            <Text className={styles.budget}>
              {t('travel.budget', { perDay: budget.perDay, total: budget.total, days: budget.days })}
            </Text>
          ) : null}

          {plans.map((day) => (
            <View key={day.day} className={styles.dayCard}>
              <Text className={styles.dayTitle}>D{day.day} · {zh ? day.titleZh : day.titleEn}</Text>
              {day.items.map((it) => (
                <View key={`${day.day}-${it.slotZh}`} className={styles.dayItem}>
                  <Text className={styles.daySlot}>{zh ? it.slotZh : it.slotEn}</Text>
                  <Text className={styles.dayText}>{zh ? it.textZh : it.textEn}</Text>
                </View>
              ))}
            </View>
          ))}

          <Text className={styles.tip}>{t('travel.tip', { text: zh ? selected.tip : selected.tipEn })}</Text>
          <Text className={styles.disclaimer}>{t('travel.disclaimer')}</Text>

          <View className={styles.actions}>
            <Button className={styles.action} onClick={handleAddToCalendar}>
              {t('travel.addToCalendar')}
            </Button>
            <Button className={styles.actionGhost} onClick={handleCopy}>
              {t('travel.copy')}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}
