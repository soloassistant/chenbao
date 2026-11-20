import { useEffect } from 'react';
import { create } from 'zustand';
import Taro from '@tarojs/taro';

export interface ThemePreset {
  id: string;
  name: string;
  /** 主色（大场面视觉用，对白底不足 WCAG AA） */
  color: string;
  /** 浅底（页面头部/浅色容器） */
  soft: string;
  /** 深色（渐变终点/强调） */
  deep: string;
  /** 深色模式下的品牌文字色（对 #16130f 底 ≥4.5:1） */
  onDark: string;
  /** 深色模式下的实心品牌底（压白字 ≥4.5:1） */
  solid: string;
  /**
   * 同色系加深变体：用于「品牌色文字」与「白字品牌控件」。
   * 背景/大色块仍用 color（保留品牌识别），凡承载信息的小文字或
   * 白字控件一律用 strong —— 四个 color 对白底全部 <4.5。
   */
  strong: string;
}

/** 界面主题预设：切换后通过 CSS 变量 --brand* 应用到各页面 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'sunrise', name: '晨光橙', color: '#FF7A45', soft: '#FFF3EC', deep: '#E85D2A', strong: '#C7371A', onDark: '#FFB59A', solid: '#A82C13' },
  { id: 'ocean', name: '天空蓝', color: '#5B8DEF', soft: '#EEF3FE', deep: '#3A6FD8', strong: '#3560B8', onDark: '#A8C4FF', solid: '#2F5BB0' },
  { id: 'forest', name: '森林绿', color: '#00B42A', soft: '#E8FFEA', deep: '#008A20', strong: '#00751C', onDark: '#6BE38A', solid: '#006A17' },
  { id: 'sakura', name: '樱花粉', color: '#F5669C', soft: '#FEEEF5', deep: '#D14B80', strong: '#C03A6E', onDark: '#FFA8C8', solid: '#A32E5C' }
];

export const STORAGE_KEY = 'brand-theme';

interface ThemeState {
  theme: ThemePreset;
  setTheme: (id: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: THEME_PRESETS[0],
  setTheme: (id) => {
    const next = THEME_PRESETS.find((t) => t.id === id);
    if (!next) return;
    set({ theme: next });
    try {
      Taro.setStorageSync(STORAGE_KEY, id);
    } catch (err) {
      console.warn('[ThemeStore] persist failed:', err);
    }
  }
}));

// 模块加载时恢复本地选择
try {
  const saved = Taro.getStorageSync(STORAGE_KEY) as string;
  const local = THEME_PRESETS.find((t) => t.id === saved);
  if (local) useThemeStore.setState({ theme: local });
} catch (err) {
  console.warn('[ThemeStore] restore failed:', err);
}

/** 生成页面根节点的 CSS 变量样式（各页面根 View 使用） */
export function brandVars(theme: ThemePreset, resolved: ResolvedTheme = 'light'): React.CSSProperties {
  if (resolved === 'dark') {
    return {
      '--brand': theme.color,
      '--brand-soft': hexToRgba(theme.color, 0.18),
      '--brand-deep': theme.onDark,
      '--brand-strong': theme.onDark,
      '--dm-brand-strong': theme.onDark,
      '--dm-brand-solid': theme.solid
    } as React.CSSProperties;
  }
  return {
    '--brand': theme.color,
    '--brand-soft': theme.soft,
    '--brand-deep': theme.deep,
    '--brand-strong': theme.strong,
    '--dm-brand-strong': theme.strong
  } as React.CSSProperties;
}

function hexToRgba(hex: string, alpha: number): string {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ============================================
// 显示模式：跟随系统 / 浅色 / 深色（2026-11-20）
// ============================================
export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const MODE_STORAGE_KEY = 'theme-mode';

export function getSystemTheme(): ResolvedTheme {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  }
  try {
    const info = Taro.getSystemInfoSync();
    if (info.theme === 'dark') return 'dark';
    if (info.theme === 'light') return 'light';
  } catch (err) {
    console.warn('[ThemeMode] system theme unavailable:', err);
  }
  return 'light';
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? getSystemTheme() : mode;
}

function readStoredMode(): ThemeMode {
  try {
    const saved = Taro.getStorageSync(MODE_STORAGE_KEY) as string;
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
  } catch (err) {
    console.warn('[ThemeMode] restore failed:', err);
  }
  return 'system';
}

interface ThemeModeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  syncSystem: () => void;
}

const initialMode = readStoredMode();

export const useThemeModeStore = create<ThemeModeState>((set, get) => ({
  mode: initialMode,
  resolved: resolveMode(initialMode),
  setMode: (mode) => {
    set({ mode, resolved: resolveMode(mode) });
    try {
      Taro.setStorageSync(MODE_STORAGE_KEY, mode);
    } catch (err) {
      console.warn('[ThemeMode] persist failed:', err);
    }
  },
  syncSystem: () => {
    const next = resolveMode(get().mode);
    if (next !== get().resolved) set({ resolved: next });
  }
}));

/** 页面根节点用的类名：把 .theme-dark / .theme-light 挂上去，token 才会切换 */
export function themeModeClass(resolved: ResolvedTheme): string {
  return resolved === 'dark' ? 'theme-dark' : 'theme-light';
}

/** 读取当前显示模式，并在系统主题变化时同步；H5 同时把类名挂到 html/body 兜底 */
export function useThemeMode() {
  const mode = useThemeModeStore((s) => s.mode);
  const resolved = useThemeModeStore((s) => s.resolved);
  const setMode = useThemeModeStore((s) => s.setMode);

  useEffect(() => {
    const store = useThemeModeStore.getState();
    store.syncSystem();
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => useThemeModeStore.getState().syncSystem();
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
      }
      mq.addListener(onChange);
      return () => mq.removeListener(onChange);
    }
    type ThemeChangeApi = {
      onThemeChange?: (cb: (res: { theme: string }) => void) => void;
      offThemeChange?: (cb: (res: { theme: string }) => void) => void;
    };
    const api = Taro as unknown as ThemeChangeApi;
    const onChange = (res: { theme: string }) => {
      if (useThemeModeStore.getState().mode === 'system') {
        useThemeModeStore.setState({ resolved: res.theme === 'dark' ? 'dark' : 'light' });
      }
    };
    api.onThemeChange?.(onChange);
    return () => api.offThemeChange?.(onChange);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('theme-dark', resolved === 'dark');
    root.classList.toggle('theme-light', resolved === 'light');
    root.style.colorScheme = resolved;
    if (document.body) {
      document.body.classList.toggle('theme-dark', resolved === 'dark');
      document.body.classList.toggle('theme-light', resolved === 'light');
    }
  }, [resolved]);

  return { mode, resolved, setMode };
}
