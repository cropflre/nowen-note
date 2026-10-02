import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import fixture from "./fixtures/envelope-v1.json";
import { ENCRYPTED_NOTE_FORMAT } from "../noteDocument";
import { saveEncryptedNoteCiphertext } from "../saveNote";
import { pendingEncryptedNote } from "../pendingNote";
const mocks = vi.hoisted(() => ({ save: vi.fn(), queue: [] as any[], scope: "account-a", persist: true }));
vi.mock("../../api", () => ({ api: { updateNoteConfirmed: mocks.save } }));
vi.mock("../../offlineQueue", () => ({
  getOfflineQueueStorageKey: () => mocks.scope,
  getQueue: () => mocks.queue,
  enqueue: (item: unknown) => { if (mocks.persist) mocks.queue.push(item); },
  discardResolvedQueueItems: (item: any) => { mocks.queue = mocks.queue.filter((entry) => entry !== item); },
}));
const note = { id: "note-id", notebookId: "book", userId: "owner", title: "Visible title", content: JSON.stringify(fixture.envelope), contentFormat: ENCRYPTED_NOTE_FORMAT, contentText: "", version: 1 } as Note;
beforeEach(() => { mocks.save.mockReset(); mocks.queue = []; mocks.scope = "account-a"; mocks.persist = true; });
describe("encrypted offline and conflict saves", () => {
  it("reloads the latest pending encrypted entry rather than an earlier conflict snapshot", () => {
    mocks.queue.push(
      { type: "updateNote", noteId: note.id, conflict: true, body: { ...note, title: "Older draft" } },
      { type: "updateNote", noteId: note.id, body: { ...note, title: "Latest draft", version: 2 } },
    );
    expect(pendingEncryptedNote(note.id)?.title).toBe("Latest draft");
    expect(pendingEncryptedNote(note.id)?.version).toBe(2);
  });
  it("a later pending save cannot bypass an earlier encrypted conflict", async () => {
    mocks.queue.push(
      { type: "updateNote", noteId: note.id, conflict: true, body: { ...note } },
      { type: "updateNote", noteId: note.id, body: { ...note, version: 2 } },
    );
    await expect(saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal)).rejects.toThrow("Resolve encrypted conflict");
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.queue).toHaveLength(2);
  });
  it("uses confirmed saves without ordinary plaintext conflict rebasing", async () => {
    mocks.save.mockResolvedValue({ ...note, version: 2 });
    const result = await saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal);
    expect(result.version).toBe(2); expect(mocks.queue).toHaveLength(0);
    expect(mocks.save).toHaveBeenCalledWith(note.id, { content: note.content, contentText: "", contentFormat: ENCRYPTED_NOTE_FORMAT, version: 1 });
  });
  it("persists only ciphertext on a network failure and reloads it without the detail cache", async () => {
    mocks.save.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal);
    expect(result.__offlineQueued).toBe(true);
    expect(pendingEncryptedNote(note.id)?.content).toBe(note.content);
    expect(JSON.stringify(mocks.queue)).not.toContain(fixture.passphrase);
    expect(JSON.stringify(mocks.queue)).not.toContain(fixture.plaintext);
  });
  it("rejects quota/persistence failure without pretending the draft was saved", async () => {
    mocks.persist = false; mocks.save.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal)).rejects.toThrow("not persisted");
  });
  it("clears an older offline ciphertext after a newer online save is acknowledged", async () => {
    mocks.queue.push({ id: "old", type: "updateNote", noteId: note.id, body: { content: note.content, contentFormat: ENCRYPTED_NOTE_FORMAT } });
    mocks.save.mockResolvedValue({ ...note, version: 2 });
    await saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal);
    expect(mocks.queue).toHaveLength(0); expect(pendingEncryptedNote(note.id)).toBeNull();
  });
  it("a save acknowledged after auto-lock clears stale ciphertext without reviving plaintext", async () => {
    mocks.queue.push({ id: "old", type: "updateNote", noteId: note.id, body: { content: note.content, contentFormat: ENCRYPTED_NOTE_FORMAT } });
    const controller = new AbortController();
    mocks.save.mockImplementation(async () => { controller.abort("auto-lock"); return { ...note, version: 2 }; });
    expect((await saveEncryptedNoteCiphertext(note, note.content, controller.signal)).version).toBe(2);
    expect(mocks.queue).toHaveLength(0);
  });
  it("keeps queued encrypted conflicts until explicit resolution", async () => {
    mocks.queue.push({ type: "updateNote", noteId: note.id, conflict: true, body: { content: note.content, contentFormat: ENCRYPTED_NOTE_FORMAT } });
    await expect(saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal)).rejects.toThrow("Resolve encrypted conflict");
    expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.queue).toHaveLength(1);
  });
  it.each([400, 401, 403, 409, 500])("does not enqueue or overwrite after HTTP %s", async (status) => {
    mocks.save.mockRejectedValue(Object.assign(new Error("Rejected"), { status }));
    await expect(saveEncryptedNoteCiphertext(note, note.content, new AbortController().signal)).rejects.toThrow();
    expect(mocks.queue).toHaveLength(0);
  });
  it.each(["account-change", "abort"])("refuses offline persistence after %s", async (kind) => {
    const controller = new AbortController();
    mocks.save.mockImplementation(async () => { if (kind === "account-change") mocks.scope = "account-b"; else controller.abort(); throw new TypeError("Network failed"); });
    await expect(saveEncryptedNoteCiphertext(note, note.content, controller.signal)).rejects.toThrow();
    expect(mocks.queue).toHaveLength(0);
  });
});
