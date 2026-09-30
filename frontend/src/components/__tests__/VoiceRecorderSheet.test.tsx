import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), getNote: vi.fn(), put: vi.fn(), remove: vi.fn(), list: vi.fn(), scope: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getNote: mocks.getNote, attachments: { upload: mocks.upload } } }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/voiceMemo", () => ({ voiceMemoScope: mocks.scope }));
vi.mock("@/lib/voiceMemoDraftStore", () => ({
  voiceMemoDraftStore: { put: mocks.put, remove: mocks.remove, list: mocks.list },
  createVoiceMemoDraft: (scope: string, noteId: string, voice: { blob: Blob }) => ({ id: "draft-1", scope, noteId, createdAt: 123, mimeType: "audio/webm", durationMs: 32120, blob: voice.blob, status: "recorded" }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/voiceRecorder", () => ({
  VoiceRecorderSession: class {
    state = "idle"; durationMs = 32120;
    constructor(private onState: (state: string) => void) {}
    async start() { this.state = "recording"; this.onState(this.state); }
    async stop() { this.state = "processing"; return { blob: new Blob(["recording"]), mimeType: "audio/webm", extension: "webm", durationMs: 32120, size: 9 }; }
    async cancel() { this.state = "idle"; }
  },
  recordedVoiceFile: (voice: { blob: Blob }) => new File([voice.blob], "voice-123.webm", { type: "audio/webm" }),
  formatVoiceDuration: () => "00:32",
}));
import VoiceRecorderSheet from "../VoiceRecorderSheet";

describe("recoverable voice recording", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mocks.scope.mockReturnValue("server|user-a"); mocks.list.mockResolvedValue([]); mocks.put.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined);
    mocks.getNote.mockResolvedValue({ id: "note-a", isTrashed: 0 });
    mocks.upload.mockResolvedValue({ id: "audio-1", url: "/api/attachments/audio-1", filename: "voice.webm", mimeType: "audio/webm", size: 9 });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<VoiceRecorderSheet />));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function click(label: string) {
    await act(async () => { const button = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === label); expect(button).toBeDefined(); button!.click(); });
  }
  async function record(insert = vi.fn().mockReturnValue(true)) {
    await act(async () => window.dispatchEvent(new CustomEvent("nowen:voice-record", { detail: { noteId: "note-a", insert } })));
    await click("voice.start"); await click("voice.finish"); return insert;
  }
  it("writes the local draft before uploading and deletes it after insertion", async () => {
    const insert = await record();
    expect(mocks.put.mock.invocationCallOrder[0]).toBeLessThan(mocks.upload.mock.invocationCallOrder[0]);
    expect(mocks.upload).toHaveBeenCalledWith("note-a", expect.any(File));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: "audio-1", durationMs: 32120 }));
    expect(mocks.remove).toHaveBeenCalledWith("draft-1");
  });
  it("keeps a failed upload locally and retries without recording again", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("offline")); const insert = await record();
    expect(insert).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.put).toHaveBeenLastCalledWith(expect.objectContaining({ noteId: "note-a", status: "upload-failed" }));
    expect(document.body.textContent).toContain("voice.localSaved"); await click("voice.retry"); expect(insert).toHaveBeenCalledTimes(1);
  });
  it("retains the original attachment when the editor switches notes and avoids duplicate uploads", async () => {
    const insert = vi.fn().mockReturnValue(false); await record(insert);
    expect(document.body.textContent).toContain("voice.savedOriginal"); expect(mocks.remove).not.toHaveBeenCalled();
    insert.mockReturnValue(true); await click("voice.retry"); expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.remove).toHaveBeenCalledWith("draft-1");
  });
  it("does not upload when local persistence fails and retains the recording in memory", async () => {
    mocks.put.mockRejectedValue(new Error("quota")); await record();
    expect(mocks.upload).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("voice.localFailed");
    await click("voice.close"); expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it("does not upload into a trashed note", async () => {
    mocks.getNote.mockResolvedValue({ id: "note-a", isTrashed: 1 }); await record();
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("retains the local audio when a mobile upload returns incomplete bytes", async () => {
    mocks.upload.mockResolvedValue({ id: "audio-1", url: "/api/attachments/audio-1", filename: "voice.webm", mimeType: "audio/webm", size: 2 });
    const insert = await record(); expect(insert).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("voice.uploadIncomplete");
  });
  it("retains a draft under the original account and releases the session after account changes during upload", async () => {
    let complete!: (value: unknown) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const insert = await record();
    mocks.scope.mockReturnValue("server|user-b");
    await act(async () => window.dispatchEvent(new Event("nowen:token-changed")));
    await act(async () => complete({ id: "audio-1", url: "/api/attachments/audio-1", filename: "voice.webm", mimeType: "audio/webm", size: 9 }));
    expect(insert).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.put).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "server|user-a" }));
    await act(async () => window.dispatchEvent(new CustomEvent("nowen:voice-record", { detail: { noteId: "note-b", insert: vi.fn() } })));
    expect(document.body.textContent).toContain("voice.start");
  });

  it("inserts and persists the attachment identity when Android upload returns a device URL", async () => {
    mocks.upload.mockResolvedValue({ id: "audio-1", url: "https://localhost/_capacitor_file_/voice.webm", filename: "voice.webm", mimeType: "audio/webm", size: 9 });
    const insert = await record();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: "audio-1", src: "/api/attachments/audio-1" }));
    expect(mocks.put).toHaveBeenCalledWith(expect.objectContaining({ attachment: expect.objectContaining({ src: "/api/attachments/audio-1" }) }));
  });
  it("canonicalizes an uploaded legacy draft on recovery without uploading again", async () => {
    mocks.list.mockResolvedValue([{ id: "old-draft", scope: "server|user-a", noteId: "note-a", createdAt: 123, blob: new Blob(["recording"]), mimeType: "audio/webm", durationMs: 32120, status: "recorded", attachment: { attachmentId: "audio-1", src: "capacitor://localhost/old.webm", filename: "voice.webm", mimeType: "audio/webm", size: 9, durationMs: 32120 } }]);
    const insert = vi.fn().mockReturnValue(true);
    await act(async () => window.dispatchEvent(new CustomEvent("nowen:voice-record", { detail: { noteId: "note-a", insert } })));
    await click("voice.retry");
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ src: "/api/attachments/audio-1" }));
    expect(mocks.remove).toHaveBeenCalledWith("old-draft");
  });
});
