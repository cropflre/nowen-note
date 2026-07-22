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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            {t("workspaceManagement.title")}
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("workspaceManagement.description")} ·{" "}
            {t("workspaceManagement.total", { count: filtered.length })}
          </p>
        </div>
        <button
          onClick={() => void fetchList()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("workspaceManagement.refresh")}
        </button>
      </div>

      {/* 搜索 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("workspaceManagement.searchPlaceholder")}
          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500"
        />
      </div>

      {/* 列表 */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="max-h-[52vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-zinc-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-zinc-400">
              {t("workspaceManagement.noResult")}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.map((w) => (
                <li
                  key={w.id}
                  className="px-4 py-3 hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {/* 图标 */}
                    <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-base shrink-0">
                      {w.icon || DEFAULT_WORKSPACE_ICON}
                    </div>

                    {/* 主信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">
                          {w.name}
                        </span>
                      </div>
                      {w.description && (
                        <div className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                          {w.description}
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px] text-zinc-400 dark:text-zinc-500">
                        <span className="truncate">
                          {t("workspaceManagement.colOwner")}: {" "}
                          {w.ownerName ||
                            w.ownerUsername ||
                            t("workspaceManagement.ownerUnknown")}
                          {w.ownerUsername && w.ownerName && w.ownerName !== w.ownerUsername
                            ? ` (@${w.ownerUsername})`
                            : ""}
                        </span>
                        <span>
                          {t("workspaceManagement.colMembers")}: {" "}
                          {t("workspaceManagement.members", { count: w.memberCount ?? 0 })}
                        </span>
                        <span>
                          {t("workspaceManagement.colNotebooks")}: {" "}
                          {t("workspaceManagement.notebooks", { count: w.notebookCount ?? 0 })}
                        </span>
                        <span className="truncate">
                          {t("workspaceManagement.colCreatedAt")}: {" "}
                          {w.createdAt ? new Date(w.createdAt).toLocaleString() : "—"}
                        </span>
                      </div>
                    </div>

                    {/* 操作 */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() =>
                          setEdit({
                            workspace: w,
                            name: w.name,
                            description: w.description || "",
                            icon: w.icon || DEFAULT_WORKSPACE_ICON,
                          })
                        }
                        className="p-1.5 rounded-md text-zinc-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
                        title={t("workspaceManagement.edit")}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          setDel({ workspace: w, submitting: false, error: "" })
                        }
                        className="p-1.5 rounded-md text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                        title={t("workspaceManagement.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
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
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {t("workspaceManagement.fieldDescription")}
                </label>
                <textarea
                  value={edit.description}
                  onChange={(e) =>
                    setEdit((s) => (s ? { ...s, description: e.target.value } : s))
                  }
                  rows={3}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 resize-none"
                />
              </div>

              {editError && <p className="text-xs text-red-500">{editError}</p>}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={editLoading}
                  onClick={() => setEdit(null)}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={editLoading || !edit.name.trim()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 flex items-center gap-1.5"
                >
                  {editLoading && <Loader2 className="w-3 h-3 animate-spin" />}
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
              <div className="p-3 rounded-lg bg-red-50/60 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">
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

              <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300">
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

              {del.error && <p className="text-xs text-red-500">{del.error}</p>}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={del.submitting}
                  onClick={() => setDel(null)}
                  className="px-3 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  disabled={del.submitting}
                  onClick={handleDelete}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 flex items-center gap-1.5"
                >
                  {del.submitting && <Loader2 className="w-3 h-3 animate-spin" />}
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
      <span className="text-zinc-500">{label}</span>
      <span className={value > 0 ? "font-medium tabular-nums" : "text-zinc-400 tabular-nums"}>
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
      <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500"
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
        className="absolute inset-0 bg-zinc-900/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        className="relative w-full max-w-md bg-white dark:bg-zinc-950 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h4>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </motion.div>
    </motion.div>
  );
}
