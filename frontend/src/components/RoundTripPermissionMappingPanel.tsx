import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search, ShieldAlert, UserRoundCheck, UsersRound, X } from "lucide-react";
import { api } from "@/lib/api";
import type {
  RoundTripPermissionInspection,
  RoundTripPermissionTargetUser,
} from "@/lib/roundTripImportReview";
import type { UserPublicInfo } from "@/types";

interface Props {
  inspection?: RoundTripPermissionInspection;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  mappings: Record<string, string>;
  onMappingsChange: (mappings: Record<string, string>) => void;
  disabled?: boolean;
}

function displayName(user: { username: string; displayName?: string | null }): string {
  return user.displayName?.trim() || user.username;
}

function roleLabel(role: string | null): string {
  switch (role) {
    case "owner": return "所有者（导入时按管理员处理）";
    case "admin": return "管理员";
    case "editor": return "编辑者";
    case "commenter": return "评论者";
    case "viewer": return "查看者";
    default: return "仅目录授权";
  }
}

function MappingRow({
  principal,
  selectedId,
  usedTargetIds,
  disabled,
  onSelect,
}: {
  principal: RoundTripPermissionInspection["principals"][number];
  selectedId?: string;
  usedTargetIds: Set<string>;
  disabled: boolean;
  onSelect: (target: RoundTripPermissionTargetUser | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserPublicInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    if (principal.suggestedTarget?.id === selectedId) return principal.suggestedTarget;
    const result = results.find((item) => item.id === selectedId);
    return result || null;
  }, [principal.suggestedTarget, results, selectedId]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setLoading(true);
      api.searchUsers(query.trim())
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const candidates = results.filter((item) => item.id === selectedId || !usedTargetIds.has(item.id));

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {principal.displayName || principal.username}
            </span>
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              @{principal.username}
            </span>
            <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
              {roleLabel(principal.workspaceRole)}
            </span>
          </div>
          {principal.email && (
            <p className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={principal.email}>
              {principal.email}
            </p>
          )}
          <p className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">
            {principal.match === "email"
              ? "已按邮箱找到建议账号"
              : principal.match === "username"
                ? "已按用户名找到建议账号"
                : principal.match === "ambiguous"
                  ? "存在多个候选，需要手动确认"
                  : "未自动匹配，可搜索目标账号或保持跳过"}
          </p>
        </div>

        <div className="relative w-full sm:w-[280px]">
          {selectedId ? (
            <div className="flex min-h-10 items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 dark:border-emerald-900/50 dark:bg-emerald-500/5">
              <UserRoundCheck size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                {selected ? displayName(selected) : selectedId}
                {selected && selected.displayName && <span className="ml-1 font-normal text-zinc-400">@{selected.username}</span>}
              </span>
              <button
                type="button"
                onClick={() => onSelect(null)}
                disabled={disabled}
                className="rounded p-1 text-zinc-400 hover:bg-white hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label="清除账号映射"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              disabled={disabled}
              className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-zinc-300 bg-white px-2.5 text-left text-xs text-zinc-500 transition-colors hover:border-violet-300 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
            >
              <Search size={14} />
              搜索目标实例中的账号
            </button>
          )}

          {open && !selectedId && (
            <div className="absolute right-0 top-[calc(100%+0.35rem)] z-20 w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
              <div className="flex items-center gap-2 border-b border-zinc-200 px-2.5 dark:border-zinc-800">
                <Search size={14} className="text-zinc-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="用户名或显示名"
                  className="h-10 min-w-0 flex-1 bg-transparent text-xs text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-200"
                />
                <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <X size={14} />
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto p-1.5">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-5 text-xs text-zinc-400"><Loader2 size={14} className="animate-spin" />正在搜索…</div>
                ) : candidates.length ? (
                  candidates.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => {
                        onSelect(user);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-50 text-xs font-bold text-violet-600 dark:bg-violet-500/10 dark:text-violet-300">
                        {displayName(user).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">{displayName(user)}</span>
                        <span className="block truncate text-[10px] text-zinc-400">@{user.username}</span>
                      </span>
                      <Check size={14} className="text-zinc-300" />
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-5 text-center text-xs text-zinc-400">没有可用账号</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RoundTripPermissionMappingPanel({
  inspection,
  enabled,
  onEnabledChange,
  mappings,
  onMappingsChange,
  disabled = false,
}: Props) {
  if (!inspection?.included) return null;

  const mappedCount = Object.values(mappings).filter(Boolean).length;
  const usedTargetIds = new Set(Object.values(mappings).filter(Boolean));

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/35 p-3 dark:border-violet-900/45 dark:bg-violet-500/5">
      <div className="flex items-start gap-2.5">
        <UsersRound size={17} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold text-violet-900 dark:text-violet-200">恢复成员与权限</h3>
              <p className="mt-1 text-[11px] leading-5 text-violet-700/80 dark:text-violet-300/80">
                默认关闭。开启后仅恢复已明确映射的成员，不创建新账号，也不会替换目标工作区所有者或降低已有权限。
              </p>
            </div>
            <label className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${inspection.canApply ? "cursor-pointer border-violet-200 bg-white text-violet-700 dark:border-violet-800 dark:bg-zinc-900 dark:text-violet-300" : "cursor-not-allowed border-zinc-200 bg-zinc-100 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/50"}`}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => onEnabledChange(event.target.checked)}
                disabled={disabled || !inspection.canApply}
                className="h-4 w-4 accent-violet-600"
              />
              应用权限
            </label>
          </div>

          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-violet-700 dark:text-violet-300">
            <span className="rounded bg-white/80 px-2 py-1 dark:bg-zinc-900/60">来源成员 {inspection.counts.principals}</span>
            <span className="rounded bg-white/80 px-2 py-1 dark:bg-zinc-900/60">工作区授权 {inspection.counts.workspaceMembers}</span>
            <span className="rounded bg-white/80 px-2 py-1 dark:bg-zinc-900/60">目录直接授权 {inspection.counts.notebookMembers}</span>
            {enabled && <span className="rounded bg-violet-600 px-2 py-1 font-semibold text-white">已映射 {mappedCount}</span>}
          </div>

          {!inspection.canApply && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-700 dark:border-amber-900/50 dark:bg-amber-500/5 dark:text-amber-300">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <span>{inspection.reason || inspection.issues[0] || "当前目标不能恢复成员与权限"}</span>
            </div>
          )}

          {enabled && inspection.canApply && (
            <div className="mt-3 space-y-2">
              {inspection.principals.map((principal) => (
                <MappingRow
                  key={principal.sourceUserId}
                  principal={principal}
                  selectedId={mappings[principal.sourceUserId]}
                  usedTargetIds={usedTargetIds}
                  disabled={disabled}
                  onSelect={(target) => {
                    const next = { ...mappings };
                    if (target) next[principal.sourceUserId] = target.id;
                    else delete next[principal.sourceUserId];
                    onMappingsChange(next);
                  }}
                />
              ))}
              <p className="text-[10px] leading-4 text-zinc-500 dark:text-zinc-400">
                未映射成员会被跳过，不影响目录、笔记和附件导入。一个目标账号只能对应一个来源成员。
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
