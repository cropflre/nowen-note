/**
 * 为每条使用 dvh 的声明补一条 vh 回退：
 *   max-height: 85dvh;  →  max-height: 85vh; max-height: 85dvh;
 *
 * 旧版 Android WebView（Chromium 108 之前）不认识 dvh，会把整条声明丢掉，弹窗、底部面板因此失去
 * 高度上限，超出屏幕又无法滚动。补在前面的 vh 声明在旧引擎里生效，新引擎里被后面的 dvh 覆盖。
 * 只改属性值，不动选择器和 @supports / @media 条件；自定义属性（--x）在使用处才校验，补了也无效，跳过。
 */
const DVH_LENGTH = /(\d*\.?\d+)dvh\b/g;

function dvhFallback() {
  return {
    postcssPlugin: "nowen-dvh-fallback",
    Declaration(decl) {
      if (decl.prop.startsWith("--") || !decl.value.includes("dvh")) return;
      const fallback = decl.value.replace(DVH_LENGTH, "$1vh");
      if (fallback === decl.value) return;
      const previous = decl.prev();
      if (previous?.type === "decl" && previous.prop === decl.prop && previous.value === fallback) return;
      decl.cloneBefore({ value: fallback });
    },
  };
}
dvhFallback.postcss = true;

module.exports = dvhFallback;
