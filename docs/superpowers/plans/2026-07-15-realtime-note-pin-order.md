# 树形与目录列表置顶实时重排实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让编辑器工具栏、树形列表和目录列表的置顶操作在服务端成功后立即同步，并在所有排序模式下形成顶部置顶区域。

**架构：** 新增共享的置顶优先排序函数，由目录列表和树形列表共同调用。树形列表继续保留局部缓存，但通过纯函数从全局列表同步 `isPinned`；目录列表置顶当前笔记时显式同步 `activeNote`。

**技术栈：** React 18、TypeScript、Vitest

---

## 文件结构

- 创建：`frontend/src/lib/notePinnedOrder.ts`，提供共享的置顶优先稳定排序。
- 创建：`frontend/src/lib/__tests__/notePinnedOrder.test.ts`，验证置顶分组和区域内顺序。
- 修改：`frontend/src/lib/notebookNoteCache.ts`，让树形列表手动排序置顶优先，并提供置顶状态缓存同步。
- 修改：`frontend/src/lib/__tests__/notebookNoteCache.test.ts`，验证手动排序、取消置顶归位及缓存引用稳定。
- 修改：`frontend/src/components/NoteList.tsx`，所有目录列表模式使用共享排序，并同步当前笔记状态。
- 修改：`frontend/src/components/Sidebar.tsx`，接收全局列表中的置顶变化。
- 创建：`frontend/src/components/__tests__/NotePinRealtimeSync.test.ts`，守护两个组件的同步接线。

### 任务 1：统一目录列表与树形列表的置顶排序

**文件：**

- 创建：`frontend/src/lib/notePinnedOrder.ts`
- 创建：`frontend/src/lib/__tests__/notePinnedOrder.test.ts`
- 修改：`frontend/src/lib/notebookNoteCache.ts:8-27`
- 修改：`frontend/src/lib/__tests__/notebookNoteCache.test.ts`
- 修改：`frontend/src/components/NoteList.tsx:1593-1618`

- [x] **步骤 1：编写共享排序函数的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { sortNotesPinnedFirst } from "@/lib/notePinnedOrder";

type Item = { id: string; isPinned: number; sortOrder: number };

const item = (id: string, isPinned: number, sortOrder: number): Item => ({
  id,
  isPinned,
  sortOrder,
});

describe("sortNotesPinnedFirst", () => {
  it("stable-groups pinned notes without changing relevance order inside groups", () => {
    const notes = [item("normal-a", 0, 3), item("pinned-a", 1, 8), item("pinned-b", 1, 2), item("normal-b", 0, 1)];

    expect(sortNotesPinnedFirst(notes).map((note) => note.id)).toEqual([
      "pinned-a",
      "pinned-b",
      "normal-a",
      "normal-b",
    ]);
  });

  it("uses the supplied comparator inside pinned and normal groups", () => {
    const notes = [item("normal-a", 0, 3), item("pinned-a", 1, 8), item("pinned-b", 1, 2), item("normal-b", 0, 1)];

    expect(sortNotesPinnedFirst(notes, (a, b) => a.sortOrder - b.sortOrder).map((note) => note.id)).toEqual([
      "pinned-b",
      "pinned-a",
      "normal-b",
      "normal-a",
    ]);
  });
});
```

- [x] **步骤 2：运行测试并验证模块缺失**

运行：`npm run test:run -- src/lib/__tests__/notePinnedOrder.test.ts`

预期：FAIL，报告无法解析 `@/lib/notePinnedOrder`。

- [x] **步骤 3：实现最小共享排序函数**

```ts
type PinnableNote = { isPinned?: number | null };

export function comparePinnedFirst(a: PinnableNote, b: PinnableNote): number {
  return Number(b.isPinned || 0) - Number(a.isPinned || 0);
}

export function sortNotesPinnedFirst<T extends PinnableNote>(
  notes: readonly T[],
  compareWithinGroup: (a: T, b: T) => number = () => 0,
): T[] {
  return [...notes].sort((a, b) => comparePinnedFirst(a, b) || compareWithinGroup(a, b));
}
```

- [x] **步骤 4：编写树形列表手动排序的失败测试**

在 `notebookNoteCache.test.ts` 增加：

```ts
it("keeps pinned notes first in manual mode and restores sortOrder after unpinning", () => {
  const notes = [
    { ...note("n1", "target"), sortOrder: 0 },
    { ...note("n2", "target"), sortOrder: 1, isPinned: 1 },
    { ...note("n3", "target"), sortOrder: 2 },
  ];

  expect(sortNotebookNotes(notes, { by: "manual", dir: "desc" }).map((n) => n.id)).toEqual(["n2", "n1", "n3"]);
  expect(sortNotebookNotes(notes.map((n) => n.id === "n2" ? { ...n, isPinned: 0 } : n), { by: "manual", dir: "desc" }).map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
});
```

- [x] **步骤 5：运行树形排序测试并验证失败**

运行：`npm run test:run -- src/lib/__tests__/notebookNoteCache.test.ts`

预期：FAIL，手动模式仍返回 `["n1", "n2", "n3"]`，未把 `n2` 移入顶部置顶区域。

- [x] **步骤 6：让树形列表手动排序也置顶优先**

在 `sortNotebookNotes` 中移除手动模式直接返回，统一调用共享函数：

```ts
export function sortNotebookNotes(notes: NoteListItem[], pref: NotebookSortPref): NoteListItem[] {
  const dir = pref.dir === "asc" ? 1 : -1;
  return sortNotesPinnedFirst(notes, (a, b) => {
    if (pref.by === "manual") {
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    }
    if (pref.by === "name") {
      const cmp = (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      return cmp * dir || a.id.localeCompare(b.id);
    }
    const field = pref.by as "updatedAt" | "createdAt";
    const av = a[field] || "";
    const bv = b[field] || "";
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return cmp * dir || a.id.localeCompare(b.id);
  });
}
```

- [x] **步骤 7：让目录列表所有模式使用共享排序**

将 `sortedNotes` 改为：

```ts
const sortedNotes = useMemo(() => {
  if (state.viewMode === "search") {
    return sortNotesPinnedFirst(state.notes);
  }
  if (sortPref.by === "manual") {
    return sortNotesPinnedFirst(
      state.notes,
      (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0),
    );
  }
  const dir = sortPref.dir === "asc" ? 1 : -1;
  return sortNotesPinnedFirst(state.notes, (a, b) => {
    if (sortPref.by === "title") {
      const cmp = (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      return cmp * dir || a.id.localeCompare(b.id);
    }
    const field = sortPref.by as "updatedAt" | "createdAt";
    const av = a[field] || "";
    const bv = b[field] || "";
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return cmp * dir || a.id.localeCompare(b.id);
  });
}, [state.notes, sortPref.by, sortPref.dir, state.viewMode]);
```

- [x] **步骤 8：运行排序相关测试**

运行：`npm run test:run -- src/lib/__tests__/notePinnedOrder.test.ts src/lib/__tests__/notebookNoteCache.test.ts src/lib/__tests__/notebookSortInheritance.test.ts`

预期：3 个测试文件全部通过。

- [x] **步骤 9：提交任务 1**

```powershell
git add frontend/src/lib/notePinnedOrder.ts frontend/src/lib/__tests__/notePinnedOrder.test.ts frontend/src/lib/notebookNoteCache.ts frontend/src/lib/__tests__/notebookNoteCache.test.ts frontend/src/components/NoteList.tsx
git commit -m "fix(notes): 统一置顶笔记实时排序（任务 1）"
```

### 任务 2：同步树形缓存与顶部工具栏状态

**文件：**

- 修改：`frontend/src/lib/notebookNoteCache.ts`
- 修改：`frontend/src/lib/__tests__/notebookNoteCache.test.ts`
- 修改：`frontend/src/components/Sidebar.tsx:43-50,1260-1270`
- 修改：`frontend/src/components/NoteList.tsx:2368-2378`
- 创建：`frontend/src/components/__tests__/NotePinRealtimeSync.test.ts`

- [x] **步骤 1：编写树形缓存同步的失败测试**

向 `notebookNoteCache.test.ts` 增加：

```ts
it("syncs pinned state into cached tree notes and preserves references when unchanged", () => {
  const cached = note("n1", "target");
  const cache = new Map([["target", [cached]]]);

  const updated = syncPinnedStateToNotebookCache(cache, [{ ...cached, isPinned: 1 }]);
  expect(updated).not.toBe(cache);
  expect(updated.get("target")?.[0].isPinned).toBe(1);

  const unchanged = syncPinnedStateToNotebookCache(updated, [{ ...cached, isPinned: 1 }]);
  expect(unchanged).toBe(updated);
});
```

- [x] **步骤 2：运行测试并验证导出缺失**

运行：`npm run test:run -- src/lib/__tests__/notebookNoteCache.test.ts`

预期：FAIL，报告 `syncPinnedStateToNotebookCache` 未导出。

- [x] **步骤 3：实现最小树形缓存同步函数**

```ts
export function syncPinnedStateToNotebookCache(
  cache: Map<string, NoteListItem[]>,
  sourceNotes: readonly NoteListItem[],
): Map<string, NoteListItem[]> {
  const pinnedById = new Map(sourceNotes.map((note) => [note.id, note.isPinned || 0]));
  let changed = false;
  const next = new Map(cache);

  cache.forEach((notes, notebookId) => {
    let notesChanged = false;
    const synced = notes.map((note) => {
      const pinned = pinnedById.get(note.id);
      if (pinned === undefined || pinned === (note.isPinned || 0)) return note;
      notesChanged = true;
      return { ...note, isPinned: pinned };
    });
    if (!notesChanged) return;
    changed = true;
    next.set(notebookId, synced);
  });

  return changed ? next : cache;
}
```

- [x] **步骤 4：编写组件同步接线的失败测试**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(path.resolve(__dirname, "../Sidebar.tsx"), "utf8");
const noteListSource = readFileSync(path.resolve(__dirname, "../NoteList.tsx"), "utf8");

describe("realtime note pin synchronization", () => {
  it("reconciles global pin state into the sidebar tree cache", () => {
    expect(sidebarSource).toContain("syncPinnedStateToNotebookCache(prev, state.notes)");
  });

  it("updates the active note when pinning it from the directory list", () => {
    expect(noteListSource).toContain('actions.setActiveNote({ ...state.activeNote, isPinned: newVal });');
  });
});
```

- [x] **步骤 5：运行组件同步测试并验证失败**

运行：`npm run test:run -- src/components/__tests__/NotePinRealtimeSync.test.ts`

预期：2 个测试失败，分别报告树形缓存协调调用和当前笔记更新缺失。

- [x] **步骤 6：接入树形缓存协调与当前笔记同步**

在 `Sidebar.tsx` 增加：

```ts
useEffect(() => {
  if (!showNotesInNotebookTree) return;
  setNotesByNotebookId((prev) => syncPinnedStateToNotebookCache(prev, state.notes));
}, [showNotesInNotebookTree, state.notes]);
```

在 `NoteList.tsx` 的 `toggle_pin` 分支增加：

```ts
if (state.activeNote?.id === targetId) {
  actions.setActiveNote({ ...state.activeNote, isPinned: newVal });
}
```

- [x] **步骤 7：运行全部本次相关测试**

运行：`npm run test:run -- src/lib/__tests__/notePinnedOrder.test.ts src/lib/__tests__/notebookNoteCache.test.ts src/lib/__tests__/notebookSortInheritance.test.ts src/components/__tests__/NotePinRealtimeSync.test.ts`

预期：4 个测试文件全部通过。

- [x] **步骤 8：运行前端构建**

运行：`npm run build`

预期：TypeScript 检查和 Vite 构建退出码为 0。

- [x] **步骤 9：提交任务 2**

```powershell
git add frontend/src/lib/notebookNoteCache.ts frontend/src/lib/__tests__/notebookNoteCache.test.ts frontend/src/components/Sidebar.tsx frontend/src/components/NoteList.tsx frontend/src/components/__tests__/NotePinRealtimeSync.test.ts
git commit -m "fix(notes): 同步置顶状态到所有视图（任务 2）"
```

### 审查补充：保持手动拖拽与置顶分组一致

- [x] 列表 API 返回持久化的 `sortOrder`，并新增真实路由回归测试。
- [x] 目录列表和树形列表均从当前显示顺序计算拖拽结果。
- [x] 拖拽仅在同一置顶分组内生效，只持久化当前分组并同步本地 `sortOrder`。
- [x] 树形列表仅在手动排序时允许同目录重排，保留跨目录移动能力。
- [x] 重新运行相关回归测试、前端构建和后端 TypeScript 构建。
