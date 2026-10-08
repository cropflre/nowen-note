import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import { validateEnvelope } from "../envelope";
import { ENCRYPTED_IDLE_LOCK_MS } from "../useAutoLock";
import EncryptedNotePane from "../../../components/EncryptedNotePane";
import EncryptedBlockDialog from "../../../components/EncryptedBlockDialog";
import EncryptedNoteCreateDialog from "../../../components/EncryptedNoteCreateDialog";
import type { Note } from "@/types";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({ crypto: vi.fn(), save: vi.fn(), setNote: vi.fn(), close: vi.fn(), scope: "account-a" }));
vi.mock("../workerClient", () => ({ runEncryptedContentOperation: mocks.crypto }));
vi.mock("../sessionClient", () => ({ EncryptedContentSession: class {
  open(envelope: unknown, passphrase: string, expected: unknown, signal: AbortSignal) { return mocks.crypto({ operation: "decrypt", input: { envelope, passphrase, expected } }, signal); }
  update(envelope: unknown, plaintext: string, signal: AbortSignal) { return mocks.crypto({ operation: "update", input: { envelope, plaintext } }, signal); }
  changePassphrase(envelope: unknown, passphrase: string, newPassphrase: string, signal: AbortSignal) { return mocks.crypto({ operation: "change-passphrase", input: { envelope, passphrase, newPassphrase } }, signal); }
  close() { mocks.close(); }
} }));
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
async function unlockNote() { await fill("密码", fixture.passphrase); await click("解锁"); }
async function autosave() { await act(async () => vi.advanceTimersByTime(800)); }
function mayLeave() {
  let allowed = false;
  act(() => { allowed = window.dispatchEvent(new Event("nowen:encrypted-note-before-leave", { cancelable: true })); });
  return allowed;
}
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); mocks.scope = "account-a"; mocks.crypto.mockReset(); mocks.save.mockReset(); mocks.setNote.mockReset(); mocks.close.mockReset();
  mocks.crypto.mockImplementation(async (request) => request.operation === "decrypt" ? "Private initial" : request.input.envelope || block);
  mocks.save.mockImplementation(async (base: Note, content: string) => ({ ...base, content, version: base.version + 1 }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("a locked note shows only its title and a simple password prompt", () => {
  act(() => root.render(<EncryptedNotePane note={note} />));
  expect(container.querySelector("h1")?.textContent).toBe("Public");
  expect(container.querySelector("h2")?.textContent).toBe("此笔记已加密");
  expect(container.textContent).toContain("输入密码查看内容");
  expect(container.textContent).toContain("忘记密码将无法恢复内容");
  expect(container.querySelector("details")).toBeNull();
  expect(container.querySelector("textarea")).toBeNull();
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["", "解锁"]);
});
it("offline ciphertext persistence distinguishes local pending sync and needs no save or discard button", async () => {
  mocks.save.mockImplementation(async (base, content) => ({ ...base, content, __offlineQueued: true }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote();
  await fill("加密 Markdown 正文", "Offline private draft"); await autosave();
  expect(document.querySelector('[role="status"]')?.textContent).toBe("已保存在本机，等待同步");
  expect([...container.querySelectorAll("button")].some((button) => /^(保存|重试保存|放弃修改并锁定)$/.test(button.textContent || ""))).toBe(false);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save.mock.calls[0][1]).not.toContain("Offline private draft");
});
it("unlocking an existing v1 note continues to accept a short legacy password", async () => {
  act(() => root.render(<EncryptedNotePane note={note} />));
  await fill("密码", "123456"); await click("解锁");
  expect(input("加密 Markdown 正文").value).toBe("Private initial");
  expect(mocks.crypto.mock.calls[0][0].input.passphrase).toBe("123456");
});

it("autosaves only after input settles, preserves edits during a write and uses the acknowledged version", async () => {
  let resolve!: (value: Note) => void;
  mocks.save.mockImplementationOnce((base, content) => new Promise<Note>((done) => { resolve = () => done({ ...base, content, version: 2 }); }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote();
  await fill("加密 Markdown 正文", "First draft");
  await act(async () => vi.advanceTimersByTime(600)); expect(mocks.save).not.toHaveBeenCalled();
  await fill("加密 Markdown 正文", "Second draft");
  await act(async () => vi.advanceTimersByTime(799)); expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1)); expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(input("加密 Markdown 正文").readOnly).toBe(false);
  await fill("加密 Markdown 正文", "Latest draft");
  await act(async () => resolve(note));
  expect(document.querySelector('[role="status"]')?.textContent).toBe("正在保存…");
  await act(async () => vi.advanceTimersByTime(800));
  expect(mocks.save).toHaveBeenCalledTimes(2); expect(mocks.save.mock.calls[1][0].version).toBe(2);
  expect(mocks.crypto.mock.calls.at(-1)![0].input.plaintext).toBe("Latest draft");
  expect(document.querySelector('[role="status"]')?.textContent).toBe("已保存");
  expect(JSON.stringify(mocks.setNote.mock.calls)).not.toContain("Latest draft");
  expect(JSON.stringify(mocks.setNote.mock.calls)).not.toContain(fixture.passphrase);
});
it("idle saves dirty ciphertext before locking and permits leaving without a memory-only draft", async () => {
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await act(async () => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS));
  expect(input("加密 Markdown 正文")).toBeNull(); expect(input("密码").value).toBe("");
  expect(document.body.textContent).toContain("此笔记已加密"); expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mayLeave()).toBe(true);
});
it("manual lock flushes the debounce immediately after an offline acknowledgement without showing technical state", async () => {
  mocks.save.mockImplementation(async (base, content) => ({ ...base, content, __offlineQueued: true }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await click("锁定");
  expect(mocks.save).toHaveBeenCalledTimes(1); expect(input("加密 Markdown 正文")).toBeNull();
  expect(document.body.textContent).toContain("此笔记已加密");
  expect(document.body.textContent).not.toContain("队列");
  expect(document.querySelector('[role="status"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(800)); expect(mocks.save).toHaveBeenCalledTimes(1);
});
it("background cancels a pending decrypt and its late result cannot restore the editor", async () => {
  let resolve!: (value: string) => void;
  mocks.crypto.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await fill("密码", fixture.passphrase); await click("解锁");
  const signal = mocks.crypto.mock.calls[0][1] as AbortSignal;
  await act(async () => window.dispatchEvent(new Event("blur"))); expect(signal.aborted).toBe(true);
  await act(async () => resolve("Late private body"));
  expect(input("加密 Markdown 正文")).toBeNull(); expect(input("密码").value).toBe("");
});
it("locking waits for a submitted save then flushes newer edits without competing writes or reviving plaintext", async () => {
  let resolve!: (value: Note) => void;
  mocks.save.mockImplementationOnce((base, content) => new Promise<Note>((done) => { resolve = () => done({ ...base, content, version: 2 }); }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await autosave(); await fill("加密 Markdown 正文", "Newer private draft");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("加密 Markdown 正文")).toBeNull(); expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save.mock.calls[0][2].aborted).toBe(false);
  expect(mayLeave()).toBe(false);
  await act(async () => resolve(note));
  expect(mocks.save).toHaveBeenCalledTimes(2); expect(mocks.save.mock.calls[1][0].version).toBe(2);
  expect(mocks.crypto.mock.calls.at(-1)![0].input.plaintext).toBe("Newer private draft");
  expect(mocks.setNote).toHaveBeenCalledTimes(2); expect(input("加密 Markdown 正文")).toBeNull();
  expect(document.body.textContent).toContain("此笔记已加密");
});
it("synchronous store acknowledgements cannot restore the previous envelope before a lock flush", async () => {
  let active = note; const listeners = new Set<() => void>();
  function Harness() {
    const value = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => active);
    return <EncryptedNotePane note={value} />;
  }
  mocks.setNote.mockImplementation((updated) => { active = updated; listeners.forEach((listener) => listener()); });
  const changed = { ...envelope, payload: { ...envelope.payload, iv: "MDEyMzQ1Njc4OTo7" } };
  let resolve!: (value: Note) => void;
  mocks.save.mockImplementationOnce((base, content) => new Promise<Note>((done) => { resolve = () => done({ ...base, content, version: 2 }); }));
  act(() => root.render(<Harness />)); await unlockNote();
  mocks.crypto.mockResolvedValueOnce(changed);
  await fill("加密 Markdown 正文", "Private draft"); await autosave();
  await fill("加密 Markdown 正文", "Latest private draft"); await click("锁定");
  await act(async () => resolve(note));
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.crypto.mock.calls.at(-1)![0].input.envelope).toEqual(changed);
  expect(input("加密 Markdown 正文")).toBeNull();
});
it("locking during password rotation waits for its acknowledgement and retains the new password", async () => {
  let resolve!: (value: Note) => void;
  mocks.save.mockImplementationOnce((_id, payload) => new Promise<Note>((done) => { resolve = () => done({ ...note, ...payload, version: 2 }); }));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote();
  const change = [...document.querySelectorAll("button")].find((button) => button.textContent === "确认修改")!;
  await fill("当前密码", fixture.passphrase);
  await fill("新密码", "12345"); await fill("确认新密码", "12345"); expect(change.disabled).toBe(true);
  await click("确认修改"); expect(mocks.save).not.toHaveBeenCalled();
  await fill("新密码", "123456789012"); expect(change.disabled).toBe(true);
  await fill("确认新密码", "123456789012"); expect(change.disabled).toBe(false);
  await click("确认修改");
  expect(mocks.crypto.mock.calls.at(-1)![0]).toMatchObject({ operation: "change-passphrase", input: { newPassphrase: "123456789012" } });
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(mocks.save).toHaveBeenCalledTimes(1); expect(input("加密 Markdown 正文")).toBeNull();
  await act(async () => resolve(note));
  expect(document.body.textContent).toContain("此笔记已加密");
  await fill("密码", "123456789012"); await click("解锁");
  await fill("加密 Markdown 正文", "New private draft"); await autosave();
  expect(mocks.crypto.mock.calls.at(-1)![0].input.passphrase).toBeUndefined();
  expect(mocks.save).toHaveBeenCalledTimes(2);
});
it.each(["crypto", "storage"])("failed %s retains edits, blocks leaving and permits explicit lock retry", async (stage) => {
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  if (stage === "crypto") mocks.crypto.mockRejectedValueOnce(new Error("unavailable"));
  else mocks.save.mockRejectedValueOnce(new Error("quota or HTTP conflict"));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("加密 Markdown 正文")).toBeNull(); expect(document.body.textContent).toContain("锁定未完成");
  expect(mayLeave()).toBe(false);
  await act(async () => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS));
  expect(mocks.save).toHaveBeenCalledTimes(stage === "storage" ? 1 : 0);
  await unlockNote();
  expect(input("加密 Markdown 正文").value).toBe("Private draft");
  await click("锁定"); expect(input("加密 Markdown 正文")).toBeNull();
  expect(mocks.save).toHaveBeenCalledTimes(stage === "storage" ? 2 : 1);
});
it("a failed automatic save is not silently retried, even after further editing", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Conflict"));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await act(async () => vi.advanceTimersByTime(800));
  expect(document.body.textContent).toContain("原内容和当前修改已保留");
  await fill("加密 Markdown 正文", "More private edits");
  await act(async () => vi.advanceTimersByTime(3000)); expect(mocks.save).toHaveBeenCalledTimes(1);
  await click("重试保存"); expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("已保存");
});
it("automatic background locking does not retry a previously failed autosave", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Conflict"));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await act(async () => vi.advanceTimersByTime(800));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(mocks.save).toHaveBeenCalledTimes(1); expect(input("加密 Markdown 正文")).toBeNull();
  expect(document.body.textContent).toContain("锁定未完成");
});
it("reverting a failed autosave to the saved body can lock without retrying the write", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Conflict"));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await act(async () => vi.advanceTimersByTime(800));
  await fill("加密 Markdown 正文", "Private initial");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(mocks.save).toHaveBeenCalledTimes(1); expect(input("加密 Markdown 正文")).toBeNull();
  expect(input("密码").value).toBe("");
});
it("rejects an acknowledgement of different ciphertext instead of claiming the draft saved", async () => {
  const different = { ...envelope, payload: { ...envelope.payload, iv: "MDEyMzQ1Njc4OTo7" } };
  mocks.save.mockResolvedValueOnce({ ...note, content: JSON.stringify(different), version: 2 });
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  await click("锁定"); expect(input("加密 Markdown 正文")).toBeNull();
  expect(document.body.textContent).toContain("锁定未完成"); expect(mocks.setNote).not.toHaveBeenCalled();
});
it("failed background locking requires authentication and clears recovery password on a second blur", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Storage unavailable"));
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote();
  await fill("加密 Markdown 正文", "Private recovery draft");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("加密 Markdown 正文")).toBeNull();
  await fill("密码", "Wrong password");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("密码").value).toBe(""); expect(mocks.save).toHaveBeenCalledTimes(1);
  mocks.crypto.mockRejectedValueOnce(Object.assign(new Error("Wrong password"), { code: "unlock-failed" }));
  await fill("密码", "Wrong password"); await click("解锁");
  expect(input("加密 Markdown 正文")).toBeNull();
  await unlockNote(); expect(input("加密 Markdown 正文").value).toBe("Private recovery draft");
  await act(async () => vi.advanceTimersByTime(800)); expect(mocks.save).toHaveBeenCalledTimes(1);
  await click("重试保存"); expect(mocks.save).toHaveBeenCalledTimes(2);
});
it.each(["encryption", "write"])("account change during %s prevents a late result from restoring or writing the old session", async (stage) => {
  let resolve!: (value: unknown) => void;
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  if (stage === "encryption") mocks.crypto.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  else mocks.save.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => window.dispatchEvent(new Event("blur")));
  await act(async () => { mocks.scope = "account-b"; window.dispatchEvent(new Event("nowen:token-changed")); resolve(stage === "encryption" ? envelope : { ...note, version: 2 }); });
  expect(input("加密 Markdown 正文")).toBeNull(); expect(mocks.setNote).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledTimes(stage === "write" ? 1 : 0);
  expect(document.querySelector('[role="status"]')).toBeNull();
});
it("permission revocation during encryption prevents submission and preserves the draft", async () => {
  let resolve!: (value: typeof envelope) => void;
  act(() => root.render(<EncryptedNotePane note={note} />)); await unlockNote(); await fill("加密 Markdown 正文", "Private draft");
  mocks.crypto.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await autosave();
  await act(async () => { root.render(<EncryptedNotePane note={{ ...note, isLocked: 1 }} />); });
  await act(async () => resolve(envelope));
  expect(mocks.save).not.toHaveBeenCalled(); expect(input("加密 Markdown 正文").value).toBe("Private draft");
});
it("region drafts lock without committing, require the password again and retain the pending write", async () => {
  const commit = vi.fn(); const close = vi.fn();
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(block)} onCommit={commit} onClose={close} />));
  await fill("密码", fixture.passphrase); await click("解锁"); await fill("区域临时正文", "Private region draft");
  expect(input("密码")).toBeNull();
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(input("区域临时正文")).toBeNull(); expect(input("密码").value).toBe(""); expect(commit).not.toHaveBeenCalled();
  mocks.crypto.mockResolvedValueOnce("Private region draft"); await fill("密码", fixture.passphrase); await click("解锁");
  expect(input("区域临时正文").value).toBe("Private region draft");
  await click("保存"); expect(commit).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][0]).not.toContain("Private region draft");
});
it("an unlocked region clears its password and saves through the key worker session", async () => {
  const commit = vi.fn();
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(block)} onCommit={commit} onClose={vi.fn()} />));
  await fill("密码", fixture.passphrase); await click("解锁"); await fill("区域临时正文", "Private region edit");
  expect(input("密码")).toBeNull(); await click("保存");
  expect(mocks.crypto.mock.calls.at(-1)![0].input).toMatchObject({ plaintext: "Private region edit", envelope: block });
  expect(mocks.crypto.mock.calls.at(-1)![0].input).not.toHaveProperty("passphrase"); expect(commit).toHaveBeenCalledTimes(1);
});
it("a region background lock includes the last keystroke even before React commits its input render", async () => {
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(block)} onCommit={vi.fn()} onClose={vi.fn()} />));
  await fill("密码", fixture.passphrase); await click("解锁");
  await act(async () => {
    const element = input("区域临时正文");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, "Latest private keystroke");
    element.dispatchEvent(new Event("input", { bubbles: true })); window.dispatchEvent(new Event("blur"));
  });
  expect(mocks.crypto.mock.calls.at(-1)![0]).toMatchObject({ operation: "update", input: { plaintext: "Latest private keystroke" } });
});
it("unsupported decrypted region schema destroys its new worker and leaves the editor locked", async () => {
  const rich = { ...block, originalFormat: "tiptap-json" };
  mocks.crypto.mockResolvedValueOnce('{"type":"doc","content":[{"type":"image","attrs":{"src":"https://example.invalid"}}]}');
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(rich)} onClose={vi.fn()} />));
  await fill("密码", fixture.passphrase); await click("解锁");
  expect(document.querySelector('[aria-label="加密富文本正文"]')).toBeNull(); expect(mocks.close).toHaveBeenCalledTimes(1);
});
it.each([false, true])("failed region encryption stays hidden and recovers only with its password (new=%s)", async (newRegion) => {
  const close = vi.fn();
  act(() => root.render(<EncryptedBlockDialog source={newRegion ? undefined : JSON.stringify(block)} onCommit={vi.fn()} onClose={close} />));
  await fill("密码", fixture.passphrase);
  if (!newRegion) await click("解锁");
  await fill("区域临时正文", "Hidden region recovery");
  mocks.crypto.mockRejectedValueOnce(new Error("Worker unavailable"));
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("区域临时正文")).toBeNull(); expect(input("密码").value).toBe("");
  vi.spyOn(window, "confirm").mockReturnValue(false); await click("关闭"); expect(close).not.toHaveBeenCalled();
  await fill("密码", "Wrong password");
  if (!newRegion) mocks.crypto.mockRejectedValueOnce(new Error("Wrong password"));
  await click("解锁"); expect(input("区域临时正文")).toBeNull();
  await fill("密码", fixture.passphrase); await click("解锁");
  expect(input("区域临时正文").value).toBe("Hidden region recovery");
});

it("new note creation needs matching passwords of at least twelve characters without an acknowledgement checkbox", async () => {
  act(() => root.render(<EncryptedNoteCreateDialog parentId={null} onClose={vi.fn()} />));
  const create = [...document.querySelectorAll("button")].find((button) => button.textContent === "创建")!;
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(document.body.textContent).toContain("忘记密码将无法恢复内容");
  expect(document.body.textContent).toContain("密码（至少 12 个字符）");
  await fill("密码", "short"); await fill("确认密码", "short"); expect(create.disabled).toBe(true);
  await fill("密码", "123456"); await fill("确认密码", "123456"); expect(create.disabled).toBe(true);
  await fill("密码", "🚀".repeat(6)); await fill("确认密码", "🚀".repeat(6)); expect(create.disabled).toBe(true);
  await act(async () => input("确认密码").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mocks.crypto).not.toHaveBeenCalled();
  await fill("密码", "123456789012"); expect(create.disabled).toBe(true);
  await fill("确认密码", "123456789012"); expect(create.disabled).toBe(false);
});
it("selected content needs only matching passwords, warns about old copies and writes ciphertext", async () => {
  const commit = vi.fn(); const close = vi.fn();
  act(() => root.render(<EncryptedBlockDialog initialContent={{ plaintext: "Previously saved private text", format: "markdown" }} onCommit={commit} onClose={close} />));
  expect(input("区域临时正文")).toBeNull(); expect(document.body.textContent).toContain("历史记录和旧备份中可能仍存在旧内容");
  const encrypt = [...document.querySelectorAll("button")].find((button) => button.textContent === "加密")!;
  expect(encrypt.disabled).toBe(true);
  expect(document.body.textContent).toContain("密码（至少 12 个字符）");
  await fill("密码", "12345"); await fill("确认密码", "12345"); expect(encrypt.disabled).toBe(true);
  await fill("密码", "123456789012"); expect(encrypt.disabled).toBe(true);
  await fill("确认密码", "123456789012"); await click("加密");
  expect(mocks.crypto.mock.calls.at(-1)![0].input).toMatchObject({ plaintext: "Previously saved private text", passphrase: "123456789012", originalFormat: "markdown", kind: "block" });
  expect(commit.mock.calls[0][0]).toBe(JSON.stringify(block)); expect(close).toHaveBeenCalledTimes(1);
});
it("closing an untouched selection keeps the original and never asks to discard it", async () => {
  const close = vi.fn(); const commit = vi.fn(); const confirm = vi.spyOn(window, "confirm");
  act(() => root.render(<EncryptedBlockDialog initialContent={{ plaintext: "Existing text", format: "markdown" }} onCommit={commit} onClose={close} />));
  await click("关闭"); expect(close).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
});
it("confirming selection passwords with Enter encrypts only after both passwords match", async () => {
  const commit = vi.fn(); const close = vi.fn();
  act(() => root.render(<EncryptedBlockDialog initialContent={{ plaintext: "Selected private text", format: "markdown" }} onCommit={commit} onClose={close} />));
  await fill("密码", "12345"); await fill("确认密码", "12345");
  await act(async () => input("确认密码").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mocks.crypto).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  await fill("密码", "123456789012"); await fill("确认密码", "210987654321");
  await act(async () => input("确认密码").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(commit).not.toHaveBeenCalled();
  await fill("确认密码", "123456789012");
  await act(async () => input("确认密码").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(commit).toHaveBeenCalledWith(JSON.stringify(block));
  expect(close).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("使用说明");
});
it("a new region draft can lock before first write; closing it requires explicit discard", async () => {
  const close = vi.fn(); act(() => root.render(<EncryptedBlockDialog onCommit={vi.fn()} onClose={close} />));
  await fill("密码", fixture.passphrase); await fill("区域临时正文", "New private draft");
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(input("区域临时正文")).toBeNull(); expect(input("密码").value).toBe("");
  vi.spyOn(window, "confirm").mockReturnValue(false); await click("关闭"); expect(close).not.toHaveBeenCalled();
  mocks.crypto.mockResolvedValueOnce("New private draft"); await fill("密码", fixture.passphrase); await click("解锁");
  const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "保存")!;
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(save.disabled).toBe(false);
});
it("background cancels region unlock and new note creation without late plaintext results", async () => {
  let resolve!: (value: string) => void;
  const close = vi.fn(); mocks.crypto.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  act(() => root.render(<EncryptedBlockDialog source={JSON.stringify(block)} onClose={close} />));
  await fill("密码", fixture.passphrase); await click("解锁");
  await act(async () => window.dispatchEvent(new Event("blur"))); await act(async () => resolve("Late region body"));
  expect(input("区域临时正文")).toBeNull(); expect(input("密码").value).toBe("");
  act(() => root.render(<EncryptedNoteCreateDialog parentId={null} onClose={close} />));
  await fill("密码", fixture.passphrase); await act(async () => window.dispatchEvent(new Event("blur")));
  expect(close).toHaveBeenCalledTimes(1); expect(input("密码").value).toBe("");
});
