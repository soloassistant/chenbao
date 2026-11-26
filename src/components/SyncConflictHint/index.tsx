import { useEffect, useState } from 'react';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import {
  dismissSyncOwnerNotice,
  dismissSyncSizeNotice,
  getSyncConflicts,
  getSyncDisabledState,
  getSyncOwnerNotice,
  getSyncSizeNotice,
  resolveSyncConflicts,
  retrySync,
  subscribeSyncConflicts,
  subscribeSyncDisabled,
  subscribeSyncOwnerNotice,
  subscribeSyncSizeNotice
} from '@/services/cloudSync';
import type { SyncDisabledState, SyncOwnerNotice, SyncSizeNotice } from '@/services/cloudSync';
import { useT } from '@/store/language';
import type { LangKey } from '@/store/language';
import type { SyncConflict } from '@/utils/syncConflict';
import styles from './index.module.scss';

/**
 * 同步冲突提示与裁决（2026-10-19，cloudSync 冲突检测的 UI 出口）。
 *
 * 何时出现：拉取时发现**远端较新、且本机该键有尚未推送的修改**（两台设备各自改过）。
 * 此前这一步是静默覆盖——本机未上传的修改直接消失，用户无从知晓。
 *
 * 为什么挂「我的」页：冲突是账号/数据范畴的事，与订阅、注销同一语境；
 * 且提示要一直挂到用户裁决（未裁决 = 该键同步暂停），放常驻入口最不容易漏。
 *
 * 无障碍：只渲染文本、不写 role/aria-*（Taro 的 View/Text 不透传未知属性，
 * 详见 components/Splash 的 nativeProps 说明），读屏可直接获取文本。
 */
/** 冲突按模块归类：45 个键平铺时用户不知道从哪下手，先按功能分组。
 *  映射只影响展示，不影响裁决语义（裁决仍是 per-key）。 */
function moduleOf(key: string): 'plan' | 'ledger' | 'shopping' | 'library' | 'learn' | 'settings' {
  if (/^(dailyPlanStore|calendar)/.test(key)) return 'plan';
  if (/^ledger/.test(key)) return 'ledger';
  if (/^shopping/.test(key)) return 'shopping';
  if (/^(collectionStore|browseHistory|news|hotspot)/.test(key)) return 'library';
  if (/^(learn|question|mock|paper)/.test(key)) return 'learn';
  return 'settings';
}

function SyncConflictHint() {
  const t = useT();
  const [conflicts, setConflicts] = useState<SyncConflict[]>(() => getSyncConflicts());
  const [ownerNotice, setOwnerNotice] = useState<SyncOwnerNotice | null>(() => getSyncOwnerNotice());
  const [sizeNotice, setSizeNotice] = useState<SyncSizeNotice | null>(() => getSyncSizeNotice());
  const [disabledState, setDisabledState] = useState<SyncDisabledState>(() => getSyncDisabledState());

  // subscribeSyncConflicts 订阅时立即回调一次当前快照，并返回取消订阅函数
  useEffect(() => subscribeSyncConflicts(setConflicts), []);
  // 换账号隔离提示：必须让用户看见（缺陷 B1 明确要求，不能静默）
  useEffect(() => subscribeSyncOwnerNotice(setOwnerNotice), []);
  // 单键超过 512KB 未同步：同样必须可见（缺陷 X5，云端会静默丢弃）
  useEffect(() => subscribeSyncSizeNotice(setSizeNotice), []);
  // 熔断（连续 5 次云端硬失败）：必须告诉用户「同步已暂停」，不能继续装作正常（缺陷 X6）
  useEffect(() => subscribeSyncDisabled(setDisabledState), []);

  if (conflicts.length === 0 && !ownerNotice && !sizeNotice && !disabledState.disabled) return null;

  const handleResolve = async (key: string, choice: 'local' | 'remote') => {
    try {
      await resolveSyncConflicts(choice, [key]);
      Taro.showToast({
        title: t(choice === 'local' ? 'syncConflict.toastLocal' : 'syncConflict.toastRemote'),
        icon: 'none'
      });
    } catch (err) {
      // 裁决失败不静默：用户点了按钮要有反馈，否则会以为已生效
      console.error('[SyncConflictHint] resolve failed:', err);
      Taro.showToast({ title: t('syncConflict.failed'), icon: 'none' });
    }
  };

  const grouped = conflicts.reduce<Record<string, SyncConflict[]>>((acc, c) => {
    const g = moduleOf(c.key);
    (acc[g] = acc[g] || []).push(c);
    return acc;
  }, {});

  const handleResolveAll = async () => {
    // 45 个键换设备时可能一次冒出十几条；逐条点不现实。
    // 「较新者为准」= 每条各自比 remoteTs/localTs，而不是一刀切用云端。
    const remoteKeys = conflicts.filter((c) => c.remoteTs >= c.localTs).map((c) => c.key);
    const localKeys = conflicts.filter((c) => c.remoteTs < c.localTs).map((c) => c.key);
    try {
      if (remoteKeys.length) await resolveSyncConflicts('remote', remoteKeys);
      if (localKeys.length) await resolveSyncConflicts('local', localKeys);
      Taro.showToast({ title: t('syncConflict.toastAll'), icon: 'none' });
    } catch (err) {
      console.error('[SyncConflictHint] resolve all failed:', err);
      Taro.showToast({ title: t('syncConflict.failed'), icon: 'none' });
    }
  };

  return (
    <View className={styles.hint}>
      {ownerNotice && (
        <View className={styles.ownerNotice}>
          <Text className={styles.title}>{t('syncConflict.ownerTitle')}</Text>
          <Text className={styles.desc}>{t('syncConflict.ownerDesc', { from: ownerNotice.from })}</Text>
          <Text className={styles.ownerDismiss} onClick={dismissSyncOwnerNotice}>
            {t('syncConflict.ownerDismiss')}
          </Text>
        </View>
      )}
      {disabledState.disabled && (
        <View className={styles.ownerNotice}>
          <Text className={styles.title}>{t('syncConflict.disabledTitle')}</Text>
          <Text className={styles.desc}>{t('syncConflict.disabledDesc', { n: String(disabledState.failures) })}</Text>
          <Text
            className={styles.ownerDismiss}
            onClick={async () => {
              const ok = await retrySync();
              Taro.showToast({
                title: t(ok ? 'syncConflict.disabledRetryOk' : 'syncConflict.disabledRetryFail'),
                icon: 'none'
              });
            }}
          >
            {t('syncConflict.disabledRetry')}
          </Text>
        </View>
      )}
      {sizeNotice && (
        <View className={styles.ownerNotice}>
          <Text className={styles.title}>{t('syncConflict.sizeTitle', { n: String(sizeNotice.items.length) })}</Text>
          <Text className={styles.desc}>{t('syncConflict.sizeDesc')}</Text>
          <Text className={styles.ownerDismiss} onClick={dismissSyncSizeNotice}>
            {t('syncConflict.sizeDismiss')}
          </Text>
        </View>
      )}
      {conflicts.length > 0 && (
        <>
          <Text className={styles.title}>{t('syncConflict.title')}</Text>
          <Text className={styles.desc}>{t('syncConflict.desc')}</Text>
          <Text className={styles.action} onClick={() => void handleResolveAll()}>
            {t('syncConflict.resolveAll')}
          </Text>
        </>
      )}
      {Object.entries(grouped).map(([group, list]) => (
        <View key={group}>
          <Text className={styles.group}>{t(`syncConflict.group.${group}` as LangKey)} · {list.length}</Text>
          {list.map((c) => (
        <View className={styles.item} key={c.key}>
          <Text className={styles.itemLabel}>{t(`sync.key.${c.key}` as LangKey)}</Text>
          <View className={styles.itemActions}>
            {/* 用 Text 而非 Button：flex 行内的 Button 受 taro-button-core 默认 width:100%
                影响会挤占兄弟元素（项目既有坑）；文本按钮与 mine 页 linkText 模式一致 */}
            <Text className={styles.action} onClick={() => void handleResolve(c.key, 'local')}>
              {t('syncConflict.keepLocal')}
            </Text>
            <Text className={styles.actionRemote} onClick={() => void handleResolve(c.key, 'remote')}>
              {t('syncConflict.takeRemote')}
            </Text>
          </View>
        </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export default SyncConflictHint
