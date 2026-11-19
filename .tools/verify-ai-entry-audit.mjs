#!/usr/bin/env node
/**
 * 新 AI 入口的行为门禁（2026-11-19）。
 *
 * 起因：只读审计指出「CI 全绿，关键功能仍然有错」——出题/讲解绕过额度闸门，
 * 高考/AP 的元数据被写成 edexcel/a2 导致入库被拒，结果页重复调用。
 * 这些不是文案扫描能守住的，必须**真跑**判定函数与调用链。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const STUB = (n) => path.join(ROOT, '.tools', 'stubs', n);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond === true) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
};

async function loadPaperGen() {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/services/paperGen.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent',
    alias: {
      '@tarojs/taro': STUB('stub-ai-entry-taro.cjs')
    },
    plugins: [{
      name: 'ai-entry-stubs',
      setup(build) {
        // 源码里用的是相对路径（./cloudLlm、./aiQuota），alias 的 @/ 前缀匹配不到，
        // 用 onResolve 按文件名收口，避免门禁偷偷测到真实云端实现。
        build.onResolve({ filter: /^\.\/cloudLlm$/ }, () => ({ path: STUB('stub-ai-entry-llm.cjs') }));
        build.onResolve({ filter: /^\.\/aiQuota$/ }, () => ({ path: STUB('stub-ai-entry-quota.cjs') }));
        build.onResolve({ filter: /contentSafety$/ }, () => ({ path: STUB('stub-ai-entry-safety.cjs') }));
      }
    }]
  });
  const sandbox = { module: { exports: {} }, exports: {}, console: { log() {}, warn() {}, error() {} }, process: { env: {} }, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'paperGen.ts' });
  return sandbox;
}

const sandbox = await loadPaperGen();
const { resolveGenMetadata, generateQuestions } = sandbox.module.exports;

/* A. 元数据：体系决定 board/level，不再全局默认 edexcel/a2 */
const gk = resolveGenMetadata({ examSystem: 'gaokao', subject: '数学' });
const ap = resolveGenMetadata({ examSystem: 'ap', subject: 'calculus' });
const al = resolveGenMetadata({ examSystem: 'alevel', subject: 'mathematics' });
ok('A1 高考元数据 = china_moe / na', gk.ok === true && gk.board === 'china_moe' && gk.level === 'na', JSON.stringify(gk));
ok('A2 AP 元数据 = collegeboard / na', ap.ok === true && ap.board === 'collegeboard' && ap.level === 'na', JSON.stringify(ap));
ok('A3 ALevel 未指定考试局时标 other，不冒充 Edexcel', al.ok === true && al.board === 'other', JSON.stringify(al));
ok('A4 学科不在闭集时调用模型前就拒绝', resolveGenMetadata({ examSystem: 'gaokao', subject: 'nonsense' }).ok === false);
ok('A5 显式 level 与体系冲突时拒绝', resolveGenMetadata({ examSystem: 'ap', subject: 'calculus', level: 'a2' }).ok === false);

/* B. 调用链：额度、内容、记账三者口径一致 */
const reset = (quotaOk = true, unsafe = false) => {
  sandbox.__LLM_CALLS__ = 0;
  sandbox.__LOCAL_BUMP__ = 0;
  sandbox.__QUOTA_OK__ = quotaOk;
  sandbox.__UNSAFE__ = unsafe;
};
reset();
const gen = await generateQuestions({ examSystem: 'gaokao', subject: '数学', topic: '函数', tags: [], count: 3 });
ok('B1 正常出题成功，题目落库元数据为高考 na', gen.ok === true && gen.questions.every((q) => q.level === 'na' && q.board === 'china_moe' && q.examSystem === 'gaokao'), gen.reason || '');
ok('B2 一次成功调用只发一次模型请求、只补一次本地额度', sandbox.__LLM_CALLS__ === 1 && sandbox.__LOCAL_BUMP__ === 1, `llm=${sandbox.__LLM_CALLS__} bump=${sandbox.__LOCAL_BUMP__}`);
reset(false);
const noQuota = await generateQuestions({ examSystem: 'gaokao', subject: '数学', topic: '函数', tags: [] });
ok('B3 额度耗尽时根本不调用模型', noQuota.ok === false && noQuota.reason === 'quota' && sandbox.__LLM_CALLS__ === 0 && sandbox.__LOCAL_BUMP__ === 0);
reset(true, true);
const unsafe = await generateQuestions({ examSystem: 'gaokao', subject: '数学', topic: '函数', tags: [] });
ok('B4 内容检查不过时不调用模型', unsafe.ok === false && unsafe.reason === 'unsafe' && sandbox.__LLM_CALLS__ === 0);

/* C. 静态约束：不回退到旧写法 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const paperSrc = stripComments(read('src/services/paperGen.ts'));
const reviewSrc = stripComments(read('src/services/mockReview.ts'));
const resultSrc = read('src/pages/mockExamResult/index.tsx');
const examSrc = read('src/pages/mockExam/index.tsx');
const delSrc = read('cloudfunctions/deleteAccount/index.js');
ok('C1 出题/讲解都过统一闸门，且不再单独写云端用量',
  paperSrc.includes('guardAiEntry(prompt)') && reviewSrc.includes('guardAiEntry(userContent)') &&
  paperSrc.includes('finishAiEntry(raw)') && reviewSrc.includes('finishAiEntry(raw)') &&
  !paperSrc.includes('llmEventInsert') && !reviewSrc.includes('llmEventInsert'));
ok('C2 结果页不再自动调用讲解，且复用已存结果',
  resultSrc.includes('loadStoredReview(s.id)') && resultSrc.includes('saveStoredReview(session.id, out.result)') &&
  resultSrc.includes("rvState === 'idle' && wrongItems.length") &&
  !/useEffect\([\s\S]{0,1400}reviewWrongAnswers\(/.test(resultSrc));
ok('C3 真题外链复用 openExternalPage，不再直接 window.open',
  examSrc.includes("import { openExternalPage } from '@/utils/externalLink'") &&
  examSrc.includes('openExternalPage(url)') && !/window\.open\(/.test(examSrc));
ok('C4 注销日志经 maskId，且不打印原始异常信息',
  delSrc.includes("require('./maskId')") && delSrc.includes('maskId(OPENID)') &&
  !/console\.(error|info|warn|log)\([^\n]*err\.message/.test(delSrc));

console.log(`\nAI 入口门禁：PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条）`);
process.exit(fail === 0 ? 0 : 1);
