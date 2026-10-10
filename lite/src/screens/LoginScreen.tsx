/**
 * 登录页 —— 按 Nowen Note 标准版的登录页重做。
 *
 * 从标准版（v1.5.0 LoginPage + ServerAddressInput）搬过来的设计：
 *   · 顶部品牌区：图标 + 名称 + 副标题「连接你的私有知识库」
 *   · **最近登录卡片**：上次用的账号 + 服务器，一眼看到"我要登到哪"
 *   · **服务器地址 = 协议下拉 + `://` + 主机端口**，右侧一个连接状态图标
 *     ⚠️ 这不是好看而已：让用户手打 `http://` 时，很容易漏掉协议，
 *        而漏掉协议会被浏览器当**相对路径**（解析成 https://localhost/…）→ 全部 404。
 *        用下拉选协议，从源头消灭这个坑。
 *   · 两步式：密码 → 动态验证码（服务端要求 2FA 时）
 *   · 密码显隐、「记住账号和密码」、错误条、加载态
 *
 * 没搬的（Lite 不需要）：
 *   注册模式、局域网发现（要原生 mDNS 插件）、绿联 NAS 授权、桌面端本地登录提示。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getSavedUsername,
  getServerUrl,
  isSessionOnly,
  login,
  setSavedUsername,
  setServerUrl,
  setSessionOnly,
  storeTokens,
  verify2fa,
} from "../auth/auth";
import { useI18n } from "../lib/i18n";
import { joinServer, SCHEMES, splitServer, type Scheme } from "../lib/serverAddress";

type Step =
  | { name: "credentials" }
  | { name: "twoFactor"; ticket: string; username: string };

type ServerStatus = "idle" | "checking" | "ok" | "fail";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { t } = useI18n();

  const initial = splitServer(getServerUrl());
  const [scheme, setScheme] = useState<Scheme>(initial.scheme);
  const [host, setHost] = useState(initial.host);
  const [serverStatus, setServerStatus] = useState<ServerStatus>("idle");

  const [username, setUsername] = useState(getSavedUsername());
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(() => !isSessionOnly());

  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ name: "credentials" });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const baseUrl = useMemo(() => joinServer({ scheme, host }), [scheme, host]);
  /** 「最近登录」有内容才显示那张卡片 */
  const hasRecent = Boolean(getSavedUsername() || getServerUrl());

  /** 探测服务端可达性（真实服务端与 mock 都有 /api/health，且不需要鉴权） */
  const checkServer = useMemo(
    () => async (url: string) => {
      if (!url) return setServerStatus("idle");
      setServerStatus("checking");
      try {
        const res = await fetch(`${url}/api/health`, {
          method: "GET",
          signal: AbortSignal.timeout(6000),
        });
        setServerStatus(res.ok ? "ok" : "fail");
      } catch {
        setServerStatus("fail");
      }
    },
    [],
  );

  useEffect(() => {
    void checkServer(joinServer(splitServer(getServerUrl())));
    // 只在挂载时探一次；地址改了会在失焦时重探
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step.name === "twoFactor") codeRef.current?.focus();
  }, [step.name]);

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (!username.trim() || !password) {
      setError(t("login.errEmpty"));
      return;
    }
    // ⚠️ 不强制要求填服务器地址：留空 = 与当前页面同源，这在网页版是**合法**的
    //    （开发时由 vite 代理转发）。APK 里留空确实会指向 localhost，
    //    但那由下面的「连不上服务器」提示来表达，不该用红字拦住用户。
    setBusy(true);
    try {
      // 存的一定是「协议 + 主机」的完整地址（见 serverAddress.ts 的说明）
      setServerUrl(baseUrl);
      setSessionOnly(!remember);
      const outcome = await login(baseUrl, username.trim(), password);
      setSavedUsername(username.trim());
      if (outcome.kind === "2fa") {
        setStep({ name: "twoFactor", ticket: outcome.ticket, username: outcome.username });
        setPassword("");
      } else {
        storeTokens(outcome.token, outcome.refreshToken);
        onLoggedIn();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(/fetch|network|Failed/i.test(message) ? t("login.errNetwork") : message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (busy || step.name !== "twoFactor") return;
    setError(null);
    if (!code.trim()) {
      setError(t("login.errEmptyCode"));
      return;
    }
    setBusy(true);
    try {
      const { token, refreshToken } = await verify2fa(baseUrl, step.ticket, code.trim());
      storeTokens(token, refreshToken);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function backToPassword() {
    setStep({ name: "credentials" });
    setCode("");
    setError(null);
  }

  /** 清掉「最近登录」记忆（账号 + 服务器），回到全新状态 */
  function forgetRecent() {
    setSavedUsername("");
    setUsername("");
    setHost("");
    setScheme("http");
    setServerStatus("idle");
    setError(null);
  }

  return (
    <div className="app login-page">
      <div className="app-content app-content--padded">
        {/* ---- 品牌区 ---- */}
        <div className="brand">
          <div className="brand-logo">
            <span aria-hidden="true">📖</span>
          </div>
          <h2 className="brand-title">{t("login.title")}</h2>
          <div className="brand-sub">{t("login.subtitle")}</div>
        </div>

        {step.name === "credentials" ? (
          <form className="form card glass login-card" onSubmit={submitCredentials}>
            {/* ---- 最近登录（对齐标准版：一眼看到上次登到哪）---- */}
            {hasRecent ? (
              <div className="recent-block" data-testid="recent-login">
                <div className="recent-label">{t("login.recent")}</div>
                <div className="recent-card">
                  <span className="recent-avatar" aria-hidden="true">
                    {(username.trim()[0] || "?").toUpperCase()}
                  </span>
                  <span className="recent-main">
                    <span className="recent-name">{username.trim() || t("login.noAccount")}</span>
                    <span className="recent-sub">
                      {baseUrl ? baseUrl.replace(/^https?:\/\//, "") : t("login.serverSameOrigin")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="recent-forget"
                    onClick={forgetRecent}
                    aria-label={t("login.forget")}
                    title={t("login.forget")}
                    data-testid="forget-recent"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : null}

            {/* ---- 服务器地址：协议下拉 + :// + 主机端口 + 状态 ---- */}
            <div className="field">
              <label htmlFor="server-host">{t("login.serverLabel")}</label>
              <div className="server-input" data-status={serverStatus}>
                <span className="server-scheme">
                  <span className="server-globe" aria-hidden="true">
                    🌐
                  </span>
                  <select
                    value={scheme}
                    onChange={(e) => {
                      setScheme(e.target.value as Scheme);
                      setServerStatus("idle");
                    }}
                    aria-label={t("login.scheme")}
                    data-testid="server-scheme"
                  >
                    {SCHEMES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <span className="server-caret" aria-hidden="true">
                    ▾
                  </span>
                </span>
                <span className="server-sep" aria-hidden="true">
                  ://
                </span>
                <input
                  id="server-host"
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={t("login.serverPlaceholder")}
                  value={host}
                  onChange={(e) => {
                    setHost(e.target.value);
                    setServerStatus("idle");
                  }}
                  onBlur={() => void checkServer(joinServer({ scheme, host }))}
                />
                <span className="server-state" data-status={serverStatus} aria-hidden="true">
                  {serverStatus === "ok" ? "✔" : serverStatus === "fail" ? "✕" : ""}
                </span>
              </div>
              <div className="field-hint">{t("login.serverHint")}</div>
            </div>

            <div className="field">
              <label htmlFor="username">{t("login.username")}</label>
              <div className="input-affix">
                <span className="field-icon" aria-hidden="true">
                  👤
                </span>
                <input
                  id="username"
                  className="has-icon"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  placeholder={t("login.usernamePlaceholder")}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="password">{t("login.password")}</label>
              <div className="input-affix">
                <span className="field-icon" aria-hidden="true">
                  🔒
                </span>
                <input
                  id="password"
                  className="has-icon"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder={t("login.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="affix-btn"
                  aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? "🙈" : "👁"}
                </button>
              </div>
            </div>

            <label className="check-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>
                <b>{t("login.remember")}</b>
                <em>{t("login.rememberHint")}</em>
              </span>
            </label>

            {serverStatus === "fail" ? (
              <div className="notice notice-inline" data-testid="server-fail">
                <b>{t("login.serverFail")}</b>
                <span>{t("login.serverFailHint")}</span>
              </div>
            ) : null}

            <div className={error ? "form-error form-error--in" : "form-error"} aria-live="polite">
              {error ? (
                <>
                  <span className="form-error-dot" aria-hidden="true" />
                  <span data-testid="login-error">{error}</span>
                </>
              ) : null}
            </div>

            <button className="btn" type="submit" disabled={busy} data-testid="login-submit">
              {busy ? (
                <>
                  <span className="spinner spinner--on-accent" />
                  {t("login.submitting")}
                </>
              ) : (
                t("login.submit")
              )}
            </button>
          </form>
        ) : (
          <form className="form card glass login-card" onSubmit={submitCode}>
            <div className="twofa-head">
              <span className="twofa-icon" aria-hidden="true">
                🔐
              </span>
              <div className="twofa-text">
                <b>{t("login.twoFactorTitle")}</b>
                <span>{t("login.twoFactorSubtitle")}</span>
              </div>
            </div>

            <div className="twofa-account">
              {t("login.twoFactorAccount")} · <b>{step.username}</b>
            </div>

            <div className="field">
              <label htmlFor="code">{t("login.twoFactorCode")}</label>
              <input
                id="code"
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder={t("login.twoFactorPlaceholder")}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="field-hint">{t("login.twoFactorHint")}</div>
            </div>

            <div className={error ? "form-error form-error--in" : "form-error"} aria-live="polite">
              {error ? (
                <>
                  <span className="form-error-dot" aria-hidden="true" />
                  <span data-testid="login-error">{error}</span>
                </>
              ) : null}
            </div>

            <button className="btn" type="submit" disabled={busy} data-testid="twofa-submit">
              {busy ? (
                <>
                  <span className="spinner spinner--on-accent" />
                  {t("login.twoFactorVerifying")}
                </>
              ) : (
                t("login.twoFactorVerify")
              )}
            </button>

            <button
              className="link-btn"
              type="button"
              onClick={backToPassword}
              data-testid="twofa-back"
            >
              {t("login.twoFactorBack")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
