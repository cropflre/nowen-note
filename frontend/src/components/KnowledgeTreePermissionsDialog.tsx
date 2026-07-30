import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";

import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
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
};

const ROLE_DESCRIPTIONS: Record<KnowledgeRolePreset, string> = {
  readonly: "可查看和下载",
  editor: "可评论、创建和编辑",
  maintainer: "可编辑、移动和删除",
  admin: "可管理成员和再次分享",
};

const ROLE_OPTIONS = Object.keys(ROLE_LABELS) as KnowledgeRolePreset[];

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
  const [userQuery, setUserQuery] = useState("");
  const [userCandidates, setUserCandidates] = useState<UserPublicInfo[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserPublicInfo | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState("");
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(-1);
  const [focusUserPicker, setFocusUserPicker] = useState(false);
  const [role, setRole] = useState<KnowledgeRolePreset>("readonly");
  const [memberSearch, setMemberSearch] = useState("");
  const [showAddMember, setShowAddMember] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string; email: string | null } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [response, me] = await Promise.all([
        knowledgeTreeApi.getPermissions(node.id),
        api.getMe(),
      ]);
      setRows(response.direct);
      setInheritsFromParent(response.inheritsFromParent);
      setCurrentUser({ id: me.id, username: me.username, email: me.email });
    } catch (error: any) {
      toast.error(error?.message || "读取权限失败");
    } finally {
      setLoading(false);
    }
  }, [node.id]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!showAddMember || selectedUser || !currentUser || !candidateOpen) return;
    let cancelled = false;
    setCandidateLoading(true);
    setCandidateError("");
    setUserCandidates([]);
    setActiveCandidateIndex(-1);
    const timer = window.setTimeout(() => {
      api.searchUsers(userQuery.trim() || undefined)
        .then((users) => {
          if (cancelled) return;
          setUserCandidates(users);
          setActiveCandidateIndex(users.findIndex((user) => (
            user.id !== currentUser.id && !rows.some((row) => row.userId === user.id)
          )));
          setCandidateOpen(true);
        })
        .catch((error: any) => {
          if (cancelled) return;
          setUserCandidates([]);
          setCandidateError(error?.message || "加载人员失败，请重试");
          setCandidateOpen(true);
        })
        .finally(() => { if (!cancelled) setCandidateLoading(false); });
    }, userQuery.trim() ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [candidateOpen, currentUser, rows, selectedUser, showAddMember, userQuery]);

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

  const addMember = async () => {
    if (!selectedUser || savingKey) return;
    if (!currentUser) {
      toast.warning("正在确认当前账号，请稍后重试");
      return;
    }
    if (selectedUser.id === currentUser.id) {
      toast.warning("不能修改自己的权限");
      return;
    }
    if (rows.some((row) => row.userId === selectedUser.id)) {
      toast.warning("该用户已在成员列表中");
      return;
    }
    setSavingKey("add");
    try {
      await knowledgeTreeApi.setPermission(node.id, selectedUser.id, role);
      setCandidateOpen(false);
      setFocusUserPicker(false);
      setSelectedUser(null);
      setUserQuery("");
      setUserCandidates([]);
      setActiveCandidateIndex(-1);
      await reload();
      onChanged("permission-updated");
      toast.success("成员权限已更新");
    } catch (error: any) {
      toast.error(error?.message || "更新权限失败");
    } finally {
      setSavingKey(null);
    }
  };

  const selectUser = (user: UserPublicInfo) => {
    if (user.id === currentUser?.id || rows.some((row) => row.userId === user.id)) return;
    setSelectedUser(user);
    setCandidateOpen(false);
    setFocusUserPicker(false);
    setActiveCandidateIndex(-1);
  };

  const moveActiveCandidate = (direction: 1 | -1) => {
    const selectableIndexes = userCandidates
      .map((user, index) => ({ user, index }))
      .filter(({ user }) => user.id !== currentUser?.id && !rows.some((row) => row.userId === user.id))
      .map(({ index }) => index);
    if (selectableIndexes.length === 0) return;
    const currentPosition = selectableIndexes.indexOf(activeCandidateIndex);
    const nextPosition = currentPosition < 0
      ? (direction === 1 ? 0 : selectableIndexes.length - 1)
      : (currentPosition + direction + selectableIndexes.length) % selectableIndexes.length;
    setActiveCandidateIndex(selectableIndexes[nextPosition]);
  };

  const updateMemberRole = async (row: KnowledgePermissionRow, nextRole: KnowledgeRolePreset) => {
    if (row.rolePreset === nextRole || savingKey) return;
    if (!currentUser) {
      toast.warning("正在确认当前账号，请稍后重试");
      return;
    }
    if (row.userId === currentUser?.id) {
      toast.warning("不能修改自己的权限");
      return;
    }
    setSavingKey(row.userId);
    try {
      await knowledgeTreeApi.setPermission(node.id, row.userId, nextRole);
      setRows((current) => current.map((item) => (
        item.userId === row.userId ? { ...item, rolePreset: nextRole } : item
      )));
      onChanged("permission-role-updated");
      toast.success("成员角色已更新");
    } catch (error: any) {
      toast.error(error?.message || "更新权限失败");
    } finally {
      setSavingKey(null);
    }
  };

  const removeDirectPermission = async (row: KnowledgePermissionRow) => {
    if (!currentUser) {
      toast.warning("正在确认当前账号，请稍后重试");
      return;
    }
    if (row.userId === currentUser?.id) {
      toast.warning("不能修改自己的权限");
      return;
    }
    const inherits = Boolean(inheritsFromParent);
    const name = memberName(row);
    const accepted = await confirm({
      title: inherits ? "恢复继承权限？" : "移除成员？",
      description: inherits
        ? `${name} 将不再使用当前节点的独立角色，改为继承上级权限。`
        : `${name} 在当前节点的直接权限将被移除；下级节点已有的独立权限不会被删除。`,
      confirmText: inherits ? "恢复继承" : "移除成员",
      danger: !inherits,
    });
    if (!accepted) return;
    setSavingKey(row.userId);
    try {
      await knowledgeTreeApi.clearPermission(node.id, row.userId);
      setRows((current) => current.filter((item) => item.userId !== row.userId));
      onChanged(inherits ? "permission-inheritance-restored" : "permission-member-removed");
      toast.success(inherits ? "已恢复继承" : "当前节点权限已移除");
    } catch (error: any) {
      toast.error(error?.message || "操作失败");
    } finally {
      setSavingKey(null);
    }
  };

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
        className="flex h-[100dvh] w-full flex-col overflow-hidden border-app-border bg-app-surface shadow-2xl sm:h-auto sm:max-h-[88vh] sm:max-w-[720px] sm:rounded-2xl sm:border"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-app-border px-4 py-4 sm:px-6 sm:py-5">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
            <ShieldCheck size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="knowledge-tree-permissions-title" className="text-lg font-semibold text-tx-primary">成员与权限</h2>
            <p className="mt-0.5 truncate text-xs text-tx-tertiary">{node.title} · 权限作用于当前节点及其下级内容</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" aria-label="关闭成员与权限"><X size={19} /></button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <section className="rounded-xl border border-app-border bg-app-hover/25 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-tx-primary">
              <ShieldCheck size={16} className="text-accent-primary" />
              {inheritsFromParent ? "继承上级权限" : "当前节点独立管理"}
            </div>
            <p className="mt-1 pl-6 text-xs leading-5 text-tx-tertiary">
              {inheritsFromParent
                ? "未直接设置的成员继续继承上级权限；这里设置的角色优先生效。"
                : "当前节点没有上级权限来源；直接权限仅在这里管理，下级节点已有的独立权限仍保留。"}
            </p>
          </section>

          <section className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-tx-primary">成员</h3>
                <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-tertiary">{rows.length}</span>
              </div>
              <button
                type="button"
                disabled={!currentUser}
                onClick={() => setShowAddMember((current) => {
                  if (!current) {
                    setUserQuery("");
                    setSelectedUser(null);
                    setCandidateOpen(true);
                    setFocusUserPicker(true);
                  }
                  return !current;
                })}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent-primary hover:bg-accent-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                title={currentUser ? "添加成员" : "正在确认当前账号"}
              >
                <UserPlus size={16} />添加成员
              </button>
            </div>

            {showAddMember && (
              <div className="mt-3 rounded-xl border border-accent-primary/25 bg-accent-primary/[0.04] p-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    {selectedUser ? (
                      <div className="flex h-10 items-center gap-2 rounded-lg border border-accent-primary bg-app-bg px-2.5">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
                          {selectedUser.avatarUrl
                            ? <img src={selectedUser.avatarUrl} alt="" className="h-full w-full object-cover" />
                            : userName(selectedUser).slice(0, 1).toLocaleUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1 truncate text-sm text-tx-primary">
                          {userName(selectedUser)}
                          {selectedUser.displayName && <span className="ml-1.5 text-xs text-tx-tertiary">@{selectedUser.username}</span>}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedUser(null);
                            setUserQuery("");
                            setCandidateOpen(true);
                            setFocusUserPicker(true);
                          }}
                          className="rounded p-1 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                          aria-label={`取消选择 ${userName(selectedUser)}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex h-10 items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3 focus-within:border-accent-primary focus-within:ring-2 focus-within:ring-accent-primary/15">
                        <Search size={15} className="shrink-0 text-tx-tertiary" />
                        <input
                          value={userQuery}
                          onChange={(event) => {
                            setUserQuery(event.target.value);
                            setUserCandidates([]);
                            setActiveCandidateIndex(-1);
                            setCandidateOpen(true);
                          }}
                          onFocus={() => {
                            setCandidateOpen(true);
                            setFocusUserPicker(false);
                          }}
                          onBlur={() => window.setTimeout(() => setCandidateOpen(false), 120)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                              event.preventDefault();
                              event.stopPropagation();
                              setCandidateOpen(true);
                              moveActiveCandidate(1);
                              return;
                            }
                            if (event.key === "ArrowUp") {
                              event.preventDefault();
                              event.stopPropagation();
                              setCandidateOpen(true);
                              moveActiveCandidate(-1);
                              return;
                            }
                            if (event.key === "Escape" && candidateOpen) {
                              event.preventDefault();
                              event.stopPropagation();
                              setCandidateOpen(false);
                              return;
                            }
                            if (event.key === "Enter") {
                              event.preventDefault();
                              event.stopPropagation();
                              const candidate = userCandidates[activeCandidateIndex];
                              if (candidate) selectUser(candidate);
                            }
                          }}
                          placeholder="搜索用户名、显示名或邮箱"
                          autoFocus={focusUserPicker}
                          role="combobox"
                          aria-expanded={candidateOpen}
                          aria-controls="knowledge-tree-user-options"
                          aria-autocomplete="list"
                          aria-activedescendant={candidateOpen && activeCandidateIndex >= 0
                            ? `knowledge-tree-user-option-${userCandidates[activeCandidateIndex]?.id}`
                            : undefined}
                          className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
                        />
                        {candidateLoading && <Loader2 size={15} className="shrink-0 animate-spin text-tx-tertiary" />}
                        {userQuery && !candidateLoading && (
                          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setUserQuery("")} className="rounded p-1 text-tx-tertiary hover:bg-app-hover" aria-label="清空人员搜索">
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    )}

                    {!selectedUser && candidateOpen && (
                      <div id="knowledge-tree-user-options" role="listbox" className="absolute left-0 right-0 top-11 z-20 max-h-60 overflow-y-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-xl">
                        {candidateLoading && userCandidates.length === 0 ? (
                          <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-tx-tertiary"><Loader2 size={16} className="animate-spin" />正在加载人员</div>
                        ) : candidateError ? (
                          <div className="px-3 py-6 text-center text-sm text-red-500">{candidateError}</div>
                        ) : userCandidates.length === 0 ? (
                          <div className="px-3 py-6 text-center text-sm text-tx-tertiary">没有找到匹配人员</div>
                        ) : userCandidates.map((user, index) => {
                          const isSelf = user.id === currentUser?.id;
                          const isMember = rows.some((row) => row.userId === user.id);
                          const unavailable = isSelf || isMember;
                          return (
                            <button
                              key={user.id}
                              id={`knowledge-tree-user-option-${user.id}`}
                              type="button"
                              role="option"
                              aria-selected={activeCandidateIndex === index}
                              disabled={unavailable}
                              onMouseDown={(event) => event.preventDefault()}
                              onMouseEnter={() => { if (!unavailable) setActiveCandidateIndex(index); }}
                              onClick={() => selectUser(user)}
                              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${activeCandidateIndex === index ? "bg-app-hover" : "hover:bg-app-hover"}`}
                            >
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
                                {user.avatarUrl
                                  ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                                  : userName(user).slice(0, 1).toLocaleUpperCase()}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-tx-primary">{userName(user)}</div>
                                <div className="truncate text-xs text-tx-tertiary">@{user.username}</div>
                              </div>
                              <span className={unavailable ? "text-xs text-tx-tertiary" : "text-xs font-medium text-accent-primary"}>
                                {isSelf ? "你自己" : (isMember ? "已在成员列表中" : "选择")}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <select value={role} onChange={(event) => setRole(event.target.value as KnowledgeRolePreset)} className="h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary sm:w-32">
                    {ROLE_OPTIONS.map((preset) => <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>)}
                  </select>
                  <button type="button" disabled={!currentUser || !selectedUser || savingKey !== null} onClick={() => void addMember()} className="flex h-10 min-w-20 items-center justify-center rounded-lg bg-accent-primary px-4 text-sm font-medium text-white disabled:opacity-40">
                    {savingKey === "add" ? <Loader2 size={16} className="animate-spin" /> : "添加"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-tx-tertiary">{ROLE_LABELS[role]}：{ROLE_DESCRIPTIONS[role]}</p>
              </div>
            )}

            <div className="mt-3 overflow-hidden rounded-xl border border-app-border">
              <div className="flex h-11 items-center gap-2 border-b border-app-border px-3 sm:px-4">
                <Search size={15} className="shrink-0 text-tx-tertiary" />
                <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="搜索成员" className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary" />
                {memberSearch && <button type="button" onClick={() => setMemberSearch("")} className="rounded p-1 text-tx-tertiary hover:bg-app-hover" aria-label="清空成员搜索"><X size={14} /></button>}
              </div>

              {loading ? (
                <div className="flex justify-center py-14"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
              ) : filteredRows.length === 0 ? (
                <div className="px-4 py-14 text-center text-sm text-tx-tertiary">
                  {rows.length === 0
                    ? (inheritsFromParent ? "暂无独立成员，当前全部继承上级权限" : "暂无其他成员")
                    : "没有匹配的成员"}
                </div>
              ) : filteredRows.map((row) => {
                const isCurrentUser = row.userId === currentUser?.id;
                return (
                <div key={row.userId} className="flex flex-wrap items-center gap-3 border-b border-app-border px-3 py-3 last:border-b-0 sm:flex-nowrap sm:px-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-sm font-semibold text-accent-primary">
                    {memberName(row).slice(0, 1).toLocaleUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1 basis-[calc(100%-52px)] sm:basis-auto">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium text-tx-primary">
                      <span className="truncate">{memberName(row)}</span>
                      {isCurrentUser && <span className="shrink-0 rounded bg-app-hover px-1.5 py-0.5 text-[10px] font-normal text-tx-tertiary">你自己</span>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-tx-tertiary">{row.email || row.username} · {ROLE_DESCRIPTIONS[row.rolePreset]}</div>
                  </div>
                  <select
                    value={row.rolePreset}
                    disabled={savingKey !== null || isCurrentUser}
                    onChange={(event) => void updateMemberRole(row, event.target.value as KnowledgeRolePreset)}
                    className="ml-12 h-9 rounded-lg border border-app-border bg-app-bg px-2 text-xs text-tx-primary sm:ml-0 sm:w-28"
                    aria-label={`调整 ${memberName(row)} 的角色`}
                  >
                    {ROLE_OPTIONS.map((preset) => <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>)}
                  </select>
                  <button
                    type="button"
                    disabled={savingKey !== null || isCurrentUser}
                    onClick={() => void removeDirectPermission(row)}
                    className="rounded-lg p-2 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                    title={isCurrentUser ? "不能修改自己的权限" : (inheritsFromParent ? "恢复继承" : "移除成员")}
                    aria-label={`${inheritsFromParent ? "恢复继承" : "移除成员"} ${memberName(row)}`}
                  >
                    {savingKey === row.userId ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  </button>
                </div>
                );
              })}
            </div>
          </section>

          <section className="mt-4 grid grid-cols-2 gap-2 text-xs text-tx-tertiary sm:grid-cols-4">
            {ROLE_OPTIONS.map((preset) => (
              <div key={preset} className="rounded-lg bg-app-hover/40 px-3 py-2">
                <div className="font-medium text-tx-secondary">{ROLE_LABELS[preset]}</div>
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
