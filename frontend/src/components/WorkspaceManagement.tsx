/**
 * 系统管理员「工作区管理」面板
 *
 * 范围：仅 users.role = 'admin' 可见（在 SettingsModal 中通过 isAdmin 闸门）。
 * 能力：
 *   - 列出系统内全部工作区（含 owner 展示信息、成员数、笔记本数、创建时间）；
 *   - 编辑任意工作区的 name / description / icon；
 *   - 删除任意工作区（带二次确认；后端会把笔记本/笔记归还到 owner 的个人空间）。
 *
 * 设计取舍：
 *   - 视觉沿用 UserManagement 的卡片式列表 + Modal 风格，避免引入第三方组件；
 *   - 不在这里处理"成员管理 / 邀请码 / features"，那些在工作区内部已有 MembersPanel
 *     等更专业的 UI；本面板专注于"跨工作区运维"动作；
 *   - 后端 requireWorkspaceRole 已对系统管理员旁路，故 PUT/DELETE 直接调用现有接口。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatAppDateTime } from "@/lib/dateTime";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2,
  Search,
  Loader2,
  Trash2,
  Pencil,
  X,
  RefreshCcw,
  AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { realtime } from "@/lib/realtime";
import { WorkspaceAdminItem } from "@/types";
import { toast } from "@/lib/toast";
import WorkspaceIconField, { DEFAULT_WORKSPACE_ICON } from "@/components/WorkspaceIconField";

interface EditState {
  workspace: WorkspaceAdminItem;
  name: string;
  description: string;
  icon: string;
}

interface DeleteState {
  workspace: WorkspaceAdminItem;
  submitting: boolean;
  error: string;
}

export default function WorkspaceManagement() {
  const { t } = useTranslation();
  const [items, setItems] = useState<WorkspaceAdminItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [edit, setEdit] = useState<EditState | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");

  const [del, setDel] = useState<DeleteState | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listAllWorkspaces();
      setItems(list.map((workspace) => ({
        ...workspace,
        icon: workspace.icon || DEFAULT_WORKSPACE_ICON,
      })));
    } catch (err: any) {
      toast.error(err?.message || t("workspaceManagement.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  useEffect(() => realtime.on("workspace:updated", () => {
    void fetchList();
  }), [fetchList]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((w) => {
      const owner = (w.ownerName || w.ownerUsername || "").toLowerCase();
      return (
        w.name.toLowerCase().includes(q) ||
        (w.description || "").toLowerCase().includes(q) ||
        owner.includes(q)
      );
    });
  }, [items, search]);

  const handleSaveEdit = async () => {
    if (!edit) return;
    setEditError("");
    const payload: { name?: string; description?: string; icon?: string } = {};
    if (edit.name.trim() !== edit.workspace.name) payload.name = edit.name.trim();
    if (edit.description !== (edit.workspace.description || ""))
      payload.description = edit.description;
    if (edit.icon !== (edit.workspace.icon || DEFAULT_WORKSPACE_ICON)) payload.icon = edit.icon;

    if (!payload.name && payload.description === undefined && !payload.icon) {
      setEdit(null);
      return;
    }
    if (payload.name !== undefined && !payload.name) {
      setEditError(t("workspaceManagement.fieldName"));
      return;
    }

    setEditLoading(true);
    try {
      const saved = await api.updateWorkspace(edit.workspace.id, payload);
      setItems((previous) => previous.map((workspace) => (
        workspace.id === saved.id
          ? { ...workspace, ...saved, icon: saved.icon || DEFAULT_WORKSPACE_ICON }
          : workspace
      )));
      toast.success(t("workspaceManagement.saveSuccess"));
      setEdit(null);
      void fetchList();
    } catch (err: any) {
      setEditError(err?.message || t("workspaceManagement.saveFailed"));
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!del) return;
    setDel({ ...del, submitting: true, error: "" });
    try {
      await api.deleteWorkspace(del.workspace.id);
      toast.success(t("workspaceManagement.deleteSuccess"));
      setDel(null);
      void fetchList();
    } catch (err: any) {
      setDel((prev) =>
        prev
          ? {
              ...prev,
              submitting: false,
              error: err?.message || t("workspaceManagement.deleteFailed"),
            }
          : prev,
      );
    }
  };

  return (
    <div className="space-y-5">
      {/* 标题 */}
      <div className="relative overflow-hidden rounded-2xl border border-app-border/80 bg-gradient-to-br from-amber-500/[0.08] via-app-elevated/85 to-orange-500/[0.07] p-5 shadow-xs backdrop-blur-sm">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-amber-400/15 blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <motion.span
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
              transition={{ duration: 0.45 }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/20 via-yellow-400/18 to-orange-500/20 text-amber-600 shadow-xs ring-1 ring-amber-500/25 dark:text-amber-300"
            >
              <Building2 className="h-5 w-5" />
            </motion.span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold tracking-tight text-tx-primary">
                  {t("workspaceManagement.title")}
                </h3>
                <span className="rounded-full bg-amber-500/12 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                  {t("workspaceManagement.total", { count: filtered.length })}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">
                {t("workspaceManagement.description")}
              </p>
            </div>
          </div>
          <button
            onClick={() => void fetchList()}
            disabled={loading}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-xs font-semibold text-tx-primary shadow-2xs transition-all hover:-translate-y-0.5 hover:border-amber-400/50 hover:text-amber-600 disabled:translate-y-0 disabled:opacity-50 dark:hover:text-amber-300"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("workspaceManagement.refresh")}
          </button>
        </div>
      </div>

      {/* 搜索 */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tx-tertiary" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("workspaceManagement.searchPlaceholder")}
          className="w-full rounded-2xl border border-app-border/80 bg-app-elevated/85 py-2.5 pl-10 pr-4 text-sm text-tx-primary shadow-xs outline-none backdrop-blur-sm transition-all placeholder:text-tx-tertiary focus:border-amber-400 focus:ring-2 focus:ring-amber-500/15"
        />
      </div>

      {/* 列表 */}
      <div className="overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated/80 shadow-xs backdrop-blur-sm">
        <div className="max-h-[52vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-tx-tertiary">
              <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <span className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
                <Building2 className="h-5 w-5" />
              </span>
              <span className="text-sm font-medium text-tx-secondary">
                {t("workspaceManagement.noResult")}
              </span>
            </div>
          ) : (
            <ul className="divide-y divide-app-border/60">
              {filtered.map((w) => (
                <li
                  key={w.id}
                  className="px-4 py-3.5 transition-colors hover:bg-amber-500/[0.04]"
                >
                  <div className="flex items-start gap-3.5">
                    {/* 图标 */}
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 via-orange-400 to-rose-400 text-base text-white shadow-xs">
                      {w.icon || DEFAULT_WORKSPACE_ICON}
                    </div>

                    {/* 主信息 */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-bold text-tx-primary">
                          {w.name}
                        </span>
                      </div>
                      {w.description && (
                        <div className="mt-0.5 truncate text-xs text-tx-secondary">
                          {w.description}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="truncate rounded-full bg-app-surface px-2.5 py-0.5 font-medium text-tx-secondary ring-1 ring-app-border/60">
                          {t("workspaceManagement.colOwner")}:{" "}
                          {w.ownerName ||
                            w.ownerUsername ||
                            t("workspaceManagement.ownerUnknown")}
                          {w.ownerUsername && w.ownerName && w.ownerName !== w.ownerUsername
                            ? ` (@${w.ownerUsername})`
                            : ""}
                        </span>
                        <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 font-semibold text-amber-700 dark:text-amber-300">
                          {t("workspaceManagement.colMembers")}:{" "}
                          {t("workspaceManagement.members", { count: w.memberCount ?? 0 })}
                        </span>
                        <span className="rounded-full bg-sky-500/10 px-2.5 py-0.5 font-semibold text-sky-700 dark:text-sky-300">
                          {t("workspaceManagement.colNotebooks")}:{" "}
                          {t("workspaceManagement.notebooks", { count: w.notebookCount ?? 0 })}
                        </span>
                        <span className="truncate text-tx-tertiary">
                          {t("workspaceManagement.colCreatedAt")}:{" "}
                          {w.createdAt ? formatAppDateTime(w.createdAt) : "—"}
                        </span>
                      </div>
                    </div>

                    {/* 操作 */}
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() =>
                          setEdit({
                            workspace: w,
                            name: w.name,
                            description: w.description || "",
                            icon: w.icon || DEFAULT_WORKSPACE_ICON,
                          })
                        }
                        className="rounded-xl p-2 text-tx-secondary transition-all hover:bg-amber-500/12 hover:text-amber-600 dark:hover:text-amber-300"
                        title={t("workspaceManagement.edit")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          setDel({ workspace: w, submitting: false, error: "" })
                        }
                        className="rounded-xl p-2 text-tx-secondary transition-all hover:bg-rose-500/12 hover:text-rose-500"
                        title={t("workspaceManagement.delete")}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 编辑弹窗 */}
      <AnimatePresence>
        {edit && (
          <Modal
            onClose={() => !editLoading && setEdit(null)}
            title={t("workspaceManagement.editTitle", { name: edit.workspace.name })}
          >
            <div className="space-y-4">
              <WorkspaceIconField
                label={t("workspaceManagement.fieldIcon")}
                icon={edit.icon}
                disabled={editLoading}
                onChange={(icon) => setEdit((state) => state ? { ...state, icon } : state)}
              />
              <FieldInput
                label={t("workspaceManagement.fieldName")}
                value={edit.name}
                onChange={(v) => setEdit((s) => (s ? { ...s, name: v } : s))}
              />
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-tx-secondary">
                  {t("workspaceManagement.fieldDescription")}
                </label>
                <textarea
                  value={edit.description}
                  onChange={(e) =>
                    setEdit((s) => (s ? { ...s, description: e.target.value } : s))
                  }
                  rows={3}
                  className="w-full resize-none rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-sm text-tx-primary outline-none transition-all focus:border-amber-400 focus:ring-2 focus:ring-amber-500/15"
                />
              </div>

              {editError && <p className="text-xs font-medium text-rose-500">{editError}</p>}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={editLoading}
                  onClick={() => setEdit(null)}
                  className="rounded-xl px-3.5 py-2 text-xs font-semibold text-tx-secondary transition-colors hover:bg-app-hover disabled:opacity-40"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={editLoading || !edit.name.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:shadow-md disabled:opacity-50"
                >
                  {editLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("workspaceManagement.save")}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* 删除确认弹窗 */}
      <AnimatePresence>
        {del && (
          <Modal
            onClose={() => !del.submitting && setDel(null)}
            title={t("workspaceManagement.deleteTitle", { name: del.workspace.name })}
          >
            <div className="space-y-4 text-sm">
              <div className="flex items-start gap-2.5 rounded-xl border border-rose-400/35 bg-rose-500/10 p-3.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                <p className="text-xs leading-relaxed text-rose-700 dark:text-rose-300">
                  {del.workspace.ownerName || del.workspace.ownerUsername
                    ? t("workspaceManagement.deleteConfirmHint", {
                        owner:
                          del.workspace.ownerName ||
                          del.workspace.ownerUsername ||
                          "",
                      })
                    : t("workspaceManagement.deleteConfirmHintNoOwner")}
                </p>
              </div>

              <div className="rounded-xl border border-app-border/80 bg-app-surface/75 p-3.5">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-tx-primary">
                  <SummaryRow
                    label={t("workspaceManagement.deleteSummaryMembers")}
                    value={del.workspace.memberCount ?? 0}
                  />
                  <SummaryRow
                    label={t("workspaceManagement.deleteSummaryNotebooks")}
                    value={del.workspace.notebookCount ?? 0}
                  />
                </div>
              </div>

              {del.error && <p className="text-xs font-medium text-rose-500">{del.error}</p>}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={del.submitting}
                  onClick={() => setDel(null)}
                  className="rounded-xl px-3.5 py-2 text-xs font-semibold text-tx-secondary transition-colors hover:bg-app-hover disabled:opacity-40"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={del.submitting}
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                >
                  {del.submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t("workspaceManagement.confirmDelete")}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============ 内部 UI 元素 ============

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-tx-tertiary">{label}</span>
      <span className={value > 0 ? "font-semibold tabular-nums text-tx-primary" : "tabular-nums text-tx-tertiary"}>
        {value}
      </span>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-tx-secondary">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-sm text-tx-primary outline-none transition-all focus:border-amber-400 focus:ring-2 focus:ring-amber-500/15"
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
      <div
        className="absolute inset-0 bg-zinc-900/45 backdrop-blur-sm dark:bg-black/65"
        onClick={onClose}
      />
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-app-border/70 px-5 py-3.5">
          <h4 className="text-sm font-bold text-tx-primary">{title}</h4>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </motion.div>
    </motion.div>
  );
}
