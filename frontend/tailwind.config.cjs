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
        dark: {
          bg: "#0d1117",
          surface: "#161b22",
          elevated: "#1c2333",
          border: "#30363d",
          hover: "#1f2937",
          active: "#253040",
        },
        accent: {
          primary: "#58a6ff",
          secondary: "#7ee787",
          warning: "#f0883e",
          danger: "#f85149",
          muted: "#8b949e",
        },
        text: {
          primary: "#e6edf3",
          secondary: "#8b949e",
          tertiary: "#6e7681",
          inverse: "#0d1117",
        }
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
