var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/utils/contentSafety.ts
var contentSafety_exports = {};
__export(contentSafety_exports, {
  SAFETY_REFUSAL_EN: () => SAFETY_REFUSAL_EN,
  SAFETY_REFUSAL_ZH: () => SAFETY_REFUSAL_ZH,
  safetyRefusal: () => safetyRefusal,
  screenContent: () => screenContent
});
module.exports = __toCommonJS(contentSafety_exports);
var RULES = [
  // 爆炸物 / 危险品制作
  { category: "explosive", re: /(制作|自制|配制|合成|组装)[^。\n]{0,18}(炸弹|炸药|雷管|爆炸物|燃烧弹)/ },
  // 毒品制作
  { category: "drugs", re: /(制作|提炼|合成|配制)[^。\n]{0,18}(冰毒|海洛因|毒品|麻古|K粉)/ },
  // 侵害未成年人
  { category: "minor", re: /(未成年|儿童|幼女|萝莉)[^。\n]{0,12}(裸照|色情|性行为|性交|视频)/ },
  // 教唆自残 / 自杀方法
  { category: "self-harm", re: /(自杀|自残)[^。\n]{0,12}(方法|教程|怎么做|步骤|无痛)/ },
  // 洗钱 / 套现
  { category: "fraud", re: /(银行卡|信用卡|收款码)[^。\n]{0,12}(套现|洗钱|跑分|代收)/ },
  // 代写代考
  { category: "cheat", re: /(代写|代考|枪手)[^。\n]{0,10}(论文|作业|考试|四六级|雅思)/ }
];
function normalize(text) {
  return text.replace(/[\u3000]/g, " ").replace(/[\u200b-\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").toLowerCase();
}
function screenContent(text) {
  if (!text || typeof text !== "string") return { ok: true };
  const s = normalize(text);
  for (const rule of RULES) {
    if (rule.re.test(s)) return { ok: false, category: rule.category };
  }
  return { ok: true };
}
var SAFETY_REFUSAL_ZH = "\u8FD9\u4E2A\u8BF7\u6C42\u6D89\u53CA\u8FDD\u6CD5\u8FDD\u89C4\u5185\u5BB9\uFF0C\u6211\u4E0D\u80FD\u534F\u52A9\u3002\u53EF\u4EE5\u6362\u4E2A\u95EE\u9898\uFF0C\u6216\u901A\u8FC7\u300C\u6211\u7684 \u2192 \u53CD\u9988\u300D\u8054\u7CFB\u4EBA\u5DE5\u3002";
var SAFETY_REFUSAL_EN = "This request involves unlawful content, so I can\u2019t help with it. Please rephrase, or contact us via Me \u2192 Feedback.";
function safetyRefusal(lang) {
  return lang === "en" ? SAFETY_REFUSAL_EN : SAFETY_REFUSAL_ZH;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SAFETY_REFUSAL_EN,
  SAFETY_REFUSAL_ZH,
  safetyRefusal,
  screenContent
});
