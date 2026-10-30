import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema";
import settings from "../src/routes/settings";

const app = new Hono();
app.route("/settings", settings);

async function update(value: unknown, userId = "width-admin", extra = {}) {
  return app.request("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify({ site_share_page_width: value, ...extra }),
  });
}

test.before(() => {
  for (const [id, role] of [["width-admin", "admin"], ["width-user", "user"]]) {
    getDb().prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)")
      .run(id, id, "hash", role);
  }
});
test.beforeEach(() => {
  getDb().prepare("DELETE FROM system_settings WHERE key IN ('site_share_page_width', 'site_title')").run();
});
test.after(() => closeDb());

test("旧站点默认标准宽度，各档位保存后可公开读取", async () => {
  assert.equal((await (await app.request("/settings")).json()).site_share_page_width, "standard");
  for (const width of ["wide", "full", "standard"]) {
    const response = await update(width);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).site_share_page_width, width);
    assert.equal((await (await app.request("/settings")).json()).site_share_page_width, width);
  }
});

test("普通用户和匿名访客不能修改全站分享宽度", async () => {
  for (const userId of ["width-user", ""]) {
    assert.equal((await update("wide", userId)).status, 403);
  }
  assert.equal((await (await app.request("/settings")).json()).site_share_page_width, "standard");
});

test("无效宽度拒绝整次保存，保留已有配置", async () => {
  await update("wide", "width-admin", { site_title: "原站点" });
  for (const invalid of [null, 123, {}, "", "10000px", "<style>", "WIDE"]) {
    const response = await update(invalid, "width-admin", { site_title: "不应保存" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_SHARE_PAGE_WIDTH");
  }
  const stored = await (await app.request("/settings")).json();
  assert.equal(stored.site_share_page_width, "wide");
  assert.equal(stored.site_title, "原站点");
});
