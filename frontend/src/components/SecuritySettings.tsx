import React, { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  Key,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  User,
  Smartphone,
  Copy,
  Download,
  LogOut,
  RefreshCw,
  Monitor,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, broadcastLogout, withSudo } from "@/lib/api";

/**
 * 顶层组件：组合账号/密码修改 + 2FA + 会话管理三个区块。
 * 这样后端的 Phase 6（2FA + session 管理）也有一个用户可见的入口。
 */
export default function SecuritySettings() {
  return (
    <div className="space-y-10">
      <PasswordSection />
      <TwoFactorSection />
      <SessionsSection />
    </div>
  );
}

// ====================================================================
// 账号与密码修改（原有逻辑，只微调使用 api.updateSecurity + broadcastLogout）
// ====================================================================
function PasswordSection() {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [shake, setShake] = useState(false);

  const triggerShake = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!currentPassword) {
      return triggerShake(t('securitySettings.currentPasswordRequired'));
    }
    if (!newPassword && !newUsername) {
      return triggerShake(t('securitySettings.noChanges'));
    }
    if (newPassword && newPassword.length < 6) {
      return triggerShake(t('securitySettings.passwordTooShort'));
    }
    if (newPassword && newPassword !== confirmPassword) {
      return triggerShake(t('securitySettings.passwordNotMatch'));
    }

    setIsLoading(true);
    try {
      // api.updateSecurity 会自动把新 token 写回 localStorage（后端改密会 bump tokenVersion）
      await api.updateSecurity({
        currentPassword,
        newUsername: newUsername || undefined,
        newPassword: newPassword || undefined,
      });
      setSuccess(true);
      setTimeout(() => {
        // L10: 改密成功 → 广播其他 tab 一起下线
        broadcastLogout("password_changed");
        window.location.reload();
      }, 2000);
    } catch (err: any) {
      triggerShake(err?.message || t('securitySettings.updateFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <Shield className="w-4 h-4 text-indigo-500" />
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{t('securitySettings.title')}</h3>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">{t('securitySettings.description')}</p>

      <motion.form
        onSubmit={handleSubmit}
        className="space-y-4 max-w-md"
        animate={shake ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : { x: 0 }}
        transition={shake ? { duration: 0.5 } : {}}
      >
        {/* 当前密码 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {t('securitySettings.currentPassword')} <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Key className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
            </div>
            <input
              type={showCurrentPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={`block w-full pl-10 pr-10 py-2.5 border rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm ${
                error && !currentPassword ? "border-red-500/50 dark:border-red-500/50" : "border-zinc-200 dark:border-zinc-700"
              }`}
              placeholder={t('securitySettings.currentPasswordPlaceholder')}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              {showCurrentPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <div className="h-px w-full bg-zinc-200 dark:bg-zinc-800" />

        {/* 新用户名 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('securitySettings.newUsername')}</label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <User className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
            </div>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
              placeholder={t('securitySettings.newUsernamePlaceholder')}
              autoComplete="username"
            />
          </div>
        </div>

        {/* 新密码 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('securitySettings.newPassword')}</label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Key className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
            </div>
            <input
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="block w-full pl-10 pr-10 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
              placeholder={t('securitySettings.newPasswordPlaceholder')}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {newPassword && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-1.5 overflow-hidden"
            >
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('securitySettings.confirmPassword')}</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Key className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                </div>
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`block w-full pl-10 pr-3 py-2.5 border rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm ${
                    confirmPassword && newPassword !== confirmPassword ? "border-red-500/50 dark:border-red-500/50" : "border-zinc-200 dark:border-zinc-700"
                  }`}
                  placeholder={t('securitySettings.confirmPasswordPlaceholder')}
                  autoComplete="new-password"
                  required={!!newPassword}
                />
              </div>
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-red-500 dark:text-red-400">{t('securitySettings.passwordMismatch')}</p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

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

        <button
          type="submit"
          disabled={isLoading || success}
          className={`w-full flex items-center justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-white transition-all shadow-sm hover:shadow-md ${
            success
              ? "bg-green-500"
              : "bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500"
          } disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900`}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : success ? (
            <>
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {t('securitySettings.successMessage')}
            </>
          ) : (
            <>
              <Key className="w-4 h-4 mr-2" />
              {t('securitySettings.saveButton')}
            </>
          )}
        </button>
      </motion.form>
    </section>
  );
}

// ====================================================================
// 两步验证 (2FA)
// ====================================================================
//
// 三态状态机：
//   idle            刚进入，显示 enable / disable 按钮
//   setup           已调用 /auth/2fa/setup，显示 otpauth URI + 输入框
//   showRecovery    activate 成功，展示恢复码
//   disabling       显示关闭 2FA 的 code 输入框
function TwoFactorSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ enabled: boolean; enabledAt: string | null; recoveryCodesRemaining: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [ui, setUi] = useState<
    | { mode: "idle" }
    | { mode: "setup"; secret: string; otpauthUri: string; pending: string; code: string; error: string; busy: boolean }
    | { mode: "showRecovery"; codes: string[] }
    | { mode: "disabling"; code: string; error: string; busy: boolean }
  >({ mode: "idle" });
  const [sudoToken, setSudoToken] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.getTwoFactorStatus();
      setStatus(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  };

  const startSetup = async () => {
    try {
      const { secret, otpauthUri, pending } = await api.setupTwoFactor();
      setUi({ mode: "setup", secret, otpauthUri, pending, code: "", error: "", busy: false });
    } catch (err: any) {
      showToast(err?.message || "setup failed");
    }
  };

  const activate = async () => {
    if (ui.mode !== "setup") return;
    setUi({ ...ui, busy: true, error: "" });
    try {
      const { recoveryCodes } = await api.activateTwoFactor(ui.pending, ui.code.trim());
      setUi({ mode: "showRecovery", codes: recoveryCodes });
      await refresh();
    } catch (err: any) {
      setUi({ ...ui, busy: false, error: err?.message || t("securitySettings.twoFactor.codeInvalid") });
    }
  };

  const disable = async () => {
    if (ui.mode !== "disabling") return;
    setUi({ ...ui, busy: true, error: "" });
    try {
      const ran = await withSudo(
        (tk) => api.disableTwoFactor(ui.code.trim(), tk),
        () => window.prompt(t("securitySettings.twoFactor.disableHint")) || null,
        sudoToken,
      );
      if (!ran) {
        setUi({ ...ui, busy: false });
        return;
      }
      setSudoToken(ran.sudoToken);
      setUi({ mode: "idle" });
      await refresh();
      showToast(t("securitySettings.twoFactor.disableSuccess"));
    } catch (err: any) {
      setUi({ ...ui, busy: false, error: err?.message || t("securitySettings.twoFactor.codeInvalid") });
    }
  };

  const regenerate = async () => {
    try {
      const ran = await withSudo(
        (tk) => api.regenerateRecoveryCodes(tk),
        () => window.prompt(t("securitySettings.twoFactor.regenerateHint") + "\n\n" + t("securitySettings.currentPasswordPlaceholder")) || null,
        sudoToken,
      );
      if (!ran) return;
      setSudoToken(ran.sudoToken);
      setUi({ mode: "showRecovery", codes: ran.result.recoveryCodes });
      await refresh();
    } catch (err: any) {
      showToast(err?.message || "regenerate failed");
    }
  };

  const copyCodes = async (codes: string[]) => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      showToast(t("securitySettings.twoFactor.copied"));
    } catch {
      /* ignore */
    }
  };

  const downloadCodes = (codes: string[]) => {
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "nowen-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <Smartphone className="w-4 h-4 text-indigo-500" />
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{t("securitySettings.twoFactor.title")}</h3>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
        {status?.enabled
          ? t("securitySettings.twoFactor.descriptionEnabled")
          : t("securitySettings.twoFactor.descriptionDisabled")}
      </p>

      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
      ) : (
        <div className="max-w-md space-y-4">
          {/* 状态区 */}
          <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/50">
            <div className="text-sm">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">
                {status?.enabled
                  ? t("securitySettings.twoFactor.enabledAt", { date: status.enabledAt ? new Date(status.enabledAt).toLocaleString() : "-" })
                  : t("securitySettings.twoFactor.descriptionDisabled")}
              </div>
              {status?.enabled && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {t("securitySettings.twoFactor.recoveryRemaining", { count: status.recoveryCodesRemaining })}
                </div>
              )}
            </div>
            {status?.enabled ? (
              <button
                type="button"
                onClick={() => setUi({ mode: "disabling", code: "", error: "", busy: false })}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 border border-red-200 dark:border-red-500/30"
              >
                {t("securitySettings.twoFactor.disableButton")}
              </button>
            ) : (
              <button
                type="button"
                onClick={startSetup}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700"
              >
                {t("securitySettings.twoFactor.enableButton")}
              </button>
            )}
          </div>

          {/* 已启用：重新生成恢复码 */}
          {status?.enabled && ui.mode === "idle" && (
            <button
              type="button"
              onClick={regenerate}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {t("securitySettings.twoFactor.regenerateCodes")}
            </button>
          )}

          {/* setup 状态：展示 otpauth URI + 输入 6 位码 */}
          {ui.mode === "setup" && (
            <div className="space-y-3 p-4 rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/50 dark:bg-indigo-500/5">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {t("securitySettings.twoFactor.setupTitle")}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("securitySettings.twoFactor.setupHint")}
              </div>
              {/* otpauth URI（用户可点开自己用在线二维码生成器，或复制到密码管理器） */}
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("securitySettings.twoFactor.otpauthUri")}</div>
                <input
                  readOnly
                  value={ui.otpauthUri}
                  className="w-full px-2 py-1.5 text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-300"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              {/* 纯密钥 */}
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("securitySettings.twoFactor.manualSecret")}</div>
                <code className="block px-2 py-1.5 text-sm font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg tracking-widest text-zinc-700 dark:text-zinc-300">
                  {ui.secret}
                </code>
              </div>
              {/* 输入 6 位码 */}
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t("securitySettings.twoFactor.activateLabel")}</div>
                <input
                  value={ui.code}
                  onChange={(e) => setUi({ ...ui, code: e.target.value })}
                  placeholder="123456"
                  inputMode="numeric"
                  maxLength={6}
                  className="w-full px-3 py-2 text-center tracking-[0.4em] font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100"
                />
                {ui.error && <p className="text-xs text-red-500 mt-1">{ui.error}</p>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={activate}
                  disabled={ui.busy || !/^\d{6}$/.test(ui.code.trim())}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {ui.busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t("securitySettings.twoFactor.activateButton")}
                </button>
                <button
                  type="button"
                  onClick={() => setUi({ mode: "idle" })}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t("securitySettings.twoFactor.cancelButton")}
                </button>
              </div>
            </div>
          )}

          {/* disabling：请求输入 code */}
          {ui.mode === "disabling" && (
            <div className="space-y-3 p-4 rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50/50 dark:bg-red-500/5">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("securitySettings.twoFactor.disableTitle")}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t("securitySettings.twoFactor.disableHint")}</div>
              <input
                value={ui.code}
                onChange={(e) => setUi({ ...ui, code: e.target.value })}
                placeholder="123456"
                className="w-full px-3 py-2 text-center tracking-[0.3em] font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-zinc-100"
              />
              {ui.error && <p className="text-xs text-red-500">{ui.error}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={disable}
                  disabled={ui.busy || !ui.code.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                >
                  {ui.busy ? <Loader2 className="w-3 h-3 animate-spin" /> : t("securitySettings.twoFactor.disableButton")}
                </button>
                <button
                  type="button"
                  onClick={() => setUi({ mode: "idle" })}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t("securitySettings.twoFactor.cancelButton")}
                </button>
              </div>
            </div>
          )}

          {/* 展示恢复码（仅一次） */}
          {ui.mode === "showRecovery" && (
            <div className="space-y-3 p-4 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-500/5">
              <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {t("securitySettings.twoFactor.recoveryCodesTitle")}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("securitySettings.twoFactor.recoveryCodesHint")}
              </div>
              <div className="grid grid-cols-2 gap-2 p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 font-mono text-sm text-zinc-800 dark:text-zinc-200">
                {ui.codes.map((c) => (
                  <code key={c}>{c}</code>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyCodes(ui.codes)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" />
                  {t("securitySettings.twoFactor.copyCodes")}
                </button>
                <button
                  type="button"
                  onClick={() => downloadCodes(ui.codes)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"
                >
                  <Download className="w-3 h-3" />
                  {t("securitySettings.twoFactor.downloadCodes")}
                </button>
                <button
                  type="button"
                  onClick={() => setUi({ mode: "idle" })}
                  className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                >
                  {t("securitySettings.twoFactor.cancelButton")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 px-3 py-2 rounded-lg text-sm bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 shadow-lg z-50">
          {toast}
        </div>
      )}
    </section>
  );
}

// ====================================================================
// 会话管理
// ====================================================================
function SessionsSection() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<Array<{
    id: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string | null;
    ip: string;
    userAgent: string;
    deviceLabel: string | null;
    current: boolean;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSessions();
      setSessions(data.sessions);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const revokeOne = async (id: string) => {
    setRevoking(id);
    try {
      await api.revokeSession(id);
      await refresh();
    } finally {
      setRevoking(null);
    }
  };

  const revokeOthers = async () => {
    const others = sessions.filter((s) => !s.current).length;
    if (others === 0) return;
    if (!window.confirm(t("securitySettings.sessions.revokeOthersConfirm", { count: others }))) return;
    await api.revokeOtherSessions(true);
    await refresh();
  };

  const formatUa = (ua: string) => {
    if (!ua) return t("securitySettings.sessions.unknownUa");
    // 粗略提取浏览器+OS，足够识别场景
    const os = /Windows/.test(ua) ? "Windows"
      : /Mac OS/.test(ua) ? "macOS"
      : /Android/.test(ua) ? "Android"
      : /iPhone|iPad/.test(ua) ? "iOS"
      : /Linux/.test(ua) ? "Linux"
      : "";
    const br = /Edg\//.test(ua) ? "Edge"
      : /OPR\//.test(ua) ? "Opera"
      : /Chrome\//.test(ua) ? "Chrome"
      : /Firefox\//.test(ua) ? "Firefox"
      : /Safari\//.test(ua) ? "Safari"
      : "";
    return [br, os].filter(Boolean).join(" · ") || ua.slice(0, 60);
  };

  const others = sessions.filter((s) => !s.current);

  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <LogOut className="w-4 h-4 text-indigo-500" />
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{t("securitySettings.sessions.title")}</h3>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t("securitySettings.sessions.description")}</p>

      <div className="max-w-2xl space-y-2">
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
        ) : sessions.length === 0 ? (
          <p className="text-sm text-zinc-400">{t("securitySettings.sessions.empty")}</p>
        ) : (
          <>
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-3 p-3 rounded-xl border ${
                  s.current
                    ? "border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/40 dark:bg-indigo-500/5"
                    : "border-zinc-200 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-800/30"
                }`}
              >
                <Monitor className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <span className="truncate">{formatUa(s.userAgent)}</span>
                    {s.current && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-600 text-white flex-shrink-0">
                        {t("securitySettings.sessions.current")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {t("securitySettings.sessions.from", { ip: s.ip || "-" })}
                    {" · "}
                    {t("securitySettings.sessions.lastSeen", {
                      time: new Date(s.lastSeenAt).toLocaleString(),
                    })}
                  </div>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    onClick={() => revokeOne(s.id)}
                    disabled={revoking === s.id}
                    className="px-3 py-1 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 border border-red-200 dark:border-red-500/30 disabled:opacity-50"
                  >
                    {revoking === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : t("securitySettings.sessions.revokeButton")}
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={refresh}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                {t("securitySettings.sessions.refresh")}
              </button>
              {others.length > 0 && (
                <button
                  type="button"
                  onClick={revokeOthers}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 border border-red-200 dark:border-red-500/30"
                >
                  {t("securitySettings.sessions.revokeOthers")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
