/**
 * 真题单元 → 题库考点的映射表。
 *
 * 为什么要这张表：历年真题库里存的是「考卷结构」（考试局 / 科目 / 单元 / 历年考季），
 * 而题库存的是「题目」（带考纲标签）。要「按真题出模拟卷」，就得先把
 * 「这套真题考的是哪些考点」翻译成「题库里哪些题对应这些考点」。
 *
 * ⚠️ 这张表是**人工维护的显式映射**，不是靠字符串猜的：
 *   · 标签没有语义的单元（例如 Edexcel 物理的 Unit 1~6，label 就叫 "Unit 1"）
 *     一律**不登记** —— 宁可说「这套卷组不了」，也不要抽一堆不相干的题凑一卷。
 *   · 每条登记的 tags 都必须在 SYLLABUS_TOPICS 的闭集里，否则抽出来的题
 *     无法通过题库的 syllabus 校验。
 *
 * 数据来源：各考试局公布的单元大纲名称（纯数/力学/微积分 AB…），
 * 与题库闭集里的考点名一一对齐。
 */
import type { ExamSystem } from '@/types/questionBank';

/** 一个真题单元的组卷坐标 */
export interface PaperExamBinding {
  /** 题库体系 */
  examSystem: ExamSystem;
  /** 题库里的学科名（必须在 SUBJECTS_BY_EXAM[examSystem] 里） */
  subject: string;
  /** 该真题单元覆盖的题库考点（必须在 SYLLABUS_TOPICS[`${examSystem}:${subject}`] 里） */
  tags: string[];
}

/** 坐标：${boardId}/${subjectId}/${unitBase} */
export const unitKey = (boardId: string, subjectId: string, unitBase: string) =>
  `${boardId}/${subjectId}/${unitBase}`;

/* ---- Edexcel 数学：纯数 / 进阶纯数 / 力学 / 决策 ---- */
const EDEXCEL_PURE_1 = [
  'algebra and functions',
  'coordinate geometry',
  'sequences and series',
  'differentiation',
  'integration',
  'trigonometry',
  'exponentials and logarithms',
  'proof'
];
const EDEXCEL_MECH = ['kinematics', 'forces and equilibrium'];

/* ---- AQA 数学：纯数 / 力学 / 统计 ---- */
const AQA_PURE_1 = EDEXCEL_PURE_1;

/* ---- AP：微积分 / 统计 / 物理 / 化学 / 生物 ---- */
const AP_CALCULUS = [
  'limits and continuity',
  'differentiation',
  'applications of derivatives',
  'integration',
  'fundamental theorem of calculus',
  'differential equations',
  'sequences and series',
  'parametric and polar curves',
  'vector-valued functions',
  'numerical approximations'
];

/**
 * 显式映射表。
 * ⚠️ 只登记「单元名能唯一确定考点范围」的条目 —— 见文件头说明。
 */
export const PAPER_EXAM_BINDINGS: Record<string, PaperExamBinding> = {
  /* ── Edexcel 数学 ── */
  'edexcel/maths/P1': { examSystem: 'alevel', subject: 'mathematics', tags: EDEXCEL_PURE_1 },
  'edexcel/maths/P2': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: [...EDEXCEL_PURE_1, 'vectors', 'probability and distributions']
  },
  'edexcel/maths/P3': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: [...EDEXCEL_PURE_1, 'vectors']
  },
  'edexcel/maths/F1': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: ['algebra and functions', 'proof', 'trigonometry', 'exponentials and logarithms']
  },
  'edexcel/maths/F2': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: ['algebra and functions', 'proof', 'trigonometry']
  },
  'edexcel/maths/F3': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: ['algebra and functions', 'sequences and series', 'trigonometry', 'integration']
  },
  'edexcel/maths/M1': { examSystem: 'alevel', subject: 'mathematics', tags: EDEXCEL_MECH },
  'edexcel/maths/M2': { examSystem: 'alevel', subject: 'mathematics', tags: EDEXCEL_MECH },
  'edexcel/maths/M3': { examSystem: 'alevel', subject: 'mathematics', tags: EDEXCEL_MECH },
  'edexcel/maths/D1': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: ['probability and distributions']
  },

  /* ── AQA 数学 ── */
  'aqa/maths/P1': { examSystem: 'alevel', subject: 'mathematics', tags: AQA_PURE_1 },
  'aqa/maths/P2': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: [...AQA_PURE_1, 'vectors', 'probability and distributions']
  },
  'aqa/maths/M2': { examSystem: 'alevel', subject: 'mathematics', tags: EDEXCEL_MECH },
  'aqa/maths/S2': {
    examSystem: 'alevel',
    subject: 'mathematics',
    tags: ['probability and distributions']
  },

  /* ── AP 数学与计算机 ── */
  'ap/math-cs/AB': { examSystem: 'ap', subject: 'calculus', tags: AP_CALCULUS },
  'ap/math-cs/BC': { examSystem: 'ap', subject: 'calculus', tags: AP_CALCULUS },
  'ap/math-cs/STAT': { examSystem: 'ap', subject: 'statistics', tags: [
    'describing data',
    'probability',
    'random variables',
    'sampling distributions',
    'confidence intervals',
    'significance tests',
    'regression',
    'experimental design'
  ] },
  'ap/math-cs/CSA': { examSystem: 'ap', subject: 'computer-science-a', tags: [
    'primitive types',
    'objects and classes',
    'arrays and arraylists',
    'recursion',
    'sorting and searching',
    'inheritance'
  ] },

  /* ── AP 科学 ── */
  'ap/science/PHY1': { examSystem: 'ap', subject: 'physics-1', tags: [
    'kinematics',
    'dynamics',
    'circular motion',
    'energy',
    'momentum',
    'simple harmonic motion',
    'rotational motion',
    'waves and sound'
  ] },
  'ap/science/PHY2': { examSystem: 'ap', subject: 'physics-2', tags: [
    'fluids',
    'thermodynamics',
    'electrostatics',
    'circuits',
    'optics',
    'modern physics'
  ] },
  'ap/science/PHY-C': { examSystem: 'ap', subject: 'physics-2', tags: [
    'fluids',
    'thermodynamics',
    'electrostatics',
    'circuits',
    'optics',
    'modern physics'
  ] },
  'ap/science/CHEM': { examSystem: 'ap', subject: 'chemistry', tags: [
    'atomic structure',
    'chemical bonding',
    'stoichiometry',
    'thermochemistry',
    'equilibrium',
    'acids and bases',
    'kinetics',
    'electrochemistry'
  ] },
  'ap/science/BIO': { examSystem: 'ap', subject: 'biology', tags: [
    'cell structure',
    'cellular energetics',
    'heredity',
    'gene expression',
    'evolution',
    'ecology',
    'homeostasis'
  ] }
};

/**
 * 高考：按**科目**组卷（不是按卷名）。
 * 高考的「单元」是卷别（全国一卷 / 北京卷 / 上海卷…），卷别差异在考点层面很小，
 * 按科目组卷更贴近实际备考；卷别仍然在真题库里可查。
 */
export const GAOKAO_SUBJECT_BINDINGS: Record<string, PaperExamBinding> = {
  数学: {
    examSystem: 'gaokao',
    subject: '数学',
    tags: [
      '集合与常用逻辑',
      '函数与导数',
      '三角函数',
      '解三角形',
      '平面向量',
      '数列',
      '不等式',
      '复数',
      '立体几何',
      '解析几何',
      '概率与统计',
      '计数原理'
    ]
  },
  物理: {
    examSystem: 'gaokao',
    subject: '物理',
    tags: [
      '运动学',
      '牛顿运动定律',
      '功和能',
      '动量',
      '电场与电势',
      '恒定电流',
      '磁场与电磁感应',
      '机械振动与波',
      '光学',
      '热学'
    ]
  },
  化学: {
    examSystem: 'gaokao',
    subject: '化学',
    tags: [
      '物质结构与元素周期律',
      '化学平衡',
      '水溶液中的离子平衡',
      '氧化还原与电化学',
      '有机化学基础',
      '化学实验',
      '化学反应速率',
      '化学计量'
    ]
  },
  生物: {
    examSystem: 'gaokao',
    subject: '生物',
    tags: ['细胞结构与功能', '细胞代谢', '遗传与变异', '稳态与调节', '生态与环境', '生物技术实践']
  },
  英语: {
    examSystem: 'gaokao',
    subject: '英语',
    tags: [
      '时态与语态',
      '非谓语动词',
      '定语从句',
      '名词性从句',
      '状语从句',
      '虚拟语气',
      '词义辨析',
      '阅读理解'
    ]
  },
  语文: {
    examSystem: 'gaokao',
    subject: '语文',
    tags: ['语言文字运用', '古代诗文阅读', '现代文阅读', '写作', '文学常识', '文言文实词虚词']
  },
  历史: {
    examSystem: 'gaokao',
    subject: '历史',
    tags: ['中国古代史', '中国近现代史', '世界古代史', '世界近现代史', '史料实证', '历史解释']
  },
  思想政治: {
    examSystem: 'gaokao',
    subject: '思想政治',
    tags: ['中国特色社会主义', '经济与社会', '政治与法治', '哲学与文化', '唯物辩证法', '认识论']
  },
  地理: {
    examSystem: 'gaokao',
    subject: '地理',
    tags: ['自然地理', '人文地理', '区域地理', '地图与等值线', '大气与气候', '水循环与洋流']
  }
};

/** 查一个真题单元的组卷坐标；查不到返回 null（= 这套卷组不了） */
export function bindingForUnit(
  boardId: string,
  subjectId: string,
  unitBase: string
): PaperExamBinding | null {
  const direct = PAPER_EXAM_BINDINGS[unitKey(boardId, subjectId, unitBase)];
  if (direct) return direct;
  if (boardId === 'gaokao') {
    const bySubject = GAOKAO_SUBJECT_BINDINGS[subjectId];
    if (bySubject) return bySubject;
  }
  return null;
}

/** 查一个考试局 + 科目的组卷坐标（高考走科目级；其余走单元级） */
export function bindingForSubject(boardId: string, subjectId: string): PaperExamBinding | null {
  if (boardId === 'gaokao') {
    const bySubject = GAOKAO_SUBJECT_BINDINGS[subjectId];
    if (bySubject) return bySubject;
  }
  return null;
}
