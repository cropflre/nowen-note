// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIApplyOutcome } from "@/hooks/useAIAssistantAnchor";

const mocks = vi.hoisted(() => ({ aiChat: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/api", () => ({ api: { aiChat: mocks.aiChat, aiPrompts: { list: async () => ({ items: [] }) } } }));
vi.mock("@/components/aiCollaboration/AiGeneratedNotice", () => ({ default: () => null }));
import AIWritingAssistant from "../AIWritingAssistant";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AI writing assistant after an apply attempt", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const byText = (label: string) => [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  const click = async (element: Element | undefined) => { expect(element).toBeDefined(); await act(async () => (element as HTMLElement).click()); await flush(); };
  const alert = () => document.body.querySelector('[role="alert"]');

  async function openWithResult(outcome: AIApplyOutcome) {
    const onReplace = vi.fn(() => outcome);
    const onInsert = vi.fn(() => outcome);
    await act(async () => root.render(
      <AIWritingAssistant selectedText="Hello" fullText="Hello world" onReplace={onReplace} onInsert={onInsert} onClose={onClose} />,
    ));
    await click(byText("ai.actionPolish"));
    expect(byText("ai.replace")).toBeDefined();
    return { onReplace, onInsert };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aiChat.mockImplementation(async (_action: string, _selected: string, _prompt: string, onChunk: (chunk: string) => void) => { onChunk("Hi"); });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it.each([["ai.replace"], ["ai.insertAfter"]])("closes only when %s really wrote into the note", async (label) => {
    const { onReplace, onInsert } = await openWithResult("applied");
    await click(byText(label));
    expect(label === "ai.replace" ? onReplace : onInsert).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alert()).toBeNull();
  });

  it.each([
    ["conflict", "ai.applyConflict"],
    ["encrypted", "ai.applyEncrypted"],
    ["tooLarge", "ai.applyTooLarge"],
  ] as const)("keeps the result and explains a refusal (%s) instead of closing", async (outcome, message) => {
    await openWithResult(outcome);
    await click(byText("ai.replace"));
    expect(onClose).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain(message);
    // The result stays available, so it can still be copied.
    expect(byText("ai.copy")).toBeDefined();
    await click(byText("ai.insertAfter"));
    expect(onClose).not.toHaveBeenCalled();
    expect(alert()?.textContent).toContain(message);
  });

  it("clears the notice when the assistant is retried", async () => {
    await openWithResult("conflict");
    await click(byText("ai.replace"));
    expect(alert()).not.toBeNull();
    await click([...document.body.querySelectorAll("button")].find((element) => element.getAttribute("title") === "ai.retry"));
    expect(alert()).toBeNull();
  });
});
