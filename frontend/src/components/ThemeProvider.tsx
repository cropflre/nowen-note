import { ThemeProvider as NextThemesProvider } from "next-themes";
import React from "react";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      // 默认主题：日间（light）。
      // 仅在用户首次打开、尚未保存任何主题选择时生效；一旦用户在设置里切换，
      // next-themes 会把选择写入 localStorage(storageKey)，后续沿用用户偏好。
      defaultTheme="light"
      enableSystem
      // Android WebView 在根节点 class 改变时若同时执行全站 transition-colors，
      // 会连续重绘大面积背景并出现明显闪白/抖动。主题切换期间临时禁用 CSS
      // transition，切换完成后 next-themes 会自动恢复，不影响普通交互动效。
      disableTransitionOnChange
      storageKey="nowen-note-theme"
    >
      {children}
    </NextThemesProvider>
  );
}
