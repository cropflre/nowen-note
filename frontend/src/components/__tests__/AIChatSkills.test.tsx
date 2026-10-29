// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
const mocks = vi.hoisted(() => ({ list: vi.fn(), ask: vi.fn(), status: vi.fn(), scope: "account-a", workspace: "personal", failures: [] as unknown[] }));
vi.mock("@/lib/api", () => ({ api: { aiAsk: vi.fn(), aiPrompts: { list: mocks.list } }, getCurrentWorkspace: () => mocks.workspace }));
vi.mock("@/lib/aiCollaboration", () => ({ collaborationScope: () => mocks.scope }));
vi.mock("@/lib/aiReliable", () => ({ reliableAsk: mocks.ask, getReliableAIStatus: mocks.status, exportDiagnosticsFile: vi.fn() }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { activeNote: { id: "current-note" } } }) }));
vi.mock("../agent/NotebookAgentPanel", () => ({ default: () => null }));
vi.mock("../AIChatPanel", async () => {
  const { api } = await import("@/lib/api");
  return { default: () => <button onClick={() => {
    void api.aiAsk("What happened?", [{ role: "user", content: "Earlier question" }], undefined, undefined, { notebookId: "project", includeChildren: true }).catch(error => mocks.failures.push(error));
  }}>Ask</button> };
});
import Shell from "../AIChatReliabilityShell";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function choose(value: string) {
  const select = host.querySelector('[aria-label="自定义 Skill"]') as HTMLSelectElement;
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function ask() {
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Ask")!.click()); await flush();
}
beforeEach(async () => {
  vi.clearAllMocks(); mocks.scope = "account-a"; mocks.workspace = "personal"; mocks.failures = [];
  mocks.list.mockResolvedValue({ items: [{ id: "review", name: "Review", prompt: "PRIVATE INSTRUCTIONS" }] });
  mocks.ask.mockResolvedValue("Answer"); mocks.status.mockResolvedValue(null);
  await i18n.changeLanguage("zh-CN"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<Shell onClose={() => {}} />)); await flush();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("passes the chosen Skill ID with history and knowledge scope, and omits it when disabled", async () => {
  await choose("review"); await ask();
  expect(mocks.ask.mock.calls[0][0]).toMatchObject({ skillId: "review", question: "What happened?", notebookId: "project", includeChildren: true, history: [{ role: "user", content: "Earlier question" }] });
  expect(JSON.stringify(mocks.ask.mock.calls[0][0])).not.toContain("PRIVATE INSTRUCTIONS");
  await choose(""); await ask(); expect(mocks.ask.mock.calls[1][0].skillId).toBeUndefined();
});

it("clears selected Skills when account changes and blocks stale scope before events arrive", async () => {
  await choose("review"); mocks.scope = "account-b";
  await ask(); expect(mocks.ask).not.toHaveBeenCalled(); expect(mocks.failures).toHaveLength(1);
  mocks.list.mockResolvedValue({ items: [] });
  await act(async () => window.dispatchEvent(new Event("nowen:token-changed"))); await flush();
  await ask(); expect(mocks.ask.mock.calls[0][0].skillId).toBeUndefined();
  expect(host.textContent).not.toContain("Review");
});
