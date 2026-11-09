/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 语义化颜色 - 通过 CSS 变量切换 Light/Dark
        app: {
          bg: "var(--color-bg)",
          surface: "var(--color-surface)",
          sidebar: "var(--color-sidebar)",
          elevated: "var(--color-elevated)",
          border: "var(--color-border)",
          hover: "var(--color-hover)",
          active: "var(--color-active)",
        },
        tx: {
          primary: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          tertiary: "var(--color-text-tertiary)",
          // 第四级文字色：禁用态 / 极弱提示（HIG quaternaryLabelColor 对齐）。
          // 默认皮肤也有回退定义，保证所有皮肤下都能用 text-tx-quaternary。
          quaternary: "var(--color-text-quaternary)",
          inverse: "var(--color-text-inverse)",
        },
        // NOTE: "accent" 原本是 DEFAULT 对象，扩展后同时支持 bg-accent / bg-accent-primary 等
        accent: {
          DEFAULT: "var(--color-hover)", // shadcn 风格的 bg-accent（悬停态浅灰）
          foreground: "var(--color-text-primary)",
          primary: "var(--color-accent-primary)",
          secondary: "var(--color-accent-secondary)",
          warning: "var(--color-accent-warning)",
          danger: "var(--color-accent-danger)",
          muted: "var(--color-accent-muted)",
        },
        // shadcn 语义色别名，映射到已有 CSS 变量。
        // 之所以加这些：项目里有大量组件（WorkspaceSwitcher、MembersPanel、TagInput、
        // SlashCommands 等）直接使用 bg-popover / bg-card / bg-background / border-border
        // / text-muted-foreground 等 shadcn 习惯类。若不定义，它们会变成透明色，
        // 导致下拉/浮层背景穿透，出现视觉错位。
        background: "var(--color-bg)",
        foreground: "var(--color-text-primary)",
        card: {
          DEFAULT: "var(--color-elevated)",
          foreground: "var(--color-text-primary)",
        },
        popover: {
          DEFAULT: "var(--color-elevated)",
          foreground: "var(--color-text-primary)",
        },
        primary: {
          DEFAULT: "var(--color-accent-primary)",
          foreground: "var(--color-text-inverse)",
        },
        secondary: {
          DEFAULT: "var(--color-surface)",
          foreground: "var(--color-text-primary)",
        },
        muted: {
          DEFAULT: "var(--color-surface)",
          foreground: "var(--color-text-secondary)",
        },
        destructive: {
          DEFAULT: "var(--color-accent-danger)",
          foreground: "var(--color-text-inverse)",
        },
        border: "var(--color-border)",
        input: "var(--color-border)",
        ring: "var(--color-accent-primary)",
      },
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        // 与 CSS 变量绑定的语义圆角令牌：
        //   rounded-window → 窗口/大面板（macOS 10px，默认 10px）
        //   rounded-card   → 卡片/列表项（macOS 8px）
        //   rounded-button → 按钮（macOS 6px）
        //   rounded-input  → 输入框（macOS 5px）
        // 皮肤切换时值由 index.css 里的 --radius-* 覆盖，组件代码无需改。
        window: "var(--radius-window)",
        card: "var(--radius-card)",
        button: "var(--radius-button)",
        input: "var(--radius-input)",
      },
      // Motion Design System：取值来自 src/motion.css 的 CSS 变量（JS 侧镜像在 src/lib/motion.ts）。
      // tailwindcss-animate 会把 duration-* / ease-* 同步到 animation-duration / timing-function。
      transitionDuration: {
        instant: "var(--motion-duration-instant)",
        fast: "var(--motion-duration-fast)",
        normal: "var(--motion-duration-normal)",
        slow: "var(--motion-duration-slow)",
      },
      transitionTimingFunction: {
        standard: "var(--motion-ease-standard)",
        enter: "var(--motion-ease-enter)",
        exit: "var(--motion-ease-exit)",
      },
      transitionProperty: {
        // 交互反馈只过渡颜色、透明度、阴影与 transform，不触发布局。
        interactive: "color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform",
      },
      boxShadow: {
        popover: "var(--shadow-popover)",
        dialog: "var(--shadow-dialog)",
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-in": "slideIn 0.3s ease-out",
        "nowen-fade-in": "nowen-fade-in var(--motion-duration-normal) var(--motion-ease-standard)",
        // backwards：配合 animation-delay 做错峰时，等待期间保持起始帧，结束后不残留样式。
        "nowen-rise-in": "nowen-rise-in var(--motion-duration-normal) var(--motion-ease-enter) backwards",
        "nowen-tree-reveal": "nowen-tree-reveal var(--motion-duration-fast) var(--motion-ease-enter)",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideIn: {
          "0%": { transform: "translateX(-10px)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        "nowen-fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "nowen-rise-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "none" },
        },
        "nowen-tree-reveal": {
          from: { opacity: "0", transform: "translateY(-3px)" },
          to: { opacity: "1", transform: "none" },
        },
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
