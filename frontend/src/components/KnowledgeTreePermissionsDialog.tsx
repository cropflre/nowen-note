import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";

import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgeAccessMode,
  type KnowledgePermissionRow,
  type KnowledgeRolePreset,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import type { UserPublicInfo } from "@/types";

const ROLE_LABELS: Record<KnowledgeRolePreset, string> = {
  readonly: "只读成员",
  editor: "编辑成员",
  maintainer: "维护成员",
  admin: "管理员",
  deny: "禁止访问",
};

const ROLE_DESCRIPTIONS: Record<KnowledgeRolePreset, string> = {
  readonly: "可查看和下载",
  editor: "可评论、创建和编辑",
  maintainer: "可编辑、移动和删除",
  admin: "可管理成员和再次分享",
  deny: "无法查看当前节点及下级内容",
};

const ROLE_OPTIONS: KnowledgeRolePreset[] = [
  "readonly",
  "editor",
  "maintainer",
  "admin",
  "deny",
];

interface Props {
  node: KnowledgeTreeNode;
  onClose: () => void;
  onChanged: (reason: string) => void;
}

function memberName(row: KnowledgePermissionRow): string {
  return row.displayName || row.username || row.email || "未知成员";
}

function userName(user: UserPublicInfo): string {
  return user.displayName || user.username;
}

export default function KnowledgeTreePermissionsDialog({ node, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<KnowledgePermissionRow[]>([]);
  const [inheritsFromParent, setInheritsFromParent] = useState<string | null>(null);
  const [accessMode, setAccessMode] = useState<KnowledgeAccessMode>("inherit");
  const [isExplicit, setIsExplicit] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");

  const [showAddMember, setShowAddMember] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [userCandidates, setUserCandidates] = useState<UserPublicInfo[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserPublicInfo | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [role, setRole] = useState<KnowledgeRolePreset>("readonly");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [response, me] = await Promise.all([
        knowledgeTreeApi.getPermissions(node.id),
        api.getMe(),
      ]);
      setRows(response.direct);
      setInheritsFromParent(response.inheritsFromParent);
      setAccessMode(response.accessMode);
      setIsExplicit(response.isExplicit === true);
      setCurrentUser({ id: me.id, username: me.username });
    } catch (error: any) {
      toast.error(error?.message || "读取权限失败");
    } finally {
      setLoading(false);
    }
  }, [node.id]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (!showAddMember || selectedUser || !candidateOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCandidateLoading(true);
      api.searchUsers(userQuery.trim() || undefined)
        .then((users) => {
          if (cancelled) return;
          setUserCandidates(users.filter((user) => (
            user.id !== currentUser?.id && !rows.some((row) => row.userId === user.id)
          )));
        })
        .catch((error: any) => {
          if (!cancelled) toast.error(error?.message || "加载人员失败");
        })
        .finally(() => { if (!cancelled) setCandidateLoading(false); });
    }, userQuery.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [candidateOpen, currentUser?.id, rows, selectedUser, showAddMember, userQuery]);

  const filteredRows = useMemo(() => {
    const query = memberSearch.trim().toLocaleLowerCase();
    if (!query) return rows;
    return rows.filter((row) => [
      row.displayName,
      row.username,
      row.email,
      ROLE_LABELS[row.rolePreset],
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [memberSearch, rows]);

  const allowRows = useMemo(
    () => rows.filter((row) => row.rolePreset !== "deny"),
    [rows],
  );
  const denyRows = useMemo(
    () => rows.filter((row) => row.rolePreset === "deny"),
    [rows],
  );

  const changeAccessMode = async (nextMode: KnowledgeAccessMode) => {
    if (nextMode === accessMode || savingKey) return;
    if (nextMode === "inherit") {
      const accepted = await confirm({
        title: "恢复继承权限？",
        description: inheritsFromParent
          ? "当前节点将重新继承上级可见范围。已有成员规则会保留并继续作为角色覆盖或禁止规则。"
          : "当前节点将重新按团队空间角色开放。已有成员规则会保留并继续作为角色覆盖或禁止规则。",
        confirmText: "恢复继承",
      });
      if (!accepted) return;
    }

    setSavingKey("access-mode");
    try {
      await knowledgeTreeApi.setAccessMode(node.id, nextMode);
      await reload();
      onChanged("permission-access-mode-updated");
      toast.success(nextMode === "restricted" ? "已设为仅指定成员可访问" : "已恢复继承权限");
    } catch (error: any) {
      toast.error(error?.message || "更新访问模式失败");
    } finally {
      setSavingKey(null);
    }
  };

  const addMember = async () => {
    if (!selectedUser || savingKey) return;
    setSavingKey("add");
    try {
      await knowledgeTreeApi.setPermission(node.id, selectedUser.id, role);
      setSelectedUser(null);
      setUserQuery("");
      setUserCandidates([]);
      setCandidateOpen(false);
      setShowAddMember(false);
      await reload();
      onChanged(role === "deny" ? "permission-denied" : "permission-updated");
      toast.success(role === "deny" ? "已禁止该成员访问" : "成员权限已更新");
    } catch (error: any) {
      toast.error(error?.message || "更新权限失败");
    } finally {
      setSavingKey(null);
    }
  };

  const updateMemberRole = async (row: KnowledgePermissionRow, nextRole: KnowledgeRolePreset) => {
    if (row.rolePreset === nextRole || savingKey || row.userId === currentUser?.id) return;
    setSavingKey(row.userId);
    try {
      await knowledgeTreeApi.setPermission(node.id, row.userId, nextRole);
      await reload();
      onChanged(nextRole === "deny" ? "permission-denied" : "permission-role-updated");
      toast.success(nextRole === "deny" ? "已禁止该成员访问" : "成员角色已更新");
    } catch (error: any) {
      toast.error(error?.message || "更新权限失败");
    } finally {
      setSavingKey(null);
    }
  };

  const removeRule = async (row: KnowledgePermissionRow) => {
    if (savingKey || row.userId === currentUser?.id) return;
    const name = memberName(row);
    const removesLastAutomaticAllow =
      row.rolePreset !== "deny"
      && accessMode === "restricted"
      && !isExplicit
      && allowRows.length === 1;
    const accepted = await confirm({
      title: row.rolePreset === "deny"
        ? "取消禁止访问？"
        : (removesLastAutomaticAllow ? "恢复继承权限？" : "移除成员规则？"),
      description: row.rolePreset === "deny"
        ? `${name} 将重新按当前节点的继承或允许规则获得权限。`
        : (removesLastAutomaticAllow
          ? `移除 ${name} 后，自动建立的仅指定成员模式将恢复为继承权限。`
          : `${name} 的当前节点规则将被移除，并重新使用上级或团队空间权限。`),
      confirmText: row.rolePreset === "deny" ? "取消禁止" : "移除规则",
      danger: row.rolePreset !== "deny" && !removesLastAutomaticAllow,
    });
    if (!accepted) return;

    setSavingKey(row.userId);
    try {
      await knowledgeTreeApi.clearPermission(node.id, row.userId);
      await reload();
      onChanged("permission-rule-removed");
      toast.success(row.rolePreset === "deny" ? "已取消禁止访问" : "成员规则已移除");
    } catch (error: any) {
      toast.error(error?.message || "操作失败");
    } finally {
      setSavingKey(null);
    }
  };

  const policyTitle = accessMode === "restricted"
    ? "仅指定成员可访问"
    : (inheritsFromParent ? "继承上级权限" : "继承团队空间权限");
  const policyDescription = accessMode === "restricted"
    ? (allowRows.length === 0
      ? "当前没有允许成员，除空间所有者外其他成员均不可访问。可保持为空作为完全私有目录。"
      : "允许名单中的成员可以访问；未列出的普通团队成员不可查看。禁止规则优先于同级允许规则。")
    : (inheritsFromParent
      ? "沿用上级可见范围和角色，当前节点的成员规则作为局部覆盖。"
      : "按团队空间角色开放，当前节点的成员规则作为局部覆盖。"
    );

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      data-knowledge-tree-permissions-dialog="true"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-tree-permissions-title"
        className="flex h-[100dvh] w-full flex-col overflow-hidden border-app-border bg-app-surface shadow-2xl sm:h-auto sm:max-h-[88vh] sm:max-w-[760px] sm:rounded-2xl sm:border"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-app-border px-4 py-4 sm:px-6 sm:py-5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
            <ShieldCheck size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="knowledge-tree-permissions-title" className="text-lg font-semibold text-tx-primary">成员与权限</h2>
            <p className="mt-0.5 truncate text-xs text-tx-tertiary">{node.title} · 权限作用于当前节点及其下级内容</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" aria-label="关闭成员与权限">
            <X size={19} />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <section className={`rounded-xl border px-4 py-4 ${accessMode === "restricted" ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-app-border bg-app-hover/25"}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
                  <ShieldCheck size={16} className={accessMode === "restricted" ? "text-amber-500" : "text-accent-primary"} />
                  {policyTitle}
                </div>
                <p className="mt-1 pl-6 text-xs leading-5 text-tx-tertiary">{policyDescription}</p>
              </div>
              <div className="flex shrink-0 rounded-lg border border-app-border bg-app-bg p-1">
                <button
                  type="button"
                  disabled={savingKey !== null}
                  onClick={() => void changeAccessMode("inherit")}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${accessMode === "inherit" ? "bg-app-surface text-tx-primary shadow-sm" : "text-tx-tertiary hover:text-tx-primary"}`}
                >
                  继承权限
                </button>
                <button
                  type="button"
                  disabled={savingKey !== null}
                  onClick={() => void changeAccessMode("restricted")}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium ${accessMode === "restricted" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "text-tx-tertiary hover:text-tx-primary"}`}
                >
                  仅指定成员
                </button>
              </div>
            </div>
          </section>

          <section className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-tx-primary">成员规则</h3>
                <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-tertiary">允许 {allowRows.length} · 禁止 {denyRows.length}</span>
              </div>
              <button
                type="button"
                disabled={!currentUser || savingKey !== null}
                onClick={() => {
                  setShowAddMember((current) => !current);
                  setSelectedUser(null);
                  setUserQuery("");
                  setUserCandidates([]);
                  setCandidateOpen(true);
                }}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent-primary hover:bg-accent-primary/10 disabled:opacity-40"
              >
                <UserPlus size={16} />添加规则
              </button>
            </div>

            {showAddMember && (
              <div className="mt-3 rounded-xl border border-accent-primary/25 bg-accent-primary/[0.04] p-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    {selectedUser ? (
                      <div className="flex h-10 items-center gap-2 rounded-lg border border-accent-primary bg-app-bg px-3">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
                          {userName(selectedUser).slice(0, 1).toLocaleUpperCase()}
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm text-tx-primary">{userName(selectedUser)}</span>
                        <button type="button" onClick={() => { setSelectedUser(null); setCandidateOpen(true); }} className="rounded p-1 text-tx-tertiary hover:bg-app-hover">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex h-10 items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3 focus-within:border-accent-primary focus-within:ring-2 focus-within:ring-accent-primary/15">
                        <Search size={15} className="text-tx-tertiary" />
                        <input
                          value={userQuery}
                          onChange={(event) => { setUserQuery(event.target.value); setCandidateOpen(true); }}
                          onFocus={() => setCandidateOpen(true)}
                          placeholder="搜索用户名、显示名或邮箱"
                          className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
                        />
                        {candidateLoading && <Loader2 size={15} className="animate-spin text-tx-tertiary" />}
                      </div>
                    )}
                    {!selectedUser && candidateOpen && (
                      <div className="absolute left-0 right-0 top-11 z-20 max-h-56 overflow-y-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-xl">
                        {candidateLoading && userCandidates.length === 0 ? (
                          <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-tx-tertiary"><Loader2 size={16} className="animate-spin" />加载中</div>
                        ) : userCandidates.length === 0 ? (
                          <div className="px-3 py-6 text-center text-sm text-tx-tertiary">没有可添加的成员</div>
                        ) : userCandidates.map((user) => (
                          <button
                            key={user.id}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => { setSelectedUser(user); setCandidateOpen(false); }}
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-app-hover"
                          >
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
                              {userName(user).slice(0, 1).toLocaleUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-tx-primary">{userName(user)}</div>
                              <div className="truncate text-xs text-tx-tertiary">@{user.username}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <select value={role} onChange={(event) => setRole(event.target.value as KnowledgeRolePreset)} className="h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary sm:w-36">
                    {ROLE_OPTIONS.map((preset) => <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>)}
                  </select>
                  <button type="button" disabled={!selectedUser || savingKey !== null} onClick={() => void addMember()} className="flex h-10 min-w-20 items-center justify-center rounded-lg bg-accent-primary px-4 text-sm font-medium text-white disabled:opacity-40">
                    {savingKey === "add" ? <Loader2 size={16} className="animate-spin" /> : "添加"}
                  </button>
                </div>
                <p className={`mt-2 text-xs ${role === "deny" ? "text-red-500" : "text-tx-tertiary"}`}>{ROLE_LABELS[role]}：{ROLE_DESCRIPTIONS[role]}</p>
              </div>
            )}

            <div className="mt-3 overflow-hidden rounded-xl border border-app-border">
              <div className="flex h-11 items-center gap-2 border-b border-app-border px-3 sm:px-4">
                <Search size={15} className="text-tx-tertiary" />
                <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="搜索成员规则" className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary" />
                {memberSearch && <button type="button" onClick={() => setMemberSearch("")} className="rounded p-1 text-tx-tertiary hover:bg-app-hover"><X size={14} /></button>}
              </div>

              {loading ? (
                <div className="flex justify-center py-14"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
              ) : filteredRows.length === 0 ? (
                <div className="px-4 py-14 text-center text-sm text-tx-tertiary">
                  {rows.length === 0 ? "暂无成员规则" : "没有匹配的成员规则"}
                </div>
              ) : filteredRows.map((row) => {
                const isCurrentUser = row.userId === currentUser?.id;
                const isDenied = row.rolePreset === "deny";
                return (
                  <div key={row.userId} className={`flex flex-wrap items-center gap-3 border-b border-app-border px-3 py-3 last:border-b-0 sm:flex-nowrap sm:px-4 ${isDenied ? "bg-red-500/[0.03]" : ""}`}>
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${isDenied ? "bg-red-500/10 text-red-500" : "bg-accent-primary/10 text-accent-primary"}`}>
                      {memberName(row).slice(0, 1).toLocaleUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1 basis-[calc(100%-52px)] sm:basis-auto">
                      <div className="flex items-center gap-2 truncate text-sm font-medium text-tx-primary">
                        <span className="truncate">{memberName(row)}</span>
                        {isDenied && <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-normal text-red-500">禁止访问</span>}
                        {isCurrentUser && <span className="rounded bg-app-hover px-1.5 py-0.5 text-[10px] font-normal text-tx-tertiary">你自己</span>}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-tx-tertiary">{row.email || `@${row.username}`} · {ROLE_DESCRIPTIONS[row.rolePreset]}</div>
                    </div>
                    <select
                      value={row.rolePreset}
                      disabled={savingKey !== null || isCurrentUser}
                      onChange={(event) => void updateMemberRole(row, event.target.value as KnowledgeRolePreset)}
                      className={`ml-12 h-9 rounded-lg border bg-app-bg px-2 text-xs sm:ml-0 sm:w-32 ${isDenied ? "border-red-500/30 text-red-500" : "border-app-border text-tx-primary"}`}
                    >
                      {ROLE_OPTIONS.map((preset) => <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>)}
                    </select>
                    <button
                      type="button"
                      disabled={savingKey !== null || isCurrentUser}
                      onClick={() => void removeRule(row)}
                      className="rounded-lg p-2 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                      aria-label={`移除 ${memberName(row)} 的权限规则`}
                    >
                      {savingKey === row.userId ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-4 grid grid-cols-2 gap-2 text-xs text-tx-tertiary sm:grid-cols-5">
            {ROLE_OPTIONS.map((preset) => (
              <div key={preset} className={`rounded-lg px-3 py-2 ${preset === "deny" ? "bg-red-500/[0.06]" : "bg-app-hover/40"}`}>
                <div className={`font-medium ${preset === "deny" ? "text-red-500" : "text-tx-secondary"}`}>{ROLE_LABELS[preset]}</div>
                <div className="mt-0.5 leading-4">{ROLE_DESCRIPTIONS[preset]}</div>
              </div>
            ))}
          </section>
        </main>
      </div>
    </div>,
    document.body,
  );
}
