import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { getDeviceId } from "@/lib/deviceId";
import {
  clearTwoFactorLoginChallenge,
  readTwoFactorLoginChallenge,
  TWO_FACTOR_LOGIN_CHALLENGE_EVENT,
  type TwoFactorLoginChallenge,
} from "@/lib/twoFactorLoginChallenge";

function storeLoginToken(token: string): void {
  try {
    localStorage.setItem("nowen-token", token);
  } catch {
    /* AuthGate reload will fall back to the login page if storage is unavailable. */
  }
  try {
    window.dispatchEvent(new CustomEvent("nowen:token-changed"));
  } catch {
    /* ignore */
  }
}

export default function TwoFactorLoginChallengeCenter() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [challenge, setChallenge] = useState<TwoFactorLoginChallenge | null>(() =>
    readTwoFactorLoginChallenge(),
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const isZh = useMemo(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.language.toLowerCase().startsWith("zh");
  }, []);

  const copy = isZh ? {
    title: "完成二步验证",
    prompt: "请输入身份验证器中的 6 位验证码，或使用一次性恢复码。",
    account: "正在登录",
    codeLabel: "验证码或恢复码",
    codePlaceholder: "123456 / xxxxx-xxxxx",
    verify: "验证并登录",
    back: "返回账号密码登录",
    required: "请输入验证码或恢复码",
    invalid: "验证码或恢复码不正确，请重试",
    expired: "登录验证已过期，请重新输入账号密码",
    failed: "验证失败，请稍后重试",
    secure: "验证码不会被保存",
  } : {
    title: "Complete two-factor authentication",
    prompt: "Enter the 6-digit code from your authenticator, or use a recovery code.",
    account: "Signing in as",
    codeLabel: "Code or recovery code",
    codePlaceholder: "123456 / xxxxx-xxxxx",
    verify: "Verify and sign in",
    back: "Back to password sign-in",
    required: "Enter a verification or recovery code",
    invalid: "That code is invalid. Try again.",
    expired: "This sign-in challenge expired. Enter your password again.",
    failed: "Verification failed. Please try again.",
    secure: "Your verification code is never stored",
  };

  const refreshChallenge = useCallback(() => {
    setChallenge(readTwoFactorLoginChallenge());
  }, []);

  useEffect(() => {
    window.addEventListener(TWO_FACTOR_LOGIN_CHALLENGE_EVENT, refreshChallenge);
    window.addEventListener("pageshow", refreshChallenge);
    document.addEventListener("visibilitychange", refreshChallenge);
    return () => {
      window.removeEventListener(TWO_FACTOR_LOGIN_CHALLENGE_EVENT, refreshChallenge);
      window.removeEventListener("pageshow", refreshChallenge);
      document.removeEventListener("visibilitychange", refreshChallenge);
    };
  }, [refreshChallenge]);

  useEffect(() => {
    if (!challenge) return;
    const delay = Math.max(0, challenge.expiresAt - Date.now());
    const expiryTimer = window.setTimeout(() => {
      clearTwoFactorLoginChallenge();
      window.location.reload();
    }, delay + 25);
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(expiryTimer);
      window.clearTimeout(focusTimer);
    };
  }, [challenge]);

  useEffect(() => {
    if (!challenge) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || loading) return;
      event.preventDefault();
      clearTwoFactorLoginChallenge();
      window.location.reload();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [challenge, loading]);

  const returnToPassword = useCallback(() => {
    if (loading) return;
    clearTwoFactorLoginChallenge();
    window.location.reload();
  }, [loading]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;

    const current = readTwoFactorLoginChallenge();
    if (!current || !challenge || current.ticket !== challenge.ticket) {
      clearTwoFactorLoginChallenge();
      setError(copy.expired);
      window.location.reload();
      return;
    }

    const normalizedCode = code.trim();
    if (!normalizedCode) {
      setError(copy.required);
      inputRef.current?.focus();
      return;
    }

    setLoading(true);
    setError("");
    try {
      const response = await fetch(current.verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          ticket: current.ticket,
          code: normalizedCode,
          deviceId: getDeviceId(),
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (data?.code === "TFA_TICKET_EXPIRED" || data?.code === "TFA_NOT_ENABLED") {
          clearTwoFactorLoginChallenge();
          setError(copy.expired);
          window.setTimeout(() => window.location.reload(), 300);
          return;
        }
        if (data?.code === "TFA_INVALID_CODE") {
          setError(copy.invalid);
          setCode("");
          window.setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
        setError(data?.error || copy.failed);
        return;
      }

      if (!data?.token || !data?.user) {
        setError(copy.failed);
        return;
      }

      storeLoginToken(data.token);
      clearTwoFactorLoginChallenge();
      window.location.reload();
    } catch (requestError: any) {
      setError(requestError?.message || copy.failed);
    } finally {
      setLoading(false);
    }
  };

  if (!challenge) return null;

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center overflow-y-auto bg-zinc-950/55 px-4 py-8 backdrop-blur-sm"
      style={{
        paddingTop: "calc(var(--safe-area-top) + 24px)",
        paddingBottom: "calc(var(--safe-area-bottom) + 24px)",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="two-factor-login-title"
      data-swipe-blocker="two-factor-login"
    >
      <div className="w-full max-w-[420px] rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
            <ShieldCheck size={25} />
          </div>
          <h1 id="two-factor-login-title" className="mt-4 text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {copy.title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {copy.prompt}
          </p>
          {challenge.username && (
            <p className="mt-2 truncate text-xs text-zinc-400 dark:text-zinc-500">
              {copy.account} <span className="font-medium text-zinc-600 dark:text-zinc-300">{challenge.username}</span>
            </p>
          )}
        </div>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label htmlFor="two-factor-login-code" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {copy.codeLabel}
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input
                ref={inputRef}
                id="two-factor-login-code"
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={copy.codePlaceholder}
                autoComplete="one-time-code"
                inputMode="text"
                spellCheck={false}
                autoCapitalize="none"
                className="block w-full rounded-xl border border-zinc-200 bg-zinc-50/70 py-2.5 pl-10 pr-3 text-sm text-zinc-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-100"
              />
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">{copy.secure}</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-indigo-500 dark:focus:ring-offset-zinc-900"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : copy.verify}
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={returnToPassword}
            className="w-full py-1 text-xs text-zinc-500 transition hover:text-indigo-600 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-indigo-400"
          >
            {copy.back}
          </button>
        </form>
      </div>
    </div>
  );
}
