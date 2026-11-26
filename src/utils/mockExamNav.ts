/**
 * 启动模拟考试的导航工具。
 *
 * 为什么要单独抽出来：真题库现在出现在两个入口（题库页的「历年真题」tab、
 * 以及保留的独立页 pages/papers），两边都要能「按这套真题组卷」——
 * 跳转参数拼法必须一致，否则两处会拼出不同的 URL（口径分叉的老毛病）。
 */
import Taro from '@tarojs/taro';
import type { Board, ExamSystem, Level } from '@/types/questionBank';

export interface MockExamLaunch {
  /** 卷面标题，例如「Edexcel 数学 · 纯数 1」 */
  title: string;
  /** 真题模式：试卷 PDF 链接。带上它时 mockExam 不加载本地题库，直接按原卷计时开考。 */
  paperQp?: string;
  /** 真题模式：评分标准 PDF 链接（交卷后自评用）。 */
  paperMs?: string;
  /** 题库体系 */
  examSystem: ExamSystem;
  /** 题库里的学科 */
  subject: string;
  /** 考试局；真题/组卷入口已知时必须传，否则 A-Level 会被写成 other */
  board?: Board;
  /** 层级（as/a2/hl/…）；同上 */
  level?: Level;
  /** 该真题单元覆盖的考点 */
  tags: string[];
}

export function mockExamUrl(launch: MockExamLaunch): string {
  const q = (s: string) => encodeURIComponent(s);
  const base =
    `/pages/mockExam/index?examSystem=${q(launch.examSystem)}` +
    `&subject=${q(launch.subject)}` +
    `&tags=${q(launch.tags.join('|'))}` +
    `&title=${q(launch.title)}` +
    (launch.board ? `&board=${q(launch.board)}` : '') +
    (launch.level ? `&level=${q(launch.level)}` : '');
  // 真题模式的两个参数：没有就不拼，避免空串被当成"有 qp 但为空"
  const qp = launch.paperQp ? `&qp=${q(launch.paperQp)}` : '';
  const ms = launch.paperMs ? `&ms=${q(launch.paperMs)}` : '';
  return base + qp + ms;
}

/** 跳去考试页；失败要出声（静默失败＝用户以为点坏了） */
export function startMockExam(launch: MockExamLaunch, failMessage?: string): void {
  Taro.navigateTo({ url: mockExamUrl(launch) }).catch(() => {
    Taro.showToast({ title: failMessage || '', icon: 'none' });
  });
}
