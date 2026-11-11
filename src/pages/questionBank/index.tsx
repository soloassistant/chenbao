/**
 * pages/questionBank —— 题库列表（接入批次 2/5）。
 *
 * 三态是**三种不同的现实**，不许合并：
 *   · loading：正在读本机题库；
 *   · error  ：读不出来（存储损坏 / 版本不支持）—— 给重试，**绝不渲染成「题库 0 题」**；
 *   · ready  ：读出来了；再分「题库为空」与「筛选没命中」两种空态。
 * 筛选走 `questionBankQuery`：学科始终与体系成对使用（闭集 key 不扁平化）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { appStorage } from '@/utils/appStorage';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import type { ExamSystem, Question } from '@/types/questionBank';
import { filterQuestions, examSystemsOf, loadQuestionBank, subjectsOf } from '@/data/questionBankQuery';
import { createQuestionBankRepo } from '@/data/questionBankRepo';
import { createQuestionBankProgress } from '@/data/questionBankProgress';
import { SEED_QUESTIONS } from '@/data/questionBankSeed';
import { LINGXI_ENTRY_URL } from '@/config/partners';
import { openExternalPage } from '@/utils/externalLink';
import { pressableProps } from '@/utils/a11y';
import PaperLibrary from '@/components/PaperLibrary';
import { startMockExam } from '@/utils/mockExamNav';
import styles from './shared.module.scss';

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; questions: Question[] };

const NO_QUESTIONS: Question[] = [];

export default function QuestionBankPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [system, setSystem] = useState<ExamSystem | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  // 题库 / 真题库 两个 tab：历年真题库已并入本页（原先是独立页 pages/papers）
  const [tab, setTab] = useState<'mine' | 'papers'>('mine');

  const load = useCallback(() => {
    setView({ status: 'loading' });
    // 读取是本地同步操作，但仍走一次事件循环：加载态是真实渲染出来的，不是装饰
    void Promise.resolve().then(() => {
      const result = loadQuestionBank(appStorage());
      if (result.status === 'error') {
        console.error('[QuestionBank] load failed:', result.code, result.message);
        setView({ status: 'error', message: result.message });
      } else {
        setView({ status: 'ready', questions: result.questions });
      }
    });
  }, []);
  useEffect(load, [load]);

  const questions = view.status === 'ready' ? view.questions : NO_QUESTIONS;
  const systems = useMemo(() => examSystemsOf(questions), [questions]);
  const subjects = useMemo(() => (system ? subjectsOf(questions, system) : []), [questions, system]);
  const filtered = useMemo(
    () => filterQuestions(questions, { examSystem: system, subject, keyword }),
    [questions, system, subject, keyword]
  );

  const handleBack = useCallback(() => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/briefing/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, []);

  const openQuestion = (q: Question) => {
    Taro.navigateTo({ url: `/pages/questionBankAnswer/index?id=${q.id}` }).catch((err) =>
      console.warn('[QuestionBank] navigate failed:', err)
    );
  };

  /** 载入内置示例题：逐题 add，已存在（同 id）跳过；失败只说失败，不假装成功 */
  const seed = () => {
    try {
      const repo = createQuestionBankRepo(appStorage());
      let added = 0;
      for (const q of SEED_QUESTIONS) {
        try {
          repo.add(q);
          added += 1;
        } catch {
          // 重复 id / 校验不过：跳过，不打断其余题目
        }
      }
      Taro.showToast({ title: t('qb.seedDone', { n: added }), icon: 'none' });
      load();
    } catch (err) {
      console.error('[QuestionBank] seed failed:', err);
      Taro.showToast({ title: t('qb.seedFailed'), icon: 'none' });
    }
  };

  /** 每日一题：优先错题 → 没做过的题 → 全库随机。读进度失败则退回全库随机并留痕 */
  const startPractice = () => {
    if (questions.length === 0) {
      Taro.showToast({ title: t('qb.practiceEmpty'), icon: 'none' });
      return;
    }
    let pool = questions;
    try {
      const progress = createQuestionBankProgress(appStorage());
      const wrong = progress.mistakes().map((e) => e.questionId);
      const wrongPick = questions.find((q) => q.id === wrong[0]);
      const answered = new Set(progress.list().map((e) => e.questionId));
      const unseen = questions.filter((q) => !answered.has(q.id));
      pool = wrongPick ? [wrongPick] : (unseen.length ? unseen : questions);
    } catch (err) {
      console.error('[QuestionBank] practice progress read failed:', err);
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    Taro.navigateTo({ url: `/pages/questionBankAnswer/index?id=${picked.id}` }).catch((err) =>
      console.warn('[QuestionBank] navigate failed:', err)
    );
  };

  const goLingxi = async () => {
    const res = await openExternalPage(LINGXI_ENTRY_URL);
    if (res === 'copied') Taro.showToast({ title: t('qb.lingxiCopied'), icon: 'none', duration: 2500 });
    if (res === 'failed') Taro.showToast({ title: t('qb.lingxiFailed'), icon: 'none' });
  };

  const changeSystem = (next: ExamSystem | null) => {
    setSystem(next);
    setSubject(null);
  };

  const renderBody = () => {
    if (view.status === 'loading') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateTitle}>{t('qb.loading')}</Text>
        </View>
      );
    }
    if (view.status === 'error') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>⚠️</Text>
          <Text className={styles.stateTitle}>{t('qb.loadFailed')}</Text>
          <Text className={styles.stateDesc}>{t('qb.loadFailedHint')}</Text>
          <View className={styles.retry} onClick={load}>
            <Text className={styles.retryText}>{t('qb.retry')}</Text>
          </View>
        </View>
      );
    }
    if (questions.length === 0) {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>📚</Text>
          <Text className={styles.stateTitle}>{t('qb.empty')}</Text>
          <Text className={styles.stateDesc}>{t('qb.emptyHint')}</Text>
          <View className={styles.primaryBtn} onClick={seed} {...pressableProps(t('qb.seedCta'))}>
            <Text className={styles.primaryText}>{t('qb.seedCta')}</Text>
          </View>
          <Text className={styles.stateNote}>{t('qb.seedNote')}</Text>
          <View className={styles.lingxi} onClick={() => void goLingxi()} {...pressableProps(t('qb.lingxiCta'))}>
            <Text className={styles.lingxiTitle}>{t('qb.lingxiCta')} →</Text>
            <Text className={styles.lingxiDesc}>{t('qb.lingxiHint')}</Text>
          </View>
        </View>
      );
    }
    if (filtered.length === 0) {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>🔍</Text>
          <Text className={styles.stateTitle}>{t('qb.noMatch')}</Text>
          <Text className={styles.stateDesc}>{t('qb.noMatchHint')}</Text>
        </View>
      );
    }
    return filtered.map((q) => (
      <View key={q.id} className={styles.card} onClick={() => openQuestion(q)}>
        <Text className={styles.stem} numberOfLines={2}>{q.stem}</Text>
        <View className={styles.meta}>
          <Text className={styles.badge}>{t(`qb.system.${q.examSystem}`)}</Text>
          <Text className={styles.badge}>{q.subject}</Text>
          <Text className={styles.badge}>{t('qb.difficulty', { n: q.difficulty })}</Text>
        </View>
      </View>
    ));
  };

  const headerLink = (url: string, label: string) => (
    <Text
      className={styles.headerAction}
      onClick={() => Taro.navigateTo({ url }).catch((err) => console.warn('[QuestionBank] navigate failed:', err))}
    >
      {label}
    </Text>
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={handleBack}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('qb.title')}</Text>
        <View className={styles.headerLinks}>
          {headerLink('/pages/questionBankImport/index', t('qb.openImport'))}
          {headerLink('/pages/questionBankMistakes/index', t('qb.openMistakes'))}
        </View>
      </View>

      {/* 题库 / 真题库：真题库并入本页，原独立页保留为薄壳（同一组件，不会分叉） */}
      <View className={styles.chips}>
        <Text
          className={tab === 'mine' ? `${styles.chip} ${styles.chipActive}` : styles.chip}
          onClick={() => setTab('mine')}
          {...pressableProps(t('qb.tabMine'))}
        >
          {t('qb.tabMine')}
        </Text>
        <Text
          className={tab === 'papers' ? `${styles.chip} ${styles.chipActive}` : styles.chip}
          onClick={() => setTab('papers')}
          {...pressableProps(t('qb.tabPapers'))}
        >
          {t('qb.tabPapers')}
        </Text>
      </View>

      {tab === 'mine' ? (
      <>
      <Input
        className={styles.search}
        value={keyword}
        placeholder={t('qb.searchPlaceholder')}
        onInput={(e) => setKeyword(e.detail.value)}
      />

      {questions.length > 0 ? (
        <View className={styles.practice} onClick={startPractice} {...pressableProps(t('qb.practiceCta'))}>
          <Text className={styles.practiceTitle}>{t('qb.practiceCta')} →</Text>
          <Text className={styles.practiceDesc}>{t('qb.practiceHint', { total: questions.length })}</Text>
        </View>
      ) : null}

      {systems.length > 0 ? (
        <View className={styles.chips}>
          <Text className={!system ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => changeSystem(null)}>
            {t('qb.allSystems')}
          </Text>
          {systems.map((s) => (
            <Text key={s} className={s === system ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => changeSystem(s)}>
              {t(`qb.system.${s}`)}
            </Text>
          ))}
        </View>
      ) : null}

      {system && subjects.length > 0 ? (
        <View className={styles.chips}>
          <Text className={!subject ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => setSubject(null)}>
            {t('qb.allSubjects')}
          </Text>
          {subjects.map((s) => (
            <Text key={s} className={s === subject ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => setSubject(s)}>
              {s}
            </Text>
          ))}
        </View>
      ) : null}

      {view.status === 'ready' && filtered.length > 0 ? (
        <Text className={styles.count}>{t('qb.count', { n: filtered.length })}</Text>
      ) : null}

      {renderBody()}
      </>
      ) : (
        <PaperLibrary
          showHeader={false}
          onStartMock={({ binding, title, tags }) =>
            startMockExam(
              { title, examSystem: binding.examSystem, subject: binding.subject, tags },
              t('mock.startFailed')
            )
          }
        />
      )}
    </View>
  );
}
