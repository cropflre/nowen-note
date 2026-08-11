/**
 * MembersPanel - 工作区成员与邀请管理面板（Phase 1）
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Trash2, Plus, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import {
  Workspace,
  WorkspaceMember,
  WorkspaceInvite,
  WorkspaceRole,
  WorkspaceFeatures,
  WORKSPACE_FEATURE_META,
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

interface Props {
  workspaceId: string;
  onClose: () => void;
}

export default function MembersPanel({ workspaceId, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  const [tab, setTab] = useState<"members" | "invites" | "features">("members");
  const [loading, setLoading] = useState(true);
  const [showCreateInvite, setShowCreateInvite] = useState(false);

  const locale = i18n.resolvedLanguage || i18n.language;
  const isManager = workspace?.role === "owner" || workspace?.role === "admin";
  // 功能开关：按后端约束，仅 owner 可改；admin 可见但只读（保持信息透明）。
  const isOwner = workspace?.role === "owner";

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

  useEffect(() => {
    loadAll();
  }, [workspaceId]);

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
    } catch (e: any) {
      toast.error(e.message || t("workspaceMembers.actionFailed"));
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
    } catch (e: any) {
      setFeatures(prev);
      toast.error(e?.message || t("workspaceMembers.saveFailed"));
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
          <div className="flex gap-1 mb-4 border-b border-border shrink-0">
            <TabBtn active={tab === "members"} onClick={() => setTab("members")}>
              {t("workspaceMembers.membersCount", { count: members.length })}
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
            <div className="space-y-1 flex-1 min-h-0 overflow-auto">
              {members.map((m) => {
                const joinedDate = new Date(m.joinedAt).toLocaleDateString(locale);
                return (
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
                        {m.email || t("workspaceMembers.noEmail")} · {t("workspaceMembers.joinedAt", { date: joinedDate })}
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
                        {t(`workspaceMembers.roles.${m.role}`)}
                      </span>
                    )}
                    {isManager && m.role !== "owner" && (
                      <button
                        onClick={() => handleRemove(m.userId, m.username)}
                        className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                        title={t("workspaceMembers.removeMember")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
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
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<
    { top: number; left: number; placement: "bottom" | "top" } | null
  >(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const options: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];

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
            ? t("workspaceMembers.validUntil", { date: new Date(invite.expiresAt).toLocaleString(locale) })
            : t("workspaceMembers.permanent")}
          {expired && <span className="text-destructive ml-2">{t("workspaceMembers.expired")}</span>}
          {exhausted && <span className="text-destructive ml-2">{t("workspaceMembers.exhausted")}</span>}
        </div>
      </div>
      <button
        onClick={copyCode}
        className="p-1.5 rounded hover:bg-accent"
        title={t("workspaceMembers.copy")}
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
  onClose,
  onCreated,
}: {
  workspaceId: string;
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
    } catch (e: any) {
      toast.error(e.message || t("workspaceMembers.createFailed"));
    } finally {
      setLoading(false);
    }
  };

  const roleOptions: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];

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
