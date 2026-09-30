import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), transcribe: vi.fn() }));
vi.mock("@/lib/api", () => ({ voiceApi: mocks }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import VoiceTranscription from "../VoiceTranscription";
import { registerNativeAttachmentUrl, resetAttachmentAccessStateForTests } from "@/lib/noteAttachmentAccessBridge";

const ID = "123e4567-e89b-42d3-a456-426614174216";
describe("voice transcription attachment identity", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks(); resetAttachmentAccessStateForTests();
    mocks.settings.mockResolvedValue({ configured: true });
    mocks.transcribe.mockResolvedValue({ text: "转写内容" });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function renderAndTranscribe(src: string, attachmentId?: string) {
    const insert = vi.fn();
    await act(async () => root.render(<VoiceTranscription src={src} attachmentId={attachmentId} onInsert={insert} />));
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    return insert;
  }
  it("transcribes unregistered device URLs using the explicit ID and inserts edited text", async () => {
    const insert = await renderAndTranscribe("capacitor://localhost/voice.webm", ID);
    expect(mocks.transcribe).toHaveBeenCalledWith(ID);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "校订内容");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "voice.insert")!.click());
    expect(insert).toHaveBeenCalledWith("校订内容");
  });
  it("prefers explicit identity over a conflicting source URL", async () => {
    await renderAndTranscribe("/api/attachments/123e4567-e89b-42d3-a456-426614174217", ID);
    expect(mocks.transcribe).toHaveBeenCalledWith(ID);
  });
  it("retains legacy signed URL extraction when metadata is missing", async () => {
    await renderAndTranscribe(`https://server/api/attachments/${ID}?exp=1&sig=temporary`);
    expect(mocks.transcribe).toHaveBeenCalledWith(ID);
  });
  it("recovers registered local URLs when metadata is missing", async () => {
    const src = "https://localhost/_capacitor_file_/voice.webm";
    registerNativeAttachmentUrl(ID, src);
    await renderAndTranscribe(src);
    expect(mocks.transcribe).toHaveBeenCalledWith(ID);
  });
});
