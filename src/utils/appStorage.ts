/**
 * 应用存储适配器（题库链路专用）。
 *
 * 为什么不直接用 `Taro.getStorageSync`：本仓的 H5 构建里存在**两份 Taro 实例**，
 * 页面 chunk 里拿到的那份不带存储 API（`getStorageSync is not a function`），
 * 而 app 入口那份是好的。题库页原先直接把 `Taro` 当 storage 传进仓储层，
 * 于是每次打开都报「题库读取失败」——2026-11-11 实测复现。
 *
 * 这里按能力探测，而不是按端写死分支：
 *   1. 当前 Taro 有 getStorageSync/setStorageSync → 直接用（小程序端走这条）；
 *   2. 没有但运行在浏览器里 → 直接读写 localStorage，**信封格式与 Taro H5 一致**
 *      （写入 `JSON.stringify({ data })`，读取取回 `data`，缺键返回 `''`），
 *      因此和 app 其他模块写的数据可以互相读；
 *   3. 两者都没有 → 抛明确错误，不静默降级成内存存储（那会让题库"看起来能用"，
 *      刷新后全丢）。
 */
import Taro from '@tarojs/taro';
import type { QuestionBankStorage } from '@/data/questionBankRepo';

/** Taro 读不到键时返回空串（不是 undefined），仓储层依赖这个语义 */
const MISSING = '';

function taroAdapter(): QuestionBankStorage | null {
  const t = Taro as unknown as Partial<QuestionBankStorage>;
  if (typeof t.getStorageSync !== 'function' || typeof t.setStorageSync !== 'function') return null;
  return {
    getStorageSync: (key: string) => t.getStorageSync!(key),
    setStorageSync: (key: string, value: unknown) => t.setStorageSync!(key, value)
  };
}

function localStorageAdapter(): QuestionBankStorage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return {
    getStorageSync(key: string) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return MISSING;
        const parsed = JSON.parse(raw);
        // 与 Taro H5 一致：磁盘上是 { data: 值 }，读出来是值本身
        return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
      } catch {
        // 存了非 JSON 的历史脏数据：交给上层按"读坏了"处理，不要吞成空库
        return MISSING;
      }
    },
    setStorageSync(key: string, value: unknown) {
      window.localStorage.setItem(key, JSON.stringify({ data: value }));
    }
  };
}

let cached: QuestionBankStorage | null = null;

/** 拿一个确定可用的存储实现；同一次运行内复用，避免反复探测。 */
export function appStorage(): QuestionBankStorage {
  if (cached) return cached;
  const adapter = taroAdapter() ?? localStorageAdapter();
  if (!adapter) {
    throw new Error('当前环境没有可用的本地存储（Taro 与 localStorage 均不可用）');
  }
  cached = adapter;
  return cached;
}

/** 仅测试用：重置缓存，便于验证不同环境下的分支选择。 */
export function __resetStorageCache(): void {
  cached = null;
}
