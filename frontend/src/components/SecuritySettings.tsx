import React, { useCallback, useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  ShieldCheck,
  Key,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  Mail,
  User,
  Smartphone,
  Copy,
  Download,
  LogOut,
  RefreshCw,
  Monitor,
  Lock,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from "lucide-react";
import QRCode from "@/components/ui/QRCode";
import FolderAutoLockSettings from "@/components/FolderAutoLockSettings";
import JournalPrivacySettingsCard from "@/components/settings/JournalPrivacySettingsCard";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "@/lib/dateTime";
import { api, broadcastAuthChanged, withSudo } from "@/lib/api";
import { getAppInfo } from "@/lib/desktopBridge";
import { MOTION_EASE } from "@/lib/motion";
import {
  confirm as confirmDialog,
  prompt as promptDialog,
} from "@/components/ui/confirm";

const SHIELD_BOOP_LINES = [
  "小盾牌正在认真站岗，你的笔记和账号都安安心心 🛡️",
  "开启两步验证 + 定期检查登录设备，安全感直接拉满 ✨",
  "改完密码后，其他标签页会自动同步刷新登录态哦 🔑",
];

/**
 * 顶层组件：组合账号/密码修改 + 2FA + 私密锁 + 会话管理四个区块。
 *
 * v15：体验账号（user.isDemo === true）隐藏“修改账号密码”和“两步验证”两个区块，
 * 只保留“会话管理”，同时在顶部给出提示。
 */
export default function SecuritySettings() {
  const { t } = useTranslation();
  const [isDemo, setIsDemo] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [isFullLocalDesktop, setIsFullLocalDesktop] = useState(false);
  const [boopIndex, setBoopIndex] = useState<number | null>(null);
  const prevUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    getAppInfo().then((info) => {
      setIsFullLocalDesktop(info?.mode === "full" && info?.runtime === "local");
    }).catch(() => {});
  }, []);

  // 拉取当前用户信息：mount 时 + token 变化时重新拉取，
  // 防止切换账号后 SettingsModal 未卸载导致子组件保留旧用户数据。
  const fetchUser = useCallback(() => {
    let cancelled = false;
    api
      .getMe()
      .then((u) => {
        if (cancelled) return;
        setIsDemo(!!(u as any)?.isDemo);
        setCurrentUserId(u.id);
        setCurrentUsername(u.username);
        prevUserIdRef.current = u.id;
      })
      .catch(() => {
        if (!cancelled) {
          setIsDemo(false);
          setCurrentUserId(null);
          setCurrentUsername(null);
          prevUserIdRef.current = null;
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => fetchUser(), [fetchUser]);

  // 监听 token 变化（同 tab 登录/登出 + 跨 tab 同步）
  useEffect(() => {
    const onTokenChanged = () => { fetchUser(); };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "nowen-token") fetchUser();
    };
    window.addEventListener("nowen:token-changed", onTokenChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("nowen:token-changed", onTokenChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [fetchUser]);

  // 监听 storage 事件：当其他 tab 登出/登入时，当前 tab 的 token 变了，
  // 需要重新拉取用户信息。否则 SettingsModal 没有 remount，SecuritySettings
  // 的 useEffect([], []) 不会重新执行。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "nowen-token") {
        const newToken = e.newValue;
        if (newToken) {
          api.getMe().then((u) => {
            setIsDemo(!!(u as any)?.isDemo);
            setCurrentUserId(u.id);
            setCurrentUsername(u.username);
            prevUserIdRef.current = u.id;
          }).catch(() => {});
        } else {
          // token 被清除（登出），重置状态
          setIsDemo(false);
          setCurrentUserId(null);
          setCurrentUsername(null);
          prevUserIdRef.current = null;
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const isManagedDesktop = isFullLocalDesktop && currentUsername === "desktop";

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-6">
      {/* 俏皮安全小管家概览条 + 快捷跳转 */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: MOTION_EASE.enter }}
        className="relative max-w-2xl overflow-hidden rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/[0.06] via-app-elevated/90 to-indigo-500/[0.06] p-4 shadow-xs backdrop-blur-sm"
      >
        <div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-rose-400/15 blur-2xl" />
        <div className="relative flex flex-wrap items-center gap-3.5">
          <motion.button
            type="button"
            whileHover={{ rotate: [0, -10, 10, -4, 0], scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            onClick={() => setBoopIndex((prev) => (prev === null ? 0 : (prev + 1) % SHIELD_BOOP_LINES.length))}
            title="点一下小盾牌"
            className="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 via-pink-500 to-indigo-500 text-white shadow-md shadow-rose-500/20"
          >
            <ShieldCheck size={21} />
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-300 text-amber-800 shadow-xs">
              <Sparkles size={8} />
            </span>
          </motion.button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-tx-primary">安全小管家</span>
              {currentUsername && (
                <span className="inline-flex items-center rounded-full border border-rose-500/20 bg-rose-500/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-rose-600 dark:text-rose-300">
                  @{currentUsername}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-tx-secondary">
              {boopIndex !== null
                ? SHIELD_BOOP_LINES[boopIndex]
                : "密码、两步验证、私密锁与登录设备都在这里统一守护 ✨"}
            </p>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
          {!isDemo && !isManagedDesktop && (
            <>
              <button
                type="button"
                onClick={() => scrollToSection("security-password")}
                className="rounded-full border border-app-border/75 bg-app-surface/85 px-3 py-1 text-[11px] font-medium text-tx-secondary transition-all hover:border-rose-400/40 hover:text-rose-600 active:scale-95 dark:hover:text-rose-300"
              >
                资料与密码
              </button>
              <button
                type="button"
                onClick={() => scrollToSection("security-2fa")}
                className="rounded-full border border-app-border/75 bg-app-surface/85 px-3 py-1 text-[11px] font-medium text-tx-secondary transition-all hover:border-violet-400/40 hover:text-violet-600 active:scale-95 dark:hover:text-violet-300"
              >
                两步验证
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => scrollToSection("security-folder-lock")}
            className="rounded-full border border-app-border/75 bg-app-surface/85 px-3 py-1 text-[11px] font-medium text-tx-secondary transition-all hover:border-amber-400/40 hover:text-amber-600 active:scale-95 dark:hover:text-amber-300"
          >
            文件夹锁
          </button>
          <button
            type="button"
            onClick={() => scrollToSection("security-journal-privacy")}
            className="rounded-full border border-app-border/75 bg-app-surface/85 px-3 py-1 text-[11px] font-medium text-tx-secondary transition-all hover:border-emerald-400/40 hover:text-emerald-600 active:scale-95 dark:hover:text-emerald-300"
          >
            日记隐私锁
          </button>
          <button
            type="button"
            onClick={() => scrollToSection("security-sessions")}
            className="rounded-full border border-app-border/75 bg-app-surface/85 px-3 py-1 text-[11px] font-medium text-tx-secondary transition-all hover:border-sky-400/40 hover:text-sky-600 active:scale-95 dark:hover:text-sky-300"
          >
            登录设备
          </button>
        </div>
      </motion.div>

      {isDemo && (
        <div className="flex max-w-2xl items-start gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/[0.08] px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
          <div>
            {t(
              "securitySettings.demoLocked",
              { defaultValue: "体验账号不允许修改账号密码、用户名或启用两步验证。如需完整体验，请注册个人账号。" },
            )}
          </div>
        </div>
      )}
      {isManagedDesktop && (
        <div className="flex max-w-2xl items-start gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/[0.08] px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
          <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
          <div>
            此 desktop 账号由本机自动登录凭据托管，不能在这里修改密码或用户名；自动登录不是应用密码锁。如需恢复本地账号，请先核对「数据管理 → 本地数据位置」，再使用「恢复本地自动登录」。
            {currentUserId && <div className="mt-1 break-all font-mono text-xs">当前账号：desktop · ID {currentUserId}</div>}
          </div>
        </div>
      )}

      {/* 用 key={currentUserId} 强制子组件在用户切换时完全 remount，清除所有旧状态 */}
      {!isDemo && !isManagedDesktop && <PasswordSection key={`pwd-${currentUserId}`} />}
      {!isDemo && !isManagedDesktop && <TwoFactorSection key={`2fa-${currentUserId}`} />}
      <FolderAutoLockSettings key={`folder-lock-${currentUserId}`} />
      <JournalPrivacySettingsCard key={`journal-privacy-${currentUserId}`} />
      <SessionsSection key={`sess-${currentUserId}`} />
    </div>
  );
}

// ====================================================================
// 账号与密码修改（使用 api.updateSecurity + broadcastAuthChanged）
// ====================================================================
function PasswordSection() {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [originalDisplayName, setOriginalDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [successLabel, setSuccessLabel] = useState("");
  const [shake, setShake] = useState(false);

  const loadProfile = useCallback(() => {
    let cancelled = false;
    api.getMe().then((user) => {
      if (cancelled) return;
      const nextEmail = user.email || "";
      const nextDisplayName = user.displayName || "";
      setEmail(nextEmail);
      setDisplayName(nextDisplayName);
      setOriginalEmail(nextEmail);
      setOriginalDisplayName(nextDisplayName);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => loadProfile(), [loadProfile]);

  const triggerShake = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const passwordStrength = !newPassword
    ? null
    : newPassword.length < 6
      ? { label: "再多加几位更稳妥", cls: "bg-rose-500/12 text-rose-600 dark:text-rose-300" }
      : newPassword.length >= 10 && /[A-Za-z]/.test(newPassword) && /\d/.test(newPassword)
        ? { label: "超稳固 🛡️", cls: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300" }
        : { label: "不错哦 ✨", cls: "bg-sky-500/12 text-sky-600 dark:text-sky-300" };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!currentPassword) {
      return triggerShake(t("securitySettings.currentPasswordRequired"));
    }
    const trimmedEmail = email.trim();
    const trimmedDisplayName = displayName.trim();
    const emailChanged = trimmedEmail !== originalEmail;
    const displayNameChanged = trimmedDisplayName !== originalDisplayName;

    if (!newPassword && !newUsername.trim() && !emailChanged && !displayNameChanged) {
      return triggerShake(t("securitySettings.noChanges"));
    }
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return triggerShake(t("securitySettings.emailInvalid"));
    }
    if (newPassword && newPassword.length < 6) {
      return triggerShake(t("securitySettings.passwordTooShort"));
    }
    if (newPassword && newPassword !== confirmPassword) {
      return triggerShake(t("securitySettings.passwordNotMatch"));
    }

    setIsLoading(true);
    try {
      const changedPassword = !!newPassword;
      // api.updateSecurity 会自动把新 token 写回 localStorage（后端改密会 bump tokenVersion）
      await api.updateSecurity({
        currentPassword,
        newUsername: newUsername.trim() || undefined,
        newEmail: emailChanged ? (trimmedEmail || null) : undefined,
        newDisplayName: displayNameChanged ? (trimmedDisplayName || null) : undefined,
        newPassword: newPassword || undefined,
      });
      // 改密后清掉"记住密码/自动登录"和快速登录旧 token，避免旧密码反复尝试
      if (changedPassword) {
        void import("@/lib/rememberLogin").then((m) => m.clearRememberedCredentials()).catch(() => {});
        void import("@/lib/quickLogin").then((m) => m.disableQuickLogin()).catch(() => {});
      }
      setSuccessLabel(changedPassword ? t("securitySettings.successMessage") : t("securitySettings.profileUpdated"));
      setSuccess(true);
      setCurrentPassword("");
      setNewUsername("");
      setNewPassword("");
      setConfirmPassword("");
      if (changedPassword) {
        setTimeout(() => {
          // 改密成功 → 通知其他 tab 重新登录，当前 tab 保持登录态 reload
          broadcastAuthChanged("password_changed");
          window.location.reload();
        }, 1200);
      } else {
        loadProfile();
        broadcastAuthChanged("profile_changed");
        setTimeout(() => setSuccess(false), 1200);
      }
    } catch (err: any) {
      triggerShake(err?.message || t("securitySettings.updateFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const inputBaseClass = "block w-full rounded-xl border border-app-border/80 bg-app-surface/95 py-2.5 pl-10 text-sm text-tx-primary placeholder:text-tx-tertiary transition-all focus:border-accent-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/15";

  return (
    <section
      id="security-password"
      className="max-w-2xl rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-5 flex items-start gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.4 }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500/20 via-pink-400/18 to-indigo-500/20 text-rose-600 ring-1 ring-rose-500/20 dark:text-rose-300"
        >
          <Shield className="h-5 w-5" />
        </motion.span>
        <div>
          <h3 className="text-base font-bold tracking-tight text-tx-primary">{t("securitySettings.title")}</h3>
          <p className="mt-0.5 text-xs leading-5 text-tx-secondary">{t("securitySettings.description")}</p>
        </div>
      </div>

      <motion.form
        onSubmit={handleSubmit}
        className="space-y-4"
        animate={shake ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : { x: 0 }}
        transition={shake ? { duration: 0.5 } : {}}
      >
        {/* 当前密码验证区 */}
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/[0.05] p-3.5 space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-tx-primary">
            {t("securitySettings.currentPassword")} <span className="text-rose-500">*</span>
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
              <Key className="h-4 w-4 text-amber-500 dark:text-amber-400" />
            </div>
            <input
              type={showCurrentPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={`${inputBaseClass} pr-10 ${
                error && !currentPassword ? "border-rose-500/60" : ""
              }`}
              placeholder={t("securitySettings.currentPasswordPlaceholder")}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-tx-tertiary transition-colors hover:text-tx-primary"
            >
              {showCurrentPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {/* 资料双栏网格 */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {/* 新用户名 */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-tx-secondary">{t("securitySettings.newUsername")}</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                <User className="h-4 w-4 text-sky-500/80 dark:text-sky-400" />
              </div>
              <input
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className={`${inputBaseClass} pr-3`}
                placeholder={t("securitySettings.newUsernamePlaceholder")}
                autoComplete="username"
              />
            </div>
          </div>

          {/* 昵称 */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-tx-secondary">{t("securitySettings.displayName")}</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                <User className="h-4 w-4 text-violet-500/80 dark:text-violet-400" />
              </div>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={`${inputBaseClass} pr-3`}
                placeholder={t("securitySettings.displayNamePlaceholder")}
                autoComplete="nickname"
              />
            </div>
          </div>

          {/* 邮箱（跨两列） */}
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-semibold text-tx-secondary">{t("securitySettings.email")}</label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                <Mail className="h-4 w-4 text-emerald-500/80 dark:text-emerald-400" />
              </div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${inputBaseClass} pr-3`}
                placeholder={t("securitySettings.emailPlaceholder")}
                autoComplete="email"
              />
            </div>
          </div>

          {/* 新密码 */}
          <div className={`space-y-1.5 ${newPassword ? "" : "sm:col-span-2"}`}>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold text-tx-secondary">{t("securitySettings.newPassword")}</label>
              {passwordStrength && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${passwordStrength.cls}`}>
                  {passwordStrength.label}
                </span>
              )}
            </div>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                <Key className="h-4 w-4 text-rose-500/80 dark:text-rose-400" />
              </div>
              <input
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={`${inputBaseClass} pr-10`}
                placeholder={t("securitySettings.newPasswordPlaceholder")}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-tx-tertiary transition-colors hover:text-tx-primary"
              >
                {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {/* 确认新密码 */}
          <AnimatePresence>
            {newPassword && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="space-y-1.5"
              >
                <label className="text-xs font-semibold text-tx-secondary">{t("securitySettings.confirmPassword")}</label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5">
                    <Key className="h-4 w-4 text-rose-500/80 dark:text-rose-400" />
                  </div>
                  <input
                    type={showNewPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={`${inputBaseClass} pr-3 ${
                      confirmPassword && newPassword !== confirmPassword ? "border-rose-500/60" : ""
                    }`}
                    placeholder={t("securitySettings.confirmPasswordPlaceholder")}
                    autoComplete="new-password"
                    required={!!newPassword}
                  />
                </div>
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className="text-xs text-rose-500 dark:text-rose-400">{t("securitySettings.passwordMismatch")}</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5"
            >
              <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-rose-500" />
              <p className="text-xs font-medium text-rose-600 dark:text-rose-300">{error}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex justify-end pt-1">
          <motion.button
            type="submit"
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            disabled={isLoading || success}
            className={`inline-flex items-center justify-center rounded-xl px-5 py-2.5 text-xs font-semibold text-white shadow-sm transition-all ${
              success
                ? "bg-emerald-500 shadow-emerald-500/20"
                : "bg-gradient-to-r from-rose-500 via-pink-500 to-indigo-500 shadow-rose-500/20 hover:brightness-105"
            } disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent-primary focus:ring-offset-2`}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : success ? (
              <>
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                {successLabel || t("securitySettings.profileUpdated")}
              </>
            ) : (
              <>
                <Key className="mr-1.5 h-3.5 w-3.5" />
                {t("securitySettings.saveButton")}
              </>
            )}
          </motion.button>
        </div>
      </motion.form>
    </section>
  );
}

// ====================================================================
// 两步验证 (2FA)
// ====================================================================
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
  const [showSecret, setShowSecret] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
      // 清空所有敏感状态
      setShowSecret(false);
      setShowAdvanced(false);
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
        () =>
          promptDialog({
            title: t("securitySettings.twoFactor.disableHint"),
            type: "password",
            placeholder: t("securitySettings.currentPasswordPlaceholder"),
          }),
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
        () =>
          promptDialog({
            title: t("securitySettings.twoFactor.regenerateHint"),
            description: t("securitySettings.currentPasswordPlaceholder"),
            type: "password",
            placeholder: t("securitySettings.currentPasswordPlaceholder"),
          }),
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
    <section
      id="security-2fa"
      className="max-w-2xl rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-4 flex items-start gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.4 }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/20 via-indigo-400/18 to-sky-500/20 text-violet-600 ring-1 ring-violet-500/25 dark:text-violet-300"
        >
          <Smartphone className="h-5 w-5" />
        </motion.span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-bold tracking-tight text-tx-primary">{t("securitySettings.twoFactor.title")}</h3>
            {!loading && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                  status?.enabled
                    ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                    : "bg-app-hover text-tx-tertiary"
                }`}
              >
                {status?.enabled && (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                )}
                {status?.enabled ? "已开启" : "未开启"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-tx-secondary">
            {status?.enabled
              ? t("securitySettings.twoFactor.descriptionEnabled")
              : t("securitySettings.twoFactor.descriptionDisabled")}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="h-16 animate-pulse rounded-xl bg-app-hover/65" />
      ) : (
        <div className="space-y-3.5">
          {/* 状态区 */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5">
            <div className="min-w-0 text-xs">
              <div className="font-semibold text-tx-primary">
                {status?.enabled
                  ? t("securitySettings.twoFactor.enabledAt", { date: status.enabledAt ? formatAppDateTime(status.enabledAt, undefined, "-") : "-" })
                  : t("securitySettings.twoFactor.descriptionDisabled")}
              </div>
              {status?.enabled && (
                <div className="mt-1 text-[11px] text-tx-tertiary">
                  {t("securitySettings.twoFactor.recoveryRemaining", { count: status.recoveryCodesRemaining })}
                </div>
              )}
            </div>
            {status?.enabled ? (
              <button
                type="button"
                onClick={() => setUi({ mode: "disabling", code: "", error: "", busy: false })}
                className="shrink-0 whitespace-nowrap rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-600 transition-all hover:bg-rose-500/18 active:scale-95 dark:text-rose-300"
              >
                {t("securitySettings.twoFactor.disableButton")}
              </button>
            ) : (
              <button
                type="button"
                onClick={startSetup}
                className="shrink-0 whitespace-nowrap rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-3.5 py-2 text-xs font-semibold text-white shadow-xs shadow-violet-500/20 transition-all hover:brightness-105 active:scale-95"
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
              className="rounded-xl px-2.5 py-1 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-500/10 dark:text-violet-300"
            >
              {t("securitySettings.twoFactor.regenerateCodes")}
            </button>
          )}

          {/* setup 状态：展示二维码 + 密钥 + 输入 6 位码 */}
          {ui.mode === "setup" && (
            <div className="space-y-4 rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.06] to-sky-500/[0.04] p-4">
              <div className="text-sm font-bold text-tx-primary">
                {t("securitySettings.twoFactor.setupTitle")}
              </div>
              <div className="text-xs text-tx-secondary">
                {t("securitySettings.twoFactor.setupHint")}
              </div>

              {/* 二维码 */}
              <div className="flex justify-center">
                <div className="rounded-2xl border border-app-border bg-white p-3.5 shadow-sm">
                  <QRCode value={ui.otpauthUri} size={180} />
                </div>
              </div>

              {/* 手动输入密钥区域 */}
              <div className="space-y-2">
                <div className="text-center text-xs text-tx-tertiary">
                  {t("securitySettings.twoFactor.cannotScan", { defaultValue: "无法扫码？" })}
                </div>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(ui.secret);
                      showToast(t("securitySettings.twoFactor.secretCopied", { defaultValue: "密钥已复制" }));
                    }}
                    className="flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                  >
                    <Copy className="h-3 w-3" />
                    {t("securitySettings.twoFactor.copySecret", { defaultValue: "复制密钥" })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                  >
                    {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {showSecret
                      ? t("securitySettings.twoFactor.hideSecret", { defaultValue: "隐藏密钥" })
                      : t("securitySettings.twoFactor.showSecret", { defaultValue: "显示密钥" })}
                  </button>
                </div>
                {showSecret && (
                  <code className="block select-all rounded-xl border border-app-border bg-app-surface px-3 py-2 text-center font-mono text-sm tracking-widest text-tx-primary">
                    {ui.secret}
                  </code>
                )}
              </div>

              {/* 高级选项：otpauth URI */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-xs text-tx-tertiary transition-colors hover:text-tx-primary"
                >
                  {showAdvanced ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {t("securitySettings.twoFactor.advancedSettings", { defaultValue: "高级设置" })}
                </button>
                {showAdvanced && (
                  <div className="mt-2 space-y-2">
                    <div className="text-xs text-tx-tertiary">{t("securitySettings.twoFactor.otpauthUri")}</div>
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={ui.otpauthUri}
                        className="flex-1 truncate rounded-xl border border-app-border bg-app-surface px-2.5 py-1.5 font-mono text-xs text-tx-secondary"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(ui.otpauthUri);
                          showToast(t("securitySettings.twoFactor.uriCopied", { defaultValue: "URI 已复制" }));
                        }}
                        className="rounded-xl p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 输入 6 位码 */}
              <div>
                <div className="mb-1.5 text-xs font-medium text-tx-secondary">{t("securitySettings.twoFactor.activateLabel")}</div>
                <input
                  value={ui.code}
                  onChange={(e) => setUi({ ...ui, code: e.target.value })}
                  placeholder="123456"
                  inputMode="numeric"
                  maxLength={6}
                  className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2.5 text-center font-mono text-lg tracking-[0.4em] text-tx-primary outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/15"
                  autoFocus
                />
                {ui.error && <p className="mt-1.5 text-xs text-rose-500">{ui.error}</p>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={activate}
                  disabled={ui.busy || !/^\d{6}$/.test(ui.code.trim())}
                  className="flex-1 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-3 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:brightness-105 disabled:opacity-50"
                >
                  {ui.busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : t("securitySettings.twoFactor.activateButton")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUi({ mode: "idle" });
                    setShowSecret(false);
                    setShowAdvanced(false);
                  }}
                  className="rounded-xl px-3.5 py-2 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
                >
                  {t("securitySettings.twoFactor.cancelButton")}
                </button>
              </div>
            </div>
          )}

          {/* disabling：请求输入 code */}
          {ui.mode === "disabling" && (
            <div className="space-y-3 rounded-2xl border border-rose-500/30 bg-rose-500/[0.06] p-4">
              <div className="text-sm font-bold text-tx-primary">{t("securitySettings.twoFactor.disableTitle")}</div>
              <div className="text-xs text-tx-secondary">{t("securitySettings.twoFactor.disableHint")}</div>
              <input
                value={ui.code}
                onChange={(e) => setUi({ ...ui, code: e.target.value })}
                placeholder="123456"
                className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-center font-mono tracking-[0.3em] text-tx-primary outline-none focus:border-rose-500"
              />
              {ui.error && <p className="text-xs text-rose-500">{ui.error}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={disable}
                  disabled={ui.busy || !ui.code.trim()}
                  className="rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                >
                  {ui.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : t("securitySettings.twoFactor.disableButton")}
                </button>
                <button
                  type="button"
                  onClick={() => setUi({ mode: "idle" })}
                  className="rounded-xl px-3 py-2 text-xs font-medium text-tx-secondary hover:bg-app-hover"
                >
                  {t("securitySettings.twoFactor.cancelButton")}
                </button>
              </div>
            </div>
          )}

          {/* 展示恢复码（仅一次） */}
          {ui.mode === "showRecovery" && (
            <div className="space-y-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4">
              <div className="text-sm font-bold text-tx-primary">
                {t("securitySettings.twoFactor.recoveryCodesTitle")}
              </div>
              <div className="text-xs text-tx-secondary">
                {t("securitySettings.twoFactor.recoveryCodesHint")}
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-app-border bg-app-surface p-3 font-mono text-xs text-tx-primary">
                {ui.codes.map((c) => (
                  <code key={c} className="rounded-lg bg-app-hover/65 px-2 py-1 text-center">{c}</code>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyCodes(ui.codes)}
                  className="flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-medium text-tx-primary transition-colors hover:bg-app-hover"
                >
                  <Copy className="h-3 w-3" />
                  {t("securitySettings.twoFactor.copyCodes")}
                </button>
                <button
                  type="button"
                  onClick={() => downloadCodes(ui.codes)}
                  className="flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-medium text-tx-primary transition-colors hover:bg-app-hover"
                >
                  <Download className="h-3 w-3" />
                  {t("securitySettings.twoFactor.downloadCodes")}
                </button>
                <button
                  type="button"
                  onClick={() => setUi({ mode: "idle" })}
                  className="ml-auto rounded-xl px-3 py-1.5 text-xs font-medium text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                >
                  {t("securitySettings.twoFactor.cancelButton")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl bg-zinc-900 px-3.5 py-2 text-xs font-medium text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
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
    const ok = await confirmDialog({
      title: t("securitySettings.sessions.revokeOthersConfirm", { count: others }),
      danger: true,
    });
    if (!ok) return;
    await api.revokeOtherSessions(true);
    await refresh();
  };

  const formatUa = (ua: string) => {
    if (!ua) return t("securitySettings.sessions.unknownUa", { defaultValue: "来源未知" });
    // 桌面客户端特殊处理
    if (/Nowen.*Desktop/i.test(ua)) {
      const os = /Windows/.test(ua) ? "Windows"
        : /Mac OS/.test(ua) ? "macOS"
        : /Linux/.test(ua) ? "Linux"
        : "";
      return os ? `Nowen Note · ${os}` : "Nowen Note";
    }
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
    <section
      id="security-sessions"
      className="max-w-2xl rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm transition-shadow hover:shadow-md"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <motion.span
            whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
            transition={{ duration: 0.4 }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 via-cyan-400/18 to-indigo-500/20 text-sky-600 ring-1 ring-sky-500/25 dark:text-sky-300"
          >
            <LogOut className="h-5 w-5" />
          </motion.span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold tracking-tight text-tx-primary">{t("securitySettings.sessions.title")}</h3>
              {!loading && (
                <span className="inline-flex items-center rounded-full bg-sky-500/12 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-sky-700 dark:text-sky-300">
                  {sessions.length} 台设备
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-tx-secondary">{t("securitySettings.sessions.description")}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="group inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface/90 px-3 py-1.5 text-xs font-medium text-tx-secondary transition-colors hover:border-sky-400/40 hover:text-tx-primary active:scale-95"
        >
          <RefreshCw className="h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-180" />
          {t("securitySettings.sessions.refresh")}
        </button>
      </div>

      <div className="space-y-2.5">
        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((idx) => (
              <div key={idx} className="h-16 animate-pulse rounded-xl bg-app-hover/65" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-app-border px-4 py-6 text-center text-xs text-tx-tertiary">
            {t("securitySettings.sessions.empty")}
          </p>
        ) : (
          <>
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-3 rounded-xl border p-3.5 transition-all ${
                  s.current
                    ? "border-sky-400/35 bg-gradient-to-r from-sky-500/[0.08] via-app-surface to-indigo-500/[0.06] shadow-xs"
                    : "border-app-border/75 bg-app-surface/90 hover:border-app-border hover:bg-app-surface"
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    s.current
                      ? "bg-sky-500/14 text-sky-600 dark:text-sky-300"
                      : "bg-app-hover text-tx-tertiary"
                  }`}
                >
                  <Monitor className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs font-semibold text-tx-primary sm:text-sm">
                    <span className="truncate">{formatUa(s.userAgent)}</span>
                    {s.current && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/14 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {t("securitySettings.sessions.current")}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-tx-tertiary tabular-nums">
                    {t("securitySettings.sessions.from", { ip: s.ip || t("securitySettings.sessions.unknownIp", { defaultValue: "来源未知" }) })}
                    {" · "}
                    {t("securitySettings.sessions.lastSeen", {
                      time: formatAppDateTime(s.lastSeenAt),
                    })}
                  </div>
                </div>
                {!s.current && (
                  <button
                    type="button"
                    onClick={() => revokeOne(s.id)}
                    disabled={revoking === s.id}
                    className="shrink-0 whitespace-nowrap rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-600 transition-all hover:bg-rose-500/18 active:scale-95 disabled:opacity-50 dark:text-rose-300"
                  >
                    {revoking === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : t("securitySettings.sessions.revokeButton")}
                  </button>
                )}
              </div>
            ))}
            {others.length > 0 && (
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={revokeOthers}
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-600 transition-all hover:bg-rose-500/18 active:scale-95 dark:text-rose-300"
                >
                  {t("securitySettings.sessions.revokeOthers")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
