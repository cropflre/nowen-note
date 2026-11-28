import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, Plus, Search, Loader2, Trash2, KeyRound, ShieldCheck, Shield,
  UserCheck, UserX, X, Save, Lock,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { User } from "@/types";
import { toast } from "@/lib/toast";
import { formatServerTime } from "@/lib/dateTime";
import AdminWebUiSetting from "@/components/settings/AdminWebUiSetting";

type StatusFilter = "all" | "active" | "disabled";
type RoleFilter = "all" | "admin" | "user";

interface EditState {
  user: User;
  username: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  // 个人空间导入/导出开关（schema v6 起为 per-user 字段）。
  // 这两个字段非高危：PATCH 不需 sudo、不会 bump tokenVersion 踢人下线。
  // 字段在 User 上是 optional（旧版本服务端可能不返回），打开编辑弹窗时按 true 兜底，
  // 这样：
  //   - 后端旧版返回 undefined → 表现为"开"（向后兼容默认放行）
  //   - 后端新版返回 false → 表现为"关"
  // 用户主动 toggle 后，diff 与原值对比再决定是否写入 patch。
  personalExportEnabled: boolean;
  personalImportEnabled: boolean;
}

interface ResetPwdState {
  user: User;
  password: string;
  confirm: string;
}

interface CreateState {
  username: string;
  password: string;
  confirm: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
}

const emptyCreateState: CreateState = {
  username: "",
  password: "",
  confirm: "",
  email: "",
  displayName: "",
  role: "user",
};

export default function UserManagement({ currentUserId }: { currentUserId: string | null }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [allowRegistration, setAllowRegistration] = useState<boolean>(true);
  const [togglingRegistration, setTogglingRegistration] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<CreateState>(emptyCreateState);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");

  const [edit, setEdit] = useState<EditState | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");

  const [resetPwd, setResetPwd] = useState<ResetPwdState | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetError, setResetError] = useState("");

  // L3: 删除用户 — 带数据归属选项的确认弹窗
  //
  //   - 打开时拉 /users/:id/data-summary 展示"将影响的内容量"；
  //   - 默认"一并删除所有数据"（保持原语义）；可切换到"转移给其他用户"，弹出用户选择；
  //   - 转移模式下必须选定一个活跃用户，再调 adminDeleteUser(id, sudo, transferTo)。
  interface DeleteDialogState {
    user: User;
    summary: Awaited<ReturnType<typeof api.adminGetUserDataSummary>> | null;
    loadingSummary: boolean;
    mode: "cascade" | "transfer";
    transferToId: string;
    submitting: boolean;
    error: string;
  }
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);

  // H2: sudo 二次验证
  //
  // 策略：
  //   - 同一 tab 内缓存 sudoToken（内存），避免连续操作多个用户每次都弹密码框；
  //   - 后端 ttl=5 分钟；前端不自己倒计时，若 token 过期/失效，业务请求会返回
  //     code=SUDO_INVALID，runWithSudo 检测到后自动清缓存并重新弹密码框；
  //   - sudoToken 仅放内存（useRef），不写 localStorage，防止 XSS 窃取。
  const sudoTokenRef = useRef<string | null>(null);
  const [sudoAsk, setSudoAsk] = useState<{
    resolve: (token: string | null) => void;
    reason: string;
  } | null>(null);
  const [sudoPwd, setSudoPwd] = useState("");
  const [sudoError, setSudoError] = useState("");
  const [sudoSubmitting, setSudoSubmitting] = useState(false);

  /** 打开 sudo Modal，让用户输密码 → 直接换到 sudoToken 后 resolve（只请求一次后端）。 */
  const askSudoToken = useCallback(
    (reason: string) =>
      new Promise<string | null>((resolve) => {
        setSudoPwd("");
        setSudoError("");
        setSudoAsk({ resolve, reason });
      }),
    [],
  );

  /** 封装敏感操作统一调用：优先走缓存 sudoToken，失效/缺失时弹密码框重新获取。 */
  const runWithSudo = useCallback(
    async <T,>(
      reason: string,
      action: (token: string) => Promise<T>,
    ): Promise<T | null> => {
      const tryOnce = async (tk: string) => {
        try {
          return { ok: true as const, data: await action(tk) };
        } catch (e: any) {
          if (e?.code === "SUDO_INVALID" || e?.code === "SUDO_REQUIRED") {
            return { ok: false as const, retry: true, err: e };
          }
          throw e;
        }
      };

      // 1) 先用缓存 token
      if (sudoTokenRef.current) {
        const out = await tryOnce(sudoTokenRef.current);
        if (out.ok) return out.data;
        sudoTokenRef.current = null; // 已过期，清掉
      }

      // 2) 弹密码框换新 token
      const fresh = await askSudoToken(reason);
      if (!fresh) return null;
      sudoTokenRef.current = fresh;

      // 3) 用新 token 执行（不再重试，新 token 刚拿到不该立即失效）
      return action(fresh);
    },
    [askSudoToken],
  );

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.adminListUsers({
        q: search || undefined,
        role: roleFilter === "all" ? undefined : roleFilter,
        status: statusFilter === "all" ? undefined : statusFilter,
      });
      setUsers(list);
    } catch (err: any) {
      toast.error(err.message || t("userManagement.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [search, roleFilter, statusFilter, t]);

  useEffect(() => {
    const timer = setTimeout(fetchUsers, 200);
    return () => clearTimeout(timer);
  }, [fetchUsers]);

  useEffect(() => {
    api
      .getRegisterConfig()
      .then((cfg) => setAllowRegistration(cfg.allowRegistration))
      .catch(() => {});
  }, []);

  const handleToggleRegistration = async () => {
    setTogglingRegistration(true);
    try {
      const cfg = await api.updateRegisterConfig(!allowRegistration);
      setAllowRegistration(cfg.allowRegistration);
      toast.success(cfg.allowRegistration ? t("userManagement.registrationOpened") : t("userManagement.registrationClosed"));
    } catch (err: any) {
      toast.error(err.message || t("userManagement.updateFailed"));
    } finally {
      setTogglingRegistration(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError("");
    if (createForm.password.length < 6) {
      setCreateError(t("userManagement.passwordTooShort"));
      return;
    }
    if (createForm.password !== createForm.confirm) {
      setCreateError(t("userManagement.passwordMismatch"));
      return;
    }
    setCreateLoading(true);
    try {
      const payload = {
        username: createForm.username.trim(),
        password: createForm.password,
        email: createForm.email.trim() || undefined,
        displayName: createForm.displayName.trim() || undefined,
        role: createForm.role,
      };
      // 创建管理员账号需要 sudo，普通用户直接走
      const created =
        createForm.role === "admin"
          ? await runWithSudo(t("userManagement.sudoDesc"), (tk) => api.adminCreateUser(payload, tk))
          : await api.adminCreateUser(payload);
      if (created === null) {
        // 用户取消 sudo
        return;
      }
      toast.success(t("userManagement.createSuccess"));
      setShowCreate(false);
      setCreateForm(emptyCreateState);
      fetchUsers();
    } catch (err: any) {
      setCreateError(err.message || t("userManagement.createFailed"));
    } finally {
      setCreateLoading(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!edit) return;
    setEditError("");
    setEditLoading(true);
    try {
      // 原始 per-user 开关值，缺失按 true 兜底（向后兼容 / 默认放行）
      const origExport = edit.user.personalExportEnabled !== false;
      const origImport = edit.user.personalImportEnabled !== false;
      const patch = {
        username: edit.username.trim() !== edit.user.username ? edit.username.trim() : undefined,
        email: edit.email.trim() !== (edit.user.email || "") ? (edit.email.trim() || null) : undefined,
        displayName:
          edit.displayName.trim() !== (edit.user.displayName || "")
            ? edit.displayName.trim() || null
            : undefined,
        role: edit.role !== edit.user.role ? edit.role : undefined,
        personalExportEnabled:
          edit.personalExportEnabled !== origExport ? edit.personalExportEnabled : undefined,
        personalImportEnabled:
          edit.personalImportEnabled !== origImport ? edit.personalImportEnabled : undefined,
      };
      // 改 role 属于高危字段，需要 sudo；仅改 username/email/displayName/personalExport*Enabled 则无需。
      // personalExport/Import 的开关明确不算高危（不会踢人下线、不影响身份），保持轻流程。
      const needsSudo = patch.role !== undefined;
      const result = needsSudo
        ? await runWithSudo(t("userManagement.sudoDesc"), (tk) =>
            api.adminUpdateUser(edit.user.id, patch, tk),
          )
        : await api.adminUpdateUser(edit.user.id, patch);
      if (result === null) return;
      toast.success(t("userManagement.updateSuccess"));
      setEdit(null);
      fetchUsers();
    } catch (err: any) {
      setEditError(err.message || t("userManagement.updateFailed"));
    } finally {
      setEditLoading(false);
    }
  };

  const handleToggleDisabled = async (u: User) => {
    try {
      // isDisabled 变更属于高危：禁用会立即踢下线所有 session
      const result = await runWithSudo(t("userManagement.sudoDesc"), (tk) =>
        api.adminUpdateUser(u.id, { isDisabled: !u.isDisabled }, tk),
      );
      if (result === null) return;
      toast.success(u.isDisabled ? t("userManagement.enabled") : t("userManagement.disabled"));
      fetchUsers();
    } catch (err: any) {
      toast.error(err.message || t("userManagement.updateFailed"));
    }
  };

  const handleResetPassword = async () => {
    if (!resetPwd) return;
    setResetError("");
    if (resetPwd.password.length < 6) {
      setResetError(t("userManagement.passwordTooShort"));
      return;
    }
    if (resetPwd.password !== resetPwd.confirm) {
      setResetError(t("userManagement.passwordMismatch"));
      return;
    }
    setResetLoading(true);
    try {
      const reset = (tk?: string) => api.adminResetUserPassword(resetPwd.user.id, resetPwd.password, tk);
      let result: { success: boolean } | null;
      try {
        result = await reset();
      } catch (err: any) {
        // 旧版服务端仍要求二次验证：回退到密码弹窗，新客户端连旧服务端时也能重置。
        if (err?.code !== "SUDO_REQUIRED") throw err;
        result = await runWithSudo(t("userManagement.sudoDesc"), reset);
      }
      if (result === null) return;
      toast.success(t("userManagement.passwordResetSuccess"));
      setResetPwd(null);
    } catch (err: any) {
      setResetError(err.message || t("userManagement.updateFailed"));
    } finally {
      setResetLoading(false);
    }
  };

  /**
   * L3 新版删除入口：不再用 window.confirm，改弹自定义 Modal；
   *    先异步拉取 data-summary 展示数据量，再由管理员选择「删掉全部」还是「转移给 XX」。
   */
  const openDeleteDialog = (u: User) => {
    setDeleteDialog({
      user: u,
      summary: null,
      loadingSummary: true,
      mode: "cascade",
      transferToId: "",
      submitting: false,
      error: "",
    });
    api
      .adminGetUserDataSummary(u.id)
      .then((summary) =>
        setDeleteDialog((prev) => (prev && prev.user.id === u.id ? { ...prev, summary, loadingSummary: false } : prev)),
      )
      .catch((err: any) =>
        setDeleteDialog((prev) =>
          prev && prev.user.id === u.id
            ? { ...prev, loadingSummary: false, error: err?.message || t("userManagement.deleteFailed") }
            : prev,
        ),
      );
  };

  const submitDeleteDialog = async () => {
    if (!deleteDialog) return;
    const { user: u, mode, transferToId } = deleteDialog;
    if (mode === "transfer" && !transferToId) {
      setDeleteDialog({ ...deleteDialog, error: t("userManagement.deleteNeedReceiver") });
      return;
    }
    setDeleteDialog({ ...deleteDialog, submitting: true, error: "" });
    try {
      const result = await runWithSudo(t("userManagement.sudoDesc"), (tk) =>
        api.adminDeleteUser(u.id, tk, mode === "transfer" ? transferToId : undefined),
      );
      if (result === null) {
        // 用户取消 sudo
        setDeleteDialog((prev) => (prev ? { ...prev, submitting: false } : prev));
        return;
      }
      toast.success(
        result.transferred
          ? t("userManagement.deleteTransferSuccess", { name: u.username })
          : t("userManagement.deleteSuccess"),
      );
      setDeleteDialog(null);
      fetchUsers();
    } catch (err: any) {
      setDeleteDialog((prev) =>
        prev ? { ...prev, submitting: false, error: err?.message || t("userManagement.deleteFailed") } : prev,
      );
    }
  };

  const filteredCount = useMemo(() => users.length, [users]);

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      {/* 标题 */}
      <div className="relative overflow-hidden rounded-2xl border border-app-border/80 bg-gradient-to-br from-blue-500/[0.08] via-app-elevated/85 to-indigo-500/[0.07] p-5 shadow-xs backdrop-blur-sm">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-blue-400/15 blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <motion.span
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
              transition={{ duration: 0.45 }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500/20 via-indigo-400/18 to-sky-500/20 text-blue-600 shadow-xs ring-1 ring-blue-500/25 dark:text-blue-300"
            >
              <Users className="h-5 w-5" />
            </motion.span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold tracking-tight text-tx-primary">
                  {t("userManagement.title")}
                </h3>
                <span className="rounded-full bg-blue-500/12 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 dark:text-blue-300">
                  {t("userManagement.total", { count: filteredCount })}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">
                {t("userManagement.description")}
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-blue-500/20 transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("userManagement.createUser")}
          </button>
        </div>
      </div>

      {/* 注册开关 */}
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-app-border/80 bg-app-elevated/80 px-4 py-3.5 shadow-xs backdrop-blur-sm transition-colors hover:border-blue-400/40">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-tx-primary">
            {t("userManagement.openRegistration")}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">
            {t("userManagement.openRegistrationDesc")}
          </p>
        </div>
        <button
          onClick={handleToggleRegistration}
          disabled={togglingRegistration}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-all ${
            allowRegistration ? "bg-gradient-to-r from-blue-500 to-indigo-500" : "bg-app-border/90"
          } disabled:opacity-50`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
              allowRegistration ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* 网页端访问：服务器级开关，仅管理员 */}
      <AdminWebUiSetting />

      {/* 过滤 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-0 w-full sm:w-auto sm:min-w-[200px] sm:flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tx-tertiary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("userManagement.searchPlaceholder")}
            className="w-full rounded-2xl border border-app-border/80 bg-app-elevated/85 py-2.5 pl-10 pr-4 text-sm text-tx-primary shadow-xs outline-none backdrop-blur-sm transition-all placeholder:text-tx-tertiary focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
          className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-elevated/85 px-3 py-2.5 text-xs font-medium text-tx-primary outline-none focus:border-blue-400 sm:flex-none"
        >
          <option value="all">{t("userManagement.filterRoleAll")}</option>
          <option value="admin">{t("userManagement.roleAdmin")}</option>
          <option value="user">{t("userManagement.roleUser")}</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-elevated/85 px-3 py-2.5 text-xs font-medium text-tx-primary outline-none focus:border-blue-400 sm:flex-none"
        >
          <option value="all">{t("userManagement.filterStatusAll")}</option>
          <option value="active">{t("userManagement.statusActive")}</option>
          <option value="disabled">{t("userManagement.statusDisabled")}</option>
        </select>
      </div>

      {/* 用户列表（卡片） */}
      <div className="overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated/80 shadow-xs backdrop-blur-sm">
        <div className="sm:max-h-[52vh] sm:overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-tx-tertiary">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <span className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500">
                <Users className="h-5 w-5" />
              </span>
              <span className="text-sm font-medium text-tx-secondary">
                {t("userManagement.noResult")}
              </span>
            </div>
          ) : (
            <ul className="divide-y divide-app-border/60">
              {users.map((u) => {
                const isSelf = u.id === currentUserId;
                return (
                  <li
                    key={u.id}
                    className="px-3.5 py-3 transition-colors hover:bg-blue-500/[0.04] sm:px-4 sm:py-3.5"
                  >
                    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1 sm:flex sm:items-start sm:gap-3.5">
                      {/* 头像 */}
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-500 text-sm font-bold text-white shadow-xs">
                        {u.avatarUrl ? (
                          <img src={u.avatarUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          (u.displayName || u.username).charAt(0).toUpperCase()
                        )}
                      </div>

                      {/* 主信息 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-bold text-tx-primary">
                            {u.displayName || u.username}
                          </span>
                          {isSelf && (
                            <span className="rounded-full bg-blue-500/12 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-300">
                              {t("userManagement.you")}
                            </span>
                          )}
                          {u.role === "admin" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/12 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300">
                              <ShieldCheck className="h-3 w-3" />
                              {t("userManagement.roleAdmin")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2 py-0.5 text-[10px] font-medium text-tx-secondary ring-1 ring-app-border/60">
                              <Shield className="h-3 w-3" />
                              {t("userManagement.roleUser")}
                            </span>
                          )}
                          {u.isDisabled ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/12 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                              <UserX className="h-3 w-3" />
                              {t("userManagement.statusDisabled")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                              <UserCheck className="h-3 w-3" />
                              {t("userManagement.statusActive")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-tx-secondary">
                          @{u.username}
                          {u.email && ` · ${u.email}`}
                        </div>
                        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tx-tertiary">
                          <span className="rounded-full bg-app-surface px-2 py-0.5 font-medium text-tx-secondary ring-1 ring-app-border/50">
                            {t("userManagement.colNotes")}: {u.noteCount ?? 0}
                          </span>
                          <span className="truncate">
                            {t("userManagement.colLastLogin")}:{" "}
                            {formatServerTime(u.lastLoginAt, undefined, "—")}
                          </span>
                        </div>
                      </div>

                      {/* 操作按钮 */}
                      <div className="col-start-2 flex shrink-0 items-center justify-end gap-1">
                        <button
                          onClick={() =>
                            setEdit({
                              user: u,
                              username: u.username,
                              email: u.email || "",
                              displayName: u.displayName || "",
                              role: (u.role as "admin" | "user") || "user",
                              // 后端缺字段（旧版本）按 true 兜底；只要不是显式 false 就视为"开"
                              personalExportEnabled: u.personalExportEnabled !== false,
                              personalImportEnabled: u.personalImportEnabled !== false,
                            })
                          }
                          className="rounded-xl p-2 text-tx-secondary transition-all hover:bg-blue-500/12 hover:text-blue-600 dark:hover:text-blue-300"
                          title={t("userManagement.edit")}
                        >
                          <Save className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setResetPwd({ user: u, password: "", confirm: "" })}
                          disabled={isSelf}
                          className="rounded-xl p-2 text-tx-secondary transition-all hover:bg-amber-500/12 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-amber-300"
                          title={t("userManagement.resetPassword")}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleToggleDisabled(u)}
                          disabled={isSelf}
                          className="rounded-xl p-2 text-tx-secondary transition-all hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
                          title={u.isDisabled ? t("userManagement.enable") : t("userManagement.disable")}
                        >
                          {u.isDisabled ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          onClick={() => openDeleteDialog(u)}
                          disabled={isSelf}
                          className="rounded-xl p-2 text-tx-secondary transition-all hover:bg-rose-500/12 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
                          title={t("userManagement.delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* 创建用户 */}
      <AnimatePresence>
        {showCreate && (
          <Modal onClose={() => setShowCreate(false)} title={t("userManagement.createUser")}>
            <form onSubmit={handleCreateUser} className="space-y-3">
              <FieldInput
                label={t("userManagement.fieldUsername")}
                value={createForm.username}
                onChange={(v) => setCreateForm((s) => ({ ...s, username: v }))}
                placeholder="e.g. alice"
                required
              />
              <FieldInput
                label={t("userManagement.fieldDisplayName")}
                value={createForm.displayName}
                onChange={(v) => setCreateForm((s) => ({ ...s, displayName: v }))}
              />
              <FieldInput
                label={t("userManagement.fieldEmail")}
                value={createForm.email}
                onChange={(v) => setCreateForm((s) => ({ ...s, email: v }))}
                type="email"
              />
              <FieldInput
                label={t("userManagement.fieldPassword")}
                value={createForm.password}
                onChange={(v) => setCreateForm((s) => ({ ...s, password: v }))}
                type="password"
                required
              />
              <FieldInput
                label={t("userManagement.fieldConfirmPassword")}
                value={createForm.confirm}
                onChange={(v) => setCreateForm((s) => ({ ...s, confirm: v }))}
                type="password"
                required
              />
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {t("userManagement.fieldRole")}
                </label>
                <select
                  value={createForm.role}
                  onChange={(e) => setCreateForm((s) => ({ ...s, role: e.target.value as "admin" | "user" }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                >
                  <option value="user">{t("userManagement.roleUser")}</option>
                  <option value="admin">{t("userManagement.roleAdmin")}</option>
                </select>
              </div>
              {createError && <p className="text-xs text-red-500">{createError}</p>}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 flex items-center gap-1.5"
                >
                  {createLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t("userManagement.create")}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>

      {/* 编辑用户 */}
      <AnimatePresence>
        {edit && (
          <Modal onClose={() => setEdit(null)} title={t("userManagement.editUser", { name: edit.user.username })}>
            <div className="space-y-3">
              <FieldInput
                label={t("userManagement.fieldUsername")}
                value={edit.username}
                onChange={(v) => setEdit((s) => (s ? { ...s, username: v } : s))}
              />
              <FieldInput
                label={t("userManagement.fieldDisplayName")}
                value={edit.displayName}
                onChange={(v) => setEdit((s) => (s ? { ...s, displayName: v } : s))}
              />
              <FieldInput
                label={t("userManagement.fieldEmail")}
                value={edit.email}
                onChange={(v) => setEdit((s) => (s ? { ...s, email: v } : s))}
                type="email"
              />
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {t("userManagement.fieldRole")}
                </label>
                <select
                  value={edit.role}
                  onChange={(e) =>
                    setEdit((s) => (s ? { ...s, role: e.target.value as "admin" | "user" } : s))
                  }
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                >
                  <option value="user">{t("userManagement.roleUser")}</option>
                  <option value="admin">{t("userManagement.roleAdmin")}</option>
                </select>
              </div>

              {/*
                个人空间功能开关（v6 起为 per-user）。
                - 管理员账号本身不受这两个开关约束（后端 isSystemAdmin 直通），但仍然把
                  开关展示出来便于"统一管理"——管理员看着这两个开关也是关的，但导出/导入功能依然可用。
                - 这里用 inline checkbox 而不引入额外组件，与本文件其它 UI 风格保持一致。
              */}
              <div className="space-y-2 pt-1">
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 block">
                  {t("userManagement.fieldPersonalFeatures")}
                </label>
                <ToggleEditRow
                  label={t("userManagement.fieldPersonalExportEnabled")}
                  desc={t("userManagement.fieldPersonalExportEnabledDesc")}
                  checked={edit.personalExportEnabled}
                  onChange={(v) => setEdit((s) => (s ? { ...s, personalExportEnabled: v } : s))}
                />
                <ToggleEditRow
                  label={t("userManagement.fieldPersonalImportEnabled")}
                  desc={t("userManagement.fieldPersonalImportEnabledDesc")}
                  checked={edit.personalImportEnabled}
                  onChange={(v) => setEdit((s) => (s ? { ...s, personalImportEnabled: v } : s))}
                />
              </div>

              {editError && <p className="text-xs text-red-500">{editError}</p>}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEdit(null)}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={editLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 flex items-center gap-1.5"
                >
                  {editLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t("common.save")}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* 重置密码 */}
      <AnimatePresence>
        {resetPwd && (
          <Modal
            onClose={() => setResetPwd(null)}
            title={t("userManagement.resetPasswordFor", { name: resetPwd.user.username })}
          >
            <div className="space-y-3">
              <FieldInput
                label={t("userManagement.fieldPassword")}
                value={resetPwd.password}
                onChange={(v) => setResetPwd((s) => (s ? { ...s, password: v } : s))}
                type="password"
              />
              <FieldInput
                label={t("userManagement.fieldConfirmPassword")}
                value={resetPwd.confirm}
                onChange={(v) => setResetPwd((s) => (s ? { ...s, confirm: v } : s))}
                type="password"
              />
              {resetError && <p className="text-xs text-red-500">{resetError}</p>}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResetPwd(null)}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleResetPassword}
                  disabled={resetLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-50 flex items-center gap-1.5"
                >
                  {resetLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t("userManagement.confirmReset")}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* L3: 删除用户（支持数据转移） */}
      <AnimatePresence>
        {deleteDialog && (
          <Modal
            onClose={() => {
              if (deleteDialog.submitting) return;
              setDeleteDialog(null);
            }}
            title={t("userManagement.deleteTitle", { name: deleteDialog.user.username })}
          >
            <div className="space-y-4 text-sm">
              {/* 数据量预览 */}
              <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                {deleteDialog.loadingSummary ? (
                  <div className="flex items-center gap-2 text-zinc-500 text-xs">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{t("userManagement.deleteLoadingSummary")}</span>
                  </div>
                ) : deleteDialog.summary ? (
                  <>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-2">
                      {t("userManagement.deleteSummaryHint")}
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300">
                      <SummaryRow label={t("userManagement.summaryNotebooks")} value={deleteDialog.summary.notebooks} />
                      <SummaryRow label={t("userManagement.summaryNotes")} value={deleteDialog.summary.notes} />
                      <SummaryRow label={t("userManagement.summaryTags")} value={deleteDialog.summary.tags} />
                      <SummaryRow label={t("userManagement.summaryTasks")} value={deleteDialog.summary.tasks} />
                      <SummaryRow label={t("userManagement.summaryDiaries")} value={deleteDialog.summary.diaries} />
                      <SummaryRow label={t("userManagement.summaryShares")} value={deleteDialog.summary.shares} />
                      <SummaryRow label={t("userManagement.summaryOwnedWorkspaces")} value={deleteDialog.summary.ownedWorkspaces} />
                      <SummaryRow label={t("userManagement.summaryMemberships")} value={deleteDialog.summary.workspaceMemberships} />
                    </div>
                  </>
                ) : null}
              </div>

              {/* 模式选择 */}
              <div className="space-y-2">
                <label className="flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors
                  hover:bg-zinc-50 dark:hover:bg-zinc-900/50
                  data-[active=true]:border-red-500 data-[active=true]:bg-red-50/50 dark:data-[active=true]:bg-red-500/5
                  border-zinc-200 dark:border-zinc-800"
                  data-active={deleteDialog.mode === "cascade"}
                >
                  <input
                    type="radio"
                    checked={deleteDialog.mode === "cascade"}
                    onChange={() => setDeleteDialog({ ...deleteDialog, mode: "cascade", error: "" })}
                    className="mt-0.5 accent-red-600"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {t("userManagement.deleteModeCascade")}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {t("userManagement.deleteModeCascadeDesc")}
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors
                  hover:bg-zinc-50 dark:hover:bg-zinc-900/50
                  data-[active=true]:border-indigo-500 data-[active=true]:bg-indigo-50/50 dark:data-[active=true]:bg-indigo-500/5
                  border-zinc-200 dark:border-zinc-800"
                  data-active={deleteDialog.mode === "transfer"}
                >
                  <input
                    type="radio"
                    checked={deleteDialog.mode === "transfer"}
                    onChange={() => setDeleteDialog({ ...deleteDialog, mode: "transfer", error: "" })}
                    className="mt-0.5 accent-indigo-600"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                      {t("userManagement.deleteModeTransfer")}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {t("userManagement.deleteModeTransferDesc")}
                    </div>
                    {deleteDialog.mode === "transfer" && (
                      <select
                        value={deleteDialog.transferToId}
                        onChange={(e) =>
                          setDeleteDialog({ ...deleteDialog, transferToId: e.target.value, error: "" })
                        }
                        className="mt-2 w-full px-2.5 py-1.5 text-xs rounded-md border bg-white dark:bg-zinc-950
                          border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100
                          outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
                      >
                        <option value="">{t("userManagement.deleteSelectReceiver")}</option>
                        {users
                          .filter((o) => o.id !== deleteDialog.user.id && !o.isDisabled)
                          .map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.displayName ? `${o.displayName} (@${o.username})` : o.username}
                              {o.role === "admin" ? ` · ${t("userManagement.roleAdmin")}` : ""}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </label>
              </div>

              {deleteDialog.error && (
                <p className="text-xs text-red-500">{deleteDialog.error}</p>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={deleteDialog.submitting}
                  onClick={() => setDeleteDialog(null)}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={
                    deleteDialog.submitting ||
                    (deleteDialog.mode === "transfer" && !deleteDialog.transferToId)
                  }
                  onClick={submitDeleteDialog}
                  className={`px-3 py-1.5 text-xs rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5 ${
                    deleteDialog.mode === "transfer"
                      ? "bg-indigo-600 hover:bg-indigo-700"
                      : "bg-red-600 hover:bg-red-700"
                  }`}
                >
                  {deleteDialog.submitting && <Loader2 className="w-3 h-3 animate-spin" />}
                  {deleteDialog.mode === "transfer"
                    ? t("userManagement.deleteConfirmTransfer")
                    : t("userManagement.deleteConfirmCascade")}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* H2: sudo 二次验证密码框 */}
      <AnimatePresence>
        {sudoAsk && (
          <Modal
            onClose={() => {
              sudoAsk.resolve(null);
              setSudoAsk(null);
            }}
            title={t("userManagement.sudoTitle")}
          >
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!sudoPwd) return;
                setSudoError("");
                setSudoSubmitting(true);
                try {
                  // 在此一次性换取 sudoToken，成功后把 token 直接回传给 runWithSudo
                  const { sudoToken } = await api.requestSudoToken(sudoPwd);
                  sudoAsk.resolve(sudoToken);
                  setSudoAsk(null);
                } catch (err) {
                  if (typeof err === "object" && err !== null && "status" in err && err.status === 429) {
                    setSudoError(t("userManagement.sudoRateLimited"));
                  } else {
                    setSudoError((err instanceof Error && err.message) || t("userManagement.sudoWrongPassword"));
                  }
                } finally {
                  setSudoSubmitting(false);
                }
              }}
              className="space-y-3"
            >
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50/70 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs">
                <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{sudoAsk.reason || t("userManagement.sudoDesc")}</span>
              </div>
              <FieldInput
                label={t("userManagement.sudoPasswordLabel")}
                value={sudoPwd}
                onChange={setSudoPwd}
                type="password"
                required
              />
              {sudoError && <p className="text-xs text-red-500">{sudoError}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    sudoAsk.resolve(null);
                    setSudoAsk(null);
                  }}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t("userManagement.sudoCancel")}
                </button>
                <button
                  type="submit"
                  disabled={sudoSubmitting || !sudoPwd}
                  className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 flex items-center gap-1.5"
                >
                  {sudoSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
                  {t("userManagement.sudoConfirm")}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============ 内部 UI 元素 ============

/** L3 删除对话框里的"数据量"展示行 */
function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-tx-tertiary">{label}</span>
      <span className={value > 0 ? "font-semibold tabular-nums text-tx-primary" : "tabular-nums text-tx-tertiary"}>{value}</span>
    </div>
  );
}

/**
 * 编辑用户弹窗里的 toggle 行。
 * 与 SettingsModal 里曾经的 ToggleRow 视觉一致，但因 UserManagement 自带 Modal 与 FieldInput
 * 体系，刻意保留独立实现，不去 shared 化——避免跨文件耦合让以后改样式时牵动太广。
 */
function ToggleEditRow({
  label,
  desc,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-xl border border-app-border/80 bg-app-surface/75 px-3.5 py-2.5 ${
        disabled ? "opacity-70" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="text-xs font-semibold text-tx-primary">{label}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-tx-secondary">
          {desc}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-all ${
          checked ? "bg-gradient-to-r from-blue-500 to-indigo-500" : "bg-app-border/90"
        } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-tx-secondary">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-sm text-tx-primary outline-none transition-all focus:border-blue-400 focus:ring-2 focus:ring-blue-500/15"
      />
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-zinc-900/45 backdrop-blur-sm dark:bg-black/65" onClick={onClose} />
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        className="relative flex max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-md flex-col overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-app-border/70 px-4 py-3.5 sm:px-5">
          <h4 className="text-sm font-bold text-tx-primary">{title}</h4>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5">{children}</div>
      </motion.div>
    </motion.div>
  );
}
