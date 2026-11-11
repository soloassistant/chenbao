/**
 * pages/mockExamResult —— 模拟考试结果。
 *
 * 判分复用题库 gradeAnswer；答错的题**同时写入错题本**（与题库单题作答同一条链路），
 * 这样「模拟考 → 错题本 → 重做」是连着的。
 */
import { useEffect, useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import { appStorage } from '@/utils/appStorage';
import { loadMockExamSession, gradeMockExam, type MockExamSession, type MockExamResult } from '@/data/mockExam';
import { createQuestionBankProgress } from '@/data/questionBankProgress';
import { formatAnswerKey } from '@/utils/questionBankGrading';
import { LINGXI_ENTRY_URL } from '@/config/partners';
import { openExternalPage } from '@/utils/externalLink';
import { pressableProps } from '@/utils/a11y';
import styles from '@/pages/questionBank/shared.module.scss';

export default function MockExamResultPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [session, setSession] = useState<MockExamSession | null>(null);
  const [result, setResult] = useState<MockExamResult | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const s = loadMockExamSession(appStorage());
    if (!s) {
      setMissing(true);
      return;
    }
    setSession(s);
    const r = gradeMockExam(s.questions, s.responses, s.plan.scorePerQuestion);
    setResult(r);
    try {
      const progress = createQuestionBankProgress(appStorage());
      for (const d of r.details) progress.record(d.question.id, d.correct);
    } catch (err) {
      // 写不进错题本不该让整张成绩页失败 —— 如实留痕，其余照常展示
      console.error('[MockExam] progress write failed:', err);
    }
  }, []);

  const myAnswer = (response: unknown): string => {
    if (response === null || response === undefined) return t('mock.unanswered');
    if (typeof response === 'boolean') return response ? t('qb.true') : t('qb.false');
    if (Array.isArray(response)) return response.join(', ');
    return String(response);
  };

  const usedSec = useMemo(() => {
    if (!session || !session.finishedAt) return 0;
    return Math.max(0, Math.round((session.finishedAt - session.startedAt) / 1000));
  }, [session]);

  const back = () => {
    Taro.reLaunch({ url: '/pages/questionBank/index' });
  };

  const goLingxi = async () => {
    const res = await openExternalPage(LINGXI_ENTRY_URL);
    if (res === 'copied') Taro.showToast({ title: t('qb.lingxiCopied'), icon: 'none', duration: 2500 });
    if (res === 'failed') Taro.showToast({ title: t('qb.lingxiFailed'), icon: 'none' });
  };

  if (missing || !session || !result) {
    return (
      <View className={styles.page} style={brandVars(theme)}>
        <View className={styles.state}>
          <Text className={styles.stateIcon}>📄</Text>
          <Text className={styles.stateTitle}>{t('mock.resultMissing')}</Text>
          <View className={styles.retry} onClick={back} {...pressableProps(t('mock.backToBank'))}>
            <Text className={styles.retryText}>{t('mock.backToBank')}</Text>
          </View>
        </View>
      </View>
    );
  }

  const mm = String(Math.floor(usedSec / 60)).padStart(2, '0');
  const ss = String(usedSec % 60).padStart(2, '0');

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={back} {...pressableProps(t('mock.backToBank'))}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('mock.backToBank')}</Text>
        </View>
        <Text className={styles.title}>{t('mock.resultTitle')}</Text>
      </View>

      <View className={styles.result}>
        <Text className={result.pass ? styles.resultGood : styles.resultBad}>
          {t(result.pass ? 'mock.pass' : 'mock.fail')}
        </Text>
        <Text className={styles.countValue}>
          {result.score} / {result.totalScore}
        </Text>
        <View className={styles.counts}>
          <View className={styles.countItem}>
            <Text className={styles.countValue}>{result.correctCount}/{result.total}</Text>
            <Text className={styles.countLabel}>{t('mock.correct')}</Text>
          </View>
          <View className={styles.countItem}>
            <Text className={styles.countValue}>
              {mm}:{ss}
            </Text>
            <Text className={styles.countLabel}>{t('mock.used')}</Text>
          </View>
          <View className={styles.countItem}>
            <Text className={styles.countValue}>{session.plan.passScore}</Text>
            <Text className={styles.countLabel}>{t('mock.passLine')}</Text>
          </View>
        </View>
      </View>

      <Text className={styles.stateDesc}>{session.plan.title}</Text>
      <Text className={styles.stateDesc}>{session.plan.sourceNote}</Text>

      {/* 逐题明细 */}
      {result.details.map((d, i) => (
        <View key={d.question.id} className={styles.card}>
          <View className={styles.meta}>
            <Text className={styles.badge}>{t('mock.qno', { n: i + 1, total: result.total })}</Text>
            <Text className={styles.badge}>{d.question.subject}</Text>
            <Text className={d.correct ? styles.resultGood : styles.resultBad}>
              {t(d.correct ? 'qb.correct' : 'qb.wrong')}
            </Text>
          </View>
          <Text className={styles.stem}>{d.question.stem}</Text>
          <Text className={styles.detailRow}>
            {t('mock.mine')}：{myAnswer(d.response)} · {t('qb.answerKey')}：{formatAnswerKey(d.question)}
          </Text>
          {d.question.explanation ? (
            <>
              <Text className={styles.badge}>{t('qb.explanationTitle')}</Text>
              <Text className={styles.detailRow}>{d.question.explanation}</Text>
            </>
          ) : null}
        </View>
      ))}

      <View className={styles.lingxi} onClick={() => void goLingxi()} {...pressableProps(t('qb.lingxiCta'))}>
        <Text className={styles.lingxiTitle}>{t('mock.lingxiAfter')} →</Text>
        <Text className={styles.lingxiDesc}>{t('qb.lingxiHint')}</Text>
      </View>

      <View className={styles.actions}>
        <View className={styles.secondaryBtn} onClick={back} {...pressableProps(t('mock.backToBank'))}>
          <Text>{t('mock.backToBank')}</Text>
        </View>
      </View>
    </View>
  );
}
