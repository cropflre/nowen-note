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
      disableTransitionOnChange={false}
      storageKey="nowen-note-theme"
    >
      {children}
    </NextThemesProvider>
  );
}
