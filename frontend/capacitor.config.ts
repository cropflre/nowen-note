import type { CapacitorConfig } from "@capacitor/cli";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// ===== 热更新信任锚点 =====
// 壳指纹（runtimeVersion）和签名公钥在 cap sync 时写进 APK 自带的
// android/app/src/main/assets/capacitor.config.json（已被 gitignore）。热更新包只替换网页目录，
// 改不到这里，所以前端和插件只信任这里的值。指纹从 git 提交计算，与发版流水线的 hot job 一致。
// 本机测试可用 NOWEN_HOT_UPDATE_TEST_PUBLIC_KEYS_FILE 指向临时公钥列表；CI 里设置会直接失败。
// 详见 docs/architecture/hot-update.md。
function resolveHotUpdateAnchors() {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const runtime = JSON.parse(
    execFileSync(process.execPath, [path.join(repoRoot, "scripts/hot-update/runtime-fingerprint.mjs"), "--repo", repoRoot], { encoding: "utf8" }),
  );
  const testKeys = process.env.NOWEN_HOT_UPDATE_TEST_PUBLIC_KEYS_FILE;
  if (testKeys && process.env.GITHUB_ACTIONS === "true") throw new Error("CI 构建不允许使用测试热更新公钥");
  const keys = JSON.parse(readFileSync(testKeys ? path.resolve(testKeys) : path.join(repoRoot, "hot-update/public-keys.json"), "utf8")).keys ?? [];
  // 列表第一把是当前签名用的公钥；安卓插件只能配置一把。
  const active = keys[0];
  if (testKeys) console.warn(`[hot-update] 使用测试公钥 ${active?.id ?? "(空)"}，这个安装包不能发布`);
  return { runtimeVersion: String(runtime.android), publicKey: active?.pem ?? "", keyId: active?.id ?? "" };
}
const hotUpdate = resolveHotUpdateAnchors();

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
    CapacitorHttp: {
      // Android WebView 的 fetch 会受 CORS 限制；原生 HTTP 可让移动端直连自托管服务。
      enabled: true,
    },
    SplashScreen: {
      // 禁用自动隐藏，由前端 JS 在渲染完成后手动调用 hide()
      // Safety net for older Android WebViews: JS still calls hide(), but native must not stay stuck forever.
      launchAutoHide: true,
      // 奶白底，与 app icon 背景 (#F5F3EE) 一致，开机视觉不跳变
      backgroundColor: "#F5F3EE",
      // 使用现有 splash.png
      launchShowDuration: 2500,
      showSpinner: false,
    },
    StatusBar: {
      // 冷启动初始值（浅色）；启动后由 useStatusBarSync 根据主题动态切换
      style: "LIGHT",
      backgroundColor: "#F5F3EE",
    },
    Keyboard: {
      // 键盘弹出时不自动调整 WebView 大小，由前端 JS 手动控制布局。
      //
      // 与 AndroidManifest.xml 中 `windowSoftInputMode="adjustNothing"` 配套：
      //   - resize:"none" 让 Capacitor 不主动通知 JS 调整视口；
      //   - adjustNothing 让 Android 系统也不调整 Activity；
      //   - 双管齐下确保 WebView 始终保持全屏，键盘纯绘制在最上层；
      //   - 前端通过 Capacitor Keyboard.addListener 拿精确键盘高度自己加 padding。
      //
      // **不要打开 `resizeOnFullScreen`**：该字段在 Android 全屏时会强制使用
      // Native resize 模式（覆盖 `resize` 字段），导致 WebView frame 被原生层
      // 压扁，而 CSS 视口仍按全屏算 —— 表现为键盘上方露出 Activity windowBackground
      // (Light 主题下 = 白色)，即"输入框下方一大片白色空白延伸到键盘顶端"。
      resize: "none",
    },
    LiveUpdate: {
      // 新包启动后 45 秒内没调用 ready() 就退回 APK 自带的版本（进程被杀也会在下次启动回退），
      // 回退后屏蔽这个包；下载、切换都由前端按签名清单手动驱动，从不连 Capawesome Cloud。
      // 不用 10 秒：应用自己把 12 秒才算慢启动，低端机加上首次数据库迁移会被误判为坏包。
      readyTimeout: 45000,
      autoDeleteBundles: true,
      autoBlockRolledBackBundles: true,
      autoUpdateStrategy: "none",
      ...(hotUpdate.publicKey ? { publicKey: hotUpdate.publicKey } : {}),
    },
    NowenHotUpdateRuntime: hotUpdate,
  },
};

export default config;
