import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-authority-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: () => void;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("rebuilds a healthy Block shadow with versions, operation history and attachment refs", async () => {
  const [{ getDb, closeDb: close }, store, noteBlocks] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/blockAuthorityStore"),
    import("../src/lib/noteBlocks"),
  ]);
  closeDb = close;
  const db = getDb();
  const userId = "authority-user";
  const notebookId = "authority-notebook";
  const noteId = "15151515-1515-4515-8515-151515151515";
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, userId, "Authority");
  const content = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "blk_authority0" },
      content: [{ type: "image", attrs: { src: "/api/attachments/attachment-001", alt: null, title: null } }],
    }],
  });
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'Authority', ?, '', 'tiptap-json', 1)
  `).run(noteId, userId, notebookId, content);
  noteBlocks.syncNoteBlocks(db, noteId, content, "tiptap-json");

  const first = store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", {
    noteVersion: 1,
    operationId: "authority-operation-1",
    operationType: "snapshot",
    operationJson: { source: "test" },
  });
  assert.equal(first.status, "healthy");
  assert.equal(first.blockVersion, 1);
  assert.equal(first.structureVersion, 1);
  assert.equal(store.readAuthoritativeNoteContent(db, noteId, content).source, "blocks");
  assert.equal((db.prepare("SELECT version FROM note_block_records WHERE noteId = ? AND blockId = ?").get(noteId, "blk_authority0") as any).version, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM note_block_operations WHERE noteId = ?").get(noteId) as any).c, 1);
  assert.equal((db.prepare("SELECT attachmentId FROM note_block_attachment_refs WHERE noteId = ?").get(noteId) as any).attachmentId, "attachment-001");

  const changed = content.replace("attachment-001", "attachment-002");
  db.prepare("UPDATE notes SET content = ?, version = 2 WHERE id = ?").run(changed, noteId);
  noteBlocks.syncNoteBlocks(db, noteId, changed, "tiptap-json");
  const second = store.rebuildBlockAuthorityStore(db, noteId, changed, "tiptap-json", { noteVersion: 2 });
  assert.equal(second.blockVersion, 2);
  assert.equal(second.structureVersion, 1);
  assert.equal((db.prepare("SELECT version FROM note_block_records WHERE noteId = ? AND blockId = ?").get(noteId, "blk_authority0") as any).version, 2);
});

test("fails closed to notes.content when the shadow snapshot hash diverges", async () => {
  const { getDb } = await import("../src/db/schema");
  const store = await import("../src/lib/blockAuthorityStore");
  const db = getDb();
  const noteId = "15151515-1515-4515-8515-151515151515";
  const notesContent = (db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as any).content as string;
  db.prepare("UPDATE note_block_documents SET snapshotContent = 'corrupted' WHERE noteId = ?").run(noteId);
  const result = store.readAuthoritativeNoteContent(db, noteId, notesContent);
  assert.equal(result.source, "notes");
  assert.equal(result.content, notesContent);
  assert.equal(result.status, "mismatch");
});

test("checks per-block and structure versions independently", async () => {
  const { getDb } = await import("../src/db/schema");
  const store = await import("../src/lib/blockAuthorityStore");
  const db = getDb();
  const noteId = "15151515-1515-4515-8515-151515151515";
  const content = (db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as any).content as string;
  const state = store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", { noteVersion: 2 });
  const record = db.prepare("SELECT blockId, version FROM note_block_records WHERE noteId = ? ORDER BY blockOrder LIMIT 1")
    .get(noteId) as { blockId: string; version: number };
  assert.doesNotThrow(() => store.assertBlockAuthorityVersions(db, noteId, {
    expectedStructureVersion: state.structureVersion,
    expectedBlockVersions: { [record.blockId]: record.version },
  }));
  assert.throws(
    () => store.assertBlockAuthorityVersions(db, noteId, { expectedBlockVersions: { [record.blockId]: 99 } }),
    (error: unknown) => error instanceof store.BlockAuthorityConflictError && error.code === "BLOCK_VERSION_CONFLICT",
  );
  assert.throws(
    () => store.assertBlockAuthorityVersions(db, noteId, { expectedStructureVersion: state.structureVersion + 1 }),
    (error: unknown) => error instanceof store.BlockAuthorityConflictError && error.code === "STRUCTURE_VERSION_CONFLICT",
  );
});

test("backfills canonical block snapshots in bounded batches", async () => {
  const { getDb } = await import("../src/db/schema");
  const store = await import("../src/lib/blockAuthorityStore");
  const db = getDb();
  db.prepare("DELETE FROM note_block_documents").run();
  const result = store.backfillBlockAuthorityStore(db, { limit: 1 });
  assert.equal(result.scanned, 1);
  assert.equal(result.rebuilt, 1);
  assert.deepEqual(result.failed, []);
  assert.equal((db.prepare("SELECT status FROM note_block_documents LIMIT 1").get() as any).status, "healthy");
});

async function createAuthorityNote(
  noteId: string,
  contentFormat: "tiptap-json" | "markdown",
  initialContent: string,
) {
  const [{ getDb }, store, noteBlocks] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/blockAuthorityStore"),
    import("../src/lib/noteBlocks"),
  ]);
  const db = getDb();
  const userId = "authority-user";
  const notebookId = "authority-notebook";
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'Authority fixture', ?, '', ?, 1)
  `).run(noteId, userId, notebookId, initialContent, contentFormat);
  const synced = noteBlocks.syncNoteBlocks(db, noteId, initialContent, contentFormat);
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(synced.content, synced.contentText, noteId);
  store.rebuildBlockAuthorityStore(db, noteId, synced.content, contentFormat, { noteVersion: 1 });
  return { db, store, content: synced.content };
}

function tiptapAuthorityFixture(): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "blk_root_a1" },
        content: [{ type: "text", text: "根段落" }],
      },
      {
        type: "blockquote",
        attrs: { blockId: "blk_root_b1" },
        content: [{
          type: "paragraph",
          attrs: { blockId: "blk_nested_b1" },
          content: [{ type: "text", text: "嵌套段落" }],
        }],
      },
    ],
  });
}

function markdownAuthorityFixture(): string {
  return "# 标题\n\n第一段\n续行\n\n- 列表项\n\n```ts\nconst value = 1;\n```\n\n尾段\n\n";
}

test("materializes Tiptap content from top-level records and stores only root Block order", async () => {
  const { db, store, content } = await createAuthorityNote(
    "25252525-2525-4525-8525-252525252501",
    "tiptap-json",
    tiptapAuthorityFixture(),
  );
  const noteId = "25252525-2525-4525-8525-252525252501";
  const document = db.prepare(`
    SELECT rootOrderJson, materializedHash FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as { rootOrderJson: string; materializedHash: string };

  assert.deepEqual(JSON.parse(document.rootOrderJson), ["blk_root_a1", "blk_root_b1"]);
  assert.equal(store.materializeBlockAuthorityContent(db, noteId), content);
  assert.equal(document.materializedHash, store.hashBlockAuthorityContent(content));
  assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, content), {
    content,
    source: "blocks",
    status: "healthy",
  });
});

test("materializes Markdown records without losing blank lines or trailing whitespace", async () => {
  const { db, store, content } = await createAuthorityNote(
    "25252525-2525-4525-8525-252525252502",
    "markdown",
    markdownAuthorityFixture(),
  );
  const noteId = "25252525-2525-4525-8525-252525252502";

  assert.equal(store.materializeBlockAuthorityContent(db, noteId), content);
  assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, content), {
    content,
    source: "blocks",
    status: "healthy",
  });
});

type AuthorityCorruption = {
  name: string;
  mutate: (db: any, noteId: string, store: any) => void;
  notesContent?: (content: string) => string;
};

const authorityCorruptions: AuthorityCorruption[] = [
  {
    name: "record payload",
    mutate: (db, noteId) => {
      db.prepare(`
        UPDATE note_block_records SET payload = payload || 'corrupted'
        WHERE noteId = ? AND blockOrder = 0
      `).run(noteId);
    },
  },
  {
    name: "missing root record",
    mutate: (db, noteId) => {
      const rootOrder = JSON.parse((db.prepare(`
        SELECT rootOrderJson FROM note_block_documents WHERE noteId = ?
      `).get(noteId) as any).rootOrderJson) as string[];
      db.prepare("DELETE FROM note_block_records WHERE noteId = ? AND blockId = ?")
        .run(noteId, rootOrder[0]);
    },
  },
  {
    name: "root order",
    mutate: (db, noteId) => {
      const rootOrder = JSON.parse((db.prepare(`
        SELECT rootOrderJson FROM note_block_documents WHERE noteId = ?
      `).get(noteId) as any).rootOrderJson) as string[];
      db.prepare("UPDATE note_block_documents SET rootOrderJson = ? WHERE noteId = ?")
        .run(JSON.stringify([...rootOrder].reverse()), noteId);
    },
  },
  {
    name: "duplicate root",
    mutate: (db, noteId) => {
      const rootOrder = JSON.parse((db.prepare(`
        SELECT rootOrderJson FROM note_block_documents WHERE noteId = ?
      `).get(noteId) as any).rootOrderJson) as string[];
      db.prepare("UPDATE note_block_documents SET rootOrderJson = ? WHERE noteId = ?")
        .run(JSON.stringify([rootOrder[0], ...rootOrder]), noteId);
    },
  },
  {
    name: "snapshot",
    mutate: (db, noteId) => {
      db.prepare("UPDATE note_block_documents SET snapshotContent = 'corrupted' WHERE noteId = ?")
        .run(noteId);
    },
  },
  {
    name: "notes.content",
    mutate: () => undefined,
    notesContent: (content) => `${content}drift`,
  },
];

for (const [formatIndex, fixture] of [
  { contentFormat: "tiptap-json" as const, content: tiptapAuthorityFixture() },
  { contentFormat: "markdown" as const, content: markdownAuthorityFixture() },
].entries()) {
  for (const [corruptionIndex, corruption] of authorityCorruptions.entries()) {
    test(`${fixture.contentFormat} fails closed after ${corruption.name} corruption`, async () => {
      const suffix = String(formatIndex * 100 + corruptionIndex + 10).padStart(12, "0");
      const noteId = `35353535-3535-4535-8535-${suffix}`;
      const { db, store, content } = await createAuthorityNote(noteId, fixture.contentFormat, fixture.content);
      corruption.mutate(db, noteId, store);
      const notesContent = corruption.notesContent?.(content) ?? content;

      assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, notesContent), {
        content: notesContent,
        source: "notes",
        status: "mismatch",
      });
      assert.equal((db.prepare(`
        SELECT status FROM note_block_documents WHERE noteId = ?
      `).get(noteId) as any).status, "mismatch");
    });
  }
}

test("fails closed when a nested Tiptap record references a missing parent", async () => {
  const { db, store, content } = await createAuthorityNote(
    "45454545-4545-4545-8545-454545454545",
    "tiptap-json",
    tiptapAuthorityFixture(),
  );
  const noteId = "45454545-4545-4545-8545-454545454545";
  db.prepare(`
    UPDATE note_block_records SET parentBlockId = 'blk_missing_parent'
    WHERE noteId = ? AND blockId = 'blk_nested_b1'
  `).run(noteId);

  assert.equal(store.readAuthoritativeNoteContent(db, noteId, content).source, "notes");
  assert.equal(store.readAuthoritativeNoteContent(db, noteId, content).status, "mismatch");
});

test("materializes top-level list wrappers instead of rejecting ordinary list documents", async () => {
  const content = JSON.stringify({
    type: "doc",
    content: [{
      type: "bulletList",
      content: [
        {
          type: "listItem",
          attrs: { blockId: "blk_list_root_a" },
          content: [{
            type: "paragraph",
            attrs: { blockId: "blk_list_text_a" },
            content: [{ type: "text", text: "第一项" }],
          }],
        },
        {
          type: "listItem",
          attrs: { blockId: "blk_list_root_b" },
          content: [{
            type: "paragraph",
            attrs: { blockId: "blk_list_text_b" },
            content: [{ type: "text", text: "第二项" }],
          }],
        },
      ],
    }],
  });
  const { db, store, content: normalized } = await createAuthorityNote(
    "56565656-5656-4656-8656-565656565656",
    "tiptap-json",
    content,
  );
  const noteId = "56565656-5656-4656-8656-565656565656";

  assert.equal(store.materializeBlockAuthorityContent(db, noteId), normalized);
  assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, normalized), {
    content: normalized,
    source: "blocks",
    status: "healthy",
  });
});

test("marks an existing shadow stale immediately when an unintegrated writer changes notes.content", async () => {
  const { db } = await createAuthorityNote(
    "67676767-6767-4767-8767-676767676767",
    "tiptap-json",
    tiptapAuthorityFixture(),
  );
  const noteId = "67676767-6767-4767-8767-676767676767";
  db.prepare("UPDATE notes SET content = content || ' ' WHERE id = ?").run(noteId);

  const document = db.prepare(`
    SELECT status, mismatchReason FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as { status: string; mismatchReason: string };
  assert.equal(document.status, "mismatch");
  assert.equal(document.mismatchReason, "notes_content_changed_without_shadow_rebuild");
});

test("records create, whole-save and read-repair history whenever operationType is provided", async () => {
  const { db, store, content } = await createAuthorityNote(
    "78787878-7878-4787-8787-787878787878",
    "tiptap-json",
    tiptapAuthorityFixture(),
  );
  const noteId = "78787878-7878-4787-8787-787878787878";
  for (const operationType of ["create", "whole-save", "read-repair"]) {
    store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", {
      noteVersion: 1,
      operationType,
    });
  }
  store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", {
    noteVersion: 1,
    operationId: "history-idempotent-operation",
    operationType: "whole-save",
  });
  store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", {
    noteVersion: 1,
    operationId: "history-idempotent-operation",
    operationType: "whole-save",
  });

  const operationTypes = (db.prepare(`
    SELECT operationType FROM note_block_operations WHERE noteId = ? ORDER BY rowid
  `).all(noteId) as Array<{ operationType: string }>).map((row) => row.operationType);
  assert.deepEqual(operationTypes, ["create", "whole-save", "read-repair", "whole-save"]);

  const firstPage = store.readBlockAuthorityHistory(db, noteId, { limit: 2 });
  assert.equal(firstPage.limit, 2);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(firstPage.items.map((item: any) => item.type), ["whole-save", "read-repair"]);
  assert.deepEqual(firstPage.items[0].operation, {});
  assert.equal(firstPage.items[0].operationId, "history-idempotent-operation");
  assert.equal(typeof firstPage.items[0].time, "string");

  const secondPage = store.readBlockAuthorityHistory(db, noteId, { limit: 2, offset: 2 });
  assert.deepEqual(secondPage.items.map((item: any) => item.type), ["whole-save", "create"]);

  db.prepare(`
    UPDATE note_block_operations SET operationJson = '{bad json'
    WHERE noteId = ? AND operationType = 'create'
  `).run(noteId);
  assert.throws(
    () => store.readBlockAuthorityHistory(db, noteId, { limit: 100 }),
    /operationJson.*JSON/,
  );
});

test("stale trigger marks an old write immediately and rebuild restores healthy in the same transaction", async () => {
  const noteBlocks = await import("../src/lib/noteBlocks");
  const { db, store, content } = await createAuthorityNote(
    "89898989-8989-4898-8989-898989898989",
    "tiptap-json",
    tiptapAuthorityFixture(),
  );
  const noteId = "89898989-8989-4898-8989-898989898989";
  const changed = content.replace("根段落", "根段落已修改");

  db.transaction(() => {
    db.prepare("UPDATE notes SET content = ?, version = 2 WHERE id = ?").run(changed, noteId);
    assert.equal((db.prepare(`
      SELECT status FROM note_block_documents WHERE noteId = ?
    `).get(noteId) as any).status, "mismatch");

    noteBlocks.syncNoteBlocks(db, noteId, changed, "tiptap-json");
    store.rebuildBlockAuthorityStore(db, noteId, changed, "tiptap-json", {
      noteVersion: 2,
      operationType: "whole-save",
    });
    assert.equal((db.prepare(`
      SELECT status FROM note_block_documents WHERE noteId = ?
    `).get(noteId) as any).status, "healthy");
  })();

  assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, changed), {
    content: changed,
    source: "blocks",
    status: "healthy",
  });
});

// 复杂度回归：物化与重建过程中，整篇文档最多各解析一次。
//
// 历史问题：materializeTiptapRecords / buildIndexedPayloads 曾对每条 Block 记录
// 调用 tiptapNodeAtPath，而该函数内部 JSON.parse 整篇文档，导致
// "记录数 × 全文解析" 的 O(n²) 行为。5000 段 / 776KB 的笔记单次读取实测 10.6s，
// 而 GET /api/notes/:id 每次非 slim 读取都会走到这里。
//
// 这里用 JSON.parse 调用次数（而非绝对耗时）断言，避免 CI 上的时间抖动。
test("materializes large documents without re-parsing the whole doc per block", async () => {
  const paragraphs = 400;
  const content = JSON.stringify({
    type: "doc",
    content: Array.from({ length: paragraphs }, (_, index) => ({
      type: "paragraph",
      attrs: { blockId: `blk_perf_${index}` },
      content: [{ type: "text", text: `第${index} 段内容` }],
    })),
  });
  const noteId = "78787878-7878-4878-8878-787878787878";
  const { db, store, content: normalized } = await createAuthorityNote(noteId, "tiptap-json", content);

  const originalParse = JSON.parse;
  let fullDocParses = 0;
  // 只统计"整篇文档级别"的解析，忽略单个 Block payload 的小解析
  JSON.parse = ((text: string, ...rest: unknown[]) => {
    if (typeof text === "string" && text.length > normalized.length / 2) fullDocParses++;
    return (originalParse as any)(text, ...rest);
  }) as typeof JSON.parse;

  let materialized: string;
  try {
    materialized = store.materializeBlockAuthorityContent(db, noteId);
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(materialized, normalized, "物化结果必须与原文一致");
  assert.ok(
    fullDocParses <= 1,
    `物化 ${paragraphs} 段文档时整篇解析次数应 <= 1，实际 ${fullDocParses} 次`,
  );

  // 重建路径同样不允许逐块重复解析整篇文档
  let rebuildParses = 0;
  JSON.parse = ((text: string, ...rest: unknown[]) => {
    if (typeof text === "string" && text.length > normalized.length / 2) rebuildParses++;
    return (originalParse as any)(text, ...rest);
  }) as typeof JSON.parse;
  try {
    store.rebuildBlockAuthorityStore(db, noteId, normalized, "tiptap-json", {
      noteVersion: 2,
      operationType: "whole-save",
    });
  } finally {
    JSON.parse = originalParse;
  }

  assert.ok(
    rebuildParses <= 2,
    `重建 ${paragraphs} 段文档时整篇解析次数应 <= 2，实际 ${rebuildParses} 次`,
  );
});

// 已处于 mismatch 的文档，重复读取不得再次物化校验或写库。
//
// 历史行为：readAuthoritativeNoteContent 对 mismatch 文档也会跑完整物化 + 3 次
// 全文哈希，然后无条件 UPDATE。由于本函数不自愈（mismatch 必须保留现场），
// 这些工作得不出新结论，而且会把触发器写入的具体原因覆盖成通用的
// authority_hash_mismatch，反而丢掉诊断信息。
test("skips revalidation and rewrites for documents already marked mismatch", async () => {
  const noteId = "89898989-8989-4989-8989-898989898989";
  const { db, store, content } = await createAuthorityNote(noteId, "tiptap-json", tiptapAuthorityFixture());

  // 未整合的写入方改动 notes.content，触发器写入具体原因
  db.prepare("UPDATE notes SET content = content || ' ' WHERE id = ?").run(noteId);
  const drifted = (db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as any).content;
  const before = db.prepare(`
    SELECT status, mismatchReason, updatedAt FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as { status: string; mismatchReason: string; updatedAt: string };
  assert.equal(before.status, "mismatch");
  assert.equal(before.mismatchReason, "notes_content_changed_without_shadow_rebuild");

  // 多次读取：返回值保持"保留现场"语义
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, drifted), {
      content: drifted,
      source: "notes",
      status: "mismatch",
    });
  }

  const after = db.prepare(`
    SELECT status, mismatchReason, updatedAt FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as { status: string; mismatchReason: string; updatedAt: string };
  assert.equal(after.status, "mismatch");
  assert.equal(
    after.mismatchReason,
    "notes_content_changed_without_shadow_rebuild",
    "读取不得覆盖触发器写入的具体诊断原因",
  );
  assert.equal(after.updatedAt, before.updatedAt, "已 mismatch 的文档重复读取不应再写库");

  // 重建仍可恢复 healthy —— 短路不得阻断自愈路径
  const synced = (await import("../src/lib/noteBlocks")).syncNoteBlocks(db, noteId, drifted, "tiptap-json");
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(synced.content, synced.contentText, noteId);
  store.rebuildBlockAuthorityStore(db, noteId, synced.content, "tiptap-json", {
    noteVersion: 2,
    operationType: "read-repair",
  });
  assert.equal(store.readAuthoritativeNoteContent(db, noteId, synced.content).status, "healthy");
  assert.notEqual(content, null);
});

// 建表 DDL 每个连接只执行一次。
//
// 这些语句都是 IF NOT EXISTS，重复执行逻辑上无害但并非免费：内存库约 0.02ms，
// 文件库（Docker volume / NAS 的真实形态）实测约 5ms —— 而 GET /api/notes/:id
// 每次都会调用一次。这里断言重复调用不再产生 DDL，同时确认建表结果仍然齐备。
test("runs block authority schema DDL only once per connection", async () => {
  const { getDb } = await import("../src/db/schema");
  const store = await import("../src/lib/blockAuthorityStore");
  const db = getDb();

  // 首次调用后，表与陈旧标记触发器都必须存在
  store.ensureBlockAuthorityTables(db);
  const documentsTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_block_documents'
  `).get();
  assert.ok(documentsTable, "note_block_documents 必须已建立");
  const staleTrigger = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND name = 'trg_note_block_authority_stale_after_content_update'
  `).get();
  assert.ok(staleTrigger, "陈旧标记触发器必须已建立");

  // 重复调用不得再执行 DDL
  const originalExec = db.exec.bind(db);
  let execCalls = 0;
  (db as any).exec = (sql: string) => {
    execCalls++;
    return originalExec(sql);
  };
  try {
    for (let i = 0; i < 5; i++) store.ensureBlockAuthorityTables(db);
  } finally {
    (db as any).exec = originalExec;
  }
  assert.equal(execCalls, 0, "同一连接重复调用不应再执行建表 DDL");
});

// healthy 判定可缓存，但任何输入变化都必须立刻重新校验。
//
// 物化 + 3 次全文哈希只为回答"这份数据是否仍健康"，1MB 文档一次判定实测约 30ms。
// 同一笔记内容未变时反复读取（A→B→A、乐观锁重试）会重复得出同一结论。
test("caches healthy verdicts without ever serving a stale one", async () => {
  const noteId = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
  const { db, store, content } = await createAuthorityNote(noteId, "tiptap-json", tiptapAuthorityFixture());

  // 重复读取：结论与内容都必须稳定
  const first = store.readAuthoritativeNoteContent(db, noteId, content);
  assert.deepEqual(first, { content, source: "blocks", status: "healthy" });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, content), {
      content,
      source: "blocks",
      status: "healthy",
    });
  }

  // notesContent 变化必须绕过缓存并判定 mismatch
  const drifted = `${content} `;
  assert.equal(store.readAuthoritativeNoteContent(db, noteId, drifted).status, "mismatch");

  // 重建后必须重新判定 healthy 并返回新内容
  const noteBlocks = await import("../src/lib/noteBlocks");
  const changed = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "blk_root_a1" },
      content: [{ type: "text", text: "缓存失效后的新内容" }],
    }],
  });
  const synced = noteBlocks.syncNoteBlocks(db, noteId, changed, "tiptap-json");
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(synced.content, synced.contentText, noteId);
  store.rebuildBlockAuthorityStore(db, noteId, synced.content, "tiptap-json", {
    noteVersion: 2,
    operationType: "whole-save",
  });
  assert.deepEqual(store.readAuthoritativeNoteContent(db, noteId, synced.content), {
    content: synced.content,
    source: "blocks",
    status: "healthy",
  });
});
