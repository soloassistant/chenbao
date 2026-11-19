import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useCallback } from 'react';
import { useT } from '@/store/language';
import styles from './index.module.scss';

/**
 * 二级页返回条（2026-11-19）。
 *
 * 背景：H5 的 TabRouter 不渲染原生导航栏，会员 / 偏好 / 报告 / AI 助手四个
 * 二级页没有返回入口，用户只能靠浏览器后退 —— 原生 App 与小程序都有系统返回，
 * 只有 H5 会走进死路（UI 审查项 ④）。
 *
 * 形态与 pages/search 的返回键一致：‹ + 「返回」，右侧不占位。
 * 行为：优先 navigateBack（保留来源页状态），栈里只剩本页时兜底 reLaunch 回晨报。
 * 仅 H5 渲染：weapp 有原生导航栏，再放一条会重复。
 */
export default function SubPageHeader() {
  const t = useT();

  const handleBack = useCallback(() => {
    Taro.navigateBack().catch(() => {
      Taro.reLaunch({ url: '/pages/briefing/index' }).catch(() => {});
    });
  }, []);

  if (process.env.TARO_ENV !== 'h5') return null;

  return (
    <View className={styles.bar} onClick={handleBack}>
      <Text className={styles.icon}>‹</Text>
      <Text className={styles.text}>{t('common.back')}</Text>
    </View>
  );
}
