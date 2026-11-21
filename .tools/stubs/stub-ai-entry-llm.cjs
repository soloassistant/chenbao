// 只给 .tools/verify-ai-entry-audit.mjs 用：记录模型调用次数，不联网
module.exports = {
  cloudLlmChat: async () => {
    globalThis.__LLM_CALLS__ = (globalThis.__LLM_CALLS__ || 0) + 1;
    return JSON.stringify([{
      stem: '已知函数 f(x)=x^2+1，求 f(2) 的值是多少',
      options: [{ key: 'A', text: '3' }, { key: 'B', text: '4' }, { key: 'C', text: '5' }, { key: 'D', text: '6' }],
      answer: 'C', explanation: '代入计算'
    }]);
  }
};
