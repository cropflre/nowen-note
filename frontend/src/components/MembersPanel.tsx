/**
 * MembersPanel - 工作区成员与邀请管理面板（Phase 1）
 */
import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, Plus, UserPlus, Shield, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { Workspace, WorkspaceMember, WorkspaceInvite, WorkspaceRole } from "@/types";
import { Modal } from "@/components/WorkspaceSwitcher";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "所有者",
  admin: "管理员",
  editor: "编辑者",
  commenter: "评论者",
  viewer: "查看者",
};

const ROLE_BADGE_CLASS: Record<WorkspaceRole, string> = {
  owner: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  admin: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
  editor: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  commenter: "bg-green-500/20 text-green-600 dark:text-green-400",
  viewer: "bg-slate-500/20 text-slate-600 dark:text-slate-400",
};

interface Props {
  workspaceId: string;
  onClose: () => void;
}

export default function MembersPanel({ workspaceId, onClose }: Props) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [tab, setTab] = useState<"members" | "invites">("members");
  const [loading, setLoading] = useState(true);
  const [showCreateInvite, setShowCreateInvite] = useState(false);

  const isManager = workspace?.role === "owner" || workspace?.role === "admin";

  const loadAll = async () => {
    setLoading(true);
    try {
      const [ws, mem] = await Promise.all([
        api.getWorkspace(workspaceId),
        api.getWorkspaceMembers(workspaceId),
      ]);
      setWorkspace(ws);
      setMembers(mem);
      // 只有管理员才能看邀请码
      if (ws.role === "owner" || ws.role === "admin") {
        try {
          const inv = await api.getWorkspaceInvites(workspaceId);
          setInvites(inv);
        } catch {
          // 忽略
        }
      }
    } catch (e: any) {
      toast.error(e.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [workspaceId]);

  const handleRoleChange = async (userId: string, role: WorkspaceRole) => {
    try {
      await api.updateWorkspaceMember(workspaceId, userId, role);
      toast.success("角色已更新");
      loadAll();
    } catch (e: any) {
      toast.error(e.message || "更新失败");
    }
  };

  const handleRemove = async (userId: string, username: string) => {
    if (!confirm(`确定要移除成员「${username}」吗？`)) return;
    try {
      await api.removeWorkspaceMember(workspaceId, userId);
      toast.success("已移除");
      loadAll();
    } catch (e: any) {
      toast.error(e.message || "移除失败");
    }
  };

  const handleDeleteInvite = async (inviteId: string) => {
    if (!confirm("确定要撤销这个邀请码吗？")) return;
    try {
      await api.deleteWorkspaceInvite(workspaceId, inviteId);
      toast.success("邀请码已撤销");
      loadAll();
    } catch (e: any) {
      toast.error(e.message || "操作失败");
    }
  };

  return (
    <Modal
      title={workspace ? `${workspace.icon} ${workspace.name}` : "工作区"}
      onClose={onClose}
      widthClass="max-w-2xl"
    >
      {loading ? (
        <div className="py-8 text-center text-muted-foreground">加载中...</div>
      ) : (
        <>
          {/* Tab */}
          <div className="flex gap-1 mb-4 border-b border-border">
            <TabBtn active={tab === "members"} onClick={() => setTab("members")}>
              成员 ({members.length})
            </TabBtn>
            {isManager && (
              <TabBtn active={tab === "invites"} onClick={() => setTab("invites")}>
                邀请码 ({invites.length})
              </TabBtn>
            )}
          </div>

          {tab === "members" && (
            <div className="space-y-1 max-h-[60vh] overflow-auto">
              {members.map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center gap-3 p-2 rounded hover:bg-accent/50"
                >
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-sm font-semibold">
                    {m.username.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{m.username}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {m.email || "无邮箱"} · 加入于 {new Date(m.joinedAt).toLocaleDateString()}
                    </div>
                  </div>
                  {isManager && m.role !== "owner" ? (
                    <RoleSelect
                      value={m.role}
                      onChange={(role) => handleRoleChange(m.userId, role)}
                    />
                  ) : (
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded text-xs font-medium",
                        ROLE_BADGE_CLASS[m.role],
                      )}
                    >
                      {ROLE_LABEL[m.role]}
                    </span>
                  )}
                  {isManager && m.role !== "owner" && (
                    <button
                      onClick={() => handleRemove(m.userId, m.username)}
                      className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                      title="移除成员"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "invites" && isManager && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setShowCreateInvite(true)}>
                  <Plus className="w-4 h-4 mr-1" />
                  创建邀请码
                </Button>
              </div>
              <div className="space-y-2 max-h-[50vh] overflow-auto">
                {invites.length === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-8">
                    暂无邀请码
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
        </>
      )}

      {showCreateInvite && (
        <CreateInviteDialog
          workspaceId={workspaceId}
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
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-sm border-b-2 transition-colors -mb-px",
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
  onChange,
}: {
  value: WorkspaceRole;
  onChange: (v: WorkspaceRole) => void;
}) {
  const [open, setOpen] = useState(false);
  const options: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "px-2 py-0.5 rounded text-xs font-medium flex items-center gap-1",
          ROLE_BADGE_CLASS[value],
        )}
      >
        {ROLE_LABEL[value]}
        <ChevronDown className="w-3 h-3" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="absolute right-0 top-full mt-1 bg-popover border border-border rounded shadow-lg z-50 py-1 min-w-[100px]"
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
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function InviteItem({
  invite,
  onDelete,
}: {
  invite: WorkspaceInvite;
  onDelete: () => void;
}) {
  const expired =
    !!invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now();
  const exhausted = invite.maxUses > 0 && invite.useCount >= invite.maxUses;
  const invalid = expired || exhausted;

  const copyCode = () => {
    navigator.clipboard.writeText(invite.code);
    toast.success("邀请码已复制");
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
        title="点击复制"
      >
        {invite.code}
      </code>
      <div className="flex-1 min-w-0 text-xs text-muted-foreground">
        <div>
          角色：<span className="font-medium text-foreground">{ROLE_LABEL[invite.role]}</span>
          {" · "}
          使用 {invite.useCount}/{invite.maxUses || "∞"}
        </div>
        <div>
          {invite.expiresAt
            ? `有效期至 ${new Date(invite.expiresAt).toLocaleString()}`
            : "永久有效"}
          {expired && <span className="text-destructive ml-2">已过期</span>}
          {exhausted && <span className="text-destructive ml-2">已用尽</span>}
        </div>
      </div>
      <button
        onClick={copyCode}
        className="p-1.5 rounded hover:bg-accent"
        title="复制"
      >
        <Copy className="w-4 h-4" />
      </button>
      <button
        onClick={onDelete}
        className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
        title="撤销"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ========== 创建邀请码对话框 ========== */
function CreateInviteDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
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
      toast.success("邀请码已生成");
      onCreated();
    } catch (e: any) {
      toast.error(e.message || "创建失败");
    } finally {
      setLoading(false);
    }
  };

  const roleOptions: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];

  return (
    <Modal title="创建邀请码" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-sm mb-1 block">角色</label>
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
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-sm mb-1 block">最大使用次数</label>
          <Input
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(parseInt(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className="text-sm mb-1 block">有效期（天）</label>
          <Input
            type="number"
            min={0}
            value={expireDays}
            onChange={(e) => setExpireDays(parseInt(e.target.value) || 0)}
            placeholder="0 表示永久"
          />
          <p className="text-xs text-muted-foreground mt-1">0 表示永久有效</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? "创建中..." : "生成邀请码"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
