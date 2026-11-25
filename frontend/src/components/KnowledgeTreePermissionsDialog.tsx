import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Search, ShieldCheck, Stethoscope, Trash2, UserPlus, Users, X } from "lucide-react";

import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
  type EffectiveKnowledgeAccess,
  type KnowledgeAccessMode,
  type KnowledgeEffectivePermissionDiagnosis,
  type KnowledgePermissionRow,
  type KnowledgeRolePreset,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import type { UserPublicInfo, WorkspaceGroup, WorkspaceMember } from "@/types";

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

const CAPABILITY_ITEMS: Array<{
  key: keyof EffectiveKnowledgeAccess["capabilities"];
  label: string;
}> = [
  { key: "canView", label: "查看" },
  { key: "canComment", label: "评论" },
  { key: "canCreate", label: "新建" },
  { key: "canEdit", label: "编辑" },
  { key: "canMove", label: "移动" },
  { key: "canDelete", label: "删除" },
  { key: "canManageMembers", label: "管理成员" },
  { key: "canReshare", label: "再次分享" },
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
  const [currentUserAccess, setCurrentUserAccess] = useState<EffectiveKnowledgeAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");

  const [showAddMember, setShowAddMember] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [userCandidates, setUserCandidates] = useState<UserPublicInfo[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserPublicInfo | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(-1);
  const [focusUserPicker, setFocusUserPicker] = useState(false);
  const [role, setRole] = useState<KnowledgeRolePreset>("readonly");

  // P2：按工作区用户组批量授权 & 成员生效权限诊断
  const [workspaceGroups, setWorkspaceGroups] = useState<WorkspaceGroup[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [showGroupGrant, setShowGroupGrant] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groupRole, setGroupRole] = useState<KnowledgeRolePreset>("editor");
  const [showDiagnosis, setShowDiagnosis] = useState(false);
  const [diagUserId, setDiagUserId] = useState("");
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagnosis, setDiagnosis] = useState<KnowledgeEffectivePermissionDiagnosis | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [response, me, groupsRes, membersRes] = await Promise.all([
        knowledgeTreeApi.getPermissions(node.id),
        api.getMe(),
        node.workspaceId ? api.getWorkspaceGroups(node.workspaceId).catch(() => [] as WorkspaceGroup[]) : Promise.resolve([] as WorkspaceGroup[]),
        node.workspaceId ? api.getWorkspaceMembers(node.workspaceId).catch(() => [] as WorkspaceMember[]) : Promise.resolve([] as WorkspaceMember[]),
      ]);
      setRows(response.direct);
      setInheritsFromParent(response.inheritsFromParent);
      setAccessMode(response.accessMode);
      setIsExplicit(response.isExplicit === true);
      setCurrentUserAccess(response.currentUserAccess);
      setCurrentUser({ id: me.id, username: me.username });
      setWorkspaceGroups(groupsRes);
      setWorkspaceMembers(membersRes);
      if (response.currentUserAccess.source === "owner" && !response.currentUserAccess.capabilities.canManageMembers) {
        console.error("[KnowledgeTreePermissionsDialog] owner access invariant violated", {
          nodeId: node.id,
          access: response.currentUserAccess,
        });
      }
    } catch (error: any) {
      setCurrentUserAccess(null);
      toast.error(error?.message || "读取权限失败");
    } finally {
      setLoading(false);
    }
  }, [node.id, node.workspaceId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!showDiagnosis || !diagUserId) {
      setDiagnosis(null);
      return;
    }
    let cancelled = false;
    setDiagLoading(true);
    knowledgeTreeApi
      .getEffectivePermission(node.id, diagUserId)
      .then((res) => {
        if (!cancelled) setDiagnosis(res);
      })
      .catch((error: any) => {
        if (!cancelled) {
          setDiagnosis(null);
          toast.error(error?.message || "诊断生效权限失败");
        }
      })
      .finally(() => {
        if (!cancelled) setDiagLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [diagUserId, node.id, showDiagnosis, rows, accessMode]);

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
  const canManageMembers = currentUserAccess?.capabilities.canManageMembers === true;
  const managementDisabled = loading || savingKey !== null || !canManageMembers;

  const ensureCanManageMembers = () => {
    if (canManageMembers) return true;
    toast.error("你当前没有成员管理权限");
    return false;
  };

  const changeAccessMode = async (nextMode: KnowledgeAccessMode) => {
    if (!ensureCanManageMembers() || nextMode === accessMode || savingKey) return;
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

  const grantGroup = async () => {
    if (!ensureCanManageMembers() || !selectedGroupId || savingKey) return;
    setSavingKey("grant-group");
    try {
      const res = await knowledgeTreeApi.grantGroupPermission(node.id, selectedGroupId, groupRole);
      setShowGroupGrant(false);
      setSelectedGroupId("");
      await reload();
      onChanged("permission-group-granted");
      toast.success(`已为用户组「${res.groupName}」的 ${res.appliedCount} 位成员授予${ROLE_LABELS[groupRole]}`);
    } catch (error: any) {
      toast.error(error?.message || "按用户组授权失败");
    } finally {
      setSavingKey(null);
    }
  };

  const addMember = async () => {
    if (!currentUser || !ensureCanManageMembers()) return;
    if (!selectedUser || savingKey) return;
    setSavingKey("add");
    try {
      await knowledgeTreeApi.setPermission(node.id, selectedUser.id, role);
      setSelectedUser(null);
      setUserQuery("");
      setUserCandidates([]);
      setCandidateOpen(false);
      setFocusUserPicker(false);
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
    if (!ensureCanManageMembers() || row.rolePreset === nextRole || savingKey) return;
    if (row.userId === currentUser?.id) { toast.error("不能修改自己的权限"); return; }
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
    if (!ensureCanManageMembers() || savingKey) return;
    if (row.userId === currentUser?.id) { toast.error("不能修改自己的权限"); return; }
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
          : `${name} 的当前节点规则将被移除，并重新使用上级或团队空间权限。下级节点已有的独立权限不会被删除`),
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
          {!loading && currentUserAccess && !canManageMembers && (
            <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-xs leading-5 text-amber-700 dark:text-amber-300" role="status">
              你当前可以查看此内容，但没有成员管理权限。成员角色、禁止访问和访问范围只能由所有者或管理员修改。
            </div>
          )}

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
                  disabled={managementDisabled}
                  onClick={() => void changeAccessMode("inherit")}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${accessMode === "inherit" ? "bg-app-surface text-tx-primary shadow-sm" : "text-tx-tertiary hover:text-tx-primary"}`}
                >
                  继承权限
                </button>
                <button
                  type="button"
                  disabled={managementDisabled}
                  onClick={() => void changeAccessMode("restricted")}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${accessMode === "restricted" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "text-tx-tertiary hover:text-tx-primary"}`}
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
              <div className="flex items-center gap-1.5">
                {node.workspaceId && canManageMembers && (
                  <button
                    type="button"
                    disabled={managementDisabled}
                    aria-expanded={showGroupGrant}
                    onClick={() => {
                      if (!ensureCanManageMembers()) return;
                      setShowGroupGrant((current) => !current);
                      setShowAddMember(false);
                    }}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                  >
                    <Users size={15} />按用户组授权
                  </button>
                )}
                <button
                  type="button"
                  disabled={!currentUser || managementDisabled}
                  onClick={() => {
                    if (!ensureCanManageMembers()) return;
                    setShowAddMember((current) => !current);
                    setShowGroupGrant(false);
                    setSelectedUser(null);
                    setUserQuery("");
                    setUserCandidates([]);
                    setCandidateOpen(true);
                  }}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent-primary hover:bg-accent-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <UserPlus size={16} />添加成员
                </button>
              </div>
            </div>

            {showGroupGrant && node.workspaceId && (
              <div className="mt-3 rounded-xl border border-app-border bg-app-hover/30 p-3">
                {workspaceGroups.length === 0 ? (
                  <p className="text-xs text-tx-tertiary">
                    当前工作区暂无用户组，请先在工作区「成员与设置 → 用户组」中创建分组。
                  </p>
                ) : (
                  <>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <select
                        aria-label="选择要授权的用户组"
                        value={selectedGroupId}
                        disabled={managementDisabled}
                        onChange={(event) => setSelectedGroupId(event.target.value)}
                        className="h-10 flex-1 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <option value="">选择工作区用户组…</option>
                        {workspaceGroups.map((group) => (
                          <option key={group.id} value={group.id} disabled={group.memberCount === 0}>
                            {group.name}（{group.memberCount} 人）
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="用户组授权角色"
                        value={groupRole}
                        disabled={managementDisabled}
                        onChange={(event) => setGroupRole(event.target.value as KnowledgeRolePreset)}
                        className="h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary disabled:cursor-not-allowed disabled:opacity-40 sm:w-36"
                      >
                        {ROLE_OPTIONS.map((preset) => (
                          <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={!selectedGroupId || managementDisabled}
                        onClick={() => void grantGroup()}
                        className="flex h-10 min-w-24 items-center justify-center rounded-lg bg-accent-primary px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {savingKey === "grant-group" ? <Loader2 size={16} className="animate-spin" /> : "批量授权"}
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-tx-tertiary">
                      将为所选用户组内所有有效工作区成员批量写入当前节点的「{ROLE_LABELS[groupRole]}」规则。
                    </p>
                  </>
                )}
              </div>
            )}

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
                          disabled={!canManageMembers}
                          onChange={(event) => { setUserQuery(event.target.value); setActiveCandidateIndex(-1); setCandidateOpen(true); }}
                          onFocus={() => setCandidateOpen(true)}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowDown") { event.preventDefault(); setActiveCandidateIndex((index) => Math.min(index + 1, userCandidates.length - 1)); }
                            if (event.key === "ArrowUp") { event.preventDefault(); setActiveCandidateIndex((index) => Math.max(index - 1, -1)); }
                            if (event.key === "Escape") { event.stopPropagation(); setCandidateOpen(false); }
                            if (event.key === "Enter" && activeCandidateIndex >= 0) { event.preventDefault(); const candidate = userCandidates[activeCandidateIndex]; if (candidate) { setSelectedUser(candidate); setCandidateOpen(false); } }
                          }}
                          aria-activedescendant={activeCandidateIndex >= 0 ? `knowledge-user-candidate-${activeCandidateIndex}` : undefined}
                          autoFocus={focusUserPicker}
                          placeholder="搜索用户名、显示名或邮箱"
                          className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary disabled:cursor-not-allowed"
                        />
                        {candidateLoading && <Loader2 size={15} className="animate-spin text-tx-tertiary" />}
                      </div>
                    )}
                    {!selectedUser && candidateOpen && canManageMembers && (
                      <div role="listbox" className="absolute left-0 right-0 top-11 z-20 max-h-56 overflow-y-auto rounded-xl border border-app-border bg-app-surface py-1 shadow-xl">
                        {candidateLoading && userCandidates.length === 0 ? (
                          <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-tx-tertiary"><Loader2 size={16} className="animate-spin" />加载中</div>
                        ) : userCandidates.length === 0 ? (
                          <div className="px-3 py-6 text-center text-sm text-tx-tertiary">没有可添加的成员（已在成员列表中的用户不会重复显示）</div>
                        ) : userCandidates.map((user) => (
                          <button
                            key={user.id}
                            id={`knowledge-user-candidate-${userCandidates.indexOf(user)}`}
                            role="option"
                            aria-selected={userCandidates.indexOf(user) === activeCandidateIndex}
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
                  <select
                    value={role}
                    disabled={managementDisabled}
                    onChange={(event) => setRole(event.target.value as KnowledgeRolePreset)}
                    className="h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm text-tx-primary disabled:cursor-not-allowed disabled:opacity-40 sm:w-36"
                  >
                    {ROLE_OPTIONS.map((preset) => <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>)}
                  </select>
                  <button type="button" disabled={!selectedUser || managementDisabled} onClick={() => void addMember()} className="flex h-10 min-w-20 items-center justify-center rounded-lg bg-accent-primary px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
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
                      disabled={managementDisabled || isCurrentUser}
                      onChange={(event) => void updateMemberRole(row, event.target.value as KnowledgeRolePreset)}
                      className={`ml-12 h-9 rounded-lg border bg-app-bg px-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 sm:ml-0 sm:w-32 ${isDenied ? "border-red-500/30 text-red-500" : "border-app-border text-tx-primary"}`}
                    >
                      {ROLE_OPTIONS.map((preset) => <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>)}
                    </select>
                    <button
                      type="button"
                      disabled={managementDisabled || isCurrentUser}
                      onClick={() => void removeRule(row)}
                      className="rounded-lg p-2 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
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

          {canManageMembers && node.workspaceId && workspaceMembers.length > 0 && (
            <section className="mt-4 rounded-xl border border-app-border bg-app-hover/20 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
                  <Stethoscope size={15} className="text-accent-primary" />
                  生效权限诊断
                </div>
                <button
                  type="button"
                  aria-expanded={showDiagnosis}
                  onClick={() => {
                    setShowDiagnosis((prev) => {
                      const next = !prev;
                      if (next && !diagUserId && workspaceMembers[0]) {
                        setDiagUserId(workspaceMembers[0].userId);
                      }
                      return next;
                    });
                  }}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium text-accent-primary hover:bg-accent-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                >
                  {showDiagnosis ? "收起诊断" : "检查成员最终权限"}
                </button>
              </div>

              {showDiagnosis && (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor="knowledge-perm-diag-user" className="text-xs text-tx-secondary">
                      诊断对象：
                    </label>
                    <select
                      id="knowledge-perm-diag-user"
                      aria-label="选择要诊断生效权限的成员"
                      value={diagUserId}
                      onChange={(event) => setDiagUserId(event.target.value)}
                      className="h-9 flex-1 min-w-[200px] rounded-lg border border-app-border bg-app-bg px-3 text-xs text-tx-primary"
                    >
                      <option value="">请选择工作区成员…</option>
                      {workspaceMembers.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.username}（空间角色：{member.role}）
                        </option>
                      ))}
                    </select>
                  </div>

                  {diagLoading ? (
                    <div className="flex items-center gap-2 py-2 text-xs text-tx-tertiary" role="status">
                      <Loader2 size={14} className="animate-spin" />
                      正在计算最终生效权限…
                    </div>
                  ) : diagnosis ? (
                    <div className="space-y-2.5 rounded-lg border border-app-border bg-app-surface p-3" role="status" aria-live="polite">
                      <div className="text-xs leading-5 text-tx-primary">
                        <span className="font-semibold">{diagnosis.user.displayName || diagnosis.user.username}</span>
                        {" · "}
                        <span>{diagnosis.explanation}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {CAPABILITY_ITEMS.map((cap) => {
                          const allowed = diagnosis.effective.capabilities[cap.key];
                          return (
                            <div
                              key={cap.key}
                              aria-label={`${cap.label}：${allowed ? "允许" : "不允许"}`}
                              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
                                allowed
                                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                  : "bg-app-hover/60 text-tx-tertiary"
                              }`}
                            >
                              {allowed ? <Check size={13} /> : <X size={13} />}
                              <span>{cap.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>,
    document.body,
  );
}
