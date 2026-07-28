import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Crown,
  Gear,
  Link2,
  LockKeyhole,
  MessageCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Unlink,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { buildPublicWebUrl } from "@/lib/publicWebOrigin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { Notebook, NotebookMember, NotebookShareLink, User, UserPublicInfo } from "@/types";
import {
  notebookPublicationApi,
  type ManagedPublicationComment,
  type NotebookDirectoryPermission,
  type NotebookPermissionOverride,
  type NotebookPublication,
  type NotebookPublicationAccessMode,
  type NotebookPublicationPermission,
} from "@/lib/notebookPublicationApi";

interface Props {
  notebook: Notebook;
  onClose: () => void;
}

type View = "overview" | "scope" | "permissions";
type MemberRole = "viewer" | "editor";

const bool = (value: number | boolean | undefined) => value === true || value === 1;
const localDateTime = (value: string | null | undefined) =>
  value
    ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16)
    : "";

const permissionLabel = (permission: NotebookDirectoryPermission) =>
  ({ none: "不可见", read: "可查看", comment: "可评论", write: "可编辑", manage: "可管理" })[
    permission
  ];

const memberRoleLabel = (role: NotebookMember["role"]) =>
  role === "owner" ? "所有者" : role === "editor" ? "可编辑" : "可查看";

function displayName(member: Pick<NotebookMember, "displayName" | "username" | "userId">) {
  return member.displayName || member.username || member.userId;
}

function sourceLabel(source: NotebookMember["source"]) {
  if (source === "invite_link") return "通过邀请链接加入";
  if (source === "publication") return "通过公开发布加入";
  return "直接添加";
}

function Avatar({ member, size = 38 }: { member: NotebookMember; size?: number }) {
  const name = displayName(member);
  return member.avatarUrl ? (
    <img
      src={member.avatarUrl}
      alt=""
      className="shrink-0 rounded-md object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className="flex shrink-0 items-center justify-center rounded-md bg-accent-primary/10 text-sm font-semibold text-accent-primary"
      style={{ width: size, height: size }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-lg border border-app-border p-3 text-xs",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{title}</span>
    </label>
  );
}

export default function NotebookShareDialog({ notebook, onClose }: Props) {
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [members, setMembers] = useState<NotebookMember[]>([]);
  const [link, setLink] = useState<NotebookShareLink | null>(null);
  const [publication, setPublication] = useState<NotebookPublication | null>(null);
  const [overrides, setOverrides] = useState<NotebookPermissionOverride[]>([]);
  const [inheritsFromParent, setInheritsFromParent] = useState<string | null>(null);
  const [comments, setComments] = useState<ManagedPublicationComment[]>([]);

  const [memberSearch, setMemberSearch] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [showAddMember, setShowAddMember] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UserPublicInfo[]>([]);
  const [role, setRole] = useState<MemberRole>("viewer");

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferring, setTransferring] = useState(false);

  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [inviteMaxUses, setInviteMaxUses] = useState("");

  const [accessMode, setAccessMode] = useState<NotebookPublicationAccessMode>("link");
  const [publicPermission, setPublicPermission] = useState<NotebookPublicationPermission>("read");
  const [publicSecret, setPublicSecret] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [allowDownload, setAllowDownload] = useState(true);
  const [allowComment, setAllowComment] = useState(false);
  const [allowEdit, setAllowEdit] = useState(false);
  const [allowReshare, setAllowReshare] = useState(false);

  const [aclQuery, setAclQuery] = useState("");
  const [aclCandidates, setAclCandidates] = useState<UserPublicInfo[]>([]);
  const [aclPermission, setAclPermission] = useState<NotebookDirectoryPermission>("read");
  const [aclAllowDownload, setAclAllowDownload] = useState(true);
  const [aclAllowReshare, setAclAllowReshare] = useState(false);

  const shareUrl = useMemo(
    () => (link?.token ? buildPublicWebUrl(`/notebook-share/${link.token}`) : ""),
    [link?.token],
  );
  const publicationUrl = useMemo(
    () =>
      publication?.token && bool(publication.isActive)
        ? buildPublicWebUrl(`/public/${publication.token}`)
        : "",
    [publication?.token, publication?.isActive],
  );

  const owner = useMemo(() => members.find((member) => member.role === "owner") || null, [members]);
  const collaborators = useMemo(
    () => members.filter((member) => member.role !== "owner"),
    [members],
  );
  const normalizedMemberSearch = memberSearch.trim().toLowerCase();
  const filteredCollaborators = useMemo(
    () =>
      collaborators.filter((member) => {
        if (!normalizedMemberSearch) return true;
        return [member.displayName, member.username, member.email]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedMemberSearch));
      }),
    [collaborators, normalizedMemberSearch],
  );

  const activePublication = Boolean(publication && bool(publication.isActive));
  const scopeMode = activePublication ? "public" : link ? "invite" : "private";
  const scopeTitle =
    scopeMode === "public"
      ? "通过公开链接访问"
      : scopeMode === "invite"
        ? "登录后持链接加入"
        : "仅文档协作者可访问";
  const scopeDescription =
    scopeMode === "public"
      ? `公开权限：${publicPermission === "write" ? "登录后可编辑" : publicPermission === "comment" ? "可评论" : "仅查看"}`
      : scopeMode === "invite"
        ? `新成员加入后${role === "editor" ? "可编辑" : "仅查看"}`
        : "未被添加的用户无法访问此目录";
  const currentCopyUrl = publicationUrl || shareUrl;
  const canTransferOwnership =
    notebook.workspaceId === null && owner?.userId === me?.id && collaborators.length > 0;

  const applyPublication = (value: NotebookPublication | null) => {
    setPublication(value);
    if (!value) return;
    setAccessMode(value.accessMode);
    setPublicPermission(value.permission);
    setExpiresAt(localDateTime(value.expiresAt));
    setAllowDownload(bool(value.allowDownload));
    setAllowComment(bool(value.allowComment));
    setAllowEdit(bool(value.allowEdit));
    setAllowReshare(bool(value.allowReshare));
    setPublicSecret("");
  };

  const applyLink = (value: NotebookShareLink | null) => {
    setLink(value);
    if (!value) return;
    setRole(value.role);
    setInviteExpiresAt(localDateTime(value.expiresAt));
    setInviteMaxUses(value.maxUses ? String(value.maxUses) : "");
  };

  const reload = async () => {
    const [nextMe, nextMembers, nextLink, nextPublication, nextOverrides] = await Promise.all([
      api.getMe(),
      api.getNotebookMembers(notebook.id),
      api.getNotebookShareLink(notebook.id),
      notebookPublicationApi.getPublication(notebook.id),
      notebookPublicationApi.getPermissionOverrides(notebook.id),
    ]);
    setMe(nextMe);
    setMembers(nextMembers);
    applyLink(nextLink);
    applyPublication(nextPublication);
    setOverrides(nextOverrides.direct);
    setInheritsFromParent(nextOverrides.inheritsFromParent);
    setSelectedMemberIds(new Set());
  };

  const loadComments = async () => {
    if (!publication || !bool(publication.isActive)) {
      setComments([]);
      return;
    }
    try {
      setComments(await notebookPublicationApi.getManagedComments(notebook.id));
    } catch (error: any) {
      toast.error(error?.message || "加载公开评论失败");
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((error: any) => !cancelled && toast.error(error?.message || "加载权限设置失败"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [notebook.id]);

  useEffect(() => {
    if (view === "scope" && activePublication) void loadComments();
  }, [view, publication?.id, publication?.isActive]);

  const copy = async (value: string) => {
    if (!value) {
      toast.warning("当前仅协作者可访问，请先在“分享范围”中开启链接访问");
      return;
    }
    const copied = await copyText(value);
    if (copied) toast.success("链接已复制");
    else toast.error("复制失败");
  };

  const searchUsers = async (kind: "member" | "acl") => {
    const keyword = (kind === "member" ? query : aclQuery).trim();
    if (!keyword) return;
    try {
      const rows = await api.searchUsers(keyword);
      if (kind === "member") {
        setCandidates(rows.filter((user) => !members.some((member) => member.userId === user.id)));
      } else {
        setAclCandidates(rows.filter((user) => !overrides.some((entry) => entry.userId === user.id)));
      }
    } catch (error: any) {
      toast.error(error?.message || "搜索用户失败");
    }
  };

  const addMember = async (userId: string) => {
    try {
      await api.addNotebookMember(notebook.id, { userId, role });
      setQuery("");
      setCandidates([]);
      setShowAddMember(false);
      toast.success("协作者已添加");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "添加协作者失败");
    }
  };

  const changeMemberRole = async (member: NotebookMember, next: MemberRole) => {
    try {
      await api.updateNotebookMember(notebook.id, member.userId, { role: next });
      toast.success("协作者权限已更新");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "权限更新失败");
    }
  };

  const removeMember = async (member: NotebookMember) => {
    if (
      !await confirm({
        title: `移除 ${displayName(member)}？`,
        description: "该协作者会立即失去当前目录及全部子目录的访问权限。",
        danger: true,
      })
    ) return;
    try {
      await api.removeNotebookMember(notebook.id, member.userId);
      toast.success("协作者已移除");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "移除协作者失败");
    }
  };

  const toggleMemberSelection = (userId: string) => {
    setSelectedMemberIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const visibleIds = filteredCollaborators.map((member) => member.userId);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedMemberIds.has(id));
    setSelectedMemberIds((current) => {
      const next = new Set(current);
      visibleIds.forEach((id) => {
        if (allSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  };

  const batchSetRole = async (nextRole: MemberRole) => {
    const targets = collaborators.filter((member) => selectedMemberIds.has(member.userId));
    if (targets.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(
        targets.map((member) =>
          api.updateNotebookMember(notebook.id, member.userId, { role: nextRole }),
        ),
      );
      toast.success(`已将 ${targets.length} 位协作者设为${nextRole === "editor" ? "可编辑" : "可查看"}`);
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "批量更新失败");
    } finally {
      setSaving(false);
    }
  };

  const batchRemove = async () => {
    const targets = collaborators.filter((member) => selectedMemberIds.has(member.userId));
    if (targets.length === 0) return;
    if (
      !await confirm({
        title: `移除 ${targets.length} 位协作者？`,
        description: "这些用户会立即失去当前目录及全部子目录的访问权限。",
        danger: true,
      })
    ) return;
    setSaving(true);
    try {
      await Promise.all(targets.map((member) => api.removeNotebookMember(notebook.id, member.userId)));
      toast.success("已批量移除协作者");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "批量移除失败");
    } finally {
      setSaving(false);
    }
  };

  const openTransfer = () => {
    const first = collaborators[0];
    if (!first) return;
    setTransferTargetId(first.userId);
    setTransferOpen(true);
  };

  const transferOwnership = async () => {
    if (!transferTargetId || transferring) return;
    const target = collaborators.find((member) => member.userId === transferTargetId);
    if (!target) return;
    setTransferring(true);
    try {
      const result = await api.transferNotebookOwnership(notebook.id, transferTargetId);
      setTransferOpen(false);
      toast.success(`已将所有权转交给 ${displayName(target)}`);
      await reload();
      if (result.detachedFromParent) {
        toast.info("该目录已从原父目录中分离，并成为新所有者个人空间的根目录");
      }
    } catch (error: any) {
      toast.error(error?.message || "转交所有者失败");
    } finally {
      setTransferring(false);
    }
  };

  const saveInvite = async () => {
    const maxUses = inviteMaxUses.trim() ? Number(inviteMaxUses) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      toast.error("最大加入人数必须是正整数");
      return;
    }
    setSaving(true);
    try {
      const input = {
        role,
        expiresAt: inviteExpiresAt ? new Date(inviteExpiresAt).toISOString() : null,
        maxUses,
      };
      const next = link
        ? await api.updateNotebookShareLink(notebook.id, input)
        : await api.createNotebookShareLink(notebook.id, input);
      applyLink(next);
      toast.success(link ? "邀请设置已保存" : "邀请链接已生成");
    } catch (error: any) {
      toast.error(error?.message || "邀请链接保存失败");
    } finally {
      setSaving(false);
    }
  };

  const rotateInvite = async () => {
    if (
      !await confirm({
        title: "更换邀请链接？",
        description: "旧链接立即失效，使用次数会清零；已加入的协作者不受影响。",
      })
    ) return;
    const next = await api.updateNotebookShareLink(notebook.id, { rotateToken: true });
    applyLink(next);
    toast.success("已生成新邀请链接");
  };

  const resetInviteUses = async () => {
    const next = await api.updateNotebookShareLink(notebook.id, { resetUses: true });
    applyLink(next);
    toast.success("加入人数统计已清零");
  };

  const revokeInvite = async () => {
    if (
      !await confirm({
        title: "关闭邀请链接？",
        description: "旧链接立即失效，仅通过该链接加入的成员会被移除；手动添加的协作者不受影响。",
        danger: true,
      })
    ) return;
    await api.deleteNotebookShareLink(notebook.id);
    applyLink(null);
    toast.success("邀请链接已关闭");
    await reload();
  };

  const savePublication = async () => {
    if (
      (accessMode === "code" || accessMode === "password") &&
      !publication?.hasSecret &&
      !publicSecret.trim()
    ) {
      toast.error("请设置访问凭证");
      return;
    }
    setSaving(true);
    try {
      const next = await notebookPublicationApi.savePublication(notebook.id, {
        accessMode,
        permission: publicPermission,
        secret: publicSecret.trim() || undefined,
        allowDownload,
        allowComment,
        allowEdit,
        allowReshare,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      applyPublication(next);
      toast.success("公开访问设置已保存");
    } catch (error: any) {
      toast.error(error?.message || "公开发布失败");
    } finally {
      setSaving(false);
    }
  };

  const revokePublication = async () => {
    if (
      !await confirm({
        title: "关闭公开访问？",
        description: "公开链接、附件签名以及仅通过公开发布加入的成员会立即失效。",
        danger: true,
      })
    ) return;
    await notebookPublicationApi.revokePublication(notebook.id);
    setPublication((current) => current ? { ...current, isActive: 0 } : current);
    setComments([]);
    toast.success("公开访问已关闭");
    await reload();
  };

  const setPrivateScope = async () => {
    if (scopeMode === "private") return;
    if (
      !await confirm({
        title: "改为仅协作者可访问？",
        description: "邀请链接和公开链接将全部失效，仅保留当前协作者。",
      })
    ) return;
    setSaving(true);
    try {
      if (link) await api.deleteNotebookShareLink(notebook.id);
      if (activePublication) await notebookPublicationApi.revokePublication(notebook.id);
      applyLink(null);
      setPublication((current) => current ? { ...current, isActive: 0 } : null);
      toast.success("已改为仅协作者可访问");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "更新分享范围失败");
    } finally {
      setSaving(false);
    }
  };

  const moderate = async (
    comment: ManagedPublicationComment,
    input: { isResolved?: boolean; isHidden?: boolean },
  ) => {
    await notebookPublicationApi.moderateComment(notebook.id, comment.id, input);
    await loadComments();
  };

  const deleteComment = async (comment: ManagedPublicationComment) => {
    if (!await confirm({ title: "删除评论？", description: "该操作不可恢复。", danger: true })) return;
    await notebookPublicationApi.deleteManagedComment(notebook.id, comment.id);
    await loadComments();
  };

  const addOverride = async (userId: string) => {
    await notebookPublicationApi.setPermissionOverride(notebook.id, userId, {
      permission: aclPermission,
      allowDownload: aclAllowDownload,
      allowReshare: aclAllowReshare,
    });
    setAclQuery("");
    setAclCandidates([]);
    toast.success("目录权限已添加");
    await reload();
  };

  const updateOverride = async (
    entry: NotebookPermissionOverride,
    permission: NotebookDirectoryPermission,
  ) => {
    await notebookPublicationApi.setPermissionOverride(notebook.id, entry.userId, {
      permission,
      allowDownload: bool(entry.allowDownload),
      allowReshare: bool(entry.allowReshare),
    });
    await reload();
  };

  const removeOverride = async (userId: string) => {
    await notebookPublicationApi.removePermissionOverride(notebook.id, userId);
    await reload();
  };

  const headerTitle = view === "overview" ? "权限管理" : view === "scope" ? "分享范围" : "权限配置";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-3 py-5 backdrop-blur-sm">
      <div className="relative flex max-h-[94vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl">
        <header className="flex items-center justify-between px-6 py-5">
          <div className="flex min-w-0 items-center gap-2.5">
            {view !== "overview" && (
              <button
                onClick={() => setView("overview")}
                className="rounded-lg p-1.5 text-tx-secondary hover:bg-app-hover"
                aria-label="返回"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-tx-primary">{headerTitle}</h2>
              <p className="mt-0.5 truncate text-xs text-tx-tertiary">
                {notebook.icon} {notebook.name} · 权限包含全部子目录
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-tx-secondary hover:bg-app-hover"
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {loading ? (
            <div className="py-24 text-center text-sm text-tx-tertiary">正在加载权限信息...</div>
          ) : view === "overview" ? (
            <div className="space-y-7">
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-base font-medium text-tx-secondary">分享范围</h3>
                  <button
                    onClick={() => copy(currentCopyUrl)}
                    className={cn(
                      "flex items-center gap-1.5 text-sm font-medium text-accent-primary",
                      !currentCopyUrl && "opacity-60",
                    )}
                    title={currentCopyUrl ? "复制当前分享链接" : "请先开启链接访问"}
                  >
                    <Link2 size={17} />
                    复制链接
                  </button>
                </div>
                <button
                  onClick={() => setView("scope")}
                  className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-hover/35 px-4 py-3 text-left transition-colors hover:bg-app-hover"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-app-surface text-tx-secondary shadow-sm">
                    {scopeMode === "private" ? <LockKeyhole size={18} /> : scopeMode === "invite" ? <Users size={18} /> : <ShieldCheck size={18} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-tx-primary">{scopeTitle}</div>
                    <div className="mt-0.5 truncate text-xs text-tx-tertiary">{scopeDescription}</div>
                  </div>
                  <ChevronRight size={18} className="text-tx-tertiary" />
                </button>
              </section>

              <section>
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-medium text-tx-secondary">所有协作者</h3>
                    <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-tertiary">
                      {members.length}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setShowAddMember((current) => !current);
                      setCandidates([]);
                    }}
                    className="flex items-center gap-1 text-sm font-medium text-accent-primary"
                  >
                    <Plus size={18} />
                    添加协作者
                  </button>
                </div>

                {showAddMember && (
                  <div className="mb-3 rounded-xl border border-accent-primary/25 bg-accent-primary/[0.04] p-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <select
                        value={role}
                        onChange={(event) => setRole(event.target.value as MemberRole)}
                        className="h-9 rounded-lg border border-app-border bg-app-bg px-3 text-sm"
                      >
                        <option value="viewer">可查看</option>
                        <option value="editor">可编辑</option>
                      </select>
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void searchUsers("member");
                        }}
                        placeholder="搜索用户名或邮箱"
                        className="h-9 flex-1"
                        autoFocus
                      />
                      <Button variant="outline" onClick={() => searchUsers("member")}>
                        <Search size={14} className="mr-1" />搜索
                      </Button>
                    </div>
                    {candidates.length > 0 && (
                      <div className="mt-2 overflow-hidden rounded-lg border border-app-border bg-app-surface">
                        {candidates.map((user) => (
                          <button
                            key={user.id}
                            onClick={() => addMember(user.id)}
                            className="flex w-full items-center justify-between border-b border-app-border px-3 py-2.5 text-left last:border-b-0 hover:bg-app-hover"
                          >
                            <span className="text-sm">{user.displayName || user.username}</span>
                            <span className="flex items-center gap-1 text-xs text-accent-primary">
                              <UserPlus size={13} />添加
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-app-border">
                  <div className="flex h-12 items-center gap-3 border-b border-app-border px-4">
                    <input
                      type="checkbox"
                      checked={
                        filteredCollaborators.length > 0 &&
                        filteredCollaborators.every((member) => selectedMemberIds.has(member.userId))
                      }
                      onChange={toggleAllVisible}
                      aria-label="全选协作者"
                    />
                    <span className="text-sm font-medium text-tx-primary">全选</span>
                    <div className="ml-auto flex w-52 items-center gap-2 rounded-lg bg-app-hover/50 px-2.5 py-1.5">
                      <Search size={15} className="text-tx-tertiary" />
                      <input
                        value={memberSearch}
                        onChange={(event) => setMemberSearch(event.target.value)}
                        placeholder="搜索协作者"
                        className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-tx-tertiary"
                      />
                    </div>
                  </div>

                  {selectedMemberIds.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-accent-primary/[0.04] px-4 py-2">
                      <span className="mr-auto text-xs text-tx-secondary">
                        已选择 {selectedMemberIds.size} 人
                      </span>
                      <Button size="sm" variant="outline" disabled={saving} onClick={() => batchSetRole("viewer")}>设为可查看</Button>
                      <Button size="sm" variant="outline" disabled={saving} onClick={() => batchSetRole("editor")}>设为可编辑</Button>
                      <Button size="sm" variant="outline" disabled={saving} className="text-red-500" onClick={batchRemove}>移除</Button>
                    </div>
                  )}

                  {owner && (
                    <div>
                      <div className="px-4 pb-1 pt-4 text-xs text-tx-tertiary">所有者</div>
                      <div className="flex items-center gap-3 px-4 py-3">
                        <input type="checkbox" disabled aria-label="所有者不可选择" />
                        <Avatar member={owner} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-tx-primary">{displayName(owner)}</span>
                            {owner.userId === me?.id && <span className="text-xs text-tx-tertiary">我自己</span>}
                            <span className="rounded border border-accent-primary/35 bg-accent-primary/5 px-1.5 py-0.5 text-[11px] text-accent-primary">所有者</span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-tx-tertiary">拥有全部权限，可管理协作者与分享范围</div>
                        </div>
                        {canTransferOwnership ? (
                          <button onClick={openTransfer} className="shrink-0 text-sm font-medium text-accent-primary">转交所有者</button>
                        ) : (
                          <span className="shrink-0 text-xs text-tx-tertiary">可管理</span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="px-4 pb-1 pt-3 text-xs text-tx-tertiary">协作者</div>
                  {filteredCollaborators.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-tx-tertiary">
                      {collaborators.length === 0 ? "暂时没有其他协作者" : "没有匹配的协作者"}
                    </div>
                  ) : (
                    filteredCollaborators.map((member) => (
                      <div key={member.userId} className="flex items-center gap-3 border-t border-app-border px-4 py-3 first:border-t-0">
                        <input
                          type="checkbox"
                          checked={selectedMemberIds.has(member.userId)}
                          onChange={() => toggleMemberSelection(member.userId)}
                          aria-label={`选择 ${displayName(member)}`}
                        />
                        <Avatar member={member} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-tx-primary">{displayName(member)}</div>
                          <div className="mt-0.5 truncate text-xs text-tx-tertiary">{sourceLabel(member.source)}{member.email ? ` · ${member.email}` : ""}</div>
                        </div>
                        <select
                          value={member.role}
                          onChange={(event) => changeMemberRole(member, event.target.value as MemberRole)}
                          className="h-8 rounded-md border border-app-border bg-app-bg px-2 text-xs"
                          aria-label={`${displayName(member)} 的权限`}
                        >
                          <option value="viewer">可查看</option>
                          <option value="editor">可编辑</option>
                        </select>
                        <button
                          onClick={() => removeMember(member)}
                          className="rounded-md p-1.5 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500"
                          title="移除协作者"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <button
                onClick={() => setView("permissions")}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left hover:bg-app-hover"
              >
                <Gear size={20} className="text-tx-secondary" />
                <div className="flex-1">
                  <div className="text-base font-medium text-tx-primary">权限配置</div>
                  <div className="mt-0.5 text-xs text-tx-tertiary">设置子目录继承、指定用户覆盖、下载与二次分享权限</div>
                </div>
                <ChevronRight size={18} className="text-tx-tertiary" />
              </button>
            </div>
          ) : view === "scope" ? (
            <div className="space-y-4">
              <section className={cn("rounded-xl border p-4", scopeMode === "private" ? "border-accent-primary bg-accent-primary/[0.04]" : "border-app-border")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app-hover"><LockKeyhole size={19} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><h3 className="text-sm font-semibold">仅协作者可访问</h3>{scopeMode === "private" && <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] text-accent-primary">当前</span>}</div>
                    <p className="mt-1 text-xs text-tx-tertiary">只有上一级页面中列出的协作者可以打开，安全性最高。</p>
                  </div>
                  {scopeMode !== "private" && <Button size="sm" variant="outline" disabled={saving} onClick={setPrivateScope}>设为当前范围</Button>}
                </div>
              </section>

              <section className={cn("rounded-xl border p-4", scopeMode === "invite" ? "border-accent-primary bg-accent-primary/[0.04]" : "border-app-border")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app-hover"><Users size={19} /></div>
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">登录后持链接加入</h3>{scopeMode === "invite" && <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] text-accent-primary">当前</span>}</div><p className="mt-1 text-xs text-tx-tertiary">适合内部团队快速加入，加入后会出现在协作者列表中。</p></div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">加入权限</span><select value={role} onChange={(event) => setRole(event.target.value as MemberRole)} className="h-9 w-full rounded-lg border border-app-border bg-app-bg px-2 text-sm"><option value="viewer">可查看</option><option value="editor">可编辑</option></select></label>
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">最大加入人数</span><Input type="number" min={1} value={inviteMaxUses} onChange={(event) => setInviteMaxUses(event.target.value)} placeholder="不限" className="h-9" /></label>
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">有效期</span><Input type="datetime-local" value={inviteExpiresAt} onChange={(event) => setInviteExpiresAt(event.target.value)} className="h-9" /></label>
                </div>
                {link && <div className="mt-3"><div className="flex gap-2"><Input readOnly value={shareUrl} className="h-9 text-xs" /><Button variant="outline" onClick={() => copy(shareUrl)}><Copy size={14} className="mr-1" />复制</Button></div><p className="mt-1 text-[11px] text-tx-tertiary">已加入 {link.useCount || 0}{link.maxUses ? ` / ${link.maxUses}` : ""} 人</p></div>}
                <div className="mt-3 flex flex-wrap justify-end gap-2">{link && <><Button variant="outline" onClick={resetInviteUses}><RotateCcw size={13} className="mr-1" />清零统计</Button><Button variant="outline" onClick={rotateInvite}><RefreshCw size={13} className="mr-1" />换链接</Button><Button variant="outline" className="text-red-500" onClick={revokeInvite}><Unlink size={13} className="mr-1" />关闭</Button></>}<Button onClick={saveInvite} disabled={saving}>{link ? "保存邀请设置" : "开启邀请链接"}</Button></div>
              </section>

              <section className={cn("rounded-xl border p-4", scopeMode === "public" ? "border-accent-primary bg-accent-primary/[0.04]" : "border-app-border")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app-hover"><ShieldCheck size={19} /></div>
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">通过公开链接访问</h3>{scopeMode === "public" && <span className="rounded-full bg-accent-primary/10 px-2 py-0.5 text-[10px] text-accent-primary">当前</span>}</div><p className="mt-1 text-xs text-tx-tertiary">适合对外发布，可设置访问码、密码、有效期及细粒度能力。</p></div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">访问方式</span><select value={accessMode} onChange={(event) => setAccessMode(event.target.value as NotebookPublicationAccessMode)} className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm"><option value="public">任何人可访问</option><option value="link">持链接访问</option><option value="code">访问码</option><option value="password">密码保护</option></select></label>
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">基础权限</span><select value={publicPermission} onChange={(event) => { const next = event.target.value as NotebookPublicationPermission; setPublicPermission(next); if (next === "read") { setAllowComment(false); setAllowEdit(false); } else if (next === "comment") setAllowComment(true); }} className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm"><option value="read">可查看</option><option value="comment">可查看、评论</option><option value="write">登录后可编辑</option></select></label>
                </div>
                {(accessMode === "code" || accessMode === "password") && <label className="mt-3 block space-y-1"><span className="text-xs text-tx-secondary">{accessMode === "code" ? "访问码" : "密码"}</span><Input type={accessMode === "password" ? "password" : "text"} value={publicSecret} onChange={(event) => setPublicSecret(event.target.value)} placeholder={publication?.hasSecret ? "留空保持原凭证" : "设置访问凭证"} /></label>}
                <label className="mt-3 block space-y-1"><span className="text-xs text-tx-secondary">有效期</span><Input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
                <div className="mt-3 grid gap-2 sm:grid-cols-2"><Toggle checked={allowDownload} onChange={setAllowDownload} title="允许附件下载" /><Toggle checked={allowComment} onChange={setAllowComment} title="允许游客评论" /><Toggle checked={allowEdit} onChange={setAllowEdit} disabled={publicPermission !== "write"} title="登录后加入编辑" /><Toggle checked={allowReshare} onChange={setAllowReshare} title="允许二次分享" /></div>
                {publicationUrl && <div className="mt-3 flex gap-2"><Input readOnly value={publicationUrl} className="text-xs" /><Button variant="outline" onClick={() => copy(publicationUrl)}><Copy size={14} className="mr-1" />复制</Button></div>}
                <div className="mt-4 flex justify-end gap-2">{activePublication && <Button variant="outline" className="text-red-500" onClick={revokePublication}>关闭公开访问</Button>}<Button onClick={savePublication} disabled={saving}>{activePublication ? "保存公开设置" : "开启公开访问"}</Button></div>
              </section>

              {activePublication && <section><div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><MessageCircle size={15} />公开评论管理</div><Button size="sm" variant="ghost" onClick={loadComments}><RefreshCw size={13} /></Button></div><div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">{comments.length === 0 ? <div className="p-6 text-center text-sm text-tx-tertiary">暂无公开评论</div> : comments.map((comment) => <div key={comment.id} className={cn("p-3", bool(comment.isHidden) && "opacity-60")}><div className="flex items-center justify-between gap-3"><div className="text-xs font-medium">{comment.nickname} · {comment.noteTitle}</div><div className="text-[10px] text-tx-tertiary">{new Date(comment.createdAt).toLocaleString()}</div></div><p className="mt-1 whitespace-pre-wrap text-sm">{comment.content}</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => moderate(comment, { isResolved: !bool(comment.isResolved) })}>{bool(comment.isResolved) ? "取消解决" : "标记解决"}</Button><Button size="sm" variant="outline" onClick={() => moderate(comment, { isHidden: !bool(comment.isHidden) })}>{bool(comment.isHidden) ? "恢复显示" : "隐藏"}</Button><Button size="sm" variant="outline" className="text-red-500" onClick={() => deleteComment(comment)}><Trash2 size={13} /></Button></div></div>)}</div></section>}
            </div>
          ) : (
            <div className="space-y-5">
              <section className="rounded-xl border border-app-border bg-app-hover/20 p-4">
                <div className="flex items-start gap-3"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" /><div><h3 className="text-sm font-semibold">目录级权限继承</h3><p className="mt-1 text-xs leading-5 text-tx-tertiary">最近的显式规则优先，并向全部子目录继承。{inheritsFromParent ? "当前目录存在父级规则，可添加覆盖或删除覆盖恢复继承。" : "当前目录是权限树根节点。"}</p></div></div>
              </section>
              <section>
                <div className="grid gap-2 sm:grid-cols-[140px_1fr_auto]"><select value={aclPermission} onChange={(event) => setAclPermission(event.target.value as NotebookDirectoryPermission)} className="h-9 rounded-lg border border-app-border bg-app-bg px-2 text-sm"><option value="none">不可见</option><option value="read">可查看</option><option value="comment">可评论</option><option value="write">可编辑</option><option value="manage">可管理</option></select><Input value={aclQuery} onChange={(event) => setAclQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchUsers("acl"); }} placeholder="搜索要设置独立权限的用户" className="h-9" /><Button variant="outline" onClick={() => searchUsers("acl")}><Search size={14} className="mr-1" />搜索</Button></div>
                <div className="mt-2 flex gap-4 text-xs"><label className="flex items-center gap-1.5"><input type="checkbox" checked={aclAllowDownload} onChange={(event) => setAclAllowDownload(event.target.checked)} />允许下载</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={aclAllowReshare} onChange={(event) => setAclAllowReshare(event.target.checked)} />允许二次分享</label></div>
                {aclCandidates.map((user) => <button key={user.id} onClick={() => addOverride(user.id)} className="mt-2 flex w-full items-center justify-between rounded-lg border border-app-border px-3 py-2.5 text-sm hover:bg-app-hover"><span>{user.displayName || user.username}</span><span className="text-accent-primary">设为{permissionLabel(aclPermission)}</span></button>)}
              </section>
              <section><div className="mb-2 text-sm font-semibold">独立权限规则</div><div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">{overrides.length === 0 ? <div className="p-8 text-center text-sm text-tx-tertiary">没有显式覆盖，当前完全继承上级权限</div> : overrides.map((entry) => <div key={entry.userId} className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><div className="truncate text-sm">{entry.displayName || entry.username}</div><div className="text-[11px] text-tx-tertiary">{bool(entry.allowDownload) ? "可下载" : "不可下载"} · {bool(entry.allowReshare) ? "可二次分享" : "不可二次分享"}</div></div><select value={entry.permission} onChange={(event) => updateOverride(entry, event.target.value as NotebookDirectoryPermission)} className="h-8 rounded border border-app-border bg-app-bg px-2 text-xs"><option value="none">不可见</option><option value="read">可查看</option><option value="comment">可评论</option><option value="write">可编辑</option><option value="manage">可管理</option></select><button onClick={() => removeOverride(entry.userId)} className="rounded p-1.5 text-red-500 hover:bg-red-500/10"><Trash2 size={14} /></button></div>)}</div></section>
            </div>
          )}
        </main>

        {transferOpen && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 px-5 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600"><Crown size={20} /></div>
                <div><h3 className="text-base font-semibold">转交所有者</h3><p className="mt-1 text-xs leading-5 text-tx-tertiary">接收人将获得当前目录及全部子目录的所有权。你会保留可编辑权限，但不再能转交或删除其他协作者。</p></div>
              </div>
              <label className="mt-4 block space-y-1.5"><span className="text-xs text-tx-secondary">选择接收人</span><select value={transferTargetId} onChange={(event) => setTransferTargetId(event.target.value)} className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm">{collaborators.map((member) => <option key={member.userId} value={member.userId}>{displayName(member)} · {memberRoleLabel(member.role)}</option>)}</select></label>
              <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setTransferOpen(false)} disabled={transferring}>取消</Button><Button onClick={transferOwnership} disabled={!transferTargetId || transferring} className="bg-amber-600 hover:bg-amber-700">{transferring ? "正在转交..." : "确认转交"}</Button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
