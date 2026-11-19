// 额度桩：__QUOTA_OK__ 控制闸门，__LOCAL_BUMP__ 记录本地镜像写入次数
module.exports = {
  getAiQuota: async () => ({ subscribed: false, used: 0, limit: 10, remaining: globalThis.__QUOTA_OK__ === false ? 0 : 10 }),
  canChat: (q) => q.remaining > 0,
  bumpLocalUsage: () => { globalThis.__LOCAL_BUMP__ = (globalThis.__LOCAL_BUMP__ || 0) + 1; }
};
