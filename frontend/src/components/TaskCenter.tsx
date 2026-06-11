import React, { useState, useEffect, useCallback, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import {
  Calendar, ListTodo,
  CalendarDays, AlertTriangle, CheckCheck, Inbox,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { Task, TaskFilter, TaskStats } from "@/types";
import { cn } from "@/lib/utils";
import {
  TASK_CENTER_MAIN_CLASS,
  TASK_CENTER_ROOT_CLASS,
  TASK_MOBILE_FILTER_BAR_CLASS,
} from "@/lib/taskLayout";

// 子组件 & 工具
import { useTaskTree } from "./tasks/useTaskTree";
import { buildTaskTree } from "./tasks/taskProgress";
import type { TaskTreeNode } from "./tasks/taskProgress";
import { TaskOverview } from "./tasks/TaskOverview";
import { TaskTreeRow } from "./tasks/TaskTreeRow";
import { TaskQuickAdd } from "./tasks/TaskQuickAdd";
import { TaskDetailPanel } from "./tasks/TaskDetailPanel";
import { FlatTaskRow } from "./tasks/FlatTaskRow";
/* ===== 主组件 ===== */
export default function TaskCenter() {
  const { t } = useTranslation();

  const FILTERS: { key: TaskFilter; label: string; icon: React.ReactNode }[] = [
    { key: "all", label: t('tasks.allTasks'), icon: <Inbox size={16} /> },
    { key: "today", label: t('tasks.today'), icon: <CalendarDays size={16} /> },
    { key: "week", label: t('tasks.next7Days'), icon: <Calendar size={16} /> },
    { key: "overdue", label: t('tasks.overdue'), icon: <AlertTriangle size={16} /> },
    { key: "completed", label: t('tasks.completed'), icon: <CheckCheck size={16} /> },
  ];

  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingOrphansRef = useRef<string[]>([]);

  // 树形任务 hook
  const {
    flatOrderedTasks,
    expandedTaskIds,
    toggleExpand,
    isTreeMode,
  } = useTaskTree(tasks, filter);

  // 收集指定任务及其所有后代的 id（用于删除父任务时同步移除子任务）
  // 收集指定任务及其所有后代的 id（用于删除父任务时同步移除子任务）
  // 加 visited 防护，避免坏数据 parentId 环导致递归死循环
  const getDescendantIds = useCallback((rootId: string, taskList: Task[], visited = new Set<string>()): string[] => {
    if (visited.has(rootId)) return [];
    visited.add(rootId);
    const ids: string[] = [rootId];
    const children = taskList.filter((t) => t.parentId === rootId);
    for (const child of children) {
      ids.push(...getDescendantIds(child.id, taskList, visited));
    }
    return ids;
  }, []);
  const selectedTask = React.useMemo(() => {
    if (!selectedTaskId) return null;
    return tasks.find((t) => t.id === selectedTaskId) || null;
  }, [selectedTaskId, tasks]);

  const loadTasks = useCallback(async () => {
    try {
      const [data, statsData] = await Promise.all([
        api.getTasks(filter),
        api.getTaskStats(),
      ]);
      setTasks(data);
      setStats(statsData);
    } catch (err) {
      console.error("Failed to load tasks:", err);
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const onWs = () => {
      setSelectedTaskId(null);
      loadTasks();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [loadTasks]);

  const handleToggle = async (id: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isCompleted: t.isCompleted ? 0 : 1 } : t))
    );
    try {
      await api.toggleTask(id);
      const s = await api.getTaskStats();
      setStats(s);
    } catch {
      loadTasks();
    }
  };

  const handleCreate = async (orphanIds: string[] = []): Promise<boolean> => {
    if (!newTitle.trim()) return false;
    const titleToCreate = newTitle.trim();
    try {
      const task = await api.createTask({ title: titleToCreate });
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      inputRef.current?.focus();
      if (orphanIds.length) {
        await Promise.all(
          orphanIds.map((id) =>
            api.taskAttachments.bind(id, task.id).catch(() => null)
          )
        );
      }
      const s = await api.getTaskStats();
      setStats(s);
      return true;
    } catch (err) {
      console.error("Failed to create task:", err);
      return false;
    }
  };

  const handleUpdate = async (id: string, data: Partial<Task>) => {
    try {
      const updated = await api.updateTask(id, data);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      if (selectedTaskId === id) setSelectedTaskId(updated.id);
      const affectsStats =
        "dueDate" in data ||
        "isCompleted" in data ||
        "priority" in data;
      if (affectsStats) {
        try {
          const s = await api.getTaskStats();
          setStats(s);
        } catch (e) {
          console.error("Failed to refresh task stats:", e);
        }
      }
    } catch (err) {
      console.error("Failed to update task:", err);
    }
  };

  const handleDelete = async (id: string) => {
    // 收集要删除的 id 列表（父任务 + 所有后代），乐观更新一次性移除
    const idsToRemove = getDescendantIds(id, tasks);
    setTasks((prev) => prev.filter((t) => !idsToRemove.includes(t.id)));
    if (selectedTaskId && idsToRemove.includes(selectedTaskId)) setSelectedTaskId(null);
    try {
      await api.deleteTask(id); // 后端 ON DELETE CASCADE 会同步删子任务
      const s = await api.getTaskStats();
      setStats(s);
    } catch {
      loadTasks();
    }
  };
  const filterCount = (key: TaskFilter): number => {
    if (!stats) return 0;
    switch (key) {
      case "all": return stats.total;
      case "today": return stats.today;
      case "week": return stats.week ?? 0;
      case "overdue": return stats.overdue;
      case "completed": return stats.completed;
      default: return 0;
    }
  };

  // 查找 selectedTask 对应的树节点（用于详情面板进度计算）
  const selectedTreeNode = React.useMemo(() => {
    if (!selectedTask || !isTreeMode) return null;
    const findNode = (nodes: TaskTreeNode[]): TaskTreeNode | null => {
      for (const n of nodes) {
        if (n.id === selectedTask.id) return n;
        const found = findNode(n.children);
        if (found) return found;
      }
      return null;
    };
    // 从 flatOrderedTasks 中重建树查找（避免重复构建）
    // 直接用 buildTaskTree 查找更准确

    const tree = buildTaskTree(tasks);
    return findNode(tree);
  }, [selectedTask, tasks, isTreeMode]);

  return (
    <div className={TASK_CENTER_ROOT_CLASS}>
      {/* Left: Filter Panel — 桌面端显示 */}
      <div className="hidden md:flex w-[220px] min-w-[220px] shrink-0 border-r border-app-border bg-app-surface flex-col transition-colors">
        <div className="px-4 py-4 border-b border-app-border">
          <div className="flex items-center gap-2">
            <ListTodo size={18} className="text-accent-primary" />
            <h2 className="text-sm font-bold text-tx-primary">{t('tasks.title')}</h2>
          </div>
          {stats && (
            <div className="mt-2 text-xs text-tx-tertiary">
              {t('tasks.pendingCount', { pending: stats.pending, completed: stats.completed })}
            </div>
          )}
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTaskId(null); }}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors",
                filter === f.key
                  ? "bg-app-active text-accent-primary"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              )}
            >
              <span className="flex items-center gap-2.5">
                {f.icon}
                {f.label}
              </span>
              <span className={cn(
                "text-xs min-w-[20px] text-center rounded-full px-1.5 py-0.5",
                filter === f.key ? "bg-accent-primary/20 text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Center: Task List */}
      <div className={TASK_CENTER_MAIN_CLASS}>
        {/* 移动端：水平筛选标签 */}
        <div className={TASK_MOBILE_FILTER_BAR_CLASS}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTaskId(null); }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                filter === f.key
                  ? "bg-accent-primary/15 text-accent-primary"
                  : "text-tx-secondary bg-app-hover/50 active:bg-app-active"
              )}
            >
              {f.icon}
              {f.label}
              <span className={cn(
                "text-[10px] min-w-[16px] text-center",
                filter === f.key ? "text-accent-primary" : "text-tx-tertiary"
              )}>
                {filterCount(f.key)}
              </span>
            </button>
          ))}
        </div>

        {/* 顶部概览卡片 — 仅在 "all" 过滤时显示 */}
        {filter === "all" && !isLoading && (
          <TaskOverview tasks={tasks} stats={stats} />
        )}

        {/* Header — 桌面端显示 */}
        <div className="hidden md:block px-6 py-4 border-b border-app-border">
          <h1 className="text-lg font-bold text-tx-primary">
            {FILTERS.find((f) => f.key === filter)?.label || t('tasks.allTasks')}
          </h1>
        </div>

        {/* Quick Add */}
        <div className="px-4 md:px-6 py-3 border-b border-app-border">
          <TaskQuickAdd
            value={newTitle}
            onChange={setNewTitle}
            onSubmit={handleCreate}
            inputRef={inputRef}
          />
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6 py-3">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-tx-tertiary text-sm">
              {t('common.loading')}
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-tx-tertiary">
              <CheckCheck size={36} className="mb-3 opacity-40" />
              <span className="text-sm">{t('tasks.noTasks')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {isTreeMode ? (
                  // 树形模式：使用 flatOrderedTasks 渲染带缩进的任务行
                  flatOrderedTasks.map((item) => (
                    <TaskTreeRow
                      key={item.node.id}
                      task={item.node}
                      depth={item.depth}
                      isExpanded={expandedTaskIds.has(item.node.id)}
                      hasChildren={item.node.children.length > 0}
                      onToggle={handleToggle}
                      onSelect={(task) => setSelectedTaskId(task.id)}
                      onDelete={handleDelete}
                      onToggleExpand={toggleExpand}
                    />
                  ))
                ) : (
                  // 过滤模式：平铺渲染
                  tasks.map((task) => (
                    <FlatTaskRow
                      key={task.id}
                      task={task}
                      onToggle={handleToggle}
                      onSelect={(task) => setSelectedTaskId(task.id)}
                      onDelete={handleDelete}
                    />
                  ))
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail Panel */}
      <AnimatePresence>
        {selectedTask && (
          <TaskDetailPanel
            key={selectedTask.id}
            task={selectedTask}
            treeNode={selectedTreeNode}
            onClose={() => setSelectedTaskId(null)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
