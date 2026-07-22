import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Edit3,
  FolderTree,
  Key,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, getBaseUrl } from "@/lib/api";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/lib/toast";
import TokenUsageStats from "@/components/TokenUsageStats";

type ResourceMode = "unrestricted" | "restricted";
type ResourcePermission = "read" | "write";

interface NotebookResource {
  notebookId: string;
  notebookName?: string | null;
  permission: ResourcePermission;
  includeDescendants: boolean;
}

interface NotebookOption {
  id: string;
  name: string;
  parentId: string | null;
  workspaceId: string | null;
  canWrite: boolean;
}

interface ApiTokenListItem {
  id: string;
  name: string;
  scopes: string[];
  resourceMode: ResourceMode;
  notebookResources: NotebookResource[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface TokenFormValue {
  name: string;
  scopes: string[];
  expiresInDays: number | null;
  resourceMode: ResourceMode;
  notebookResources: NotebookResource[];
}

async function tokenJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body as T;
}

function formatDate(value: string | null): string {
  if (!value) return "永不过期";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function scopeLabel(scope: string): string {
  const labels: Record<string, string> = {
    "notes:read": "读取笔记",
    "notes:write": "写入笔记",
    "notebooks:read": "读取笔记本",
    "notebooks:write": "管理笔记本",
    "attachments:write": "写入附件",
    "tags:read": "读取标签",
    "tags:write": "管理标签",
    "export:import": "导入导出",
  };
  return labels[scope] || scope;
}

export default function TokenManagement(): JSX.Element {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<ApiTokenListItem[]>([]);
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<ApiTokenListItem | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.tokens.list() as any;
      setTokens(result.tokens || []);
      setAvailableScopes(result.availableScopes || []);
    } catch (error: any) {
      toast.error(error?.message || "加载访问令牌失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadNotebooks = useCallback(async () => {
    try {
      const result = await tokenJson<{ notebooks: NotebookOption[] }>("/tokens/notebook-options");
      setNotebooks(result.notebooks || []);
    } catch (error: any) {
      toast.error(error?.message || "加载笔记本列表失败");
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (showCreate || editing) void loadNotebooks();
  }, [showCreate, editing, loadNotebooks]);

  const revoke = async (item: ApiTokenListItem) => {
    const ok = await confirm({
      title: "吊销访问令牌",
      description: `「${item.name}」将立即失效，此操作不可撤销。`,
      confirmText: "吊销",
      cancelText: t("common.cancel", { defaultValue: "取消" }),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.tokens.revoke(item.id);
      toast.success("令牌已吊销");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "吊销失败");
    }
  };

  return (
    <div className="space-y-6 pb-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">个人访问令牌</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            为 MCP、CLI 和自动化 Agent 创建独立令牌，并限制其可访问的笔记本。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus className="h-4 w-4" />创建令牌
        </button>
      </div>

      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/5 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>restricted 模式采用服务端强制校验。即使绕过 MCP 直接调用 REST API，也不能访问未授权笔记本。</span>
      </div>

      {tokens.length > 0 && <TokenUsageStats />}

      {loading ? (
        <div className="flex justify-center py-12 text-sm text-zinc-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中...</div>
      ) : tokens.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <Key className="mx-auto h-8 w-8 text-zinc-400" />
          <p className="mt-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">尚未创建访问令牌</p>
          <p className="mt-1 text-xs text-zinc-500">建议为每个 Agent 单独创建 restricted Token。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tokens.map((item) => (
            <TokenRow key={item.id} item={item} onEdit={() => setEditing(item)} onRevoke={() => void revoke(item)} />
          ))}
        </div>
      )}

      {showCreate && (
        <TokenDialog
          title="创建访问令牌"
          availableScopes={availableScopes}
          notebooks={notebooks}
          initial={{
            name: "",
            scopes: ["notes:read", "notebooks:read"].filter((scope) => availableScopes.includes(scope)),
            expiresInDays: 90,
            resourceMode: "restricted",
            notebookResources: [],
          }}
          onClose={() => setShowCreate(false)}
          onSubmit={async (value) => {
            const result = await tokenJson<{ name: string; token: string }>("/tokens", {
              method: "POST",
              body: JSON.stringify(value),
            });
            setShowCreate(false);
            setCreated(result);
            await reload();
          }}
        />
      )}

      {editing && (
        <TokenDialog
          title={`编辑资源范围 · ${editing.name}`}
          resourceOnly
          availableScopes={availableScopes}
          notebooks={notebooks}
          initial={{
            name: editing.name,
            scopes: editing.scopes,
            expiresInDays: null,
            resourceMode: editing.resourceMode,
            notebookResources: editing.notebookResources || [],
          }}
          onClose={() => setEditing(null)}
          onSubmit={async (value) => {
            await tokenJson(`/tokens/${encodeURIComponent(editing.id)}/resources`, {
              method: "PATCH",
              body: JSON.stringify({
                resourceMode: value.resourceMode,
                notebookResources: value.notebookResources,
              }),
            });
            toast.success("资源授权已更新");
            setEditing(null);
            await reload();
          }}
        />
      )}

      {created && <CreatedTokenDialog value={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function TokenRow({
  item,
  onEdit,
  onRevoke,
}: {
  item: ApiTokenListItem;
  onEdit: () => void;
  onRevoke: () => void;
}) {
  const revoked = Boolean(item.revokedAt);
  const expired = Boolean(item.expiresAt && Date.parse(item.expiresAt) < Date.now());
  const active = !revoked && !expired;
  return (
    <div className={`rounded-xl border p-4 ${active ? "border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900/40" : "border-zinc-200 bg-zinc-50 opacity-70 dark:border-zinc-800 dark:bg-zinc-900/20"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Key className="h-4 w-4 text-indigo-500" />
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${active ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"}`}>
              {revoked ? "已吊销" : expired ? "已过期" : "有效"}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${item.resourceMode === "restricted" ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300" : "bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"}`}>
              {item.resourceMode === "restricted" ? "限定笔记本" : "全部可访问资源"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.scopes.map((scope) => <span key={scope} className="rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{scopeLabel(scope)}</span>)}
          </div>
          {item.resourceMode === "restricted" && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(item.notebookResources || []).length === 0 ? (
                <span className="text-xs text-red-500">空白名单：所有笔记本请求都会被拒绝</span>
              ) : item.notebookResources.map((resource) => (
                <span key={resource.notebookId} className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200">
                  <FolderTree className="h-3 w-3" />
                  {resource.notebookName || resource.notebookId}
                  · {resource.permission === "write" ? "读写" : "只读"}
                  {resource.includeDescendants ? " · 含子笔记本" : ""}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 text-[11px] text-zinc-400">
            创建：{formatDate(item.createdAt)} · 过期：{formatDate(item.expiresAt)} · 最近使用：{item.lastUsedAt ? formatDate(item.lastUsedAt) : "—"}
            {item.lastUsedIp ? ` · ${item.lastUsedIp}` : ""}
          </div>
        </div>
        {!revoked && (
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
              <Edit3 className="h-3.5 w-3.5" />授权
            </button>
            <button type="button" onClick={onRevoke} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10">
              <Trash2 className="h-3.5 w-3.5" />吊销
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TokenDialog({
  title,
  initial,
  availableScopes,
  notebooks,
  resourceOnly = false,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: TokenFormValue;
  availableScopes: string[];
  notebooks: NotebookOption[];
  resourceOnly?: boolean;
  onClose: () => void;
  onSubmit: (value: TokenFormValue) => Promise<void>;
}) {
  const [value, setValue] = useState<TokenFormValue>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selected = useMemo(() => new Map(value.notebookResources.map((resource) => [resource.notebookId, resource])), [value.notebookResources]);

  const toggleNotebook = (option: NotebookOption) => {
    const current = selected.get(option.id);
    setValue((previous) => ({
      ...previous,
      notebookResources: current
        ? previous.notebookResources.filter((resource) => resource.notebookId !== option.id)
        : [...previous.notebookResources, {
            notebookId: option.id,
            notebookName: option.name,
            permission: option.canWrite ? "write" : "read",
            includeDescendants: false,
          }],
    }));
  };

  const patchResource = (notebookId: string, patch: Partial<NotebookResource>) => {
    setValue((previous) => ({
      ...previous,
      notebookResources: previous.notebookResources.map((resource) => resource.notebookId === notebookId ? { ...resource, ...patch } : resource),
    }));
  };

  const submit = async () => {
    setError("");
    if (!resourceOnly && !value.name.trim()) return setError("请填写令牌名称");
    if (!resourceOnly && value.scopes.length === 0) return setError("请至少选择一个 scope");
    setSubmitting(true);
    try {
      await onSubmit({ ...value, name: value.name.trim() });
    } catch (submitError: any) {
      setError(submitError?.message || "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogShell title={title} onClose={onClose}>
      <div className="space-y-5">
        {!resourceOnly && (
          <>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-700 dark:text-zinc-300">名称</span>
              <input value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} maxLength={64} autoFocus className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900" placeholder="例如：投资助理 MCP" />
            </label>
            <div>
              <span className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300">能力 scopes</span>
              <div className="grid grid-cols-2 gap-2">
                {availableScopes.map((scope) => {
                  const checked = value.scopes.includes(scope);
                  return <button key={scope} type="button" onClick={() => setValue({ ...value, scopes: checked ? value.scopes.filter((item) => item !== scope) : [...value.scopes, scope] })} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs ${checked ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200" : "border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"}`}>
                    <span className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "border-indigo-600 bg-indigo-600 text-white" : "border-zinc-300"}`}>{checked && <Check className="h-3 w-3" />}</span>
                    {scopeLabel(scope)}
                  </button>;
                })}
              </div>
            </div>
          </>
        )}

        <div>
          <span className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300">资源范围</span>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setValue({ ...value, resourceMode: "restricted" })} className={`rounded-lg border p-3 text-left ${value.resourceMode === "restricted" ? "border-indigo-400 bg-indigo-50 dark:bg-indigo-500/10" : "border-zinc-200 dark:border-zinc-700"}`}>
              <ShieldCheck className="mb-1 h-4 w-4 text-indigo-500" /><div className="text-sm font-medium">限定笔记本</div><div className="mt-1 text-[11px] text-zinc-500">推荐用于 MCP 与 Agent</div>
            </button>
            <button type="button" onClick={() => setValue({ ...value, resourceMode: "unrestricted" })} className={`rounded-lg border p-3 text-left ${value.resourceMode === "unrestricted" ? "border-amber-400 bg-amber-50 dark:bg-amber-500/10" : "border-zinc-200 dark:border-zinc-700"}`}>
              <Key className="mb-1 h-4 w-4 text-amber-500" /><div className="text-sm font-medium">全部可访问资源</div><div className="mt-1 text-[11px] text-zinc-500">兼容旧 Token 行为</div>
            </button>
          </div>
        </div>

        {value.resourceMode === "restricted" && (
          <div>
            <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">笔记本白名单</span><span className="text-[11px] text-zinc-400">已选 {value.notebookResources.length}</span></div>
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-zinc-200 p-2 dark:border-zinc-700">
              {notebooks.length === 0 ? <div className="py-6 text-center text-xs text-zinc-500">暂无可授权笔记本</div> : notebooks.map((option) => {
                const resource = selected.get(option.id);
                return (
                  <div key={option.id} className={`rounded-lg border p-2.5 ${resource ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-500/40 dark:bg-indigo-500/5" : "border-zinc-200 dark:border-zinc-800"}`}>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => toggleNotebook(option)} className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${resource ? "border-indigo-600 bg-indigo-600 text-white" : "border-zinc-300 dark:border-zinc-600"}`}>{resource && <Check className="h-3 w-3" />}</button>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{option.name}</span>
                      {resource && <select value={resource.permission} onChange={(event) => patchResource(option.id, { permission: event.target.value as ResourcePermission })} className="rounded border border-zinc-200 bg-white px-2 py-1 text-[11px] dark:border-zinc-700 dark:bg-zinc-900">
                        <option value="read">只读</option>
                        {option.canWrite && <option value="write">读写</option>}
                      </select>}
                    </div>
                    {resource && <label className="mt-2 flex items-center gap-2 pl-6 text-[11px] text-zinc-500"><input type="checkbox" checked={resource.includeDescendants} onChange={(event) => patchResource(option.id, { includeDescendants: event.target.checked })} />自动包含子笔记本</label>}
                  </div>
                );
              })}
            </div>
            {value.notebookResources.length === 0 && <p className="mt-2 flex items-center gap-1 text-[11px] text-red-500"><AlertTriangle className="h-3 w-3" />空白名单会拒绝所有笔记本访问。</p>}
          </div>
        )}

        {!resourceOnly && (
          <div>
            <span className="mb-2 block text-xs font-medium text-zinc-700 dark:text-zinc-300">有效期</span>
            <div className="flex flex-wrap gap-2">{[30, 90, 180, 365].map((days) => <button key={days} type="button" onClick={() => setValue({ ...value, expiresInDays: days })} className={`rounded-lg border px-3 py-1.5 text-xs ${value.expiresInDays === days ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-200" : "border-zinc-200 dark:border-zinc-700"}`}>{days} 天</button>)}<button type="button" onClick={() => setValue({ ...value, expiresInDays: null })} className={`rounded-lg border px-3 py-1.5 text-xs ${value.expiresInDays === null ? "border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-500/10" : "border-zinc-200 dark:border-zinc-700"}`}>永不过期</button></div>
          </div>
        )}

        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
      </div>
      <div className="mt-6 flex justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" onClick={onClose} disabled={submitting} className="rounded-lg px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">取消</button>
        <button type="button" onClick={() => void submit()} disabled={submitting} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}保存</button>
      </div>
    </DialogShell>
  );
}

function CreatedTokenDialog({ value, onClose }: { value: { name: string; token: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value.token);
    setCopied(true);
    toast.success("令牌已复制");
  };
  return <DialogShell title={`保存令牌 · ${value.name}`} onClose={onClose}>
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/5 dark:text-amber-200">明文只显示这一次。请立即复制到 MCP 配置或密码管理器。</div>
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-900"><code className="min-w-0 flex-1 break-all text-xs">{value.token}</code><button type="button" onClick={() => void copy()} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs text-white">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}复制</button></div>
    <div className="mt-5 flex justify-end"><button type="button" onClick={onClose} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">我已保存</button></div>
  </DialogShell>;
}

function DialogShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-950">
      <div className="mb-5 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-indigo-500" /><h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3></div><button type="button" onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="h-4 w-4" /></button></div>
      {children}
    </div>
  </div>;
}
