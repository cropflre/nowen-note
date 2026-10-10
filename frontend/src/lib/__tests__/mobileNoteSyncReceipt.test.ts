import { describe, expect, it, vi } from "vitest";
import { readNativeNoteSyncReceipt, nativeReceiptKey } from "@/lib/mobileNoteSyncReceipt";
import type { NativeDatabase } from "@/lib/nativeDatabase";

function dbStub(input: { conflicts?: unknown[]; outbox?: unknown[]; receipt?: { mutationId: string; serverVersion?: number } } = {}) {
  const query = vi.fn(async (sql: string, _params: unknown[]) => {
    if (sql.includes("sync_conflicts")) return input.conflicts ?? [];
    if (sql.includes("sync_outbox")) return input.outbox ?? [];
    if (sql.includes("native_runtime_meta")) return input.receipt ? [{ value: JSON.stringify(input.receipt) }] : [];
    return [];
  });
  return { db: { query } as unknown as NativeDatabase, query };
}
describe("native per-note sync receipt", () => {
  it("requires a matching native mutation receipt instead of global sync time", async () => {
    const { db, query } = dbStub();
    expect(await readNativeNoteSyncReceipt(db, "profile-a", "note-a")).toMatchObject({ phase: "unverified" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("native_runtime_meta"),
      [nativeReceiptKey("profile-a", "note-a")]);
    const confirmed = dbStub({ receipt: { mutationId: "mutation-1", serverVersion: 9 } });
    expect(await readNativeNoteSyncReceipt(confirmed.db, "profile-a", "note-a")).toMatchObject({
      phase: "confirmed", acknowledgedRevision: 9,
    });
  });
  it("keeps native pending and conflicts ahead of committed ACK", async () => {
    const receipt = { mutationId: "mutation-1", serverVersion: 8 };
    expect(await readNativeNoteSyncReceipt(dbStub({
      receipt, outbox: [{ status: "pending", lastError: null }],
    }).db, "profile-a", "note-a")).toMatchObject({ phase: "pending" });
    expect(await readNativeNoteSyncReceipt(dbStub({
      receipt, outbox: [{ status: "failed", lastError: "NETWORK_UNAVAILABLE" }],
    }).db, "profile-a", "note-a")).toMatchObject({ phase: "error" });
    expect(await readNativeNoteSyncReceipt(dbStub({
      receipt, conflicts: [{ id: "conflict-1" }],
    }).db, "profile-a", "note-a")).toMatchObject({ phase: "conflict" });
  });
});
