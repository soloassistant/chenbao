// 内容安全桩：__UNSAFE__ 为 true 时判不通过
module.exports = { screenContent: (s) => ({ ok: globalThis.__UNSAFE__ !== true, text: String(s || '') }) };
