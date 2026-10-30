import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema";
import settings from "../src/routes/settings";

const app = new Hono();
app.route("/settings", settings);
let image: string;

async function update(body: object, userId = "banner-admin") {
  return app.request("/settings", {
    method: "PUT", headers: { "Content-Type": "application/json", "X-User-Id": userId },
    body: JSON.stringify(body),
  });
}
async function read() { return (await app.request("/settings")).json(); }

test.before(async () => {
  for (const [id, role] of [["banner-admin", "admin"], ["banner-user", "user"]]) {
    getDb().prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)").run(id, id, "hash", role);
  }
  const bytes = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#4263eb" } }).png().toBuffer();
  image = `data:image/png;base64,${bytes.toString("base64")}`;
});
test.beforeEach(() => {
  getDb().prepare("DELETE FROM system_settings WHERE key IN ('site_share_banner_enabled', 'site_share_banner_image', 'site_title')").run();
});
test.after(() => closeDb());

test("旧站点默认关闭横幅，管理员保存后公开读取可解码的裁切图片", async () => {
  const defaults = await read();
  assert.equal(defaults.site_share_banner_enabled, "false");
  assert.equal(defaults.site_share_banner_image, "");
  const response = await update({ site_share_banner_enabled: true, site_share_banner_image: image });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.site_share_banner_enabled, "true");
  assert.match(saved.site_share_banner_image, /^data:image\/jpeg;base64,/);
  const metadata = await sharp(Buffer.from(saved.site_share_banner_image.split(",")[1], "base64")).metadata();
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 400);
  closeDb();
  assert.equal((await read()).site_share_banner_image, saved.site_share_banner_image);
});

test("关闭保留图片，重新开启恢复；删除图片自动关闭", async () => {
  await update({ site_share_banner_enabled: "true", site_share_banner_image: image });
  const original = (await read()).site_share_banner_image;
  assert.equal((await update({ site_share_banner_enabled: false })).status, 200);
  assert.equal((await read()).site_share_banner_image, original);
  assert.equal((await update({ site_share_banner_enabled: true })).status, 200);
  assert.equal((await read()).site_share_banner_enabled, "true");
  assert.equal((await update({ site_share_banner_image: "" })).status, 200);
  assert.equal((await read()).site_share_banner_enabled, "false");
  assert.equal((await read()).site_share_banner_image, "");
});

test("普通用户及访客不能上传、删除或切换横幅", async () => {
  for (const userId of ["banner-user", ""]) {
    for (const body of [{ site_share_banner_image: image }, { site_share_banner_image: "" }, { site_share_banner_enabled: true }]) {
      assert.equal((await update(body, userId)).status, 403);
    }
  }
  assert.equal((await read()).site_share_banner_image, "");
});

test("透明 PNG 处理后使用与裁切预览一致的白底", async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const response = await update({ site_share_banner_image: `data:image/png;base64,${png.toString("base64")}` });
  assert.equal(response.status, 200);
  const saved = await response.json();
  const pixels = await sharp(Buffer.from(saved.site_share_banner_image.split(",")[1], "base64")).raw().toBuffer();
  assert.deepEqual(Array.from(pixels.subarray(0, 3)), [255, 255, 255]);
});

test("拒绝外部地址、SVG、伪装图片、损坏和超限图片，整次保存不产生副作用", async () => {
  await update({ site_share_banner_enabled: true, site_share_banner_image: image, site_title: "原站点" });
  const original = (await read()).site_share_banner_image;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>').toString("base64");
  const png = Buffer.from(image.split(",")[1], "base64");
  const oversized = Buffer.concat([png, Buffer.alloc(1024 * 1024 + 1 - png.length)]);
  const invalid = [null, 123, "https://example.com/banner.png", `data:image/svg+xml;base64,${svg}`, `data:image/png;base64,${svg}`,
    "data:image/jpeg;base64,/9j/", `data:image/png;base64,${oversized.toString("base64")}`];
  for (const value of invalid) {
    const response = await update({ site_share_banner_image: value, site_title: "不应保存" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_SHARE_BANNER_IMAGE");
  }
  assert.equal((await read()).site_share_banner_image, original);
  assert.equal((await read()).site_title, "原站点");
});

test("无图片不能开启，非布尔开关不保存", async () => {
  assert.equal((await update({ site_share_banner_enabled: true })).status, 400);
  for (const value of [null, 1, "1", "yes", {}]) {
    assert.equal((await update({ site_share_banner_enabled: value, site_title: "不应保存" })).status, 400);
  }
  assert.equal((await read()).site_title, "nowen-note");
});
