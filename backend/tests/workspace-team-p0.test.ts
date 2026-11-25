import assert from "node:assert/strict";
import test from "node:test";

const owner = "team-p0-owner";
const adminA = "team-p0-admin-a";
const adminB = "team-p0-admin-b";
const editor = "team-p0-editor";
const outsider = "team-p0-outsider";
const disabledUser = "team-p0-disabled";

async function setup() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const workspaces = (await import("../src/routes/workspaces.js")).default;
  const db = getDb();

  for (const uid of [owner, adminA, adminB, editor, outsider]) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, isDisabled) VALUES (?, ?, 'hash', 0)").run(uid, uid);
  }
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, isDisabled) VALUES (?, ?, 'hash', 1)").run(disabledUser, disabledUser);

  const app = new Hono();
  app.route("/api/workspaces", workspaces);
  return { app, db };
}

const headers = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

test("团队 P0：直加站内成员、同级 admin 权限边界保护、防自操作与 Owner 转让", async () => {
  const { app } = await setup();

  // 1. Owner 创建工作区
  const createRes = await app.request("/api/workspaces", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "研发团队" }),
  });
  assert.equal(createRes.status, 201);
  const ws = (await createRes.json()) as { id: string };

  // 2. Owner 直接添加站内成员（adminA、adminB、editor）
  for (const [uid, role] of [
    [adminA, "admin"],
    [adminB, "admin"],
    [editor, "editor"],
  ] as const) {
    const res = await app.request(`/api/workspaces/${ws.id}/members`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({ userId: uid, role }),
    });
    assert.equal(res.status, 201);
  }

  // 重复添加返回 409，停用用户返回 404
  const dupRes = await app.request(`/api/workspaces/${ws.id}/members`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ userId: editor, role: "viewer" }),
  });
  assert.equal(dupRes.status, 409);

  const disabledRes = await app.request(`/api/workspaces/${ws.id}/members`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ userId: disabledUser, role: "viewer" }),
  });
  assert.equal(disabledRes.status, 404);

  // 3. 权限拒绝用例：普通 editor 不能直加成员或转让所有权
  const editorAdd = await app.request(`/api/workspaces/${ws.id}/members`, {
    method: "POST",
    headers: headers(editor),
    body: JSON.stringify({ userId: outsider, role: "viewer" }),
  });
  assert.equal(editorAdd.status, 403);

  const editorTransfer = await app.request(`/api/workspaces/${ws.id}/transfer-owner`, {
    method: "POST",
    headers: headers(editor),
    body: JSON.stringify({ targetUserId: editor }),
  });
  assert.equal(editorTransfer.status, 403);

  // 4. 权限拒绝用例：普通 admin 同级保护与防提权、防自操作
  const adminAddAdmin = await app.request(`/api/workspaces/${ws.id}/members`, {
    method: "POST",
    headers: headers(adminA),
    body: JSON.stringify({ userId: outsider, role: "admin" }),
  });
  assert.equal(adminAddAdmin.status, 403);

  const adminPromoteEditor = await app.request(`/api/workspaces/${ws.id}/members/${editor}`, {
    method: "PUT",
    headers: headers(adminA),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(adminPromoteEditor.status, 403);

  const adminDemotePeer = await app.request(`/api/workspaces/${ws.id}/members/${adminB}`, {
    method: "PUT",
    headers: headers(adminA),
    body: JSON.stringify({ role: "viewer" }),
  });
  assert.equal(adminDemotePeer.status, 403);

  const adminKickPeer = await app.request(`/api/workspaces/${ws.id}/members/${adminB}`, {
    method: "DELETE",
    headers: headers(adminA),
  });
  assert.equal(adminKickPeer.status, 403);

  const adminInviteAdmin = await app.request(`/api/workspaces/${ws.id}/invites`, {
    method: "POST",
    headers: headers(adminA),
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(adminInviteAdmin.status, 403);

  const adminSelfRole = await app.request(`/api/workspaces/${ws.id}/members/${adminA}`, {
    method: "PUT",
    headers: headers(adminA),
    body: JSON.stringify({ role: "editor" }),
  });
  assert.equal(adminSelfRole.status, 400);

  const adminSelfDelete = await app.request(`/api/workspaces/${ws.id}/members/${adminA}`, {
    method: "DELETE",
    headers: headers(adminA),
  });
  assert.equal(adminSelfDelete.status, 400);

  // 普通 admin 可以添加普通成员（viewer）并生成 editor 邀请码
  const adminAddViewer = await app.request(`/api/workspaces/${ws.id}/members`, {
    method: "POST",
    headers: headers(adminA),
    body: JSON.stringify({ userId: outsider, role: "viewer" }),
  });
  assert.equal(adminAddViewer.status, 201);

  const validInvite = await app.request(`/api/workspaces/${ws.id}/invites`, {
    method: "POST",
    headers: headers(adminA),
    body: JSON.stringify({ role: "editor" }),
  });
  assert.equal(validInvite.status, 201);
  const inviteJson = (await validInvite.json()) as { code: string };
  assert.match(inviteJson.code, /^[A-Z2-9]{10}$/);

  // 5. Owner 转让：非 Owner 拒绝，Owner 成功转让后原 Owner 降为 admin 且可正常退出
  const adminTransfer = await app.request(`/api/workspaces/${ws.id}/transfer-owner`, {
    method: "POST",
    headers: headers(adminA),
    body: JSON.stringify({ targetUserId: adminB }),
  });
  assert.equal(adminTransfer.status, 403);

  const transferRes = await app.request(`/api/workspaces/${ws.id}/transfer-owner`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ targetUserId: adminA }),
  });
  assert.equal(transferRes.status, 200);

  const membersAfter = (await (await app.request(`/api/workspaces/${ws.id}/members`, {
    headers: headers(adminA),
  })).json()) as Array<{ userId: string; role: string }>;
  assert.equal(membersAfter.find((m) => m.userId === adminA)?.role, "owner");
  assert.equal(membersAfter.find((m) => m.userId === owner)?.role, "admin");

  // 原 Owner 现在已变为 admin，可以顺利退出工作区
  const leaveRes = await app.request(`/api/workspaces/${ws.id}/leave`, {
    method: "POST",
    headers: headers(owner),
  });
  assert.equal(leaveRes.status, 200);
});
