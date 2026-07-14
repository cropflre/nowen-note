import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");

function update(relativePath, replacements) {
  const filePath = path.join(backendRoot, relativePath);
  let source = fs.readFileSync(filePath, "utf8");
  for (const { from, to, label, all = false } of replacements) {
    if (!source.includes(from)) {
      throw new Error(`${relativePath}: missing expected fragment: ${label}`);
    }
    source = all ? source.split(from).join(to) : source.replace(from, to);
  }
  fs.writeFileSync(filePath, source);
}

update("src/services/webhook.ts", [
  {
    label: "webhook database import",
    from: 'import { getDb } from "../db/schema.js";',
    to: 'import { webhookRepository } from "../repositories/webhookRepository";',
  },
  {
    label: "webhook schema initialization",
    from: `export function initWebhookTables(): void {
  const db = getDb();

  db.exec(\`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      events TEXT NOT NULL DEFAULT '["*"]',
      isActive INTEGER DEFAULT 1,
      description TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhookId TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      responseStatus INTEGER,
      responseBody TEXT DEFAULT '',
      success INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      deliveredAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (webhookId) REFERENCES webhooks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(userId);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhookId);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_time ON webhook_deliveries(deliveredAt DESC);
  \`);
}`,
    to: `export function initWebhookTables(): void {
  webhookRepository.initTables();
}`,
  },
  {
    label: "active webhook query",
    from: `      const db = getDb();
      const webhooks = db.prepare(
        "SELECT * FROM webhooks WHERE userId = ? AND isActive = 1"
      ).all(userId) as WebhookConfig[];`,
    to: `      const webhooks = webhookRepository.listActiveByUser<WebhookConfig>(userId);`,
  },
  {
    label: "delivery database local",
    from: `    const db = getDb();
    const deliveryId = crypto.randomUUID();`,
    to: `    const deliveryId = crypto.randomUUID();`,
  },
  {
    label: "delivery log insert",
    from: `      db.prepare(\`
        INSERT INTO webhook_deliveries (id, webhookId, event, payload, responseStatus, responseBody, success, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      \`).run(
        deliveryId,
        webhook.id,
        event,
        payload,
        lastStatus,
        (lastBody || "").slice(0, 2000), // 限制日志大小
        success ? 1 : 0,
        maxRetries,
      );`,
    to: `      webhookRepository.recordDelivery({
        id: deliveryId,
        webhookId: webhook.id,
        event,
        payload,
        responseStatus: lastStatus,
        responseBody: (lastBody || "").slice(0, 2000),
        success: success ? 1 : 0,
        attempts: maxRetries,
      });`,
  },
]);

update("src/services/yjs.ts", [
  {
    label: "Yjs database import",
    from: `import { getDb } from "../db/schema";
import { noteYsnapshotsRepository, noteYupdatesRepository } from "../repositories";`,
    to: `import {
  noteYsnapshotsRepository,
  noteYupdatesRepository,
  yjsPersistenceRepository,
} from "../repositories";`,
  },
  {
    label: "loadDoc database local",
    from: `function loadDocFromDb(noteId: string): Y.Doc {
  const db = getDb();
  const doc = new Y.Doc();`,
    to: `function loadDocFromDb(noteId: string): Y.Doc {
  const doc = new Y.Doc();`,
  },
  {
    label: "Yjs note seed lookup",
    from: `    const note = db.prepare("SELECT content, contentText FROM notes WHERE id = ?").get(noteId) as
      | { content: string; contentText: string }
      | undefined;`,
    to: `    const note = yjsPersistenceRepository.getNoteSeed(noteId);`,
    all: true,
  },
  {
    label: "snapshot transaction",
    from: `function writeSnapshot(noteId: string, doc: Y.Doc) {
  const db = getDb();
  const state = Y.encodeStateAsUpdate(doc);
  // 取当前最大 updateId 作为水位线（在事务内做，避免并发 insert 造成 off-by-one）
  const tx = db.transaction(() => {
    const maxRow = noteYupdatesRepository.getMaxId(noteId);
    const mergedTo = maxRow?.maxId || 0;
    noteYsnapshotsRepository.upsert(noteId, Buffer.from(state), mergedTo);
  });
  tx();
}`,
    to: `function writeSnapshot(noteId: string, doc: Y.Doc) {
  const state = Y.encodeStateAsUpdate(doc);
  // 最大 updateId 与 snapshot upsert 在 Repository 内同一事务执行。
  yjsPersistenceRepository.writeSnapshot(noteId, Buffer.from(state));
}`,
  },
  {
    label: "persist notes database local",
    from: `function persistToNotesTable(room: RoomState) {
  const db = getDb();
  const ytext = room.doc.getText("content");`,
    to: `function persistToNotesTable(room: RoomState) {
  const ytext = room.doc.getText("content");`,
  },
  {
    label: "note version lookup",
    from: `  const existing = db.prepare("SELECT version FROM notes WHERE id = ?").get(room.noteId) as
    | { version: number }
    | undefined;`,
    to: `  const existing = yjsPersistenceRepository.getNoteVersion(room.noteId);`,
  },
  {
    label: "version bump update",
    from: `    db.prepare(
      \`UPDATE notes
         SET content = ?,
             contentText = ?,
             version = version + 1,
             updatedAt = datetime('now')
       WHERE id = ?\`,
    ).run(markdown, contentText, room.noteId);`,
    to: `    yjsPersistenceRepository.updateNoteContent(
      room.noteId,
      markdown,
      contentText,
      true,
    );`,
  },
  {
    label: "content-only update",
    from: `    db.prepare(
      \`UPDATE notes
         SET content = ?,
             contentText = ?,
             updatedAt = datetime('now')
       WHERE id = ?\`,
    ).run(markdown, contentText, room.noteId);`,
    to: `    yjsPersistenceRepository.updateNoteContent(
      room.noteId,
      markdown,
      contentText,
      false,
    );`,
  },
]);

console.log("Applied webhook and Yjs persistence boundary codemod.");
