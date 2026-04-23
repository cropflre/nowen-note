import type { CapacitorConfig } from "@capacitor/cli";

// Live Reload 开关：设置环境变量 `CAP_LIVE_URL=http://<电脑LAN_IP>:5173` 后再
// 执行 `npx cap sync android` / run android，即可让 WebView 直接加载电脑的
// vite dev server，改代码秒刷。**发 release 时必须清掉该变量**（否则生成的
// APK 会去连一个局域网地址，装在别的设备上直接白屏）。
// 检测 `npm run cap:release` 这种生产构建时我们通过 NODE_ENV 兜底一下。
const LIVE_URL = process.env.CAP_LIVE_URL;
const isProd = process.env.NODE_ENV === "production";

const config: CapacitorConfig = {
  appId: "com.nowen.note",
  appName: "Nowen Note",
  webDir: "dist",
  server: {
    // 允许 HTTP 明文（连接局域网 IP / HTTP 服务器需要）
    cleartext: true,
    // Live Reload：仅在显式设置 CAP_LIVE_URL 且非生产时生效
    ...(LIVE_URL && !isProd
      ? {
          url: LIVE_URL,
          // androidScheme 切到 http，否则 http 的 server.url 与默认 https origin
          // 不同源，WebView 的 fetch / WebSocket 会被跨 origin 策略干扰。
          // 注意：此举只在 Live Reload 下临时生效，release 不走这里。
          androidScheme: "http",
        }
      : {}),
    // androidScheme 保持默认 "https"（不显式指定）：
    //   1) 默认 origin 为 https://localhost，符合浏览器现代安全模型，
    //      avoids Service Worker / fetch / cookie 在 http origin 下被额外限制；
    //   2) 配合 allowMixedContent:true + cleartext:true，仍然可以从 https 页面
    //      调 http://192.168.x.x:3001 这种局域网后端；
    //   3) 切勿改回 "http" —— 改 scheme 会切换 WebView 的 origin，导致旧版本
    //      localStorage（含登录 token / 服务器地址）全部丢失，升级后表现为
    //      "登录后重启白屏"。
  },
  android: {
    // 允许 https origin 的页面加载 / 请求 http 资源（连内网 HTTP 后端需要）
    allowMixedContent: true,
  },
  plugins: {
    SplashScreen: {
      // 禁用自动隐藏，由前端 JS 在渲染完成后手动调用 hide()
      launchAutoHide: false,
      // 奶白底，与 app icon 背景 (#F5F3EE) 一致，开机视觉不跳变
      backgroundColor: "#F5F3EE",
      // 使用现有 splash.png
      launchShowDuration: 0,
      showSpinner: false,
    },
    StatusBar: {
      // 冷启动初始值（浅色）；启动后由 useStatusBarSync 根据主题动态切换
      style: "LIGHT",
      backgroundColor: "#F5F3EE",
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
