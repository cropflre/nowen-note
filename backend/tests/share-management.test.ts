import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShareManagementResult,
  parseShareManagementQuery,
  resolveShareEffectiveStatus,
  type ShareManagementRawRow,
} from "../src/services/share-management";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");

function row(overrides: Partial<ShareManagementRawRow>): ShareManagementRawRow {
  return {
    id: "share-1",
    noteId: "note-1",
    ownerId: "owner-1",
    shareToken: "token-1",
    shareType: "link",
    permission: "view",
    password: null,
    expiresAt: null,
    maxViews: null,
    viewCount: 0,
    isActive: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    noteTitle: "示例笔记",
    noteOwnerId: "owner-1",
    notebookId: "notebook-1",
    notebookName: "工作笔记",
    workspaceId: null,
    workspaceName: null,
    noteIsTrashed: 0,
    ...overrides,
  };
}

test("share status priority is disabled, expired, exhausted, active", () => {
  assert.equal(resolveShareEffectiveStatus(row({ isActive: 0, expiresAt: "2020-01-01", maxViews: 1, viewCount: 1 }), NOW), "disabled");
  assert.equal(resolveShareEffectiveStatus(row({ expiresAt: "2026-07-24T23:59:59Z", maxViews: 1, viewCount: 1 }), NOW), "expired");
  assert.equal(resolveShareEffectiveStatus(row({ maxViews: 2, viewCount: 2 }), NOW), "exhausted");
  assert.equal(resolveShareEffectiveStatus(row({ maxViews: 2, viewCount: 1 }), NOW), "active");
});

test("query parsing clamps pagination and validates filters", () => {
  assert.deepEqual(parseShareManagementQuery({
    q: "  token  ", status: "expired", permission: "edit", hasPassword: "1",
    sort: "expiresAt", order: "asc", page: "0", pageSize: "999",
  }), {
    q: "token", status: "expired", permission: "edit", hasPassword: true,
    sort: "expiresAt", order: "asc", page: 1, pageSize: 100,
  });
});

test("management access follows creator, notebook override, note ACL and workspace role precedence", () => {
  const rows = [
    row({ id: "own-orphan", noteId: "missing", ownerId: "me", noteOwnerId: null, notebookId: null }),
    row({ id: "notebook-manager", noteId: "n2", ownerId: "other", noteOwnerId: "other", notebookId: "nb-manage" }),
    row({ id: "notebook-deny", noteId: "n3", ownerId: "other", noteOwnerId: "other", notebookId: "nb-read", workspaceId: "ws-admin" }),
    row({ id: "note-manager", noteId: "n4", ownerId: "other", noteOwnerId: "other", notebookId: "nb-none", workspaceId: "ws-user" }),
    row({ id: "workspace-manager", noteId: "n5", ownerId: "other", noteOwnerId: "other", notebookId: "nb-none-2", workspaceId: "ws-admin" }),
  ];
  const result = buildShareManagementResult(rows, "me", {
    notebookRoleById: new Map([["nb-manage", "manage"], ["nb-read", "read"]]),
    notePermissionById: new Map([["n4", "manage"]]),
    workspaceRoleById: new Map([["ws-admin", "admin"], ["ws-user", "editor"]]),
  }, { page: 1, pageSize: 20 }, NOW);
  assert.deepEqual(result.items.map((item) => item.id).sort(), ["note-manager", "notebook-manager", "own-orphan", "workspace-manager"].sort());
});

test("filters, stats, password redaction and pagination are stable", () => {
  const rows = [
    row({ id: "active", ownerId: "me", noteTitle: "Alpha", password: "hash", updatedAt: "2026-07-24T00:00:00Z" }),
    row({ id: "disabled", ownerId: "me", noteTitle: "Beta", isActive: 0, updatedAt: "2026-07-23T00:00:00Z" }),
    row({ id: "expired", ownerId: "me", noteTitle: "Gamma", expiresAt: "2026-07-20T00:00:00Z" }),
  ];
  const access = { notebookRoleById: new Map(), notePermissionById: new Map(), workspaceRoleById: new Map() };
  const result = buildShareManagementResult(rows, "me", access, {
    q: "alpha", hasPassword: true, page: 1, pageSize: 1,
  }, NOW);
  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.id, "active");
  assert.equal(result.items[0]?.hasPassword, true);
  assert.equal("password" in (result.items[0] || {}), false);
  assert.deepEqual(result.stats, { total: 3, active: 1, disabled: 1, expired: 1, exhausted: 0 });
});
