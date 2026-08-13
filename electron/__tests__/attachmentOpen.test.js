const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openLocalAttachmentWithSystem } = require("../attachment-open");

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174000";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-attachment-open-"));
  const relativePath = path.join("2026", "08", "physical-name.xlsx");
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "xlsx");
  return { root, relativePath, filePath };
}

test("使用后端返回的真实分月路径打开附件，不根据 attachmentId 猜文件名", async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let openedPath = "";

  const result = await openLocalAttachmentWithSystem({
    attachmentId: ATTACHMENT_ID,
    mode: "full",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "local", path: fixture.relativePath }),
    openPath: async (filePath) => {
      openedPath = filePath;
      return "";
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(openedPath, fs.realpathSync(fixture.filePath));
  assert.notEqual(path.basename(openedPath), `${ATTACHMENT_ID}.xlsx`);
});

test("拒绝非 UUID、Lite、S3、目录逃逸和不存在的文件", async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let openCount = 0;
  const openPath = async () => {
    openCount += 1;
    return "";
  };

  assert.equal((await openLocalAttachmentWithSystem({
    attachmentId: "../../outside",
    mode: "full",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "local", path: fixture.relativePath }),
    openPath,
  })).error, "INVALID_ATTACHMENT_ID");

  assert.equal((await openLocalAttachmentWithSystem({
    attachmentId: ATTACHMENT_ID,
    mode: "lite",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "local", path: fixture.relativePath }),
    openPath,
  })).error, "NOT_FULL_MODE");

  assert.equal((await openLocalAttachmentWithSystem({
    attachmentId: ATTACHMENT_ID,
    mode: "full",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "s3", path: fixture.relativePath }),
    openPath,
  })).error, "STORAGE_NOT_LOCAL");

  assert.equal((await openLocalAttachmentWithSystem({
    attachmentId: ATTACHMENT_ID,
    mode: "full",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "local", path: path.join("..", "outside.xlsx") }),
    openPath,
  })).error, "PATH_OUTSIDE_ATTACHMENTS_ROOT");

  assert.equal((await openLocalAttachmentWithSystem({
    attachmentId: ATTACHMENT_ID,
    mode: "full",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "local", path: path.join("missing", "file.xlsx") }),
    openPath,
  })).error, "ATTACHMENT_FILE_NOT_FOUND");

  assert.equal(openCount, 0);
});

test("shell.openPath 返回错误时透传明确失败", async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = await openLocalAttachmentWithSystem({
    attachmentId: ATTACHMENT_ID,
    mode: "full",
    attachmentsRoot: fixture.root,
    loadMetadata: async () => ({ driver: "local", path: fixture.relativePath }),
    openPath: async () => "No application is associated with the specified file",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "OPEN_FAILED");
  assert.match(result.message, /No application/);
});
