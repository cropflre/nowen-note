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
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-in": "slideIn 0.3s ease-out",
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
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
