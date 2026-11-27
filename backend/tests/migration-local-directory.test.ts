import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-local-dir-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ELECTRON_LOCAL_ACCOUNT_SECRET = "desktop-local-secret-0123456789abcdef";

const VALID_PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180,
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

let app: Hono;
let closeDb: () => void;
let getDb: typeof import("../src/db/schema").getDb;
let migrationJobDirectory: typeof import("../src/services/migrationService").migrationJobDirectory;
let readAttachmentRange: typeof import("../src/services/attachment-storage").readAttachmentRange;

const userId = "local-desktop-user";
const sessionId = "desktop-session-1";

async function waitForStatus(jobId: string, expected: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.request(`/api/migrations/${jobId}`, {
      headers: { "X-User-Id": userId },
    });
    const job = await res.json() as any;
    if (expected.includes(job.status)) return job;
    if (["FAILED", "CANCELLED"].includes(job.status) && !expected.includes(job.status)) {
      throw new Error(`Migration job failed unexpectedly: ${job.status} (${job.error})`);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for migration job ${jobId} to reach ${expected.join("/")}`);
}

test.before(async () => {
  const [schema, routes, settingsRoutes, service, storage] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/migrations"),
    import("../src/routes/settings"),
    import("../src/services/migrationService"),
    import("../src/services/attachment-storage"),
  ]);
  closeDb = schema.closeDb;
  getDb = schema.getDb;
  migrationJobDirectory = service.migrationJobDirectory;
  readAttachmentRange = storage.readAttachmentRange;

  const db = getDb();
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, isDisabled, personalImportEnabled)
    VALUES (?, 'desktop', 'hash', 'admin', 0, 1)
  `).run(userId);
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, isDisabled, personalImportEnabled)
    VALUES ('normal-member', 'member', 'hash', 'user', 0, 1)
  `).run();
  db.prepare(`
    INSERT INTO user_sessions (id, userId, expiresAt)
    VALUES (?, ?, datetime('now', '+1 day'))
  `).run(sessionId, userId);

  app = new Hono();
  app.use("/api/migrations/*", async (c, next) => {
    if (c.req.header("X-Auth-Mode") !== "api-token") {
      c.set("migrationApprovalSession" as never, { userId, sessionId } as never);
    }
    await next();
  });
  app.route("/api/migrations", routes.default);
  app.route("/api/settings", settingsRoutes.default);
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("DCC-006: 本地文件夹直导强制校验桌面密钥与权限，拒绝未授权、API Token 与根目录请求", async () => {
  const vaultDir = path.join(tmpDir, "auth-check-vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "a.md"), "# Hello");

  // 1. 缺少 X-Nowen-Desktop-Secret 必须 403
  const noSecret = await app.request("/api/migrations/local-directory", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ directoryPath: vaultDir }),
  });
  assert.equal(noSecret.status, 403);
  assert.equal((await noSecret.json() as any).code, "MIGRATION_LOCAL_DIR_FORBIDDEN");

  // 2. 错误的 X-Nowen-Desktop-Secret 必须 403
  const wrongSecret = await app.request("/api/migrations/local-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-Nowen-Desktop-Secret": "wrong-secret-0123456789abcdef01234",
    },
    body: JSON.stringify({ directoryPath: vaultDir }),
  });
  assert.equal(wrongSecret.status, 403);

  // 3. API Token（如 AI 助手）即使带密钥也不得直接读取任意本地目录
  const apiTokenAttempt = await app.request("/api/migrations/local-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-Auth-Mode": "api-token",
      "X-Api-Token-Id": "tok-1",
      "X-Nowen-Desktop-Secret": process.env.ELECTRON_LOCAL_ACCOUNT_SECRET!,
    },
    body: JSON.stringify({ directoryPath: vaultDir }),
  });
  assert.equal(apiTokenAttempt.status, 403);
  assert.equal((await apiTokenAttempt.json() as any).code, "MIGRATION_HUMAN_APPROVAL_REQUIRED");

  // 4. 拒绝导入文件系统根目录
  const rootAttempt = await app.request("/api/migrations/local-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-Nowen-Desktop-Secret": process.env.ELECTRON_LOCAL_ACCOUNT_SECRET!,
    },
    body: JSON.stringify({ directoryPath: path.parse(tmpDir).root }),
  });
  assert.equal(rootAttempt.status, 400);
  assert.equal((await rootAttempt.json() as any).code, "MIGRATION_LOCAL_DIR_INVALID");
});

test("DCC-005: 桌面端本地文件夹零拷贝直导支持 Obsidian 独立附件库与相对路径，忽略符号链接且不改动源目录", async () => {
  const outsideSecret = path.join(tmpDir, "outside-secret.md");
  fs.writeFileSync(outsideSecret, "# SECRET DO NOT IMPORT");

  const vaultDir = path.join(tmpDir, "MyObsidianVault");
  fs.mkdirSync(path.join(vaultDir, "公众号摘录"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "随笔"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "图片库"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });

  const img1Path = path.join(vaultDir, "图片库", "pic1.png");
  const img2Path = path.join(vaultDir, "图片库", "pic2.png");
  const unusedImgPath = path.join(vaultDir, "图片库", "unused.png");
  fs.writeFileSync(img1Path, VALID_PNG);
  fs.writeFileSync(img2Path, VALID_PNG);
  fs.writeFileSync(unusedImgPath, VALID_PNG);
  fs.writeFileSync(path.join(vaultDir, ".obsidian", "app.json"), '{"theme":"dark"}');
  fs.symlinkSync(outsideSecret, path.join(vaultDir, "escape.md"));

  const noteAPath = path.join(vaultDir, "公众号摘录", "文章A.md");
  const noteBPath = path.join(vaultDir, "随笔", "文章B.md");
  const noteAContent = "# 文章A\n\n相对路径图片：![图1](../图片库/pic1.png)\n\nObsidian 嵌入：![[pic2.png]]\n";
  const noteBContent = "# 文章B\n\n复用同一张图片：![复用](../图片库/pic1.png)\n";
  fs.writeFileSync(noteAPath, noteAContent, "utf8");
  fs.writeFileSync(noteBPath, noteBContent, "utf8");

  // 1. 发起本地目录直导
  const startRes = await app.request("/api/migrations/local-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-Nowen-Desktop-Secret": process.env.ELECTRON_LOCAL_ACCOUNT_SECRET!,
    },
    body: JSON.stringify({ directoryPath: vaultDir }),
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json() as any;
  assert.equal(started.name, "MyObsidianVault");

  // 2. 等待后台扫描完成（零拷贝：staging 目录中不应存在图片副本）
  const scanned = await waitForStatus(started.id, ["CREATED"]);
  assert.equal(scanned.counts.total, 2, "应扫描到 2 篇笔记，且跳过符号链接与 .obsidian");
  assert.equal(scanned.counts.attachments, 3, "两篇笔记共引用 3 处附件（含复用）");
  const jobDir = migrationJobDirectory(started.id);
  assert.equal(fs.existsSync(path.join(jobDir, "local")), false, "附件不得复制到临时 staging 目录");
  assert.equal(fs.existsSync(path.join(jobDir, "extracted")), false, "本地直导不应创建解压目录");

  // 3. 预览并确认导入
  const previewRes = await app.request(`/api/migrations/${started.id}/preview`, {
    method: "POST",
    headers: { "X-User-Id": userId },
  });
  assert.equal(previewRes.status, 200);
  const previewed = await previewRes.json() as any;
  assert.equal(previewed.status, "PREVIEW_READY");
  assert.equal(previewed.counts.create, 2);

  const approveRes = await app.request(`/api/migrations/${started.id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ previewDigest: previewed.previewDigest }),
  });
  assert.equal(approveRes.status, 202);

  // 4. 等待导入与完整性核验完成
  const completed = await waitForStatus(started.id, ["COMPLETED"]);
  assert.equal(completed.counts.imported, 2);
  assert.equal(completed.counts.failed, 0);

  // 5. 验证数据库中的笔记正文图片链接已重写为 /api/attachments/<id>，且二进制内容完整可读
  const db = getDb();
  const notes = db.prepare("SELECT id, title, content FROM notes WHERE userId = ? ORDER BY title").all(userId) as Array<{ id: string; title: string; content: string }>;
  assert.deepEqual(notes.map((n) => n.title), ["文章A", "文章B"]);
  assert.equal(notes.some((n) => n.content.includes("SECRET DO NOT IMPORT")), false, "绝不能读取目录外符号链接内容");

  const attachments = db.prepare("SELECT id, noteId, filename, path, hash, size FROM attachments WHERE userId = ?").all(userId) as Array<{ id: string; noteId: string; filename: string; path: string; hash: string; size: number }>;
  assert.equal(attachments.length, 3);
  const expectedHash = crypto.createHash("sha256").update(VALID_PNG).digest("hex");
  for (const att of attachments) {
    assert.equal(att.hash, expectedHash);
    assert.equal(att.size, VALID_PNG.length);
    const bytes = await readAttachmentRange(att.path, 0, att.size - 1);
    assert.ok(bytes && Buffer.from(bytes).equals(VALID_PNG), "导入后的附件字节必须与源文件完全一致");
  }
  const noteA = notes.find((n) => n.title === "文章A")!;
  const noteAAttachments = attachments.filter((a) => a.noteId === noteA.id);
  assert.equal(noteAAttachments.length, 2);
  for (const att of noteAAttachments) {
    assert.ok(noteA.content.includes(`/api/attachments/${att.id}`), "Markdown 相对路径与 Obsidian 嵌入都应改写为附件地址");
  }

  // 6. 验证源 Obsidian 目录未被任何修改或删除
  assert.equal(fs.readFileSync(noteAPath, "utf8"), noteAContent);
  assert.equal(fs.readFileSync(noteBPath, "utf8"), noteBContent);
  assert.equal(fs.existsSync(unusedImgPath), true);
});

test("管理员可在设置中调整导入包上限并立即生效，非管理员与非法范围被拒绝", async () => {
  // 1. 非管理员不可修改
  const forbidden = await app.request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": "normal-member" },
    body: JSON.stringify({ migration_max_upload_mb: 3072 }),
  });
  assert.equal(forbidden.status, 403);

  // 2. 超出安全范围（<100 或 >3584）返回 400
  for (const bad of [50, 4096, "abc", 1024.5]) {
    const invalid = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-User-Id": userId },
      body: JSON.stringify({ migration_max_upload_mb: bad }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as any).code, "INVALID_MIGRATION_MAX_UPLOAD_MB");
  }

  // 3. 管理员设为 3584 MB（3.5 GB）并立即体现在 /api/settings 与 /api/migrations/capabilities
  const updated = await app.request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ migration_max_upload_mb: 3584 }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json() as any).migration_max_upload_mb, "3584");

  const capsRes = await app.request("/api/migrations/capabilities", {
    headers: { "X-User-Id": userId },
  });
  assert.equal(capsRes.status, 200);
  const caps = await capsRes.json() as any;
  assert.equal(caps.limits.uploadBytes, 3584 * 1024 * 1024);
  assert.equal(caps.localDirectoryImport, true);
});

test("Obsidian 本地直导兼容 Windows 反斜杠、含空格路径、仓库根相对路径、大小写与裸 % 文件名", async () => {
  const vaultDir = path.join(tmpDir, "WeChatObsidianVault");
  fs.mkdirSync(path.join(vaultDir, "公众号"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "assets"), { recursive: true });

  fs.writeFileSync(path.join(vaultDir, "assets", "my image.png"), VALID_PNG);
  fs.writeFileSync(path.join(vaultDir, "assets", "100%_chart.png"), VALID_PNG);
  fs.writeFileSync(path.join(vaultDir, "assets", "CasePic.png"), VALID_PNG);

  const article = [
    "# 公众号测试",
    "反斜杠含空格：![图1](..\\assets\\my image.png)",
    "仓库根裸百分号：![图2](assets/100%_chart.png)",
    "大小写与根斜杠：![图3](/assets/casepic.png)",
  ].join("\n\n");
  fs.writeFileSync(path.join(vaultDir, "公众号", "wechat.md"), article, "utf8");

  const startRes = await app.request("/api/migrations/local-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
      "X-Nowen-Desktop-Secret": process.env.ELECTRON_LOCAL_ACCOUNT_SECRET!,
    },
    body: JSON.stringify({ directoryPath: vaultDir }),
  });
  assert.equal(startRes.status, 202);
  const started = await startRes.json() as any;
  const scanned = await waitForStatus(started.id, ["CREATED"]);
  assert.equal(scanned.counts.total, 1);
  assert.equal(scanned.counts.attachments, 3, "3 种 Obsidian/Windows 相对路径图片都应成功关联");

  const previewRes = await app.request(`/api/migrations/${started.id}/preview`, {
    method: "POST",
    headers: { "X-User-Id": userId },
  });
  const previewed = await previewRes.json() as any;
  await app.request(`/api/migrations/${started.id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ previewDigest: previewed.previewDigest }),
  });
  const completed = await waitForStatus(started.id, ["COMPLETED"]);
  assert.equal(completed.counts.imported, 1);

  const db = getDb();
  const note = db.prepare("SELECT id, content FROM notes WHERE userId = ? AND title = '公众号测试'").get(userId) as { id: string; content: string };
  const atts = db.prepare("SELECT id FROM attachments WHERE noteId = ?").all(note.id) as Array<{ id: string }>;
  assert.equal(atts.length, 3);
  for (const att of atts) {
    assert.ok(note.content.includes(`/api/attachments/${att.id}`), "每张图片链接都应改写为附件地址");
  }
});
