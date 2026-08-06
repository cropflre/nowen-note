// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareMarkdownFootnotesForImageExport,
  refreshNoteImageAttachmentAccess,
} from "@/lib/noteImageExportPreparation";
import {
  resetAttachmentAccessStateForTests,
  resolveAttachmentAccessUrl,
} from "@/lib/noteAttachmentAccessBridge";

afterEach(() => {
  localStorage.clear();
  resetAttachmentAccessStateForTests();
  vi.unstubAllGlobals();
});

describe("NOTE-IMAGE-EXPORT footnote preparation", () => {
  it("renders references and definitions while keeping fenced code unchanged", () => {
    const markdown = [
      "正文引用。[^mind] 再次引用。[^mind]",
      "",
      "```md",
      "代码里的 [^mind] 不应转换",
      "```",
      "",
      "[^mind]: 第一行脚注",
      "    第二行脚注",
    ].join("\n");

    const prepared = prepareMarkdownFootnotesForImageExport(markdown);

    expect(prepared).toContain('id="fnref-mind"');
    expect(prepared).toContain('id="fnref-mind-2"');
    expect(prepared).toContain('id="fn-mind"');
    expect(prepared).toContain("第一行脚注<br>第二行脚注");
    expect(prepared).toContain("代码里的 [^mind] 不应转换");
    expect(prepared).not.toContain("[^mind]: 第一行脚注");
  });

  it("leaves an undefined reference untouched", () => {
    expect(prepareMarkdownFootnotesForImageExport("正文[^missing]"))
      .toBe("正文[^missing]");
  });
});

describe("NOTE-IMAGE-EXPORT Docker/NAS attachment access", () => {
  it("refreshes and registers a signed attachment URL before rendering", async () => {
    const attachmentId = "72effe54-9200-41d5-95b1-9ff8fce078f7";
    localStorage.setItem("nowen-token", "login-token");

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      urls: {
        [attachmentId]: `http://127.0.0.1:3001/api/attachments/${attachmentId}?exp=9999999999&sig=test-signature&scope=user`,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const count = await refreshNoteImageAttachmentAccess(
      "note-1",
      `![心经](/api/attachments/${attachmentId})`,
    );

    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/attachments/access/urls?noteId=note-1"),
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer login-token" }),
      }),
    );

    const resolved = resolveAttachmentAccessUrl(`/api/attachments/${attachmentId}`);
    expect(resolved).toContain(`/api/attachments/${attachmentId}`);
    expect(resolved).toContain("sig=test-signature");
  });

  it("skips the access request when the note has no attachment URLs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem("nowen-token", "login-token");

    await expect(refreshNoteImageAttachmentAccess("note-1", "纯文本"))
      .resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
