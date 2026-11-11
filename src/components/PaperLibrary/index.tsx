/**
 * PaperLibrary —— 历年真题库主体（组件）。
 *
 * 为什么做成组件：真题库要「并入题库页」（同一个入口下两个 tab），
 * 同时保留原独立页（老链接不能死）。两份实现必然分叉 —— 这个仓库已经吃过一次
 * 「两处副本逐字一致」的亏（static-server 的旧副本），所以这里只留一份实现，
 * 两个页面都渲染它。样式也直接复用 pages/papers 的 module.scss，不复制第二份。
 *
 * 只做「索引 + 跳转原站」：试卷与评分标准都在第三方站点上，本组件不存副本、不解析题目。
 * 版权归各考试局（Pearson Edexcel / AQA / College Board / 中国教育在线），
 * 来源与版权说明必须保留 —— 这不是装饰，删了就等于把别人的卷子包装成自己的。
 */
import { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import { PAPER_BOARDS, PAPERS_SOURCE, groupUnits, totalPapers, type SessionRow } from '@/data/papers';
import { bindingForSubject, bindingForUnit, type PaperExamBinding } from '@/data/paperExamMap';
import { openExternalPage } from '@/utils/externalLink';
import { pressableProps } from '@/utils/a11y';
import styles from '@/pages/papers/index.module.scss';

/** 各来源的落地页：页脚「前往源站」按当前考试局走，避免把人送到不相干的站点 */
const BOARD_SOURCE: Record<string, string> = {
  edexcel: 'https://alevelclouds.com',
  aqa: 'https://alevelclouds.com',
  gaokao: 'https://gaokao.eol.cn/e_html/gk/gkst/',
  ap: 'https://apcentral.collegeboard.org/'
};

export interface PaperLibraryProps {
  /** 是否自带页头（并入题库页时由外层统一页头，这里不重复渲染） */
  showHeader?: boolean;
  /** 点「组模拟卷」时回调；不传则不显示该按钮 */
  onStartMock?: (payload: {
    binding: PaperExamBinding;
    /** 卷面标题，例如「Edexcel 数学 · 纯数 1」 */
    title: string;
    /** 该单元覆盖的考点（组卷用） */
    tags: string[];
  }) => void;
}

export default function PaperLibrary({ showHeader = true, onStartMock }: PaperLibraryProps) {
  const t = useT();
  const { theme } = useThemeStore();

  const [boardId, setBoardId] = useState(PAPER_BOARDS[0].id);
  const board = PAPER_BOARDS.find((b) => b.id === boardId) || PAPER_BOARDS[0];

  const [subjectId, setSubjectId] = useState(board.subjects[0].id);
  const subject = board.subjects.find((s) => s.id === subjectId) || board.subjects[0];

  const groups = useMemo(() => groupUnits(subject), [subject]);

  const [unitBase, setUnitBase] = useState(groups[0].base);
  // 换考试局/科目后旧单元可能不存在 —— 派生兜底，不用 effect 去「修正状态」
  const activeBase = groups.some((g) => g.base === unitBase) ? unitBase : groups[0].base;
  const active = groups.find((g) => g.base === activeBase) || groups[0];

  const yearGroups = useMemo(() => {
    const out: { year: number; rows: SessionRow[] }[] = [];
    for (const row of active.rows) {
      const last = out[out.length - 1];
      if (last && last.year === row.y) last.rows.push(row);
      else out.push({ year: row.y, rows: [row] });
    }
    return out;
  }, [active]);

  /** 当前选中单元能不能组卷 —— 没有显式考点映射的一律组不了 */
  const mockBinding = useMemo(
    () => bindingForUnit(board.id, subject.id, active.base) || bindingForSubject(board.id, subject.id),
    [board.id, subject.id, active.base]
  );

  const back = useCallback(() => {
    if (Taro.getCurrentPages().length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/learn/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/learn/index' });
  }, []);

  const open = useCallback(
    async (url: string) => {
      if (!url) return;
      const res = await openExternalPage(url);
      if (res === 'copied') {
        Taro.showToast({ title: t('papers.copiedHint'), icon: 'none', duration: 2500 });
      } else if (res === 'failed') {
        // 静默失败＝用户以为点坏了，必须出声音
        Taro.showToast({ title: t('papers.openFailed'), icon: 'none' });
      }
    },
    [t]
  );

  const pickBoard = (id: string) => {
    if (id === boardId) return;
    const next = PAPER_BOARDS.find((b) => b.id === id);
    if (!next) return;
    setBoardId(id);
    setSubjectId(next.subjects[0].id);
    const nextGroups = groupUnits(next.subjects[0]);
    setUnitBase(nextGroups[0].base);
  };

  const pickSubject = (id: string) => {
    if (id === subjectId) return;
    const next = board.subjects.find((s) => s.id === id);
    if (!next) return;
    setSubjectId(id);
    setUnitBase(groupUnits(next)[0].base);
  };

  const startMock = () => {
    if (!onStartMock || !mockBinding) return;
    onStartMock({
      binding: mockBinding,
      title: `${board.name} ${subject.name} · ${active.label || active.base}`,
      tags: mockBinding.tags
    });
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      {showHeader ? (
        <View className={styles.header}>
          <View className={styles.back} onClick={back} {...pressableProps(t('common.back'))}>
            <Text className={styles.backIcon}>‹</Text>
            <Text className={styles.backText}>{t('common.back')}</Text>
          </View>
          <Text className={styles.title}>{t('papers.title')}</Text>
          <Text className={styles.subtitle}>{t('papers.subtitle', { count: totalPapers() })}</Text>
        </View>
      ) : null}

      {/* 考试局 */}
      <View className={styles.tabRow}>
        {PAPER_BOARDS.map((b) => (
          <View
            key={b.id}
            className={classnames(styles.tab, b.id === board.id && styles.tabActive)}
            onClick={() => pickBoard(b.id)}
            {...pressableProps(`${t('papers.boardLabel')}：${b.name}`)}
          >
            <Text className={classnames(styles.tabText, b.id === board.id && styles.tabTextActive)}>
              {b.name}
            </Text>
          </View>
        ))}
      </View>

      {/* 科目 */}
      <View className={styles.tabRow}>
        {board.subjects.map((s) => (
          <View
            key={s.id}
            className={classnames(styles.tabSm, s.id === subject.id && styles.tabSmActive)}
            onClick={() => pickSubject(s.id)}
            {...pressableProps(`${t('papers.subjectLabel')}：${s.name}`)}
          >
            <Text className={classnames(styles.tabSmText, s.id === subject.id && styles.tabSmTextActive)}>
              {s.name}
            </Text>
          </View>
        ))}
        <Text className={styles.subjectMeta}>{t('papers.paperCount', { count: subject.qpCount })}</Text>
      </View>

      {/* 单元 */}
      <ScrollView className={styles.unitBar} scrollX enableFlex>
        <View className={styles.unitBarInner}>
          {groups.map((g) => (
            <View
              key={g.base}
              className={classnames(styles.unitChip, g.base === active.base && styles.unitChipActive)}
              onClick={() => setUnitBase(g.base)}
              {...pressableProps(`${t('papers.unitLabel')}：${g.base} ${g.label}`)}
            >
              <Text className={classnames(styles.unitCode, g.base === active.base && styles.unitCodeActive)}>
                {g.base}
              </Text>
              <Text className={classnames(styles.unitName, g.base === active.base && styles.unitNameActive)}>
                {g.label}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* 组模拟卷：没有显式考点映射的单元组不了 —— 直接说清，不给假入口 */}
      {onStartMock ? (
        <View className={styles.note}>
          {mockBinding ? (
            <View
              className={styles.noteLink}
              onClick={startMock}
              {...pressableProps(t('papers.mockStart'))}
            >
              <Text className={styles.noteLinkText}>{t('papers.mockStart')} →</Text>
            </View>
          ) : (
            <Text className={styles.noteText}>{t('papers.mockUnsupported')}</Text>
          )}
        </View>
      ) : null}

      {/* 考季列表 */}
      <View className={styles.list}>
        {yearGroups.map((yg) => (
          <View key={yg.year} className={styles.yearBlock}>
            <Text className={styles.yearTitle}>{t('papers.yearLabel', { year: yg.year })}</Text>
            {yg.rows.map((row) => (
              <View key={`${row.code}-${row.y}-${row.m}-${row.tag || ''}`} className={styles.row}>
                <View className={styles.rowLeft}>
                  <Text className={styles.rowDate}>{t('papers.sessionLabel', { m: row.m })}</Text>
                  {row.tag || row.variant ? (
                    <Text className={styles.variantTag}>{row.tag || row.code}</Text>
                  ) : null}
                </View>
                <View className={styles.rowActions}>
                  <View
                    className={classnames(styles.action, !row.qp && styles.actionDisabled)}
                    onClick={() => void open(row.qp)}
                    {...pressableProps(`${t('papers.qp')}：${row.code} ${row.y}-${row.m}`)}
                  >
                    <Text className={styles.actionText}>{t('papers.qp')}</Text>
                  </View>
                  <View
                    className={classnames(styles.actionGhost, !row.ms && styles.actionDisabled)}
                    onClick={() => void open(row.ms)}
                    {...pressableProps(`${t('papers.ms')}：${row.code} ${row.y}-${row.m}`)}
                  >
                    <Text className={styles.actionGhostText}>{t('papers.ms')}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        ))}
      </View>

      <View className={styles.note}>
        <Text className={styles.noteText}>{t('papers.sourceNote')}</Text>
        <View
          className={styles.noteLink}
          onClick={() => void open(BOARD_SOURCE[board.id] || PAPERS_SOURCE)}
          {...pressableProps(t('papers.sourceVisit'))}
        >
          <Text className={styles.noteLinkText}>{t('papers.sourceVisit')} ↗</Text>
        </View>
      </View>
    </View>
  );
}
