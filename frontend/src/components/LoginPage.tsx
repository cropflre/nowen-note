import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Lock, User, BookOpen, CheckCircle2, AlertCircle, Mail, UserPlus, ShieldCheck, Eye, EyeOff, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getServerUrl, setServerUrl, clearServerUrl, testServerConnection, fetchRegisterConfig, registerAccount, diagnoseConnection, type DiagnosisResult } from "@/lib/api";
import { buildServerUrl, parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";
import ServerAddressInput from "@/components/ServerAddressInput";
import LanDiscoveryPanel from "@/components/LanDiscoveryPanel";
import { useKeyboardLayout } from "@/hooks/useCapacitor";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";
import {
  loadRememberedCredentials,
  saveRememberedCredentials,
  clearRememberedCredentials,
  canPersistPassword,
} from "@/lib/rememberLogin";

interface LoginPageProps {
  onLogin: (token: string, user: any) => void;
  /** 是否为客户端模式（Electron / Android / 曾配置过服务器地址） */
  isClientMode?: boolean;
  onDisconnect?: () => void;
}

type Mode = "login" | "register";

// 体验环境配置（仅 demo 站点构建时通过 VITE_DEMO_MODE=true 开启；自部署用户默认 false）。
// 账号/密码可通过 VITE_DEMO_USERNAME / VITE_DEMO_PASSWORD 覆盖，未设置时使用默认值。
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const DEMO_USERNAME = import.meta.env.VITE_DEMO_USERNAME || "demo";
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || "demo123456";

export default function LoginPage({ onLogin, isClientMode = false, onDisconnect }: LoginPageProps) {
  const [mode, setMode] = useState<Mode>("login");
  // 登录页外层滚动容器 ref（软键盘适配用，见下方 useEffect）
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // 登录页键盘适配 —— 直接复用全站既有的原生键盘事件链，**不要再自己用
  // visualViewport 推断键盘高度**（推断在 Android `Keyboard.resize: "none"`
  // 下不稳，会出现"露白"或残留 padding）。
  //
  // 实现方式：
  //   1) `useKeyboardLayout()`：注册 Capacitor 原生 `keyboardWillShow/Hide`
  //      事件，事件回调里把 `info.keyboardHeight` 写入 CSS 变量
  //      `--keyboard-height` 和 `data-keyboard` 属性。这是从原生层拿到的
  //      **精确像素**，与 WebView CSS 视口无关，跨 Android/iOS 一致。
  //      AppLayout（登录后）也调用了同一个 hook —— 没有冲突，各自 add/remove
  //      自己的 listener。**登录页必须独立调一次**，否则没人写 CSS 变量。
  //   2) `useKeyboardVisible()`：MutationObserver 监听 html 上 CSS 变量
  //      变化，把 `{ visible, height }` 转成 React state 供本组件用。
  //
  // 为什么之前的 `visualViewport.height` 方案不行？
  //   - 在 Android `Keyboard.resize: "none"` 下，WebView 全屏不缩，但
  //     `visualViewport.height` 也**不一定缩**（取决于 WebView 版本/厂商定制
  //     —— 部分 ROM 上 visualViewport 完全不感知键盘）。原生事件是唯一稳的源。
  //   - 上一版用 `maxHeight = visualViewport.height` 让外层容器只占屏幕上方，
  //     容器下方到屏幕底之间露出 body 背景（≈白色），就是截图里的"红框白块"。
  useKeyboardLayout();
  const { height: keyboardHeight } = useKeyboardVisible();

  // 【Android/iOS 关键修复】主动把 focused input 滚到容器可视区上 1/4 处。
  //
  // 背景：
  //   - 全局 CSS `html, body, #root { overflow: hidden }` 禁止了文档级滚动，
  //     因此必须在 LoginPage 外层 div 自己挂 overflow-y-auto 作为滚动容器。
  //   - Android WebView 下，浏览器自带的 focus-scrollIntoView **几乎不工作**,
  //     尤其是可滚动祖先不是 document 而是内部 div 时；iOS 相对稳但也有抖动。
  //   - 原生 `el.scrollIntoView({ block: "center" })` 会向上冒泡到**最近的**
  //     可滚动祖先 —— 就是我们的 scrollContainerRef —— 但在 Android WebView
  //     多次实测行为不可靠。因此直接**手动算 scrollTop**，跨平台最稳。
  //
  // 实现：
  //   1) 监听 document.focusin（冒泡，能捕获所有 input/textarea focus）；
  //   2) 同时监听 visualViewport.resize（键盘弹起/收起触发的视口变化）；
  //   3) 延迟 80ms 等 keyboardHeight state & DOM 布局完成；
  //   4) 计算 scrollTop 让输入框出现在容器可视区上 1/4 处（非居中），留下
  //      3/4 给"登录按钮 + 底部提示"，避免按钮被键盘盖住。
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scrollFocusedIntoView = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const container = scrollContainerRef.current;
        const el = document.activeElement as HTMLElement | null;
        if (
          !container ||
          !el ||
          (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")
        ) {
          return;
        }
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        // 输入框相对容器顶部的偏移（含当前已滚动部分）
        const offsetTop = elRect.top - containerRect.top + container.scrollTop;
        // 目标：把输入框滚到可视区**上 1/4 处**（而非居中）。
        // 理由：登录表单里用户真正需要看到的是"当前输入框 + 其下方的
        // 登录按钮 + 底部提示"，不是输入框上方的 logo/标题。如果把 input
        // 居中（container.clientHeight / 2），下方只剩一半可视区，登录按钮
        // 往往被挤到键盘下方 —— 截图里"记住密码下方一大片空白、按钮不可见"
        // 就是这个原因。滚到 1/4 处留下 3/4 可视区给下方内容，按钮始终可见。
        const target = offsetTop - container.clientHeight * 0.25;
        const maxScroll = container.scrollHeight - container.clientHeight;
        const next = Math.max(0, Math.min(target, maxScroll));
        container.scrollTo({ top: next, behavior: "smooth" });
      }, 80);
    };
    document.addEventListener("focusin", scrollFocusedIntoView);
    const vv = window.visualViewport;
    if (vv) vv.addEventListener("resize", scrollFocusedIntoView);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("focusin", scrollFocusedIntoView);
      if (vv) vv.removeEventListener("resize", scrollFocusedIntoView);
    };
  }, []);
  // 服务器地址拆成 (protocol, host, port) 三段，避免用户手填整串 URL 出错；
  // 旧数据 localStorage 里是完整 URL，下方 useEffect 里用 parseServerUrl 回填
  const [serverParts, setServerParts] = useState<ServerAddressParts>({
    protocol: "http",
    host: "",
    port: "",
    path: "",
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // 密码明文/密文切换（登录 + 注册共用；确认密码独立一个开关）
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [serverStatus, setServerStatus] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [diagResults, setDiagResults] = useState<DiagnosisResult[] | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true);
  const [hasUsers, setHasUsers] = useState(false);
  // Phase 6: 2FA 两阶段登录 state —— 第一步（密码）成功后若后端返回 requires2FA,
  // 就暂存 ticket + 当前 baseUrl，切到 2FA 面板让用户输入 6 位动态码或恢复码。
  const [twoFactor, setTwoFactor] = useState<{
    ticket: string;
    username: string;
    baseUrl: string; // 用于 2fa/verify 的 origin，保持与登录阶段一致
  } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  // 「记住密码 / 自动登录」
  //   - rememberMe：登录成功后把密码加密保存；下次打开自动预填
  //   - autoLogin：在 rememberMe 基础上，打开 App 自动触发登录（无需再点按钮）
  //   - canSavePassword：当前运行环境是否能安全保存密码（Web=false，Electron 要看 safeStorage）
  //   - triedAutoLoginRef：确保"自动登录"只触发一次，避免失败后无限自动重试
  const [rememberMe, setRememberMe] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  const [canSavePassword, setCanSavePassword] = useState(false);
  const triedAutoLoginRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const { t } = useTranslation();

  // 回填上次的服务器地址（兼容旧版：localStorage 里可能存的是完整 URL 字符串）
  //
  // Electron 桌面端特殊处理：首次启动时 localStorage 里什么都没有，若走常规逻辑会
  // 展示一个空的"服务器地址"框，强迫用户先填才能登录 —— 但 Electron 本身就带一个
  // 本机内置后端（窗口加载的就是 http://127.0.0.1:<port>/），默认就该连它。
  // 因此若 Electron 检测到 nowenDesktop 且没有历史 serverUrl，用 window.location.origin
  // 作为默认地址预填。用户想连远程时清空 host 另填即可。
  useEffect(() => {
    if (!isClientMode) return;
    const saved = getServerUrl() || localStorage.getItem("nowen-server-url-last") || "";
    if (saved) {
      setServerParts(parseServerUrl(saved));
      setServerStatus("ok");
      return;
    }
    const isElectron = !!(window as any).nowenDesktop?.isDesktop;
    if (isElectron && window.location.origin.startsWith("http")) {
      setServerParts(parseServerUrl(window.location.origin));
      // 不主动标 ok —— 让用户按"登录"时再测，避免误判
    }
  }, [isClientMode]);

  // 拉取注册开关
  useEffect(() => {
    let cancelled = false;
    const baseUrl = isClientMode ? (getServerUrl() || "") : "";
    fetchRegisterConfig(baseUrl || undefined).then((cfg) => {
      if (!cancelled) setAllowRegistration(cfg.allowRegistration);
        setHasUsers(!!(cfg as any).hasUsers || Number((cfg as any).userCount || 0) > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [isClientMode, serverStatus]);

  // 探测当前环境是否能落盘密码（决定"记住密码"开关是否显示）
  useEffect(() => {
    let alive = true;
    canPersistPassword().then((v) => {
      if (alive) setCanSavePassword(v);
    });
    return () => { alive = false; };
  }, []);

  // 启动时读取"记住的凭据"→ 预填 + 视情况触发自动登录
  //
  // 关键：本 effect 只跑一次（mount），后续用户编辑不会再覆盖输入。
  //   - 仅当拿到非空凭据才预填；
  //   - 若设置了 autoLogin 且 hasPassword，等服务器地址就绪后自动点一次"登录"；
  //   - triedAutoLoginRef 防止失败后无限重试。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cred = await loadRememberedCredentials();
      if (cancelled || !cred) return;
      if (cred.username) setUsername(cred.username);
      if (cred.password) setPassword(cred.password);
      if (cred.serverUrl && isClientMode) {
        setServerParts(parseServerUrl(cred.serverUrl));
        // 不直接标 ok：等 resolveBaseUrl 或 blur 再探测
      }
      setRememberMe(!!cred.username); // 有保存就默认勾上
      setAutoLogin(!!cred.autoLogin);

      if (cred.autoLogin && cred.hasPassword && cred.username && cred.password) {
        // 延后一帧等 state 刷到输入框，再 requestSubmit 走正常流程
        // （走 handleSubmit 可以复用 serverCheck + 2FA + 错误显示的整套逻辑）
        if (triedAutoLoginRef.current) return;
        triedAutoLoginRef.current = true;
        setTimeout(() => {
          if (cancelled) return;
          try {
            formRef.current?.requestSubmit();
          } catch {
            /* ignore */
          }
        }, 120);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 服务器地址框 onBlur 时主动探测一次连通性，提前把 serverStatus 落到 ok/fail，
  // 让用户在点"登录"之前就能看到红/绿状态灯。
  const handleServerBlur = async () => {
    if (!isClientMode) return;
    const url = buildServerUrl(serverParts);
    if (!url) return;
    setServerStatus("checking");
    const result = await testServerConnection(url);
    setServerStatus(result.ok ? "ok" : "fail");
    if (result.ok) {
      // 刷新注册开关
      fetchRegisterConfig(url).then((cfg) => setAllowRegistration(cfg.allowRegistration));
    }
  };

  const runDiagnosis = async () => {
    const url = buildServerUrl(serverParts);
    if (!url) return;
    setDiagRunning(true);
    setDiagResults(null);
    try {
      const results = await diagnoseConnection(url);
      setDiagResults(results);
    } catch (e: any) {
      setDiagResults([{ step: "error", ok: false, detail: e.message || "诊断异常" }]);
    } finally {
      setDiagRunning(false);
    }
  };

  const resolveBaseUrl = async (): Promise<string | null> => {
    if (!isClientMode) return "";
    const url = buildServerUrl(serverParts);
    if (!url) {
      setError(t("auth.serverRequired"));
      return null;
    }
    setServerStatus("checking");
    const serverResult = await testServerConnection(url);
    if (!serverResult.ok) {
      setServerStatus("fail");
      setError(serverResult.error || t("server.connectFailed"));
      return null;
    }
    setServerStatus("ok");
    setServerUrl(url);
    localStorage.setItem("nowen-server-url-last", url);
    return url;
  };

  /**
   * 根据当前复选框状态持久化「记住密码 / 自动登录」。
   * 放一个独立函数是因为既要在普通登录成功后调用，也要在 2FA 一阶段成功后调用，
   * 避免两处 copy-paste。
   */
  const persistRememberState = async (baseUrl: string) => {
    try {
      await saveRememberedCredentials({
        remember: rememberMe,
        autoLogin: rememberMe && autoLogin,
        serverUrl: baseUrl || "",
        username,
        password: canSavePassword ? password : "",
      });
    } catch (e) {
      console.warn("[LoginPage] persist remember failed:", e);
    }
  };

  const handleLoginSubmit = async () => {
    const baseUrl = await resolveBaseUrl();
    if (baseUrl === null) return;

    const loginUrl = baseUrl ? `${baseUrl}/api/auth/login` : "/api/auth/login";
    // 带上 deviceId 用于会话去重，避免同一设备反复登录产生大量重复 session
    const { getDeviceId } = await import("@/lib/deviceId");
    const res = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, deviceId: getDeviceId() }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || t("auth.loginFailed"));
      // 登录失败：关闭本轮自动登录；若之前配置了自动登录，把 autoLogin 关掉防止死循环
      // （但保留用户名用于下次预填）
      if (autoLogin) {
        setAutoLogin(false);
        await saveRememberedCredentials({
          remember: rememberMe,
          autoLogin: false,
          serverUrl: baseUrl,
          username,
          password: "", // 密码可能错了，别再保留
        });
      }
      return;
    }
    // Phase 6: 2FA 两阶段 —— 后端返回 requires2FA 时，跳转到 2FA 面板
    //   ticket 只有 5 分钟有效期，仅能用于 /auth/2fa/verify；前端不把它写进 localStorage
    //   以减少 XSS 暴露面，切到 2FA 面板后保存在组件 state 里即可。
    //
    //   此时"一阶段密码校验"已经通过，记住密码/自动登录可以先落盘——
    //   下次自动登录仍会回到 2FA 面板，由用户输动态码。
    if (data.requires2FA && data.ticket) {
      await persistRememberState(baseUrl);
      setTwoFactor({ ticket: data.ticket, username: data.username || username, baseUrl });
      setPassword(""); // 清掉内存里的密码
      setTwoFactorCode("");
      return;
    }
    localStorage.setItem("nowen-token", data.token);
    // 持久化「记住密码 / 自动登录」配置（两者同时可独立开关）
    await persistRememberState(baseUrl);
    onLogin(data.token, data.user);
  };

  const handle2FASubmit = async () => {
    if (!twoFactor) return;
    const code = twoFactorCode.trim();
    if (!code) {
      setError(t("auth.twoFactor.codeRequired"));
      return;
    }
    const url = twoFactor.baseUrl ? `${twoFactor.baseUrl}/api/auth/2fa/verify` : "/api/auth/2fa/verify";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: twoFactor.ticket, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // ticket 过期 → 退回登录页重新输密码
      if (data?.code === "TFA_TICKET_EXPIRED") {
        setTwoFactor(null);
        setError(t("auth.twoFactor.ticketExpired"));
        return;
      }
      setError(data?.error || t("auth.twoFactor.verifyFailed"));
      return;
    }
    localStorage.setItem("nowen-token", data.token);
    onLogin(data.token, data.user);
  };

  const handleRegisterSubmit = async () => {
    if (username.length < 3) {
      setError(t("auth.usernameInvalid"));
      return;
    }
    if (password.length < 6) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(t("auth.emailInvalid"));
      return;
    }

    const baseUrl = await resolveBaseUrl();
    if (baseUrl === null) return;

    try {
      const data = await registerAccount(
        {
          username: username.trim(),
          password,
          email: email.trim() || undefined,
          displayName: displayName.trim() || undefined,
        },
        baseUrl || undefined,
      );
      localStorage.setItem("nowen-token", data.token);
      onLogin(data.token, data.user);
    } catch (err: any) {
      setError(err.message || t("auth.registerFailed"));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");
    try {
      if (twoFactor) {
        await handle2FASubmit();
      } else if (mode === "login") {
        await handleLoginSubmit();
      } else {
        await handleRegisterSubmit();
      }
    } catch {
      setError(t("auth.networkError"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnect = () => {
    clearServerUrl();
    localStorage.removeItem("nowen-token");
    // 断开服务器 = 凭据不再有意义，一并清掉防止下次自动登录打到错误服务器
    void clearRememberedCredentials();
    setServerParts({ protocol: "http", host: "", port: "", path: "" });
    setServerStatus("idle");
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setEmail("");
    setDisplayName("");
    setError("");
    setRememberMe(false);
    setAutoLogin(false);
    onDisconnect?.();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setPassword("");
    setConfirmPassword("");
  };

  const serverStatusIcon = () => {
    switch (serverStatus) {
      case "checking":
        return <Loader2 className="w-4 h-4 animate-spin text-amber-500" />;
      case "ok":
        return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
      case "fail":
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      default:
        return null;
    }
  };

  const isRegister = mode === "register";
  const submitDisabled = twoFactor
    ? isLoading || !twoFactorCode.trim()
    : isLoading ||
      !username ||
      !password ||
      (isRegister && !confirmPassword) ||
      (isClientMode && !serverParts.host.trim());

  return (
    <div
      ref={scrollContainerRef}
      className="flex flex-col items-center bg-zinc-50 dark:bg-zinc-950 selection:bg-indigo-500/30 transition-colors overflow-y-auto overflow-x-hidden"
      style={{
        // 移动端软键盘处理（最终方案，踩坑历史见下）：
        //
        // 踩过的坑：
        //   1) Capacitor `Keyboard.resize: "none"`：原生层**不缩 WebView frame**,
        //      WebView 始终全屏。键盘绘制在 WebView 之上。
        //   2) 想用 `visualViewport.height` 推断键盘高度 —— 在部分 Android ROM
        //      上 visualViewport 完全不感知键盘，推不出真实高度。
        //   3) 致命错误（上一版 BUG）：把外层容器 maxHeight 设成 visualViewport.height,
        //      容器只占屏幕上方部分；容器下方到 WebView 底（即键盘所在区域）
        //      露出 body 背景 —— 浅色模式 body = var(--color-bg) ≈ 白色，于是用户
        //      看到"登录按钮下方一直到键盘顶端是一整片白色"（截图红框区域）。
        //   4) `useKeyboardLayout()` 默认只挂载在 AppLayout（登录后），登录页
        //      是 AuthGate 直接 return <LoginPage />，原生事件链没人注册，
        //      `--keyboard-height` 永远是 0 —— 这就是历史上多次"看似对了
        //      但键盘弹起没反应"的根本原因。**修复**：登录页内独立调一次
        //      `useKeyboardLayout()`，与 AppLayout 各自维护 listener，互不冲突。
        //   5) 全局 CSS `html, body, #root { overflow: hidden }` 禁止文档
        //      级滚动，**必须由 LoginPage 外层自己 overflow-y-auto** 作为
        //      滚动容器（所以这里必须保留 overflow-y-auto、挂 ref）。
        //   6) Android WebView focus 时不会自动 scrollIntoView —— 见上方
        //      useEffect，手动监听 focusin + 算 scrollTop 让 input 出现在
        //      可视区上 1/4 处（非居中），保证 input 下方的登录按钮可见。
        //   7) 前后 `flex-1 min-h-0` 占位实测在 iOS WKWebView 下会出现
        //      **上下不对称**（下方占位异常大、按钮被挤到键盘下方），改用
        //      卡片 `my-auto`：flex 规范下 auto margin 内容不足时吸收剩余
        //      空间实现居中，内容溢出时**坍缩为 0**，行为比 flex-1 更稳。
        //
        // 最终方案：
        //   a) 容器高 = 100dvh（动态视口高，撑满 WebView），bg 与卡片同色系，
        //      **永远不会露出 body 白底**。
        //   b) `paddingBottom: keyboardHeight + safe-area-bottom`：键盘弹起时
        //      原生事件回调写入精确像素，padding 把内容推到键盘上方；未弹起
        //      时 keyboardHeight=0，等价于普通 safe-area padding。
        //   c) flex-col + items-center + 卡片 auto-margin（**双态**）+ `flex-shrink-0`：
        //      - 键盘未弹起：卡片 `my-auto`，整页垂直居中；
        //      - 键盘已弹起：卡片 `mt-auto`（仅上方 auto），卡片**贴键盘上沿**，
        //        否则会被在"键盘上方可视区"里二次居中，导致卡片下方到键盘顶
        //        之间留出一大片白色（上一版症状）。
        //      - 内容 > 可用区时 auto margin 按 flex 规范坍缩为 0，overflow-y-auto
        //        滚动接管。
        //   d) focusin 触发手动 scrollTo，把 focused input 滚到上 1/4 处。
        minHeight: '100dvh',
        maxHeight: '100dvh',
        paddingTop: 'var(--safe-area-top)',
        paddingBottom: `calc(var(--safe-area-bottom) + ${keyboardHeight}px)`,
      }}
    >
      {/* 背景装饰 */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-indigo-500/5 via-transparent to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-purple-500/5 via-transparent to-transparent rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        // 居中策略（双态）：
        //   - 键盘**未**弹起：`my-auto` —— flex 容器把剩余空间均分到卡片
        //     上下，卡片整页垂直居中。
        //   - 键盘**已**弹起：`mt-auto`（去掉下方 auto margin）—— 上方撑满
        //     auto，下方 margin 为 0，卡片**贴近底部 padding**（即贴键盘
        //     上沿）。否则 `my-auto` 会让卡片在"容器减键盘高的可用区"中再
        //     次居中，结果是**卡片下方到键盘顶之间出现一大片白色空白**
        //     （上一版用户截图正是这个症状：按钮下方白茫茫一片）。
        //   - 内容 > 可用区时 auto margin 按 flex 规范坍缩为 0，overflow-y-auto
        //     滚动接管。比 flex-1 占位元素更可靠（实测占位方案在 iOS
        //     WKWebView 下会出现上下不对称）。
        className={`relative w-full max-w-[420px] mx-4 py-6 flex-shrink-0 ${keyboardHeight > 0 ? 'mt-auto' : 'my-auto'}`}
      >
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/20 p-8">
          {/* Logo & Title */}
          <div className="text-center mb-6">
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 mb-4"
            >
              <BookOpen size={24} className="text-indigo-600 dark:text-indigo-400" />
            </motion.div>
            <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100 tracking-tight">
              {t("auth.appTitle")}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">
              {isRegister
                ? t("auth.registerSubtitle")
                : isClientMode
                ? t("auth.subtitleClient")
                : t("auth.subtitle")}
            </p>
          </div>

          {/* 登录/注册 Tab（2FA 阶段时隐藏） */}
          {!twoFactor && (
          <div className="flex items-center gap-1 p-1 mb-5 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === "login"
                  ? "bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >
              {t("auth.loginTab")}
            </button>
            <button
              type="button"
              onClick={() => allowRegistration && switchMode("register")}
              disabled={!allowRegistration}
              title={!allowRegistration ? t("auth.registerDisabled") : undefined}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === "register"
                  ? "bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-sm"
                  : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
              }`}
            >
              {t("auth.registerTab")}
            </button>
          </div>
          )}

          {/* 体验环境提示卡片（仅 VITE_DEMO_MODE=true 构建时 + 登录模式 + 非 2FA 阶段显示）。
              一键填入只填用户名/密码到输入框，不会自动提交，让用户自己点登录按钮。 */}
          {DEMO_MODE && !isRegister && !twoFactor && (
            <div className="mb-4 p-3 rounded-xl border border-indigo-200/70 dark:border-indigo-500/30 bg-gradient-to-br from-indigo-50 to-purple-50/50 dark:from-indigo-500/10 dark:to-purple-500/5">
              <div className="flex items-start gap-2.5">
                <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0 text-indigo-600 dark:text-indigo-400" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-indigo-900 dark:text-indigo-200">
                    {t("auth.demoBanner.title")}
                  </p>
                  <p className="text-[11px] mt-0.5 text-indigo-700/80 dark:text-indigo-300/80 leading-relaxed">
                    {t("auth.demoBanner.desc", { username: DEMO_USERNAME, password: DEMO_PASSWORD })}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setUsername(DEMO_USERNAME);
                      setPassword(DEMO_PASSWORD);
                      setError("");
                    }}
                    className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400 text-white transition-colors"
                  >
                    {t("auth.demoBanner.fillButton")}
                  </button>
                </div>
              </div>
            </div>
          )}

          <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
            {/* Phase 6: 2FA 面板（取代登录表单） */}
            {twoFactor ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/20">
                  <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
                  <p className="text-xs text-indigo-700 dark:text-indigo-300">
                    {t("auth.twoFactor.prompt", { username: twoFactor.username })}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {t("auth.twoFactor.codeLabel")}
                  </label>
                  <input
                    type="text"
                    value={twoFactorCode}
                    onChange={(e) => setTwoFactorCode(e.target.value)}
                    className="block w-full px-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm tracking-[0.3em] font-mono text-center"
                    placeholder="123456"
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={20}
                  />
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">
                    {t("auth.twoFactor.codeHint")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setTwoFactor(null);
                    setTwoFactorCode("");
                    setError("");
                  }}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
                >
                  {t("auth.twoFactor.backToLogin")}
                </button>
              </div>
            ) : (<>
            {/* 服务器地址 — 仅客户端模式显示（协议 + 主机 + 端口 三段式） */}
            <AnimatePresence>
              {isClientMode && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-1.5 overflow-hidden"
                >
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {t("auth.serverAddress")}
                  </label>
                  <ServerAddressInput
                    value={serverParts}
                    onChange={(next) => {
                      setServerParts(next);
                      if (serverStatus !== "idle") setServerStatus("idle");
                    }}
                    onHostBlur={handleServerBlur}
                    autoFocus={isClientMode}
                    accent="indigo"
                    rightSlot={serverStatusIcon()}
                  />
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">
                    {t("auth.serverHint")}
                  </p>
                  {/* 桌面端：局域网 mDNS 自动发现。非 Electron 环境组件会自动隐身。 */}
                  <LanDiscoveryPanel
                    currentHostIsEmpty={!serverParts.host.trim()}
                    onSelect={(next) => {
                      setServerParts(next);
                      setServerStatus("idle");
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* 用户名 */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t("auth.username")}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                </div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
                  placeholder={isRegister ? t("auth.usernameRegisterPlaceholder") : t("auth.usernamePlaceholder")}
                  autoComplete="username"
                  autoFocus={!isClientMode}
                  required
                />
              </div>
            </div>

            {/* 注册时：邮箱 + 昵称 */}
            <AnimatePresence>
              {isRegister && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-4 overflow-hidden"
                >
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {t("auth.displayNameOptional")}
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <UserPlus className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                      </div>
                      <input
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                        placeholder={t("auth.displayNamePlaceholder")}
                        maxLength={40}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {t("auth.emailOptional")}
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Mail className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                      </div>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                        placeholder="name@example.com"
                        autoComplete="email"
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 密码 */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t("auth.password")}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-10 pr-10 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
                  placeholder="••••••••"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? t("auth.hidePassword", { defaultValue: "隐藏密码" }) : t("auth.showPassword", { defaultValue: "显示密码" })}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* 注册确认密码 */}
            <AnimatePresence>
              {isRegister && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-1.5 overflow-hidden"
                >
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {t("auth.confirmPassword")}
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Lock className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                    </div>
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={`block w-full pl-10 pr-10 py-2.5 border rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 text-sm ${
                        confirmPassword && password !== confirmPassword
                          ? "border-red-500/60 dark:border-red-500/60"
                          : "border-zinc-200 dark:border-zinc-700"
                      }`}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      tabIndex={-1}
                      aria-label={showConfirmPassword ? t("auth.hidePassword", { defaultValue: "隐藏密码" }) : t("auth.showPassword", { defaultValue: "显示密码" })}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 记住密码 / 自动登录（仅登录模式 + 支持落盘加密的平台显示） */}
            {!isRegister && canSavePassword && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-zinc-600 dark:text-zinc-400">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setRememberMe(checked);
                      // 关掉记住密码时顺带关自动登录
                      if (!checked) setAutoLogin(false);
                    }}
                    className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-600 focus:ring-indigo-500/40"
                  />
                  {t("auth.rememberMe")}
                </label>
                <label className={`flex items-center gap-2 select-none text-xs ${rememberMe ? "cursor-pointer text-zinc-600 dark:text-zinc-400" : "cursor-not-allowed text-zinc-400 dark:text-zinc-600"}`}>
                  <input
                    type="checkbox"
                    checked={autoLogin}
                    disabled={!rememberMe}
                    onChange={(e) => setAutoLogin(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-600 focus:ring-indigo-500/40 disabled:opacity-50"
                  />
                  {t("auth.autoLogin")}
                </label>
              </div>
            )}
            </>)}

            {/* 错误提示 */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 提交按钮 */}
            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full flex items-center justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
            >
              {isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : twoFactor ? (
                t("auth.twoFactor.verifyButton")
              ) : isRegister ? (
                t("auth.registerButton")
              ) : (
                t("auth.loginButton")
              )}
            </button>
          </form>

          {/* 底部提示 */}
          <p className="text-center text-xs text-zinc-400 dark:text-zinc-600 mt-6">
            {isRegister ? t("auth.registerHint") : (hasUsers ? null : t("auth.defaultCredentials"))}
          </p>

          {!allowRegistration && !isRegister && (
            <p className="text-center text-[11px] text-zinc-400 dark:text-zinc-600 mt-1.5">
              {t("auth.registerClosed")}
            </p>
          )}

          {/* 客户端模式：断开连接按钮 */}
          {isClientMode && getServerUrl() && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={handleDisconnect}
                className="text-xs text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 transition-colors"
              >
                {t("auth.resetServer")}
              </button>
            </div>
          )}

          {/*
            D-1：桌面端"返回本地（零登录）"入口。
            条件：当前已写过 nowen-prefer-cloud（说明用户是从 NavRail 主动切到云端模式来的）。
            点击后清掉标记 + token + reload，App.tsx 重新走 ensureLocalAccount 流程。
            注意：不清理 IndexedDB / 本地 SQLite 数据，本地笔记本依然完整保留。
          */}
          {(() => {
            const isElectron = !!(window as any).nowenDesktop?.isDesktop;
            const preferCloud = (() => {
              try { return localStorage.getItem("nowen-prefer-cloud") === "1"; } catch { return false; }
            })();
            if (!isElectron || !preferCloud) return null;
            return (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    try {
                      localStorage.removeItem("nowen-prefer-cloud");
                      localStorage.removeItem("nowen-token");
                      clearServerUrl();
                    } catch { /* ignore */ }
                    window.location.reload();
                  }}
                  className="text-xs text-zinc-400 hover:text-blue-500 dark:text-zinc-500 dark:hover:text-blue-400 transition-colors"
                >
                  {t("auth.backToLocal", "← 返回本地模式（不登录直接使用）")}
                </button>
              </div>
            );
          })()}
        </div>

        {isClientMode && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-center text-[11px] text-zinc-400 dark:text-zinc-600 mt-4 px-4"
          >
            {t("auth.clientNote")}
          </motion.p>
        )}
      </motion.div>
    </div>
  );
}
