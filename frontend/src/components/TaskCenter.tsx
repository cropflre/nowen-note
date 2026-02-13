import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, Circle, Flag, Calendar, Plus, ListTodo,
  CalendarDays, AlertTriangle, CheckCheck, Inbox, X,
  ChevronRight, Trash2
} from "lucide-react";
import { format, isToday, isPast, isTomorrow, isThisWeek, parseISO } from "date-fns";
import { zhCN } from "date-fns/locale";
import { api } from "@/lib/api";
import { Task, TaskFilter, TaskPriority, TaskStats } from "@/types";
import { cn } from "@/lib/utils";

/* ===== 优先级配置 ===== */
const PRIORITY_CONFIG: Record<number, { label: string; color: string; flagClass: string }> = {
  3: { label: "高", color: "text-red-500", flagClass: "text-red-500" },
  2: { label: "中", color: "text-amber-500", flagClass: "text-amber-500" },
  1: { label: "低", color: "text-blue-400", flagClass: "text-blue-400" },
};

/* ===== 过滤器配置 ===== */
const FILTERS: { key: TaskFilter; label: string; icon: React.ReactNode }[] = [
  { key: "all", label: "全部任务", icon: <Inbox size={16} /> },
  { key: "today", label: "今天", icon: <CalendarDays size={16} /> },
  { key: "week", label: "未来 7 天", icon: <Calendar size={16} /> },
  { key: "overdue", label: "已逾期", icon: <AlertTriangle size={16} /> },
  { key: "completed", label: "已完成", icon: <CheckCheck size={16} /> },
];

/* ===== 日期显示 ===== */
function DateBadge({ dateStr }: { dateStr: string | null }) {
  if (!dateStr) return null;
  const date = parseISO(dateStr);
  let className = "text-tx-tertiary";
  let text = format(date, "MM/dd", { locale: zhCN });

  if (isToday(date)) {
    className = "text-green-500";
    text = "今天";
  } else if (isTomorrow(date)) {
    className = "text-accent-primary";
    text = "明天";
  } else if (isPast(date)) {
    className = "text-red-500";
    text = "逾期 " + format(date, "MM/dd");
  } else if (isThisWeek(date)) {
    text = format(date, "EEEE", { locale: zhCN });
  }

  return (
    <span className={cn("flex items-center gap-1 text-xs whitespace-nowrap", className)}>
      <Calendar size={12} />
      {text}
    </span>
  );
}

/* ===== 任务项组件 ===== */
const TaskRow = React.forwardRef<HTMLDivElement, {
  task: Task;
  onToggle: (id: string) => void;
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
}>(({ task, onToggle, onSelect, onDelete }, ref) => {
  const isCompleted = task.isCompleted === 1;
  const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG[2];

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20, transition: { duration: 0.15 } }}
      className={cn(
        "group flex items-center gap-3 px-4 py-3 rounded-lg border transition-all cursor-pointer",
        isCompleted
          ? "border-transparent bg-app-hover/50 opacity-60"
          : "border-app-border bg-app-elevated hover:shadow-md hover:border-accent-primary/30"
      )}
      onClick={() => onSelect(task)}
    >
      {/* Checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(task.id); }}
        className="flex-shrink-0 transition-transform hover:scale-110"
      >
        {isCompleted ? (
          <CheckCircle2 className="w-5 h-5 text-indigo-500" />
        ) : (
          <Circle className="w-5 h-5 text-tx-tertiary group-hover:text-indigo-400 transition-colors" />
        )}
      </button>

      {/* Title */}
      <span
        className={cn(
          "flex-1 text-sm truncate transition-all",
          isCompleted ? "line-through text-tx-tertiary" : "text-tx-primary"
        )}
      >
        {task.title}
      </span>

      {/* Badges */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <DateBadge dateStr={task.dueDate} />
        <Flag size={14} className={pri.flagClass} />
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          className="opacity-0 group-hover:opacity-100 text-tx-tertiary hover:text-accent-danger transition-all"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  );
});

/* ===== 任务详情面板 ===== */
const TaskDetail = React.forwardRef<HTMLDivElement, {
  task: Task;
  onClose: () => void;
  onUpdate: (id: string, data: Partial<Task>) => void;
  onDelete: (id: string) => void;
}>(({ task, onClose, onUpdate, onDelete }, ref) => {
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate || "");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(task.title);
    setPriority(task.priority);
    setDueDate(task.dueDate || "");
  }, [task.id]);

  const handleSave = () => {
    onUpdate(task.id, { title: title.trim() || task.title, priority, dueDate: dueDate || null });
  };

  return (
    <motion.div
      ref={ref}
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      className="w-[340px] min-w-[340px] h-full border-l border-app-border bg-app-surface flex flex-col shrink-0"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
        <span className="text-sm font-semibold text-tx-primary">任务详情</span>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover transition-colors">
          <X size={16} className="text-tx-secondary" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4 space-y-5">
        {/* 标题 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">标题</label>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleSave}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* 优先级 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">优先级</label>
          <div className="flex gap-2">
            {([3, 2, 1] as TaskPriority[]).map((p) => {
              const cfg = PRIORITY_CONFIG[p];
              return (
                <button
                  key={p}
                  onClick={() => { setPriority(p); onUpdate(task.id, { priority: p }); }}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-all",
                    priority === p
                      ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                      : "border-app-border text-tx-secondary hover:bg-app-hover"
                  )}
                >
                  <Flag size={12} className={priority === p ? cfg.flagClass : ""} />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 截止日期 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">截止日期</label>
          <input
            type="date"
            value={dueDate ? dueDate.split("T")[0] : ""}
            onChange={(e) => {
              const val = e.target.value || null;
              setDueDate(val || "");
              onUpdate(task.id, { dueDate: val });
            }}
            className="w-full px-3 py-2 rounded-md bg-app-bg border border-app-border text-sm text-tx-primary focus:outline-none focus:border-accent-primary transition-colors"
          />
        </div>

        {/* 创建时间 */}
        <div>
          <label className="text-xs text-tx-tertiary uppercase tracking-wider mb-1.5 block">创建时间</label>
          <span className="text-sm text-tx-secondary">
            {format(parseISO(task.createdAt + (task.createdAt.endsWith("Z") ? "" : "Z")), "yyyy-MM-dd HH:mm", { locale: zhCN })}
          </span>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-app-border">
        <button
          onClick={() => { onDelete(task.id); onClose(); }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-accent-danger border border-accent-danger/30 hover:bg-accent-danger/10 transition-colors"
        >
          <Trash2 size={14} />
          删除任务
        </button>
      </div>
    </motion.div>
  );
});

/* ===== 主组件 ===== */
export default function TaskCenter() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleToggle = async (id: string) => {
    // Optimistic update
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isCompleted: t.isCompleted ? 0 : 1 } : t))
    );
    try {
      await api.toggleTask(id);
      // Refresh stats
      const s = await api.getTaskStats();
      setStats(s);
    } catch {
      loadTasks(); // rollback
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      const task = await api.createTask({ title: newTitle.trim() });
      setTasks((prev) => [task, ...prev]);
      setNewTitle("");
      inputRef.current?.focus();
      const s = await api.getTaskStats();
      setStats(s);
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const handleUpdate = async (id: string, data: Partial<Task>) => {
    try {
      const updated = await api.updateTask(id, data);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      if (selectedTask?.id === id) setSelectedTask(updated);
    } catch (err) {
      console.error("Failed to update task:", err);
    }
  };

  const handleDelete = async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    if (selectedTask?.id === id) setSelectedTask(null);
    try {
      await api.deleteTask(id);
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
      case "week": return stats.today; // approximate
      case "overdue": return stats.overdue;
      case "completed": return stats.completed;
      default: return 0;
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Left: Filter Panel */}
      <div className="w-[220px] min-w-[220px] shrink-0 border-r border-app-border bg-app-surface flex flex-col transition-colors">
        <div className="px-4 py-4 border-b border-app-border">
          <div className="flex items-center gap-2">
            <ListTodo size={18} className="text-accent-primary" />
            <h2 className="text-sm font-bold text-tx-primary">待办事项</h2>
          </div>
          {stats && (
            <div className="mt-2 text-xs text-tx-tertiary">
              {stats.pending} 待完成 · {stats.completed} 已完成
            </div>
          )}
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelectedTask(null); }}
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
      <div className="flex-1 flex flex-col overflow-hidden bg-app-bg transition-colors">
        {/* Header */}
        <div className="px-6 py-4 border-b border-app-border">
          <h1 className="text-lg font-bold text-tx-primary">
            {FILTERS.find((f) => f.key === filter)?.label || "全部任务"}
          </h1>
        </div>

        {/* Quick Add */}
        <div className="px-6 py-3 border-b border-app-border">
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-dashed border-app-border bg-app-elevated/50 hover:border-accent-primary/40 transition-colors">
            <Plus size={16} className="text-tx-tertiary flex-shrink-0" />
            <input
              ref={inputRef}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="添加新任务，按 Enter 保存..."
              className="flex-1 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
            />
          </div>
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-auto px-6 py-3">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-tx-tertiary text-sm">
              加载中...
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-tx-tertiary">
              <CheckCheck size={36} className="mb-3 opacity-40" />
              <span className="text-sm">暂无任务</span>
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onToggle={handleToggle}
                    onSelect={setSelectedTask}
                    onDelete={handleDelete}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>

      {/* Right: Detail Drawer */}
      <AnimatePresence>
        {selectedTask && (
          <TaskDetail
            key={selectedTask.id}
            task={selectedTask}
            onClose={() => setSelectedTask(null)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
