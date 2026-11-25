module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
    // 放在最后：Tailwind 生成的任意值类（如 max-h-[85dvh]）也要补上旧 WebView 的 vh 回退。
    "./postcss-dvh-fallback.cjs": {},
  },
};
