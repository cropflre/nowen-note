import { useEffect, useMemo, useState } from "react";
import { Globe2, KeyRound, Link2, LockKeyhole, MessageCircle, RefreshCw, RotateCcw, ShieldCheck, Trash2, Unlink, UserRoundCog, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import { buildPublicWebUrl } from "@/lib/publicWebOrigin";
import type { Notebook, NotebookMember, NotebookShareLink, UserPublicInfo } from "@/types";
import {
  notebookPublicationApi,
  type ManagedPublicationComment,
  type NotebookDirectoryPermission,
  type NotebookPermissionOverride,
  type NotebookPublication,
  type NotebookPublicationAccessMode,
  type NotebookPublicationPermission,
} from "@/lib/notebookPublicationApi";
import { cn } from "@/lib/utils";

interface Props { notebook: Notebook; onClose: () => void; }
type Tab = "members" | "publish" | "permissions";
const bool = (value: number | boolean | undefined) => value === true || value === 1;
const localDateTime = (value: string | null | undefined) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
const permissionLabel = (permission: NotebookDirectoryPermission) => ({ none: "不可见", read: "可查看", comment: "可评论", write: "可编辑", manage: "可管理" })[permission];

export default function NotebookShareDialog({ notebook, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("members");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<NotebookMember[]>([]);
  const [link, setLink] = useState<NotebookShareLink | null>(null);
  const [publication, setPublication] = useState<NotebookPublication | null>(null);
  const [overrides, setOverrides] = useState<NotebookPermissionOverride[]>([]);
  const [inheritsFromParent, setInheritsFromParent] = useState<string | null>(null);
  const [comments, setComments] = useState<ManagedPublicationComment[]>([]);

  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UserPublicInfo[]>([]);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
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

  const shareUrl = useMemo(() => link?.token ? buildPublicWebUrl(`/notebook-share/${link.token}`) : "", [link?.token]);
  const publicationUrl = useMemo(() => publication?.token && bool(publication.isActive) ? buildPublicWebUrl(`/public/${publication.token}`) : "", [publication?.token, publication?.isActive]);

  const applyPublication = (value: NotebookPublication | null) => {
    setPublication(value);
    if (!value) return;
    setAccessMode(value.accessMode); setPublicPermission(value.permission);
    setExpiresAt(localDateTime(value.expiresAt)); setAllowDownload(bool(value.allowDownload));
    setAllowComment(bool(value.allowComment)); setAllowEdit(bool(value.allowEdit));
    setAllowReshare(bool(value.allowReshare)); setPublicSecret("");
  };
  const applyLink = (value: NotebookShareLink | null) => {
    setLink(value);
    if (!value) return;
    setRole(value.role); setInviteExpiresAt(localDateTime(value.expiresAt));
    setInviteMaxUses(value.maxUses ? String(value.maxUses) : "");
  };

  const reload = async () => {
    const [nextMembers, nextLink, nextPublication, nextOverrides] = await Promise.all([
      api.getNotebookMembers(notebook.id), api.getNotebookShareLink(notebook.id),
      notebookPublicationApi.getPublication(notebook.id), notebookPublicationApi.getPermissionOverrides(notebook.id),
    ]);
    setMembers(nextMembers); applyLink(nextLink); applyPublication(nextPublication);
    setOverrides(nextOverrides.direct); setInheritsFromParent(nextOverrides.inheritsFromParent);
  };
  const loadComments = async () => {
    if (!publication || !bool(publication.isActive)) { setComments([]); return; }
    try { setComments(await notebookPublicationApi.getManagedComments(notebook.id)); }
    catch (error: any) { toast.error(error?.message || "加载公开评论失败"); }
  };

  useEffect(() => { let cancelled = false; setLoading(true); reload().catch((e: any) => !cancelled && toast.error(e?.message || "加载分享设置失败")).finally(() => !cancelled && setLoading(false)); return () => { cancelled = true; }; }, [notebook.id]);
  useEffect(() => { if (tab === "publish") void loadComments(); }, [tab, publication?.id, publication?.isActive]);

  const copy = async (value: string) => {
    const copied = await copyText(value);
    toast[copied ? "success" : "error"](copied ? "链接已复制" : "复制失败");
  };
  const searchUsers = async (kind: "member" | "acl") => {
    const keyword = (kind === "member" ? query : aclQuery).trim(); if (!keyword) return;
    const rows = await api.searchUsers(keyword);
    if (kind === "member") setCandidates(rows.filter((u) => !members.some((m) => m.userId === u.id)));
    else setAclCandidates(rows.filter((u) => !overrides.some((entry) => entry.userId === u.id)));
  };
  const addMember = async (userId: string) => { await api.addNotebookMember(notebook.id, { userId, role }); setQuery(""); setCandidates([]); toast.success("成员已添加"); await reload(); };
  const changeMemberRole = async (member: NotebookMember, next: "viewer" | "editor") => { try { await api.updateNotebookMember(notebook.id, member.userId, { role: next }); toast.success("成员权限已更新"); await reload(); } catch (e: any) { toast.error(e?.message || "权限更新失败"); } };
  const removeMember = async (userId: string) => { if (!await confirm({ title: "移除成员？", description: "该成员会立即失去共享目录访问权限。", danger: true })) return; await api.removeNotebookMember(notebook.id, userId); toast.success("成员已移除"); await reload(); };

  const saveInvite = async () => {
    const maxUses = inviteMaxUses.trim() ? Number(inviteMaxUses) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return toast.error("最大加入人数必须是正整数");
    setSaving(true);
    try {
      const input = { role, expiresAt: inviteExpiresAt ? new Date(inviteExpiresAt).toISOString() : null, maxUses };
      const next = link ? await api.updateNotebookShareLink(notebook.id, input) : await api.createNotebookShareLink(notebook.id, input);
      applyLink(next); toast.success(link ? "邀请设置已保存" : "邀请链接已生成");
    } catch (e: any) { toast.error(e?.message || "邀请链接保存失败"); } finally { setSaving(false); }
  };
  const rotateInvite = async () => { if (!await confirm({ title: "轮换邀请链接？", description: "旧链接立即失效，使用次数会清零；已加入成员不受影响。" })) return; const next = await api.updateNotebookShareLink(notebook.id, { rotateToken: true }); applyLink(next); toast.success("已生成新邀请链接"); };
  const resetInviteUses = async () => { const next = await api.updateNotebookShareLink(notebook.id, { resetUses: true }); applyLink(next); toast.success("加入人数统计已清零"); };
  const revokeInvite = async () => { if (!await confirm({ title: "撤销邀请链接？", description: "旧链接立即失效，并移除仅通过该链接加入的成员；手动成员不受影响。", danger: true })) return; await api.deleteNotebookShareLink(notebook.id); applyLink(null); toast.success("邀请链接已撤销"); await reload(); };

  const savePublication = async () => {
    if ((accessMode === "code" || accessMode === "password") && !publication?.hasSecret && !publicSecret.trim()) return toast.error("请设置访问凭证");
    setSaving(true);
    try { const next = await notebookPublicationApi.savePublication(notebook.id, { accessMode, permission: publicPermission, secret: publicSecret.trim() || undefined, allowDownload, allowComment, allowEdit, allowReshare, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }); applyPublication(next); toast.success("公开发布设置已保存"); }
    catch (e: any) { toast.error(e?.message || "发布失败"); } finally { setSaving(false); }
  };
  const revokePublication = async () => { if (!await confirm({ title: "撤销目录发布？", description: "公开链接、附件签名以及仅通过该发布加入的成员会立即失效。", danger: true })) return; await notebookPublicationApi.revokePublication(notebook.id); setPublication((p) => p ? { ...p, isActive: 0 } : p); setComments([]); toast.success("目录发布已撤销"); };
  const moderate = async (comment: ManagedPublicationComment, input: { isResolved?: boolean; isHidden?: boolean }) => { await notebookPublicationApi.moderateComment(notebook.id, comment.id, input); await loadComments(); };
  const deleteComment = async (comment: ManagedPublicationComment) => { if (!await confirm({ title: "删除评论？", description: "该操作不可恢复。", danger: true })) return; await notebookPublicationApi.deleteManagedComment(notebook.id, comment.id); await loadComments(); };

  const addOverride = async (userId: string) => { await notebookPublicationApi.setPermissionOverride(notebook.id, userId, { permission: aclPermission, allowDownload: aclAllowDownload, allowReshare: aclAllowReshare }); setAclQuery(""); setAclCandidates([]); await reload(); };
  const updateOverride = async (entry: NotebookPermissionOverride, permission: NotebookDirectoryPermission) => { await notebookPublicationApi.setPermissionOverride(notebook.id, entry.userId, { permission, allowDownload: bool(entry.allowDownload), allowReshare: bool(entry.allowReshare) }); await reload(); };
  const removeOverride = async (userId: string) => { await notebookPublicationApi.removePermissionOverride(notebook.id, userId); await reload(); };

  const tabs: Array<{ id: Tab; label: string; icon: typeof Users }> = [{ id: "members", label: "成员与邀请", icon: Users }, { id: "publish", label: "公开发布", icon: Globe2 }, { id: "permissions", label: "目录权限", icon: UserRoundCog }];
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-3 py-5 backdrop-blur-sm"><div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl">
    <header className="flex items-center justify-between border-b border-app-border px-5 py-4"><div><h2 className="font-semibold">分享与发布</h2><p className="text-xs text-tx-tertiary">{notebook.icon} {notebook.name} · 包含全部子目录</p></div><button onClick={onClose} className="rounded-lg p-2 hover:bg-app-hover"><X size={17} /></button></header>
    <nav className="flex gap-1 border-b border-app-border bg-app-hover/30 px-4 py-2">{tabs.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setTab(id)} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium", tab === id ? "bg-app-surface text-accent-primary shadow-sm" : "text-tx-secondary hover:bg-app-surface/70")}><Icon size={14} />{label}</button>)}</nav>
    <main className="min-h-0 flex-1 overflow-y-auto p-5">{loading ? <div className="py-16 text-center text-sm text-tx-tertiary">正在加载...</div> : tab === "members" ? <div className="space-y-5">
      <section><h3 className="mb-2 text-sm font-semibold">指定账号</h3><div className="flex gap-2"><select className="h-9 rounded-lg border border-app-border bg-app-bg px-2 text-sm" value={role} onChange={(e) => setRole(e.target.value as any)}><option value="viewer">只读</option><option value="editor">可编辑</option></select><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索用户名或邮箱" className="h-9" onKeyDown={(e) => { if (e.key === "Enter") void searchUsers("member"); }} /><Button variant="outline" onClick={() => searchUsers("member")}>搜索</Button></div>{candidates.length > 0 && <div className="mt-2 overflow-hidden rounded-lg border">{candidates.map((u) => <button key={u.id} onClick={() => addMember(u.id)} className="flex w-full justify-between px-3 py-2 text-sm hover:bg-app-hover"><span>{u.displayName || u.username}</span><span className="text-xs text-tx-tertiary">添加</span></button>)}</div>}</section>
      <section><div className="mb-2 text-xs font-medium text-tx-tertiary">当前成员</div><div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">{members.length === 0 ? <div className="p-5 text-center text-sm text-tx-tertiary">暂无指定成员</div> : members.map((m) => <div key={m.userId} className="flex items-center gap-3 px-3 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-sm">{m.displayName || m.username || m.userId}</div><div className="text-[11px] text-tx-tertiary">{m.source === "invite_link" ? "邀请链接加入" : m.source === "publication" ? "公开发布加入" : "手动成员"}</div></div>{m.role === "owner" ? <span className="text-xs text-tx-tertiary">拥有者</span> : <><select value={m.role} onChange={(e) => changeMemberRole(m, e.target.value as any)} className="h-8 rounded-md border bg-app-bg px-2 text-xs"><option value="viewer">只读</option><option value="editor">可编辑</option></select><button onClick={() => removeMember(m.userId)} className="rounded p-1.5 text-red-500 hover:bg-app-hover"><Trash2 size={14} /></button></>}</div>)}</div></section>
      <section className="rounded-xl border border-app-border bg-app-hover/20 p-4"><div className="flex items-center gap-2"><Link2 size={16} /><h3 className="text-sm font-semibold">登录邀请链接</h3></div><div className="mt-3 grid gap-3 sm:grid-cols-3"><label className="space-y-1"><span className="text-xs">加入权限</span><select value={role} onChange={(e) => setRole(e.target.value as any)} className="h-9 w-full rounded-lg border bg-app-bg px-2 text-sm"><option value="viewer">只读</option><option value="editor">可编辑</option></select></label><label className="space-y-1"><span className="text-xs">最大加入人数</span><Input type="number" min={1} value={inviteMaxUses} onChange={(e) => setInviteMaxUses(e.target.value)} placeholder="不限" className="h-9" /></label><label className="space-y-1"><span className="text-xs">有效期</span><Input type="datetime-local" value={inviteExpiresAt} onChange={(e) => setInviteExpiresAt(e.target.value)} className="h-9" /></label></div>{link && <><div className="mt-3 flex gap-2"><Input readOnly value={shareUrl} className="h-9 text-xs" /><Button variant="outline" onClick={() => copy(shareUrl)}>复制</Button></div><p className="mt-1 text-[11px] text-tx-tertiary">已加入 {link.useCount || 0}{link.maxUses ? ` / ${link.maxUses}` : ""} 人</p></>}<div className="mt-3 flex flex-wrap justify-end gap-2">{link && <><Button variant="outline" onClick={resetInviteUses}><RotateCcw size={13} className="mr-1" />清零统计</Button><Button variant="outline" onClick={rotateInvite}><RefreshCw size={13} className="mr-1" />换链接</Button><Button variant="outline" className="text-red-500" onClick={revokeInvite}><Unlink size={13} className="mr-1" />撤销</Button></>}<Button onClick={saveInvite} disabled={saving}>{link ? "保存邀请设置" : "生成邀请链接"}</Button></div></section>
    </div> : tab === "publish" ? <div className="space-y-5">
      <section className="rounded-xl border border-app-border p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1"><span className="text-xs">访问方式</span><select value={accessMode} onChange={(e) => setAccessMode(e.target.value as any)} className="h-10 w-full rounded-lg border bg-app-bg px-3 text-sm"><option value="public">公共空间公开</option><option value="link">持链接访问</option><option value="code">访问码</option><option value="password">密码保护</option></select></label><label className="space-y-1"><span className="text-xs">基础权限</span><select value={publicPermission} onChange={(e) => { const next = e.target.value as NotebookPublicationPermission; setPublicPermission(next); if (next === "read") { setAllowComment(false); setAllowEdit(false); } else if (next === "comment") setAllowComment(true); }} className="h-10 w-full rounded-lg border bg-app-bg px-3 text-sm"><option value="read">查看</option><option value="comment">查看 + 评论</option><option value="write">登录后加入编辑</option></select></label></div>{(accessMode === "code" || accessMode === "password") && <label className="mt-3 block space-y-1"><span className="text-xs">{accessMode === "code" ? "访问码" : "密码"}</span><Input type={accessMode === "password" ? "password" : "text"} value={publicSecret} onChange={(e) => setPublicSecret(e.target.value)} placeholder={publication?.hasSecret ? "留空保持原凭证" : "设置访问凭证"} /></label>}<label className="mt-3 block space-y-1"><span className="text-xs">有效期</span><Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></label><div className="mt-3 grid gap-2 sm:grid-cols-2"><Toggle checked={allowDownload} onChange={setAllowDownload} title="允许附件下载" /><Toggle checked={allowComment} onChange={setAllowComment} title="允许游客评论" /><Toggle checked={allowEdit} onChange={setAllowEdit} disabled={publicPermission !== "write"} title="登录后加入编辑" /><Toggle checked={allowReshare} onChange={setAllowReshare} title="允许二次分享" /></div>{publicationUrl && <div className="mt-3 flex gap-2"><Input readOnly value={publicationUrl} className="text-xs" /><Button variant="outline" onClick={() => copy(publicationUrl)}>复制</Button></div>}<div className="mt-4 flex justify-end gap-2">{publication && bool(publication.isActive) && <Button variant="outline" className="text-red-500" onClick={revokePublication}>撤销发布</Button>}<Button onClick={savePublication} disabled={saving}>保存发布设置</Button></div></section>
      <section><div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><MessageCircle size={15} />公开评论管理</div><Button size="sm" variant="ghost" onClick={loadComments}><RefreshCw size={13} /></Button></div><div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">{comments.length === 0 ? <div className="p-6 text-center text-sm text-tx-tertiary">暂无公开评论</div> : comments.map((c) => <div key={c.id} className={cn("p-3", bool(c.isHidden) && "opacity-60")}><div className="flex items-center justify-between gap-3"><div className="text-xs font-medium">{c.nickname} · {c.noteTitle}</div><div className="text-[10px] text-tx-tertiary">{new Date(c.createdAt).toLocaleString()}</div></div><p className="mt-1 whitespace-pre-wrap text-sm">{c.content}</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => moderate(c, { isResolved: !bool(c.isResolved) })}>{bool(c.isResolved) ? "取消解决" : "标记解决"}</Button><Button size="sm" variant="outline" onClick={() => moderate(c, { isHidden: !bool(c.isHidden) })}>{bool(c.isHidden) ? "恢复显示" : "隐藏"}</Button><Button size="sm" variant="outline" className="text-red-500" onClick={() => deleteComment(c)}><Trash2 size={13} /></Button></div></div>)}</div></section>
    </div> : <div className="space-y-5"><section className="rounded-xl border border-app-border bg-app-hover/20 p-4"><h3 className="text-sm font-semibold">目录级权限继承</h3><p className="mt-1 text-xs text-tx-tertiary">最近的显式规则优先，并向子目录继承。{inheritsFromParent ? "当前目录可删除覆盖以恢复父级继承。" : "当前目录是权限树根节点。"}</p></section><section><div className="grid gap-2 sm:grid-cols-[140px_1fr_auto]"><select value={aclPermission} onChange={(e) => setAclPermission(e.target.value as any)} className="h-9 rounded-lg border bg-app-bg px-2 text-sm"><option value="none">不可见</option><option value="read">可查看</option><option value="comment">可评论</option><option value="write">可编辑</option><option value="manage">可管理</option></select><Input value={aclQuery} onChange={(e) => setAclQuery(e.target.value)} placeholder="搜索用户" className="h-9" /><Button variant="outline" onClick={() => searchUsers("acl")}>搜索</Button></div><div className="mt-2 flex gap-4 text-xs"><label><input type="checkbox" checked={aclAllowDownload} onChange={(e) => setAclAllowDownload(e.target.checked)} /> 允许下载</label><label><input type="checkbox" checked={aclAllowReshare} onChange={(e) => setAclAllowReshare(e.target.checked)} /> 允许二次分享</label></div>{aclCandidates.map((u) => <button key={u.id} onClick={() => addOverride(u.id)} className="mt-2 flex w-full justify-between rounded border px-3 py-2 text-sm hover:bg-app-hover"><span>{u.displayName || u.username}</span><span>设为{permissionLabel(aclPermission)}</span></button>)}</section><section><div className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border">{overrides.length === 0 ? <div className="p-6 text-center text-sm text-tx-tertiary">没有显式覆盖</div> : overrides.map((entry) => <div key={entry.userId} className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><div className="truncate text-sm">{entry.displayName || entry.username}</div><div className="text-[11px] text-tx-tertiary">{bool(entry.allowDownload) ? "可下载" : "不可下载"} · {bool(entry.allowReshare) ? "可二次分享" : "不可二次分享"}</div></div><select value={entry.permission} onChange={(e) => updateOverride(entry, e.target.value as any)} className="h-8 rounded border bg-app-bg px-2 text-xs"><option value="none">不可见</option><option value="read">可查看</option><option value="comment">可评论</option><option value="write">可编辑</option><option value="manage">可管理</option></select><button onClick={() => removeOverride(entry.userId)} className="rounded p-1.5 text-red-500"><Trash2 size={14} /></button></div>)}</div></section></div>}</main>
  </div></div>;
}

function Toggle({ checked, onChange, title, disabled }: { checked: boolean; onChange: (value: boolean) => void; title: string; disabled?: boolean }) {
  return <label className={cn("flex cursor-pointer items-center gap-2 rounded-lg border border-app-border p-3 text-xs", disabled && "cursor-not-allowed opacity-50")}><input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span>{title}</span></label>;
}
