/**
 * 待办（服务端 /api/tasks）
 *
 * 交互：点左边的圆圈直接勾选 —— 手机上最高频的动作，不该藏在二级菜单里。
 * 更新策略：**乐观更新 + 失败回滚**。
 *   勾下去要立刻有反馈（等网络回来再变会显得「卡」），
 *   但失败必须回滚并提示，否则用户以为勾上了、其实没保存。
 */
import { useEffect, useMemo, useState } from "react";
import { getClient } from "../api/client";
import { parseServerTime, shortDate } from "../lib/time";
import { PromptDialog } from "../shell/PromptDialog";
import { Fab } from "../shell/Fab";
import { TopBar } from "../App";
import type { Task, TaskStats } from "../../sdk/types";

type Filter = "open" | "done" | "all";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "open", label: "未完成" },
  { id: "done", label: "已完成" },
  { id: "all", label: "全部" },
];

const PRIORITY_LABEL: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

function isOverdue(task: Task): boolean {
  if (!task.dueDate || task.status === "done") return false;
  const due = parseServerTime(task.dueDate)?.getTime() ?? Number.NaN;
  return Number.isFinite(due) && due < Date.now();
}

function formatDue(iso: string): string {
  return shortDate(iso);
}

export function TasksScreen() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [busyCreate, setBusyCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, s] = await Promise.all([
          getClient().listTasks() as Promise<Task[]>,
          getClient().getTaskStats() as Promise<TaskStats>,
        ]);
        if (cancelled) return;
        setTasks(list);
        setStats(s);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (!tasks) return null;
    const filtered = tasks.filter((t) => {
      if (filter === "open") return t.status !== "done";
      if (filter === "done") return t.status === "done";
      return true;
    });
    const rank: Record<string, number> = { doing: 0, todo: 1, done: 2 };
    return [...filtered].sort((a, b) => {
      const r = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (r !== 0) return r;
      const ad = a.dueDate ? (parseServerTime(a.dueDate)?.getTime() ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      const bd = b.dueDate ? (parseServerTime(b.dueDate)?.getTime() ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
  }, [tasks, filter]);

  async function createTask(title: string) {
    setBusyCreate(true);
    try {
      const created = (await getClient().createTask({ title, status: "todo", priority: "medium" })) as Task;
      setTasks((prev) => (prev ? [created, ...prev] : [created]));
      setFilter("open");
      setCreating(false);
      setError(null);
      void getClient()
        .getTaskStats()
        .then((s) => setStats(s as TaskStats))
        .catch(() => {});
    } catch (err) {
      setError(`新建失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyCreate(false);
    }
  }

  async function toggle(task: Task) {
    if (pending.has(task.id)) return;
    const nextStatus: Task["status"] = task.status === "done" ? "todo" : "done";

    setPending((p) => new Set(p).add(task.id));
    setTasks((prev) =>
      prev
        ? prev.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status: nextStatus,
                  completedAt: nextStatus === "done" ? new Date().toISOString() : null,
                }
              : t,
          )
        : prev,
    );

    try {
      const updated = (await getClient().toggleTask(task.id)) as Task;
      setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? updated : t)) : prev));
      setError(null);
      void getClient()
        .getTaskStats()
        .then((s) => setStats(s as TaskStats))
        .catch(() => {});
    } catch (err) {
      // 回滚：不能让用户以为勾上了、其实没保存
      setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? task : t)) : prev));
      setError(`勾选失败，已还原：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <>
      <TopBar title="待办" />
      <div className="app-content">
        {stats ? (
          <div className="stat-grid">
            <div className="stat-cell glass">
              <div className="stat-num">{stats.pending}</div>
              <div className="stat-label">待办</div>
            </div>
            <div className="stat-cell glass">
              <div
                className="stat-num"
                style={{ color: stats.overdue > 0 ? "var(--danger)" : undefined }}
              >
                {stats.overdue}
              </div>
              <div className="stat-label">已逾期</div>
            </div>
            <div className="stat-cell glass">
              <div className="stat-num">{stats.completed}</div>
              <div className="stat-label">已完成</div>
            </div>
          </div>
        ) : null}

        <div className="searchbar glass" style={{ padding: 4, gap: 4 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              style={{
                flex: 1,
                border: 0,
                borderRadius: 10,
                padding: "7px 0",
                fontSize: 13,
                fontWeight: filter === f.id ? 650 : 500,
                background: filter === f.id ? "rgba(10,132,255,0.18)" : "transparent",
                color: filter === f.id ? "var(--accent-ink)" : "var(--text-2)",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error ? <div className="notice">{error}</div> : null}
        {!visible && !error ? <div className="loading">加载中…</div> : null}

        {visible && visible.length === 0 ? (
          <div className="empty">
            {filter === "done" ? "还没有已完成的任务" : "没有待办，清爽 ✨"}
          </div>
        ) : null}

        {visible && visible.length > 0 ? (
          <div className="card glass">
            <ul className="list">
              {visible.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="task-row"
                    data-status={task.status}
                    onClick={() => void toggle(task)}
                    aria-pressed={task.status === "done"}
                  >
                    <span className="task-check" aria-hidden="true">
                      ✓
                    </span>
                    <span className="li-main">
                      <span className="li-title">{task.title || "（无标题）"}</span>
                      <span className="task-meta">
                        {task.priority && task.priority !== "low" ? (
                          <span className={`chip chip-${task.priority}`}>
                            {PRIORITY_LABEL[task.priority]}优先
                          </span>
                        ) : null}
                        {task.status === "doing" ? (
                          <span className="chip chip-done">进行中</span>
                        ) : null}
                        {task.dueDate ? (
                          <span className={isOverdue(task) ? "chip chip-overdue" : "chip"}>
                            {isOverdue(task) ? "已逾期 " : "截止 "}
                            {formatDue(task.dueDate)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Fab label="新建待办" icon="＋" onClick={() => setCreating(true)} />

      <PromptDialog
        open={creating}
        title="新建待办"
        placeholder="要做什么？"
        confirmLabel="创建"
        busy={busyCreate}
        onConfirm={(v) => void createTask(v)}
        onDismiss={() => setCreating(false)}
      />
    </>
  );
}
