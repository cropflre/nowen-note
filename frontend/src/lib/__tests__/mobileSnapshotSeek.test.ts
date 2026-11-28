import { describe, expect, it } from "vitest";
import { fetchSnapshotEntities, snapshotSeekCursor, SNAPSHOT_TYPE_ORDER, type SnapshotSeekPage } from "../mobileSnapshotSeek";

type Entry = { entityType: string; entityId: string; payload: Record<string, unknown> };

/** 按服务端 /snapshot 规则分页：`<类型>:<id>` 之后按 UTF-8 字节序升序，类型首尾相接。 */
function snapshotServer(entries: Entry[], pageSize = 50) {
  const bytes = (value: string) => Buffer.from(value, "utf8");
  const sorted = [...entries].sort((a, b) =>
    SNAPSHOT_TYPE_ORDER.indexOf(a.entityType as never) - SNAPSHOT_TYPE_ORDER.indexOf(b.entityType as never)
      || Buffer.compare(bytes(a.entityId), bytes(b.entityId)));
  const requests: Array<{ cursor: string | null; limit: number; returned: number }> = [];
  const fetchPage = async (cursor: string | null, limit: number | undefined): Promise<SnapshotSeekPage<string>> => {
    const size = limit ?? pageSize;
    let start = 0;
    if (cursor) {
      const separator = cursor.indexOf(":");
      const type = cursor.slice(0, separator);
      const after = bytes(cursor.slice(separator + 1));
      const typeIndex = SNAPSHOT_TYPE_ORDER.indexOf(type as never);
      start = sorted.findIndex((entry) => {
        const index = SNAPSHOT_TYPE_ORDER.indexOf(entry.entityType as never);
        return index > typeIndex || (index === typeIndex && Buffer.compare(bytes(entry.entityId), after) > 0);
      });
      if (start < 0) start = sorted.length;
    }
    const items = sorted.slice(start, start + size);
    requests.push({ cursor, limit: size, returned: items.length });
    const last = items.at(-1);
    return { items, nextCursor: start + size < sorted.length && last ? `${last.entityType}:${last.entityId}` : null };
  };
  return { fetchPage, requests };
}

const uuid = (index: number) => `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const note = (index: number): Entry => ({ entityType: "note", entityId: uuid(index), payload: { content: `正文 ${index}` } });

describe("mobile snapshot seek", () => {
  it("builds a cursor that sorts directly before the entity id", () => {
    const id = uuid(255);
    const cursor = snapshotSeekCursor("note", id)!;
    const after = cursor.slice("note:".length);
    expect(Buffer.compare(Buffer.from(after), Buffer.from(id))).toBeLessThan(0);
    // 任何更小的可打印 ASCII id 都排在游标之前，不会夹在游标与目标之间。
    expect(Buffer.compare(Buffer.from(uuid(254)), Buffer.from(after))).toBeLessThan(0);
    expect(Buffer.compare(Buffer.from(`${id.slice(0, -1)}e~~~~`), Buffer.from(after))).toBeLessThan(0);
    expect(snapshotSeekCursor("notebook", id)).toBeNull();
    expect(snapshotSeekCursor("knowledge_tree_node", `note:${id}`)).toBeNull();
    expect(snapshotSeekCursor("note", "含中文的id")).toBeNull();
  });

  it("DCC-005: fetches one changed note with a single one-item request instead of scanning the library", async () => {
    const library = Array.from({ length: 400 }, (_, index) => note(index));
    const server = snapshotServer([{ entityType: "notebook", entityId: "nb", payload: {} }, ...library]);
    const found = await fetchSnapshotEntities({ wanted: [{ entityType: "note", entityId: uuid(321) }], fetchPage: server.fetchPage });
    expect(found).toEqual([note(321)]);
    expect(server.requests).toEqual([{ cursor: snapshotSeekCursor("note", uuid(321)), limit: 1, returned: 1 }]);
  });

  it("DCC-005: scans only the entity's own section for tree nodes and asset folders, in server order", async () => {
    const entries: Entry[] = [
      ...Array.from({ length: 120 }, (_, index) => note(index)),
      { entityType: "attachment_organization", entityId: "file:a", payload: { kind: "file" } },
      { entityType: "attachment_organization", entityId: "folder:x", payload: { kind: "folder" } },
      { entityType: "attachment_organization", entityId: "folder:y", payload: { kind: "folder" } },
      { entityType: "knowledge_tree_node", entityId: "notebook:root", payload: { parentId: null } },
      { entityType: "knowledge_tree_node", entityId: "note:child", payload: { parentId: "notebook:root" } },
    ];
    const server = snapshotServer(entries, 2);
    const found = await fetchSnapshotEntities({
      wanted: [
        { entityType: "knowledge_tree_node", entityId: "note:child" },
        { entityType: "attachment_organization", entityId: "file:a" },
        { entityType: "note", entityId: uuid(3) },
      ],
      includeAssetFolders: true,
      fetchPage: server.fetchPage,
    });
    expect(found.map((item) => `${item.entityType}:${item.entityId}`)).toEqual([
      `note:${uuid(3)}`,
      "attachment_organization:file:a", "attachment_organization:folder:x", "attachment_organization:folder:y",
      "knowledge_tree_node:note:child",
    ]);
    expect(server.requests.some((request) => request.cursor === null)).toBe(false);
    // 120 篇笔记只按定位取了 1 篇。
    expect(server.requests.filter((request) => request.cursor?.startsWith("note:")).map((request) => request.returned)).toEqual([1]);
  });

  it("DCC-005: leaves a deleted entity missing after one pass over its section, never a second full scan", async () => {
    const server = snapshotServer(Array.from({ length: 30 }, (_, index) => note(index)), 10);
    const found = await fetchSnapshotEntities({ wanted: [{ entityType: "note", entityId: uuid(999) }], fetchPage: server.fetchPage });
    expect(found).toEqual([]);
    expect(server.requests.every((request) => request.cursor !== null)).toBe(true);
    expect(server.requests.reduce((sum, request) => sum + request.returned, 0)).toBeLessThanOrEqual(30);
  });

  it("still works against a server page that ignores the cursor", async () => {
    const everything = { items: [note(1), note(2), note(3)], nextCursor: null };
    const found = await fetchSnapshotEntities({
      wanted: [{ entityType: "note", entityId: uuid(3) }, { entityType: "note", entityId: uuid(1) }],
      fetchPage: async () => everything,
    });
    expect(found.map((item) => item.entityId).sort()).toEqual([uuid(1), uuid(3)]);
  });
});
