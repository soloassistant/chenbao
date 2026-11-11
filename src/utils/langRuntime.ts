/**
 * 当前界面语言的「读侧」单点 —— 给**纯工具函数**用。
 *
 * 为什么单独一个文件（2026-11-11）：
 *   `src/utils/date.ts` 里的日期格式化要按语言出文案（#73 / U-04），最初写成
 *   `useLanguageStore.getState().lang`。但那样一来纯工具就拖上了 Zustand + Taro + React
 *   整条链，后果立刻显形 —— 两个离线门禁（`verify:util` 的 esbuild 打包、
 *   `verify:interaction` 的 vm 沙箱）在加载 `date.ts` 时就崩了：
 *     · esbuild：打包 Taro 时炸在 `ENABLE_INNER_HTML` 这类编译期常量
 *     · vm：React 里读 `process` → `ReferenceError: process is not defined`
 *   门禁红并不是「日期算错了」，而是「工具被耦合进了运行时」。
 *
 * 约定：
 *   · 本文件**零依赖**（不许 import 任何东西），这样任何离线脚本都能安全打包它；
 *   · 写入只有 `setRuntimeLang`，唯一调用方是 `src/store/language.ts`；
 *   · 默认 `zh`，与 #73 之前「日期永远出中文」的行为一致 —— 语言未初始化时不会闪烁。
 */

export type RuntimeLang = 'zh' | 'en';

let current: RuntimeLang = 'zh';

/** 由语言 store 在「初始化 / 切换语言」时调用 */
export function setRuntimeLang(lang: RuntimeLang): void {
  current = lang;
}

/** 纯工具（date.ts 等）读当前语言是否英文 */
export function runtimeIsEn(): boolean {
  return current === 'en';
}
