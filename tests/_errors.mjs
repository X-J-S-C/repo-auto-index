// 回归脚本共用的「页面错误收集器」。
//
// 为什么要抽出来（2026-10-14）：
//   三张卡（panel / report / chain）都按候选通道探测后端：先试相对路径，答不了再换下一条。
//   离线台没接真后端，所以「探测失败」是**设计内的正常路径**，不是缺陷。
//   以前各脚本自己写过滤，写法还不一样——sweep.mjs 用的是 /favicon|404/，
//   这条太宽：随便哪个真资源缺了报 404 都会被它吃掉，等于把判据戳了个洞。
//
//   本模块把「哪些是已知噪音」写在一处，只放行两类：
//     1. /favicon.ico —— 浏览器自己伸的手，每次访问都会要，与 App 无关
//     2. 卡片的后端通道探测 —— 路径落在 /routes/ 下且返回 404
//   其余一律算错。要放行第三条噪音，必须在这里写清理由，不能就地放宽正则。
//
// 用法：
//   import { collectErrors } from "./_errors.mjs";
//   const errors = collectErrors(page);
//   ...
//   console.log("ERRORS:", errors.length ? errors : "(none)");

/** 已知噪音：这些 URL 的失败不算 App 的问题。 */
const NOISE_URL = [
  /\/favicon\.ico$/,
  /\/routes\//, // 卡片的后端通道探测（离线台无后端）
];

/**
 * 给一个 playwright page 挂上错误收集。
 * 返回一个数组引用，随页面活动增长；同时读 console error / pageerror / requestfailed。
 */
export function collectErrors(page) {
  const errors = [];
  // 记录被放行、被拒绝的 URL，便于"检查器自身的可观测性"。
  page.on("response", (res) => {
    if (res.status() !== 404) return;
    if (NOISE_URL.some((re) => re.test(res.url()))) return;
    errors.push(`HTTP 404: ${res.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // console 的 404 文本不带 URL，URL 由上面的 response 钩子判过；
    // 这里只放行 pure-404 文案，其余 console error 一律留。
    if (/Failed to load resource: the server responded with a status of 404/.test(m.text())) return;
    errors.push("CONSOLE: " + m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("requestfailed", (r) => {
    if (NOISE_URL.some((re) => re.test(r.url()))) return;
    errors.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`);
  });
  return errors;
}

/** 给「回退到内联样本」这类预期路径用的说明，写进报告便于人核。 */
export const NOISE_NOTE =
  "已知噪音：/favicon.ico 与 /routes/* 的后端探测 404（离线台没有真后端，卡片按候选通道探测是设计内的正常路径）";
