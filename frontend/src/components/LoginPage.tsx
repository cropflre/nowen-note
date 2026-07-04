import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, BookOpen, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  clearServerUrl,
  fetchRegisterConfig,
  getServerUrl,
  registerAccount,
  setServerUrl,
  testServerConnection,
} from "@/lib/api";
import { buildServerUrl, parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";
import ServerAddressInput from "@/components/ServerAddressInput";
import LanDiscoveryPanel from "@/components/LanDiscoveryPanel";
import { useKeyboardLayout } from "@/hooks/useCapacitor";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";
import { useSiteSettings } from "@/hooks/useSiteSettings";

interface LoginPageProps {
  onLogin: (token: string, user: any) => void;
  /** 是否为客户端模式（Electron / Android / 曾配置过服务器地址） */
  isClientMode?: boolean;
  onDisconnect?: () => void;
}

type Mode = "login" | "register";
type LoginStep = "password" | "twoFactor";

function isMobileNativeClientRuntime(): boolean {
  try {
    const w = window as any;
    return !!w.Capacitor?.isNativePlatform?.()
      || (!!w.Capacitor?.platform && w.Capacitor.platform !== "web");
  } catch {
    return false;
  }
}

export default function LoginPage({ onLogin, isClientMode = false, onDisconnect }: LoginPageProps) {
  const { t } = useTranslation();
  const { siteConfig } = useSiteSettings();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useKeyboardLayout();
  const { height: keyboardHeight } = useKeyboardVisible();

  const [mode, setMode] = useState<Mode>("login");
  const [loginStep, setLoginStep] = useState<LoginStep>("password");
  const [serverParts, setServerParts] = useState<ServerAddressParts>({
    protocol: "http",
    host: "",
    port: "",
    path: "",
  });
  const [serverStatus, setServerStatus] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [twoFactorTicket, setTwoFactorTicket] = useState("");
  const [twoFactorUsername, setTwoFactorUsername] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);
  const [hasUsers, setHasUsers] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const icpBeianText = siteConfig.icpBeian?.trim() || "";
  const showIcpBeian = !!icpBeianText && !isMobileNativeClientRuntime();
  const isRegister = mode === "register";
  const isTwoFactorStep = loginStep === "twoFactor";

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
    }
  }, [isClientMode]);

  useEffect(() => {
    let cancelled = false;
    const baseUrl = isClientMode ? (getServerUrl() || "") : "";
    fetchRegisterConfig(baseUrl || undefined).then((cfg) => {
      if (cancelled) return;
      setAllowRegistration(cfg.allowRegistration);
      setHasUsers(!!(cfg as any).hasUsers || Number((cfg as any).userCount || 0) > 0);
    }).catch(() => {
      if (!cancelled) setAllowRegistration(true);
    });
    return () => { cancelled = true; };
  }, [isClientMode, serverStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scrollFocusedIntoView = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const container = scrollContainerRef.current;
        const el = document.activeElement as HTMLElement | null;
        if (!container || !el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const offsetTop = elRect.top - containerRect.top + container.scrollTop;
        const target = offsetTop - container.clientHeight * 0.25;
        const maxScroll = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top: Math.max(0, Math.min(target, maxScroll)), behavior: "smooth" });
      }, 80);
    };
    document.addEventListener("focusin", scrollFocusedIntoView);
    window.visualViewport?.addEventListener("resize", scrollFocusedIntoView);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("focusin", scrollFocusedIntoView);
      window.visualViewport?.removeEventListener("resize", scrollFocusedIntoView);
    };
  }, []);

  const submitDisabled = useMemo(() => {
    if (isLoading) return true;
    if (isTwoFactorStep) return false;
    if (!username.trim() || !password) return true;
    if (isClientMode && !serverParts.host.trim()) return true;
    if (isRegister && !confirmPassword) return true;
    return false;
  }, [confirmPassword, isClientMode, isLoading, isRegister, isTwoFactorStep, password, serverParts.host, username]);

  const serverStatusIcon = () => {
    if (serverStatus === "checking") return <Loader2 className="w-4 h-4 animate-spin text-amber-500" />;
    if (serverStatus === "ok") return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
    if (serverStatus === "fail") return <AlertCircle className="w-4 h-4 text-red-500" />;
    return null;
  };

  const handleServerBlur = async () => {
    if (!isClientMode) return;
    const url = buildServerUrl(serverParts);
    if (!url) return;
    setServerStatus("checking");
    const result = await testServerConnection(url);
    setServerStatus(result.ok ? "ok" : "fail");
    if (result.ok) {
      setServerUrl(url);
      localStorage.setItem("nowen-server-url-last", url);
      fetchRegisterConfig(url).then((cfg) => setAllowRegistration(cfg.allowRegistration)).catch(() => {});
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
    const result = await testServerConnection(url);
    if (!result.ok) {
      setServerStatus("fail");
      setError(result.error || t("server.connectFailed"));
      return null;
    }
    setServerStatus("ok");
    setServerUrl(url);
    localStorage.setItem("nowen-server-url-last", url);
    return url;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    let loginUrl = "";
    try {
      const baseUrl = await resolveBaseUrl();
      if (baseUrl === null) return;

      if (isRegister) {
        if (username.trim().length < 3) {
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
        const data = await registerAccount({
          username: username.trim(),
          password,
          email: email.trim() || undefined,
          displayName: displayName.trim() || undefined,
        }, baseUrl || undefined);
        localStorage.setItem("nowen-token", data.token);
        onLogin(data.token, data.user);
        return;
      }

      loginUrl = baseUrl ? `${baseUrl}/api/auth/login` : "/api/auth/login";
      const { getDeviceId } = await import("@/lib/deviceId");
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, deviceId: getDeviceId() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t("auth.loginFailed"));
        return;
      }

      if (data.requires2FA && data.ticket) {
        setTwoFactorTicket(data.ticket);
        setTwoFactorUsername(data.username || username.trim());
        setTwoFactorCode("");
        setLoginStep("twoFactor");
        setError("");
        return;
      }

      if (!data.token || !data.user) {
        setError(t("auth.loginFailed"));
        return;
      }

      localStorage.setItem("nowen-token", data.token);
      onLogin(data.token, data.user);
    } catch (err: any) {
      const message = err?.message || String(err || t("auth.networkError"));
      console.error("[login] request failed", { url: loginUrl || "(resolveBaseUrl)", error: message });
      setError(`${message}（请检查服务器地址、CORS/CSP、证书或 /api 反代）`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactorTicket) {
      setLoginStep("password");
      setError(t("auth.twoFactor.ticketExpired"));
      return;
    }
    if (!twoFactorCode.trim()) {
      setError(t("auth.twoFactor.codeRequired"));
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const baseUrl = isClientMode ? buildServerUrl(serverParts) : "";
      const verifyUrl = baseUrl
        ? `${baseUrl}/api/auth/2fa/verify`
        : "/api/auth/2fa/verify";
      const { getDeviceId } = await import("@/lib/deviceId");
      const res = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: twoFactorTicket,
          code: twoFactorCode.trim(),
          deviceId: getDeviceId(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "TFA_TICKET_EXPIRED") {
          setLoginStep("password");
          setTwoFactorTicket("");
          setTwoFactorCode("");
          setError(t("auth.twoFactor.ticketExpired"));
          return;
        }
        if (data.code === "TFA_INVALID_CODE") {
          setError(t("auth.twoFactor.verifyFailed"));
          return;
        }
        setError(data.error || t("auth.twoFactor.verifyFailed"));
        return;
      }

      if (!data.token || !data.user) {
        setError(t("auth.twoFactor.verifyFailed"));
        return;
      }

      localStorage.setItem("nowen-token", data.token);
      onLogin(data.token, data.user);
    } catch (err: any) {
      setError(err?.message || t("auth.networkError"));
    } finally {
      setIsLoading(false);
    }
  };

  const backToPasswordLogin = () => {
    setLoginStep("password");
    setTwoFactorTicket("");
    setTwoFactorCode("");
    setError("");
  };

  const handleDisconnect = () => {
    clearServerUrl();
    localStorage.removeItem("nowen-token");
    setServerParts({ protocol: "http", host: "", port: "", path: "" });
    setServerStatus("idle");
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setEmail("");
    setDisplayName("");
    setLoginStep("password");
    setTwoFactorTicket("");
    setTwoFactorUsername("");
    setTwoFactorCode("");
    setError("");
    onDisconnect?.();
  };

  const switchMode = (next: Mode) => {
    if (next === "register" && !allowRegistration) return;
    setMode(next);
    setError("");
    setPassword("");
    setConfirmPassword("");
    setLoginStep("password");
    setTwoFactorTicket("");
    setTwoFactorUsername("");
    setTwoFactorCode("");
  };

  return (
    <div
      ref={scrollContainerRef}
      className="flex flex-col items-center bg-zinc-50 dark:bg-zinc-950 selection:bg-indigo-500/30 transition-colors overflow-y-auto overflow-x-hidden"
      style={{
        minHeight: "100dvh",
        maxHeight: "100dvh",
        paddingTop: "var(--safe-area-top)",
        paddingBottom: `calc(var(--safe-area-bottom) + ${keyboardHeight}px)`,
      }}
    >
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-indigo-500/5 via-transparent to-transparent rounded-full blur-3xl" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-purple-500/5 via-transparent to-transparent rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
        className={`relative w-full max-w-[420px] mx-4 py-6 flex-shrink-0 ${keyboardHeight > 0 ? "mt-auto" : "my-auto"}`}
      >
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/20 p-8">
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
              {isTwoFactorStep ? t("auth.twoFactor.title") : siteConfig.title || t("auth.appTitle")}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">
              {isTwoFactorStep
                ? t("auth.twoFactor.prompt", { username: twoFactorUsername || username.trim() })
                : isRegister ? t("auth.registerSubtitle") : isClientMode ? t("auth.subtitleClient") : t("auth.subtitle")}
            </p>
          </div>

          {!isTwoFactorStep && (
          <div className="flex items-center gap-1 p-1 mb-5 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${mode === "login" ? "bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-sm" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
            >
              {t("auth.loginTab")}
            </button>
            <button
              type="button"
              onClick={() => switchMode("register")}
              disabled={!allowRegistration}
              title={!allowRegistration ? t("auth.registerDisabled") : undefined}
              className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${mode === "register" ? "bg-white dark:bg-zinc-700 text-indigo-600 dark:text-indigo-400 shadow-sm" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"}`}
            >
              {t("auth.registerTab")}
            </button>
          </div>
          )}

          <form ref={formRef} onSubmit={isTwoFactorStep ? handleTwoFactorSubmit : handleSubmit} className="space-y-4">
            {isTwoFactorStep ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.twoFactor.codeLabel")}</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                    <input
                      type="text"
                      value={twoFactorCode}
                      onChange={(e) => setTwoFactorCode(e.target.value)}
                      className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                      placeholder="123456 / xxxxx-xxxxx"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      autoFocus
                    />
                  </div>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("auth.twoFactor.codeHint")}</p>
                </div>

                <AnimatePresence>
                  {error && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                      <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  type="submit"
                  disabled={submitDisabled}
                  className="w-full flex items-center justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t("auth.twoFactor.verifyButton")}
                </button>

                <button
                  type="button"
                  onClick={backToPasswordLogin}
                  className="w-full text-xs text-zinc-500 hover:text-indigo-600 dark:text-zinc-400 dark:hover:text-indigo-400 transition-colors"
                >
                  {t("auth.twoFactor.backToLogin")}
                </button>
              </>
            ) : (
            <>
            <AnimatePresence>
              {isClientMode && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-1.5 overflow-hidden">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.serverAddress")}</label>
                  <ServerAddressInput
                    value={serverParts}
                    onChange={(next) => { setServerParts(next); if (serverStatus !== "idle") setServerStatus("idle"); }}
                    onHostBlur={handleServerBlur}
                    autoFocus={isClientMode}
                    accent="indigo"
                    rightSlot={serverStatusIcon()}
                  />
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("auth.serverHint")}</p>
                  <LanDiscoveryPanel
                    currentHostIsEmpty={!serverParts.host.trim()}
                    onSelect={(next) => { setServerParts(next); setServerStatus("idle"); }}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.username")}</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                  placeholder="admin"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <AnimatePresence>
              {isRegister && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-4 overflow-hidden">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.emailOptional")}</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                        placeholder="you@example.com"
                        autoComplete="email"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.displayNameOptional")}</label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="block w-full px-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                      placeholder={t("auth.displayNamePlaceholder")}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.password")}</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-10 pr-10 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                  placeholder="••••••••"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  required
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} tabIndex={-1} className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {isRegister && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-1.5 overflow-hidden">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("auth.confirmPassword")}</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="block w-full pl-10 pr-10 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 text-sm"
                      placeholder="••••••••"
                      autoComplete="new-password"
                      required
                    />
                    <button type="button" onClick={() => setShowConfirmPassword((v) => !v)} tabIndex={-1} className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors">
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {error && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full flex items-center justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : isRegister ? t("auth.registerButton") : t("auth.loginButton")}
            </button>
            </>
            )}
          </form>

          {!isTwoFactorStep && <p className="text-center text-xs text-zinc-400 dark:text-zinc-600 mt-6">
            {isRegister ? t("auth.registerHint") : (hasUsers ? null : t("auth.defaultCredentials"))}
          </p>}

          {!isTwoFactorStep && !allowRegistration && !isRegister && (
            <p className="text-center text-[11px] text-zinc-400 dark:text-zinc-600 mt-1.5">{t("auth.registerClosed")}</p>
          )}

          {!isTwoFactorStep && isClientMode && getServerUrl() && (
            <div className="mt-3 flex justify-center">
              <button type="button" onClick={handleDisconnect} className="text-xs text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400 transition-colors">
                {t("auth.resetServer")}
              </button>
            </div>
          )}
        </div>

        {isClientMode && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="text-center text-[11px] text-zinc-400 dark:text-zinc-600 mt-4 px-4">
            {t("auth.clientNote")}
          </motion.p>
        )}

        {showIcpBeian && (
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-4 text-center text-[11px] text-zinc-400 dark:text-zinc-600 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
          >
            {icpBeianText}
          </a>
        )}
      </motion.div>
    </div>
  );
}
