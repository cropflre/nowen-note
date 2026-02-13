import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BookOpen, Plus, Star, Trash2, FolderOpen, Search, ChevronRight,
  ChevronDown, Settings, Hash, MoreHorizontal, PanelLeftClose, PanelLeft
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp, useAppActions } from "@/store/AppContext";
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
  notebook, depth, onSelect, selectedId, onToggle
}: {
  notebook: Notebook; depth: number; onSelect: (id: string) => void;
  selectedId: string | null; onToggle: (id: string) => void;
}) {
  const isSelected = selectedId === notebook.id;
  const hasChildren = notebook.children && notebook.children.length > 0;
  const isExpanded = notebook.isExpanded === 1;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm group transition-colors",
          isSelected ? "bg-dark-active text-text-primary" : "text-text-secondary hover:bg-dark-hover hover:text-text-primary"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(notebook.id)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(notebook.id); }}
            className="p-0.5 rounded hover:bg-dark-border transition-colors"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5" />
        )}
        <span className="text-base">{notebook.icon}</span>
        <span className="flex-1 truncate">{notebook.name}</span>
        <button className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-dark-border transition-all">
          <MoreHorizontal size={14} />
        </button>
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
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function Sidebar() {
  const { state } = useApp();
  const actions = useAppActions();
  const [searchInput, setSearchInput] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(state.notebooks), [state.notebooks]);

  useEffect(() => {
    api.getNotebooks().then(actions.setNotebooks).catch(console.error);
    api.getTags().then(actions.setTags).catch(console.error);
  }, []);

  const handleNotebookSelect = (id: string) => {
    actions.setSelectedNotebook(id);
    actions.setViewMode("notebook");
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
  };

  const navItems: { icon: React.ReactNode; label: string; mode: ViewMode; active: boolean }[] = [
    { icon: <BookOpen size={16} />, label: "所有笔记", mode: "all", active: state.viewMode === "all" },
    { icon: <Star size={16} />, label: "收藏", mode: "favorites", active: state.viewMode === "favorites" },
    { icon: <Trash2 size={16} />, label: "回收站", mode: "trash", active: state.viewMode === "trash" },
  ];

  if (state.sidebarCollapsed) {
    return (
      <div className="w-12 h-full bg-dark-surface border-r border-dark-border flex flex-col items-center py-3 gap-2 shrink-0">
        <Button variant="ghost" size="icon" onClick={actions.toggleSidebar}>
          <PanelLeft size={16} />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="w-[260px] min-w-[260px] h-full bg-dark-surface border-r border-dark-border flex flex-col shrink-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-border">
        <h1 className="text-sm font-semibold text-text-primary tracking-wide">MyStation</h1>
        <Button variant="ghost" size="icon" onClick={actions.toggleSidebar}>
          <PanelLeftClose size={16} />
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" size={14} />
          <Input
            placeholder="搜索笔记..."
            className="pl-8 h-8 text-xs bg-dark-bg border-dark-border"
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
            }}
            className={cn(
              "flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md text-sm transition-colors",
              item.active
                ? "bg-dark-active text-text-primary"
                : "text-text-secondary hover:bg-dark-hover hover:text-text-primary"
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="mx-3 my-2 border-t border-dark-border" />

      {/* Notebooks */}
      <div className="px-3 flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">笔记本</span>
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
            />
          ))}
        </div>
      </ScrollArea>

      {/* Tags */}
      <div className="border-t border-dark-border px-3 py-2">
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">标签</span>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {state.tags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs cursor-pointer hover:opacity-80 transition-opacity"
              style={{ backgroundColor: tag.color + "20", color: tag.color }}
            >
              <Hash size={10} />
              {tag.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
