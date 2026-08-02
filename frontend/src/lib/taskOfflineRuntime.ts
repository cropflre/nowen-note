import type {
  Habit,
  HabitCheckin,
  HabitCheckinListItem,
  HabitCheckinStatus,
  HabitStats,
  Task,
  TaskFilter,
  TaskStats,
} from "@/types";

type TaskResult = { task: Task; generatedTask: Task | null };
type OpBase = { id: string; entityId: string; queuedAt: number; retryCount: number; blocked?: boolean; lastError?: string };
type Op =
  | (OpBase & { kind: "task.create"; data: Partial<Task> })
  | (OpBase & { kind: "task.update"; data: Partial<Task> })
  | (OpBase & { kind: "task.delete" })
  | (OpBase & { kind: "habit.create"; data: { title: string; icon?: string; color?: string; sortOrder?: number } })
  | (OpBase & { kind: "habit.update"; data: Partial<Habit> })
  | (OpBase & { kind: "habit.archive"; archived: boolean })
  | (OpBase & { kind: "habit.delete" })
  | (OpBase & { kind: "habit.checkin"; data: { status: HabitCheckinStatus; note?: string; checkinDate?: string } });

type State = {
  version: 2;
  tasks: Task[];
  taskStats: TaskStats | null;
  habits: Habit[];
  habitStats: HabitStats | null;
  checkins: HabitCheckinListItem[];
  queue: Op[];
  idMap: Record<string, string>;
  updatedAt: number;
};

type Options = { getServerUrl: () => string; getWorkspaceId: () => string; getScopeKey?: () => string };
type NativeApi = {
  getTasks: (filter?: TaskFilter, noteId?: string, projectId?: string) => Promise<Task[]>;
  getTaskStats: () => Promise<TaskStats>;
  createTask: (data: Partial<Task>) => Promise<Task>;
  updateTask: (id: string, data: Partial<Task>) => Promise<TaskResult>;
  toggleTask: (id: string) => Promise<TaskResult>;
  deleteTask: (id: string) => Promise<unknown>;
  getHabits: (includeArchived?: boolean, checkinDate?: string) => Promise<Habit[]>;
  getHabitStats: (includeArchived?: boolean, checkinDate?: string) => Promise<HabitStats>;
  getHabitCheckinLog: (params?: { from?: string; to?: string; includeArchived?: boolean }) => Promise<HabitCheckinListItem[]>;
  createHabit: (data: { title: string; icon?: string; color?: string; sortOrder?: number }) => Promise<Habit>;
  updateHabit: (id: string, data: Partial<Habit>) => Promise<Habit>;
  archiveHabit: (id: string, archived?: boolean) => Promise<Habit>;
  deleteHabit: (id: string) => Promise<{ success: boolean }>;
  checkInHabit: (id: string, data: { status: HabitCheckinStatus; note?: string; checkinDate?: string }) => Promise<HabitCheckin>;
};

const PREFIX = "nowen-task-offline:v2";
const LEGACY_PREFIX = "nowen-task-offline:v1";
const EVENT = "nowen:task-offline-state-changed";
const FLAG = Symbol.for("nowen.taskOfflineApi.v2.installed");
const MAX_RETRY = 10;

const blank = (): State => ({
  version: 2, tasks: [], taskStats: null, habits: [], habitStats: null,
  checkins: [], queue: [], idMap: {}, updatedAt: 0,
});

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function userId(): string {
  const token = storage()?.getItem("nowen-token");
  if (!token) return "anonymous";
  try {
    const raw = token.split(".")[1];
    if (!raw) return "anonymous";
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { userId?: string; sub?: string };
    return payload.userId || payload.sub || "anonymous";
  } catch { return "anonymous"; }
}

const scopePart = (value: string) => encodeURIComponent((value || "default").replace(/\/+$/, "").toLowerCase());
const localId = (id: string) => id.startsWith("local-task:") || id.startsWith("local-habit:");
const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
const statusOf = (error: unknown) => (error as { status?: number })?.status;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error || "同步失败");

function retryable(error: unknown): boolean {
  const value = error as { name?: string; message?: string; status?: number };
  if (!online()) return true;
  if ([408, 425, 429].includes(value?.status || 0) || (value?.status || 0) >= 500) return true;
  return ["AbortError", "NetworkError", "TypeError"].includes(value?.name || "")
    || /failed to fetch|network\s*error|load failed|timeout|aborted/i.test(value?.message || "");
}

function newId(prefix: string): string {
  const randomUUID = typeof crypto !== "undefined" ? crypto.randomUUID : undefined;
  return typeof randomUUID === "function"
    ? `${prefix}:${randomUUID.call(crypto)}`
    : `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : localDate(parsed);
}

const today = () => localDate(new Date());
function plusDays(key: string, days: number): string {
  const value = new Date(`${key}T00:00:00`);
  value.setDate(value.getDate() + days);
  return localDate(value);
}
const completed = (task: Task) => Boolean(task.isCompleted) || task.status === "done";
const due = (task: Task) => dateKey(task.dueAt || task.dueDate);

export function filterOfflineTasks(tasks: Task[], filter: TaskFilter = "all", noteId?: string, projectId?: string): Task[] {
  const start = today();
  const end = plusDays(start, 6);
  return tasks.filter((task) => {
    if (noteId && task.noteId !== noteId) return false;
    if (projectId && task.projectId !== projectId) return false;
    const key = due(task);
    if (filter === "completed") return completed(task);
    if (filter === "today") return !completed(task) && key === start;
    if (filter === "week") return !completed(task) && !!key && key >= start && key <= end;
    if (filter === "overdue") return !completed(task) && !!key && key < start;
    return true;
  });
}

export function deriveOfflineTaskStats(tasks: Task[]): TaskStats {
  const start = today();
  const end = plusDays(start, 6);
  let done = 0, todayCount = 0, overdue = 0, week = 0;
  for (const task of tasks) {
    const isDone = completed(task);
    const key = due(task);
    if (isDone) done += 1;
    if (!isDone && key === start) todayCount += 1;
    if (!isDone && key && key < start) overdue += 1;
    if (!isDone && key && key >= start && key <= end) week += 1;
  }
  return { total: tasks.length, completed: done, pending: tasks.length - done, today: todayCount, overdue, week };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((value) => value.id === item.id);
  if (index < 0) return [item, ...items];
  const next = [...items];
  next[index] = { ...next[index], ...item };
  return next;
}

function merge<T extends { id: string }>(left: T[], right: T[]): T[] {
  let result = [...left];
  for (const item of right) result = upsert(result, item);
  return result;
}

function resolve(state: State, id: string): string {
  let value = id;
  const seen = new Set<string>();
  while (state.idMap[value] && !seen.has(value)) {
    seen.add(value);
    value = state.idMap[value];
  }
  return value;
}

function descendants(tasks: Task[], rootId: string): Set<string> {
  const result = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    tasks.filter((task) => task.parentId === id).forEach((task) => pending.push(task.id));
  }
  return result;
}

function workspace(options: Options): string | null {
  const id = options.getWorkspaceId();
  return id && id !== "personal" ? id : null;
}

function optimisticTask(id: string, data: Partial<Task>, options: Options, time = Date.now()): Task {
  const iso = new Date(time).toISOString();
  const done = Boolean(data.isCompleted) || data.status === "done";
  return {
    id, userId: userId(), workspaceId: workspace(options), title: data.title || "",
    description: data.description || "", priority: data.priority ?? 2,
    dueDate: data.dueDate ?? null, dueAt: data.dueAt ?? null, startDate: data.startDate ?? null,
    noteId: data.noteId ?? null, parentId: data.parentId ?? null,
    isCompleted: done ? 1 : 0, completedAt: data.completedAt ?? (done ? iso : null),
    sortOrder: data.sortOrder ?? 0, projectId: data.projectId ?? null,
    status: data.status ?? (done ? "done" : "todo"), createdAt: data.createdAt || iso,
    updatedAt: iso, ...data,
  } as Task;
}

function optimisticHabit(id: string, data: { title: string; icon?: string; color?: string; sortOrder?: number }, options: Options, time = Date.now()): Habit {
  const iso = new Date(time).toISOString();
  return {
    id, userId: userId(), workspaceId: workspace(options), title: data.title,
    icon: data.icon || "🎯", color: data.color || "#6366f1", sortOrder: data.sortOrder ?? 0,
    archivedAt: null, createdAt: iso, updatedAt: iso,
  };
}

function optimisticCheckin(habit: Habit, data: { status: HabitCheckinStatus; note?: string; checkinDate?: string }): HabitCheckinListItem {
  const iso = new Date().toISOString();
  return {
    id: newId("local-checkin"), habitId: habit.id, userId: userId(), workspaceId: habit.workspaceId,
    checkinDate: data.checkinDate || today(), status: data.status, note: data.note || "",
    createdAt: iso, updatedAt: iso, habitTitle: habit.title, habitColor: habit.color,
    habitIcon: habit.icon, habitArchivedAt: habit.archivedAt,
  };
}

function applyCheckin(state: State, habitId: string, checkin: HabitCheckin): State {
  const habit = state.habits.find((value) => value.id === habitId);
  const item: HabitCheckinListItem = {
    ...checkin, habitTitle: habit?.title || "", habitColor: habit?.color || "#6366f1",
    habitIcon: habit?.icon || "🎯", habitArchivedAt: habit?.archivedAt || null,
  };
  return {
    ...state,
    habits: habit ? upsert(state.habits, {
      ...habit, todayStatus: checkin.status, todayNote: checkin.note,
      todayCheckinDate: checkin.checkinDate, updatedAt: checkin.updatedAt,
    }) : state.habits,
    checkins: [item, ...state.checkins.filter((value) => !(value.habitId === habitId && value.checkinDate === checkin.checkinDate))],
  };
}

function overlayTasks(server: Task[], cached: Task[], queue: Op[], options: Options): Task[] {
  let tasks = [...server];
  for (const operation of queue) {
    if (operation.kind === "task.create") {
      tasks = upsert(tasks, cached.find((task) => task.id === operation.entityId)
        || optimisticTask(operation.entityId, operation.data, options, operation.queuedAt));
    } else if (operation.kind === "task.update") {
      const current = tasks.find((task) => task.id === operation.entityId)
        || cached.find((task) => task.id === operation.entityId);
      if (current) tasks = upsert(tasks, { ...current, ...operation.data } as Task);
    } else if (operation.kind === "task.delete") {
      const ids = descendants(tasks, operation.entityId);
      tasks = tasks.filter((task) => !ids.has(task.id));
    }
  }
  return tasks;
}

function overlayHabits(server: Habit[], cached: Habit[], queue: Op[], options: Options): Habit[] {
  let habits = [...server];
  for (const operation of queue) {
    const current = habits.find((habit) => habit.id === operation.entityId)
      || cached.find((habit) => habit.id === operation.entityId);
    if (operation.kind === "habit.create") {
      habits = upsert(habits, current || optimisticHabit(operation.entityId, operation.data, options, operation.queuedAt));
    } else if (operation.kind === "habit.update" && current) {
      habits = upsert(habits, { ...current, ...operation.data });
    } else if (operation.kind === "habit.archive" && current) {
      habits = upsert(habits, { ...current, archivedAt: operation.archived ? new Date(operation.queuedAt).toISOString() : null });
    } else if (operation.kind === "habit.delete") {
      habits = habits.filter((habit) => habit.id !== operation.entityId);
    } else if (operation.kind === "habit.checkin" && current) {
      habits = upsert(habits, {
        ...current, todayStatus: operation.data.status, todayNote: operation.data.note || "",
        todayCheckinDate: operation.data.checkinDate || today(),
      });
    }
  }
  return habits;
}

function compact(queue: Op[], operation: Op): Op[] {
  if (operation.kind === "task.update") {
    const create = queue.findIndex((item) => item.kind === "task.create" && item.entityId === operation.entityId && !item.blocked);
    if (create >= 0) {
      const next = [...queue];
      const item = next[create] as Extract<Op, { kind: "task.create" }>;
      next[create] = { ...item, data: { ...item.data, ...operation.data } };
      return next;
    }
    const update = queue.findIndex((item) => item.kind === "task.update" && item.entityId === operation.entityId && !item.blocked);
    if (update >= 0) {
      const next = [...queue];
      const item = next[update] as Extract<Op, { kind: "task.update" }>;
      next[update] = { ...item, data: { ...item.data, ...operation.data }, queuedAt: operation.queuedAt };
      return next;
    }
  }
  if (operation.kind === "habit.update") {
    const create = queue.findIndex((item) => item.kind === "habit.create" && item.entityId === operation.entityId && !item.blocked);
    if (create >= 0) {
      const next = [...queue];
      const item = next[create] as Extract<Op, { kind: "habit.create" }>;
      next[create] = { ...item, data: { ...item.data, ...operation.data } };
      return next;
    }
    const update = queue.findIndex((item) => item.kind === "habit.update" && item.entityId === operation.entityId && !item.blocked);
    if (update >= 0) {
      const next = [...queue];
      const item = next[update] as Extract<Op, { kind: "habit.update" }>;
      next[update] = { ...item, data: { ...item.data, ...operation.data }, queuedAt: operation.queuedAt };
      return next;
    }
  }
  if (operation.kind === "habit.archive") {
    return [...queue.filter((item) => !(item.kind === "habit.archive" && item.entityId === operation.entityId && !item.blocked)), operation];
  }
  if (operation.kind === "habit.checkin") {
    const key = operation.data.checkinDate || today();
    return [...queue.filter((item) => !(item.kind === "habit.checkin" && item.entityId === operation.entityId
      && (item.data.checkinDate || today()) === key && !item.blocked)), operation];
  }
  return [...queue, operation];
}

export function installTaskOfflineApi(api: any, options: Options) {
  if (api[FLAG]) return api[FLAG] as { flush: () => Promise<void>; pending: () => number };
  const native: NativeApi = {
    getTasks: api.getTasks.bind(api), getTaskStats: api.getTaskStats.bind(api),
    createTask: api.createTask.bind(api), updateTask: api.updateTask.bind(api),
    toggleTask: api.toggleTask.bind(api), deleteTask: api.deleteTask.bind(api),
    getHabits: api.getHabits.bind(api), getHabitStats: api.getHabitStats.bind(api),
    getHabitCheckinLog: api.getHabitCheckinLog.bind(api), createHabit: api.createHabit.bind(api),
    updateHabit: api.updateHabit.bind(api), archiveHabit: api.archiveHabit.bind(api),
    deleteHabit: api.deleteHabit.bind(api), checkInHabit: api.checkInHabit.bind(api),
  };

  const suffix = () => options.getScopeKey?.() || [
    scopePart(options.getServerUrl() || "same-origin"), scopePart(userId()),
    scopePart(options.getWorkspaceId() || "personal"),
  ].join(":");
  const key = () => `${PREFIX}:${suffix()}`;
  const legacyKey = () => `${LEGACY_PREFIX}:${suffix()}`;

  const read = (): State => {
    const store = storage();
    if (!store) return blank();
    try {
      const raw = store.getItem(key()) || store.getItem(legacyKey());
      if (!raw) return blank();
      const value = JSON.parse(raw) as Partial<State>;
      return {
        ...blank(), ...value, version: 2,
        tasks: Array.isArray(value.tasks) ? value.tasks : [], habits: Array.isArray(value.habits) ? value.habits : [],
        checkins: Array.isArray(value.checkins) ? value.checkins : [], queue: Array.isArray(value.queue) ? value.queue : [],
        idMap: value.idMap && typeof value.idMap === "object" ? value.idMap : {},
      };
    } catch { return blank(); }
  };

  const write = (state: State, strict = false): State => {
    const next = { ...state, version: 2 as const, updatedAt: Date.now() };
    const store = storage();
    if (!store) {
      if (strict) throw new Error("当前环境无法保存离线任务，请恢复网络后重试");
      return next;
    }
    try {
      store.setItem(key(), JSON.stringify(next));
      store.removeItem(legacyKey());
    } catch (error) {
      if (strict) throw new Error("离线存储空间不足，任务未保存，请清理空间后重试");
      console.warn("[task-offline] cache write failed", error);
      return next;
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(EVENT, { detail: {
        pending: next.queue.length, blocked: next.queue.filter((item) => item.blocked).length,
        updatedAt: next.updatedAt,
      } }));
    }
    return next;
  };

  const enqueue = (state: State, operation: Op) => write({ ...state, queue: compact(state.queue, operation) }, true);
  const pending = () => read().queue.length;
  let flushing: Promise<void> | null = null;

  const remapTask = (state: State, local: string, task: Task): State => ({
    ...state, idMap: { ...state.idMap, [local]: task.id },
    tasks: upsert(state.tasks.filter((value) => value.id !== local)
      .map((value) => value.parentId === local ? { ...value, parentId: task.id } : value), task),
    queue: state.queue.map((item) => {
      const entityId = item.entityId === local ? task.id : item.entityId;
      if ((item.kind === "task.create" || item.kind === "task.update") && item.data.parentId === local) {
        return { ...item, entityId, data: { ...item.data, parentId: task.id } };
      }
      return { ...item, entityId };
    }) as Op[],
  });

  const remapHabit = (state: State, local: string, habit: Habit): State => ({
    ...state, idMap: { ...state.idMap, [local]: habit.id },
    habits: upsert(state.habits.filter((value) => value.id !== local), habit),
    checkins: state.checkins.map((value) => value.habitId === local ? { ...value, habitId: habit.id } : value),
    queue: state.queue.map((item) => item.entityId === local ? { ...item, entityId: habit.id } : item) as Op[],
  });

  const run = async (operation: Op, state: State): Promise<State> => {
    const id = resolve(state, operation.entityId);
    if (operation.kind === "task.create") {
      return remapTask(state, operation.entityId, await native.createTask({
        ...operation.data,
        parentId: operation.data.parentId ? resolve(state, operation.data.parentId) : operation.data.parentId,
      }));
    }
    if (operation.kind === "task.update") {
      const result = await native.updateTask(id, operation.data);
      let next = { ...state, tasks: upsert(state.tasks, result.task) };
      if (result.generatedTask) next = { ...next, tasks: upsert(next.tasks, result.generatedTask) };
      return next;
    }
    if (operation.kind === "task.delete") {
      try { await native.deleteTask(id); } catch (error) { if (statusOf(error) !== 404) throw error; }
      const ids = descendants(state.tasks, operation.entityId); ids.add(id);
      return { ...state, tasks: state.tasks.filter((task) => !ids.has(task.id)) };
    }
    if (operation.kind === "habit.create") return remapHabit(state, operation.entityId, await native.createHabit(operation.data));
    if (operation.kind === "habit.update") return { ...state, habits: upsert(state.habits, await native.updateHabit(id, operation.data)) };
    if (operation.kind === "habit.archive") return { ...state, habits: upsert(state.habits, await native.archiveHabit(id, operation.archived)) };
    if (operation.kind === "habit.delete") {
      try { await native.deleteHabit(id); } catch (error) { if (statusOf(error) !== 404) throw error; }
      return { ...state, habits: state.habits.filter((habit) => habit.id !== id && habit.id !== operation.entityId),
        checkins: state.checkins.filter((item) => item.habitId !== id && item.habitId !== operation.entityId) };
    }
    return applyCheckin(state, id, await native.checkInHabit(id, operation.data));
  };

  const flush = async (): Promise<void> => {
    if (!online()) return;
    if (flushing) return flushing;
    flushing = (async () => {
      for (let count = 0; count < 200; count += 1) {
        let state = read();
        const operation = state.queue[0];
        if (!operation || operation.blocked) break;
        try {
          state = await run(operation, state);
          write({ ...state, queue: state.queue.filter((item) => item.id !== operation.id) }, true);
        } catch (error) {
          state = read();
          const current = state.queue.find((item) => item.id === operation.id);
          if (!current) continue;
          const retryCount = current.retryCount + 1;
          write({ ...state, queue: state.queue.map((item) => item.id === operation.id ? {
            ...item, retryCount, lastError: messageOf(error), blocked: !retryable(error) || retryCount >= MAX_RETRY,
          } : item) }, true);
          break;
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  };

  api.getTasks = async (filter?: TaskFilter, noteId?: string, projectId?: string) => {
    if (online()) await flush();
    try {
      const remote = await native.getTasks("all");
      const state = read();
      const tasks = overlayTasks(remote, state.tasks, state.queue, options);
      write({ ...state, tasks });
      return filterOfflineTasks(tasks, filter, noteId, projectId);
    } catch (error) {
      const state = read();
      if (!state.updatedAt && !state.tasks.length && !state.queue.length) throw error;
      return filterOfflineTasks(overlayTasks(state.tasks, state.tasks, state.queue, options), filter, noteId, projectId);
    }
  };

  api.getTaskStats = async () => {
    if (online()) await flush();
    try {
      const remote = await native.getTaskStats();
      const state = write({ ...read(), taskStats: remote });
      return state.queue.some((item) => item.kind.startsWith("task.")) ? deriveOfflineTaskStats(state.tasks) : remote;
    } catch (error) {
      const state = read();
      if (!state.updatedAt && !state.tasks.length && !state.queue.length) throw error;
      return deriveOfflineTaskStats(state.tasks);
    }
  };

  api.createTask = async (data: Partial<Task>) => {
    if (online()) {
      try { const task = await native.createTask(data); const state = read(); write({ ...state, tasks: upsert(state.tasks, task) }); return task; }
      catch (error) { if (!retryable(error)) throw error; }
    }
    const operation: Op = { id: newId("task-op"), kind: "task.create", entityId: newId("local-task"), data, queuedAt: Date.now(), retryCount: 0 };
    const task = optimisticTask(operation.entityId, data, options, operation.queuedAt);
    enqueue({ ...read(), tasks: upsert(read().tasks, task) }, operation);
    return task;
  };

  api.updateTask = async (inputId: string, data: Partial<Task>) => {
    let state = read(); const id = resolve(state, inputId);
    if (online() && !localId(id)) {
      try {
        const result = await native.updateTask(id, data);
        state = { ...read(), tasks: upsert(read().tasks, result.task) };
        if (result.generatedTask) state = { ...state, tasks: upsert(state.tasks, result.generatedTask) };
        write(state); return result;
      } catch (error) { if (!retryable(error)) throw error; }
    }
    state = read(); const resolved = resolve(state, inputId);
    const current = state.tasks.find((task) => task.id === inputId || task.id === resolved) || optimisticTask(resolved, data, options);
    const task = { ...current, ...data, updatedAt: new Date().toISOString() } as Task;
    enqueue({ ...state, tasks: upsert(state.tasks, task) }, {
      id: newId("task-op"), kind: "task.update", entityId: task.id, data, queuedAt: Date.now(), retryCount: 0,
    });
    return { task, generatedTask: null };
  };

  api.toggleTask = async (inputId: string) => {
    let state = read(); const id = resolve(state, inputId);
    if (online() && !localId(id)) {
      try {
        const result = await native.toggleTask(id);
        state = { ...read(), tasks: upsert(read().tasks, result.task) };
        if (result.generatedTask) state = { ...state, tasks: upsert(state.tasks, result.generatedTask) };
        write(state); return result;
      } catch (error) { if (!retryable(error)) throw error; }
    }
    state = read(); const current = state.tasks.find((task) => task.id === inputId || task.id === resolve(state, inputId));
    if (!current) throw new Error("离线缓存中找不到该任务");
    const done = !completed(current);
    const data: Partial<Task> = { isCompleted: done ? 1 : 0, status: done ? "done" : "todo", completedAt: done ? new Date().toISOString() : null };
    const task = { ...current, ...data, updatedAt: new Date().toISOString() };
    enqueue({ ...state, tasks: upsert(state.tasks, task) }, {
      id: newId("task-op"), kind: "task.update", entityId: task.id, data, queuedAt: Date.now(), retryCount: 0,
    });
    return { task, generatedTask: null };
  };

  api.deleteTask = async (inputId: string) => {
    const state = read(); const id = resolve(state, inputId); const ids = descendants(state.tasks, id); ids.add(inputId);
    const pendingCreate = state.queue.some((item) => item.kind === "task.create" && item.entityId === inputId);
    const base = { ...state, tasks: state.tasks.filter((task) => !ids.has(task.id)), queue: state.queue.filter((item) => !ids.has(item.entityId)) };
    if (pendingCreate) { write(base, true); return { success: true }; }
    if (online() && !localId(id)) {
      try { const result = await native.deleteTask(id); write(base); return result; }
      catch (error) { if (!retryable(error) && statusOf(error) !== 404) throw error; }
    }
    enqueue(base, { id: newId("task-op"), kind: "task.delete", entityId: id, queuedAt: Date.now(), retryCount: 0 });
    return { success: true };
  };

  api.getHabits = async (includeArchived = false, checkinDate?: string) => {
    if (online()) await flush();
    try {
      const remote = await native.getHabits(true, checkinDate); const state = read();
      const habits = overlayHabits(remote, state.habits, state.queue, options); write({ ...state, habits });
      return habits.filter((habit) => includeArchived || !habit.archivedAt);
    } catch (error) {
      const state = read(); if (!state.updatedAt && !state.habits.length && !state.queue.length) throw error;
      return overlayHabits(state.habits, state.habits, state.queue, options).filter((habit) => includeArchived || !habit.archivedAt);
    }
  };

  api.getHabitStats = async (includeArchived = false, checkinDate?: string) => {
    if (online()) await flush();
    try { const result = await native.getHabitStats(includeArchived, checkinDate); write({ ...read(), habitStats: result }); return result; }
    catch (error) {
      const state = read();
      if (state.habitStats) return { ...state.habitStats, habitCount: state.habits.filter((habit) => includeArchived || !habit.archivedAt).length };
      if (!state.updatedAt && !state.habits.length) throw error;
      return {
        totalCheckins: state.checkins.length, checkinDays: new Set(state.checkins.map((item) => item.checkinDate)).size,
        currentStreak: 0, successCount: state.checkins.filter((item) => item.status === "success").length,
        partialCount: state.checkins.filter((item) => item.status === "partial").length,
        failureCount: state.checkins.filter((item) => item.status === "failure").length,
        habitCount: state.habits.filter((habit) => includeArchived || !habit.archivedAt).length,
      } satisfies HabitStats;
    }
  };

  api.getHabitCheckinLog = async (params?: { from?: string; to?: string; includeArchived?: boolean }) => {
    if (online()) await flush();
    const filter = (items: HabitCheckinListItem[]) => items.filter((item) =>
      (!params?.from || item.checkinDate >= params.from) && (!params?.to || item.checkinDate <= params.to)
      && (params?.includeArchived !== false || !item.habitArchivedAt));
    try { const state = read(); const checkins = merge(state.checkins, await native.getHabitCheckinLog(params)); write({ ...state, checkins }); return filter(checkins); }
    catch (error) { const state = read(); if (!state.updatedAt && !state.checkins.length && !state.queue.length) throw error; return filter(state.checkins); }
  };

  api.createHabit = async (data: { title: string; icon?: string; color?: string; sortOrder?: number }) => {
    if (online()) {
      try { const habit = await native.createHabit(data); const state = read(); write({ ...state, habits: upsert(state.habits, habit) }); return habit; }
      catch (error) { if (!retryable(error)) throw error; }
    }
    const operation: Op = { id: newId("habit-op"), kind: "habit.create", entityId: newId("local-habit"), data, queuedAt: Date.now(), retryCount: 0 };
    const habit = optimisticHabit(operation.entityId, data, options, operation.queuedAt);
    enqueue({ ...read(), habits: upsert(read().habits, habit) }, operation); return habit;
  };

  api.updateHabit = async (inputId: string, data: Partial<Habit>) => {
    let state = read(); const id = resolve(state, inputId);
    if (online() && !localId(id)) {
      try { const habit = await native.updateHabit(id, data); state = read(); write({ ...state, habits: upsert(state.habits, habit) }); return habit; }
      catch (error) { if (!retryable(error)) throw error; }
    }
    state = read(); const current = state.habits.find((habit) => habit.id === inputId || habit.id === resolve(state, inputId));
    if (!current) throw new Error("离线缓存中找不到该习惯");
    const habit = { ...current, ...data, updatedAt: new Date().toISOString() };
    enqueue({ ...state, habits: upsert(state.habits, habit) }, {
      id: newId("habit-op"), kind: "habit.update", entityId: habit.id, data, queuedAt: Date.now(), retryCount: 0,
    }); return habit;
  };

  api.archiveHabit = async (inputId: string, archived = true) => {
    let state = read(); const id = resolve(state, inputId);
    if (online() && !localId(id)) {
      try { const habit = await native.archiveHabit(id, archived); state = read(); write({ ...state, habits: upsert(state.habits, habit) }); return habit; }
      catch (error) { if (!retryable(error)) throw error; }
    }
    state = read(); const current = state.habits.find((habit) => habit.id === inputId || habit.id === resolve(state, inputId));
    if (!current) throw new Error("离线缓存中找不到该习惯");
    const habit = { ...current, archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
    enqueue({ ...state, habits: upsert(state.habits, habit) }, {
      id: newId("habit-op"), kind: "habit.archive", entityId: habit.id, archived, queuedAt: Date.now(), retryCount: 0,
    }); return habit;
  };

  api.deleteHabit = async (inputId: string) => {
    const state = read(); const id = resolve(state, inputId);
    const pendingCreate = state.queue.some((item) => item.kind === "habit.create" && item.entityId === inputId);
    const base = { ...state,
      habits: state.habits.filter((habit) => habit.id !== inputId && habit.id !== id),
      checkins: state.checkins.filter((item) => item.habitId !== inputId && item.habitId !== id),
      queue: state.queue.filter((item) => item.entityId !== inputId && item.entityId !== id),
    };
    if (pendingCreate) { write(base, true); return { success: true }; }
    if (online() && !localId(id)) {
      try { const result = await native.deleteHabit(id); write(base); return result; }
      catch (error) { if (!retryable(error) && statusOf(error) !== 404) throw error; }
    }
    enqueue(base, { id: newId("habit-op"), kind: "habit.delete", entityId: id, queuedAt: Date.now(), retryCount: 0 });
    return { success: true };
  };

  api.checkInHabit = async (inputId: string, data: { status: HabitCheckinStatus; note?: string; checkinDate?: string }) => {
    let state = read(); const id = resolve(state, inputId);
    if (online() && !localId(id)) {
      try { const checkin = await native.checkInHabit(id, data); write(applyCheckin(read(), id, checkin)); return checkin; }
      catch (error) { if (!retryable(error)) throw error; }
    }
    state = read(); const habit = state.habits.find((value) => value.id === inputId || value.id === resolve(state, inputId));
    if (!habit) throw new Error("离线缓存中找不到该习惯");
    const checkin = optimisticCheckin(habit, data);
    enqueue(applyCheckin(state, habit.id, checkin), {
      id: newId("habit-op"), kind: "habit.checkin", entityId: habit.id, data, queuedAt: Date.now(), retryCount: 0,
    }); return checkin;
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { void flush(); });
    queueMicrotask(() => { if (online()) void flush(); });
  }
  const controller = { flush, pending };
  api[FLAG] = controller;
  return controller;
}

export const TASK_OFFLINE_CHANGE_EVENT = EVENT;
