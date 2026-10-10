// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSyncEngine, isAckedOwnNoteEcho } from "../mobileSyncEngine";
import { nativeReceiptKey } from "../mobileNoteSyncReceipt";
import type { NativeDatabase } from "../nativeDatabase";

const scope = {
  scopeKey: "personal", workspaceId: null, workspaceName: null,
  role: null, canWrite: true, accessFingerprint: "same",
};
const local = { id: "note-a", scopeKey: "personal", version: 4, title: "RACE NEW", content: "new body", contentFormat: "markdown", contentText: "new body" };
const ownAck = JSON.stringify({ mutationId: "mutation-old", serverVersion: 3 });
const pending = { baseVersion: 3, payload: JSON.stringify(local) };

afterEach(() => vi.unstubAllGlobals());

describe("PR #821 Android receipt ACK and in-flight pull regressions", () => {
  function setupDb(config: {
    rows?: Array<Record<string, unknown>>; server?: Array<Record<string, unknown>>;
    lastAck?: string; pending?: { payload: string; baseVersion: number } | null;
  } = {}) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT mutationId,entityType,entityId,operation")) return config.rows ?? [];
      if (sql.includes("SELECT * FROM notes")) return [local];
      if (sql.includes("SELECT id FROM sync_conflicts")) return [];
      if (sql.includes("SELECT payload,baseVersion FROM sync_outbox")) return config.pending ? [config.pending] : [];
      if (sql.includes("SELECT value FROM native_runtime_meta")) return config.lastAck ? [{ value: config.lastAck }] : [];
      return [];
    });
    const run = vi.fn(async () => ({ changes: 1 }));
    const db: NativeDatabase = {
      query: query as NativeDatabase["query"],
      run,
      transaction: async (work) => work(db),
      close: async () => undefined,
    };
    const engine = new MobileSyncEngine({
      db, attachments: {} as never, serverUrl: "https://notes.example.com",
      token: "test", userId: "user", profileId: "profile", deviceId: "device",
    }) as unknown as {
      push: (scope: typeof scope) => Promise<void>;
      applyEntries: (scope: typeof scope, entries: Array<{entityType:"note";entityId:string;payload: Record<string,unknown>}>, bootstrap:boolean) => Promise<void>;
    };
    return { engine, query, run };
  }

  it("stores the actual applied and duplicate versions in an atomic mutation ACK", async () => {
    for (const status of ["applied", "duplicate"]) {
    const row = {
      mutationId: "mutation-1", entityType: "note", entityId: "note-a",
      operation: "upsert", baseVersion: 3, payload: JSON.stringify(local),
    };
    const { engine, run } = setupDb({ rows: [row] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ serverSequence: 16, results: [
        { mutationId: "mutation-1", status, version: 4 },
      ] }),
    }));
    await engine.push(scope);
    const ack = run.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO native_runtime_meta (key,value"));
    expect(ack).toBeTruthy();
    expect(ack![1][0]).toBe(nativeReceiptKey("profile","note-a"));
    expect(JSON.parse(String(ack![1][1]))).toEqual({ mutationId: "mutation-1", serverVersion: 4 });
    expect(run.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM sync_outbox WHERE mutationId"))).toBe(true);
    }
  });

  it("keeps conflict.serverVersion separate from successful applied.version", async () => {
    const row = {
      mutationId: "mutation-1", entityType: "note", entityId: "note-a",
      operation: "upsert", baseVersion: 3, payload: JSON.stringify(local),
    };
    const { engine, run } = setupDb({ rows: [row] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ results: [
        { mutationId: "mutation-1", status: "conflict", code: "VERSION_CONFLICT", serverVersion: 21,
          serverPayload: { version: 21, contentFormat: "markdown", content: "other-device" } },
      ] }),
    }));
    await engine.push(scope);
    expect(run.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO native_runtime_meta (key,value"))).toHaveLength(0);
    const conflict = run.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sync_conflicts"));
    expect(conflict).toBeTruthy();
    expect(conflict![1][6]).toBe(21);
  });

  it("ignores only the known own ACK echo with a newer queued edit, without overwriting local", async () => {
    const { engine, run } = setupDb({ pending, lastAck: ownAck });
    await engine.applyEntries(scope, [{ entityType:"note", entityId:"note-a", payload: {
      id:"note-a", version:3, content:"prior acknowledged body", contentFormat:"markdown",
    } }], false);
    expect(run.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sync_conflicts"))).toBe(false);
    expect(run.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO notes"))).toBe(false);
  });

  it("keeps real competing remote modifications as conflicts (not own echoes)", async () => {
    const { engine, run } = setupDb({ pending, lastAck: ownAck });
    await engine.applyEntries(scope, [{ entityType:"note", entityId:"note-a", payload: {
      id:"note-a", version:5, content:"other device change", contentFormat:"markdown",
    } }], false);
    expect(run.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sync_conflicts"))).toBe(true);
    expect(run.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO notes"))).toBe(false);
  });

  it("fails closed on missing provenance, stale bases or malformed metadata", () => {
    const remote = { version: 3, content:"acknowledged" };
    expect(isAckedOwnNoteEcho(remote, local, pending, undefined)).toBe(false);
    expect(isAckedOwnNoteEcho(remote, local, pending, "{bad")).toBe(false);
    expect(isAckedOwnNoteEcho(remote, local, { ...pending, baseVersion: 2 }, ownAck)).toBe(false);
    expect(isAckedOwnNoteEcho(remote, local, pending, JSON.stringify({ mutationId:"m", serverVersion:null }))).toBe(false);
    expect(isAckedOwnNoteEcho(remote, local, pending, ownAck)).toBe(true);
  });
});
