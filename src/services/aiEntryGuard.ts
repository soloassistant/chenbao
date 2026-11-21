/**
 * 所有「非助手」AI 入口的统一闸门（2026-11-19）。
 *
 * 背景：出题 / 错题讲解直接调 cloudLlmChat，绕过了助手里那套
 * 「内容检查 → 额度检查 → 调用 → 一次记账」的流程。结果用户的额度、
 * 后台统计与实际模型调用三者口径不一致。
 *
 * 这里只收口**调用前后**的纪律；真正的模型请求仍由 cloudLlmChat 发出，
 * 它自己写一条 llm_events。因此 afterAiCall 只补本地镜像，不再写第二条云端记录。
 */
import { screenContent } from '@/utils/contentSafety';
import { bumpLocalUsage, canChat, getAiQuota } from './aiQuota';

export type GuardOutcome = { ok: true } | { ok: false; reason: string };

/** 调用模型前：先内容检查，再额度闸门。任何一个不过都不许发出请求。 */
export async function guardAiEntry(userContent: string): Promise<GuardOutcome> {
  if (!screenContent(userContent).ok) return { ok: false, reason: 'unsafe' };
  const quota = await getAiQuota();
  if (!canChat(quota)) return { ok: false, reason: 'quota' };
  return { ok: true };
}

/** 调用成功后：检查输出内容 + 补本地额度镜像（云端已由 cloudLlmChat 记过，绝不重复记）。 */
export function finishAiEntry(raw: string): GuardOutcome {
  if (!screenContent(raw).ok) return { ok: false, reason: 'unsafe' };
  bumpLocalUsage();
  return { ok: true };
}
