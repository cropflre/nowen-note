/**
 * WorkspaceSwitcher - 工作区切换器（Phase 1 多用户协作）
 *
 * 功能：
 *   - 下拉列出当前用户的所有工作区（含个人空间）
 *   - 切换后触发全局数据重载
 *   - 快捷入口：创建工作区、加入工作区（输入邀请码）
 *   - 管理成员入口
 */
import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Home, Building2, Plus, ChevronDown, Users, LogIn, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { Workspace } from "@/types";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import MembersPanel from "@/components/MembersPanel";

interface WorkspaceSwitcherProps {
  /** 切换后父组件触发的回调，通常是 reload 数据 */
  onWorkspaceChange?: (workspaceId: string) => void;
  collapsed?: boolean;
}

export default function WorkspaceSwitcher({ onWorkspaceChange, collapsed }: WorkspaceSwitcherProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [current, setCurrent] = useState<string>(getCurrentWorkspace());
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showMembers, setShowMembers] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const loadWorkspaces = async () => {
    try {
      const list = await api.getWorkspaces();
      setWorkspaces(list);
    } catch (e: any) {
      console.error("[WorkspaceSwitcher] load failed", e);
    }
  };

  useEffect(() => {
    loadWorkspaces();
  }, []);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const switchTo = (id: string) => {
    if (id === current) {
      setOpen(false);
      return;
    }
    setCurrent(id);
    setCurrentWorkspace(id);
    setOpen(false);
    onWorkspaceChange?.(id);
    // 触发页面重载以刷新所有数据
    window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: id } }));
  };

  const currentWs = workspaces.find((w) => w.id === current);
  const displayName = current === "personal" ? "个人空间" : currentWs?.name || "个人空间";
  const displayIcon = current === "personal" ? "🏠" : currentWs?.icon || "🏢";

  if (collapsed) {
    return (
      <button
        className="w-full flex items-center justify-center p-2 rounded-lg hover:bg-accent transition-colors"
        title={displayName}
        onClick={() => setOpen(true)}
      >
        <span className="text-xl">{displayIcon}</span>
      </button>
    );
  }

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border",
            "bg-background hover:bg-accent transition-colors text-sm",
          )}
        >
          <span className="text-lg">{displayIcon}</span>
          <div className="flex-1 text-left truncate">
            <div className="font-medium truncate">{displayName}</div>
            {currentWs && (
              <div className="text-xs text-muted-foreground">
                {currentWs.role} · {currentWs.memberCount} 位成员
              </div>
            )}
          </div>
          <ChevronDown className={cn("w-4 h-4 transition-transform", open && "rotate-180")} />
        </button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden"
            >
              <div className="max-h-[320px] overflow-auto py-1">
                {/* 个人空间 */}
                <WorkspaceItem
                  icon="🏠"
                  name="个人空间"
                  subtitle="仅自己可见"
                  active={current === "personal"}
                  onClick={() => switchTo("personal")}
                />
                {workspaces.length > 0 && (
                  <div className="mx-2 my-1 border-t border-border" />
                )}
                {workspaces.map((w) => (
                  <WorkspaceItem
                    key={w.id}
                    icon={w.icon || "🏢"}
                    name={w.name}
                    subtitle={`${w.role} · ${w.memberCount} 位成员`}
                    active={current === w.id}
                    onClick={() => switchTo(w.id)}
                    onManage={
                      w.role === "owner" || w.role === "admin"
                        ? () => {
                            setOpen(false);
                            setShowMembers(w.id);
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
              <div className="border-t border-border p-1">
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent"
                  onClick={() => {
                    setOpen(false);
                    setShowCreate(true);
                  }}
                >
                  <Plus className="w-4 h-4" />
                  创建工作区
                </button>
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent"
                  onClick={() => {
                    setOpen(false);
                    setShowJoin(true);
                  }}
                >
                  <LogIn className="w-4 h-4" />
                  使用邀请码加入
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showCreate && (
        <CreateWorkspaceDialog
          onClose={() => setShowCreate(false)}
          onCreated={(ws) => {
            setShowCreate(false);
            loadWorkspaces();
            switchTo(ws.id);
          }}
        />
      )}

      {showJoin && (
        <JoinWorkspaceDialog
          onClose={() => setShowJoin(false)}
          onJoined={(workspaceId) => {
            setShowJoin(false);
            loadWorkspaces();
            switchTo(workspaceId);
          }}
        />
      )}

      {showMembers && (
        <MembersPanel
          workspaceId={showMembers}
          onClose={() => {
            setShowMembers(null);
            loadWorkspaces();
          }}
        />
      )}
    </>
  );
}

/* ========== 下拉项 ========== */
function WorkspaceItem({
  icon,
  name,
  subtitle,
  active,
  onClick,
  onManage,
}: {
  icon: string;
  name: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
  onManage?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 mx-1 rounded cursor-pointer group",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
      onClick={onClick}
    >
      <span className="text-lg">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{name}</div>
        <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
      </div>
      {onManage && (
        <button
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-background"
          onClick={(e) => {
            e.stopPropagation();
            onManage();
          }}
          title="管理成员"
        >
          <Users className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/* ========== 创建工作区对话框 ========== */
function CreateWorkspaceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (ws: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("🏢");
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error("请输入工作区名称");
      return;
    }
    setLoading(true);
    try {
      const ws = await api.createWorkspace({ name: name.trim(), description, icon });
      toast.success("工作区创建成功");
      onCreated(ws);
    } catch (e: any) {
      toast.error(e.message || "创建失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="创建工作区" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-sm mb-1 block">图标</label>
          <Input
            value={icon}
            maxLength={4}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="🏢"
            className="w-20 text-center text-lg"
          />
        </div>
        <div>
          <label className="text-sm mb-1 block">
            名称 <span className="text-destructive">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：研发团队"
            autoFocus
          />
        </div>
        <div>
          <label className="text-sm mb-1 block">描述（可选）</label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简短说明"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleCreate} disabled={loading}>
            {loading ? "创建中..." : "创建"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ========== 加入工作区对话框 ========== */
function JoinWorkspaceDialog({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (workspaceId: string) => void;
}) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleJoin = async () => {
    if (!code.trim()) {
      toast.error("请输入邀请码");
      return;
    }
    setLoading(true);
    try {
      const res = await api.joinWorkspace(code.trim());
      if (res.alreadyMember) {
        toast.info("您已是该工作区成员");
        onJoined(res.workspaceId!);
      } else {
        toast.success(`已加入工作区：${res.workspace?.name}`);
        onJoined(res.workspace!.id);
      }
    } catch (e: any) {
      toast.error(e.message || "加入失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="使用邀请码加入工作区" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-sm mb-1 block">邀请码</label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCDEF1234"
            autoFocus
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">向工作区管理员索要邀请码</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleJoin} disabled={loading}>
            {loading ? "加入中..." : "加入"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ========== 通用 Modal ========== */
export function Modal({
  title,
  children,
  onClose,
  widthClass = "max-w-md",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  widthClass?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.15 }}
        className={cn("bg-card border border-border rounded-lg shadow-xl w-full", widthClass)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </motion.div>
    </div>
  );
}
