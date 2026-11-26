/**
 * Chrome 可执行文件解析 —— 唯一口径（2026-11-24）
 *
 * 为什么收口：verify-routes / verify-inputs 各自硬编码了本机 Windows 路径，
 * 在 Linux CI runner 上必然找不到 → exit 2 → CI 步骤按 SKIP 放行，
 * 门禁「接进了 CI」却从来没真正跑过。同一扇门第三次各写各的解析，不能再犯。
 *
 * 查找顺序：
 *   1. CHROME_BIN（显式指定，CI 用它指向 /usr/bin/google-chrome）
 *   2. 平台常见安装路径
 *   3. 本机 .agent-browser / Playwright 缓存（版本号未知，按目录扫描）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function scanAgentBrowser() {
  // ~/.agent-browser/browsers/<chrome-版本>/chrome.exe —— 版本号会变，不能写死
  const base = path.join(os.homedir(), '.agent-browser', 'browsers');
  try {
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, isMac ? 'chrome-mac/Chromium.app/Contents/MacOS/Chromium' : 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* 没有就算了 */ }
  return null;
}

export function resolveChrome() {
  const env = process.env.CHROME_BIN;
  if (env && fs.existsSync(env)) return env;

  const candidates = isWin
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    : isMac
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  for (const p of candidates) if (p && fs.existsSync(p)) return p;

  const local = scanAgentBrowser();
  if (local) return local;

  if (!isWin && !isMac) {
    // Playwright 缓存：~/.cache/ms-playwright/chromium-<版本>/chrome-linux/chrome
    const base = path.join(os.homedir(), '.cache', 'ms-playwright');
    try {
      for (const dir of fs.readdirSync(base)) {
        const exe = path.join(base, dir, 'chrome-linux', 'chrome');
        if (fs.existsSync(exe)) return exe;
      }
    } catch { /* ignore */ }
  }
  return null;
}
