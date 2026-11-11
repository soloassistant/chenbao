/**
 * pages/mockExam —— 模拟考试。
 *
 * 卷面来源：历年真题库的**考卷结构**（考点范围），题目来自本地题库。
 * 卷面必须如实写清这一点 —— 用户看到「模拟卷」很容易理解成「原卷」，那是欺骗。
 *
 * 流程：组卷 → 计时作答 → 交卷 → 结果页判分（判据复用题库 gradeAnswer）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import { loadQuestionBank } from '@/data/questionBankQuery';
import { appStorage } from '@/utils/appStorage';
import { buildMockExam, saveMockExamSession, type MockExamPlan } from '@/data/mockExam';
import type { ExamSystem, Question } from '@/types/questionBank';
import type { UserResponse } from '@/utils/questionBankGrading';
import { pressableProps } from '@/utils/a11y';
import styles from '@/pages/questionBank/shared.module.scss';

function readParams(): Record<string, string> {
  const router = Taro.getCurrentInstance().router;
  return (router?.params || {}) as Record<string, string>;
}

export default function MockExamPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const params = readParams();
  const examSystem = (params.examSystem || 'alevel') as ExamSystem;
  const subject = decodeURIComponent(params.subject || '');
  const tagsKey = decodeURIComponent(params.tags || '');
  const tags = useMemo(() => tagsKey.split('|').filter(Boolean), [tagsKey]);
  const title = decodeURIComponent(params.title || '');

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errText, setErrText] = useState('');
  const [plan, setPlan] = useState<MockExamPlan | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [responses, setResponses] = useState<Record<string, UserResponse>>({});
  const [idx, setIdx] = useState(0);
  const [left, setLeft] = useState(0);

  const startedAt = useRef(Date.now());
  const finishing = useRef(false);
  const responsesRef = useRef<Record<string, UserResponse>>({});

  useEffect(() => {
    const res = loadQuestionBank(appStorage());
    if (res.status !== 'ok') {
      setErrText(res.status === 'error' ? res.message : t('mock.loadFailed'));
      setStatus('error');
      return;
    }
    const p = buildMockExam(res.questions, { title, examSystem, subject, tags });
    if (!p) {
      setErrText(t('mock.noQuestions'));
      setStatus('error');
      return;
    }
    const byId = new Map(res.questions.map((q) => [q.id, q]));
    const qs = p.questionIds.map((id) => byId.get(id)).filter(Boolean) as Question[];
    setPlan(p);
    setQuestions(qs);
    setLeft(p.durationMin * 60);
    setStatus('ready');
  }, [examSystem, subject, tags, tagsKey, title, t]);

  const finish = useCallback(() => {
    if (finishing.current || !plan) return;
    finishing.current = true;
    saveMockExamSession(appStorage(), {
      id: plan.id,
      title: plan.title,
      subtitle: plan.subtitle,
      plan,
      questions,
      responses: responsesRef.current,
      startedAt: startedAt.current,
      finishedAt: Date.now()
    });
    Taro.redirectTo({ url: `/pages/mockExamResult/index?id=${plan.id}` }).catch(() => {
      Taro.reLaunch({ url: '/pages/questionBank/index' });
    });
  }, [plan, questions]);

  // 计时：到点自动交卷（考试不能因为用户走神而永远挂着）
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => {
      setLeft((v) => {
        if (v <= 1) {
          clearInterval(timer);
          setTimeout(finish, 0);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status, finish]);

  const choose = (q: Question, v: UserResponse) => {
    responsesRef.current = { ...responsesRef.current, [q.id]: v };
    setResponses(responsesRef.current);
  };

  const back = useCallback(() => {
    Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/questionBank/index' }));
  }, []);

  if (status === 'loading') {
    return (
      <View className={styles.page} style={brandVars(theme)}>
        <View className={styles.state}>
          <Text className={styles.stateTitle}>{t('mock.loading')}</Text>
        </View>
      </View>
    );
  }

  if (status === 'error' || !plan || !questions.length) {
    return (
      <View className={styles.page} style={brandVars(theme)}>
        <View className={styles.header}>
          <View className={styles.back} onClick={back} {...pressableProps(t('common.back'))}>
            <Text className={styles.backIcon}>‹</Text>
            <Text className={styles.backText}>{t('common.back')}</Text>
          </View>
          <Text className={styles.title}>{t('mock.title')}</Text>
        </View>
        <View className={styles.state}>
          <Text className={styles.stateIcon}>📄</Text>
          <Text className={styles.stateTitle}>{t('mock.cannotStart')}</Text>
          <Text className={styles.stateDesc}>{errText}</Text>
          <View className={styles.retry} onClick={back} {...pressableProps(t('common.back'))}>
            <Text className={styles.retryText}>{t('common.back')}</Text>
          </View>
        </View>
      </View>
    );
  }

  const current = questions[idx];
  const answered = Object.keys(responses).length;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={back} {...pressableProps(t('common.back'))}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('mock.title')}</Text>
        <Text className={styles.headerAction} data-contrast-ignore={undefined}>
          {mm}:{ss}
        </Text>
      </View>

      <Text className={styles.stateDesc}>{plan.title}</Text>

      <View className={styles.progressTrack}>
        <View className={styles.progressBar} style={{ width: `${((idx + 1) / questions.length) * 100}%` }} />
      </View>
      <Text className={styles.count}>
        {t('mock.progress', { done: answered, total: questions.length })}
      </Text>

      {/* 卷面信息：题量 / 时长 / 及格线 / 覆盖考点 —— 也要如实说明题目来源 */}
      <View className={styles.card}>
        <View className={styles.meta}>
          <Text className={styles.badge}>{t('mock.minutes', { n: plan.durationMin })}</Text>
          <Text className={styles.badge}>{t('mock.passMark', { n: plan.passScore })}</Text>
          <Text className={styles.badge}>{t('mock.totalScore', { n: plan.totalScore })}</Text>
        </View>
        <Text className={styles.stateDesc}>{t('mock.coverage', {
          tags: plan.coverage.filter((c) => c.count > 0).map((c) => c.tag).join('、') || '—'
        })}</Text>
        <Text className={styles.stateDesc}>{plan.sourceNote}</Text>
        {plan.shortage > 0 ? (
          <Text className={styles.stateDesc}>
            {t('mock.shortage', { n: plan.shortage, total: plan.targetCount })}
          </Text>
        ) : null}
      </View>

      {/* 当前题 */}
      <View className={styles.card}>
        <View className={styles.meta}>
          <Text className={styles.badge}>
            {t('mock.qno', { n: idx + 1, total: questions.length })}
          </Text>
          <Text className={styles.badge}>{current.subject}</Text>
          <Text className={styles.badge}>{t('qb.difficulty', { n: current.difficulty })}</Text>
        </View>
        <Text className={styles.questionStem}>{current.stem}</Text>

        {current.type === 'judge' ? (
          <View className={styles.judgeRow}>
            {[true, false].map((v) => (
              <Text
                key={String(v)}
                className={responses[current.id] === v ? `${styles.judgeBtn} ${styles.optionActive}` : styles.judgeBtn}
                onClick={() => choose(current, v)}
                {...pressableProps(t(v ? 'qb.true' : 'qb.false'))}
              >
                {t(v ? 'qb.true' : 'qb.false')}
              </Text>
            ))}
          </View>
        ) : (
          current.options.map((o) => {
            const active = responses[current.id] === o.key;
            return (
              <View
                key={o.key}
                className={classnames(styles.option, active && styles.optionActive)}
                onClick={() => choose(current, o.key)}
                {...pressableProps(`${o.key}. ${o.text}`)}
              >
                <Text className={styles.optionKey}>{o.key}</Text>
                <Text className={styles.optionText}>{o.text}</Text>
              </View>
            );
          })
        )}
      </View>

      <View className={styles.actions}>
        <View
          className={styles.secondaryBtn}
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          {...pressableProps(t('mock.prev'))}
        >
          <Text>{t('mock.prev')}</Text>
        </View>
        {idx < questions.length - 1 ? (
          <View
            className={styles.primaryBtn}
            onClick={() => setIdx((i) => Math.min(questions.length - 1, i + 1))}
            {...pressableProps(t('mock.next'))}
          >
            <Text className={styles.primaryText}>{t('mock.next')}</Text>
          </View>
        ) : (
          <View className={styles.primaryBtn} onClick={finish} {...pressableProps(t('mock.submit'))}>
            <Text className={styles.primaryText}>{t('mock.submit')}</Text>
          </View>
        )}
      </View>
    </View>
  );
}
