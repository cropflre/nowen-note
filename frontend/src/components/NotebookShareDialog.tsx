import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Copy,
  Crown,
  Link2,
  LockKeyhole,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
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
import UserPickerCombobox from "@/components/UserPickerCombobox";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { buildPublicWebUrl } from "@/lib/publicWebOrigin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  notebookPermissionManagementApi,
  type NotebookPermissionSummary,
} from "@/lib/notebookPermissionManagementApi";
import {
  notebookPublicationApi,
  type ManagedPublicationComment,
  type NotebookDirectoryPermission,
  type NotebookPermissionOverride,
  type NotebookPublication,
  type NotebookPublicationAccessMode,
  type NotebookPublicationPermission,
} from "@/lib/notebookPublicationApi";
import type { Notebook, NotebookMember, NotebookShareLink, User, UserPublicInfo } from "@/types";

interface Props {
  notebook: Notebook;
  onClose: () => void;
}

type View = "overview" | "scope" | "permissions";
type MemberRole = "viewer" | "editor";

type PublicationDraft = {
  accessMode: NotebookPublicationAccessMode;
  permission: NotebookPublicationPermission;
  secret: string;
  expiresAt: string;
  allowDownload: boolean;
  allowComment: boolean;
  allowEdit: boolean;
  allowReshare: boolean;
};

const bool = (value: number | boolean | undefined) => value === 1 || value === true;

function toLocalDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function memberName(member: Pick<NotebookMember, "displayName" | "username" | "userId">): string {
  return member.displayName || member.username || member.userId;
}

function memberSource(member: NotebookMember): string {
  if (member.source === "invite_link") return "通过邀请链接加入";
  if (member.source === "publication") return "通过公开发布加入";
  return "直接添加";
}

function Avatar({ member }: { member: NotebookMember }) {
  const name = memberName(member);
  return member.avatarUrl ? (
    <img src={member.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
  ) : (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-primary/10 text-sm font-semibold text-accent-primary">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function CapabilityToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn(
      "flex items-center gap-2 rounded-lg border border-app-border p-3 text-xs",
      disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

export default function NotebookShareDialog({ notebook, onClose }: Props) {
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<User | null>(null);
  const [summary, setSummary] = useState<NotebookPermissionSummary | null>(null);
  const [members, setMembers] = useState<NotebookMember[]>([]);
  const [invite, setInvite] = useState<NotebookShareLink | null>(null);
  const [publication, setPublication] = useState<NotebookPublication | null>(null);
  const [comments, setComments] = useState<ManagedPublicationComment[]>([]);
  const [overrides, setOverrides] = useState<NotebookPermissionOverride[]>([]);
  const [inheritsFromParent, setInheritsFromParent] = useState<string | null>(null);

  const [memberSearch, setMemberSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberSelectedUser, setMemberSelectedUser] = useState<UserPublicInfo | null>(null);
  const [newMemberRole, setNewMemberRole] = useState<MemberRole>("viewer");

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState("");

  const [inviteRole, setInviteRole] = useState<MemberRole>("viewer");
  const [inviteMaxUses, setInviteMaxUses] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");

  const [publicationDraft, setPublicationDraft] = useState<PublicationDraft>({
    accessMode: "link",
    permission: "read",
    secret: "",
    expiresAt: "",
    allowDownload: true,
    allowComment: false,
    allowEdit: false,
    allowReshare: false,
  });

  const [aclSelectedUser, setAclSelectedUser] = useState<UserPublicInfo | null>(null);
  const [aclPermission, setAclPermission] = useState<NotebookDirectoryPermission>("read");
  const [aclAllowDownload, setAclAllowDownload] = useState(true);
  const [aclAllowReshare, setAclAllowReshare] = useState(false);

  const owner = useMemo(() => members.find((member) => member.role === "owner") || null, [members]);
  const collaborators = useMemo(() => members.filter((member) => member.role !== "owner"), [members]);
  const filteredCollaborators = useMemo(() => {
    const keyword = memberSearch.trim().toLowerCase();
    if (!keyword) return collaborators;
    return collaborators.filter((member) =>
      [member.displayName, member.username, member.email]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword)),
    );
  }, [collaborators, memberSearch]);

  const inviteUrl = useMemo(
    () => invite?.token ? buildPublicWebUrl(`/notebook-share/${invite.token}`) : "",
    [invite?.token],
  );
  const publicationUrl = useMemo(
    () => publication?.token && bool(publication.isActive)
      ? buildPublicWebUrl(`/public/${publication.token}`)
      : "",
    [publication?.token, publication?.isActive],
  );

  const publicationActive = Boolean(publication && bool(publication.isActive));
  const scopeMode: "private" | "invite" | "public" = publicationActive
    ? "public"
    : invite
      ? "invite"
      : "private";
  const scopeTitle = scopeMode === "public"
    ? "通过公开链接访问"
    : scopeMode === "invite"
      ? "登录后持链接加入"
      : "仅文档协作者可访问";
  const scopeDescription = scopeMode === "public"
    ? `公开权限：${publication?.permission === "write" ? "登录后可编辑" : publication?.permission === "comment" ? "可评论" : "仅查看"}`
    : scopeMode === "invite"
      ? `新成员加入后${invite?.role === "editor" ? "可编辑" : "仅查看"}`
      : "未被添加的用户无法访问此目录";
  const copyUrl = publicationUrl || inviteUrl;
  const canTransfer = !notebook.workspaceId && owner?.userId === me?.id && collaborators.length > 0;
  const memberDisabledUserLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    members.forEach((member) => { labels[member.userId] = "已是协作者"; });
    if (me?.id) labels[me.id] = "你自己";
    return labels;
  }, [me?.id, members]);
  const aclDisabledUserLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    if (me?.id) labels[me.id] = "你自己";
    overrides.forEach((entry) => { labels[entry.userId] = "已设置独立权限"; });
    return labels;
  }, [me?.id, overrides]);

  function applyInvite(next: NotebookShareLink | null) {
    setInvite(next);
    if (!next) return;
    setInviteRole(next.role);
    setInviteMaxUses(next.maxUses ? String(next.maxUses) : "");
    setInviteExpiresAt(toLocalDateTime(next.expiresAt));
  }

  function applyPublication(next: NotebookPublication | null) {
    setPublication(next);
    if (!next) return;
    setPublicationDraft({
      accessMode: next.accessMode,
      permission: next.permission,
      secret: "",
      expiresAt: toLocalDateTime(next.expiresAt),
      allowDownload: bool(next.allowDownload),
      allowComment: bool(next.allowComment),
      allowEdit: bool(next.allowEdit),
      allowReshare: bool(next.allowReshare),
    });
  }

  async function reload() {
    const [nextMe, nextSummary, nextInvite, nextPublication, nextOverrides] = await Promise.all([
      api.getMe(),
      notebookPermissionManagementApi.getSummary(notebook.id),
      api.getNotebookShareLink(notebook.id),
      notebookPublicationApi.getPublication(notebook.id),
      notebookPublicationApi.getPermissionOverrides(notebook.id),
    ]);
    setMe(nextMe);
    setSummary(nextSummary);
    setMembers(nextSummary.members);
    applyInvite(nextInvite);
    applyPublication(nextPublication);
    setOverrides(nextOverrides.direct);
    setInheritsFromParent(nextOverrides.inheritsFromParent);
    setSelectedIds(new Set());
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((error: any) => !cancelled && toast.error(error?.message || "加载权限设置失败"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [notebook.id]);

  async function copyLink(value: string) {
    if (!value) {
      toast.warning("请先在分享范围中开启链接访问");
      return;
    }
    if (await copyText(value)) toast.success("链接已复制");
    else toast.error("复制失败");
  }

  async function addMember() {
    if (!memberSelectedUser || saving) return;
    setSaving(true);
    try {
      await api.addNotebookMember(notebook.id, { userId: memberSelectedUser.id, role: newMemberRole });
      setShowAddMember(false);
      setMemberSelectedUser(null);
      toast.success("协作者已添加");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "添加协作者失败");
    } finally {
      setSaving(false);
    }
  }

  async function setMemberRole(member: NotebookMember, role: MemberRole) {
    try {
      await api.updateNotebookMember(notebook.id, member.userId, { role });
      toast.success("协作者权限已更新");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "权限更新失败");
    }
  }

  async function removeMember(member: NotebookMember) {
    if (!await confirm({
      title: `移除 ${memberName(member)}？`,
      description: "该协作者会立即失去当前目录及全部子目录的访问权限。",
      danger: true,
    })) return;
    try {
      await api.removeNotebookMember(notebook.id, member.userId);
      toast.success("协作者已移除");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "移除协作者失败");
    }
  }

  function toggleMember(userId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleVisibleMembers() {
    const visibleIds = filteredCollaborators.map((member) => member.userId);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
    setSelectedIds((current) => {
      const next = new Set(current);
      visibleIds.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  async function batchSetRole(role: MemberRole) {
    const targets = collaborators.filter((member) => selectedIds.has(member.userId));
    if (targets.length === 0) return;
    setSaving(true);
    try {
      await Promise.all(targets.map((member) =>
        api.updateNotebookMember(notebook.id, member.userId, { role }),
      ));
      toast.success(`已更新 ${targets.length} 位协作者`);
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "批量更新失败");
    } finally {
      setSaving(false);
    }
  }

  async function batchRemove() {
    const targets = collaborators.filter((member) => selectedIds.has(member.userId));
    if (targets.length === 0) return;
    if (!await confirm({
      title: `移除 ${targets.length} 位协作者？`,
      description: "这些用户会立即失去当前目录及全部子目录的访问权限。",
      danger: true,
    })) return;
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
  }

  function openTransfer() {
    if (!collaborators[0]) return;
    setTransferTargetId(collaborators[0].userId);
    setTransferOpen(true);
  }

  async function transferOwnership() {
    const target = collaborators.find((member) => member.userId === transferTargetId);
    if (!target) return;
    setSaving(true);
    try {
      const result = await notebookPermissionManagementApi.transferOwnership(notebook.id, target.userId);
      setTransferOpen(false);
      toast.success(`已将所有权转交给 ${memberName(target)}`);
      if (result.detachedFromParent) {
        toast.info("该目录已提升为新所有者个人空间的根目录");
      }
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "转交所有者失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveInvite() {
    const maxUses = inviteMaxUses.trim() ? Number(inviteMaxUses) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      toast.error("最大加入人数必须是正整数");
      return;
    }
    setSaving(true);
    try {
      const input = {
        role: inviteRole,
        maxUses,
        expiresAt: inviteExpiresAt ? new Date(inviteExpiresAt).toISOString() : null,
      };
      const next = invite
        ? await api.updateNotebookShareLink(notebook.id, input)
        : await api.createNotebookShareLink(notebook.id, input);
      applyInvite(next);
      toast.success(invite ? "邀请设置已保存" : "邀请链接已开启");
    } catch (error: any) {
      toast.error(error?.message || "邀请链接保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function rotateInvite() {
    if (!await confirm({ title: "更换邀请链接？", description: "旧链接会立即失效，已加入的协作者不受影响。" })) return;
    applyInvite(await api.updateNotebookShareLink(notebook.id, { rotateToken: true }));
    toast.success("已生成新邀请链接");
  }

  async function resetInviteUses() {
    applyInvite(await api.updateNotebookShareLink(notebook.id, { resetUses: true }));
    toast.success("加入人数统计已清零");
  }

  async function revokeInvite() {
    if (!await confirm({
      title: "关闭邀请链接？",
      description: "仅通过该链接加入的成员会被移除，直接添加的协作者不受影响。",
      danger: true,
    })) return;
    await api.deleteNotebookShareLink(notebook.id);
    applyInvite(null);
    toast.success("邀请链接已关闭");
    await reload();
  }

  async function savePublication() {
    if (
      (publicationDraft.accessMode === "code" || publicationDraft.accessMode === "password") &&
      !publication?.hasSecret &&
      !publicationDraft.secret.trim()
    ) {
      toast.error("请设置访问凭证");
      return;
    }
    setSaving(true);
    try {
      const next = await notebookPublicationApi.savePublication(notebook.id, {
        accessMode: publicationDraft.accessMode,
        permission: publicationDraft.permission,
        secret: publicationDraft.secret.trim() || undefined,
        expiresAt: publicationDraft.expiresAt
          ? new Date(publicationDraft.expiresAt).toISOString()
          : null,
        allowDownload: publicationDraft.allowDownload,
        allowComment: publicationDraft.allowComment,
        allowEdit: publicationDraft.allowEdit,
        allowReshare: publicationDraft.allowReshare,
      });
      applyPublication(next);
      toast.success("公开访问设置已保存");
    } catch (error: any) {
      toast.error(error?.message || "公开访问设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function revokePublication() {
    if (!await confirm({
      title: "关闭公开访问？",
      description: "公开链接、附件签名和通过公开发布加入的成员会立即失效。",
      danger: true,
    })) return;
    await notebookPublicationApi.revokePublication(notebook.id);
    setPublication((current) => current ? { ...current, isActive: 0 } : current);
    setComments([]);
    toast.success("公开访问已关闭");
    await reload();
  }

  async function setPrivateScope() {
    if (scopeMode === "private") return;
    if (!await confirm({
      title: "改为仅协作者可访问？",
      description: "邀请链接和公开链接都会关闭，仅保留当前协作者。",
    })) return;
    setSaving(true);
    try {
      if (invite) await api.deleteNotebookShareLink(notebook.id);
      if (publicationActive) await notebookPublicationApi.revokePublication(notebook.id);
      applyInvite(null);
      setPublication((current) => current ? { ...current, isActive: 0 } : null);
      toast.success("已改为仅协作者可访问");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "分享范围更新失败");
    } finally {
      setSaving(false);
    }
  }

  async function loadComments() {
    if (!publicationActive) return setComments([]);
    try {
      setComments(await notebookPublicationApi.getManagedComments(notebook.id));
    } catch (error: any) {
      toast.error(error?.message || "评论加载失败");
    }
  }

  async function moderateComment(
    comment: ManagedPublicationComment,
    input: { isResolved?: boolean; isHidden?: boolean },
  ) {
    await notebookPublicationApi.moderateComment(notebook.id, comment.id, input);
    await loadComments();
  }

  async function deleteComment(comment: ManagedPublicationComment) {
    if (!await confirm({ title: "删除评论？", description: "该操作不可恢复。", danger: true })) return;
    await notebookPublicationApi.deleteManagedComment(notebook.id, comment.id);
    await loadComments();
  }

  async function addOverride() {
    if (!aclSelectedUser || saving) return;
    setSaving(true);
    try {
      await notebookPublicationApi.setPermissionOverride(notebook.id, aclSelectedUser.id, {
        permission: aclPermission,
        allowDownload: aclAllowDownload,
        allowReshare: aclAllowReshare,
      });
      setAclSelectedUser(null);
      toast.success("独立权限已添加");
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "权限添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function updateOverride(entry: NotebookPermissionOverride, permission: NotebookDirectoryPermission) {
    try {
      await notebookPublicationApi.setPermissionOverride(notebook.id, entry.userId, {
        permission,
        allowDownload: bool(entry.allowDownload),
        allowReshare: bool(entry.allowReshare),
      });
      await reload();
    } catch (error: any) {
      toast.error(error?.message || "权限更新失败");
    }
  }

  async function removeOverride(userId: string) {
    await notebookPublicationApi.removePermissionOverride(notebook.id, userId);
    await reload();
  }

  const headerTitle = view === "overview" ? "权限管理" : view === "scope" ? "分享范围" : "权限配置";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-3 py-5 backdrop-blur-sm">
      <div className="relative flex max-h-[94vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl">
        <header className="flex items-center justify-between px-6 py-5">
          <div className="flex min-w-0 items-center gap-2.5">
            {view !== "overview" && (
              <button onClick={() => setView("overview")} className="rounded-lg p-1.5 text-tx-secondary hover:bg-app-hover" aria-label="返回">
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
          <button onClick={onClose} className="rounded-lg p-2 text-tx-secondary hover:bg-app-hover" aria-label="关闭">
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
                  <button onClick={() => copyLink(copyUrl)} className="flex items-center gap-1.5 text-sm font-medium text-accent-primary">
                    <Link2 size={17} />复制链接
                  </button>
                </div>
                <button onClick={() => setView("scope")} className="flex w-full items-center gap-3 rounded-lg border border-app-border bg-app-hover/35 px-4 py-3 text-left hover:bg-app-hover">
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
                    <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-tertiary">{members.length}</span>
                  </div>
                  <button
                    onClick={() => {
                      setMemberSelectedUser(null);
                      setShowAddMember((current) => !current);
                    }}
                    className="flex items-center gap-1 text-sm font-medium text-accent-primary"
                  >
                    <UserPlus size={17} />添加协作者
                  </button>
                </div>

                {showAddMember && (
                  <div className="mb-3 rounded-xl border border-accent-primary/25 bg-accent-primary/[0.04] p-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <div className="min-w-0 flex-1">
                        <UserPickerCombobox
                          value={memberSelectedUser}
                          onChange={setMemberSelectedUser}
                          disabledUserLabels={memberDisabledUserLabels}
                          placeholder="搜索用户名、显示名或邮箱"
                          autoFocus
                          idPrefix="notebook-member-user"
                        />
                      </div>
                      <select value={newMemberRole} onChange={(event) => setNewMemberRole(event.target.value as MemberRole)} className="h-10 rounded-lg border border-app-border bg-app-bg px-3 text-sm sm:w-28">
                        <option value="viewer">可查看</option>
                        <option value="editor">可编辑</option>
                      </select>
                      <Button disabled={!memberSelectedUser || saving} onClick={() => void addMember()}>
                        {saving ? "添加中..." : "添加"}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="overflow-hidden rounded-xl border border-app-border">
                  <div className="flex h-12 items-center gap-3 border-b border-app-border px-4">
                    <input
                      type="checkbox"
                      checked={filteredCollaborators.length > 0 && filteredCollaborators.every((member) => selectedIds.has(member.userId))}
                      onChange={toggleVisibleMembers}
                      aria-label="全选协作者"
                    />
                    <span className="text-sm font-medium text-tx-primary">全选</span>
                    <div className="ml-auto flex w-52 items-center gap-2 rounded-lg bg-app-hover/50 px-2.5 py-1.5">
                      <Search size={15} className="text-tx-tertiary" />
                      <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="搜索协作者" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
                    </div>
                  </div>

                  {selectedIds.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-accent-primary/[0.04] px-4 py-2">
                      <span className="mr-auto text-xs text-tx-secondary">已选择 {selectedIds.size} 人</span>
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
                            <span className="truncate text-sm font-medium text-tx-primary">{memberName(owner)}</span>
                            {owner.userId === me?.id && <span className="text-xs text-tx-tertiary">我自己</span>}
                            <span className="rounded border border-accent-primary/35 bg-accent-primary/5 px-1.5 py-0.5 text-[11px] text-accent-primary">所有者</span>
                          </div>
                          <div className="mt-0.5 text-xs text-tx-tertiary">拥有全部权限，可管理协作者与分享范围</div>
                        </div>
                        {canTransfer ? (
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
                  ) : filteredCollaborators.map((member) => (
                    <div key={member.userId} className="flex items-center gap-3 border-t border-app-border px-4 py-3">
                      <input type="checkbox" checked={selectedIds.has(member.userId)} onChange={() => toggleMember(member.userId)} aria-label={`选择 ${memberName(member)}`} />
                      <Avatar member={member} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-tx-primary">{memberName(member)}</div>
                        <div className="mt-0.5 truncate text-xs text-tx-tertiary">{memberSource(member)}{member.email ? ` · ${member.email}` : ""}</div>
                      </div>
                      <select value={member.role} onChange={(event) => setMemberRole(member, event.target.value as MemberRole)} className="h-8 rounded-md border border-app-border bg-app-bg px-2 text-xs">
                        <option value="viewer">可查看</option>
                        <option value="editor">可编辑</option>
                      </select>
                      <button onClick={() => removeMember(member)} className="rounded-md p-1.5 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500" title="移除协作者"><Trash2 size={15} /></button>
                    </div>
                  ))}
                </div>
              </section>

              <button onClick={() => setView("permissions")} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left hover:bg-app-hover">
                <Settings2 size={20} className="text-tx-secondary" />
                <div className="flex-1">
                  <div className="text-base font-medium text-tx-primary">权限配置</div>
                  <div className="mt-0.5 text-xs text-tx-tertiary">设置目录继承、用户覆盖、下载与二次分享权限</div>
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
                    <h3 className="text-sm font-semibold">仅协作者可访问</h3>
                    <p className="mt-1 text-xs text-tx-tertiary">只有协作者列表中的用户可以打开，安全性最高。</p>
                  </div>
                  {scopeMode !== "private" && <Button size="sm" variant="outline" onClick={setPrivateScope} disabled={saving}>设为当前范围</Button>}
                </div>
              </section>

              <section className={cn("rounded-xl border p-4", scopeMode === "invite" ? "border-accent-primary bg-accent-primary/[0.04]" : "border-app-border")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app-hover"><Users size={19} /></div>
                  <div><h3 className="text-sm font-semibold">登录后持链接加入</h3><p className="mt-1 text-xs text-tx-tertiary">适合团队内部快速加入，加入后会出现在协作者列表。</p></div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">加入权限</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as MemberRole)} className="h-9 w-full rounded-lg border border-app-border bg-app-bg px-2 text-sm"><option value="viewer">可查看</option><option value="editor">可编辑</option></select></label>
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">最大加入人数</span><Input type="number" min={1} value={inviteMaxUses} onChange={(event) => setInviteMaxUses(event.target.value)} placeholder="不限" className="h-9" /></label>
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">有效期</span><Input type="datetime-local" value={inviteExpiresAt} onChange={(event) => setInviteExpiresAt(event.target.value)} className="h-9" /></label>
                </div>
                {invite && <div className="mt-3"><div className="flex gap-2"><Input readOnly value={inviteUrl} className="h-9 text-xs" /><Button variant="outline" onClick={() => copyLink(inviteUrl)}><Copy size={14} className="mr-1" />复制</Button></div><p className="mt-1 text-[11px] text-tx-tertiary">已加入 {invite.useCount || 0}{invite.maxUses ? ` / ${invite.maxUses}` : ""} 人</p></div>}
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  {invite && <><Button variant="outline" onClick={resetInviteUses}><RotateCcw size={13} className="mr-1" />清零</Button><Button variant="outline" onClick={rotateInvite}><RefreshCw size={13} className="mr-1" />换链接</Button><Button variant="outline" className="text-red-500" onClick={revokeInvite}><Unlink size={13} className="mr-1" />关闭</Button></>}
                  <Button onClick={saveInvite} disabled={saving}>{invite ? "保存邀请设置" : "开启邀请链接"}</Button>
                </div>
              </section>

              <section className={cn("rounded-xl border p-4", scopeMode === "public" ? "border-accent-primary bg-accent-primary/[0.04]" : "border-app-border")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app-hover"><ShieldCheck size={19} /></div>
                  <div><h3 className="text-sm font-semibold">通过公开链接访问</h3><p className="mt-1 text-xs text-tx-tertiary">适合对外发布，可设置访问凭证和细粒度能力。</p></div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">访问方式</span><select value={publicationDraft.accessMode} onChange={(event) => setPublicationDraft((draft) => ({ ...draft, accessMode: event.target.value as NotebookPublicationAccessMode }))} className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm"><option value="public">任何人可访问</option><option value="link">持链接访问</option><option value="code">访问码</option><option value="password">密码保护</option></select></label>
                  <label className="space-y-1"><span className="text-xs text-tx-secondary">基础权限</span><select value={publicationDraft.permission} onChange={(event) => { const permission = event.target.value as NotebookPublicationPermission; setPublicationDraft((draft) => ({ ...draft, permission, allowComment: permission !== "read", allowEdit: permission === "write" })); }} className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm"><option value="read">可查看</option><option value="comment">可查看、评论</option><option value="write">登录后可编辑</option></select></label>
                </div>
                {(publicationDraft.accessMode === "code" || publicationDraft.accessMode === "password") && <label className="mt-3 block space-y-1"><span className="text-xs text-tx-secondary">{publicationDraft.accessMode === "code" ? "访问码" : "密码"}</span><Input type={publicationDraft.accessMode === "password" ? "password" : "text"} value={publicationDraft.secret} onChange={(event) => setPublicationDraft((draft) => ({ ...draft, secret: event.target.value }))} placeholder={publication?.hasSecret ? "留空保持原凭证" : "设置访问凭证"} /></label>}
                <label className="mt-3 block space-y-1"><span className="text-xs text-tx-secondary">有效期</span><Input type="datetime-local" value={publicationDraft.expiresAt} onChange={(event) => setPublicationDraft((draft) => ({ ...draft, expiresAt: event.target.value }))} /></label>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <CapabilityToggle checked={publicationDraft.allowDownload} label="允许附件下载" onChange={(checked) => setPublicationDraft((draft) => ({ ...draft, allowDownload: checked }))} />
                  <CapabilityToggle checked={publicationDraft.allowComment} label="允许游客评论" onChange={(checked) => setPublicationDraft((draft) => ({ ...draft, allowComment: checked }))} />
                  <CapabilityToggle checked={publicationDraft.allowEdit} disabled={publicationDraft.permission !== "write"} label="登录后加入编辑" onChange={(checked) => setPublicationDraft((draft) => ({ ...draft, allowEdit: checked }))} />
                  <CapabilityToggle checked={publicationDraft.allowReshare} label="允许二次分享" onChange={(checked) => setPublicationDraft((draft) => ({ ...draft, allowReshare: checked }))} />
                </div>
                {publicationUrl && <div className="mt-3 flex gap-2"><Input readOnly value={publicationUrl} className="text-xs" /><Button variant="outline" onClick={() => copyLink(publicationUrl)}><Copy size={14} className="mr-1" />复制</Button></div>}
                <div className="mt-4 flex justify-end gap-2">{publicationActive && <Button variant="outline" className="text-red-500" onClick={revokePublication}>关闭公开访问</Button>}<Button onClick={savePublication} disabled={saving}>{publicationActive ? "保存公开设置" : "开启公开访问"}</Button></div>
              </section>

              {publicationActive && (
                <section>
                  <div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><MessageCircle size={15} />公开评论管理</div><Button size="sm" variant="ghost" onClick={loadComments}><RefreshCw size={13} /></Button></div>
                  <div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">
                    {comments.length === 0 ? <div className="p-6 text-center text-sm text-tx-tertiary">点击刷新加载公开评论</div> : comments.map((comment) => (
                      <div key={comment.id} className={cn("p-3", bool(comment.isHidden) && "opacity-60")}>
                        <div className="flex items-center justify-between gap-3"><div className="text-xs font-medium">{comment.nickname} · {comment.noteTitle}</div><div className="text-[10px] text-tx-tertiary">{new Date(comment.createdAt).toLocaleString()}</div></div>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{comment.content}</p>
                        <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => moderateComment(comment, { isResolved: !bool(comment.isResolved) })}>{bool(comment.isResolved) ? "取消解决" : "标记解决"}</Button><Button size="sm" variant="outline" onClick={() => moderateComment(comment, { isHidden: !bool(comment.isHidden) })}>{bool(comment.isHidden) ? "恢复显示" : "隐藏"}</Button><Button size="sm" variant="outline" className="text-red-500" onClick={() => deleteComment(comment)}><Trash2 size={13} /></Button></div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <section className="rounded-xl border border-app-border bg-app-hover/20 p-4">
                <div className="flex items-start gap-3"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" /><div><h3 className="text-sm font-semibold">目录级权限继承</h3><p className="mt-1 text-xs leading-5 text-tx-tertiary">最近的显式规则优先，并向全部子目录继承。{inheritsFromParent ? "当前存在父级规则，可添加覆盖或删除覆盖恢复继承。" : "当前目录是权限树根节点。"}</p></div></div>
              </section>
              <section>
                <div className="grid gap-2 sm:grid-cols-[140px_1fr_auto]">
                  <select value={aclPermission} onChange={(event) => setAclPermission(event.target.value as NotebookDirectoryPermission)} className="h-10 rounded-lg border border-app-border bg-app-bg px-2 text-sm">
                    <option value="none">不可见</option>
                    <option value="read">可查看</option>
                    <option value="comment">可评论</option>
                    <option value="write">可编辑</option>
                    <option value="manage">可管理</option>
                  </select>
                  <UserPickerCombobox
                    value={aclSelectedUser}
                    onChange={setAclSelectedUser}
                    disabledUserLabels={aclDisabledUserLabels}
                    placeholder="搜索要设置独立权限的用户"
                    idPrefix="notebook-acl-user"
                  />
                  <Button disabled={!aclSelectedUser || saving} onClick={() => void addOverride()}>
                    {saving ? "添加中..." : "添加"}
                  </Button>
                </div>
                <div className="mt-2 flex gap-4 text-xs"><label className="flex items-center gap-1.5"><input type="checkbox" checked={aclAllowDownload} onChange={(event) => setAclAllowDownload(event.target.checked)} />允许下载</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={aclAllowReshare} onChange={(event) => setAclAllowReshare(event.target.checked)} />允许二次分享</label></div>
              </section>
              <section>
                <div className="mb-2 text-sm font-semibold">独立权限规则</div>
                <div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">
                  {overrides.length === 0 ? <div className="p-8 text-center text-sm text-tx-tertiary">没有显式覆盖，当前完全继承上级权限</div> : overrides.map((entry) => (
                    <div key={entry.userId} className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><div className="truncate text-sm">{entry.displayName || entry.username}</div><div className="text-[11px] text-tx-tertiary">{bool(entry.allowDownload) ? "可下载" : "不可下载"} · {bool(entry.allowReshare) ? "可二次分享" : "不可二次分享"}</div></div><select value={entry.permission} onChange={(event) => updateOverride(entry, event.target.value as NotebookDirectoryPermission)} className="h-8 rounded border border-app-border bg-app-bg px-2 text-xs"><option value="none">不可见</option><option value="read">可查看</option><option value="comment">可评论</option><option value="write">可编辑</option><option value="manage">可管理</option></select><button onClick={() => removeOverride(entry.userId)} className="rounded p-1.5 text-red-500 hover:bg-red-500/10"><Trash2 size={14} /></button></div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </main>

        {transferOpen && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/45 px-5 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl">
              <div className="flex items-start gap-3"><div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600"><Crown size={20} /></div><div><h3 className="text-base font-semibold">转交所有者</h3><p className="mt-1 text-xs leading-5 text-tx-tertiary">接收人将获得当前目录及全部子目录的所有权。你会保留可编辑权限，但不再能管理其他协作者。</p></div></div>
              <label className="mt-4 block space-y-1.5"><span className="text-xs text-tx-secondary">选择接收人</span><select value={transferTargetId} onChange={(event) => setTransferTargetId(event.target.value)} className="h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 text-sm">{collaborators.map((member) => <option key={member.userId} value={member.userId}>{memberName(member)}</option>)}</select></label>
              <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setTransferOpen(false)} disabled={saving}>取消</Button><Button onClick={transferOwnership} disabled={!transferTargetId || saving} className="bg-amber-600 hover:bg-amber-700">{saving ? "正在转交..." : "确认转交"}</Button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
