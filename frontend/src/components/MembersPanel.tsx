/**
 * MembersPanel - 工作区成员与邀请管理面板（Phase 1）
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, Plus, ChevronDown, UserPlus, Link2, Crown, Search, Loader2, Users, Activity, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatAppDate, formatAppDateTime } from "@/lib/dateTime";
import {
  Workspace,
  WorkspaceMember,
  WorkspaceInvite,
  WorkspaceGroup,
  WorkspaceActivityCategory,
  WorkspaceActivityItem,
  WorkspaceRole,
  WorkspaceFeatures,
  WORKSPACE_FEATURE_META,
  type UserPublicInfo,
} from "@/types";
import { Modal } from "@/components/WorkspaceSwitcher";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { confirm as confirmDialog } from "@/components/ui/confirm";

const ROLE_BADGE_CLASS: Record<WorkspaceRole, string> = {
  owner: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  admin: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  editor: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  commenter: "bg-green-500/20 text-green-600 dark:text-green-400",
  viewer: "bg-slate-500/20 text-slate-600 dark:text-slate-400",
};

const ACTIVITY_CATEGORY_META: Record<
  Exclude<WorkspaceActivityCategory, "all">,
  { label: string; badgeClass: string }
> = {
  docs: { label: "文档", badgeClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  issues: { label: "议题", badgeClass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  members: { label: "成员", badgeClass: "bg-purple-500/15 text-purple-600 dark:text-purple-400" },
  permissions: { label: "权限审计", badgeClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
};

interface Props {
  workspaceId: string;
  onClose: () => void;
}

export default function MembersPanel({ workspaceId, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [groups, setGroups] = useState<WorkspaceGroup[]>([]);
  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  const [tab, setTab] = useState<"members" | "groups" | "activity" | "invites" | "features">("members");
  const [loading, setLoading] = useState(true);
  const [showCreateInvite, setShowCreateInvite] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [showAddMember, setShowAddMember] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [userCandidates, setUserCandidates] = useState<UserPublicInfo[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [addRole, setAddRole] = useState<WorkspaceRole>("editor");
  const [addingUserId, setAddingUserId] = useState<string | null>(null);

  // P2：用户组状态
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupMemberDraft, setGroupMemberDraft] = useState<Record<string, string>>({});
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);

  // P2：空间动态流状态
  const [activityCategory, setActivityCategory] = useState<WorkspaceActivityCategory>("all");
  const [activityItems, setActivityItems] = useState<WorkspaceActivityItem[]>([]);
  const [canViewPermissions, setCanViewPermissions] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);

  const locale = i18n.resolvedLanguage || i18n.language;
  const isManager = workspace?.role === "owner" || workspace?.role === "admin";
  // 功能开关与管理员治理：按后端约束，仅 owner 可改；admin 可见但受同级保护约束。
  const isOwner = workspace?.role === "owner";

  const loadAll = async () => {
    setLoading(true);
    try {
      const [ws, mem, me, grp] = await Promise.all([
        api.getWorkspace(workspaceId),
        api.getWorkspaceMembers(workspaceId),
        api.getMe().catch(() => null),
        api.getWorkspaceGroups(workspaceId).catch(() => [] as WorkspaceGroup[]),
      ]);
      setWorkspace(ws);
      setMembers(mem);
      setGroups(grp);
      if (me?.id) setCurrentUserId(me.id);
      // 只有管理员才能看邀请码
      if (ws.role === "owner" || ws.role === "admin") {
        try {
          const inv = await api.getWorkspaceInvites(workspaceId);
          setInvites(inv);
        } catch {
          // 忽略
        }
        // 功能开关：任何成员都能读（后端允许），但我们这里只在管理员视图里用。
        try {
          const feat = await api.getWorkspaceFeatures(workspaceId);
          setFeatures(feat);
        } catch {
          // 后端暂不可用时，降级为 null，不阻断成员管理。
        }
      }
    } catch (e: any) {
      toast.error(e.message || t("workspaceMembers.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const loadActivity = async (category: WorkspaceActivityCategory = activityCategory) => {
    setActivityLoading(true);
    try {
      const res = await api.getWorkspaceActivity(workspaceId, category, 40);
      setActivityItems(res.items || []);
      setCanViewPermissions(Boolean(res.canViewPermissions));
    } catch (e: any) {
      toast.error(e?.message || "加载空间动态失败");
    } finally {
      setActivityLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [workspaceId]);

  useEffect(() => {
    if (tab !== "activity") return;
    void loadActivity(activityCategory);
  }, [tab, activityCategory, workspaceId]);

  // 站内搜索候选用户（自动过滤已在工作区中的成员）
  useEffect(() => {
    if (!showAddMember) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchingUsers(true);
      api
        .searchUsers(userQuery.trim() || undefined)
        .then((users) => {
          if (cancelled) return;
          const existingIds = new Set(members.map((m) => m.userId));
          setUserCandidates(users.filter((u) => !existingIds.has(u.id)));
        })
        .catch(() => {
          if (!cancelled) setUserCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setSearchingUsers(false);
        });
    }, userQuery.trim() ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showAddMember, userQuery, members]);

  const handleAddMember = async (user: UserPublicInfo) => {
    setAddingUserId(user.id);
    try {
      await api.addWorkspaceMember(workspaceId, { userId: user.id, role: addRole });
      toast.success(`已将 ${user.displayName || user.username} 加入工作区`);
      setUserQuery("");
      await loadAll();
    } catch (e: any) {
      toast.error(e.message || "添加成员失败");
    } finally {
      setAddingUserId(null);
    }
  };

  const handleTransferOwner = async (target: WorkspaceMember) => {
    const ok = await confirmDialog({
      title: `将工作区所有权转让给 ${target.username}？`,
      description: "转让后对方将成为新的所有者，你的角色会自动降为管理员（仍保留管理权限）。此操作立即生效。",
      confirmText: "确认转让",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.transferWorkspaceOwner(workspaceId, target.userId);
      toast.success(`已将所有权转让给 ${target.username}`);
      await loadAll();
    } catch (e: any) {
      toast.error(e.message || "转让所有权失败");
    }
  };

  const handleRoleChange = async (userId: string, role: WorkspaceRole) => {
    try {
      await api.updateWorkspaceMember(workspaceId, userId, role);
      toast.success(t("workspaceMembers.roleUpdated"));
      loadAll();
    } catch (e: any) {
      toast.error(e.message || t("workspaceMembers.updateFailed"));
    }
  };

  const handleRemove = async (userId: string, username: string) => {
    const ok = await confirmDialog({
      title: t("workspaceMembers.removeConfirm", { username }),
      confirmText: t("workspaceMembers.remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeWorkspaceMember(workspaceId, userId);
      toast.success(t("workspaceMembers.removed"));
      loadAll();
    } catch (e: any) {
      toast.error(e.message || t("workspaceMembers.removeFailed"));
    }
  };

  const handleDeleteInvite = async (inviteId: string) => {
    const ok = await confirmDialog({
      title: t("workspaceMembers.revokeInviteConfirm"),
      confirmText: t("workspaceMembers.revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteWorkspaceInvite(workspaceId, inviteId);
      toast.success(t("workspaceMembers.inviteRevoked"));
      loadAll();
    } catch (e) {
      toast.error((e instanceof Error && e.message) || t("workspaceMembers.actionFailed"));
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name || creatingGroup) return;
    setCreatingGroup(true);
    try {
      await api.createWorkspaceGroup(workspaceId, {
        name,
        description: newGroupDesc.trim() || undefined,
      });
      setNewGroupName("");
      setNewGroupDesc("");
      toast.success(`已创建用户组「${name}」`);
      const next = await api.getWorkspaceGroups(workspaceId);
      setGroups(next);
    } catch (err) {
      toast.error((err instanceof Error && err.message) || "创建用户组失败");
    } finally {
      setCreatingGroup(false);
    }
  };

  const handleDeleteGroup = async (group: WorkspaceGroup) => {
    const ok = await confirmDialog({
      title: `删除用户组「${group.name}」？`,
      description: "删除后不会移除成员的工作区身份，已单独授予的目录权限也会保留。",
      confirmText: "删除用户组",
      danger: true,
    });
    if (!ok) return;
    setBusyGroupId(group.id);
    try {
      await api.deleteWorkspaceGroup(workspaceId, group.id);
      toast.success(`已删除用户组「${group.name}」`);
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
    } catch (err) {
      toast.error((err instanceof Error && err.message) || "删除用户组失败");
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleAddGroupMember = async (group: WorkspaceGroup) => {
    const targetUserId = groupMemberDraft[group.id];
    if (!targetUserId || busyGroupId) return;
    setBusyGroupId(group.id);
    try {
      await api.addWorkspaceGroupMember(workspaceId, group.id, targetUserId);
      setGroupMemberDraft((prev) => ({ ...prev, [group.id]: "" }));
      const next = await api.getWorkspaceGroups(workspaceId);
      setGroups(next);
      toast.success(`已加入用户组「${group.name}」`);
    } catch (err) {
      toast.error((err instanceof Error && err.message) || "添加组成员失败");
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleRemoveGroupMember = async (group: WorkspaceGroup, userId: string, label: string) => {
    if (busyGroupId) return;
    setBusyGroupId(group.id);
    try {
      await api.removeWorkspaceGroupMember(workspaceId, group.id, userId);
      const next = await api.getWorkspaceGroups(workspaceId);
      setGroups(next);
      toast.success(`已将 ${label} 移出用户组「${group.name}」`);
    } catch (err) {
      toast.error((err instanceof Error && err.message) || "移出组成员失败");
    } finally {
      setBusyGroupId(null);
    }
  };

  // 功能开关：乐观更新 + 失败回滚。
  //   - owner 勾选时立即本地生效（侧边栏通过事件广播同步）
  //   - 后端失败则回滚 UI 并 toast
  //   - 广播自定义事件 'nowen:workspace-features-changed'，由侧边栏/路由守卫订阅
  const handleToggleFeature = async (key: keyof WorkspaceFeatures, value: boolean) => {
    if (!features || !isOwner) return;
    const prev = features;
    const next: WorkspaceFeatures = { ...features, [key]: value };
    setFeatures(next);
    try {
      const saved = await api.updateWorkspaceFeatures(workspaceId, { [key]: value });
      setFeatures(saved);
      window.dispatchEvent(
        new CustomEvent("nowen:workspace-features-changed", {
          detail: { workspaceId, features: saved },
        }),
      );
    } catch (e) {
      setFeatures(prev);
      toast.error((e instanceof Error && e.message) || t("workspaceMembers.saveFailed"));
    }
  };

  return (
    <Modal
      title={workspace ? `${workspace.icon} ${workspace.name}` : t("workspaceMembers.workspace")}
      onClose={onClose}
      widthClass="max-w-2xl"
      heightClass="h-[80vh]"
    >
      {loading ? (
        <div className="py-8 text-center text-muted-foreground">{t("workspaceMembers.loading")}</div>
      ) : (
        <div className="flex flex-col h-full min-h-0">
          <div className="flex flex-wrap gap-1 mb-4 border-b border-border shrink-0" role="tablist" aria-label="工作区管理标签页">
            <TabBtn active={tab === "members"} onClick={() => setTab("members")}>
              {t("workspaceMembers.membersCount", { count: members.length })}
            </TabBtn>
            <TabBtn active={tab === "groups"} onClick={() => setTab("groups")}>
              用户组 ({groups.length})
            </TabBtn>
            <TabBtn active={tab === "activity"} onClick={() => setTab("activity")}>
              空间动态
            </TabBtn>
            {isManager && (
              <TabBtn active={tab === "invites"} onClick={() => setTab("invites")}>
                {t("workspaceMembers.invitesCount", { count: invites.length })}
              </TabBtn>
            )}
            {isManager && (
              <TabBtn active={tab === "features"} onClick={() => setTab("features")}>
                {t("workspaceMembers.featureModules")}
              </TabBtn>
            )}
          </div>

          {tab === "members" && (
            <div className="flex flex-col flex-1 min-h-0 space-y-2">
              {isManager && (
                <div className="shrink-0 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      可直接搜索站内账号添加，或在“邀请码”页生成一键邀请链接
                    </span>
                    <Button
                      size="sm"
                      variant={showAddMember ? "outline" : "default"}
                      onClick={() => setShowAddMember((prev) => !prev)}
                      aria-expanded={showAddMember}
                    >
                      <UserPlus className="w-4 h-4 mr-1" />
                      {showAddMember ? "收起添加" : "添加成员"}
                    </Button>
                  </div>

                  {showAddMember && (
                    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative flex-1 min-w-[180px]">
                          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <Input
                            value={userQuery}
                            onChange={(e) => setUserQuery(e.target.value)}
                            placeholder="搜索用户名或昵称…"
                            aria-label="搜索站内用户"
                            className="pl-8 h-8 text-xs"
                          />
                        </div>
                        <select
                          aria-label="新成员角色"
                          value={addRole}
                          onChange={(e) => setAddRole(e.target.value as WorkspaceRole)}
                          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                        >
                          {isOwner && <option value="admin">{t("workspaceMembers.roles.admin")}</option>}
                          <option value="editor">{t("workspaceMembers.roles.editor")}</option>
                          <option value="commenter">{t("workspaceMembers.roles.commenter")}</option>
                          <option value="viewer">{t("workspaceMembers.roles.viewer")}</option>
                        </select>
                      </div>
                      <div className="max-h-36 overflow-auto space-y-1">
                        {searchingUsers ? (
                          <div className="flex items-center justify-center gap-1.5 py-3 text-xs text-muted-foreground">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            正在搜索用户…
                          </div>
                        ) : userCandidates.length === 0 ? (
                          <div className="py-2 text-center text-xs text-muted-foreground">
                            未找到可添加的站内用户
                          </div>
                        ) : (
                          userCandidates.map((candidate) => (
                            <div
                              key={candidate.id}
                              className="flex items-center justify-between gap-2 rounded px-2 py-1.5 hover:bg-accent/60"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-medium truncate">
                                  {candidate.displayName || candidate.username}
                                </div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  @{candidate.username}
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={addingUserId === candidate.id}
                                onClick={() => void handleAddMember(candidate)}
                                className="h-7 px-2.5 text-xs shrink-0"
                              >
                                {addingUserId === candidate.id ? "添加中…" : "添加"}
                              </Button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1 flex-1 min-h-0 overflow-auto">
                {members.map((m) => {
                  const joinedDate = formatAppDate(m.joinedAt, undefined, undefined, locale);
                  const isSelf = m.userId === currentUserId;
                  const canEditTarget =
                    isManager &&
                    !isSelf &&
                    m.role !== "owner" &&
                    (isOwner || m.role !== "admin");
                  return (
                    <div
                      key={m.userId}
                      className="flex items-center gap-3 p-2 rounded hover:bg-accent/50"
                    >
                      <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-sm font-semibold">
                        {m.username.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {m.username}
                          {isSelf && <span className="ml-1.5 text-xs text-muted-foreground">（我）</span>}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {m.email || t("workspaceMembers.noEmail")} · {t("workspaceMembers.joinedAt", { date: joinedDate })}
                        </div>
                      </div>
                      {canEditTarget ? (
                        <RoleSelect
                          value={m.role}
                          allowAdminOption={isOwner}
                          onChange={(role) => handleRoleChange(m.userId, role)}
                        />
                      ) : (
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-xs font-medium",
                            ROLE_BADGE_CLASS[m.role],
                          )}
                        >
                          {t(`workspaceMembers.roles.${m.role}`)}
                        </span>
                      )}
                      {isOwner && !isSelf && m.role !== "owner" && (
                        <button
                          type="button"
                          onClick={() => void handleTransferOwner(m)}
                          className="p-1.5 rounded hover:bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          title={`将所有权转让给 ${m.username}`}
                          aria-label={`将所有权转让给 ${m.username}`}
                        >
                          <Crown className="w-4 h-4" />
                        </button>
                      )}
                      {canEditTarget && (
                        <button
                          type="button"
                          onClick={() => handleRemove(m.userId, m.username)}
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                          title={t("workspaceMembers.removeMember")}
                          aria-label={`移除成员 ${m.username}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "groups" && (
            <div className="flex flex-col flex-1 min-h-0 space-y-3">
              <p className="text-xs text-muted-foreground shrink-0">
                将团队成员按部门或项目分组后，可在任意目录的「成员与权限」中按用户组一键批量授权。
              </p>
              {isManager && (
                <form
                  onSubmit={(e) => void handleCreateGroup(e)}
                  className="shrink-0 rounded-lg border border-border bg-muted/30 p-3 flex flex-wrap items-center gap-2"
                >
                  <Input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="新用户组名称（如：产品组、研发部）"
                    aria-label="新用户组名称"
                    maxLength={60}
                    className="h-8 text-xs flex-1 min-w-[160px]"
                  />
                  <Input
                    value={newGroupDesc}
                    onChange={(e) => setNewGroupDesc(e.target.value)}
                    placeholder="说明（可选）"
                    aria-label="用户组说明"
                    maxLength={200}
                    className="h-8 text-xs flex-1 min-w-[140px]"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!newGroupName.trim() || creatingGroup}
                    className="h-8 px-3 text-xs shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    {creatingGroup ? "创建中…" : "新建用户组"}
                  </Button>
                </form>
              )}

              <div className="space-y-2.5 flex-1 min-h-0 overflow-auto">
                {groups.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground" role="status">
                    <Users className="w-6 h-6 mx-auto mb-2 opacity-50" />
                    暂无用户组{isManager ? "，可在上方创建一个团队分组" : ""}
                  </div>
                ) : (
                  groups.map((group) => {
                    const existingIds = new Set(group.members.map((m) => m.userId));
                    const availableMembers = members.filter((m) => !existingIds.has(m.userId));
                    const selectedDraft = groupMemberDraft[group.id] || "";
                    const isBusy = busyGroupId === group.id;
                    return (
                      <div
                        key={group.id}
                        className="rounded-lg border border-border p-3 space-y-2.5 bg-background/60"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{group.name}</span>
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                {group.memberCount} 人
                              </span>
                            </div>
                            {group.description && (
                              <p className="text-xs text-muted-foreground mt-0.5">{group.description}</p>
                            )}
                          </div>
                          {isManager && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeleteGroup(group)}
                              className="p-1.5 rounded hover:bg-destructive/10 text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-40"
                              title={`删除用户组 ${group.name}`}
                              aria-label={`删除用户组 ${group.name}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {group.members.length === 0 ? (
                            <span className="text-xs text-muted-foreground">暂无成员</span>
                          ) : (
                            group.members.map((gm) => {
                              const label = gm.displayName || gm.username;
                              return (
                                <span
                                  key={gm.userId}
                                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs"
                                >
                                  <span>{label}</span>
                                  {isManager && (
                                    <button
                                      type="button"
                                      disabled={isBusy}
                                      onClick={() => void handleRemoveGroupMember(group, gm.userId, label)}
                                      className="rounded-full p-0.5 hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                      aria-label={`将 ${label} 移出用户组 ${group.name}`}
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  )}
                                </span>
                              );
                            })
                          )}
                        </div>

                        {isManager && (
                          <div className="flex items-center gap-2 pt-1 border-t border-border/60">
                            <select
                              aria-label={`选择要加入 ${group.name} 的成员`}
                              value={selectedDraft}
                              disabled={isBusy || availableMembers.length === 0}
                              onChange={(e) =>
                                setGroupMemberDraft((prev) => ({ ...prev, [group.id]: e.target.value }))
                              }
                              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
                            >
                              <option value="">
                                {availableMembers.length === 0
                                  ? "所有工作区成员均已加入该组"
                                  : "选择工作区成员加入此组…"}
                              </option>
                              {availableMembers.map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {m.username}（{t(`workspaceMembers.roles.${m.role}`)}）
                                </option>
                              ))}
                            </select>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!selectedDraft || isBusy}
                              onClick={() => void handleAddGroupMember(group)}
                              className="h-8 px-2.5 text-xs shrink-0"
                            >
                              加入组
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {tab === "activity" && (
            <div className="flex flex-col flex-1 min-h-0 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="按类型筛选空间动态">
                  {(
                    [
                      { key: "all", label: "全部" },
                      { key: "docs", label: "文档" },
                      { key: "issues", label: "议题" },
                      { key: "members", label: "成员" },
                      ...(canViewPermissions || isManager
                        ? [{ key: "permissions" as const, label: "权限审计" }]
                        : []),
                    ] as Array<{ key: WorkspaceActivityCategory; label: string }>
                  ).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={activityCategory === item.key}
                      onClick={() => setActivityCategory(item.key)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        activityCategory === item.key
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={activityLoading}
                  onClick={() => void loadActivity(activityCategory)}
                  className="h-7 px-2.5 text-xs"
                  aria-label="刷新空间动态"
                >
                  <RefreshCw className={cn("w-3.5 h-3.5 mr-1", activityLoading && "animate-spin")} />
                  刷新
                </Button>
              </div>

              <div className="space-y-1.5 flex-1 min-h-0 overflow-auto">
                {activityLoading ? (
                  <div className="py-10 flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    正在加载空间动态…
                  </div>
                ) : activityItems.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground" role="status">
                    <Activity className="w-6 h-6 mx-auto mb-2 opacity-50" />
                    暂无符合条件的动态记录
                  </div>
                ) : (
                  activityItems.map((item) => {
                    const meta = ACTIVITY_CATEGORY_META[item.category];
                    return (
                      <div
                        key={item.id}
                        className="flex items-start gap-2.5 rounded-lg border border-border/70 p-2.5 text-xs"
                      >
                        <span
                          className={cn(
                            "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
                            meta.badgeClass,
                          )}
                        >
                          {meta.label}
                        </span>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="leading-5">
                            <span className="font-medium text-foreground">{item.actorName}</span>{" "}
                            <span className="text-muted-foreground">{item.action}</span>{" "}
                            <span className="font-medium text-foreground">「{item.targetTitle}」</span>
                          </div>
                          {item.detail && (
                            <div className="text-[11px] text-muted-foreground">{item.detail}</div>
                          )}
                        </div>
                        <time className="shrink-0 text-[11px] text-muted-foreground whitespace-nowrap">
                          {formatAppDateTime(item.createdAt, undefined, undefined, locale)}
                        </time>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {tab === "invites" && isManager && (
            <div className="flex flex-col flex-1 min-h-0 space-y-3">
              <div className="flex justify-end shrink-0">
                <Button size="sm" onClick={() => setShowCreateInvite(true)}>
                  <Plus className="w-4 h-4 mr-1" />
                  {t("workspaceMembers.createInvite")}
                </Button>
              </div>
              <div className="space-y-2 flex-1 min-h-0 overflow-auto">
                {invites.length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    {t("workspaceMembers.noInvites")}
                  </div>
                )}
                {invites.map((inv) => (
                  <InviteItem
                    key={inv.id}
                    invite={inv}
                    onDelete={() => handleDeleteInvite(inv.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {tab === "features" && isManager && (
            <div className="space-y-3 flex-1 min-h-0 overflow-auto">
              {!features ? (
                <div className="text-center text-sm text-muted-foreground py-8">
                  {t("workspaceMembers.featuresUnavailable")}
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("workspaceMembers.featureDisabledDesc")}
                    {!isOwner && (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                        {t("workspaceMembers.ownerOnly")}
                      </span>
                    )}
                  </p>
                  <div className="space-y-1">
                    {WORKSPACE_FEATURE_META.map((meta) => (
                      <FeatureRow
                        key={meta.key}
                        label={t(`workspaceMembers.features.${meta.key}.label`)}
                        description={t(`workspaceMembers.features.${meta.key}.description`)}
                        enabled={features[meta.key]}
                        disabled={!isOwner}
                        onToggle={(v) => handleToggleFeature(meta.key, v)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {showCreateInvite && (
        <CreateInviteDialog
          workspaceId={workspaceId}
          allowAdminRole={isOwner}
          onClose={() => setShowCreateInvite(false)}
          onCreated={() => {
            setShowCreateInvite(false);
            loadAll();
          }}
        />
      )}
    </Modal>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-sm border-b-2 transition-colors -mb-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-t",
        active
          ? "border-primary text-primary font-medium"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function RoleSelect({
  value,
  allowAdminOption = true,
  onChange,
}: {
  value: WorkspaceRole;
  allowAdminOption?: boolean;
  onChange: (v: WorkspaceRole) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<
    { top: number; left: number; placement: "bottom" | "top" } | null
  >(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const options: WorkspaceRole[] = allowAdminOption
    ? ["admin", "editor", "commenter", "viewer"]
    : ["editor", "commenter", "viewer"];

  const MENU_MIN_WIDTH = 100;
  const MENU_EST_HEIGHT = 120;

  const computePos = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    const placement: "bottom" | "top" =
      spaceBelow < MENU_EST_HEIGHT + 12 && spaceAbove > spaceBelow ? "top" : "bottom";
    const width = Math.max(MENU_MIN_WIDTH, rect.width);
    let left = rect.right - width;
    if (left < 8) left = 8;
    if (left + width > vw - 8) left = vw - width - 8;
    const top = placement === "bottom" ? rect.bottom + 4 : rect.top - 4 - MENU_EST_HEIGHT;
    setPos({ top, left, placement });
  };

  useEffect(() => {
    if (!open) return;
    computePos();
    const handleDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const handleClose = () => setOpen(false);
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("touchstart", handleDown, { passive: true });
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("resize", handleClose);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("touchstart", handleDown);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("resize", handleClose);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "px-2 py-0.5 rounded text-xs font-medium flex items-center gap-1",
          ROLE_BADGE_CLASS[value],
        )}
      >
        {t(`workspaceMembers.roles.${value}`)}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && pos &&
        createPortal(
          <AnimatePresence>
            <motion.div
              ref={menuRef}
              initial={{ opacity: 0, y: pos.placement === "bottom" ? -4 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: pos.placement === "bottom" ? -4 : 4 }}
              style={{ top: pos.top, left: pos.left, minWidth: MENU_MIN_WIDTH }}
              className="fixed z-[200] bg-popover border border-border rounded shadow-lg py-1"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {options.map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    onChange(r);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-accent"
                >
                  {t(`workspaceMembers.roles.${r}`)}
                </button>
              ))}
            </motion.div>
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

function InviteItem({
  invite,
  onDelete,
}: {
  invite: WorkspaceInvite;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const expired =
    !!invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now();
  const exhausted = invite.maxUses > 0 && invite.useCount >= invite.maxUses;
  const invalid = expired || exhausted;

  const copyCode = () => {
    navigator.clipboard.writeText(invite.code);
    toast.success(t("workspaceMembers.inviteCopied"));
  };

  const copyInviteLink = () => {
    const link = `${window.location.origin}/?joinWorkspace=${encodeURIComponent(invite.code)}`;
    navigator.clipboard.writeText(link);
    toast.success("已复制一键邀请链接");
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded border border-border",
        invalid && "opacity-60",
      )}
    >
      <code
        className={cn(
          "px-2 py-1 rounded font-mono text-sm cursor-pointer bg-muted hover:bg-accent",
        )}
        onClick={copyCode}
        title={t("workspaceMembers.clickToCopy")}
      >
        {invite.code}
      </code>
      <div className="flex-1 min-w-0 text-xs text-muted-foreground">
        <div>
          {t("workspaceMembers.role")}：<span className="font-medium text-foreground">{t(`workspaceMembers.roles.${invite.role}`)}</span>
          {" · "}
          {t("workspaceMembers.uses", { used: invite.useCount, max: invite.maxUses || "∞" })}
        </div>
        <div>
          {invite.expiresAt
            ? t("workspaceMembers.validUntil", { date: formatAppDateTime(invite.expiresAt, undefined, undefined, locale) })
            : t("workspaceMembers.permanent")}
          {expired && <span className="text-destructive ml-2">{t("workspaceMembers.expired")}</span>}
          {exhausted && <span className="text-destructive ml-2">{t("workspaceMembers.exhausted")}</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={copyInviteLink}
        className="p-1.5 rounded hover:bg-accent"
        title="复制一键邀请链接"
        aria-label="复制一键邀请链接"
      >
        <Link2 className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={copyCode}
        className="p-1.5 rounded hover:bg-accent"
        title={t("workspaceMembers.copy")}
        aria-label={t("workspaceMembers.copy")}
      >
        <Copy className="w-4 h-4" />
      </button>
      <button
        onClick={onDelete}
        className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
        title={t("workspaceMembers.revoke")}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

function FeatureRow({
  label,
  description,
  enabled,
  disabled,
  onToggle,
}: {
  label: string;
  description: string;
  enabled: boolean;
  disabled: boolean;
  onToggle: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded border border-border",
        disabled && "opacity-80",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => !disabled && onToggle(!enabled)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          enabled ? "bg-primary" : "bg-muted",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
        title={disabled ? t("workspaceMembers.ownerOnly") : undefined}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
            enabled && "translate-x-4",
          )}
        />
      </button>
    </div>
  );
}

function CreateInviteDialog({
  workspaceId,
  allowAdminRole = true,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  allowAdminRole?: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [role, setRole] = useState<WorkspaceRole>("editor");
  const [maxUses, setMaxUses] = useState(10);
  const [expireDays, setExpireDays] = useState(7);
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      const expiresAt =
        expireDays > 0
          ? new Date(Date.now() + expireDays * 24 * 3600 * 1000).toISOString()
          : undefined;
      await api.createWorkspaceInvite(workspaceId, {
        role,
        maxUses: maxUses || 10,
        expiresAt,
      });
      toast.success(t("workspaceMembers.inviteGenerated"));
      onCreated();
    } catch (e) {
      toast.error((e instanceof Error && e.message) || t("workspaceMembers.createFailed"));
    } finally {
      setLoading(false);
    }
  };

  const roleOptions: WorkspaceRole[] = allowAdminRole
    ? ["admin", "editor", "commenter", "viewer"]
    : ["editor", "commenter", "viewer"];

  return (
    <Modal title={t("workspaceMembers.createInviteTitle")} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-sm mb-1 block">{t("workspaceMembers.role")}</label>
          <div className="flex gap-2 flex-wrap">
            {roleOptions.map((r) => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={cn(
                  "px-3 py-1 rounded text-sm border transition-colors",
                  role === r
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border hover:bg-accent",
                )}
              >
                {t(`workspaceMembers.roles.${r}`)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-sm mb-1 block">{t("workspaceMembers.maxUses")}</label>
          <Input
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(parseInt(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="text-sm mb-1 block">{t("workspaceMembers.expiryDays")}</label>
          <Input
            type="number"
            min={0}
            value={expireDays}
            onChange={(e) => setExpireDays(parseInt(e.target.value) || 0)}
            placeholder={t("workspaceMembers.permanentPlaceholder")}
          />
          <p className="text-xs text-muted-foreground mt-1">{t("workspaceMembers.permanentHint")}</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {t("workspaceMembers.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? t("workspaceMembers.creating") : t("workspaceMembers.generateInvite")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
