// Run with Node + --import tsx. Only creates a new, isolated QA database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-assets-ui-"));
process.env.DB_PATH = path.join(directory, "qa.db");
process.env.ELECTRON_USER_DATA = directory;
process.env.NODE_ENV = "production";
process.env.PORT = "4197";
process.env.DISABLE_MDNS = "1";
process.env.CALENDAR_EXPORT_TIMER_DISABLED = "1";
process.env.FRONTEND_DIST = path.resolve("../frontend/dist");
process.env.JWT_SECRET = "isolated-assets-qa-signing-secret-not-production";

await import("../src/runtime/knowledge-tree-migration-bootstrap.ts");
const { getDb } = await import("../src/db/schema.ts");
const { default: bcrypt } = await import("bcryptjs");
const { default: sharp } = await import("sharp");
const { getAttachmentsDir } = await import("../src/routes/attachments.ts");
const db = getDb();
const owner = "assets-qa-user";
db.prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, 'assets_qa', ?, 'admin')")
  .run(owner, bcrypt.hashSync("assets-qa-only-password", 10));
db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('assets-qa-notebook', ?, 'QA notes')").run(owner);
db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, isArchived) VALUES ('assets-qa-holder', ?, 'assets-qa-notebook', 'Files', '{}', 1)").run(owner);
for (const [id, name, parentId] of [["qa-project", "项目资料", null], ["qa-design", "设计素材", "qa-project"], ["qa-references", "参考图片", "qa-design"], ["qa-documents", "文档归档", null]]) {
  db.prepare("INSERT INTO attachment_folders (id, userId, name, parentId) VALUES (?, ?, ?, ?)").run(id, owner, name, parentId);
}
fs.mkdirSync(getAttachmentsDir(), { recursive: true });
const insert = db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash, uploadSource, folderId)
  VALUES (?, 'assets-qa-holder', ?, ?, ?, ?, ?, ?, 'file_manager', ?)`);
const imageSpecs = [
  [720, 400, "#c9dce9", "Architecture"], [360, 620, "#e2d5bc", "Research"], [600, 600, "#d2dfcb", "Components"],
  [840, 300, "#d7cee3", "Flow"], [360, 1000, "#dce5e3", "Long reference"], [620, 430, "#ead4cd", "Sketch"],
];
let firstImage;
for (let index = 0; index < imageSpecs.length; index++) {
  const [width, height, color, title] = imageSpecs[index];
  const id = crypto.randomUUID();
  firstImage ||= id;
  const svg = `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/><rect x="30" y="40" width="${width - 60}" height="${height - 80}" rx="16" fill="white" opacity=".65"/><text x="50%" y="48%" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#42566a">${title}</text><text x="50%" y="58%" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#42566a">QA fixture ${index + 1}</text></svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync(path.join(getAttachmentsDir(), `${id}.png`), bytes);
  insert.run(id, owner, `项目参考图-${index + 1}.png`, "image/png", bytes.length, `${id}.png`, crypto.createHash("sha256").update(bytes).digest("hex"), "qa-references");
}
// Legacy duplicate fixture: a second record shares the original object, without copying bytes.
db.prepare(`INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path,hash,uploadSource)
  SELECT ?,noteId,userId,'legacy-identical-copy.png',mimeType,size,path,hash,uploadSource FROM attachments WHERE id=?`).run(crypto.randomUUID(),firstImage);
for (const [index, title] of ["项目开发记录", "UI 设计规范", "产品需求文档"].entries()) {
  const noteId = `assets-qa-reference-${index}`;
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, contentFormat) VALUES (?, ?, 'assets-qa-notebook', ?, ?, 'markdown')")
    .run(noteId, owner, title, `![Reference](/api/attachments/${firstImage})`);
  db.prepare("INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)").run(firstImage, noteId);
}
for (let index = 0; index < 96; index++) {
  const id = crypto.randomUUID();
  const bytes = Buffer.from(`Actual QA attachment ${index}\n`);
  fs.writeFileSync(path.join(getAttachmentsDir(), `${id}.txt`), bytes);
  insert.run(id, owner, `开发记录-${String(index + 1).padStart(3, "0")}.txt`, "text/plain", bytes.length, `${id}.txt`, crypto.createHash("sha256").update(bytes).digest("hex"), index < 6 ? "qa-documents" : null);
}
console.log(`[assets-qa] Isolated database: ${directory}; 103 actual attachments; port ${process.env.PORT}`);
if (process.env.NOWEN_FILES_AI_QA === "1") {
  const { installAssetAIQA } = await import("./files-assets-ai-provider.mjs");
  await installAssetAIQA(owner);
}
await import("../src/index.hardened.ts");
