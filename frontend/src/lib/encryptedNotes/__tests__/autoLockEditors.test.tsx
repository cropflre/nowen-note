import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import { validateEnvelope } from "../envelope";
import { ENCRYPTED_IDLE_LOCK_MS } from "../useAutoLock";
import EncryptedNotePane from "../../../components/EncryptedNotePane";
import EncryptedBlockDialog from "../../../components/EncryptedBlockDialog";
import EncryptedNoteCreateDialog from "../../../components/EncryptedNoteCreateDialog";
import type { Note } from "@/types";

const mocks = vi.hoisted(() => ({ crypto: vi.fn(), save: vi.fn(), setNote: vi.fn(), scope: "account-a" }));
vi.mock("../workerClient", () => ({ runEncryptedContentOperation: mocks.crypto }));
vi.mock("../saveNote", () => ({ saveEncryptedNoteCiphertext: mocks.save }));
vi.mock("@/lib/api", () => ({ api: { updateNoteConfirmed: mocks.save }, getCurrentWorkspace: () => "personal" }));
vi.mock("@/lib/offlineQueue", () => ({ getOfflineQueueStorageKey: () => mocks.scope, getQueue: () => [] }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => ({ setActiveNote: mocks.setNote, updateNoteInList: vi.fn() }) }));
const envelope = validateEnvelope(fixture.envelope);
const block = validateEnvelope({ ...fixture.envelope, kind: "block" });
const note = { id: "auto-lock-note", title: "Public", contentFormat: "encrypted-note-v1", content: JSON.stringify(envelope), version: 1 } as Note;
let root: Root; let container: HTMLDivElement;
function input(label: string) { return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; }
async function fill(label: string, value: string) {
  const element = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((button) => button.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
async function unlockNote() { await fill("解锁口令", fixture.passphrase); await click("解锁"); }
beforeEach(() => {
  vi.useFakeTimers(); mocks.scope = "account-a"; mocks.crypto.mockReset(); mocks.save.mockReset(); mocks.setNote.mockReset();
  mocks.crypto.mockImplementation(async (request) => request.operation === "decrypt" ? "Private initial" : request.input.envelope || block);
  mocks.save.mockResolvedValue({ ...note, version: 2 });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("idle locks a dirty note into a memory ciphertext draft, restores it and saves against the original base", async () => {
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await act(async () => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS));
  expect(input("加密 Markdown 正文")).toBeNull(); expect(input("解锁口令").value).toBe("");
  expect(document.body.textContent).toContain("加密内存草稿"); expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.crypto.mock.calls.at(-1)![0].input.plaintext).toBe("Private draft");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="返回列表"]')!.click());
  expect(document.body.textContent).toContain("请先保存或放弃修改");
  expect(window.dispatchEvent(new Event("nowen:encrypted-note-before-leave", { cancelable: true }))).toBe(false);
  mocks.crypto.mockResolvedValueOnce("Private draft"); await unlockNote();
  expect(input("加密 Markdown 正文").value).toBe("Private draft");
  await click("加密保存"); expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.setNote).toHaveBeenCalledTimes(1);
  await fill("加密 Markdown 正文", "Another private draft");
  await act(async () => window.dispatchEvent(new Event("blur")));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("放弃加密内存草稿"); expect(document.body.textContent).toContain("重新解锁可恢复");
  confirm.mockReturnValue(true); await click("放弃加密内存草稿");
  expect(window.dispatchEvent(new Event("nowen:encrypted-note-before-leave", { cancelable: true }))).toBe(true);
});
it("background cancels a pending decrypt and its late result cannot restore the editor", async () => {
  let resolve!: (value: string) => void;
  mocks.crypto.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await fill("解锁口令", fixture.passphrase); await click("解锁");
  const signal = mocks.crypto.mock.calls[0][1] as AbortSignal;
  await act(async () => window.dispatchEvent(new Event("blur"))); expect(signal.aborted).toBe(true);
  await act(async () => resolve("Late private body"));
  expect(input("加密 Markdown 正文")).toBeNull(); expect(input("解锁口令").value).toBe("");
});
it("a ciphertext save acknowledged after locking updates the note without recreating plaintext", async () => {
  let resolve!: (value: Note) => void;
  mocks.save.mockImplementationOnce(() => new Promise<Note>((done) => { resolve = done; }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await click("加密保存"); await act(async () => window.dispatchEvent(new Event("blur")));
  await act(async () => resolve({ ...note, version: 2 }));
  expect(mocks.setNote).toHaveBeenCalledTimes(1); expect(input("加密 Markdown 正文")).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("已由服务器确认");
});
it("failed draft encryption preserves edits, reports lock failure and permits an explicit retry", async () => {
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  mocks.crypto.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("加密 Markdown 正文").value).toBe("Private draft"); expect(document.body.textContent).toContain("自动锁定未完成");
  await click("重试自动锁定"); expect(input("加密 Markdown 正文")).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
});
it("account change during draft encryption prevents restoration or draft adoption", async () => {
  let resolve!: (value: typeof envelope) => void;
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  mocks.crypto.mockImplementationOnce(() => new Promise<typeof envelope>((done) => { resolve = done; }));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect([...document.querySelectorAll("button")].find((button) => button.textContent === "取消")?.disabled).toBe(true);
  await act(async () => { mocks.scope = "account-b"; window.dispatchEvent(new Event("nowen:token-changed")); resolve(envelope); });
  expect(input("加密 Markdown 正文")).toBeNull(); expect(document.body.textContent).not.toContain("重新解锁可恢复");
});
it("region drafts lock without committing, require the password again and retain the pending write", async () => {
  const commit = vi.fn(); const close = vi.fn();
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(block)} onCommit={commit} onClose={close} />));
  await fill("区域口令", fixture.passphrase); await click("解锁区域"); await fill("区域临时正文", "Private region draft");
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(input("区域临时正文")).toBeNull(); expect(input("区域口令").value).toBe(""); expect(commit).not.toHaveBeenCalled();
  mocks.crypto.mockResolvedValueOnce("Private region draft"); await fill("区域口令", fixture.passphrase); await click("解锁区域");
  expect(input("区域临时正文").value).toBe("Private region draft");
  await click("加密写回"); expect(commit).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][0]).not.toContain("Private region draft");
});
it("a new region draft can lock before first write; closing it requires explicit discard", async () => {
  const close = vi.fn(); act(() => root.render(<EncryptedBlockDialog onCommit={vi.fn()} onClose={close} />));
  await fill("区域口令", fixture.passphrase); await fill("区域临时正文", "New private draft");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("区域临时正文")).toBeNull(); expect(input("区域口令").value).toBe("");
  vi.spyOn(window, "confirm").mockReturnValue(false); await click("关闭并锁定"); expect(close).not.toHaveBeenCalled();
  mocks.crypto.mockResolvedValueOnce("New private draft"); await fill("区域口令", fixture.passphrase); await click("解锁区域");
  const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "加密写回")!;
  expect(save.disabled).toBe(true);
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(save.disabled).toBe(false);
});
it("background cancels region unlock and new note creation without late plaintext results", async () => {
  let resolve!: (value: string) => void;
  const close = vi.fn(); mocks.crypto.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(block)} onClose={close} />));
  await fill("区域口令", fixture.passphrase); await click("解锁区域");
  await act(async () => window.dispatchEvent(new Event("blur"))); await act(async () => resolve("Late region body"));
  expect(input("区域临时正文")).toBeNull(); expect(input("区域口令").value).toBe("");
  act(() => root.render(<EncryptedNoteCreateDialog parentId={null} onClose={close} />));
  await fill("创建口令", fixture.passphrase); await act(async () => window.dispatchEvent(new Event("blur")));
  expect(close).toHaveBeenCalledTimes(1); expect(input("创建口令").value).toBe("");
});
