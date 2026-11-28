/**
 * 按 Change Feed 条目从 /snapshot 取回实体内容，而不是从头翻完整个知识库。
 *
 * Change Feed 只告诉客户端"哪些实体变了"，内容要到 /snapshot 里取。旧做法从第一页开始
 * 逐页翻，直到凑齐全部变更实体：改一篇笔记平均要下载半个库的正文，改一个知识树节点或附件
 * 要翻完全部笔记。大库、弱网下一次拉取就可能超时，其他设备迟迟看不到修改。
 *
 * /snapshot 的游标是 `<实体类型>:<id>`，服务端返回该类型中 id 大于游标的实体（按 id 升序），
 * 各类型按固定顺序首尾相接。因此：
 * - 按 id 排序的类型：用"紧挨在目标 id 之前"的游标请求 1 条，命中即得；
 * - 其余类型（目录按深度、知识树按父先子后）或定位未命中：只扫描该类型自己的一段，
 *   不再从库首开始。
 * 这只用到现有协议，旧版服务器同样适用；定位只是捷径，未命中时回到分段扫描，
 * 仍找不到的实体保持"缺失"，由调用方拒绝推进游标（与原先一致）。
 *
 * 与 frontend/src/lib/mobileSnapshotSeek.ts 为同一算法的两端实现，修改时保持一致。
 */

export interface SnapshotSeekEntry<T extends string> {
  entityType: T;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface SnapshotSeekPage<T extends string> {
  nextCursor: string | null;
  items: Array<SnapshotSeekEntry<T>>;
}

/** 服务端 /snapshot 的实体顺序（routes/sync-v2.ts snapshotOrder）。 */
export const SNAPSHOT_TYPE_ORDER = [
  "notebook", "tag", "note", "note_tag", "favorite", "attachment",
  "task", "task_reminder", "diary", "mindmap", "attachment_organization", "knowledge_tree_node",
] as const;

/** 游标即 `<类型>:<id>`、服务端按 id 升序返回的类型。 */
const SEEKABLE_TYPES = new Set<string>([
  "tag", "note", "note_tag", "favorite", "attachment",
  "task", "task_reminder", "diary", "mindmap", "attachment_organization",
]);

/** 单个类型超过这么多个变更实体时直接分段扫描，避免成百上千次单条请求。 */
const DEFAULT_MAX_SEEKS_PER_TYPE = 24;
const MAX_SECTION_PAGES = 1000;

/**
 * 紧挨在 entityId 之前的快照游标；返回 null 表示不适合精确定位。
 *
 * SQLite 以 UTF-8 字节比较 TEXT：把最后一个字符减一并接上 U+10FFFF，得到的字符串小于
 * entityId，且两者之间只可能夹着同样带 U+10FFFF 的 id（实际不存在）。只对可打印 ASCII
 * 的 id 定位（UUID、组合 id 都是）；即便中间夹了别的实体，也只会"未命中"并回退扫描。
 */
export function snapshotSeekCursor(entityType: string, entityId: string): string | null {
  if (!SEEKABLE_TYPES.has(entityType) || !/^[\x21-\x7e]+$/.test(entityId)) return null;
  const last = entityId.charCodeAt(entityId.length - 1);
  return `${entityType}:${entityId.slice(0, -1)}${String.fromCharCode(last - 1)}\u{10FFFF}`;
}

/**
 * 取回 wanted 中各实体的快照条目（按服务端实体顺序返回）。
 * includeAssetFolders：附件目录有变化时还需要全部 kind=folder 的附件目录条目。
 * fetchPage(cursor, limit)：cursor 为 null 表示从库首开始；limit 为 undefined 时使用调用方原有的分页大小。
 */
export async function fetchSnapshotEntities<T extends string>(options: {
  wanted: Iterable<{ entityType: T; entityId: string }>;
  includeAssetFolders?: boolean;
  fetchPage: (cursor: string | null, limit: number | undefined) => Promise<SnapshotSeekPage<T>>;
  maxSeeksPerType?: number;
}): Promise<Array<SnapshotSeekEntry<T>>> {
  const key = (entityType: string, entityId: string) => `${entityType}\u0000${entityId}`;
  const remaining = new Map<string, { entityType: T; entityId: string }>();
  for (const item of options.wanted) remaining.set(key(item.entityType, item.entityId), item);
  const folders = options.includeAssetFolders === true;
  const found = new Map<string, SnapshotSeekEntry<T>>();
  // 任何一页里出现的目标实体都收下：服务端按 limit=1 只回 1 条，但不应依赖这一点。
  const collect = (page: SnapshotSeekPage<T>) => {
    for (const item of page.items) {
      const id = key(item.entityType, item.entityId);
      if (remaining.delete(id) || (folders && item.entityType === "attachment_organization"
        && item.payload?.kind === "folder" && !found.has(id))) found.set(id, item);
    }
  };
  const order = SNAPSHOT_TYPE_ORDER as readonly string[];
  const remainingTypes = () => [...new Set([...remaining.values()].map((item) => item.entityType as string))];
  const types = [
    ...order.filter((type) => remainingTypes().includes(type) || (folders && type === "attachment_organization")),
    ...remainingTypes().filter((type) => !order.includes(type)),
  ];
  const maxSeeks = options.maxSeeksPerType ?? DEFAULT_MAX_SEEKS_PER_TYPE;
  let inconclusive = false;

  for (const type of types) {
    const folderSection = folders && type === "attachment_organization";
    const wantedIds = () => [...remaining.values()].filter((item) => item.entityType === type).map((item) => item.entityId);
    if (!folderSection && SEEKABLE_TYPES.has(type) && wantedIds().length <= maxSeeks) {
      for (const id of wantedIds()) {
        if (!remaining.has(key(type, id))) continue;
        const cursor = snapshotSeekCursor(type, id);
        if (cursor) collect(await options.fetchPage(cursor, 1));
      }
    }
    if (!wantedIds().length && !folderSection) continue;
    // 只扫描该类型自己的一段，不从库首开始。翻到该段末尾仍没有的实体确实不在快照里。
    const seenCursors = new Set<string>();
    let cursor: string | null = `${type}:`;
    let pages = 0;
    for (; cursor && pages < MAX_SECTION_PAGES && !seenCursors.has(cursor); pages++) {
      seenCursors.add(cursor);
      const page: SnapshotSeekPage<T> = await options.fetchPage(cursor, undefined);
      collect(page);
      if (page.items.some((item) => item.entityType !== type) || (!wantedIds().length && !folderSection)) { cursor = null; break; }
      cursor = page.nextCursor && page.nextCursor.startsWith(`${type}:`) ? page.nextCursor : null;
    }
    if (cursor) inconclusive = true;
  }

  // 兜底：某段因安全上限没翻完时，按原来的方式从头翻一遍（最坏情况与旧实现相同）；仍缺失则由调用方拒绝推进游标。
  if (remaining.size && inconclusive) {
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let pages = 0; pages < MAX_SECTION_PAGES && remaining.size; pages++) {
      const page: SnapshotSeekPage<T> = await options.fetchPage(cursor, undefined);
      collect(page);
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  const rank = (type: string) => { const index = order.indexOf(type); return index < 0 ? order.length : index; };
  return [...found.values()]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.entityType) - rank(b.item.entityType) || a.index - b.index)
    .map(({ item }) => item);
}
