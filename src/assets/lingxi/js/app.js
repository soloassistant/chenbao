/* ============================================================
   灵犀课堂 · AI 一对一直播课
   基于WorkBuddy 云服务 LLM API（免密钥）
   ============================================================ */
'use strict';

/* ---------- 云服务配置（来自云服务环境 publicConfig） ---------- */
const PUBLIC_CONFIG = {
  endpoint: 'https://ai-tutor-live.app.workbuddy.host',
  publishableKey: 'wbpk_qntXmGvXSGtzgBQwEkxknD_eaOXPu86yJeDXN2E2iyVr2Difq9hZF4T',
  /* 运营方联系邮箱：填写后会出现在《隐私政策》「联系我们」与注销确认里。
     留空时，界面只展示可自助的数据权利入口，不会出现死链接。 */
  supportEmail: '',
};

/* ---------- 全局状态 ---------- */
const state = {
  cloud: null,
  models: [],
  model: null,
  courses: [],
  homeSystem: 'cn',
  gen: { system: 'cn', subject: '数学', boards: ['ib'], duration: '45 分钟', level: '基础巩固' },
  live: null, // { course, conversationId, messages, controller, busy, seconds, timerInt, stageIndex, savedProgress }
  /* 教学偏好：苏格拉底引导等级 + 元认知提示，长期记忆在 localStorage */
  guide: 'balanced',   // 'more' 更多引导 | 'balanced' 均衡 | 'less' 更多自主
  meta: true,          // 是否启用元认知提问（"哪一步让你困惑？"）
  /* 账号与长期记忆 */
  user: null,          // 已登录用户 { id, email, phone }
  mem: null,           // 当前学生的长期记忆档案（云端）
  memLoaded: false,    // 是否已尝试拉取
  smsReady: null,      // 短信通道是否可用（null=未知，false=本环境未开通）
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ============================================================
   长期记忆（Per-user memory）
   三个云端表（均 owner-only RLS，owner_id 由 DEFAULT auth.uid() 填充）：
     student_profiles — 学生画像（学段/目标/风格/掌握度/优势/薄弱点）
     student_facts    — 老师记住的每条具体事实（偏好/误区/进度）
     student_sessions — 每节课的小结与逐字记录
   记忆的用法：① 开课前置入 system prompt；② 课后自动提炼并写回。
   未登录时一切照旧（纯本地），登录后自动升级为跨设备长期记忆。
   ============================================================ */

const FACT_KINDS = {
  weak: { label: '薄弱点', cls: 'k-weak' },
  strength: { label: '优势', cls: 'k-strength' },
  preference: { label: '偏好', cls: 'k-preference' },
  progress: { label: '进度', cls: 'k-progress' },
  misconception: { label: '易错点', cls: 'k-weak' },
  context: { label: '背景', cls: 'k-preference' },
};

/* 知识点掌握度：把散落的记忆事实按 topic 聚合成「掌握度」。
   定级取"最需要关注"的信号（易错点 > 薄弱点 > 进度 > 优势），
   而不是简单平均 —— 一个知识点哪怕有 3 条优势、只要有 1 条易错点，就不能算已掌握。
   preference / context 与掌握度无关，不参与。 */
const MASTERY_LEVELS = {
  need: { label: '待巩固', cls: 'm-need' },
  learning: { label: '学习中', cls: 'm-learning' },
  mastered: { label: '已掌握', cls: 'm-mastered' },
};
function buildMastery(facts) {
  const agg = {};
  (facts || []).forEach((f) => {
    if (!f) return;
    const topic = String(f.topic || '').trim();
    if (!topic) return;
    const rank = { misconception: 0, weak: 1, progress: 2, strength: 3 }[f.kind];
    if (rank === undefined) return;      // 非掌握度相关的事实（偏好/背景）不计入
    const t = agg[topic] || (agg[topic] = { topic, rank: 3, conf: 0, hits: 0 });
    if (rank < t.rank) t.rank = rank;
    if (Number(f.confidence || 0) > t.conf) t.conf = Number(f.confidence || 0);
    t.hits += Number(f.hits || 0);
  });
  const levelOf = (rank) => (rank <= 1 ? 'need' : rank === 2 ? 'learning' : 'mastered');
  const ord = { need: 0, learning: 1, mastered: 2 };
  return Object.keys(agg)
    .map((k) => ({ topic: k, level: levelOf(agg[k].rank), conf: agg[k].conf, hits: agg[k].hits }))
    .sort((a, b) => ord[a.level] - ord[b.level] || b.conf - a.conf);
}

/* ============================================================
   错因分析（Error-cause analysis）
   只判"对/错"没有教学价值 —— 真正决定怎么补的是"为什么错"。
   四维归类参照数学教育研究里最常用的一种错误分类（Newman 分析框架的简化版）：
     knowledge  知识漏洞：概念/公式根本没掌握        → 要重讲
     concept    概念混淆：把相近概念/条件弄混了      → 要辨析对比
     careless   计算失误：思路对、算错了            → 要建立检查习惯
     reading    审题偏差：看漏/看错条件，答非所问    → 要练审题
   前两类是"真不会"，后两类是"会但没做对"，两者的补救方式完全相反。
   这一点必须显式告诉学生，否则"我明明会"的挫败感会伤害学习动机。
   ============================================================ */
const ERROR_CAUSES = {
  knowledge: {
    label: '知识漏洞',
    short: '漏洞',
    cls: 'e-knowledge',
    icon: '📕',
    // 一句话说清"这意味着什么"，避免学生把错因当成指责
    meaning: '这个概念本身还没学会',
    action: '需要把定义和原理重新讲一遍，从最简单的例子入手。',
  },
  concept: {
    label: '概念混淆',
    short: '混淆',
    cls: 'e-concept',
    icon: '🔀',
    meaning: '把两个相近的概念、公式或适用条件弄混了',
    action: '要把容易混的几组放在一起对比辨析，逐条说清"什么情况用哪个"。',
  },
  careless: {
    label: '计算失误',
    short: '算错',
    cls: 'e-careless',
    icon: '🧮',
    meaning: '思路是对的，但运算或书写过程出了问题',
    action: '这类错是"会但没做对"，重点是养成验算和逐步检查的习惯，不用重学知识。',
  },
  reading: {
    label: '审题偏差',
    short: '审题',
    cls: 'e-reading',
    icon: '👀',
    meaning: '漏看或看错了题目条件，理解的方向偏了',
    action: '读题时先把条件逐条划出来、把问句圈出来，再动笔。',
  },
  other: {
    label: '其它原因',
    short: '其它',
    cls: 'e-other',
    icon: '❓',
    meaning: '暂时无法归入上述四类',
    action: '下节课请老师现场看看你是怎么做的。',
  },
};

const ERROR_CAUSE_KEYS = ['knowledge', 'concept', 'careless', 'reading'];
const ERROR_CAUSE_MAX = ERROR_CAUSE_KEYS.length;

function normErrorCause(c) {
  const k = String(c || '').trim().toLowerCase();
  if (ERROR_CAUSES[k] && k !== 'other') return k;
  // 容错：模型偶尔会给中文或同义词
  const alias = {
    知识漏洞: 'knowledge', 概念不清: 'knowledge', 不会: 'knowledge',
    概念混淆: 'concept', 混淆: 'concept', 弄混: 'concept',
    计算错误: 'careless', 计算失误: 'careless', 粗心: 'careless', 马虎: 'careless',
    审题偏差: 'reading', 审题错误: 'reading', 看错题: 'reading', 没看清: 'reading',
  };
  const s = String(c || '').trim();
  return alias[s] || 'other';
}

function emptyCauseStat() {
  const o = {};
  ERROR_CAUSE_KEYS.forEach((k) => { o[k] = 0; });
  return o;
}

/* 归一化一节课的错因清单：只保留有意义的条目，最多四类各一条 */
function cleanErrorCauses(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((e) => {
    if (!e) return;
    const cause = normErrorCause(typeof e === 'string' ? e : e.cause);
    if (cause === 'other') return;
    if (out.some((x) => x.cause === cause)) return;   // 同类只留第一条
    const topic = String((typeof e === 'object' && e.topic) || '').trim().slice(0, 120);
    const detail = String((typeof e === 'object' && (e.detail || e.wrong || e.mistake)) || '').trim().slice(0, 240);
    const fix = String((typeof e === 'object' && (e.fix || e.suggestion || e.action)) || '').trim().slice(0, 240);
    out.push({ cause, topic, detail, fix });
  });
  return out.slice(0, ERROR_CAUSE_MAX);
}

/* 跨课程聚合错因：按"科目 · 知识点"分组，统计四维分布 */
function buildErrorProfile(sessions) {
  const groups = {};
  let total = 0;
  (sessions || []).forEach((s) => {
    const list = Array.isArray(s && s.error_causes) ? s.error_causes : [];
    list.forEach((raw) => {
      if (!raw) return;
      // 与 cleanErrorCauses 保持一致：字符串条目也要能容错（历史数据 / 手工写的行）
      const e = typeof raw === 'string' ? { cause: raw } : raw;
      const cause = normErrorCause(e.cause);
      if (cause === 'other') return;
      total++;
      const topic = String(e.topic || '').trim() || '未归类知识点';
      const subject = String((s && s.subject) || '').trim();
      const key = (subject ? subject + ' · ' : '') + topic;
      const g = groups[key] || (groups[key] = { key, subject, topic, counts: emptyCauseStat(), total: 0 });
      if (!g.counts || typeof g.counts[cause] !== 'number') g.counts = emptyCauseStat();
      g.counts[cause]++;
      g.total++;
    });
  });
  const hasCareless = Object.keys(groups).some((k) => groups[k].counts.careless > 0);
  const hasReading = Object.keys(groups).some((k) => groups[k].counts.reading > 0);
  const list = Object.keys(groups).map((k) => {
    const g = groups[k];
    // 主导错因：次数最多；并列时优先"更该补"的知识性错因
    const prio = { knowledge: 0, concept: 1, careless: 2, reading: 3 };
    const top = ERROR_CAUSE_KEYS
      .filter((c) => g.counts[c] > 0)
      .sort((a, b) => g.counts[b] - g.counts[a] || prio[a] - prio[b])[0];
    return Object.assign({}, g, { top });
  }).sort((a, b) => {
    const ka = a.counts.knowledge + a.counts.concept;
    const kb = b.counts.knowledge + b.counts.concept;
    return kb - ka || b.total - a.total;
  });
  return {
    total,
    list,
    // 会但没做对（粗心 + 审题）/ 真不会（漏洞 + 混淆）：这个比例最该被学生看到
    carelessish: total ? (list.reduce((n, g) => n + g.counts.careless + g.counts.reading, 0)) : 0,
    hasCareless,
    hasReading,
  };
}

/* ============================================================
   入学诊断（起点画像）
   ------------------------------------------------------------
   为什么要有它：一对一最大的优势是"从学生真实起点开始"，但开课前
   老师其实一无所知 —— 只能靠学生自己填的"基础巩固/进阶提升"，
   那是个自我评价，常常不准（学生普遍高估或低估自己）。
   代价也最大：**把已经会的东西讲一遍，是消耗信任最快的方式**。

   所以这里做一件很具体的事：课前出 5-8 道**诊断题**，
   不是考分，而是**定位**：每道题对应一个知识点，用结果把学生
   分成三档（掌握 / 模糊 / 未掌握），再据此生成一张"起点画像"，
   直接决定第一节课从哪里讲起、哪些可以跳过。

   与「错因四维」的关系：诊断只分三档（会不会），不判错因 ——
   错因需要看解题过程，那是直播课里老师边问边判断的事。
   诊断负责**圈出范围**，错因负责**解释原因**。两者互补，不重复。
   ============================================================ */

/* 诊断结果分档。注意"未作答"是独立一档，不能算错 ——
   学生可能只是没来得及做，把它当"不会"会冤枉人。 */
const DIAG_LEVELS = {
  ok: { label: '已掌握', cls: 'd-ok', icon: '✅', order: 0 },
  fuzzy: { label: '待确认', cls: 'd-fuzzy', icon: '🔶', order: 1 },
  gap: { label: '未掌握', cls: 'd-gap', icon: '🔴', order: 2 },
  na: { label: '未作答', cls: 'd-na', icon: '⬜', order: 3 },
};

/* 诊断题量：5-8 题。少于 5 题定位不出范围，多于 8 题开课前就把人劝退了。 */
const DIAG_MIN = 5;
const DIAG_MAX = 8;

function normDiagLevel(v) {
  const k = String(v || '').trim().toLowerCase();
  if (DIAG_LEVELS[k] && k !== 'na') return k;
  // 容错：模型可能直接说结论
  if (/^(true|yes|correct|对|会|掌握|熟练|是)$/i.test(k)) return 'ok';
  if (/^(false|no|wrong|错|不会|没掌握|否)$/i.test(k)) return 'gap';
  return 'na';
}

/* 单题判定：优先按"选项字母对不对"，其次按"是否作答 + 自评"。
   为什么要分 na / fuzzy：诊断题里有简答题，学生可能答了但没答对，
   这和"空着没写"在诊断上是两回事 —— 前者是 gap 的强信号，后者是没信息。 */
function judgeDiagItem(item, ans) {
  if (!item) return { level: 'na', reason: '' };
  const a = ans || {};
  const answered = a.value !== undefined && a.value !== null && String(a.value).trim() !== '';
  if (!answered) return { level: 'na', reason: '没有作答' };

  if (item.type === 'choice') {
    const correct = String(a.value).trim().toUpperCase();
    const answer = String(item.answer || '').trim().toUpperCase();
    if (!answer) return { level: 'fuzzy', reason: '这道题缺参考答案，先按待确认' };
    return correct === answer
      ? { level: 'ok', reason: '选对了' }
      : { level: 'gap', reason: '选错（正确答案 ' + answer + '）' };
  }
  // 简答/填空：没有客观标准，交给"学生自评 + 是否写了"两档
  const self = String(a.self || '').trim();
  if (self === 'sure') return { level: 'ok', reason: '自己确认做对了' };
  if (self === 'unsure') return { level: 'fuzzy', reason: '做了但不确定' };
  return { level: 'fuzzy', reason: '有作答但未自评' };
}

/* 把逐题结果聚合成"起点画像"。
   ★ 关键设计：**按知识点聚合，且同一知识点取最差的一档**。
   一个知识点出两道题、对一道错一道 —— 那不是"掌握一半"，
   而是"不稳定"，必须按待确认/未掌握处理（和掌握度图谱用同一套哲学：
   不能因为有几条好信号就把坏信号平均掉）。 */
function buildDiagnostic(items, answers) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const byTopic = {};
  const order = [];
  list.forEach((it, i) => {
    const key = String(it.topic || '').trim() || ('第 ' + (i + 1) + ' 题');
    if (!byTopic[key]) {
      byTopic[key] = { topic: key, subject: it.subject || '', levels: [], reasons: [] };
      order.push(key);
    }
    const j = judgeDiagItem(it, (answers || {})[i]);
    byTopic[key].levels.push(j.level);
    if (j.reason) byTopic[key].reasons.push(j.reason);
  });

  const topics = order.map((k) => {
    const g = byTopic[k];
    // 最差档胜出：gap > fuzzy > ok；全是 na 则该知识点确实没被评估
    const real = g.levels.filter((x) => x !== 'na');
    let level = 'na';
    if (real.length) {
      if (real.includes('gap')) level = 'gap';
      else if (real.includes('fuzzy')) level = 'fuzzy';
      else level = 'ok';
    }
    return { topic: g.topic, level, reason: g.reasons[0] || '', count: g.levels.length };
  });

  const counts = { ok: 0, fuzzy: 0, gap: 0, na: 0 };
  topics.forEach((t) => { counts[t.level]++; });
  const judged = topics.filter((t) => t.level !== 'na');
  const score = judged.length ? Math.round((counts.ok / judged.length) * 100) : 0;

  // 学习建议：先看"未掌握"有多少，再看整体水平，别一上来就喊加油
  let verdict;
  if (!judged.length) {
    verdict = '这次没有作答记录，暂时无法判断起点 —— 直接开始上课，老师会在课上一对一确认。';
  } else if (counts.gap === 0 && counts.fuzzy === 0) {
    verdict = '这些知识点你<b>全都答对了</b>，基础很扎实。这节课我们会<b>直接跳到更难的题型和综合应用</b>，不做重复铺垫。';
  } else if (counts.gap === 0) {
    verdict = '整体掌握得不错，只有个别点不太确定。上课时老师会先<b>快速带你确认这几个点</b>，再进入提升内容。';
  } else if (counts.gap >= Math.ceil(judged.length / 2)) {
    verdict = '有<b>多个知识点还没掌握</b>，这完全正常 —— 说明这节课正好讲在你需要的地方。' +
      '老师会从最基础的一步开始，不预设你已经会了。';
  } else {
    verdict = '你的情况是<b>部分掌握、部分不牢</b>。老师会跳过你已经会的，集中把薄弱的那几个点讲透。';
  }

  return {
    topics,
    counts,
    total: topics.length,
    judged: judged.length,
    score,
    verdict,
    // 优先级：未掌握最该先讲，其次待确认；已掌握的直接跳过
    focus: topics.filter((t) => t.level === 'gap')
      .concat(topics.filter((t) => t.level === 'fuzzy'))
      .map((t) => t.topic),
    skip: topics.filter((t) => t.level === 'ok').map((t) => t.topic),
  };
}

/* 诊断题出题 prompt。要点：题目必须**短、可自答、能区分会不会**，
   不要出需要长篇演算的题 —— 开课前没人愿意做压轴题。 */
function buildDiagnosticPrompt(opt) {
  const o = opt || {};
  const sys = getSystem(o.system || state.gen.system);
  const isIntl = sys.id === 'intl';
  const n = Math.min(DIAG_MAX, Math.max(DIAG_MIN, o.count || 6));
  const boards = (o.boards || []).filter(Boolean);
  return '请为一位准备开始一对一辅导的学生出一份**课前诊断卷**，用来定位他/她的真实起点。\n' +
    '科目：' + (o.subject || state.gen.subject) + '\n' +
    '课程体系：' + sys.name + (isIntl ? '（对标考纲：' + (boards.length ? boards.join('、') : '国际通行标准') + '）' : '') + '\n' +
    '学段：' + (o.grade || '') + '\n' +
    '学习目标：' + (o.goal || '未填写，请按该学段该科目的典型学习需求设计') + '\n' +
    '题量：' + n + ' 题\n' +
    '题目要求：\n' +
    '1. 每题只考察**一个**知识点，并在 topic 字段写出该知识点的名称（4-10 字，如"配方法"、"韦达定理"）；\n' +
    '2. **难度要有梯度**：前 2 题是该学段最基础的（几乎必须会），中间 3-4 题是标准难度，最后 1-2 题稍难，' +
    '这样既能查出"地基有没有塌"，也能看出上限；\n' +
    '3. 每题都能在 1-2 分钟内独立做完，**不要出需要长篇演算的压轴题**；\n' +
    '4. 优先用选择题（4 个选项，题干和选项都要具体，数学要给出真实数字/式子）；' +
    '   最多 2 道简答题（此时 options 留空数组，answer 写简要答案）；\n' +
    '5. 干扰项要真实：选那些"用错方法/记混公式"就会选中的答案，不要放明显可笑的选项；\n' +
    '6. 覆盖该目标下**最关键**的知识点，而不是随便凑 6 个知识点。' +
    (isIntl ? '\n7. 专业术语给出英文原名（如 "判别式 discriminant"）。' : '');
}

/* 诊断卷的系统提示词：只吐 JSON，并明确 topic 的作用（后面靠它做聚合） */
function diagnosticSystemPrompt() {
  return '你是「灵犀课堂」的资深学科教研员，擅长设计**课前诊断卷**来快速定位学生的真实水平。' +
    '你既熟悉中国国家课程与中高考考纲，也熟悉 IB、A-Level、AP、IGCSE 等国际课程体系。' +
    '只输出一个 JSON 对象，禁止输出 markdown 代码块或任何解释文字。JSON 结构：' +
    '{"title":"诊断卷标题","intro":"一两句话向学生说明这份诊断是做什么的（不要吓人，说明只是为定制课程）",' +
    '"items":[{"topic":"知识点名称（4-10字，必须能被复用作为知识点的唯一标识）",' +
    '"type":"choice","question":"完整题干",' +
    '"options":["A. 选项一","B. 选项二","C. 选项三","D. 选项四"],' +
    '"answer":"B","why":"这个知识点为什么会错（一句话，老师看）",' +
    '"ifWrong":"答错说明什么（一句话，老师看：是概念没懂还是方法没掌握）"}]}。' +
    '注意：简答题的 options 必须是空数组 []，answer 写简要答案文字。';
}

/* 清洗诊断卷：模型输出经常有小毛病（选项前缀缺失、answer 是中文整句、
   topic 重复），这里做归一化，保证后面聚合算法拿到的是干净数据。 */
function cleanDiagnostic(raw, opt) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const src = Array.isArray(o.items) ? o.items : [];
  const items = [];
  const seen = {};
  src.forEach((it) => {
    if (!it || !it.question) return;
    if (items.length >= DIAG_MAX) return;
    let type = String(it.type || '').toLowerCase() === 'choice' ? 'choice' : 'short';
    let topic = String(it.topic || '').trim().slice(0, 40);
    if (!topic) topic = '第 ' + (items.length + 1) + ' 题';
    // 同一知识点重复出题：保留（能测稳定性），但最多两条，避免整卷只考一个点
    seen[topic] = (seen[topic] || 0) + 1;
    if (seen[topic] > 2) return;
    let options = [];
    if (type === 'choice' && Array.isArray(it.options)) {
      options = it.options.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
      // 补上 A. B. C. 前缀（模型时常漏）
      options = options.map((x, i) => (/^[A-F][.、)]/.test(x) ? x : String.fromCharCode(65 + i) + '. ' + x));
    }
    if (!options.length) type = 'short';
    let answer = String(it.answer == null ? '' : it.answer).trim().slice(0, 60);
    // 把"答案是 B"这类整句压成单个字母
    const m = /(?:^|[^A-Za-z])([A-F])(?:[^A-Za-z]|$)/.exec(answer);
    if (type === 'choice' && m) answer = m[1].toUpperCase();
    items.push({
      topic,
      type,
      question: String(it.question).trim().slice(0, 500),
      options,
      answer,
      why: String(it.why || '').trim().slice(0, 200),
      ifWrong: String(it.ifWrong || it.if_wrong || '').trim().slice(0, 200),
    });
  });
  return {
    title: String(o.title || '').trim() || '课前诊断',
    intro: String(o.intro || '').trim() ||
      '这不是考试，只是为了知道你从哪里开始 —— 有几道不会做很正常，直接跳过也没关系。',
    subject: (opt && opt.subject) || state.gen.subject,
    system: (opt && opt.system) || state.gen.system,
    grade: (opt && opt.grade) || '',
    goal: (opt && opt.goal) || '',
    items,
  };
}

/* PostgREST 查询结果统一拆包 */
function dbPick(res) {
  if (!res) return null;
  if (res.error) throw res.error;
  return res.data;
}

/* 当前是否具备云端记忆能力 */
function memReady() {
  return !!(state.cloud && state.cloud.database && state.user && !state.user.anonymous);
}

/* 拉取当前学生的完整记忆（画像 + 事实 + 最近上课记录） */
async function loadMemory(force) {
  if (!state.cloud || !state.user) { state.mem = null; state.memLoaded = true; return null; }
  if (state.user.anonymous) { state.mem = null; state.memLoaded = true; return null; }
  if (state.memLoaded && !force) return state.mem;

  const db = state.cloud.database;
  try {
    const [profRes, factsRes, sessRes] = await Promise.all([
      db.from('student_profiles').select('*').maybeSingle(),
      db.from('student_facts').select('*').order('last_seen', { ascending: false }).limit(80),
      // 带 error_causes 查一次；若该列还没建（老库），降级到不带它的字段集，
      // 保证"错因分析"缺失时其余档案功能完全不受影响
      (async () => {
        const full = 'id, course_title, subject, grade, duration_secs, mastered, weak_points, homework, comment, error_causes, created_at';
        const base = 'id, course_title, subject, grade, duration_secs, mastered, weak_points, homework, comment, created_at';
        const q = (cols) => db.from('student_sessions').select(cols)
          .order('created_at', { ascending: false }).limit(20);
        const r = await q(full);
        if (r && r.error) return q(base);
        return r;
      })(),
    ]);
    const profile = dbPick(profRes) || null;
    const facts = dbPick(factsRes) || [];
    const sessions = dbPick(sessRes) || [];
    state.mem = { profile, facts, sessions };
    state.memLoaded = true;
    return state.mem;
  } catch (e) {
    // 登录态失效会连带把记忆读取打成 401：清掉残留会话，避免"明明登录着却什么都不能用"
    if (isAuthError(e)) {
      try {
        if (await healSession()) toast('登录状态已过期，已切回访客模式，可以继续上课');
      } catch (_) {}
    }
    console.warn('[memory] 读取失败:', (e && e.message) || e);
    state.mem = { profile: null, facts: [], sessions: [], error: e };
    state.memLoaded = true;
    return state.mem;
  }
}

/* 画像 upsert：owner 唯一索引保证一人一行 */
async function saveProfile(patch) {
  if (!memReady()) return null;
  const db = state.cloud.database;
  try {
    // 先按 owner 查是否已有画像；RLS 保证只能看到自己的
    const { data: rows } = await db.from('student_profiles').select('id, sessions_count, total_seconds').limit(1);
    const cur = Array.isArray(rows) && rows.length ? rows[0] : null;
    const body = Object.assign({}, patch);
    if (cur) {
      // patch 里若带 sessions_count/total_seconds 增量，这里做累加
      if (typeof patch._addSessions === 'number') {
        body.sessions_count = (cur.sessions_count || 0) + patch._addSessions;
        delete body._addSessions;
      }
      if (typeof patch._addSeconds === 'number') {
        body.total_seconds = (cur.total_seconds || 0) + patch._addSeconds;
        delete body._addSeconds;
      }
      body.updated_at = new Date().toISOString();
      const res = await db.from('student_profiles').update(body).eq('id', cur.id).select();
      const out = dbPick(res);
      // 空数组 = RLS 拦下（不属于自己），必须显式处理而不是当作成功
      if (Array.isArray(out) && out.length === 0) {
        console.warn('[memory] 画像更新被 RLS 拒绝');
        return null;
      }
      return Array.isArray(out) ? out[0] : null;
    }
    // 首次创建
    if (typeof patch._addSessions === 'number') { body.sessions_count = patch._addSessions; delete body._addSessions; }
    if (typeof patch._addSeconds === 'number') { body.total_seconds = patch._addSeconds; delete body._addSeconds; }
    const res = await db.from('student_profiles').insert(body).select();
    const out = dbPick(res);
    return Array.isArray(out) ? out[0] : null;
  } catch (e) {
    console.warn('[memory] 画像写入失败:', e);
    return null;
  }
}

/* 批量写入「老师记住的事」，同内容去重（命中则提升 confidence + hits） */
async function saveFacts(facts) {
  if (!memReady() || !Array.isArray(facts) || !facts.length) return 0;
  const db = state.cloud.database;
  const list = facts
    .filter((f) => f && f.content && String(f.content).trim())
    .map((f) => ({
      kind: FACT_KINDS[f.kind] ? f.kind : 'context',
      content: String(f.content).trim().slice(0, 400),
      subject: f.subject ? String(f.subject).slice(0, 60) : null,
      topic: f.topic ? String(f.topic).slice(0, 120) : null,
      confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0.6,
      source: f.source ? String(f.source).slice(0, 60) : 'class',
    }))
    // 同一次返回里也去重
    .filter((f, i, arr) => arr.findIndex((x) => x.content === f.content) === i);
  if (!list.length) return 0;

  // 拿已有内容做去重（只取自己的，RLS 保证）
  let existing = [];
  try {
    const res = await db.from('student_facts').select('id, content, hits, confidence').limit(500);
    existing = dbPick(res) || [];
  } catch (_) {}

  const byContent = new Map(existing.map((r) => [String(r.content), r]));
  const fresh = list.filter((f) => !byContent.has(f.content));
  let written = 0;

  // 命中已有：更新 last_seen / hits / confidence
  for (const f of list) {
    const hit = byContent.get(f.content);
    if (!hit) continue;
    try {
      await db.from('student_facts').update({
        last_seen: new Date().toISOString(),
        hits: (hit.hits || 0) + 1,
        confidence: Math.min(1, (hit.confidence || 0.6) + 0.12),
      }).eq('id', hit.id);
      written++;
    } catch (_) {}
  }
  if (fresh.length) {
    try {
      const res = await db.from('student_facts').insert(fresh).select('id');
      const out = dbPick(res);
      written += Array.isArray(out) ? out.length : 0;
    } catch (e) { console.warn('[memory] 事实写入失败:', e); }
  }
  return written;
}

async function saveSession(rec) {
  if (!memReady()) return null;
  const db = state.cloud.database;
  const body = {
    course_title: String(rec.courseTitle || '未命名课程').slice(0, 200),
    subject: rec.subject || null,
    grade: rec.grade || null,
    duration_secs: Math.max(0, Math.round(rec.durationSecs || 0)),
    mastered: Array.isArray(rec.mastered) ? rec.mastered.slice(0, 12) : [],
    weak_points: Array.isArray(rec.weakPoints) ? rec.weakPoints.slice(0, 12) : [],
    homework: Array.isArray(rec.homework) ? rec.homework.slice(0, 12) : [],
    cards: Array.isArray(rec.cards) ? rec.cards.slice(0, 12) : [],
    review_plan: Array.isArray(rec.reviewPlan) ? rec.reviewPlan.slice(0, 12) : [],
    comment: rec.comment ? String(rec.comment).slice(0, 1200) : null,
    transcript: rec.transcript ? String(rec.transcript).slice(0, 20000) : null,
  };
  const causes = cleanErrorCauses(rec.errorCauses);
  try {
    const res = await db.from('student_sessions').insert(
      causes.length ? Object.assign({ error_causes: causes }, body) : body
    ).select('id');
    const out = dbPick(res);
    return Array.isArray(out) ? out[0] : null;
  } catch (e) {
    // error_causes 列尚未创建时，退回写入不带错因的记录 —— 丢的只是增强字段，不是整节课
    if (causes.length) {
      try {
        const res2 = await db.from('student_sessions').insert(body).select('id');
        const out2 = dbPick(res2);
        console.warn('[memory] error_causes 列缺失，本节课错因未写入（不影响其它数据）');
        return Array.isArray(out2) ? out2[0] : null;
      } catch (e2) {
        console.warn('[memory] 上课记录写入失败:', e2);
        return null;
      }
    }
    console.warn('[memory] 上课记录写入失败:', e);
    return null;
  }
}

async function deleteFact(id) {
  if (!memReady()) return false;
  try {
    const res = await state.cloud.database.from('student_facts').delete().eq('id', id).select('id');
    const out = dbPick(res);
    return Array.isArray(out) && out.length > 0;
  } catch (e) { return false; }
}

/* 把记忆渲染成一段可注入 system prompt 的文本（省 token 且信息密度高） */
function memoryPromptBlock() {
  const m = state.mem;
  if (!m) return '';
  const p = m.profile;
  const facts = Array.isArray(m.facts) ? m.facts : [];
  const sessions = Array.isArray(m.sessions) ? m.sessions : [];
  if (!p && !facts.length && !sessions.length) return '';

  const lines = [];
  if (p) {
    const bits = [];
    if (p.grade) bits.push('学段：' + p.grade);
    if (p.system) bits.push('体系：' + p.system);
    if (p.goal) bits.push('目标：' + p.goal);
    if (p.level) bits.push('水平：' + p.level);
    if (p.teaching_style) bits.push('偏好教学风格：' + p.teaching_style);
    if (p.pace) bits.push('节奏：' + p.pace);
    if (bits.length) lines.push('· 画像：' + bits.join('；'));
    if (typeof p.sessions_count === 'number' && p.sessions_count > 0) {
      lines.push('· 已上过 ' + p.sessions_count + ' 节课，累计 ' + Math.round((p.total_seconds || 0) / 60) + ' 分钟');
    }
  }

  // 薄弱点 / 易错点优先（最该被"记住"的部分），最多各取几条
  const pick = (kinds, n) => facts.filter((f) => kinds.includes(f.kind)).slice(0, n);
  const weak = pick(['weak', 'misconception'], 6);
  const strong = pick(['strength'], 4);
  const pref = pick(['preference', 'context'], 5);
  const prog = pick(['progress'], 4);

  if (weak.length) lines.push('· 需要重点关注的薄弱点/易错点：\n   - ' + weak.map((f) => f.content).join('\n   - '));
  if (strong.length) lines.push('· 已展现的优势（可以更快推进）：\n   - ' + strong.map((f) => f.content).join('\n   - '));
  if (pref.length) lines.push('· 学生的偏好与背景：\n   - ' + pref.map((f) => f.content).join('\n   - '));
  if (prog.length) lines.push('· 上次学到哪里：\n   - ' + prog.map((f) => f.content).join('\n   - '));

  if (sessions.length) {
    const last = sessions[0];
    if (last && last.course_title) {
      lines.push('· 上一节课是《' + last.course_title + '》' +
        (last.subject ? '（' + last.subject + '）' : '') +
        (last.comment ? '，当时评价：' + String(last.comment).slice(0, 140) : ''));
    }
  }

  // 错因画像：把"曾经怎么错的"明确交给模型，否则它会反复用同一种无效讲法
  const ep = buildErrorProfile(sessions);
  if (ep.total) {
    const top = ep.list.slice(0, 4);
    lines.push('· 以前出错的原因分析（这决定你这次该怎么讲，不要忽略）：\n   - ' +
      top.map((g) => {
        const c = ERROR_CAUSES[g.top] || ERROR_CAUSES.other;
        return g.topic + '：主要是「' + c.label + '」' +
          (g.counts[g.top] > 1 ? '（出现过 ' + g.counts[g.top] + ' 次）' : '') +
          ' → ' + c.action;
      }).join('\n   - '));
    if (ep.list.some((g) => g.counts.careless > 0)) {
      lines.push('   - 注意：他有「思路对但算错」的情况。讲这类题时不要重讲概念，' +
        '而是带他把验算和逐步骤检查变成习惯。');
    }
    if (ep.list.some((g) => g.counts.reading > 0)) {
      lines.push('   - 注意：他有「读题漏条件」的情况。出题后先让他把条件逐条复述出来再动笔。');
    }
  }
  if (!lines.length) return '';
  return '【关于这个学生的长期记忆（你以前教过他/她，请自然地体现出你记得，但不要生硬复述）】\n' +
    lines.join('\n') + '\n';
}

/* 记忆 → 教学动作的指令：让"记住"真正影响教法，而不只是念档案 */
const MEMORY_USE_RULE =
  '【怎么使用这些记忆】\n' +
  '1. 开场用一两句话自然地衔接上次（例如"上次你对判别式的符号还有点犹豫，今天我们先把它彻底解决"），不要机械念档案。\n' +
  '2. 不要重复讲解学生已掌握的内容，直接推进；但如果学生显露出遗忘，就快速回补一句。\n' +
  '3. 针对"薄弱点/易错点"要主动设计追问去验证是否真的解决了，而不是假设已经学会。\n' +
  '4. 尊重学生的偏好（例子类型、节奏、讲解风格），但不要主动点破你是在"照着偏好讲"。\n' +
  '5. 如果记忆里有明显过时或与学生当前说法矛盾的信息，以学生现在说的为准，并自然更新你的理解。';


/* ============================================================
   法律合规（中国法）
   依据：《个人信息保护法》《网络安全法》《数据安全法》《生成式人工智能服务管理暂行办法》
   落地要点：① 处理前告知并取得同意 ② 最小必要收集 ③ 明示处理目的与保存期限
            ④ 保障查阅/复制/更正/删除/注销等个人权利 ⑤ 未成年人特别提示
            ⑥ 生成式 AI 内容标识提示
   ============================================================ */

const LEGAL_VERSION = '2026-09-21';

/* 隐私政策：说明我们收集什么、为什么、存多久、你的权利怎么行使 */
const PRIVACY_DOC = [
  { h: '一、我们收集哪些信息', p: [
    '为向你提供 AI 一对一直播课与跨课程长期记忆服务，我们会收集以下信息：',
    '1）账号信息：你注册或登录时提供的邮箱地址或手机号码，以及你在登录时使用的验证信息。这是识别你身份、把你的学习数据还给你所必需的。',
    '2）学习信息：你选择的课程体系、学科、学段、学习目标，你在课堂中的提问与作答、AI 老师对你学习情况的评估结论（已掌握/待巩固的知识点、薄弱点、学习偏好、学习进度）。这些信息用于让 AI 老师跨课程记住你，从而提供更连贯的教学。',
    '3）课堂记录：课堂对话的逐字记录与课堂小结，用于生成学习档案与课堂回放。',
    '我们不会收集你的身份证号、生物识别信息、精确地理位置、通讯录、相册等与你学习无关的信息。',
  ]},
  { h: '二、我们如何使用这些信息', p: [
    '1）向你提供课程生成、AI 讲解答疑、学习档案与长期记忆等核心功能。',
    '2）向你本人展示并管理你的学习档案。',
    '我们不会将你的个人信息用于广告推送，也不会将其出售给任何第三方。',
  ]},
  { h: '三、AI 处理说明', p: [
    '本服务的讲解内容、课程大纲、课堂小结与分析结论由人工智能模型生成。AI 生成的内容可能存在错误或偏差，仅供学习参考，不构成任何形式的成绩承诺或专业建议。',
    '你的课堂上内容会被发送至模型服务进行推理，以生成本次回复；该处理仅用于完成你所请求的功能。',
    '依据《生成式人工智能服务管理暂行办法》，AI 生成的内容会向你明示其 AI 生成属性。',
  ]},
  { h: '四、保存期限与存储', p: [
    '你的学习数据保存在为你提供服务的云端环境中，保存至你主动删除或注销账号为止。',
    '注销账号后，我们会删除你的学生画像、全部记忆条目与课堂记录，并解除登录方式与你学习数据之间的关联，且不可恢复。为便于你日后重新开始，用于登录的邮箱或手机号会保留为一个没有任何学习记录的空白账号；如需连同该登录方式一并删除，可通过「联系我们」提出。',
  ]},
  { h: '五、你的权利', p: [
    '依据《个人信息保护法》，你对自身个人信息享有以下权利，且可随时行使：',
    '1）查阅、复制：在「学习档案」页可查看全部记忆条目与上课记录，也可一键导出为 JSON 文件。',
    '2）更正、补充：可逐条删除不准确的记忆，或重新添加正确的内容。',
    '3）删除、注销：可删除单条记忆，也可在「账号与个人信息」中注销账号并删除全部数据。',
    '4）撤回同意：你可随时退出登录并使用访客模式，此时我们不再处理你的学习数据。',
  ]},
  { h: '六、未成年人保护', p: [
    '若你未满 14 周岁，请在父母或其他监护人的陪同下阅读本政策，并在取得监护人同意后使用本服务。',
    '我们建议未成年人在监护人指导下使用，且我们会以最小必要原则处理未成年人信息。监护人若需查询、更正或删除未成年人的信息，可通过下方方式联系我们。',
  ]},
  { h: '七、信息安全', p: [
    '我们采用按用户隔离的访问控制机制：每位用户的云端数据仅能由该用户本人读取和写入，其他用户无法访问你的学习档案。',
    '请你妥善保管账号与验证码，不要将其提供给他人。',
  ]},
  { h: '八、联系我们', p: [
    '如你对本政策有任何疑问，或需要行使上述个人权利（包括删除用于登录的邮箱或手机号本身），可通过以下方式联系我们：',
    '1）应用内「账号与个人信息」面板：可自助完成查阅、导出、更正、删除与注销，这是本服务的数据权利受理入口。',
    '2）' + (PUBLIC_CONFIG.supportEmail
      ? '联系邮箱：' + PUBLIC_CONFIG.supportEmail + '。'
      : '如需人工协助，请通过你注册时使用的邮箱与我们联系。'),
    '本政策自 ' + LEGAL_VERSION + ' 起生效。若政策发生重大变更，我们会以显著方式提示你重新阅读并确认。',
  ]},
];

/* 用户协议 */
const TERMS_DOC = [
  { h: '一、服务内容', p: [
    '灵犀课堂（下称"本服务"）为你提供由人工智能驱动的课程生成、一对一在线讲解、课堂互动问答、学习档案与长期记忆等功能。',
    '本服务为学习辅助工具，不能替代学校教育教学，也不提供学历、学位或任何官方认证。',
  ]},
  { h: '二、账号与实名', p: [
    '你可使用邮箱注册账号；手机号登录在短信通道开通后同样可用。为遵守《网络安全法》关于网络实名制的要求，你在注册与登录时需通过短信验证码或邮箱验证码完成真实身份验证。',
    '你需要对账号项下的一切行为负责，并妥善保管账号信息与验证码。',
  ]},
  { h: '三、使用规范', p: [
    '你承诺不利用本服务从事违法违规活动，不输入、上传、传播含有下列内容的信息：',
    '1）违反国家法律法规的；2）危害国家安全、荣誉和利益的；3）煽动民族仇恨、破坏民族团结的；4）宣扬淫秽、色情、赌博、暴力、恐怖或者教唆犯罪的；5）侮辱、诽谤他人或侵害他人合法权益的；6）其他违背公序良俗的。',
    '若你输入上述内容，我们有权拒绝处理，并在必要时停止向你提供服务。',
  ]},
  { h: '四、AI 生成内容的说明与责任', p: [
    '本服务中的课程大纲、讲解内容、练习题、解析与学习分析均由人工智能模型生成，可能存在不准确、不完整或不适用于你具体学习阶段的内容。',
    '请在教师或家长指导下甄别使用。你基于 AI 生成内容作出的学习决策与由此产生的后果，由你自行承担。',
  ]},
  { h: '五、知识产权', p: [
    '本服务的界面、代码与产品设计等相关知识产权归我们所有。',
    '你在课堂中输入的问题与你自行上传的学习材料，其权利仍归你所有；你授权我们在为你提供服务的必要范围内处理这些内容。',
  ]},
  { h: '六、服务变更与终止', p: [
    '我们可能因业务调整、技术升级或法律法规要求而变更、中断或终止部分或全部服务，并会提前以适当方式通知你。',
    '你可随时停止使用本服务，并可在「账号与个人信息」中注销账号。',
  ]},
  { h: '七、免责声明', p: [
    '因不可抗力、网络故障、第三方服务（含模型服务、验证码送达）异常等非我们可控的原因导致的服务中断或数据延迟，我们在法律允许范围内不承担责任。',
    '请勿将本服务用于考试作弊等违反学术诚信的用途。',
  ]},
  { h: '八、适用法律与争议解决', p: [
    '本协议的订立、效力、解释、履行及争议解决均适用中华人民共和国法律。',
    '如发生争议，双方应先友好协商；协商不成的，可向有管辖权的人民法院提起诉讼。',
    '本协议自 ' + LEGAL_VERSION + ' 起生效。',
  ]},
];

const DOCS = {
  privacy: { title: '隐私政策', body: PRIVACY_DOC },
  terms: { title: '用户协议', body: TERMS_DOC },
};

/* 同意状态持久化：勾选后记住，但政策版本变化需重新确认 */
const CONSENT_KEY = 'lingxi_consent_v1';
function hasConsent() {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    return !!(o && o.version === LEGAL_VERSION);
  } catch (_) { return false; }
}
function setConsent(yes) {
  try {
    if (yes) localStorage.setItem(CONSENT_KEY, JSON.stringify({ version: LEGAL_VERSION, at: Date.now() }));
    else localStorage.removeItem(CONSENT_KEY);
  } catch (_) {}
}
function consentChecked() {
  const box = $('#au-consent');
  return !!(box && box.checked);
}
/* 需要同意才能继续的操作统一走这里 */
function requireConsent() {
  if (consentChecked()) return true;
  authMsg('请先阅读并勾选同意《用户协议》和《隐私政策》');
  return false;
}

/* 渲染并打开协议 / 政策弹窗 */
function openDoc(which, needAgree) {
  const d = DOCS[which];
  if (!d) return;
  const t = $('#doc-title'), b = $('#doc-body'), foot = $('#doc-foot'), m = $('#doc-modal');
  if (!t || !b || !m) return;
  t.textContent = d.title;
  b.innerHTML =
    '<p class="doc-meta">生效日期：' + LEGAL_VERSION + '</p>' +
    d.body.map((s) => '<h4>' + esc(s.h) + '</h4>' + s.p.map((x) => '<p>' + esc(x) + '</p>').join('')).join('');
  if (foot) foot.hidden = !needAgree;
  if (foot) foot.dataset.doc = which;
  m.hidden = false;
  b.scrollTop = 0;
}
function closeDoc() { const m = $('#doc-modal'); if (m) m.hidden = true; }

/* 用户点击"同意并继续"：记录同意 + 自动勾选 */
function agreeDoc() {
  setConsent(true);
  const box = $('#au-consent');
  if (box) box.checked = true;
  closeDoc();
  authMsg('已记录你的同意，可以继续操作了', 'ok');
}

/* 手机号：只接受中国大陆号段（与 SDK 的归一化规则保持一致） */
function normalizeCNPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
    .replace(/^0086/, '').replace(/^86(?=\d{11}$)/, '');
  return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
}
function phoneMask(p) {
  const s = String(p || '');
  return s.length === 11 ? s.slice(0, 3) + '****' + s.slice(7) : '—';
}


/* ============================================================
   账号（Auth）—— 登录后长期记忆才跨设备生效
   未登录 = 访客：课程照旧存在本机，老师不跨课记忆。
   ============================================================ */

function authUI() {
  const btn = $('#btn-auth');
  if (!btn) return;
  const u = state.user;
  if (u && !u.anonymous) {
    const name = (u.nickname || (u.phone ? phoneMask(u.phone) : (u.email ? String(u.email).split('@')[0] : '同学')));
    const initial = String(name).trim().charAt(0).toUpperCase() || '学';
    btn.className = 'user-chip';
    btn.innerHTML = '<span class="uc-av">' + esc(initial) + '</span>' +
      '<span class="uc-name">' + esc(name) + '</span>';
    btn.title = '已登录，点击管理账号与个人信息';
  } else {
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = '登录 / 注册';
    btn.title = '登录后，灵犀老师会跨课程记住你';
  }
}

function authMsg(text, kind) {
  const el = $('#auth-msg');
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'auth-msg ' + (kind === 'ok' ? 'ok' : 'err');
  el.textContent = text;
}

function resetMsg(text, kind) {
  const el = $('#rs-msg');
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'auth-msg ' + (kind === 'ok' ? 'ok' : 'err');
  el.textContent = text;
}

/* 短信相关错误的语义化文案：不暴露"该手机号是否已注册" */
function smsErr(e) {
  const kind = e && e.kind;
  const raw = (e && e.message) || '';
  if (/not.*(support|enable)|unsupported|not enabled|disabled/i.test(raw)) {
    return '短信登录暂未开通，请改用邮箱登录';
  }
  if (kind === 'network' || kind === 'backend-unavailable') return '网络异常，请稍后重试';
  if (/frequen|too many|rate|限|频繁/i.test(raw)) return '发送过于频繁，请稍后再试';
  if (/expired|invalid.*code|验证码/i.test(raw)) return '验证码不正确或已过期';
  return authErr(e);
}

/* 手机号验证成功后的统一收尾：补齐 phone，拉记忆 */
async function signInFromPhone(u, phone) {
  setConsent(true);          // 用户已在勾选后完成验证，落库同意状态
  const box = $('#au-consent');
  if (box) box.checked = true;
  await onSignedIn(u ? { ...u, phone: u.phone || phone } : null);
  try { await seedProfileFromLocal(); } catch (_) {}
}

/* 语义化 auth 错误：不暴露"该邮箱是否已注册" */
function authErr(e) {
  const kind = e && e.kind;
  const raw = (e && e.message) || '';
  if (kind === 'unauthenticated' || kind === 'invalid_grant') return '账号或密码不正确';
  if (kind === 'network' || kind === 'backend-unavailable') return '网络异常，请稍后重试';
  if (/rate|too many|频繁/i.test(raw)) return '操作过于频繁，请稍后再试';
  if (/expired|invalid.*code|验证码/i.test(raw)) return '验证码不正确或已过期';
  if (/password/i.test(raw) && /short|weak|least|length/i.test(raw)) return '密码至少 8 位，并包含字母和数字';
  return raw || '操作失败，请重试';
}

function openAuthModal() {
  const m = $('#auth-modal');
  if (!m) return;
  authMsg('');
  m.hidden = false;
  const e1 = $('#au-pw-email');
  if (e1) setTimeout(() => { try { e1.focus(); } catch (_) {} }, 60);
}
function closeAuthModal() {
  const m = $('#auth-modal');
  if (m) m.hidden = true;
}

function switchAuthTab(name) {
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authTab === name));
  $$('.auth-pane').forEach((p) => p.classList.toggle('active', p.id === 'auth-pane-' + name));
  authMsg('');
  // 手机号页签：若环境尚未开通短信通道，明确告知并给出可用的替代路径
  if (name === 'phone' && state.smsReady === false) {
    authMsg('短信登录暂未开通，请使用「邮箱登录」或「注册」——记忆功能完全一致', 'err');
  }
}

/* ============================================================
   会话 / 用户对象的形状适配
   依据 SDK 源码，三种返回结构并不一致，必须归一后才能用：
   · getSession().data  = { accessToken, refreshToken, expiresAt,
                            user: { id, isAnonymous, raw } }   ← user 里没有 email / phone
   · signInWithPassword / verifyOtp / signUp 的 .data 就是同一个 session 对象，
     用户位于 data.user（不存在 data.session.user）
   · getUser().data     = { id, email, phone, isAnonymous, raw } ← 唯一带 email/phone 的来源
   ============================================================ */
function pickUser(src) {
  if (!src) return null;
  const u = src.user || (src.session && src.session.user) || (src.id || src.sub ? src : null);
  if (!u) return null;
  const raw = u.raw || {};
  const meta = u.user_metadata || {};
  const id = u.id || raw.sub || raw.uid || '';
  if (!id) return null;
  return {
    id: String(id),
    email: u.email || raw.email || meta.email || null,
    phone: u.phone || normalizeCNPhone(raw.phone_number || raw.phone || '') || null,
    nickname: u.nickname || meta.nickname || null,
    anonymous: u.isAnonymous === true || u.anonymous === true,
  };
}

/* 取当前登录用户的权威资料：先 getUser（带 email/phone），不可用再退回 getSession */
async function fetchAuthUser() {
  const auth = state.cloud && state.cloud.auth;
  if (!auth) return null;
  try {
    const res = await auth.getUser();
    if (res && !res.error) { const u = pickUser(res.data); if (u) return u; }
  } catch (_) { /* 旧版 SDK / 测试桩没有 getUser 时静默退回 */ }
  try {
    const res = await auth.getSession();
    return pickUser(res && res.data);
  } catch (_) { return null; }
}

/* 合并新旧用户对象：不让降级对象（缺 email/phone）覆盖掉已拿到的完整资料 */
function mergeUser(prev, next) {
  if (!prev || !next || prev.id !== next.id) return next || prev || null;
  const out = { ...prev };
  Object.keys(next).forEach((k) => { if (next[k] != null) out[k] = next[k]; });
  return out;
}

/* 登录成功后的统一收尾：刷新 UI + 拉取记忆 */
async function onSignedIn(user) {
  let u = pickUser(user);
  // 兜底：登录接口只回 session（无 email/phone）时，再取一次权威资料；取不到才算失败
  if (!u || !u.email) {
    const full = await fetchAuthUser();
    u = mergeUser(u, full) || full || u;
  }
  if (!u) { authMsg('登录状态异常，请重试'); return; }
  state.user = mergeUser(state.user, u);
  state.memLoaded = false;
  authUI();
  closeAuthModal();
  toast('已登录，灵犀老师会一直记得你', 'ok');
  try {
    await loadMemory(true);
    renderMemoryView();
  } catch (_) {}
}

async function doSignOut() {
  if (state.cloud && state.cloud.auth) {
    try { await state.cloud.auth.signOut(); } catch (_) {}
  }
  state.user = null;
  state.mem = null;
  state.memLoaded = false;
  authUI();
  renderMemoryView();
  toast('已退出登录，老师暂时不记得你了');
}

/* 会话恢复 + 登录态监听 */
async function initAuth() {
  if (!state.cloud || !state.cloud.auth) { renderMemoryView(); return; }
  const auth = state.cloud.auth;

  try {
    // getSession 的 user 不含 email/phone，必须用 getUser 补齐，否则刷新后账号资料会丢
    const u = await fetchAuthUser();
    if (u) state.user = mergeUser(state.user, u);
  } catch (e) { console.warn('[auth] 会话恢复失败:', e); }
  authUI();

  try {
    auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        state.user = null; state.mem = null; state.memLoaded = false;
        authUI(); renderMemoryView();
      } else if (session && session.user) {
        // 事件里拿到的是 session.user（只有 id），合并保留已有的 email/phone
        const u = pickUser(session);
        if (u) {
          state.user = mergeUser(state.user, u);
          authUI();
          // 资料不完整时异步补一次，不阻塞回调
          if (!state.user.email && !state.user.phone) {
            fetchAuthUser().then((full) => {
              if (full) { state.user = mergeUser(state.user, full); authUI(); }
            }).catch(() => {});
          }
        }
      }
    });
  } catch (e) { console.warn('[auth] onAuthStateChange 失败:', e); }

  if (state.user) {
    try { await loadMemory(true); } catch (_) {}
  }
  renderMemoryView();
}

/* 访客模式：不建任何本地假身份，只是明确"不启用记忆" */
function continueAsGuest() {
  closeAuthModal();
  toast('已按访客继续，老师不会跨课程记住你');
}

function bindAuthEvents() {
  const btnAuth = $('#btn-auth');
  if (btnAuth) btnAuth.addEventListener('click', () => {
    if (state.user && !state.user.anonymous) {
      if (window.confirm('要退出登录吗？退出后灵犀老师将暂时不再跨课程记住你（记忆仍在云端，重新登录即可恢复）。')) doSignOut();
    } else {
      openAuthModal();
    }
  });
  const c1 = $('#btn-auth-close');
  if (c1) c1.addEventListener('click', closeAuthModal);
  const c2 = $('#au-skip');
  if (c2) c2.addEventListener('click', continueAsGuest);
  const am = $('#auth-modal');
  if (am) am.addEventListener('click', (ev) => { if (ev.target === am) closeAuthModal(); });

  $$('.auth-tab').forEach((t) => t.addEventListener('click', () => switchAuthTab(t.dataset.authTab)));

  const A = () => state.cloud && state.cloud.auth;

  // —— 手机号登录 / 注册（走 SDK 的 phone 通道）——
  const phSend = $('#au-ph-send');
  if (phSend) phSend.addEventListener('click', async () => {
    if (!requireConsent()) return;
    const raw = ($('#au-ph-phone').value || '').trim();
    const phone = normalizeCNPhone(raw);
    if (!phone) return authMsg('请输入正确的 11 位中国大陆手机号');
    if (!A()) return authMsg('云服务未连接，请刷新页面重试');
    phSend.disabled = true; phSend.textContent = '发送中…';
    try {
      const sent = await A().sendOtp({ phone });
      if (sent.error) {
        // 渠道未开通时记下来：切回手机号页签时能给出明确指引，而不是让用户反复试
        if (/not.*(support|enable)|unsupported|not enabled|disabled/i.test((sent.error && sent.error.message) || '')) {
          state.smsReady = false;
        }
        authMsg(smsErr(sent.error)); return;
      }
      state.smsReady = true;
      window.__phHandle = sent.data;
      $('#au-ph-step2').hidden = false;
      const tip = $('#au-ph-tip');
      if (tip) tip.textContent = '验证码已发送至 ' + phoneMask(phone) + '，5 分钟内有效。';
      authMsg(sent.data && sent.data.isExistingUser ? '验证码已发送，欢迎回来' : '验证码已发送，完成验证后将为你创建账号', 'ok');
    } catch (e) { authMsg(smsErr(e)); }
    finally { phSend.disabled = false; phSend.textContent = '重新获取验证码'; }
  });

  const phSubmit = $('#au-ph-submit');
  if (phSubmit) phSubmit.addEventListener('click', async () => {
    if (!requireConsent()) return;
    const phone = normalizeCNPhone(($('#au-ph-phone').value || '').trim());
    const token = ($('#au-ph-code').value || '').trim();
    if (!phone) return authMsg('请输入正确的手机号');
    if (!token) return authMsg('请填写短信验证码');
    if (!window.__phHandle) return authMsg('请先获取短信验证码');
    if (!A()) return authMsg('云服务未连接，请刷新页面重试');
    phSubmit.disabled = true; phSubmit.textContent = '验证中…';
    try {
      // 复用 sendOtp 返回的 verify 闭包：它会按 isExistingUser 自动走登录或注册
      const done = await window.__phHandle.verify({ token });
      if (done.error) { authMsg(smsErr(done.error)); return; }
      await signInFromPhone(pickUser(done.data), phone);
    } catch (e) { authMsg(smsErr(e)); }
    finally { phSubmit.disabled = false; phSubmit.textContent = '登录 / 注册'; }
  });

  // —— 邮箱密码登录 ——
  const pw = $('#au-pw-submit');
  if (pw) pw.addEventListener('click', async () => {
    if (!requireConsent()) return;
    const email = ($('#au-pw-email').value || '').trim();
    const password = $('#au-pw-pass').value || '';
    if (!email || !password) return authMsg('请填写邮箱和密码');
    if (!A()) return authMsg('云服务未连接，请刷新页面重试');
    pw.disabled = true; pw.textContent = '登录中…';
    try {
      const { data, error } = await A().signInWithPassword({ email, password });
      if (error) { authMsg(authErr(error)); return; }
      // 注意：返回的 data 本身就是 session（用户位于 data.user），不是 data.session.user
      await onSignedIn(pickUser(data));
    } catch (e) { authMsg(authErr(e)); }
    finally { pw.disabled = false; pw.textContent = '登录'; }
  });

  // —— 验证码登录 ——
  const otpSend = $('#au-otp-send');
  if (otpSend) otpSend.addEventListener('click', async () => {
    if (!requireConsent()) return;
    const email = ($('#au-otp-email').value || '').trim();
    if (!email) return authMsg('请填写邮箱');
    if (!A()) return authMsg('云服务未连接，请刷新页面重试');
    otpSend.disabled = true; otpSend.textContent = '发送中…';
    try {
      const started = await A().signInWithOtp({ email });
      if (started.error) { authMsg(authErr(started.error)); return; }
      window.__otpHandle = started.data;
      $('#au-otp-step2').hidden = false;
      authMsg('验证码已发送，请查收邮件（含垃圾箱）', 'ok');
    } catch (e) { authMsg(authErr(e)); }
    finally { otpSend.disabled = false; otpSend.textContent = '重新发送验证码'; }
  });
  const otpVerify = $('#au-otp-verify');
  if (otpVerify) otpVerify.addEventListener('click', async () => {
    const token = ($('#au-otp-code').value || '').trim();
    if (!token) return authMsg('请填写验证码');
    if (!window.__otpHandle) return authMsg('请先获取验证码');
    otpVerify.disabled = true; otpVerify.textContent = '验证中…';
    try {
      const done = await window.__otpHandle.verify({ token });
      if (done.error) { authMsg(authErr(done.error)); return; }
      await onSignedIn(pickUser(done.data));
    } catch (e) { authMsg(authErr(e)); }
    finally { otpVerify.disabled = false; otpVerify.textContent = '验证并登录'; }
  });

  // —— 注册（OTP 验证 + 设置密码）——
  const suSend = $('#au-su-send');
  if (suSend) suSend.addEventListener('click', async () => {
    if (!requireConsent()) return;
    const email = ($('#au-su-email').value || '').trim();
    if (!email) return authMsg('请填写邮箱');
    if (!A()) return authMsg('云服务未连接，请刷新页面重试');
    suSend.disabled = true; suSend.textContent = '发送中…';
    try {
      const sent = await A().sendOtp({ email });
      if (sent.error) { authMsg(authErr(sent.error)); return; }
      // 已是老用户：不暴露账号存在性，引导到登录
      if (sent.data.isExistingUser) {
        authMsg('这个邮箱已有账号，请直接登录（已切到密码登录）', 'ok');
        switchAuthTab('password');
        const pe = $('#au-pw-email');
        if (pe) pe.value = email;
        return;
      }
      window.__suHandle = sent.data;
      $('#au-su-step2').hidden = false;
      authMsg('验证码已发送，请查收邮件', 'ok');
    } catch (e) { authMsg(authErr(e)); }
    finally { suSend.disabled = false; suSend.textContent = '重新发送验证码'; }
  });
  const suSubmit = $('#au-su-submit');
  if (suSubmit) suSubmit.addEventListener('click', async () => {
    const token = ($('#au-su-code').value || '').trim();
    const password = $('#au-su-pass').value || '';
    const email = ($('#au-su-email').value || '').trim();
    if (!token) return authMsg('请填写验证码');
    if (!password || password.length < 8) return authMsg('密码至少 8 位，并包含字母和数字');
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return authMsg('密码需同时包含字母和数字');
    if (!window.__suHandle) return authMsg('请先获取验证码');
    suSubmit.disabled = true; suSubmit.textContent = '注册中…';
    try {
      const done = await A().verifyOtp({
        verificationId: window.__suHandle.verificationId,
        token,
        email,
        isExistingUser: false,
        password,
      });
      if (done.error) { authMsg(authErr(done.error)); return; }
      const u = pickUser(done.data);
      await onSignedIn(u ? { ...u, nickname: u.nickname || String(email).split('@')[0] } : null);
      try { await seedProfileFromLocal(); } catch (_) {}
    } catch (e) { authMsg(authErr(e)); }
    finally { suSubmit.disabled = false; suSubmit.textContent = '注册并登录'; }
  });

  // —— 忘记密码 ——
  const forgot = $('#au-forgot');
  if (forgot) forgot.addEventListener('click', () => {
    closeAuthModal();
    resetMsg('');
    const rm = $('#reset-modal');
    if (rm) rm.hidden = false;
    const e = $('#rs-email');
    if (e) e.value = ($('#au-pw-email').value || '').trim();
  });
  const rc = $('#btn-reset-close');
  if (rc) rc.addEventListener('click', () => { const m = $('#reset-modal'); if (m) m.hidden = true; });
  const rmm = $('#reset-modal');
  if (rmm) rmm.addEventListener('click', (ev) => { if (ev.target === rmm) rmm.hidden = true; });

  const rsSend = $('#rs-send');
  if (rsSend) rsSend.addEventListener('click', async () => {
    const email = ($('#rs-email').value || '').trim();
    if (!email) return resetMsg('请填写邮箱');
    if (!A()) return resetMsg('云服务未连接，请刷新页面重试');
    rsSend.disabled = true; rsSend.textContent = '发送中…';
    try {
      const started = await A().resetPasswordForEmail(email);
      if (started.error) { resetMsg(authErr(started.error)); return; }
      window.__rsHandle = started.data;
      $('#rs-step2').hidden = false;
      resetMsg('验证码已发送，请查收邮件', 'ok');
    } catch (e) { resetMsg(authErr(e)); }
    finally { rsSend.disabled = false; rsSend.textContent = '重新发送验证码'; }
  });
  const rsSubmit = $('#rs-submit');
  if (rsSubmit) rsSubmit.addEventListener('click', async () => {
    const nonce = ($('#rs-code').value || '').trim();
    const password = $('#rs-pass').value || '';
    if (!nonce) return resetMsg('请填写验证码');
    if (!password || password.length < 8) return resetMsg('新密码至少 8 位，并包含字母和数字');
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return resetMsg('新密码需同时包含字母和数字');
    if (!window.__rsHandle) return resetMsg('请先获取验证码');
    rsSubmit.disabled = true; rsSubmit.textContent = '提交中…';
    try {
      const done = await window.__rsHandle.updateUser({ nonce, password });
      if (done.error) { resetMsg(authErr(done.error)); return; }
      const m = $('#reset-modal'); if (m) m.hidden = true;
      toast('密码已重置并登录', 'ok');
      await onSignedIn(await fetchAuthUser());
    } catch (e) { resetMsg(authErr(e)); }
    finally { rsSubmit.disabled = false; rsSubmit.textContent = '重置密码并登录'; }
  });
}

/* 首次登录时，用本机已有课程把画像填个初值（只在画像为空时执行） */
async function seedProfileFromLocal() {
  if (!memReady()) return;
  const m = await loadMemory(true);
  if (m && m.profile) return;   // 已有画像，不覆盖
  const last = (state.courses && state.courses.length) ? state.courses[state.courses.length - 1] : null;
  if (!last) return;
  await saveProfile({
    grade: last.grade || null,
    system: last.systemName || null,
    goal: last.goal || null,
    level: last.level || null,
    teaching_style: guideProfile().name,
    pace: '默认',
  });
}


/* ============================================================
   账号与个人信息（PIPL 权利落地）
   查阅 / 复制 / 更正 / 删除 / 注销 —— 全部在界面内可自助完成
   ============================================================ */

function acctMsg(text, kind) {
  const el = $('#acct-msg');
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'auth-msg ' + (kind === 'ok' ? 'ok' : 'err');
  el.textContent = text;
}

function openAccountModal() {
  const m = $('#account-modal');
  if (!m) return;
  acctMsg('');
  const u = state.user || {};
  const idEl = $('#acct-ident');
  if (idEl) {
    // 只显示脱敏后的账号标识，避免完整手机号/邮箱出现在界面上被旁人看到
    idEl.textContent = u.phone ? phoneMask(u.phone) : (u.email ? String(u.email).replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : '—');
  }
  const memEl = $('#acct-mem');
  if (memEl) {
    const f = (state.mem && Array.isArray(state.mem.facts)) ? state.mem.facts.length : 0;
    const s = (state.mem && Array.isArray(state.mem.sessions)) ? state.mem.sessions.length : 0;
    memEl.textContent = f + ' 条记忆 · ' + s + ' 节课记录';
  }
  m.hidden = false;
}
function closeAccountModal() { const m = $('#account-modal'); if (m) m.hidden = true; }

/* 导出：把云端 + 本机属于本人的全部数据打包成 JSON 交给用户（PIPL 查阅复制权） */
async function exportMyData() {
  if (!state.user) { acctMsg('请先登录'); return; }
  acctMsg('正在整理你的数据…', 'ok');
  const out = {
    exportedAt: new Date().toISOString(),
    legalVersion: LEGAL_VERSION,
    account: { id: state.user.id, phone: state.user.phone || null, email: state.user.email || null },
    memory: {},
    localCourses: [],
  };
  try {
    const m = await loadMemory(true);
    out.memory = {
      profile: (m && m.profile) || null,
      facts: (m && m.facts) || [],
      sessions: (m && m.sessions) || [],
    };
  } catch (e) { out.memory = { error: String(e && e.message || e) }; }

  try {
    out.localCourses = (state.courses || []).map((c) => ({
      id: c.id, title: c.title, subject: c.subject, grade: c.grade,
      system: c.systemName, createdAt: c.createdAt,
      outline: c.outline || null, slides: c.slides || [],
    }));
  } catch (_) {}

  try {
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lingxi-my-data-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    acctMsg('已导出，请查看下载文件', 'ok');
  } catch (e) {
    acctMsg('导出失败，请稍后重试');
  }
}

/* 注销：删除云端全部个人数据（画像/记忆/课堂记录），并清空本机课程 */
async function deleteMyAccount() {
  if (!state.user) { acctMsg('请先登录'); return; }
  const ok1 = window.confirm(
    '⚠️ 注销将永久删除以下数据，且不可恢复：\n\n' +
    '· 学生画像与全部「老师记住的事」\n' +
    '· 全部上课记录与课堂回放\n' +
    '· 本机保存的课程\n\n' +
    '注销后仍可用同一登录方式重新登录，但那将是一个没有任何学习记录的空白账号。\n' +
    '如需连同登录方式本身一并删除，请在注销后联系我们。\n\n' +
    '确定要继续吗？'
  );
  if (!ok1) return;
  const typed = window.prompt('请输入「确认注销」四个字以最终确认：');
  if (typed !== '确认注销') { acctMsg('输入不匹配，已取消注销'); return; }

  acctMsg('正在删除你的数据…', 'ok');
  const db = state.cloud && state.cloud.database;
  const errs = [];
  if (db) {
    for (const t of ['student_facts', 'student_sessions', 'student_profiles']) {
      try {
        const res = await db.from(t).delete().eq('owner_id', state.user.id).select('id');
        // 空数组说明没有可删的行（或已被 RLS 挡下）；不当成错误，但记录下来便于排查
        if (res && res.error) errs.push(t + ': ' + (res.error.message || 'error'));
      } catch (e) { errs.push(t + ': ' + (e && e.message || e)); }
    }
  } else {
    errs.push('云端未连接');
  }

  // 清空本机数据
  try { localStorage.removeItem('lingxi_courses_v1'); } catch (_) {}
  state.courses = [];
  try { renderCourses(); } catch (_) {}

  // 撤销同意标记
  setConsent(false);

  try { await state.cloud.auth.signOut(); } catch (_) {}
  state.user = null; state.mem = null; state.memLoaded = false;
  authUI(); renderMemoryView();
  closeAccountModal();

  if (errs.length) {
    toast('本机数据已清除，云端部分数据删除失败，请重试', 'err');
    console.warn('[account] 删除异常:', errs);
  } else {
    toast('账号已注销，全部个人数据已删除', 'ok');
  }
}


/* 协议 / 政策 / 账号面板的事件绑定 */
function bindLegalEvents() {
  // 页面上所有 data-doc 入口（注册勾选框、页脚）
  document.body.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-doc]');
    if (!a) return;
    ev.preventDefault();
    // 从注册勾选框里点开时，带上"同意并继续"按钮，读完即可一步同意
    const inConsent = !!ev.target.closest('#au-consent-wrap');
    openDoc(a.dataset.doc, inConsent);
  });
  const c = $('#btn-doc-close'); if (c) c.addEventListener('click', closeDoc);
  const cancel = $('#btn-doc-cancel'); if (cancel) cancel.addEventListener('click', closeDoc);
  const agree = $('#btn-doc-agree'); if (agree) agree.addEventListener('click', agreeDoc);
  const dm = $('#doc-modal');
  if (dm) dm.addEventListener('click', (ev) => { if (ev.target === dm) closeDoc(); });

  const ac = $('#btn-acct-close'); if (ac) ac.addEventListener('click', closeAccountModal);
  const am = $('#account-modal');
  if (am) am.addEventListener('click', (ev) => { if (ev.target === am) closeAccountModal(); });
  const exp = $('#btn-acct-export'); if (exp) exp.addEventListener('click', exportMyData);
  const del = $('#btn-acct-delete'); if (del) del.addEventListener('click', deleteMyAccount);
  const tBtn = $('#btn-acct-terms'); if (tBtn) tBtn.addEventListener('click', () => openDoc('terms', false));
  const pBtn = $('#btn-acct-privacy'); if (pBtn) pBtn.addEventListener('click', () => openDoc('privacy', false));

  const memAcct = $('#btn-mem-account'); if (memAcct) memAcct.addEventListener('click', openAccountModal);
}


/* 课程体系：国内 + 国际 */
const SYSTEMS = [
  {
    id: 'cn',
    name: '国内课程',
    short: '国内',
    ico: '🇨🇳',
    desc: '中高考 · 同步辅导 · 竞赛',
    grades: ['小学', '初中', '高中', '大学 / 成人'],
    stages: [
      { name: '小学', ico: '🎒' },
      { name: '初中', ico: '📗' },
      { name: '高中', ico: '📘' },
      { name: '大学 / 成人', ico: '🎓' },
    ],
    subjects: [
      { name: '数学', ico: '📐', color: '#EEEDFD', desc: '代数 · 几何 · 函数' },
      { name: '英语', ico: '🔤', color: '#FFF1E6', desc: '语法 · 词汇 · 听说' },
      { name: '语文', ico: '📖', color: '#FEF3C7', desc: '阅读 · 写作 · 文言' },
      { name: '物理', ico: '⚛️', color: '#E0F2FE', desc: '力学 · 电学 · 实验' },
      { name: '化学', ico: '🧪', color: '#D9F6F1', desc: '方程 · 实验 · 推断' },
      { name: '生物', ico: '🌿', color: '#DCFCE7', desc: '细胞 · 遗传 · 生态' },
      { name: '历史', ico: '🏛️', color: '#FFE4E6', desc: '脉络 · 史料 · 答题' },
      { name: '地理', ico: '🌏', color: '#E0F2FE', desc: '自然 · 人文 · 图表' },
      { name: '编程', ico: '💻', color: '#EDE9FE', desc: 'Python · 算法启蒙' },
      { name: '竞赛数学', ico: '🏆', color: '#FEF3C7', desc: '奥数 · 思维 · 压轴' },
    ],
    goals: [
      '同步课内进度，把没听懂的地方补上',
      '月考 / 期中期末考试冲刺，主攻失分点',
      '中考 / 高考系统复习，按考纲梳理考点',
      '奥数思维训练，冲击竞赛奖项',
    ],
  },
  {
    id: 'intl',
    name: '国际课程',
    short: '国际',
    ico: '🌐',
    desc: 'IB · A-Level · HKDSE · AP',
    // 国际考纲/考试局：用户可多选，AI 按考纲授课
    boards: [
      { id: 'ib', name: 'IB', full: 'IB DP', ico: '🌍', desc: 'MYP / DP · HL SL · IA/EE', marks: ['IB DP (HL/SL)', 'MYP'] },
      { id: 'alevel', name: 'A-Level', full: 'A-Level', ico: '🇬🇧', desc: 'CAIE · Edexcel · A2/AS', marks: ['A-Level (AS/A2)', 'IGCSE'] },
      { id: 'hkdse', name: 'HKDSE', full: 'HKDSE 香港中学文凭', ico: '🇭🇰', desc: '香港文凭试 · 核心+选修', marks: ['HKDSE 香港中学文凭'] },
      { id: 'ap', name: 'AP', full: 'AP', ico: '🇺🇸', desc: 'College Board · 5 分制', marks: ['AP'] },
    ],
    grades: ['IGCSE / MYP', 'AS / A2 / DP1-2', '本科 / 研究生', '标化与竞赛备考'],
    subjects: [
      { name: 'Mathematics 数学', ico: '📐', color: '#EEEDFD', desc: 'AA/AI · Pure · Calculus', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Further Math 进阶数学', ico: '🧮', color: '#EDE9FE', desc: 'Further Pure · 向量矩阵', boards: ['alevel', 'hkdse'] },
      { name: 'English 英语', ico: '🔤', color: '#FFF1E6', desc: 'Lang & Lit · Paper 1/2', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Physics 物理', ico: '⚛️', color: '#E0F2FE', desc: 'Mechanics · Fields · 实验', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Chemistry 化学', ico: '🧪', color: '#D9F6F1', desc: 'Organic · 机理 · 实验', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Biology 生物', ico: '🌿', color: '#DCFCE7', desc: 'Cell · Genetics · 生态', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Economics 经济', ico: '📈', color: '#FEF3C7', desc: 'Micro · Macro · 图表题', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Business 商科', ico: '💼', color: '#E0F2FE', desc: 'Case · Finance · 分析', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'CS 计算机', ico: '💻', color: '#EDE9FE', desc: 'Python · Java · 算法', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'History 历史', ico: '🏛️', color: '#FFE4E6', desc: 'Source · Essay 论文', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: 'Geography 地理', ico: '🌏', color: '#E0F2FE', desc: 'Human · Physical · 数据', boards: ['ib', 'alevel', 'hkdse', 'ap'] },
      { name: '中文 Chinese', ico: '📖', color: '#FEF3C7', desc: 'HKDSE 中文 · IB 中文', boards: ['hkdse', 'ib', 'alevel'] },
      { name: '公民与社会 CSD', ico: '🤝', color: '#FFE4E6', desc: 'HKDSE 公民与社会发展', boards: ['hkdse'] },
      { name: 'IELTS / TOEFL', ico: '🎧', color: '#DCFCE7', desc: '听说读写 · 冲分' },
      { name: 'SAT / ACT', ico: '✏️', color: '#FFF1E6', desc: 'Reading · Math · 文法' },
      { name: 'AMC 竞赛', ico: '🏆', color: '#FEF3C7', desc: 'AMC/AIME · 逻辑推理' },
    ],
    goals: [
      'IB：跟上 DP 进度，把概念彻底讲清楚，理清 IA/EE 选题',
      'A-Level：按 CAIE/Edexcel 考纲过一遍重点，刷 past papers',
      'HKDSE：核心科目与选修一起冲 Level 5**，主攻 Paper 2 选择题',
      'AP：备考 5 月大考，冲 5 分，重点攻克 FRQ 自由问答题',
      '标化考试冲分，突破瓶颈分数段',
    ],
  },
];
const SUBJECTS = SYSTEMS.flatMap((s) => s.subjects);
function getSystem(id) { return SYSTEMS.find((s) => s.id === id) || SYSTEMS[0]; }
function getBoards(sys) { return sys.boards || []; }

/* ---------- 小工具 ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function mdLite(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
/* 统计一节课件里的练习题数量 */
function quizCountOf(course) {
  const slides = (course && course.slides) || [];
  return slides.filter((s) => s && s.type === 'quiz' && s.question).length;
}
function toast(text, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = text;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 3200);
  setTimeout(() => el.remove(), 3700);
}
/* ============================================================
   语音合成（TTS）：让灵犀老师真的开口讲课
   使用浏览器内置 SpeechSynthesis，零成本、零依赖
   ============================================================ */
const TTS = {
  // 只有真正拿到了可用对象才算支持（某些环境属性存在但为 null）
  supported: typeof window !== 'undefined' && !!window.speechSynthesis &&
    typeof window.speechSynthesis.speak === 'function',
  voice: null,
  enabled: false,      // 用户是否开启朗读
  speaking: false,
  rate: 1.0,
  queue: [],           // 待朗读句子
  _speakingNow: false,
};

/* 挑选一个中文女声（各平台名称不同，做优先级匹配） */
function pickVoice() {
  if (!TTS.supported || !window.speechSynthesis) return null;
  let vs = [];
  try { vs = window.speechSynthesis.getVoices() || []; } catch (_) { return null; }
  if (!vs.length) return null;
  const prefer = [
    /Xiaoxiao|晓晓/i, /Xiaoyi|晓伊/i, /Huihui|慧慧/i, /Yaoyao|瑶瑶/i,
    /Tingting|婷婷/i, /Mei[i-]?Jia|美佳/i, /Sinji|善怡/i,
    /Chinese.*(Female|女)/i, /zh[-_]CN/i, /zh[-_]HK/i, /zh/i,
  ];
  for (const re of prefer) {
    const v = vs.find((x) => re.test(x.name) || re.test(x.lang));
    if (v) return v;
  }
  return vs[0];
}

function initTTS() {
  if (!TTS.supported || TTS._inited) return;
  TTS._inited = true;
  try {
    TTS.voice = pickVoice();
    // 部分浏览器 voice 列表异步就绪
    window.speechSynthesis.onvoiceschanged = () => { TTS.voice = TTS.voice || pickVoice(); };
    if (!TTS.voice) {
      setTimeout(() => { try { TTS.voice = pickVoice(); } catch (_) {} }, 600);
    }
  } catch (e) { console.warn('TTS 初始化失败，已降级为无语音', e); }
}

/* 提取文本中"已完整结束"的句子（末尾标点闭合），用于增量朗读 */
function completeSentences(text) {
  const out = [];
  const re = /[^。！？!?；;\n]*[。！？!?；;]/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const s = m[0].replace(/[*#`>_~]/g, '').trim();
    if (s.length > 1) out.push(s);
  }
  return out;
}

/* 把长文切成适合朗读的短句 */
function splitSentences(text) {
  return String(text || '')
    .replace(/[*#`>_~]/g, '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/* 讲一句（内部） */
function speakOne(text) {
  return new Promise((resolve) => {
    if (!TTS.supported || !TTS.enabled || !text) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (TTS.voice) u.voice = TTS.voice;
    u.lang = (TTS.voice && TTS.voice.lang) || 'zh-CN';
    u.rate = TTS.rate;
    u.pitch = 1.06;
    u.volume = 1;
    u.onend = () => { TTS._speakingNow = false; resolve(); };
    u.onerror = () => { TTS._speakingNow = false; resolve(); };
    TTS._speakingNow = true;
    try { window.speechSynthesis.speak(u); } catch (_) { resolve(); }
  });
}

/* 入口：把一段文本加入朗读队列（顺序播放，不叠音） */
function speak(text) {
  if (!TTS.supported || !TTS.enabled) return;
  const parts = splitSentences(text);
  if (!parts.length) return;
  TTS.queue.push(...parts);
  if (!TTS.speaking) drainSpeechQueue();
}

async function drainSpeechQueue() {
  if (TTS.speaking) return;
  TTS.speaking = true;
  setSpeakingUI(true);
  while (TTS.queue.length && TTS.enabled) {
    const s = TTS.queue.shift();
    await speakOne(s);
  }
  TTS.speaking = false;
  setSpeakingUI(false);
}

function stopSpeech() {
  TTS.queue.length = 0;
  TTS.speaking = false;
  TTS._speakingNow = false;
  if (TTS.supported) { try { window.speechSynthesis.cancel(); } catch (_) {} }
  setSpeakingUI(false);
}

function toggleTTS(on) {
  TTS.enabled = typeof on === 'boolean' ? on : !TTS.enabled;
  const btn = $('#tb-voice');
  if (btn) {
    btn.classList.toggle('active', TTS.enabled);
    btn.querySelector('.mt-ico').textContent = TTS.enabled ? '🔊' : '🔈';
    btn.querySelector('.mt-label').textContent = TTS.enabled ? '朗读中' : '语音';
  }
  try { localStorage.setItem('lingxi_tts', TTS.enabled ? '1' : '0'); } catch (_) {}
  if (!TTS.enabled) { stopSpeech(); toast('已关闭语音朗读'); return; }
  if (!TTS.supported) { toast('当前浏览器不支持语音朗读', 'err'); TTS.enabled = false; return; }
  if (!TTS.voice) TTS.voice = pickVoice();
  // 浏览器要求首次发音由用户手势触发，这里正是点击事件，可安全"解锁"
  try {
    const warm = new SpeechSynthesisUtterance(' ');
    warm.volume = 0;
    window.speechSynthesis.speak(warm);
  } catch (_) {}
  toast('已开启老师语音朗读（首次可能需 1 秒）', 'ok');
}

/* 恢复上次的语音偏好 */
function restoreTTSPref() {
  if (!TTS.supported) return;
  let saved = null;
  try { saved = localStorage.getItem('lingxi_tts'); } catch (_) {}
  if (saved === '1') {
    TTS.enabled = true;
    const btn = $('#tb-voice');
    if (btn) {
      btn.classList.add('active');
      btn.querySelector('.mt-ico').textContent = '🔊';
      btn.querySelector('.mt-label').textContent = '朗读中';
    }
  }
}

/* ---------- 教学引导强度（苏格拉底支持等级） ---------- */
function setGuide(level, opts) {
  const o = opts || {};
  if (!GUIDE_PROFILES[level]) level = 'balanced';
  state.guide = level;
  try { localStorage.setItem('lingxi_guide', level); } catch (_) {}
  renderGuideBtn();
  if (o.silent) return;
  const g = GUIDE_PROFILES[level];
  toast('已切换为「' + g.name + '」：' + g.tip, 'ok');
  // 让老师立刻感知到新的支持等级（隐藏指令，学生看不到）
  if (state.live && !state.live.ended) {
    sendLive('（学生把引导强度调整成了「' + g.name + '」。请从下一句开始就按新的节奏来，' +
      '不要解释这条设置。）', { hidden: true });
  }
}

function renderGuideBtn() {
  const btn = $('#tb-guide');
  if (!btn) return;
  const g = guideProfile();
  const ico = { more: '🤝', balanced: '⚖️', less: '🎯' }[state.guide] || '⚖️';
  const i = btn.querySelector('.mt-ico');
  const l = btn.querySelector('.mt-label');
  if (i) i.textContent = ico;
  if (l) l.textContent = g.name;
  btn.title = '引导强度：' + g.name + '（' + g.tip + '）';
  btn.classList.toggle('active', state.guide !== 'balanced');
}

function restoreGuidePref() {
  let saved = null;
  try { saved = localStorage.getItem('lingxi_guide'); } catch (_) {}
  if (saved && GUIDE_PROFILES[saved]) state.guide = saved;
  let meta = null;
  try { meta = localStorage.getItem('lingxi_meta'); } catch (_) {}
  if (meta === '0') state.meta = false;
  renderGuideBtn();
}

function toggleMeta(on) {
  state.meta = typeof on === 'boolean' ? on : !state.meta;
  try { localStorage.setItem('lingxi_meta', state.meta ? '1' : '0'); } catch (_) {}
  const btn = $('#guide-meta');
  if (btn) {
    btn.classList.toggle('on', state.meta);
    btn.setAttribute('aria-checked', state.meta ? 'true' : 'false');
  }
  toast(state.meta ? '已开启元认知提问：老师会常问"你卡在哪一步"' : '已关闭元认知提问');
}

/* 引导强度选择面板 */
function openGuideModal() {
  const m = $('#guide-modal');
  if (!m) return;
  const wrap = $('#guide-options');
  if (wrap) {
    wrap.innerHTML = Object.keys(GUIDE_PROFILES).map((k) => {
      const g = GUIDE_PROFILES[k];
      const ico = { more: '🤝', balanced: '⚖️', less: '🎯' }[k];
      return `<button class="guide-opt${state.guide === k ? ' cur' : ''}" data-guide="${k}">
        <span class="go-ico">${ico}</span>
        <span class="go-body"><b>${esc(g.name)}</b><small>${esc(g.tip)}</small></span>
        <span class="go-check">${state.guide === k ? '✓' : ''}</span>
      </button>`;
    }).join('');
  }
  m.hidden = false;
}
function closeGuideModal() {
  const m = $('#guide-modal');
  if (m) m.hidden = true;
}

/* 头像"开口说话"的视觉联动 */
function setSpeakingUI(on) {
  const av = $('#teacher-avatar');
  if (av) av.classList.toggle('talking', !!on);
  const wave = $('#voice-wave');
  if (wave && on) wave.classList.add('on');
  else if (wave && !on && !(state.live && state.live.busy)) wave.classList.remove('on');
  // 参会者列表里的老师状态
  const badge = $('#p-teacher-state');
  if (badge) badge.textContent = on ? '正在讲话' : '主讲 · AI 教师';
}

/* ============================================================
   多学生参会者 + 宫格视图
   ============================================================ */
const PEER_NAMES = ['小美', '子航', '若曦', '嘉禾', '一诺', '思远', '雨桐', '承宇'];
const PEER_AVATAR_COLORS = ['#F472B6', '#34D399', '#FBBF24', '#60A5FA', '#A78BFA', '#FB923C'];

/* 新参会者对象 */
function makePeer(name, idx) {
  return {
    id: 'peer-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    name: name || PEER_NAMES[idx % PEER_NAMES.length],
    color: PEER_AVATAR_COLORS[idx % PEER_AVATAR_COLORS.length],
    muted: Math.random() < 0.45,
    handUp: false,
    camOn: Math.random() < 0.7,
    isMe: false,
    isTeacher: false,
  };
}

/* 我的参会者对象 */
function mePeer() {
  const live = state.live;
  return {
    id: 'me', name: '你', color: '#6366F1', isMe: true,
    muted: live ? !!live.muted : false,
    handUp: live ? !!live.handUp : false,
    camOn: true,
  };
}

function teacherPeer() {
  return { id: 'teacher', name: '灵犀老师', color: '#F97316', isTeacher: true, muted: false, camOn: true };
}

/* 全部参会者（老师 + 我 + 同学们） */
function allPeers() {
  const live = state.live;
  if (!live) return [];
  return [teacherPeer(), mePeer(), ...(live.peers || [])];
}

/* 邀请一位同学加入 */
function invitePeer() {
  const live = state.live;
  if (!live) return;
  if (!live.peers) live.peers = [];
  if (live.peers.length >= 6) { toast('课堂最多 8 人（含老师和助教）'); return; }
  const p = makePeer(null, live.peers.length);
  live.peers.push(p);
  renderPeople();
  renderGallery();
  updatePeerCount();
  toast('「' + p.name + '」已加入课堂', 'ok');
  // 老师欢迎新同学
  if (!live.busy) {
    sendLive('（新同学 ' + p.name + ' 刚进入课堂，请简短欢迎一下，并问他/她是否跟得上。）', { hidden: true });
  }
}

/* 移除参会者 */
function removePeer(id) {
  const live = state.live;
  if (!live || !live.peers) return;
  const i = live.peers.findIndex((p) => p.id === id);
  if (i < 0) return;
  const name = live.peers[i].name;
  live.peers.splice(i, 1);
  renderPeople();
  renderGallery();
  updatePeerCount();
  toast('「' + name + '」已离开课堂');
}

function updatePeerCount() {
  const n = allPeers().length;
  const c = $('#people-count');
  if (c) c.textContent = String(n);
  const g = $('#gal-count');
  if (g) g.textContent = String(n);
}

/* 渲染参会者列表 */
function renderPeople() {
  const list = $('#people-list');
  if (!list) return;
  const live = state.live;
  if (!live) return;
  const peers = allPeers();
  list.innerHTML = peers.map((p) => {
    const badge = p.isTeacher
      ? '<small id="p-teacher-state">' + (TTS.speaking ? '正在讲话' : '主讲 · AI 教师') + '</small>'
      : p.isMe
        ? '<small>学生 · 参会者</small>'
        : '<small>学生 · 受邀参会' + (p.handUp ? ' · ✋ 已举手' : '') + '</small>';
    const av = p.isMe ? '我' : p.isTeacher ? '灵' : esc(p.name.slice(0, 1));
    const avCls = p.isTeacher ? 'p-host' : p.isMe ? 'p-me' : 'p-peer';
    const avStyle = (!p.isTeacher && !p.isMe) ? ' style="background:' + p.color + '"' : '';
    const micId = p.isTeacher ? ' id="p-teacher-mic"'
      : p.isMe ? ' id="p-me-mic"' : '';
    const mic = (p.isMe ? live.muted : p.muted)
      ? '<span class="p-mic off"' + micId + '>🔇</span>'
      : '<span class="p-mic on"' + micId + '>🎙</span>';
    const hand = p.handUp ? '<span class="p-hand">✋</span>' : '';
    const kick = (!p.isTeacher && !p.isMe)
      ? '<button class="p-kick" data-kick="' + esc(p.id) + '" title="移出课堂">✕</button>' : '';
    return '<div class="person">' +
      '<span class="p-avatar ' + avCls + '"' + avStyle + '>' + av + '</span>' +
      '<div class="p-info"><b>' + esc(p.name) + '</b>' + badge + '</div>' +
      hand + mic + kick + '</div>';
  }).join('');
}

/* 渲染宫格 */
function renderGallery() {
  const grid = $('#gal-grid');
  if (!grid) return;
  const peers = allPeers();
  const n = peers.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  grid.innerHTML = peers.map((p) => {
    const isSpeaking = p.isTeacher && (TTS.speaking || (state.live && state.live.busy));
    const off = !p.camOn;
    const av = p.isMe ? '我' : p.isTeacher ? '灵' : esc(p.name.slice(0, 1));
    const bg = p.isTeacher ? '#EEF0FF' : p.isMe ? '#EEF0FF' : p.color + '33';
    const fg = p.isTeacher ? '#6366F1' : p.isMe ? '#6366F1' : p.color;
    // 老师格子：有真人形象就显示照片
    const camInner = (p.isTeacher && AVATAR.ready)
      ? '<img class="gal-photo" src="' + AVATAR.thumb + '" alt="">' +
        (off ? '<span class="gal-off">摄像头已关闭</span>' : '')
      : '<span class="gal-av" style="background:' + bg + ';color:' + fg + '">' + av + '</span>' +
        (off ? '<span class="gal-off">摄像头已关闭</span>' : '');
    return '<div class="gal-tile' + (isSpeaking ? ' speaking' : '') + (off ? ' cam-off' : '') + '">' +
      '<div class="gal-cam">' + camInner + '</div>' +
      '<div class="gal-bar">' +
        '<span class="gal-name">' + esc(p.name) + (p.isTeacher ? ' <em>（主讲）</em>' : '') + '</span>' +
        '<span class="gal-mic">' + ((p.isMe ? state.live && state.live.muted : p.muted) ? '🔇' : '🎙') + '</span>' +
      '</div>' +
      (p.handUp ? '<span class="gal-hand">✋</span>' : '') +
      (isSpeaking ? '<div class="gal-wave"><i></i><i></i><i></i><i></i></div>' : '') +
      '</div>';
  }).join('');
}

function toggleGallery(force) {
  const g = $('#meet-gallery');
  if (!g) return;
  const show = typeof force === 'boolean' ? force : g.hidden;
  g.hidden = !show;
  const btn = $('#tb-gallery');
  if (btn) {
    btn.classList.toggle('active', show);
    btn.querySelector('.mt-label').textContent = show ? '返回画面' : '宫格';
  }
  if (show) renderGallery();
}

/* 参会者角色扮演：让某位同学"发言" */
async function peerAsk(id, question) {
  const live = state.live;
  if (!live || live.busy) return;
  const p = (live.peers || []).find((x) => x.id === id);
  if (!p) return;
  appendMessage('user', p.name + '：' + question, 'peer-msg');
  recordEvent('ask', question, { who: p.name });
  if (TTS.enabled) setCaptions(p.name + ' 正在提问…');
  await sendLive('（同学【' + p.name + '】举手提问："' + question + '"。请以老师身份先回应这位同学，' +
    '再顺势照顾一下全班其他同学的进度。）', { hidden: true, asPeer: p.name });
}

/* ============================================================
   课堂回放：录制时间轴事件（翻页 / 发言），课后可回放
   ============================================================ */
function recordEvent(type, payload, extra) {
  const live = state.live;
  if (!live || !live.recStart) return;
  const t = (Date.now() - live.recStart) / 1000;
  const ev = Object.assign({ t: Math.round(t * 10) / 10, type: type, v: payload }, extra || {});
  live.recording.push(ev);
}

/* 保存回放数据到课程对象（localStorage） */
function persistRecording(course, recording, durationSec) {
  if (!recording || !recording.length) return;
  course.replay = {
    duration: Math.round(durationSec),
    events: recording,
    createdAt: Date.now(),
  };
  const idx = state.courses.findIndex((c) => c.id === course.id);
  if (idx >= 0) { state.courses[idx] = course; }
  try {
    localStorage.setItem('lingxi_courses_v1', JSON.stringify(state.courses));
  } catch (_) {}
}

/* ---------- 回放播放器 ---------- */
const replay = {
  course: null,
  events: [],
  duration: 0,
  t: 0,
  playing: false,
  speed: 1,
  raf: null,
  lastTick: 0,
  lastApplied: -1,   // 上一次应用的播放位置（用于判断是否需要回退重建）
  cursor: 0,         // 已应用事件指针
};

function openReplay(course) {
  if (!course || !course.replay || !course.replay.events || !course.replay.events.length) {
    toast('这节课还没有回放记录', 'err');
    return;
  }
  replay.course = course;
  replay.events = course.replay.events;
  replay.duration = course.replay.duration || Math.max(1, replay.events[replay.events.length - 1].t);
  replay.t = 0;
  replay.playing = false;
  replay.cursor = 0;

  $('#replay-modal').hidden = false;
  $('#replay-title').textContent = '⏺ 回放 · ' + course.title;
  $('#rp-seek').max = String(Math.max(1, Math.round(replay.duration)));
  $('#rp-seek').value = '0';
  renderReplayMeta();
  renderReplayTimeline();
  applyReplayTo(0, true);
  updateReplayTime();

  // 若已有数字人视频，作为回放主画面
  if (course.avatarVideo) {
    renderReplayVideo(course);
  }
}

function renderReplayMeta() {
  const c = replay.course;
  const evs = replay.events;
  const talkCount = evs.filter((e) => e.type === 'speak').length;
  const slideCount = (c.slides || []).length;
  $('#replay-meta').innerHTML =
    '<div class="rm-row"><span>课程</span><b>' + esc(c.title) + '</b></div>' +
    '<div class="rm-row"><span>时长</span><b>' + fmtTime(replay.duration) + '</b></div>' +
    '<div class="rm-row"><span>课件</span><b>' + slideCount + ' 页</b></div>' +
    '<div class="rm-row"><span>讲解</span><b>' + talkCount + ' 段</b></div>' +
    '<div class="rm-row"><span>录制</span><b>' + fmtDate((c.replay && c.replay.createdAt) || Date.now()) + '</b></div>' +
    (c.avatarVideo ? '<div class="rm-row"><span>数字人</span><b class="rm-ok">已生成</b></div>' : '');
}

function renderReplayTimeline() {
  const wrap = $('#replay-timeline');
  const evs = replay.events;
  const total = Math.max(1, replay.duration);
  wrap.innerHTML = '<div class="tl-head">📌 时间轴（点击跳转）</div>' +
    evs.filter((e) => e.type === 'speak' || e.type === 'slide' || e.type === 'ask').map((e) => {
      const left = Math.min(100, (e.t / total) * 100);
      const ico = e.type === 'slide' ? '📊' : e.type === 'ask' ? '✋' : '💬';
      const short = String(e.v || '').slice(0, 46) + (String(e.v || '').length > 46 ? '…' : '');
      return '<div class="tl-item" data-seek="' + e.t + '">' +
        '<span class="tl-bar" style="left:' + left + '%"></span>' +
        '<span class="tl-ico">' + ico + '</span>' +
        '<span class="tl-t">' + fmtTime(Math.round(e.t)) + '</span>' +
        '<span class="tl-txt">' + esc(short) + '</span></div>';
    }).join('');
}

/* 把回放状态应用到 UI（t 秒处） */
function applyReplayTo(t, reset) {
  const c = replay.course;
  // 回退（seek 往回拖）：从头重建，避免残留
  const needRebuild = reset || (replay.lastApplied != null && replay.lastApplied > t);
  if (needRebuild) {
    replay.cursor = 0;
    replay.lastApplied = -1;
    $('#replay-cap').textContent = '';
    $('#replay-slide').innerHTML = '';
  }
  // 应用所有 t 之前的事件
  for (let i = replay.cursor; i < replay.events.length; i++) {
    const e = replay.events[i];
    if (e.t > t) break;
    replay.cursor = i + 1;
    if (e.type === 'slide') {
      const slides = c.slides || [];
      const s = slides[e.v];
      if (s) $('#replay-slide').innerHTML = slideHTML(s, e.v, slides.length, slideTheme(c));
    } else if (e.type === 'speak') {
      $('#replay-cap').textContent = e.v;
    } else if (e.type === 'ask') {
      $('#replay-cap').textContent = e.who + '：' + e.v;
    }
  }
  replay.lastApplied = t;
}

function updateReplayTime() {
  $('#rp-time').textContent = fmtTime(Math.round(replay.t)) + ' / ' + fmtTime(Math.round(replay.duration));
  $('#rp-seek').value = String(Math.min(replay.duration, Math.round(replay.t)));
}

function tickReplay(now) {
  if (!replay.playing) return;
  if (!replay.lastTick) replay.lastTick = now;
  const dt = (now - replay.lastTick) / 1000;
  replay.lastTick = now;
  replay.t += dt * replay.speed;
  if (replay.t >= replay.duration) {
    replay.t = replay.duration;
    applyReplayTo(replay.t);
    updateReplayTime();
    pauseReplay();
    return;
  }
  applyReplayTo(replay.t);
  updateReplayTime();
  replay.raf = requestAnimationFrame(tickReplay);
}

function playReplay() {
  if (replay.playing) return;
  if (replay.t >= replay.duration) { // 播完了重播
    replay.t = 0; replay.lastApplied = -1; applyReplayTo(0, true);
  }
  replay.playing = true;
  replay.lastTick = 0;
  $('#rp-play').textContent = '⏸';
  // 回放时同步朗读
  if (TTS.enabled) {
    const upcoming = replay.events.filter((e) => e.type === 'speak' && e.t >= replay.t).slice(0, 3);
    upcoming.forEach((e) => setTimeout(() => {
      if (replay.playing && TTS.enabled) speak(e.v);
    }, Math.max(0, (e.t - replay.t) * 1000 / replay.speed)));
  }
  replay.raf = requestAnimationFrame(tickReplay);
}

function pauseReplay() {
  replay.playing = false;
  if (replay.raf) cancelAnimationFrame(replay.raf);
  replay.raf = null;
  replay.lastTick = 0;
  $('#rp-play').textContent = '▶';
  stopSpeech();
}

/* 数字人视频回放画面 */
function renderReplayVideo(course) {
  const v = course.avatarVideo;
  if (!v) return;
  const url = (v && (v.url || v.videoUrl)) || '';
  if (!url) return;
  $('#replay-screen').classList.add('has-video');
  const old = $('#replay-screen .rp-video');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'rp-video';
  wrap.innerHTML = '<video src="' + esc(url) + '" controls playsinline preload="metadata"></video>' +
    '<span class="rp-video-tag">🎬 AI 数字人老师</span>';
  $('#replay-screen').insertBefore(wrap, $('#replay-screen').firstChild);
  $('#replay-cap').textContent = '数字人视频已嵌入，可与课件时间轴配合观看';
}

function closeReplay() {
  pauseReplay();
  $('#replay-modal').hidden = true;
  $('#replay-screen').classList.remove('has-video');
  const v = $('#replay-screen .rp-video');
  if (v) v.remove();
  replay.course = null;
  replay.events = [];
}

function seekReplay(sec) {
  sec = Math.max(0, Math.min(replay.duration, Number(sec) || 0));
  replay.t = sec;
  replay.lastApplied = -1;
  applyReplayTo(sec, true);
  updateReplayTime();
}

/* ============================================================
   数字人老师：真人形象 + 说话动效 + 演示视频
   ============================================================ */
const AVATAR = {
  photo: 'assets/teacher-avatar.jpg',
  thumb: 'assets/teacher-thumb.jpg',
  video: 'assets/teacher-demo.mp4',
  ready: false,
  videoReady: false,
};

/* 探测资源是否存在，存在则切到真人形象 */
function initAvatar() {
  const img = $('#teacher-img');
  if (!img || img.dataset.bound) return;
  img.dataset.bound = '1';
  img.onload = () => {
    AVATAR.ready = true;
    $('#teacher-photo').hidden = false;
    const av = $('#teacher-avatar');
    if (av) av.style.display = 'none';
    if ($('#gal-grid')) renderGallery();
  };
  img.onerror = () => {
    AVATAR.ready = false;
    const ph = $('#teacher-photo');
    if (ph) ph.hidden = true;
    const av = $('#teacher-avatar');
    if (av) av.style.display = '';
  };
  img.src = AVATAR.photo;
}

function teacherAvatarHTML() {
  if (AVATAR.ready) {
    return '<img class="gal-photo" src="' + AVATAR.thumb + '" alt="灵犀老师">';
  }
  return '<span class="gal-av" style="background:#EEF0FF;color:#6366F1">灵</span>';
}

/* ---------- 数字人视频生成（云服务） ---------- */
function openAvatarModal() {
  const live = state.live;
  const course = live ? live.course : null;
  if (!course) { toast('请先进入课堂', 'err'); return; }
  const has = !!course.avatarVideo;
  $('#avatar-body').innerHTML =
    '<div class="av-intro">' +
      '<div class="av-preview">' +
        '<img src="' + AVATAR.thumb + '" alt="灵犀老师数字人">' +
        '<span class="av-tag">🎬 灵犀老师数字人</span>' +
      '</div>' +
      '<div class="av-desc">' +
        '<b>为这节课生成一段数字人老师授课视频</b>' +
        '<p>基于灵犀老师的真人形象，生成一段会开口讲课的动态视频，下课后可在「课堂回放」中作为主讲画面观看。</p>' +
        '<ul class="av-notes">' +
          '<li>视频为 5 秒循环片段，用于会议画面的"老师在讲话"效果</li>' +
          '<li>生成约需 1-3 分钟，会消耗一定积分</li>' +
          '<li>每个课程只需生成一次，后续可复用</li>' +
        '</ul>' +
        (has ? '<p class="av-has">✅ 本节课已生成数字人视频，可直接前往回放观看。</p>' : '') +
      '</div>' +
    '</div>';
  // 内联 onerror 会被 CSP 拦，改成事件监听（图片加载失败时隐藏，不破坏页面）
  const avImg = $('#avatar-body img');
  if (avImg) avImg.addEventListener('error', () => { avImg.style.display = 'none'; });
  $('#btn-avatar-gen').textContent = has ? '重新生成' : '生成数字人视频';
  $('#avatar-modal').hidden = false;
}

/* 把已生成的视频挂到直播画面 & 回放 */
function applyAvatarVideo(course) {
  const v = course && course.avatarVideo;
  if (!v) return;
  AVATAR.videoReady = true;
  const url = v.url || v.videoUrl;
  if (!url) return;
  // 直播间：主画面加一个循环播放的数字人视频层
  const host = $('#teacher-video');
  if (host && !$('#teacher-video .tp-livevideo')) {
    const d = document.createElement('div');
    d.className = 'tp-livevideo';
    d.innerHTML = '<video src="' + esc(url) + '" autoplay loop muted playsinline></video>';
    host.appendChild(d);
  }
}

/* 探测本地数字人视频（assets/teacher-demo.mp4），存在则作为"老师视频"循环播放 */
function initAvatarVideo() {
  const host = $('#teacher-video');
  if (!host) return;
  if (host.querySelector('.tp-video')) {   // 已初始化，避免重复插入
    const ex = host.querySelector('.tp-video');
    if (AVATAR.ready) ex.style.display = '';
    return;
  }
  const v = document.createElement('video');
  v.className = 'tp-video';
  v.id = 'tp-video';
  v.src = AVATAR.video;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.style.display = 'none';
  v.addEventListener('loadeddata', () => {
    AVATAR.videoReady = true;
    if (AVATAR.ready) v.style.display = '';
  });
  v.addEventListener('error', () => { v.style.display = 'none'; AVATAR.videoReady = false; });
  host.insertBefore(v, host.firstChild);
  // 有照片时也尝试播放（照片作为封面，视频作为动态层）
  // 注意：play() 在不同引擎下可能返回 undefined 或抛同步异常，必须整体兜住，
  // 否则异常会冒泡到 init()，导致后续所有事件绑定失败（页面看起来"点不动"）
  try {
    const p = v.play && v.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* 自动播放被拦截时静默 */ }
}

/* 生成 / 绑定数字人视频到当前课程 */
async function generateAvatarVideo() {
  const live = state.live;
  const course = live ? live.course : null;
  if (!course) { toast('请先进入课堂', 'err'); return; }
  const btn = $('#btn-avatar-gen');
  btn.disabled = true;
  btn.textContent = '正在绑定…';

  // 探测随站点一起部署的数字人视频
  const url = await probeVideo(AVATAR.video);
  btn.disabled = false;

  if (!url) {
    btn.textContent = '生成数字人视频';
    toast('未找到数字人视频资源，请先在后台生成后放入 assets 目录', 'err');
    return;
  }

  course.avatarVideo = { url: url, poster: AVATAR.photo, createdAt: Date.now() };
  const i = state.courses.findIndex((c) => c.id === course.id);
  if (i >= 0) { state.courses[i] = course; }
  try { localStorage.setItem('lingxi_courses_v1', JSON.stringify(state.courses)); } catch (_) {}

  applyAvatarVideo(course);
  renderCourses();
  $('#avatar-modal').hidden = true;
  toast('数字人老师已就位，可进入课堂或回放观看', 'ok');
}

/* 探测媒体资源是否可用 */
function probeVideo(src) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok ? src : null); } };
    v.preload = 'metadata';
    v.onloadedmetadata = () => finish(true);
    v.onerror = () => finish(false);
    v.src = src;
    setTimeout(() => finish(false), 6000);
  });
}

/* ---------- 登录态失效（401）的识别与自愈 ----------
   背景：SDK 只在会话「即将过期」时才去刷新。若本地残留一个 expiresAt 未到、
   但已被服务端判废的会话，SDK 会一直带着它发请求，云端持续返回
   401 invalid_grant —— 页面就永久卡在「AI 暂不可用」，而云端 AI 其实是好的。
   这里补三件事：识别这种错误、清掉残留会话（自愈）、匿名重试。 */

/* 兼容两种错误形态：
   ① LLM 调用：CloudOpenAIError，code 在 e.error.code，HTTP 状态在 e.status
   ② 云服务 auth/db：普通对象 { kind, message, status, code } */
function isAuthError(e) {
  if (!e) return false;
  if (e.status === 401 || e.status === 403) return true;
  if (e.kind === 'unauthenticated' || e.kind === 'permission-denied') return true;
  const inner = e.error;
  if (typeof inner === 'string') return /invalid_grant|unauthorized|unauthenticated/i.test(inner);
  if (inner && typeof inner === 'object') {
    if (inner.code === 'invalid_grant') return true;
    if (inner.kind === 'unauthenticated' || inner.kind === 'permission-denied') return true;
    if (typeof inner.type === 'string' && /auth|permission/i.test(inner.type)) return true;
  }
  return typeof e.message === 'string' && /invalid_grant|HTTP\s*40[13]/i.test(e.message);
}

let healInflight = null;
/* 自愈：凭据被服务端拒绝 → 清掉本地残留会话，随后以访客身份重试即可恢复。
   网络/后端故障不动登录态，避免把好端端的登录误登出。返回 true 表示确实清理过。 */
async function healSession() {
  if (healInflight) return healInflight;
  const auth = state.cloud && state.cloud.auth;
  healInflight = (async () => {
    if (!auth) return false;
    let r;
    try {
      if (typeof auth.refreshSession === 'function') r = await auth.refreshSession();
      else return false;
    } catch (_) { return false; }
    if (!r) return false;
    if (r.data) return false;                                  // 刷新成功，账号仍在
    if (!r.error || !isAuthError(r.error)) return false;        // 网络/后端问题：不登出
    // 凭据被判废：SDK 内部已清存储，这里再兜一层，确保不会二次踩坑
    if (typeof auth.signOut === 'function') { try { await auth.signOut(); } catch (_) {} }
    state.user = null; state.mem = null; state.memLoaded = false;
    try { authUI(); renderMemoryView(); } catch (_) {}
    return true;
  })();
  try { return await healInflight; } finally { healInflight = null; }
}

/* 启动时先校验本地会话：getUser 会打到服务端，凭据失效时 SDK 自己就会清存储。
   返回 true 表示清掉了失效会话。 */
async function ensureSessionHealthy() {
  const auth = state.cloud && state.cloud.auth;
  if (!auth || typeof auth.getSession !== 'function') return false;
  let alive = false;
  try {
    const s = await auth.getSession();
    alive = !!(s && s.data && s.data.accessToken);
  } catch (_) {}
  if (!alive) return false;
  try {
    const r = await auth.getUser();
    if (r && r.error && isAuthError(r.error)) return await healSession();
  } catch (_) {}
  return false;
}

function mapLLMError(e) {
  const inner = (e && e.error && typeof e.error === 'object') ? e.error : {};
  const code = errCode(e);
  const status = (e && e.status) || 0;
  if (isAuthError(e)) return '登录状态已过期，已切回访客模式，请重试一次。';
  if (code === 'client_model_slow') return '当前模型响应太慢，可换个模型再试（右上角状态条 / 生成页的模型选择）。';
  if (code === 'client_empty_answer') return '模型这次没返回内容，请重试一次。';
  if (code === 'gateway_network_error') return '网络异常，请检查网络后重试。';
  // 连接被中途掐断：Node/undici 会把 message 写成 "terminated" / "other side closed"，
  // 不能把这种英文黑话直接甩给用户
  if (e && typeof e.message === 'string' &&
      /^(terminated|other side closed|socket hang up|ECONNRESET|fetch failed|network)/i.test(e.message)) {
    return '网络连接中断了，请检查网络后重试。';
  }
  if (status === 429 || code.startsWith('quota_')) return 'AI 额度已用尽或触发限流，请稍后再试。';
  if (status >= 500 || code.startsWith('gateway_') || code.startsWith('internal_')) return 'AI 服务开小差了，请点击重试。';
  if (code.startsWith('model_')) return '当前模型暂时不可用，请点击重试。';
  if (code === 'request_stream_required') return '请求参数错误（需要流式调用）。';
  if (code.startsWith('request_')) return '请求参数有误：' + (inner.message || code);
  return (e && e.message) ? ('出错了：' + e.message) : '网络异常，请检查网络后重试。';
}
function errorRequestId(e) {
  // requestId 来自服务端，但照样会被拼进 innerHTML —— 转义纪律不能有例外
  return (e && e.requestId) ? ('（诊断 ID：' + esc(e.requestId) + '）') : '';
}

/* ---------- 模型 ---------- */
/* 目录里除了对话模型还混着图像/向量之类的模型，别把它们当成聊天模型选中 */
const NON_CHAT_MODEL = /(?:^|[-_])(image|embed|embedding|rerank|tts|asr|whisper)(?:$|[-_])/i;

/* 默认模型白名单（按实测的首字延迟与成功率排序，同一份「生成整节课 JSON」请求实测）：
     deepseek-v4.1-flash  首字 1.1s / 总 8.7s   ✅ 9 页 3 题
     deepseek-v4-flash    首字 1.2s / 总 10.4s  ✅ 9 页 3 题
     kimi-k2.6            首字 1.1s / 总 61.6s  ✅ 10 页 3 题（慢但可用）
   踩过的坑（都实测过，所以写在这里当"禁令"）：
     · auto            路由到高档位思考模型，4 分钟一个字都不吐 → 用户看到「AI 服务不可用」
     · minimax-m2.5    直接 400 request_invalid_parameter（不吃 response_format）
     · glm-5.3-flash   首字 121s / 总 158s，体验上等同不可用
     · hunyuan-chat    输出上限 8k，课件 JSON 会被截断成非法 JSON
   所以默认值必须显式指定，绝不能用"取列表第一个"。 */
const MODEL_PREFERENCE = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'kimi-k2.6',
];
const MODEL_KEY = 'lingxi_model_v1';
const MIN_OUTPUT_TOKENS = 16000;   // 一次要产出 7~10 页课件 JSON，输出空间太小会被截断

function isChatModel(m) {
  return !!m && !!m.id && m.enabled !== false && m.disabled !== true && !NON_CHAT_MODEL.test(m.id);
}
/* 评分只用来排序；白名单命中直接给一个压倒性的分值，
   避免"惩罚项加起来超过偏好差距"导致默认模型又滑回慢模型（这个坑真踩过）。 */
function modelScore(m) {
  if (!isChatModel(m)) return -Infinity;
  const pref = MODEL_PREFERENCE.indexOf(m.id);
  if (pref >= 0) return 1000 - pref;
  let s = 0;
  if ((m.maxOutputTokens || 0) >= MIN_OUTPUT_TOKENS) s += 40; else s -= 40;
  if (m.onlyReasoning === true) s -= 50;                       // 只思考型模型首字延迟不可控
  if (m.id === 'auto') s -= 20;                                // 路由模型延迟随任务浮动，不宜当默认
  if (m.reasoning && m.reasoning.effort === 'high' && m.reasoning.canDisableThinking !== true) s -= 10;
  return s;
}
function rankModels(models) {
  return (models || []).filter(isChatModel).slice().sort((a, b) => modelScore(b) - modelScore(a));
}
function pickPreferredModel(models) {
  const ranked = rankModels(models);
  return ranked.length ? ranked[0] : null;
}

let loadModelsInflight = null;

function setAIStatus(kind, text, retryable) {
  const el = $('#ai-status');
  if (!el) return;
  // kind 只允许固定几个枚举值（用于拼 class），text 必须转义——即便调用方目前都传字面量
  const k = ['ok', 'bad', 'wait', 'off'].indexOf(String(kind)) >= 0 ? String(kind) : 'off';
  el.innerHTML = '<i class="dot dot-' + k + '"></i>' + esc(text);
  el.classList.toggle('is-retryable', !!retryable);
  el.setAttribute('title', retryable ? '点击重试' : '');
}

/* 落地当前模型：优先用户上次手选，其次偏好列表 */
function applyModel(models) {
  const list = (models || []).filter(isChatModel);
  if (!list.length) return null;
  let saved = null;
  try { saved = localStorage.getItem(MODEL_KEY); } catch (_) {}
  const bySaved = saved ? list.find((m) => m.id === saved) : null;
  state.model = bySaved || pickPreferredModel(list);
  return state.model;
}

function setModel(id, opts) {
  const m = (state.models || []).find((x) => x.id === id);
  if (!m) return null;
  state.model = m;
  if (!opts || opts.persist !== false) {
    try { localStorage.setItem(MODEL_KEY, id); } catch (_) {}
  }
  syncModelSelect();
  if (!opts || !opts.quiet) setAIStatus('ok', 'AI 已就绪', false);
  return m;
}

/* 首字延迟预算：超时就认为这个模型不适合当前请求，自动换一个更快的重来。
   这一步是"AI 服务不可用"的兜底 —— 思考型模型可能几分钟不吐一个字，
   用户无法区分"在思考"和"挂了"，所以宁可自动换模型。 */
const FIRST_CONTENT_BUDGET_MS = 45000;

function fastestAlternativeModel() {
  const cur = state.model && state.model.id;
  const ranked = rankModels(state.models).filter((m) => m.id !== cur);
  return ranked.length ? ranked[0] : null;
}

/* 模型选择器：把可用的对话模型列出来，用户可手动切（慢的时候有得选） */
function renderModelSelect() {
  const sel = $('#model-select');
  const field = $('#model-field');
  if (!sel) return;
  const list = (state.models || []).filter(isChatModel);
  const cur = state.model && state.model.id;
  sel.innerHTML = list.map((m) =>
    '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' +
    esc(m.name || m.id) + '</option>').join('');
  if (field) field.hidden = list.length <= 1;
  sel.hidden = list.length <= 1;
  syncModelSelect();
}
function syncModelSelect() {
  const sel = $('#model-select');
  if (!sel || !state.model) return;
  sel.value = state.model.id;
}
async function onModelChange(e) {
  const id = e.target.value;
  const m = setModel(id, { quiet: true });
  if (!m) return;
  toast('已切换到「' + (m.name || m.id) + '」', 'ok');
  setAIStatus('ok', 'AI 已就绪', false);
}
function bindModelSelect() {
  const sel = $('#model-select');
  if (!sel || sel.dataset.bound === '1') return;
  sel.dataset.bound = '1';
  sel.addEventListener('change', onModelChange);
}

/* 拉取模型目录。失败不再永久锁死：带退避重试、登录态自愈，并留一个可点的重试入口。 */
async function loadModels() {
  if (loadModelsInflight) return loadModelsInflight;
  loadModelsInflight = (async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ac = new AbortController();
        // 实测云端网关冷启动时，仅"拉模型目录"就可能要 12 秒以上（波动很大），
        // 超时给太紧会把"慢但正常"误判成不可用
        const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 20000);
        let models;
        try { models = await state.cloud.llm.models.list(ac.signal); }
        finally { clearTimeout(timer); }

        state.models = Array.isArray(models) ? models : [];
        const usable = applyModel(state.models);
        if (!usable) {
          state.model = null;
          setAIStatus('bad', '暂无可用模型', false);
          return false;
        }
        renderModelSelect();
        setAIStatus('ok', 'AI 已就绪', false);
        return true;
      } catch (e) {
        lastErr = e;
        // ① 登录态失效 → 清掉残留会话后匿名重试（「AI 服务不可用」最常见的原因）
        if (attempt === 0 && isAuthError(e)) {
          const healed = await healSession();
          if (healed) toast('登录状态已过期，已切回访客模式，可以继续上课');
          continue;
        }
        // ② 网络/后端抖动 → 退避重试
        if (!isAuthError(e) && attempt < 2) { await sleep(700 * (attempt + 1)); continue; }
        break;
      }
    }
    state.model = null;
    setAIStatus('bad', 'AI 暂不可用 · 点此重试', true);
    console.error('模型列表获取失败', lastErr);
    return false;
  })();
  try { return await loadModelsInflight; } finally { loadModelsInflight = null; }
}

/* 状态条点击即重试（窄屏下状态条隐藏，不影响桌面主流程） */
function bindAIStatusRetry() {
  const el = $('#ai-status');
  if (!el || el.dataset.retryBound === '1') return;
  el.dataset.retryBound = '1';
  el.addEventListener('click', () => {
    if (!state.cloud) return;
    setAIStatus('wait', 'AI 连接中…', false);
    loadModels();
  });
}

/* 统一的「AI 是否可用」闸门 —— 一律 await 使用。
   踩过的坑：打开页面后 SDK 要先建会话再拉模型目录，实测在真实云端约 4~5 秒。
   老实现是同步判定，用户手快在这 5 秒里点「生成课程」就会被直接拒绝，
   明明再等两秒就好，体感却是「AI 服务不可用」。
   现在它会在预算内等首次加载（或进行中的重试）落地，只有真的等不到才拦。 */
const MODEL_WAIT_BUDGET_MS = 12000;
async function requireModel({ budget = MODEL_WAIT_BUDGET_MS } = {}) {
  if (state.model) return true;
  if (!state.cloud) { toast('云服务未就绪，请刷新页面后重试', 'err'); return false; }
  setAIStatus('wait', 'AI 连接中…', false);
  // loadModels 自带去重：已有在途请求会直接复用，不会重复打接口
  await Promise.race([loadModels(), sleep(budget)]);
  if (state.model) return true;
  toast('AI 还在连接中，稍等一两秒再点一次就好', 'err');
  return false;
}

/* 统一的流式调用封装：所有调用都带 system 首消息 + stream:true
   - 登录态失效（401）→ 自愈后重试一次
   - 模型不支持 response_format → 降级重试一次
   - 首字迟迟不来（思考型模型可能几分钟不出字）→ 自动换更快的模型重来
   - 纯推理模型（onlyReasoning）会先吐 reasoning_content，通过 onReasoning 透出，
     避免"半天没反应"被误判成 AI 不可用 */
async function streamChat({ messages, temperature = 0.7, conversationId, responseFormat, signal, onDelta, onReasoning, onNotice,
                            firstContentBudget = FIRST_CONTENT_BUDGET_MS }) {
  const params = { model: state.model && state.model.id, messages, stream: true, temperature };
  if (conversationId) params.conversationId = conversationId;

  let useFormat = responseFormat;
  let healed = false;
  let switched = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    params.model = (state.model && state.model.id) || params.model;   // 换了模型必须同步，否则重试还在打旧模型
    if (useFormat) params.response_format = { type: 'json_object' };
    else delete params.response_format;

    // 外层取消信号（用户点"打断"）与内部超时要能叠加
    const ac = new AbortController();
    const relay = () => { try { ac.abort(); } catch (_) {} };
    if (signal) {
      if (signal.aborted) return '';
      signal.addEventListener('abort', relay, { once: true });
    }
    let timedOut = false;
    let gotContent = false;
    const cap = setTimeout(() => { if (!gotContent) { timedOut = true; relay(); } }, firstContentBudget);

    try {
      params.signal = ac.signal;
      let full = '';
      let thinking = '';
      for await (const chunk of state.cloud.llm.chat.completions.create(params)) {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          thinking += delta.reasoning_content;
          if (onReasoning) onReasoning(delta.reasoning_content, thinking, full);
        }
        if (delta.content) {
          if (!gotContent) { gotContent = true; clearTimeout(cap); }   // 只有正文才算"开口"
          full += delta.content;
          if (onDelta) onDelta(delta.content, full);
        }
      }
      if (signal && signal.aborted) return full;      // 用户主动打断：不是错误
      if (full) return full;
      if (timedOut) { lastErr = slowModelError(state.model && state.model.id); }
      else { lastErr = emptyAnswerError(); }
    } catch (e) {
      lastErr = e;
      // ① 登录态失效 → 清残留会话后以访客身份重试一次
      if (!healed && isAuthError(e)) {
        healed = true;
        await healSession();
        continue;
      }
      // ② 个别模型不支持 response_format 时降级重试一次
      const code = String((e && e.error && e.error.code) || '');
      if (useFormat && code.startsWith('request_')) { useFormat = null; continue; }
      if (signal && signal.aborted) return '';
      // ③ 首字超时是我们自己掐的：中止请求后，流的落地方式**有两种**——
      //    有时 async generator 直接"正常结束"（走下面 try 里那条 timedOut 分支），
      //    有时抛出 AbortError（Node/undici 侧还会变成 message="terminated" 的错）。
      //    两条路径必须等价，都算"模型太慢"交给换模型分支；
      //    否则自动切换会随中止的落地方式时灵时不灵，用户直接吃到报错。
      if (!timedOut) throw e;
      lastErr = slowModelError(state.model && state.model.id);
    } finally {
      clearTimeout(cap);
      if (signal) { try { signal.removeEventListener('abort', relay); } catch (_) {} }
    }

    // ③ 一个字都没等到：换一个更快的模型重来（只换一次，避免来回横跳）
    if (!switched && errCode(lastErr) === 'client_model_slow') {
      const alt = fastestAlternativeModel();
      if (alt) {
        switched = true;
        setModel(alt.id, { quiet: true, persist: false });
        if (onNotice) onNotice('当前模型响应太慢，已自动切换到「' + (alt.name || alt.id) + '」重试');
        continue;
      }
    }
    throw lastErr;
  }
  throw lastErr || new Error('AI 调用失败');
}

/* 首字超时 / 空回答：用可识别的 code，便于上层给不同文案 */
function errCode(e) {
  const inner = e && e.error;
  if (inner && typeof inner === 'object' && inner.code) return String(inner.code);
  if (typeof inner === 'string') return inner;
  return '';
}
function slowModelError(id) {
  const e = new Error('模型响应超时（' + (id || '未知') + '）');
  e.name = 'CloudOpenAIError';
  e.error = { message: 'model too slow to respond', type: 'server_error', param: null, code: 'client_model_slow' };
  return e;
}
function emptyAnswerError() {
  const e = new Error('模型没有返回内容');
  e.name = 'CloudOpenAIError';
  e.error = { message: 'empty completion', type: 'server_error', param: null, code: 'client_empty_answer' };
  return e;
}

/* 解析模型输出的 JSON（容错：剥掉 markdown 代码块围栏） */
function parseJSONLoose(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s > 0 || (e >= 0 && e < t.length - 1)) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (_) { return null; }
}

/* 从题干/知识点里造一道兜底练习题（无 AI 可用时保证课件里有题） */
function fallbackQuiz(course, outline, idx) {
  const kp = (outline && Array.isArray(outline.knowledgePoints) && outline.knowledgePoints.length)
    ? String(outline.knowledgePoints[idx % outline.knowledgePoints.length])
    : (course.subject + '重点');
  const stage = (outline && Array.isArray(outline.stages) && outline.stages.length)
    ? String(outline.stages[idx % outline.stages.length].name || '') : '';
  const stem = stage
    ? '关于「' + kp + '」，下面说法正确的是：'
    : '关于本节课「' + kp + '」，下面说法正确的是：';
  return {
    type: 'quiz',
    title: '随堂练习 ' + (idx + 1),
    subtitle: '限时 2 分钟',
    question: stem,
    options: [
      'A. 它是本节课的核心概念，需要重点掌握',
      'B. 它只在本节课出现，与后续学习无关',
      'C. 掌握它不需要任何前置知识',
      'D. 它只有一种固定解法，不能变通',
    ],
    answer: 'A',
    analysis: 'A 正确：「' + kp + '」是本节的核心内容，也是后续学习的基础；' +
      'B、C、D 都忽略了知识点之间的关联与前置基础。请结合老师刚才的讲解再回顾一遍。',
    note: '我们来做一道随堂练习，检查一下刚才讲的「' + kp + '」有没有真正掌握。你先自己选，选完告诉我是哪个选项，我再带你分析。',
  };
}

/* 把 AI 输出的 slides 规范化；缺课件时用课程大纲兜底生成 */
function normalizeSlides(outline, course) {
  const arr = outline && Array.isArray(outline.slides) ? outline.slides : null;
  if (arr && arr.length) {
    const mapped = arr.map((s, i) => {
      // 类型判定：显式 type 优先，否则按位置推断
      let type = String(s.type || '').toLowerCase();
      if (!['cover', 'content', 'quiz', 'summary'].includes(type)) {
        if (i === 0) type = 'cover';
        else if (i === arr.length - 1) type = 'summary';
        else type = 'content';
      }
      const out = {
        type,
        title: String(s.title || '第 ' + (i + 1) + ' 页'),
        subtitle: s.subtitle ? String(s.subtitle) : '',
        bullets: Array.isArray(s.bullets) ? s.bullets.map(String).filter(Boolean) : [],
        note: s.note ? String(s.note) : '',
      };
      if (type === 'quiz') {
        out.question = String(s.question || '').trim();
        out.options = Array.isArray(s.options) ? s.options.map(String).filter(Boolean) : [];
        out.answer = String(s.answer || '').trim();
        out.analysis = String(s.analysis || '').trim();
      }
      return out;
    });
    // 丢弃没有题干的空题页；若一页题都不剩，稍后在 summary 前补一道
    let list = mapped.filter((s) => s.type !== 'quiz' || (s.question && s.answer));
    if (!list.some((s) => s.type === 'quiz')) {
      const si = list.findIndex((s) => s.type === 'summary');
      const quiz = fallbackQuiz(course, outline, 0);
      if (si >= 0) list.splice(si, 0, quiz); else list.push(quiz);
    }
    return list.slice(0, 14);
  }

  // 兜底：用大纲信息拼一份最小课件（含封皮 + 知识点 + 练习 + 小结）
  const cover = {
    type: 'cover',
    title: (outline && outline.title) || course.title,
    subtitle: [course.subject, course.grade, course.boardNames && course.boardNames[0]].filter(Boolean).join(' · '),
    bullets: [],
    note: '开场：介绍本节课的目标与安排。',
  };
  const body = [];
  const kps = (outline && Array.isArray(outline.knowledgePoints)) ? outline.knowledgePoints.map(String) : [];
  if (kps.length) {
    body.push({
      type: 'content', title: '本课知识点', subtitle: '',
      bullets: kps.slice(0, 5),
      note: '先带学生整体过一遍知识框架。',
    });
  }
  if (outline && Array.isArray(outline.stages)) {
    outline.stages.forEach((s, i) => {
      body.push({
        type: 'content',
        title: s.name || ('环节 ' + (i + 1)),
        subtitle: s.duration ? String(s.duration) : '',
        bullets: String(s.content || '').split(/[；;。]/).map((x) => x.trim()).filter(Boolean).slice(0, 3),
        note: String(s.content || ''),
      });
    });
  }
  const quiz = fallbackQuiz(course, outline, 0);
  const tail = {
    type: 'summary',
    title: '课堂小结', subtitle: '',
    bullets: (outline && Array.isArray(outline.homework) ? outline.homework.slice(0, 3) : ['回顾本课重点']).map(String),
    note: '总结要点，布置作业。',
  };
  return [cover, ...body, quiz, tail].slice(0, 12);
}

/* ---------- 视图切换 ---------- */
function switchView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  $$('.nav-links a, .mobile-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (name === 'courses') renderCourses();
  if (name === 'memory') renderMemoryView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- 学习档案（AI 记忆） ---------- */

/* 渲染「知识点掌握度」图谱：把记忆事实聚合成待巩固/学习中/已掌握三档 */
function renderMastery(facts) {
  const el = $('#mem-mastery');
  if (!el) return;
  const list = buildMastery(facts);
  if (!list.length) {
    el.innerHTML = '<p class="mem-empty">还没有知识点记录。上完一节课，老师会把你每个知识点的掌握程度标在这里。</p>';
    return;
  }
  el.innerHTML = list.map((m) => {
    const L = MASTERY_LEVELS[m.level] || MASTERY_LEVELS.need;
    return '<div class="mastery-item">' +
      '<span class="mastery-dot ' + L.cls + '"></span>' +
      '<b>' + esc(m.topic) + '</b>' +
      '<span class="mastery-tag ' + L.cls + '">' + L.label + '</span>' +
      '</div>';
  }).join('');
}

function renderMemoryView() {
  const gate = $('#mem-gate');
  const body = $('#mem-body');
  if (!gate || !body) return;

  const loggedIn = !!(state.user && !state.user.anonymous);
  gate.hidden = loggedIn;
  body.hidden = !loggedIn;
  if (!loggedIn) return;

  // 未拉取完（或正在拉取）
  if (!state.memLoaded) {
    body.innerHTML = '<div class="mem-loading">正在读取你的学习档案…</div>';
    loadMemory().then(() => renderMemoryView()).catch(() => {
      body.innerHTML = '<div class="mem-loading">读取失败，请稍后重试</div>';
    });
    return;
  }

  const m = state.mem || { profile: null, facts: [], sessions: [] };
  const p = m.profile || {};
  const facts = Array.isArray(m.facts) ? m.facts : [];
  const sessions = Array.isArray(m.sessions) ? m.sessions : [];

  const item = (label, val) => val
    ? '<div class="mp-item"><span>' + esc(label) + '</span><b>' + esc(val) + '</b></div>' : '';

  const profileHtml = [
    item('学段', p.grade),
    item('课程体系', p.system),
    item('学习目标', p.goal),
    item('当前水平', p.level),
    item('偏好风格', p.teaching_style),
    item('上课节奏', p.pace),
  ].filter(Boolean).join('');
  $('#mem-profile-body').innerHTML = profileHtml ||
    '<p class="mp-empty">还没有画像。上完第一节课后，老师会自动总结出你的学段、目标与偏好。</p>';

  const mins = Math.round((p.total_seconds || 0) / 60);
  $('#mem-stats-body').innerHTML = [
    '<div class="ms-item"><b>' + (p.sessions_count || sessions.length || 0) + '</b><span>已上课程</span></div>',
    '<div class="ms-item"><b>' + mins + '</b><span>累计分钟</span></div>',
    '<div class="ms-item"><b>' + facts.length + '</b><span>记住的事</span></div>',
  ].join('');

  // 事实列表
  const order = ['weak', 'misconception', 'strength', 'preference', 'context', 'progress'];
  const sorted = facts.slice().sort((a, b) => {
    const ia = order.indexOf(a.kind), ib = order.indexOf(b.kind);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  $('#mem-facts').innerHTML = sorted.length ? sorted.map((f) => {
    const k = FACT_KINDS[f.kind] || { label: '记忆', cls: '' };
    const when = f.last_seen ? new Date(f.last_seen).toLocaleDateString('zh-CN') : '';
    const hits = (f.hits > 0) ? '<span>被提及 ' + f.hits + ' 次</span>' : '';
    const subj = f.subject ? '<span>' + esc(f.subject) + (f.topic ? ' · ' + esc(f.topic) : '') + '</span>' : '';
    return '<div class="fact-row">' +
      '<span class="fact-kind ' + k.cls + '">' + esc(k.label) + '</span>' +
      '<div class="fact-body"><p>' + esc(f.content) + '</p>' +
      '<div class="fact-meta">' + subj + hits + (when ? '<span>' + when + '</span>' : '') + '</div></div>' +
      '<button class="fact-del" data-fact-del="' + esc(f.id) + '" title="忘掉这条">✕</button>' +
      '</div>';
  }).join('') : '<p class="mem-empty">还没有记住的事。上完一节课后，老师会把你的薄弱点、优势和偏好记在这里。</p>';

  // 知识点掌握度图谱（由事实聚合，待巩固/学习中/已掌握）
  renderMastery(facts);
  // 错因分布图谱（由上课记录聚合，四维错因 + 会/不会比例）
  renderErrorProfile(sessions);
  // 起点画像（由入学诊断沉淀的 diagnostic 来源事实聚合）
  renderMemoryDiag(facts);

  // 上课记录
  $('#mem-sessions').innerHTML = sessions.length ? sessions.map((s) => {
    const when = s.created_at ? new Date(s.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const mins2 = Math.round((s.duration_secs || 0) / 60);
    const list = (t, arr) => (Array.isArray(arr) && arr.length)
      ? '<div class="sess-list"><span>' + t + '</span><ul>' + arr.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '';
    const causes = renderCauses(s.error_causes);
    return '<div class="sess-row">' +
      '<div class="sess-head"><b>' + esc(s.course_title || '未命名课程') + '</b>' +
      '<span class="sess-meta">' + esc([s.subject, s.grade].filter(Boolean).join(' · ')) +
      (mins2 ? ' · ' + mins2 + ' 分钟' : '') + (when ? ' · ' + when : '') + '</span></div>' +
      '<div class="sess-lists">' + list('✅ 已掌握', s.mastered) + list('📌 待巩固', s.weak_points) + list('✏️ 作业', s.homework) + '</div>' +
      (causes ? '<div class="sess-causes"><span>🔍 错因</span>' + causes + '</div>' : '') +
      (s.comment ? '<div class="sess-comment">' + esc(s.comment) + '</div>' : '') +
      '</div>';
  }).join('') : '<p class="mem-empty">还没有上课记录。</p>';
}

/* 手动添加一条记忆 */
async function addMemoryFact() {
  if (!memReady()) { toast('请先登录', 'err'); return; }
  const content = window.prompt('想让灵犀老师记住什么？（例如：我更习惯先看例题再做题）');
  if (!content || !content.trim()) return;
  const n = await saveFacts([{ kind: 'preference', content: content.trim(), source: 'manual', confidence: 0.9 }]);
  if (n) {
    toast('已记住', 'ok');
    await loadMemory(true);
    renderMemoryView();
  } else {
    toast('保存失败，请稍后重试', 'err');
  }
}

function bindMemoryEvents() {
  const gateBtn = $('#btn-mem-login');
  if (gateBtn) gateBtn.addEventListener('click', openAuthModal);
  const addBtn = $('#btn-mem-add');
  if (addBtn) addBtn.addEventListener('click', addMemoryFact);

  const facts = $('#mem-facts');
  if (facts) facts.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-fact-del]');
    if (!btn) return;
    if (!window.confirm('让老师忘掉这条记忆？')) return;
    const ok = await deleteFact(btn.dataset.factDel);
    if (ok) {
      toast('已忘掉这条');
      await loadMemory(true);
      renderMemoryView();
    } else {
      toast('删除失败，请稍后重试', 'err');
    }
  });
}

/* ---------- 首页渲染 ---------- */
function renderHome() {
  // 体系切换
  $('#system-tabs').innerHTML = SYSTEMS.map((s) => `
    <button class="sys-tab${s.id === state.homeSystem ? ' active' : ''}" data-sys="${s.id}">
      <span class="sys-ico">${s.ico}</span>
      <span class="sys-name">${esc(s.name)}</span>
      <span class="sys-desc">${esc(s.desc)}</span>
    </button>`).join('');

  const sys = getSystem(state.homeSystem);
  const grid = $('#subject-grid');
  grid.innerHTML = sys.subjects.map((s) => `
    <button class="subject-card" data-subject="${esc(s.name)}" data-sys="${sys.id}">
      <span class="s-ico" style="background:${s.color}">${s.ico}</span>
      <b>${esc(s.name)}</b>
      <span>${esc(s.desc)}</span>
    </button>`).join('');
  $('#subject-count').textContent = sys.subjects.length;
  $('#subject-sys-name').textContent = sys.name;
}

function bindHomeEvents() {
  $('#system-tabs').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.sys-tab');
    if (!tab || tab.dataset.sys === state.homeSystem) return;
    state.homeSystem = tab.dataset.sys;
    renderHome();
    // 首页切换体系后，生成页的选择同步跟上
    state.gen.system = tab.dataset.sys;
    state.gen.subject = getSystem(tab.dataset.sys).subjects[0].name;
    renderGenChips();
    renderGradeOptions();
  });
  $('#subject-grid').addEventListener('click', (ev) => {
    const card = ev.target.closest('.subject-card');
    if (!card) return;
    state.gen.system = card.dataset.sys;
    renderGenChips();
    renderGradeOptions();
    setGenSubject(card.dataset.subject);
    switchView('generate');
  });
}

/* ---------- 生成课程 ---------- */
let __genChipsBound = false;
function renderGenChips() {
  const sys = getSystem(state.gen.system);
  const boards = getBoards(sys);

  // 体系切换
  $('#gen-systems').innerHTML = SYSTEMS.map((s) => `
    <button class="chip${s.id === state.gen.system ? ' active' : ''}" data-v="${s.id}">
      ${s.ico} ${esc(s.name)}
    </button>`).join('');

  // 考纲/考试局（仅国际体系；可多选）
  const boardField = $('#gen-boards-field');
  if (boards.length) {
    boardField.hidden = false;
    $('#gen-boards').innerHTML = boards.map((b) => `
      <button class="board-chip${state.gen.boards.includes(b.id) ? ' active' : ''}" data-board="${b.id}">
        <span class="bc-ico">${b.ico}</span>
        <span class="bc-name">${esc(b.name)}</span>
        <span class="bc-desc">${esc(b.desc)}</span>
      </button>`).join('');
  } else {
    boardField.hidden = true;
    $('#gen-boards').innerHTML = '';
  }

  // 科目（按考纲过滤：无 boards 标注的通用科目始终显示）
  const list = sys.subjects.filter((s) => {
    if (!Array.isArray(s.boards)) return true;
    if (!state.gen.boards.length) return true;
    return s.boards.some((b) => state.gen.boards.includes(b));
  });
  if (!list.some((s) => s.name === state.gen.subject)) {
    state.gen.subject = list.length ? list[0].name : sys.subjects[0].name;
  }
  $('#gen-subjects').innerHTML = list.map((s) =>
    `<button class="chip${s.name === state.gen.subject ? ' active' : ''}" data-v="${esc(s.name)}">${esc(s.name)}</button>`
  ).join('');

  // 学习目标预设（该体系下）
  $('#gen-goal-presets').innerHTML = sys.goals.map((g) =>
    `<button class="goal-chip" data-goal="${esc(g)}">${esc(g)}</button>`).join('');
  $('#gen-sys-note').textContent = sys.id === 'intl'
    ? '国际课程默认中英双语授课；可多选考纲，AI 将按对应考纲与评分标准授课'
    : '国内课程按考纲与教材进度授课';

  if (__genChipsBound) return;
  __genChipsBound = true;
  bindChips('#gen-systems', (v) => {
    state.gen.system = v;
    const nsys = getSystem(v);
    if (nsys.boards && nsys.boards.length) state.gen.boards = [nsys.boards[0].id];
    state.gen.subject = nsys.subjects[0].name;
    state.homeSystem = v;
    renderGenChips();
    renderGradeOptions();
    $('#gen-goal').value = '';
    $('#gen-goal').placeholder = v === 'intl'
      ? '例如：IB HL 物理，力学部分概念混乱，11 月大考想提高到 6 分；希望多用英文术语讲解'
      : '例如：下个月要考一元二次方程单元测，基础一般，想系统复习并多做典型题';
  });
  // 考纲多选
  $('#gen-boards').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.board-chip');
    if (!chip) return;
    const id = chip.dataset.board;
    const arr = state.gen.boards;
    if (arr.includes(id)) {
      if (arr.length === 1) { toast('至少保留一个考纲', 'err'); return; }
      state.gen.boards = arr.filter((x) => x !== id);
    } else {
      state.gen.boards = [...arr, id];
    }
    renderGenChips();
  });
  bindChips('#gen-subjects', (v) => { state.gen.subject = v; });
  bindChips('#gen-duration', (v) => { state.gen.duration = v; });
  bindChips('#gen-level', (v) => { state.gen.level = v; });
  $('#gen-goal-presets').addEventListener('click', (ev) => {
    const g = ev.target.closest('.goal-chip');
    if (!g) return;
    $('#gen-goal').value = g.dataset.goal;
    $$('#gen-goal-presets .goal-chip').forEach((x) => x.classList.toggle('active', x === g));
  });
}

/* 年级/学习阶段下拉，随体系联动 */
function renderGradeOptions(keepCurrent) {
  const sys = getSystem(state.gen.system);
  const sel = $('#gen-grade');
  const cur = sel.value;
  sel.innerHTML = sys.grades.map((g) => `<option>${esc(g)}</option>`).join('');
  if (keepCurrent && sys.grades.includes(cur)) {
    sel.value = cur;
  } else if (sys.id === 'intl') {
    // 国际课程默认停在中段（IB / A-Level / AP）
    sel.value = sys.grades[1] || sys.grades[0];
  }
  $$('#gen-level .chip').forEach((c, i) => c.classList.toggle('active', i === 0));
  state.gen.level = '基础巩固';
}

function setGenSubject(name) {
  state.gen.subject = name;
  renderGenChips();
}
function bindChips(sel, cb) {
  const row = $(sel);
  row.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    row.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    cb(chip.dataset.v);
  });
}

/* 返回当前选中的考纲显示名，如 ["IB DP (HL/SL)", "HKDSE 香港中学文凭"] */
function selectedBoardNames() {
  const sys = getSystem(state.gen.system);
  const boards = getBoards(sys);
  if (!boards.length) return [];
  return state.gen.boards
    .map((id) => boards.find((b) => b.id === id))
    .filter(Boolean)
    .flatMap((b) => b.marks || [b.full || b.name]);
}

const BOARD_GUIDE = {
  ib: 'IB：按 IB DP 考纲与 assessment objectives 设计，注意 HL/SL 差异；环节中体现 IA（Internal Assessment）、' +
      'EE（Extended Essay）与 TOK 的关联；题目引述 past paper 风格并说明 mark scheme 给分点。',
  alevel: 'A-Level：按 CAIE / Edexcel / AQA 考纲设计，区分 AS 与 A2 内容；' +
      '强调 Paper 结构与 past papers 训练，说明 mark scheme（如 M1/A1/B1 给分点）与常见失分陷阱。',
  hkdse: 'HKDSE（香港中学文凭）：按香港教育局课程指引与文凭试考纲设计，覆盖核心科目与选修；' +
      '强调 Paper 1（长题目）与 Paper 2（选择题）的答题技巧、评分准则与 Level 5** 冲分策略。',
  ap: 'AP：按 College Board AP 课程大纲设计，锚定 CED（Course and Exam Description）的知识框架；' +
      '强调 MCQ 与 FRQ（Free Response）题型训练、AP 5 分制评分标准与高分答题要点。',
};

function buildCourseOutlinePrompt() {
  const sys = getSystem(state.gen.system);
  const grade = $('#gen-grade').value;
  const goal = $('#gen-goal').value.trim();
  const bnames = selectedBoardNames();
  let sysLine;
  if (sys.id === 'intl') {
    const guides = state.gen.boards.map((id) => BOARD_GUIDE[id]).filter(Boolean);
    sysLine = '课程体系：国际课程（' + grade + '）。对标考纲：' +
      (bnames.length ? bnames.join('、') : '国际通行标准') + '。\n' +
      '请严格按上述考纲设计：使用国际教材通行的章节结构；专业术语首次出现时给出英文原名' +
      '（如 Newton\'s second law）；体现 inquiry-based learning 与 past paper 训练。\n' +
      (guides.length ? guides.join('\n') : '');
  } else {
    sysLine = '课程体系：国内课程（' + grade + '）。请贴合国内课标与教材进度，对标中高考/单元考的考查方式，' +
      '强调典型例题与易错点。';
  }
  return '请为以下学生设计一节' + state.gen.duration + '的 AI 一对一直播课。\n' +
    '科目：' + state.gen.subject + '\n' + sysLine + '\n难度：' + state.gen.level +
    '\n学习目标：' + (goal || '未填写，请按该体系、该阶段的典型学习需求设计') +
    diagnosticPromptBlock() +
    '\n要求：环节由浅入深、可互动、贴合一对一场景；content 要具体到"讲什么、怎么互动"。' +
    (sys.id === 'intl' ? '标题与知识点可用中英双语，正文说明用简体中文。' : '全部使用简体中文。');
}

async function generateCourse() {
  if (!requireModel()) return;
  const btn = $('#btn-generate');
  btn.disabled = true;
  btn.textContent = '生成中，请稍候…';
  $('#gen-empty').hidden = true;
  $('#gen-course').hidden = true;
  const streamBox = $('#gen-stream');
  const streamText = $('#gen-stream-text');
  streamBox.hidden = false;
  streamText.textContent = '';

  // 有诊断结果就把它写进长期记忆（登录后生效），让"从哪里讲起"跨课留得住。
  // 放在生成之前，而不是之后 —— 即使这次生成失败，诊断结论也不该丢。
  if (diagState.profile && diagState.profile.judged) {
    persistDiagnostic(diagState.profile, {
      subject: state.gen.subject,
      system: state.gen.system,
      grade: ($('#gen-grade') || {}).value || '',
      goal: (($('#gen-goal') || {}).value || '').trim(),
    }).catch(() => {});
  }

  const sysObj = getSystem(state.gen.system);
  const system = '你是「灵犀课堂」的资深课程设计师，专为 AI 一对一直播课设计方案与课件，' +
    '既熟悉中国国家课程与中高考考纲，也熟悉 IB、A-Level、AP、IGCSE 等国际课程体系与标化考试。' +
    '只输出一个 JSON 对象，禁止输出 markdown 代码块或任何解释文字。JSON 结构：' +
    '{"title":"课程标题","summary":"一两句话说明这节课解决什么问题",' +
    '"knowledgePoints":["知识点1","知识点2","知识点3","知识点4"],' +
    '"stages":[{"name":"环节名","duration":"如 10 分钟","content":"具体教学安排，2-3句，含互动方式"}],' +
    '"slides":[' +
      '{"type":"cover","title":"课程标题","subtitle":"副标题"},' +
      '{"type":"content","title":"知识模块名","bullets":["要点1","要点2"],"note":"老师讲解词"},' +
      '{"type":"quiz","title":"随堂练习","question":"题干（完整可作答）","options":["A. 选项一","B. 选项二","C. 选项三","D. 选项四"],"answer":"B","analysis":"解析，说明为什么选它、其他选项错在哪","note":"老师讲这道题的话"},' +
      '{"type":"summary","title":"课堂小结","bullets":["小结1","小结2"]}' +
    '],' +
    '"homework":["课后练习1","课后练习2"],"tips":"给这位学生的一两句学习建议"}。' +
    'stages 数量 3-5 个，知识要点 4-6 个。\n' +
    '【配套课件要求】共 7-10 页，必须包含以下三类页面：\n' +
    '① 第 1 页 type=cover（封面，用 title + subtitle）；\n' +
    '② 中间若干页 type=content（知识模块），每页 bullets 2-4 条、每条不超过 28 字（要精炼到可直接投影），' +
    'note 写这一页老师要展开讲的话（2-3 句）；\n' +
    '③ **必须包含 2-3 页 type=quiz 的练习页**，分散在相关知识点之后（不要全堆在最后）。每页一道题：\n' +
    '   - question 是完整题干（数学要给出具体数字/式子，不能写"举例说明"这类空话）；\n' +
    '   - options 给 4 个选项（选择题），数组元素自带 "A. " 前缀；若是计算/推导题则 options 留空数组；\n' +
    '   - answer 填正确选项字母（如 "B"）或简要答案；\n' +
    '   - analysis 写解析：为什么选它、其他选项错在哪，2-3 句，要能让学生看懂；\n' +
    '   - 题目难度与该节课阶段匹配，第一道题偏基础，最后一道题可稍难。\n' +
    '④ 最后 1 页 type=summary（课堂小结）。\n' +
    '所有内容与 stages 呼应，可直接当讲课 PPT 使用。';

  const controller = new AbortController();
  try {
    const raw = await streamChat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: buildCourseOutlinePrompt() },
      ],
      temperature: 0.7,
      responseFormat: true,
      signal: controller.signal,
      onDelta: (_d, full) => {
        streamText.textContent = full;
        streamText.scrollTop = streamText.scrollHeight;
      },
      // 纯推理模型先"想"后"写"，这段静默期里给个明确反馈，别让人以为 AI 挂了
      onReasoning: (_d, _thinking, full) => {
        if (full) return;
        streamText.textContent = '灵犀老师正在设计这节课的讲法与随堂题…';
      },
      onNotice: (msg) => { streamText.textContent = msg; },
    });
    const outline = parseJSONLoose(raw);
    const boardNames = selectedBoardNames();
    const course = {
      id: 'c' + Date.now(),
      system: sysObj.id,
      systemName: sysObj.name,
      systemIco: sysObj.ico,
      boards: state.gen.boards.slice(),
      boardNames: boardNames,
      subject: state.gen.subject,
      grade: $('#gen-grade').value,
      level: state.gen.level,
      duration: state.gen.duration,
      goal: $('#gen-goal').value.trim(),
      createdAt: Date.now(),
      progress: 0,
      saved: false,
      outline: outline || null,
      rawOutline: outline ? null : raw,
      // 诊断画像随课程走：直播时老师能直接引用，不必依赖已登录的记忆
      diag: diagState.profile ? {
        focus: diagState.profile.focus.slice(0, 8),
        skip: diagState.profile.skip.slice(0, 8),
        counts: Object.assign({}, diagState.profile.counts),
        score: diagState.profile.score,
      } : null,
    };
    if (outline && outline.title) {
      course.title = outline.title;
    } else {
      course.title = state.gen.subject + ' · ' + state.gen.level + '一对一课';
    }
    course.slides = normalizeSlides(outline, course);
    streamBox.hidden = true;
    renderGenCourse(course);
    window.__lastGenerated = course;
    if (!outline) toast('AI 返回的格式略有偏差，已按原文展示，仍可上课', 'err');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      toast('已取消生成');
      streamBox.hidden = true;
    } else {
      const msg = mapLLMError(e) + errorRequestId(e);
      toast(msg, 'err');
      // 失败原因留在页面上：只闪一个 3 秒的 toast，用户会以为"点了没反应"
      streamText.textContent = '生成失败：' + msg +
        '\n\n可以点右上角「AI 状态」重试，或换一个模型再试。';
      streamBox.hidden = false;
      $('#gen-empty').hidden = true;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI 生成课程';
  }
}

function courseTags(course) {
  const sysTag = course.systemName
    ? `<span class="tag sys">${esc(course.systemIco || '')} ${esc(course.systemName)}</span>` : '';
  const boardTag = (course.boards && course.boards.length)
    ? course.boards.map((id) => {
      const b = getBoards(getSystem('intl')).find((x) => x.id === id);
      return b ? `<span class="tag board">${b.ico} ${esc(b.name)}</span>` : '';
    }).join('')
    : '';
  return `${sysTag}${boardTag}
        <span class="tag">${esc(course.subject)} · ${esc(course.grade)}</span>
        <span class="tag orange">${esc(course.level)}</span>
        <span class="tag teal">${esc(course.duration)}</span>`;
}

function renderGenCourse(course) {
  const o = course.outline;
  const el = $('#gen-course');
  const tags = courseTags(course);
  if (!o) {
    el.innerHTML = `
      <h3>${esc(course.title)}</h3>
      <div class="cc-tags">${tags}</div>
      <div class="cc-summary">AI 未返回结构化大纲，以下为原文方案：</div>
      <div class="cc-summary" style="white-space:pre-wrap">${esc(course.rawOutline)}</div>
      <div class="cc-actions">
        <button class="btn btn-ghost" id="btn-save-only">暂存到我的课程</button>
        <button class="btn btn-primary" id="btn-go-live">进入直播间</button>
      </div>`;
  } else {
    const stages = Array.isArray(o.stages) ? o.stages : [];
    const kps = Array.isArray(o.knowledgePoints) ? o.knowledgePoints : [];
    const hw = Array.isArray(o.homework) ? o.homework : [];
    el.innerHTML = `
      <div class="cc-top">
        <div>
          <h3>${esc(o.title || course.title)}</h3>
          <div class="cc-tags">${tags}</div>
        </div>
      </div>
      <p class="cc-summary">${esc(o.summary || '')}</p>
      ${kps.length ? `<div class="cc-block"><b>🎯 本课知识点</b><div class="kp-wrap">${
        kps.map((k) => `<span class="kp">${esc(k)}</span>`).join('')
      }</div></div>` : ''}
      ${stages.length ? `<div class="cc-block"><b>🧭 教学环节</b>${stages.map((s, i) => `
        <div class="stage-item">
          <span class="st-no">${i + 1}</span>
          <div><b>${esc(s.name || '环节' + (i + 1))}<span class="st-dur">${esc(s.duration || '')}</span></b>
          <p>${esc(s.content || '')}</p></div>
        </div>`).join('')}</div>` : ''}
      ${hw.length ? `<div class="cc-block"><b>✏️ 课后练习</b><div class="kp-wrap">${
        hw.map((h) => `<span class="kp">${esc(h)}</span>`).join('')
      }</div></div>` : ''}
      ${o.tips ? `<div class="cc-block"><b>💡 灵犀小贴士</b><p class="cc-summary">${esc(o.tips)}</p></div>` : ''}
      ${(course.slides && course.slides.length) ? `
      <div class="cc-block">
        <b>📊 配套课件 <span class="slide-count">${course.slides.length} 页</span></b>
        <div class="slide-strip">
          ${course.slides.map((s, i) => `
            <div class="slide-thumb" data-slide="${i}">
              <span class="sth-no">${i + 1}</span>
              <span class="sth-title">${esc(s.title)}</span>
            </div>`).join('')}
        </div>
      </div>` : ''}
      <div class="cc-actions">
        <button class="btn btn-ghost" id="btn-save-only">暂存到我的课程</button>
        ${(course.slides && course.slides.length) ? '<button class="btn btn-ghost" id="btn-preview-slides">预览课件</button>' : ''}
        <button class="btn btn-primary" id="btn-go-live">进入直播间开课</button>
      </div>`;
  }
  el.hidden = false;
  const saveOnly = $('#btn-save-only');
  if (saveOnly) saveOnly.addEventListener('click', () => saveCourse(course, true));
  const goLive = $('#btn-go-live');
  if (goLive) goLive.addEventListener('click', () => {
    saveCourse(course, false);
    enterLive(course);
  });
  const pv = $('#btn-preview-slides');
  if (pv) pv.addEventListener('click', () => openSlidePreview(course));
  const strip = el.querySelector('.slide-strip');
  if (strip) {
    strip.addEventListener('click', (ev) => {
      const t = ev.target.closest('.slide-thumb');
      if (!t) return;
      openSlidePreview(course, Number(t.dataset.slide));
    });
  }
}

/* ==================== 入学诊断：生成 / 作答 / 起点画像 ==================== */
/* 状态：diag 为当前诊断卷（含 items 与学生作答），profile 为聚合出的起点画像 */
const diagState = { paper: null, answers: {}, profile: null };

/* 渲染整份诊断卷。用原生 radio/textarea，不用自定义组件 ——
   开课前少一个"点不动"的可能。 */
function renderDiagnostic() {
  const el = $('#gen-diag');
  if (!el) return;
  const p = diagState.paper;
  if (!p || !p.items.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const answered = p.items.filter((it, i) => {
    const a = diagState.answers[i];
    return a && String(a.value || '').trim() !== '';
  }).length;

  el.innerHTML =
    '<div class="diag-head">' +
      '<b>📝 ' + esc(p.title) + '</b>' +
      '<span class="diag-prog" id="diag-prog">' + answered + ' / ' + p.items.length + ' 已作答</span>' +
    '</div>' +
    '<p class="diag-intro">' + esc(p.intro) + '</p>' +
    '<div class="diag-list">' + p.items.map((it, i) => diagItemHTML(it, i)).join('') + '</div>' +
    '<div class="diag-actions">' +
      '<button class="btn btn-primary" id="btn-diag-submit">提交，生成起点画像</button>' +
      '<button class="btn btn-ghost" id="btn-diag-skip">跳过诊断，直接生成课程</button>' +
    '</div>' +
    '<p class="form-hint">诊断只用来决定这节课从哪里讲起，<b>不影响</b>你能生成的课程内容。</p>';

  bindDiagEvents();
}

function diagItemHTML(it, i) {
  const a = diagState.answers[i] || {};
  const head = '<div class="diag-q-head"><span class="diag-no">' + (i + 1) + '</span>' +
    '<span class="diag-topic">' + esc(it.topic) + '</span></div>' +
    '<div class="diag-stem">' + mdLite(it.question) + '</div>';

  if (it.type === 'choice' && it.options.length) {
    const opts = it.options.map((o, k) => {
      const letter = String(o).trim().charAt(0).toUpperCase();
      const checked = String(a.value || '').toUpperCase() === letter ? ' checked' : '';
      return '<label class="diag-opt">' +
        '<input type="radio" name="diag-' + i + '" value="' + esc(letter) + '"' + checked + '>' +
        '<span class="diag-opt-key">' + esc(letter) + '</span>' +
        '<span class="diag-opt-txt">' + esc(String(o).replace(/^[A-Fa-f][.、．)）]\s*/, '')) + '</span>' +
        '</label>';
    }).join('');
    return '<div class="diag-item" data-i="' + i + '">' + head + '<div class="diag-opts">' + opts + '</div></div>';
  }

  // 简答题：写上答案 + 自评（自评是简答题唯一可用的判据，必须让填）
  const self = String(a.self || '');
  return '<div class="diag-item" data-i="' + i + '">' + head +
    '<textarea class="diag-open" rows="2" data-i="' + i + '" placeholder="写下你的答案或思路；不会就直接留空，也可以的">' +
      esc(a.value || '') + '</textarea>' +
    '<div class="diag-self">' +
      '<span>自评：</span>' +
      '<label><input type="radio" name="diag-self-' + i + '" value="sure"' + (self === 'sure' ? ' checked' : '') + '>做对了</label>' +
      '<label><input type="radio" name="diag-self-' + i + '" value="unsure"' + (self === 'unsure' ? ' checked' : '') + '>不确定</label>' +
    '</div></div>';
}

function updateDiagProgress() {
  const el = $('#diag-prog');
  const p = diagState.paper;
  if (!el || !p) return;
  const answered = p.items.filter((it, i) => {
    const a = diagState.answers[i];
    return a && String(a.value || '').trim() !== '';
  }).length;
  el.textContent = answered + ' / ' + p.items.length + ' 已作答';
}

function bindDiagEvents() {
  const el = $('#gen-diag');
  if (!el) return;
  // 选择题：点选即记
  el.querySelectorAll('input[type=radio][name^="diag-"]').forEach((r) => {
    const m = /^diag-(\d+)$/.exec(r.name);
    if (!m) return;
    r.addEventListener('change', () => {
      const i = Number(m[1]);
      diagState.answers[i] = Object.assign({}, diagState.answers[i], { value: r.value });
      updateDiagProgress();
    });
  });
  // 简答题：输入即记（用 input 而非 change，避免点"提交"时还没 blur 导致丢答案）
  el.querySelectorAll('textarea.diag-open').forEach((ta) => {
    ta.addEventListener('input', () => {
      const i = Number(ta.dataset.i);
      diagState.answers[i] = Object.assign({}, diagState.answers[i], { value: ta.value });
      updateDiagProgress();
    });
  });
  el.querySelectorAll('input[type=radio][name^="diag-self-"]').forEach((r) => {
    const m = /^diag-self-(\d+)$/.exec(r.name);
    if (!m) return;
    r.addEventListener('change', () => {
      const i = Number(m[1]);
      diagState.answers[i] = Object.assign({}, diagState.answers[i], { self: r.value });
    });
  });
  const sub = $('#btn-diag-submit');
  if (sub) sub.addEventListener('click', () => submitDiagnostic());
  const skip = $('#btn-diag-skip');
  if (skip) skip.addEventListener('click', () => {
    diagState.paper = null;
    diagState.answers = {};
    diagState.profile = null;
    const box = $('#gen-diag');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    toast('已跳过诊断，直接生成课程');
  });
}

/* 生成诊断卷（LLM） */
async function generateDiagnostic() {
  if (!requireModel()) return;
  const btn = $('#btn-diag-gen');
  const box = $('#gen-diag');
  if (btn) { btn.disabled = true; btn.textContent = '诊断卷生成中…'; }
  const prev = $('#gen-course');
  if (prev) prev.hidden = true;
  const empty = $('#gen-empty');
  if (empty) empty.hidden = true;
  if (box) {
    box.hidden = false;
    box.innerHTML = '<div class="diag-loading"><i class="dot dot-live"></i>正在根据你的目标出诊断题…</div>';
  }

  const opt = {
    system: state.gen.system,
    subject: state.gen.subject,
    grade: ($('#gen-grade') || {}).value || '',
    goal: (($('#gen-goal') || {}).value || '').trim(),
    boards: selectedBoardNames(),
    count: 6,
  };
  try {
    const raw = await streamChat({
      messages: [
        { role: 'system', content: diagnosticSystemPrompt() },
        { role: 'user', content: buildDiagnosticPrompt(opt) },
      ],
      temperature: 0.6,
      responseFormat: true,
      onDelta: (_d, full) => {
        if (box && full) box.querySelector('.diag-loading').textContent = '正在出题…（' + full.length + ' 字）';
      },
      onNotice: (msg) => {
        if (box && box.querySelector('.diag-loading')) box.querySelector('.diag-loading').textContent = msg;
      },
    });
    const parsed = parseJSONLoose(raw);
    const paper = cleanDiagnostic(parsed, opt);
    if (!paper.items.length) {
      if (box) { box.hidden = true; box.innerHTML = ''; }
      toast('诊断卷生成失败，可直接生成课程', 'err');
      return;
    }
    diagState.paper = paper;
    diagState.answers = {};
    diagState.profile = null;
    renderDiagnostic();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      toast('已取消');
    } else {
      toast(mapLLMError(e) + errorRequestId(e), 'err');
    }
    if (box) { box.hidden = true; box.innerHTML = ''; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📝 先做课前诊断（可选）'; }
  }
}

/* 提交诊断 → 算起点画像 → 渲染 → 为用户下一步生成课程做好准备 */
function submitDiagnostic() {
  const p = diagState.paper;
  if (!p || !p.items.length) return;
  const answers = p.items.map((_, i) => diagState.answers[i] || {});
  const profile = buildDiagnostic(p.items, answers);
  diagState.profile = profile;
  renderDiagProfile(profile);
  // 提交后收起答题区，只留画像
  const list = $('#gen-diag .diag-list');
  if (list) list.hidden = true;
  const acts = $('#gen-diag .diag-actions');
  if (acts) acts.hidden = true;
  toast('起点画像已生成，课程会从这里讲起');
}

/* 渲染起点画像 */
function renderDiagProfile(profile) {
  const el = $('#gen-diag');
  if (!el || !profile) return;
  const c = profile.counts;
  const chip = '<span class="dp-chip">' +
    DIAG_MIN + '~' + DIAG_MAX + ' 题 · 覆盖 ' + profile.total + ' 个知识点</span>';

  // 单个知识点一行：topic / reason 都是模型或学生输入，必须转义
  const topicRow = (t) => {
    const L = DIAG_LEVELS[t.level] || DIAG_LEVELS.na;
    return '<div class="dp-topic ' + L.cls + '">' +
      '<span class="dp-ico">' + L.icon + '</span>' +
      '<b>' + esc(t.topic) + '</b>' +
      '<span class="dp-lv">' + L.label + '</span>' +
      (t.reason ? '<span class="dp-why">' + esc(t.reason) + '</span>' : '') +
      '</div>';
  };

  // verdict 里有我故意写进去的 <b> 强调标签，但它是 buildDiagnostic 里
  // 我自己拼的固定文案（不含任何模型/用户输入），所以只做定长白名单式放行：
  // 先把 <b></b> 抠出来，其余字符一律走 esc()，这样即便将来文案里混进变量也不会漏。
  const safeVerdict = esc(String(profile.verdict || ''))
    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');

  // 把画像 HTML 插到答题区上方（答题区已隐藏）。
  // 下面每一处动态值都当场走 esc()/mdLite() —— 不依赖"上面的 helper 已经转过了"，
  // 因为那种间接转义既无法被静态审查看到，将来改 helper 时也会静默变脏。
  const box = document.createElement('div');
  box.className = 'dp-wrap';
  box.innerHTML =
    '<div class="dp-top">' + mdLite('🎯 你的起点画像') + mdLite(chip) + '</div>' +
    '<div class="dp-stats">' +
      '<div class="dp-stat ok"><b>' + esc(c.ok) + '</b><span>已掌握</span></div>' +
      '<div class="dp-stat fuzzy"><b>' + esc(c.fuzzy) + '</b><span>待确认</span></div>' +
      '<div class="dp-stat gap"><b>' + esc(c.gap) + '</b><span>未掌握</span></div>' +
      (c.na ? '<div class="dp-stat na"><b>' + esc(c.na) + '</b><span>未作答</span></div>' : '') +
    '</div>' +
    // verdict 里的 <b> 是我自己写的固定强调；safeVerdict 已做"先全转义再放回 b 标签"
    '<div class="dp-verdict">' + safeVerdict + '</div>' +
    (profile.focus.length ? '<div class="dp-block"><b>▶ 这节课重点讲</b><div class="dp-topics">' +
      profile.topics.filter((t) => profile.focus.indexOf(t.topic) >= 0).map((t) => topicRow(t)).join('') +
      '</div></div>' : '') +
    (profile.skip.length ? '<div class="dp-block"><b>⏭ 可以跳过（已掌握）</b><div class="dp-skips">' +
      profile.skip.map((t) => '<span class="dp-skip">' + esc(t) + '</span>').join('') +
      '</div></div>' : '') +
    '<p class="dp-hint">这份画像会一起交给老师 —— 上课时他/她<b>不会再讲你已经会的部分</b>，' +
    '而是直接从标红的知识点开始。多错几道反而是好事，说的是真话才能真的帮到你。</p>' +
    '<div class="dp-actions">' +
      '<button class="btn btn-ghost btn-sm" id="btn-diag-retry">重做一遍</button>' +
      '<button class="btn btn-primary btn-sm" id="btn-diag-tocourse">继续生成课程 →</button>' +
    '</div>';
  el.appendChild(box);

  const retry = box.querySelector('#btn-diag-retry');
  if (retry) retry.addEventListener('click', () => {
    diagState.answers = {};
    diagState.profile = null;
    const old = $('#gen-diag .dp-wrap');
    if (old) old.remove();
    const list = $('#gen-diag .diag-list');
    if (list) list.hidden = false;
    const acts = $('#gen-diag .diag-actions');
    if (acts) acts.hidden = false;
    if (list) list.querySelectorAll('input, textarea').forEach((x) => {
      if (x.type === 'radio' || x.type === 'checkbox') x.checked = false;
      else x.value = '';
    });
    updateDiagProgress();
  });
  const toc = box.querySelector('#btn-diag-tocourse');
  if (toc) toc.addEventListener('click', () => {
    const g = $('#btn-generate');
    if (g) {
      g.scrollIntoView({ behavior: 'smooth', block: 'center' });
      g.classList.add('pulse');
      setTimeout(() => g.classList.remove('pulse'), 1600);
    }
    toast('点「✨ AI 生成课程」，会带上你的起点画像');
  });
}

/* 把起点画像写进长期记忆：让"这节课从哪里讲起"跨课生效 */
async function persistDiagnostic(profile, opt) {
  if (!profile || !profile.judged) return 0;
  const o = opt || {};
  const facts = [];
  // 未掌握 / 待确认 → 薄弱点，直接进 prompt 的"需要重点关注"
  profile.topics.filter((t) => t.level === 'gap').forEach((t) => {
    facts.push({
      kind: 'weak', topic: t.topic, subject: o.subject || state.gen.subject,
      confidence: 0.9, source: 'diagnostic',
      content: '课前诊断显示「' + t.topic + '」还没掌握' + (t.reason ? '（' + t.reason + '）' : '') +
        '，第一节课要从这里开始讲。',
    });
  });
  profile.topics.filter((t) => t.level === 'fuzzy').forEach((t) => {
    facts.push({
      kind: 'weak', topic: t.topic, subject: o.subject || state.gen.subject,
      confidence: 0.65, source: 'diagnostic',
      content: '课前诊断显示「' + t.topic + '」掌握得不牢' + (t.reason ? '（' + t.reason + '）' : '') +
        '，需要再确认一遍。',
    });
  });
  // 已掌握 → 优势，用于让老师跳过铺垫
  profile.topics.filter((t) => t.level === 'ok').forEach((t) => {
    facts.push({
      kind: 'strength', topic: t.topic, subject: o.subject || state.gen.subject,
      confidence: 0.8, source: 'diagnostic',
      content: '课前诊断中「' + t.topic + '」答对了，已掌握，讲课时可以直接略过基础铺垫。',
    });
  });
  facts.push({
    kind: 'context', subject: o.subject || state.gen.subject,
    confidence: 0.75, source: 'diagnostic',
    content: '入学诊断起步水平：' + profile.counts.ok + ' 个知识点已掌握、' +
      profile.counts.fuzzy + ' 个待确认、' + profile.counts.gap + ' 个未掌握（共判断 ' +
      profile.judged + ' 个知识点）。',
  });
  const n = await saveFacts(facts);
  // 画像里的 goal / level 也顺手补上，让 memoryPromptBlock 更完整
  try {
    await saveProfile({
      grade: o.grade || undefined,
      system: getSystem(o.system || state.gen.system).name,
      goal: o.goal || undefined,
      level: profile.counts.gap > profile.counts.ok ? '基础巩固' : '进阶提升',
    });
  } catch (_) {}
  return n;
}

/* 起点画像 → 课程生成提示词的一段。
   ★ 这是整个诊断功能的落点：**把"哪些可以不讲"明确交给课程设计模型**。
   只告诉它"学生薄弱"是不够的 —— 必须同时说"这些他已经会了，别讲"。 */
function diagnosticPromptBlock() {
  const pf = diagState.profile;
  if (!pf || !pf.judged) return '';
  const lines = [];
  if (pf.focus.length) lines.push('· 诊断显示**尚未掌握 / 需要确认**的知识点：' + pf.focus.join('、'));
  if (pf.skip.length) {
    lines.push('· 诊断显示**已经掌握**的知识点：' + pf.skip.join('、') +
      ' —— 这些**不要再花时间从零讲**，最多用一道小题快速带过。');
  }
  lines.push('· 请按此调整这节课的重心：把主要时间给到上面"尚未掌握"的知识点，' +
    '难度从它们的基础形态切入，不要因为学生选了"' + state.gen.level + '"就默认他已具备全部前置知识。');
  return '\n【课前诊断结果（这位学生刚做的起点测验）】\n' + lines.join('\n') + '\n';
}

/* ==================== 课件：预览 / 放映 / 导出 PPTX ==================== */
const slideState = { course: null, index: 0, mode: 'preview' };

/* 生成一页幻灯片的 HTML（16:9），封面 / 内容 / 练习 / 小结 四种版式 */
function slideHTML(slide, i, total, theme) {
  const t = theme || 'indigo';
  // 类型：显式 type 优先，兼容老的 cover 判定
  let type = slide.type;
  if (!type) type = (slide.cover === true || ((slide.bullets || []).length === 0 && i === 0)) ? 'cover' : 'content';
  const isCover = type === 'cover';
  const isQuiz = type === 'quiz';
  const isSummary = type === 'summary';
  const cls = 'sl sl-' + t + (isCover ? ' sl-cover' : '') + (isQuiz ? ' sl-quiz' : '') + (isSummary ? ' sl-summary' : '');

  if (isCover) {
    return `<div class="${cls}">
      <div class="sl-deco"></div>
      <div class="sl-body">
        <h2>${esc(slide.title)}</h2>
        ${slide.subtitle ? `<p class="sl-sub">${esc(slide.subtitle)}</p>` : ''}
        <div class="sl-foot">灵犀课堂 · AI 一对一直播课</div>
      </div>
      <span class="sl-page">${i + 1} / ${total}</span>
    </div>`;
  }

  const head = `<div class="sl-head">
      <h3>${esc(slide.title)}</h3>
      ${slide.subtitle ? `<span class="sl-sub-inline">${esc(slide.subtitle)}</span>` : ''}
    </div>`;

  if (isQuiz) {
    // 练习页：题干 + 选项（点击可高亮）+ 折叠的答案与解析
    const opts = (slide.options || []).map((o, k) => {
      const letter = String(o).trim().charAt(0).toUpperCase();
      const isRight = slide.answer && letter === String(slide.answer).trim().toUpperCase();
      return `<li class="qz-opt${isRight ? ' qz-right' : ''}" data-opt="${esc(letter)}">
        <span class="qz-key">${esc(letter)}</span>
        <span class="qz-txt">${mdLite(String(o).replace(/^[A-Da-d][.、．)）]\s*/, ''))}</span>
      </li>`;
    }).join('');
    const ansBlock = (slide.answer || slide.analysis) ? `
      <details class="qz-ans">
        <summary>查看答案与解析</summary>
        <div class="qz-ans-body">
          ${slide.answer ? `<p class="qz-ans-line"><b>正确答案：</b><span class="qz-ans-key">${esc(slide.answer)}</span></p>` : ''}
          ${slide.analysis ? `<p class="qz-ans-txt">${mdLite(slide.analysis)}</p>` : ''}
        </div>
      </details>` : '';
    return `<div class="${cls}">
      ${head}
      <div class="qz-body">
        <div class="qz-stem"><span class="qz-badge">练习</span>${mdLite(slide.question || '请完成本题')}</div>
        ${opts ? `<ul class="qz-opts">${opts}</ul>` : '<div class="qz-open">请写出你的解答过程，完成后我们一起对照检查。</div>'}
        ${ansBlock}
      </div>
      <span class="sl-page">${i + 1} / ${total}</span>
    </div>`;
  }

  // 内容页 / 小结页
  const bullets = (slide.bullets || []).map((b) => `<li>${mdLite(b)}</li>`).join('');
  return `<div class="${cls}">
    ${head}
    <ul class="sl-bullets">${bullets || '<li>重点讲解</li>'}</ul>
    <span class="sl-page">${i + 1} / ${total}</span>
  </div>`;
}

/* 课件主题（按体系区分配色） */
function slideTheme(course) {
  if (course && course.system === 'intl') return 'ocean';
  return 'indigo';
}

function openSlidePreview(course, startIndex) {
  const modal = $('#slide-modal');
  const slides = course.slides || [];
  if (!slides.length) { toast('这节课还没有课件', 'err'); return; }
  slideState.course = course;
  slideState.mode = 'preview';
  slideState.index = Number.isFinite(startIndex) ? startIndex : 0;
  $('#slide-modal-title').textContent = '课件预览 · ' + course.title;
  modal.hidden = false;
  renderSlideViewer();
}

function renderSlideViewer() {
  const { course, index, mode } = slideState;
  const slides = course.slides || [];
  const total = slides.length;
  const theme = slideTheme(course);
  // 主画面：放映模式加上下页提示
  $('#slide-stage').innerHTML = slideHTML(slides[index], index, total, theme);
  $('#slide-pageinfo').textContent = (index + 1) + ' / ' + total;
  // 缩略图
  $('#slide-nav').innerHTML = slides.map((s, i) => `
    <button class="snav-item${i === index ? ' active' : ''}" data-goto="${i}">
      <span class="snav-no">${i + 1}</span>
      <span class="snav-title">${esc(s.title)}</span>
    </button>`).join('');
  // 讲稿备注（预览模式下显示）
  const note = slides[index].note || '';
  const noteEl = $('#slide-note');
  noteEl.hidden = !note;
  noteEl.innerHTML = note ? `<b>🎙 讲稿：</b>${esc(note)}` : '';
  $('#btn-slide-prev').disabled = index === 0;
  $('#btn-slide-next').disabled = index === total - 1;
}

function slideGo(delta) {
  const slides = slideState.course.slides || [];
  const next = slideState.index + delta;
  if (next < 0 || next >= slides.length) return;
  slideState.index = next;
  renderSlideViewer();
}

function closeSlidePreview() {
  $('#slide-modal').hidden = true;
  slideState.course = null;
}

/* 导出为真实 .pptx（浏览器端生成，无需后端） */
function exportPPTX(course) {
  const PptxGenJS = window.PptxGenJS || (window.pptxgen && window.pptxgen.default);
  if (!PptxGenJS) { toast('PPT 导出组件加载中，请稍后重试', 'err'); return; }

  const slides = course.slides || [];
  if (!slides.length) { toast('这节课还没有课件', 'err'); return; }

  const isIntl = course.system === 'intl';
  const PRIMARY = isIntl ? '0284C7' : '5B5CE6';
  const PRIMARY2 = isIntl ? '0EA5E9' : '8B5CF6';
  const INK = '1D2130';
  const MUTED = '6B7186';
  const FONT = '微软雅黑';

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = '灵犀课堂';
  pptx.company = '灵犀课堂 LingXi Classroom';
  pptx.title = course.title;

  slides.forEach((s, i) => {
    const isCover = s.type === 'cover' || (s.cover === true) ||
      ((s.bullets || []).length === 0 && i === 0 && s.type !== 'quiz');
    const isQuiz = !isCover && s.type === 'quiz';
    const slide = pptx.addSlide();

    if (isCover) {
      slide.background = { color: PRIMARY };
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 3.35, w: 10, h: 0.06, fill: { color: PRIMARY2 } });
      slide.addText(s.title || course.title, {
        x: 0.8, y: 1.5, w: 8.4, h: 1.1, fontSize: 36, bold: true,
        color: 'FFFFFF', fontFace: FONT, align: 'left',
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 0.8, y: 2.6, w: 8.4, h: 0.6, fontSize: 16, color: 'E0E7FF', fontFace: FONT,
        });
      }
      slide.addText('灵犀课堂 · AI 一对一直播课', {
        x: 0.8, y: 4.55, w: 8.4, h: 0.4, fontSize: 12, color: 'C7D2FE', fontFace: FONT,
      });
    } else if (isQuiz) {
      // 顶部橙色标题条（练习页与内容页区分开）
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.12, fill: { color: 'F59E0B' } });
      slide.addText('✎ ' + (s.title || '随堂练习'), {
        x: 0.7, y: 0.5, w: 7.6, h: 0.8, fontSize: 24, bold: true, color: INK, fontFace: FONT,
      });
      slide.addShape(pptx.ShapeType.rect, { x: 0.72, y: 1.32, w: 1.1, h: 0.05, fill: { color: 'F59E0B' } });
      // 题干
      if (s.question) {
        slide.addText(String(s.question), {
          x: 0.75, y: 1.6, w: 8.5, h: 0.9, fontSize: 17, bold: true, color: '2A2F45',
          fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25,
        });
      }
      // 选项
      const opts = s.options || [];
      if (opts.length) {
        const objs = opts.map((o) => {
          const letter = String(o).trim().charAt(0).toUpperCase();
          const right = s.answer && letter === String(s.answer).trim().toUpperCase();
          return {
            text: String(o),
            options: {
              color: right ? '16A34A' : INK, bold: !!right, fontSize: 15,
              breakLine: true, paraSpaceAfter: 8, bullet: false,
            },
          };
        });
        slide.addText(objs, {
          x: 0.95, y: 2.62, w: 8.3, h: 1.9, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.25,
        });
      }
      // 答案与解析（放右下角浅色块）
      if (s.answer || s.analysis) {
        const lines = [];
        if (s.answer) lines.push({ text: '正确答案：' + s.answer, options: { color: '16A34A', bold: true, fontSize: 13, breakLine: true, paraSpaceAfter: 4 } });
        if (s.analysis) lines.push({ text: s.analysis, options: { color: MUTED, fontSize: 12, breakLine: true } });
        slide.addShape(pptx.ShapeType.roundRect, {
          x: 0.75, y: 4.5, w: 8.5, h: s.analysis ? 0.95 : 0.5, fill: { color: 'F5F7FF' },
          line: { color: 'E2E6F7', width: 0.5 }, rectRadius: 0.06,
        });
        slide.addText(lines, {
          x: 0.92, y: 4.6, w: 8.2, h: s.analysis ? 0.78 : 0.34,
          fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.2,
        });
      }
      if (s.note) slide.addNotes(s.note);
      slide.addText(String(i + 1), {
        x: 9.1, y: 5.15, w: 0.6, h: 0.3, fontSize: 11, color: MUTED, fontFace: FONT, align: 'right',
      });
    } else {
      // 顶部标题条
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.12, fill: { color: PRIMARY } });
      slide.addText(s.title || '', {
        x: 0.7, y: 0.5, w: 7.6, h: 0.8, fontSize: 26, bold: true, color: INK, fontFace: FONT,
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 7.0, y: 0.65, w: 2.3, h: 0.5, fontSize: 12, color: PRIMARY, fontFace: FONT, align: 'right',
        });
      }
      slide.addShape(pptx.ShapeType.rect, { x: 0.72, y: 1.32, w: 1.1, h: 0.05, fill: { color: PRIMARY2 } });

      const bullets = (s.bullets || []).map((b) => ({
        text: String(b),
        options: { bullet: { code: '25CF' }, color: INK, fontSize: 17, breakLine: true, paraSpaceAfter: 12 },
      }));
      if (bullets.length) {
        slide.addText(bullets, {
          x: 0.85, y: 1.75, w: 8.3, h: 3.1, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.3,
        });
      }
      // 讲稿备注（PPT 演讲者备注）
      if (s.note) slide.addNotes(s.note);
      slide.addText(String(i + 1), {
        x: 9.1, y: 5.15, w: 0.6, h: 0.3, fontSize: 11, color: MUTED, fontFace: FONT, align: 'right',
      });
    }
  });

  const safeName = String(course.title || '课件').replace(/[\\/:*?"<>|]/g, '_');
  pptx.writeFile({ fileName: safeName + '.pptx' })
    .then(() => toast('PPT 已开始下载', 'ok'))
    .catch((e) => { console.error(e); toast('PPT 导出失败：' + (e.message || '未知错误'), 'err'); });
}

function saveCourse(course, notify) {
  // 注意：这里必须是 state.courses（历史上有过引用未定义的 arr，会让"进入直播间"直接抛 ReferenceError）
  const idx = state.courses.findIndex((c) => c.id === course.id);
  course.saved = true;
  if (idx >= 0) state.courses[idx] = course; else state.courses.unshift(course);
  try {
    localStorage.setItem('lingxi_courses_v1', JSON.stringify(state.courses));
  } catch (_) { /* 存储满时静默，仅影响本地列表 */ }
  if (notify) {
    toast('已保存到「我的课程」', 'ok');
    const b = $('#btn-save-only');
    if (b) { b.textContent = '已保存 ✓'; b.disabled = true; }
  }
}

function loadCourses() {
  try {
    state.courses = JSON.parse(localStorage.getItem('lingxi_courses_v1') || '[]');
    if (!Array.isArray(state.courses)) state.courses = [];
  } catch (_) { state.courses = []; }
}

function renderCourses() {
  const list = $('#course-list');
  const empty = $('#course-empty');
  const filterRow = $('#course-filter');
  const all = state.courses;
  if (!all.length) {
    list.innerHTML = '';
    if (filterRow) filterRow.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  // 按体系筛选（仅在存在国际课程时显示筛选条）
  const hasIntl = all.some((c) => c.system === 'intl');
  const hasCn = all.some((c) => c.system !== 'intl');
  if (filterRow) {
    filterRow.hidden = !(hasIntl && hasCn);
    filterRow.innerHTML = [['all', '全部'], ['cn', '🇨🇳 国内课程'], ['intl', '🌐 国际课程']]
      .map(([k, label]) => `<button class="chip${(state.courseFilter || 'all') === k ? ' active' : ''}" data-filter="${k}">${label}</button>`)
      .join('');
  }
  const f = state.courseFilter || 'all';
  const rows = all.filter((c) => f === 'all' || (f === 'intl' ? c.system === 'intl' : c.system !== 'intl'));

  list.innerHTML = rows.map((c) => `
    <div class="course-item">
      <h3>${esc(c.title)}</h3>
      <div class="ci-meta">
        ${c.systemName ? `<span class="tag sys">${esc(c.systemIco || '')} ${esc(c.systemName)}</span>` : ''}
        ${(c.boards || []).map((id) => {
          const b = getBoards(getSystem('intl')).find((x) => x.id === id);
          return b ? `<span class="tag board">${b.ico} ${esc(b.name)}</span>` : '';
        }).join('')}
        <span class="tag">${esc(c.subject)} · ${esc(c.grade)}</span>
        <span class="tag orange">${esc(c.level)}</span>
        <span class="ci-date">${fmtDate(c.createdAt)}</span>
      </div>
      <div class="ci-progress"><i style="width:${Math.round((c.progress || 0) * 100)}%"></i></div>
      <small style="color:var(--muted)">课程进度 ${Math.round((c.progress || 0) * 100)}%${(c.slides && c.slides.length) ? ' · 课件 ' + c.slides.length + ' 页' + (quizCountOf(c) ? '（含 ' + quizCountOf(c) + ' 道题）' : '') : ''}${(c.replay && c.replay.events && c.replay.events.length) ? ' · <span class="ci-replay-dot"></span>回放 ' + fmtTime(c.replay.duration) : ''}${c.avatarVideo ? ' · 🎬 数字人' : ''}</small>
      <div class="ci-foot">
        <button class="btn btn-primary btn-sm" data-enter="${esc(c.id)}">进入课堂</button>
        ${(c.replay && c.replay.events && c.replay.events.length)
          ? `<button class="btn btn-ghost btn-sm btn-replay" data-replay="${esc(c.id)}">⏺ 回放</button>` : ''}
        ${(c.slides && c.slides.length)
          ? `<button class="btn btn-ghost btn-sm" data-slides="${esc(c.id)}">📊 课件</button>
             <button class="btn btn-ghost btn-sm" data-ppt="${esc(c.id)}">导出 PPT</button>`
          : `<button class="btn btn-ghost btn-sm" data-mkslides="${esc(c.id)}">✨ 生成课件</button>`}
        <button class="ci-del" data-del="${esc(c.id)}">删除</button>
      </div>
    </div>`).join('');
}

/* ---------- 直播课堂 ---------- */

/* ===== 苏格拉底式教学引擎 =====
   参考 2025 年 AI 辅导（AI tutoring）教学法研究：
   - 苏格拉底四阶段：Elicitation 引出 → Probing 追问 → Contradiction/Extension 矛盾或延伸 → Synthesis 综合
   - 反「答案倾倒」：1-2 个针对性追问后才给一个小提示；两次尝试失败后才给示范解答
   - 元认知提示：先让学生说清"卡在哪一步、为什么"
   - 主动回忆与间隔重复：讲完知识点用小题复述检验，课后生成闪卡
   - 成长型思维：把错误归因为"策略还没找到"，而不是"你不会"
   - 可调支持等级：学生可随时要求"更多引导 / 让我自己试"                                     */

const GUIDE_PROFILES = {
  more: {
    name: '更多引导',
    tip: '多给提示与脚手架，拆小步子',
    rule:
      '学生当前选择了「更多引导」支持等级：\n' +
      '     · 把每个知识点再拆成 2-3 个小步子，每步都先确认学生跟上再继续。\n' +
      '     · 追问不超过 1 轮；学生一旦显露出困难，立刻给出一个明确的小提示或类比。\n' +
      '     · 多用"我们一起来看""我陪你走一遍"这类陪伴式措辞，降低学生的畏难感。',
  },
  balanced: {
    name: '均衡',
    tip: '先追问、再给提示的默认节奏',
    rule:
      '学生当前使用默认的「均衡」引导节奏：\n' +
      '     · 每个知识点先用 1-2 个追问把学生的思路掏出来，再决定给提示还是推进。\n' +
      '     · 提示与放手交替：一次由你示范，下一次让学生自己说思路。',
  },
  less: {
    name: '更多自主',
    tip: '让学生先自己想，只在卡死时出手',
    rule:
      '学生当前选择了「更多自主」支持等级：\n' +
      '     · 先让学生自己完整说一遍思路与答案，**不要抢先提示**。\n' +
      '     · 只在学生明确说"我不会"或连续两次尝试都卡住时才介入，且只给方向不给结论。\n' +
      '     · 学生答对后不要只夸结果，追问"如果条件反过来，结论还成立吗"来拓展迁移。',
  },
};

/* 讲解长度可以调，但"提问密度"必须保持：这是苏格拉底式辅导的关键 */
const META_RULE =
  '元认知提问（必须贯穿全程，不要省略）：\n' +
  '     · 学生答错或说不会时，先问"你能指一下自己卡在哪一步吗？是概念没懂，还是步骤不会用？"再给帮助。\n' +
  '     · 每讲完一个较难的知识点，问一句"这一块如果让你讲给别人听，你会怎么说？"来检验真正的理解。\n' +
  '     · 学生答对时，追问"你为什么选这个思路？当时是怎么想到的？"，把正确直觉变成可复用的方法。';

const SOCRATIC_RULE =
  '苏格拉底式提问（本课最重要的教学方式）：\n' +
  '        a) 引出：新知识点先别急着讲，用一个问题把学生已有的经验"勾"出来（"你觉得……会怎么样？你已经会哪些相关的？"）。\n' +
  '        b) 追问：针对学生回答里的**具体主张**追问，一次只问一个问题，问完停下来等他答。\n' +
  '        c) 矛盾或延伸：如果他的推理有问题，给一个反例或极端情形让他自己发现矛盾；如果是对的，就换一个更难的变式继续延伸。\n' +
  '        d) 综合：一个知识点收尾时，请学生用自己的话把结论复述一遍，你再补一句精炼总结。\n' +
  '     · 绝不做"答案倾倒"：连续 1-2 个追问之后才给**一个小提示**（不是答案）；\n' +
  '       只有当学生连续两次尝试都失败、或明确说"直接告诉我吧"，才给出完整示范解答（worked example），\n' +
  '       并且示范完立刻让他用同类题自己做一遍。';

function guideProfile() {
  return GUIDE_PROFILES[state.guide] || GUIDE_PROFILES.balanced;
}

function teacherSystemPrompt(course) {
  const o = course.outline;
  const isIntl = course.system === 'intl';
  let outlineText = '';
  if (o && Array.isArray(o.stages)) {
    outlineText = o.stages.map((s, i) => `${i + 1}. ${s.name}（${s.duration || ''}）：${s.content || ''}`).join('\n');
  } else if (course.rawOutline) {
    outlineText = course.rawOutline;
  }
  const boardLine = (course.boardNames && course.boardNames.length)
    ? '；对标考纲：' + course.boardNames.join('、') : '';
  const boardRules = (course.boards || []).map((id) => BOARD_GUIDE[id]).filter(Boolean);
  const slides = course.slides || [];
  const slideText = slides.length
    ? slides.map((s, i) => {
        const tag = s.type === 'quiz' ? '【练习页】' : (s.type === 'summary' ? '【小结页】' : (s.type === 'cover' ? '【封面】' : ''));
        let line = `第 ${i + 1} 页${tag}「${s.title}」`;
        if (s.type === 'quiz') {
          if (s.question) line += ' 题目：' + s.question;
          if (s.options && s.options.length) line += ' 选项：' + s.options.join(' / ');
          if (s.answer) line += ' 正确答案：' + s.answer;
          if (s.analysis) line += ' 解析：' + s.analysis;
        } else if (s.bullets && s.bullets.length) {
          line += ' 要点：' + s.bullets.join('；');
        }
        if (s.note) line += ' 讲解：' + s.note;
        return line;
      }).join('\n')
    : '';
  const quizCount = slides.filter((s) => s.type === 'quiz').length;
  const guide = guideProfile();
  const memBlock = memoryPromptBlock();

  // 课前诊断：即使未登录（没有长期记忆），这次诊断的结果也必须让老师知道
  const dg = course.diag;
  let diagBlock = '';
  if (dg && (dg.focus.length || dg.skip.length)) {
    const seg = ['【课前诊断结果（这节课开课前学生刚做的）】'];
    if (dg.focus.length) seg.push('· 尚未掌握/需要确认：' + dg.focus.join('、') + ' —— 这些是本节课的重点。');
    if (dg.skip.length) {
      seg.push('· 已经掌握：' + dg.skip.join('、') +
        ' —— **不要再从零讲这些**，最多用一句"这个你已经会了，我们直接看下一块"带过，' +
        '把时间留给上面那些没掌握的。');
    }
    seg.push('· 诊断不等于定论：如果课上一问发现他其实会，就立刻往下走，不要照着诊断硬讲。');
    diagBlock = seg.join('\n') + '\n';
  }

  const langRule = isIntl
    ? '本课属于国际课程体系：讲解以简体中文为主、关键术语给出英文原名（如 "牛顿第二定律 Newton\'s second law"），' +
      '并按国际课堂习惯使用英文题干引述；若学生要求全英授课，则切换为全英文讲解、必要时用中文补充解释。'
    : '';

  return '你是「灵犀课堂」的 AI 一对一老师，名叫"灵犀老师"，正在给学生上一节一对一直播课。' +
    '全程使用简体中文，口语化、亲切、有耐心。你既能辅导中国国家课程与中高考，' +
    '也能辅导 IB、A-Level、HKDSE、AP 等国际课程与标化考试。\n' +
    '你的教学信条：**不是把知识讲给学生听，而是用问题把知识从学生心里"问"出来。**\n' +
    '【课程信息】体系：' + (course.systemName || '国内课程') + boardLine + '；标题：' + course.title +
    '；科目：' + course.subject + '；阶段：' + course.grade +
    '；难度：' + course.level + '；时长：' + course.duration + '。\n' +
    (course.goal ? '【学生的学习目标】' + course.goal + '\n' : '') +
    diagBlock +
    (memBlock ? memBlock + MEMORY_USE_RULE + '\n' : '') +
    (outlineText ? '【课程大纲】\n' + outlineText + '\n' : '') +
    (slideText ? '【配套课件（正在投屏给学生看）】\n' + slideText + '\n' : '') +
    (isIntl && boardRules.length ? '【考纲要求】\n' + boardRules.join('\n') + '\n' : '') +
    '【教学规则】\n' +
    '1. 一次只讲一小段（不超过 120 字），讲完必须抛出一个问题让学生回应，' +
    '并且在学生回答之前**不要自问自答**。保持真正的一对一问答节奏。\n' +
    '2. 每次开始讲解新知识点前，先让学生用自己的话说一遍"你目前怎么理解它"或"你会从哪一步入手"，' +
    '再决定从哪里讲起——不要跳过这一步直接开讲。\n' +
    '3. 学生答错时**绝不要直接给正确答案**：先指出他思路里值得肯定的部分，' +
    '再用 1-2 个针对性追问帮他自己找到出错的那一步（"你这一步用到了哪个条件？那个条件在这里满足吗？"）。\n' +
    '4. 给帮助时遵循"最小帮助原则"：一次只给**一个小提示**（一个方向、一个类比、一个更简单的例子），' +
    '给完就停下等他再试一次；只有学生连续两次尝试都失败、或他明确说"直接告诉我吧"，' +
    '才给出完整示范解答，并且示范完立刻让他用一道同类题自己复现一遍。\n' +
    '5. 每讲完一个知识点，用**一道小题**检验理解（口头出题即可，不必等课件练习页），' +
    '要求学生不仅说答案、还要说理由。\n' +
    '6. 多鼓励但不空洞：表扬要指向具体的方法和努力（"你这个分类讨论的思路很稳""你能自己发现这个矛盾点，很棒"），' +
    '不要只说"你真聪明"。学生犯错时把它归因为"这一步的策略还没找到"，而不是"你不会"。\n' +
    '7. 多用生活化的例子帮助建立直觉；可适量使用 1-2 个 emoji 增加亲和力，但不要每句都加。\n' +
    '8. 只讨论与本次课程学习相关的内容；无关或敏感话题礼貌拉回课程。\n' +
    '9. 当前环节讲完时，明确说"我们进入下一环节"，并按大纲顺序推进。\n' +
    '10. 学生可以随时打断你插话提问，这是正常的一对一课堂节奏：' +
    '收到学生插话后要立刻停下当前讲解、认真回应他的问题，不要抱怨被打断；' +
    '答完之后自然地说一句"那我们接着刚才的往下讲"，把话接回被打断的位置，不要从头重讲。\n' +
    '【苏格拉底式提问】\n     ' + SOCRATIC_RULE + '\n' +
    (state.meta ? '【元认知脚手架】\n     ' + META_RULE + '\n' : '') +
    '【本轮引导强度】\n     ' + guide.rule + '\n' +
    (slideText ? '【课件配合】课件正投屏给学生：讲到某一页时，请自然地说"大家看这一页""我们翻到下一页"等，' +
      '讲解内容与当前页要点保持一致；不要念完整页文字，而是展开讲、边讲边问。\n' : '') +
    (quizCount > 0 ? '【练习页处理】课件里安排了 ' + quizCount + ' 页随堂练习。讲到练习页时要切换到出题模式：' +
      '先把题目完整读一遍，让学生自己思考并作答，**绝对不要立刻公布答案**；' +
      '学生作答后先让他说理由再点评：答对就肯定并追问"为什么"，' +
      '答错就按解析里的思路一步步引导他自己找到正确选项（可以给选项级的小提示，但不说出字母）。\n' : '') +
    (isIntl ? '【国际课程作答】涉及考题时，按上述考纲的题型与评分标准示范作答（如 mark scheme 给分点）。' +
      '涉及标化考试（雅思/托福/SAT）时，给出可操作的分数提升策略与时间分配建议。\n' : '') +
    '【错因诊断（每道错题必做，且必须说出来）】学生答错时，除了引导他自己找出错在哪，' +
    '还要在心里判断这属于哪一类，并用一句自然的话点明（不要用分类术语）：\n' +
    '     · 概念/公式本身没学会 → 说"我们把这个定义重新捋一遍"，然后回到最基础的地方重建。\n' +
    '     · 把相近的概念或适用条件弄混了 → 说"你是不是把它和 XX 记混了"，然后**放在一起对比**讲清区别。\n' +
    '     · 思路对、只是算错/写错 → 说"你的方法完全没问题，这一步算错了"，**不要重讲知识点**，' +
    '带他把这一步重新算一遍并教他一个验算方法。\n' +
    '     · 看漏/看错题目条件 → 说"我们一起把题目再读一遍"，让他逐条把条件划出来。\n' +
    '     关键：**"不会"和"会但错"要用完全不同的方式处理**，把算错当成不会来重讲会让学生非常受挫。\n' +
    '【红线】' + langRule;
}

async function enterLive(course) {
  switchView('live');
  try {
    await startLive(course);
  } catch (e) {
    console.error('进入直播间失败', e);
    toast('开课失败：' + (e && e.message ? e.message : '未知错误') + '，请刷新页面重试', 'err');
  }
}

async function startLive(course) {
  if (!(await requireModel())) {
    switchView('courses');
    return;
  }
  // 若已有进行中的课堂且是同一节课，直接展示
  if (state.live && state.live.course.id === course.id && !state.live.ended) {
    $('#live-empty').hidden = true;
    $('#live-room').hidden = false;
    return;
  }
  endLiveSilent();

  state.live = {
    course,
    conversationId: 'live-' + course.id + '-' + Date.now(),
    messages: [],
    busy: false,
    seconds: 0,
    stageIndex: 0,
    slideIndex: 0,
    sharing: true,
    muted: false,
    camOn: true,
    handUp: false,
    ended: false,
    peers: [],          // 受邀加入的其他同学
    recording: [],      // 回放录制：时间轴事件
    recStart: 0,
    gallery: false,
    pendingInterrupt: null,   // 打断上下文（老师讲到哪儿）
    interruptedSeg: false,    // 当前正在生成的段是否已被打断
    currentSegStart: null,    // 本段讲解的起始时间点
    curHidden: false,         // 本段是否由隐藏指令触发
    pendingCauses: [],        // 当前页面累积的错因诊断（翻页时落盘）
    causeSummary: [],         // 本节课诊断出过的错因（课后传给小结模型）
    controller: null,
    timerInt: null,
  };
  const live = state.live;

  $('#live-empty').hidden = true;
  $('#live-room').hidden = false;
  $('#live-title').textContent = course.title;
  const mn = $('#meet-no');
  if (mn) mn.textContent = meetNo(course);
  $('#chat-messages').innerHTML = '';
  setCaptions('课程即将开始…');
  setTeacherStatus('正在准备课程…');

  // ★ 先渲染参会者列表（会重建 #people-list 的 DOM），再重置控件外观，
  //   否则对 #p-me-mic 等元素的操作会被随后的重建覆盖
  renderPeople();
  updatePeerCount();

  // 重置会议控件外观（全部加空值保护，避免任一元素缺失导致开课中断）
  const tbMic = $('#tb-mic');
  if (tbMic) {
    tbMic.classList.remove('off');
    const l = tbMic.querySelector('.mt-label');
    if (l) l.textContent = '静音';
  }
  const meMic = $('#p-me-mic');
  if (meMic) { meMic.classList.add('on'); meMic.classList.remove('off'); }
  const tbCam = $('#tb-cam');
  if (tbCam) {
    tbCam.classList.remove('off');
    const l = tbCam.querySelector('.mt-label');
    if (l) l.textContent = '停止视频';
  }
  const tbShare = $('#tb-share');
  if (tbShare) tbShare.classList.add('active');
  const tbHand = $('#tb-hand');
  if (tbHand) tbHand.classList.remove('active');
  const board = $('#meet-board');
  if (board) board.hidden = true;
  const avatar = $('#teacher-avatar');
  if (avatar) avatar.classList.remove('speaking');
  const tbRec = $('#tb-rec');
  if (tbRec) tbRec.classList.remove('active');
  const tbGal = $('#tb-gallery');
  if (tbGal) {
    tbGal.classList.remove('active');
    const l = tbGal.querySelector('.mt-label');
    if (l) l.textContent = '宫格';
  }
  toggleGallery(false);
  switchSidePane('chat');
  renderGuideBtn();

  renderStageList(course);
  renderLiveSlide();

  // 回放初始化
  live.recStart = Date.now();
  live.recording = [];
  recordEvent('slide', live.slideIndex);
  recordEvent('start', 0);

  // 数字人：优先用本节课已生成的视频，否则用站点自带形象
  try {
    if (course.avatarVideo) applyAvatarVideo(course);
    else initAvatarVideo();
  } catch (e) { console.warn('数字人初始化跳过', e); }

  // 没有课件的旧课程：后台补生成，完成后自动上屏
  if (!(course.slides && course.slides.length)) {
    ensureSlides(course).then((slides) => {
      if (slides && state.live && state.live.course.id === course.id) {
        state.live.slideIndex = 0;
        renderLiveSlide();
        toast('课件已生成，正在共享', 'ok');
      }
    });
  }

  state.live.timerInt = setInterval(() => {
    state.live.seconds += 1;
    $('#live-timer').textContent = fmtTime(state.live.seconds);
  }, 1000);

  // 开场（对模型隐藏的指令，不在界面渲染）
  // 有长期记忆时，让老师先自然衔接上次，而不是从零开始
  const hasMem = !!memoryPromptBlock();
  sendLive(
    hasMem
      ? '（课程正式开始。你以前教过这个学生，档案见上方【关于这个学生的长期记忆】。' +
        '请先用一两句话自然衔接上次的学习（不要机械念档案、不要罗列），简短欢迎，' +
        '说明这节课的目标，然后从学生上次的薄弱点或进度接着往下讲。）'
      : '（课程正式开始。请灵犀老师简短开场：欢迎学生、用一两句话介绍这节课的目标，然后直接开始第一环节的讲解。）',
    { hidden: true }
  );

  // 引导：语音朗读需用户手势解锁
  if (TTS.supported && !TTS.enabled) {
    setTimeout(() => {
      if (state.live && !state.live.ended) {
        toast('小提示：点底部「语音」按钮，灵犀老师就能开口讲课啦', 'ok');
      }
    }, 2200);
  }
}

/* 会议号：由课程 id 派生的 9 位数字，形如 532 617 842 */
function meetNo(course) {
  let h = 0;
  const s = String(course.id || course.title || 'lingxi');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  const n = String(100000000 + (h % 900000000));
  return n.slice(0, 3) + ' ' + n.slice(3, 6) + ' ' + n.slice(6, 9);
}

function setCaptions(text) {
  const el = $('#teacher-status');
  if (!el) return;
  const t = String(text == null ? '' : text).trim();
  el.textContent = t.length > 120 ? t.slice(0, 118) + '…' : t;
  const cap = $('#meet-caption');
  if (cap) cap.style.display = t ? '' : 'none';
}
function setTeacherStatus(text) { setCaptions(text); }

/* 切换右侧面板 */
function switchSidePane(name) {
  $$('.side-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
  $$('.side-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
}

/* ---------- 直播间课件放映（会议共享屏） ---------- */
function renderLiveSlide() {
  const live = state.live;
  const share = $('#tile-share');
  if (!share) return;
  const slides = (live && live.course.slides) || [];
  if (!slides.length) {
    share.hidden = true;
    return;
  }
  if (live.sharing === false) { share.hidden = true; return; }
  share.hidden = false;
  const i = Math.min(live.slideIndex, slides.length - 1);
  const stage = $('#live-slide-stage');
  if (stage) stage.innerHTML = slideHTML(slides[i], i, slides.length, slideTheme(live.course));
  const now = $('#live-slide-now');
  if (now) now.textContent = (i + 1) + ' / ' + slides.length;
}

function liveSlideGo(target) {
  const live = state.live;
  if (!live) return;
  const slides = live.course.slides || [];
  if (!slides.length) return;
  let next = typeof target === 'number' ? target : live.slideIndex + target;
  next = Math.max(0, Math.min(slides.length - 1, next));
  if (next === live.slideIndex) return;
  flushLiveCauses();            // 离开当前页：先行保存这一页累积的错因诊断
  live.slideIndex = next;
  renderLiveSlide();
  recordEvent('slide', next);
}

/* 把当前页面累积的错因诊断落成一条时间轴事件。
   挂在"翻页"上而不是"每段讲解"上：一页里老师可能来回讲好几轮，
   合并成一条更干净，也避免录制时间轴被刷屏。 */
function flushLiveCauses() {
  const live = state.live;
  if (!live || !live.recStart) return;
  const list = Array.isArray(live.pendingCauses) ? live.pendingCauses : [];
  if (!list.length) return;
  const slide = (live.course.slides || [])[live.slideIndex];
  recordEvent('cause', list.slice(0, ERROR_CAUSE_MAX), {
    slide: live.slideIndex,
    title: (slide && slide.title) || '',
  });
  live.pendingCauses = [];
}

/* 老师讲完一段后，若提到翻页/下一环节，自动跟进一页 */
function maybeAdvanceSlide(text) {
  const live = state.live;
  if (!live) return;
  const slides = live.course.slides || [];
  if (slides.length <= 1) return;
  const t = String(text || '');
  const wantsNext = /下一页|翻到下一|翻页|下一张|进入下一环节|看下一页|滑到下一/.test(t);
  const wantsPrev = /上一页|翻回去|回到上一页/.test(t);
  if (wantsNext) {
    setTimeout(() => liveSlideGo(1), 700);
  } else if (wantsPrev) {
    setTimeout(() => liveSlideGo(-1), 700);
  }
}

/* 错因诊断：老师每讲完一段，判断这段里有没有"诊断出学生为什么错"，
   顺手记到时间轴上，供课后生成错因报告。刻意做成"关键词启发式"：
   零额外网络开销、零额外 token，宁可漏记也不误记 —— 真正的结构化错因
   由课后小结模型统一判定（那道 prompt 能看到完整对话）。 */
const CAUSE_SIGNALS = [
  { cause: 'concept', re: /记混|弄混|混淆|区别在哪|把它和|区分|分不清|不是一回事/ },
  { cause: 'careless', re: /算错|算错了|计算错|抄错|笔误|粗心|马虎|符号写错|思路.{0,6}(对|没问题).{0,10}(错|错)/ },
  { cause: 'reading', re: /看漏|漏了条件|看错题|没看清|审题|读到哪|条件.{0,4}(划|圈)/ },
  { cause: 'knowledge', re: /没学过|没掌握|不懂|不会|重新捋|从最基础|这个定义|先把.{0,6}搞清楚/ },
];

function noteCauseSignals(text) {
  const live = state.live;
  if (!live || !live.recStart) return;
  const t = String(text || '');
  if (t.length < 8) return;
  CAUSE_SIGNALS.forEach((s) => {
    if (!s.re.test(t)) return;
    if (live.pendingCauses.indexOf(s.cause) >= 0) return;
    live.pendingCauses.push(s.cause);
  });
}

/* 为老课程补生成课件（同步生成，不阻塞直播） */
async function ensureSlides(course) {
  if (course.slides && course.slides.length) return course.slides;
  if (!state.model) return null;
  try {
    const sys = '你是课件设计师。根据给定课程大纲，输出配套 PPT 内容，只输出 JSON，禁止其他文字：' +
      '{"slides":[' +
      '{"type":"cover","title":"课程标题","subtitle":"副标题"},' +
      '{"type":"content","title":"页标题","subtitle":"可选副标题","bullets":["要点1","要点2"],"note":"老师讲解词"},' +
      '{"type":"quiz","title":"随堂练习","question":"完整题干","options":["A. 选项一","B. 选项二","C. 选项三","D. 选项四"],"answer":"B","analysis":"解析：为什么选它、其他选项错在哪","note":"老师讲这道题的话"},' +
      '{"type":"summary","title":"课堂小结","bullets":["小结1","小结2"]}' +
      ']}。' +
      '共 7-9 页：第 1 页 type=cover（title 用课程标题，无 bullets）；' +
      '中间每页对应一个知识模块 type=content，bullets 2-4 条、每条不超过 28 字；' +
      '**必须安排 2 页 type=quiz 的练习页**（分散在知识点之间，第一道偏基础、第二道稍难，每题给 4 个选项、明确答案与解析）；' +
      '最后 1 页 type=summary 课堂小结。';
    const o = course.outline;
    const body = o ? JSON.stringify({
      title: o.title, summary: o.summary, kps: o.knowledgePoints, stages: o.stages, hw: o.homework,
    }) : (course.rawOutline || course.title);
    const raw = await streamChat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '课程信息：' + course.subject + ' / ' + course.grade + ' / ' +
          (course.systemName || '国内课程') + '\n大纲：' + body },
      ],
      temperature: 0.6,
      responseFormat: true,
    });
    const parsed = parseJSONLoose(raw);
    course.slides = normalizeSlides(parsed, course);
    const idx = state.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) { state.courses[idx] = course; saveCourse(course, false); }
    return course.slides;
  } catch (e) {
    console.error('补生成课件失败', e);
    return null;
  }
}

/* ============================================================
   课堂打断机制：学生随时插话，老师停下回应，答完接着讲
   ============================================================ */
async function interruptTeacher(askText) {
  const live = state.live;
  if (!live || !live.busy) return false;

  // 1) 立刻掐断正在进行的流式生成
  if (live.controller) { try { live.controller.abort(); } catch (_) {} }
  // 2) 立刻停止朗读，避免和后面的回答叠音
  stopSpeech();

  // 3) 记下"被打断时讲到哪儿了"，供答完后接续
  const last = lastTeacherBubbleText();
  // 存到 pendingInterrupt（独立字段），不会被上一轮的 finally 清掉
  live.pendingInterrupt = {
    spoken: clipText(last, 180),
    at: (Date.now() - live.recStart) / 1000,
    ask: askText,
  };
  live.interruptedSeg = true;

  // 4) 等忙锁释放（abort 后 finally 会复位），最多 1.2 秒
  for (let i = 0; i < 24 && live.busy; i++) {
    await sleep(50);
  }
  // 5) 给被掐断的气泡盖上"已打断"标记
  markLastBubbleInterrupted();
  setCaptions('老师已停下，正在听你说…');
  toast('已打断老师，老师正在听你说', 'ok');
  return true;
}

/* 取最后一条老师气泡的纯文本 */
function lastTeacherBubbleText() {
  const wrap = $('#chat-messages');
  if (!wrap) return '';
  const ais = wrap.querySelectorAll('.msg.ai');
  if (!ais.length) return '';
  const el = ais[ais.length - 1].querySelector('.msg-bubble');
  return el ? el.textContent.replace(/（已打断）|（已停止生成）/g, '').trim() : '';
}

function markLastBubbleInterrupted() {
  const wrap = $('#chat-messages');
  if (!wrap) return;
  const ais = wrap.querySelectorAll('.msg.ai');
  if (!ais.length) return;
  const b = ais[ais.length - 1].querySelector('.msg-bubble');
  if (b && !b.querySelector('.sys-note')) {
    b.insertAdjacentHTML('beforeend', '<span class="sys-note">（学生插话，老师已停下）</span>');
  }
  ais[ais.length - 1].classList.add('interrupted');
}

function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 把打断上下文转成给模型的追问提示 */
function interruptHint(ctx, askText) {
  if (!ctx) return '';
  const isPause = /^（学生(要求暂停|按了暂停)/.test(ctx.ask || '');
  if (isPause) {
    return '（刚才你正在讲课，讲到"' + ctx.spoken + '"的时候学生按了暂停。' +
      '请先简短确认"好的，我停一下"，然后等他继续；如果他接着问了问题就直接回答。' +
      '回答或确认完，记得把话接回被打断的地方继续讲，不要从头重讲。）';
  }
  return '（刚才你正在讲课，讲到"' + ctx.spoken + '"的时候被学生打断了，学生的问题是："' +
    askText + '"。请先回答学生的问题，回答完再自然地把话接回被打断的地方继续讲，' +
    '不要重头开始。如果学生的问题与本课无关，简单回应后也回到刚才的讲解。）';
}

function renderStageList(course) {
  const list = $('#stage-list');
  const o = course && course.outline;
  if (!o || !Array.isArray(o.stages) || !o.stages.length) {
    list.innerHTML = '<li class="current"><span class="sg-no">★</span>按 AI 生成方案灵活授课</li>';
    $('#board-tip').textContent = '本课程为自由形式，AI 老师将按生成方案授课';
    list.onclick = null;
    return;
  }
  list.innerHTML = o.stages.map((s, i) => `
    <li data-i="${i}" class="${i === 0 ? 'current' : ''}">
      <span class="sg-no">${i + 1}</span>
      <span class="sg-name">${esc(s.name)}</span>
      <span class="sg-dur">${esc(s.duration || '')}</span>
    </li>`).join('');
  list.onclick = (ev) => {
    const li = ev.target.closest('li[data-i]');
    if (!li || !state.live || state.live.busy) return;
    const i = Number(li.dataset.i);
    if (i === state.live.stageIndex) return;
    state.live.stageIndex = i;
    $$('#stage-list li').forEach((x, j) => {
      x.classList.toggle('current', j === i);
      x.classList.toggle('done', j < i);
    });
    const stage = course.outline.stages[i];
    sendLive('老师，我们看第 ' + (i + 1) + ' 环节吧：' + stage.name + '。');
  };
}

function buildLiveMessages(ivCtx) {
  const sys = teacherSystemPrompt(state.live.course);
  // 1) 取出可见历史（隐藏消息只是内部的"指令"，学生看不到，不入模型上下文）
  let history = state.live.messages
    .filter((m) => !m.hidden)
    .slice(-14)
    .map((m) => ({ role: m.role, content: m.content }));

  // 2) 打断场景：把"你刚被打断，答完接着讲"的指令并入最后一条学生消息，
  //    避免出现连续两条 user 消息（部分模型对角色交替有严格要求）
  if (ivCtx && history.length) {
    const last = history[history.length - 1];
    const hint = interruptHint(ivCtx, last.content);
    if (last.role === 'user') last.content = last.content + '\n\n' + hint;
    else history.push({ role: 'user', content: hint });
  }

  // 3) ★ 强制修复角色交替：合并相邻同角色消息、并保证首条不是 assistant。
  //    任何历史写入异常（abort、隐藏消息被过滤等）都不该让整节课卡死，
  //    这里做一次兜底归一化，模型侧永远看到合法的 user/assistant 交替。
  const fixed = [];
  for (const m of history) {
    const prev = fixed[fixed.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = String(prev.content) + '\n' + String(m.content);
    } else if (!prev && m.role === 'assistant') {
      // 首条不能是 assistant，补一句学生消息把它接住
      fixed.push({ role: 'user', content: '（继续）' }, m);
    } else {
      fixed.push({ role: m.role, content: m.content });
    }
  }
  return [{ role: 'system', content: sys }, ...fixed];
}

function appendMessage(role, text, extraClass) {
  const wrap = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'me' : 'ai') + (extraClass ? ' ' + extraClass : '');
  if (role === 'user') {
    div.innerHTML = '<div class="msg-bubble">' + mdLite(text) + '</div>';
  } else {
    div.innerHTML = `
      <div class="msg-avatar">
        <svg viewBox="0 0 96 96" fill="none">
          <circle cx="48" cy="48" r="48" fill="#EEF0FF"/>
          <rect x="24" y="66" width="48" height="30" rx="15" fill="#6366F1"/>
          <circle cx="48" cy="44" r="22" fill="#FFDCC8"/>
          <path d="M26 45 a22 22 0 0 1 44 0 z" fill="#3F3D56"/>
          <circle cx="40" cy="46" r="6" fill="#fff" fill-opacity="0.9" stroke="#3F3D56" stroke-width="1.8"/>
          <circle cx="56" cy="46" r="6" fill="#fff" fill-opacity="0.9" stroke="#3F3D56" stroke-width="1.8"/>
          <line x1="46" y1="46" x2="50" y2="46" stroke="#3F3D56" stroke-width="1.8"/>
          <path d="M41 57 q7 6 14 0" stroke="#C97B5A" stroke-width="2.2" stroke-linecap="round" fill="none"/>
        </svg>
      </div>
      <div class="msg-bubble">${mdLite(text)}</div>`;
  }
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

function appendTyping() {
  const wrap = $('#chat-messages');
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="msg-avatar">
      <svg viewBox="0 0 96 96" fill="none">
        <circle cx="48" cy="48" r="48" fill="#EEF0FF"/>
        <rect x="24" y="66" width="48" height="30" rx="15" fill="#6366F1"/>
        <circle cx="48" cy="44" r="22" fill="#FFDCC8"/>
        <path d="M26 45 a22 22 0 0 1 44 0 z" fill="#3F3D56"/>
        <circle cx="40" cy="46" r="6" fill="#fff" fill-opacity="0.9" stroke="#3F3D56" stroke-width="1.8"/>
        <circle cx="56" cy="46" r="6" fill="#fff" fill-opacity="0.9" stroke="#3F3D56" stroke-width="1.8"/>
        <line x1="46" y1="46" x2="50" y2="46" stroke="#3F3D56" stroke-width="1.8"/>
        <path d="M41 57 q7 6 14 0" stroke="#C97B5A" stroke-width="2.2" stroke-linecap="round" fill="none"/>
      </svg>
    </div>
    <div class="msg-bubble"><span class="typing-dots"><i></i><i></i><i></i></span></div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

async function sendLive(text, opts = {}) {
  const live = state.live;
  if (!live || live.ended) return;
  if (!(await requireModel())) return;

  // ★ 打断机制：老师正在讲课时学生插话 → 立刻掐断当前生成，记下讲到哪儿
  let interrupted = false;
  if (live.busy) {
    interrupted = await interruptTeacher(text);
    if (!interrupted && live.busy) return;   // 掐断失败且仍在忙，放弃本次
  }
  // 取走打断上下文（存放在 pendingInterrupt，避免被上一轮 finally 清掉）
  const ivCtx = live.pendingInterrupt || null;
  live.pendingInterrupt = null;

  live.messages.push({ role: 'user', content: text, hidden: !!opts.hidden });
  if (!opts.hidden) {
    appendMessage('user', text);
    recordEvent('ask', text, { who: opts.asPeer || '你' });
    const input = $('#chat-input');
    input.value = '';
    input.style.height = 'auto';
  }

  setLiveBusy(true);
  const bubbleDiv = appendTyping();
  const bubbleEl = bubbleDiv.querySelector('.msg-bubble');
  const controller = new AbortController();
  live.controller = controller;
  const lastRecT = (Date.now() - live.recStart) / 1000;   // 本段讲解的起始时间点
  live.currentSegStart = lastRecT;
  live.curHidden = !!opts.hidden;   // 记录本段是否由隐藏指令触发

  let full = '';
  let spokenLen = 0;   // 已送入朗读队列的字符数（保证不重不漏）
  try {
    full = await streamChat({
      messages: buildLiveMessages(ivCtx),
      temperature: 0.8,
      conversationId: live.conversationId,
      signal: controller.signal,
      onDelta: (_d, acc) => {
        bubbleEl.innerHTML = mdLite(acc);
        const wrap = $('#chat-messages');
        wrap.scrollTop = wrap.scrollHeight;
        // 实时字幕：滚动显示老师正在讲的最后一段
        const segs = String(acc).split(/[\n。！？!?]/).filter((s) => s.trim());
        const tail = segs.length ? segs[segs.length - 1] : acc;
        if (tail && tail.trim()) setCaptions(tail.trim());
        // 语音朗读：把"已说完的整句"增量送给 TTS
        if (TTS.enabled) {
          const done = completeSentences(String(acc));
          if (done.length > spokenLen) {
            speak(done.slice(spokenLen));
            spokenLen = done.length;
          }
        }
      },
      // 纯推理模型先"想"后"写"：静默期给出明确反馈，避免被误判成 AI 不可用
      onReasoning: (_d, _thinking, acc) => {
        if (acc) return;
        bubbleEl.innerHTML = '<span class="teach-thinking">灵犀老师正在思考…</span>';
        const wrap = $('#chat-messages');
        wrap.scrollTop = wrap.scrollHeight;
        setCaptions('灵犀老师正在思考…');
      },
      onNotice: (msg) => { bubbleEl.innerHTML = '<span class="teach-thinking">' + esc(msg) + '</span>'; },
    });
    // 若这段被学生打断（abort），走 catch 分支单独处理；此处只处理正常讲完
    live.messages.push({ role: 'assistant', content: full });
    bubbleEl.innerHTML = mdLite(full);
    noteCauseSignals(full);
    maybeAdvanceSlide(full);
    // 收尾：朗读剩余的半句
    if (TTS.enabled) {
      const done = completeSentences(String(full));
      if (done.length > spokenLen) speak(done.slice(spokenLen));
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 关键：无论已生成多少内容，都要写入一条 assistant 消息，
      // 否则连续插话时会留下两条相邻的 user 消息，破坏角色交替
      const partial = full || '';
      // 被隐藏指令触发的段落不产生学生可见的气泡，但必须补一条 assistant 占位，
      // 保证 live.messages 里 user/assistant 成对（否则下一轮 buildLiveMessages 会错位）
      if (live.curHidden && !partial) {
        live.messages.push({ role: 'assistant', content: '（未及回答，学生已插话）' });
        bubbleDiv.remove();   // 隐藏指令不留残留气泡
      } else if (partial) {
        live.messages.push({ role: 'assistant', content: partial + '\n（讲解被学生打断）' });
        bubbleEl.innerHTML = mdLite(partial) + '<span class="sys-note">（学生插话，老师已停下）</span>';
        bubbleDiv.classList.add('interrupted');
      } else {
        live.messages.push({ role: 'assistant', content: '（老师刚开口就被打断了）' });
        bubbleEl.innerHTML = '<span class="sys-note">已停下，老师正在听你说…</span>';
        bubbleDiv.classList.add('interrupted');
      }
      live.interruptedSeg = false;
    } else {
      // 出错也要占位，否则同样会造成角色错位
      live.messages.push({ role: 'assistant', content: '（讲解中断：' + mapLLMError(e) + '）' });
      bubbleEl.innerHTML = '<span class="sys-note">' + esc(mapLLMError(e)) + errorRequestId(e) + '</span>';
      toast(mapLLMError(e), 'err');
    }
    stopSpeech();
  } finally {
    setLiveBusy(false);
    live.controller = null;
    live.currentSegStart = null;
    live.curHidden = false;
    // 讲完后字幕停留在最后一句，3 秒后回到待机提示
    if (full) {
      const segs = String(full).split(/[\n。！？!?]/).filter((s) => s.trim());
      if (segs.length) setCaptions(segs[segs.length - 1].trim());
      // 录制：按句记时间轴，回放可逐句还原讲解
      const spoken = completeSentences(full);
      const now = (Date.now() - live.recStart) / 1000;
      const span = Math.min(now - lastRecT, 24);   // 本段讲解占用的时间
      const each = spoken.length ? span / spoken.length : 0;
      spoken.forEach((s, i) => {
        live.recording.push({ t: Math.round((lastRecT + each * i) * 10) / 10, type: 'speak', v: s });
      });
      live.recording.sort((a, b) => a.t - b.t);
    }
    setTimeout(() => {
      if (state.live && !state.live.busy && !state.live.ended) setCaptions('等待你的提问');
    }, 3000);
  }
}

function setLiveBusy(busy) {
  const live = state.live;
  if (!live) return;
  live.busy = busy;

  // ★ 关键：老师讲课时不禁用输入，学生可以随时插话
  const input = $('#chat-input');
  if (input) {
    input.disabled = false;
    input.placeholder = busy
      ? '老师正在讲…（随时插话提问，Enter 发送即打断）'
      : '发送消息…（Enter 发送）';
    input.classList.toggle('can-interrupt', !!busy);
  }
  const send = $('#btn-send');
  if (send) {
    send.disabled = false;
    send.textContent = busy ? '打断提问' : '发送';
    send.classList.toggle('btn-interrupt', !!busy);
  }
  // 快捷提问在讲课时也保持可用（它们同样能打断）
  $$('#quick-row .quick-chip').forEach((b) => (b.disabled = false));
  $('#btn-stop').hidden = !busy;

  // 会议式状态：说话光环 + 语音波形 + 连接标识
  const av = $('#teacher-avatar');
  if (av) av.classList.toggle('speaking', busy);
  const wave = $('#voice-wave');
  if (wave) wave.classList.toggle('on', busy);
  const conn = $('#teacher-conn');
  if (conn) conn.textContent = busy ? '正在发言 · 可随时打断' : '连接良好';
  if (!busy) setCaptions('等待你的提问');
  const tmic = $('#teacher-mic');
  if (tmic) tmic.textContent = live.muted ? '🔇' : '🎙';
  // 老师在讲课时，闪烁提示"可打断"
  const hint = $('#interrupt-hint');
  if (hint) hint.hidden = !busy;
}

function endLiveSilent() {
  const live = state.live;
  if (!live) return;
  live.ended = true;
  if (live.controller) { try { live.controller.abort(); } catch (_) {} }
  if (live.timerInt) clearInterval(live.timerInt);
  stopSpeech();
  live.pendingInterrupt = null;
  live.interruptedSeg = false;
  live.curHidden = false;
  live.controller = null;
  state.live = null;
  // 复位输入区与打断提示
  const hint = $('#interrupt-hint');
  if (hint) hint.hidden = true;
  const input = $('#chat-input');
  if (input) {
    input.classList.remove('can-interrupt');
    input.placeholder = '发送消息…（Enter 发送）';
  }
  const send = $('#btn-send');
  if (send) {
    send.disabled = false;
    send.textContent = '发送';
    send.classList.remove('btn-interrupt');
  }
}

async function endLive() {
  const live = state.live;
  if (!live) return;
  const course = live.course;
  const transcript = live.messages.filter((m) => !m.hidden).map((m) =>
    (m.role === 'user' ? '学生：' : '灵犀老师：') + m.content).join('\n');
  const seconds = live.seconds;
  // 收尾：把最后一页还没落盘的错因诊断补上；再算出会话期间诊断过的错因概览
  flushLiveCauses();
  const causeEvents = (live.recording || []).filter((e) => e && e.type === 'cause');
  const causeSeen = [];
  causeEvents.forEach((e) => {
    (Array.isArray(e.v) ? e.v : []).forEach((c) => {
      if (causeSeen.indexOf(c) < 0) causeSeen.push(c);
    });
  });
  live.causeSummary = causeSeen;
  const stageIndex = live.stageIndex;
  const recording = live.recording.slice();
  const courseRef = live.course;
  endLiveSilent();

  $('#live-room').hidden = true;
  $('#live-empty').hidden = false;
  $('#tile-share').hidden = true;

  // 保存课堂回放
  persistRecording(courseRef, recording, seconds);
  renderCourses();

  // 更新课程进度
  const idx = state.courses.findIndex((c) => c.id === course.id);
  const total = (course.outline && Array.isArray(course.outline.stages)) ? course.outline.stages.length : 1;
  course.progress = Math.min(1, (stageIndex + (seconds > 60 ? 1 : 0)) / total);
  if (idx >= 0) { state.courses[idx] = course; saveCourse(course, false); }

  // 生成课堂小结
  openSummaryLoading();
  try {
    // 教学法依据：主动回忆（active recall）+ 间隔重复（spaced repetition）显著优于重复阅读。
    // 因此小结除掌握度评估外，还输出 3 张"闪卡"式复习卡与复习时间表。
    const sys = '你是「灵犀课堂」的教学顾问，熟悉认知科学与学习科学（主动回忆、间隔重复、成长型思维）。' +
      '请根据课堂对话记录输出一个 JSON 对象，禁止输出其他文字：' +
      '{"mastered":["已掌握的知识点"],"weakPoints":["仍薄弱或需要注意的点"],' +
      '"homework":["针对性作业建议1","作业建议2"],' +
      '"cards":[{"q":"自测问题（一句话，能直接作答）","a":"标准答案（1-2 句）"}],' +
      '"reviewPlan":["今晚：……","明天：……","三天后：……","一周后：……"],' +
      '"memoryFacts":[{"kind":"weak|strength|preference|progress|misconception|context",' +
      '"content":"一条关于这个学生的、值得长期记住的事实","topic":"对应知识点","confidence":0.8}],' +
      '"studentStyle":{"teaching_style":"他偏好的讲解方式（如喜欢先看例题/需要图像帮助）",' +
      '"pace":"他的节奏（如反应快可加速/需要放慢）","note":"其它值得长期记住的观察"},' +
      '"errorCauses":[{"cause":"knowledge|concept|careless|reading","topic":"出错的知识点",' +
      '"detail":"他具体是怎么错的（一句话，写清错误表现）","fix":"下次针对这个原因该怎么补（一句话）"}],' +
      '"comment":"给学生和家长的两三句总评，语气温和鼓励，用成长型思维措辞（把不足说成' +
      '\"这一步的策略还有提升空间\"而不是\"你不行\"）"}。' +
      '要求：mastered/weakPoints/homework 各 1-3 条；cards 给 3 张，问题要覆盖本节课最核心的 3 个知识点、' +
      '必须能脱离上下文作答（不要出现"这道题""刚才那个"这类指代）；reviewPlan 4 条，按遗忘曲线安排；' +
      'memoryFacts 给 2-6 条，只写**对以后教学真正有用**的信息（薄弱知识点、反复出现的错误、有效的讲解方式、' +
      '学习偏好、当前进度），不要写"今天上了XX课"这类流水账，每条要具体可执行、脱离本节课也能看懂；' +
      'studentStyle 若无法判断则给空字符串；全部使用简体中文。\n' +
      '【errorCauses 是本节课最重要的产出，请认真判断】只针对本节课里**学生真正做错或卡住**的地方填写，' +
      '没有就返回空数组 []，绝对不要为了凑数编造。每一类错误最多一条，允许只写 1-2 条。四个维度互斥的定义：\n' +
      '  · knowledge（知识漏洞）——相关概念、公式、定理他**根本没学会**，答不出或纯属瞎猜。\n' +
      '  · concept（概念混淆）——他其实学过，但把相近的概念/公式/适用条件**弄混了**（如把充分条件和必要条件搞反、' +
      '把平方差和完全平方弄混）；表现为"我知道那个公式，但用错地方了"。\n' +
      '  · careless（计算失误）——**解题思路和方法是对的**，只是运算、移项、去括号、抄写、符号出现错误。\n' +
      '  · reading（审题偏差）——漏看或错看了题目条件、单位、问法（如求"最大值"他答了"最小值"、漏掉"至少"）。\n' +
      '判定时优先看学生**自己说的解题过程**：如果他复述思路正确却算错，就是 careless，不要误判成 knowledge —— ' +
      '把"会但算错"当成"不会"去重讲，是伤害学习信心最常见的一种误诊。';
    const raw = await streamChat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: '课程：' + course.title + '（' + course.subject + ' · ' + course.grade + '，时长 ' + fmtTime(seconds) + '）' +
          (memoryPromptBlock() ? '\n【已有的学生长期记忆（请勿重复记录，只补新的或更新的）】\n' + memoryPromptBlock() : '') +
          '\n课堂对话记录：\n' + (transcript || '（学生本节课未发言）') },
      ],
      temperature: 0.4,
      responseFormat: true,
    });
    const sum = parseJSONLoose(raw);
    renderSummary(sum, raw, null, course);
    // 课后沉淀长期记忆（异步，不阻塞小结展示）
    persistMemoryAfterClass(course, sum, transcript, seconds).catch((e) => console.warn('[memory] 课后写入失败:', e));
  } catch (e) {
    renderSummary(null, null, mapLLMError(e), course);
  }
}

/* 课后：把本节课沉淀成长期记忆（画像 + 事实 + 上课记录） */
async function persistMemoryAfterClass(course, sum, transcript, seconds) {
  if (!memReady() || !sum) return;
  const facts = Array.isArray(sum.memoryFacts) ? sum.memoryFacts : [];
  const style = sum.studentStyle || {};
  const causes = cleanErrorCauses(sum.errorCauses);

  // 1) 上课记录（含错因四维归类；列不存在时 saveSession 内部自动降级）
  await saveSession({
    courseTitle: course.title,
    subject: course.subject,
    grade: course.grade,
    durationSecs: seconds,
    mastered: sum.mastered,
    weakPoints: sum.weakPoints,
    homework: sum.homework,
    cards: sum.cards,
    reviewPlan: sum.reviewPlan,
    errorCauses: causes,
    comment: sum.comment,
    transcript: transcript ? transcript.slice(0, 20000) : null,
  });

  // 2) 记忆事实（带学科/知识点，方便以后按学科召回）
  const mapped = facts.map((f) => ({
    kind: f.kind, content: f.content, topic: f.topic,
    subject: course.subject, confidence: f.confidence, source: 'class',
  }));

  /* 2b) 错因 → 记忆事实：模型有时写不好 memoryFacts，但错因是结构化字段，
     这里确定性地产出，保证"老师明天还记得你为什么错"不会被模型漏掉。
     按维度而不是按题目措辞，天然可跨课程去重累积（hits 会一直累加）。 */
  const causeFacts = causes.map((e) => {
    const c = ERROR_CAUSES[e.cause];
    const where = e.topic ? '在「' + e.topic + '」上' : '在本节课的题目上';
    return {
      kind: 'misconception',
      topic: e.topic || '',
      subject: course.subject,
      confidence: 0.82,
      source: 'class',
      content: '错因类型：' + c.label + ' —— ' + where +
        (e.detail ? '，具体表现是' + e.detail : '') +
        '。下次要' + (e.fix || c.action),
    };
  });
  if (causes.length) {
    causeFacts.push({
      kind: 'misconception',
      topic: '',
      subject: course.subject,
      confidence: 0.75,
      source: 'class',
      content: '错因画像：本节课的错误集中在' +
        causes.map((e) => ERROR_CAUSES[e.cause].label).join('、') + '。',
    });
  }

  await saveFacts(mapped.concat(causeFacts));

  // 3) 画像：计数累加 + 风格/节奏（有值才覆盖，避免把已有信息冲掉）
  const patch = { _addSessions: 1, _addSeconds: Math.round(seconds) };
  if (style.teaching_style) patch.teaching_style = String(style.teaching_style).slice(0, 200);
  if (style.pace) patch.pace = String(style.pace).slice(0, 100);
  if (style.note) patch.notes = String(style.note).slice(0, 2000);
  if (course.grade) patch.grade = course.grade;
  if (course.systemName) patch.system = course.systemName;
  if (course.goal) patch.goal = course.goal;
  await saveProfile(patch);

  // 4) 刷新本地记忆缓存（下次开课即可用上）
  await loadMemory(true);
}

/* ---------- 小结弹窗 ---------- */
function openSummaryLoading() {
  $('#summary-modal').hidden = false;
  $('#summary-body').innerHTML = '<div style="text-align:center;padding:30px 0;color:var(--muted)">AI 正在整理课堂小结…</div>';
}
/* 渲染「错因分析」列表：一节课的错因清单（原因徽章 + 知识点 + 具体表现 + 建议） */
function renderCauses(list) {
  const items = cleanErrorCauses(list);
  if (!items.length) return '';
  return '<div class="cause-list">' + items.map((e) => {
    const c = ERROR_CAUSES[e.cause] || ERROR_CAUSES.other;
    return '<div class="cause-item ' + c.cls + '">' +
      '<div class="cause-head">' +
      '<span class="cause-badge ' + c.cls + '">' + c.icon + ' ' + esc(c.label) + '</span>' +
      (e.topic ? '<b>' + esc(e.topic) + '</b>' : '') +
      '</div>' +
      '<p class="cause-meaning">' + esc(c.meaning) + '</p>' +
      (e.detail ? '<p class="cause-detail">当时的表现：' + esc(e.detail) + '</p>' : '') +
      '<p class="cause-fix">👉 ' + esc(e.fix || c.action) + '</p>' +
      '</div>';
  }).join('') + '</div>';
}

/* 渲染「错因分布」：跨课程的错因聚合图谱（学习档案页） */
function renderErrorProfile(sessions) {
  const el = $('#mem-causes');
  if (!el) return;
  const ep = buildErrorProfile(sessions);
  if (!ep.total) {
    el.innerHTML = '<p class="mem-empty">还没有错因记录。做错题时，老师会判断是' +
      '<b>知识漏洞</b>、<b>概念混淆</b>、<b>计算失误</b>还是<b>审题偏差</b>，然后记在这里。</p>';
    return;
  }
  const totalOf = (k) => ep.list.reduce((a, g) => a + g.counts[k], 0);
  /* 用"出现该错因的知识点数 / 出现过错因的知识点数"而不是纯次数：
     同一个知识点反复算错 5 次，不代表它比 5 个都完全没掌握的知识点更严重。
     占比衡量的是"这种毛病波及多广"，次数只作为参考数字。 */
  const topicCount = ep.list.length;

  const bar = (k) => {
    const n = totalOf(k);
    if (!n) return '';
    const pct = Math.round((ep.list.filter((g) => g.counts[k] > 0).length / topicCount) * 100);
    const c = ERROR_CAUSES[k];
    return '<div class="ep-bar-row">' +
      '<span class="ep-bar-label">' + c.icon + ' ' + c.label + '</span>' +
      '<span class="ep-bar-track" role="img" aria-label="' + esc(c.label) + '：影响 ' +
        ep.list.filter((g) => g.counts[k] > 0).length + ' 个知识点，共 ' + n + ' 次">' +
        '<i class="ep-bar-fill ' + c.cls + '" style="width:' + pct + '%"></i></span>' +
      '<b class="ep-bar-num">' + n + '</b>' +
      '</div>';
  };

  const carelessish = ep.list.reduce((a, g) => a + g.counts.careless + g.counts.reading, 0);
  const knowledgeish = ep.total - carelessish;
  // 这个比例是"会但没做对" vs "真不会"，直接决定下一步该补什么
  const verdict = carelessish > knowledgeish
    ? '你的错<b>大多是"会但没做对"</b>——知识其实是掌握的，重点放在审题和验算习惯上。'
    : knowledgeish > carelessish
      ? '你的错<b>大多来自知识点本身</b>——先把概念和公式夯实，比多刷题更有效。'
      : '你的错误里"知识点没掌握"和"会但没做对"各占一半，两边都要兼顾。';

  el.innerHTML =
    '<div class="ep-verdict">' + verdict + '</div>' +
    '<div class="ep-topics">' + ep.list.slice(0, 6).map((g) => {
      const c = ERROR_CAUSES[g.top] || ERROR_CAUSES.other;
      return '<div class="ep-topic">' +
        '<span class="ep-topic-name">' + esc(g.topic) + '</span>' +
        (g.subject ? '<span class="ep-topic-subj">' + esc(g.subject) + '</span>' : '') +
        '<span class="cause-badge ' + c.cls + '">' + c.icon + ' ' + esc(c.label) + '</span>' +
        '<span class="ep-topic-n">' + g.total + ' 次</span>' +
        '</div>';
    }).join('') + '</div>' +
    '<div class="ep-bars">' +
      ERROR_CAUSE_KEYS.map(bar).join('') +
    '</div>' +
    '<p class="ep-bars-hint">每组占比 = 出现过这类错误的<b>知识点</b>占全部出错知识点的比例（括号里是累计次数）。</p>';
}

/* 渲染「起点画像」：把入学诊断沉淀的 facts（source='diagnostic'）还原成一张图。
   为什么要单独做：诊断是**一次性**的定位（开课前），和每节课动态生长的
   掌握度/错因不是一回事。混在一起看，学生会分不清"这是我起点的样子"
   还是"我现在的样子" —— 起点必须单独呈现，才能看出进步。 */
function renderMemoryDiag(facts) {
  const el = $('#mem-diag');
  if (!el) return;
  const list = (Array.isArray(facts) ? facts : []).filter((f) => f && f.source === 'diagnostic');
  if (!list.length) {
    // 纯静态文案（无任何插值），写成单行字面量让静态审查可直接判定
    el.innerHTML = '<p class="mem-empty">还没有做过课前诊断。生成课程前点「先做课前诊断」，老师就能知道该从哪里讲起，不会把你会的内容再讲一遍。</p>';
    return;
  }

  // 按 topic 归组，取"最需要关注"的那条（weak > strength）
  const byTopic = {};
  const order = [];
  list.forEach((f) => {
    const key = String(f.topic || '').trim() || '综合评估';
    if (!byTopic[key]) {
      byTopic[key] = { topic: key, subject: f.subject || '', kinds: [], when: f.last_seen || '' };
      order.push(key);
    }
    if (byTopic[key].kinds.indexOf(f.kind) < 0) byTopic[key].kinds.push(f.kind);
    if (f.last_seen && (!byTopic[key].when || f.last_seen > byTopic[key].when)) byTopic[key].when = f.last_seen;
  });

  const levelOf = (kinds) => {
    if (kinds.indexOf('weak') >= 0) return 'need';
    if (kinds.indexOf('strength') >= 0) return 'ok';
    return 'info';
  };
  const rows = order.map((k) => {
    const g = byTopic[k];
    const lv = levelOf(g.kinds);
    const L = lv === 'need' ? { label: '起点薄弱', cls: 'd-gap', icon: '🔴' }
      : lv === 'ok' ? { label: '起点已会', cls: 'd-ok', icon: '✅' }
        : { label: '评估记录', cls: 'd-fuzzy', icon: '🔶' };
    return { topic: g.topic, subject: g.subject, when: g.when, lv, L };
  }).sort((a, b) => (a.lv === b.lv ? 0 : a.lv === 'need' ? -1 : 1));

  const need = rows.filter((r) => r.lv === 'need');
  const ok = rows.filter((r) => r.lv === 'ok');
  const overall = list.filter((f) => f.kind === 'context')[0];

  const head = '<div class="md-sum">' +
    '<div class="md-stat need"><b>' + need.length + '</b><span>起点薄弱</span></div>' +
    '<div class="md-stat ok"><b>' + ok.length + '</b><span>起点已会</span></div>' +
    '</div>' +
    (overall ? '<p class="md-overall">' + esc(overall.content) + '</p>' : '');

  const body = '<div class="md-topics">' + rows.slice(0, 12).map((r) =>
    '<div class="md-topic ' + r.L.cls + '">' +
    '<span class="md-ico">' + r.L.icon + '</span>' +
    '<b>' + esc(r.topic) + '</b>' +
    (r.subject ? '<span class="md-subj">' + esc(r.subject) + '</span>' : '') +
    '<span class="md-lv">' + r.L.label + '</span>' +
    '</div>').join('') + '</div>';

  el.innerHTML = head + body +
    '<p class="md-hint">这是你<b>开课前</b>的起点快照。真正的进步看上面的「知识点掌握度」——' +
    '当某个"起点薄弱"的标签在掌握度里变成"已掌握"，那才是真的学会了。</p>';
}

function renderSummary(sum, raw, errMsg, course) {
  const body = $('#summary-body');
  if (!sum) {
    body.innerHTML = '<div class="sum-comment">' +
      esc(errMsg || '小结生成失败') + (raw ? '<br><br>' + esc(raw) : '') + '</div>';
    return;
  }
  const list = (arr) => Array.isArray(arr) && arr.length
    ? '<ul>' + arr.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    : '<ul><li>暂无</li></ul>';

  // 闪卡：正面问题，点开才看答案 —— 强制"先回忆再核对"，这是主动回忆的关键
  const cards = (Array.isArray(sum.cards) ? sum.cards : []).filter((c) => c && (c.q || c.a));
  const cardsHtml = cards.length
    ? `<div class="sum-block sum-cards"><b>🃏 课后自测闪卡</b>
        <p class="sum-hint">先在心里作答，再点开对答案 —— 直接看答案效果会差很多。</p>
        <div class="flash-list">${cards.map((c, i) => `
          <details class="flash-card">
            <summary><span class="fc-no">${i + 1}</span><span class="fc-q">${esc(c.q || '（略）')}</span>
              <span class="fc-toggle">看答案</span></summary>
            <div class="fc-a"><b>答案：</b>${esc(c.a || '（略）')}</div>
          </details>`).join('')}</div>
      </div>`
    : '';

  const plan = Array.isArray(sum.reviewPlan) ? sum.reviewPlan.filter(Boolean) : [];
  const planHtml = plan.length
    ? `<div class="sum-block"><b>🔁 间隔复习计划</b>
        <ol class="review-plan">${plan.map((p) => '<li>' + esc(p) + '</li>').join('')}</ol></div>`
    : '';

  const hasReplay = course && course.replay && course.replay.events && course.replay.events.length;
  const causeHtml = renderCauses(sum.errorCauses);
  body.innerHTML = `
    <div class="sum-block"><b>✅ 已掌握</b>${list(sum.mastered)}</div>
    <div class="sum-block"><b>📌 待巩固</b>${list(sum.weakPoints)}</div>
    ${causeHtml ? '<div class="sum-block sum-causes"><b>🔍 错因分析</b>' +
      '<p class="sum-hint">知道"为什么错"比知道"错了"重要 —— 不同原因要用完全不同的方式补。</p>' +
      causeHtml + '</div>' : ''}
    <div class="sum-block"><b>✏️ 作业建议</b>${list(sum.homework)}</div>
    ${cardsHtml}
    ${planHtml}
    ${sum.comment ? '<div class="sum-comment">' + esc(sum.comment) + '</div>' : ''}
    ${hasReplay ? '<div class="sum-replay"><b>⏺ 课堂回放已生成</b>（' + fmtTime(course.replay.duration) + '，' +
      course.replay.events.length + ' 个时间点）<br>到「我的课程」点击 <b>回放</b> 即可重温本节课。</div>' : ''}`;
}

/* ---------- 事件绑定 ---------- */
/* ============================================================
   弹窗可访问性：集中给全部 .modal-mask 补 ARIA、Esc 关闭、
   焦点归还与滚动锁。改这里即可覆盖 9 个弹窗，无需逐个改结构。
   ============================================================ */
function allMasks() {
  return Array.prototype.slice.call(document.querySelectorAll('.modal-mask'));
}
function openMasks() {
  return allMasks().filter((m) => !m.hidden);
}
function syncBodyScrollLock() {
  document.body.style.overflow = openMasks().length ? 'hidden' : '';
}
function enhanceModalA11y() {
  allMasks().forEach((mask) => {
    try {
      if (!mask.getAttribute('role')) mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-modal', 'true');
      if (!mask.getAttribute('aria-label')) {
        const head = mask.querySelector('.modal-head');
        const t = head ? String(head.textContent || '').replace(/[✕×]/g, '').trim() : '';
        if (t) mask.setAttribute('aria-label', t);
      }
      Array.prototype.forEach.call(mask.querySelectorAll('.modal-close'), (b) => {
        // 关闭按钮原本只有 ✕ 符号，读屏无法朗读
        if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', '关闭');
        if (!b.getAttribute('type')) b.setAttribute('type', 'button');
      });
    } catch (_) {}
  });
}
function watchModalFocus() {
  let lastOpen = [];
  let restoreTo = null;
  const sync = () => {
    try {
      const open = openMasks();
      if (open.length > lastOpen.length) {
        // 新打开：记住来源，把焦点移进弹窗
        restoreTo = document.activeElement;
        const top = open[open.length - 1];
        const first = top.querySelector('input:not([type="hidden"]), textarea, select, a[href]')
          || top.querySelector('.modal-close');
        if (first) setTimeout(() => { try { first.focus(); } catch (_) {} }, 40);
      } else if (!open.length && lastOpen.length) {
        // 全部关闭：把焦点还给打开它的元素
        const back = restoreTo;
        restoreTo = null;
        if (back && typeof back.focus === 'function') {
          setTimeout(() => { try { back.focus(); } catch (_) {} }, 0);
        }
      }
      lastOpen = open;
      syncBodyScrollLock();
    } catch (_) {}
  };
  try {
    if (typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(sync);
    allMasks().forEach((m) => mo.observe(m, { attributes: true, attributeFilter: ['hidden'] }));
    sync();
  } catch (_) {}
}
function bindModalA11yKeys() {
  // 捕获阶段先于直播间那个 Esc 打断监听，避免两者互相抢
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const open = openMasks();
    if (!open.length) return;
    if (state.live && state.live.busy) return;   // 讲解中：Esc 留给「打断老师」
    const btn = open[open.length - 1].querySelector('.modal-close');
    if (btn) { btn.click(); ev.preventDefault(); }
  }, true);
}

/* 移动端导航抽屉：宽屏隐藏了 .nav-links，手机上必须另有入口，
   否则「我的课程 / 学习档案」在手机上完全进不去。 */
function bindMobileNav() {
  const btn = $('#btn-burger');
  const menu = $('#mobile-nav');
  if (!btn || !menu) return;
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  };
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setOpen(menu.hidden);
  });
  // 点菜单项后自动收起；真正的跳转由 body 上的 [data-nav] 委托处理
  menu.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-nav]')) setOpen(false);
  });
  document.addEventListener('click', (ev) => {
    if (menu.hidden) return;
    if (ev.target.closest('#mobile-nav') || ev.target.closest('#btn-burger')) return;
    setOpen(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !menu.hidden) setOpen(false);
  });
  window.addEventListener('resize', () => { if (window.innerWidth > 1000) setOpen(false); });
  window.__closeMobileNav = () => setOpen(false);
}

function bindNav() {
  document.body.addEventListener('click', (ev) => {
    // ① 所有 href="#" / javascript: 的伪链接，统一拦截默认跳转。
    //    既避免页面跳到顶部，也避免 CSP（script-src 无 unsafe-inline）把它们
    //    当成内联脚本拦掉而刷控制台报错。
    const dead = ev.target.closest('a[href="#"], a[href^="javascript:"]');
    if (dead) ev.preventDefault();
    // ② 真正的导航：点击 [data-nav] 切换视图
    const nav = ev.target.closest('[data-nav]');
    if (nav) { switchView(nav.dataset.nav); return; }
  });
}

function bindLiveEvents() {
  const input = $('#chat-input');
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const t = input.value.trim();
      if (t) sendLive(t);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });
  $('#btn-send').addEventListener('click', () => {
    const t = input.value.trim();
    if (t) sendLive(t);
  });
  $('#btn-stop').addEventListener('click', () => {
    if (state.live && state.live.controller) {
      state.live.pendingInterrupt = {
        spoken: clipText(lastTeacherBubbleText(), 180),
        ask: '（学生要求暂停一下）',
      };
      state.live.controller.abort();
    }
  });

  // Esc 键：快速打断 / 停止老师讲解
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if ($('#live-room').hidden) return;
    if (state.live && state.live.busy && state.live.controller) {
      state.live.pendingInterrupt = {
        spoken: clipText(lastTeacherBubbleText(), 180),
        ask: '（学生按了暂停）',
      };
      state.live.controller.abort();
      ev.preventDefault();
    }
  });
  $('#quick-row').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.quick-chip');
    if (chip && !chip.disabled) sendLive(chip.dataset.q);
  });
  $('#btn-end').addEventListener('click', endLive);

  // 键盘翻页：预览弹窗打开时优先控制弹窗，否则控制直播间课件
  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const d = ev.key === 'ArrowRight' ? 1 : -1;
    if (!$('#slide-modal').hidden) {
      slideGo(d);
      ev.preventDefault();
    } else if (!$('#live-room').hidden && !$('#tile-share').hidden) {
      liveSlideGo(d);
      ev.preventDefault();
    }
  });
}

function bindModalEvents() {
  const close = () => { $('#summary-modal').hidden = true; };
  $('#btn-summary-close').addEventListener('click', close);
  $('#btn-summary-close2').addEventListener('click', close);
  $('#btn-summary-back').addEventListener('click', () => { close(); switchView('home'); });
  $('#summary-modal').addEventListener('click', (ev) => {
    if (ev.target === $('#summary-modal')) close();
  });

  // 课件预览弹窗
  $('#btn-slide-close').addEventListener('click', closeSlidePreview);
  $('#slide-modal').addEventListener('click', (ev) => {
    if (ev.target === $('#slide-modal')) closeSlidePreview();
  });
  $('#btn-slide-prev').addEventListener('click', () => slideGo(-1));
  $('#btn-slide-next').addEventListener('click', () => slideGo(1));
  $('#slide-nav').addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-goto]');
    if (!item) return;
    slideState.index = Number(item.dataset.goto);
    renderSlideViewer();
  });
  $('#btn-slide-export').addEventListener('click', () => {
    if (slideState.course) exportPPTX(slideState.course);
  });

  // 直播间课件翻页（会议共享屏）
  $('#btn-live-slide-prev').addEventListener('click', () => liveSlideGo(-1));
  $('#btn-live-slide-next').addEventListener('click', () => liveSlideGo(1));

  // 右侧面板切换
  $$('.side-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchSidePane(tab.dataset.panel));
  });

  // 会议控制栏：麦克风
  $('#tb-mic').addEventListener('click', () => {
    const live = state.live;
    if (!live) return;
    live.muted = !live.muted;
    const btn = $('#tb-mic');
    btn.classList.toggle('off', live.muted);
    btn.querySelector('.mt-ico').textContent = live.muted ? '🔇' : '🎙';
    btn.querySelector('.mt-label').textContent = live.muted ? '解除静音' : '静音';
    // 参会者列表由 renderPeople() 动态生成，元素可能尚未存在，必须做空值保护
    const pMic = $('#p-me-mic');
    if (pMic) {
      pMic.classList.toggle('on', !live.muted);
      pMic.classList.toggle('off', live.muted);
    }
    toast(live.muted ? '麦克风已静音' : '麦克风已开启');
  });

  // 摄像头
  $('#tb-cam').addEventListener('click', () => {
    const live = state.live;
    if (!live) return;
    live.camOn = !live.camOn;
    const btn = $('#tb-cam');
    btn.classList.toggle('off', !live.camOn);
    btn.querySelector('.mt-ico').textContent = live.camOn ? '📹' : '🚫';
    btn.querySelector('.mt-label').textContent = live.camOn ? '停止视频' : '开启视频';
    $('#teacher-video').classList.toggle('cam-off', !live.camOn);
  });

  // 共享屏幕（课件）
  $('#tb-share').addEventListener('click', () => {
    const live = state.live;
    if (!live) return;
    live.sharing = !live.sharing;
    $('#tb-share').classList.toggle('active', live.sharing);
    renderLiveSlide();
    toast(live.sharing ? '正在共享课件' : '已停止共享');
  });

  // 举手
  $('#tb-hand').addEventListener('click', () => {
    const live = state.live;
    if (!live) return;
    if (live.handUp) {
      live.handUp = false;
      $('#tb-hand').classList.remove('active');
      return;
    }
    live.handUp = true;
    $('#tb-hand').classList.add('active');
    toast('已举手，老师会回应你', 'ok');
    // 学生举手时让提示条出现一下
    const hint = $('#people-hint');
    if (hint) {
      hint.textContent = '✋ 你举手了，正在等待老师回应…';
      setTimeout(() => { hint.textContent = '课堂小结会在下课后自动生成'; }, 4000);
    }
    sendLive('（学生举手了，请先回应他的问题。）', { hidden: true });
  });

  // 聊天 / 参会者 / 大纲
  $('#tb-chat').addEventListener('click', () => switchSidePane('chat'));
  $('#tb-people').addEventListener('click', () => switchSidePane('people'));
  $('#tb-board').addEventListener('click', () => {
    const board = $('#meet-board');
    board.hidden = !board.hidden;
    $('#tb-board').classList.toggle('active', !board.hidden);
  });
  $('#mb-close').addEventListener('click', () => {
    $('#meet-board').hidden = true;
    $('#tb-board').classList.remove('active');
  });

  // 底部结束按钮
  $('#tb-leave').addEventListener('click', endLive);

  // 语音朗读
  const tbVoice = $('#tb-voice');
  if (tbVoice) tbVoice.addEventListener('click', () => toggleTTS());

  // 引导强度（苏格拉底支持等级）
  const tbGuide = $('#tb-guide');
  if (tbGuide) tbGuide.addEventListener('click', openGuideModal);
  const gm = $('#guide-modal');
  if (gm) {
    gm.addEventListener('click', (ev) => { if (ev.target === gm) closeGuideModal(); });
    const opts = $('#guide-options');
    if (opts) opts.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-guide]');
      if (!b) return;
      setGuide(b.dataset.guide);
      openGuideModal();   // 重绘选中态
    });
    const metaSw = $('#guide-meta');
    if (metaSw) metaSw.addEventListener('click', () => toggleMeta());
  }
  const gc = $('#btn-guide-close');
  if (gc) gc.addEventListener('click', closeGuideModal);
  const gok = $('#btn-guide-ok');
  if (gok) gok.addEventListener('click', closeGuideModal);

  // 宫格视图
  const tbGal = $('#tb-gallery');
  if (tbGal) tbGal.addEventListener('click', () => toggleGallery());
  const galBack = $('#gal-back');
  if (galBack) galBack.addEventListener('click', () => toggleGallery(false));

  // 邀请同学 / 移出同学 / 同学提问
  const inviteBtn = $('#btn-invite');
  if (inviteBtn) inviteBtn.addEventListener('click', invitePeer);
  const plist = $('#people-list');
  if (plist) plist.addEventListener('click', (ev) => {
    const kick = ev.target.closest('[data-kick]');
    if (kick) { removePeer(kick.dataset.kick); return; }
    const person = ev.target.closest('.person');
    if (!person) return;
    // 点击同学 → 让 TA 提问（角色扮演）
    const idx = Array.from(plist.querySelectorAll('.person')).indexOf(person);
    const peers = allPeers();
    const p = peers[idx];
    if (p && !p.isTeacher && !p.isMe) {
      const qs = ['老师，这一步我没跟上，能再讲一遍吗？',
                  '这个知识点考试会怎么考呀？',
                  '能帮我举个例子说明一下吗？',
                  '为什么这里要这样算呢？'];
      peerAsk(p.id, qs[Math.floor(Math.random() * qs.length)]);
    }
  });

  // 课堂回放
  const tbRec = $('#tb-rec');
  if (tbRec) tbRec.addEventListener('click', () => {
    if (!state.live) return;
    openReplay(state.live.course);
  });
  const rpClose = $('#btn-replay-close');
  if (rpClose) rpClose.addEventListener('click', closeReplay);
  $('#replay-modal').addEventListener('click', (ev) => {
    if (ev.target === $('#replay-modal')) closeReplay();
  });
  $('#rp-play').addEventListener('click', () => replay.playing ? pauseReplay() : playReplay());
  $('#rp-restart').addEventListener('click', () => { seekReplay(0); });
  $('#rp-seek').addEventListener('input', (ev) => seekReplay(ev.target.value));
  $('#rp-speed').addEventListener('change', (ev) => { replay.speed = Number(ev.target.value) || 1; });
  $('#replay-timeline').addEventListener('click', (ev) => {
    const it = ev.target.closest('[data-seek]');
    if (it) seekReplay(it.dataset.seek);
  });
  $('#btn-replay-clear').addEventListener('click', () => {
    const c = replay.course || (state.live && state.live.course);
    if (!c) return;
    delete c.replay;
    const i = state.courses.findIndex((x) => x.id === c.id);
    if (i >= 0) { state.courses[i] = c; }
    try { localStorage.setItem('lingxi_courses_v1', JSON.stringify(state.courses)); } catch (_) {}
    closeReplay();
    renderCourses();
    toast('已删除本节回放');
  });

  // 数字人视频
  const tbAv = $('#tb-avatar');
  if (tbAv) tbAv.addEventListener('click', openAvatarModal);
  $('#btn-avatar-close').addEventListener('click', () => { $('#avatar-modal').hidden = true; });
  $('#btn-avatar-cancel').addEventListener('click', () => { $('#avatar-modal').hidden = true; });
  $('#avatar-modal').addEventListener('click', (ev) => {
    if (ev.target === $('#avatar-modal')) $('#avatar-modal').hidden = true;
  });
  $('#btn-avatar-gen').addEventListener('click', generateAvatarVideo);
}

function bindCourseListEvents() {
  const filterRow = $('#course-filter');
  if (filterRow) {
    filterRow.addEventListener('click', (ev) => {
      const chip = ev.target.closest('[data-filter]');
      if (!chip) return;
      state.courseFilter = chip.dataset.filter;
      renderCourses();
    });
  }
  $('#course-list').addEventListener('click', (ev) => {
    const enter = ev.target.closest('[data-enter]');
    const regen = ev.target.closest('[data-regen]');
    const del = ev.target.closest('[data-del]');
    const slidesBtn = ev.target.closest('[data-slides]');
    const pptBtn = ev.target.closest('[data-ppt]');
    const mkBtn = ev.target.closest('[data-mkslides]');
    const replayBtn = ev.target.closest('[data-replay]');
    if (enter) {
      const c = state.courses.find((x) => x.id === enter.dataset.enter);
      if (c) enterLive(c);
    } else if (replayBtn) {
      const c = state.courses.find((x) => x.id === replayBtn.dataset.replay);
      if (c) openReplay(c);
    } else if (slidesBtn) {
      const c = state.courses.find((x) => x.id === slidesBtn.dataset.slides);
      if (c) openSlidePreview(c);
    } else if (pptBtn) {
      const c = state.courses.find((x) => x.id === pptBtn.dataset.ppt);
      if (c) exportPPTX(c);
    } else if (mkBtn) {
      const c = state.courses.find((x) => x.id === mkBtn.dataset.mkslides);
      if (!c) return;
      // requireModel 现在要等首次加载落地，用 IIFE 保持点击回调本身的非阻塞性
      (async () => {
        if (!(await requireModel())) return;
        mkBtn.disabled = true;
        mkBtn.textContent = '生成中…';
        const slides = await ensureSlides(c).catch(() => null);
        if (slides) {
          renderCourses();
          toast('课件已生成', 'ok');
          openSlidePreview(c);
        } else {
          mkBtn.disabled = false;
          mkBtn.textContent = '✨ 生成课件';
          toast('课件生成失败，请重试', 'err');
        }
      })();
    } else if (regen) {
      const c = state.courses.find((x) => x.id === regen.dataset.regen);
      if (c) { window.__lastGenerated = c; renderGenCourse(c); switchView('generate'); }
    } else if (del) {
      const id = del.dataset.del;
      const c = state.courses.find((x) => x.id === id);
      if (c && window.confirm('确定删除课程《' + c.title + '》吗？')) {
        state.courses = state.courses.filter((x) => x.id !== id);
        try { localStorage.setItem('lingxi_courses_v1', JSON.stringify(state.courses)); } catch (_) {}
        renderCourses();
        toast('已删除');
      }
    }
  });
}

/* ---------- 启动 ---------- */
/* 每个初始化步骤独立兜底：任一步失败都不影响其它步骤与后续事件绑定 */
function safeInit(label, fn) {
  try { fn(); } catch (e) {
    console.error('[init] ' + label + ' 失败:', e);
  }
}

function init() {
  if (!window.WorkBuddyCloud) {
    $('#ai-status').innerHTML = '<i class="dot dot-bad"></i>云服务未连接';
    toast('云服务 SDK 加载失败，请检查网络后刷新页面', 'err');
  } else {
    try {
      state.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        publishableKey: PUBLIC_CONFIG.publishableKey,
      });
      // ★ 先校验本地会话再拉模型：残留的失效会话会被清掉，
      //   否则它会一直 401，让页面永久停在「AI 暂不可用」。
      ensureSessionHealthy().catch(() => {}).then(() => loadModels());
    } catch (e) {
      console.error('[init] 云服务初始化失败:', e);
      $('#ai-status').innerHTML = '<i class="dot dot-bad"></i>云服务初始化失败';
    }
  }

  // ★ 事件绑定优先：只要绑定成功，页面就不会"点不动"
  safeInit('renderHome', renderHome);
  safeInit('renderGenChips', renderGenChips);
  safeInit('renderGradeOptions', renderGradeOptions);
  safeInit('loadCourses', loadCourses);
  safeInit('bindNav', bindNav);
  safeInit('bindAIStatusRetry', bindAIStatusRetry);
  safeInit('bindModelSelect', bindModelSelect);
  safeInit('bindMobileNav', bindMobileNav);
  safeInit('bindHomeEvents', bindHomeEvents);
  safeInit('bindLiveEvents', bindLiveEvents);
  safeInit('bindModalEvents', bindModalEvents);
  safeInit('bindModalA11yKeys', bindModalA11yKeys);
  safeInit('enhanceModalA11y', enhanceModalA11y);
  safeInit('watchModalFocus', watchModalFocus);
  safeInit('bindCourseListEvents', bindCourseListEvents);
  safeInit('bindAuthEvents', bindAuthEvents);
  safeInit('bindMemoryEvents', bindMemoryEvents);
  safeInit('bindLegalEvents', bindLegalEvents);
  safeInit('btn-generate', () => {
    $('#btn-generate').addEventListener('click', generateCourse);
    const dg = $('#btn-diag-gen');
    if (dg) dg.addEventListener('click', generateDiagnostic);
  });

  // 装饰性初始化放最后，失败也不影响交互
  safeInit('initAvatar', initAvatar);
  safeInit('initAvatarVideo', initAvatarVideo);
  safeInit('initTTS', initTTS);
  safeInit('restoreTTSPref', restoreTTSPref);
  safeInit('restoreGuidePref', restoreGuidePref);
  // 账号与长期记忆：异步恢复会话，失败不影响页面
  safeInit('authUI', authUI);
  initAuth().catch((e) => { console.warn('[init] initAuth 失败:', e); renderMemoryView(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/* 测试钩子：把 const 声明的内部状态/常量挂到 window，供 jsdom 回归测试读写。
   生产运行时无副作用（仅暴露引用，不改变行为）。 */
try {
  Object.assign(window, {
    state, GUIDE_PROFILES, TTS, FACT_KINDS, MASTERY_LEVELS, buildMastery, renderMastery,
    ERROR_CAUSES, ERROR_CAUSE_KEYS, ERROR_CAUSE_MAX, normErrorCause, cleanErrorCauses,
    buildErrorProfile, renderCauses, renderErrorProfile,
    noteCauseSignals, flushLiveCauses, CAUSE_SIGNALS, setAIStatus,
    /* 入学诊断（起点画像） */
    DIAG_LEVELS, DIAG_MIN, DIAG_MAX, diagState,
    normDiagLevel, judgeDiagItem, buildDiagnostic, cleanDiagnostic,
    buildDiagnosticPrompt, diagnosticSystemPrompt, diagnosticPromptBlock,
    renderDiagnostic, renderDiagProfile, submitDiagnostic, generateDiagnostic,
    persistDiagnostic, renderMemoryDiag,
    guideProfile, setGuide, renderGuideBtn, restoreGuidePref, toggleMeta,
    openGuideModal, closeGuideModal,
    teacherSystemPrompt, renderSummary, buildLiveMessages,
    normalizeSlides, slideHTML, quizCountOf,
    /* 账号与长期记忆 */
    memoryPromptBlock, loadMemory, saveProfile, saveFacts, saveSession, deleteFact,
    memReady, authUI, authErr, onSignedIn, doSignOut, initAuth, openAuthModal, closeAuthModal,
    pickUser, fetchAuthUser, mergeUser,
    switchAuthTab, renderMemoryView, addMemoryFact, persistMemoryAfterClass, seedProfileFromLocal,
    continueAsGuest, dbPick, bindAuthEvents, bindMemoryEvents, switchView, bindMobileNav,
    /* AI 可用性与登录态自愈 */
    loadModels, setAIStatus, bindAIStatusRetry, requireModel, streamChat,
    isAuthError, healSession, ensureSessionHealthy, mapLLMError, PUBLIC_CONFIG,
    isChatModel, modelScore, rankModels, pickPreferredModel, applyModel, setModel, renderModelSelect,
    bindModelSelect, fastestAlternativeModel, errCode, slowModelError, emptyAnswerError,
    MODEL_PREFERENCE, MODEL_KEY, FIRST_CONTENT_BUDGET_MS,
    /* 弹窗可访问性 */
    allMasks, openMasks, enhanceModalA11y, watchModalFocus, bindModalA11yKeys, syncBodyScrollLock,
    /* 法律合规 */
    LEGAL_VERSION, PRIVACY_DOC, TERMS_DOC, DOCS, hasConsent, setConsent, consentChecked, requireConsent,
    openDoc, closeDoc, agreeDoc, normalizeCNPhone, phoneMask, smsErr, signInFromPhone,
    openAccountModal, closeAccountModal, exportMyData, deleteMyAccount, acctMsg, bindLegalEvents, CONSENT_KEY,
  });
} catch (_) {}
