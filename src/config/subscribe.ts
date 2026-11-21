/**
 * 订阅消息模板 id 集中配置（上线三件事 · 前端侧）。
 *
 * 获取路径：微信公众平台（mp.weixin.qq.com）→ 功能 → 订阅消息 → 「选用模板」→
 * 选「一次性订阅」类型的模板 → 复制模板 id（形如 xxxxxxxxxxxxxxxxxx-xxxx）→ 粘贴到下方。
 *
 * 注意：云函数 getBriefing 侧通过环境变量 SUBSCRIBE_TEMPLATE_ID 读同一个 id，
 * 两处必须填同一个值（详见 docs/云函数部署指南.md 的「订阅消息模板 id 配置」一节）。
 *
 * 空串 = 未配置：promptSubscribe 对空串直接 noop（不弹窗、不计入统计），不影响现有行为。
 */
const ENV_TEMPLATE_ID = (process.env.TARO_APP_SUBSCRIBE_TEMPLATE_ID || '').trim();

/** 真值只来自构建期环境变量（config/index.ts 的 defineConstants 注入）。
 *  不写死在源码里：模板 id 属于账号配置，不该跟着代码走，也不该让「空串」成为
 *  一个看起来像已完成、实际永远 noop 的常量。 */
export const SUBSCRIBE_TEMPLATE_ID = ENV_TEMPLATE_ID;

/** 是否真的可用：非空、不是 TODO 占位、形状像微信模板 id。
 *  UI 用它决定「显示订阅按钮」还是「如实说明当前未开通」，避免点了没反应。 */
export const SUBSCRIBE_CONFIGURED =
  SUBSCRIBE_TEMPLATE_ID.length >= 10 &&
  !SUBSCRIBE_TEMPLATE_ID.startsWith('TODO') &&
  /^[A-Za-z0-9_-]+$/.test(SUBSCRIBE_TEMPLATE_ID);
