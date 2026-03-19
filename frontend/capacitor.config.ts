import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.nowen.note",
  appName: "Nowen Note",
  webDir: "dist",
  server: {
    // 允许 HTTP 明文（连接局域网 IP 需要）
    cleartext: true,
    // 不使用内置服务器的 origin，让 fetch 使用绝对 URL
    androidScheme: "http",
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      // 禁用自动隐藏，由前端 JS 在渲染完成后手动调用 hide()
      launchAutoHide: false,
      // 背景色与深色主题一致，减少视觉跳变
      backgroundColor: "#0d1117",
      // 使用现有 splash.png
      launchShowDuration: 0,
      showSpinner: false,
    },
    StatusBar: {
      // 默认深色模式状态栏（后续由 JS 动态切换）
      style: "DARK",
      backgroundColor: "#0d1117",
    },
    Keyboard: {
      // 键盘弹出时不自动调整 WebView 大小，由前端 JS 手动控制布局
      resize: "none",
      // 点击 WebView 空白区域时自动收起键盘
      resizeOnFullScreen: true,
    },
  },
};

export default config;
