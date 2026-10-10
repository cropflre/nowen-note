import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMobileSyncItems, MobileSyncEngine } from "../mobileSyncEngine";
import fixture from "../encryptedNotes/__tests__/fixtures/envelope-v1.json";

const scope = {
  scopeKey: "personal", workspaceId: null, workspaceName: null,
  role: null, canWrite: true, accessFingerprint: "test",
};

function createEngine() {
  const db = {
    query: vi.fn().mockResolvedValue([{ lastSequence: 5 }]),
    run: vi.fn(),
    transaction: vi.fn(),
  };
  const engine = new MobileSyncEngine({
    db: db as never, attachments: {} as never, serverUrl: "http://localhost:3001",
    token: "test", userId: "user", profileId: "profile", deviceId: "device",
  });
  return { db, engine: engine as unknown as {
    pull: (value: typeof scope) => Promise<void>;
    bootstrap: (value: typeof scope) => Promise<void>;
    push: (value: typeof scope) => Promise<void>;
  } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("mobile Sync V2 protocol safety", () => {
  it.each(["encrypted-note-v99", "encrypted-note-v1"])("does not persist or ACK unsupported/malformed %s snapshots", async (contentFormat) => {
    const { db, engine } = createEngine();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ snapshotSequence: 6, nextCursor: null, items: [
      { entityType: "note", entityId: "n1", payload: { contentFormat, content: "Private malformed content", contentText: "" } },
    ] }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(engine.bootstrap(scope)).rejects.toMatchObject({ code: "invalid" });
    expect(db.transaction).not.toHaveBeenCalled(); expect(db.run).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed encrypted push conflict before deleting the original local mutation", async () => {
    const { db, engine } = createEngine();
    const payload = { contentFormat: "encrypted-note-v1", content: JSON.stringify(fixture.envelope), contentText: "" };
    db.query.mockImplementation(async (sql: string) => sql.includes("SELECT mutationId") ? [{ mutationId: "m1", entityType: "note", entityId: "n1", operation: "upsert", baseVersion: 1, payload: JSON.stringify(payload) }] : []);
    db.transaction.mockImplementation(async (work) => work(db));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [{ mutationId: "m1", status: "conflict", code: "VERSION_CONFLICT", serverPayload: { content: "Unmarked plaintext", contentFormat: "markdown" } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(engine.push(scope)).rejects.toMatchObject({ code: "invalid" });
    expect(db.run.mock.calls.some(([sql]) => sql.includes("DELETE FROM sync_outbox"))).toBe(false);
    expect(db.run.mock.calls.some(([sql]) => sql.includes("INSERT INTO sync_conflicts"))).toBe(false);
  });

  it("rejects unknown change-feed entities before ACK", () => {
    expect(() => assertMobileSyncItems([
      { entityType: "knowledge_tree_node", entityId: "note:n1", operation: "upsert" },
    ], "changes")).toThrow("不支持的同步实体");
  });

  it("rejects unknown snapshot entities but accepts existing mindmaps", () => {
    expect(() => assertMobileSyncItems([
      { entityType: "knowledge_tree_node", entityId: "note:n1", payload: {} },
    ], "snapshot")).toThrow("不支持的同步实体");
    expect(() => assertMobileSyncItems([
      { entityType: "mindmap", entityId: "m1", payload: { title: "地图" } },
    ], "snapshot")).not.toThrow();
  });

  it("rejects unknown operations instead of treating them as upsert", () => {
    expect(() => assertMobileSyncItems([
      { entityType: "mindmap", entityId: "m1", operation: "relocate" },
    ], "changes")).toThrow("远端同步操作无效");
  });

  it("does not apply, ACK, or advance the cursor for an unknown change-feed entity", async () => {
    const { db, engine } = createEngine();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resetRequired: false, nextSequence: 6, items: [
        { entityType: "knowledge_tree_node", entityId: "note:n1", operation: "upsert" },
      ] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(engine.pull(scope)).rejects.toThrow("不支持的同步实体");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("does not bypass entity validation when the server requests a snapshot reset", async () => {
    const { db, engine } = createEngine();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resetRequired: true, nextSequence: 6, items: [
        { entityType: "knowledge_tree_node", entityId: "note:n1", operation: "upsert" },
      ] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(engine.pull(scope)).rejects.toThrow("不支持的同步实体");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("does not apply or ACK an unknown snapshot entity during bootstrap", async () => {
    const { db, engine } = createEngine();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ snapshotSequence: 6, nextCursor: null, items: [
        { entityType: "knowledge_tree_node", entityId: "note:n1", payload: {} },
      ] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(engine.bootstrap(scope)).rejects.toThrow("不支持的同步实体");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("does not push an unknown local entity after a client downgrade", async () => {
    const { db, engine } = createEngine();
    db.query.mockResolvedValue([{ mutationId: "m1", entityType: "knowledge_tree_node",
      entityId: "note:n1", operation: "upsert", baseVersion: null, payload: "{}" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(engine.push(scope)).rejects.toThrow("本地存在当前客户端不支持的同步实体");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
