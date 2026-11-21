import { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Button } from '@tarojs/components';
import { useT, useLanguageStore } from '@/store/language';
import { saveConsent } from '@/data/legal-consent';
import { PRIVACY_TEXT, TERMS_TEXT, AI_SERVICES_TEXT } from '@/data/legal';
import styles from './index.module.scss';

const isH5 = process.env.TARO_ENV === 'h5';

interface ConsentGateProps {
  /** 用户点击「同意」后回调：由调用方写 storage 标记并关闭本层 */
  onAgree: () => void;
}

/**
 * H5 首启合规同意层（应用级）。
 *
 * 历史：原先只嵌在 briefing 页内（P0 缺陷：切到收件箱/热点/日历/我的 等其它 tab 或悬浮 AI 面板
 * 时同意层不挂载，等于「可绕过同意直接使用」）。现上移到 App 外壳，覆盖所有 tab 页与 AI 助理，
 * 未同意前整屏遮罩阻断一切交互（含 TabBar 与悬浮球，因遮罩 z 高于二者且全屏覆盖）。
 *
 * 仅在网页端启用：小程序端依赖微信平台隐私弹窗机制，不在此重复弹。
 */
export default function ConsentGate({ onAgree }: ConsentGateProps) {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const [declined, setDeclined] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 遮罩是全屏的，但 background 元素仍在 Tab 序列里：把焦点约束在面板内，
  // 初始落在第一个可操作项（不同意），避免键盘用户绕过同意直接激活遮罩后的页面。
  useEffect(() => {
    if (!isH5) return;
    const panel = panelRef.current;
    if (!panel) return;
    const list = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'taro-button-core, button, [tabindex]:not([tabindex="-1"]), input, textarea, a[href]'
        )
      ).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    const timer = window.setTimeout(() => list()[0]?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = list();
      if (!items.length) return;
      e.preventDefault();
      const cur = document.activeElement as HTMLElement | null;
      let i = cur ? items.indexOf(cur) : -1;
      if (i === -1) {
        items[e.shiftKey ? items.length - 1 : 0].focus();
        return;
      }
      i = e.shiftKey ? (i - 1 + items.length) % items.length : (i + 1) % items.length;
      items[i].focus();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!panel.contains(e.target as Node)) list()[0]?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);

  const handleAgree = () => {
    saveConsent();
    onAgree();
    // 遮罩关闭后焦点不能留在 body：等遮罩真正卸载，再回到当前页第一个可操作项
    const restoreFocus = (tries: number) => {
      if (document.querySelector('[class*="consentMask"]') && tries < 20) {
        window.setTimeout(() => restoreFocus(tries + 1), 30);
        return;
      }
      const page = document.querySelector('.taro_page_show') as HTMLElement | null;
      const first = page?.querySelector('[data-pressable]') as HTMLElement | null;
      if (first) {
        first.focus();
        if (document.activeElement !== document.body) return;
      }
      if (page) {
        page.setAttribute('tabindex', '-1');
        page.focus();
      }
    };
    window.setTimeout(() => restoreFocus(0), 30);
  };
  const handleDecline = () => setDeclined(true);

  if (!isH5) return null;

  return (
    <View className={styles.consentMask}>
      <View className={styles.consentPanel} ref={panelRef} role='dialog' aria-modal='true'>
        <Text className={styles.consentTitle}>{t('consent.title')}</Text>
        {declined ? (
          <View className={styles.consentDeclinedBox}>
            <Text className={styles.consentDeclinedText}>{t('consent.declinedBody')}</Text>
          </View>
        ) : (
          <ScrollView scrollY className={styles.consentBody}>
            {/* 法务原文只有中文版：英文界面下必须先声明「以中文版为准」 */}
            {lang === 'en' ? (
              <Text className={styles.consentText}>{`${t('legal.langNotice')}\n\n`}</Text>
            ) : null}
            <Text className={styles.consentText}>{PRIVACY_TEXT}</Text>
            <Text className={styles.consentText}>{'\n\n'}</Text>
            <Text className={styles.consentText}>{TERMS_TEXT}</Text>
            <Text className={styles.consentText}>{'\n\n'}</Text>
            <Text className={styles.consentText}>{AI_SERVICES_TEXT}</Text>
          </ScrollView>
        )}
        <Text className={styles.consentHint}>{t('consent.hint')}</Text>
        <View className={styles.consentActions}>
          <Button className={styles.consentDecline} onClick={handleDecline}>
            {t('consent.decline')}
          </Button>
          <Button className={styles.consentAgree} onClick={handleAgree}>
            {t('consent.agree')}
          </Button>
        </View>
      </View>
    </View>
  );
}
