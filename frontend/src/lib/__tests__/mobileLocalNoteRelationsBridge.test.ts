import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { installMobileLocalNoteRelationsBridge } from "@/lib/mobileLocalNoteRelationsBridge";
import type { NativeDatabase } from "@/lib/nativeDatabase";

const targetId = "target-note-123";
const sourceId = "source-note-123";
const target = {
  id:targetId,
  notebookId:"book-1",
  notebookName:"本地笔记本",
  title:"目标笔记",
  content:JSON.stringify({
    type:"doc",
    content:[{
      type:"heading",
      attrs:{level:2,blockId:"blk_heading01"},
      content:[{type:"text",text:"本地标题"}],
    }],
  }),
  contentText:"本地标题\n正文预览",
  contentFormat:"tiptap-json",
  version:3,
  updatedAt:"2026-08-27T00:00:00.000Z",
};
const source = {
  id:sourceId,
  notebookId:"book-1",
  notebookName:"本地笔记本",
  title:"来源笔记",
  content:`引用 [[note:${targetId}#blk:blk_heading01|目标块]] ^blk_source01`,
  contentText:"引用目标块",
  contentFormat:"markdown",
  version:1,
  updatedAt:"2026-08-27T01:00:00.000Z",
};

function createFakeDb(): NativeDatabase {
  const db: NativeDatabase = {
    async run(_sql: string, _values: unknown[] = []) { return { changes:0 }; },
    async query<T>(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/g," ");
      if (normalized.includes("WHERE n.scopeKey='personal' AND n.id=?")) {
        const id = String(values[0]);
        return ([target,source].filter((note) => note.id === id)) as T[];
      }
      if (normalized.includes("FROM notes n") && normalized.includes("ORDER BY n.updatedAt DESC")) {
        return [source,target] as T[];
      }
      return [] as T[];
    },
    async transaction<T>(work: (tx: NativeDatabase) => Promise<T>) { return work(db); },
    async close() {},
  };
  return db;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

describe("mobile local note relations bridge", () => {
  it("resolves block previews, precise backlinks and graph from local notes without fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis,"fetch");
    restore = installMobileLocalNoteRelationsBridge(createFakeDb());

    const resolved = await api.resolveNoteLink(`note:${targetId}#blk:blk_heading01`);
    expect(resolved).toMatchObject({
      note:{id:targetId,title:"目标笔记",notebookName:"本地笔记本",version:3},
      block:{blockId:"blk_heading01",blockType:"heading",plainText:"本地标题"},
    });

    const headings = await api.getNoteHeadings(targetId);
    expect(headings.headings).toEqual([
      {blockId:"blk_heading01",level:2,text:"本地标题",order:0},
    ]);

    const backlinks = await api.getBacklinks(targetId,20);
    expect(backlinks.backlinks).toHaveLength(1);
    expect(backlinks.backlinks[0]).toMatchObject({
      sourceNoteId:sourceId,
      sourceBlockId:"blk_source01",
      targetBlockId:"blk_heading01",
      linkType:"block",
    });

    const graph = await api.getKnowledgeGraph(targetId);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([sourceId,targetId].sort());
    expect(graph.edges).toContainEqual(expect.objectContaining({
      sourceNoteId:sourceId,
      sourceBlockId:"blk_source01",
      targetNoteId:targetId,
      targetBlockId:"blk_heading01",
    }));
    expect(await api.releaseYjsRoom(targetId)).toEqual({success:true});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
