import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Lock, User, BookOpen, CheckCircle2, AlertCircle, Mail, UserPlus, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getServerUrl, setServerUrl, clearServerUrl, testServerConnection, fetchRegisterConfig, registerAccount } from "@/lib/api";
import { buildServerUrl, parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";
import ServerAddressInput from "@/components/ServerAddressInput";
import LanDiscoveryPanel from "@/components/LanDiscoveryPanel";

interface LoginPageProps {
  onLogin: (token: string, user: any) => void;
  /** 是否为客户端模式（Electron / Android / 曾配置过服务器地址） */
  isClientMode?: boolean;
  onDisconnect?: () => void;
}

type Mode = "login" | "register";

export default function LoginPage({ onLogin, isClientMode = false, onDisconnect }: LoginPageProps) {
  const [mode, setMode] = useState<Mode>("login");
  // 服务器地址拆成 (protocol, host, port) 三段，避免用户手填整串 URL 出错；
  // 旧数据 localStorage 里是完整 URL，下方 useEffect 里用 parseServerUrl 回填
  const [serverParts, setServerParts] = useState<ServerAddressParts>({
    protocol: "http",
    host: "",
    port: "",
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [serverStatus, setServerStatus] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true);
  // Phase 6: 2FA 两阶段登录 state —— 第一步（密码）成功后若后端返回 requires2FA,
  // 就暂存 ticket + 当前 baseUrl，切到 2FA 面板让用户输入 6 位动态码或恢复码。
  const [twoFactor, setTwoFactor] = useState<{
    ticket: string;
    username: string;
    baseUrl: string; // 用于 2fa/verify 的 origin，保持与登录阶段一致
  } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
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
    });
    return () => {
      cancelled = true;
    };
  }, [isClientMode, serverStatus]);

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

  const handleLoginSubmit = async () => {
    const baseUrl = await resolveBaseUrl();
    if (baseUrl === null) return;

    const loginUrl = baseUrl ? `${baseUrl}/api/auth/login` : "/api/auth/login";
    const res = await fetch(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || t("auth.loginFailed"));
      return;
    }
    // Phase 6: 2FA 两阶段 —— 后端返回 requires2FA 时，跳转到 2FA 面板
    //   ticket 只有 5 分钟有效期，仅能用于 /auth/2fa/verify；前端不把它写进 localStorage
    //   以减少 XSS 暴露面，切到 2FA 面板后保存在组件 state 里即可。
    if (data.requires2FA && data.ticket) {
      setTwoFactor({ ticket: data.ticket, username: data.username || username, baseUrl });
      setPassword(""); // 清掉内存里的密码
      setTwoFactorCode("");
      return;
    }
    localStorage.setItem("nowen-token", data.token);
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
    setServerParts({ protocol: "http", host: "", port: "" });
    setServerStatus("idle");
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setEmail("");
    setDisplayName("");
    setError("");
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
      className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 selection:bg-indigo-500/30 transition-colors"
      style={{
        // 刘海屏 / Android 状态栏避让，保证登录卡片不会被状态栏/手势条遮挡
        paddingTop: 'var(--safe-area-top)',
        paddingBottom: 'var(--safe-area-bottom)',
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
        className="relative w-full max-w-[420px] mx-4"
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

          <form onSubmit={handleSubmit} className="space-y-4">
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
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
                  placeholder="••••••••"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  required
                />
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
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={`block w-full pl-10 pr-3 py-2.5 border rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 text-sm ${
                        confirmPassword && password !== confirmPassword
                          ? "border-red-500/60 dark:border-red-500/60"
                          : "border-zinc-200 dark:border-zinc-700"
                      }`}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      required
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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
            {isRegister ? t("auth.registerHint") : t("auth.defaultCredentials")}
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
