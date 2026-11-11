/**
 * 题库领域模型（PR-1）—— 纯类型与闭集常量，零 UI、零 I/O。
 * 硬边界：只做「对齐大纲的自编题」，不复制任何真题。`source='official'` 指用户自己持有的
 * 正版材料录入，不是我们抓取的真题；CAIE / College Board / IBO 真题版权严格，禁止抓取、转载或入库。
 */
export type ExamSystem = 'gaokao' | 'zhongkao' | 'igcse' | 'alevel' | 'ap' | 'ib' | 'other';
export type Board = 'cie' | 'edexcel' | 'aqa' | 'ocr' | 'collegeboard' | 'ibo' | 'china_moe' | 'other';
export type Level = 'hl' | 'sl' | 'as' | 'a2' | 'foundation' | 'higher' | 'standard' | 'na';
export type QuestionType = 'single' | 'multi' | 'fill' | 'judge';
export type LangCode = 'zh' | 'en';
export type QuestionSource = 'manual' | 'import' | 'official';

export const EXAM_SYSTEMS: readonly ExamSystem[] = ['gaokao', 'zhongkao', 'igcse', 'alevel', 'ap', 'ib', 'other'];
export const BOARDS: readonly Board[] = ['cie', 'edexcel', 'aqa', 'ocr', 'collegeboard', 'ibo', 'china_moe', 'other'];
export const LEVELS: readonly Level[] = ['hl', 'sl', 'as', 'a2', 'foundation', 'higher', 'standard', 'na'];
export const QUESTION_TYPES: readonly QuestionType[] = ['single', 'multi', 'fill', 'judge'];
export const LANG_CODES: readonly LangCode[] = ['zh', 'en'];
export const QUESTION_SOURCES: readonly QuestionSource[] = ['manual', 'import', 'official'];
/** 英文卷体系：这些体系用 zh 只给 warning，不拒绝（IB 也有中文 B 等课程）。 */
export const ENGLISH_EXAMS: readonly ExamSystem[] = ['igcse', 'alevel', 'ap', 'ib'];

/** 每个体系允许的层级：IB 只允许 hl/sl；高考/中考/AP 无分层（na）。 */
export const LEVELS_BY_EXAM: Record<ExamSystem, readonly Level[]> = {
  gaokao: ['na'], zhongkao: ['na'], igcse: ['foundation', 'higher'], alevel: ['as', 'a2', 'na'],
  ap: ['na'], ib: ['hl', 'sl'], other: LEVELS
};

/** subject 常量表：每个体系先只登记最小可用学科，避免任意字符串。 */
export const SUBJECTS_BY_EXAM: Record<ExamSystem, readonly string[]> = {
  gaokao: ['数学', '物理', '化学', '生物', '英语'],
  zhongkao: ['数学', '物理', '化学'],
  igcse: ['mathematics', 'physics', 'chemistry', 'biology', 'economics'],
  alevel: ['mathematics', 'physics', 'chemistry', 'economics'],
  ap: ['calculus', 'statistics', 'physics-1', 'chemistry', 'biology', 'microeconomics'],
  ib: ['mathematics-aa', 'physics', 'chemistry', 'economics'],
  other: ['other']
};

/**
 * 按大纲分层的知识点闭集，key 为 `${examSystem}:${subject}`。
 * 只填最小可用集合（10–15 个 topic/syllabus），够验证机制；不抄全量大纲。
 */
export const SYLLABUS_TOPICS: Record<string, readonly string[]> = {
  'gaokao:数学': ['集合与常用逻辑', '函数与导数', '三角函数', '解三角形', '平面向量', '数列', '不等式', '立体几何', '解析几何', '概率与统计', '计数原理', '复数'],
  'zhongkao:数学': ['实数与代数式', '方程与不等式', '一次函数', '二次函数', '三角形', '四边形', '圆', '图形变换', '统计与概率', '实际问题建模'],
  'igcse:mathematics': ['number', 'algebra', 'algebraic manipulation', 'geometry', 'mensuration', 'trigonometry', 'statistics', 'probability', 'ratio and proportion', 'graphs of functions'],
  'alevel:mathematics': ['algebra and functions', 'coordinate geometry', 'sequences and series', 'differentiation', 'integration', 'trigonometry', 'exponentials and logarithms', 'vectors', 'proof', 'kinematics', 'forces and equilibrium', 'probability and distributions'],
  'ap:calculus': ['limits and continuity', 'differentiation', 'applications of derivatives', 'integration', 'fundamental theorem of calculus', 'differential equations', 'sequences and series', 'parametric and polar curves', 'vector-valued functions', 'numerical approximations'],
  'ib:mathematics-aa': ['algebra', 'functions', 'sequences and series', 'complex numbers', 'vectors', 'trigonometry', 'statistics', 'probability', 'calculus', 'proof', 'binomial theorem', 'geometry'],
  // 2026-11-11 扩展：为内置示例题覆盖的学科补齐闭集（缺一个闭集，validateQuestion 直接报错）
  'gaokao:物理': ['运动学', '牛顿运动定律', '功和能', '动量', '电场与电势', '恒定电流', '磁场与电磁感应', '机械振动与波', '光学', '热学'],
  'gaokao:化学': ['物质结构与元素周期律', '化学平衡', '水溶液中的离子平衡', '氧化还原与电化学', '有机化学基础', '化学实验', '化学反应速率', '化学计量'],
  'gaokao:生物': ['细胞结构与功能', '细胞代谢', '遗传与变异', '稳态与调节', '生态与环境', '生物技术实践'],
  'gaokao:英语': ['时态与语态', '非谓语动词', '定语从句', '名词性从句', '状语从句', '虚拟语气', '词义辨析', '阅读理解'],
  'zhongkao:物理': ['力学基础', '压强与浮力', '简单机械', '电路与欧姆定律', '电功率', '光的反射与折射'],
  'zhongkao:化学': ['物质构成', '常见的酸和碱', '金属与盐', '化学方程式', '溶液与溶解度'],
  'igcse:physics': ['forces and motion', 'energy', 'waves', 'electricity', 'magnetism', 'thermal physics', 'light', 'radioactivity'],
  'igcse:chemistry': ['atomic structure', 'bonding', 'stoichiometry', 'acids and bases', 'rates of reaction', 'electrolysis', 'organic chemistry', 'periodic table'],
  'igcse:biology': ['cell structure', 'enzymes', 'photosynthesis', 'transport in plants', 'human nutrition', 'respiration', 'homeostasis', 'inheritance'],
  'igcse:economics': ['basic economic problem', 'demand and supply', 'market equilibrium', 'elasticity', 'money and banking', 'international trade'],
  'alevel:physics': ['mechanics', 'materials', 'waves', 'electricity', 'fields', 'nuclear physics', 'thermal physics', 'circular motion'],
  'alevel:chemistry': ['atomic structure', 'bonding', 'equilibrium', 'kinetics', 'redox', 'organic chemistry', 'periodicity', 'thermodynamics'],
  'alevel:economics': ['demand and supply', 'elasticity', 'market failure', 'macroeconomic objectives', 'fiscal and monetary policy', 'exchange rates'],
  'ap:statistics': ['describing data', 'probability', 'random variables', 'sampling distributions', 'confidence intervals', 'significance tests', 'regression', 'experimental design'],
  'ap:physics-1': ['kinematics', 'dynamics', 'circular motion', 'energy', 'momentum', 'simple harmonic motion', 'rotational motion', 'waves and sound'],
  'ap:chemistry': ['atomic structure', 'chemical bonding', 'stoichiometry', 'thermochemistry', 'equilibrium', 'acids and bases', 'kinetics', 'electrochemistry'],
  'ap:biology': ['cell structure', 'cellular energetics', 'heredity', 'gene expression', 'evolution', 'ecology', 'homeostasis'],
  'ap:microeconomics': ['scarcity and choice', 'demand and supply', 'elasticity', 'production and costs', 'market structures', 'factor markets'],
  'ib:physics': ['mechanics', 'thermal physics', 'waves', 'electricity and magnetism', 'circular motion', 'atomic and nuclear physics', 'energy production'],
  'ib:chemistry': ['atomic structure', 'bonding', 'stoichiometry', 'energetics', 'kinetics', 'equilibrium', 'acids and bases', 'organic chemistry'],
  'ib:economics': ['demand and supply', 'elasticity', 'market failure', 'macroeconomic policy', 'international trade'],
  // 原先 other:other 没有闭集，导致「其他」体系下的任何题都必被 validateQuestion 拒绝
  'other:other': ['general']
};

export interface QuestionOption { key: string; text: string }

/** 单选存 key，多选/填空存 key 或字符串数组，判断存 boolean。 */
export type AnswerKey = string | string[] | boolean;

export interface Question {
  /** 身份：独立随机生成、与内容无关、永不变更；由 utils/questionBank.questionId() 生成。 */
  id: string;
  /** 内容指纹：只用于判重与「疑似重复」提示，不参与身份。同一 id 的 stemHash 变化 = 该题被修订，引用该 id 的记录仍然有效。 */
  stemHash: string;
  /** 题干，允许 LaTeX：`$\frac{1}{2}$`、`$x^{2}$`、`$\sqrt{3}$`。 */
  stem: string;
  options: QuestionOption[];
  type: QuestionType;
  answerKey: AnswerKey;
  explanation?: string;
  examSystem: ExamSystem;
  board: Board;
  /** 必须出现在 SUBJECTS_BY_EXAM[examSystem] 中。 */
  subject: string;
  level: Level;
  syllabusCode?: string;
  year?: number;
  paper?: string;
  /** 必须落在 SYLLABUS_TOPICS[`${examSystem}:${subject}`] 闭集内。 */
  knowledgeTags: string[];
  difficulty: number;
  source: QuestionSource;
  langCode: LangCode;
  createdAt: string;
  updatedAt: string;
}
