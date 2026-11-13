import type Database from "better-sqlite3";

import { isRootDocumentNotebookId } from "../services/knowledgeTreeRootDocuments.js";
import { redactEntityId, structureFailureMessage } from "./diagnostics";
import { SyncError, type SyncFailureDiagnostic } from "./errors";
import { logSyncWarn } from "./log";
import type { ApplyLocalOptions, RemoteEntityPayload } from "./applyLocal";

/**
 * 远端笔记本（目录）的依赖感知落库。
 *
 * ## 为什么不能逐条 upsert
 *
 * 本地库带着 `notebooks_parent_guard_*` 触发器：写入 `parentId` 时，父目录必须存在**且
 * `isDeleted = 0`**，否则 `RAISE(ABORT, 'NOTEBOOK_PARENT_NOT_FOUND')`。而远端数据天然包含：
 *
 *  1. 已软删除的整棵子树 —— 服务端删除目录时只把子孙一并置 `isDeleted = 1`，`parentId` 保留；
 *  2. 根文档隐藏容器 `__nowen_root_documents__:*` —— 它常年是 `isDeleted = 1`，下面却挂着
 *     未删除的活目录（服务端 apply.ts 为此已有特例）；
 *  3. 随机 UUID 顺序 —— Snapshot 按 id 排序，子目录经常先于父目录到达。
 *
 * 旧实现用"父目录行存在"代替"父目录可用"，且父目录缺失时**悄悄把 parentId 置 null**：
 * 前者撞上触发器整批失败，后者在没有任何提示的情况下把目录压平到根。
 *
 * ## 做法（与服务端自己建立/隐藏容器的顺序一致）
 *
 *  1. 按"父先子后"排序（环与悬空父目录单独处理）；
 *  2. 第一阶段只写结构：新行一律以未删除状态插入，已存在行**只有父目录真的变了才写 parentId**
 *     （`UPDATE OF parentId` 即使值不变也会重跑守卫，重放同一批数据就会失败）；
 *  3. 第二阶段再落 `isDeleted / deletedAt`，这类更新不碰守卫列，所以已删子树的父子链可以完整保留；
 *  4. 父目录本就是已删除状态而又需要挂新子目录时，临时复活、挂接、恢复原状，全程同一事务，
 *     触发器始终保持开启。
 *
 * 结构异常（悬空/跨作用域父目录、自引用、成环）不再静默处理：按固定规则回退（新行放根目录、
 * 已有行保持原父目录），并逐条记入日志，调用方也能拿到数量。
 */

export type NotebookParentState =
  | "root"
  | "live"
  | "deleted"
  | "missing"
  | "other-scope"
  | "self"
  | "cycle";

export interface NotebookStructureRepair {
  /** 已脱敏。 */
  notebookId: string | undefined;
  /** 已脱敏。 */
  parentId: string | undefined;
  reason: Extract<NotebookParentState, "missing" | "other-scope" | "self" | "cycle">;
}

export interface NotebookApplyReport {
  applied: number;
  repairs: NotebookStructureRepair[];
}

/**
 * 两种应用场景对"无法兑现的父目录"的处理不同：
 *
 *  - repair（本机副本，默认）：远端是权威，本机必须能完成落库——新行放到根、已有行保持原父目录，
 *    并逐条记录；
 *  - reject（服务端收到推送）：绝不替客户端改写结构。父目录还没到就拒绝，客户端的修改留在
 *    Outbox 里等父目录先到；悄悄挂到根会把 NAS 上的结构永久改坏。
 */
export interface NotebookApplyMode {
  unresolvedParent: "repair" | "reject";
  /** 目录 id 已被别的用户/工作区占用：reject 抛错；skip 沿用服务端一贯的"不更新不属于本作用域的行"。 */
  foreignScope: "reject" | "skip";
}

const REPLICA_MODE: NotebookApplyMode = { unresolvedParent: "repair", foreignScope: "reject" };
export const SERVER_PUSH_MODE: NotebookApplyMode = { unresolvedParent: "reject", foreignScope: "skip" };

interface NotebookRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  isDeleted: number;
  deletedAt: string | null;
}

interface NotebookScope {
  userId: string;
  workspaceId: string | null;
}

interface Resolution {
  /** string = 挂到该父目录；null = 放到根；undefined = 保持已有父目录不动。 */
  link: string | null | undefined;
  state: NotebookParentState;
}

interface LinkedRow {
  id: string;
  parentId: string;
  live: boolean;
}

// 与 applyLocal.ts 里的同名辅助保持一致；那边反向依赖本模块，这里不能 import 它们。
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bit(value: unknown): number {
  return value ? 1 : 0;
}

function wantedParent(payload: Record<string, unknown> | undefined): string | null {
  const value = payload?.parentId;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

interface Orderable {
  entityId: string;
  payload?: Record<string, unknown>;
}

/** 在一批目录内部，找出 left 里某个环上 id 最小的成员。left 中每个节点的父目录都在 left 内。 */
function smallestCycleMember(left: Orderable[], parentOf: (item: Orderable) => string | null): string {
  const parents = new Map(left.map((item) => [item.entityId, parentOf(item)] as const));
  const visited = new Set<string>();
  let cursor = left[0].entityId;
  while (!visited.has(cursor)) {
    visited.add(cursor);
    cursor = parents.get(cursor) as string;
  }
  const members = [cursor];
  for (let next = parents.get(cursor) as string; next !== cursor; next = parents.get(next) as string) {
    members.push(next);
  }
  return members.sort()[0];
}

/**
 * 父先子后排序。
 *
 * 批内互相引用的目录按依赖展开，其余保持输入顺序；成环的部分在 id 最小的成员处断开
 * （返回在 `cycleBreakers` 里），保证结果与输入顺序无关、可重放。
 * 父目录不在本批内的目录视为根，由调用方按数据库现状解析。
 */
export function orderNotebooksParentsFirst<T extends Orderable>(
  batch: readonly T[],
): { ordered: T[]; cycleBreakers: Set<string> } {
  const cycleBreakers = new Set<string>();
  const ordered: T[] = [];
  let remaining: T[] = [...batch];

  for (;;) {
    const ids = new Set(remaining.map((item) => item.entityId));
    const inBatchParent = (item: Orderable): string | null => {
      if (cycleBreakers.has(item.entityId)) return null;
      const parent = wantedParent(item.payload);
      return parent !== null && parent !== item.entityId && ids.has(parent) ? parent : null;
    };

    const children = new Map<string, T[]>();
    const queue: T[] = [];
    for (const item of remaining) {
      const parent = inBatchParent(item);
      if (parent === null) {
        queue.push(item);
      } else {
        const siblings = children.get(parent);
        if (siblings) siblings.push(item);
        else children.set(parent, [item]);
      }
    }

    const emitted = new Set<string>();
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      ordered.push(current);
      emitted.add(current.entityId);
      for (const child of children.get(current.entityId) ?? []) queue.push(child);
    }
    if (emitted.size === remaining.length) return { ordered, cycleBreakers };

    // 剩下的是环上的节点以及挂在环下面的节点，它们的父目录必然也在剩余集合里。
    const left = remaining.filter((item) => !emitted.has(item.entityId));
    cycleBreakers.add(smallestCycleMember(left, (item) => wantedParent(item.payload)));
    remaining = left;
  }
}

// ---------------------------------------------------------------------------
// 父目录解析与临时复活
// ---------------------------------------------------------------------------

function createLinker(db: Database.Database, scope: NotebookScope) {
  const selectRow = db.prepare(
    "SELECT id, userId, workspaceId, parentId, isDeleted, deletedAt FROM notebooks WHERE id = ?",
  );
  const selectParentId = db.prepare("SELECT parentId FROM notebooks WHERE id = ?");
  const reviveRow = db.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL WHERE id = ?");
  const restoreRow = db.prepare("UPDATE notebooks SET isDeleted = ?, deletedAt = ? WHERE id = ?");
  const revived = new Map<string, NotebookRow>();
  // 根文档隐藏容器：服务端 activateRootContainer 会补回它的树节点，hideRootContainer 再删掉，
  // 其下的目录因此在树上落到根。这里按同样的做法处理，副本与 NAS 的树才一致。
  const containers = new Set<string>();
  let hasTree: boolean | undefined;
  const treeTableExists = () => hasTree ??= Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_tree_nodes'").get(),
  );
  const ensureContainerTreeNode = db.prepare(`
    INSERT OR IGNORE INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
      resourceId, sortOrder, isExpanded, isDeleted, deletedAt
    ) SELECT 'notebook:' || n.id, n.userId, n.workspaceId,
             CASE WHEN n.workspaceId IS NULL THEN 'personal:' || n.userId ELSE 'workspace:' || n.workspaceId END,
             NULL, 'folder', 'notebook', n.id, -2147483648, 0, 0, NULL
        FROM notebooks n WHERE n.id = ?
  `);
  const dropContainerTreeNode = db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ?");

  const readRow = (id: string) => selectRow.get(id) as NotebookRow | undefined;
  const inScope = (row: NotebookRow) => (row.workspaceId ?? null) === scope.workspaceId
    && (scope.workspaceId !== null || row.userId === scope.userId);

  /** 把 parentId 设为 id 的父目录会不会让 id 出现在自己的祖先链上。 */
  function wouldCycle(id: string, parentId: string): boolean {
    const seen = new Set<string>();
    let cursor: string | null = parentId;
    while (cursor !== null) {
      if (cursor === id) return true;
      // 库里原本就有的环不是这次挂接造成的，别在这里死循环。
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const row = selectParentId.get(cursor) as { parentId: string | null } | undefined;
      cursor = row?.parentId ?? null;
    }
    return false;
  }

  function resolve(id: string, wanted: string | null, existing: NotebookRow | undefined): Resolution {
    // 远端的父目录无法兑现时：新行放根，已有行保持原父目录，绝不凭空改变既有结构。
    const fallback = existing ? undefined : null;
    if (wanted === null) return { link: null, state: "root" };
    if (wanted === id) return { link: fallback, state: "self" };
    const parent = readRow(wanted);
    if (!parent) return { link: fallback, state: "missing" };
    if (!inScope(parent)) return { link: fallback, state: "other-scope" };
    // 新行还没有任何子孙，挂到哪里都不可能成环；首次下载全是新行，省掉逐行沿祖先链的查询。
    if (existing && wouldCycle(id, wanted)) return { link: fallback, state: "cycle" };
    return { link: wanted, state: parent.isDeleted ? "deleted" : "live" };
  }

  /** 与服务端 activateRootContainer 同样的手法：挂接子目录前让已删除的父目录临时可用。 */
  function reviveIfDeleted(parentId: string): void {
    const row = readRow(parentId);
    if (!row || !row.isDeleted) return;
    if (!revived.has(parentId)) revived.set(parentId, row);
    reviveRow.run(parentId);
    if (isRootDocumentNotebookId(parentId)) {
      containers.add(parentId);
      // 子目录插入时镜像触发器会把树父节点指向容器：容器的树节点必须在。
      if (treeTableExists()) ensureContainerTreeNode.run(parentId);
    }
  }

  /** 把临时复活过、且本批没有给出最终状态的父目录恢复成原样。 */
  function restoreRevived(keep: ReadonlySet<string>): void {
    for (const [id, original] of revived) {
      if (!keep.has(id)) restoreRow.run(original.isDeleted, original.deletedAt, id);
    }
    revived.clear();
  }

  /** 本批写入或复活过的根文档容器，最终若是已删除状态，就按 hideRootContainer 删掉它的树节点。 */
  function noteContainer(id: string): void {
    if (isRootDocumentNotebookId(id)) containers.add(id);
  }

  function hideContainers(): void {
    for (const id of containers) {
      if (readRow(id)?.isDeleted && treeTableExists()) dropContainerTreeNode.run(`notebook:${id}`);
    }
    containers.clear();
  }

  return { readRow, inScope, resolve, reviveIfDeleted, restoreRevived, noteContainer, hideContainers };
}

/**
 * 知识树投影：已删除父目录之下的"活目录"，以及根文档容器之下的一切，都落在树的根上。
 *
 * 这与 knowledge_tree_notebooks_* 镜像触发器"父目录必须未删除才挂树父节点"的规则、
 * 服务端 hideRootContainer 删除容器树节点后的结果一致。挂接过程中父目录是临时可用的，
 * 镜像会先把树父节点指向它，这里在父目录回到已删除状态后校正。
 * 已删除子树内部的树链接保持原样，恢复整棵子树时仍然需要它。
 */
function projectTreeParents(db: Database.Database, linked: readonly LinkedRow[], linker: ReturnType<typeof createLinker>): void {
  if (linked.length === 0) return;
  const hasTree = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_tree_nodes'").get();
  if (!hasTree) return;
  const project = db.prepare(`
    UPDATE knowledge_tree_nodes SET parentId = NULL
    WHERE resourceType = 'notebook' AND resourceId = ? AND parentId IS NOT NULL
  `);
  for (const row of linked) {
    const parent = linker.readRow(row.parentId);
    if (parent?.isDeleted && (row.live || isRootDocumentNotebookId(row.parentId))) project.run(row.id);
  }
}

/**
 * 把笔记写进一个已删除的目录（已删子树里的笔记）时，让目录临时可用。
 *
 * 知识树镜像触发器在笔记**插入**时只有"所属目录未删除"才把树父节点指向它，否则落到根；
 * 服务端上这些笔记是在目录还存在时创建、之后目录才被整棵删除的，树父节点仍指向目录。
 * 副本直接写入最终状态会得到不同的树，知识树基线随后会把每篇这样的笔记报成结构冲突并锁住树协议，
 * 恢复整棵子树时也找不到它们。临时可用同一事务内完成并恢复原状。
 *
 * 根文档容器不适用：它在 NAS 上没有树节点，其下的笔记在树上本来就在根。
 */
export function withNotebookLive<T>(
  db: Database.Database,
  scope: { userId: string; workspaceId: string | null },
  notebookId: string,
  write: () => T,
): T {
  if (!notebookId || isRootDocumentNotebookId(notebookId)) return write();
  const row = db.prepare(
    "SELECT id, userId, workspaceId, parentId, isDeleted, deletedAt FROM notebooks WHERE id = ?",
  ).get(notebookId) as NotebookRow | undefined;
  const inScope = row && (row.workspaceId ?? null) === scope.workspaceId
    && (scope.workspaceId !== null || row.userId === scope.userId);
  if (!row || !inScope || !row.isDeleted) return write();
  db.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL WHERE id = ?").run(notebookId);
  try {
    return write();
  } finally {
    db.prepare("UPDATE notebooks SET isDeleted = ?, deletedAt = ? WHERE id = ?").run(row.isDeleted, row.deletedAt, notebookId);
  }
}

/** 服务端收到推送时，父目录无法兑现要拒绝；错误会作为该条 mutation 的失败结果回给客户端。 */
function rejectUnresolvedParent(state: NotebookParentState, failure: SyncFailureDiagnostic): SyncError {
  const diagnostic = { ...failure };
  if (state === "missing") {
    return new SyncError("MISSING_DEPENDENCY", "父目录尚未同步到服务器，本机修改已保留，稍后重试", {
      ...diagnostic, reason: "NOTEBOOK_PARENT_NOT_FOUND",
    });
  }
  const reason = state === "self" ? "NOTEBOOK_PARENT_SELF"
    : state === "cycle" ? "NOTEBOOK_PARENT_CYCLE" : "NOTEBOOK_PARENT_SCOPE_MISMATCH";
  return new SyncError("DATA_STRUCTURE", structureFailureMessage(reason), { ...diagnostic, reason });
}

function logRepairs(repairs: readonly NotebookStructureRepair[]): void {
  if (repairs.length === 0) return;
  for (const repair of repairs.slice(0, 20)) {
    logSyncWarn("apply.notebook-structure-repaired", {
      entityType: "notebook",
      entityId: repair.notebookId,
      parentId: repair.parentId,
      parentState: repair.reason,
    });
  }
  logSyncWarn("apply.notebook-structure-repaired", { entityType: "notebook", applyCount: repairs.length, state: "summary" });
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 应用一批远端 notebook upsert。必须在调用方的事务内执行（失败时整批回滚）。
 *
 * `failure` 由调用方持有并在出错时用来生成诊断；这里随处理进度更新它的当前步骤与实体。
 */
export function applyNotebookUpserts(
  db: Database.Database,
  items: readonly RemoteEntityPayload[],
  options: ApplyLocalOptions,
  failure: SyncFailureDiagnostic,
  mode: NotebookApplyMode = REPLICA_MODE,
): NotebookApplyReport {
  const scope: NotebookScope = { userId: options.userId, workspaceId: options.workspaceId ?? null };
  const linker = createLinker(db, scope);

  const unique = new Map<string, RemoteEntityPayload>();
  for (const item of items) unique.set(item.entityId, item);
  const { ordered, cycleBreakers } = orderNotebooksParentsFirst([...unique.values()]);

  const insert = db.prepare(`
    INSERT INTO notebooks (
      id, userId, parentId, name, description, icon, color,
      sortOrder, isExpanded, isDeleted, deletedAt, createdAt, updatedAt, workspaceId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, COALESCE(?, datetime('now')), datetime('now'), ?)
  `);
  const update = db.prepare(`
    UPDATE notebooks
       SET name = ?, description = ?, icon = ?, color = ?, sortOrder = ?, isExpanded = ?, updatedAt = datetime('now')
     WHERE id = ?
  `);
  const relink = db.prepare("UPDATE notebooks SET parentId = ? WHERE id = ?");
  const setFlags = db.prepare(`
    UPDATE notebooks SET isDeleted = ?, deletedAt = ?
     WHERE id = ? AND (isDeleted IS NOT ? OR deletedAt IS NOT ?)
  `);

  const repairs: NotebookStructureRepair[] = [];
  const linked: LinkedRow[] = [];
  const written = new Set<string>();

  // ---- 第一阶段：结构（父先子后；删除标记留到第二阶段）----
  failure.step = "notebook.link";
  for (const item of ordered) {
    const id = item.entityId;
    const payload = item.payload ?? {};
    const wanted = wantedParent(payload);
    failure.entityType = "notebook";
    failure.entityId = redactEntityId(id);
    failure.parentId = redactEntityId(wanted ?? undefined);
    failure.parentState = undefined;
    failure.reason = undefined;

    const existing = linker.readRow(id);
    const resolution: Resolution = cycleBreakers.has(id)
      ? { link: existing ? undefined : null, state: "cycle" }
      : linker.resolve(id, wanted, existing);
    failure.parentState = resolution.state;
    if (existing && !linker.inScope(existing)) {
      // 同一个 id 已经属于别的用户或工作区：写下去会覆盖不属于这个作用域的目录。
      if (mode.foreignScope === "skip") continue;
      failure.reason = "NOTEBOOK_ID_COLLISION";
      throw new SyncError("DATA_STRUCTURE", structureFailureMessage("NOTEBOOK_ID_COLLISION"), { ...failure });
    }
    if (resolution.state === "self" || resolution.state === "missing"
      || resolution.state === "other-scope" || resolution.state === "cycle") {
      if (mode.unresolvedParent === "reject") throw rejectUnresolvedParent(resolution.state, failure);
      repairs.push({
        notebookId: redactEntityId(id),
        parentId: redactEntityId(wanted ?? undefined),
        reason: resolution.state,
      });
    }

    const { link } = resolution;
    if (!existing) {
      if (typeof link === "string") linker.reviveIfDeleted(link);
      insert.run(
        id, scope.userId, link ?? null,
        str(payload.name, "未命名笔记本"),
        payload.description ?? null,
        str(payload.icon, "📒"),
        payload.color ?? null,
        num(payload.sortOrder),
        bit(payload.isExpanded ?? 1),
        payload.createdAt ?? null,
        scope.workspaceId,
      );
    } else {
      update.run(
        str(payload.name, "未命名笔记本"),
        payload.description ?? null,
        str(payload.icon, "📒"),
        payload.color ?? null,
        num(payload.sortOrder),
        bit(payload.isExpanded ?? 1),
        id,
      );
      // 只有父目录真的变了才写 parentId：值没变也写会让 UPDATE OF parentId 守卫重跑一遍。
      if (link !== undefined && link !== existing.parentId) {
        if (typeof link === "string") linker.reviveIfDeleted(link);
        relink.run(link, id);
      }
    }
    written.add(id);
    linker.noteContainer(id);
    if (typeof link === "string" && (!existing || link !== existing.parentId)) {
      linked.push({ id, parentId: link, live: bit(payload.isDeleted) === 0 });
    }
  }

  // ---- 第二阶段：删除标记 ----
  failure.step = "notebook.flags";
  failure.parentId = undefined;
  failure.parentState = undefined;
  for (const item of ordered) {
    // 被跳过的行（服务端遇到别的作用域占用的 id）不属于这次写入，不能碰它的删除标记。
    if (!written.has(item.entityId)) continue;
    const payload = item.payload ?? {};
    const deleted = bit(payload.isDeleted);
    const deletedAt = payload.deletedAt ?? null;
    failure.entityId = redactEntityId(item.entityId);
    setFlags.run(deleted, deletedAt, item.entityId, deleted, deletedAt);
  }
  linker.restoreRevived(written);

  // ---- 第三阶段：知识树投影 ----
  failure.step = "notebook.tree";
  failure.entityId = undefined;
  linker.hideContainers();
  projectTreeParents(db, linked, linker);

  failure.step = undefined;
  failure.entityType = undefined;
  logRepairs(repairs);
  return { applied: ordered.length, repairs };
}

/**
 * 只修复父子链接，不改动任何其他字段。
 *
 * 给"分页应用完再统一补链接"的路径使用（引擎的 Snapshot 重建）：此时所有目录都已落库，
 * 之前因为父目录还没到而回退的链接可以补上。不覆盖字段，因此不会冲掉有未推送修改而被跳过的目录。
 */
export function relinkNotebookParents(
  db: Database.Database,
  links: ReadonlyArray<{ id: string; parentId: string }>,
  options: Pick<ApplyLocalOptions, "userId" | "workspaceId">,
  failure: SyncFailureDiagnostic = {},
  /** 本机还有未上传改动的目录：远端的父目录不能盖过用户尚未上传的移动。 */
  skipIds: ReadonlySet<string> = new Set(),
): number {
  const linker = createLinker(db, { userId: options.userId, workspaceId: options.workspaceId ?? null });
  const relink = db.prepare("UPDATE notebooks SET parentId = ? WHERE id = ?");
  const { ordered } = orderNotebooksParentsFirst(links.map((link) => ({
    entityId: link.id,
    payload: { parentId: link.parentId },
  })));
  const linked: LinkedRow[] = [];

  failure.step = "notebook.relink";
  for (const item of ordered) {
    if (skipIds.has(item.entityId)) continue;
    const existing = linker.readRow(item.entityId);
    if (!existing || !linker.inScope(existing)) continue;
    const { link } = linker.resolve(item.entityId, wantedParent(item.payload), existing);
    if (typeof link !== "string" || link === existing.parentId) continue;
    failure.entityType = "notebook";
    failure.entityId = redactEntityId(item.entityId);
    failure.parentId = redactEntityId(link);
    linker.reviveIfDeleted(link);
    relink.run(link, item.entityId);
    linked.push({ id: item.entityId, parentId: link, live: existing.isDeleted === 0 });
  }
  linker.restoreRevived(new Set());
  linker.hideContainers();
  projectTreeParents(db, linked, linker);

  failure.step = undefined;
  failure.entityType = undefined;
  failure.entityId = undefined;
  failure.parentId = undefined;
  return linked.length;
}
