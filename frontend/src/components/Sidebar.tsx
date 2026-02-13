import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BookOpen, Plus, Star, Trash2, Search, ChevronRight,
  ChevronDown, Hash, PanelLeftClose, PanelLeft, ListTodo,
  Settings, LogOut, FilePlus, FolderPlus, Edit2, X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import SettingsModal from "@/components/SettingsModal";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useApp, useAppActions } from "@/store/AppContext";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { Notebook, ViewMode } from "@/types";
import { cn } from "@/lib/utils";

function buildTree(notebooks: Notebook[]): Notebook[] {
  const map = new Map<string, Notebook>();
  const roots: Notebook[] = [];
  notebooks.forEach((nb) => map.set(nb.id, { ...nb, children: [] }));
  notebooks.forEach((nb) => {
    const node = map.get(nb.id)!;
    if (nb.parentId && map.has(nb.parentId)) {
      map.get(nb.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function NotebookItem({
  notebook, depth, onSelect, selectedId, onToggle, onContextMenu,
  editingId, editValue, onEditChange, onEditSubmit, onEditCancel,
}: {
  notebook: Notebook; depth: number; onSelect: (id: string) => void;
  selectedId: string | null; onToggle: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  editingId: string | null; editValue: string;
  onEditChange: (v: string) => void; onEditSubmit: () => void; onEditCancel: () => void;
}) {
  const isSelected = selectedId === notebook.id;
  const hasChildren = notebook.children && notebook.children.length > 0;
  const isExpanded = notebook.isExpanded === 1;
  const isEditing = editingId === notebook.id;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm group transition-colors",
          isSelected ? "bg-app-active text-tx-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(notebook.id)}
        onContextMenu={(e) => onContextMenu(e, notebook.id)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(notebook.id); }}
            className="p-0.5 rounded hover:bg-app-border transition-colors"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        <span className="text-base">{notebook.icon}</span>
        {isEditing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit();
              if (e.key === "Escape") onEditCancel();
            }}
            onBlur={onEditSubmit}
            className="flex-1 text-sm bg-transparent border border-accent-primary/50 rounded px-1 py-0 outline-none text-tx-primary"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate">{notebook.name}</span>
        )}
      </motion.div>
      <AnimatePresence>
        {hasChildren && isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {notebook.children!.map((child) => (
              <NotebookItem
                key={child.id}
                notebook={child}
                depth={depth + 1}
                onSelect={onSelect}
                selectedId={selectedId}
                onToggle={onToggle}
                onContextMenu={onContextMenu}
                editingId={editingId}
                editValue={editValue}
                onEditChange={onEditChange}
                onEditSubmit={onEditSubmit}
                onEditCancel={onEditCancel}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// 笔记本右键菜单项
const notebookMenuItems: ContextMenuItem[] = [
  { id: "new_note", label: "新建笔记", icon: <FilePlus size={14} /> },
  { id: "new_sub", label: "新建子笔记本", icon: <FolderPlus size={14} /> },
  { id: "sep1", label: "", separator: true },
  { id: "rename", label: "重命名", icon: <Edit2 size={14} /> },
  { id: "sep2", label: "", separator: true },
  { id: "delete", label: "删除笔记本", icon: <Trash2 size={14} />, danger: true },
];

export default function Sidebar() {
  const { state } = useApp();
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  const [searchInput, setSearchInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(true);

  // 右键菜单
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();

  // 重命名状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);

  const tree = useMemo(() => buildTree(state.notebooks), [state.notebooks]);

  useEffect(() => {
    api.getNotebooks().then(actions.setNotebooks).catch(console.error);
    api.getTags().then(actions.setTags).catch(console.error);
  }, []);

  const handleNotebookSelect = (id: string) => {
    actions.setSelectedNotebook(id);
    actions.setViewMode("notebook");
    actions.setMobileSidebar(false);
  };

  const handleToggle = (id: string) => {
    const nb = state.notebooks.find((n) => n.id === id);
    if (nb) {
      api.updateNotebook(id, { isExpanded: nb.isExpanded === 1 ? 0 : 1 } as any).catch(console.error);
      actions.setNotebooks(
        state.notebooks.map((n) => n.id === id ? { ...n, isExpanded: n.isExpanded === 1 ? 0 : 1 } : n)
      );
    }
  };

  const handleCreateNotebook = async () => {
    const nb = await api.createNotebook({ name: "新笔记本", icon: "📒" });
    actions.setNotebooks([...state.notebooks, nb]);
    // 自动进入重命名
    setEditingId(nb.id);
    setEditValue(nb.name);
  };

  // 右键菜单操作分发
  const handleMenuAction = async (actionId: string) => {
    const targetId = menu.targetId;
    closeMenu();
    if (!targetId) return;

    const targetNb = state.notebooks.find((nb) => nb.id === targetId);

    switch (actionId) {
      case "new_note": {
        const note = await api.createNote({ notebookId: targetId, title: "无标题笔记" });
        actions.setActiveNote(note);
        actions.setSelectedNotebook(targetId);
        actions.setViewMode("notebook");
        break;
      }
      case "new_sub": {
        const sub = await api.createNotebook({ name: "新笔记本", icon: "📁", parentId: targetId } as any);
        actions.setNotebooks([...state.notebooks, sub]);
        // 展开父级
        if (targetNb && targetNb.isExpanded !== 1) {
          api.updateNotebook(targetId, { isExpanded: 1 } as any).catch(console.error);
          actions.setNotebooks(
            [...state.notebooks, sub].map((n) => n.id === targetId ? { ...n, isExpanded: 1 } : n)
          );
        }
        setEditingId(sub.id);
        setEditValue(sub.name);
        break;
      }
      case "rename": {
        if (targetNb) {
          setEditingId(targetId);
          setEditValue(targetNb.name);
        }
        break;
      }
      case "delete": {
        if (targetNb) {
          setDeleteTarget(targetNb);
        }
        break;
      }
    }
  };

  // 重命名提交
  const handleEditSubmit = async () => {
    if (!editingId || !editValue.trim()) {
      setEditingId(null);
      return;
    }
    const original = state.notebooks.find((nb) => nb.id === editingId);
    if (original && editValue.trim() !== original.name) {
      await api.updateNotebook(editingId, { name: editValue.trim() }).catch(console.error);
      actions.setNotebooks(
        state.notebooks.map((nb) => nb.id === editingId ? { ...nb, name: editValue.trim() } : nb)
      );
    }
    setEditingId(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
  };

  // 删除笔记本
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await api.deleteNotebook(deleteTarget.id).catch(console.error);
    actions.setNotebooks(state.notebooks.filter((nb) => nb.id !== deleteTarget.id));
    if (state.selectedNotebookId === deleteTarget.id) {
      actions.setSelectedNotebook(null);
      actions.setViewMode("all");
    }
    setDeleteTarget(null);
  };

  const navItems: { icon: React.ReactNode; label: string; mode: ViewMode; active: boolean }[] = [
    { icon: <BookOpen size={16} />, label: "所有笔记", mode: "all", active: state.viewMode === "all" },
    { icon: <ListTodo size={16} />, label: "待办事项", mode: "tasks", active: state.viewMode === "tasks" },
    { icon: <Star size={16} />, label: "收藏", mode: "favorites", active: state.viewMode === "favorites" },
    { icon: <Trash2 size={16} />, label: "回收站", mode: "trash", active: state.viewMode === "trash" },
  ];

  if (state.sidebarCollapsed) {
    return (
      <div className="hidden md:flex w-12 h-full bg-app-sidebar border-r border-app-border flex-col items-center py-3 gap-2 shrink-0 transition-colors">
        <Button variant="ghost" size="icon" onClick={actions.toggleSidebar}>
          <PanelLeft size={16} />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full md:w-[260px] md:min-w-[260px] h-full bg-app-sidebar border-r border-app-border flex flex-col shrink-0 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
        <h1 className="text-sm font-semibold text-tx-primary tracking-wide">{siteConfig.title}</h1>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="hidden md:inline-flex" onClick={actions.toggleSidebar}>
            <PanelLeftClose size={16} />
          </Button>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => actions.setMobileSidebar(false)}>
            <X size={16} />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" size={14} />
          <Input
            placeholder="搜索笔记..."
            className="pl-8 h-8 text-xs bg-app-bg border-app-border"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              if (e.target.value.trim()) {
                actions.setViewMode("search");
                actions.setSearchQuery(e.target.value);
              } else {
                actions.setViewMode("all");
                actions.setSearchQuery("");
              }
            }}
          />
        </div>
      </div>

      {/* Navigation */}
      <div className="px-3 py-1 space-y-0.5">
        {navItems.map((item) => (
          <button
            key={item.mode}
            onClick={() => {
              actions.setViewMode(item.mode);
              actions.setSelectedNotebook(null);
              actions.setMobileSidebar(false);
            }}
            className={cn(
              "flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-sm transition-colors",
              item.active
                ? "bg-app-active text-tx-primary"
                : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="mx-3 my-2 border-t border-app-border" />

      {/* Notebooks */}
      <div className="px-3 flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-tx-tertiary uppercase tracking-wider">笔记本</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCreateNotebook}>
          <Plus size={14} />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-1">
        <div className="space-y-0.5 pb-2">
          {tree.map((nb) => (
            <NotebookItem
              key={nb.id}
              notebook={nb}
              depth={0}
              onSelect={handleNotebookSelect}
              selectedId={state.selectedNotebookId}
              onToggle={handleToggle}
              onContextMenu={(e, id) => openMenu(e, id, "notebook")}
              editingId={editingId}
              editValue={editValue}
              onEditChange={setEditValue}
              onEditSubmit={handleEditSubmit}
              onEditCancel={handleEditCancel}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Tags */}
      <div className="border-t border-app-border">
        <button
          onClick={() => setTagsExpanded(!tagsExpanded)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-app-hover transition-colors"
        >
          <span className="text-xs font-medium text-tx-tertiary uppercase tracking-wider">标签</span>
          <ChevronDown
            size={14}
            className={cn(
              "text-tx-tertiary transition-transform duration-200",
              !tagsExpanded && "-rotate-90"
            )}
          />
        </button>
        <AnimatePresence initial={false}>
          {tagsExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-2 pb-2 space-y-0.5">
                {state.tags.length === 0 ? (
                  <p className="text-[10px] text-tx-tertiary px-2 py-1">暂无标签</p>
                ) : (
                  state.tags.map((tag) => {
                    const isActive = state.viewMode === "tag" && state.selectedTagId === tag.id;
                    return (
                      <button
                        key={tag.id}
                        onClick={() => {
                          actions.setSelectedTag(tag.id);
                          actions.setSelectedNotebook(null);
                          actions.setViewMode("tag");
                          actions.setMobileSidebar(false);
                        }}
                        className={cn(
                          "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs transition-colors group/tag",
                          isActive
                            ? "bg-app-active text-tx-primary"
                            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                        )}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: tag.color }}
                        />
                        <span className="flex-1 truncate text-left">{tag.name}</span>
                        {tag.noteCount !== undefined && tag.noteCount > 0 && (
                          <span className="text-[10px] text-tx-tertiary tabular-nums">{tag.noteCount}</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer: Settings + Logout */}
      <div className="border-t border-app-border px-3 py-2 flex items-center justify-between">
        <button
          onClick={() => setShowSettings(true)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors"
        >
          <Settings size={15} />
          <span>设置</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-tx-tertiary hover:text-red-500 dark:hover:text-red-400"
          onClick={() => {
            localStorage.removeItem("nowen-token");
            window.location.reload();
          }}
          title="退出登录"
        >
          <LogOut size={16} />
        </Button>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </AnimatePresence>

      {/* Notebook Context Menu */}
      <ContextMenu
        isOpen={menu.isOpen && menu.targetType === "notebook"}
        x={menu.x}
        y={menu.y}
        menuRef={menuRef}
        items={notebookMenuItems}
        onAction={handleMenuAction}
        header={state.notebooks.find((nb) => nb.id === menu.targetId)?.name}
      />

      {/* Delete Confirmation */}
      <AnimatePresence>
        {deleteTarget && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-zinc-900/50 backdrop-blur-sm"
              onClick={() => setDeleteTarget(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0 }}
              className="relative bg-white dark:bg-zinc-900 w-full max-w-sm p-5 rounded-xl shadow-2xl border border-zinc-200 dark:border-zinc-800"
              onClick={(e) => e.stopPropagation()}
            >
              <h4 className="text-base font-bold text-zinc-900 dark:text-zinc-100 mb-2">
                删除笔记本
              </h4>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                确定要删除「{deleteTarget.icon} {deleteTarget.name}」吗？该笔记本下的所有笔记也将被删除，此操作不可撤销。
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                >
                  确认删除
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
