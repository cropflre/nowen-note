import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema";
import settings from "../src/routes/settings";

const app = new Hono();
app.route("/settings", settings);

async function update(value: unknown, userId = "footer-admin") {
  return app.request("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ site_share_footer_text: value }),
  });
}

test.before(() => {
  getDb().prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)")
    .run("footer-admin", "footer-admin", "hash", "admin");
  getDb().prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)")
    .run("footer-user", "footer-user", "hash", "user");
});

test.beforeEach(() => {
  getDb().prepare("DELETE FROM system_settings WHERE key = 'site_share_footer_text'").run();
});

test.after(() => closeDb());

test("旧站点提供空值，管理员保存的文字可公开读取", async () => {
  assert.equal((await (await app.request("/settings")).json()).site_share_footer_text, "");
  const response = await update("  通过团队知识库分享  ");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).site_share_footer_text, "通过团队知识库分享");
  assert.equal((await (await app.request("/settings")).json()).site_share_footer_text, "通过团队知识库分享");
});

test("清空和纯空白输入都恢复默认配置", async () => {
  for (const empty of ["", "   "]) {
    await update("团队知识库");
    const response = await update(empty);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).site_share_footer_text, "");
  }
});

test("普通用户及匿名访客不能修改分享页标识", async () => {
  for (const userId of ["footer-user", ""]) {
    assert.equal((await update("未授权修改", userId)).status, 403);
  }
  assert.equal((await (await app.request("/settings")).json()).site_share_footer_text, "");
});

test("拒绝非文字及超长输入并保留之前的配置", async () => {
  await update("团队知识库");
  for (const invalid of [null, 123, {}, "字".repeat(101)]) {
    assert.equal((await update(invalid)).status, 400);
  }
  assert.equal((await (await app.request("/settings")).json()).site_share_footer_text, "团队知识库");
  assert.equal((await update("字".repeat(100))).status, 200);
});
