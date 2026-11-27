import assert from "node:assert/strict";
import test from "node:test";

const owner = "team-p2-owner";
const editorA = "team-p2-editor-a";
const viewerB = "team-p2-viewer-b";
const outsider = "team-p2-outsider";

async function setup() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const workspaces = (await import("../src/routes/workspaces.js")).default;
  const knowledgeTree = (await import("../src/routes/knowledge-tree.js")).default;
  const workspaceIssues = (await import("../src/routes/workspace-issues.js")).default;
  const db = getDb();

  for (const [uid, displayName] of [
    [owner, "负责人"],
    [editorA, "研发甲"],
    [viewerB, "产品乙"],
    [outsider, "外部人员"],
  ]) {
    db.prepare(
      "INSERT OR IGNORE INTO users (id, username, displayName, passwordHash, isDisabled) VALUES (?, ?, ?, 'hash', 0)",
    ).run(uid, uid, displayName);
  }

  const app = new Hono();
  app.route("/api/workspaces", workspaces);
  app.route("/api/knowledge-tree", knowledgeTree);
  app.route("/api/workspace-issues", workspaceIssues);
  return { app, db };
}

const headers = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

test("团队 P2：工作区用户组、按组批量目录授权、生效权限诊断与空间动态审计", async () => {
  const { app } = await setup();

  // 1. 创建两个工作区（主工作区 + 对照工作区，用于验证跨工作区隔离）
  const ws1Res = await app.request("/api/workspaces", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "P2 协作空间" }),
  });
  assert.equal(ws1Res.status, 201);
  const ws1 = (await ws1Res.json()) as { id: string };

  const ws2Res = await app.request("/api/workspaces", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "P2 隔离空间" }),
  });
  assert.equal(ws2Res.status, 201);
  const ws2 = (await ws2Res.json()) as { id: string };

  // 添加成员 editorA、viewerB 到 ws1
  for (const [uid, role] of [
    [editorA, "editor"],
    [viewerB, "viewer"],
  ] as const) {
    const res = await app.request(`/api/workspaces/${ws1.id}/members`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({ userId: uid, role }),
    });
    assert.equal(res.status, 201);
  }

  // 2. 用户组 CRUD 与权限拒绝用例
  // 拒绝：普通 editor 不能新建用户组
  const editorCreateGrp = await app.request(`/api/workspaces/${ws1.id}/groups`, {
    method: "POST",
    headers: headers(editorA),
    body: JSON.stringify({ name: "非法分组" }),
  });
  assert.equal(editorCreateGrp.status, 403);

  // 拒绝：外部人员不能读取用户组
  const outsiderListGrp = await app.request(`/api/workspaces/${ws1.id}/groups`, {
    headers: headers(outsider),
  });
  assert.equal(outsiderListGrp.status, 403);

  // Owner 创建用户组
  const createGrpRes = await app.request(`/api/workspaces/${ws1.id}/groups`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "产品研发组", description: "核心协作团队" }),
  });
  assert.equal(createGrpRes.status, 201);
  const group = (await createGrpRes.json()) as { id: string; name: string };

  // 重名冲突返回 409
  const dupGrpRes = await app.request(`/api/workspaces/${ws1.id}/groups`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "产品研发组" }),
  });
  assert.equal(dupGrpRes.status, 409);

  // 在 ws2 创建一个空组，用于跨工作区拒绝测试
  const otherGrpRes = await app.request(`/api/workspaces/${ws2.id}/groups`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "其他空间组" }),
  });
  assert.equal(otherGrpRes.status, 201);
  const otherGroup = (await otherGrpRes.json()) as { id: string };

  // 拒绝：不能把非工作区成员加入用户组
  const addOutsiderToGrp = await app.request(`/api/workspaces/${ws1.id}/groups/${group.id}/members`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ userId: outsider }),
  });
  assert.equal(addOutsiderToGrp.status, 400);

  // 将 editorA 与 viewerB 加入「产品研发组」
  for (const uid of [editorA, viewerB]) {
    const res = await app.request(`/api/workspaces/${ws1.id}/groups/${group.id}/members`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({ userId: uid }),
    });
    assert.equal(res.status, 201);
  }

  // 工作区普通成员可读用户组及成员列表
  const listGrpRes = await app.request(`/api/workspaces/${ws1.id}/groups`, {
    headers: headers(viewerB),
  });
  assert.equal(listGrpRes.status, 200);
  const groups = (await listGrpRes.json()) as Array<{ id: string; memberCount: number }>;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].memberCount, 2);

  // 3. 创建知识树目录并按用户组批量授权
  const nodeRes = await app.request(`/api/knowledge-tree/nodes?workspaceId=${ws1.id}`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ parentId: null, nodeType: "folder", title: "P2 架构设计目录" }),
  });
  assert.equal(nodeRes.status, 201);
  const folder = (await nodeRes.json()) as { id: string };

  // 拒绝：editor 不能按组授权（无 canManageMembers）
  const editorGrantRes = await app.request(`/api/knowledge-tree/nodes/${folder.id}/permissions/grant-group`, {
    method: "POST",
    headers: headers(editorA),
    body: JSON.stringify({ groupId: group.id, rolePreset: "editor" }),
  });
  assert.equal(editorGrantRes.status, 403);

  // 拒绝：跨工作区用户组返回 404
  const crossWsGrantRes = await app.request(`/api/knowledge-tree/nodes/${folder.id}/permissions/grant-group`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ groupId: otherGroup.id, rolePreset: "editor" }),
  });
  assert.equal(crossWsGrantRes.status, 404);

  // Owner 按组批量授予 maintainer 角色
  const grantRes = await app.request(`/api/knowledge-tree/nodes/${folder.id}/permissions/grant-group`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ groupId: group.id, rolePreset: "maintainer" }),
  });
  assert.equal(grantRes.status, 200);
  const grantPayload = (await grantRes.json()) as { appliedCount: number; rolePreset: string; groupName: string };
  assert.equal(grantPayload.appliedCount, 2);
  assert.equal(grantPayload.rolePreset, "maintainer");
  assert.equal(grantPayload.groupName, "产品研发组");

  // 4. 成员生效权限诊断接口（含拒绝用例）
  // 拒绝：普通成员无 canManageMembers 不可调用诊断接口
  const editorDiagRes = await app.request(
    `/api/knowledge-tree/nodes/${folder.id}/permissions/effective?userId=${viewerB}`,
    { headers: headers(editorA) },
  );
  assert.equal(editorDiagRes.status, 403);

  // Owner 诊断 viewerB：虽为工作区 viewer，但通过用户组批量授权成为该目录 maintainer
  const diagRes = await app.request(
    `/api/knowledge-tree/nodes/${folder.id}/permissions/effective?userId=${viewerB}`,
    { headers: headers(owner) },
  );
  assert.equal(diagRes.status, 200);
  const diag = (await diagRes.json()) as {
    workspaceRole: string | null;
    effective: { rolePreset: string; source: string; capabilities: { canEdit: boolean; canDelete: boolean; canManageMembers: boolean } };
    explanation: string;
  };
  assert.equal(diag.workspaceRole, "viewer");
  assert.equal(diag.effective.rolePreset, "maintainer");
  assert.equal(diag.effective.source, "direct");
  assert.equal(diag.effective.capabilities.canEdit, true);
  assert.equal(diag.effective.capabilities.canDelete, true);
  assert.equal(diag.effective.capabilities.canManageMembers, false);
  assert.match(diag.explanation, /独立授权/);

  // 5. 工作区动态流与空间级权限审计
  // 创建一条议题以便动态流覆盖 issues
  const issueRes = await app.request("/api/workspace-issues", {
    method: "POST",
    headers: headers(editorA),
    body: JSON.stringify({ workspaceId: ws1.id, title: "P2 动态流验证议题" }),
  });
  assert.equal(issueRes.status, 201);

  // 拒绝：外部人员不可查看动态流
  const outsiderActivity = await app.request(`/api/workspaces/${ws1.id}/activity`, {
    headers: headers(outsider),
  });
  assert.equal(outsiderActivity.status, 403);

  // 拒绝：普通成员不可查看 permissions 审计分类
  const viewerPermActivity = await app.request(`/api/workspaces/${ws1.id}/activity?category=permissions`, {
    headers: headers(viewerB),
  });
  assert.equal(viewerPermActivity.status, 403);

  // 普通成员查看 all 动态：canViewPermissions 为 false 且不泄露 permissions 审计记录
  const viewerAllActivity = await app.request(`/api/workspaces/${ws1.id}/activity?category=all`, {
    headers: headers(viewerB),
  });
  assert.equal(viewerAllActivity.status, 200);
  const viewerAllData = (await viewerAllActivity.json()) as {
    canViewPermissions: boolean;
    items: Array<{ category: string; targetTitle: string }>;
  };
  assert.equal(viewerAllData.canViewPermissions, false);
  assert.equal(viewerAllData.items.some((item) => item.category === "permissions"), false);
  assert.equal(viewerAllData.items.some((item) => item.category === "docs" && item.targetTitle === "P2 架构设计目录"), true);
  assert.equal(viewerAllData.items.some((item) => item.category === "issues" && item.targetTitle === "P2 动态流验证议题"), true);

  // Owner 查看 permissions 审计分类：能看到按组批量授权产生的目录权限变更记录
  const ownerPermActivity = await app.request(`/api/workspaces/${ws1.id}/activity?category=permissions`, {
    headers: headers(owner),
  });
  assert.equal(ownerPermActivity.status, 200);
  const ownerPermData = (await ownerPermActivity.json()) as {
    canViewPermissions: boolean;
    items: Array<{ category: string; targetTitle: string; detail?: string }>;
  };
  assert.equal(ownerPermData.canViewPermissions, true);
  assert.ok(ownerPermData.items.length >= 2);
  assert.equal(ownerPermData.items.every((item) => item.category === "permissions"), true);

  // 6. 删除用户组（editor 拒绝，owner 成功）
  const editorDelGrp = await app.request(`/api/workspaces/${ws1.id}/groups/${group.id}`, {
    method: "DELETE",
    headers: headers(editorA),
  });
  assert.equal(editorDelGrp.status, 403);

  const ownerDelGrp = await app.request(`/api/workspaces/${ws1.id}/groups/${group.id}`, {
    method: "DELETE",
    headers: headers(owner),
  });
  assert.equal(ownerDelGrp.status, 200);
});
