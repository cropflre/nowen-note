/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "https://notes.example/api",
  getCurrentWorkspace: () => "personal",
}));
import EmbeddingIndexFailureDetails from "../EmbeddingIndexFailureDetails";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("EmbeddingIndexFailureDetails", () => {
  let root: Root;
  let host: HTMLDivElement;
  const fetchMock = vi.fn();
  const onRetried = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("nowen-token", "test-token");
    fetchMock.mockReset();
    onRetried.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function click(text: string) {
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
    expect(button, text).toBeDefined();
    await act(async () => { button!.click(); });
  }

  it("loads reasons only on demand and retries failures without requesting a full rebuild", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      failed: 2,
      notes: 1,
      attachments: 1,
      reasons: [{ code: "rate_limit", label: "请求频率限制", count: 2, example: "HTTP 429" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true, notes: 1, attachments: 1, enqueued: 2,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await act(async () => { root.render(<EmbeddingIndexFailureDetails failed={2} onRetried={onRetried} />); });
    expect(fetchMock).not.toHaveBeenCalled();

    await click("查看失败原因");
    expect(host.textContent).toContain("请求频率限制");
    expect(host.textContent).toContain("笔记 1 · 附件 1");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://notes.example/api/ai/embeddings/failures", expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer test-token" },
    }));

    await click("仅重试失败任务");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://notes.example/api/ai/embeddings/retry-failed", expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    }));
    expect(onRetried).toHaveBeenCalledWith(2);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith("/rebuild"))).toBe(true);
  });

  it("renders nothing when there are no failed jobs", async () => {
    await act(async () => root.render(<EmbeddingIndexFailureDetails failed={0} onRetried={onRetried} />));
    expect(host.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
