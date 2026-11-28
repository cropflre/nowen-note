import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, Eye, EyeOff, Info, Loader2, Lock, Mail, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  clearServerUrl,
  discoverNowenApiPath,
  fetchRegisterConfig,
  getServerUrl,
  registerAccount,
  resolveWebSocketPathAfterLogin,
  setServerUrl,
} from "@/lib/api";
import { buildServerUrl, getResolvedApiBaseUrl, parseServerUrl, type ServerAddressParts } from "@/lib/serverUrl";
import { fetchLoginRequest, LOGIN_ATTEMPT_TIMEOUT_MS, submitPasswordLogin } from "@/lib/loginRequest";
import ServerAddressInput from "@/components/ServerAddressInput";
import { useKeyboardLayout } from "@/hooks/useCapacitor";
import { useKeyboardVisible } from "@/hooks/useKeyboardVisible";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { AccountLoginHistoryList } from "@/components/AccountLoginHistory";
import { consumePendingAccountReauth, type AccountLoginHistoryItem } from "@/lib/accountLoginHistory";
import {
  canPersistPassword,
  loadRememberedCredentials,
  saveRememberedCredentials,
} from "@/lib/rememberLogin";
import type { User as AuthUser } from "@/types";
import { isUgreenRemoteAccessUrl, openUgreenRemoteWorkspace } from "@/lib/ugreenRemoteAccess";
import { clearAuthTokens, storeAuthTokens } from "@/lib/authSession";
import {
  completeDesktopLocalLoginHint,
  getDesktopLocalLoginHint,
  type DesktopLocalLoginHint,
} from "@/lib/desktopBridge";

interface LoginPageProps {
  onLogin: (token: string, user: any) => void;
  onAccountLogin?: (token: string, user: AuthUser) => void;
  /** 是否为客户端模式（Electron / Android） */
  isClientMode?: boolean;
  onDisconnect?: () => void;
  /** Android 账号登录页返回设备本地模式。 */
  onContinueLocal?: () => void;
}

type Mode = "login" | "register";
type LoginStep = "password" | "twoFactor";
/** 失败提示旁的唯一操作：连接故障重试，或打开原地址完成代理网关验证。 */
type FailureAction = "retry" | "openWeb";

function isMobileNativeClientRuntime(): boolean {
  try {
    const w = window as any;
    return !!w.Capacitor?.isNativePlatform?.()
      || (!!w.Capacitor?.platform && w.Capacitor.platform !== "web");
  } catch {
    return false;
  }
}

export default function LoginPage({ onLogin, onAccountLogin, isClientMode = false, onDisconnect, onContinueLocal }: LoginPageProps) {
  const { t } = useTranslation();
  const { siteConfig } = useSiteSettings();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const serverProbeEpochRef = useRef(0);
  const submitInFlightRef = useRef(false);

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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [twoFactorTicket, setTwoFactorTicket] = useState("");
  const [twoFactorUsername, setTwoFactorUsername] = useState("");
  const [twoFactorBaseUrl, setTwoFactorBaseUrl] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(true);
  const [hasUsers, setHasUsers] = useState(false);
  const [canSavePassword, setCanSavePassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(isClientMode);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthorizingUgreen, setIsAuthorizingUgreen] = useState(false);
  const [failure, setFailure] = useState<{ message: string; action?: FailureAction } | null>(null);
  const error = failure?.message ?? "";
  const setError = useCallback((message: string, action?: FailureAction) => {
    setFailure(message ? { message, action } : null);
  }, []);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [registerConfigRefresh, setRegisterConfigRefresh] = useState(0);
  const [localLoginHint, setLocalLoginHint] = useState<DesktopLocalLoginHint | null>(null);
  const pendingReauthRef = useRef<{ serverUrl: string; username: string } | null>(null);
  const pendingUgreenLoginRef = useRef(false);

  const icpBeianText = siteConfig.icpBeian?.trim() || "";
  const showIcpBeian = !!icpBeianText && !isMobileNativeClientRuntime();
  const isRegister = mode === "register";
  const isTwoFactorStep = loginStep === "twoFactor";
  const isDesktopClient = !!(window as any).nowenDesktop?.isDesktop;
  const isNativeMobileClient = isMobileNativeClientRuntime() && !isDesktopClient;
  const isMobileUgreenAddress = isNativeMobileClient && isUgreenRemoteAccessUrl(buildServerUrl(serverParts));

  useEffect(() => {
    if (!isClientMode || !isDesktopClient) return;
    let cancelled = false;
    void getDesktopLocalLoginHint().then((hint) => {
      if (!cancelled) setLocalLoginHint(hint);
    }).catch(() => {
      if (!cancelled) setLocalLoginHint(null);
    });
    return () => { cancelled = true; };
  }, [isClientMode, isDesktopClient]);

  useEffect(() => {
    const desktop = (window as any).nowenDesktop;
    if (!desktop?.isDesktop || typeof desktop.on !== "function") return;

    const stopReady = desktop.on("ugreen:gateway-ready", (payload: unknown) => {
      const ready = payload as { serverUrl?: unknown };
      if (!pendingUgreenLoginRef.current) return;
      if (typeof ready.serverUrl !== "string" || !isUgreenRemoteAccessUrl(ready.serverUrl)) return;

      pendingUgreenLoginRef.current = false;
      setIsAuthorizingUgreen(false);
      setServerUrl(ready.serverUrl);
      localStorage.setItem("nowen-server-url-last", ready.serverUrl);
      setError("");
      window.setTimeout(() => formRef.current?.requestSubmit(), 0);
    });
    const stopCancelled = desktop.on("ugreen:auth-cancelled", () => {
      if (!pendingUgreenLoginRef.current) return;
      pendingUgreenLoginRef.current = false;
      setIsAuthorizingUgreen(false);
      setError(t("auth.ugreenAccess.cancelled"));
    });
    return () => {
      stopReady?.();
      stopCancelled?.();
    };
  }, [setError, t]);

  const handleHistoryReauth = (account: AccountLoginHistoryItem, message?: string) => {
    pendingReauthRef.current = { serverUrl: account.serverUrl, username: account.username };
    setServerParts(parseServerUrl(account.serverUrl));
    setServerUrl(account.serverUrl);
    setRegisterConfigRefresh((n) => n + 1);
    setUsername(account.username);
    setPassword("");
    setMode("login");
    setLoginStep("password");
    setError(message || t("auth.loginHistory.sessionExpired"));

    // 仅回填与所选历史账号完全匹配的安全存储密码，绝不把其它账号密码带过来。
    void loadRememberedCredentials().then((saved) => {
      const sameServer = saved?.serverUrl.replace(/\/+$/, "").toLowerCase()
        === account.serverUrl.replace(/\/+$/, "").toLowerCase();
      if (!saved?.hasPassword || !saved.password || !sameServer || saved.username !== account.username) return;
      setPassword(saved.password);
      setRememberMe(true);
    }).catch(() => {});
  };

  useEffect(() => {
    if (!isClientMode) return;
    const saved = getServerUrl() || localStorage.getItem("nowen-server-url-last") || "";
    if (saved) {
      setServerParts(parseServerUrl(saved));
      setRegisterConfigRefresh((n) => n + 1);
      return;
    }
    const isElectron = !!(window as any).nowenDesktop?.isDesktop;
    if (isElectron && window.location.origin.startsWith("http")) {
      setServerParts(parseServerUrl(window.location.origin));
    }
  }, [isClientMode]);

  useEffect(() => {
    if (!isClientMode) return;
    const pending = consumePendingAccountReauth();
    if (!pending) return;
    pendingReauthRef.current = pending;
    setServerParts(parseServerUrl(pending.serverUrl));
    setServerUrl(pending.serverUrl);
    setRegisterConfigRefresh((n) => n + 1);
    setUsername(pending.username);
    setMode("login");
    setError(t("auth.loginHistory.sessionExpired"));
  }, [isClientMode, setError, t]);

  useEffect(() => {
    if (!isClientMode) return;
    let cancelled = false;
    const serverEpochAtLoad = serverProbeEpochRef.current;
    void Promise.all([canPersistPassword(), loadRememberedCredentials()]).then(([supported, saved]) => {
      if (cancelled) return;
      setCanSavePassword(supported);
      if (!supported) {
        setRememberMe(false);
        return;
      }

      // 账号历史要求重登时，只允许同一服务器、同一用户名的密码回填，
      // 避免异步读取安全存储后覆盖用户刚刚选择的账号。
      const pending = pendingReauthRef.current;
      const matchesPending = !pending || (
        saved?.serverUrl.replace(/\/+$/, "").toLowerCase() === pending.serverUrl.replace(/\/+$/, "").toLowerCase()
        && saved?.username === pending.username
      );
      if (!saved || !matchesPending || serverEpochAtLoad !== serverProbeEpochRef.current) {
        // A user has started entering a different server while secure storage was loading.
        // Never silently replace their current address and associated credentials.
        setRememberMe(true);
        return;
      }

      if (saved.serverUrl) {
        setServerParts(parseServerUrl(saved.serverUrl));
        setServerUrl(saved.serverUrl);
        setRegisterConfigRefresh((n) => n + 1);
      }
      if (saved.username) setUsername(saved.username);
      if (saved.password) setPassword(saved.password);
      setRememberMe(saved.hasPassword);
    }).catch(() => {
      if (!cancelled) setRememberMe(false);
    });
    return () => { cancelled = true; };
  }, [isClientMode]);

  useEffect(() => {
    let cancelled = false;
    const baseUrl = isClientMode ? (getServerUrl() || "") : "";
    fetchRegisterConfig(baseUrl || undefined).then((cfg) => {
      if (cancelled) return;
      setAllowRegistration(cfg.allowRegistration);
      setHasUsers(!!(cfg as any).hasUsers || Number((cfg as any).userCount || 0) > 0);
      setServiceUnavailable(false);
    }).catch(() => {
      if (!cancelled) {
        setAllowRegistration(true);
        if (!isClientMode) setServiceUnavailable(true);
      }
    });
    return () => { cancelled = true; };
  }, [isClientMode, registerConfigRefresh]);

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
    if (isLoading || isAuthorizingUgreen) return true;
    if (isTwoFactorStep) return false;
    // 绿联远程域名需要先在绿联网关页面完成认证；本地表单账号不会提交给网关。
    if (!isRegister && isMobileUgreenAddress) return false;
    if (!username.trim() || !password) return true;
    if (isRegister && !confirmPassword) return true;
    return false;
  }, [confirmPassword, isAuthorizingUgreen, isLoading, isMobileUgreenAddress, isRegister, isTwoFactorStep, password, username]);

  // 失焦只读取该服务器的注册开关，不做连接探测；提交登录不等待它。
  const handleServerBlur = (resolved: ServerAddressParts) => {
    if (!isClientMode) return;
    const url = buildServerUrl(resolved);
    if (!url || (isNativeMobileClient && isUgreenRemoteAccessUrl(url))) return;
    const epoch = ++serverProbeEpochRef.current;
    fetchRegisterConfig(url).then((cfg) => {
      if (epoch !== serverProbeEpochRef.current) return;
      const info = cfg as { allowRegistration: boolean; hasUsers?: boolean; userCount?: number };
      setAllowRegistration(info.allowRegistration);
      setHasUsers(!!info.hasUsers || Number(info.userCount || 0) > 0);
    }).catch(() => {});
  };

  const commitServerUrl = (url: string) => {
    if (!isClientMode || !url) return;
    setServerUrl(url);
    localStorage.setItem("nowen-server-url-last", url);
  };

  const retryAfterFailure = () => {
    setError("");
    setServiceUnavailable(false);
    setRegisterConfigRefresh((n) => n + 1);
    if (!submitDisabled) formRef.current?.requestSubmit();
  };

  const openServerInBrowser = async () => {
    const url = isClientMode ? buildServerUrl(serverParts) : (getServerUrl() || window.location.origin);
    if (!url) return;
    try {
      if (isNativeMobileClient) {
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url });
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (openError) {
      console.warn("[login] failed to open server address", openError instanceof Error ? openError.name : "unknown");
    }
  };

  const beginUgreenAuthorization = async (url: string) => {
    if (pendingUgreenLoginRef.current) return;
    pendingUgreenLoginRef.current = true;
    setIsAuthorizingUgreen(true);
    setError("");
    try {
      await openUgreenRemoteWorkspace(url);
      // Android/iOS 使用系统安全浏览器打开远程工作台，不会收到 Electron 网关事件。
      // Browser.open 返回后立即释放本地等待态，避免回到 App 时按钮永久转圈。
      if (isNativeMobileClient) {
        pendingUgreenLoginRef.current = false;
        setIsAuthorizingUgreen(false);
      }
    } catch (openError) {
      console.error("[login] failed to open UGREEN authentication", openError);
      pendingUgreenLoginRef.current = false;
      setIsAuthorizingUgreen(false);
      setError(t("auth.ugreenAccess.openFailed"));
    }
  };

  /** 只解析用户选定的入口，不做提交前的健康检查或 WebSocket 探测。 */
  const resolveBaseUrl = async (): Promise<string | null> => {
    if (!isClientMode) return getServerUrl();
    serverProbeEpochRef.current += 1;
    const url = buildServerUrl(serverParts);
    if (!url) {
      setError(t("auth.serverAddressInvalid"));
      return null;
    }
    // Android 原生 HTTP 无法完成绿联网关的交互式 302 认证。
    // 对可信 UGREENlink 域名直接打开远程 Web 工作台，且不发送 Nowen 账号密码。
    if (isNativeMobileClient && isUgreenRemoteAccessUrl(url)) {
      commitServerUrl(url);
      await beginUgreenAuthorization(url);
      return null;
    }
    return url;
  };

  const persistRememberedLogin = async (baseUrl: string) => {
    const supported = canSavePassword || await canPersistPassword();
    const result = await saveRememberedCredentials({
      remember: supported && rememberMe,
      autoLogin: false,
      serverUrl: baseUrl,
      username: username.trim(),
      password,
    });
    if (!result.ok) {
      console.warn("[LoginPage] save remembered credentials failed:", result.error);
    }
  };

  const completeLocalLoginHintIfMatched = async (baseUrl: string, loginUsername: string) => {
    const hint = localLoginHint;
    if (!hint) return;
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "").toLowerCase();
    const normalizedHintUrl = hint.serverUrl.replace(/\/+$/, "").toLowerCase();
    if (normalizedBaseUrl !== normalizedHintUrl || loginUsername.trim() !== hint.username) return;
    try {
      const result = await completeDesktopLocalLoginHint(baseUrl, loginUsername.trim());
      if (result.ok) setLocalLoginHint(null);
    } catch {
      // 登录本身已经成功；提示状态写入失败不能阻断用户进入工作台。
    }
  };

  const fillLocalLoginHint = () => {
    if (!localLoginHint) return;
    pendingReauthRef.current = null;
    setMode("login");
    setLoginStep("password");
    setServerParts(parseServerUrl(localLoginHint.serverUrl));
    setRegisterConfigRefresh((n) => n + 1);
    setServerUrl(localLoginHint.serverUrl);
    localStorage.setItem("nowen-server-url-last", localLoginHint.serverUrl);
    setUsername(localLoginHint.username);
    setPassword(localLoginHint.password);
    setError("");
  };

  const handleAccountSwitched = (token: string, switchedUser: AuthUser) => {
    const baseUrl = getServerUrl() || buildServerUrl(serverParts);
    void completeLocalLoginHintIfMatched(baseUrl, switchedUser.username || "");
    (onAccountLogin || onLogin)(token, switchedUser);
  };

  const completeLogin = async (baseUrl: string, data: { token: string; refreshToken?: string; user: AuthUser }, loginUsername: string) => {
    commitServerUrl(baseUrl);
    await persistRememberedLogin(baseUrl);
    storeAuthTokens({ token: data.token, refreshToken: data.refreshToken ?? null });
    await completeLocalLoginHintIfMatched(baseUrl, data.user?.username || loginUsername);
    // WebSocket 放到登录后在后台确认；异常由工作台里的实时连接状态提示，不阻塞进入。
    if (isClientMode) void resolveWebSocketPathAfterLogin(baseUrl).catch(() => false);
    onLogin(data.token, data.user);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 同一时间只允许一个登录请求，避免连点或回车触发并发提交。
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setError("");
    setServiceUnavailable(false);
    setIsLoading(true);
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
        // 注册前在同一入口下确认可用的 Nowen API 路径（无凭据）。
        if (isClientMode && !(await discoverNowenApiPath(baseUrl).catch(() => null))) {
          setError(t("auth.serverUnreachable"), "retry");
          return;
        }
        let data: Awaited<ReturnType<typeof registerAccount>>;
        try {
          data = await registerAccount({
            username: username.trim(),
            password,
            email: email.trim() || undefined,
            displayName: displayName.trim() || undefined,
          }, baseUrl || undefined);
        } catch (err: any) {
          if (err?.name === "TypeError" || err?.status >= 500) setError(t("auth.serverUnreachable"), "retry");
          else setError(err?.status >= 400 && err?.status < 500 ? err.message || t("auth.registerFailed") : t("auth.registerFailed"));
          return;
        }
        commitServerUrl(baseUrl);
        storeAuthTokens({ token: data.token, refreshToken: data.refreshToken ?? null });
        await completeLocalLoginHintIfMatched(baseUrl || "", data.user?.username || username.trim());
        onLogin(data.token, data.user);
        return;
      }

      const { getDeviceId } = await import("@/lib/deviceId");
      const result = await submitPasswordLogin({
        serverUrl: baseUrl,
        credentials: { username: username.trim(), password, deviceId: getDeviceId() },
        retryWithoutResponse: isClientMode,
      });

      switch (result.kind) {
        case "success":
          await completeLogin(baseUrl, result, username.trim());
          return;
        case "twoFactor":
          setTwoFactorTicket(result.ticket);
          setTwoFactorUsername(result.username || username.trim());
          setTwoFactorBaseUrl(baseUrl);
          setTwoFactorCode("");
          setLoginStep("twoFactor");
          return;
        case "invalidCredentials":
          setError(t("auth.invalidCredentials"));
          return;
        case "refused":
          // 锁定、限流、禁用等由服务端给出带时长的具体提示。
          setError(result.message || t("auth.loginFailed"));
          return;
      }
      // 绿联桌面端继续走已有的网关授权窗口，授权完成后自动重新提交。
      if (isDesktopClient && isUgreenRemoteAccessUrl(baseUrl)) {
        await beginUgreenAuthorization(baseUrl);
        return;
      }
      if (result.kind === "gateway") setError(t("auth.gatewayVerificationRequired"), "openWeb");
      else setError(t("auth.serverUnreachable"), "retry");
    } catch (err: any) {
      console.error("[login] setup or session failed", { name: err?.name || "unknown" });
      setError(t("auth.loginSessionError"));
    } finally {
      setIsLoading(false);
      submitInFlightRef.current = false;
    }
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    if (!twoFactorTicket) {
      setLoginStep("password");
      setError(t("auth.twoFactor.ticketExpired"));
      return;
    }
    if (!twoFactorCode.trim()) {
      setError(t("auth.twoFactor.codeRequired"));
      return;
    }

    submitInFlightRef.current = true;
    setIsLoading(true);
    setError("");
    setServiceUnavailable(false);

    try {
      const baseUrl = twoFactorBaseUrl || (isClientMode ? buildServerUrl(serverParts) : getServerUrl());
      const verifyUrl = `${getResolvedApiBaseUrl(baseUrl)}/auth/2fa/verify`;
      const { getDeviceId } = await import("@/lib/deviceId");
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: twoFactorTicket,
          code: twoFactorCode.trim(),
          deviceId: getDeviceId(),
        }),
        redirect: "manual",
      };
      let res: Response;
      try {
        // 客户端偶发第一次请求无响应，自动补发一次；网页端同源请求不补发。
        res = isClientMode
          ? await fetchLoginRequest(verifyUrl, init, { timeoutMs: LOGIN_ATTEMPT_TIMEOUT_MS })
          : await fetch(verifyUrl, init);
      } catch {
        setError(t("auth.serverUnreachable"), "retry");
        return;
      }
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "TFA_TICKET_EXPIRED") {
          setLoginStep("password");
          setTwoFactorTicket("");
          setTwoFactorBaseUrl("");
          setTwoFactorCode("");
          setError(t("auth.twoFactor.ticketExpired"));
          return;
        }
        if (data.code === "TFA_INVALID_CODE") {
          setError(t("auth.twoFactor.verifyFailed"));
          return;
        }
        if (res.status >= 500 || typeof data.error !== "string") {
          setError(t("auth.serverUnreachable"), "retry");
          return;
        }
        setError(data.error || t("auth.twoFactor.verifyFailed"));
        return;
      }

      if (!data.token || !data.user) {
        setError(t("auth.twoFactor.verifyFailed"));
        return;
      }

      await completeLogin(baseUrl || "", data, twoFactorUsername || username.trim());
    } catch (err) {
      console.error("[login] two-factor session failed", { name: err instanceof Error ? err.name : "unknown" });
      setError(t("auth.loginSessionError"));
    } finally {
      setIsLoading(false);
      submitInFlightRef.current = false;
    }
  };

  const backToPasswordLogin = () => {
    setLoginStep("password");
    setTwoFactorTicket("");
    setTwoFactorBaseUrl("");
    setTwoFactorCode("");
    setError("");
  };

  const handleDisconnect = () => {
    clearServerUrl();
    clearAuthTokens();
    setServerParts({ protocol: "http", host: "", port: "", path: "" });
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setEmail("");
    setDisplayName("");
    setLoginStep("password");
    setTwoFactorTicket("");
    setTwoFactorUsername("");
    setTwoFactorBaseUrl("");
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
    setTwoFactorBaseUrl("");
    setTwoFactorCode("");
  };

  // 每次失败只显示一条简短提示；网页端首次加载失败也在这里提示重试。
  const failureMessage = error || (!isClientMode && serviceUnavailable ? t("auth.serverUnreachable") : "");
  const failureAction = error ? failure?.action : serviceUnavailable ? "retry" : undefined;
  const failureNotice = failureMessage ? (
    <div role="alert" data-login-failure className="flex items-start gap-2.5 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-3.5 py-2.5 text-sm leading-5 text-zinc-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-zinc-200">
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-500 dark:text-rose-400" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">{failureMessage}</p>
      {failureAction && (
        <button
          type="button"
          onClick={failureAction === "retry" ? retryAfterFailure : () => void openServerInBrowser()}
          className="flex-shrink-0 rounded-lg bg-white/80 px-2 py-0.5 text-xs font-medium text-indigo-600 ring-1 ring-indigo-500/20 transition-colors hover:bg-white hover:text-indigo-700 dark:bg-zinc-900/70 dark:text-indigo-300 dark:hover:text-indigo-200"
        >
          {failureAction === "retry" ? t("auth.retryConnection") : t("auth.openInBrowser")}
        </button>
      )}
    </div>
  ) : null;

  const inputClass = "block w-full rounded-xl border border-zinc-200/85 bg-white/75 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 shadow-[inset_0_1px_2px_rgba(15,23,42,0.03)] backdrop-blur-sm transition-all focus:border-indigo-500/80 focus:bg-white focus:outline-none focus:ring-4 focus:ring-indigo-500/15 dark:border-white/[0.1] dark:bg-zinc-950/55 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-indigo-400/70 dark:focus:bg-zinc-950/80 dark:focus:ring-indigo-400/20";

  return (
    <div
      ref={scrollContainerRef}
      // 高度必须用类：旧版 WebView 不认识 dvh，会直接丢掉内联值，index.css 的 vh 回退只能作用于类。
      // 一旦没有高度上限，页面无法滚动，表单较长时「登录工作台」按钮会被挤出屏幕。
      className="relative flex flex-col items-center bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50/55 dark:from-[#070a12] dark:via-[#0b1020] dark:to-[#0a1322] selection:bg-indigo-500/30 transition-colors overflow-y-auto overflow-x-hidden min-h-[100dvh] max-h-[100dvh]"
      style={{
        paddingTop: "var(--safe-area-top)",
        paddingBottom: `calc(var(--safe-area-bottom) + ${keyboardHeight}px)`,
      }}
    >
      {/* NOWEN Deep Space / Solar Clarity 极光氛围层（移动端静态轻量） */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute -top-40 -left-32 h-[28rem] w-[28rem] rounded-full bg-indigo-400/18 blur-3xl dark:bg-indigo-500/22 md:h-[36rem] md:w-[36rem]" />
        <div className="absolute -bottom-44 -right-28 h-[26rem] w-[26rem] rounded-full bg-sky-400/16 blur-3xl dark:bg-cyan-500/18 md:h-[34rem] md:w-[34rem]" />
        <div className="hidden md:block absolute top-1/3 right-1/4 h-72 w-72 rounded-full bg-fuchsia-400/10 blur-3xl dark:bg-violet-500/14" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className={`relative w-full max-w-[436px] px-4 py-6 flex-shrink-0 ${keyboardHeight > 0 ? "mt-auto" : "my-auto"}`}
      >
        <div className="relative overflow-hidden rounded-[28px] border border-white/75 bg-white/82 p-7 sm:p-8 shadow-[0_24px_64px_-20px_rgba(15,23,42,0.16),0_2px_6px_rgba(15,23,42,0.04)] backdrop-blur-2xl dark:border-white/[0.09] dark:bg-zinc-900/76 dark:shadow-[0_28px_72px_-16px_rgba(0,0,0,0.68),inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-500/60 via-50% to-transparent opacity-90"
          />

          <div className="text-center mb-6">
            <motion.div
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              whileHover={{ y: -2, rotate: -4, scale: 1.04 }}
              whileTap={{ scale: 0.94, rotate: 3 }}
              transition={{ type: "spring", stiffness: 360, damping: 22 }}
              className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/18 via-sky-500/12 to-violet-500/20 text-indigo-600 ring-1 ring-inset ring-indigo-500/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_3px_0_rgba(15,23,42,0.09),0_10px_22px_-8px_rgba(99,102,241,0.32)] dark:from-indigo-400/22 dark:via-sky-400/14 dark:to-violet-400/22 dark:text-indigo-300 dark:ring-indigo-400/30 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_3px_0_rgba(0,0,0,0.5),0_10px_24px_-8px_rgba(99,102,241,0.42)]"
            >
              <BookOpen size={26} />
            </motion.div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
              {isTwoFactorStep ? t("auth.twoFactor.title") : siteConfig.title || t("auth.appTitle")}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              {isTwoFactorStep
                ? t("auth.twoFactor.prompt", { username: twoFactorUsername || username.trim() })
                : isRegister ? t("auth.registerSubtitle") : isClientMode ? t("auth.subtitleClient") : t("auth.subtitle")}
            </p>
          </div>

          {!isTwoFactorStep && !isRegister && isClientMode && (
            <AccountLoginHistoryList
              className="mb-5"
              title={t("auth.loginHistory.recentAccounts")}
              onSwitched={handleAccountSwitched}
              onRequiresReauth={handleHistoryReauth}
            />
          )}

          {!isTwoFactorStep && (
          <div className="relative mb-5 grid grid-cols-2 gap-1 rounded-2xl border border-zinc-200/70 bg-zinc-100/80 p-1 shadow-inner shadow-black/[0.03] dark:border-white/[0.07] dark:bg-black/30">
            <button
              type="button"
              onClick={() => switchMode("login")}
              className={`relative z-10 rounded-xl py-2 text-xs font-semibold transition-colors ${mode === "login" ? "text-indigo-600 dark:text-indigo-300" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"}`}
            >
              {mode === "login" && (
                <motion.span
                  layoutId="login-mode-pill"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="pointer-events-none absolute inset-0 -z-10 rounded-xl bg-white shadow-[0_2px_0_rgba(15,23,42,0.06),0_6px_14px_-4px_rgba(99,102,241,0.22)] ring-1 ring-black/[0.04] dark:bg-zinc-800/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_2px_0_rgba(0,0,0,0.45)] dark:ring-white/[0.06]"
                />
              )}
              {t("auth.loginTab")}
            </button>
            <button
              type="button"
              onClick={() => switchMode("register")}
              disabled={!allowRegistration}
              title={!allowRegistration ? t("auth.registerDisabled") : undefined}
              className={`relative z-10 rounded-xl py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${mode === "register" ? "text-indigo-600 dark:text-indigo-300" : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"}`}
            >
              {mode === "register" && (
                <motion.span
                  layoutId="login-mode-pill"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                  className="pointer-events-none absolute inset-0 -z-10 rounded-xl bg-white shadow-[0_2px_0_rgba(15,23,42,0.06),0_6px_14px_-4px_rgba(99,102,241,0.22)] ring-1 ring-black/[0.04] dark:bg-zinc-800/95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_2px_0_rgba(0,0,0,0.45)] dark:ring-white/[0.06]"
                />
              )}
              {t("auth.registerTab")}
            </button>
          </div>
          )}

          <AnimatePresence>
            {!isTwoFactorStep && !isRegister && localLoginHint && (
              <motion.div
                data-desktop-local-login-hint
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-5 overflow-hidden rounded-2xl border border-indigo-200/80 bg-gradient-to-br from-indigo-50/85 via-white/70 to-sky-50/70 p-4 shadow-sm dark:border-indigo-400/25 dark:from-indigo-500/14 dark:via-zinc-900/50 dark:to-sky-500/10"
              >
                <div className="mb-2.5">
                  <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">{t("auth.localDesktopLogin.title")}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-indigo-700/80 dark:text-indigo-300/75">{t("auth.localDesktopLogin.description")}</p>
                </div>
                <dl className="space-y-1.5 rounded-xl bg-white/75 p-2.5 text-xs ring-1 ring-indigo-500/10 dark:bg-black/25 dark:ring-white/[0.06]">
                  <div className="flex gap-2">
                    <dt className="w-14 flex-shrink-0 text-indigo-500 dark:text-indigo-400">{t("auth.localDesktopLogin.address")}</dt>
                    <dd className="min-w-0 break-all font-mono text-zinc-700 dark:text-zinc-200">{localLoginHint.serverUrl}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-14 flex-shrink-0 text-indigo-500 dark:text-indigo-400">{t("auth.localDesktopLogin.username")}</dt>
                    <dd className="min-w-0 break-all font-mono text-zinc-700 dark:text-zinc-200">{localLoginHint.username}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-14 flex-shrink-0 text-indigo-500 dark:text-indigo-400">{t("auth.localDesktopLogin.password")}</dt>
                    <dd className="min-w-0 break-all font-mono text-zinc-700 dark:text-zinc-200">{localLoginHint.password}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-14 flex-shrink-0 text-indigo-500 dark:text-indigo-400">{t("auth.localDesktopLogin.role")}</dt>
                    <dd className="min-w-0 text-zinc-700 dark:text-zinc-200">{t("auth.localDesktopLogin.roleAdmin")}</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  onClick={fillLocalLoginHint}
                  className="mt-3 w-full rounded-xl border border-indigo-200/90 bg-white/90 px-3 py-2 text-xs font-semibold text-indigo-700 shadow-sm transition-all hover:-translate-y-[1px] hover:bg-white hover:shadow active:translate-y-[0.5px] dark:border-indigo-400/30 dark:bg-indigo-950/45 dark:text-indigo-200 dark:hover:bg-indigo-950/65"
                >
                  {t("auth.localDesktopLogin.fillButton")}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <form ref={formRef} onSubmit={isTwoFactorStep ? handleTwoFactorSubmit : handleSubmit} className="space-y-4">
            {isTwoFactorStep ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.twoFactor.codeLabel")}</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                    <input
                      type="text"
                      value={twoFactorCode}
                      onChange={(e) => setTwoFactorCode(e.target.value)}
                      className={`${inputClass} pl-10 pr-3 font-mono tracking-wider`}
                      placeholder="123456 / xxxxx-xxxxx"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      autoFocus
                    />
                  </div>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("auth.twoFactor.codeHint")}</p>
                </div>

                {failureNotice}

                <button
                  type="submit"
                  disabled={submitDisabled}
                  className="w-full flex items-center justify-center rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_8px_20px_-6px_rgba(99,102,241,0.5)] transition-all hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_12px_24px_-6px_rgba(99,102,241,0.58)] active:translate-y-[0.5px] active:scale-[0.985] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900 disabled:pointer-events-none disabled:opacity-50"
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t("auth.twoFactor.verifyButton")}
                </button>

                <button
                  type="button"
                  onClick={backToPasswordLogin}
                  className="w-full rounded-xl py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-indigo-600 dark:text-zinc-400 dark:hover:text-indigo-300"
                >
                  {t("auth.twoFactor.backToLogin")}
                </button>
              </>
            ) : (
            <>
            <AnimatePresence>
              {isClientMode && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-1.5">
                  <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.serverAddress")}</label>
                  <ServerAddressInput
                    value={serverParts}
                    onChange={(next) => {
                      serverProbeEpochRef.current += 1;
                      setServerParts(next);
                      if (failure?.action) setError("");
                    }}
                    onHostBlur={handleServerBlur}
                    autoFocus={isClientMode}
                    disabled={isLoading}
                    accent="indigo"
                  />
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">{t("auth.serverHint")}</p>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.username")}</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={`${inputClass} pl-10 pr-3`}
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
                    <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.emailOptional")}</label>
                    <div className="relative">
                      <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={`${inputClass} pl-10 pr-3`}
                        placeholder="you@example.com"
                        autoComplete="email"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.displayNameOptional")}</label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className={`${inputClass} px-3.5`}
                      placeholder={t("auth.displayNamePlaceholder")}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.password")}</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${inputClass} pl-10 pr-10`}
                  placeholder="••••••••"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  required
                />
                <button type="button" onClick={() => setShowPassword((v) => !v)} tabIndex={-1} className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {isRegister && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="space-y-1.5 overflow-hidden">
                  <label className="text-xs font-semibold tracking-wide text-zinc-600 dark:text-zinc-300">{t("auth.confirmPassword")}</label>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={`${inputClass} pl-10 pr-10`}
                      placeholder="••••••••"
                      autoComplete="new-password"
                      required
                    />
                    <button type="button" onClick={() => setShowConfirmPassword((v) => !v)} tabIndex={-1} className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors">
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {!isRegister && canSavePassword && (
              <label className="flex cursor-pointer select-none items-center gap-2.5 pt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500/40 dark:border-zinc-600"
                />
                <span>{t("auth.rememberMe")}</span>
              </label>
            )}

            {failureNotice}

            {isAuthorizingUgreen && (
              <div className="flex items-center gap-2 rounded-xl border border-indigo-200/80 bg-indigo-50/80 px-3.5 py-2.5 text-xs font-medium text-indigo-700 dark:border-indigo-400/25 dark:bg-indigo-500/12 dark:text-indigo-300">
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
                <span>{t("auth.ugreenAccess.waiting")}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full flex items-center justify-center rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_8px_20px_-6px_rgba(99,102,241,0.5)] transition-all hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_12px_24px_-6px_rgba(99,102,241,0.58)] active:translate-y-[0.5px] active:scale-[0.985] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900 disabled:pointer-events-none disabled:opacity-50"
            >
              {isLoading && !isRegister && !isAuthorizingUgreen
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />{t("auth.signingIn")}</>
                : isLoading || isAuthorizingUgreen
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : isRegister
                  ? t("auth.registerButton")
                  : isMobileUgreenAddress
                    ? t("auth.ugreenAccess.button")
                    : t("auth.loginButton")}
              {isAuthorizingUgreen && <span className="ml-2">{t("auth.ugreenAccess.authorizing")}</span>}
            </button>
            </>
            )}
          </form>

          {!isTwoFactorStep && onContinueLocal && (
            <div className="mt-5 border-t border-zinc-200/70 pt-4 dark:border-white/[0.08]">
              <button
                type="button"
                onClick={onContinueLocal}
                className="w-full rounded-xl border border-zinc-200/85 bg-white/80 px-4 py-2.5 text-sm font-medium text-zinc-700 shadow-sm transition-all hover:-translate-y-[1px] hover:border-indigo-300 hover:text-indigo-600 hover:shadow active:translate-y-[0.5px] dark:border-white/[0.1] dark:bg-zinc-900/70 dark:text-zinc-200 dark:hover:border-indigo-400/50 dark:hover:text-indigo-300"
              >
                {t("auth.continueLocal")}
              </button>
              <p className="mt-2 text-center text-[11px] leading-5 text-zinc-400 dark:text-zinc-500">
                {t("auth.localModeNote")}
              </p>
            </div>
          )}

          {!isTwoFactorStep && !serviceUnavailable && <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
            {isRegister ? t("auth.registerHint") : (hasUsers ? null : t("auth.defaultCredentials"))}
          </p>}

          {!isTwoFactorStep && !allowRegistration && !isRegister && (
            <p className="mt-1.5 text-center text-[11px] text-zinc-400 dark:text-zinc-500">{t("auth.registerClosed")}</p>
          )}

          {!isTwoFactorStep && isClientMode && getServerUrl() && (
            <div className="mt-3 flex justify-center">
              <button type="button" onClick={handleDisconnect} className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-rose-500/8 hover:text-rose-500 dark:text-zinc-500 dark:hover:text-rose-400">
                {t("auth.resetServer")}
              </button>
            </div>
          )}
        </div>

        {isClientMode && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="mt-4 px-4 text-center text-[11px] text-zinc-500/80 dark:text-zinc-500">
            {t("auth.clientNote")}
          </motion.p>
        )}

        {showIcpBeian && (
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 block text-center text-[11px] text-zinc-400 transition-colors hover:text-indigo-500 dark:text-zinc-500 dark:hover:text-indigo-400"
          >
            {icpBeianText}
          </a>
        )}
      </motion.div>
    </div>
  );
}
